import { type Floor, type Point, roofIndexOf } from "./model";
import type { Rect } from "./floor-plan";

/** An interior stair core (design version 4, `stairs`).
 *
 * The design places one core for the whole building: a rectangle 4 cells wide
 * and 9 long (north to south), the same cells on every storey and the roof.
 * Its two end strips are landings, open floor on every level. Between them
 * run two flights side by side. The flight from an even level climbs the west
 * pair of columns from the north landing to the south landing of the level
 * above; the flight from an odd level climbs the east pair back north. So a
 * walker turns on each landing, as on any switchback stair.
 *
 * On level k the cells of its own flight are the solid mass of the stair, and
 * the cells of the flight arriving from below are an opening in the floor.
 * Both are solid tiles to the flat simulation: nobody walks into the opening,
 * and people on foot use the markers on the landings as they do the wall wells
 * of other buildings. The player's body walks the real flight. */
export interface StairCore {
  /** North-west interior cell of the core. */
  x: number;
  y: number;
}
export const CORE_WIDTH = 4;
const CORE_LANDING = 2;
const CORE_FLIGHT = 5;
export const CORE_LENGTH = 2 * CORE_LANDING + CORE_FLIGHT;

export const coreRect = (c: StairCore): Rect => ({
  x1: c.x,
  y1: c.y,
  x2: c.x + CORE_WIDTH - 1,
  y2: c.y + CORE_LENGTH - 1,
});

interface CoreFlight {
  /** The five by two cells the flight covers. */
  cells: Rect;
  /** Marker on the lower level's landing, at the foot of the flight. */
  foot: Point;
  /** Where the treads begin (lower level height) and end (upper level). */
  start: Point;
  end: Point;
  /** Marker on the upper level's landing, at the head of the flight. */
  head: Point;
  /** +1 when the flight climbs south, -1 when it climbs north. */
  direction: 1 | -1;
}
/** The flight that climbs from `level` to the level above. */
export function coreFlight(c: StairCore, level: number): CoreFlight {
  const even = level % 2 === 0,
    x = c.x + (even ? 1 : 3),
    north = c.y + CORE_LANDING,
    south = c.y + CORE_LANDING + CORE_FLIGHT;
  return {
    cells: {
      x1: x - 1,
      y1: north,
      x2: x,
      y2: south - 1,
    },
    foot: { x, y: even ? north - 1 : south + 1 },
    start: { x, y: even ? north : south },
    end: { x, y: even ? south : north },
    head: { x, y: even ? south + 1 : north - 1 },
    direction: even ? 1 : -1,
  };
}

/** A core standing on a floor: the start building's own, or a stamped
 * neighbour's with the floors it spans. */
export interface FloorCore extends StairCore {
  /** Ground and roof floor of the building this core belongs to. */
  ground: number;
  roof: number;
  site?: string;
}
export function floorCores(
  f: Pick<Floor, "stairCore" | "cores" | "roof">,
): FloorCore[] {
  return [
    ...(f.stairCore
      ? [{ ...f.stairCore, ground: 0, roof: roofIndexOf(f) }]
      : []),
    ...(f.cores ?? []),
  ];
}

type CoreCell = "landing" | "flight" | "opening" | "floor";
/** What a cell of a floor is to a core standing on it, if it is in one. */
function coreCellOf(
  core: FloorCore,
  level: number,
  x: number,
  y: number,
): CoreCell | undefined {
  if (
    level < core.ground ||
    level > core.roof ||
    x < core.x ||
    x >= core.x + CORE_WIDTH ||
    y < core.y ||
    y >= core.y + CORE_LENGTH
  )
    return undefined;
  const along = y - core.y;
  if (along < CORE_LANDING || along >= CORE_LANDING + CORE_FLIGHT)
    return "landing";
  const within = (flight: CoreFlight) =>
    x >= flight.cells.x1 && x <= flight.cells.x2;
  const relative = level - core.ground;
  if (level < core.roof && within(coreFlight(core, relative))) return "flight";
  if (level > core.ground && within(coreFlight(core, relative - 1)))
    return "opening";
  return "floor";
}
/** The flight mass or floor opening at a cell, for any core on the floor. */
export function stairHole(
  f: Pick<Floor, "stairCore" | "cores" | "roof" | "index">,
  x: number,
  y: number,
): "flight" | "opening" | undefined {
  if (!f.stairCore && !f.cores) return undefined;
  for (const core of floorCores(f)) {
    const cell = coreCellOf(core, f.index, x, y);
    if (cell === "flight" || cell === "opening") return cell;
  }
  return undefined;
}

/** Carve the start building's core into a floor's tiles and set its markers:
 * the way up at the foot of this level's flight, the arrival point at the
 * head of the flight from below. */
export function carveStairCore(f: Floor) {
  const c = f.stairCore;
  if (!c) return;
  const core: FloorCore = { ...c, ground: 0, roof: roofIndexOf(f) };
  for (let y = c.y; y < c.y + CORE_LENGTH; y++)
    for (let x = c.x; x < c.x + CORE_WIDTH; x++) {
      const cell = coreCellOf(core, f.index, x, y);
      if (f.tiles[y]?.[x] === undefined) continue;
      f.tiles[y][x] = cell === "flight" || cell === "opening" ? 1 : 0;
    }
  if (f.index < core.roof) f.stairs = { ...coreFlight(c, f.index).foot };
  if (f.index > 0) f.entry = { ...coreFlight(c, f.index - 1).head };
}

/** Which way a landing marker's open side faces: away from the flights. */
export function coreMouth(c: StairCore, marker: Point): 1 | -1 {
  return marker.y < c.y + CORE_LENGTH / 2 ? -1 : 1;
}

/** Cells that must stay open floor around a core: the core itself and three
 * cells of apron beyond each landing. */
export function coreReserved(c: StairCore): Point[] {
  const out: Point[] = [];
  for (let y = c.y - 3; y < c.y + CORE_LENGTH + 3; y++)
    for (let x = c.x; x < c.x + CORE_WIDTH; x++) out.push({ x, y });
  return out;
}
