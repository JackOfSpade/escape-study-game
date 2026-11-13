/**
 * Open sites: a ground-level market/yard instead of a four-storey building.
 *
 * An open v3 design has exactly one authored floor and keeps the same gameplay
 * topology as a building's ground floor, so every field, credential, terminal
 * capacity and egress invariant still holds. What changes is construction:
 * floors above ground are solid, unreachable layers, and the ground stair
 * marker becomes the extraction pad instead of a staircase.
 */
import type { ExtractionPoint, Floor, Game } from "./model";

/** The catalogue form of a place; absent (older designs) means enclosed. */
export type SiteForm = "enclosed" | "open";

/** Only a version 3 blueprint can name a form; everything else is a building. */
export function siteFormOf(blueprint: unknown): SiteForm {
  const setting =
    blueprint && typeof blueprint === "object"
      ? (blueprint as { setting?: unknown }).setting
      : undefined;
  return setting &&
    typeof setting === "object" &&
    (setting as { form?: unknown }).form === "open"
    ? "open"
    : "enclosed";
}

/** True when the start site is open ground rather than a building. */
export function isOpenSite(g: Pick<Game, "floors">): boolean {
  return g.floors[0]?.open === true;
}

/**
 * A solid open layer above the ground: never entered, never validated as a
 * floor plan, never furnished or roofed.
 */
export function isSolidOpenFloor(
  floor: Pick<Floor, "index" | "open"> | undefined,
): boolean {
  return !!floor && floor.open === true && floor.index > 0;
}

/** Longest pickup radius an open site offers for its ground pad. */
export const OPEN_PAD_RADIUS = 2.2;
/** Smallest radius the pad keeps even on a tight, furnished ground floor. */
export const OPEN_PAD_MIN_RADIUS = 1.2;

function walkable(floor: Floor, x: number, y: number): boolean {
  return floor.tiles?.[y]?.[x] === 0;
}

/**
 * True when every tile whose centre the pickup disc covers is walkable ground,
 * so the pad never claims a cell the floorplan made solid.
 */
export function padDiscIsWalkable(
  floor: Floor,
  x: number,
  y: number,
  radius: number,
): boolean {
  for (let ty = Math.floor(y - radius); ty <= Math.ceil(y + radius); ty++)
    for (let tx = Math.floor(x - radius); tx <= Math.ceil(x + radius); tx++)
      if (
        Math.hypot(tx + 0.5 - x, ty + 0.5 - y) <= radius &&
        !walkable(floor, tx, ty)
      )
        return false;
  return true;
}

/**
 * The open site's ground pickup: the floor-0 stair marker, which egress
 * validation already floods to, with the largest radius that stays on walkable
 * ground (clamped to OPEN_PAD_MIN_RADIUS..OPEN_PAD_RADIUS).
 */
export function groundExtractionPad(floor: Floor): ExtractionPoint {
  const { x, y } = floor.stairs;
  let radius = OPEN_PAD_RADIUS;
  while (
    radius > OPEN_PAD_MIN_RADIUS &&
    !padDiscIsWalkable(floor, x, y, radius)
  )
    radius = Math.round((radius - 0.1) * 10) / 10;
  return {
    floor: 0,
    x,
    y,
    radius: Math.max(OPEN_PAD_MIN_RADIUS, Math.round(radius * 10) / 10),
  };
}
