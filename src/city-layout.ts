import type { BuildingFootprint, Floor, Game, Point } from "./model";
import { sitesOf } from "./site";
import { STAIR_ROUTE_WIDTH } from "./stair-route";
import type { RunDesign } from "./run-design-contract.mjs";
import {
  outdoorSolids,
  regionRectangles,
  subtractRectangle,
  isWalkableKind,
  type OutdoorPlan,
  type OutdoorSite,
  type OutdoorSolidKind,
} from "./outdoor-plan.mjs";

export interface CityRectangle extends Point {
  w: number;
  h: number;
}
export interface CityObstacle extends CityRectangle {
  kind: "building" | "rubble" | "vehicle" | "stair-base" | OutdoorSolidKind;
  height: number;
  color: string;
  damaged: boolean;
  /** False for water, fences and low walls: they stop bodies, not sight.
   * Absent means opaque, as every generated city obstacle is. */
  opaque?: boolean;
  /** For an authored outdoor plan: the index of the region it came from. */
  region?: number;
}
export interface CityApproach {
  id: string;
  /** Spawn towards the physical exterior contact face of the main door. */
  points: Point[];
  length: number;
}
export interface CityPlan {
  version: 1;
  seed: number;
  bounds: { left: number; right: number; top: number; bottom: number };
  roads: CityRectangle[];
  obstacles: CityObstacle[];
  approaches: CityApproach[];
  /** Set when the plan was compiled from a design's `setting.outdoors`. */
  source?: "authored";
  /** Authored paths and plazas, for drawing only: walking is decided by
   * `roads` (the whole bounds) minus `obstacles`. */
  paths?: (CityRectangle & { region: number })[];
}

function randomStream(seed: number) {
  let state = (seed ^ 0x63697479) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
export function inCityRectangle(r: CityRectangle, x: number, y: number) {
  return (
    x >= r.x - r.w / 2 &&
    x <= r.x + r.w / 2 &&
    y >= r.y - r.h / 2 &&
    y <= r.y + r.h / 2
  );
}

/** The office and its one-cell masonry ring keep their authored grid. */
function insideShell(b: BuildingFootprint, x: number, y: number) {
  for (let yy = Math.floor(y) - 1; yy <= Math.floor(y) + 1; yy++) {
    const row = b.rows[yy];
    if (
      row &&
      yy >= b.top &&
      yy < b.bottom &&
      y >= b.top - 1 &&
      y < b.bottom + 1 &&
      x >= row.left - 1 &&
      x < row.right + 1
    )
      return true;
  }
  return false;
}

function authoredBuilding(floor: Floor, x: number, y: number) {
  const b = floor.boundary;
  if (b && insideShell(b, x, y)) return true;
  // Stamped sites own their own shell and one-cell ring, so their raster
  // decides walls exactly like the start building's.
  for (const shell of floor.shells ?? [])
    if (shell.boundary && insideShell(shell.boundary, x, y)) return true;
  if (!b) return true;
  // The north stair well is authored beyond the main shell.
  return x >= 20 && x < 24 && y >= b.top - 2 && y < b.top && floor.index === 0;
}

/** A real, persisted neighbourhood. Its only open corridors are roads and
 * courtyards; the complementary space is occupied by visible solid buildings.
 * Road ends turn behind a block before meeting a collapsed street cap. */
export function createCityPlan(
  floor: Floor,
  seed: number,
  runway: number,
  design?: RunDesign["city"],
): CityPlan {
  const b = floor.boundary;
  if (!b) throw Error("A physical city needs a building footprint");
  const random = randomStream(seed),
    door = floor.furniture.find((o) => o.id === "main-gate"),
    entrance = {
      x: door?.x ?? 22,
      y: (door?.y ?? b.bottom + 0.5) + (door?.h ?? 1) / 2 + 0.42,
    },
    length = Math.max(24, runway) + 24,
    boulevard =
      b.bottom + (design?.boulevardOffset ?? 15 + Math.floor(random() * 5)),
    tail = boulevard - entrance.y,
    west = entrance.x - (length - tail),
    east = entrance.x + (length - tail),
    south = entrance.y + length,
    width = design?.roadWidth ?? 7 + Math.floor(random() * 3),
    roads: CityRectangle[] = [],
    approaches: CityApproach[] = [],
    rows = b.rows.slice(b.top, b.bottom),
    left = Math.min(...rows.map((r) => r.left)),
    right = Math.max(...rows.map((r) => r.right));
  const rect = (x: number, y: number, w: number, h: number) =>
    roads.push({ x, y, w, h });
  const segment = (a: Point, c: Point, laneWidth = width) =>
    rect(
      (a.x + c.x) / 2,
      (a.y + c.y) / 2,
      Math.abs(c.x - a.x) + laneWidth,
      Math.abs(c.y - a.y) + laneWidth,
    );
  const approach = (id: string, points: Point[]) => {
    let distance = 0;
    for (let i = 1; i < points.length; i++) {
      distance += Math.hypot(
        points[i].x - points[i - 1].x,
        points[i].y - points[i - 1].y,
      );
      segment(points[i - 1], points[i]);
    }
    approaches.push({ id, points, length: distance });
  };
  // Footways and service courts surround the real office, instead of a tiny
  // railed strip that ends at the old 44x34 simulation rectangle.
  rect((left + right) / 2, b.top - 5, right - left + 20, 10);
  rect(left - 5, (b.top + b.bottom) / 2, 10, b.bottom - b.top + 20);
  rect(right + 5, (b.top + b.bottom) / 2, 10, b.bottom - b.top + 20);
  rect(
    (left + right) / 2,
    (b.bottom + boulevard) / 2,
    right - left + 20,
    boulevard - b.bottom + width,
  );
  // Seeded loading courts are real dead ends off the footway, with solid
  // warehouse backs. They add useful outside places without an unguarded exit.
  rect(left - 12, b.top + 7 + Math.floor(random() * 5), 16, 5);
  rect(right + 12, b.top + 10 + Math.floor(random() * 5), 16, 5);
  approach("south", [
    { x: entrance.x + 12, y: south },
    { x: entrance.x, y: south },
    entrance,
  ]);
  approach("west", [
    { x: west, y: boulevard + 12 },
    { x: west, y: boulevard },
    { x: entrance.x, y: boulevard },
    entrance,
  ]);
  approach("east", [
    { x: east, y: boulevard + 12 },
    { x: east, y: boulevard },
    { x: entrance.x, y: boulevard },
    entrance,
  ]);
  const bounds = {
      left: Math.min(west - width / 2 - 18, left - 28),
      right: Math.max(east + width / 2 + 18, right + 28),
      top: b.top - 28,
      bottom: south + width / 2 + 18,
    },
    xs = new Set([bounds.left, bounds.right]),
    ys = new Set([bounds.top, bounds.bottom]),
    caps: CityObstacle[] = [
      {
        x: right + 3,
        y: Math.min(b.top, floor.stairs.y) - 2 + 3.6,
        w: STAIR_ROUTE_WIDTH + 0.12,
        h: 7.2,
        kind: "stair-base",
        height: 3.6,
        color: "#87988e",
        damaged: false,
      },
      {
        x: left - 4,
        y: b.bottom + 7,
        w: 1.85,
        h: 4.3,
        kind: "vehicle",
        height: 1.55,
        color: "#5c6c70",
        damaged: false,
      },
      {
        x: right + 4,
        y: b.bottom + 10,
        w: 1.9,
        h: 4.5,
        kind: "vehicle",
        height: 1.6,
        color: "#69524a",
        damaged: true,
      },
      {
        x: entrance.x + 12 + width / 2 + 4,
        y: south,
        w: 8,
        h: width + 2,
        kind: "vehicle",
        height: 3.1,
        color: "#54534b",
        damaged: true,
      },
      ...[west, east].map((x) => ({
        x,
        y: boulevard + 12 + width / 2 + 4,
        w: width + 2,
        h: 8,
        kind: "rubble" as const,
        height: 3.4,
        color: "#5c5750",
        damaged: true,
      })),
    ];
  for (const r of roads) {
    xs.add(r.x - r.w / 2);
    xs.add(r.x + r.w / 2);
    ys.add(r.y - r.h / 2);
    ys.add(r.y + r.h / 2);
  }
  for (const r of caps) {
    xs.add(r.x - r.w / 2);
    xs.add(r.x + r.w / 2);
    ys.add(r.y - r.h / 2);
    ys.add(r.y + r.h / 2);
  }
  // Split only the nearby skyline into smaller addresses. Distant blocks stay
  // large silhouettes so longer grace periods do not grow geometry unboundedly.
  const district = design?.districtSize ?? 18 + Math.floor(random() * 8);
  for (let x = entrance.x - 72; x <= entrance.x + 72; x += district) xs.add(x);
  for (let y = b.top - 1; y <= b.bottom + 1; y++) {
    ys.add(y);
    const row = b.rows[Math.max(b.top, Math.min(b.bottom - 1, y))];
    xs.add(row.left - 1);
    xs.add(row.right + 1);
  }
  ys.add(b.top - 2);
  xs.add(20);
  xs.add(24);
  for (
    let y = boulevard + 20;
    y < Math.min(south, boulevard + 80);
    y += district
  )
    ys.add(y);
  const xx = [...xs].sort((a, c) => a - c),
    yy = [...ys].sort((a, c) => a - c),
    raw: CityRectangle[] = [];
  for (let j = 0; j < yy.length - 1; j++) {
    let run: CityRectangle | undefined;
    for (let i = 0; i < xx.length - 1; i++) {
      const x = (xx[i] + xx[i + 1]) / 2,
        y = (yy[j] + yy[j + 1]) / 2,
        blocked =
          !authoredBuilding(floor, x, y) &&
          !roads.some((r) => inCityRectangle(r, x, y)) &&
          !caps.some((r) => inCityRectangle(r, x, y));
      if (blocked) {
        if (run) {
          run.w = xx[i + 1] - (run.x - run.w / 2);
          run.x = xx[i + 1] - run.w / 2;
        } else run = { x, y, w: xx[i + 1] - xx[i], h: yy[j + 1] - yy[j] };
      } else if (run) {
        raw.push(run);
        run = undefined;
      }
    }
    if (run) raw.push(run);
  }
  // Merge identical vertical runs before assigning distinct physical addresses.
  const merged: CityRectangle[] = [];
  for (const r of raw) {
    const previous = merged.find(
      (c) =>
        Math.abs(c.x - r.x) < 1e-8 &&
        Math.abs(c.w - r.w) < 1e-8 &&
        Math.abs(c.y + c.h / 2 - (r.y - r.h / 2)) < 1e-8,
    );
    if (previous) {
      const top = previous.y - previous.h / 2;
      previous.h = r.y + r.h / 2 - top;
      previous.y = top + previous.h / 2;
    } else merged.push({ ...r });
  }
  const palette = design?.palette ?? [
      "#56616a",
      "#695f56",
      "#57685e",
      "#62666b",
      "#64565a",
    ],
    obstacles: CityObstacle[] = [
      ...caps,
      ...merged.map((r, i) => ({
        ...r,
        kind: r.w < 3 || r.h < 3 ? ("rubble" as const) : ("building" as const),
        height:
          r.w < 3 || r.h < 3
            ? 2.3 + random() * 1.2
            : design
              ? design.buildingHeightMin +
                random() * (design.buildingHeightMax - design.buildingHeightMin)
              : 9 + Math.floor(random() * 11) * 3.15,
        color:
          palette[(Math.floor(random() * palette.length) + i) % palette.length],
        damaged: random() < (design?.damageRate ?? 0.35),
      })),
    ];
  return { version: 1, seed, bounds, roads, obstacles, approaches };
}

/** The start site as an outdoor plan sees it: the building's extent, the
 * door's outside face, and the ground the stairs and service routes need. */
export function outdoorSite(floor: Floor): OutdoorSite {
  const b = floor.boundary;
  if (!b) throw Error("An outdoor plan needs a building footprint");
  const rows = b.rows.slice(b.top, b.bottom),
    left = Math.min(...rows.map((r) => r.left)),
    right = Math.max(...rows.map((r) => r.right)),
    door = floor.furniture.find((o) => o.id === "main-gate");
  return {
    building: { left, right, top: b.top, bottom: b.bottom },
    entrance: {
      x: door?.x ?? 22,
      y: (door?.y ?? b.bottom + 0.5) + (door?.h ?? 1) / 2 + 0.42,
    },
    keepClear: [
      // The exterior fire stair and its landing run up the east face.
      {
        x: right + 5,
        y: (b.top + b.bottom) / 2,
        w: 10,
        h: b.bottom - b.top + 4,
      },
      // The north stair well is authored just beyond the main shell.
      { x: 22, y: b.top - 2, w: 8, h: 4 },
    ],
  };
}

/** The exterior stair base every start building stands beside. */
function stairBase(floor: Floor, right: number): CityObstacle {
  const b = floor.boundary!;
  return {
    x: right + 3,
    y: Math.min(b.top, floor.stairs.y) - 2 + 3.6,
    w: STAIR_ROUTE_WIDTH + 0.12,
    h: 7.2,
    kind: "stair-base",
    height: 3.6,
    color: "#87988e",
    damaged: false,
  };
}

/** A design's drawn outdoors as the rectangle plan every system reads. The
 * whole bounds is walkable road; solids (after walkable regions carve them)
 * are the obstacles; paths and plazas are kept separately for drawing. */
export function compileOutdoorPlan(
  floor: Floor,
  plan: OutdoorPlan,
  seed: number,
): CityPlan {
  const site = outdoorSite(floor),
    b = plan.bounds;
  return {
    version: 1,
    seed,
    source: "authored",
    bounds: { ...b },
    roads: [
      {
        x: (b.left + b.right) / 2,
        y: (b.top + b.bottom) / 2,
        w: b.right - b.left,
        h: b.bottom - b.top,
      },
    ],
    obstacles: [
      stairBase(floor, site.building.right),
      ...outdoorSolids(plan).map((s) => ({
        x: s.x,
        y: s.y,
        w: s.w,
        h: s.h,
        kind: s.kind,
        height: s.height,
        color: s.color,
        damaged: false,
        opaque: s.opaque,
        region: s.region,
      })),
    ],
    approaches: [],
    paths: plan.regions.flatMap((r, region) =>
      isWalkableKind(r.kind)
        ? regionRectangles(r).map((rect) => ({ ...rect, region }))
        : [],
    ),
  };
}

const INDEX_CELL = 16;
interface ObstacleIndex {
  left: number;
  top: number;
  cols: number;
  rows: number;
  cells: number[][];
}
const indexes = new WeakMap<CityPlan, ObstacleIndex>();
/** A uniform bucket grid over a plan's obstacles, built once per plan. Plans
 * are replaced, never edited in place, so the cache stays exact. */
function obstacleIndex(plan: CityPlan): ObstacleIndex {
  let index = indexes.get(plan);
  if (index) return index;
  const b = plan.bounds,
    cols = Math.max(1, Math.ceil((b.right - b.left) / INDEX_CELL)),
    rows = Math.max(1, Math.ceil((b.bottom - b.top) / INDEX_CELL)),
    cells: number[][] = Array.from({ length: cols * rows }, () => []);
  index = { left: b.left, top: b.top, cols, rows, cells };
  plan.obstacles.forEach((o, n) => {
    const [x0, x1, y0, y1] = cellRange(
      index!,
      o.x - o.w / 2,
      o.x + o.w / 2,
      o.y - o.h / 2,
      o.y + o.h / 2,
    );
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) cells[y * cols + x].push(n);
  });
  indexes.set(plan, index);
  return index;
}
function cellRange(
  index: ObstacleIndex,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
) {
  const clamp = (n: number, hi: number) => Math.max(0, Math.min(hi, n));
  return [
    clamp(Math.floor((minX - index.left) / INDEX_CELL), index.cols - 1),
    clamp(Math.floor((maxX - index.left) / INDEX_CELL), index.cols - 1),
    clamp(Math.floor((minY - index.top) / INDEX_CELL), index.rows - 1),
    clamp(Math.floor((maxY - index.top) / INDEX_CELL), index.rows - 1),
  ];
}
/** Obstacles whose box may touch the given rectangle, in plan order. Small
 * generated cities are scanned directly; authored plans use the index. */
export function cityObstaclesNear(
  plan: CityPlan,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
): readonly CityObstacle[] {
  if (plan.obstacles.length <= 48) return plan.obstacles;
  const index = obstacleIndex(plan),
    [x0, x1, y0, y1] = cellRange(index, minX, maxX, minY, maxY),
    seen = new Set<number>();
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++)
      for (const n of index.cells[y * index.cols + x]) seen.add(n);
  return [...seen].sort((a, c) => a - c).map((n) => plan.obstacles[n]);
}

/** Undefined means the existing office/stair geometry owns this position. */
export function cityWall(
  floor: Floor,
  x: number,
  y: number,
): boolean | undefined {
  if (!floor.city || floor.index !== 0 || authoredBuilding(floor, x, y))
    return undefined;
  return (
    !floor.city.roads.some((r) => inCityRectangle(r, x, y)) ||
    cityObstaclesNear(floor.city, x, x, y, y).some((o) =>
      inCityRectangle(o, x, y),
    )
  );
}

export function cityCollisionBoxes(plan: CityPlan): CityRectangle[] {
  const boxes = plan.obstacles.map(({ x, y, w, h }) => ({ x, y, w, h }));
  if (plan.source !== "authored") return boxes;
  // A generated city fills to its bounds with blocks; an authored plan is
  // open ground, so its edge gets real walls.
  const b = plan.bounds,
    w = b.right - b.left,
    h = b.bottom - b.top,
    t = 1;
  return [
    ...boxes,
    { x: b.left - t / 2, y: b.top + h / 2, w: t, h: h + 2 * t },
    { x: b.right + t / 2, y: b.top + h / 2, w: t, h: h + 2 * t },
    { x: b.left + w / 2, y: b.top - t / 2, w: w + 2 * t, h: t },
    { x: b.left + w / 2, y: b.bottom + t / 2, w: w + 2 * t, h: t },
  ];
}

/** Match the native body's circle against the exact visible city footprints;
 * callers still check the authored office grid whenever this returns false. */
export function citySolid(
  floor: Floor,
  p: Point,
  pad = 0.22,
): boolean | undefined {
  if (!floor.city || floor.index !== 0 || authoredBuilding(floor, p.x, p.y))
    return undefined;
  const radius = Math.max(0, pad);
  const b = floor.city.bounds;
  if (
    p.x - radius < b.left ||
    p.x + radius > b.right ||
    p.y - radius < b.top ||
    p.y + radius > b.bottom
  )
    return true;
  return cityObstaclesNear(
    floor.city,
    p.x - radius,
    p.x + radius,
    p.y - radius,
    p.y + radius,
  ).some((o) => {
    const dx = Math.max(0, Math.abs(p.x - o.x) - o.w / 2),
      dy = Math.max(0, Math.abs(p.y - o.y) - o.h / 2);
    return radius === 0
      ? inCityRectangle(o, p.x, p.y)
      : dx * dx + dy * dy < radius * radius;
  });
}

/** Exact slab intersections avoid half-cell city aliases in long sightlines. */
export function cityRayDistance(
  floor: Floor,
  p: Point,
  dx: number,
  dy: number,
  range: number,
) {
  if (!floor.city || floor.index !== 0) return range;
  let hit = range;
  const endX = p.x + dx * range,
    endY = p.y + dy * range,
    minX = Math.min(p.x, endX),
    maxX = Math.max(p.x, endX),
    minY = Math.min(p.y, endY),
    maxY = Math.max(p.y, endY);
  for (const o of cityObstaclesNear(floor.city, minX, maxX, minY, maxY)) {
    // Water, fences and low walls stop bodies, not eyes or ears.
    if (o.opaque === false) continue;
    if (
      o.x + o.w / 2 < minX ||
      o.x - o.w / 2 > maxX ||
      o.y + o.h / 2 < minY ||
      o.y - o.h / 2 > maxY
    )
      continue;
    let near = -Infinity,
      far = Infinity;
    for (const [origin, direction, lo, hi] of [
      [p.x, dx, o.x - o.w / 2, o.x + o.w / 2],
      [p.y, dy, o.y - o.h / 2, o.y + o.h / 2],
    ]) {
      if (Math.abs(direction) < 1e-10) {
        if (origin < lo || origin > hi) {
          far = -Infinity;
          break;
        }
      } else {
        const a = (lo - origin) / direction,
          b = (hi - origin) / direction;
        near = Math.max(near, Math.min(a, b));
        far = Math.min(far, Math.max(a, b));
      }
    }
    if (near <= far && far >= 0) hit = Math.min(hit, Math.max(0, near));
  }
  return hit;
}

interface Bounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function footprintBounds(b: BuildingFootprint | undefined): Bounds | undefined {
  if (!b) return undefined;
  let left = Infinity,
    right = -Infinity;
  for (let y = b.top; y < b.bottom; y++) {
    const row = b.rows[y];
    if (!row) continue;
    left = Math.min(left, row.left);
    right = Math.max(right, row.right);
  }
  return Number.isFinite(left) && Number.isFinite(right)
    ? { left, right, top: b.top, bottom: b.bottom }
    : undefined;
}

function union(a: Bounds | undefined, b: Bounds | undefined) {
  if (!a) return b;
  if (!b) return a;
  return {
    left: Math.min(a.left, b.left),
    right: Math.max(a.right, b.right),
    top: Math.min(a.top, b.top),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

/**
 * Open ground between sites: everything inside the union of every footprint
 * (plus the previous neighbourhood's bounds) is one walkable road rectangle.
 * Assigning this plan replaces the outdoor solids; floors of stamped sites
 * keep deciding their own cells because they are authored shells.
 */
export function terrainCityPlan(
  g: Pick<Game, "floors" | "sites" | "seed">,
): CityPlan {
  const old = g.floors.find((f) => f.index === 0)?.city;
  if (old?.source === "authored") return stampedOutdoorPlan(g, old);
  let area: Bounds | undefined = old ? { ...old.bounds } : undefined;
  for (const site of sitesOf(g))
    area = union(area, footprintBounds(site.boundary));
  const base = area ?? { left: 0, right: 0, top: 0, bottom: 0 },
    margin = 20,
    bounds: Bounds = {
      left: base.left - margin,
      right: base.right + margin,
      top: base.top - margin,
      bottom: base.bottom + margin,
    };
  return {
    version: 1,
    seed: old?.seed ?? g.seed,
    bounds,
    roads: [
      {
        x: (bounds.left + bounds.right) / 2,
        y: (bounds.top + bounds.bottom) / 2,
        w: bounds.right - bounds.left,
        h: bounds.bottom - bounds.top,
      },
    ],
    obstacles: [],
    approaches: [],
  };
}

/** Clear ground kept around every stamped site, and the band joining them. */
const SITE_CLEARANCE = 8;
/**
 * A drawn outdoors after more sites are stamped into it. The design's terrain
 * stays where it was; only each site's plot (plus a margin) and the band of
 * ground between neighbouring sites are cleared, and the bounds grow to hold
 * the new buildings. The start building's stair base is never carved.
 */
function stampedOutdoorPlan(
  g: Pick<Game, "floors" | "sites" | "seed">,
  old: CityPlan,
): CityPlan {
  const plots = sitesOf(g)
      .map((site) => footprintBounds(site.boundary))
      .filter((b): b is Bounds => !!b)
      .sort((a, b) => a.left - b.left),
    rect = (l: number, t: number, r: number, b: number) => ({
      x: (l + r) / 2,
      y: (t + b) / 2,
      w: r - l,
      h: b - t,
    }),
    m = SITE_CLEARANCE,
    start = footprintBounds(g.floors.find((f) => f.index === 0)?.boundary),
    isStart = (p: Bounds) =>
      !!start &&
      p.left === start.left &&
      p.right === start.right &&
      p.top === start.top &&
      p.bottom === start.bottom,
    // The start building's own surroundings were validated with the design;
    // only newly stamped plots need clearing.
    clear = plots
      .filter((p) => !isStart(p))
      .map((p) => rect(p.left - m, p.top - m, p.right + m, p.bottom + m));
  for (let i = 1; i < plots.length; i++) {
    const a = plots[i - 1],
      b = plots[i];
    clear.push(
      rect(
        a.right,
        Math.max(a.top, b.top),
        b.left,
        Math.min(a.bottom, b.bottom) + m,
      ),
    );
  }
  let bounds: Bounds = { ...old.bounds };
  for (const p of plots)
    bounds = union(bounds, {
      left: p.left - 20,
      right: p.right + 20,
      top: p.top - 20,
      bottom: p.bottom + 20,
    })!;
  const obstacles: CityObstacle[] = [];
  for (const o of old.obstacles) {
    if (o.kind === "stair-base") {
      obstacles.push(o);
      continue;
    }
    let pieces: CityRectangle[] = [o];
    for (const c of clear)
      if (c.w > 0 && c.h > 0)
        pieces = pieces.flatMap((piece) => subtractRectangle(piece, c));
    for (const piece of pieces)
      obstacles.push({ ...o, x: piece.x, y: piece.y, w: piece.w, h: piece.h });
  }
  return {
    ...old,
    bounds,
    roads: [rect(bounds.left, bounds.top, bounds.right, bounds.bottom)],
    obstacles,
  };
}
