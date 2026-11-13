import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { BufferGeometry, InstancedMesh } from "three";
import type { Roadmap } from "../src/model";
import type {
  RunObjectAxis,
  RunObjectPart,
  RunObjectShape,
} from "../src/setting-catalog.mjs";
import { AuthoredScene } from "../src/view3d/authored-scene";
import { InteriorLightmap } from "../src/view3d/interior-lightmap";
import {
  AXIS_SHAPES,
  OBJECT_SHAPE_GEOMETRY,
  objectGeometry,
} from "../src/view3d/object-shapes";
import { createPlayableGame } from "../src/world";
import { savedRunDesign, sceneDesignFixture } from "./helpers/run-design";

const NEW_SHAPES = ["dome", "capsule", "hexprism", "pyramid"] as const;
const AXES = ["up", "across", "along"] as const;
const EDGE = 1e-3;

const vertices = (g: BufferGeometry) => {
  const p = g.getAttribute("position");
  return Array.from({ length: p.count }, (_, i) => ({
    x: p.getX(i),
    y: p.getY(i),
    z: p.getZ(i),
  }));
};

/** Coordinates of a unit-box shape along its axis (w) and its cross-section
 * (u, v), whichever way the axis rotation turned it. */
const frame = (axis: RunObjectAxis) =>
  axis === "up"
    ? (["x", "z", "y"] as const)
    : axis === "across"
      ? (["z", "y", "x"] as const)
      : (["x", "y", "z"] as const);

test("every new shape fills the unit box on every axis", () => {
  for (const shape of NEW_SHAPES)
    for (const axis of AXES) {
      const g = objectGeometry(shape, axis);
      g.computeBoundingBox();
      const b = g.boundingBox!;
      for (const k of ["x", "y", "z"] as const) {
        assert.ok(
          Math.abs(b.min[k] + 0.5) <= EDGE && Math.abs(b.max[k] - 0.5) <= EDGE,
          `${shape} ${axis} ${k}: ${b.min[k]}..${b.max[k]}`,
        );
      }
    }
});

test("the new shapes are the only additions to the shape tables", () => {
  assert.deepEqual(Object.keys(OBJECT_SHAPE_GEOMETRY).sort(), [
    "box",
    "capsule",
    "cone",
    "cylinder",
    "dome",
    "hexprism",
    "pyramid",
    "sphere",
    "torus",
    "wedge",
  ]);
  for (const shape of NEW_SHAPES) assert.ok(AXIS_SHAPES.includes(shape), shape);
  for (const shape of ["box", "sphere"] as RunObjectShape[])
    assert.ok(!AXIS_SHAPES.includes(shape), `${shape} stays axis-free`);
});

test("a dome keeps a flat base at the low end of its axis and its crown at the high end", () => {
  for (const axis of AXES) {
    const g = objectGeometry("dome", axis),
      [u, v, w] = frame(axis),
      points = vertices(g),
      low = points.filter((p) => p[w] <= -0.5 + 1e-6),
      high = points.filter((p) => p[w] >= 0.5 - 1e-6);
    assert.ok(
      points.every((p) => p[w] >= -0.5 - 1e-6),
      `${axis}: nothing sinks below the base`,
    );
    assert.ok(low.length >= 8, `${axis}: ${low.length} base vertices`);
    assert.ok(
      low.every((p) => Math.abs(p[w] + 0.5) <= 1e-6),
      `${axis}: the base is flat`,
    );
    const crown = new Set(
      high.map((p) => `${p[u].toFixed(4)}:${p[v].toFixed(4)}`),
    );
    assert.deepEqual([...crown], ["0.0000:0.0000"], `${axis}: a single crown`);
    const base = low.map((p) => Math.hypot(p[u], p[v]));
    assert.ok(
      Math.max(...base) > 0.49,
      `${axis}: the base ring spans the box width`,
    );
  }
});

test("a capsule keeps a straight barrel between caps that fill the box", () => {
  const [u, v, w] = frame("up"),
    points = vertices(objectGeometry("capsule", "up")),
    girth = (p: { x: number; y: number; z: number }) => Math.hypot(p[u], p[v]),
    wide = points.filter((p) => Math.abs(girth(p) - 0.5) <= 1e-6),
    span = wide.map((p) => p[w]);
  assert.ok(wide.length > 8, "the barrel is round, not a point");
  assert.ok(
    Math.max(...span) - Math.min(...span) > 0.4,
    `a sphere would meet the box only at its equator: ${Math.min(...span)}..${Math.max(...span)}`,
  );
  assert.ok(
    points.every((p) => girth(p) <= 0.5 + 1e-6),
    "nothing bulges outside the box",
  );
});

test("a hexprism has a six-fold cross-section on every axis", () => {
  for (const axis of AXES) {
    const [u, v] = frame(axis),
      angles = new Set(
        vertices(objectGeometry("hexprism", axis))
          .map((p) => ({ a: p[u], b: p[v], r: Math.hypot(p[u], p[v]) }))
          .filter((p) => p.r > 0.01)
          .map((p) => Math.atan2(p.b, p.a).toFixed(6)),
      );
    assert.equal(angles.size, 6, `${axis}: ${[...angles].join(",")}`);
  }
});

test("a pyramid stands on four corners of the box and narrows to one apex", () => {
  const corner = (p: Record<"u" | "v", number>) =>
    `${Math.sign(p.u)}:${Math.sign(p.v)}`;
  for (const axis of AXES) {
    const [u, v, w] = frame(axis),
      points = vertices(objectGeometry("pyramid", axis)),
      base = points.filter((p) => p[w] <= -0.5 + 1e-6),
      corners = new Set(
        base
          .filter(
            (p) =>
              Math.abs(Math.abs(p[u]) - 0.5) <= 1e-6 &&
              Math.abs(Math.abs(p[v]) - 0.5) <= 1e-6,
          )
          .map((p) => corner({ u: p[u], v: p[v] })),
      );
    // The four base corners sit at the box corners, one in each quadrant.
    assert.deepEqual(
      [...corners].sort(),
      ["-1:-1", "-1:1", "1:-1", "1:1"],
      `${axis}: base corners`,
    );
    // Nothing else on the base plane is wider than a corner.
    assert.ok(
      base.every(
        (p) => Math.abs(p[u]) <= 0.5 + 1e-6 && Math.abs(p[v]) <= 0.5 + 1e-6,
      ),
      `${axis}: the base stays inside the box`,
    );
    const apex = new Set(
      points
        .filter((p) => p[w] >= 0.5 - 1e-6)
        .map((p) => `${p[u].toFixed(4)}:${p[v].toFixed(4)}`),
    );
    assert.deepEqual([...apex], ["0.0000:0.0000"], `${axis}: one apex`);
  }
});

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);

const part = (
  shape: RunObjectShape,
  axis: RunObjectAxis,
  z: number,
): RunObjectPart => ({
  shape,
  axis,
  x: 0,
  y: 0,
  z,
  w: 0.3,
  d: 0.3,
  h: 0.3,
  color: "#88aacc",
  finish: "matte",
  pitch: 0,
  roll: 0,
  motion: "none",
  rate: 1,
});

test("an authored scene pools a composed object that uses all four new shapes", () => {
  const game = createPlayableGame(
      42,
      roadmap,
      undefined,
      savedRunDesign(sceneDesignFixture()),
    ),
    floor = game.floors[0],
    template = floor.scene!.props[0],
    parts = [
      part("dome", "up", 0),
      part("capsule", "along", 0.3),
      part("hexprism", "across", 0.6),
      part("pyramid", "up", 0.9),
    ];
  floor.scene!.props.push({
    ...template,
    id: `${template.id}-extra-shapes`,
    object: {
      id: "extra-shapes",
      name: "Extra shapes",
      size: { w: 0.6, d: 0.3, h: 1.2 },
      parts,
    },
  });
  const map = new InteriorLightmap(),
    scene = new AuthoredScene(floor, map);
  scene.sync();
  for (const [shape, axis] of [
    ["dome", "up"],
    ["capsule", "along"],
    ["hexprism", "across"],
    ["pyramid", "up"],
  ] as const) {
    const mesh = scene.group.getObjectByName(
      `authored-scene-composed-${shape}-${axis}-matte`,
    ) as InstancedMesh | undefined;
    assert.ok(mesh, `${shape} on ${axis} has its own pool`);
    const geometry = mesh.geometry;
    geometry.computeBoundingBox();
    const b = geometry.boundingBox!;
    for (const k of ["x", "y", "z"] as const)
      assert.ok(
        Math.abs(b.min[k] + 0.5) <= EDGE && Math.abs(b.max[k] - 0.5) <= EDGE,
        `${shape} ${axis} pool geometry ${k}`,
      );
  }
  scene.dispose();
  map.dispose();
});
