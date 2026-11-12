import type { Actor, Game, Point } from "./model";
import { START_SITE, sitesOf, type Site } from "./site";
import type { StairTravel } from "./stair-travel";

/** Shared by the walking motor and renderer. Three/world Y is elevation. */
export const FLOOR_HEIGHT = 3.6;
export const STAIR_ROUTE_WIDTH = 1.6;
export interface StairRoutePoint {
  x: number;
  y: number;
  z: number;
}
export interface StairRoute {
  points: StairRoutePoint[];
  length: number;
}
export interface CityStairBase extends Point {
  w: number;
  h: number;
  start: Point;
  end: Point;
  rise: number;
}

function segmentLength(a: StairRoutePoint, b: StairRoutePoint) {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}

/** The site a stored flight belongs to; the start building when unrecorded. */
export function travelSite(
  g: Pick<Game, "floors" | "sites">,
  travel: Pick<StairTravel, "site">,
): Site {
  const sites = sitesOf(g);
  return sites.find((site) => site.id === travel.site) ?? sites[0];
}

/**
 * The generated office route enters at its south end and exits at its north
 * end. An exterior emergency stair and gallery connect those actual doors:
 * neither the camera nor the player cuts diagonally through occupied offices.
 * Downward travel uses the same physical route in reverse. Both ends belong to
 * the flight's own site, so a second building keeps its own stair columns.
 */
export function buildStairRoute(g: Game, travel: StairTravel): StairRoute {
  const down = travel.toFloor < travel.fromFloor,
    lower = g.floors[Math.min(travel.fromFloor, travel.toFloor)],
    upper = g.floors[Math.max(travel.fromFloor, travel.toFloor)],
    site = travelSite(g, travel),
    // The start site keeps its per-floor boundary; others use their own shell.
    boundary =
      site.id === START_SITE
        ? lower.boundary
        : (site.boundary ?? lower.boundary),
    stairs = site.stairs[lower.index] ?? lower.stairs,
    arrival = site.entry[upper.index] ?? upper.entry,
    north = Math.min(boundary?.top ?? stairs.y + 1, stairs.y) - 2,
    south = Math.max(boundary?.bottom ?? arrival.y - 1, arrival.y) + 2,
    east = Math.max(...(boundary?.rows.map((r) => r?.right ?? 0) ?? [42])) + 3,
    lowY = lower.index * FLOOR_HEIGHT,
    highY = upper.index * FLOOR_HEIGHT,
    low = down ? travel.destination : travel.origin,
    high = down ? travel.origin : travel.destination,
    canonical: StairRoutePoint[] = [
      { x: low.x, y: lowY, z: low.y },
      { x: stairs.x, y: lowY, z: north },
      { x: east, y: lowY, z: north },
      // Twenty 18 cm risers over a 7.2 m run, followed by a level gallery.
      { x: east, y: highY, z: Math.min(south - 1, north + 7.2) },
      { x: east, y: highY, z: south },
      { x: arrival.x, y: highY, z: south },
      { x: high.x, y: highY, z: high.y },
    ],
    points =
      travel.cityBase && !down
        ? [
            { x: travel.origin.x, y: lowY, z: travel.origin.y },
            canonical[2],
            ...canonical.slice(3),
          ]
        : canonical;
  if (down) points.reverse();
  return {
    points,
    length: points
      .slice(1)
      .reduce((sum, p, i) => sum + segmentLength(points[i], p), 0),
  };
}

/** Exact ground footprint of the lowest physical flight. The city collider
 * and the visible foundation describe this same rise, never the whole gallery. */
export function cityStairBase(g: Game): CityStairBase | undefined {
  const lower = g.floors[0],
    upper = g.floors[1];
  if (!lower?.city || !lower.boundary || !upper) return undefined;
  const route = buildStairRoute(g, {
      fromFloor: 0,
      toFloor: 1,
      origin: lower.stairs,
      destination: upper.entry,
      until: 0,
    }),
    start = route.points[2],
    end = route.points[3];
  return {
    x: (start.x + end.x) / 2,
    y: (start.z + end.z) / 2,
    w: STAIR_ROUTE_WIDTH + 0.12,
    h: Math.hypot(end.x - start.x, end.z - start.z),
    start: { x: start.x, y: start.z },
    end: { x: end.x, y: end.z },
    rise: end.y - start.y,
  };
}

/** Continuous pose at saved walking distance; tangent uses simulation X/Y. */
export function sampleStairRoute(
  g: Game,
  travel: StairTravel,
  walked = travel.walked ?? 0,
): StairRoutePoint & { tangent: Point; segment: number; length: number } {
  const route = buildStairRoute(g, travel);
  let remaining = Math.max(0, Math.min(route.length, walked));
  for (let i = 0; i < route.points.length - 1; i++) {
    const a = route.points[i],
      b = route.points[i + 1],
      length = segmentLength(a, b);
    if (remaining < length - 1e-8 || i === route.points.length - 2) {
      const t = length ? Math.max(0, Math.min(1, remaining / length)) : 0,
        horizontal = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
        tangent: { x: (b.x - a.x) / horizontal, y: (b.z - a.z) / horizontal },
        segment: i,
        length: route.length,
      };
    }
    remaining -= length;
  }
  throw Error("Stair route has no segments");
}

/** Sensing and contact use physical elevation, including a reachable survivor
 * on a desk, a stair walker or someone falling past the floor. */
export function actorOnFloor(g: Game, actor: Actor, floor: number) {
  const travel = actor.stairTravel;
  if (actor.elevated)
    return Math.abs(actor.elevated.feet - floor * FLOOR_HEIGHT) <= 1.2;
  return travel?.walked === undefined
    ? actor.floor === floor
    : Math.abs(sampleStairRoute(g, travel).y - floor * FLOOR_HEIGHT) <= 0.9;
}
