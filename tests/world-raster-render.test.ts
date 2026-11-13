import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildInteriorLighting, LIGHTMAP_RES } from "../src/interior-lighting";
import { CONFIG, type Floor, type Roadmap } from "../src/model";
import { terrainCanvas } from "../src/office-art";
import { floorCols, floorRows } from "../src/site";
import { GeometryChangeCache } from "../src/view3d/geometry";
import { InteriorLightmap } from "../src/view3d/interior-lightmap";
import { createPlayableGame } from "../src/world";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);

/** Minimal stand-in for the DOM canvas office art paints into. */
function context() {
  const values = new Map<string | symbol, unknown>();
  return new Proxy({} as CanvasRenderingContext2D, {
    get(_target, key: string | symbol) {
      if (values.has(key)) return values.get(key);
      return (...args: unknown[]) => void args;
    },
    set(_target, key: string | symbol, value: unknown) {
      values.set(key, value);
      return true;
    },
  });
}

function canvas() {
  const ctx = context();
  return {
    width: 0,
    height: 0,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
}

(globalThis as unknown as { document: unknown }).document = {
  createElement: (tag: string) => {
    assert.equal(tag, "canvas");
    return canvas();
  },
};

/** Append 44 wall columns and carve an open extension east of the legacy edge. */
function grownTiles(floor: Floor) {
  const extra = 44,
    rows = floor.tiles.length;
  return floor.tiles.map((row, y) => {
    const next = [...row, ...new Array<number>(extra).fill(1)];
    if (y === 0 || y === rows - 1) return next;
    // Carve the new wing open, keeping a shell of walls around it.
    for (let x = row.length + 1; x < next.length - 1; x++) next[x] = 0;
    return next;
  });
}

function grownFloor(floor: Floor): Floor {
  const grown: Floor = { ...floor, tiles: grownTiles(floor) };
  delete grown.boundary;
  grown.furniture = [];
  return grown;
}

test("terrain canvas follows the floor's own raster size", () => {
  const game = createPlayableGame(42, roadmap),
    legacy = game.floors[1],
    grown = grownFloor(legacy);
  assert.equal(floorCols(legacy), 44);
  assert.equal(floorRows(legacy), 34);
  assert.equal(floorCols(grown), 88);
  assert.equal(floorRows(grown), 34);

  const legacyCanvas = terrainCanvas(legacy, "normal", game.seed),
    scale = legacyCanvas.width / 44;
  assert.equal(legacyCanvas.width, 44 * scale);
  assert.equal(legacyCanvas.height, 34 * scale);

  const grownCanvas = terrainCanvas(grown, "normal", game.seed);
  assert.equal(grownCanvas.width, 88 * scale);
  assert.equal(grownCanvas.height, 34 * scale);
});

test("geometry change cache invalidates when the raster grows", () => {
  const game = createPlayableGame(42, roadmap),
    floor: Floor = { ...game.floors[1] },
    cache = new GeometryChangeCache();
  assert.equal(cache.changed(floor), true);
  assert.equal(cache.changed(floor), false);
  floor.tiles = grownTiles(game.floors[1]);
  assert.equal(cache.changed(floor), true);
  assert.equal(cache.changed(floor), false);
});

test("interior lighting bakes a floor grown past the legacy width", () => {
  const game = createPlayableGame(42, roadmap),
    floor = grownFloor(game.floors[1]),
    plan = buildInteriorLighting(floor, game.seed);
  plan.zones = [];
  plan.stories = [];
  plan.fixtures = [
    { id: "far-lamp", x: 70.5, y: 16.5, level: 0.82, color: "#f2d7a3" },
  ];
  const lightmap = new InteriorLightmap();
  assert.doesNotThrow(() => lightmap.build(1, plan));
  const far = lightmap.sample(1, 70.5, 16.5);
  assert.ok(far, "the grown floor has a lightmap sample at x = 70");
  assert.ok(far.covered, "the grown floor is covered at x = 70");
  assert.ok(far.pool > 0, "a lamp at x = 70.5 lights the grown wing");

  // A 44 x 34 floor keeps exactly its previous atlas size.
  const legacyPlan = buildInteriorLighting(game.floors[1], game.seed),
    legacyMap = new InteriorLightmap();
  legacyMap.build(1, legacyPlan);
  assert.equal(legacyMap.texture.image.width, 44 * LIGHTMAP_RES);
  assert.equal(
    legacyMap.texture.image.height,
    34 * LIGHTMAP_RES * (CONFIG.floors + 1),
  );
});
