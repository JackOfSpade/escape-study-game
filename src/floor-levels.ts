import type { Floor, Point } from "./model";
import type { RunHallFeatures, RunHallSide } from "./run-design-contract.mjs";
import { freeFloor } from "./free-design";
import { hallSectors, inRect, type Rect, type Sector } from "./floor-plan";

/** Stepped floor levels inside a hall room (floors[].hall).
 *
 * A level is a height per floor cell, in units of 15 cm. Neighbouring cells
 * never differ by more than one step (two units, 30 cm), so every level is
 * reached by walking: a stage, a pit or a platform ends in steps rather than a
 * sheer edge. Walking, routing, sight and sound stay the flat per-storey
 * systems they were; the level only says how high the floor, the furniture and
 * the people standing on a cell are. */
const LEVEL_UNIT = 0.15;
/** Largest height difference between neighbouring cells, in units. */
export const LEVEL_STEP_UNITS = 2;
/** Ceiling of a hall above its lowest ordinary floor, in metres. Other rooms
 * keep the 2.82 m ceiling. */
export const HALL_CEILING = 3.38;
const ROOM_CEILING = 2.82;

export interface FloorLevels {
  /** Inclusive cell rectangle the units cover. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Row-major heights in LEVEL_UNIT steps; 0 is the storey's own floor. */
  units: number[];
}

const levelsOf = (f: Pick<Floor, "generation">) =>
  f.generation?.levels as FloorLevels | undefined;

/** Height of a floor cell above its storey, in units. */
export function cellUnits(
  f: Pick<Floor, "generation">,
  cx: number,
  cy: number,
) {
  const l = levelsOf(f);
  if (!l || cx < l.x1 || cx > l.x2 || cy < l.y1 || cy > l.y2) return 0;
  return l.units[(cy - l.y1) * (l.x2 - l.x1 + 1) + (cx - l.x1)] ?? 0;
}
/** Height of a floor cell above its storey, in metres. */
export const cellLevel = (
  f: Pick<Floor, "generation">,
  cx: number,
  cy: number,
) => cellUnits(f, cx, cy) * LEVEL_UNIT;

/** Whether a floor has any level change at all (cheap guard for hot paths). */
export const hasLevels = (f: Pick<Floor, "generation">) => !!levelsOf(f);

/** Height of the ground under a point, in metres above its storey: the cell
 * heights blended between cell centres, so a body climbing steps rises
 * smoothly instead of jumping at each cell edge. */
export function groundLevel(f: Pick<Floor, "generation" | "tiles">, p: Point) {
  const l = levelsOf(f);
  if (!l) return 0;
  const cx = Math.floor(p.x),
    cy = Math.floor(p.y);
  if (cx < l.x1 - 1 || cx > l.x2 + 1 || cy < l.y1 - 1 || cy > l.y2 + 1)
    return 0;
  const own = cellUnits(f, cx, cy);
  // Walls carry no level: a body beside one stands at its own cell's height.
  const at = (x: number, y: number) =>
    f.tiles[y]?.[x] === 0 ? cellUnits(f, x, y) : own;
  const fx = p.x - 0.5,
    fy = p.y - 0.5,
    x0 = Math.floor(fx),
    y0 = Math.floor(fy),
    tx = fx - x0,
    ty = fy - y0;
  const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx,
    bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
  return (top * (1 - ty) + bottom * ty) * LEVEL_UNIT;
}

/** Ceiling height above the storey floor at a cell: a hall is taller. */
export function ceilingHeight(
  f: Pick<Floor, "generation">,
  cx: number,
  cy: number,
) {
  return hallSectors(f).some((s) => s.blocks.some((b) => inRect(b, cx, cy)))
    ? HALL_CEILING
    : ROOM_CEILING;
}

/** Lowest and highest level on a floor, in metres. */
export function levelRange(f: Pick<Floor, "generation">) {
  const units = levelsOf(f)?.units ?? [];
  let low = 0,
    high = 0;
  for (const u of units) {
    if (u < low) low = u;
    if (u > high) high = u;
  }
  return { low: low * LEVEL_UNIT, high: high * LEVEL_UNIT };
}

const units = (metres: number) => Math.round(metres / LEVEL_UNIT);
/** Cells of intermediate steps between the floor and a height in units. */
const stepCells = (height: number) =>
  Math.max(0, Math.ceil(Math.abs(height) / LEVEL_STEP_UNITS) - 1);

/** Depth of a cell from a wall of a rectangle (0 = the row on that wall) and
 * its position along that wall (0 = the first cell). */
function fromSide(box: Rect, side: RunHallSide, x: number, y: number) {
  switch (side) {
    case "n":
      return { depth: y - box.y1, along: x - box.x1 };
    case "s":
      return { depth: box.y2 - y, along: x - box.x1 };
    case "w":
      return { depth: x - box.x1, along: y - box.y1 };
    case "e":
      return { depth: box.x2 - x, along: y - box.y1 };
  }
}
const extent = (box: Rect, side: RunHallSide) =>
  side === "n" || side === "s"
    ? { depth: box.y2 - box.y1 + 1, along: box.x2 - box.x1 + 1 }
    : { depth: box.x2 - box.x1 + 1, along: box.y2 - box.y1 + 1 };

/** The wanted height of each hall cell before steps are cut, in units. */
function wantedUnits(hall: RunHallFeatures, box: Rect, x: number, y: number) {
  const size = extent(box, hall.focus),
    at = fromSide(box, hall.focus, x, y),
    // A raised area keeps its authored flat size: the steps down from it are
    // cut from extra cells in front of it.
    stageDepth = hall.stage
      ? Math.min(
          hall.stage.depth + stepCells(units(hall.stage.height)),
          size.depth - 4,
        )
      : 0;
  let out = 0;
  if (hall.stage && at.depth < stageDepth) out = units(hall.stage.height);
  else if (hall.rake > 0) {
    // The floor climbs from the foot of the stage to the far wall.
    const run = Math.max(1, size.depth - 1 - stageDepth);
    out = units((hall.rake * (at.depth - stageDepth)) / run);
  }
  if (hall.pit) {
    // A sunken area in front of the stage, centred across the hall.
    const width = Math.min(hall.pit.width, size.along - 4),
      first = Math.floor((size.along - width) / 2),
      start = stageDepth + 1;
    if (
      at.depth >= start &&
      at.depth < start + hall.pit.length &&
      at.along >= first &&
      at.along < first + width
    )
      out = -units(hall.pit.drop);
  }
  for (const platform of hall.platforms) {
    const side = extent(box, platform.side),
      here = fromSide(box, platform.side, x, y),
      steps = stepCells(units(platform.height)),
      width = Math.min(platform.width + 2 * steps, side.along - 2),
      first = Math.floor((side.along - width) / 2);
    if (
      here.depth < platform.depth + steps &&
      here.along >= first &&
      here.along < first + width
    )
      out = Math.max(out, units(platform.height));
  }
  return out;
}

/** The halls of a floor with their authored features: the one merged hall of
 * a chain floor, or every drawn room of a free plan that has hall features. */
function authoredHalls(f: Floor): { sector: Sector; hall: RunHallFeatures }[] {
  const design = f.design,
    drawn = freeFloor(f),
    sectors = hallSectors(f);
  if (!design) return [];
  if (drawn)
    return sectors.flatMap((sector) => {
      const hall = drawn.rooms[sector.room ?? -1]?.hall;
      return hall ? [{ sector, hall }] : [];
    });
  return "hall" in design && design.hall && sectors[0]
    ? [{ sector: sectors[0], hall: design.hall }]
    : [];
}

/** Build the levels of a floor's halls from its design, or undefined when
 * they are all flat. Cells within two cells of a field opening or doorway
 * stay at storey height, and every height difference is cut back into 30 cm
 * steps. */
export function buildHallLevels(f: Floor): FloorLevels | undefined {
  const built = authoredHalls(f).flatMap(({ sector, hall }) => {
    const levels = hallLevels(f, sector, hall);
    return levels ? [levels] : [];
  });
  if (!built.length) return undefined;
  if (built.length === 1) return built[0];
  // Several halls share one grid over their common bounding rectangle.
  const box: Rect = {
    x1: Math.min(...built.map((l) => l.x1)),
    y1: Math.min(...built.map((l) => l.y1)),
    x2: Math.max(...built.map((l) => l.x2)),
    y2: Math.max(...built.map((l) => l.y2)),
  };
  const cols = box.x2 - box.x1 + 1,
    units = new Array<number>(cols * (box.y2 - box.y1 + 1)).fill(0);
  for (const l of built) {
    const width = l.x2 - l.x1 + 1;
    l.units.forEach((u, i) => {
      if (!u) return;
      const x = l.x1 + (i % width),
        y = l.y1 + Math.floor(i / width);
      units[(y - box.y1) * cols + (x - box.x1)] = u;
    });
  }
  return { ...box, units };
}

function hallLevels(
  f: Floor,
  sector: Sector,
  hall: RunHallFeatures,
): FloorLevels | undefined {
  const box: Rect = {
    x1: Math.min(...sector.blocks.map((b) => b.x1)),
    y1: Math.min(...sector.blocks.map((b) => b.y1)),
    x2: Math.max(...sector.blocks.map((b) => b.x2)),
    y2: Math.max(...sector.blocks.map((b) => b.y2)),
  };
  const cols = box.x2 - box.x1 + 1,
    rows = box.y2 - box.y1 + 1,
    index = (x: number, y: number) => (y - box.y1) * cols + (x - box.x1),
    open = (x: number, y: number) =>
      x >= box.x1 &&
      x <= box.x2 &&
      y >= box.y1 &&
      y <= box.y2 &&
      f.tiles[y]?.[x] === 0 &&
      sector.blocks.some((b) => inRect(b, x, y));
  const fields = f.furniture.filter((o) => o.field),
    doorways = f.generation?.doorways ?? [];
  const flat = (x: number, y: number) =>
    fields.some(
      (o) =>
        Math.abs(x + 0.5 - o.x) < o.w / 2 + 2 &&
        Math.abs(y + 0.5 - o.y) < o.h / 2 + 2,
    ) ||
    doorways.some(
      (d) => x >= d.x1 - 2 && x <= d.x2 + 2 && y >= d.y1 - 2 && y <= d.y2 + 2,
    );
  const value = new Array<number>(cols * rows).fill(0),
    cells: Point[] = [],
    anchors: Point[] = [];
  for (let y = box.y1; y <= box.y2; y++)
    for (let x = box.x1; x <= box.x2; x++) {
      if (!open(x, y)) continue;
      cells.push({ x, y });
      if (flat(x, y)) anchors.push({ x, y });
      else value[index(x, y)] = wantedUnits(hall, box, x, y);
    }
  const around = (c: Point) =>
    [
      { x: c.x + 1, y: c.y },
      { x: c.x - 1, y: c.y },
      { x: c.x, y: c.y + 1 },
      { x: c.x, y: c.y - 1 },
    ].filter((n) => open(n.x, n.y));
  // A pit may only sink as fast as steps can climb back to a flat opening.
  const far = new Array<number>(cols * rows).fill(Infinity),
    queue = [...anchors];
  for (const a of anchors) far[index(a.x, a.y)] = 0;
  for (let i = 0; i < queue.length; i++)
    for (const n of around(queue[i]))
      if (far[index(n.x, n.y)] === Infinity) {
        far[index(n.x, n.y)] = far[index(queue[i].x, queue[i].y)] + 1;
        queue.push(n);
      }
  for (const c of cells) {
    const i = index(c.x, c.y);
    if (far[i] !== Infinity)
      value[i] = Math.max(value[i], -LEVEL_STEP_UNITS * far[i]);
  }
  // The highest floor that is nowhere above the wanted one and never steps
  // more than LEVEL_STEP_UNITS between neighbours: relax from the lowest cell.
  const order = [...cells].sort(
    (a, b) => value[index(a.x, a.y)] - value[index(b.x, b.y)],
  );
  for (let changed = true; changed;) {
    changed = false;
    for (const c of order) {
      const here = value[index(c.x, c.y)];
      for (const n of around(c)) {
        const i = index(n.x, n.y);
        if (value[i] > here + LEVEL_STEP_UNITS) {
          value[i] = here + LEVEL_STEP_UNITS;
          changed = true;
        }
      }
    }
  }
  if (value.every((v) => v === 0)) return undefined;
  return { ...box, units: value };
}

/** Problems with stored levels: a step too high to walk, a level on a wall's
 * far side of a field opening, or data that does not match its rectangle. */
export function levelErrors(f: Floor): string[] {
  const l = levelsOf(f);
  if (!l) return [];
  const cols = l.x2 - l.x1 + 1,
    rows = l.y2 - l.y1 + 1;
  if (
    l.units.length !== cols * rows ||
    l.units.some((u) => !Number.isInteger(u))
  )
    return ["levels do not match their rectangle"];
  const errors: string[] = [];
  const halls = hallSectors(f);
  for (let y = l.y1; y <= l.y2; y++)
    for (let x = l.x1; x <= l.x2; x++) {
      const here = cellUnits(f, x, y);
      if (f.tiles[y]?.[x] !== 0) continue;
      if (
        here &&
        !halls.some((hall) => hall.blocks.some((b) => inRect(b, x, y)))
      )
        errors.push(`level outside the hall at ${x},${y}`);
      for (const [nx, ny] of [
        [x + 1, y],
        [x, y + 1],
      ])
        if (
          f.tiles[ny]?.[nx] === 0 &&
          Math.abs(cellUnits(f, nx, ny) - here) > LEVEL_STEP_UNITS
        )
          errors.push(`step too high between ${x},${y} and ${nx},${ny}`);
    }
  for (const o of f.furniture)
    if (o.field)
      for (let y = Math.floor(o.y - o.h / 2 - 1); y <= o.y + o.h / 2 + 1; y++)
        for (let x = Math.floor(o.x - o.w / 2 - 1); x <= o.x + o.w / 2 + 1; x++)
          if (cellUnits(f, x, y)) errors.push(`level at opening ${x},${y}`);
  return errors;
}
