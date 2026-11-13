import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { terrainCityPlan } from "../src/city-layout";
import { TestRunner } from "../src/gametest/runner";
import { emptyScenario } from "../src/gametest/schema";
import type {
  BuildingFootprint,
  Floor,
  Game,
  Point,
  Roadmap,
} from "../src/model";
import type { Site } from "../src/site";
import { nextSiteOrigin, stampSite } from "../src/site-stamp";
import { Mesh } from "three";
import { ExteriorDressing } from "../src/view3d/exterior";
import {
  SITE_MARGIN,
  cityBackdrop,
  cityLayout,
  cityGroundRectangles,
  exteriorSignature,
  footprintBounds,
  neighbourLotAllowed,
  outsideBuilding,
  shellFootprints,
  siteFootprints,
} from "../src/view3d/exterior-layout";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);

/** A real generated building, node-only: no renderer is ever constructed. */
function building(seed: number): Game {
  const scenario = emptyScenario();
  Object.assign(scenario, {
    id: `site-exterior-${seed}`,
    name: "Site exterior",
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

let built: { g: Game; site: Site } | undefined;
function stamped() {
  if (!built) {
    const g = building(42),
      source = building(4242),
      site = stampSite(g, source, {
        id: "annex",
        name: "Annex",
        origin: nextSiteOrigin(g),
      });
    built = { g, site };
  }
  return built;
}

function centre(b: BuildingFootprint): Point {
  const f = footprintBounds(b);
  return { x: (f.left + f.right) / 2 + 0.5, y: (f.top + f.bottom) / 2 + 0.5 };
}

function distance(b: BuildingFootprint, p: Point) {
  const f = footprintBounds(b);
  return Math.hypot(
    Math.max(f.left - p.x, 0, p.x - f.right),
    Math.max(f.top - p.y, 0, p.y - f.bottom),
  );
}

/** A lot wholly beyond one edge of a rectangle. */
function beyond(
  lot: { x: number; w: number; y: number; d: number },
  r: { left: number; right: number; top: number; bottom: number },
) {
  return (
    lot.x + lot.w / 2 <= r.left ||
    lot.x - lot.w / 2 >= r.right ||
    lot.y + lot.d / 2 <= r.top ||
    lot.y - lot.d / 2 >= r.bottom
  );
}

test("a game without shells keeps exactly the old single footprint", () => {
  const single = building(4242),
    ground = single.floors[0];
  assert.ok(ground.boundary, "the generated ground floor has a boundary");
  assert.deepEqual(shellFootprints(single.floors), [ground.boundary]);
  assert.deepEqual(siteFootprints(ground), [ground.boundary]);
  assert.equal(outsideBuilding(ground, ...centreOf(ground.boundary)), false);
  assert.equal(cityBackdrop(ground).length > 0, true);
});

function centreOf(b: BuildingFootprint): [number, number] {
  const p = centre(b);
  return [p.x, p.y];
}

test("shell footprints list both buildings on every storey", () => {
  const { g, site } = stamped(),
    footprints = shellFootprints(g.floors);
  assert.equal(footprints.length, 2);
  assert.ok(footprints.includes(g.floors[0].boundary!));
  assert.ok(footprints.includes(site.boundary));
  for (const floor of g.floors) {
    const onFloor = siteFootprints(floor);
    assert.ok(onFloor.includes(site.boundary), `storey ${floor.index} shell`);
  }
});

test("outsideBuilding is false inside the stamped site and true between", () => {
  const { g, site } = stamped(),
    ground = g.floors[0],
    start = ground.boundary!;
  assert.equal(outsideBuilding(ground, ...centreOf(site.boundary)), false);
  assert.equal(outsideBuilding(ground, ...centreOf(start)), false);
  let between: Point | undefined;
  for (let y = 0; y < ground.tiles.length && !between; y++)
    for (let x = 0; x < ground.tiles[y].length && !between; x++) {
      const p = { x: x + 0.5, y: y + 0.5 };
      if (
        outsideBuilding(ground, p.x, p.y) &&
        distance(start, p) < 20 &&
        distance(site.boundary, p) < 20
      )
        between = p;
    }
  assert.ok(between, "open ground between the two buildings is outside");
  assert.equal(outsideBuilding(ground, between!.x, between!.y), true);
});

test("fake neighbour lots keep clear of a site footprint plus margin", () => {
  const { g, site } = stamped(),
    f = footprintBounds(site.boundary),
    mid = { x: (f.left + f.right) / 2, y: (f.top + f.bottom) / 2 },
    sites = [site.boundary];
  assert.equal(neighbourLotAllowed({ ...mid, w: 12, d: 12 }, sites), false);
  assert.equal(
    neighbourLotAllowed(
      { x: f.left - SITE_MARGIN + 2, y: mid.y, w: 8, d: 8 },
      sites,
    ),
    false,
    "a lot inside the margin is refused",
  );
  assert.equal(
    neighbourLotAllowed(
      { x: f.left - SITE_MARGIN - 20, y: mid.y, w: 8, d: 8 },
      sites,
    ),
    true,
    "a lot beyond the margin is allowed",
  );
  // The planned decoration itself never lands on the stamped site.
  const sites2 = shellFootprints(g.floors);
  for (const lot of cityBackdrop(g.floors[0]))
    assert.equal(neighbourLotAllowed(lot, sites2), true);
});

test("the exterior key includes the shells so a stamp rebuilds it", () => {
  const { g } = stamped(),
    bare: Floor[] = g.floors.map((floor) => ({ ...floor, shells: [] }));
  assert.equal(exteriorSignature(g.floors), exteriorSignature(g.floors));
  assert.notEqual(exteriorSignature(g.floors), exteriorSignature(bare));
});

test("an open-terrain plan builds with neighbours only beyond the bounds", () => {
  const { g } = stamped(),
    plan = terrainCityPlan(g),
    floors: Floor[] = g.floors.map((floor, i) =>
      i === 0 ? { ...floor, city: plan } : floor,
    ),
    ground = floors[0];
  assert.equal(plan.obstacles.length, 0, "open terrain has no obstacle solids");
  const layout = cityLayout(ground);
  assert.ok(layout, "the open-terrain plan still yields a street layout");
  assert.deepEqual(layout.blocks, [], "no fake lot stands on open terrain");
  const backdrop = cityBackdrop(ground);
  assert.ok(backdrop.length > 0, "decorative neighbours survive the filter");
  const sites = shellFootprints(floors);
  for (const lot of backdrop) {
    assert.equal(beyond(lot, plan.bounds), true, "neighbour beyond the bounds");
    assert.equal(neighbourLotAllowed(lot, sites), true);
  }
});

test("the exterior builds on open terrain: ground over the bounds and sky", () => {
  const { g } = stamped(),
    plan = terrainCityPlan(g),
    floors: Floor[] = g.floors.map((floor, i) =>
      i === 0 ? { ...floor, city: plan } : floor,
    ),
    dressing = new ExteriorDressing();
  dressing.build(floors[0], floors);
  assert.equal(dressing.enabled, true, "the dressing is drawing");
  assert.ok(dressing.group.visible);
  assert.ok(dressing.group.getObjectByName("gradient-sky"), "sky is drawn");
  const ground = dressing.group.getObjectByName("continuous-city-ground") as
    Mesh | undefined;
  assert.ok(ground, "ground is drawn");
  ground.geometry.computeBoundingBox();
  const box = ground.geometry.boundingBox!;
  assert.ok(box.min.x <= plan.bounds.left, "ground reaches the west bound");
  assert.ok(box.max.x >= plan.bounds.right, "ground reaches the east bound");
  assert.ok(box.min.z <= plan.bounds.top, "ground reaches the north bound");
  assert.ok(box.max.z >= plan.bounds.bottom, "ground reaches the south bound");
  dressing.dispose();
});

test("outdoor ground leaves both buildings' floors uncovered and covers the gap between them", () => {
  const { g, site } = stamped();
  const floor = g.floors[0]!;
  const rects = cityGroundRectangles(floor);
  const covered = (x: number, z: number) =>
    rects.some(
      (r) =>
        x > r.x - r.w / 2 &&
        x < r.x + r.w / 2 &&
        z > r.z - r.d / 2 &&
        z < r.z + r.d / 2,
    );
  // Every cell centre inside either footprint is free of asphalt.
  for (const b of [floor.boundary!, site.boundary])
    for (let y = b.top; y < b.bottom; y++)
      for (let x = b.rows[y]!.left; x < b.rows[y]!.right; x++)
        assert.equal(
          covered(x + 0.5, y + 0.5),
          false,
          `asphalt under ${x},${y}`,
        );
  // The open ground between the two buildings is covered.
  const gapX =
    (Math.max(...floor.boundary!.rows.filter(Boolean).map((r) => r.right)) +
      site.origin.x) /
    2;
  assert.equal(covered(gapX, 15.5), true);
  // Ground beyond the buildings north and south is covered too.
  assert.equal(covered(gapX, floor.boundary!.top - 5), true);
  assert.equal(covered(site.origin.x + 20, site.boundary.bottom + 5), true);
});
