/**
 * Sites: several buildings standing in one continuous world
 * (docs/ESCAPE_REDESIGN.md section 16).
 *
 * Floors are z-layers that share one x/y coordinate space. Floor `k` holds
 * storey `k` of every site. The start building is the implicit first site and
 * keeps its data in the existing floor fields (`boundary`, `stairs`, `entry`,
 * the `main-gate` furniture); every further site is a record in `Game.sites`.
 * With no extra sites every helper here answers exactly what the engine used
 * to assume for its one building.
 */
import {
  CONFIG,
  H,
  W,
  type BuildingFootprint,
  type Floor,
  type Game,
  type Point,
} from "./model";

/** A building stamped into the shared floors at a world offset. */
export interface Site {
  id: string;
  name: string;
  /** World position of the site's local (0, 0) tile corner. */
  origin: Point;
  /** Floor indices this site occupies, ground storey first, contiguous. */
  floors: number[];
  /** Footprint in world coordinates (rows use world y; columns world x). */
  boundary: BuildingFootprint;
  /** Ascending stair marker per floor index (absent on the site's top floor). */
  stairs: Record<number, Point>;
  /** Descending stair marker / arrival per floor index (absent on its ground floor). */
  entry: Record<number, Point>;
  /** Id of the site's main gate furniture on its ground floor. */
  gate?: string;
  /**
   * The site's own floors exactly as generated, in its local coordinates
   * (add `origin` to place them). Rendering and lighting read the
   * building-specific parts (authored scene, environment, design, lighting
   * sectors, rooms) from here; the simulation uses the stamped shared floors.
   */
  localFloors?: Floor[];
}

/** World position of a point given in a site's local coordinates. */
export function toWorld(site: Pick<Site, "origin">, p: Point): Point {
  return { x: p.x + site.origin.x, y: p.y + site.origin.y };
}

/** A site's local position of a world point. */
export function toLocal(site: Pick<Site, "origin">, p: Point): Point {
  return { x: p.x - site.origin.x, y: p.y - site.origin.y };
}

/** The implicit start site's id. */
export const START_SITE = "start";

/** Tile columns of this floor's raster (W for every legacy floor). */
export function floorCols(f: Pick<Floor, "tiles">): number {
  return f.tiles?.[0]?.length ?? W;
}

/** Tile rows of this floor's raster (H for every legacy floor). */
export function floorRows(f: Pick<Floor, "tiles">): number {
  return f.tiles?.length ?? H;
}

/** True when a tile index lies inside this floor's raster. */
export function inRaster(f: Pick<Floor, "tiles">, x: number, y: number) {
  return x >= 0 && y >= 0 && y < floorRows(f) && x < floorCols(f);
}

/** The start building as a Site, derived from the floors' own fields. */
export function startSite(g: Pick<Game, "floors">): Site {
  const ground = g.floors[0];
  const stairs: Record<number, Point> = {};
  const entry: Record<number, Point> = {};
  for (const f of g.floors) {
    if (f.stairs && f.index < CONFIG.floors) stairs[f.index] = f.stairs;
    if (f.entry && f.index > 0) entry[f.index] = f.entry;
  }
  return {
    id: START_SITE,
    name: "start",
    origin: { x: 0, y: 0 },
    floors: g.floors
      .filter((f) => f.index <= CONFIG.floors)
      .map((f) => f.index),
    boundary: ground?.boundary as BuildingFootprint,
    stairs,
    entry,
    gate: ground?.furniture.some((o) => o.id === "main-gate")
      ? "main-gate"
      : undefined,
  };
}

/** Every site of the game, the start site first. */
export function sitesOf(g: Pick<Game, "floors" | "sites">): Site[] {
  return [startSite(g), ...(g.sites ?? [])];
}

/** Sites that have a storey on this floor. */
export function sitesOnFloor(
  g: Pick<Game, "floors" | "sites">,
  floor: number,
): Site[] {
  return sitesOf(g).filter((s) => s.floors.includes(floor));
}

/** The site's roof (top) floor index. */
export function roofFloorOf(site: Site): number {
  return site.floors[site.floors.length - 1] ?? 0;
}

/** The site whose footprint contains this point on this floor, if any. */
export function siteAt(
  g: Pick<Game, "floors" | "sites">,
  floor: number,
  p: Point,
): Site | undefined {
  for (const s of sitesOnFloor(g, floor)) {
    const b = s.boundary;
    if (!b) continue;
    // Footprint rows are indexed by absolute y (rows[y]), like `authoredBuilding`.
    const y = Math.floor(p.y);
    const span = y >= b.top && y < b.bottom ? b.rows?.[y] : undefined;
    if (span && p.x >= span.left && p.x < span.right) return s;
  }
  return undefined;
}

/** One stair marker on a floor: which site it belongs to and where it leads. */
export interface StairMarker {
  site: Site;
  direction: "up" | "down";
  at: Point;
}

/** Every stair marker on this floor, across all sites. */
export function stairMarkers(
  g: Pick<Game, "floors" | "sites">,
  floor: number,
): StairMarker[] {
  const out: StairMarker[] = [];
  for (const site of sitesOnFloor(g, floor)) {
    const up = site.stairs[floor];
    const down = site.entry[floor];
    if (up && floor < roofFloorOf(site))
      out.push({ site, direction: "up", at: up });
    if (down && floor > (site.floors[0] ?? 0))
      out.push({ site, direction: "down", at: down });
  }
  return out;
}
