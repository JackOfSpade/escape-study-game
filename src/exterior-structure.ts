import { interiorHash } from "./interior-lighting";
import { type BuildingFootprint, type Game, type Point } from "./model";
import { START_SITE, roofFloorOf, sitesOf, startSite, type Site } from "./site";
import {
  buildStairRoute,
  cityStairBase,
  FLOOR_HEIGHT,
  STAIR_ROUTE_WIDTH,
} from "./stair-route";

/** Deck slabs and treads are 20 cm thick; flights rise in twenty treads. */
export const DECK_THICKNESS = 0.2;
export const DECK_WIDTH = STAIR_ROUTE_WIDTH + 0.12;
export const FLIGHT_STEPS = 20;
/** Glass guards stand at this lateral offset from the walking line. */
export const GUARD_OFFSET = 0.81;
/** Top of the handrail above the deck surface at the guard. */
export const GUARD_HEIGHT = 1.17;
export const LANDING_SIZE = 1.9;
export const COLUMN_SIZE = 0.2;

/** An oriented walking slab: a level deck, a corner landing or a flight. */
export interface Slab {
  /** Centre and unit direction of the run, in simulation x/y. */
  x: number;
  y: number;
  ux: number;
  uy: number;
  /** Half length along the run, half width across it. */
  halfLength: number;
  halfWidth: number;
  /** Walking surface at the start of the run, and the rise over the run. */
  top: number;
  rise: number;
  steps: number;
  /** The ground flight is filled by its concrete foundation down to 0. */
  solidToGround: boolean;
  level: number;
  segment: number;
  color: string;
}

/** One guard bay between two posts; `broken` bays have lost glass and rail. */
export interface GuardBay {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Deck surface at each end of the bay. */
  base1: number;
  base2: number;
  broken: boolean;
  /** Corner closures have no posts of their own. */
  corner: boolean;
  level: number;
}

export interface Column extends Point {
  top: number;
}

export interface ExteriorStructure {
  slabs: Slab[];
  guards: GuardBay[];
  columns: Column[];
}

/** Surface height of a slab at a point inside its footprint. */
export function slabTop(s: Slab, p: Point) {
  if (!s.rise) return s.top;
  const along = (p.x - s.x) * s.ux + (p.y - s.y) * s.uy,
    u = Math.max(0, Math.min(1, (along + s.halfLength) / (s.halfLength * 2))),
    tread = Math.min(s.steps - 1, Math.floor(u * s.steps));
  return s.top + (s.rise * (tread + 1)) / s.steps;
}

/** Signed distances of a point from the slab centre, along and across. */
export function slabLocal(s: Slab, p: Point) {
  const dx = p.x - s.x,
    dy = p.y - s.y;
  return {
    along: dx * s.ux + dy * s.uy,
    across: -dx * s.uy + dy * s.ux,
  };
}

const cache = new WeakMap<
  Game,
  { key: string; structure: ExteriorStructure }
>();

function structureKey(g: Game) {
  return JSON.stringify([
    g.seed,
    g.floors.map((f) => [
      f.boundary?.top,
      f.boundary?.bottom,
      f.stairs,
      f.entry,
      f.design?.brokenGuard,
    ]),
    g.sites?.map((site) => [
      site.id,
      site.origin,
      site.floors,
      site.boundary,
      site.stairs,
      site.entry,
    ]),
    !!g.floors[0]?.city,
  ]);
}

/** The exterior emergency stair and galleries as physical geometry. The
 * renderer draws exactly these slabs, guard bays and columns, and the
 * player's elevated body collides with exactly these too. */
export function exteriorStructure(g: Game): ExteriorStructure {
  const key = structureKey(g),
    hit = cache.get(g);
  if (hit?.key === key) return hit.structure;
  const structure = buildStructure(g);
  cache.set(g, { key, structure });
  return structure;
}

interface StructureBuild {
  slabs: Slab[];
  guards: GuardBay[];
  columns: Map<string, Column>;
}

/** Every site's exterior stair and galleries, the start building first. */
function buildStructure(g: Game): ExteriorStructure {
  const out: StructureBuild = {
      slabs: [],
      guards: [],
      columns: new Map<string, Column>(),
    },
    start = startSite(g);
  if (!start.boundary) return { slabs: [], guards: [], columns: [] };
  // The start building bridges every consecutive pair of its floors; each
  // stamped site only the storeys below its own roof, from its own markers.
  buildSite(g, start, startLevels(g), out);
  for (const site of g.sites ?? [])
    buildSite(g, site, siteLevels(g, site), out);
  return {
    slabs: out.slabs,
    guards: out.guards,
    columns: [...out.columns.values()],
  };
}

/** The start building's levels, exactly the flights it has always built. */
function startLevels(g: Game) {
  const levels: number[] = [];
  for (let level = 0; level < g.floors.length - 1; level++) levels.push(level);
  return levels;
}

/** A stamped site's flights: below its roof, between its own two markers. */
function siteLevels(g: Game, site: Site) {
  const levels: number[] = [],
    roof = roofFloorOf(site);
  for (const level of site.floors)
    if (
      level < roof &&
      site.stairs[level] &&
      site.entry[level + 1] &&
      g.floors[level] &&
      g.floors[level + 1]
    )
      levels.push(level);
  return levels;
}

/** One site's stair slabs, guards and columns beside its own markers. */
function buildSite(g: Game, site: Site, levels: number[], out: StructureBuild) {
  const { slabs, guards, columns } = out;
  for (const level of levels) {
    const floor = g.floors[level],
      next = g.floors[level + 1],
      // A site's own markers; the start building keeps its floor fields.
      origin = site.stairs[level] ?? floor.stairs,
      destination = site.entry[level + 1] ?? next.entry,
      route = buildStairRoute(g, {
        fromFloor: level,
        toFloor: level + 1,
        site: site.id,
        origin,
        destination,
        until: 0,
      }),
      broken = brokenBay(g, level),
      // Only the start site's ground storey opens onto the public court.
      cityAccess = site.id === START_SITE && level === 0 && !!floor.city;
    for (let i = 0; i < route.points.length - 1; i++) {
      const a = route.points[i],
        b = route.points[i + 1],
        dx = b.x - a.x,
        dz = b.z - a.z,
        run = Math.hypot(dx, dz),
        rise = b.y - a.y,
        groundCourt = level === 0 && !!floor.city && a.y === 0 && rise === 0;
      if (run < 0.01) continue;
      const ux = dx / run,
        uy = dz / run,
        nx = -uy,
        ny = ux,
        previous = route.points[i - 1],
        following = route.points[i + 2],
        turnsAtStart =
          !!previous &&
          Math.abs((a.x - previous.x) * dz - (a.z - previous.z) * dx) > 0.01,
        turnsAtEnd =
          !!following &&
          Math.abs(dx * (following.z - b.z) - dz * (following.x - b.x)) > 0.01;
      // A corner landing owns its square; level decks stop at its edge.
      const start = !rise && turnsAtStart ? 0.95 : 0,
        end = !rise && turnsAtEnd ? run - 0.95 : run,
        mid = (start + end) / 2;
      slabs.push({
        x: a.x + ux * mid,
        y: a.z + uy * mid,
        ux,
        uy,
        halfLength: (end - start) / 2,
        halfWidth: DECK_WIDTH / 2,
        top: a.y,
        rise,
        steps: rise ? FLIGHT_STEPS : 1,
        solidToGround: !!rise && level === 0 && !!floor.city,
        level,
        segment: i,
        color: "#8e9b91",
      });
      // Flat landings leave open connections at each end.
      const guardStart = turnsAtStart ? Math.min(0.49, 0.96 / run) : 0,
        guardEnd = turnsAtEnd ? Math.max(0.51, 1 - 0.96 / run) : 1,
        sections = Math.max(
          1,
          Math.ceil((run * (guardEnd - guardStart)) / 1.5),
        );
      // The lowest flat walks are public court paving with no fence.
      if (!groundCourt)
        for (const side of [-1, 1])
          for (let j = 0; j < sections; j++) {
            const t1 = guardStart + ((guardEnd - guardStart) * j) / sections,
              t2 = guardStart + ((guardEnd - guardStart) * (j + 1)) / sections;
            guards.push({
              x1: a.x + dx * t1 + nx * side * GUARD_OFFSET,
              y1: a.z + dz * t1 + ny * side * GUARD_OFFSET,
              x2: a.x + dx * t2 + nx * side * GUARD_OFFSET,
              y2: a.z + dz * t2 + ny * side * GUARD_OFFSET,
              base1: a.y + rise * t1,
              base2: a.y + rise * t2,
              broken:
                !!broken &&
                broken.segment === i &&
                j === Math.min(broken.bay, sections - 1) &&
                side === outerSide(site, a, ux, uy),
              corner: false,
              level,
            });
          }
      if (turnsAtStart && previous) {
        slabs.push({
          x: a.x,
          y: a.z,
          ux: 1,
          uy: 0,
          halfLength: LANDING_SIZE / 2,
          halfWidth: LANDING_SIZE / 2,
          top: a.y,
          rise: 0,
          steps: 1,
          solidToGround: false,
          level,
          segment: i,
          color: "#87988e",
        });
        // The two sides without a passage close the outside corner.
        const prevRun = Math.hypot(a.x - previous.x, a.z - previous.z),
          closed = [
            {
              x: (a.x - previous.x) / prevRun,
              y: (a.z - previous.z) / prevRun,
            },
            { x: -ux, y: -uy },
          ];
        for (const side of closed) {
          if (groundCourt) continue;
          // Ground-level city access is a real third opening on this landing.
          if (cityAccess && i === 2 && side.y < -0.5) continue;
          const groundFlight = cityAccess && i === 2,
            length = groundFlight ? 0.9 : 1.85,
            cx = a.x + side.x * 0.9,
            cy = a.z + side.y * 0.9 + (groundFlight ? 0.45 : 0),
            tx = -side.y,
            ty = side.x;
          guards.push({
            x1: cx - (tx * length) / 2,
            y1: cy - (ty * length) / 2,
            x2: cx + (tx * length) / 2,
            y2: cy + (ty * length) / 2,
            base1: a.y,
            base2: a.y,
            broken: false,
            corner: true,
            level,
          });
        }
      }
    }
    // Columns stand at the outside edge under the east corners.
    for (const p of [route.points[2], route.points[4]]) {
      const x = p.x + 0.98,
        top = p.y - DECK_THICKNESS,
        id = `${x}/${p.z}`;
      if (top > 0 && top > (columns.get(id)?.top ?? 0))
        columns.set(id, { x, y: p.z, top });
    }
  }
}

/** Horizontal centre of a site's footprint: (min left + max right) / 2. */
export function footprintCentreX(b?: BuildingFootprint) {
  let left = Infinity,
    right = -Infinity;
  for (const row of b?.rows ?? [])
    if (row) {
      left = Math.min(left, row.left);
      right = Math.max(right, row.right);
    }
  return Number.isFinite(left) && Number.isFinite(right)
    ? (left + right) / 2
    : 22;
}

/** The side of a gallery segment facing away from its own building. */
function outerSide(
  site: Site,
  a: { x: number; z: number },
  ux: number,
  uy: number,
) {
  const b = site.boundary,
    cx = footprintCentreX(b),
    cy = b ? (b.top + b.bottom) / 2 : a.z;
  return (a.x - cx) * -uy + (a.z - cy) * ux > 0 ? 1 : -1;
}

/** Every raised gallery has one storm-damaged guard bay on its outer side,
 * chosen per run: the glass and rail are gone and the edge is open. */
function brokenBay(g: Game, level: number) {
  if (level === 0 && !g.floors[0]?.boundary) return undefined;
  const authored = g.floors[level]?.design?.brokenGuard;
  if (authored) return authored;
  const roll = interiorHash(g.seed, level, "broken-guard");
  // Segment 3 is the long level east walk, 4 the south gallery.
  return { segment: 3 + (roll % 2), bay: 1 + ((roll >>> 3) % 2) };
}

export { FLOOR_HEIGHT };

/** Shared field planes: direction is the prohibited crossing along axis.
 * A descending survivor can always return through the same visible portal. */
export interface StairAccessPortal extends Point {
  kind: "well" | "city-base" | "city-base-side";
  axis: "x" | "y";
  floor: number;
  width: number;
  base: number;
  height: number;
  direction: -1 | 1;
}

export function stairAccessPortals(g: Game): StairAccessPortal[] {
  const portals: StairAccessPortal[] = [];
  for (const site of sitesOf(g))
    for (const index of site.floors) {
      const at = site.stairs[index],
        floor = g.floors[index];
      // A portal exists only below this site's own roof, never on it.
      if (
        !at ||
        !floor ||
        index >= roofFloorOf(site) ||
        index >= g.floors.length - 1
      )
        continue;
      // The start building opens its well only for a real floor footprint.
      if (site.id === START_SITE && !floor.boundary) continue;
      portals.push({
        kind: "well",
        axis: "y",
        floor: index,
        x: at.x,
        y: at.y - 1,
        width: 2,
        base: index * FLOOR_HEIGHT,
        height: 2.8,
        direction: -1,
      });
    }
  const base = cityStairBase(g);
  if (base)
    portals.push(
      {
        kind: "city-base",
        axis: "y",
        floor: 0,
        ...base.start,
        width: base.w,
        base: 0,
        height: 2.8,
        direction: 1,
      },
      {
        // The corner joins the public court on its west side too. Cover that
        // return visibly, so jumping through the side cannot evade access.
        kind: "city-base-side",
        axis: "x",
        floor: 0,
        x: base.start.x - DECK_WIDTH / 2,
        y: base.start.y + 0.48,
        width: 0.96,
        base: 0,
        height: 2.8,
        direction: 1,
      },
    );
  return portals;
}
