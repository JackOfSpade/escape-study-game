import { BufferGeometry, Float32BufferAttribute } from "three";
import type { Floor } from "../model";
import { type CarvedCorner, cornerProfile } from "../room-shapes";

const WALL_HEIGHT = 2.8;

/** One smooth wall wedge for a carved corner: a vertical face along the
 * chamfer or curve that looks into the room (normals point at the room), and
 * a flat cap. The carved cells themselves stay solid tiles for collision. */
export function cornerWallGeometry(corner: CarvedCorner): BufferGeometry {
  const outline = cornerProfile(corner);
  const positions: number[] = [],
    normals: number[] = [],
    uvs: number[] = [],
    indices: number[] = [];
  const push = (
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    u: number,
    v: number,
  ) => {
    positions.push(x, y, z);
    normals.push(nx, ny, nz);
    uvs.push(u, v);
    return positions.length / 3 - 1;
  };
  // outline[0] is the outer corner point; the visible surface is the rest.
  const face = outline.slice(1);
  let run = 0;
  for (let i = 0; i + 1 < face.length; i++) {
    const a = face[i],
      b = face[i + 1],
      dx = b.x - a.x,
      dz = b.y - a.y,
      length = Math.hypot(dx, dz);
    if (length < 1e-9) continue;
    // The normal that points into the room, towards (sx, sy).
    let nx = dz / length,
      nz = -dx / length;
    if (nx * corner.sx + nz * corner.sy < 0) ((nx = -nx), (nz = -nz));
    const base = positions.length / 3;
    push(a.x, 0, a.y, nx, 0, nz, run, 0);
    push(b.x, 0, b.y, nx, 0, nz, run + length, 0);
    push(b.x, WALL_HEIGHT, b.y, nx, 0, nz, run + length, WALL_HEIGHT);
    push(a.x, WALL_HEIGHT, a.y, nx, 0, nz, run, WALL_HEIGHT);
    // The triangle (a0, b0, b1) faces (-dz, 0, dx); flip it when that is
    // not the room side.
    if (nx * -dz + nz * dx > 0)
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    run += length;
  }
  // Cap: a fan from the outer corner (the outline is star-shaped around it).
  const first = positions.length / 3;
  for (const p of outline) push(p.x, WALL_HEIGHT, p.y, 0, 1, 0, p.x, p.y);
  for (let i = 1; i + 1 < outline.length; i++) {
    const o = outline[0],
      a = outline[i],
      b = outline[i + 1];
    // (o, a, b) faces up when its xz winding has a positive y component.
    const up = (a.y - o.y) * (b.x - o.x) - (a.x - o.x) * (b.y - o.y);
    if (up > 0) indices.push(first, first + i, first + i + 1);
    else indices.push(first, first + i + 1, first + i);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

/** Wedges for every carved corner of a floor (none when it has none). */
export function cornerWallGeometries(floor: Pick<Floor, "generation">) {
  return (floor.generation?.corners ?? []).map(cornerWallGeometry);
}
