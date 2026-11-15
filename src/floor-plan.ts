import type { Floor, Point } from "./model";

/** Inclusive interior cell ranges. */
export interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
export type SubRoomKind = "office" | "meeting" | "storage" | "break";
export interface SubRoom {
  /** Zone id for furnishing and furniture ids, e.g. "room3r1". */
  id: string;
  kind: SubRoomKind;
  /** Interior cells. */
  rect: Rect;
  /** The two open cells in this room's wall ring. */
  doorway: Rect;
}
/** `room${n}` for study rooms; a free plan (generation 6) numbers its drawn
 * rooms from 0 and has the one "entry" concourse. */
export type SectorId = "entry" | "lobby" | `room${number}`;
export interface Sector {
  id: SectorId;
  /** Study sectors only: 0..3 on chain floors, 0..n-1 on a free plan. */
  room?: number;
  /** A hall: taller than other rooms, with optional stepped levels. */
  hall?: true;
  /** Study sectors of a hall floor only: every study room this sector holds
   * (its own `room` first). A hall takes the place of two or three rooms. */
  merged?: number[];
  /** 0 = entry ... last = lobby (5 unless a hall shortens the chain). */
  order: number;
  /** Union = territory (clipped to the building shell); one to three rects. */
  blocks: Rect[];
  /** Deliberate corridor cells (subset of circulation). */
  corridors: Rect[];
  rooms: SubRoom[];
  /** Centre of the opening (field) to the next sector. */
  gate?: Point;
}

/** Room interior size table (min side, max side) per sub-room kind. */
export const SUB_ROOM_SIZES: Record<
  SubRoomKind,
  { short: [number, number]; long: [number, number] }
> = {
  office: { short: [3, 4], long: [3, 5] },
  meeting: { short: [4, 6], long: [5, 8] },
  storage: { short: [3, 3], long: [3, 4] },
  break: { short: [5, 7], long: [5, 8] },
};
export function sizeFits(kind: SubRoomKind, w: number, h: number) {
  const s = SUB_ROOM_SIZES[kind],
    a = Math.min(w, h),
    b = Math.max(w, h);
  return a >= s.short[0] && a <= s.short[1] && b >= s.long[0] && b <= s.long[1];
}

export const inRect = (r: Rect, x: number, y: number) =>
  x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2;

/** Sectors of a fresh floor: stored version 5 sectors, or bands synthesised
 * from version 3/4 stages (entry, four study bands, stair lobby). */
export function floorSectors(f: Floor): Sector[] {
  const generation = f.generation;
  if (!generation) return [];
  if (generation.sectors) return generation.sectors;
  const stages = generation.stages;
  if (!stages?.length) return [];
  const top = f.boundary?.top ?? 2,
    bottom = f.boundary?.bottom ?? 28;
  const band = (y1: number, y2: number): Rect => {
    if (!f.boundary) return { x1: 2, y1, x2: 41, y2 };
    const rows = f.boundary.rows.slice(y1, y2 + 1);
    return {
      x1: Math.max(...rows.map((r) => r.left)),
      y1,
      x2: Math.min(...rows.map((r) => r.right)) - 1,
      y2,
    };
  };
  const sector = (
    id: Sector["id"],
    order: number,
    rect: Rect,
    gate?: Point,
    room?: number,
  ): Sector => ({
    id,
    ...(room === undefined ? {} : { room }),
    order,
    blocks: [rect],
    corridors: [],
    rooms: [],
    ...(gate ? { gate } : {}),
  });
  return [
    sector("entry", 0, band(stages[0].rear + 1, bottom - 1), f.doors[2]),
    ...stages.map((s, i) =>
      sector(
        `room${s.room}` as Sector["id"],
        i + 1,
        band(s.front + 1, s.rear - 1),
        f.rooms?.[s.room]?.forwardExit,
        s.room,
      ),
    ),
    sector("lobby", stages.length + 1, band(top, stages.at(-1)!.front - 1)),
  ];
}

/** The sector whose territory contains this point, if any. */
export function sectorAt(f: Floor, p: Point): Sector | undefined {
  const x = Math.floor(p.x),
    y = Math.floor(p.y);
  return floorSectors(f).find((s) => s.blocks.some((b) => inRect(b, x, y)));
}

/** The block rect of the sector containing this point, if any. */
export function sectorBounds(f: Floor, p: Point): Rect | undefined {
  const x = Math.floor(p.x),
    y = Math.floor(p.y);
  for (const s of floorSectors(f))
    for (const b of s.blocks) if (inRect(b, x, y)) return b;
  return undefined;
}

/** The study rooms a sector holds: its own, plus those a hall absorbed. */
export const sectorRooms = (s: Sector): number[] =>
  s.merged ?? (s.room === undefined ? [] : [s.room]);

/** The sector that holds a study room: its own sector, or the hall that
 * absorbed it. Scene rooms, stations and doors of an absorbed room resolve to
 * the hall this way. */
export function sectorOfRoom(f: Floor, room: number): Sector | undefined {
  return floorSectors(f).find((s) => sectorRooms(s).includes(room));
}

/** The hall of a floor (floors[].hall), if it has one. */
export function hallSector(f: Floor): Sector | undefined {
  return f.generation?.sectors?.find((s) => s.merged || s.hall);
}

/** Every hall of a floor: one on a chain floor, any number on a free plan. */
export function hallSectors(f: Pick<Floor, "generation">): Sector[] {
  return f.generation?.sectors?.filter((s) => s.merged || s.hall) ?? [];
}
