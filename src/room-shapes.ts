import { type Floor, type Point, H, W } from "./model";
import { floorSectors, inRect, type Rect } from "./floor-plan";

/** Carved study-room corners (floors[].roomShapes). A carved corner is a small
 * staircase of ordinary solid tiles in an otherwise open room corner: physics
 * and navigation see jagged cells, while the renderers draw one smooth wall
 * across them. Everything here is integer or plain arithmetic (no engine
 * trigonometry), so plans and validation are identical on every engine. */
export type CornerStyle = "chamfered" | "rounded" | "octagon";
export interface CarvedCorner {
  /** The corner cell itself (the outermost cell of the open room corner). */
  x: number;
  y: number;
  /** Direction from the corner cell into the room along each axis. */
  sx: 1 | -1;
  sy: 1 | -1;
  style: CornerStyle;
  /** Staircase size: legs for chamfered/octagon, radius for rounded. */
  size: number;
  /** Study room the corner belongs to. */
  room: number;
  /** Sub-room id when this is the interior corner of a sub-room. */
  zone?: string;
}

/** Carved cells per row away from the wall, a non-increasing staircase. */
export function cornerRows(style: CornerStyle, size: number): number[] {
  const rows: number[] = [];
  for (let v = 0; v < size; v++) {
    let n = 0;
    if (style === "rounded") {
      // Cells whose centre lies outside the quarter disc of radius `size`
      // centred `size` cells into the room.
      while (n < size) {
        const a = size - n - 0.5,
          b = size - v - 0.5;
        if (a * a + b * b > size * size) n++;
        else break;
      }
    } else n = Math.max(0, size - v);
    if (!n) break;
    rows.push(n);
  }
  return rows;
}
const cellOffsets = (style: CornerStyle, size: number) =>
  cornerRows(style, size).flatMap((n, dv) =>
    Array.from({ length: n }, (_, du) => ({ du, dv })),
  );
/** The world cells a carved corner turns into walls. */
export function cornerCells(c: CarvedCorner): Point[] {
  return cellOffsets(c.style, c.size).map(({ du, dv }) => ({
    x: c.x + c.sx * du,
    y: c.y + c.sy * dv,
  }));
}

/** Wall footprint of a carved corner in world cell-edge coordinates, starting
 * at the outer corner point. The surface passes through the middle of the
 * staircase, so no wall ever pokes more than half a cell into a walkable cell
 * and the part behind it stays within solid tiles. */
export function cornerProfile(c: CarvedCorner): Point[] {
  const rows = cornerRows(c.style, c.size);
  if (!rows.length) return [];
  let local: Point[];
  if (c.style !== "rounded") {
    const s = rows.length + 0.5;
    local = [
      { x: 0, y: 0 },
      { x: s, y: 0 },
      { x: 0, y: s },
    ];
  } else {
    let line: Point[] = [{ x: rows[0], y: 0 }];
    for (let v = 0; v < rows.length; v++) {
      line.push({ x: rows[v], y: v + 0.5 });
      line.push({ x: (rows[v] + (rows[v + 1] ?? 0)) / 2, y: v + 1 });
    }
    line.push({ x: 0, y: rows.length });
    for (let pass = 0; pass < 2; pass++) {
      const next: Point[] = [line[0]];
      for (let i = 0; i + 1 < line.length; i++) {
        const a = line[i],
          b = line[i + 1];
        next.push(
          { x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y },
          { x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y },
        );
      }
      next.push(line[line.length - 1]);
      line = next;
    }
    local = [{ x: 0, y: 0 }, ...line];
  }
  const ox = c.sx > 0 ? c.x : c.x + 1,
    oy = c.sy > 0 ? c.y : c.y + 1;
  return local.map((p) => ({ x: ox + c.sx * p.x, y: oy + c.sy * p.y }));
}

/** Carved cells of a floor, for painters that skip them. */
export function carvedCells(f: Pick<Floor, "generation">): Point[] {
  return (f.generation?.corners ?? []).flatMap(cornerCells);
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));
/** Staircase size wanted for a rectangle of the given shorter side. */
export function cornerSize(
  style: CornerStyle,
  shorter: number,
  subRoom: boolean,
) {
  const room = Math.max(1, Math.floor((shorter - 1) / 2));
  if (style === "chamfered")
    return clamp(Math.min(2, Math.floor(shorter / 4) || 1), 1, room);
  if (style === "octagon")
    return clamp(
      subRoom ? (shorter >= 6 ? 2 : 1) : Math.round(shorter / 3),
      1,
      Math.min(4, room),
    );
  return subRoom ? 2 : shorter >= 12 ? 5 : 4;
}

const SIGNS: [1 | -1, 1 | -1][] = [
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
];
const styleOf = (shape: string | undefined): CornerStyle | undefined =>
  shape === "chamfered" || shape === "rounded" || shape === "octagon"
    ? shape
    : undefined;

/** Carve the corners of each shaped study room and its sub-rooms, keeping a
 * corner (or shrinking it) whenever the validator objects or it would crowd a
 * terminal, doorway or field approach. Never throws and never fails a design;
 * the carved corners are recorded on `f.generation.corners`. Draws no random
 * numbers. */
export function carveRoomShapes(
  f: Floor,
  validate: (f: Floor) => string[],
  keepClear: Point[],
): CarvedCorner[] {
  const design = f.design as { roomShapes?: string[] } | undefined,
    shapes = design?.roomShapes,
    generation = f.generation;
  if (!shapes?.some((s) => s !== "rect") || !generation?.sectors) return [];
  const carved: CarvedCorner[] = [];
  const tiles = f.tiles;
  const near = (x: number, y: number, p: Point, d: number) =>
    Math.abs(p.x - (x + 0.5)) < d && Math.abs(p.y - (y + 0.5)) < d;
  const protectedCell = (x: number, y: number) =>
    keepClear.some((p) => near(x, y, p, 1.01)) ||
    f.stations.some((s) => near(x, y, s, 1.6)) ||
    f.furniture.some((o) => o.field && near(x, y, o, o.w / 2 + o.h / 2 + 1.5));
  const open = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < W && y < H && tiles[y][x] === 0;
  const attempt = (
    style: CornerStyle,
    wanted: number,
    x: number,
    y: number,
    sx: 1 | -1,
    sy: 1 | -1,
    room: number,
    allowed: (x: number, y: number) => boolean,
    zone?: string,
  ) => {
    // The corner must be a true convex corner of the open room.
    if (
      !open(x, y) ||
      open(x - sx, y) ||
      open(x, y - sy) ||
      open(x - sx, y - sy)
    )
      return;
    for (let size = wanted; size >= 1; size--) {
      const corner: CarvedCorner = {
        x,
        y,
        sx,
        sy,
        style,
        size,
        room,
        ...(zone ? { zone } : {}),
      };
      const cells = cornerCells(corner);
      if (
        !cells.length ||
        cells.some(
          (c) =>
            !open(c.x, c.y) || !allowed(c.x, c.y) || protectedCell(c.x, c.y),
        )
      )
        continue;
      for (const c of cells) tiles[c.y][c.x] = 1;
      generation.corners = [...(generation.corners ?? []), corner];
      if (!validate(f).length) {
        carved.push(corner);
        return;
      }
      generation.corners = generation.corners.slice(0, -1);
      for (const c of cells) tiles[c.y][c.x] = 0;
    }
  };
  const corners = (r: Rect) =>
    SIGNS.map(([sx, sy]) => ({
      x: sx > 0 ? r.x1 : r.x2,
      y: sy > 0 ? r.y1 : r.y2,
      sx,
      sy,
    }));
  for (const sector of floorSectors(f)) {
    const style =
      sector.room === undefined ? undefined : styleOf(shapes[sector.room]);
    if (!style || sector.room === undefined) continue;
    const roomRects = sector.rooms.map(({ rect: r }) => ({
      x1: r.x1 - 1,
      y1: r.y1 - 1,
      x2: r.x2 + 1,
      y2: r.y2 + 1,
    }));
    for (const block of sector.blocks) {
      const shorter = Math.min(
        block.x2 - block.x1 + 1,
        block.y2 - block.y1 + 1,
      );
      for (const c of corners(block))
        attempt(
          style,
          cornerSize(style, shorter, false),
          c.x,
          c.y,
          c.sx,
          c.sy,
          sector.room,
          (x, y) =>
            inRect(block, x, y) && !roomRects.some((r) => inRect(r, x, y)),
        );
    }
    for (const room of sector.rooms) {
      const r = room.rect,
        shorter = Math.min(r.x2 - r.x1 + 1, r.y2 - r.y1 + 1);
      for (const c of corners(r))
        attempt(
          style,
          cornerSize(style, shorter, true),
          c.x,
          c.y,
          c.sx,
          c.sy,
          sector.room,
          (x, y) => inRect(r, x, y),
          room.id,
        );
    }
  }
  return carved;
}
