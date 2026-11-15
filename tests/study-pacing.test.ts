import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { board, complete, step, vault } from "../src/engine";
import { emptyScenario, parseScenario } from "../src/gametest/schema";
import {
  CONFIG,
  type Game,
  type Roadmap,
  type Zombie,
  distance,
} from "../src/model";
import { simulationActive } from "../src/simulation-state";
import { STUDY_PACING, pacingProfile } from "../src/study-pacing";
import { createGame, createPlayableGame } from "../src/world";

const roadmap = (): Roadmap =>
  JSON.parse(readFileSync("public/curriculum.json", "utf8"));
const idle = { x: 0, y: 0, grab: false };
function run(g: Game, seconds: number) {
  const ticks = Math.round(seconds / 0.1);
  for (let i = 0; i < ticks; i++) step(g, 0.1, idle);
}
function zombieAt(id: string, x: number, y: number, floor = 0): Zombie {
  return {
    id,
    floor,
    x,
    y,
    hp: 60,
    path: [],
    repath: 0,
    cooldown: 0,
    memory: 0,
    stagger: 0,
    origin: "outside",
  };
}
const totalThought = (g: Game) =>
  g.survivors.slice(1).reduce((n, a) => n + a.thought, 0);

test("simulationActive gates only not-yet-started runs", () => {
  assert.equal(simulationActive({ status: "ready" }), false);
  assert.equal(simulationActive({ status: "playing" }), true);
  assert.equal(simulationActive({ status: "dead" }), true);
  assert.equal(simulationActive({ status: "escaped" }), true);
});

test("fresh playable runs use study pacing; legacy createGame keeps historical timing", () => {
  const fresh = createPlayableGame(21, roadmap());
  assert.equal(fresh.pacing, "study");
  assert.equal(fresh.nextSpawn, STUDY_PACING.swarmInterval);
  assert.ok(
    fresh.zombies.length > 0,
    "fresh city fronts already exist in the distance",
  );
  assert.equal(fresh.helicopter.next, 480);
  const legacy = createGame(21, roadmap());
  assert.equal(legacy.pacing, undefined);
  assert.equal(legacy.nextSpawn, CONFIG.spawnGraceSeconds);
  assert.equal(legacy.helicopter.next, 240);
  assert.equal(pacingProfile(legacy).npcThinkingScale, 1);
  // Movement stays responsive: speeds are not part of pacing.
  assert.equal(fresh.survivors[0].speed, legacy.survivors[0].speed);
  assert.equal(fresh.survivors[0].speed, CONFIG.playerSpeed);
});

test("the study grace window is physical travel time while distant replenishment stays gradual and bounded", () => {
  const g = createPlayableGame(5, roadmap());
  g.status = "playing";
  g.survivors = g.survivors.slice(0, 1);
  const initial = g.spawned,
    gate = g.floors[0].furniture.find((o) => o.id === "main-gate")!;
  assert.ok(
    initial >= 60 && initial <= 90,
    `initial street fronts: ${initial}`,
  );
  run(g, 9.5);
  assert.ok(g.time < STUDY_PACING.zombieGraceSeconds);
  assert.ok(g.spawned > initial && g.spawned <= initial + 3);
  assert.ok(
    g.zombies.every((z) => distance(z, gate) > 200),
    "new arrivals walk from the distant city instead of materializing at the building",
  );
  assert.equal(g.events.filter((e) => e.type === "barricade-hit").length, 0);
  run(g, 10.6);
  assert.ok(
    g.spawned >= initial + 5,
    `spawned ${g.spawned - initial} reinforcements`,
  );
  assert.ok(
    g.spawned <= initial + 7,
    `spawned ${g.spawned - initial} reinforcements`,
  );
  assert.ok(g.zombies.length <= STUDY_PACING.swarmCap);
  assert.equal(g.events.filter((e) => e.type === "barricade-hit").length, 0);

  const legacy = createGame(5, roadmap());
  legacy.status = "playing";
  legacy.survivors = legacy.survivors.slice(0, 1);
  run(legacy, 20);
  assert.ok(legacy.spawned > 4, `legacy spawned ${legacy.spawned}`);
});

test("recurring helicopter follows the study schedule", () => {
  const g = createPlayableGame(9, roadmap());
  g.status = "playing";
  g.survivors = g.survivors.slice(0, 1);
  g.nextSpawn = 1e9;
  g.zombies = [];
  g.time = 479.95;
  run(g, 0.2);
  assert.equal(g.helicopter.trip, 1);
  const next = g.helicopter.next - g.time;
  assert.ok(Math.abs(next - 180) < 0.2, `next pickup in ${next}`);
  g.time = g.helicopter.next - 0.05;
  run(g, 0.2);
  assert.equal(g.helicopter.trip, 2);
});

test("study pacing slows NPC reasoning progress relative to legacy timing", () => {
  const fresh = createPlayableGame(13, roadmap());
  fresh.status = "playing";
  fresh.nextSpawn = 1e9;
  fresh.zombies = [];
  const legacy = structuredClone(fresh);
  delete legacy.pacing;
  run(fresh, 30);
  run(legacy, 30);
  const f = totalThought(fresh),
    l = totalThought(legacy);
  assert.ok(l > 1, `legacy thought ${l}`);
  assert.ok(f > 0, `study thought ${f}`);
  const ratio = f / l;
  assert.ok(ratio > 0.12 && ratio < 0.45, `ratio ${ratio}`);
});

test("study tempo applies to working, fortifying, stair travel and vault reasoning", () => {
  for (const activity of [
    "working",
    "fortifying",
    "stairs",
    "vault",
  ] as const) {
    const g = createGame(11, roadmap());
    g.status = "playing";
    g.nextSpawn = Number.MAX_SAFE_INTEGER;
    g.survivors = g.survivors.slice(0, 2);
    g.survivors[0].floor = 1;
    const a = g.survivors[1],
      f = g.floors[0],
      e = g.encounters["f0-room1"];
    f.tiles = Array.from({ length: 34 }, () => Array(44).fill(0));
    const shelf = f.furniture.find((o) => o.kind === "shelf")!;
    Object.assign(shelf, { x: 10.5, y: 10.5, w: 1, h: 2.8 });
    f.furniture = [shelf];
    f.stations = [{ id: "study", encounter: e.id, x: 9.45, y: 10.5 }];
    Object.assign(a, {
      x: 9.45,
      y: 10.5,
      intent: e.id,
      thought: 0,
      role: "rusher",
      risk: 0.9,
      seen: ["study"],
      heading: { x: 1, y: 0 },
    });
    e.owner = a.id;
    if (activity === "fortifying") {
      a.role = "builder";
      a.defensePlan = {
        encounter: e.id,
        object: shelf.id,
        target: { x: 14.5, y: 10.5 },
        route: [{ x: 14.5, y: 10.5 }],
        idle: 0,
      };
    }
    if (activity === "stairs") {
      Object.assign(a, f.stairs);
      a.access = [0];
      a.stairTravel = {
        fromFloor: 0,
        toFloor: 1,
        origin: { ...f.stairs },
        destination: { ...g.floors[1].entry },
        until: 3,
      };
    }
    if (activity === "vault") assert.equal(vault(g, a, shelf.id), true);
    const study = structuredClone(g);
    study.pacing = "study";
    step(g, 0.1);
    step(study, 0.1);
    const normal = a.thought,
      slower = study.survivors[1].thought;
    assert.ok(normal > 0, `${activity}: normal reasoning must progress`);
    assert.ok(
      Math.abs(slower / normal - 0.25) < 1e-10,
      `${activity}: ${slower}/${normal}`,
    );
    if (activity === "fortifying") assert.equal(a.activity, "defending");
    if (activity === "stairs") assert.ok(a.stairTravel);
    if (activity === "vault") assert.ok(a.vault);
  }
});

test("historical ended saves capture their original time before spectator ticks", () => {
  for (const status of ["dead", "escaped"] as const) {
    const g = createGame(31, roadmap());
    g.status = status;
    g.time = 72;
    g.survivors[0].alive = status !== "dead";
    g.survivors[0].escaped = status === "escaped";
    step(g, 0.1);
    assert.equal(g.endedAt, 72);
    step(g, 0.1);
    assert.equal(g.endedAt, 72);
    assert.ok(g.time > 72.1);
  }
});

test("an ended human cannot receive a delayed key while living NPCs still can", () => {
  for (const status of ["dead", "escaped"] as const) {
    const g = createPlayableGame(31, roadmap());
    g.status = status;
    // Status is authoritative even if an older/incomplete save has stale
    // actor flags. The other survivors remain eligible for their own reward.
    const h = g.survivors[0],
      a = g.survivors[1];
    const e = Object.values(g.encounters).find((e) => e.reward === "stairs")!;
    h.keys = a.keys = 0;
    h.access = [];
    a.access = [];
    assert.equal(complete(g, e.id, "delayed", [h.id, a.id], "test"), true);
    assert.equal(h.keys, 0);
    assert.deepEqual(h.access, []);
    assert.equal(a.keys, 1);
    assert.ok(a.access.includes(e.floor));
    assert.equal(complete(g, e.id, "delayed", [h.id, a.id], "retry"), false);
    assert.equal(a.keys, 1);
  }
});

test("spectator scenario extensions accept bounded data and reject malformed actions/queries", () => {
  const s = emptyScenario();
  for (const patch of [
    { pacing: "fast" },
    { actions: [{ tick: 1, type: "pause", paused: "yes" }] },
    {
      simulation: "physics",
      actions: [{ tick: 1, type: "pause", paused: true }],
    },
    {
      checks: [
        {
          name: "bad",
          mode: "always",
          query: { type: "sinceEnd", metric: "eval" },
          op: "gte",
          expected: 1,
        },
      ],
    },
    {
      checks: [
        {
          name: "bad",
          mode: "always",
          query: { type: "worldTime", id: "human" },
          op: "gte",
          expected: 1,
        },
      ],
    },
  ])
    assert.throws(() => parseScenario({ ...s, ...patch }));
  assert.doesNotThrow(() =>
    parseScenario({
      ...s,
      pacing: "study",
      simulation: "game",
      actions: [{ tick: 1, type: "pause", paused: true }],
      checks: [
        {
          name: "time",
          mode: "always",
          query: { type: "worldTime" },
          op: "gte",
          expected: 0,
        },
      ],
    }),
  );
});

test("world keeps advancing after the human is killed in combat; pause still freezes it", () => {
  const g = createPlayableGame(17, roadmap());
  g.status = "playing";
  g.nextSpawn = 1e9;
  run(g, 3);
  const h = g.survivors[0];
  h.hp = 5;
  g.zombies.push(zombieAt("killer", h.x + 0.55, h.y, h.floor));
  for (let i = 0; i < 40 && g.status === "playing"; i++) step(g, 0.1, idle);
  assert.equal(g.status, "dead");
  assert.equal(h.alive, false);
  const endedAt = g.endedAt;
  assert.equal(typeof endedAt, "number");
  const pos = { x: h.x, y: h.y, floor: h.floor, keys: h.keys ?? 0 };
  const t0 = g.time,
    thought0 = totalThought(g),
    tick0 = g.tick ?? 0;
  const npcs0 = g.survivors.slice(1).map((a) => `${a.x},${a.y}`);
  const zombie0 = g.zombies.map((z) => `${z.x},${z.y}`);
  for (let i = 0; i < 50; i++) step(g, 0.1, { x: 1, y: 0, grab: false });
  assert.ok(g.time - t0 > 4.9, `time advanced ${g.time - t0}`);
  assert.equal((g.tick ?? 0) - tick0, 50);
  assert.ok(totalThought(g) > thought0, "NPC reasoning continued");
  const npcs1 = g.survivors.slice(1).map((a) => `${a.x},${a.y}`);
  assert.ok(
    npcs1.some((p, i) => p !== npcs0[i]),
    "NPCs moved",
  );
  const zombie1 = g.zombies.map((z) => `${z.x},${z.y}`);
  assert.ok(
    zombie1.some((p, i) => p !== zombie0[i]),
    "zombies moved",
  );
  assert.equal(g.status, "dead");
  assert.equal(h.alive, false);
  // The body stays where it fell and earns nothing; the ghost walks on the
  // player's input.
  assert.deepEqual(h.ghost?.body, { x: pos.x, y: pos.y, floor: pos.floor });
  assert.equal(h.keys ?? 0, pos.keys);
  assert.ok(h.x > pos.x + 1, "the ghost walked east on the held input");
  assert.equal(g.endedAt, endedAt);
  const saved = JSON.parse(JSON.stringify(g)) as Game;
  assert.equal(saved.endedAt, endedAt);
  g.paused = true;
  const frozen = g.time;
  run(g, 1);
  assert.equal(g.time, frozen);
  g.paused = false;
  run(g, 0.5);
  assert.ok(g.time > frozen);
});

test("world keeps advancing after extraction without rewarding the human, whose ghost walks on", () => {
  const g = createPlayableGame(19, roadmap());
  g.status = "playing";
  g.nextSpawn = 1e9;
  const h = g.survivors[0];
  h.floor = CONFIG.floors;
  h.x = 21.5;
  h.y = 10.5;
  g.helicopter.until = g.time + 20;
  assert.equal(board(g, h), true);
  assert.equal(g.status, "escaped");
  assert.equal(g.endedAt, g.time);
  const endedAt = g.endedAt;
  const pos = `${h.x},${h.y},${h.floor}`;
  const keys = h.keys ?? 0;
  const t0 = g.time,
    thought0 = totalThought(g);
  for (let i = 0; i < 40; i++) step(g, 0.1, { x: 0, y: 1, grab: false });
  assert.ok(g.time - t0 > 3.9);
  assert.ok(totalThought(g) > thought0);
  // An escaped human leaves no body; its ghost follows the held input.
  assert.notEqual(`${h.x},${h.y},${h.floor}`, pos);
  assert.equal(h.floor, CONFIG.floors);
  assert.deepEqual(h.ghost, {});
  assert.equal(h.keys ?? 0, keys);
  assert.equal(g.status, "escaped");
  assert.equal(g.endedAt, endedAt);
});
