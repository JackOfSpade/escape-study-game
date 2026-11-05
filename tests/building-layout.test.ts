import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  buildingLayoutErrors,
  createBuildingFootprint,
} from "../src/building-layout";
import { redesign } from "../src/force-fields";
import { CONFIG, H, W, type Floor, type Roadmap } from "../src/model";
import { decode, encode } from "../src/persistence";
import { pursuitLayoutErrors } from "../src/pursuit-layout";
import { canPlace } from "../src/spatial";
import { createGame, createPlayableGame } from "../src/world";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);

/** A shared envelope excludes the external arrival lane and recessed stairs. */
function permittedOpening(f: Floor, x: number, y: number) {
  const boundary = f.boundary!;
  const row = boundary.rows[y];
  if (
    y >= boundary.top &&
    y < boundary.bottom &&
    x >= row.left &&
    x < row.right
  )
    return true;
  if (
    f.index < CONFIG.floors &&
    x >= 21 &&
    x <= 22 &&
    y >= boundary.top - 2 &&
    y < boundary.top
  )
    return true;
  if (f.index > 0 && x >= 21 && x <= 22 && y >= 28 && y < 30) return true;
  return (
    f.index === 0 &&
    ((y === 28 && x >= 20 && x <= 23) || (y >= 29 && x >= 18 && x <= 25))
  );
}

test("a seeded building keeps its boundary on every floor while varying its interiors", () => {
  const shapes = new Set<string>(),
    masks = new Set<string>(),
    sizes = new Set<string>(),
    widths = new Set<number>(),
    depths = new Set<number>(),
    layouts = new Set<string>(),
    stageOrders = new Set<string>();
  for (let seed = 0; seed < 128; seed++) {
    const g = createPlayableGame(seed, roadmap);
    const boundary = g.floors[0].boundary;
    assert.ok(boundary, `seed ${seed}: missing building boundary`);
    assert.deepEqual(boundary, createBuildingFootprint(seed));
    assert.equal(boundary.version, 1);
    assert.ok(
      ["rectangle", "chamfered", "stepped", "waisted"].includes(boundary.shape),
    );
    assert.equal(boundary.rows.length, H);
    assert.ok(boundary.width >= 36 && boundary.width <= 40);
    assert.ok(boundary.top >= 2 && boundary.top <= 4);
    assert.equal(boundary.bottom, 28);
    assert.equal(boundary.depth, boundary.bottom - boundary.top);
    assert.equal(
      Math.max(...boundary.rows.map((row) => row.right - row.left)),
      boundary.width,
      "the stored size must match the actual footprint",
    );
    assert.equal(
      boundary.rows.filter((row) => row.right > row.left).length,
      boundary.depth,
    );
    assert.deepEqual(buildingLayoutErrors(g), [], `seed ${seed}`);
    for (const f of g.floors) {
      assert.deepEqual(f.boundary, boundary, `seed ${seed}, floor ${f.index}`);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++)
          if (!f.tiles[y][x])
            assert.ok(
              permittedOpening(f, x, y),
              `seed ${seed}, floor ${f.index}: floor extends outside boundary at ${x},${y}`,
            );
      for (const o of f.furniture)
        if (o.kind !== "door" && o.kind !== "gate")
          assert.ok(
            canPlace(f, o, o),
            `seed ${seed}, floor ${f.index}: furniture overlaps geometry: ${o.id}`,
          );
      if (f.index === CONFIG.floors) continue;
      assert.equal(f.generation?.version, 5);
      const sectors = f.generation!.sectors!;
      assert.deepEqual(
        sectors.map((s) => s.order),
        [0, 1, 2, 3, 4, 5],
      );
      assert.equal(sectors[0].id, "entry");
      assert.equal(sectors[5].id, "lobby");
      const order = sectors.slice(1, 5).map((s) => s.room!);
      assert.equal(order[0], 2, "the free study hall must remain first");
      assert.deepEqual([...order].sort(), [0, 1, 2, 3]);
      assert.deepEqual(
        pursuitLayoutErrors(g, f),
        [],
        `seed ${seed}, floor ${f.index}: inaccessible or bypassable study rooms`,
      );
      stageOrders.add(order.join(","));
    }
    shapes.add(boundary.shape);
    masks.add(JSON.stringify(boundary.rows));
    sizes.add(`${boundary.width}x${boundary.depth}`);
    widths.add(boundary.width);
    depths.add(boundary.depth);
    layouts.add(JSON.stringify(g.floors[0].tiles));
    assert.ok(
      new Set(
        g.floors.slice(0, CONFIG.floors).map((f) => JSON.stringify(f.tiles)),
      ).size > 1,
      `seed ${seed}: every floor has the same interior`,
    );
  }
  assert.ok(shapes.size >= 4, `only ${shapes.size} building shape families`);
  assert.ok(masks.size >= 40, `only ${masks.size} building boundary masks`);
  assert.ok(widths.size > 1, "building width never changes between runs");
  assert.ok(depths.size > 1, "building depth never changes between runs");
  assert.ok(sizes.size >= 4, `only ${sizes.size} building sizes`);
  assert.ok(layouts.size > 100, `only ${layouts.size} first-floor interiors`);
  assert.ok(
    stageOrders.size >= 3,
    `only ${stageOrders.size} study room orders`,
  );
});

test("footprint and floor generation replay deterministically without consuming gameplay randomness", () => {
  for (const seed of [0, 42, 2682889803, 4294967295]) {
    const a = createPlayableGame(seed, roadmap),
      b = createPlayableGame(seed, roadmap),
      legacy = createGame(seed, roadmap);
    assert.deepEqual(a.floors, b.floors, `seed ${seed}`);
    assert.deepEqual(
      createBuildingFootprint(seed),
      createBuildingFootprint(seed),
    );
    assert.equal(
      a.rng,
      legacy.rng,
      `seed ${seed}: generation consumed game RNG`,
    );
    assert.equal(legacy.floors[0].boundary, undefined);
    assert.equal(legacy.floors[0].generation, undefined);
    const restored = decode(encode(a));
    assert.equal(restored.seed, seed);
    assert.equal(restored.rng, a.rng);
    assert.deepEqual(
      restored.floors,
      a.floors,
      "loading changed saved geometry",
    );
  }
});

test("historical forward factories retain their existing floor geometry", () => {
  const g = createGame(42, roadmap, undefined, { layout: "forward" });
  assert.equal(g.floors[0].generation?.version, 2);
  redesign(g);
  for (const f of g.floors) {
    assert.equal(f.boundary, undefined);
    if (f.index < CONFIG.floors) assert.equal(f.generation?.version, 3);
  }
  const restored = decode(encode(g));
  assert.deepEqual(restored.floors, g.floors);
});

test("building validation rejects a broken envelope and mismatched floor boundaries", () => {
  const g = createPlayableGame(42, roadmap);
  assert.deepEqual(buildingLayoutErrors(g), []);
  g.floors[1].tiles[0][0] = 0;
  assert.ok(
    buildingLayoutErrors(g).length > 0,
    "an accessible tile outside the building envelope was accepted",
  );
  g.floors[1].tiles[0][0] = 1;
  assert.deepEqual(buildingLayoutErrors(g), []);
  g.floors[1].tiles[28][21] = 1;
  assert.ok(
    buildingLayoutErrors(g).length > 0,
    "a blocked arrival staircase was accepted",
  );
  g.floors[1].tiles[28][21] = 0;
  assert.deepEqual(buildingLayoutErrors(g), []);
  g.floors[1].boundary = structuredClone(g.floors[1].boundary!);
  g.floors[1].boundary.rows[10].left++;
  assert.ok(
    buildingLayoutErrors(g).length > 0,
    "a floor with a different building boundary was accepted",
  );
});
