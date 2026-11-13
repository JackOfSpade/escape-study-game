import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decisionCalls, detailTier, stableHash, step } from "../src/engine";
import { H, W, distance, type Game, type Roadmap } from "../src/model";
import { siteAt, type Site } from "../src/site";
import { createPlayableGame } from "../src/world";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);

/** The continuous world's raster: the start building's 44 columns plus the
 * appended columns a stamped second site occupies far to the east. */
const COLS = 130,
  EAST = { left: 76, right: 116, top: 10, bottom: 16 },
  /** Stands next to the human, well inside the start building. */
  NEAR = { x: 6.5, y: 25.5 },
  /** Outdoors, 56 tiles from the human: between the two sites. */
  MIDDLE = { x: 60.5, y: 12.5 },
  /** Inside the stamped east site, more than 80 tiles from the human. */
  FAR = { x: 90.5, y: 12.5 },
  /** The human's own spot: inside the start building. */
  HOME = { x: 5.5, y: 25.5 };

/** A hand-built second site far east of the start building, rows in world y. */
function eastSite(): Site {
  return {
    id: "east",
    name: "East warehouse",
    origin: { x: EAST.left, y: EAST.top },
    floors: [0, 1],
    boundary: {
      version: 1,
      shape: "rectangle",
      width: EAST.right - EAST.left,
      depth: EAST.bottom - EAST.top,
      top: EAST.top,
      bottom: EAST.bottom,
      rows: Array.from({ length: H }, (_, y) =>
        y >= EAST.top && y < EAST.bottom
          ? { left: EAST.left, right: EAST.right }
          : { left: EAST.left, right: EAST.left },
      ),
    },
    stairs: { 0: { x: 79.5, y: 11.5 } },
    entry: { 1: { x: 79.5, y: 13.5 } },
  };
}

/** Grow every floor into the shared raster and stamp the east site into it. */
function fixture(seed = 7): Game {
  const g = createPlayableGame(seed, roadmap),
    site = eastSite();
  g.zombies = [];
  g.nextSpawn = Number.MAX_SAFE_INTEGER;
  for (const f of g.floors) {
    f.tiles = f.tiles.map((row) => [
      ...row,
      ...Array.from({ length: COLS - W }, () => 1),
    ]);
    if (!site.floors.includes(f.index)) continue;
    for (let y = EAST.top; y < EAST.bottom; y++)
      for (let x = EAST.left; x < EAST.right; x++) f.tiles[y][x] = 0;
    f.shells = [
      { site: site.id, boundary: site.boundary, origin: site.origin },
    ];
  }
  g.sites = [site];
  return g;
}

test("detail tiers follow distance and site membership", () => {
  const g = fixture(),
    human = g.survivors[0];
  Object.assign(human, { floor: 0, ...HOME });
  assert.equal(siteAt(g, 0, human)?.id, "start");
  // Same site and a tile away: full detail.
  assert.equal(detailTier(g, human, { floor: 0, ...NEAR }), 0);
  // Outdoors but nearer the neighbouring site than the human: tier 1.
  const middleGap = distance(human, MIDDLE);
  assert.ok(middleGap > 24 && middleGap <= 70, `middle gap ${middleGap}`);
  assert.equal(detailTier(g, human, { floor: 0, ...MIDDLE }), 1);
  // Inside the stamped site, more than 80 tiles away: tier 2.
  assert.equal(siteAt(g, 0, FAR)?.id, "east");
  const farGap = distance(human, FAR);
  assert.ok(farGap > 80, `far gap ${farGap}`);
  assert.equal(detailTier(g, human, { floor: 0, ...FAR }), 2);
  // Same footprint on another floor is still the human's own site.
  assert.equal(detailTier(g, human, { floor: 1, ...HOME }), 0);
  // Without extra sites every actor belongs to the start site, so the tier is
  // always 0; the throttling below is gated on `g.sites`, not on the tier.
  const legacy = createPlayableGame(7, roadmap);
  Object.assign(legacy.survivors[0], { floor: 0, ...HOME });
  assert.equal(
    detailTier(legacy, legacy.survivors[0], { floor: 0, ...FAR }),
    0,
  );
});

/** A two-actor crew at fixed places with no horde or spawner interference. */
function crew(g: Game) {
  g.status = "playing";
  g.zombies = [];
  g.nextSpawn = Number.MAX_SAFE_INTEGER;
  const human = g.survivors[0],
    npc = g.survivors[1];
  g.survivors = [human, npc];
  return { human, npc };
}

test("without extra sites an NPC decides on every tick", () => {
  const g = createPlayableGame(11, roadmap),
    { human, npc } = crew(g);
  Object.assign(human, { floor: 0, x: 21.5, y: 24.5 });
  Object.assign(npc, { floor: 0, x: 22.5, y: 24.5 });
  assert.equal(g.sites?.length ?? 0, 0);
  const before = decisionCalls.npc,
    decided: number[] = [],
    ticks: number[] = [];
  for (let i = 0; i < 20; i++) {
    const calls = decisionCalls.npc;
    step(g, 0.05);
    ticks.push(g.tick!);
    if (decisionCalls.npc > calls) decided.push(g.tick!);
  }
  // One decision per step, on every step.
  assert.equal(decisionCalls.npc - before, 20);
  assert.deepEqual(decided, ticks);
});

test("a far NPC decides only every tenth tick while still walking", () => {
  const g = fixture(),
    { human, npc } = crew(g);
  // The human stands in the stamped east site, so the NPC in the start
  // building is more than 70 tiles away and has a reachable own-floor route.
  Object.assign(human, { floor: 0, x: 110, y: 13 });
  Object.assign(npc, { floor: 0, x: 22.5, y: 24.5 });
  assert.equal(detailTier(g, human, npc), 2);
  const decided: number[] = [];
  let movedOnQuietTick = false;
  for (let i = 0; i < 60; i++) {
    const calls = decisionCalls.npc,
      from = { x: npc.x, y: npc.y };
    step(g, 0.05);
    if (decisionCalls.npc > calls) decided.push(g.tick!);
    else if (npc.alive && !npc.escaped && distance(from, npc) > 0.01)
      movedOnQuietTick = true;
  }
  assert.ok(
    decided.length >= 4 && decided.length <= 8,
    `far NPC decisions in 60 ticks: ${decided.length}`,
  );
  for (const tick of decided)
    assert.equal(
      (tick + stableHash(npc.id)) % 10,
      0,
      `the far NPC decided on tick ${tick}, off its tier-2 schedule`,
    );
  assert.ok(
    movedOnQuietTick,
    "a far NPC keeps walking on ticks without a decision",
  );
});

test("far catastrophe hunters think on every fourth tick", () => {
  const g = fixture(),
    { human, npc } = crew(g);
  Object.assign(human, { floor: 0, ...HOME });
  Object.assign(npc, { floor: 0, x: 22.5, y: 24.5 });
  const hunter = {
      id: "zhunter",
      floor: 0,
      ...FAR,
      hp: 100,
      path: [],
      repath: 0,
      cooldown: 0,
      memory: 0,
      stagger: 0,
      origin: "outside" as const,
      hunter: 0,
    },
    horde = {
      id: "zhorde",
      floor: 0,
      ...NEAR,
      hp: 100,
      path: [],
      repath: 0,
      cooldown: 0,
      memory: 0,
      stagger: 0,
      origin: "outside" as const,
    };
  assert.equal(detailTier(g, human, hunter), 2);
  assert.equal(detailTier(g, human, horde), 0);
  g.zombies = [hunter, horde];
  const hunterTicks: number[] = [],
    before = decisionCalls.zombie;
  for (let i = 0; i < 40; i++) {
    const calls = decisionCalls.zombie;
    step(g, 0.05);
    const decisions = decisionCalls.zombie - calls;
    // The nearby horde body decides every tick, so a second call is the
    // far hunter taking its scheduled decision.
    assert.ok(decisions === 1 || decisions === 2, `zombie calls: ${decisions}`);
    if (decisions === 2) hunterTicks.push(g.tick!);
  }
  assert.equal(
    decisionCalls.zombie - before,
    40 + hunterTicks.length,
    "the nearby horde body must decide every tick",
  );
  assert.ok(
    hunterTicks.length >= 8 && hunterTicks.length <= 11,
    `far hunter decisions in 40 ticks: ${hunterTicks.length}`,
  );
  for (const tick of hunterTicks)
    assert.equal(
      (tick + stableHash(hunter.id)) % 4,
      0,
      `the far hunter decided on tick ${tick}, off its tier-2 schedule`,
    );
});

test("two identical continuous worlds end the run in the same places", () => {
  const run = (seed: number) => {
    const g = fixture(seed),
      { human, npc } = crew(g);
    Object.assign(human, { floor: 0, x: 110, y: 13 });
    Object.assign(npc, { floor: 0, x: 22.5, y: 24.5 });
    const start = { x: npc.x, y: npc.y };
    for (let i = 0; i < 300; i++) step(g, 0.05);
    return {
      start,
      positions: g.survivors.map((a) => ({
        id: a.id,
        floor: a.floor,
        x: a.x,
        y: a.y,
      })),
    };
  };
  const first = run(7),
    second = run(7);
  assert.deepEqual(second.positions, first.positions);
  const npcEnd = first.positions[1];
  assert.ok(
    distance(first.start, npcEnd) > 1,
    `the far NPC barely moved: ${distance(first.start, npcEnd).toFixed(3)}`,
  );
});
