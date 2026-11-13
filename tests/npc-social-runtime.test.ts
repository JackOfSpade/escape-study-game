import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { TestRunner } from "../src/gametest/runner";
import { emptyScenario } from "../src/gametest/schema";
import type { Roadmap } from "../src/model";
import { AWARENESS_WEIGHTS, observe } from "../src/npc-social";
import {
  applySocialOutcome,
  outcomeContext,
  socialStep,
  socialWorldTick,
  type SocialMotor,
} from "../src/npc-social-runtime";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);

function escapeState(role = "Security guard") {
  return {
    persona: { name: "Ada", role, backstory: "" },
    ledger: { facts: [], journal: [], seq: 0 },
    tasks: [],
    announcements: [],
    prompts: [],
    log: [],
    areas: { start: "start", current: "start", areas: {}, portals: [] },
    roomPower: {},
  } as any;
}

function fixture(
  entities: { id: string; kind: string; x: number; y: number }[],
  role = "Security guard",
) {
  const scenario = emptyScenario();
  scenario.entities = entities as any;
  const g = new TestRunner(scenario, roadmap).game as any;
  g.escape = escapeState(role);
  g.time = 0;
  return g;
}

function actor(g: { survivors: { id: string }[] }, id: string) {
  const found = g.survivors.find((a) => a.id === id);
  assert.ok(found, `actor ${id}`);
  return found as any;
}

function motor() {
  const calls: { floor: number; x: number; y: number }[] = [];
  let stops = 0;
  let faces = 0;
  const m: SocialMotor = {
    walkTo(target) {
      calls.push({ floor: target.floor, x: target.x, y: target.y });
    },
    stop() {
      stops += 1;
    },
    face() {
      faces += 1;
    },
  };
  return { m, calls, stops: () => stops, faces: () => faces };
}

function furniture(g: any, id: string, x: number, y: number, floor = 0) {
  const frame = { x, y, w: 1, h: 0.12 };
  g.floors[floor].furniture.push({
    id,
    kind: "door",
    floor,
    x,
    y,
    w: 1,
    h: 0.12,
    door: {
      frame,
      hinge: { x: x - 0.5, y },
      latched: true,
      swung: false,
      side: 0,
    },
  });
  return g.floors[floor].furniture[g.floors[floor].furniture.length - 1];
}

test("social runtime creates social state lazily and is a no-op without escape", () => {
  const g = fixture(
    [
      { id: "human", kind: "player", x: 9, y: 15 },
      { id: "guard", kind: "npc", x: 11, y: 15 },
      { id: "chef", kind: "npc", x: 14, y: 15 },
      { id: "dead", kind: "npc", x: 16, y: 15 },
    ],
    "Security guard",
  );
  actor(g, "guard").role = "Security guard";
  actor(g, "chef").role = "Chef";
  actor(g, "dead").role = "Security guard";
  actor(g, "dead").alive = false;

  socialWorldTick(g, 0.1);
  assert.equal(actor(g, "guard").socialState.player.relationship, "colleague");
  assert.equal(actor(g, "chef").socialState.player.relationship, "stranger");
  assert.equal(actor(g, "dead").socialState, undefined);
  assert.equal(actor(g, "human").socialState, undefined);

  const bare = new TestRunner(emptyScenario(), roadmap).game;
  const before = JSON.stringify(bare.survivors);
  socialWorldTick(bare, 0.1);
  assert.equal(JSON.stringify(bare.survivors), before);
  assert.equal(socialStep(bare, bare.survivors[0], 0.1, motor().m), false);
});

test("a PA announcement raises alarm and queues at most two reaction prompts", () => {
  const g = fixture([
    { id: "human", kind: "player", x: 9, y: 15 },
    { id: "a", kind: "npc", x: 10, y: 15 },
    { id: "b", kind: "npc", x: 12, y: 15 },
    { id: "c", kind: "npc", x: 13, y: 15 },
    { id: "d", kind: "npc", x: 14, y: 15 },
  ]);
  g.escape.announcements.push({
    id: "ann-1",
    at: 0,
    kind: "escalation",
    text: "All staff report to the lobby.",
    areaId: "start",
  });
  socialWorldTick(g, 0.1);
  for (const id of ["a", "b", "c", "d"]) {
    const npc = actor(g, id);
    assert.ok(npc.socialState.alarm >= 0.69, `${id} alarmed`);
  }
  assert.equal(g.escape.prompts.length, 2);
  for (const prompt of g.escape.prompts) {
    assert.equal(
      prompt.reason,
      "react to the PA announcement: All staff report to the lobby.",
    );
    assert.equal(prompt.at, 0);
  }
});

test("visible suspicious work questions, then detains, the player", () => {
  const g = fixture(
    [
      { id: "human", kind: "player", x: 9, y: 15 },
      { id: "guard", kind: "npc", x: 11, y: 15 },
    ],
    "Security guard",
  );
  const human = actor(g, "human");
  const guard = actor(g, "guard");
  guard.role = "Security guard";
  socialWorldTick(g, 0.1);
  observe(
    guard.socialState,
    { kind: "running", at: 0, text: "Someone runs past.", weight: 0.3 },
    0,
  );
  human.station = "station-1";
  g.escape.tasks.push({
    id: "t1",
    title: "Hotwire the ignition",
    unit: "wires",
    steps: 3,
    done: 0,
    objectId: "shuttle",
    areaId: "start",
    fromFacts: [],
    state: "in-progress",
    stationId: "station-1",
  });

  g.time = 0;
  socialWorldTick(g, 0.1);
  assert.deepEqual(
    g.escape.prompts.map((p: { reason: string }) => p.reason),
    ["question the player about what they are doing: Hotwire the ignition"],
  );
  assert.ok(guard.socialState.player.suspicion > 0.3);

  g.time = 9;
  socialWorldTick(g, 0.1);
  assert.equal(guard.socialState.goal.kind, "detain");
  assert.equal(guard.socialState.goal.lastSeen.floor, human.floor);
  assert.equal(guard.socialState.goal.searchUntil, 69);
});

test("lead gives up when the player keeps walking away", () => {
  const g = fixture([
    { id: "human", kind: "player", x: 2, y: 2 },
    { id: "guide", kind: "npc", x: 20, y: 20 },
  ]);
  const human = actor(g, "human");
  const guide = actor(g, "guide");
  guide.role = "Guide";
  furniture(g, "exit-door", 30, 20);
  socialWorldTick(g, 0.1);
  guide.socialState.checkBackSeconds = 1;
  applySocialOutcome(g, "guide", { kind: "lead", targetId: "exit-door" });
  assert.equal(guide.socialState.goal.kind, "lead");
  assert.equal(guide.socialState.goal.label, "exit-door");

  const { m, calls } = motor();
  let walkedOff = false;
  for (let t = 0; t <= 26; t += 2) {
    g.time = t;
    human.x = 2 + t * 0.1;
    human.y = 2;
    const handled = socialStep(g, guide, 0.1, m);
    if (!handled) {
      walkedOff = true;
      break;
    }
  }
  assert.equal(walkedOff, true);
  assert.equal(guide.socialState.goal, undefined);
  assert.ok(
    guide.socialState.player.history.some(
      (rec: { kind: string }) => rec.kind === "walked-off",
    ),
  );
  assert.ok(
    g.escape.prompts.some(
      (p: { reason: string }) =>
        p.reason === "call out to the player who stopped following",
    ),
  );
  assert.ok(calls.length > 0);
});

test("a radio report puts the nearest guard on detain after five seconds", () => {
  const g = fixture([
    { id: "human", kind: "player", x: 9, y: 15 },
    { id: "pilot", kind: "npc", x: 10, y: 15 },
    { id: "guard", kind: "npc", x: 14, y: 15 },
  ]);
  const human = actor(g, "human");
  const pilot = actor(g, "pilot");
  const guard = actor(g, "guard");
  pilot.role = "Pilot";
  guard.role = "Security guard";
  socialWorldTick(g, 0.1);
  assert.equal(pilot.socialState.hasRadio, true);
  assert.equal(pilot.socialState.canDetain, false);
  applySocialOutcome(g, "pilot", { kind: "report" });
  const { m, stops } = motor();
  assert.equal(socialStep(g, pilot, 0.1, m), true);
  assert.equal(stops(), 1);
  assert.equal(guard.socialState.goal, undefined);

  g.time = 5;
  assert.equal(socialStep(g, pilot, 0.1, m), true);
  assert.equal(pilot.socialState.goal, undefined);
  assert.equal(guard.socialState.goal.kind, "detain");
  assert.deepEqual(guard.socialState.goal.lastSeen, {
    floor: human.floor,
    x: human.x,
    y: human.y,
    at: 0,
  });
  assert.ok(
    g.escape.log.some(
      (e: { kind: string; areaId: string }) =>
        e.kind === "report-delivered" && e.areaId === "start",
    ),
  );
});

test("panic drops a report and logs report-lost", () => {
  const g = fixture([
    { id: "human", kind: "player", x: 9, y: 15 },
    { id: "guard", kind: "npc", x: 11, y: 15 },
  ]);
  const guard = actor(g, "guard");
  guard.role = "Security guard";
  socialWorldTick(g, 0.1);
  applySocialOutcome(g, "guard", { kind: "report" });
  assert.equal(guard.socialState.goal.kind, "report");
  observe(
    guard.socialState,
    {
      kind: "threat-seen",
      at: 0,
      text: "A hunter is right there.",
      weight: AWARENESS_WEIGHTS["threat-seen"],
    },
    0,
  );
  assert.ok(guard.socialState.alarm >= 0.7);

  const { m, calls } = motor();
  assert.equal(socialStep(g, guard, 0.1, m), true);
  assert.equal(guard.socialState.goal, undefined);
  assert.ok(
    g.escape.log.some(
      (e: { kind: string; areaId: string }) =>
        e.kind === "report-lost" && e.areaId === "start",
    ),
  );
  assert.equal(calls.length, 1);
  assert.ok(calls[0].x > actor(g, "human").x);
});

test("outcomeContext lists only doors within reach and durable known facts", () => {
  const g = fixture([
    { id: "human", kind: "player", x: 9, y: 15 },
    { id: "guard", kind: "npc", x: 11, y: 15 },
  ]);
  const guard = actor(g, "guard");
  guard.role = "Security guard";
  furniture(g, "near-door", 12, 15);
  furniture(g, "far-door", 20, 15);
  g.escape.ledger.facts.push(
    {
      id: "f1",
      text: "The hatch bolts are loose.",
      subject: { kind: "object", id: "shuttle" },
      source: "document",
      visibility: ["public"],
      durable: true,
    },
    {
      id: "f2",
      text: "A rumour.",
      subject: { kind: "object", id: "shuttle" },
      source: "document",
      visibility: ["public"],
      durable: false,
    },
  );
  g.escape.areas.portals.push({
    id: "portal-1",
    from: "start",
    to: "next",
    transition: "door",
    at: { floor: 0, x: 5, y: 5 },
    label: "Exit",
  });

  const ctx = outcomeContext(g, "guard");
  assert.equal(ctx.canDetain, true);
  assert.deepEqual(ctx.atDoorIds, ["near-door"]);
  assert.deepEqual(ctx.knownFactIds, ["f1"]);
  assert.ok(ctx.leadTargets.includes("near-door"));
  assert.ok(ctx.leadTargets.includes("far-door"));
  assert.ok(ctx.leadTargets.includes("portal-1"));
});
