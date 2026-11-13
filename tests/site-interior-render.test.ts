import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { floorSectors } from "../src/floor-plan";
import {
  buildInteriorLighting,
  lightAt,
  roomIdAt,
  roomPowerAt,
  siteRoomPowerKey,
} from "../src/interior-lighting";
import { TestRunner } from "../src/gametest/runner";
import { emptyScenario } from "../src/gametest/schema";
import type {
  BuildingFootprint,
  Floor,
  Game,
  Point,
  Roadmap,
} from "../src/model";
import type { EscapeState } from "../src/escape-types";
import { buildingClipRows, type BuildingClipRow } from "../src/render";
import { toWorld, type Site } from "../src/site";
import { nextSiteOrigin, stampSite } from "../src/site-stamp";
import { solid } from "../src/spatial";
import { authoredPlacement } from "../src/view3d/authored-scene";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);

/** A real generated building: randomized force-field floors plus its city. */
function building(seed: number): Game {
  const scenario = emptyScenario();
  Object.assign(scenario, {
    id: `site-interior-${seed}`,
    name: "Site interior",
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

let scene: { g: Game; source: Game; site: Site } | undefined;
function stamped() {
  if (!scene) {
    const g = building(42),
      source = building(4242),
      site = stampSite(g, source, {
        id: "annex",
        name: "Annex",
        origin: nextSiteOrigin(g),
      });
    scene = { g, source, site };
  }
  return scene;
}

/** First walkable interior cell inside a footprint. */
function interiorPoint(f: Floor, b: BuildingFootprint): Point {
  for (let y = b.top; y < b.bottom; y++) {
    const row = b.rows[y];
    if (!row) continue;
    for (let x = row.left; x < row.right; x++) {
      const p = { x: x + 0.5, y: y + 0.5 };
      if (f.tiles[y]?.[x] === 0 && solid(f, p) === false) return p;
    }
  }
  throw Error("no walkable interior cell");
}

/** A walkable cell that the sector plan names, plus its room id. */
function roomPoint(f: Floor) {
  for (const sector of floorSectors(f))
    for (const block of sector.blocks)
      for (let y = block.y1; y <= block.y2; y++)
        for (let x = block.x1; x <= block.x2; x++) {
          const p = { x: x + 0.5, y: y + 0.5 };
          if (f.tiles[y]?.[x] !== 0 || solid(f, p)) continue;
          const id = roomIdAt(f, p);
          if (id) return { p, id };
        }
  throw Error("no named room cell");
}

function samplePoints(f: Floor, b: BuildingFootprint): Point[] {
  const points: Point[] = [];
  for (let y = b.top; y < b.bottom; y += 3) {
    const row = b.rows[y];
    if (!row) continue;
    for (let x = row.left; x < row.right; x += 3) {
      const p = { x: x + 0.5, y: y + 0.5 };
      if (f.tiles[y]?.[x] === 0 && solid(f, p) === false) points.push(p);
    }
  }
  return points;
}

const clipHas = (rows: BuildingClipRow[], p: Point) =>
  rows.some(
    (row) =>
      p.y >= row.y &&
      p.y < row.y + row.h &&
      p.x >= row.x &&
      p.x < row.x + row.w,
  );

test("lightAt inside a stamped site matches the site's own plan", () => {
  const { g, source, site } = stamped(),
    world = g.floors[0]!,
    local = source.floors[0]!,
    p = interiorPoint(local, local.boundary!),
    at = toWorld(site, p),
    merged = buildInteriorLighting(world, g.seed, g.sites),
    own = buildInteriorLighting(local, g.seed);
  assert.notEqual(lightAt(own, p), 1, "the local point is a lit interior cell");
  assert.notEqual(lightAt(merged, at), 1, "the stamped point is interior too");
  assert.equal(lightAt(merged, at), lightAt(own, p));
  // The site region reads its rooms from the site's own local floor.
  const region = merged.regions?.find((r) => r.site === site.id);
  assert.ok(region, "the merged plan has a region for the site");
  assert.equal(region.floor, site.localFloors![0]);
  assert.deepEqual(region.origin, site.origin);
});

test("merged zones carry the site's fixtures and translated rectangles", () => {
  const { g, site } = stamped(),
    world = g.floors[0]!,
    merged = buildInteriorLighting(world, g.seed, g.sites),
    own = buildInteriorLighting(site.localFloors![0]!, g.seed),
    siteZones = merged.zones.filter((z) => z.site === site.id);
  assert.ok(siteZones.length > 0, "the site contributed zones");
  assert.equal(siteZones.length, own.zones.length);
  for (let i = 0; i < siteZones.length; i++) {
    const zone = siteZones[i]!,
      mine = own.zones[i]!;
    assert.equal(zone.rect.x1, mine.rect.x1 + site.origin.x);
    assert.equal(zone.rect.y2, mine.rect.y2 + site.origin.y);
    assert.equal(zone.power, mine.power);
  }
  assert.ok(
    merged.zones.some((z) => z.site === undefined),
    "the start building still has its own zones",
  );
});

test("a room-power override keyed for the site darkens that point", () => {
  const { g, source, site } = stamped(),
    world = g.floors[0]!,
    local = source.floors[0]!,
    { p, id } = roomPoint(local),
    at = toWorld(site, p);
  assert.equal(siteRoomPowerKey(site.id, 0, id), `annex/0:${id}`);
  (g as unknown as { escape: EscapeState }).escape = {
    roomPower: {},
  } as unknown as EscapeState;
  assert.notEqual(roomPowerAt(g, 0, at.x, at.y), "outage");
  g.escape!.roomPower[`annex/0:${id}`] = "outage";
  assert.equal(roomPowerAt(g, 0, at.x, at.y), "outage");
  const plan = buildInteriorLighting(world, g.seed, g.sites);
  assert.equal(lightAt(plan, at), 0.055, "the outage level applies");
  const start = interiorPoint(world, world.boundary!);
  assert.notEqual(lightAt(plan, start), 0.055);
});

test("a floor without sites keeps the single-building plan", () => {
  const g = building(7),
    f = g.floors[0]!,
    old = buildInteriorLighting(f, g.seed),
    merged = buildInteriorLighting(f, g.seed, g.sites ?? []);
  assert.deepEqual(merged.zones, old.zones);
  assert.deepEqual(merged.fixtures, old.fixtures);
  assert.deepEqual(merged.stories, old.stories);
  assert.equal(merged.regions?.length, 1);
  assert.equal(merged.regions?.[0]?.site, undefined);
  for (const p of samplePoints(f, f.boundary!))
    assert.equal(lightAt(merged, p), lightAt(old, p));

  // A stamped neighbour must not change the start building's own lighting.
  const { g: withSite, site } = stamped(),
    shared = withSite.floors[0]!,
    plain = buildInteriorLighting(shared, withSite.seed),
    dressed = buildInteriorLighting(shared, withSite.seed, withSite.sites);
  for (const p of samplePoints(shared, shared.boundary!))
    assert.equal(lightAt(dressed, p), lightAt(plain, p));
  assert.ok(
    samplePoints(site.localFloors![0]!, site.localFloors![0]!.boundary!)
      .length > 0,
    "the stamped site has interior cells",
  );
});

test("the 2-D building clip is the union of every footprint", () => {
  const { g, source, site } = stamped(),
    f = g.floors[0]!,
    rows = buildingClipRows(f),
    local = source.floors[0]!,
    at = toWorld(site, interiorPoint(local, local.boundary!));
  assert.equal(clipHas(rows, at), true, "the stamped building is drawn");
  assert.equal(clipHas(rows, interiorPoint(f, f.boundary!)), true);
  const startRight = Math.max(
      ...f.boundary!.rows.filter((r) => r).map((r) => r!.right),
    ),
    siteLeft = Math.min(
      ...site.boundary.rows.filter((r) => r).map((r) => r!.left),
    ),
    gap = {
      x: (startRight + siteLeft) / 2,
      y: (site.boundary.top + site.boundary.bottom) / 2,
    };
  assert.ok(siteLeft > startRight, "the buildings stand apart");
  assert.equal(clipHas(rows, gap), false, "open ground is not clipped");
});

test("authored props of a stamped site are placed at its origin", () => {
  const { source, site } = stamped(),
    local = source.floors[0]!,
    own = site.localFloors![0]!;
  // The site keeps its own copy of the floor it was stamped from.
  assert.notEqual(own, local, "the site owns its local floor");
  assert.equal(own.index, local.index);
  assert.deepEqual(own.tiles, local.tiles);
  // Saved props, or a representative cell when this seed authored none.
  const props = local.scene?.props.slice(0, 4) ?? [];
  const samples = props.length
    ? props
    : [
        { x: 4.5, y: 7.5 },
        { x: 12.5, y: 3.5 },
      ];
  for (const prop of samples) {
    const placed = authoredPlacement(prop, site.origin);
    assert.deepEqual(placed, {
      x: prop.x + site.origin.x,
      z: prop.y + site.origin.y,
    });
    assert.deepEqual(placed, {
      x: toWorld(site, prop).x,
      z: toWorld(site, prop).y,
    });
    assert.notDeepEqual(placed, { x: prop.x, z: prop.y });
  }
});
