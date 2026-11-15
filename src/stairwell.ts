import { carveStairCore, coreFlight, coreMouth } from "./stair-core";
import { roofIndexOf, H, type Floor, type Point, distance } from "./model";

/** A survivor stands in a staircase while within this distance of its marker:
 * the carved well on fresh floors, or the marked landing on legacy floors. */
export const STAIRWELL_RADIUS = 1.15;
/** Fresh floors carve each staircase into the boundary wall as a two-cell-wide,
 * two-cell-deep well whose open side faces the room. */
export const STAIRWELL_SIZE = 2;
export interface Stairwell {
  kind: "up" | "down";
  marker: Point;
  /** Drawn footprint in world units. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** +1 when the open side faces south (+y), -1 when it faces north. */
  open: 1 | -1;
  /** Point just outside the open side, where a visitor steps in. */
  mouth: Point;
}
export function inStairwell(p: Point, marker: Point) {
  return distance(p, marker) < STAIRWELL_RADIUS;
}
/** The ascending well sits at the north edge and opens south; the descending
 * well sits at the south edge and opens north. Legacy floors keep their open
 * landings; the same footprint is drawn around their markers. */
export function stairwell(f: Floor, kind: "up" | "down"): Stairwell {
  const marker = kind === "up" ? f.stairs : f.entry,
    // An interior core's landing opens away from its flights.
    open: 1 | -1 = f.stairCore
      ? coreMouth(f.stairCore, marker)
      : kind === "up"
        ? 1
        : -1,
    half = STAIRWELL_SIZE / 2;
  return {
    kind,
    marker,
    x: marker.x - half,
    y: marker.y - half,
    w: STAIRWELL_SIZE,
    h: STAIRWELL_SIZE,
    open,
    mouth: { x: marker.x, y: marker.y + open * (half + 0.5) },
  };
}
/** What the top-down view draws for a staircase: the wall well, or for an
 * interior core the flight itself (its treads on the level it climbs from,
 * the opening it arrives through on the level above). */
export function stairDrawing(f: Floor, kind: "up" | "down"): Stairwell {
  const well = stairwell(f, kind),
    core = f.stairCore;
  if (!core) return well;
  const flight = coreFlight(core, kind === "up" ? f.index : f.index - 1),
    { cells } = flight;
  return {
    ...well,
    x: cells.x1,
    y: cells.y1,
    w: cells.x2 - cells.x1 + 1,
    h: cells.y2 - cells.y1 + 1,
    // Treads run from the foot: the open side is where a walker steps on.
    open: (kind === "up" ? -flight.direction : flight.direction) as 1 | -1,
  };
}
/** Cells in front of a well that furniture must leave open. */
export function stairwellApproach(f: Floor, kind: "up" | "down"): Point[] {
  const well = stairwell(f, kind),
    points: Point[] = [];
  for (let depth = 0.5; depth <= 2.5; depth++)
    for (const dx of [-0.5, 0.5])
      points.push({
        x: well.marker.x + dx,
        y: well.marker.y + well.open * (STAIRWELL_SIZE / 2 + depth),
      });
  return points;
}
/** Carve the wells of a fresh floor into its boundary walls. Floor 0 has no
 * descending well (its entry stays the arrival point from outside). */
export function carveStairwells(f: Floor) {
  // A design with an interior stair core has no wells in its walls.
  if (f.stairCore) return carveStairCore(f);
  const columns = [21, 22],
    top = f.boundary?.top ?? 2,
    bottom = f.boundary?.bottom ?? H - 6;
  if (f.index < roofIndexOf(f)) {
    f.stairs = { x: 22, y: top - 1 };
    for (let y = top - 2; y < top; y++)
      for (const x of columns) f.tiles[y][x] = 0;
  }
  if (f.index > 0) {
    f.entry = { x: 22, y: bottom + 1 };
    for (let y = bottom; y < bottom + 2; y++)
      for (const x of columns) f.tiles[y][x] = 0;
  }
}
