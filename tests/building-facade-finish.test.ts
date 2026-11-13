import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Mesh, MeshStandardMaterial } from "three";
import type { Roadmap } from "../src/model";
import type { RunSetting, RunWallFinish } from "../src/setting-catalog.mjs";
import { BuildingShell } from "../src/view3d/building";
import { wallMaterialParams } from "../src/view3d/wall-textures";
import { createPlayableGame } from "../src/world";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);

// The wall painters draw into a 2D canvas. Record nothing and rasterise
// nothing, so the real texture and material path still runs in Node.
const context = new Proxy({} as CanvasRenderingContext2D, {
  get: () => () => ({ addColorStop() {} }),
  set: () => true,
});
(globalThis as unknown as { document: unknown }).document = {
  createElement: (tag: string) => {
    assert.equal(tag, "canvas");
    return { width: 0, height: 0, getContext: () => context };
  },
};

function designed(
  facade: RunSetting["exterior"]["facade"],
  wallFinish?: RunWallFinish,
): RunSetting {
  const setting: RunSetting = {
    venue: "broadcast",
    interior: {
      roomFloor: "studioCarpet",
      hallFloor: "terrazzo",
      roomTint: "#6d7aa0",
      hallTint: "#b9a98a",
      wall: "#3b4350",
      trim: "#c9a24a",
    },
    exterior: {
      facade,
      facadeColor: "#8a4b3a",
      trimColor: "#d8d0b8",
      windows: "punched",
      canopy: "marquee",
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
  if (wallFinish) setting.interior.wallFinish = wallFinish;
  return setting;
}

function shellOf(setting?: RunSetting) {
  const game = createPlayableGame(42, roadmap),
    shell = new BuildingShell();
  for (const floor of game.floors) floor.setting = setting;
  shell.build(game.floors);
  shell.group.updateMatrixWorld(true);
  return { game, shell };
}

const mesh = (shell: BuildingShell, name: string) =>
  shell.group.getObjectByName(name) as Mesh | undefined;

const structure = (shell: BuildingShell) => mesh(shell, "facade-structure")!;

/** Every distinct height the facade structure reaches, in metres. */
function courseHeights(shell: BuildingShell) {
  const position = structure(shell).geometry.getAttribute("position"),
    heights = new Set<number>();
  for (let i = 0; i < position.count; i++)
    heights.add(Math.round(position.getY(i) * 1000) / 1000);
  return [...heights].sort((a, b) => a - b);
}

const hasHeight = (heights: number[], y: number) =>
  heights.some((value) => Math.abs(value - y) < 0.005);

/** How many distinct vertex tones the facade structure carries. */
function toneCount(shell: BuildingShell) {
  const color = structure(shell).geometry.getAttribute("color"),
    tones = new Set<string>();
  for (let i = 0; i < color.count; i++)
    tones.add(`${color.getX(i)}/${color.getY(i)}/${color.getZ(i)}`);
  return tones.size;
}

/** The outward +x face of every course, keyed by the course's mid height. */
function courseExtents(shell: BuildingShell) {
  const geometry = structure(shell).geometry,
    position = geometry.getAttribute("position"),
    normal = geometry.getAttribute("normal"),
    index = geometry.getIndex(),
    triangles = index ? index.count : position.count,
    bands = new Map<number, number>();
  for (let t = 0; t < triangles; t += 3) {
    const a = index ? index.getX(t) : t,
      b = index ? index.getX(t + 1) : t + 1,
      c = index ? index.getX(t + 2) : t + 2;
    if (normal.getX(a) < 0.9) continue;
    const y = (position.getY(a) + position.getY(b) + position.getY(c)) / 3,
      key = Math.round(y * 20) / 20,
      x = Math.max(position.getX(a), position.getX(b), position.getX(c));
    bands.set(key, Math.max(bands.get(key) ?? -Infinity, x));
  }
  return [...bands.entries()].filter(([y]) => y > 0.1 && y < 2.7);
}

/** Outward relief between the proudest and the most recessed course. Bands
 * that only window liners reach (no wall face) are ignored by keeping the
 * outer metre of faces. */
function relief(shell: BuildingShell) {
  const values = courseExtents(shell).map(([, x]) => x),
    hi = Math.max(...values),
    outer = values.filter((x) => x > hi - 0.1),
    lo = Math.min(...outer),
    count = (value: number) =>
      outer.filter((x) => Math.abs(x - value) < 0.015).length;
  return { span: hi - lo, proud: count(hi), recessed: count(lo) };
}

test("stone lays 0.4 m ashlar courses that brick does not share", () => {
  const stone = shellOf(designed("stone")),
    brick = shellOf(designed("brick")),
    concrete = shellOf(designed("concrete")),
    stoneHeights = courseHeights(stone.shell),
    brickHeights = courseHeights(brick.shell),
    concreteHeights = courseHeights(concrete.shell);
  for (const y of [0.4, 0.8, 1.2, 1.6, 2.0, 2.4])
    assert.ok(hasHeight(stoneHeights, y), `stone course edge at ${y} m`);
  assert.ok(
    !hasHeight(brickHeights, 0.4) && !hasHeight(brickHeights, 1.2),
    "brick's 0.28 m grid never lands on the stone grid",
  );
  const inGroundStorey = (heights: number[]) =>
    heights.filter((y) => y > 0.05 && y < 2.75).length;
  assert.ok(
    inGroundStorey(stoneHeights) >= 8,
    "the ground storey is cut into ashlar courses",
  );
  assert.ok(
    inGroundStorey(concreteHeights) <= 3,
    "concrete is one block per wall piece",
  );
  assert.ok(
    toneCount(stone.shell) > toneCount(concrete.shell) + 20,
    "every stone block is toned on its own",
  );
  stone.shell.dispose();
  brick.shell.dispose();
  concrete.shell.dispose();
});

test("timber stacks 0.3 m courses with alternating outward relief", () => {
  const timber = shellOf(designed("timber")).shell,
    brick = shellOf(designed("brick")).shell,
    concrete = shellOf(designed("concrete")).shell,
    timberRelief = relief(timber),
    brickRelief = relief(brick),
    heights = courseHeights(timber);
  for (const y of [0.3, 0.6, 0.9, 1.5, 2.1])
    assert.ok(hasHeight(heights, y), `timber course edge at ${y} m`);
  assert.ok(
    !hasHeight(heights, 0.4),
    "0.4 m courses are stone's, not timber's",
  );
  assert.ok(
    Math.abs(timberRelief.span - 0.04) < 0.01,
    `timber alternates a 0.04 m grow, so the face moves 0.04 m in all (got ${timberRelief.span})`,
  );
  assert.ok(
    timberRelief.proud >= 3 && timberRelief.recessed >= 3,
    "both the proud and the recessed courses recur down the wall",
  );
  assert.ok(
    brickRelief.span < 0.02,
    `brick's grow stays near the wall line (got ${brickRelief.span})`,
  );
  assert.ok(
    toneCount(timber) > toneCount(concrete) + 5,
    "every timber course is warmed on its own",
  );
  timber.dispose();
  brick.dispose();
  concrete.dispose();
});

test("a wall finish maps the shell's inner liner in world scale", () => {
  const shell = shellOf(designed("brick", "brick")).shell,
    liner = mesh(shell, "facade-interior-liner");
  assert.ok(liner, "a finished liner is drawn as its own mesh");
  const material = liner.material as MeshStandardMaterial,
    params = wallMaterialParams("brick");
  assert.ok(material.map, "brick supplies the liner's map");
  assert.equal(material.roughness, params.roughness);
  assert.equal(material.metalness, params.metalness);
  assert.equal(
    material.vertexColors,
    true,
    "the design's wall colour tints it",
  );
  const position = liner.geometry.getAttribute("position"),
    normal = liner.geometry.getAttribute("normal"),
    uv = liner.geometry.getAttribute("uv");
  let upright = 0,
    minU = Infinity,
    maxU = -Infinity;
  for (let i = 0; i < position.count; i++) {
    minU = Math.min(minU, uv.getX(i));
    maxU = Math.max(maxU, uv.getX(i));
    if (Math.abs(normal.getY(i)) > 0.5) continue;
    const alongZ = Math.abs(normal.getX(i)) > Math.abs(normal.getZ(i));
    assert.ok(
      Math.abs(uv.getY(i) - position.getY(i)) < 1e-4,
      "v runs up the wall in metres",
    );
    assert.ok(
      Math.abs(uv.getX(i) - (alongZ ? position.getZ(i) : position.getX(i))) <
        1e-4,
      "u runs along the face in metres",
    );
    upright++;
  }
  assert.ok(upright > 100, "the liner has many upright faces");
  assert.ok(
    maxU - minU > 10,
    `one repeat per metre spans the liner (got ${maxU - minU} m)`,
  );
  shell.dispose();
});

test("plaster or no design keeps today's liner geometry and materials", () => {
  const plain = shellOf(designed("brick")).shell,
    plaster = shellOf(designed("brick", "plaster")).shell,
    bare = shellOf().shell,
    names = ["facade-structure", "facade-window-frames", "facade-glazing"];
  assert.deepEqual(
    plaster.group.children.map((child) => child.name),
    names,
    "plaster adds no liner mesh",
  );
  assert.deepEqual(
    plaster.group.children.map((child) => child.name),
    bare.group.children.map((child) => child.name),
  );
  assert.equal(mesh(plain, "facade-interior-liner"), undefined);
  assert.equal(mesh(plaster, "facade-interior-liner"), undefined);
  for (const child of plaster.group.children) {
    const material = (child as Mesh).material as MeshStandardMaterial;
    assert.equal(material.map, null, `${child.name} carries no liner map`);
  }
  const structural = mesh(plaster, "facade-structure")!
    .material as MeshStandardMaterial;
  assert.equal(structural.vertexColors, true);
  assert.equal(structural.roughness, 0.94);
  assert.equal(structural.metalness, 0);
  for (const name of names)
    assert.deepEqual(
      Array.from(
        mesh(plaster, name)!.geometry.getAttribute("position")
          .array as Float32Array,
      ),
      Array.from(
        mesh(plain, name)!.geometry.getAttribute("position")
          .array as Float32Array,
      ),
      `${name} is unchanged by an explicitly plaster design`,
    );
  const finished = shellOf(designed("brick", "brick")).shell;
  assert.equal(
    finished.group.children.length,
    plain.group.children.length + 1,
    "only a real finish adds a draw call",
  );
  finished.dispose();
  plain.dispose();
  plaster.dispose();
  bare.dispose();
});
