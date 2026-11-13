import { fnv1a } from "./hash";
import {
  distance,
  type Floor,
  type Game,
  type Point,
  type Zombie,
} from "./model";
import { floorCols, floorRows } from "./site";
import { furnitureNear, inFurniture, wall } from "./spatial";
import { blocksSight, canSee, sightRadius } from "./visibility";

/** Short local plans, not a floor plan. Recent footsteps are personal and
 * bounded; they encourage searching new branches without an omniscient map. */
export const ZOMBIE_SEARCH = { radius: 6, trail: 96 };
const cell = (f: Floor, p: Point) =>
  Math.floor(p.y) * floorCols(f) + Math.floor(p.x);
const point = (f: Floor, n: number): Point => {
  const cols = floorCols(f);
  return { x: (n % cols) + 0.5, y: Math.floor(n / cols) + 0.5 };
};
/** A zombie's choices do not consume another zombie's random sequence. */
export function zombieSearchRandom(g: Game, z: Zombie, salt: number) {
  return (
    fnv1a(`${g.seed}/${z.id}/${z.floor}/${z.search?.decisions ?? 0}/${salt}`) /
    4294967296
  );
}
export function prepareZombieSearch(g: Game, z: Zombie) {
  if (z.search?.floor === z.floor) return z.search;
  const angle = zombieSearchRandom(g, z, 0) * Math.PI * 2;
  z.search = {
    floor: z.floor,
    trail: [],
    heading: { x: Math.cos(angle), y: Math.sin(angle) },
    decisions: 0,
  };
  // Old saves may contain a route calculated using the entire building.
  z.path = [];
  z.repath = 0;
  return z.search;
}

/** Only cells this zombie can currently inspect enter the graph. A sensed
 * location biases the local search; it never supplies a route behind walls.
 * The first visible barricade may be approached and attacked, but its far
 * side and the rooms behind it are not revealed. */
export function planZombieRoute(g: Game, z: Zombie, cue?: Point): Point[] {
  const f = g.floors[z.floor],
    cols = floorCols(f),
    rows = floorRows(f),
    size = cols * rows,
    search = prepareZombieSearch(g, z),
    start = cell(f, z),
    radius = Math.min(ZOMBIE_SEARCH.radius, sightRadius(f)),
    known = new Uint8Array(size),
    blocked = new Uint8Array(size);
  // A floor whose raster grew invalidates every stored cell index.
  if (search.trail.some((n) => n < 0 || n >= size))
    search.trail.splice(0, search.trail.length);
  if (search.trail.at(-1) !== start) search.trail.push(start);
  if (search.trail.length > ZOMBIE_SEARCH.trail)
    search.trail.splice(0, search.trail.length - ZOMBIE_SEARCH.trail);
  search.decisions++;
  const trailPoints = search.trail.map((n) => point(f, n));
  for (
    let y = Math.max(1, Math.floor(z.y - radius));
    y <= Math.min(rows - 2, Math.floor(z.y + radius));
    y++
  ) {
    for (
      let x = Math.max(1, Math.floor(z.x - radius));
      x <= Math.min(cols - 2, Math.floor(z.x + radius));
      x++
    ) {
      const p = { x: x + 0.5, y: y + 0.5 },
        n = y * cols + x;
      if (distance(z, p) > radius || wall(f, p.x, p.y)) continue;
      const object = (furnitureNear(f, p, 0.22) ?? f.furniture).find((o) =>
        inFurniture(p, o, 0.22),
      );
      if (
        !canSee(
          f,
          z,
          p,
          radius,
          object && blocksSight(object) ? object.id : undefined,
        )
      )
        continue;
      known[n] = 1;
      blocked[n] = object ? 1 : 0;
    }
  }
  known[start] = 1;
  const costs = new Float64Array(size).fill(Infinity),
    steps = new Uint16Array(size),
    previous = new Int32Array(size).fill(-1),
    open = [start],
    closed = new Uint8Array(size);
  costs[start] = 0;
  // The graph contains at most a small disk of visible cells. Penalize props
  // so a zombie walks around a visible desk instead of knowing a hidden detour.
  for (let i = 0; open.length && i < size; i++) {
    open.sort((a, b) => costs[b] - costs[a] || b - a);
    const n = open.pop()!;
    if (closed[n]) continue;
    closed[n] = 1;
    for (const next of [n - cols, n + cols, n - 1, n + 1]) {
      if (!known[next] || closed[next]) continue;
      const cost = costs[n] + 1 + blocked[next] * 18;
      if (cost >= costs[next]) continue;
      costs[next] = cost;
      steps[next] = steps[n] + 1;
      previous[next] = n;
      open.push(next);
    }
  }
  let goal = start,
    best = -Infinity;
  const cueCell = cue ? cell(f, cue) : -1;
  if (cueCell === start) return [];
  for (let n = 0; n < known.length; n++) {
    if (n === start || previous[n] < 0) continue;
    const p = point(f, n),
      d = distance(z, p);
    if (d < 0.7 && n !== cueCell) continue;
    let revisit = 0;
    for (const q of trailPoints) {
      const gap = distance(p, q);
      if (gap < 2) revisit += (2 - gap) * 1.5;
    }
    const forward =
      ((p.x - z.x) * search.heading.x + (p.y - z.y) * search.heading.y) / d;
    const frontier = [n - cols, n + cols, n - 1, n + 1].some((v) => !known[v]);
    const score = cue
      ? (distance(z, cue) - distance(p, cue)) * 4 -
        costs[n] * 0.16 -
        revisit * 0.25 +
        (n === cueCell ? 2 : 0)
      : d * 0.6 +
        forward * 1.4 +
        (frontier ? 1.5 : 0) -
        revisit -
        // Prop costs choose a route around desks when possible. Applying the
        // same large cost to exploration goals makes a room's only force-field
        // exit permanently less attractive than circling its empty interior.
        steps[n] * 0.22 +
        zombieSearchRandom(g, z, n) * 1.5;
    if (score > best) {
      best = score;
      goal = n;
    }
  }
  if (goal === start) return [];
  const destination = point(f, goal),
    d = distance(z, destination) || 1;
  search.heading = {
    x: (destination.x - z.x) / d,
    y: (destination.y - z.y) / d,
  };
  const route: Point[] = [];
  for (let n = goal; n !== start; n = previous[n]) route.push(point(f, n));
  return route.reverse();
}
