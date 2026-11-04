import { survivorFloor } from "./force-fields";
import { doorFrame } from "./doors";
import { boxBounds, worldPoint } from "./furniture-geometry";
import { H, W, distance, type Floor, type Point } from "./model";
import {
  inFurniture,
  inStation,
  solid,
  stationBody,
  stationSignature,
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
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (tiles[y * W + x] !== (f.tiles[y]?.[x] ?? 1)) return false;
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
  const tiles = new Float64Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) tiles[y * W + x] = f.tiles[y]?.[x] ?? 1;
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
interface Graph {
  city?: Floor["city"];
  signature: Snapshot;
  stations: string;
  points: Point[];
  edges: Edge[][];
}
const cache = new WeakMap<Floor, Graph>();
// Furniture moves invalidate routes, but not the fixed grid's wall clearance.
const wallEdgeCache = new WeakMap<
  Floor,
  { tiles: Float64Array; city?: Floor["city"]; edges: Map<string, boolean> }
>();
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
    return segment(f, out, b, ignore, wallEdges);
  }
  if (d < 1e-9) return true;
  const dx = (b.x - a.x) / d,
    dy = (b.y - a.y) / d;
  const minX = Math.min(a.x, b.x) - pad,
    maxX = Math.max(a.x, b.x) + pad;
  const minY = Math.min(a.y, b.y) - pad,
    maxY = Math.max(a.y, b.y) + pad;
  const edgeKey = wallEdges ? `${a.x}/${a.y}/${b.x}/${b.y}` : "";
  let clear = wallEdges?.get(edgeKey);
  if (clear === undefined) {
    clear = wallClearance(f, a, d, dx, dy, minX, maxX, minY, maxY, pad);
    wallEdges?.set(edgeKey, clear);
  }
  if (!clear) return false;
  for (const o of f.furniture) {
    const reach = (o.w + o.h) / 2;
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
  for (const s of solidDesks(f)) {
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
  for (
    let y = Math.max(-1, Math.floor(minY));
    y <= Math.min(H, Math.floor(maxY));
    y++
  )
    for (
      let x = Math.max(-1, Math.floor(minX));
      x <= Math.min(W, Math.floor(maxX));
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

function graph(f: Floor): Graph {
  const saved = cache.get(f);
  if (
    saved &&
    saved.city === f.city &&
    saved.stations === stationSignature(f) &&
    tilesMatch(saved.signature.tiles, f) &&
    furnitureMatches(saved.signature, f)
  )
    return saved;
  // Wall clearance only depends on tiles, so a furniture move keeps this map.
  let wallEdges = wallEdgeCache.get(f);
  let tiles: Float64Array;
  if (wallEdges && wallEdges.city === f.city && tilesMatch(wallEdges.tiles, f))
    tiles = wallEdges.tiles;
  else {
    tiles = snapshotTiles(f);
    wallEdges = { tiles, city: f.city, edges: new Map() };
    wallEdgeCache.set(f, wallEdges);
  }
  const signature = snapshotFurniture(f, tiles);
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
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const p = { x: x + 0.5, y: y + 0.5 };
      if (
        !solid(f, p, 0.22, undefined, true) &&
        !solidDesks(f).some((s) => inStation(s, p, 0.22))
      )
        grid.set(y * W + x, add(p));
    }
  for (const [key, index] of grid)
    for (const neighbor of [key + 1, key + W]) {
      const other = grid.get(neighbor);
      if (
        other !== undefined &&
        distance(points[index], points[other]) < 1.01 &&
        segment(f, points[index], points[other], undefined, wallEdges.edges)
      )
        link(index, other);
    }
  const nearbyGrid = (index: number, ignore?: string) => {
    const p = points[index];
    for (let y = Math.floor(p.y) - 2; y <= Math.floor(p.y) + 2; y++)
      for (let x = Math.floor(p.x) - 2; x <= Math.floor(p.x) + 2; x++) {
        const other = grid.get(y * W + x);
        if (
          other !== undefined &&
          distance(p, points[other]) < 1.8 &&
          walkSegment(f, p, points[other], ignore)
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
            walkSegment(f, points[nodes[i]], points[nodes[j]])
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
      if (walkSegment(f, a, b, o.id)) {
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
          !walkSegment(f, a, b, o.id) ||
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
  const result = {
    signature,
    city: f.city,
    stations: stationSignature(f),
    points,
    edges,
  };
  cache.set(f, result);
  return result;
}
export function survivorPath(f: Floor, start: Point, end: Point): NavStep[] {
  f = survivorFloor(f, start);
  if (solid(f, start, 0.22, undefined, true)) return [];
  if (solid(f, end, 0.22, undefined, true)) {
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
      .map((p) => ({ p, route: survivorPath(f, start, p) }))
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
  if (walkSegment(f, start, end)) return [{ ...end }];
  const g = graph(f),
    points = [...g.points, start, end],
    from = points.length - 2,
    to = points.length - 1;
  const starts: Edge[] = [],
    ends = new Map<number, number>();
  for (let i = 0; i < g.points.length; i++) {
    if (distance(start, points[i]) < 1.8 && walkSegment(f, start, points[i]))
      starts.push({ to: i, cost: distance(start, points[i]) });
    if (distance(end, points[i]) < 1.8 && walkSegment(f, end, points[i]))
      ends.set(i, distance(end, points[i]));
  }
  const costs = new Float64Array(points.length).fill(Infinity),
    previous = new Int32Array(points.length).fill(-1),
    via: (Edge | undefined)[] = [],
    closed = new Uint8Array(points.length);
  costs[from] = 0;
  const heap = new MinHeap();
  heap.push(from, 0);
  while (heap.length) {
    const [node, cost] = heap.pop();
    if (closed[node]) continue;
    closed[node] = 1;
    if (node === to) break;
    const outgoing =
      node === from
        ? starts
        : [
            ...g.edges[node],
            ...(ends.has(node) ? [{ to, cost: ends.get(node)! }] : []),
          ];
    for (const e of outgoing)
      if (!closed[e.to] && cost + e.cost < costs[e.to]) {
        costs[e.to] = cost + e.cost;
        previous[e.to] = node;
        via[e.to] = e;
        heap.push(e.to, costs[e.to]);
      }
  }
  if (previous[to] < 0) return [];
  const result: NavStep[] = [];
  for (let i = to; i !== from; i = previous[i]) {
    if (i < 0) return [];
    const edge = via[i];
    result.push(
      edge?.action
        ? { ...points[i], action: edge.action, obstacle: edge.obstacle }
        : { ...points[i] },
    );
  }
  return result.reverse();
}
