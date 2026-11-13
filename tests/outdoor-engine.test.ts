import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  cityCollisionBoxes,
  cityRayDistance,
  citySolid,
  compileOutdoorPlan,
  outdoorSite,
} from "../src/city-layout";
import { initCityInvasion } from "../src/city-invasion";
import { TestRunner } from "../src/gametest/runner";
import { emptyScenario } from "../src/gametest/schema";
import type { Game, Roadmap } from "../src/model";
import {
  checkOutdoorGeometry,
  type OutdoorPlan,
} from "../src/outdoor-plan.mjs";
import { nextSiteOrigin, stampSite } from "../src/site-stamp";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);

function building(seed: number): Game {
  const scenario = emptyScenario();
  Object.assign(scenario, {
    id: `outdoor-engine-${seed}`,
    name: "Outdoor engine",
    seed,
    template: "building",
    layout: "randomized",
    rules: "force-fields",
    city: true,
    pacing: "study",
    naturalSpawns: false,
    maxTicks: 60,
  });
  const g = new TestRunner(scenario, roadmap).game;
  g.zombies = [];
  g.nextSpawn = Number.MAX_SAFE_INTEGER;
  return g;
}

/** An island: a sea inlet south of the door crossed by a causeway, a rock
 * outcrop to the west, and open rock ground elsewhere. */
const island: OutdoorPlan = {
  version: 1,
  bounds: { left: -40, right: 84, top: -30, bottom: 90 },
  ground: "rock",
  enclosure: "open-sky",
  backdrop: "sea",
  regions: [
    {
      kind: "water",
      shape: "rect",
      x: 22,
      y: 60,
      w: 120,
      h: 12,
      height: 0.4,
      color: "#1f3f5a",
    },
    {
      kind: "path",
      shape: "rect",
      x: 22,
      y: 55,
      w: 4,
      h: 40,
      color: "#8a8f8a",
      ground: "cobble",
    },
    {
      kind: "rocks",
      shape: "disc",
      x: -25,
      y: 20,
      r: 8,
      height: 5,
      color: "#3d4650",
    },
  ],
};

test("an authored plan compiles to open ground with its solids and real edges", () => {
  const g = building(42),
    floor = g.floors[0],
    plan = compileOutdoorPlan(floor, island, g.seed);
  assert.deepEqual(checkOutdoorGeometry(island, outdoorSite(floor)), []);
  assert.equal(plan.source, "authored");
  assert.equal(plan.approaches.length, 0, "no horde routes");
  assert.equal(
    plan.obstacles[0].kind,
    "stair-base",
    "the fire stair base stays",
  );
  assert.ok(
    plan.obstacles.some((o) => o.kind === "water" && o.opaque === false),
  );
  assert.ok(
    plan.obstacles.some((o) => o.kind === "rocks" && o.opaque === true),
  );
  assert.equal(plan.paths?.length, 1);
  const edges = cityCollisionBoxes(plan).length - plan.obstacles.length;
  assert.equal(edges, 4, "the bounds get four physical walls");
});

test("water stops bodies but not sight; rock stops both; the causeway is open", () => {
  const g = building(42),
    floor = g.floors[0];
  floor.city = compileOutdoorPlan(floor, island, g.seed);
  assert.equal(citySolid(floor, { x: 10, y: 60 }), true, "in the water");
  assert.equal(citySolid(floor, { x: 22, y: 60 }), false, "on the causeway");
  assert.equal(citySolid(floor, { x: -25, y: 20 }), true, "in the rocks");
  assert.equal(citySolid(floor, { x: 10, y: 40 }), false, "open rock ground");
  assert.equal(citySolid(floor, { x: 200, y: 40 }), true, "beyond the bounds");
  // Looking south from the shore across the inlet: nothing opaque in 30 m.
  assert.equal(cityRayDistance(floor, { x: 10, y: 45 }, 0, 1, 30), 30);
  // Looking west into the outcrop stops at its face.
  const hit = cityRayDistance(floor, { x: -5, y: 20 }, -1, 0, 40);
  assert.ok(hit > 10 && hit < 13, `rock face at ${hit}`);
});

test("an authored world seeds no horde", () => {
  const g = building(42),
    floor = g.floors[0];
  floor.city = compileOutdoorPlan(floor, island, g.seed);
  g.time = 0;
  g.spawned = 0;
  g.zombies = [];
  assert.equal(initCityInvasion(g), 0);
  assert.equal(g.zombies.length, 0);
});

test("stamping a site keeps the drawn terrain and clears only the new plot", () => {
  const g = building(42),
    floor = g.floors[0];
  // A wall of rock east of the start building, where the next site will go.
  const plan: OutdoorPlan = {
    ...island,
    regions: [
      ...island.regions,
      {
        kind: "rocks",
        shape: "rect",
        x: 80,
        y: 15,
        w: 6,
        h: 30,
        height: 4,
        color: "#3d4650",
      },
    ],
  };
  floor.city = compileOutdoorPlan(floor, plan, g.seed);
  const before = floor.city,
    origin = nextSiteOrigin(g);
  stampSite(g, building(4242), { id: "annex", name: "Annex", origin });
  const after = g.floors[0].city!;
  assert.notEqual(after, before, "a new plan object, never edited in place");
  assert.equal(after.source, "authored");
  assert.ok(after.bounds.right > before.bounds.right, "bounds grew east");
  assert.equal(citySolid(g.floors[0], { x: 10, y: 60 }), true, "water kept");
  assert.equal(citySolid(g.floors[0], { x: -25, y: 20 }), true, "outcrop kept");
  assert.equal(
    after.obstacles.filter((o) => o.region === 3).length,
    0,
    "rock on the new plot was cleared",
  );
  assert.ok(
    before.obstacles.some((o) => o.region === 3),
    "the rock existed before stamping",
  );
  assert.ok(after.obstacles.some((o) => o.kind === "stair-base"));
});
