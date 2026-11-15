import { type Floor, type Game, type Point, type Station, H, W } from "./model";
import { footprintTiles } from "./building-layout";
import { carveStairwells, stairwellApproach } from "./stairwell";
import { fieldDoor, wideFlood } from "./office-plan";
import { carveRoomShapes } from "./room-shapes";
import { buildHallLevels, levelErrors } from "./floor-levels";
import { type Rect, type Sector, inRect } from "./floor-plan";
import { freeFloor, freeRooms, isFreePlan } from "./free-design";
import type { RunFreeRoom, RunHallSide } from "./run-design-contract.mjs";

export { freeFloor, freeRooms, isFreePlan };

/** Free floor plans (design version 4, generation version 6).
 *
 * The design draws each storey itself: a list of walled rooms inside the
 * building shell, each with its own doorways, standing in an open concourse
 * that joins the entrance to the stairs. There is no room chain, no force
 * field and no quota. The engine only guarantees what play needs: every open
 * cell, room and work point can be walked to from the entrance, the stairs
 * can be reached, and work points have room to stand at.
 *
 * Every problem is reported in one error so a repair round can fix them all.
 */
const interiorOf = (room: RunFreeRoom): Rect => ({
  x1: room.x,
  y1: room.y,
  x2: room.x + room.w - 1,
  y2: room.y + room.h - 1,
});
const label = (room: RunFreeRoom, i: number) => `room ${i} "${room.name}"`;
const key = (x: number, y: number) => y * W + x;

/** The two cells of a doorway in a room's wall ring and the cell just outside
 * each, for a door on `side` at fraction `at` along that wall. */
function doorwayCells(room: RunFreeRoom, side: RunHallSide, at: number) {
  const r = interiorOf(room),
    across = side === "n" || side === "s",
    length = across ? room.w : room.h,
    start = Math.round(at * (length - 2)),
    dx = side === "w" ? -1 : side === "e" ? 1 : 0,
    dy = side === "n" ? -1 : side === "s" ? 1 : 0;
  return [0, 1].map((i) => {
    const x = across ? r.x1 + start + i : side === "w" ? r.x1 - 1 : r.x2 + 1,
      y = across ? (side === "n" ? r.y1 - 1 : r.y2 + 1) : r.y1 + start + i;
    return {
      x,
      y,
      inside: { x: x - dx, y: y - dy },
      outside: { x: x + dx, y: y + dy },
    };
  });
}

/** Cells that must stay open concourse: the arrival lane inside the entrance
 * and the approach to each staircase. */
function reservedCells(f: Floor): Point[] {
  const b = f.boundary!,
    out: Point[] = [];
  for (let y = b.bottom - 3; y < b.bottom; y++)
    for (let x = 18; x <= 25; x++) out.push({ x, y });
  for (let y = b.top; y < b.top + 3; y++)
    for (let x = 19; x <= 24; x++) out.push({ x, y });
  for (const kind of ["up", "down"] as const)
    for (const p of stairwellApproach(f, kind))
      out.push({ x: Math.floor(p.x), y: Math.floor(p.y) });
  return out;
}

/** Maximal rectangles covering a set of cells: row runs merged downward. */
function rectsOf(cells: Set<number>): Rect[] {
  const out: Rect[] = [],
    open: Rect[] = [];
  for (let y = 0; y < H; y++) {
    const runs: Rect[] = [];
    for (let x = 0; x < W; x++) {
      if (!cells.has(key(x, y))) continue;
      const x1 = x;
      while (x + 1 < W && cells.has(key(x + 1, y))) x++;
      runs.push({ x1, y1: y, x2: x, y2: y });
    }
    for (const run of runs) {
      const above = open.find(
        (r) => r.x1 === run.x1 && r.x2 === run.x2 && r.y2 === y - 1,
      );
      if (above) above.y2 = y;
      else {
        open.push(run);
        out.push(run);
      }
    }
    for (let i = open.length - 1; i >= 0; i--)
      if (open[i].y2 !== y) open.splice(i, 1);
  }
  return out;
}

/** Work points of one room: cell centres on a lattice, clear of the walls,
 * the doorways and each other. */
function workPoints(
  f: Floor,
  room: RunFreeRoom,
  doorways: Rect[],
): Point[] | undefined {
  const r = interiorOf(room),
    candidates: Point[] = [];
  for (let y = r.y1; y <= r.y2; y++)
    for (let x = r.x1; x <= r.x2; x++) {
      if (f.tiles[y]?.[x] !== 0) continue;
      // A body must fit on every side of the station.
      let clear = true;
      for (let dy = -1; dy <= 1 && clear; dy++)
        for (let dx = -1; dx <= 1 && clear; dx++)
          if (f.tiles[y + dy]?.[x + dx] !== 0) clear = false;
      if (
        clear &&
        doorways.every(
          (d) =>
            Math.max(
              Math.max(d.x1 - x, x - d.x2, 0),
              Math.max(d.y1 - y, y - d.y2, 0),
            ) >= 2,
        )
      )
        candidates.push({ x, y });
    }
  for (const [sx, sy] of [
    [3, 3],
    [3, 2],
    [2, 2],
  ]) {
    const lattice = candidates.filter(
      (c) => (c.x - r.x1 - 1) % sx === 0 && (c.y - r.y1 - 1) % sy === 0,
    );
    if (lattice.length < room.work) continue;
    return Array.from({ length: room.work }, (_, i) => {
      const c = lattice[Math.floor((i * lattice.length) / room.work)];
      return { x: c.x + 0.5, y: c.y + 0.5 };
    });
  }
  return undefined;
}

/** Give each room its work stations: reuse the floor's stations and their
 * encounters, cloning when the plan asks for more and dropping the rest. */
function assignStations(g: Game, f: Floor, points: Point[][]) {
  const pool = [...f.stations],
    template = pool[0] && g.encounters[pool[0].encounter],
    kept: Station[] = [];
  points.forEach((list, room) =>
    list.forEach((p, i) => {
      const prefix = `f${f.index}-room${room}`;
      let station = pool.shift();
      if (!station) {
        if (!template) return;
        const id = `${prefix}-work${i}`;
        g.encounters[id] = { ...structuredClone(template), id };
        station = { id: `${id}-station`, encounter: id, x: 0, y: 0 };
      }
      delete station.facing;
      Object.assign(station, p);
      g.encounters[station.encounter].questionRoom = prefix;
      kept.push(station);
    }),
  );
  for (const unused of pool) delete g.encounters[unused.encounter];
  f.stations = kept;
}

/** Build a drawn floor onto `f`. Throws one error listing every problem. */
export function freePlanLayout(g: Game, f: Floor) {
  const design = freeFloor(f);
  if (!design || !f.boundary) return;
  const b = f.boundary,
    rooms = design.rooms,
    problems: string[] = [];
  const insideShell = (x: number, y: number) =>
    y >= b.top && y < b.bottom && x >= b.rows[y].left && x < b.rows[y].right;
  const rows = b.rows.slice(b.top, b.bottom),
    X0 = Math.min(...rows.map((r) => r.left)),
    X1 = Math.max(...rows.map((r) => r.right)) - 1;
  const mainHp = f.furniture.find((o) => o.id === "main-gate")?.maxHp;
  f.tiles = footprintTiles(b);
  f.entry = { x: 21.5, y: 26.5 };
  f.stairs = { x: 21.5, y: 3.5 };
  carveStairwells(f);
  f.furniture = [];
  if (f.index === 0) {
    for (let y = 29; y < H; y++)
      for (let x = 18; x <= 25; x++) f.tiles[y][x] = 0;
    const main = fieldDoor(g, f, "main-gate", { x: 22, y: 28.5 }, 4, 1, "gate");
    main.hp = main.maxHp = mainHp ?? 600;
    main.field!.exit = false;
  }
  const reserved = new Set(reservedCells(f).map((p) => key(p.x, p.y)));
  const interiors = rooms.map(interiorOf);
  rooms.forEach((room, i) => {
    const r = interiors[i];
    if (
      r.x1 < X0 + 1 ||
      r.x2 > X1 - 1 ||
      r.y1 < b.top + 1 ||
      r.y2 > b.bottom - 2
    )
      problems.push(
        `${label(room, i)} must lie inside x ${X0 + 1}..${X1 - 1}, y ${b.top + 1}..${b.bottom - 2} (its walls need one cell on every side)`,
      );
    for (let j = 0; j < i; j++) {
      const o = interiors[j];
      // Interiors need at least the one wall cell between them.
      if (
        r.x1 <= o.x2 + 1 &&
        o.x1 <= r.x2 + 1 &&
        r.y1 <= o.y2 + 1 &&
        o.y1 <= r.y2 + 1
      )
        problems.push(
          `${label(room, i)} overlaps or touches ${label(rooms[j], j)}: leave one wall cell between rooms`,
        );
    }
    for (let y = r.y1 - 1; y <= r.y2 + 1; y++)
      for (let x = r.x1 - 1; x <= r.x2 + 1; x++)
        if (reserved.has(key(x, y))) {
          problems.push(
            `${label(room, i)} covers the entrance lane or a stair approach near ${x},${y}: keep x 18..25 of the three southmost rows and x 19..24 of the three northmost rows open`,
          );
          y = r.y2 + 2;
          break;
        }
  });
  if (problems.length)
    throw Error(`Invalid drawn floor ${f.index}: ${problems.join("; ")}`);
  // Walls around every room; a wall shared by two rooms is one cell.
  for (const r of interiors)
    for (let y = r.y1 - 1; y <= r.y2 + 1; y++)
      for (let x = r.x1 - 1; x <= r.x2 + 1; x++)
        if (!inRect(r, x, y)) f.tiles[y][x] = 1;
  const doorways: Rect[][] = rooms.map(() => []);
  rooms.forEach((room, i) =>
    room.doors.forEach((door, d) => {
      const cells = doorwayCells(room, door.side, door.at);
      const blocked = cells.find(
        (c) =>
          !insideShell(c.outside.x, c.outside.y) ||
          (f.tiles[c.outside.y][c.outside.x] !== 0 &&
            !interiors.some((r) => inRect(r, c.outside.x, c.outside.y))),
      );
      if (blocked) {
        problems.push(
          `${label(room, i)} door ${d} (${door.side}) opens into a wall at ${blocked.outside.x},${blocked.outside.y}: put it on a side facing open floor or a room exactly one wall cell away`,
        );
        return;
      }
      for (const c of cells) f.tiles[c.y][c.x] = 0;
      doorways[i].push({
        x1: cells[0].x,
        y1: cells[0].y,
        x2: cells[1].x,
        y2: cells[1].y,
      });
    }),
  );
  const allDoorways = doorways.flat();
  const doorCells = new Set(
    allDoorways.flatMap((d) => [key(d.x1, d.y1), key(d.x2, d.y2)]),
  );
  const concourse = new Set<number>();
  for (let y = b.top; y < b.bottom; y++)
    for (let x = X0; x <= X1; x++)
      if (
        f.tiles[y][x] === 0 &&
        insideShell(x, y) &&
        !doorCells.has(key(x, y)) &&
        !interiors.some((r) => inRect(r, x, y))
      )
        concourse.add(key(x, y));
  const sectors: Sector[] = [
    {
      id: "entry",
      order: 0,
      blocks: rectsOf(concourse),
      corridors: [],
      rooms: [],
    },
    ...rooms.map((room, i): Sector => ({
      id: `room${i}`,
      room: i,
      order: i + 1,
      blocks: [interiors[i]],
      corridors: [],
      rooms: [],
      ...(room.hall ? { hall: true as const } : {}),
    })),
  ];
  f.layout = "pursuit";
  f.generation = {
    version: 6,
    upperDivider: b.top,
    lowerDivider: b.bottom - 1,
    sectors,
    doorways: allDoorways,
  };
  f.rooms = rooms.map((_, index) => ({
    index,
    side: index % 2 === 0 ? ("left" as const) : ("right" as const),
  }));
  f.doors = rooms.map((_, i) => {
    const d = doorways[i][0];
    return d
      ? { x: (d.x1 + d.x2 + 1) / 2, y: (d.y1 + d.y2 + 1) / 2 }
      : { x: interiors[i].x1 + 0.5, y: interiors[i].y1 + 0.5 };
  });
  // Corner shapes, before work points so nothing stands in a carved corner.
  // The template's stations are not placed yet and must not guard corners.
  const pending = f.stations;
  f.stations = [];
  carveRoomShapes(
    f,
    () => reachErrors(f),
    [
      ...reservedCells(f).map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 })),
      ...allDoorways.flatMap((d) => [
        { x: d.x1 + 0.5, y: d.y1 + 0.5 },
        { x: d.x2 + 0.5, y: d.y2 + 0.5 },
      ]),
    ],
    rooms.map((room) => room.shape),
  );
  f.stations = pending;
  const points = rooms.map((room, i) => {
    const out = workPoints(f, room, allDoorways);
    if (!out)
      problems.push(
        `${label(room, i)} (${room.w}×${room.h}) cannot hold ${room.work} work points 2 m apart and clear of its walls and doors: enlarge it or lower work`,
      );
    return out ?? [];
  });
  assignStations(g, f, points);
  const levels = buildHallLevels(f);
  if (levels) f.generation.levels = levels;
  problems.push(...freePlanErrors(g, f));
  if (problems.length)
    throw Error(`Invalid drawn floor ${f.index}: ${problems.join("; ")}`);
}

/** Open cells walkable from the entrance. */
function reached(f: Floor) {
  const seen = new Uint8Array(W * H),
    queue = [key(Math.floor(f.entry.x), Math.floor(f.entry.y))];
  while (queue.length) {
    const id = queue.pop()!,
      x = id % W,
      y = (id - x) / W;
    if (id < 0 || id >= W * H || seen[id] || f.tiles[y]?.[x] !== 0) continue;
    seen[id] = 1;
    if (x + 1 < W) queue.push(id + 1);
    if (x > 0) queue.push(id - 1);
    queue.push(id + W, id - W);
  }
  return seen;
}

/** Reachability of a drawn floor: the stairs, every room and every open cell
 * inside the shell can be walked to from the entrance. */
function reachErrors(f: Floor): string[] {
  const errors: string[] = [],
    seen = reached(f),
    b = f.boundary!,
    rooms = freeRooms(f);
  if (!seen[key(Math.floor(f.stairs.x), Math.floor(f.stairs.y))])
    errors.push("the stairs cannot be reached from the entrance");
  rooms.forEach((room, i) => {
    const r = interiorOf(room);
    let open = 0,
      walked = 0;
    for (let y = r.y1; y <= r.y2; y++)
      for (let x = r.x1; x <= r.x2; x++)
        if (f.tiles[y]?.[x] === 0) {
          open++;
          if (seen[key(x, y)]) walked++;
        }
    if (!walked)
      errors.push(
        `${label(room, i)} cannot be reached from the entrance: give it a door onto open floor or onto a room that has one`,
      );
    else if (walked < open)
      errors.push(`${label(room, i)} has a sealed pocket`);
  });
  // Crowds need two cells of width: the stairs and one door of every room
  // must be reached from the entrance without squeezing through a single cell.
  const wide = wideFlood(f.tiles, (x, y) => f.tiles[y]?.[x] === 0, {
    x: Math.floor(f.entry.x),
    y: Math.floor(f.entry.y),
  });
  if (
    !errors.length &&
    !wide[key(Math.floor(f.stairs.x), Math.floor(f.stairs.y))]
  )
    errors.push(
      "the only way from the entrance to the stairs is one cell wide somewhere: keep passages at least two cells wide",
    );
  const doorways = f.generation?.doorways ?? [];
  rooms.forEach((room, i) => {
    const r = interiorOf(room),
      own = doorways.filter(
        (d) =>
          d.x1 >= r.x1 - 1 &&
          d.x2 <= r.x2 + 1 &&
          d.y1 >= r.y1 - 1 &&
          d.y2 <= r.y2 + 1,
      );
    if (
      own.length &&
      !own.some((d) => wide[key(d.x1, d.y1)] && wide[key(d.x2, d.y2)]) &&
      !errors.some((e) => e.startsWith(label(room, i)))
    )
      errors.push(
        `${label(room, i)} is reached only through a passage one cell wide: widen the gap beside it to two cells or move a door`,
      );
  });
  let pockets = 0;
  for (let y = b.top; y < b.bottom; y++)
    for (let x = b.rows[y].left; x < b.rows[y].right; x++)
      if (
        f.tiles[y][x] === 0 &&
        !seen[key(x, y)] &&
        !rooms.some((room) => inRect(interiorOf(room), x, y))
      )
        pockets++;
  if (pockets)
    errors.push(
      `${pockets} open cells between rooms are sealed off: close the gap or leave a passage two cells wide`,
    );
  return errors;
}

/** Validate a built free floor: reachability, work-point clearance and
 * spacing, sector cover and stepped levels. */
export function freePlanErrors(g: Game, f: Floor): string[] {
  const sectors = f.generation?.sectors ?? [],
    rooms = freeRooms(f);
  if (!f.boundary) return ["missing boundary"];
  if (
    f.generation?.version !== 6 ||
    sectors.length !== rooms.length + 1 ||
    sectors[0].id !== "entry" ||
    sectors.some((s, i) => s.order !== i || (i > 0 && s.id !== `room${i - 1}`))
  )
    return ["drawn floor does not match its design"];
  const errors = reachErrors(f),
    seen = reached(f);
  for (const s of f.stations) {
    const room = Number(
        /-room(\d+)$/.exec(g.encounters[s.encounter]?.questionRoom ?? "")?.[1],
      ),
      sector = sectors[room + 1];
    if (
      !sector ||
      !sector.blocks.some((r) => inRect(r, Math.floor(s.x), Math.floor(s.y)))
    )
      errors.push(`work point ${s.id} is outside its room`);
    if (!seen[key(Math.floor(s.x), Math.floor(s.y))])
      errors.push(`work point ${s.id} cannot be reached`);
    for (const dx of [-0.45, 0.45])
      for (const dy of [-0.45, 0.45])
        if (f.tiles[Math.floor(s.y + dy)]?.[Math.floor(s.x + dx)] !== 0)
          errors.push(`work point ${s.id} lacks clearance`);
  }
  for (let i = 0; i < f.stations.length; i++)
    for (const other of f.stations.slice(i + 1))
      if (
        Math.hypot(f.stations[i].x - other.x, f.stations[i].y - other.y) < 1.4
      )
        errors.push(`work points ${f.stations[i].id}/${other.id} overlap`);
  rooms.forEach((room, i) => {
    const count = f.stations.filter(
      (s) => g.encounters[s.encounter]?.questionRoom === `f${f.index}-room${i}`,
    ).length;
    if (count !== room.work)
      errors.push(`${label(room, i)} has ${count} of ${room.work} work points`);
  });
  errors.push(...levelErrors(f));
  return errors;
}
