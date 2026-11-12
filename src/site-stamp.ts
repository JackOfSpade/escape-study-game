/**
 * Stamping a second building into the shared floors
 * (docs/ESCAPE_REDESIGN.md section 16, phase 2).
 *
 * Floors are z-layers of one continuous x/y space. `stampSite` translates a
 * separately generated building (`source`) east of everything already present
 * and writes its storeys into the matching shared floors, tagging every copied
 * id with the site prefix so the start building's data stays untouched.
 */
import { terrainCityPlan } from "./city-layout";
import type { BuildingFootprint, Floor, Game, Point } from "./model";
import {
  START_SITE,
  floorCols,
  floorRows,
  siteAt,
  sitesOf,
  type Site,
} from "./site";

export interface StampOptions {
  id: string;
  name: string;
  origin: Point;
  /** Replace the outdoor plan with walkable open ground (default true). */
  terrain?: boolean;
}

function footprintRight(b: BuildingFootprint | undefined): number | undefined {
  if (!b) return undefined;
  let right = -Infinity;
  for (let y = b.top; y < b.bottom; y++) {
    const row = b.rows[y];
    if (row) right = Math.max(right, row.right);
  }
  return Number.isFinite(right) ? right : undefined;
}

/** East of every site's footprint, with a twelve-tile yard in between. */
export function nextSiteOrigin(g: Game): Point {
  let right = 0;
  for (const site of sitesOf(g)) {
    const edge = footprintRight(site.boundary);
    if (edge !== undefined) right = Math.max(right, edge);
  }
  return { x: Math.floor(right) + 12, y: 0 };
}

/** Grow a floor's raster towards the south-east, filling new cells with walls. */
function grow(f: Floor, cols: number, rows: number) {
  for (const row of f.tiles)
    for (let x = row.length; x < cols; x++) row.push(1);
  while (f.tiles.length < rows) f.tiles.push(new Array(cols).fill(1));
}

function shifted<T extends Point | undefined>(p: T, o: Point): T {
  return p ? ({ ...p, x: p.x + o.x, y: p.y + o.y } as T) : p;
}

/** Write one generated building into `g`'s shared floors and register it. */
export function stampSite(g: Game, source: Game, opts: StampOptions): Site {
  const { id, origin } = opts;
  const prefix = (value: string) => `${id}:${value}`;
  const floors: number[] = [],
    stairs: Record<number, Point> = {},
    entry: Record<number, Point> = {};
  for (const f of g.floors) {
    const s = source.floors.find((x) => x.index === f.index);
    // Only floors that exist on both sides carry a stamped storey.
    if (!s) continue;
    floors.push(f.index);
    grow(
      f,
      Math.max(floorCols(f), origin.x + floorCols(s)),
      Math.max(floorRows(f), origin.y + floorRows(s)),
    );
    for (let y = 0; y < floorRows(s); y++) {
      const row = s.tiles[y];
      if (!row) continue;
      for (let x = 0; x < floorCols(s); x++)
        f.tiles[y + origin.y][x + origin.x] = row[x] ?? 1;
    }
    for (const item of s.furniture) {
      const o = structuredClone(item);
      o.id = prefix(item.id);
      o.site = id;
      o.x = item.x + origin.x;
      o.y = item.y + origin.y;
      if (o.initial)
        o.initial = {
          ...o.initial,
          x: o.initial.x + origin.x,
          y: o.initial.y + origin.y,
        };
      if (o.door) {
        const frame = shifted(o.door.frame, origin);
        if (frame) o.door.frame = frame;
        const hinge = shifted(o.door.hinge, origin);
        if (hinge) o.door.hinge = hinge;
      }
      f.furniture.push(o);
    }
    for (const item of s.stations ?? []) {
      const st = structuredClone(item);
      st.id = prefix(item.id);
      st.site = id;
      st.x = item.x + origin.x;
      st.y = item.y + origin.y;
      const from = item.encounter;
      if (from) {
        const encounter = source.encounters?.[from];
        const copy = structuredClone(
          encounter ?? ({} as (typeof source.encounters)[string]),
        ) as (typeof source.encounters)[string] & { id?: string };
        copy.id = prefix(from);
        g.encounters[prefix(from)] = copy;
        st.encounter = prefix(from);
      }
      f.stations = [...(f.stations ?? []), st];
    }
    for (const p of s.doors ?? [])
      f.doors.push({ ...p, x: p.x + origin.x, y: p.y + origin.y });
    const up = shifted(s.stairs, origin);
    if (up) stairs[f.index] = up;
    const down = shifted(s.entry, origin);
    if (down) entry[f.index] = down;
  }
  const ground = source.floors[0];
  if (!ground?.boundary)
    throw Error(`Site ${id} needs a ground-floor footprint to stamp`);
  const shell = ground.boundary,
    rows: BuildingFootprint["rows"] = new Array(
      shell.rows.length + Math.max(0, Math.trunc(origin.y)),
    );
  for (let y = 0; y < shell.rows.length; y++) {
    const row = shell.rows[y];
    if (!row) continue;
    rows[y + origin.y] = {
      ...row,
      left: row.left + origin.x,
      right: row.right + origin.x,
    };
  }
  const boundary: BuildingFootprint = {
    ...shell,
    top: shell.top + origin.y,
    bottom: shell.bottom + origin.y,
    rows,
  };
  const site: Site = {
    id,
    name: opts.name,
    origin: { ...origin },
    floors,
    boundary,
    stairs,
    entry,
    gate: ground.furniture.some((o) => o.id === "main-gate")
      ? prefix("main-gate")
      : undefined,
    localFloors: structuredClone(source.floors),
  };
  g.sites = [...(g.sites ?? []), site];
  for (const index of floors) {
    const f = g.floors.find((x) => x.index === index);
    if (!f) continue;
    f.shells = [
      ...(f.shells ?? []),
      { site: id, boundary, origin: { ...origin } },
    ];
  }
  stampSurvivors(g, source, floors, origin, prefix, id);
  if (opts.terrain ?? true) {
    const groundFloor = g.floors.find((f) => f.index === 0);
    if (groundFloor) groundFloor.city = terrainCityPlan(g);
  }
  return site;
}

/** Copy the source's NPC survivors into the shared world, translated. */
function stampSurvivors(
  g: Game,
  source: Game,
  floors: number[],
  origin: Point,
  prefix: (value: string) => string,
  home: string,
) {
  for (const a of source.survivors ?? []) {
    if (a.id === "human" || !floors.includes(a.floor)) continue;
    const copy = structuredClone(a);
    copy.id = prefix(a.id);
    // People copied into a stamped building live and work in that building.
    copy.home = home;
    copy.x = a.x + origin.x;
    copy.y = a.y + origin.y;
    copy.path = [];
    copy.repath = 0;
    if (copy.station) copy.station = prefix(copy.station);
    // A copied task or terminal must resolve inside its own building.
    if (copy.intent && source.encounters[copy.intent])
      copy.intent = prefix(copy.intent);
    if (copy.taskSearch?.station)
      copy.taskSearch.station = prefix(copy.taskSearch.station);
    g.survivors.push(copy);
  }
}

/** The site a person lives and works in (absent home = the start building). */
export function homeSite(
  g: Pick<Game, "floors" | "sites">,
  a: { home?: string },
): Site | undefined {
  const id = a.home ?? START_SITE;
  return sitesOf(g).find((s) => s.id === id);
}

/** The station list a person may use: only its own building's stations. */
export function stationAtHome(
  a: { home?: string },
  s: { site?: string },
): boolean {
  return (s.site ?? START_SITE) === (a.home ?? START_SITE);
}

/** Raster-aligned bounds of a footprint, for bounded cell searches. */
export function footprintBounds(boundary: BuildingFootprint) {
  let left = Infinity,
    right = -Infinity;
  for (let y = boundary.top; y < boundary.bottom; y++) {
    const row = boundary.rows?.[y];
    if (!row) continue;
    left = Math.min(left, row.left);
    right = Math.max(right, row.right);
  }
  return Number.isFinite(left)
    ? { left, right, top: boundary.top, bottom: boundary.bottom }
    : undefined;
}

/** True when a world point lies inside a site's footprint (rows use absolute y). */
export function inFootprint(site: Site, p: Point) {
  const b = site.boundary,
    row = Math.floor(p.y);
  const span = row >= b.top && row < b.bottom ? b.rows?.[row] : undefined;
  return !!span && p.x >= span.left && p.x < span.right;
}

/** Tile radius of the yard a person may use just outside its own gate. */
export const GATE_APRON = 2;

/** The region one person may explore on a floor: its home site's footprint,
 * plus, while it stands outdoors, a short apron outside its own gate. */
export interface HomeArea {
  site: Site;
  floor: number;
  /** Footprint bounds in world tiles, for bounded cell searches. */
  bounds: { left: number; right: number; top: number; bottom: number };
  /** The person stands outside its home building right now. */
  outside: boolean;
  /** Centre of the home gate, on the floor where that gate stands. */
  gate?: Point;
}

/** Centre of a site's main gate on `floor`, when the gate stands there. */
function gatePoint(
  g: Pick<Game, "floors">,
  site: Site,
  floor: number,
): Point | undefined {
  if (!site.gate || floor !== (site.floors[0] ?? 0)) return undefined;
  const gate = g.floors
    .find((f) => f.index === floor)
    ?.furniture.find((o) => o.id === site.gate);
  return gate ? { x: gate.x + gate.w / 2, y: gate.y + gate.h / 2 } : undefined;
}

/** Where a person may roam on its floor, or undefined when its home has no
 * storey there (multi-site worlds only; the engine ignores it otherwise). */
export function homeArea(
  g: Pick<Game, "floors" | "sites">,
  a: { home?: string; floor: number; x: number; y: number },
): HomeArea | undefined {
  const site = homeSite(g, a),
    b = site?.boundary;
  if (!site || !b || !site.floors.includes(a.floor)) return undefined;
  const bounds = footprintBounds(b);
  if (!bounds) return undefined;
  return {
    site,
    floor: a.floor,
    bounds,
    outside: !inFootprint(site, a),
    gate: gatePoint(g, site, a.floor),
  };
}

/** True when a point belongs to the area: inside the home footprint, or in the
 * apron outside its own gate, and never inside another site. */
export function inHomeArea(
  g: Pick<Game, "floors" | "sites">,
  area: HomeArea,
  p: Point,
): boolean {
  const owner = siteAt(g, area.floor, p);
  if (owner) return owner.id === area.site.id;
  return (
    area.outside &&
    !!area.gate &&
    Math.abs(p.x - area.gate.x) <= GATE_APRON &&
    Math.abs(p.y - area.gate.y) <= GATE_APRON
  );
}
