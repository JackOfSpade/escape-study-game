import { stationSpot } from "../src/spatial";
import { withCompletionProvider } from "./helpers/completion-provider";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  closeChat,
  edit,
  ensureProblem,
  openChat,
  responders,
  submit,
} from "../src/ai";
import {
  beginVisit,
  eligible,
  finishVisit,
  initialStudy,
  validateAssessment,
} from "../src/curriculum";
import {
  board,
  complete,
  human,
  pushFurniture,
  stairs,
  step,
  takeLoot,
  tickSurge,
  toggleDoor,
  useItem,
  vault,
} from "../src/engine";
import {
  CONFIG,
  distance,
  rand,
  type Floor,
  type Furniture,
  type Point,
  type Roadmap,
} from "../src/model";
import { closeDoorByContact } from "../scripts/lib/defense-scenario";
import { survivorPath, type NavStep } from "../src/navigation";
import { decode, encode, recover } from "../src/persistence";
import { path, soundGain } from "../src/spatial";
import { createGame } from "../src/world";
const roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
) as Roadmap;
const fixture = (seed = 42) => createGame(seed, roadmap);
const empty = (index = 0): Floor => ({
  index,
  tiles: Array.from({ length: 34 }, (_, y) =>
    Array.from({ length: 44 }, (_, x) =>
      x < 1 || x > 42 || y < 1 || y > 32 ? 1 : 0,
    ),
  ),
  stations: [],
  furniture: [],
  dark: 0,
  name: "fixture",
  doors: [],
  stairs: { x: 21.5, y: 3.5 },
  entry: { x: 21.5, y: 26.5 },
});
function box(id: string, x: number, y: number, w = 1, h = 1): Furniture {
  return {
    id,
    floor: 0,
    x,
    y,
    w,
    h,
    kind: "desk",
    hp: 100,
    maxHp: 100,
    speed: 1,
    rotation: 0,
    destroyed: false,
    movers: [],
    moved: 0,
    credited: [],
    turning: 0,
  };
}

test("F01/F02/H06 imported source and active scope preserve exact history", () => {
  assert.equal(roadmap.tracks.PY.objectives.length, 80);
  assert.equal(roadmap.tracks.PE.objectives.length, 112);
  assert.equal(
    roadmap.tracks.PY.objectives.filter((o) => o.cells[0] === "P").length,
    2,
  );
  assert.equal(
    roadmap.tracks.PE.objectives.filter((o) => o.cells[0] === "P").length,
    8,
  );
  assert.equal(
    roadmap.tracks.PY.objectives.reduce((n, o) => n + o.target, 0),
    240,
  );
  assert.equal(
    roadmap.tracks.PE.objectives.reduce((n, o) => n + o.target, 0),
    337,
  );
  assert.equal(
    createHash("sha256").update(roadmap.raw).digest("hex"),
    roadmap.sourceHash,
  );
  const s = initialStudy(roadmap);
  assert.equal(s.visits.length, 0);
  assert.equal(s.session, undefined);
  assert.deepEqual(s.queues.PY, [
    "T11",
    "T10",
    "T14",
    "T04",
    "T12",
    "T15",
    "T05",
  ]);
  assert.deepEqual(s.queues.PE, ["X09"]);
});
test("A08 randomized layouts stable with seed; reachable stairs and terminals over 40 seeds", () => {
  const shapes = new Set<string>();
  for (let seed = 1; seed <= 40; seed++) {
    const g = fixture(seed);
    shapes.add(JSON.stringify(g.floors[0].doors));
    assert.deepEqual(g.floors, fixture(seed).floors);
    for (const f of g.floors) {
      assert.ok(path({ ...f, furniture: [] }, f.entry, f.stairs).length);
      for (const st of f.stations)
        assert.ok(
          path({ ...f, furniture: [] }, f.entry, st).length,
          `Unreachable ${st.id} seed ${seed}`,
        );
    }
  }
  assert.ok(shapes.size > 20);
});
test("A01/A02 zombies only originate outside and entrance starts physically latched", () => {
  const g = fixture();
  g.status = "playing";
  assert.equal(
    g.floors[0].furniture.find((o) => o.id === "main-gate")!.door?.latched,
    true,
  );
  for (let i = 0; i < 110; i++) step(g, 0.1);
  assert.ok(g.zombies.length > 0);
  for (const z of g.zombies) {
    assert.equal(z.origin, "outside");
    assert.equal(z.floor, 0);
    assert.ok(z.y > 28);
  }
  assert.equal(
    g.events.some((e) => e.type === "entrance-close"),
    false,
  );
});
test("A06/A07 personal access separate from another survivor and zombie route", () => {
  const g = fixture(),
    a = human(g),
    e = g.encounters["f0-room0"];
  Object.assign(a, g.floors[0].stairs);
  assert.equal(stairs(g, a), false);
  complete(g, e.id, "test", ["npc-0"], "fixture");
  assert.equal(stairs(g, a), false);
  assert.ok(
    path(g.floors[0], g.floors[0].entry, g.floors[0].stairs, true).length,
  );
  complete(g, "f0-room1", "human", ["human"], "fixture");
  assert.equal(stairs(g, a), true);
  assert.equal(a.floor, 0);
  g.status = "playing";
  for (let i = 0; i < 60; i++) step(g, 1 / 30);
  assert.equal(a.floor, 1);
  assert.equal(a.access.includes(1), false);
});
test("A09/A10/A11 four atomic seats, later pickups remain available", () => {
  const g = fixture();
  g.time = 300;
  g.helicopter.until = 320;
  g.helicopter.next = 400;
  for (const a of g.survivors.slice(0, 6)) {
    a.floor = CONFIG.floors;
    a.x = 21.5;
    a.y = 10.5;
  }
  assert.deepEqual(
    g.survivors.slice(0, 6).map((a) => board(g, a)),
    [true, true, true, true, false, false],
  );
  g.status = "playing";
  g.time = 399.95;
  step(g, 0.1);
  assert.equal(g.helicopter.passengers.length, 0);
  assert.ok(g.helicopter.until > g.time);
  assert.equal(board(g, g.survivors[4]), true);
});
test("B01/B03 damage retained during moving with helpers; handling improves without HP bonus", () => {
  const g = fixture();
  g.floors[0] = empty();
  const o = box("test", 10, 10);
  g.floors[0].furniture = [o];
  o.hp = 42;
  const a = human(g),
    helper = g.survivors[1];
  a.x = 8.5;
  a.y = 10;
  helper.x = 9;
  helper.y = 11;
  assert.ok(pushFurniture(g, a, 1, 0, 0.1));
  const single = o.x - 10;
  helper.handling = o.id;
  const prev = o.x;
  assert.ok(pushFurniture(g, a, 1, 0, 0.1));
  assert.ok(o.x - prev > single);
  assert.equal(o.hp, 42);
  assert.equal(o.maxHp, 100);
});
test("B02/B06/B07 furniture has independent footprints and weak gaps open", () => {
  const f = empty();
  for (let y = 1; y < 33; y++) f.tiles[y][20] = 1;
  for (let y = 14; y < 17; y++) f.tiles[y][20] = 0;
  const a = box("fridgeA", 20.5, 14.5, 1, 1),
    b = box("chair", 20.5, 15.5, 1, 1),
    c = box("fridgeB", 20.5, 16.5, 1, 1);
  f.furniture = [a, b, c];
  assert.equal(path(f, { x: 18.5, y: 15.5 }, { x: 23.5, y: 15.5 }).length, 0);
  b.destroyed = true;
  assert.ok(path(f, { x: 18.5, y: 15.5 }, { x: 23.5, y: 15.5 }).length);
  assert.equal(a.hp, 100);
  assert.equal(c.hp, 100);
});
test("B09/B10 vault checks landing and wall crossing", () => {
  const g = fixture();
  g.floors[0] = empty();
  g.survivors = g.survivors.slice(0, 1);
  const a = human(g);
  a.x = 8.9;
  a.y = 10.5;
  a.heading = { x: 1, y: 0 };
  g.floors[0].furniture = [box("test", 10.5, 10.5)];
  assert.equal(vault(g, a), true);
  delete a.vault;
  g.floors[0].tiles[10][11] = 1;
  assert.equal(vault(g, a), false);
});
test("B11/B12/B13/B14 sound follows open paths and layered separation", () => {
  const f = empty();
  for (let y = 1; y < 33; y++) {
    f.tiles[y][15] = 1;
    f.tiles[y][20] = 1;
  }
  f.tiles[15][15] = 0;
  f.tiles[15][20] = 0;
  const first = box("first", 15.5, 15.5),
    second = box("second", 20.5, 15.5);
  f.furniture = [first, second];
  const a = { x: 10.5, y: 15.5 },
    b = { x: 25.5, y: 15.5 };
  assert.ok(soundGain(f, a, b) < 0.1);
  first.destroyed = true;
  assert.ok(soundGain(f, a, b) < 0.1);
  second.destroyed = true;
  assert.equal(soundGain(f, a, b), 1);
  second.destroyed = false;
  f.tiles[12][20] = 0;
  assert.ok(soundGain(f, a, b) > 0.1);
});
test("C01/C03/C04/C14 exact drafts, messages, consumed state and RNG survive encode/decode", async () => {
  const g = fixture(),
    e = g.encounters["f0-room0"];
  await ensureProblem(g, e, roadmap);
  edit(g, e, "my own draft", 0);
  e.group.push({
    id: "m",
    author: "human",
    kind: "human",
    text: "persistent message",
    seq: 1,
    worldTime: 1,
    presented: 1,
    provenance: "human",
  });
  const before = encode(g),
    saved = decode(before);
  assert.equal(encode(saved), before);
  assert.equal(saved.encounters[e.id].workspace, "my own draft");
  assert.equal(saved.encounters["f0-room1"].workspace, "");
  assert.equal(
    saved.floors[0].stations.filter((s) => s.encounter === e.id).length,
    5,
  );
  assert.equal(rand(g), rand(saved));
});
test("C05/C06/C07/C08 async snapshot completion is once-only and accepted revision freezes", async () => {
  const g = fixture(),
    e = g.encounters["f0-room0"];
  await ensureProblem(g, e, roadmap);
  edit(
    g,
    e,
    `${e.problem!.validation!.answer} is the predicted value. I checked every consecutive window and maintained a fixed window size. Empty input needs a defined contract.`,
    0,
  );
  const accepted = e.workspace;
  await withCompletionProvider(async () => {
    const p = submit(g, e, roadmap);
    edit(g, e, "later incomplete work", e.revision);
    await p;
  });
  assert.equal(e.state, "consumed");
  assert.equal(e.workspace, accepted);
  assert.equal(e.submissions[0].revision, 1);
  assert.equal(complete(g, e.id, "again", ["human"], "duplicate"), false);
  assert.deepEqual(human(g).access, [0]);
  assert.equal(edit(g, e, "stale write", e.revision), false);
  assert.equal(g.study.assessments[0].status, "review-required");
  assert.equal(
    roadmap.tracks.PY.objectives.filter((o) => o.cells[0] === "P").length,
    2,
  );
});
test("D01/D04 defender qualifies for access with zero mastery and late join does not", () => {
  const g = fixture(),
    e = g.encounters["f0-room0"];
  e.contributors = ["human", "npc-0"];
  complete(g, e.id, "npc-sim", e.contributors, "simulation");
  assert.ok(human(g).access.includes(0));
  assert.equal(g.survivors[2].access.length, 0);
  assert.equal(g.study.assessments.length, 0);
  assert.equal(g.study.version, 0);
});
test("C15 shared container finite, capacity enforced and no duplicate loot", () => {
  const g = fixture(),
    a = human(g),
    e = g.encounters["f0-room2"];
  const st = g.floors[0].stations.find((s) => s.encounter === e.id)!;
  a.x = st.x;
  a.y = st.y;
  complete(g, e.id, "fixture", ["human"], "fixture");
  e.contributors = ["human"];
  a.inventory = [{ id: "heavy", kind: "medkit", weight: 6, charges: 1 }];
  const id = e.loot[0].id;
  assert.equal(takeLoot(g, a, e.id, id), false);
  a.inventory = [];
  assert.equal(takeLoot(g, a, e.id, id), true);
  assert.equal(takeLoot(g, a, e.id, id), false);
});
test("C16 bubble expires into knockback/stagger with no mass kill", () => {
  const g = fixture();
  g.floors[0] = empty();
  g.survivors = g.survivors.slice(0, 1);
  const a = human(g);
  a.x = 20;
  a.y = 20;
  a.inventory = [{ id: "bubble", kind: "bubble", weight: 1, charges: 1 }];
  g.status = "playing";
  useItem(g, a, "bubble");
  g.zombies = [
    {
      id: "fixture",
      x: 23.8,
      y: 20,
      floor: 0,
      hp: 60,
      path: [],
      repath: 0,
      cooldown: 0,
      memory: 0,
      stagger: 0,
      origin: "outside",
    },
  ];
  g.time = 22;
  g.status = "playing";
  g.nextSpawn = 100;
  step(g, 0.1);
  assert.equal(g.zombies[0].hp, 60);
  assert.ok(g.zombies[0].stagger > 0);
  assert.ok(g.zombies[0].x > 23.8);
});
test("E07/E08 on-demand catch-up appends once and open chat stays silent", () => {
  const g = fixture(),
    e = g.encounters["f0-room0"];
  e.history.push({
    seq: 1,
    at: 1,
    author: "npc-0",
    kind: "npc-thought",
    text: "Maya read the contract.",
    revision: 0,
  });
  g.seq = 1;
  openChat(g, e);
  const history = JSON.stringify(e.group);
  closeChat(g, e);
  openChat(g, e);
  assert.equal(JSON.stringify(e.group), history);
  openChat(g, e);
  assert.equal(JSON.stringify(e.group), history);
});
test("E09/E10/E11 selective responders vary across seeds, direct address matters", () => {
  const speakers = new Set<string>();
  let direct = 0;
  for (let seed = 1; seed <= 100; seed++) {
    const g = fixture(seed),
      e = g.encounters["f0-room0"];
    for (const a of g.survivors.slice(1)) {
      a.intent = e.id;
      a.thought = 30;
      a.floor = 0;
      a.x = 10;
      a.y = 6;
    }
    const selected = responders(g, e, "What assumption should we check?");
    assert.ok(selected.length < g.survivors.length - 1);
    selected.forEach((a) => speakers.add(a.id));
    if (
      responders(g, e, "Maya, what do you think?").some(
        (a) => a.name === "Maya",
      )
    )
      direct++;
  }
  assert.ok(speakers.size > 5);
  assert.ok(direct > 90);
});
test("F03/F04/F05/F06/F07 scheduled reviews then exact breadth order; ratio advances only on human visits", async () => {
  const g = fixture();
  assert.equal(eligible(roadmap, g.study).objectiveIds[0], "PY:T05.2");
  for (let i = 0; i < 6; i++) {
    const e = g.encounters[`f${Math.floor(i / 4)}-room${i % 4}`];
    await ensureProblem(g, e, roadmap);
    const c = e.problem!.contract;
    assert.equal(c.track, ["PY", "PE", "PE"][i % 3]);
    assert.equal(c.depth, 1);
    beginVisit(roadmap, g.study, e);
    finishVisit(roadmap, g.study, e, "2026-10-15");
  }
  assert.equal(g.study.visits[2].contract.objectiveIds[0], "PE:X09.1");
  assert.equal(g.study.visits[3].contract.objectiveIds[0], "PY:T11.1");
  assert.equal(g.study.visits.length, 6);
});
test("F09/F11/F13/F23 assessment rejects NPC evidence and out of scope; no automatic passes", async () => {
  const g = fixture(),
    e = g.encounters["f0-room0"];
  await ensureProblem(g, e, roadmap);
  e.history.push({
    seq: 1,
    author: "npc-0",
    kind: "edit",
    text: "solution",
    at: 1,
    revision: 1,
  });
  assert.throws(() =>
    validateAssessment(roadmap, e, {
      id: "a",
      encounter: e.id,
      sourceVersion: 0,
      status: "pending",
      provenance: "test",
      findings: [
        {
          objectiveId: "PY:T05.2",
          facet: "trace",
          outcome: "independent",
          evidence: [1],
          completeCheckpointScope: true,
          rationale: "NPC did it",
        },
      ],
    }),
  );
  assert.throws(() =>
    validateAssessment(roadmap, e, {
      id: "a",
      encounter: e.id,
      sourceVersion: 0,
      status: "pending",
      provenance: "test",
      findings: [
        {
          objectiveId: "PE:T99.9",
          facet: "x",
          outcome: "unknown",
          evidence: [],
          completeCheckpointScope: false,
          rationale: "wrong scope",
        },
      ],
    }),
  );
});
test("G01/G03/G04/G05/G08/G10 Surge fixed-duration state survives reload; only multipliers apply", () => {
  const g = fixture(),
    prompt = JSON.stringify(g.encounters);
  g.surge.quietDelay = 10;
  g.time = 10;
  tickSurge(g);
  assert.equal(g.surge.state, "warning");
  const duration = g.surge.duration;
  g.time = 23;
  tickSurge(g);
  assert.equal(g.surge.state, "active");
  g.surge.lastDeath = 25;
  const loaded = decode(encode(g));
  assert.deepEqual(loaded.surge, g.surge);
  g.time = 23 + duration - 0.01;
  tickSurge(g);
  assert.equal(g.surge.state, "active");
  g.time = 23 + duration;
  tickSurge(g);
  assert.equal(g.surge.state, "calm");
  assert.equal(g.surge.anchor, g.time);
  assert.equal(JSON.stringify(g.encounters), prompt);
});
test("H03 restart converts interrupted evaluation to retryable error without erasing work", () => {
  const g = fixture(),
    e = g.encounters["f0-room0"];
  e.workspace = "draft";
  e.state = "submitted";
  e.submissions.push({
    id: "s",
    author: "human",
    revision: 0,
    content: "captured",
    status: "pending",
    feedback: "waiting",
    seq: 0,
  });
  recover(g);
  assert.equal(e.state, "in-progress");
  assert.equal(e.workspace, "draft");
  assert.equal(e.submissions[0].content, "captured");
  assert.equal(e.submissions[0].status, "error");
  assert.throws(() => decode(encode(g).replace("draft", "fraud")));
});

test("integrated escape at 30 Hz: legal human movement, four puzzle snapshots, individual stairs and recurring helicopter", async (t) => {
  const g = fixture(2026);
  g.status = "playing";
  const a = human(g);
  function walkTo(target: Point) {
    let reached = false;
    let cached: NavStep[] = [];
    let stalled = 0;
    for (let i = 0; i < 9000; i++) {
      if (!a.alive)
        throw Error(
          `Human died en route on floor ${a.floor} at ${a.x},${a.y}, time=${g.time}`,
        );
      if (distance(a, target) < 0.45) {
        reached = true;
        break;
      }
      if (a.vault) {
        step(g, 1 / 30);
        continue;
      }
      const f = g.floors[a.floor];
      while (cached[0] && distance(a, cached[0]) < 0.04) cached.shift();
      if (!cached.length) cached = survivorPath(f, a, target);
      if (!cached.length) {
        const doors = f.furniture
          .filter((o) => o.kind === "door" && !o.open && !o.destroyed)
          .sort((b, c) => distance(a, b) - distance(a, c));
        for (const door of doors) {
          const route = survivorPath(f, a, door);
          if (route.length) {
            cached = route;
            break;
          }
        }
      }
      const next = cached[0];
      if (!next) {
        step(g, 1 / 30);
        continue;
      }
      const dx = next.x - a.x,
        dy = next.y - a.y,
        n = Math.hypot(dx, dy) || 1;
      a.heading = { x: dx / n, y: dy / n };
      const obstacle = f.furniture.find(
        (o) => o.id === next.obstacle && !o.destroyed && !o.open,
      );
      if (next.action && obstacle) {
        if (next.action === "door") {
          if (toggleDoor(g, a, obstacle.id, true)) cached = [];
        } else vault(g, a, obstacle.id);
        step(g, 1 / 30);
        continue;
      }
      const before = { x: a.x, y: a.y };
      step(g, Math.min(1 / 30, n / a.speed), {
        x: dx / n,
        y: dy / n,
        grab: false,
      });
      stalled = distance(a, before) < 0.001 ? stalled + 1 : 0;
      if (stalled > 15) {
        cached = [];
        stalled = 0;
      }
    }
    assert.ok(
      reached,
      `No legal route to ${target.x},${target.y} on ${a.floor}`,
    );
  }
  // The physical entrance must be pushed shut; it no longer closes by timer.
  walkTo({ x: 22, y: 27 });
  for (let i = 0; i < 180 && g.survivors.slice(1).some((n) => n.y > 28); i++)
    step(g, 1 / 30);
  closeDoorByContact(
    g,
    g.floors[0].furniture.find((o) => o.id === "main-gate")!,
  );
  for (let floor = 0; floor < 4; floor++) {
    const st = g.floors[floor].stations.find(
      (s) => s.encounter === `f${floor}-room0`,
    )!;
    walkTo(stationSpot(g.floors[a.floor], st));
    const e = g.encounters[st.encounter];
    assert.notEqual(e.state, "consumed");
    await ensureProblem(g, e, roadmap);
    edit(
      g,
      e,
      `${e.problem!.validation?.answer ?? "A defensible decision"} is my prediction. The contract and its preconditions must hold before and after each transition. I would verify the empty and boundary cases independently.`,
      e.revision,
    );
    await withCompletionProvider(() => submit(g, e, roadmap));
    assert.equal(e.state, "consumed");
    assert.ok(a.access.includes(floor));
    walkTo(g.floors[floor].stairs);
    // Walking into the staircase starts the flight by itself.
    assert.equal(!!a.stairTravel || stairs(g, a), true);
    for (let i = 0; i < 90 && a.stairTravel; i++) step(g, 1 / 30);
    assert.equal(a.floor, floor + 1);
  }
  // Prepare the roof's real stair chokepoint before waiting. This is an
  // intentional physical defense, not invulnerability or reduced zombie speed.
  walkTo({ x: 22.5, y: 19.3 });
  const roofCover = g.floors[4].furniture.find((o) => o.id === "roof-cover-0")!;
  for (let i = 0; i < 300 && roofCover.y < 22.45; i++)
    step(g, 1 / 30, { x: 0, y: 1, grab: true });
  assert.ok(roofCover.y > 22.4);
  walkTo({ x: 21.5, y: 10.5 });
  for (let i = 0; i < 30000 && !a.escaped && a.alive; i++) {
    if (board(g, a)) break;
    step(g, 1 / 30);
  }
  assert.equal(
    a.escaped,
    true,
    `No extraction at ${g.time}; hp=${a.hp}, seats=${g.helicopter.passengers.length}`,
  );
  assert.equal(g.status, "escaped");
  assert.equal(g.study.visits.length, 4);
  assert.equal(g.study.assessments.length, 4);
  assert.ok(g.zombies.length > 0);
  assert.ok(g.events.some((e) => e.type === "climb"));
  t.diagnostic(
    JSON.stringify({
      seed: g.seed,
      maximumStepSeconds: 1 / 30,
      seconds: g.time,
      hp: a.hp,
      trip: g.helicopter.trip,
      population: g.survivors.length,
      rescued: g.stats.rescued,
      deaths: g.stats.deaths,
      primaryDevelopmentVisits: g.study.visits.length,
      realHumanEvidence: g.study.learner?.evidence.length,
      scope:
        "oracle development answers/full-map route; physical integration only, not human balance or learning acceptance",
    }),
  );
});

test("NPC stations stay assigned while approaching; focused group work actually completes", () => {
  const g = fixture(91);
  g.status = "playing";
  g.nextSpawn = Number.MAX_SAFE_INTEGER;
  g.survivors = g.survivors.slice(0, 7);
  human(g).escaped = true;
  const e = g.encounters["f0-room0"];
  const stations = g.floors[0].stations.filter((s) => s.encounter === e.id);
  for (const [i, a] of g.survivors.slice(1).entries()) {
    a.x = stations[i % stations.length].x;
    a.y = stations[i % stations.length].y + 0.8;
    a.intent = e.id;
    a.role = "analyst";
    a.skill = 0.8;
  }
  for (let i = 0; i < 10; i++) step(g, 0.1);
  const ids = g.survivors
    .slice(1)
    .map((a) => a.station)
    .filter(Boolean);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 5);
  const assignments = g.survivors.slice(1, 6).map((a) => a.station);
  for (let i = 0; i < 10; i++) step(g, 0.1);
  assert.deepEqual(
    g.survivors.slice(1, 6).map((a) => a.station),
    assignments,
  );
  for (let i = 0; i < 700 && e.state !== "consumed"; i++) step(g, 0.1);
  assert.equal(e.state, "consumed");
  assert.ok(e.history.filter((h) => h.kind === "npc-thought").length >= 5);
  assert.ok(e.contributors.length >= 3);
  assert.equal(g.study.visits.length, 0);
});
