import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Floor, Roadmap } from "../src/model";
import { floorZone, terrainCanvas } from "../src/office-art";
import {
  FLOOR_FINISHES,
  WALL_FINISHES,
  type RunFloorFinish,
  type RunSetting,
  type RunWallFinish,
} from "../src/setting-catalog.mjs";
import {
  floorMaterialParams,
  floorTexture,
  type FloorFinish,
} from "../src/view3d/textures";
import { wallMaterialParams, wallTexture } from "../src/view3d/wall-textures";
import { createPlayableGame } from "../src/world";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
const NEW_FINISHES = [
  "planks",
  "flagstone",
  "checker",
  "grating",
  "earth",
  "mosaic",
] as const satisfies readonly RunFloorFinish[];

type Call = [string, ...unknown[]];

/** A canvas context that records every operation, so a painter's output can be
 * compared without a real rasteriser. */
function recorder() {
  const calls: Call[] = [],
    values = new Map<string | symbol, unknown>();
  const ctx = new Proxy({} as CanvasRenderingContext2D, {
    get(_target, key: string | symbol) {
      if (values.has(key)) return values.get(key);
      if (key === "createLinearGradient" || key === "createRadialGradient")
        return () => ({ addColorStop() {} });
      return (...args: unknown[]) => {
        calls.push([String(key), ...args]);
      };
    },
    set(_target, key: string | symbol, value: unknown) {
      values.set(key, value);
      calls.push([`set ${String(key)}`, value]);
      return true;
    },
  });
  return { ctx, calls };
}

function canvas() {
  const { ctx, calls } = recorder();
  return {
    width: 0,
    height: 0,
    calls,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
}

(globalThis as unknown as { document: unknown }).document = {
  createElement: (tag: string) => {
    assert.equal(tag, "canvas");
    return canvas();
  },
};

function setting(): RunSetting {
  return {
    venue: "office",
    interior: {
      roomFloor: "parquet",
      hallFloor: "terrazzo",
      roomTint: "#2b2f3a",
      hallTint: "#d8cfbd",
      wall: "#8a7a68",
      trim: "#c9a24a",
    },
    exterior: {
      facade: "brick",
      facadeColor: "#8a4b3a",
      trimColor: "#d8d0b8",
      windows: "punched",
      canopy: "flat",
      canopyGlow: "#ff4a3a",
      roofFeatures: [],
    },
    terminal: {
      style: "desk",
      body: "#6b5036",
      accent: "#2a2a2a",
      screen: "#40e0d0",
    },
    objects: [],
    props: [],
    surroundings: {
      ground: "asphalt",
      groundColor: "#3b3f44",
      pathColor: "#2b2e33",
      sky: { zenith: "#0d1622", horizon: "#3a4656" },
      fog: { color: "#1c2430", density: 0 },
      neighbors: "buildings",
      neighborColor: "#4a4f57",
      weather: "none",
      scenery: [],
    },
    filler: null,
  };
}

function designed(floor: Floor, finish: RunFloorFinish): Floor {
  const s = setting();
  s.interior.roomFloor = finish;
  s.interior.hallFloor = finish;
  return { ...floor, setting: s };
}

function painted(finish: FloorFinish) {
  const texture = floorTexture(finish) as unknown as {
    image: { calls: Call[] };
  };
  return texture.image.calls;
}

test("every floor finish has material params and a deterministic texture", () => {
  for (const finish of FLOOR_FINISHES) {
    const params = floorMaterialParams(finish);
    assert.match(params.color, /^#[0-9a-f]{6}$/i, `${finish} has a colour`);
    assert.ok(
      params.roughness >= 0 && params.roughness <= 1,
      `${finish} gloss is a valid roughness`,
    );
    const first = JSON.stringify(painted(finish));
    assert.ok(first.length > 2, `${finish} paints a texture`);
    assert.equal(first, JSON.stringify(painted(finish)), `${finish} repeats`);
  }
});

test("the six new floor finishes differ from the default and each other", () => {
  const base = floorMaterialParams("carpet"),
    colours = new Set<string>(),
    textures = new Set<string>();
  for (const finish of NEW_FINISHES) {
    const params = floorMaterialParams(finish);
    assert.notEqual(
      `${params.color}/${params.roughness}`,
      `${base.color}/${base.roughness}`,
      `${finish} is authored, not the default`,
    );
    colours.add(params.color);
    textures.add(JSON.stringify(painted(finish)));
  }
  assert.equal(colours.size, NEW_FINISHES.length, "each finish has its tint");
  assert.equal(
    textures.size,
    NEW_FINISHES.length,
    "each finish paints distinct output",
  );
  const grating = floorMaterialParams("grating").roughness,
    earth = floorMaterialParams("earth").roughness;
  assert.ok(grating >= 0.4 && grating <= 0.6, "grating is a metal look");
  assert.equal(earth, 1, "packed earth is fully diffuse");
});

test("a designed floor reports its new finishes for rooms and halls", () => {
  const game = createPlayableGame(42, roadmap),
    base = game.floors[1];
  for (const finish of NEW_FINISHES) {
    const floor = designed(base, finish);
    let cells = 0;
    for (let y = 0; y < floor.tiles.length; y++)
      for (let x = 0; x < floor.tiles[y].length; x++) {
        if (floor.tiles[y][x]) continue;
        const zone = floorZone(floor, x, y);
        if (zone === finish) cells++;
        else
          assert.ok(
            zone === "concrete" || zone === "roof",
            `${finish} floor cell ${x},${y} is outside, not ${zone}`,
          );
      }
    assert.ok(cells > 0, `${finish} is painted on designed cells`);
  }
  // A mixed design keeps rooms and halls apart.
  const mixed = { ...base, setting: setting() };
  mixed.setting!.interior.roomFloor = "planks";
  mixed.setting!.interior.hallFloor = "mosaic";
  const seen = new Set<string>();
  for (let y = 0; y < mixed.tiles.length; y++)
    for (let x = 0; x < mixed.tiles[y].length; x++) {
      if (mixed.tiles[y][x]) continue;
      const zone = floorZone(mixed, x, y);
      if (zone !== "concrete" && zone !== "roof") seen.add(zone);
    }
  assert.deepEqual([...seen].sort(), ["mosaic", "planks"]);
});

test("every wall finish except plaster maps to a cached texture", () => {
  const paints = new Map<RunWallFinish, string>();
  for (const finish of WALL_FINISHES) {
    const params = wallMaterialParams(finish);
    const texture = wallTexture(finish);
    if (finish === "plaster") {
      assert.equal(texture, null, "plaster is today's plain painted wall");
      assert.deepEqual(
        params,
        { roughness: 0.92, metalness: 0 },
        "plaster keeps the plain wall's material values",
      );
      continue;
    }
    assert.ok(texture, `${finish} has a wall texture`);
    assert.equal(texture, wallTexture(finish), `${finish} is cached`);
    const image = texture.image as unknown as {
      width: number;
      height: number;
      calls: Call[];
    };
    assert.equal(image.width, 64);
    assert.equal(image.height, 64);
    assert.ok(image.calls.length > 0, `${finish} paints something`);
    assert.ok(
      params.roughness >= 0 && params.roughness <= 1 && params.metalness >= 0,
      `${finish} has valid material params`,
    );
    paints.set(finish, JSON.stringify(image.calls));
  }
  assert.equal(
    new Set(paints.values()).size,
    WALL_FINISHES.length - 1,
    "each wall finish paints distinct relief",
  );
});

test("the new 2D floor finishes paint distinct terrain cells", () => {
  const game = createPlayableGame(42, roadmap),
    base = game.floors[1],
    painted = new Map<string, string>();
  for (const finish of NEW_FINISHES) {
    const art = terrainCanvas(
      designed(base, finish),
      "normal",
      game.seed,
    ) as unknown as { calls: Call[] };
    const calls = art.calls.splice(0);
    assert.ok(calls.length > 0, `${finish} repaints the terrain canvas`);
    assert.ok(
      calls.some(([name]) => name === "fillRect"),
      `${finish} fills cells`,
    );
    painted.set(finish, JSON.stringify(calls));
  }
  assert.equal(
    new Set(painted.values()).size,
    NEW_FINISHES.length,
    "each 2D finish paints distinct output",
  );
});
