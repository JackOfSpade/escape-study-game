import type { Point } from "./model";

const QUARTER = Math.PI / 2;
const GRID = 2 ** 36;
/** Engine-independent rotation for layout and validation geometry. Browsers
 * and Node differ in the last bit of Math.sin/cos, which can flip a
 * borderline placement check, so a design that builds in one engine would be
 * rejected in another. Quarter turns are exact; other angles are rounded to
 * about 1.5e-11, far below anything physical. */
export function turn(angle = 0): { c: number; s: number } {
  const q = angle / QUARTER,
    k = Math.round(q);
  if (Math.abs(q - k) < 1e-9) {
    const m = ((k % 4) + 4) % 4;
    return { c: [1, 0, -1, 0][m], s: [0, 1, 0, -1][m] };
  }
  return {
    c: Math.round(Math.cos(angle) * GRID) / GRID,
    s: Math.round(Math.sin(angle) * GRID) / GRID,
  };
}
/** The same angle in (-π, π], exact for quarter turns, without engine trig. */
export function normalizeAngle(angle: number) {
  const k = Math.round(angle / QUARTER);
  if (Math.abs(angle / QUARTER - k) < 1e-9)
    return [0, QUARTER, Math.PI, -QUARTER][((k % 4) + 4) % 4];
  const wrapped = angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI));
  return wrapped <= -Math.PI ? wrapped + 2 * Math.PI : wrapped;
}
export interface Box extends Point {
  w: number;
  h: number;
  angle?: number;
}
export function localPoint(p: Point, o: Point & { angle?: number }): Point {
  const { c, s } = turn(o.angle ?? 0);
  return {
    x: (p.x - o.x) * c + (p.y - o.y) * s,
    y: -(p.x - o.x) * s + (p.y - o.y) * c,
  };
}
export function worldPoint(p: Point, o: Point & { angle?: number }): Point {
  const { c, s } = turn(o.angle ?? 0);
  return { x: o.x + p.x * c - p.y * s, y: o.y + p.x * s + p.y * c };
}
export function boxBounds(o: Box) {
  const t = turn(o.angle ?? 0),
    c = Math.abs(t.c),
    s = Math.abs(t.s);
  return { w: o.w * c + o.h * s, h: o.w * s + o.h * c };
}
/** Separating axes of both rectangles, including rotated corners. */
export function boxesOverlap(a: Box, b: Box, pad = 0) {
  const { c: ac, s: as } = turn(a.angle ?? 0),
    { c: bc, s: bs } = turn(b.angle ?? 0);
  for (const [x, y] of [
    [ac, as],
    [-as, ac],
    [bc, bs],
    [-bs, bc],
  ]) {
    const ra =
        (Math.abs(x * ac + y * as) * a.w) / 2 +
        (Math.abs(-x * as + y * ac) * a.h) / 2,
      rb =
        (Math.abs(x * bc + y * bs) * b.w) / 2 +
        (Math.abs(-x * bs + y * bc) * b.h) / 2;
    if (Math.abs((a.x - b.x) * x + (a.y - b.y) * y) >= ra + rb + pad - 1e-8)
      return false;
  }
  return true;
}
export function surfacePoint(p: Point, o: Box) {
  const q = localPoint(p, o);
  return worldPoint(
    {
      x: Math.max(-o.w / 2, Math.min(q.x, o.w / 2)),
      y: Math.max(-o.h / 2, Math.min(q.y, o.h / 2)),
    },
    o,
  );
}
