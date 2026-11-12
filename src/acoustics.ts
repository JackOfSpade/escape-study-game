import { doorFrame } from "./doors";
import { cityWall } from "./city-layout";
import { worldPoint } from "./furniture-geometry";
import { type Floor, type Point } from "./model";
import { floorCols, floorRows } from "./site";
import { inFurniture } from "./spatial";

// Walking grids miss gaps narrower than a character or a grid cell. Sweep the
// actual obstacle polygons into free-space components instead. Every vertex and
// edge intersection splits a slab, so even a narrow diagonal gap remains open.
const EPS = 1e-8;
type Interval = [number, number];
interface Polygon {
  points: Point[];
  min: number;
  max: number;
}
interface Slab {
  left: number;
  right: number;
  ids: number[];
}
interface Space {
  signature: string;
  slabs: Slab[];
  roots: number[];
  polys: Polygon[];
}
const spaces = new WeakMap<Floor, Space>();
const planIds = new WeakMap<object, number>();
let nextPlanId = 1;
function planId(plan: object) {
  let id = planIds.get(plan);
  if (id === undefined) {
    id = nextPlanId++;
    planIds.set(plan, id);
  }
  return id;
}
function polygons(f: Floor): Polygon[] {
  const boxes: {
    x: number;
    y: number;
    w: number;
    h: number;
    angle?: number;
  }[] = [];
  const cols = floorCols(f),
    rows = floorRows(f);
  // Walkable outdoor ground is free space even where the raster kept a legacy
  // wall bit; inside an authored shell the tiles still decide.
  const freeCell = (x: number, y: number) =>
    f.tiles[y]?.[x] === 0 || cityWall(f, x + 0.5, y + 0.5) === false;
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols;) {
      if (freeCell(x, y)) {
        x++;
        continue;
      }
      const start = x++;
      while (x < cols && !freeCell(x, y)) x++;
      boxes.push({ x: (start + x) / 2, y: y + 0.5, w: x - start, h: 1 });
    }
  for (const o of f.furniture) {
    if (!inFurniture(o, o)) continue;
    // A latched leaf seals its jamb; an unlatched/swinging leaf uses its real
    // rotated footprint. Releasing E alone therefore does not invent a gap.
    boxes.push(o.door?.latched ? { ...doorFrame(o), angle: 0 } : o);
  }
  return boxes.map((b) => {
    const points = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([x, y]) => worldPoint({ x: (x * b.w) / 2, y: (y * b.h) / 2 }, b));
    return {
      points,
      min: Math.min(...points.map((p) => p.x)),
      max: Math.max(...points.map((p) => p.x)),
    };
  });
}
function freeAt(polys: Polygon[], x: number, rows: number): Interval[] {
  const blocked: Interval[] = [];
  for (const p of polys) {
    if (x < p.min - EPS || x > p.max + EPS) continue;
    const ys: number[] = [];
    for (let i = 0; i < 4; i++) {
      const a = p.points[i],
        b = p.points[(i + 1) % 4];
      if (x < Math.min(a.x, b.x) - EPS || x > Math.max(a.x, b.x) + EPS)
        continue;
      if (Math.abs(b.x - a.x) < EPS) {
        ys.push(a.y, b.y);
        continue;
      }
      ys.push(a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x));
    }
    if (ys.length)
      blocked.push([
        Math.max(0, Math.min(...ys)),
        Math.min(rows, Math.max(...ys)),
      ]);
  }
  blocked.sort((a, b) => a[0] - b[0]);
  const free: Interval[] = [];
  let top = 0;
  for (const [a, b] of blocked) {
    if (a > top + EPS) free.push([top, a]);
    top = Math.max(top, b);
  }
  if (top < rows - EPS) free.push([top, rows]);
  return free;
}
function build(f: Floor, signature: string): Space {
  const polys = polygons(f),
    cols = floorCols(f),
    rows = floorRows(f),
    xs = new Set([0, cols]);
  const edges = polys.flatMap((p) =>
    p.points.map((a, i) => ({ a, b: p.points[(i + 1) % 4] })),
  );
  for (const p of polys)
    for (const v of p.points) if (v.x > 0 && v.x < cols) xs.add(v.x);
  // Axis-aligned intersections already have a vertex x-coordinate. Only
  // diagonals introduce additional critical coordinates.
  for (let i = 0; i < edges.length; i++) {
    const { a, b } = edges[i],
      dx = b.x - a.x,
      dy = b.y - a.y;
    if (Math.abs(dx) < EPS || Math.abs(dy) < EPS) continue;
    for (let j = 0; j < edges.length; j++) {
      if (i === j) continue;
      const { a: c, b: d } = edges[j],
        ex = d.x - c.x,
        ey = d.y - c.y,
        cross = dx * ey - dy * ex;
      if (Math.abs(cross) < EPS) continue;
      const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / cross,
        u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / cross;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
        const x = a.x + t * dx;
        if (x > 0 && x < cols) xs.add(x);
      }
    }
  }
  const split = [...xs]
      .sort((a, b) => a - b)
      .filter((x, i, all) => !i || x - all[i - 1] > EPS),
    roots: number[] = [],
    slabs: Slab[] = [];
  const root = (id: number): number =>
    roots[id] === id ? id : (roots[id] = root(roots[id]));
  for (let i = 1; i < split.length; i++) {
    const left = split[i - 1],
      right = split[i],
      free = freeAt(polys, (left + right) / 2, rows),
      ids = free.map(() => {
        const id = roots.length;
        roots.push(id);
        return id;
      });
    slabs.push({ left, right, ids });
    if (slabs.length < 2) continue;
    const prev = slabs[slabs.length - 2],
      near = Math.min(
        1e-7,
        (right - left) * 0.001,
        (prev.right - prev.left) * 0.001,
      ),
      before = freeAt(polys, left - near, rows),
      after = freeAt(polys, left + near, rows),
      boundary = freeAt(polys, left, rows);
    for (let a = 0; a < before.length; a++)
      for (let b = 0; b < after.length; b++) {
        if (prev.ids[a] === undefined || ids[b] === undefined) continue;
        if (
          boundary.some(
            ([lo, hi]) =>
              Math.min(before[a][1], after[b][1], hi) -
                Math.max(before[a][0], after[b][0], lo) >
              EPS,
          )
        )
          roots[root(ids[b])] = root(prev.ids[a]);
      }
  }
  return { signature, slabs, roots: roots.map((_, i) => root(i)), polys };
}
// Snapshot topology once per audio mix, rather than serializing the entire
// floor again for every zombie/impact. The returned query is batch-local.
export function soundConnectivity(f: Floor) {
  const signature =
    f.tiles.map((r) => r.join(",")).join(";") +
    "/" +
    f.furniture
      .map(
        (o) =>
          `${o.id}/${o.x}/${o.y}/${o.w}/${o.h}/${o.angle ?? 0}/${o.open}/${o.destroyed}/${o.turning < 0}/${o.door?.latched}`,
      )
      .join(";") +
    // A replaced outdoor plan changes free space without touching the raster.
    "/city:" +
    (f.city ? `${f.index}/${planId(f.city)}` : "-");
  let space = spaces.get(f);
  if (!space || space.signature !== signature) {
    space = build(f, signature);
    spaces.set(f, space);
  }
  const positions = new Map<string, number[]>(),
    rows = floorRows(f);
  const components = (p: Point) => {
    const key = `${p.x}/${p.y}`;
    const cached = positions.get(key);
    if (cached) return cached;
    const ids: number[] = [];
    for (const s of space.slabs) {
      if (p.x < s.left - EPS || p.x > s.right + EPS) continue;
      const actual = freeAt(space.polys, p.x, rows);
      if (!actual.some(([lo, hi]) => p.y > lo + EPS && p.y < hi - EPS))
        continue;
      const near = Math.min(1e-7, (s.right - s.left) * 0.001),
        x = Math.max(s.left + near, Math.min(s.right - near, p.x)),
        free = freeAt(space.polys, x, rows);
      for (let i = 0; i < free.length; i++)
        if (
          p.y > free[i][0] + EPS &&
          p.y < free[i][1] - EPS &&
          s.ids[i] !== undefined
        )
          ids.push(space.roots[s.ids[i]]);
    }
    positions.set(key, ids);
    return ids;
  };
  return (a: Point, b: Point) => {
    const from = components(a),
      to = components(b);
    return from.some((id) => to.includes(id));
  };
}
export function soundConnected(f: Floor, a: Point, b: Point) {
  return soundConnectivity(f)(a, b);
}
