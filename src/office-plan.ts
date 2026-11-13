import {
  type Floor,
  type Furniture,
  type Game,
  type Point,
  type Rng,
  H,
  W,
  between,
  rand,
  shuffle,
} from "./model";
import { footprintTiles } from "./building-layout";
import { carveStairwells } from "./stairwell";
import { isSolidOpenFloor } from "./open-site";
import {
  type Rect,
  type Sector,
  type SectorId,
  type SubRoom,
  type SubRoomKind,
  inRect,
  sizeFits,
} from "./floor-plan";

/** Version 5 office floor plans: six chain sectors of varied shape between
 * the rear entry and the front stairs. See docs/FLOOR_PLAN_DESIGN.md. */
export type PlanFamily = "stack" | "columns" | "serpentine";
const int = between;

/** Interior cell labels while planning: -2 outside the bounding box, -1 wall
 * (or outside the shell inside the box), 0..5 the sector order. */
export interface PlanGrid {
  lab: Int8Array;
  X0: number;
  X1: number;
  top: number;
  bottom: number;
  inside: (x: number, y: number) => boolean;
}
export function planGrid(f: Floor): PlanGrid {
  const b = f.boundary!;
  const rows = b.rows.slice(b.top, b.bottom);
  const X0 = Math.min(...rows.map((r) => r.left)),
    X1 = Math.max(...rows.map((r) => r.right)) - 1;
  const lab = new Int8Array(W * H).fill(-2);
  for (let y = b.top; y < b.bottom; y++)
    for (let x = X0; x <= X1; x++) lab[y * W + x] = -1;
  return {
    lab,
    X0,
    X1,
    top: b.top,
    bottom: b.bottom,
    inside: (x, y) =>
      y >= b.top && y < b.bottom && x >= b.rows[y].left && x < b.rows[y].right,
  };
}
export const labelAt = (p: PlanGrid, x: number, y: number) =>
  x < 0 || y < 0 || x >= W || y >= H ? -2 : p.lab[y * W + x];

/** Lobby rectangles and the per-column wall rows around them. */
interface Lobbies {
  entry: Rect;
  lobby: Rect;
  narrowEntry: boolean;
  narrowLobby: boolean;
  /** Row of the wall above which the field ends, per column (south limit). */
  south: (x: number) => number;
  /** Row of the wall below which the field starts, per column (north limit). */
  north: (x: number) => number;
}
function lobbies(
  p: PlanGrid,
  r: Rng,
  options: { fullLobby?: boolean; defaults?: boolean },
): Lobbies {
  const { X0, X1, top, bottom } = p;
  const ed = options.defaults ? 3 : int(r, 3, 5),
    e1 = bottom - ed;
  let ex1 = X0,
    ex2 = X1;
  if (!options.defaults && rand(r) < 0.65) {
    const ew = 2 * int(r, 6, 9);
    ex1 = 16 - int(r, 0, ew - 12);
    ex2 = ex1 + ew - 1;
    if (ex1 - 1 - X0 < 5 || X1 - ex2 - 1 < 5) [ex1, ex2] = [X0, X1];
  }
  const ld = options.defaults ? 3 : int(r, 3, 5),
    l2 = top + ld - 1;
  let lx1 = X0,
    lx2 = X1;
  if (!options.defaults && !options.fullLobby && rand(r) < 0.6) {
    const lw = int(r, 10, 20);
    lx1 = int(r, 23 - lw, 21);
    lx2 = lx1 + lw - 1;
    if (lx1 - 1 - X0 < 5 || X1 - lx2 - 1 < 5) [lx1, lx2] = [X0, X1];
  }
  const narrowEntry = ex1 !== X0,
    narrowLobby = lx1 !== X0;
  return {
    entry: { x1: ex1, y1: e1, x2: ex2, y2: bottom - 1 },
    lobby: { x1: lx1, y1: top, x2: lx2, y2: l2 },
    narrowEntry,
    narrowLobby,
    south: (x) =>
      !narrowEntry || (x >= ex1 - 1 && x <= ex2 + 1) ? e1 - 1 : bottom,
    north: (x) =>
      !narrowLobby || (x >= lx1 - 1 && x <= lx2 + 1) ? l2 + 1 : top - 1,
  };
}
function paint(p: PlanGrid, rect: Rect, label: number) {
  for (let y = rect.y1; y <= rect.y2; y++)
    for (let x = rect.x1; x <= rect.x2; x++)
      if (p.lab[y * W + x] !== -2) p.lab[y * W + x] = label;
}
function paintLobbies(p: PlanGrid, l: Lobbies) {
  paint(p, l.entry, 0);
  paint(p, l.lobby, 5);
}
/** Paint rows [y1, y2] of one column. */
function column(p: PlanGrid, x: number, y1: number, y2: number, label: number) {
  for (let y = y1; y <= y2; y++)
    if (p.lab[y * W + x] !== -2) p.lab[y * W + x] = label;
}

/** Four bands south to north whose boundaries step once, so bands interlock. */
function stack(p: PlanGrid, r: Rng, defaults: boolean) {
  const l = lobbies(p, r, { defaults });
  paintLobbies(p, l);
  const fTop = l.lobby.y2 + 2,
    fBot = l.entry.y1 - 2;
  const d = [4, 3, 3, 3];
  let spare = fBot - fTop + 1 - 3 - 13;
  if (spare < 0) return false;
  for (; spare > 0; spare--) {
    if (rand(r) < 0.4 && d[0] < 8) d[0]++;
    else {
      const i = int(r, 1, 3);
      d[d[i] < 7 ? i : 0]++;
    }
  }
  const w = [0, fBot - d[0], 0, 0];
  w[2] = w[1] - d[1] - 1;
  w[3] = w[2] - d[2] - 1;
  const bp = [0, 0, 0, 0],
    step = [0, 0, 0, 0];
  const row = (k: number, x: number) =>
    !bp[k] || x < bp[k] ? w[k] : w[k] + step[k];
  const lo = (k: number, x: number) =>
    k === 0
      ? l.south(x)
      : k === 4
        ? l.north(x)
        : x === bp[k]
          ? Math.min(w[k], w[k] + step[k])
          : row(k, x);
  const hi = (k: number, x: number) =>
    k === 0
      ? l.south(x)
      : k === 4
        ? l.north(x)
        : x === bp[k]
          ? Math.max(w[k], w[k] + step[k])
          : row(k, x);
  const fits = () => {
    for (let x = p.X0; x <= p.X1; x++)
      for (let j = 0; j < 4; j++)
        if (lo(j, x) - hi(j + 1, x) - 1 < 3) return false;
    return true;
  };
  for (let k = 1; k <= 3; k++) {
    if (defaults || rand(r) >= 0.75) continue;
    if ((k === 1 && l.narrowEntry) || (k === 3 && l.narrowLobby)) continue;
    const b = int(r, p.X0 + 6, p.X1 - 6),
      sign = rand(r) < 0.5 ? -1 : 1;
    if (bp.some((other) => other && Math.abs(other - b) < 5)) continue;
    bp[k] = b;
    for (let mag = int(r, 1, 3); mag > 0; mag--) {
      step[k] = sign * mag;
      if (fits()) break;
      step[k] = 0;
    }
    if (!step[k]) bp[k] = 0;
  }
  for (let x = p.X0; x <= p.X1; x++)
    for (let j = 0; j < 4; j++)
      column(p, x, hi(j + 1, x) + 1, lo(j, x) - 1, j + 1);
  return true;
}

/** The free hall along the south side, wrapping around a narrow reception. */
function hall(p: PlanGrid, l: Lobbies, r1: number) {
  for (let x = p.X0; x <= p.X1; x++) column(p, x, r1, l.south(x) - 1, 1);
}

/** room2 south, then three departments side by side under a full-width lobby. */
function columns(p: PlanGrid, r: Rng) {
  const l = lobbies(p, r, { fullLobby: true });
  paintLobbies(p, l);
  const fTop = l.lobby.y2 + 2,
    e1 = l.entry.y1;
  const dr = Math.min(int(r, 4, 7), e1 - 11 - fTop);
  if (dr < 4) return false;
  const r1 = e1 - 1 - dr,
    fBot = r1 - 2;
  hall(p, l, r1);
  const c = [8, 8, 8];
  let spare = p.X1 - p.X0 + 1 - 2 - 24;
  if (spare < 0) return false;
  for (; spare > 0; spare--) c[int(r, 0, 2)]++;
  const order = rand(r) < 0.5 ? [2, 3, 4] : [4, 3, 2];
  let x = p.X0;
  for (let i = 0; i < 3; i++) {
    paint(p, { x1: x, y1: fTop, x2: x + c[i] - 1, y2: fBot }, order[i]);
    x += c[i] + 1;
  }
  return true;
}

/** room2 south; a spine splits the rest; one half is split again, so the
 * chain runs south part -> other half -> north part -> lobby. */
function serpentine(p: PlanGrid, r: Rng) {
  const l = lobbies(p, r, {});
  paintLobbies(p, l);
  const fTop = l.lobby.y2 + 2,
    e1 = l.entry.y1;
  const dr = Math.min(int(r, 4, 7), e1 - 13 - fTop);
  if (dr < 4) return false;
  const r1 = e1 - 1 - dr,
    fBot = r1 - 2;
  hall(p, l, r1);
  const s = int(r, 18, 26),
    west = rand(r) < 0.5,
    m = int(r, fTop + 5, fBot - 5);
  for (let x = p.X0; x <= p.X1; x++) {
    if (x === s) continue;
    const t = l.north(x) + 1;
    if (x < s === west) {
      column(p, x, t, m - 1, 4);
      column(p, x, m + 1, fBot, 2);
    } else column(p, x, t, fBot, 3);
  }
  return true;
}

/** Sector blocks as column-run rects, or undefined when a sector is not a
 * union of one to three rects or two sectors touch without a wall. */
function decompose(p: PlanGrid): Rect[][] | undefined {
  const blocks: Rect[][] = [];
  for (let label = 0; label < 6; label++) {
    const out: Rect[] = [];
    let open: Rect | undefined;
    for (let x = p.X0; x <= p.X1 + 1; x++) {
      let y1 = -1,
        y2 = -1;
      if (x <= p.X1)
        for (let y = p.top; y < p.bottom; y++)
          if (p.lab[y * W + x] === label) {
            if (y1 < 0) y1 = y;
            else if (y2 !== y - 1) return undefined;
            y2 = y;
          }
      if (open && y1 === open.y1 && y2 === open.y2) {
        open.x2 = x;
        continue;
      }
      if (open) out.push(open);
      open = y1 >= 0 ? { x1: x, y1, x2: x, y2 } : undefined;
    }
    if (out.length < 1 || out.length > 3) return undefined;
    blocks.push(out);
  }
  for (let y = p.top; y < p.bottom; y++)
    for (let x = p.X0; x <= p.X1; x++) {
      const a = p.lab[y * W + x];
      if (a < 0) continue;
      for (const b of [p.lab[y * W + x + 1], p.lab[(y + 1) * W + x]])
        if (b >= 0 && b !== a) return undefined;
    }
  return blocks;
}

export interface PlanGate {
  x: number;
  y: number;
  w: number;
  h: number;
  cells: [number, number][];
  /** -sign(previous sector side along the field axis). */
  direction: number;
}
/** Every 3-cell opening joining sector a (previous) to b: on a straight wall
 * run, one cell from every corner, with 2 clear sector cells in front on both
 * sides. */
function gateCandidates(p: PlanGrid, a: number, b: number): PlanGate[] {
  const out: PlanGate[] = [];
  const at = (x: number, y: number) => (p.inside(x, y) ? labelAt(p, x, y) : -3);
  for (let y = p.top; y < p.bottom; y++)
    for (let x = p.X0; x <= p.X1; x++)
      for (const vertical of [false, true]) {
        const [ux, uy, vx, vy] = vertical ? [0, 1, 1, 0] : [1, 0, 0, 1];
        const s = at(x - vx, y - vy),
          q = at(x + vx, y + vy);
        if (!((s === a && q === b) || (s === b && q === a))) continue;
        let ok = true;
        for (let i = -1; i <= 3 && ok; i++) {
          const cx = x + ux * i,
            cy = y + uy * i;
          if (at(cx, cy) !== -1) ok = false;
          for (let d = 1; d <= (i >= 0 && i <= 2 ? 2 : 1) && ok; d++)
            if (
              at(cx - vx * d, cy - vy * d) !== s ||
              at(cx + vx * d, cy + vy * d) !== q
            )
              ok = false;
        }
        if (!ok) continue;
        out.push({
          x: vertical ? x + 0.5 : x + 1.5,
          y: vertical ? y + 1.5 : y + 0.5,
          w: vertical ? 1 : 3,
          h: vertical ? 3 : 1,
          cells: [0, 1, 2].map((i) => [x + ux * i, y + uy * i]),
          direction: s === a ? 1 : -1,
        });
      }
  return out;
}
/** The sector cell directly in front of a gate's middle cell. */
export function gateFront(p: PlanGrid, gate: PlanGate, order: number): Point {
  const [mx, my] = gate.cells[1];
  for (const s of [-1, 1]) {
    const x = gate.w === 1 ? mx + s : mx,
      y = gate.w === 1 ? my : my + s;
    if (labelAt(p, x, y) === order) return { x, y };
  }
  return { x: mx, y: my };
}

/** Planning state shared by the sub-room carver, terminal placement and the
 * final commit. */
export interface Plan {
  family: PlanFamily;
  p: PlanGrid;
  tiles: number[][];
  blocks: Rect[][];
  gates: PlanGate[];
  rooms: SubRoom[][];
  corridors: Rect[][];
  /** Room interiors, ring walls and doorways, for overlap checks. */
  interior: Uint8Array;
  ring: Uint8Array;
  door: Uint8Array;
}
export const isWide = (tiles: number[][], x: number, y: number) => {
  const open = (cx: number, cy: number) => tiles[cy]?.[cx] === 0;
  if (!open(x, y)) return false;
  for (const dx of [-1, 0])
    for (const dy of [-1, 0])
      if (
        open(x + dx, y + dy) &&
        open(x + dx + 1, y + dy) &&
        open(x + dx, y + dy + 1) &&
        open(x + dx + 1, y + dy + 1)
      )
        return true;
  return false;
};
/** Wide cells of one sector reachable from a start cell. */
export function wideFlood(
  tiles: number[][],
  inSector: (x: number, y: number) => boolean,
  start: Point,
) {
  const seen = new Uint8Array(W * H),
    queue = [start.y * W + start.x];
  while (queue.length) {
    const id = queue.pop()!,
      x = id % W,
      y = (id - x) / W;
    if (seen[id] || !inSector(x, y) || !isWide(tiles, x, y)) continue;
    seen[id] = 1;
    queue.push(id + 1, id - 1, id + W, id - W);
  }
  return seen;
}
const sectorCell = (plan: Plan, order: number) => (x: number, y: number) =>
  x >= 0 &&
  y >= 0 &&
  x < W &&
  y < H &&
  labelAt(plan.p, x, y) === order &&
  plan.p.inside(x, y);
/** Whether a sector's entry gate still reaches its exit gate, every doorway
 * and the given extra cells through wide circulation. */
function sectorWide(plan: Plan, order: number, extra: Point[] = []) {
  const seen = wideFlood(
    plan.tiles,
    sectorCell(plan, order),
    gateFront(plan.p, plan.gates[order - 1], order),
  );
  const targets = [
    gateFront(plan.p, plan.gates[order], order),
    ...plan.rooms[order].flatMap((room) => cellsOf(room.doorway)),
    ...extra,
  ];
  return targets.every((t) => seen[t.y * W + t.x]);
}
export const cellsOf = (r: Rect) => {
  const out: Point[] = [];
  for (let y = r.y1; y <= r.y2; y++)
    for (let x = r.x1; x <= r.x2; x++) out.push({ x, y });
  return out;
};

type Edge = "n" | "s" | "w" | "e";
const widthsFor = (kind: SubRoomKind, d: number) =>
  [3, 4, 5, 6, 7].filter((w) => sizeFits(kind, w, d));
/** A room of depth d against one edge of a block, starting at `a` along it. */
function roomGeometry(B: Rect, edge: Edge, a: number, w: number, d: number) {
  if (edge === "n" || edge === "s") {
    const y1 = edge === "n" ? B.y1 : B.y2 - d + 1,
      row = edge === "n" ? y1 + d : y1 - 1;
    return {
      rect: { x1: a, x2: a + w - 1, y1, y2: y1 + d - 1 },
      door: (o: number) => ({ x1: a + o, x2: a + o + 1, y1: row, y2: row }),
      dx: 0,
      dy: edge === "n" ? 1 : -1,
    };
  }
  const x1 = edge === "w" ? B.x1 : B.x2 - d + 1,
    col = edge === "w" ? x1 + d : x1 - 1;
  return {
    rect: { x1, x2: x1 + d - 1, y1: a, y2: a + w - 1 },
    door: (o: number) => ({ x1: col, x2: col, y1: a + o, y2: a + o + 1 }),
    dx: edge === "w" ? 1 : -1,
    dy: 0,
  };
}
/** Carve one walled room with a single 2-cell doorway if it keeps the
 * sector's circulation wide and connected. */
function tryRoom(
  plan: Plan,
  order: number,
  room: SubRoom,
  dx: number,
  dy: number,
) {
  const { p, tiles } = plan,
    { rect, doorway } = room;
  for (const c of cellsOf(rect)) {
    const i = c.y * W + c.x;
    if (
      labelAt(p, c.x, c.y) !== order ||
      !p.inside(c.x, c.y) ||
      tiles[c.y][c.x] ||
      plan.interior[i] ||
      plan.ring[i]
    )
      return false;
  }
  const ring = cellsOf({
    x1: rect.x1 - 1,
    y1: rect.y1 - 1,
    x2: rect.x2 + 1,
    y2: rect.y2 + 1,
  }).filter((c) => !inRect(rect, c.x, c.y));
  const gateCells = plan.gates.flatMap((g) => g.cells);
  for (const c of ring) {
    const l = labelAt(p, c.x, c.y),
      i = c.y * W + c.x;
    if (l >= 0 && l !== order) return false;
    if (l < 0 && tiles[c.y]?.[c.x] === 0) return false;
    if (plan.interior[i] || plan.door[i]) return false;
    if (
      gateCells.some(
        ([gx, gy]) => Math.max(Math.abs(gx - c.x), Math.abs(gy - c.y)) <= 2,
      )
    )
      return false;
  }
  for (const c of cellsOf(doorway)) {
    const bx = c.x + dx,
      by = c.y + dy;
    if (
      labelAt(p, c.x, c.y) !== order ||
      !p.inside(c.x, c.y) ||
      tiles[c.y][c.x] ||
      plan.ring[c.y * W + c.x] ||
      labelAt(p, bx, by) !== order ||
      !p.inside(bx, by) ||
      tiles[by][bx] ||
      plan.interior[by * W + bx] ||
      plan.ring[by * W + bx]
    )
      return false;
  }
  const saved = ring.map((c) => tiles[c.y][c.x]);
  for (const c of ring) if (!inRect(doorway, c.x, c.y)) tiles[c.y][c.x] = 1;
  plan.rooms[order].push(room);
  if (!sectorWide(plan, order)) {
    ring.forEach((c, i) => (tiles[c.y][c.x] = saved[i]));
    plan.rooms[order].pop();
    return false;
  }
  for (const c of cellsOf(rect)) plan.interior[c.y * W + c.x] = 1;
  for (const c of ring)
    if (inRect(doorway, c.x, c.y)) plan.door[c.y * W + c.x] = 1;
    else plan.ring[c.y * W + c.x] = 1;
  return true;
}
/** Slice a strip along one edge into rooms with 1-cell partitions. */
function carveStrip(
  plan: Plan,
  order: number,
  room: number,
  B: Rect,
  edge: Edge,
  d: number,
  r: Rng,
  kinds: SubRoomKind[],
  max: number,
) {
  const [start, end] =
    edge === "n" || edge === "s" ? [B.x1, B.x2] : [B.y1, B.y2];
  const fitting = kinds.filter((k) => widthsFor(k, d).length);
  let placed = 0;
  if (!fitting.length) return 0;
  for (let a = start; a + 2 <= end && placed < max;) {
    const kind = fitting[int(r, 0, fitting.length - 1)];
    const ws = widthsFor(kind, d).filter((w) => a + w - 1 <= end);
    if (!ws.length) {
      a++;
      continue;
    }
    const w = ws[int(r, 0, ws.length - 1)],
      geo = roomGeometry(B, edge, a, w, d);
    const sub: SubRoom = {
      id: `room${room}r${plan.rooms[order].length + 1}`,
      kind,
      rect: geo.rect,
      doorway: geo.door(int(r, 0, w - 2)),
    };
    if (tryRoom(plan, order, sub, geo.dx, geo.dy)) {
      a += w + 1;
      placed++;
    } else a++;
  }
  return placed;
}

const OPPOSITE: Record<Edge, Edge> = { n: "s", s: "n", w: "e", e: "w" };
/** Rooms along one or two outer wall runs of each block, open core. */
function carveSector(
  plan: Plan,
  order: number,
  room: number,
  r: Rng,
  designedKinds?: SubRoomKind[],
) {
  const hall = room === 2;
  if (hall && rand(r) < 0.5) return;
  let left = hall ? 2 : 8;
  const kinds: SubRoomKind[] =
    designedKinds ??
    (hall ? ["office", "storage"] : ["office", "meeting", "storage", "break"]);
  const area = (b: Rect) => (b.x2 - b.x1 + 1) * (b.y2 - b.y1 + 1);
  const blocks = [...plan.blocks[order]].sort((a, b) => area(b) - area(a));
  for (const B of blocks) {
    if (left <= 0) break;
    const horizontal = (e: Edge) => e === "n" || e === "s";
    const length = (e: Edge) =>
      horizontal(e) ? B.x2 - B.x1 + 1 : B.y2 - B.y1 + 1;
    const outer = (e: Edge) =>
      cellsOf(
        e === "n"
          ? { ...B, y1: B.y1 - 1, y2: B.y1 - 1 }
          : e === "s"
            ? { ...B, y1: B.y2 + 1, y2: B.y2 + 1 }
            : e === "w"
              ? { ...B, x1: B.x1 - 1, x2: B.x1 - 1 }
              : { ...B, x1: B.x2 + 1, x2: B.x2 + 1 },
      ).every((c) => labelAt(plan.p, c.x, c.y) !== order);
    const edges = shuffle(r, ["n", "s", "w", "e"] as Edge[])
      .filter(outer)
      .sort((a, b) => length(b) - length(a));
    if (!edges.length) continue;
    const first = edges[0],
      second = OPPOSITE[first];
    const D = horizontal(first) ? B.y2 - B.y1 + 1 : B.x2 - B.x1 + 1;
    const d1 = Math.min(int(r, 3, 5), D - 4);
    if (d1 < 3) continue;
    const d2 =
      !hall && edges.includes(second) && rand(r) < 0.7
        ? Math.min(int(r, 3, 5), D - d1 - 4)
        : 0;
    const n1 = carveStrip(plan, order, room, B, first, d1, r, kinds, left);
    left -= n1;
    if (d2 < 3 || left <= 0) continue;
    const n2 = carveStrip(plan, order, room, B, second, d2, r, kinds, left);
    left -= n2;
    if (!n1 || !n2 || D - d1 - d2 - 2 > 3) continue;
    // Opposite strips with a narrow gap: a double-loaded corridor.
    const [near, far] = first === "n" || first === "w" ? [d1, d2] : [d2, d1];
    plan.corridors[order].push(
      horizontal(first)
        ? { x1: B.x1, x2: B.x2, y1: B.y1 + near + 1, y2: B.y2 - far - 1 }
        : { x1: B.x1 + near + 1, x2: B.x2 - far - 1, y1: B.y1, y2: B.y2 },
    );
  }
}

/** Terminal cells: offices and meeting rooms first, then the open area on a
 * 2 to 3 cell lattice, keeping gate approaches, doorways and corridors free. */
function placeTerminals(
  plan: Plan,
  order: number,
  count: number,
  r: Rng,
): Point[] | undefined {
  const out: Point[] = [];
  const far = (x: number, y: number, s: number) =>
    out.every((t) => Math.hypot(t.x - x, t.y - y) >= s);
  for (const room of shuffle(r, [...plan.rooms[order]])) {
    const { x1, y1, x2, y2 } = room.rect,
      cx = Math.floor((x1 + x2) / 2),
      cy = Math.floor((y1 + y2) / 2);
    if (out.length >= count) break;
    if (room.kind === "office") out.push({ x: cx, y: cy });
    else if (room.kind === "meeting") {
      if (rand(r) < 0.5 || out.length + 1 >= count) out.push({ x: cx, y: cy });
      else if (x2 - x1 >= y2 - y1)
        out.push({ x: x1 + 1, y: cy }, { x: x2 - 1, y: cy });
      else out.push({ x: cx, y: y1 + 1 }, { x: cx, y: y2 - 1 });
    }
  }
  const seen = wideFlood(
    plan.tiles,
    sectorCell(plan, order),
    gateFront(plan.p, plan.gates[order - 1], order),
  );
  const gateCells = plan.gates.flatMap((g) => g.cells);
  const doorCells = plan.rooms[order].flatMap((m) => cellsOf(m.doorway));
  const cheb = (c: Point, x: number, y: number) =>
    Math.max(Math.abs(c.x - x), Math.abs(c.y - y));
  const candidates: Point[] = [];
  for (const b of plan.blocks[order])
    for (const c of cellsOf(b)) {
      const i = c.y * W + c.x;
      if (
        seen[i] &&
        !plan.interior[i] &&
        !plan.ring[i] &&
        !plan.door[i] &&
        !plan.corridors[order].some((k) => inRect(k, c.x, c.y)) &&
        gateCells.every(([x, y]) => cheb(c, x, y) >= 3) &&
        doorCells.every((d) => cheb(c, d.x, d.y) >= 2)
      )
        candidates.push(c);
    }
  candidates.sort((a, b) => a.y - b.y || a.x - b.x);
  for (const [sx, sy] of [
    [3, 3],
    [3, 2],
    [2, 2],
    [1, 1],
  ]) {
    const need = count - out.length;
    if (need <= 0) break;
    const ox = int(r, 0, sx - 1),
      oy = int(r, 0, sy - 1);
    const lattice = candidates.filter(
      (c) =>
        (c.x - ox) % sx === 0 && (c.y - oy) % sy === 0 && far(c.x, c.y, 1.5),
    );
    if (sx === 1) {
      // Last resort: greedy row-major packing at the minimum spacing.
      for (const c of lattice)
        if (out.length < count && far(c.x, c.y, 1.5)) out.push(c);
      break;
    }
    if (lattice.length < need) continue;
    for (let i = 0; i < need; i++)
      out.push(lattice[Math.floor((i * lattice.length) / need)]);
  }
  if (out.length < count) return undefined;
  return out.map((c) => ({ x: c.x + 0.5, y: c.y + 0.5 }));
}

interface Draft {
  plan: Plan;
  /** Study room number per chain order 1..4. */
  roomOf: number[];
  terminals: Point[][];
}
/** One planning attempt; undefined when this draw cannot be built. */
function attempt(
  f: Floor,
  r: Rng,
  family: PlanFamily,
  defaults: boolean,
  counts: number[],
): Draft | undefined {
  const p = planGrid(f);
  const built =
    family === "stack"
      ? stack(p, r, defaults)
      : family === "columns"
        ? columns(p, r)
        : serpentine(p, r);
  if (!built) return undefined;
  const blocks = decompose(p);
  if (!blocks) return undefined;
  f.tiles = footprintTiles(f.boundary!);
  for (let y = p.top; y < p.bottom; y++)
    for (let x = p.X0; x <= p.X1; x++)
      if (p.lab[y * W + x] === -1) f.tiles[y][x] = 1;
  f.entry = { x: 21.5, y: 26.5 };
  f.stairs = { x: 21.5, y: 3.5 };
  carveStairwells(f);
  if (f.index === 0)
    for (let y = p.bottom; y < H; y++)
      for (let x = 18; x <= 25; x++)
        if (y > p.bottom || (x >= 20 && x < 24)) f.tiles[y][x] = 0;
  const empty = () => [0, 1, 2, 3, 4, 5].map(() => []);
  const plan: Plan = {
    family,
    p,
    tiles: f.tiles,
    blocks,
    gates: [],
    rooms: empty(),
    corridors: empty(),
    interior: new Uint8Array(W * H),
    ring: new Uint8Array(W * H),
    door: new Uint8Array(W * H),
  };
  for (let k = 0; k < 5; k++) {
    const options = gateCandidates(p, k, k + 1);
    if (!options.length) return undefined;
    const gate = options[int(r, 0, options.length - 1)];
    for (const [x, y] of gate.cells) f.tiles[y][x] = 0;
    plan.gates.push(gate);
  }
  const roomOf = [-1, 2, ...(f.design?.roomOrder ?? shuffle(r, [3, 0, 1]))];
  if (!defaults)
    for (let order = 1; order <= 4; order++)
      carveSector(plan, order, roomOf[order], r, f.design?.subroomKinds);
  const terminals: Point[][] = [];
  for (let order = 1; order <= 4; order++) {
    const t = placeTerminals(plan, order, counts[roomOf[order]], r);
    if (!t) return undefined;
    terminals[order] = t;
  }
  return { plan, roomOf, terminals };
}

/** The authored quota is shared by construction and validation. */
export function forwardFieldQuota(g: Game, f: Floor, room: number) {
  return f.design?.fieldQuotas[room] ?? 3 + ((g.seed + f.index + room) % 3);
}

export function fieldDoor(
  g: Game,
  f: Floor,
  id: string,
  point: Point,
  w: number,
  h: number,
  kind: "public" | "forward" | "gate",
  room = 0,
  direction = -1,
) {
  for (let y = Math.floor(point.y - h / 2); y < Math.ceil(point.y + h / 2); y++)
    for (
      let x = Math.floor(point.x - w / 2);
      x < Math.ceil(point.x + w / 2);
      x++
    )
      f.tiles[y][x] = 0;
  const hp = kind === "gate" ? 900 : 1200;
  const o: Furniture = {
    id,
    floor: f.index,
    kind: "door",
    ...point,
    w,
    h,
    hp,
    maxHp: hp,
    speed: 0,
    rotation: 0,
    destroyed: false,
    movers: [],
    moved: 0,
    credited: [],
    turning: 0,
    open: false,
    angle: 0,
    initial: { ...point, w, h },
    field: {
      authorized: [],
      crossing: [],
      sides: {},
      used: 0,
      exit: kind === "forward",
      ...(kind === "public"
        ? { publicEntry: true }
        : kind === "forward"
          ? { limit: forwardFieldQuota(g, f, room), direction }
          : {}),
    },
  };
  f.furniture.push(o);
  return o;
}

const SECTOR_IDS = (roomOf: number[]): SectorId[] => [
  "entry",
  ...roomOf.slice(1).map((n) => `room${n}` as SectorId),
  "lobby",
];
/** Publish a draft onto the floor: generation record, fields and terminals. */
function commit(g: Game, f: Floor, draft: Draft, mainHp: number | undefined) {
  const { plan, roomOf, terminals } = draft;
  const ids = SECTOR_IDS(roomOf);
  const sectors: Sector[] = ids.map((id, order) => ({
    id,
    ...(order >= 1 && order <= 4
      ? { room: roomOf[order] as 0 | 1 | 2 | 3 }
      : {}),
    order,
    blocks: plan.blocks[order],
    corridors: plan.corridors[order],
    rooms: plan.rooms[order],
    ...(order < 5
      ? { gate: { x: plan.gates[order].x, y: plan.gates[order].y } }
      : {}),
  }));
  f.layout = "pursuit";
  f.generation = {
    version: 5,
    upperDivider: plan.blocks[5][0].y2 + 1,
    lowerDivider: plan.blocks[0][0].y1 - 1,
    family: plan.family,
    sectors,
  };
  f.rooms = [0, 1, 2, 3].map((index) => ({
    index,
    side: index % 2 === 0 ? ("left" as const) : ("right" as const),
  }));
  f.doors = [];
  f.furniture = [];
  const point = (gate: PlanGate) => ({ x: gate.x, y: gate.y });
  for (let order = 1; order <= 4; order++) {
    const room = roomOf[order],
      entry = plan.gates[order - 1],
      exit = plan.gates[order];
    f.doors[room] = point(entry);
    if (order === 1)
      fieldDoor(
        g,
        f,
        `f${f.index}-room${room}-door`,
        point(entry),
        entry.w,
        entry.h,
        "public",
      );
    fieldDoor(
      g,
      f,
      `f${f.index}-room${room}-forward`,
      point(exit),
      exit.w,
      exit.h,
      "forward",
      room,
      exit.direction,
    );
    Object.assign(f.rooms[room], {
      forwardEntry: point(entry),
      forwardExit: point(exit),
    });
  }
  if (f.index === 0) {
    for (let y = 29; y < H; y++)
      for (let x = 18; x <= 25; x++) f.tiles[y][x] = 0;
    const main = fieldDoor(g, f, "main-gate", { x: 22, y: 28.5 }, 4, 1, "gate");
    main.hp = main.maxHp = mainHp ?? 600;
    main.field!.exit = false;
  }
  for (let order = 1; order <= 4; order++) {
    const stations = f.stations.filter(
      (s) =>
        g.encounters[s.encounter].questionRoom ===
        `f${f.index}-room${roomOf[order]}`,
    );
    stations.forEach((s, i) => Object.assign(s, terminals[order][i]));
  }
}

const FAMILIES: PlanFamily[] = ["stack", "columns", "serpentine"];
/** Build a version 5 floor: draw a family and its parameters, validate, and
 * retry (at most 24 draws) before the default stack plan. */
export function planOfficeFloor(
  g: Game,
  f: Floor,
  random: Rng,
  validate: (f: Floor) => string[],
) {
  // An open site's layers above ground are solid, not planned storeys.
  if (isSolidOpenFloor(f)) return;
  const counts = [0, 1, 2, 3].map(
    (n) =>
      f.stations.filter(
        (s) =>
          g.encounters[s.encounter].questionRoom === `f${f.index}-room${n}`,
      ).length,
  );
  const mainHp = f.furniture.find((o) => o.id === "main-gate")?.maxHp;
  let errors: string[] = ["no plan"];
  for (let i = 0; i < (f.design ? 64 : 24 + 8); i++) {
    const fallback = !f.design && i >= 24;
    // Bands are hallway-like, so they are drawn rarely and otherwise serve as
    // the fallback; departments side by side or around a spine come first.
    const family: PlanFamily =
      f.design?.family ??
      (fallback
        ? "stack"
        : rand(random) < 0.125
          ? "stack"
          : FAMILIES[1 + int(random, 0, 1)]);
    const draft = attempt(f, random, family, fallback, counts);
    if (!draft) continue;
    commit(g, f, draft, mainHp);
    errors = validate(f);
    if (!errors.length) return;
  }
  throw new Error(`Invalid office floor ${f.index}: ${errors.join("; ")}`);
}
