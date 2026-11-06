import {
  BoxGeometry,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  SphereGeometry,
  TorusGeometry,
} from "three";
import type { RunObjectAxis, RunObjectShape } from "../setting-catalog.mjs";

/** A right-triangular prism filling the unit box: full height at the back
 * (-z) and tapering to nothing at the front (+z), extruded across x. Each
 * face has its own vertices so shading is flat, and uv is present so it
 * merges with the stock primitives. */
export function unitWedge(): BufferGeometry {
  const A = [-0.5, -0.5, -0.5],
    B = [0.5, -0.5, -0.5],
    C = [-0.5, 0.5, -0.5],
    D = [0.5, 0.5, -0.5],
    E = [-0.5, -0.5, 0.5],
    F = [0.5, -0.5, 0.5];
  const faces: number[][][] = [
    [A, B, D, C], // back
    [A, B, F, E], // bottom
    [C, D, F, E], // slope
    [A, C, E], // left
    [B, F, D], // right
  ];
  const position: number[] = [],
    normal: number[] = [],
    uv: number[] = [],
    index: number[] = [];
  for (const face of faces) {
    const [a, b, c] = face;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ];
    const length = Math.hypot(n[0], n[1], n[2]);
    n = n.map((k) => k / length);
    // The prism is convex around the origin, so a face normal that points
    // toward the origin means the winding is reversed.
    const centre = [0, 1, 2].map(
      (k) => face.reduce((sum, p) => sum + p[k], 0) / face.length,
    );
    const reversed = n[0] * centre[0] + n[1] * centre[1] + n[2] * centre[2] < 0;
    const ordered = reversed ? [...face].reverse() : face;
    if (reversed) n = n.map((k) => -k);
    const base = position.length / 3;
    for (const p of ordered) {
      position.push(...p);
      normal.push(...n);
      uv.push(0, 0);
    }
    for (let i = 1; i < ordered.length - 1; i++)
      index.push(base, base + i, base + i + 1);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(position, 3));
  g.setAttribute("normal", new Float32BufferAttribute(normal, 3));
  g.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  return g;
}

/** A ring filling the unit box: its hole axis is z (a ring facing the front)
 * and the tube is stretched along that axis so the ring is as thick as the
 * box is deep. */
export function unitTorus(): BufferGeometry {
  const tube = 0.15,
    g = new TorusGeometry(0.5 - tube, tube, 8, 24);
  g.scale(1, 1, 0.5 / tube);
  return g;
}

export const OBJECT_SHAPE_GEOMETRY: Record<
  RunObjectShape,
  () => BufferGeometry
> = {
  box: () => new BoxGeometry(1, 1, 1),
  cylinder: () => new CylinderGeometry(0.5, 0.5, 1, 20),
  sphere: () => new SphereGeometry(0.5, 16, 12),
  cone: () => new ConeGeometry(0.5, 1, 20),
  wedge: unitWedge,
  torus: unitTorus,
};

/** Unit geometry turned to its axis. It still fills the unit box, so the
 * part's w×h×d scale gives its extents. Local x is across, z is along.
 * Cylinders and cones run along the axis; a wedge's slope rises toward the
 * back (up), +x (across) or the front (along); a torus lies flat (up) or
 * stands facing the front (along) or sideways (across). */
export function objectGeometry(
  shape: RunObjectShape,
  axis: RunObjectAxis,
): BufferGeometry {
  const geometry = OBJECT_SHAPE_GEOMETRY[shape]();
  if (shape === "wedge") {
    if (axis === "across") geometry.rotateY(-Math.PI / 2);
    else if (axis === "along") geometry.rotateY(Math.PI);
  } else if (shape === "torus") {
    if (axis === "up") geometry.rotateX(-Math.PI / 2);
    else if (axis === "across") geometry.rotateY(Math.PI / 2);
  } else if (axis === "across") geometry.rotateZ(-Math.PI / 2);
  else if (axis === "along") geometry.rotateX(Math.PI / 2);
  return geometry;
}

/** Shapes whose orientation depends on the axis; the rest are symmetric. */
export const AXIS_SHAPES: readonly RunObjectShape[] = [
  "cylinder",
  "cone",
  "wedge",
  "torus",
];
