import { walkSegment } from "./navigation";
import { H, W, type Floor, type Point, type Station } from "./model";
import { inFurniture, inStation, STATION_BODY } from "./spatial";

/** Corners this small behind a desk are not a sealed-off part of a floor. */
const POCKET = 2;
const SURFACE_HOSTS = new Set<string>([
  "desk",
  "reception",
  "whiteboard",
  "mixingConsole",
]);
let originalDesks = false;
/** Rebuild a saved design whose writing was bound before terminals could move. */
export function withOriginalDesks<T>(build: () => T): T {
  originalDesks = true;
  try {
    return build();
  } finally {
    originalDesks = false;
  }
}
const key = (x: number, y: number) => y * W + x;
const centre = (cell: number): Point => ({
  x: (cell % W) + 0.5,
  y: Math.floor(cell / W) + 0.5,
});

/** Walkable cell links, with doors and force fields either all open or all shut. */
function cellLinks(f: Floor, entrancesOpen: boolean) {
  const view: Floor = {
    ...f,
    stations: [],
    furniture: entrancesOpen
      ? f.furniture.filter((o) => !o.door && !o.field)
      : f.furniture,
  };
  const links: [number, number][] = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (f.tiles[y]?.[x] !== 0) continue;
      const from = { x: x + 0.5, y: y + 0.5 };
      for (const [nx, ny] of [
        [x + 1, y],
        [x, y + 1],
      ])
        if (
          f.tiles[ny]?.[nx] === 0 &&
          walkSegment(view, from, { x: nx + 0.5, y: ny + 0.5 })
        )
          links.push([key(x, y), key(nx, ny)]);
    }
  return links;
}
function components(links: [number, number][]) {
  const parent = new Int32Array(W * H).map((_, i) => i);
  const find = (i: number) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (const [a, b] of links) parent[find(a)] = find(b);
  return find;
}
/** Whether these desks cut any part of the floor off from the rest of it. */
function seals(
  links: [number, number][],
  desks: Point[],
  whole: ReturnType<typeof components>,
  terminals: Point[] = desks,
) {
  // Only cells beside a desk need the exact test.
  const blocked = new Uint8Array(W * H),
    near = new Uint8Array(W * H);
  for (const d of desks)
    for (let y = Math.floor(d.y) - 2; y <= Math.floor(d.y) + 2; y++)
      for (let x = Math.floor(d.x) - 2; x <= Math.floor(d.x) + 2; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        near[key(x, y)] = 1;
        if (inStation(d, { x: x + 0.5, y: y + 0.5 }, 0.25))
          blocked[key(x, y)] = 1;
      }
  const crosses = ([a, b]: [number, number]) => {
    if (blocked[a] || blocked[b]) return true;
    if (!near[a] && !near[b]) return false;
    const p = centre(a),
      q = centre(b),
      middle = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
    return desks.some((d) => inStation(d, middle, 0.25));
  };
  const after = components(links.filter((link) => !crosses(link)));
  const pieces = new Map<number, Map<number, number>>();
  for (const cell of new Set(links.flat())) {
    if (blocked[cell]) continue;
    const area = whole(cell),
      piece = after(cell),
      counts = pieces.get(area) ?? new Map<number, number>();
    counts.set(piece, (counts.get(piece) ?? 0) + 1);
    pieces.set(area, counts);
  }
  for (const counts of pieces.values())
    if ([...counts.values()].filter((n) => n > POCKET).length > 1) return true;
  // A small corner is only harmless if no terminal depends on it.
  for (const s of terminals) {
    let beside = false,
      open = false;
    for (let y = Math.floor(s.y) - 2; y <= Math.floor(s.y) + 2 && !open; y++)
      for (let x = Math.floor(s.x) - 2; x <= Math.floor(s.x) + 2; x++) {
        const cell = key(x, y);
        if (
          x < 0 ||
          y < 0 ||
          x >= W ||
          y >= H ||
          blocked[cell] ||
          !inStation(s, centre(cell), 1)
        )
          continue;
        const count = pieces.get(whole(cell))?.get(after(cell));
        if (count === undefined) continue;
        beside = true;
        if (count > POCKET) {
          open = true;
          break;
        }
      }
    if (beside && !open) return true;
  }
  return false;
}
/** A locked entrance is no way round for someone without a key, so a desk must
 * leave a floor connected with its entrances shut as well as open. */
function entranceViews(f: Floor) {
  return [true, false].map((open) => {
    const links = cellLinks(f, open);
    return { links, whole: components(links) };
  });
}
function solidSet(f: Floor) {
  const views = entranceViews(f),
    desks: Station[] = [];
  // Almost every floor is clear, which one whole-floor check proves.
  if (!views.some((v) => seals(v.links, f.stations, v.whole)))
    return f.stations;
  for (const s of f.stations)
    if (!views.some((v) => seals(v.links, [...desks, s], v.whole, f.stations)))
      desks.push(s);
  return desks;
}
const known = new WeakMap<
  Station[],
  { tiles: Floor["tiles"]; at: number[]; desks: Station[] }
>();
/**
 * Terminals with a physical desk. Layouts were designed around bodiless points,
 * so a few sit in the only gap between two areas. Those stay walk-through:
 * sealing a floor would strand everyone in a generated world or an older save.
 */
export function solidDesks(f: Floor): Station[] {
  // Older layouts keep their historical geometry for saves and replays.
  if (!f.stations.length || (f.generation?.version ?? 0) < 5) return [];
  const saved = known.get(f.stations);
  if (
    saved?.tiles === f.tiles &&
    saved.at.length === f.stations.length * 2 &&
    f.stations.every(
      (s, i) => saved.at[i * 2] === s.x && saved.at[i * 2 + 1] === s.y,
    )
  )
    return saved.desks;
  const desks = solidSet(f);
  known.set(f.stations, {
    tiles: f.tiles,
    at: f.stations.flatMap((s) => [s.x, s.y]),
    desks,
  });
  return desks;
}

/**
 * Generation: move a terminal standing in the only gap between two areas to the
 * nearest place that `valid` accepts. Runs before furnishing, so walls alone
 * decide it and the furniture is then placed around the final terminals.
 */
export function moveBlockingDesks(f: Floor, valid: () => boolean) {
  if ((f.generation?.version ?? 0) < 5 || originalDesks) return;
  known.delete(f.stations);
  const desks = solidSet(f);
  if (desks.length === f.stations.length) return;
  const views = entranceViews(f);
  for (const s of f.stations.filter((s) => !desks.includes(s))) {
    const home = { x: s.x, y: s.y },
      spots: Point[] = [];
    for (let dy = -6; dy <= 6; dy += 0.5)
      for (let dx = -6; dx <= 6; dx += 0.5)
        spots.push({ x: home.x + dx, y: home.y + dy });
    spots.sort(
      (a, b) =>
        Math.hypot(a.x - home.x, a.y - home.y) -
        Math.hypot(b.x - home.x, b.y - home.y),
    );
    const fits = (p: Point) =>
      [-0.75, 0, 0.75].every((dx) =>
        [-0.75, 0, 0.75].every(
          (dy) => f.tiles[Math.floor(p.y + dy)]?.[Math.floor(p.x + dx)] === 0,
        ),
      ) &&
      f.stations.every(
        (o) =>
          o === s ||
          Math.abs(o.x - p.x) > STATION_BODY.w + 0.6 ||
          Math.abs(o.y - p.y) > STATION_BODY.h + 0.75,
      ) &&
      !f.furniture.some((o) => inFurniture(p, o, 0.8));
    let moved = false;
    for (const p of spots) {
      if (!fits(p)) continue;
      Object.assign(s, p);
      if (
        !views.some((v) =>
          seals(v.links, [...desks, s], v.whole, f.stations),
        ) &&
        valid()
      ) {
        desks.push(s);
        moved = true;
        break;
      }
    }
    if (!moved) Object.assign(s, home);
  }
  known.delete(f.stations);
}

/**
 * Generation: seeded filler can close the last gap beside a terminal. Take out
 * the nearest piece that reopens it. Authored objects and entrances stay.
 */
export function clearFillerAroundDesks(f: Floor) {
  known.delete(f.stations);
  if (originalDesks) return;
  const desks = solidSet(f);
  if (desks.length === f.stations.length) return;
  for (const s of f.stations.filter((s) => !desks.includes(s))) {
    const nearby = f.furniture
      .filter(
        (o) =>
          !o.door &&
          !o.field &&
          !o.appearance &&
          // Written surfaces of a saved design are bound to these hosts.
          !(f.design && SURFACE_HOSTS.has(o.kind)) &&
          Math.hypot(o.x - s.x, o.y - s.y) < 3,
      )
      .sort(
        (a, b) =>
          Math.hypot(a.x - s.x, a.y - s.y) - Math.hypot(b.x - s.x, b.y - s.y),
      )
      .slice(0, 6);
    const all = f.furniture;
    for (const piece of nearby) {
      f.furniture = all.filter((o) => o !== piece);
      if (
        !entranceViews(f).some((v) =>
          seals(v.links, [...desks, s], v.whole, f.stations),
        )
      ) {
        desks.push(s);
        break;
      }
      f.furniture = all;
    }
  }
  known.delete(f.stations);
}
