import { survivorFloor } from "./force-fields";
import { doorFrame } from "./doors";
import { boxBounds, worldPoint } from "./furniture-geometry";
import { distance, type Floor, type Point } from "./model";
import { floorCols, floorRows } from "./site";
import {
  STATION_BODY,
  inFurniture,
  inStation,
  solid,
  stationBody,
  stationStamp,
  wall,
} from "./spatial";
import { rayBodyDistance } from "./visibility";
import { MinHeap } from "./heap";
import { solidDesks } from "./station-clearance";
import { cityWall } from "./city-layout";
export interface NavStep extends Point {
  action?: "door" | "vault";
  obstacle?: string;
}
interface Edge {
  to: number;
  cost: number;
  action?: NavStep["action"];
  obstacle?: string;
}
/** Exact geometry snapshot, compared without building strings per query. */
interface Snapshot {
  tiles: Float64Array;
  ids: string[];
  kinds: string[];
  poses: Float64Array;
}
const POSE = 6;
const poseFlags = (o: Floor["furniture"][number]) =>
  (o.destroyed ? 1 : 0) |
  (o.open ? 2 : 0) |
  (o.turning < 0 ? 4 : 0) |
  (o.door?.latched ? 8 : 0);
/** Below this swing an unlatched leaf is pushed aside, not routed around. */
const DOOR_ROUTE_ANGLE = 0.5;
/** What routing actually depends on. A hinged leaf's position follows from its
 * angle and its crossing from its fixed frame, so a door moving through its
 * near-closed arc keeps the same graph rather than rebuilding it every step.
 * A swung leaf stays exact: tight gaps beside it need its true corners. */
export function routePose(o: Floor["furniture"][number]) {
  if (!o.door) return { x: o.x, y: o.y, angle: o.angle ?? 0 };
  const angle = o.angle ?? 0;
  return {
    x: 0,
    y: 0,
    angle: o.door.latched || Math.abs(angle) < DOOR_ROUTE_ANGLE ? 0 : angle,
  };
}
function tilesMatch(tiles: Float64Array, f: Floor) {
  const cols = floorCols(f),
    rows = floorRows(f);
  if (tiles.length !== cols * rows) return false;
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++)
      if (tiles[y * cols + x] !== (f.tiles[y]?.[x] ?? 1)) return false;
  return true;
}
function furnitureMatches(s: Snapshot, f: Floor) {
  if (s.ids.length !== f.furniture.length) return false;
  for (let i = 0; i < f.furniture.length; i++) {
    const o = f.furniture[i],
      j = i * POSE,
      pose = routePose(o);
    if (
      s.ids[i] !== o.id ||
      s.kinds[i] !== o.kind ||
      s.poses[j] !== pose.x ||
      s.poses[j + 1] !== pose.y ||
      s.poses[j + 2] !== o.w ||
      s.poses[j + 3] !== o.h ||
      s.poses[j + 4] !== pose.angle ||
      s.poses[j + 5] !== poseFlags(o)
    )
      return false;
  }
  return true;
}
function snapshotTiles(f: Floor) {
  const cols = floorCols(f),
    rows = floorRows(f),
    tiles = new Float64Array(cols * rows);
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) tiles[y * cols + x] = f.tiles[y]?.[x] ?? 1;
  return tiles;
}
function snapshotFurniture(f: Floor, tiles: Float64Array): Snapshot {
  const poses = new Float64Array(f.furniture.length * POSE);
  f.furniture.forEach((o, i) => {
    const j = i * POSE,
      pose = routePose(o);
    poses[j] = pose.x;
    poses[j + 1] = pose.y;
    poses[j + 2] = o.w;
    poses[j + 3] = o.h;
    poses[j + 4] = pose.angle;
    poses[j + 5] = poseFlags(o);
  });
  return {
    tiles,
    ids: f.furniture.map((o) => o.id),
    kinds: f.furniture.map((o) => o.kind),
    poses,
  };
}
/** Broad phase: a uniform bucket grid over object bounding boxes, so a segment
 * test only visits the pieces that could possibly touch it. */
const CELL = 2;
interface Bounds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
interface BucketIndex {
  cols: number;
  rows: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  count: number;
  boxes: Float64Array;
  cells: number[][];
  stamps: Int32Array;
  queryId: number;
  out: number[];
}
function buildBuckets(count: number, boxAt: (i: number, b: Bounds) => void) {
  const boxes = new Float64Array(count * 4),
    box: Bounds = { x1: 0, y1: 0, x2: 0, y2: 0 };
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    boxAt(i, box);
    const j = i * 4;
    boxes[j] = box.x1;
    boxes[j + 1] = box.y1;
    boxes[j + 2] = box.x2;
    boxes[j + 3] = box.y2;
    if (box.x1 < minX) minX = box.x1;
    if (box.y1 < minY) minY = box.y1;
    if (box.x2 > maxX) maxX = box.x2;
    if (box.y2 > maxY) maxY = box.y2;
  }
  if (!count) minX = minY = maxX = maxY = 0;
  const cols = count ? Math.max(1, Math.ceil((maxX - minX) / CELL) + 1) : 0,
    rows = count ? Math.max(1, Math.ceil((maxY - minY) / CELL) + 1) : 0,
    cells = Array.from({ length: cols * rows }, (): number[] => []);
  for (let i = 0; i < count; i++) {
    const j = i * 4,
      x1 = Math.max(0, Math.floor((boxes[j] - minX) / CELL)),
      x2 = Math.min(cols - 1, Math.floor((boxes[j + 2] - minX) / CELL)),
      y1 = Math.max(0, Math.floor((boxes[j + 1] - minY) / CELL)),
      y2 = Math.min(rows - 1, Math.floor((boxes[j + 3] - minY) / CELL));
    for (let y = y1; y <= y2; y++)
      for (let x = x1; x <= x2; x++) cells[y * cols + x].push(i);
  }
  const index: BucketIndex = {
    cols,
    rows,
    minX,
    minY,
    maxX,
    maxY,
    count,
    boxes,
    cells,
    stamps: new Int32Array(count),
    queryId: 0,
    out: [],
  };
  return index;
}
/** Candidate item indices for a query rect. The array is the index's scratch
 * buffer, so consume it before querying the same index again. */
function queryBuckets(
  b: BucketIndex,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
) {
  const out = b.out;
  out.length = 0;
  if (!b.count || x2 < b.minX || x1 > b.maxX || y2 < b.minY || y1 > b.maxY)
    return out;
  let id = b.queryId + 1;
  if (id >= 0x7ffffff0) {
    b.stamps.fill(0);
    id = 1;
  }
  b.queryId = id;
  const cx1 = Math.max(0, Math.floor((x1 - b.minX) / CELL)),
    cx2 = Math.min(b.cols - 1, Math.floor((x2 - b.minX) / CELL)),
    cy1 = Math.max(0, Math.floor((y1 - b.minY) / CELL)),
    cy2 = Math.min(b.rows - 1, Math.floor((y2 - b.minY) / CELL));
  for (let y = cy1; y <= cy2; y++)
    for (let x = cx1; x <= cx2; x++)
      for (const i of b.cells[y * b.cols + x]) {
        if (b.stamps[i] === id) continue;
        b.stamps[i] = id;
        out.push(i);
      }
  return out;
}
/** Swept body radius of a terminal's desk: every part of it lies this close to
 * its centre, so a wider query can never miss a desk a segment really touches. */
function deskRadius() {
  return Math.hypot(STATION_BODY.w, STATION_BODY.h) / 2;
}
type Desk = ReturnType<typeof solidDesks>[number];
interface BroadPhase {
  /** Floor furniture, indexed by the reach box the linear scan rejected on. */
  furniture: BucketIndex;
  /** Solid desks, indexed by the circle that bounds their body. */
  desks: BucketIndex;
  deskList: Desk[];
}
function furnitureBroad(f: Floor) {
  return buildBuckets(f.furniture.length, (i, b) => {
    const o = f.furniture[i],
      r = (o.w + o.h) / 2 + 1e-6;
    b.x1 = o.x - r;
    b.y1 = o.y - r;
    b.x2 = o.x + r;
    b.y2 = o.y + r;
  });
}
function deskBroad(desks: Desk[]) {
  return buildBuckets(desks.length, (i, b) => {
    const s = desks[i],
      r = deskRadius() + 1e-6;
    b.x1 = s.x - r;
    b.y1 = s.y - r;
    b.x2 = s.x + r;
    b.y2 = s.y + r;
  });
}
const broadCache = new WeakMap<
  Floor,
  { poses: Float64Array; ids: string[]; stamp: number; broad: BroadPhase }
>();
function broadCurrent(
  saved: { poses: Float64Array; ids: string[]; stamp: number },
  f: Floor,
  stamp: number,
) {
  if (saved.stamp !== stamp) return false;
  if (saved.poses.length !== f.furniture.length * 5) return false;
  const p = saved.poses;
  for (let i = 0; i < f.furniture.length; i++) {
    const o = f.furniture[i],
      j = i * 5;
    if (
      saved.ids[i] !== o.id ||
      p[j] !== o.x ||
      p[j + 1] !== o.y ||
      p[j + 2] !== o.w ||
      p[j + 3] !== o.h ||
      p[j + 4] !== (o.angle ?? 0)
    )
      return false;
  }
  return true;
}
/** Bucket index for a floor's furniture and desks, reused while they hold still. */
function broadPhase(f: Floor): BroadPhase {
  const stamp = stationStamp(f),
    saved = broadCache.get(f);
  if (saved && broadCurrent(saved, f, stamp)) return saved.broad;
  const desks = solidDesks(f),
    poses = new Float64Array(f.furniture.length * 5);
  f.furniture.forEach((o, i) => {
    const j = i * 5;
    poses[j] = o.x;
    poses[j + 1] = o.y;
    poses[j + 2] = o.w;
    poses[j + 3] = o.h;
    poses[j + 4] = o.angle ?? 0;
  });
  const broad: BroadPhase = {
    furniture: furnitureBroad(f),
    desks: deskBroad(desks),
    deskList: desks,
  };
  broadCache.set(f, {
    poses,
    ids: f.furniture.map((o) => o.id),
    stamp,
    broad,
  });
  return broad;
}
/** Continuous swept actor footprint, including shallow corner intersections. */
export function walkSegment(f: Floor, a: Point, b: Point, ignore?: string) {
  return segment(survivorFloor(f, a), a, b, ignore);
}
function segment(
  f: Floor,
  a: Point,
  b: Point,
  ignore?: string,
  wallEdges?: Map<string, boolean>,
  broad?: BroadPhase,
) {
  const d = distance(a, b),
    // Leave one centimetre for native contact slop so resting on a leaf does
    // not make every outgoing route invalid. The rigid body remains radius .26.
    pad = 0.25;
  if (!Number.isFinite(d) || solid(f, b, pad, ignore, true)) return false;
  if (solid(f, a, pad, ignore, true)) {
    // Contacts and legacy saves can start a few millimetres inside the
    // conservative route clearance. Permit an outgoing segment only when
    // it actually leaves that contact within a short continuous distance.
    if (d < 0.06 || solid(f, a, 0.22, ignore, true)) return false;
    const out = {
      x: a.x + ((b.x - a.x) / d) * 0.06,
      y: a.y + ((b.y - a.y) / d) * 0.06,
    };
    if (solid(f, out, pad, ignore, true)) return false;
    return segment(f, out, b, ignore, wallEdges, broad);
  }
  if (d < 1e-9) return true;
  const dx = (b.x - a.x) / d,
    dy = (b.y - a.y) / d;
  const minX = Math.min(a.x, b.x) - pad,
    maxX = Math.max(a.x, b.x) + pad,
    minY = Math.min(a.y, b.y) - pad,
    maxY = Math.max(a.y, b.y) + pad;
  const edgeKey = wallEdges ? `${a.x}/${a.y}/${b.x}/${b.y}` : "";
  let clear = wallEdges?.get(edgeKey);
  if (clear === undefined) {
    clear = wallClearance(f, a, d, dx, dy, minX, maxX, minY, maxY, pad);
    wallEdges?.set(edgeKey, clear);
  }
  if (!clear) return false;
  // Broad phase: the linear scan rejected every piece whose reach box missed
  // this padded box, so visiting exactly those buckets tests the same objects.
  const index = broad ?? broadPhase(f);
  for (const i of queryBuckets(index.furniture, minX, minY, maxX, maxY)) {
    const o = f.furniture[i],
      reach = (o.w + o.h) / 2;
    if (
      o.id === ignore ||
      o.destroyed ||
      o.x + reach < minX ||
      o.x - reach > maxX ||
      o.y + reach < minY ||
      o.y - reach > maxY
    )
      continue;
    const bounds = boxBounds(o);
    if (
      (o.door && !o.door.latched && Math.abs(o.angle ?? 0) < 0.5) ||
      !inFurniture(o, o) ||
      o.x + bounds.w / 2 < minX ||
      o.x - bounds.w / 2 > maxX ||
      o.y + bounds.h / 2 < minY ||
      o.y - bounds.h / 2 > maxY
    )
      continue;
    if (rayBodyDistance(a, dx, dy, o, pad - 1e-8) < d - 1e-7) return false;
  }
  // Terminals are approached and left, so a desk at the destination does not
  // block; a body already touching one may leave but not walk through it.
  const desks = index.deskList;
  for (const i of queryBuckets(
    index.desks,
    minX - deskRadius(),
    minY - deskRadius(),
    maxX + deskRadius(),
    maxY + deskRadius(),
  )) {
    const s = desks[i];
    if (inStation(s, b, pad) || inStation(s, a, 1e-6)) continue;
    const clearance = inStation(s, a, pad) ? 0 : pad - 1e-8;
    if (rayBodyDistance(a, dx, dy, stationBody(s), clearance) < d - 1e-7)
      return false;
  }
  return true;
}

function wallClearance(
  f: Floor,
  a: Point,
  d: number,
  dx: number,
  dy: number,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  pad: number,
) {
  if (f.city)
    for (const obstacle of f.city.obstacles) {
      if (
        obstacle.x + obstacle.w / 2 < minX ||
        obstacle.x - obstacle.w / 2 > maxX ||
        obstacle.y + obstacle.h / 2 < minY ||
        obstacle.y - obstacle.h / 2 > maxY
      )
        continue;
      if (rayBodyDistance(a, dx, dy, obstacle, pad - 1e-8) < d - 1e-7)
        return false;
    }
  const cols = floorCols(f),
    rows = floorRows(f);
  for (
    let y = Math.max(-1, Math.floor(minY));
    y <= Math.min(rows, Math.floor(maxY));
    y++
  )
    for (
      let x = Math.max(-1, Math.floor(minX));
      x <= Math.min(cols, Math.floor(maxX));
      x++
    )
      if (
        cityWall(f, x + 0.5, y + 0.5) === undefined &&
        wall(f, x + 0.5, y + 0.5) &&
        rayBodyDistance(
          a,
          dx,
          dy,
          {
            x: x + 0.5,
            y: y + 0.5,
            w: 1,
            h: 1,
          },
          pad - 1e-8,
        ) <
          d - 1e-7
      )
        return false;
  return true;
}
interface Graph {
  city?: Floor["city"];
  signature: Snapshot;
  stamp: number;
  points: Point[];
  edges: Edge[][];
  /** Point indices bucketed by integer cell, so approach links only visit
   * nearby nodes instead of scanning the whole graph. */
  buckets: Map<number, number[]>;
  cols: number;
}
/** What survives a furniture nudge: wall clearance, whole edge tests and the
 * solidity of every route node, each keyed by its own piece of geometry. */
interface GraphState {
  city?: Floor["city"];
  stamp: number;
  tiles: Float64Array;
  wallEdges: Map<string, boolean>;
  edges: Map<string, EdgeTest>;
  solids: Int8Array;
  signature?: Snapshot;
}
interface EdgeTest {
  ok: boolean;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
const cache = new WeakMap<Floor, Graph>();
const states = new WeakMap<Floor, GraphState>();
/** Big maps would outgrow their usefulness on a floor nobody walks any more. */
const MAX_EDGE_TESTS = 240000;
let builds = 0,
  incrementalBuilds = 0;
/** How many route graphs this process built, and how many reused a floor's
 * cached tests after furniture moved. */
export function routeGraphStats() {
  return { builds, incremental: incrementalBuilds };
}
export function resetRouteGraphStats() {
  builds = 0;
  incrementalBuilds = 0;
}
function poseAt(s: Snapshot, i: number, o: Floor["furniture"][number]) {
  const j = i * POSE,
    pose = routePose(o);
  return (
    s.poses[j] === pose.x &&
    s.poses[j + 1] === pose.y &&
    s.poses[j + 2] === o.w &&
    s.poses[j + 3] === o.h &&
    s.poses[j + 4] === pose.angle &&
    s.poses[j + 5] === poseFlags(o)
  );
}
/** Drop cached node solidity and edge tests that a moved, added or removed
 * piece could touch. Everything else keeps its answer. */
function invalidate(state: GraphState, old: Snapshot, f: Floor) {
  const rects: number[] = [],
    before = new Map<string, number>(),
    live = new Set<string>();
  old.ids.forEach((id, i) => {
    if (!before.has(id)) before.set(id, i);
  });
  const mark = (x: number, y: number, w: number, h: number) => {
    // A reach box covers every point of the piece, and the extra tile covers a
    // segment box or node centre that merely grazes it.
    const reach = (w + h) / 2 + 0.5;
    rects.push(x - reach, y - reach, x + reach, y + reach);
  };
  for (const o of f.furniture) {
    live.add(o.id);
    const i = before.get(o.id);
    if (i === undefined) {
      mark(o.x, o.y, o.w, o.h);
      continue;
    }
    if (old.kinds[i] === o.kind && poseAt(old, i, o)) continue;
    mark(o.x, o.y, o.w, o.h);
    mark(
      old.poses[i * POSE],
      old.poses[i * POSE + 1],
      old.poses[i * POSE + 2],
      old.poses[i * POSE + 3],
    );
  }
  for (const [id, i] of before)
    if (!live.has(id))
      mark(
        old.poses[i * POSE],
        old.poses[i * POSE + 1],
        old.poses[i * POSE + 2],
        old.poses[i * POSE + 3],
      );
  if (!rects.length) return;
  for (const [key, e] of state.edges) {
    for (let q = 0; q < rects.length; q += 4)
      if (!(
        rects[q + 2] < e.x1 ||
        rects[q] > e.x2 ||
        rects[q + 3] < e.y1 ||
        rects[q + 1] > e.y2
      )) {
        state.edges.delete(key);
        break;
      }
  }
  const cols = floorCols(f),
    rows = floorRows(f);
  for (let q = 0; q < rects.length; q += 4) {
    const x1 = Math.max(0, Math.floor(rects[q])),
      x2 = Math.min(cols - 1, Math.ceil(rects[q + 2])),
      y1 = Math.max(0, Math.floor(rects[q + 1])),
      y2 = Math.min(rows - 1, Math.ceil(rects[q + 3]));
    for (let y = y1; y <= y2; y++)
      for (let x = x1; x <= x2; x++) state.solids[y * cols + x] = -1;
  }
}
function graph(f: Floor): Graph {
  const saved = cache.get(f),
    stamp = stationStamp(f);
  if (
    saved &&
    saved.city === f.city &&
    saved.stamp === stamp &&
    tilesMatch(saved.signature.tiles, f) &&
    furnitureMatches(saved.signature, f)
  )
    return saved;
  builds++;
  const cols = floorCols(f),
    rows = floorRows(f),
    broad = broadPhase(f);
  let state = states.get(f);
  const sameGrid =
    !!state &&
    state.city === f.city &&
    state.stamp === stamp &&
    state.solids.length === cols * rows &&
    tilesMatch(state.tiles, f);
  if (state && sameGrid) {
    // Tiles, city and terminals held still, so only furniture can have moved.
    if (state.signature) invalidate(state, state.signature, f);
    incrementalBuilds++;
  } else {
    // Wall clearance is a property of the raster, so reuse it when it held.
    const tiles =
      state && tilesMatch(state.tiles, f) ? state.tiles : snapshotTiles(f);
    state = {
      city: f.city,
      stamp,
      tiles,
      wallEdges: new Map(),
      edges: new Map(),
      solids: new Int8Array(cols * rows).fill(-1),
    };
    states.set(f, state);
  }
  const signature = snapshotFurniture(f, state.tiles),
    built = buildGraph(f, state, signature, stamp, broad);
  if (state.edges.size > MAX_EDGE_TESTS) state.edges.clear();
  state.signature = signature;
  cache.set(f, built);
  return built;
}
function buildGraph(
  f: Floor,
  state: GraphState,
  signature: Snapshot,
  stamp: number,
  broad: BroadPhase,
): Graph {
  const points: Point[] = [],
    edges: Edge[][] = [],
    grid = new Map<number, number>();
  const add = (p: Point) => {
    points.push(p);
    edges.push([]);
    return points.length - 1;
  };
  const link = (
    a: number,
    b: number,
    extra = 0,
    action?: NavStep["action"],
    obstacle?: string,
  ) => {
    const cost = distance(points[a], points[b]) + extra;
    edges[a].push({ to: b, cost, action, obstacle });
    edges[b].push({ to: a, cost, action, obstacle });
  };
  /** Segment result, remembered with the box it depends on so a far-away
   * furniture nudge leaves it alone. Nodes are plain points, never actors. */
  const test = (a: Point, b: Point, ignore?: string) => {
    const key = `${ignore ?? ""}/${a.x}/${a.y}/${b.x}/${b.y}`,
      saved = state.edges.get(key);
    if (saved) return saved.ok;
    const ok = segment(f, a, b, ignore, state.wallEdges, broad),
      entry: EdgeTest = {
        ok,
        x1: Math.min(a.x, b.x) - 0.25,
        y1: Math.min(a.y, b.y) - 0.25,
        x2: Math.max(a.x, b.x) + 0.25,
        y2: Math.max(a.y, b.y) + 0.25,
      };
    state.edges.set(key, entry);
    return ok;
  };
  const cols = floorCols(f),
    rows = floorRows(f);
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const key = y * cols + x,
        p = { x: x + 0.5, y: y + 0.5 };
      let open = state.solids[key];
      if (open < 0) {
        open =
          !solid(f, p, 0.22, undefined, true) &&
          !queryBuckets(
            broad.desks,
            p.x - deskRadius() - 0.22,
            p.y - deskRadius() - 0.22,
            p.x + deskRadius() + 0.22,
            p.y + deskRadius() + 0.22,
          ).some((i) => inStation(broad.deskList[i], p, 0.22))
            ? 1
            : 0;
        state.solids[key] = open;
      }
      if (open) grid.set(key, add(p));
    }
  for (const [key, index] of grid)
    for (const neighbor of [key + 1, key + cols]) {
      const other = grid.get(neighbor);
      if (
        other !== undefined &&
        distance(points[index], points[other]) < 1.01 &&
        test(points[index], points[other])
      )
        link(index, other);
    }
  const nearbyGrid = (index: number, ignore?: string) => {
    const p = points[index];
    for (let y = Math.floor(p.y) - 2; y <= Math.floor(p.y) + 2; y++)
      for (let x = Math.floor(p.x) - 2; x <= Math.floor(p.x) + 2; x++) {
        const other = grid.get(y * cols + x);
        if (
          other !== undefined &&
          distance(p, points[other]) < 1.8 &&
          test(p, points[other], ignore)
        )
          link(index, other);
      }
  };
  // Traverse complete obstacle faces instead of treating an occupied grid cell
  // as walkable. This keeps the approach, direction and valid landing together.
  for (const o of f.furniture) {
    if (
      o.destroyed ||
      (o.open && !o.door) ||
      o.kind === "gate" ||
      (o.field && !o.door)
    )
      continue;
    if (o.door && !o.door.latched && Math.abs(o.angle ?? 0) >= 0.5) {
      // A swung leaf can leave a legal off-centre gap narrower than the grid.
      // Continuous corner waypoints preserve that actual circular clearance.
      const nodes: number[] = [];
      for (const sx of [-1, 1])
        for (const sy of [-1, 1]) {
          const corner = worldPoint(
            { x: (sx * o.w) / 2, y: (sy * o.h) / 2 },
            o,
          );
          for (let i = 0; i < 8; i++) {
            const angle = (i * Math.PI) / 4,
              p = {
                x: corner.x + Math.cos(angle) * 0.28,
                y: corner.y + Math.sin(angle) * 0.28,
              };
            if (!solid(f, p, 0.25)) {
              const index = add(p);
              nodes.push(index);
              nearbyGrid(index);
            }
          }
        }
      for (let i = 0; i < nodes.length; i++)
        for (let j = i + 1; j < nodes.length; j++)
          if (
            distance(points[nodes[i]], points[nodes[j]]) < 3.2 &&
            test(points[nodes[i]], points[nodes[j]])
          )
            link(nodes[i], nodes[j]);
      continue;
    }
    if (o.kind === "door" && o.door) {
      const frame = doorFrame(o),
        horizontal = frame.h >= frame.w;
      const a = horizontal
        ? { x: frame.x - frame.w / 2 - 0.55, y: frame.y }
        : { x: frame.x, y: frame.y - frame.h / 2 - 0.55 };
      const b = horizontal
        ? { x: frame.x + frame.w / 2 + 0.55, y: frame.y }
        : { x: frame.x, y: frame.y + frame.h / 2 + 0.55 };
      if (test(a, b, o.id)) {
        const left = add(a),
          right = add(b);
        nearbyGrid(left, o.id);
        nearbyGrid(right, o.id);
        link(left, right, 0.5, "door", o.id);
      }
      continue;
    }
    for (const horizontal of [true, false]) {
      if (o.kind === "door" && (horizontal ? o.w > o.h : o.h > o.w)) continue;
      const span = horizontal ? o.h : o.w,
        center = horizontal ? o.y : o.x;
      const cross = horizontal ? o.w : o.h;
      if (cross + 1.1 > 4.7) continue;
      const samples = new Set([center]);
      for (
        let v = Math.ceil(center - span / 2 - 0.5);
        v + 0.5 < center + span / 2;
        v++
      )
        samples.add(v + 0.5);
      for (const along of samples) {
        const localA = horizontal
          ? { x: o.x - o.w / 2 - 0.55, y: along }
          : { x: along, y: o.y - o.h / 2 - 0.55 };
        const localB = horizontal
          ? { x: o.x + o.w / 2 + 0.55, y: along }
          : { x: along, y: o.y + o.h / 2 + 0.55 };
        const a = worldPoint({ x: localA.x - o.x, y: localA.y - o.y }, o),
          b = worldPoint({ x: localB.x - o.x, y: localB.y - o.y }, o);
        if (
          !test(a, b, o.id) ||
          !inFurniture({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, o)
        )
          continue;
        const left = add(a),
          right = add(b);
        nearbyGrid(left);
        nearbyGrid(right);
        link(
          left,
          right,
          o.kind === "door" ? 0.5 : 3.2,
          o.kind === "door" ? "door" : "vault",
          o.id,
        );
      }
    }
  }
  const buckets = new Map<number, number[]>();
  for (let i = 0; i < points.length; i++) {
    const key = Math.floor(points[i].y) * cols + Math.floor(points[i].x),
      list = buckets.get(key);
    if (list) list.push(i);
    else buckets.set(key, [i]);
  }
  return {
    signature,
    city: f.city,
    stamp,
    points,
    edges,
    buckets,
    cols,
  };
}
/** Route to an end that sits on a door leaf: the one case that needs the leaf's
 * own frame and approach points rather than the shared grid. */
function doorRoute(f: Floor, start: Point, end: Point): NavStep[] {
  const door = f.furniture.find(
    (o) => o.kind === "door" && inFurniture(end, o),
  );
  if (!door || (door.field && !door.door)) return [];
  if (door.door && !door.door.latched && walkSegment(f, start, end, door.id))
    return [{ ...end, action: "door", obstacle: door.id }];
  const frame = doorFrame(door);
  const options = [
    { x: frame.x - frame.w / 2 - 0.55, y: frame.y },
    { x: frame.x + frame.w / 2 + 0.55, y: frame.y },
    { x: frame.x, y: frame.y - frame.h / 2 - 0.55 },
    { x: frame.x, y: frame.y + frame.h / 2 + 0.55 },
  ].filter(
    (p) =>
      distance(p, frame) < 1.9 &&
      !solid(f, p, 0.22, undefined, true) &&
      walkSegment(f, p, frame, door.id),
  );
  const routes = options
    .map((p) => ({ p, route: survivorPaths(f, start, [p])[0] }))
    .filter((v) => v.route.length || distance(start, v.p) < 0.04);
  routes.sort(
    (a, b) =>
      a.route.reduce(
        (n, p, i) => n + distance(i ? a.route[i - 1] : start, p),
        0,
      ) -
      b.route.reduce(
        (n, p, i) => n + distance(i ? b.route[i - 1] : start, p),
        0,
      ),
  );
  const selected = routes[0];
  return selected
    ? [...selected.route, { ...end, action: "door", obstacle: door.id }]
    : [];
}
/** Graph nodes whose cell bucket can hold a point within the 1.8 approach
 * radius, in ascending index order so links are built exactly as before. */
function nearbyNodes(g: Graph, p: Point) {
  const out: number[] = [],
    x1 = Math.floor(p.x - 1.8),
    x2 = Math.floor(p.x + 1.8),
    y1 = Math.floor(p.y - 1.8),
    y2 = Math.floor(p.y + 1.8);
  for (let y = y1; y <= y2; y++)
    for (let x = x1; x <= x2; x++) {
      const list = g.buckets.get(y * g.cols + x);
      if (list) for (const i of list) out.push(i);
    }
  return out.sort((a, b) => a - b);
}
/** Routes from one start to many ends, over one shared graph and a single
 * Dijkstra. Each entry is the route survivorPath would return for that end. */
export function survivorPaths(
  f: Floor,
  start: Point,
  ends: Point[],
): NavStep[][] {
  f = survivorFloor(f, start);
  const out: NavStep[][] = ends.map(() => []);
  if (solid(f, start, 0.22, undefined, true)) return out;
  const pending: number[] = [];
  for (let k = 0; k < ends.length; k++) {
    const end = ends[k];
    if (solid(f, end, 0.22, undefined, true)) {
      out[k] = doorRoute(f, start, end);
      continue;
    }
    // The direct sight line is both cheapest and exactly what survivorPath
    // returns for a clear end, so it never enters the graph at all.
    if (walkSegment(f, start, end)) {
      out[k] = [{ ...end }];
      continue;
    }
    pending.push(k);
  }
  if (!pending.length) return out;
  const g = graph(f),
    from = g.points.length,
    points: Point[] = [...g.points, start];
  const starts: Edge[] = [];
  for (const i of nearbyNodes(g, start))
    if (distance(start, points[i]) < 1.8 && walkSegment(f, start, points[i]))
      starts.push({ to: i, cost: distance(start, points[i]) });
  // Every end's approach links, grouped by the graph node they leave from.
  const linkAt = new Map<number, { k: number; cost: number }[]>();
  pending.forEach((k, i) => {
    const end = ends[k];
    for (const n of nearbyNodes(g, end)) {
      if (distance(end, points[n]) >= 1.8 || !walkSegment(f, end, points[n]))
        continue;
      const link = { k: i, cost: distance(end, points[n]) },
        list = linkAt.get(n);
      if (list) list.push(link);
      else linkAt.set(n, [link]);
    }
  });
  // One Dijkstra over the shared graph. Node costs never depend on which ends
  // are asked for, so a single search prices all of them; only the approach
  // links differ, and those are read off the finished cost field.
  const costs = new Float64Array(points.length).fill(Infinity),
    previous = new Int32Array(points.length).fill(-1),
    via: (Edge | undefined)[] = [],
    closed = new Uint8Array(points.length),
    best = new Float64Array(pending.length).fill(Infinity),
    bestNode = new Int32Array(pending.length).fill(-1);
  costs[from] = 0;
  const heap = new MinHeap();
  heap.push(from, 0);
  let open = pending.length,
    worst = Infinity;
  while (heap.length) {
    const [node, cost] = heap.pop();
    // Once every end has a route, nodes this far away cannot improve one.
    if (!open && cost >= worst) break;
    if (closed[node]) continue;
    closed[node] = 1;
    const links = linkAt.get(node);
    if (links)
      for (const link of links) {
        const total = cost + link.cost;
        if (total >= best[link.k]) continue;
        best[link.k] = total;
        bestNode[link.k] = node;
        open = 0;
        worst = 0;
        for (const value of best)
          if (Number.isFinite(value)) worst = Math.max(worst, value);
          else open++;
      }
    const outward = node === from ? starts : g.edges[node];
    for (const e of outward)
      if (!closed[e.to] && cost + e.cost < costs[e.to]) {
        costs[e.to] = cost + e.cost;
        previous[e.to] = node;
        via[e.to] = e;
        heap.push(e.to, costs[e.to]);
      }
  }
  // The tree depends only on the graph and the start, never on which ends were
  // asked for, so every end gets the route a lone search would give it.
  pending.forEach((k, i) => {
    if (bestNode[i] < 0) return;
    const route: NavStep[] = [];
    for (let n = bestNode[i]; n !== from; n = previous[n]) {
      if (n < 0 || route.length > points.length) return;
      const edge = via[n];
      route.push(
        edge?.action
          ? { ...points[n], action: edge.action, obstacle: edge.obstacle }
          : { ...points[n] },
      );
    }
    // The approach link into the end is a plain step, as in a lone search.
    out[k] = [...route.reverse(), { ...ends[k] }];
  });
  return out;
}
export function survivorPath(f: Floor, start: Point, end: Point): NavStep[] {
  return survivorPaths(f, start, [end])[0];
}
/** Raw route graph for tests: points in build order and every edge. */
export function routeGraphSnapshot(f: Floor) {
  const g = graph(f);
  return {
    points: g.points.map((p) => ({ ...p })),
    edges: g.edges.map((list) => list.map((e) => ({ ...e }))),
  };
}
/** Test hook: the graph as built, optionally after dropping every cache. */
export function __graphForTest(f: Floor, options?: { fresh?: boolean }) {
  if (options?.fresh) {
    cache.delete(f);
    states.delete(f);
    broadCache.delete(f);
  }
  return routeGraphSnapshot(f);
}
