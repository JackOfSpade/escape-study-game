import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sceneSaveErrors } from "../src/authored-scene";
import { buildingLayoutErrors } from "../src/building-layout";
import { nearestStairMarker } from "../src/engine";
import {
  H,
  W,
  distance,
  type Furniture,
  type Game,
  type Roadmap,
  type Station,
} from "../src/model";
import { decode, encode, recover } from "../src/persistence";
import type { Site } from "../src/site";
import { createPlayableGame } from "../src/world";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);

/** The continuous world's raster: the start building's 44 columns plus the
 * appended columns the stamped second site occupies. */
const COLS = 100,
  EAST = { left: 56, right: 90, top: 10, bottom: 16 },
  EAST_UP = { x: 59.5, y: 11.5 },
  EAST_ENTRY = { x: 59.5, y: 13.5 };

/** A hand-built second site east of the start building, rows in world y. */
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
    stairs: { 0: { ...EAST_UP } },
    entry: { 1: { ...EAST_ENTRY } },
  };
}

function stampedFurniture(
  id: string,
  site: string | undefined,
  x: number,
  custom: boolean,
): Furniture {
  return {
    id,
    site,
    floor: 0,
    kind: custom ? "custom" : "desk",
    object: custom ? ({ id } as unknown as Furniture["object"]) : undefined,
    appearance: {
      color: "#736046",
      condition: "worn",
      owner: null,
      room: 0,
      designId: id,
    },
    x,
    y: 12.5,
    w: 1.8,
    h: 0.8,
    hp: 24,
    maxHp: 24,
    speed: 0,
    rotation: 0,
    destroyed: false,
    movers: [],
    moved: 0,
    credited: [],
    turning: 0,
  };
}

/** Grow every floor into the shared raster and stamp one second site into it. */
function fixture() {
  const g = createPlayableGame(7, roadmap),
    site = eastSite();
  g.zombies = [];
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
  const crate = stampedFurniture("east:crate", "east", 60.5, true),
    shelf = stampedFurniture("east:shelf", undefined, 64.5, false);
  const station: Station = {
    id: "east:terminal",
    site: "east",
    encounter: "study",
    x: 68.5,
    y: 13.5,
  };
  g.floors[0].furniture.push(crate, shelf);
  g.floors[0].stations.push(station);
  return { g, site, crate, shelf, station };
}

/** A one-storey site whose footprint opens the start shell's west wall. */
function westKiosk(g: Game): Site {
  const row = g.floors[0].boundary!.rows[20],
    kiosk: Site = {
      id: "kiosk",
      name: "West kiosk",
      origin: { x: 0, y: 18 },
      floors: [0],
      boundary: {
        version: 1,
        shape: "rectangle",
        width: row.left,
        depth: 4,
        top: 18,
        bottom: 22,
        rows: Array.from({ length: H }, (_, y) =>
          y >= 18 && y < 22
            ? { left: 0, right: row.left }
            : { left: 0, right: 0 },
        ),
      },
      stairs: {},
      entry: {},
    };
  for (let y = 18; y < 22; y++)
    for (let x = 0; x < row.left; x++) g.floors[0].tiles[y][x] = 0;
  return kiosk;
}

test("a save with a stamped second site round-trips", () => {
  const { g, site, crate, shelf, station } = fixture(),
    restored = recover(decode(encode(g)));
  assert.equal(restored.sites?.length, 1);
  assert.deepEqual(restored.sites?.[0], site);
  for (const f of g.floors) {
    assert.equal(restored.floors[f.index].tiles[0].length, COLS);
    assert.deepEqual(
      restored.floors[f.index].tiles,
      f.tiles,
      `floor ${f.index} raster changed`,
    );
  }
  assert.deepEqual(restored.floors[0].shells, g.floors[0].shells);
  assert.deepEqual(restored.floors[1].shells, g.floors[1].shells);
  assert.equal(restored.floors[0].tiles[12][60], 0);
  const crateBack = restored.floors[0].furniture.find((o) => o.id === crate.id);
  assert.equal(crateBack?.site, "east");
  assert.deepEqual(crateBack?.appearance, crate.appearance);
  const shelfBack = restored.floors[0].furniture.find((o) => o.id === shelf.id);
  assert.deepEqual(shelfBack?.appearance, shelf.appearance);
  assert.equal(shelfBack?.site, undefined);
  assert.deepEqual(
    restored.floors[0].stations.find((s) => s.id === station.id),
    station,
  );
});

test("layout and scene validation only inspect the start site", () => {
  const { g, shelf } = fixture();
  assert.deepEqual(buildingLayoutErrors(g), []);
  assert.equal(g.floors[0].tiles[12][60], 0);
  assert.equal(g.floors[1].tiles[12][60], 0);
  assert.deepEqual(sceneSaveErrors(g.floors[0], g.sites), []);
  // The shelf is only recognised as stamped through its site-id prefix: on a
  // bare floor it stays unbound until the save names the site.
  assert.ok(shelf.site === undefined);
  const bare = structuredClone(g.floors[0]),
    plain = fixture();
  delete bare.design;
  delete bare.scene;
  bare.furniture = [structuredClone(plain.crate), structuredClone(shelf)];
  assert.deepEqual(sceneSaveErrors(bare, plain.g.sites), []);
  assert.deepEqual(sceneSaveErrors(bare, []), [
    "Scene data has no authored blueprint",
  ]);
  // A deliberately broken start-site cell is still reported.
  g.floors[1].tiles[0][0] = 0;
  assert.ok(
    buildingLayoutErrors(g).includes("floor 1 opens outside boundary at 0,0"),
  );
  g.floors[1].tiles[0][0] = 1;
  assert.deepEqual(buildingLayoutErrors(g), []);
  // ... and so is one at the start raster's edge, next to the stamped site.
  const edge = g.floors[1].boundary!.rows[12].right;
  assert.ok(edge < W);
  g.floors[1].tiles[12][edge] = 0;
  assert.ok(
    buildingLayoutErrors(g).includes(
      `floor 1 opens outside boundary at ${edge},12`,
    ),
  );
  g.floors[1].tiles[12][edge] = 1;
  assert.deepEqual(buildingLayoutErrors(g), []);
  // Cells a stamped site owns are ignored, but only because it owns them.
  const kiosk = westKiosk(g),
    unowned = buildingLayoutErrors(g);
  assert.ok(
    unowned.includes("floor 0 opens outside boundary at 0,20"),
    `the opened west cells must be reported without the kiosk: ${unowned.join("; ")}`,
  );
  g.sites = [...(g.sites ?? []), kiosk];
  assert.deepEqual(buildingLayoutErrors(g), []);
  g.sites = (g.sites ?? []).filter((s) => s.id !== kiosk.id);
  assert.ok(
    buildingLayoutErrors(g).includes("floor 0 opens outside boundary at 0,20"),
  );
});

test("a climbing NPC inside the second site heads for that site's up marker", () => {
  const { g } = fixture(),
    human = g.survivors[0],
    startUp = g.floors[0].stairs;
  human.floor = 0;
  Object.assign(human, { x: 60.5, y: 12.5 });
  assert.ok(distance(human, startUp) > distance(human, EAST_UP));
  assert.deepEqual(nearestStairMarker(g, human, "up"), EAST_UP);
  assert.equal(nearestStairMarker(g, human, "down"), undefined);
  // Standing in the start building's own well the answer never changed.
  Object.assign(human, startUp);
  assert.deepEqual(nearestStairMarker(g, human, "up"), startUp);
  // A game without extra sites answers exactly the floor's own fields.
  const legacy = createPlayableGame(7, roadmap);
  assert.deepEqual(
    nearestStairMarker(legacy, { floor: 1, x: 0, y: 0 }, "up"),
    legacy.floors[1].stairs,
  );
  assert.deepEqual(
    nearestStairMarker(legacy, { floor: 1, x: 0, y: 0 }, "down"),
    legacy.floors[1].entry,
  );
  assert.equal(
    nearestStairMarker(legacy, { floor: 0, x: 0, y: 0 }, "down"),
    undefined,
  );
  // With no extra sites the marker is the floor's own field, not a copy.
  assert.equal(
    nearestStairMarker(legacy, legacy.survivors[0], "up"),
    legacy.floors[legacy.survivors[0].floor].stairs,
  );
});
