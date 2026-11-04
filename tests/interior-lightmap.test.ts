import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PerspectiveCamera } from "three";
import {
  buildInteriorLighting,
  CEILING_HEIGHT,
  FIXTURE_HEIGHT,
  FIXTURE_RANGE,
  fixtureIntensity,
  fixturePools,
  poolIrradiance,
  WALL_SAMPLE_HEIGHTS,
} from "../src/interior-lighting";
import { type Roadmap } from "../src/model";
import { InteriorAtmosphere } from "../src/view3d/interior-atmosphere";
import { InteriorLightmap } from "../src/view3d/interior-lightmap";
import { createPlayableGame } from "../src/world";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);

test("every powered fixture lights its room regardless of player distance", () => {
  const game = createPlayableGame(42, roadmap),
    floor = game.floors[1],
    plan = buildInteriorLighting(floor, game.seed),
    lightmap = new InteriorLightmap();
  lightmap.build(1, plan);
  const lit = plan.fixtures.filter((f) => f.level > 0.5);
  assert.ok(lit.length > 4);
  for (const f of lit) {
    const below = lightmap.sample(1, f.x, f.y)!;
    assert.ok(
      below.pool >= poolIrradiance(fixtureIntensity(f), 0) * 0.9,
      `${f.id} casts its full pool with no player nearby`,
    );
  }
  // Outage fixtures never contribute light.
  for (const f of plan.fixtures.filter((f) => f.level <= 0.2))
    assert.ok(
      fixturePools(plan).every((p) => p.fixture.id !== f.id),
      `${f.id} is dark`,
    );
});

test("walls occlude baked pools", () => {
  const game = createPlayableGame(42, roadmap),
    floor = game.floors[1],
    plan = buildInteriorLighting(floor, game.seed);
  for (const pool of fixturePools(plan))
    for (let y = 0; y < pool.h; y++)
      for (let x = 0; x < pool.w; x++) {
        if (!pool.values[y * pool.w + x]) continue;
        const tx = Math.floor((pool.x0 + x) / 2),
          ty = Math.floor((pool.y0 + y) / 2);
        if (floor.tiles[ty][tx]) continue;
        // A lit open texel two or more tiles away across a solid row/column
        // straight between it and the lamp would be a leak.
        const fx = Math.floor(pool.fixture.x),
          fy = Math.floor(pool.fixture.y);
        if (fy === ty && Math.abs(fx - tx) > 1) {
          const step = Math.sign(tx - fx);
          for (let i = fx + step; i !== tx; i += step)
            assert.equal(floor.tiles[ty][i], 0, `${pool.fixture.id} leaks`);
        }
      }
});

test("practical lights take over exactly the share they remove from the lightmap", () => {
  const game = createPlayableGame(42, roadmap),
    player = game.survivors[0],
    plan = buildInteriorLighting(game.floors[1], game.seed),
    fixture = plan.fixtures.find((f) => f.level > 0.5)!,
    atmosphere = new InteriorAtmosphere(),
    camera = new PerspectiveCamera();
  game.status = "playing";
  Object.assign(player, { floor: 1, x: fixture.x + 0.6, y: fixture.y });
  atmosphere.update(game, camera, 0);
  const lightmap = atmosphere.lightmap,
    full = poolIrradiance(fixtureIntensity(fixture), 0),
    under = lightmap.sample(1, fixture.x, fixture.y)!.pool;
  assert.ok(
    under < full * 0.5,
    "a nearby lamp is drawn by its point light, not twice",
  );
  // Walk far away: the lamp's light returns to the lightmap.
  Object.assign(player, { x: fixture.x + 30, y: fixture.y });
  for (let i = 0; i < 40; i++) atmosphere.update(game, camera, 0.1);
  assert.ok(lightmap.sample(1, fixture.x, fixture.y)!.pool >= full * 0.9);
  atmosphere.dispose();
});

/** Irradiance from a real three.js PointLight (decay 2, finite range). */
function realLight(intensity: number, offset: number, along: number) {
  const r = Math.hypot(offset, along),
    window = Math.max(0, 1 - (r / FIXTURE_RANGE) ** 4) ** 2;
  return ((intensity * along) / r ** 3) * window;
}

function singleLamp() {
  const game = createPlayableGame(42, roadmap),
    floor = game.floors[1];
  floor.tiles = floor.tiles.map((row, y) =>
    row.map((_, x) =>
      x === 0 || y === 0 || x === row.length - 1 || y === floor.tiles.length - 1
        ? 1
        : 0,
    ),
  );
  floor.furniture = [];
  delete floor.boundary;
  const plan = buildInteriorLighting(floor, game.seed);
  plan.zones = [];
  plan.stories = [];
  plan.fixtures = [
    { id: "lamp", x: 16.5, y: 15.5, level: 0.82, color: "#f2d7a3" },
  ];
  const lightmap = new InteriorLightmap();
  lightmap.build(1, plan);
  return { lightmap, intensity: fixtureIntensity(plan.fixtures[0]) };
}

test("a distant lamp keeps the same ceiling glow a real light gives up close", () => {
  const { lightmap, intensity } = singleLamp(),
    dy = CEILING_HEIGHT - FIXTURE_HEIGHT;
  // Distances land on texel centres (0.5 m texels, lamp mid-tile).
  for (const d of [0.75, 1.25, 2.25, 3.25, 5.25]) {
    const baked = lightmap.surface(1, 16.5 + d, 15.5)!.ceiling,
      real = realLight(intensity, d, dy);
    assert.ok(
      Math.abs(baked - real) < real * 0.4,
      `ceiling at ${d} m: baked ${baked}, real ${real}`,
    );
  }
  const close = realLight(intensity, 1, dy),
    far = lightmap.surface(1, 16.5 + 4, 15.5)!.ceiling;
  assert.ok(
    lightmap.surface(1, 16.5 + 1, 15.5)!.ceiling > far * 4,
    `the glow is a pool around the lamp, not a flat wash (${close}, ${far})`,
  );
});

test("a wall's baked light matches a real lamp at each height and direction", () => {
  const { lightmap, intensity } = singleLamp(),
    offset = 0.3;
  // A wall facing the lamp, read 0.3 m off its surface as the shader does.
  for (const wallAt of [1.5, 3]) {
    const sampleAt = wallAt - offset,
      texel = lightmap.surface(1, 16.5 + sampleAt, 15.5)!;
    WALL_SAMPLE_HEIGHTS.forEach((height, layer) => {
      // The wall's outward normal points back at the lamp, along -x.
      const baked = -texel.walls[layer].x,
        real = realLight(intensity, FIXTURE_HEIGHT - height, wallAt);
      assert.ok(
        Math.abs(baked - real) < real * 0.25,
        `wall ${wallAt} m away at ${height} m: baked ${baked}, real ${real}`,
      );
      assert.ok(Math.abs(texel.walls[layer].y) < real * 0.25);
    });
  }
});

test("a practical takes over its lamp's share of the ceiling and walls too", () => {
  const { lightmap } = singleLamp(),
    before = lightmap.surface(1, 18.5, 15.5)!;
  assert.ok(before.ceiling > 0 && before.walls[2].x < 0);
  lightmap.setPracticals(1, new Map([["lamp", 1]]));
  const held = lightmap.surface(1, 18.5, 15.5)!;
  assert.ok(held.ceiling < 1e-5);
  assert.ok(Math.abs(held.walls[2].x) < 1e-5);
  lightmap.setPracticals(1, new Map());
  const after = lightmap.surface(1, 18.5, 15.5)!;
  assert.ok(Math.abs(after.ceiling - before.ceiling) < 1e-5);
  assert.ok(Math.abs(after.walls[2].x - before.walls[2].x) < 1e-5);
});
