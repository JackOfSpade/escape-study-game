import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { stairs } from "../src/engine";
import { TestRunner } from "../src/gametest/runner";
import { emptyScenario } from "../src/gametest/schema";
import { CONFIG, H, type Game, type Roadmap, distance } from "../src/model";
import { type Site, stairMarkers } from "../src/site";
import { advanceStairs, beginStairs, stairwellAt } from "../src/stair-travel";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);

/** The annex lives in the open east half of the arena's shared z-layers. */
const ANNEX_UP = { x: 33.5, y: 12.5 },
  ANNEX_ENTRY = { x: 33.5, y: 15.5 },
  ANNEX_LEFT = 30,
  ANNEX_RIGHT = 36,
  ANNEX_TOP = 10,
  ANNEX_BOTTOM = 16,
  ANNEX_CLEAR = { left: 28, right: 38, top: 8, bottom: 18 };

function annex(floors = [0, 1]): Site {
  return {
    id: "annex",
    name: "Annex",
    origin: { x: 0, y: 0 },
    floors,
    boundary: {
      version: 1,
      shape: "rectangle",
      width: ANNEX_RIGHT - ANNEX_LEFT,
      depth: ANNEX_BOTTOM - ANNEX_TOP,
      top: ANNEX_TOP,
      bottom: ANNEX_BOTTOM,
      rows: Array.from({ length: H }, (_, y) =>
        y >= ANNEX_TOP && y < ANNEX_BOTTOM
          ? { left: ANNEX_LEFT, right: ANNEX_RIGHT }
          : { left: ANNEX_LEFT, right: ANNEX_LEFT },
      ),
    },
    stairs: { 0: { ...ANNEX_UP } },
    entry: { 1: { ...ANNEX_ENTRY } },
  };
}

/** Keep the annex tiles walkable: the arena furnishes its whole interior. */
function clearAnnex(g: Game) {
  const { left, right, top, bottom } = ANNEX_CLEAR;
  for (const floor of [0, 1]) {
    const f = g.floors[floor];
    f.furniture = f.furniture.filter(
      (o) =>
        o.x + o.w / 2 < left ||
        o.x - o.w / 2 > right ||
        o.y + o.h / 2 < top ||
        o.y - o.h / 2 > bottom,
    );
    for (let y = top; y <= bottom; y++)
      for (let x = left; x <= right; x++) f.tiles[y][x] = 0;
  }
}

function fixture(site?: Site) {
  const scenario = emptyScenario();
  scenario.entities = [{ id: "human", kind: "player", x: 5.5, y: 12.5 }];
  const g = new TestRunner(scenario, roadmap).game;
  g.zombies = [];
  if (site) g.sites = [site];
  clearAnnex(g);
  const human = g.survivors[0];
  assert.ok(human, "the scenario spawns the human");
  human.access = [0];
  return { g, human };
}

test("a flight from a second site lands at its own entry on the next floor", () => {
  const { g, human } = fixture(annex()),
    startEntry = g.floors[1].entry;
  human.floor = 0;
  Object.assign(human, ANNEX_UP);
  // The annex has no force-field gating: empty credentials still climb.
  human.access = [];
  assert.equal(stairwellAt(g, human), "up");
  assert.equal(stairs(g, human), true);
  assert.equal(human.stairTravel?.site, "annex");
  assert.equal(human.stairTravel?.toFloor, 1);
  assert.deepEqual(human.stairTravel?.destination, ANNEX_ENTRY);
  assert.notDeepEqual(human.stairTravel?.destination, startEntry);
  g.time += CONFIG.stairSeconds;
  advanceStairs(g, human);
  assert.equal(human.floor, 1);
  assert.ok(
    distance(human, ANNEX_ENTRY) < 0.01,
    `landed at ${human.x},${human.y}`,
  );
});

test("the second site's roof refuses a climb but still descends", () => {
  const { g, human } = fixture(annex([0, 1]));
  assert.ok(
    !stairMarkers(g, 1).some(
      (m) => m.site.id === "annex" && m.direction === "up",
    ),
    "the annex roof exposes no up marker",
  );
  human.floor = 1;
  Object.assign(human, ANNEX_ENTRY);
  assert.equal(stairwellAt(g, human), "down");
  assert.equal(beginStairs(g, human, false), false);
  assert.equal(human.stairTravel === undefined, true);
  assert.equal(human.floor, 1);
  assert.equal(beginStairs(g, human, true), true);
  assert.equal(human.stairTravel!.site, "annex");
  assert.equal(human.stairTravel!.toFloor, 0);
  assert.deepEqual(human.stairTravel!.destination, {
    x: ANNEX_UP.x,
    y: ANNEX_UP.y + 1,
  });
});

test("stairwellAt picks the nearer marker of two sites", () => {
  const near = fixture(annex()),
    startUp = near.g.floors[0].stairs;
  near.human.floor = 0;
  Object.assign(near.human, { x: ANNEX_UP.x + 0.3, y: ANNEX_UP.y + 0.3 });
  assert.ok(distance(near.human, ANNEX_UP) < distance(near.human, startUp));
  assert.equal(stairwellAt(near.g, near.human), "up");
  assert.equal(beginStairs(near.g, near.human), true);
  assert.equal(near.human.stairTravel?.site, "annex");
  assert.deepEqual(near.human.stairTravel?.destination, ANNEX_ENTRY);
  // The same floor, standing in the start building's own well instead.
  const far = fixture(annex());
  far.human.floor = 0;
  Object.assign(far.human, { x: startUp.x + 0.3, y: startUp.y + 0.3 });
  assert.ok(distance(far.human, startUp) < distance(far.human, ANNEX_UP));
  assert.equal(stairwellAt(far.g, far.human), "up");
  assert.equal(beginStairs(far.g, far.human), true);
  assert.equal(far.human.stairTravel?.site, "start");
  assert.deepEqual(far.human.stairTravel?.destination, far.g.floors[1].entry);
});

test("start-site behaviour is unchanged with a second site present", () => {
  const { g, human } = fixture(annex()),
    startUp = g.floors[0].stairs,
    startEntry = g.floors[1].entry;
  human.floor = 0;
  Object.assign(human, startUp);
  assert.equal(stairwellAt(g, human), "up");
  assert.equal(stairs(g, human), true);
  assert.equal(human.stairTravel?.site, "start");
  assert.equal(human.stairTravel?.toFloor, 1);
  assert.deepEqual(human.stairTravel?.destination, startEntry);
  g.time += CONFIG.stairSeconds;
  advanceStairs(g, human);
  assert.equal(human.floor, 1);
  assert.ok(distance(human, startEntry) < 0.01);
  // The roof of the start building and its ground floor still refuse.
  human.floor = CONFIG.floors;
  Object.assign(human, g.floors[CONFIG.floors].stairs);
  assert.equal(beginStairs(g, human), false);
  human.floor = 0;
  Object.assign(human, g.floors[0].entry);
  assert.equal(beginStairs(g, human, true), false);
});
