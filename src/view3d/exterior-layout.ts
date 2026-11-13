import type { BuildingFootprint, Floor, Point } from "../model";

export interface StreetProp extends Point {
  kind: "car" | "streetlight" | "cone" | "debris";
  w: number;
  h: number;
}
export interface StreetLayout {
  front: number;
  left: number;
  right: number;
  entrance: number;
  props: StreetProp[];
}

/** Whether a world cell lies inside one building footprint. */
export function footprintContains(b: BuildingFootprint, x: number, y: number) {
  if (y < b.top || y >= b.bottom) return false;
  const row = b.rows[Math.floor(y)];
  return !!row && x >= row.left && x < row.right;
}

/** Every real building on one storey: the start building, then stamped sites. */
export function siteFootprints(
  floor: Pick<Floor, "boundary" | "shells">,
): BuildingFootprint[] {
  const out: BuildingFootprint[] = [];
  if (floor.boundary) out.push(floor.boundary);
  for (const shell of floor.shells ?? [])
    if (shell.boundary && !out.includes(shell.boundary))
      out.push(shell.boundary);
  return out;
}

/** The start building's ground footprint followed by every shell stamped onto
 * floors 0..n. A game without shells yields exactly the old single footprint. */
export function shellFootprints(floors: readonly Floor[]): BuildingFootprint[] {
  const out: BuildingFootprint[] = [],
    ground = floors[0]?.boundary;
  if (ground) out.push(ground);
  for (const floor of floors)
    for (const shell of floor.shells ?? [])
      if (shell.boundary && !out.includes(shell.boundary))
        out.push(shell.boundary);
  return out;
}

/** The footprint is authoritative; exterior scenery never edits the physics
 * grid. The extra tile is the solid shell immediately outside the mask. */
export function outsideBuilding(floor: Floor, x: number, y: number) {
  const sites = siteFootprints(floor);
  if (!sites.length) return false;
  return !sites.some((b) => footprintContains(b, x, y));
}

/** All central outside cells are reserved, including the full survivor arrival
 * queue. Decoration may occupy only blocked cells immediately beyond the lane. This
 * deliberately reserves more space than a single shortest entrance path. */
export function clearStreetEdge(
  floor: Floor,
  prop: Pick<StreetProp, "x" | "y" | "w" | "h">,
) {
  const b = floor.boundary;
  if (
    !b ||
    floor.index !== 0 ||
    prop.w <= 0 ||
    prop.h <= 0 ||
    !Number.isFinite(prop.x) ||
    !Number.isFinite(prop.y) ||
    !Number.isFinite(prop.w) ||
    !Number.isFinite(prop.h)
  )
    return false;
  const x0 = Math.floor(prop.x - prop.w / 2 + 1e-7),
    x1 = Math.floor(prop.x + prop.w / 2 - 1e-7),
    y0 = Math.floor(prop.y - prop.h / 2 + 1e-7),
    y1 = Math.floor(prop.y + prop.h / 2 - 1e-7);
  for (let y = y0; y <= y1; y++) {
    if (y <= b.bottom) return false;
    const row = floor.tiles[y];
    if (!row) return false;
    let left = -1,
      right = -1;
    for (let x = 0; x < row.length; x++)
      if (row[x] === 0 && outsideBuilding(floor, x + 0.5, y + 0.5)) {
        if (left < 0) left = x;
        right = x;
      }
    // Do not decorate a narrow portal or a disconnected open cell.
    if (right - left < 5) return false;
    for (let x = x0; x <= x1; x++)
      if (
        row[x] === undefined ||
        row[x] === 0 ||
        !outsideBuilding(floor, x + 0.5, y + 0.5) ||
        (x !== left - 1 && x !== right + 1)
      )
        return false;
  }
  return true;
}

export function streetLayout(floor: Floor): StreetLayout | undefined {
  const b = floor.boundary;
  if (!b || floor.index !== 0) return undefined;
  const front = b.bottom,
    shell = floor.tiles[front],
    row = floor.tiles[front + 1],
    outline = b.rows[front - 1];
  if (!shell || !row || !outline) return undefined;
  const entrance = floor.furniture.find((o) => o.id === "main-gate")?.x ?? 22;
  // Require a real continuous opening from the building into the outside lane.
  const ix = Math.floor(entrance);
  if (shell[ix] !== 0 || row[ix] !== 0) return undefined;
  const open = row.flatMap((tile, x) => (tile === 0 ? [x] : []));
  if (open.length < 6) return undefined;
  const left = open[0] + 0.5,
    right = open[open.length - 1] + 0.5,
    props: StreetProp[] = [];
  const add = (
    kind: StreetProp["kind"],
    x: number,
    y: number,
    w: number,
    h: number,
  ) => {
    const prop = { kind, x, y, w, h };
    if (clearStreetEdge(floor, prop)) props.push(prop);
  };
  for (const x of [left - 1, right + 1]) {
    add("streetlight", x, front + 1.55, 0.22, 0.22);
    add("car", x, front + 3.5, 0.88, 2.7);
    add("cone", x, front + 5.55, 0.26, 0.26);
    add("debris", x, front + 1.9, 0.45, 0.18);
  }
  return {
    front,
    left: outline.left - 1,
    right: outline.right + 1,
    entrance,
    props,
  };
}

/** Nonwalkable cells beyond the building used to become huge 2.8 m masses.
 * Keep the actual one-cell shell and internal walls. The street edge receives
 * visible guardrails in the dressing, where those solid cells still block play. */
export function exteriorWallTiles(floor: Floor) {
  if (!floor.boundary) return floor.tiles;
  const b = floor.boundary!;
  return floor.tiles.map((row, y) =>
    row.map((tile, x) => {
      if (!tile || !outsideBuilding(floor, x + 0.5, y + 0.5)) return tile;
      // Keep jambs beside the two carved well rows, but do not extend them
      // across the gallery outside either doorway. The walking motor owns
      // those outer landings; an extra cap would cut through its route.
      if (
        x >= 20 &&
        x <= 23 &&
        ((y < b.top && y >= b.top - 2) ||
          (floor.index > 0 && y >= b.bottom && y < b.bottom + 2))
      )
        return tile;
      for (let yy = y - 1; yy <= y + 1; yy++) {
        const edge = b.rows[yy];
        if (
          edge &&
          yy >= b.top &&
          yy < b.bottom &&
          x >= edge.left - 1 &&
          x <= edge.right
        )
          return tile;
      }
      return 0;
    }),
  );
}

export interface CityBlock extends Point {
  w: number;
  d: number;
  stories: number;
  color: string;
  damaged: boolean;
  distant: boolean;
}
export interface CityLayout {
  left: number;
  right: number;
  north: number;
  south: number;
  blocks: CityBlock[];
}

/** Fake lots keep clear of real buildings by this many tiles. */
export const SITE_MARGIN = 6;

export interface LotBox {
  x: number;
  /** Centre along the other horizontal axis; `z` is accepted too. */
  y?: number;
  z?: number;
  w: number;
  d?: number;
  h?: number;
}

/** The tile rectangle a footprint occupies. */
export function footprintBounds(b: BuildingFootprint) {
  let left = Infinity,
    right = -Infinity;
  for (let y = b.top; y < b.bottom; y++) {
    const row = b.rows[y];
    if (!row) continue;
    left = Math.min(left, row.left);
    right = Math.max(right, row.right);
  }
  return { left, right, top: b.top, bottom: b.bottom };
}

/** Whether a fake lot may stand: never over a site footprint plus margin. */
export function neighbourLotAllowed(
  lot: LotBox,
  sites: readonly BuildingFootprint[],
  margin = SITE_MARGIN,
) {
  const cx = lot.x,
    cz = lot.y ?? lot.z ?? 0,
    w = lot.w,
    d = lot.d ?? lot.h ?? w;
  if (!(w > 0) || !(d > 0) || !Number.isFinite(cx) || !Number.isFinite(cz))
    return false;
  return !sites.some((b) => {
    const f = footprintBounds(b);
    return (
      f.right > f.left &&
      f.bottom > f.top &&
      cx + w / 2 > f.left - margin &&
      cx - w / 2 < f.right + margin &&
      cz + d / 2 > f.top - margin &&
      cz - d / 2 < f.bottom + margin
    );
  });
}

/** Everything the outside must follow, including every stamped shell, so
 * stamping a site rebuilds the dressing exactly once. */
export function exteriorSignature(floors: readonly Floor[]) {
  return JSON.stringify([
    shellFootprints(floors),
    floors.map((f) =>
      f.city ? [f.city.version, f.city.seed, f.city.bounds] : null,
    ),
  ]);
}

/** Unreachable outer districts sit wholly beyond the solid playable city.
 * A fixed silhouette budget closes rooftop sightlines without inventing
 * decorative blocks on the real invasion streets. */
export function cityBackdrop(floor: Floor): CityBlock[] {
  const city = floor.city;
  if (!city) return [];
  const b = city.bounds,
    skyline = floor.exteriorDesign?.skyline,
    blocks: CityBlock[] = [];
  let state = (city.seed ^ 0x736b796c) >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let side = 0; side < 4; side++)
    for (let i = 0; i < 16; i++) {
      const horizontal = side < 2,
        from = (horizontal ? b.left : b.top) - 80,
        to = (horizontal ? b.right : b.bottom) + 80,
        step = (to - from) / 16,
        along = from + step * (i + 0.5) + (random() - 0.5) * step * 0.2,
        frontage = step * (0.82 + random() * 0.22),
        depth = 18 + random() * 16,
        distance = 80 + random() * 24;
      blocks.push({
        x: horizontal
          ? along
          : side === 2
            ? b.left - distance - depth / 2
            : b.right + distance + depth / 2,
        y: horizontal
          ? side === 0
            ? b.top - distance - depth / 2
            : b.bottom + distance + depth / 2
          : along,
        w: horizontal ? frontage : depth,
        d: horizontal ? depth : frontage,
        stories: skyline
          ? (skyline.minHeight +
              random() * (skyline.maxHeight - skyline.minHeight)) /
            3.15
          : 9 + Math.floor(random() * 20),
        color: ["#354653", "#3f4d55", "#39444c"][i % 3],
        damaged: random() < (skyline?.damageRate ?? 0.3),
        distant: true,
      });
    }
  // Decorative lots never cover or crowd a real site, including stamped ones.
  const sites = siteFootprints(floor);
  return blocks.filter((block) => neighbourLotAllowed(block, sites));
}

/** One stable city shared by every storey. Layout is derived only from the
 * building footprint, never actor state or the simulation random stream. */
export function cityLayout(floor: Floor): CityLayout | undefined {
  const b = floor.boundary;
  if (!b) return undefined;
  const rows = b.rows.slice(b.top, b.bottom),
    left = Math.min(...rows.map((r) => r.left)) - 1,
    right = Math.max(...rows.map((r) => r.right)) + 1,
    north = b.top - 3,
    south = b.bottom + 3;
  if (floor.city) {
    return {
      left,
      right,
      north,
      south,
      blocks: floor.city.obstacles
        .filter(
          (o) =>
            o.kind === "building" &&
            neighbourLotAllowed(
              { x: o.x, y: o.y, w: o.w, d: o.h },
              siteFootprints(floor),
            ),
        )
        .map((o) => ({
          x: o.x,
          y: o.y,
          w: o.w,
          d: o.h,
          stories: Math.max(3, Math.round(o.height / 3.15)),
          color: o.color,
          damaged: o.damaged,
          distant: Math.hypot(o.x - 22, o.y - 16) > 100,
        })),
    };
  }
  const blocks: CityBlock[] = [],
    colors = ["#52616a", "#5e6260", "#514e48", "#687078", "#615754"];
  const add = (
    x: number,
    y: number,
    w: number,
    d: number,
    index: number,
    distant = false,
  ) => {
    blocks.push({
      x,
      y,
      w,
      d,
      stories: distant ? 8 + ((index * 7) % 16) : 3 + ((index * 5) % 8),
      color: colors[index % colors.length],
      damaged: index % 5 === 1,
      distant,
    });
  };
  // The near blocks face a continuous road and sidewalk around the entire
  // building. All are beyond the simulation grid, including the arrival lane.
  for (let i = 0; i < 4; i++) {
    const x = left - 8 + i * 18;
    add(x, north - 20, 12 + (i % 2) * 2, 11, i);
    add(x + 3, south + 21, 13, 12, i + 4);
  }
  for (let i = 0; i < 3; i++) {
    const z = north - 3 + i * 19;
    add(left - 20, z, 11, 13, i + 8);
    add(right + 20, z + 3, 12, 14, i + 11);
  }
  // A second skyline layer closes diagonal sight lines above and between the
  // near blocks; its detail budget is silhouettes and rooftop plant only.
  for (let i = 0; i < 24; i++) {
    const angle = (i / 24) * Math.PI * 2,
      radius = 82 + (i % 3) * 9;
    add(
      22 + Math.cos(angle) * radius,
      16 + Math.sin(angle) * radius,
      10 + (i % 4) * 2,
      10 + (i % 3) * 3,
      i + 17,
      true,
    );
  }
  // Real buildings keep a clear margin; fake blocks never crowd a stamped site.
  const sites = siteFootprints(floor);
  return {
    left,
    right,
    north,
    south,
    blocks: blocks.filter((block) => neighbourLotAllowed(block, sites)),
  };
}

export interface CityGroundRectangle {
  x: number;
  z: number;
  w: number;
  d: number;
}

/** How far the ground runs past the city bounds: to the horizon, except
 * where a drawn outdoors ends at the sea, whose shore is the bounds edge. */
function groundReach(floor: Floor) {
  return floor.city?.source === "authored" &&
    floor.setting?.outdoors?.backdrop === "sea"
    ? 0
    : 700;
}

/** The city owns the ground outside the real footprint. Cutting out the whole
 * footprint avoids a second nearly coplanar asphalt layer under room floors.
 * Consecutive identical edges share a rectangle; there are no overlapping tops.
 */
export function cityGroundRectangles(floor: Floor): CityGroundRectangle[] {
  const b = floor.boundary;
  if (!b) return [];
  // An open site has no shell covering its ground, so the outdoor ground
  // texture continues underneath it; only stamped shells are still cut out.
  if (floor.open === true) return multiSiteGround(floor, undefined);
  if (floor.shells?.length) return multiSiteGround(floor, b);
  const minX = floor.city ? floor.city.bounds.left - groundReach(floor) : -118,
    maxX = floor.city ? floor.city.bounds.right + groundReach(floor) : 162,
    minZ = floor.city ? floor.city.bounds.top - groundReach(floor) : -124,
    maxZ = floor.city ? floor.city.bounds.bottom + groundReach(floor) : 156,
    rectangles: CityGroundRectangle[] = [
      {
        x: (minX + maxX) / 2,
        z: (minZ + b.top) / 2,
        w: maxX - minX,
        d: b.top - minZ,
      },
      {
        x: (minX + maxX) / 2,
        z: (b.bottom + maxZ) / 2,
        w: maxX - minX,
        d: maxZ - b.bottom,
      },
    ];
  for (const side of ["left", "right"] as const) {
    let start = b.top;
    while (start < b.bottom) {
      const edge = b.rows[start][side];
      let end = start + 1;
      while (end < b.bottom && b.rows[end][side] === edge) end++;
      const from = side === "left" ? minX : edge,
        to = side === "left" ? edge : maxX;
      rectangles.push({
        x: (from + to) / 2,
        z: (start + end) / 2,
        w: to - from,
        d: end - start,
      });
      start = end;
    }
  }
  return rectangles;
}

/**
 * Ground with several buildings: every footprint (the start building and each
 * stamped shell) is cut out row by row, and consecutive rows with the same
 * free intervals share one rectangle, so no asphalt lies under any room floor.
 */
function multiSiteGround(
  floor: Floor,
  start: NonNullable<Floor["boundary"]> | undefined,
): CityGroundRectangle[] {
  // An open site passes no start footprint: its ground belongs to the city.
  const prints = [
    ...(start ? [start] : []),
    ...(floor.shells ?? []).map((s) => s.boundary),
  ];
  const minX = floor.city ? floor.city.bounds.left - groundReach(floor) : -118,
    maxX = floor.city ? floor.city.bounds.right + groundReach(floor) : 162,
    minZ = floor.city ? floor.city.bounds.top - groundReach(floor) : -124,
    maxZ = floor.city ? floor.city.bounds.bottom + groundReach(floor) : 156,
    top = prints.length ? Math.min(...prints.map((p) => p.top)) : minZ,
    bottom = prints.length ? Math.max(...prints.map((p) => p.bottom)) : maxZ,
    out: CityGroundRectangle[] = [
      {
        x: (minX + maxX) / 2,
        z: (minZ + top) / 2,
        w: maxX - minX,
        d: top - minZ,
      },
      {
        x: (minX + maxX) / 2,
        z: (bottom + maxZ) / 2,
        w: maxX - minX,
        d: maxZ - bottom,
      },
    ];
  const free = (y: number) => {
    const cuts = prints
      .filter((p) => y >= p.top && y < p.bottom && p.rows[y])
      .map((p) => [p.rows[y].left, p.rows[y].right] as const)
      .sort((a, c) => a[0] - c[0]);
    const spans: [number, number][] = [];
    let x = minX;
    for (const [l, r] of cuts) {
      if (l > x) spans.push([x, l]);
      x = Math.max(x, r);
    }
    if (x < maxX) spans.push([x, maxX]);
    return spans;
  };
  let y = top;
  while (y < bottom) {
    const spans = free(y),
      key = JSON.stringify(spans);
    let end = y + 1;
    while (end < bottom && JSON.stringify(free(end)) === key) end++;
    for (const [from, to] of spans)
      out.push({
        x: (from + to) / 2,
        z: (y + end) / 2,
        w: to - from,
        d: end - y,
      });
    y = end;
  }
  return out;
}

/** Grounds that carry streets, lamp posts and parked cars. Every other ground
 * gets theme-neutral clutter instead. */
export function roadGround(ground?: string) {
  return (
    !ground || ground === "asphalt" || ground === "cobble" || ground === "tile"
  );
}

/** The designed surroundings of the ground floor, if any. */
export function surroundingsOf(floor: Floor) {
  return floor.setting?.surroundings;
}

/** A visual-only plot cut into the face of a solid lot. The lot keeps its
 * footprint and collision; the plot only changes what its outer rim looks
 * like, and a raised bed there carries one scenery object. */
export interface SceneryPad {
  id: string;
  /** Centre of the pad, in world units. */
  x: number;
  z: number;
  w: number;
  d: number;
  /** Turn of the object about the vertical, in radians. */
  angle: number;
}

/** Pad dimensions: along the lot face, and into the lot. */
export const SCENERY_PAD = { along: 10, into: 7 } as const;
/** Nothing is placed within this distance of the arrival queue or a spawn. */
const ENTRANCE_CLEARANCE = 16;
const SPAWN_CLEARANCE = 14;

interface Lot {
  x: number;
  y: number;
  w: number;
  h: number;
}

function sceneryHash(seed: number, n: number) {
  let v = Math.imul((seed ^ 0x2545f491) + n * 0x9e3779b1, 0x45d9f3b);
  v = Math.imul(v ^ (v >>> 16), 0x45d9f3b);
  return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
}

/** Where the scenery stands. Pads sit inside solid lots near the building,
 * inset from the lot's road face, so they never overlap a road, the entrance
 * lane or a spawn approach, and are chosen from the city seed alone (never the
 * simulation random stream). The same inputs always give the same pads. */
export function sceneryPads(
  floor: Floor,
  ids: readonly string[],
  perId = 3,
): SceneryPad[] {
  const b = floor.boundary;
  if (!b || !ids.length) return [];
  const want = Math.min(24, ids.length * perId),
    seed = floor.city?.seed ?? 1 + b.top * 31 + b.bottom,
    lots: Lot[] = floor.city
      ? floor.city.obstacles
          .filter(
            (o) =>
              o.kind === "building" &&
              neighbourLotAllowed(
                { x: o.x, y: o.y, w: o.w, d: o.h },
                siteFootprints(floor),
              ),
          )
          .map((o) => ({ x: o.x, y: o.y, w: o.w, h: o.h }))
      : (cityLayout(floor)?.blocks ?? [])
          .filter((blk) => !blk.distant)
          .map((blk) => ({ x: blk.x, y: blk.y, w: blk.w, h: blk.d })),
    roads = floor.city?.roads ?? [],
    spawns = floor.city?.approaches.flatMap((a) => a.points) ?? [],
    entrance = floor.furniture.find((o) => o.id === "main-gate")?.x ?? 22,
    front = b.bottom,
    footprint = {
      left: Math.min(...b.rows.slice(b.top, b.bottom).map((r) => r.left)),
      right: Math.max(...b.rows.slice(b.top, b.bottom).map((r) => r.right)),
    };
  const candidates: (SceneryPad & { rank: number })[] = [];
  let index = 0;
  for (const lot of lots) {
    if (Math.min(lot.w, lot.h) < 8) continue;
    for (const side of [0, 1, 2, 3]) {
      const alongX = side < 2,
        sign = side % 2 ? 1 : -1,
        length = alongX ? lot.w : lot.h,
        into = Math.min(SCENERY_PAD.into, (alongX ? lot.h : lot.w) / 2),
        slots = Math.max(
          0,
          Math.floor((length - SCENERY_PAD.along) / (SCENERY_PAD.along + 4)) +
            1,
        );
      for (let s = 0; s < slots; s++) {
        const along =
          slots === 1
            ? 0
            : -length / 2 +
              SCENERY_PAD.along / 2 +
              (s * (length - SCENERY_PAD.along)) / (slots - 1);
        const x = alongX
            ? lot.x + along
            : lot.x + sign * (lot.w / 2 - into / 2),
          z = alongX ? lot.y + sign * (lot.h / 2 - into / 2) : lot.y + along,
          w = alongX ? SCENERY_PAD.along : into,
          d = alongX ? into : SCENERY_PAD.along;
        index++;
        const distance = Math.hypot(x - 22, z - 30);
        // Beyond ~110 m a plot is a dot; closer ones are rated by the seed.
        if (distance > 110) continue;
        if (
          // The arrival queue and the plaza in front of the gate.
          (Math.abs(x - entrance) < w / 2 + ENTRANCE_CLEARANCE &&
            z > front - d / 2 - 2 &&
            z < front + ENTRANCE_CLEARANCE + 12 + d / 2) ||
          // Never beside the building's own walls.
          (x + w / 2 > footprint.left - 2 &&
            x - w / 2 < footprint.right + 2 &&
            z + d / 2 > b.top - 3 &&
            z - d / 2 < b.bottom + 3) ||
          spawns.some((p) => Math.hypot(p.x - x, p.y - z) < SPAWN_CLEARANCE) ||
          roads.some(
            (r) =>
              x + w / 2 > r.x - r.w / 2 - 0.5 &&
              x - w / 2 < r.x + r.w / 2 + 0.5 &&
              z + d / 2 > r.y - r.h / 2 - 0.5 &&
              z - d / 2 < r.y + r.h / 2 + 0.5,
          )
        )
          continue;
        candidates.push({
          id: "",
          x,
          z,
          w,
          d,
          angle: sceneryHash(seed, index * 3 + 1) * Math.PI * 2,
          rank: sceneryHash(seed, index * 3) + distance / 180,
        });
      }
    }
  }
  candidates.sort((a, b2) => a.rank - b2.rank);
  const chosen: SceneryPad[] = [];
  for (const c of candidates) {
    if (chosen.length >= want) break;
    // One pad per stretch of frontage, so a type is not stacked in one place.
    if (chosen.some((p) => Math.hypot(p.x - c.x, p.z - c.z) < 16)) continue;
    chosen.push({
      id: ids[chosen.length % ids.length],
      x: c.x,
      z: c.z,
      w: c.w,
      d: c.d,
      angle: c.angle,
    });
  }
  return chosen;
}

/** Whether a cell of a lot overlaps the pad (they then share a raised bed). */
export function overlapsPad(
  pad: Pick<SceneryPad, "x" | "z" | "w" | "d">,
  cell: { x: number; z: number; w: number; d: number },
) {
  return (
    Math.abs(pad.x - cell.x) < (pad.w + cell.w) / 2 &&
    Math.abs(pad.z - cell.z) < (pad.d + cell.d) / 2
  );
}
