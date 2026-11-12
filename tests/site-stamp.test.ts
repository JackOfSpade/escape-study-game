import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { soundConnected } from "../src/acoustics";
import { TestRunner } from "../src/gametest/runner";
import { emptyScenario } from "../src/gametest/schema";
import type {
  BuildingFootprint,
  Floor,
  Game,
  Point,
  Roadmap,
} from "../src/model";
import { survivorPath } from "../src/navigation";
import { floorCols, type Site } from "../src/site";
import { nextSiteOrigin, stampSite } from "../src/site-stamp";
import { solid } from "../src/spatial";
import { canSee } from "../src/visibility";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);

/** A real generated building: randomized force-field floors plus its city. */
function building(seed: number): Game {
  const scenario = emptyScenario();
  Object.assign(scenario, {
    id: `site-stamp-${seed}`,
    name: "Site stamp",
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

let scene: { g: Game; source: Game; site: Site; origin: Point } | undefined;
function stamped() {
  if (!scene) {
    const g = building(42),
      source = building(4242),
      origin = nextSiteOrigin(g),
      site = stampSite(g, source, {
        id: "annex",
        name: "Annex",
        origin,
      });
    scene = { g, source, site, origin };
  }
  return scene;
}

/** First walkable cell straight out through a floor's south gate. */
function outsideGate(f: Floor, gate: string, b: BuildingFootprint): Point {
  const door = f.furniture.find((o) => o.id === gate);
  assert.ok(door, `${gate} exists`);
  for (let y = door.y + door.h; y < f.tiles.length; y++) {
    const p = { x: door.x, y: y + 0.5 };
    if (y > b.bottom && solid(f, p) === false) return p;
  }
  throw Error(`no walkable ground outside ${gate}`);
}

/** First walkable cell just inside a floor's gate, walking north. */
function insideGate(f: Floor, gate: string, b: BuildingFootprint): Point {
  const door = f.furniture.find((o) => o.id === gate);
  assert.ok(door, `${gate} exists`);
  for (let y = Math.floor(door.y); y > b.top; y--) {
    const row = b.rows[y];
    if (!row) continue;
    for (const x of [Math.floor(door.x), Math.floor(door.x) - 1]) {
      if (x < row.left || x >= row.right) continue;
      const p = { x: x + 0.5, y: y + 0.5 };
      if (f.tiles[y]?.[x] === 0 && solid(f, p) === false) return p;
    }
  }
  throw Error(`no walkable interior behind ${gate}`);
}

test("stamping registers the site, its translated footprint and its shell", () => {
  const { g, source, site, origin } = stamped(),
    s = source.floors[0],
    b = s.boundary!;
  assert.deepEqual(site.origin, origin);
  assert.equal(site.id, "annex");
  assert.equal(site.gate, "annex:main-gate");
  assert.ok(site.floors.includes(0), "the ground storey is stamped");
  assert.deepEqual(
    site.floors,
    g.floors
      .filter((f) => source.floors.some((x) => x.index === f.index))
      .map((f) => f.index),
  );
  assert.equal(site.boundary.top, b.top + origin.y);
  assert.equal(site.boundary.bottom, b.bottom + origin.y);
  for (let y = b.top; y < b.bottom; y++) {
    const before = b.rows[y],
      after = site.boundary.rows[y + origin.y];
    assert.ok(after, `footprint row ${y} is translated`);
    assert.equal(after.left, before.left + origin.x);
    assert.equal(after.right, before.right + origin.x);
  }
  if (s.stairs)
    assert.deepEqual(site.stairs[0], {
      x: s.stairs.x + origin.x,
      y: s.stairs.y + origin.y,
    });
  assert.ok(
    g.sites?.some((x) => x.id === "annex" && x === site),
    "the site is registered on the game",
  );
  for (const index of site.floors)
    assert.ok(
      g.floors[index].shells?.some(
        (shell) => shell.site === "annex" && shell.boundary === site.boundary,
      ),
      `floor ${index} knows the stamped shell`,
    );
  const npcs = source.survivors.filter(
    (a) => a.id !== "human" && site.floors.includes(a.floor),
  );
  assert.ok(npcs.length > 0, "the source building has NPC survivors");
  for (const a of npcs)
    assert.ok(
      g.survivors.some((x) => x.id === `annex:${a.id}`),
      `survivor ${a.id} is stamped`,
    );
});

test("stamped tiles, stations and encounters arrive with prefixed ids", () => {
  const { g, source, site, origin } = stamped(),
    f = g.floors[0],
    s = source.floors[0];
  assert.ok(
    floorCols(f) >= origin.x + floorCols(s),
    "the shared raster grew to hold the stamp",
  );
  for (let y = 0; y < Math.min(10, s.tiles.length); y++)
    for (let x = 0; x < Math.min(10, floorCols(s)); x++)
      assert.equal(
        f.tiles[y + origin.y][x + origin.x],
        s.tiles[y][x],
        `tile ${x},${y} is copied`,
      );
  const found = source.floors
    .flatMap((x) => x.stations.map((st) => ({ floor: x.index, st })))
    .find((entry) => entry.st.encounter);
  assert.ok(found, "the source building has an encounter station");
  const { floor: sourceFloor, st: sourceStation } = found;
  const station = g.floors[sourceFloor].stations.find(
    (st) => st.id === `annex:${sourceStation.id}`,
  );
  assert.ok(station, "the station is stamped with its site prefix");
  assert.equal(station.site, "annex");
  assert.equal(station.encounter, `annex:${sourceStation.encounter}`);
  assert.ok(
    g.encounters[station.encounter],
    "the station's encounter exists under its prefixed id",
  );
  assert.ok(
    g.floors[0].furniture.some(
      (o) => o.id === "annex:main-gate" && o.site === "annex",
    ),
    "the gate is stamped with the site prefix",
  );
  const b = site.boundary;
  let wall: Point | undefined;
  for (let y = b.top; y < b.bottom && !wall; y++)
    for (let x = b.rows[y].left; x < b.rows[y].right; x++)
      if (f.tiles[y][x] === 1) {
        wall = { x: x + 0.5, y: y + 0.5 };
        break;
      }
  assert.ok(wall, "the stamped building has walls");
  assert.equal(solid(f, wall), true, "a stamped wall tile is solid");
});

test("survivors walk between the buildings and into the stamped one", () => {
  const { g, site } = stamped(),
    f = g.floors[0],
    start = f.boundary!;
  assert.ok(f.city, "open ground has an outdoor plan");
  assert.equal(f.city.obstacles.length, 0, "open terrain has no obstacles");
  const from = outsideGate(f, "main-gate", start),
    to = outsideGate(f, "annex:main-gate", site.boundary),
    interior = insideGate(f, "annex:main-gate", site.boundary),
    gate = f.furniture.find((o) => o.id === "annex:main-gate");
  assert.ok(gate, "the stamped gate exists");
  // The entrance leaf is the only thing between the yard and the corridor.
  gate.open = true;
  if (gate.door) {
    gate.door.latched = false;
    gate.door.swung = true;
  }
  assert.notDeepEqual(from, to);
  assert.ok(
    survivorPath(f, from, to).length > 0,
    "route across the open ground between the two gates",
  );
  assert.ok(
    survivorPath(f, from, interior).length > 0,
    "route from outside into the stamped interior",
  );
});

test("sight and sound cross the open ground between the gates", () => {
  const { g, site } = stamped(),
    f = g.floors[0],
    from = outsideGate(f, "main-gate", f.boundary!),
    to = outsideGate(f, "annex:main-gate", site.boundary),
    range = Math.hypot(to.x - from.x, to.y - from.y) + 2;
  assert.equal(canSee(f, from, to, range), true, "line of sight is open");
  assert.equal(soundConnected(f, from, to), true, "sound crosses open ground");
});

test("nextSiteOrigin moves east of everything already stamped", () => {
  const { g, site, origin } = stamped(),
    b = site.boundary;
  let right = -Infinity;
  for (let y = b.top; y < b.bottom; y++)
    right = Math.max(right, b.rows[y].right);
  const next = nextSiteOrigin(g);
  assert.ok(next.x > origin.x, "the next site is further east");
  assert.equal(next.x, Math.floor(right) + 12);
  assert.equal(next.y, 0);
});
