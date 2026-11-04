import { fieldAllows } from "./force-fields";
import { citySolid, cityWall } from "./city-layout";
import { boxBounds, boxesOverlap, localPoint } from "./furniture-geometry";
import {
  type Actor,
  type Floor,
  type Furniture,
  H,
  type Point,
  type Station,
  W,
} from "./model";
import { MinHeap } from "./heap";
import { solidDesks } from "./station-clearance";
export function inFurniture(p: Point, f: Furniture, pad = 0) {
  if (
    f.destroyed ||
    (f.open && !f.door) ||
    (f.kind === "gate" && f.turning < 0)
  )
    return false;
  // Conservative square around every rotation: reject distant props before
  // allocating local coordinates or evaluating trigonometry in navigation loops.
  const reach = (f.w + f.h) / 2 + Math.max(0, pad);
  if (Math.abs(p.x - f.x) > reach || Math.abs(p.y - f.y) > reach) return false;
  const q = localPoint(p, f);
  return pad > 0
    ? Math.hypot(
        Math.max(0, Math.abs(q.x) - f.w / 2),
        Math.max(0, Math.abs(q.y) - f.h / 2),
      ) < pad
    : Math.abs(q.x) < f.w / 2 && Math.abs(q.y) < f.h / 2;
}
/**
 * Per-floor cell buckets of furniture for point queries during one engine
 * step. Outside a step every query scans the floor's list exactly as before.
 * A bucket holds every object whose conservative reach, widened by the
 * largest indexed pad plus this tick's movement allowance, covers the cell,
 * in the floor list's order, so first-match and any-match results are
 * identical to a full scan. Each query still runs the exact inFurniture test.
 */
const INDEX_MAX_PAD = 0.5;
// A step lasts at most 0.1 s and a carried object moves at most about 8 m/s,
// so one metre covers any in-step motion before the next rebuild.
const INDEX_SLACK = INDEX_MAX_PAD + 1;
let indexEpoch = 0;
// Only the game's own floors are indexed. Temporary floor copies with a
// filtered furniture list (vault and barricade planning) keep the plain scan.
let indexedFloors: ReadonlySet<Floor> = new Set();
const furnitureIndexes = new WeakMap<
  Floor,
  { epoch: number; list: Furniture[]; length: number; cells: Furniture[][] }
>();
export function beginFurnitureIndex(floors: readonly Floor[]) {
  indexEpoch = (indexEpoch % 1_000_000_000) + 1;
  indexedFloors = new Set(floors);
}
export function endFurnitureIndex() {
  // Keep the generation monotonic: the next step must rebuild buckets even
  // when the floor retains the same furniture array and object count.
  indexedFloors = new Set();
}
/** Furniture that may contain `p` within `pad`, in floor order; undefined means scan all. */
export function furnitureNear(
  f: Floor,
  p: Point,
  pad: number,
): readonly Furniture[] | undefined {
  if (!indexEpoch || pad > INDEX_MAX_PAD || !indexedFloors.has(f))
    return undefined;
  let index = furnitureIndexes.get(f);
  if (
    !index ||
    index.epoch !== indexEpoch ||
    index.list !== f.furniture ||
    index.length !== f.furniture.length
  ) {
    // Reuse this floor's bucket arrays; only their contents change per step.
    const cells =
      index?.cells ?? Array.from({ length: W * H }, (): Furniture[] => []);
    for (const cell of cells) cell.length = 0;
    for (const o of f.furniture) {
      const reach = (o.w + o.h) / 2 + INDEX_SLACK;
      const x1 = Math.max(0, Math.floor(o.x - reach)),
        x2 = Math.min(W - 1, Math.floor(o.x + reach)),
        y1 = Math.max(0, Math.floor(o.y - reach)),
        y2 = Math.min(H - 1, Math.floor(o.y + reach));
      for (let y = y1; y <= y2; y++)
        for (let x = x1; x <= x2; x++) cells[y * W + x].push(o);
    }
    index = {
      epoch: indexEpoch,
      list: f.furniture,
      length: f.furniture.length,
      cells,
    };
    furnitureIndexes.set(f, index);
  }
  const x = Math.floor(p.x),
    y = Math.floor(p.y);
  if (x < 0 || y < 0 || x >= W || y >= H) return undefined;
  return index.cells[y * W + x];
}
/** Footprint of a terminal's desk, matching its first-person model. */
export const STATION_BODY = { w: 0.98, h: 0.65 };
/** A terminal as a fixed obstacle, for the geometry helpers. */
export function stationBody(s: Point) {
  return { x: s.x, y: s.y, ...STATION_BODY, angle: 0 };
}
/** Whether `p` is within `pad` of a terminal's desk. */
export function inStation(s: Point, p: Point, pad = 0) {
  return (
    Math.hypot(
      Math.max(0, Math.abs(p.x - s.x) - STATION_BODY.w / 2),
      Math.max(0, Math.abs(p.y - s.y) - STATION_BODY.h / 2),
    ) < pad
  );
}
/** Cheap comparison key: terminals only move while a floor is being laid out. */
export function stationSignature(f: Floor) {
  return f.stations.map((s) => `${s.x},${s.y}`).join(";");
}
export function wall(f: Floor, x: number, y: number) {
  const city = cityWall(f, x, y);
  if (city !== undefined) return city;
  return (
    x < 0 ||
    y < 0 ||
    x >= W ||
    y >= H ||
    f.tiles[Math.floor(y)]?.[Math.floor(x)] !== 0
  );
}
export function solid(
  f: Floor,
  p: Point,
  pad = 0.22,
  ignore?: string,
  pushDoors = false,
) {
  if (citySolid(f, p, pad)) return true;
  for (let y = Math.floor(p.y - pad); y <= Math.floor(p.y + pad); y++)
    for (let x = Math.floor(p.x - pad); x <= Math.floor(p.x + pad); x++)
      if (
        cityWall(f, x + 0.5, y + 0.5) === undefined &&
        wall(f, x + 0.5, y + 0.5) &&
        Math.hypot(
          Math.max(x - p.x, 0, p.x - x - 1),
          Math.max(y - p.y, 0, p.y - y - 1),
        ) < pad
      )
        return true;
  return (furnitureNear(f, p, pad) ?? f.furniture).some(
    (o) =>
      // Cheap distance rejection before permission checks.
      Math.abs(p.x - o.x) <= (o.w + o.h) / 2 + pad &&
      Math.abs(p.y - o.y) <= (o.w + o.h) / 2 + pad &&
      o.id !== ignore &&
      !(
        pushDoors &&
        o.door &&
        !o.door.latched &&
        Math.abs(o.angle ?? 0) < 0.5
      ) &&
      !(
        o.field &&
        "access" in p &&
        fieldAllows(o, p as import("./model").Actor)
      ) &&
      inFurniture(p, o, pad),
  );
}
/** How far from a terminal's centre a body stands to work at its keyboard. */
const STATION_REACH = STATION_BODY.h / 2 + 0.325;
/**
 * The way a terminal's screen faces: toward open floor rather than a wall, or
 * a pushed chair would flip it. Once settled the desk keeps it for the run.
 */
export function stationFacing(f: Floor, s: Station) {
  if (s.facing) return s.facing;
  const clear = ([1, -1] as const).filter((sign) => {
    const y = s.y + sign * STATION_REACH;
    return ![-0.26, 0, 0.26].some((dx) =>
      [-0.26, 0, 0.26].some((dy) => wall(f, s.x + dx, y + dy)),
    );
  });
  const open = clear.find(
    (sign) => !solid(f, { x: s.x, y: s.y + sign * STATION_REACH }, 0.26),
  );
  return (s.facing = open ?? clear[0] ?? 1);
}
/** Where a body stands to use a terminal: at the keyboard, facing the screen.
 * Falls back to the other sides only if something has been left in the way. */
export function stationSpot(f: Floor, s: Station): Point {
  const sign = stationFacing(f, s),
    side = STATION_BODY.w / 2 + 0.325,
    spots = [
      { x: s.x, y: s.y + sign * STATION_REACH },
      { x: s.x - side, y: s.y },
      { x: s.x + side, y: s.y },
      { x: s.x, y: s.y - sign * STATION_REACH },
    ];
  return spots.find((p) => !solid(f, p, 0.26)) ?? spots[0];
}
export function move(
  f: Floor,
  p: Point,
  dx: number,
  dy: number,
  ignore?: string,
) {
  // solid() only reads x/y, plus id/access for actors' force-field checks.
  const probe: Point =
    "access" in p
      ? ({
          x: p.x,
          y: p.y,
          id: (p as Actor).id,
          access: (p as Actor).access,
        } as Point)
      : { x: p.x, y: p.y };
  probe.x = p.x + dx;
  if (!solid(f, probe, 0.22, ignore)) p.x = probe.x;
  probe.x = p.x;
  probe.y = p.y + dy;
  if (!solid(f, probe, 0.22, ignore)) p.y = probe.y;
}
export function line(
  f: Floor,
  a: Point,
  b: Point,
  withFurniture = false,
  ignore?: string,
) {
  const d = Math.hypot(a.x - b.x, a.y - b.y),
    n = Math.ceil(d * 5);
  // Only objects whose reach overlaps the segment's box can block it.
  const near = withFurniture
    ? f.furniture.filter((o) => {
        const r = (o.w + o.h) / 2;
        return (
          o.id !== ignore &&
          o.x + r >= Math.min(a.x, b.x) &&
          o.x - r <= Math.max(a.x, b.x) &&
          o.y + r >= Math.min(a.y, b.y) &&
          o.y - r <= Math.max(a.y, b.y)
        );
      })
    : [];
  for (let i = 1; i < n; i++) {
    const p = {
      x: a.x + ((b.x - a.x) * i) / n,
      y: a.y + ((b.y - a.y) * i) / n,
    };
    if (wall(f, p.x, p.y) || near.some((o) => inFurniture(p, o))) return false;
  }
  return true;
}
interface PathCache {
  city?: Floor["city"];
  tiles: Uint8Array;
  ids: string[];
  poses: Float64Array;
  routes: Map<string, Point[]>;
  /** Cells whose centre lies within a body radius of intact furniture. */
  furniture?: Uint8Array;
  stations: string;
  /** Cells whose centre lies within a body radius of a terminal's desk. */
  desks?: Uint8Array;
}
const routeCache = new WeakMap<Floor, PathCache>();
const POSE = 6;
/** Geometry snapshot compared without building strings on every query. */
function snapshot(f: Floor) {
  const tiles = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) tiles[y * W + x] = f.tiles[y]?.[x] ?? 1;
  const poses = new Float64Array(f.furniture.length * POSE);
  f.furniture.forEach((o, i) => {
    poses.set(
      [
        o.x,
        o.y,
        o.w,
        o.h,
        o.angle ?? 0,
        (o.destroyed ? 1 : 0) | (o.open ? 2 : 0) | (o.turning < 0 ? 4 : 0),
      ],
      i * POSE,
    );
  });
  return {
    city: f.city,
    tiles,
    poses,
    ids: f.furniture.map((o) => `${o.id}/${o.kind}`),
    stations: stationSignature(f),
  };
}
function unchanged(cache: PathCache, f: Floor) {
  if (cache.city !== f.city) return false;
  if (cache.ids.length !== f.furniture.length) return false;
  if (cache.stations !== stationSignature(f)) return false;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (cache.tiles[y * W + x] !== (f.tiles[y]?.[x] ?? 1)) return false;
  for (let i = 0; i < f.furniture.length; i++) {
    const o = f.furniture[i],
      p = cache.poses,
      j = i * POSE;
    if (
      cache.ids[i] !== `${o.id}/${o.kind}` ||
      // Routes are grid-level guidance and collisions stay exact, so a
      // shoved chair moving a few centimetres keeps the cached routes.
      Math.abs(p[j] - o.x) > 0.08 ||
      Math.abs(p[j + 1] - o.y) > 0.08 ||
      p[j + 2] !== o.w ||
      p[j + 3] !== o.h ||
      Math.abs(p[j + 4] - (o.angle ?? 0)) > 0.04 ||
      p[j + 5] !==
        ((o.destroyed ? 1 : 0) | (o.open ? 2 : 0) | (o.turning < 0 ? 4 : 0))
    )
      return false;
  }
  return true;
}
export function path(f: Floor, a: Point, b: Point, breakable = false): Point[] {
  // This bounded grid owns indoor guidance. Public exterior recovery has its
  // own road graph; out-of-range indices must never enter a typed-array path.
  if (!gridPoint(a) || !gridPoint(b)) return [];
  // Exact grid queries recur while a crowd waits at a barricade. Geometry is
  // authoritative, including externally loaded/edited floors; HP is not a cost.
  let cache = routeCache.get(f);
  if (!cache || !unchanged(cache, f)) {
    cache = { ...snapshot(f), routes: new Map() };
    routeCache.set(f, cache);
  }
  const key = `${Math.floor(a.x)},${Math.floor(a.y)}/${Math.floor(b.x)},${Math.floor(b.y)}/${breakable}`;
  let route = cache.routes.get(key);
  if (!route) {
    cache.furniture ??= furnitureCells(f);
    cache.desks ??= deskCells(f);
    route = computePath(f, a, b, breakable, cache.furniture, cache.desks);
    if (cache.routes.size >= 512)
      cache.routes.delete(cache.routes.keys().next().value!);
    cache.routes.set(key, route);
  }
  // Callers consume routes and sometimes modify individual points.
  return route.map((p) => ({ ...p }));
}
function furnitureCells(f: Floor) {
  const cells = new Uint8Array(W * H);
  for (const o of f.furniture) {
    const r = (o.w + o.h) / 2 + 0.22;
    for (
      let y = Math.max(0, Math.floor(o.y - r));
      y <= Math.min(H - 1, Math.floor(o.y + r));
      y++
    )
      for (
        let x = Math.max(0, Math.floor(o.x - r));
        x <= Math.min(W - 1, Math.floor(o.x + r));
        x++
      )
        if (
          !cells[y * W + x] &&
          inFurniture({ x: x + 0.5, y: y + 0.5 }, o, 0.22)
        )
          cells[y * W + x] = 1;
  }
  return cells;
}
function deskCells(f: Floor) {
  const cells = new Uint8Array(W * H),
    desks = solidDesks(f);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (desks.some((s) => inStation(s, { x: x + 0.5, y: y + 0.5 }, 0.22)))
        cells[y * W + x] = 1;
  return cells;
}
// Dijkstra with positive furniture traversal costs: zombies prefer open alternatives, then break a physical route.
function computePath(
  f: Floor,
  a: Point,
  b: Point,
  breakable: boolean,
  furniture: Uint8Array,
  desks: Uint8Array,
): Point[] {
  const start = Math.floor(a.y) * W + Math.floor(a.x),
    end = Math.floor(b.y) * W + Math.floor(b.x);
  const dist = new Float64Array(W * H).fill(Infinity),
    prev = new Int32Array(W * H).fill(-1),
    closed = new Uint8Array(W * H);
  dist[start] = 0;
  const heap = new MinHeap();
  heap.push(start, 0);
  while (heap.length) {
    const [v, cost] = heap.pop();
    if (closed[v]) continue;
    closed[v] = 1;
    if (v === end) break;
    const x = v % W,
      y = Math.floor(v / W);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const xx = x + dx,
        yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      if (wall(f, xx + 0.5, yy + 0.5)) continue;
      const id = yy * W + xx;
      if (closed[id]) continue;
      // A desk cannot be broken, but its own cell may be the destination.
      if (desks[id] && id !== end) continue;
      const ob = furniture[id] === 1;
      if (ob && !breakable) continue;
      const nd = cost + 1 + (ob ? 18 : 0);
      if (nd < dist[id]) {
        dist[id] = nd;
        prev[id] = v;
        heap.push(id, nd);
      }
    }
  }
  if (!Number.isFinite(dist[end]) || prev[end] < 0) return [];
  const out: Point[] = [];
  for (let v = end, count = 0; v !== start; v = prev[v]) {
    if (!Number.isSafeInteger(v) || v < 0 || v >= W * H || ++count > W * H)
      return [];
    out.push({ x: (v % W) + 0.5, y: Math.floor(v / W) + 0.5 });
  }
  return out.reverse();
}
function gridPoint(p: Point) {
  return (
    Number.isFinite(p.x) &&
    Number.isFinite(p.y) &&
    p.x >= 0 &&
    p.y >= 0 &&
    p.x < W &&
    p.y < H
  );
}
export function soundGain(f: Floor, a: Point, b: Point) {
  if (line(f, a, b, true)) return 1;
  if (f.city && (!gridPoint(a) || !gridPoint(b))) return 0.15;
  const open = path(f, a, b, false);
  return open.length ? Math.max(0.25, 1 - open.length / 100) : 0.025;
}
export function canPlace(
  f: Floor,
  o: Furniture,
  p: Point,
  w = o.w,
  h = o.h,
  angle = o.angle ?? 0,
  margin = 0.04,
) {
  if (!Number.isFinite(p.x + p.y + w + h + angle) || w <= 0 || h <= 0)
    return false;
  const box = { ...p, w, h, angle },
    bounds = boxBounds(box),
    eps = 1e-7;
  if (f.city) {
    const city = f.city.bounds;
    if (
      p.x - bounds.w / 2 < city.left ||
      p.x + bounds.w / 2 > city.right ||
      p.y - bounds.h / 2 < city.top ||
      p.y + bounds.h / 2 > city.bottom
    )
      return false;
    if (
      f.city.obstacles.some((obstacle) => boxesOverlap(box, obstacle, margin))
    )
      return false;
  }
  for (
    let y = Math.floor(p.y - bounds.h / 2 + eps);
    y <= Math.floor(p.y + bounds.h / 2 - eps);
    y++
  )
    for (
      let x = Math.floor(p.x - bounds.w / 2 + eps);
      x <= Math.floor(p.x + bounds.w / 2 - eps);
      x++
    )
      if (
        cityWall(f, x + 0.5, y + 0.5) === undefined &&
        wall(f, x + 0.5, y + 0.5) &&
        boxesOverlap(box, { x: x + 0.5, y: y + 0.5, w: 1, h: 1 })
      )
        return false;
  return !f.furniture.some(
    (other) =>
      other.id !== o.id &&
      inFurniture(other, other) &&
      boxesOverlap(box, other, margin),
  );
}
