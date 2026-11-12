import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { onsetAt, fallbackCatastrophe } from "../src/catastrophe";
import { escapeRead, ensureTaskStation } from "../src/director";
import { createEscapeState } from "../src/escape-state";
import {
  escapeFrame,
  escapeInteract,
  escapeJournal,
  setDirectorRequest,
} from "../src/escape-runtime";
import { roomPowerKey } from "../src/room-power-key";
import { validateAnnouncement } from "../src/pa-system";
import { TestRunner } from "../src/gametest/runner";
import { emptyScenario } from "../src/gametest/schema";
import type { EscapeState } from "../src/escape-types";
import type { Game, Roadmap } from "../src/model";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);

interface Call {
  operation: string;
  payload: Record<string, unknown>;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A real synthetic world with a minimal escape state attached. */
function world(): { g: Game; escape: EscapeState; calls: Call[] } {
  const scenario = emptyScenario();
  scenario.entities = [{ id: "human", kind: "player", x: 9, y: 15 }];
  const g = new TestRunner(scenario, roadmap).game;
  const escape = createEscapeState(g, { gender: "male", seed: g.seed });
  escape.catastrophe = fallbackCatastrophe(g.seed, escape.areas.current);
  g.escape = escape;
  g.time = 0;
  return { g, escape, calls: [] };
}

/** Give floor 0 one room so announcements can name and affect it. */
function addRoom(g: Game): string {
  const floor = g.floors[0];
  floor.rooms = [
    {
      index: 0,
      side: "left",
      innerMouth: { x: floor.entry.x, y: floor.entry.y },
    },
  ];
  return `0:0`;
}

function record(calls: Call[]) {
  return async (operation: string, payload: unknown) => {
    calls.push({ operation, payload: payload as Record<string, unknown> });
    if (operation === "escape-pa")
      return {
        requestId: "pa-answer",
        kind: "incident",
        text: "Power outage reported in the lobby. Emergency lighting is active nearby.",
        effect: { kind: "power", roomId: "0:0", power: "outage" },
      };
    if (operation === "escape-intent")
      return { requestId: "intent-answer", goals: [] };
    return { requestId: "engage-answer" };
  };
}

test("frame is a no-op without g.escape", () => {
  const { g, escape, calls } = world();
  delete g.escape;
  setDirectorRequest(record(calls));
  g.time = 500;
  assert.doesNotThrow(() => escapeFrame(g, 0.1));
  assert.deepEqual(calls, []);
  assert.equal(
    escapeInteract(g, { kind: "read", subjectId: "x", label: "X" }),
    false,
  );
  assert.deepEqual(escapeJournal(g), []);
  g.escape = escape;
});

test("the PA is scheduled, requested, recorded, committed and its power effect applied", async () => {
  const { g, escape, calls } = world();
  const roomId = addRoom(g);
  setDirectorRequest(record(calls));
  escapeFrame(g, 0.1); // primes the schedule: first PA is 40..90 s out
  assert.equal(escape.announcements.length, 0);
  g.time = 200;
  escapeFrame(g, 0.1);
  const paCalls = calls.filter((call) => call.operation === "escape-pa");
  assert.equal(paCalls.length, 1);
  await settle();
  assert.equal(escape.announcements.length, 1);
  const announcement = escape.announcements[0];
  assert.deepEqual(validateAnnouncement(announcement, [{ id: roomId }]), []);
  assert.equal(announcement.id, "pa1");
  assert.equal(announcement.areaId, escape.areas.current);
  assert.equal(escape.roomPower[roomId], "outage");
  assert.equal(escape.ledger.facts.length, 1);
  assert.equal(escape.ledger.facts[0].source, "pa");
  assert.equal(escape.ledger.facts[0].durable, false);
  assert.equal(announcement.factId, escape.ledger.facts[0].id);
  assert.equal(escape.log.filter((event) => event.kind === "pa").length, 1);
});

test("a pre-onset PA payload contains nothing from the sealed spec", async () => {
  const { g, escape, calls } = world();
  addRoom(g);
  setDirectorRequest(record(calls));
  escapeFrame(g, 0.1);
  const onset = onsetAt(escape.catastrophe);
  assert.ok(onset > 200, "fallback catastrophe keeps its grace period");
  g.time = 200;
  escapeFrame(g, 0.1);
  await settle();
  const pa = calls.find((call) => call.operation === "escape-pa");
  assert.ok(pa, "the director requested a PA");
  const body = JSON.stringify(pa.payload);
  const spec = escape.catastrophe;
  const sealed = [spec.title, spec.premise, spec.publicStory];
  for (const omen of spec.omens) sealed.push(omen.text);
  for (const secret of sealed) {
    assert.ok(secret.length > 0);
    assert.equal(body.includes(secret), false, `payload leaked ${secret}`);
  }
  assert.equal("publicStory" in pa.payload, false);
  assert.equal(
    pa.payload.areaName,
    escape.areas.areas[escape.areas.current].name,
  );
});

test("after onset the PA payload carries the public story", async () => {
  const { g, escape, calls } = world();
  addRoom(g);
  setDirectorRequest(record(calls));
  escapeFrame(g, 0.1);
  g.time = onsetAt(escape.catastrophe) + 1;
  escapeFrame(g, 0.1);
  const pa = calls.find((call) => call.operation === "escape-pa");
  assert.ok(pa);
  assert.equal(pa.payload.publicStory, escape.catastrophe.publicStory);
});
test("a rejected PA request falls back to a valid announcement", async () => {
  const { g, escape, calls } = world();
  addRoom(g);
  setDirectorRequest((operation, payload) => {
    calls.push({ operation, payload: payload as Record<string, unknown> });
    return Promise.reject(new Error("bridge offline"));
  });
  escapeFrame(g, 0.1);
  g.time = 200;
  escapeFrame(g, 0.1);
  await settle();
  assert.equal(escape.announcements.length, 1);
  const announcement = escape.announcements[0];
  assert.equal(announcement.id, "pa1");
  assert.deepEqual(validateAnnouncement(announcement, [{ id: "0:0" }]), []);
  assert.equal(escape.announcements[0].factId, escape.ledger.facts[0].id);
});

test("an engagement commits and learns durable facts, replies and creates a task", async () => {
  const { g, escape, calls } = world();
  const floor = g.floors[0];
  const object = floor.furniture[0];
  const subjectId = object?.id ?? "loose-locker";
  setDirectorRequest(async (operation, payload) => {
    calls.push({ operation, payload: payload as Record<string, unknown> });
    if (operation === "escape-engage")
      return {
        requestId: "engage-answer",
        facts: [
          {
            text: "The locker holds a flight-crew badge on a broken chain.",
            subject: { kind: "object", id: subjectId },
            visibility: ["public"],
          },
        ],
        task: {
          title: "Pry the locker",
          unit: "bolts",
          steps: 2,
          objectId: subjectId,
        },
        reply: "The locker gives a little.",
      };
    return { requestId: "other", goals: [] };
  });
  const handled = escapeInteract(g, {
    kind: "attempt",
    subjectId,
    label: "Loose locker",
  });
  assert.equal(handled, true);
  assert.equal(g.notice, "You look over the Loose locker…");
  await settle();
  assert.equal(escape.ledger.facts.length, 1);
  const fact = escape.ledger.facts[0];
  assert.equal(fact.durable, true);
  assert.equal(fact.visibility.includes("public"), true);
  assert.equal(escape.ledger.journal.length, 1);
  assert.equal(escape.ledger.journal[0].factId, fact.id);
  assert.equal(escape.ledger.journal[0].via, "attempt");
  assert.equal(escape.ledger.journal[0].line, fact.text);
  assert.equal(escape.tasks.length, 1);
  const task = escape.tasks[0];
  assert.equal(task.id, "t1");
  assert.equal(task.objectId, subjectId);
  assert.equal(task.areaId, escape.areas.current);
  assert.deepEqual(task.fromFacts, [fact.id]);
  assert.equal(task.state, "available");
  assert.equal(g.notice, "The locker gives a little.");
  const station = object ? ensureTaskStation(g, subjectId) : undefined;
  if (
    object &&
    floor.stations.length > 0 &&
    Object.keys(g.encounters).length > 0
  ) {
    assert.ok(station, "a task station was built next to the object");
    assert.equal(task.stationId, station);
    assert.equal(ensureTaskStation(g, subjectId), station);
  } else {
    assert.equal(station, undefined);
    assert.equal(task.stationId, undefined);
  }
});

test("an offline engagement commits the ordinary-object observation", async () => {
  const { g, escape } = world();
  setDirectorRequest(() => Promise.reject(new Error("bridge offline")));
  assert.equal(
    escapeInteract(g, { kind: "read", subjectId: "motd", label: "Notice" }),
    true,
  );
  await settle();
  const fact = escape.ledger.facts[0];
  assert.equal(fact.text, "Notice looks ordinary.");
  assert.equal(fact.source, "observation");
  assert.equal(fact.durable, true);
  assert.equal(escape.ledger.journal.length, 1);
  assert.equal(escape.ledger.journal[0].via, "observation");
});

test("a hatch engagement asks the director instead of entering anything", async () => {
  const { g, escape, calls } = world();
  // Crossings are region edges now: an object beside a region is not a way in.
  escape.areas.portals.push({
    id: "p1",
    from: escape.areas.current,
    to: "a2",
    transition: "hatch",
    at: { floor: 0, x: 2, y: 2 },
    label: "Airlock",
    objectId: "hatch-1",
  });
  setDirectorRequest(record(calls));
  const handled = escapeInteract(g, {
    kind: "attempt",
    subjectId: "hatch-1",
    label: "Hatch",
  });
  assert.equal(handled, true);
  await settle();
  // F tries the hatch through the director: there is no portal branch left.
  assert.equal(g.notice, "You look over the Hatch…");
  assert.equal(
    calls.filter((call) => call.operation === "escape-engage").length,
    1,
  );
});

test("a near area answer registers a site with no portal", async () => {
  const { g, escape } = world();
  setDirectorRequest(async (operation) => {
    if (operation === "escape-engage")
      return {
        requestId: "engage-answer",
        area: {
          name: "Deck Seven",
          brief: "A service deck.",
          transition: "lift",
        },
      };
    return { requestId: "other", goals: [] };
  });
  assert.equal(
    escapeInteract(g, {
      kind: "read",
      subjectId: "lift-panel",
      label: "Panel",
    }),
    true,
  );
  await settle();
  // A near place is a building next door: it is stamped into this world, so
  // the answer adds one site stub with an origin and no portal at all.
  const added = Object.keys(escape.areas.areas).filter((id) => id !== "start");
  assert.equal(added.length, 1);
  const area = escape.areas.areas[added[0]!]!;
  assert.equal(area.name, "Deck Seven");
  assert.equal(area.state, "stub");
  assert.equal(area.kind, "site");
  assert.ok(area.origin);
  assert.equal(area.stamped, undefined);
  assert.equal(escape.areas.portals.length, 0);
});

test("a far area answer registers a region reached at the world edge", async () => {
  const { g, escape } = world();
  setDirectorRequest(async (operation) => {
    if (operation === "escape-engage")
      return {
        requestId: "engage-answer",
        area: {
          name: "Frost ridge",
          brief: "Two days out across the ice.",
          transition: "vehicle",
          distance: "far",
        },
      };
    return { requestId: "other", goals: [] };
  });
  escapeInteract(g, {
    kind: "read",
    subjectId: "lift-panel",
    label: "Panel",
  });
  await settle();
  const added = Object.keys(escape.areas.areas).filter((id) => id !== "start");
  assert.equal(added.length, 1);
  const area = escape.areas.areas[added[0]!]!;
  assert.equal(area.kind, "region");
  assert.equal(area.origin, undefined);
  // A region keeps a crossing record for the edge, labelled with its name.
  assert.equal(escape.areas.portals.length, 1);
  assert.equal(escape.areas.portals[0]!.to, area.id);
  assert.equal(escape.areas.portals[0]!.label, "Frost ridge");
  assert.equal(escape.areas.portals[0]!.transition, "vehicle");
  assert.equal(escape.areas.portals[0]!.objectId, "lift-panel");
});

test("intent prediction only asks while undiscovered areas exist", async () => {
  const { g, escape, calls } = world();
  setDirectorRequest(async (operation, payload) => {
    calls.push({ operation, payload: payload as Record<string, unknown> });
    return {
      requestId: "intent-answer",
      goals: [{ areaId: "remote", goal: "find the lift", confidence: 0.9 }],
    };
  });
  escapeFrame(g, 0.1);
  g.time = 100;
  escapeFrame(g, 0.1);
  g.time = 200;
  escapeFrame(g, 0.1);
  await settle();
  assert.equal(
    calls.filter((call) => call.operation === "escape-intent").length,
    0,
  );
  escape.areas.areas.remote = {
    id: "remote",
    name: "Remote deck",
    brief: "A deck nobody has walked yet.",
    state: "stub",
    seed: 7,
  };
  g.time = 300;
  escapeFrame(g, 0.1);
  await settle();
  const intents = calls.filter((call) => call.operation === "escape-intent");
  assert.equal(intents.length, 1);
  assert.deepEqual(intents[0].payload.areaIds, ["remote"]);
  assert.deepEqual(intents[0].payload.recentEngagements, []);
  assert.equal(typeof intents[0].payload.floor, "number");
  assert.ok(Array.isArray(intents[0].payload.journal));
});

test("the journal lists learned lines and open tasks", () => {
  const { g, escape } = world();
  escape.ledger.facts.push({
    id: "f1",
    text: "The hatch needs a flight-crew badge.",
    subject: { kind: "object", id: "hatch" },
    source: "observation",
    visibility: ["public"],
    at: 10,
  });
  escape.ledger.journal.push({
    factId: "f1",
    line: "Hatch: flight-crew badge",
    learnedAt: 11,
    via: "attempt",
  });
  escape.ledger.seq = 1;
  escape.tasks.push(
    {
      id: "t1",
      title: "Pry the hatch",
      unit: "bolts",
      steps: 3,
      done: 1,
      objectId: "hatch",
      areaId: escape.areas.current,
      fromFacts: ["f1"],
      state: "in-progress",
    },
    {
      id: "t2",
      title: "Rewire the panel",
      unit: "wires",
      steps: 2,
      done: 2,
      objectId: "panel",
      areaId: escape.areas.current,
      fromFacts: [],
      state: "complete",
    },
  );
  assert.deepEqual(escapeJournal(g), [
    "Hatch: flight-crew badge",
    "Task: Pry the hatch · 1/3 bolts",
  ]);
});

test("a read engagement sends its text and learns the fact via document", async () => {
  const { g, escape, calls } = world();
  setDirectorRequest(async (operation, payload) => {
    calls.push({ operation, payload: payload as Record<string, unknown> });
    if (operation === "escape-engage")
      return {
        requestId: "engage-answer",
        facts: [
          {
            text: "Locker 7 holds the flight-crew badge.",
            subject: { kind: "object", id: "scene.surface:memo" },
            visibility: ["public"],
          },
        ],
        reply: "The memo names locker seven.",
      };
    return { requestId: "other", goals: [] };
  });
  const readable = {
    id: "scene.surface:memo",
    label: "Crumpled memo",
    text: "Badge is in locker 7.",
  };
  assert.equal(escapeRead(g, readable), true);
  await settle();
  const engage = calls.find((call) => call.operation === "escape-engage");
  assert.ok(engage, "the director requested an engagement");
  assert.deepEqual(engage.payload.engagement, {
    kind: "read",
    subjectId: "scene.surface:memo",
    label: "Crumpled memo",
    text: "Badge is in locker 7.",
  });
  assert.equal(escape.ledger.facts.length, 1);
  assert.equal(
    escape.ledger.facts[0]!.text,
    "Locker 7 holds the flight-crew badge.",
  );
  assert.equal(escape.ledger.journal.length, 1);
  assert.equal(escape.ledger.journal[0]!.via, "document");
  assert.equal(escape.ledger.journal[0]!.line, escape.ledger.facts[0]!.text);
  assert.equal(g.notice, "The memo names locker seven.");
});

test("a read that yields no facts still records the page in the journal", async () => {
  const { g, escape } = world();
  setDirectorRequest(async (operation) => {
    if (operation === "escape-engage") return { requestId: "engage-answer" };
    return { requestId: "other", goals: [] };
  });
  assert.equal(
    escapeRead(g, {
      id: "scene.surface:sign",
      label: "Sign",
      text: "Deck seven is sealed.",
    }),
    true,
  );
  await settle();
  assert.equal(escape.ledger.facts.length, 1);
  assert.equal(escape.ledger.facts[0]!.text, "Sign: Deck seven is sealed.");
  assert.equal(escape.ledger.journal.length, 1);
  assert.equal(escape.ledger.journal[0]!.via, "document");
  assert.equal(escape.ledger.journal[0]!.line, "Sign: Deck seven is sealed.");
});

test("an offline read commits and learns the first 200 characters it read", async () => {
  const { g, escape } = world();
  setDirectorRequest(() => Promise.reject(new Error("bridge offline")));
  const body = `the badge is in locker seven. ${"x".repeat(300)}`;
  assert.equal(
    escapeRead(g, { id: "memo", label: "Crumpled memo", text: body }),
    true,
  );
  await settle();
  const fact = escape.ledger.facts[0];
  assert.ok(fact, "the fallback committed a fact");
  assert.equal(fact.durable, true);
  assert.equal(fact.visibility.includes("public"), true);
  assert.equal(fact.text, `Crumpled memo: ${body.slice(0, 200)}`);
  assert.equal(escape.ledger.journal.length, 1);
  assert.equal(escape.ledger.journal[0]!.factId, fact.id);
  assert.equal(escape.ledger.journal[0]!.via, "document");
});

test("PA power effects are keyed by roomPowerKey for the current area", async () => {
  const { g, escape, calls } = world();
  const roomId = addRoom(g);
  const start = escape.areas.start ?? "start";
  g.areaId = "deck-7";
  assert.notEqual(g.areaId, start);
  setDirectorRequest(record(calls));
  escapeFrame(g, 0.1);
  g.time = 200;
  escapeFrame(g, 0.1);
  await settle();
  assert.equal(escape.announcements.length, 1);
  // The power map keys a room by its bare id under roomPowerKey's area prefix.
  const key = roomPowerKey(g, 0, "0");
  assert.equal(key, `deck-7/${roomId}`);
  assert.equal(escape.roomPower[key], "outage");
  assert.equal(escape.roomPower[roomId], undefined);
});
