import {
  inCityRectangle,
  type CityApproach,
  type CityPlan,
} from "./city-layout";
import { SWARM } from "./force-fields";
import {
  CONFIG,
  type Floor,
  type Game,
  type Point,
  type Zombie,
  distance,
} from "./model";
import { solid } from "./spatial";
import { spawnGrace, swarmPacing } from "./study-pacing";
import { playerCanSee } from "./visibility";

/** Saved route intent; positions are always the actual physics positions. */
export interface CityApproachState {
  route: string;
  waypoint: number;
  lane: number;
  /** Public-street detour after a chase; bounded, and retained in checkpoints. */
  recovery?: Point[];
  recoveryWaypoint?: number;
  recoveryRetryAt?: number;
}
interface CityApproachTarget {
  point: Point;
  speed: number;
  finalDoor: boolean;
}

const INITIAL_RANKS = 2;
const RANK_SPACING = 0.95;
const LOOKAHEAD = 2;
const paths = new WeakMap<CityPlan, Map<string, Point[]>>();
const MAX_ROAD_NODES = 96;
interface RoadGraph {
  points: Point[];
  edges: number[][];
}
const roadGraphs = new WeakMap<CityPlan, RoadGraph>();

function segmentHitsBox(
  a: Point,
  b: Point,
  left: number,
  right: number,
  top: number,
  bottom: number,
) {
  let near = 0,
    far = 1;
  for (const [origin, delta, lo, hi] of [
    [a.x, b.x - a.x, left, right],
    [a.y, b.y - a.y, top, bottom],
  ]) {
    if (Math.abs(delta) < 1e-10) {
      if (origin < lo || origin > hi) return false;
    } else {
      const start = (lo - origin) / delta,
        end = (hi - origin) / delta;
      near = Math.max(near, Math.min(start, end));
      far = Math.min(far, Math.max(start, end));
      if (near > far) return false;
    }
  }
  return near <= far;
}

/** Exterior navigation knows public streets and the office's outer masonry,
 * never private indoor rooms or the location of a hidden survivor. */
function publicRoadClear(floor: Floor, a: Point, b: Point) {
  const city = floor.city!,
    pad = 0.24;
  for (const point of [a, b])
    if (!city.roads.some((road) => inCityRectangle(road, point.x, point.y)))
      return false;
  for (const box of city.obstacles)
    if (
      segmentHitsBox(
        a,
        b,
        box.x - box.w / 2 - pad,
        box.x + box.w / 2 + pad,
        box.y - box.h / 2 - pad,
        box.y + box.h / 2 + pad,
      )
    )
      return false;
  const shell = floor.boundary;
  if (shell) {
    for (let y = shell.top; y < shell.bottom; y++) {
      const row = shell.rows[y];
      if (
        segmentHitsBox(
          a,
          b,
          row.left - 1 - pad,
          row.right + 1 + pad,
          y - 1 - pad,
          y + 2 + pad,
        )
      )
        return false;
    }
    if (
      segmentHitsBox(
        a,
        b,
        20 - pad,
        24 + pad,
        shell.top - 2 - pad,
        shell.top + pad,
      )
    )
      return false;
  }
  return true;
}

function roadGraph(floor: Floor) {
  const city = floor.city!,
    existing = roadGraphs.get(city);
  if (existing) return existing;
  const points: Point[] = [];
  const add = (point: Point) => {
    if (
      points.length >= MAX_ROAD_NODES ||
      !publicRoadClear(floor, point, point) ||
      points.some((other) => distance(point, other) < 0.05)
    )
      return false;
    points.push(point);
    return true;
  };
  for (const road of city.roads) add({ x: road.x, y: road.y });
  for (let i = 0; i < city.roads.length; i++)
    for (let j = i + 1; j < city.roads.length; j++) {
      const a = city.roads[i],
        b = city.roads[j],
        left = Math.max(a.x - a.w / 2, b.x - b.w / 2) + 0.5,
        right = Math.min(a.x + a.w / 2, b.x + b.w / 2) - 0.5,
        top = Math.max(a.y - a.h / 2, b.y - b.h / 2) + 0.5,
        bottom = Math.min(a.y + a.h / 2, b.y + b.h / 2) - 0.5;
      if (left > right || top > bottom) continue;
      const middle = { x: (left + right) / 2, y: (top + bottom) / 2 };
      if (!add(middle))
        for (const x of [left, right])
          for (const y of [top, bottom]) add({ x, y });
    }
  const edges = points.map(() => points.map(() => Infinity));
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++)
      if (publicRoadClear(floor, points[i], points[j]))
        edges[i][j] = edges[j][i] = distance(points[i], points[j]);
  const graph = { points, edges };
  roadGraphs.set(city, graph);
  return graph;
}

function streetRecovery(floor: Floor, start: Point, target: Point) {
  const graph = roadGraph(floor),
    count = graph.points.length,
    from = count,
    to = count + 1,
    points = [...graph.points, start, target],
    startEdges = graph.points.map((p) =>
      publicRoadClear(floor, start, p) ? distance(start, p) : Infinity,
    ),
    targetEdges = graph.points.map((p) =>
      publicRoadClear(floor, target, p) ? distance(target, p) : Infinity,
    ),
    scores = points.map(() => Infinity),
    previous = points.map(() => -1),
    visited = new Set<number>();
  scores[from] = 0;
  for (let iteration = 0; iteration < points.length; iteration++) {
    let current = -1;
    for (let i = 0; i < points.length; i++)
      if (
        !visited.has(i) &&
        Number.isFinite(scores[i]) &&
        (current < 0 || scores[i] < scores[current])
      )
        current = i;
    if (current < 0) return undefined;
    if (current === to) {
      const result: Point[] = [];
      for (let i = to; i !== from && i >= 0; i = previous[i])
        result.push({ x: points[i].x, y: points[i].y });
      return result.reverse();
    }
    visited.add(current);
    for (let next = 0; next < points.length; next++) {
      if (visited.has(next) || next === from) continue;
      const weight =
          current === from
            ? next < count
              ? startEdges[next]
              : Infinity
            : next === to
              ? targetEdges[current]
              : graph.edges[current][next],
        candidate = scores[current] + weight;
      if (candidate < scores[next]) {
        scores[next] = candidate;
        previous[next] = current;
      }
    }
  }
  return undefined;
}

function distanceFromSegment(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    t = Math.max(
      0,
      Math.min(
        1,
        ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1),
      ),
    );
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

export function cityZombieSpeed(g: Pick<Game, "rules">) {
  return g.rules === "force-fields"
    ? CONFIG.playerSpeed * SWARM.speedRatio
    : CONFIG.zombieSpeed;
}

export function cityRouteLength(points: readonly Point[]) {
  let length = 0;
  for (let i = 1; i < points.length; i++)
    length += distance(points[i - 1], points[i]);
  return length;
}

/** Parallel lanes keep a broad street front. The final leg tapers into the
 * real entrance width; neighbouring zombies then form ordinary physical queues. */
function lanePath(g: Game, route: CityApproach, lane: number) {
  const city = g.floors[0].city!;
  let cache = paths.get(city);
  if (!cache) paths.set(city, (cache = new Map()));
  const key = `${route.id}/${lane}`;
  const existing = cache.get(key);
  if (existing) return existing;
  const door = g.floors[0].furniture.find((o) => o.id === "main-gate"),
    endLane = Math.max(
      -Math.max(0, (door?.w ?? 4) / 2 - 0.35),
      Math.min(Math.max(0, (door?.w ?? 4) / 2 - 0.35), lane),
    ),
    sourcePoints = route.points.map((p) => ({ ...p }));
  const end = sourcePoints.at(-1)!,
    previous = sourcePoints.at(-2)!,
    finalLength = distance(previous, end);
  if (lane !== 0 && finalLength > 12.01)
    sourcePoints.splice(sourcePoints.length - 1, 0, {
      x: end.x + ((previous.x - end.x) / finalLength) * 12,
      y: end.y + ((previous.y - end.y) / finalLength) * 12,
    });
  const points = sourcePoints.map((p, i, all) => {
    const before = all[Math.max(0, i - 1)],
      after = all[Math.min(all.length - 1, i + 1)],
      previousLength = distance(before, p) || distance(p, after) || 1,
      nextLength = distance(p, after) || previousLength,
      previous =
        i === 0
          ? {
              x: (after.x - p.x) / nextLength,
              y: (after.y - p.y) / nextLength,
            }
          : {
              x: (p.x - before.x) / previousLength,
              y: (p.y - before.y) / previousLength,
            },
      next =
        i === all.length - 1
          ? previous
          : {
              x: (after.x - p.x) / nextLength,
              y: (after.y - p.y) / nextLength,
            },
      divisor = Math.max(0.5, 1 + previous.x * next.x + previous.y * next.y),
      offset = i === all.length - 1 ? endLane : lane;
    return {
      x: p.x - ((previous.y + next.y) * offset) / divisor,
      y: p.y + ((previous.x + next.x) * offset) / divisor,
    };
  });
  cache.set(key, points);
  return points;
}

function sample(points: readonly Point[], fromStart: number) {
  let remaining = Math.max(0, fromStart);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i],
      length = distance(a, b);
    if (remaining <= length || i === points.length - 1) {
      const t = Math.min(1, remaining / (length || 1));
      return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        waypoint: i,
      };
    }
    remaining -= length;
  }
  return { ...points[0], waypoint: 1 };
}

function zombie(g: Game, position: Point, state: CityApproachState): Zombie {
  let id: string;
  do id = `z${g.spawned++}`;
  while (g.zombies.some((z) => z.id === id));
  return {
    id,
    floor: 0,
    x: position.x,
    y: position.y,
    hp: 60,
    path: [],
    repath: 0,
    cooldown: 0,
    memory: 0,
    stagger: 0,
    origin: "outside",
    cityApproach: state,
  };
}

function formationWidth(
  city: CityPlan,
  route: CityApproach,
  p: Point & { waypoint: number },
) {
  const target = route.points[p.waypoint],
    previous = route.points[p.waypoint - 1],
    horizontal =
      Math.abs(target.x - previous.x) > Math.abs(target.y - previous.y),
    widths = city.roads
      .filter((r) => inCityRectangle(r, p.x, p.y))
      .map((r) => (horizontal ? r.h : r.w));
  return Math.max(4, Math.min(9, ...widths));
}

/** Fresh worlds begin with real distant bodies, rather than a future promise
 * to materialize attackers at the doorstep. Existing runs are never reseeded. */
export function initCityInvasion(g: Game) {
  const city = g.floors[0]?.city;
  if (!city || g.time !== 0 || g.spawned > 0 || g.zombies.length) return 0;
  const speed = cityZombieSpeed(g),
    runway = speed * spawnGrace(g),
    cap = swarmPacing(g).cap;
  let added = 0;
  for (let index = 0; index < city.approaches.length; index++) {
    const route = city.approaches[index],
      center = sample(route.points, route.length - runway),
      width = formationWidth(city, route, center),
      rawColumns = Math.ceil((width - 0.64) / 0.6) + 1,
      columns = Math.min(15, Math.max(7, rawColumns + (1 - (rawColumns % 2)))),
      half = (columns - 1) / 2,
      spacing = (width - 0.64) / (columns - 1),
      lanes = [0];
    for (let i = 1; i <= half; i++) lanes.push(i * spacing, -i * spacing);
    for (let rank = 0; rank < INITIAL_RANKS; rank++)
      for (const lane of lanes) {
        if (g.zombies.length >= cap) break;
        const points = lanePath(g, route, lane),
          // A centre leader is first; other streets arrive just behind it.
          // Every lane's own arc length is measured, including its turns.
          remaining =
            runway +
            rank * RANK_SPACING +
            (lane ? 2 + Math.abs(lane) * 0.02 : 0) +
            index * speed * 3,
          position = sample(points, cityRouteLength(points) - remaining);
        if (solid(g.floors[0], position, 0.24)) continue;
        g.zombies.push(
          zombie(g, position, {
            route: route.id,
            waypoint: position.waypoint,
            lane,
          }),
        );
        added++;
      }
  }
  g.nextSpawn = g.time + swarmPacing(g).interval;
  return added;
}

/** A bounded, nearby steering target lets the existing motor, obstacle
 * strikes, crowd contacts and combat remain authoritative. No teleporting,
 * scheduled arrivals, position interpolation or hidden invulnerability. */
export function cityApproachTarget(
  g: Game,
  z: Zombie,
): CityApproachTarget | undefined {
  const city = g.floors[0]?.city,
    state = z.cityApproach;
  if (!city || !state || z.floor !== 0 || z.hp <= 0) return undefined;
  const route = city.approaches.find((r) => r.id === state.route);
  if (!route) {
    delete z.cityApproach;
    return undefined;
  }
  const door = g.floors[0].furniture.find((o) => o.id === "main-gate"),
    boundary = g.floors[0].boundary;
  if ((!door || door.destroyed) && boundary && z.y < boundary.bottom) {
    delete z.cityApproach;
    return undefined;
  }
  const points = lanePath(g, route, state.lane);
  state.waypoint = Math.max(1, Math.min(points.length - 1, state.waypoint));
  while (
    state.waypoint < points.length - 1 &&
    distance(z, points[state.waypoint]) < 0.035
  )
    state.waypoint++;
  const target = points[state.waypoint],
    d = distance(z, target),
    last = state.waypoint === points.length - 1,
    // Once the barrier falls, carry the approach through the actual opening,
    // where ordinary indoor search takes over on the next tick.
    through = last && (!door || door.destroyed) && (d < 0.08 || z.y < target.y);
  if (through) {
    delete state.recovery;
    delete state.recoveryWaypoint;
    delete state.recoveryRetryAt;
    return {
      point: { x: target.x, y: (boundary?.bottom ?? target.y) - 0.8 },
      speed: cityZombieSpeed(g),
      finalDoor: last,
    };
  }
  if (state.recoveryWaypoint !== state.waypoint) {
    delete state.recovery;
    delete state.recoveryWaypoint;
  }
  while (state.recovery?.length && distance(z, state.recovery[0]) < 0.035)
    state.recovery.shift();
  // Normal approaches keep their exact original motor path and cadence. A
  // geometric return plan is needed only after a physical chase left that lane
  // and the direct return is now obstructed by a real city block or the office.
  const needsRecovery = state.recovery?.length
    ? !publicRoadClear(g.floors[0], z, state.recovery[0])
    : distanceFromSegment(z, points[state.waypoint - 1], target) > 0.08 &&
      !publicRoadClear(g.floors[0], z, target);
  if (needsRecovery && g.time >= (state.recoveryRetryAt ?? 0)) {
    state.recovery = streetRecovery(g.floors[0], z, target);
    state.recoveryWaypoint = state.waypoint;
    if (!state.recovery?.length) state.recoveryRetryAt = g.time + 1;
    else delete state.recoveryRetryAt;
  }
  const guide = state.recovery?.[0] ?? target,
    guideDistance = distance(z, guide),
    amount = Math.min(LOOKAHEAD, guideDistance);
  return {
    point: {
      x: z.x + ((guide.x - z.x) / (guideDistance || 1)) * amount,
      y: z.y + ((guide.y - z.y) / (guideDistance || 1)) * amount,
    },
    speed: cityZombieSpeed(g),
    finalDoor: last,
  };
}

/** Replenishment starts behind the far corner, and waits if that location is
 * actually in the player's unobstructed view. The live population stays capped. */
export function spawnCityReinforcements(g: Game, batch: number) {
  const floor = g.floors[0],
    city = floor?.city;
  if (!city || !city.approaches.length) return 0;
  g.zombies = g.zombies.filter((z) => z.hp > 0);
  const cap = swarmPacing(g).cap,
    count = Math.min(Math.max(0, Math.floor(batch)), cap - g.zombies.length),
    range =
      Math.hypot(
        city.bounds.right - city.bounds.left,
        city.bounds.bottom - city.bounds.top,
      ) + 1,
    human = g.survivors[0];
  let added = 0;
  for (let n = 0; n < count; n++) {
    let created = false;
    for (let i = 0; i < city.approaches.length && !created; i++) {
      const route = city.approaches[(g.spawned + i) % city.approaches.length];
      for (const lane of [0, 0.65, -0.65, 1.3, -1.3, 1.95, -1.95]) {
        const points = lanePath(g, route, lane),
          position = sample(points, 0.45);
        if (
          solid(floor, position, 0.24) ||
          g.zombies.some(
            (z) => z.floor === 0 && distance(z, position) < 0.55,
          ) ||
          g.survivors.some(
            (a) =>
              a.floor === 0 &&
              a.alive &&
              !a.escaped &&
              distance(a, position) < 0.6,
          ) ||
          (human?.alive &&
            !human.escaped &&
            human.floor === 0 &&
            playerCanSee(floor, human, position, range))
        )
          continue;
        g.zombies.push(
          zombie(g, position, {
            route: route.id,
            waypoint: position.waypoint,
            lane,
          }),
        );
        added++;
        created = true;
        break;
      }
    }
    if (!created) break;
  }
  return added;
}
