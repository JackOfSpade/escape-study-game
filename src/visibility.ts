import { localPoint } from "./furniture-geometry";
import { type Floor, type Furniture, type Point, distance } from "./model";
import { inFurniture, wall } from "./spatial";
import { floorCols, floorRows } from "./site";
import { cityRayDistance, cityWall } from "./city-layout";

export const VISION = { lit: 11, dim: 8, dark: 5.4, max: 11 };
export function sightRadius(f: Floor) {
  return f.dark > 0.8 ? VISION.dark : f.dark > 0.3 ? VISION.dim : VISION.lit;
}
/** Streets have real long sight lines; indoor room visibility remains local. */
export function playerSightRadius(f: Floor, origin: Point) {
  if (!f.city || cityWall(f, origin.x, origin.y) !== false)
    return sightRadius(f);
  return Math.max(64, ...f.city.approaches.map((route) => route.length + 24));
}
const OPAQUE = new Set<Furniture["kind"]>(["gate", "door", "fridge", "shelf"]);
/** Objects of an opaque kind on a floor; kinds never change, so the list stays
 * valid until the furniture array is replaced or resized. */
const opaqueCache = new WeakMap<
  Floor,
  { source: Furniture[]; length: number; list: Furniture[] }
>();
function opaqueFurniture(f: Floor) {
  const hit = opaqueCache.get(f);
  if (hit?.source === f.furniture && hit.length === f.furniture.length)
    return hit.list;
  const list = f.furniture.filter((o) => OPAQUE.has(o.kind));
  opaqueCache.set(f, { source: f.furniture, length: f.furniture.length, list });
  return list;
}
export function blocksSight(o: Furniture) {
  return (
    OPAQUE.has(o.kind) &&
    !o.destroyed &&
    // Access doors hide what is behind them only in the rendered scene. Zombies
    // keep sensing through them, so door health stays a real time budget.
    !o.field &&
    (!o.open || !!o.door) &&
    !(o.kind === "gate" && o.turning < 0)
  );
}
// Slab intersection against an opaque object's real footprint. All distances
// are world-space, independent of canvas size, heading, palette, and frame rate.
export function rayBoxDistance(
  origin: Point,
  dx: number,
  dy: number,
  o: Pick<Furniture, "x" | "y" | "w" | "h" | "angle">,
) {
  const localOrigin = localPoint(origin, o),
    direction = localPoint({ x: o.x + dx, y: o.y + dy }, o);
  let near = -Infinity,
    far = Infinity;
  for (const [start, dir, lo, hi] of [
    [localOrigin.x, direction.x, -o.w / 2, o.w / 2],
    [localOrigin.y, direction.y, -o.h / 2, o.h / 2],
  ]) {
    if (Math.abs(dir) < 1e-10) {
      if (start < lo || start > hi) return Infinity;
      continue;
    }
    const a = (lo - start) / dir,
      b = (hi - start) / dir;
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
    if (near > far) return Infinity;
  }
  return far < 0 ? Infinity : Math.max(0, near);
}
/** Sweep a circular character against a rotated rectangular leaf/prop. */
export function rayBodyDistance(
  origin: Point,
  dx: number,
  dy: number,
  o: Pick<Furniture, "x" | "y" | "w" | "h" | "angle">,
  radius: number,
) {
  let hit = Math.min(
    rayBoxDistance(origin, dx, dy, {
      x: o.x,
      y: o.y,
      w: o.w + 2 * radius,
      h: o.h,
      angle: o.angle,
    }),
    rayBoxDistance(origin, dx, dy, {
      x: o.x,
      y: o.y,
      w: o.w,
      h: o.h + 2 * radius,
      angle: o.angle,
    }),
  );
  const q = localPoint(origin, o),
    d = localPoint({ x: o.x + dx, y: o.y + dy }, o);
  for (const sx of [-1, 1])
    for (const sy of [-1, 1]) {
      const x = q.x - (sx * o.w) / 2,
        y = q.y - (sy * o.h) / 2,
        b = x * d.x + y * d.y,
        c = x * x + y * y - radius * radius;
      if (c < 0) return 0;
      const disc = b * b - c;
      if (disc >= 0) {
        const t = -b - Math.sqrt(disc);
        if (t >= 0) hit = Math.min(hit, t);
      }
    }
  return hit;
}
export function wallRayDistance(
  f: Floor,
  origin: Point,
  angle: number,
  range: number,
) {
  const dx = Math.cos(angle),
    dy = Math.sin(angle),
    cols = floorCols(f),
    rows = floorRows(f);
  let x = Math.floor(origin.x),
    y = Math.floor(origin.y),
    hit = cityRayDistance(f, origin, dx, dy, Math.max(0, range));
  if (wall(f, origin.x, origin.y)) return 0;
  const sx = dx < 0 ? -1 : 1,
    sy = dy < 0 ? -1 : 1;
  const stepX = Math.abs(dx) < 1e-10 ? Infinity : Math.abs(1 / dx),
    stepY = Math.abs(dy) < 1e-10 ? Infinity : Math.abs(1 / dy);
  let nextX =
    Math.abs(dx) < 1e-10
      ? Infinity
      : (dx > 0 ? x + 1 - origin.x : origin.x - x) / Math.abs(dx);
  let nextY =
    Math.abs(dy) < 1e-10
      ? Infinity
      : (dy > 0 ? y + 1 - origin.y : origin.y - y) / Math.abs(dy);
  while (Math.min(nextX, nextY) <= hit) {
    let d: number;
    if (nextX < nextY) {
      d = nextX;
      x += sx;
      nextX += stepX;
    } else {
      d = nextY;
      y += sy;
      nextY += stepY;
    }
    // City facades use their exact slab hit above. Only the authored office
    // raster participates here, preserving its real doors and stair mouths.
    if (
      f.city &&
      (x < 0 ||
        y < 0 ||
        x >= cols ||
        y >= rows ||
        cityWall(f, x + 0.5, y + 0.5) !== undefined)
    )
      continue;
    if (wall(f, x + 0.5, y + 0.5)) {
      hit = d;
      break;
    }
  }
  return hit;
}
// Actor perception and physical reach still account for intervening cover.
export function rayDistance(
  f: Floor,
  origin: Point,
  angle: number,
  range: number,
  ignore?: string,
) {
  const dx = Math.cos(angle),
    dy = Math.sin(angle);
  let hit = wallRayDistance(f, origin, angle, range);
  for (const o of opaqueFurniture(f)) {
    if (!blocksSight(o) || o.id === ignore) continue;
    if (distance(origin, o) > range + Math.hypot(o.w, o.h) / 2) continue;
    if (inFurniture(origin, o)) continue;
    hit = Math.min(hit, rayBoxDistance(origin, dx, dy, o));
  }
  return hit;
}
export function canSee(
  f: Floor,
  origin: Point,
  target: Point,
  range = sightRadius(f),
  ignore?: string,
) {
  const d = distance(origin, target);
  if (d > range + 1e-7) return false;
  if (d < 1e-7) return true;
  return (
    // Only blockers nearer than the target matter, so the ray stops there.
    rayDistance(
      f,
      origin,
      Math.atan2(target.y - origin.y, target.x - origin.x),
      d,
      ignore,
    ) >=
    d - 1e-6
  );
}
/** Player view and lighting: finite in every direction, blocked only by walls. */
export function playerCanSee(
  f: Floor,
  origin: Point,
  target: Point,
  range = playerSightRadius(f, origin),
) {
  const d = distance(origin, target);
  if (d > range + 1e-7) return false;
  if (d < 1e-7) return true;
  return (
    wallRayDistance(
      f,
      origin,
      Math.atan2(target.y - origin.y, target.x - origin.x),
      range,
    ) >=
    d - 1e-6
  );
}
export function visibilityPolygon(
  f: Floor,
  origin: Point,
  range = sightRadius(f),
) {
  return Array.from({ length: 512 }, (_, i) => {
    const angle = (i / 512) * Math.PI * 2;
    // A small surface allowance makes the blocking face itself visible; it
    // cannot reveal live occupants behind it (they also need exact LOS).
    const d = Math.min(range, wallRayDistance(f, origin, angle, range) + 0.06);
    return {
      x: origin.x + Math.cos(angle) * d,
      y: origin.y + Math.sin(angle) * d,
    };
  });
}
