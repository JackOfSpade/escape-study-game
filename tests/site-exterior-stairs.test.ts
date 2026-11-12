import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { stairs } from "../src/engine";
import {
  DECK_WIDTH,
  type ExteriorStructure,
  exteriorStructure,
  slabLocal,
} from "../src/exterior-structure";
import { TestRunner } from "../src/gametest/runner";
import { emptyScenario } from "../src/gametest/schema";
import {
  CONFIG,
  distance,
  type Game,
  type Point,
  type Roadmap,
} from "../src/model";
import type { Site } from "../src/site";
import { nextSiteOrigin, stampSite } from "../src/site-stamp";
import { buildStairRoute } from "../src/stair-route";
import { advanceStairs, stairwellAt } from "../src/stair-travel";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);

/** A real generated building: randomized force-field floors plus its city. */
function building(seed: number): Game {
  const scenario = emptyScenario();
  Object.assign(scenario, {
    id: `site-exterior-${seed}`,
    name: "Site exterior stairs",
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

/** Tile span of a site's footprint rows, in world x. */
function span(site: Site) {
  let left = Infinity,
    right = -Infinity;
  for (const row of site.boundary.rows)
    if (row) {
      left = Math.min(left, row.left);
      right = Math.max(right, row.right);
    }
  assert.ok(Number.isFinite(left), "the site has a footprint");
  return { left, right };
}

/** Midpoint of a guard bay, for locating it beside a site. */
const middle = (guard: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}): Point => ({
  x: (guard.x1 + guard.x2) / 2,
  y: (guard.y1 + guard.y2) / 2,
});

let scene:
  | {
      g: Game;
      site: Site;
      origin: Point;
      before: ExteriorStructure;
    }
  | undefined;

/** The start building alone, then the same game with a stamped second site. */
function stamped() {
  if (!scene) {
    const g = building(42),
      source = building(4242);
    g.sites = undefined;
    // Cached before the stamp: this must not survive as the stamped answer.
    const before = exteriorStructure(g),
      origin = nextSiteOrigin(g),
      site = stampSite(g, source, { id: "annex", name: "Annex", origin });
    scene = { g, site, origin, before };
  }
  return scene;
}

let plain: Game | undefined;

/** The start building's game with no stamped sites at all. */
function alone() {
  if (!plain) {
    plain = building(42);
    plain.sites = undefined;
  }
  return plain;
}

test("the structure covers the stamped site beside its own stairs", () => {
  const { g, site, origin, before } = stamped(),
    structure = exteriorStructure(g),
    { left, right } = span(site),
    boundary = site.boundary,
    up = site.stairs[0],
    entry = site.entry[1];
  assert.ok(up, "the stamped site has an up marker on floor 0");
  assert.ok(entry, "the stamped site has an entry on floor 1");
  assert.ok(
    up.x >= left && up.x < right,
    `the up marker ${up.x} stands inside its own footprint`,
  );
  // The start building alone never reaches the stamp: its gallery ends at its
  // own east edge, a whole yard west of the stamped origin.
  assert.ok(
    Math.max(...before.slabs.map((s) => s.x)) < origin.x,
    "the start building alone stays west of the stamped site",
  );
  // Beside one's stairs means within its own footprint span plus the gallery
  // that runs out east of it, and within its north/south extent.
  const beside = (p: Point) =>
    p.x >= left - DECK_WIDTH &&
    p.x <= right + 3 + DECK_WIDTH &&
    p.y >= boundary.top - 4 &&
    p.y <= boundary.bottom + 4;
  const stampedSlabs = structure.slabs.filter((s) =>
      beside({ x: s.x, y: s.y }),
    ),
    stampedGuards = structure.guards.filter((b) => beside(middle(b)));
  assert.ok(stampedSlabs.length > 0, "slabs stand beside the stamped stairs");
  assert.ok(stampedGuards.length > 0, "guards stand beside the stamped stairs");
  assert.ok(
    !before.slabs.some((s) => beside({ x: s.x, y: s.y })),
    "no such slab exists without the stamp",
  );
  assert.ok(
    !before.guards.some((b) => beside(middle(b))),
    "no such guard exists without the stamp",
  );
  // The start building's own geometry is still exactly what it was.
  assert.ok(before.slabs.length > 0, "the start building has its own stair");
  assert.deepEqual(
    structure.slabs.slice(0, before.slabs.length),
    before.slabs,
    "the start building's decks are unchanged",
  );
  assert.deepEqual(
    structure.guards.slice(0, before.guards.length),
    before.guards,
    "the start building's guards are unchanged",
  );
  assert.deepEqual(
    structure.columns.slice(0, before.columns.length),
    before.columns,
    "the start building's columns are unchanged",
  );
  assert.ok(
    structure.slabs.length > before.slabs.length,
    "the cached structure was rebuilt for the stamp",
  );
});

test("a walker climbs the stamped site's flight through its structure", () => {
  const { g, site } = stamped(),
    structure = exteriorStructure(g),
    human = g.survivors.find((a) => a.id === "human"),
    up = site.stairs[0],
    entry = site.entry[1];
  assert.ok(human, "the scenario spawns the human");
  assert.ok(up, "the stamped site has an up marker on floor 0");
  assert.ok(entry, "the stamped site has an entry on floor 1");
  human.floor = 0;
  Object.assign(human, up);
  // The stamped site's climb is not gated by the start building's credentials.
  human.access = [];
  assert.equal(stairwellAt(g, human), "up");
  assert.equal(stairs(g, human), true, "the stamped stair accepts the climb");
  assert.equal(human.stairTravel?.site, "annex");
  assert.deepEqual(
    human.stairTravel?.destination,
    entry,
    "the flight heads for that site's own entry",
  );
  const route = buildStairRoute(g, human.stairTravel!),
    east = span(site).right + 3;
  assert.ok(
    route.points.some((p) => p.x >= east - 1e-9),
    "the flight runs out east of the stamped footprint",
  );
  for (const p of route.points) {
    const on = structure.slabs.some((s) => {
      const local = slabLocal(s, { x: p.x, y: p.z });
      return (
        Math.abs(local.along) <= s.halfLength + 1e-6 &&
        Math.abs(local.across) <= s.halfWidth + 1e-6 &&
        p.y >= s.top - 1e-6 &&
        p.y <= s.top + Math.abs(s.rise) + 1e-6
      );
    });
    assert.ok(on, `route point ${p.x},${p.y},${p.z} walks on a built slab`);
  }
  g.time += CONFIG.stairSeconds;
  advanceStairs(g, human);
  assert.equal(human.floor, 1);
  assert.ok(distance(human, entry) < 0.01, `landed at ${human.x},${human.y}`);
});

test("a game with no sites keeps exactly the previous structure", () => {
  const g = alone(),
    expected = exteriorStructure(g);
  assert.equal(g.sites, undefined);
  assert.ok(
    expected.slabs.length > 0 && expected.guards.length > 0,
    "the start building keeps its stair",
  );
  g.sites = [];
  assert.deepEqual(
    exteriorStructure(g),
    expected,
    "an empty site list builds nothing new",
  );
  assert.deepEqual(
    exteriorStructure(JSON.parse(JSON.stringify(g))),
    expected,
    "the structure stays a pure function of the floors",
  );
});
