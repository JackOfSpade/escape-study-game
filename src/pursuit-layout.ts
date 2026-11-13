import {
  type Game,
  type Floor,
  type Furniture,
  type Point,
  H,
  W,
  rand,
} from "./model";
import { carveStairwells } from "./stairwell";
import { isSolidOpenFloor } from "./open-site";
import { layoutRandom } from "./building-layout";
import { inRect, sizeFits, type Sector } from "./floor-plan";
import { carveRoomShapes, cornerCells } from "./room-shapes";
import { fieldClearance } from "./office-layout";
import {
  fieldDoor,
  forwardFieldQuota,
  planOfficeFloor,
  wideFlood,
} from "./office-plan";

/** The first free hall has an independent one-use terminal for everyone, plus spares. */
function topUpHall(g: Game, f: Floor) {
  const prefix = `f${f.index}-room2`,
    rear = f.stations.filter(
      (s) => g.encounters[s.encounter].questionRoom === prefix,
    );
  const template = g.encounters[rear[0].encounter];
  for (let i = rear.length; i < g.survivors.length + 4; i++) {
    const id = `${prefix}-pursuit${i}`;
    g.encounters[id] = {
      ...structuredClone(template),
      id,
      questionRoom: prefix,
    };
    const station = { id: `${id}-station`, encounter: id, x: 0, y: 0 };
    f.stations.push(station);
    rear.push(station);
  }
}

/** Fresh force-field floors have no corridor around their study rooms.
 * With a building boundary the floor is a version 5 office plan (see
 * office-plan.ts); without one it keeps the historical version 3 bands, each
 * complete transverse room a cut between the rear entry and front stairs. */
export function pursuitLayout(g: Game, f: Floor) {
  if (isSolidOpenFloor(f) || f.index === 4 || !f.stations.length) return;
  if (f.boundary) {
    topUpHall(g, f);
    planOfficeFloor(
      g,
      f,
      layoutRandom(f.design?.layoutSeed ?? g.seed, 0x726f6f6d, f.index),
      (fl) => pursuitLayoutErrors(g, fl),
    );
    // Designed room shapes: carve corners now that routes and terminals are
    // fixed (absent roomShapes does nothing and draws no random numbers).
    carveRoomShapes(
      f,
      (fl) => pursuitLayoutErrors(g, fl),
      f.design && "roomShapes" in f.design ? fieldClearance(f) : [],
    );
    return;
  }
  const random = { rng: (g.seed ^ Math.imul(f.index + 1, 0x6d2b79f5)) >>> 0 };
  // Allocate the available depth instead of independently rolling room sizes:
  // every stage keeps a usable interior and the stair/entry lobbies stay connected.
  const depths = [5, 4, 4, 4];
  const rearRow = 25;
  const frontRow = 5;
  for (let spare = rearRow - frontRow - 17; spare > 0; spare--)
    depths[Math.floor(rand(random) * depths.length)]++;
  const order = [3, 0, 1];
  let rearWall = rearRow;
  const stages = [2, ...order].map((room, i) => {
    const stage = { room, rear: rearWall, front: rearWall - depths[i] };
    rearWall = stage.front;
    return stage;
  });
  const bounds = stages.map(() => ({
    left: 2 + Math.floor(rand(random) * 4),
    right: 42 - Math.floor(rand(random) * 4),
  }));
  f.layout = "pursuit";
  f.generation = {
    version: 3,
    upperDivider: stages[2].front,
    lowerDivider: stages[0].front,
    stages,
  };
  f.tiles = Array.from({ length: H }, (_, y) =>
    Array.from({ length: W }, (_, x) =>
      x >= 2 && x < 42 && y >= 2 && y < 28 ? 0 : 1,
    ),
  );
  for (const row of [stages[0].rear, ...stages.map((s) => s.front)])
    for (let x = 2; x < 42; x++) f.tiles[row][x] = 1;
  // Historical floors keep their independent side recesses.
  for (const [i, stage] of stages.entries())
    for (let y = stage.front + 1; y < stage.rear; y++)
      for (let x = 2; x < 42; x++)
        if (x < bounds[i].left || x >= bounds[i].right) f.tiles[y][x] = 1;
  f.entry = { x: 21.5, y: 26.5 };
  f.stairs = { x: 21.5, y: 3.5 };
  // Staircases are real wells in the north and south boundary walls.
  carveStairwells(f);
  f.rooms = [0, 1, 2, 3].map((index) => ({
    index,
    side: index % 2 === 0 ? ("left" as const) : ("right" as const),
  }));
  f.doors = [];
  const originalMain = f.furniture.find((o) => o.id === "main-gate");
  f.furniture = [];
  const add = (
    id: string,
    point: Point,
    w: number,
    h: number,
    kind: "public" | "forward" | "gate",
    room = 0,
  ) => fieldDoor(g, f, id, point, w, h, kind, room);
  // One opening per shared wall: each stage's single forward field is green
  // with floor access, admits a few first-touch visitors from the rear, and
  // otherwise needs a personal key. A red field cannot be walked around.
  const exits = stages.map((stage) => {
    let x = 21.5;
    if (stage.room !== 1)
      x = 7.5 + Math.floor(rand(random) * 7) + (rand(random) < 0.5 ? 0 : 23);
    return { x, y: stage.front + 0.5 };
  });
  for (const [i, stage] of stages.entries()) {
    // The retired separate entry position was rolled here; keep consuming the
    // roll so each seed's room sizes and terminal arrangement stay unchanged.
    if (i > 0) rand(random);
    const entry =
      i === 0 ? { x: 21.5, y: stage.rear + 0.5 } : { ...exits[i - 1] };
    const exit = exits[i];
    f.doors[stage.room] = entry;
    if (i === 0)
      add(`f${f.index}-room${stage.room}-door`, entry, 3, 1, "public");
    add(
      `f${f.index}-room${stage.room}-forward`,
      exit,
      3,
      1,
      "forward",
      stage.room,
    );
    Object.assign(f.rooms[stage.room], {
      forwardEntry: entry,
      forwardExit: exit,
    });
  }
  if (f.index === 0) {
    for (let y = 29; y < H; y++)
      for (let x = 18; x <= 25; x++) f.tiles[y][x] = 0;
    const main = add("main-gate", { x: 22, y: 28.5 }, 4, 1, "gate");
    main.hp = main.maxHp = originalMain?.maxHp ?? 600;
    main.field!.exit = false;
  }
  topUpHall(g, f);
  for (const [index, stage] of stages.entries()) {
    const stations = f.stations.filter(
      (s) =>
        g.encounters[s.encounter].questionRoom ===
        `f${f.index}-room${stage.room}`,
    );
    const { left, right } = bounds[index];
    const columns = stage.room === 2 ? 12 : 3 + Math.floor(rand(random) * 4);
    const rows = Math.ceil(stations.length / columns);
    const slots = Array.from({ length: rows * columns }, (_, i) => i);
    // Shuffle assignment, not independent coordinates: no terminal overlaps,
    // and every terminal retains room for physical work and circulation.
    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.floor(rand(random) * (i + 1));
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }
    const offset = rand(random) * 0.3 - 0.15;
    for (const [i, s] of stations.entries()) {
      const slot = slots[i];
      s.x =
        left + 1.5 + ((slot % columns) * (right - left - 3)) / (columns - 1);
      s.y =
        rows === 1
          ? (stage.front + 1 + stage.rear) / 2 + offset
          : stage.front +
            1.65 +
            (Math.floor(slot / columns) * (stage.rear - stage.front - 2.3)) /
              (rows - 1) +
            offset;
    }
  }
  const errors = pursuitLayoutErrors(g, f);
  if (errors.length)
    throw new Error(`Invalid pursuit floor ${f.index}: ${errors.join("; ")}`);
}

const covers = (o: Furniture, x: number, y: number) =>
  Math.abs(x + 0.5 - o.x) < o.w / 2 && Math.abs(y + 0.5 - o.y) < o.h / 2;
/** Open cells reachable from start, avoiding blocked fields and cells. */
function floodFrom(
  f: Floor,
  start: Point,
  blocked: Furniture[],
  cut?: (x: number, y: number) => boolean,
) {
  const seen = new Set<number>();
  const queue = [{ x: Math.floor(start.x), y: Math.floor(start.y) }];
  for (let i = 0; i < queue.length; i++) {
    const { x, y } = queue[i],
      key = y * W + x;
    if (
      x < 0 ||
      x >= W ||
      y < 0 ||
      y >= H ||
      seen.has(key) ||
      f.tiles[y][x] ||
      cut?.(x, y) ||
      blocked.some((o) => covers(o, x, y))
    )
      continue;
    seen.add(key);
    queue.push(
      { x: x + 1, y },
      { x: x - 1, y },
      { x, y: y + 1 },
      { x, y: y - 1 },
    );
  }
  return seen;
}
const contains = (seen: Set<number>, p: Point) =>
  seen.has(Math.floor(p.y) * W + Math.floor(p.x));
/** Study stations reachable from the entrance without spending a key. */
export function zeroKeyTerminals(f: Floor): number {
  const freeStudy = floodFrom(
    f,
    f.entry,
    f.furniture.filter((o) => o.field && !o.field.publicEntry),
  );
  return f.stations.filter((s) => contains(freeStudy, s)).length;
}

/** Terminal checks shared by every fresh floor: credentialed egress with all
 * entrance quotas exhausted, zero-key capacity, clearance and spacing. */
function stationErrors(g: Game, f: Floor, fields: Furniture[]) {
  const errors: string[] = [];
  const sealed = fields.filter(
    (o) => !o.field!.exit && o.field!.limit !== undefined,
  );
  const egress = floodFrom(f, f.stairs, sealed);
  const freeCount = zeroKeyTerminals(f);
  for (const s of f.stations) {
    if (!contains(egress, s))
      errors.push(`no credentialed egress from ${s.id}`);
    for (const dx of [-0.45, 0.45])
      for (const dy of [-0.45, 0.45])
        if (f.tiles[Math.floor(s.y + dy)]?.[Math.floor(s.x + dx)] !== 0)
          errors.push(`terminal lacks clearance ${s.id}`);
  }
  for (let i = 0; i < f.stations.length; i++)
    for (const other of f.stations.slice(i + 1))
      if (
        Math.hypot(f.stations[i].x - other.x, f.stations[i].y - other.y) < 1.4
      )
        errors.push(`overlapping study space ${f.stations[i].id}/${other.id}`);
  if (freeCount < g.survivors.length)
    errors.push("insufficient zero-key terminals");
  return errors;
}

/** Validate actual generated tiles, openings and destinations before publishing
 * a fresh floor. No learning state or physics engine is involved. */
export function pursuitLayoutErrors(g: Game, f: Floor): string[] {
  if (isSolidOpenFloor(f)) return [];
  if (f.generation?.version === 5) return officePlanErrors(g, f);
  const errors: string[] = [];
  const stages = f.generation?.stages;
  if (!stages?.length) return ["missing stages"];
  const fields = f.furniture.filter((o) => o.field);
  for (const row of [stages[0].rear, ...stages.map((s) => s.front)])
    for (let x = 0; x < W; x++)
      if (
        !f.tiles[row][x] &&
        fields.filter((o) => covers(o, x, row)).length !== 1
      )
        errors.push(`uncovered or overlapping opening ${x},${row}`);
  // One opening per wall: a red field must have no green neighbour to walk to.
  for (const row of [stages[0].rear, ...stages.map((s) => s.front)]) {
    const count = fields.filter((o) => Math.floor(o.y) === row).length;
    if (count !== 1) errors.push(`wall ${row} has ${count} openings`);
  }
  errors.push(...stationErrors(g, f, fields));
  // Removing any occupied stage must sever every rear-to-stairs path.
  for (const stage of stages) {
    const cut: Furniture = {
      ...fields[0],
      x: 22,
      y: (stage.front + 1 + stage.rear) / 2,
      w: 40,
      h: stage.rear - stage.front - 1,
    };
    if (contains(floodFrom(f, f.entry, [cut]), f.stairs))
      errors.push(`bypass around room ${stage.room}`);
  }
  return errors;
}

/** Version 5: sector cover, one field per consecutive pair, cut property,
 * wide circulation, walled sub-rooms and the shared terminal checks. */
function officePlanErrors(g: Game, f: Floor): string[] {
  const errors: string[] = [];
  const sectors = f.generation?.sectors ?? [];
  const ids = sectors.map((s) => s.id);
  if (
    sectors.length !== 6 ||
    ids[0] !== "entry" ||
    ids[1] !== "room2" ||
    ids[5] !== "lobby" ||
    [...ids.slice(2, 5)].sort().join() !== "room0,room1,room3" ||
    sectors.some((s, i) => s.order !== i)
  )
    return ["bad sector chain"];
  const b = f.boundary;
  if (!b) return ["missing boundary"];
  const inside = (x: number, y: number) =>
    y >= b.top && y < b.bottom && x >= b.rows[y].left && x < b.rows[y].right;
  const owner = new Int8Array(W * H).fill(-1);
  for (const s of sectors)
    for (const r of s.blocks)
      for (let y = r.y1; y <= r.y2; y++)
        for (let x = r.x1; x <= r.x2; x++) {
          if (!inside(x, y)) continue;
          if (owner[y * W + x] >= 0)
            errors.push(`sectors overlap at ${x},${y}`);
          owner[y * W + x] = s.order;
        }
  const fields = f.furniture.filter((o) => o.field);
  const chain = fields.filter((o) => o.id !== "main-gate");
  for (let y = b.top; y < b.bottom; y++)
    for (let x = 0; x < W; x++)
      if (
        inside(x, y) &&
        !f.tiles[y][x] &&
        owner[y * W + x] < 0 &&
        fields.filter((o) => covers(o, x, y)).length !== 1
      )
        errors.push(`uncovered or overlapping opening ${x},${y}`);
  const at = (x: number, y: number) =>
    x < 0 || y < 0 || x >= W || y >= H ? -1 : owner[y * W + x];
  // The sector cell in front of a field's middle cell, on the given order's side.
  const front = (o: Furniture, order: number): Point | undefined => {
    const cx = Math.floor(o.x),
      cy = Math.floor(o.y);
    for (const s of [-1, 1]) {
      const p = o.h > o.w ? { x: cx + s, y: cy } : { x: cx, y: cy + s };
      if (at(p.x, p.y) === order) return p;
    }
    return undefined;
  };
  const pairs = [0, 0, 0, 0, 0];
  const gates: (Furniture | undefined)[] = [];
  for (const o of chain) {
    const vertical = o.h > o.w,
      cx = Math.floor(o.x),
      cy = Math.floor(o.y);
    const a = vertical ? at(cx - 1, cy) : at(cx, cy - 1),
      c = vertical ? at(cx + 1, cy) : at(cx, cy + 1),
      k = Math.min(a, c);
    if (a < 0 || c < 0 || Math.abs(a - c) !== 1) {
      errors.push(`field ${o.id} joins no consecutive sectors`);
      continue;
    }
    pairs[k]++;
    gates[k] = o;
    if (vertical ? o.w !== 1 || o.h !== 3 : o.w !== 3 || o.h !== 1)
      errors.push(`field ${o.id} is not a 3-cell opening`);
    const expected =
      k === 0 ? `f${f.index}-room2-door` : `f${f.index}-${ids[k]}-forward`;
    if (o.id !== expected) errors.push(`field ${o.id} should be ${expected}`);
    const prevSide = a === k ? -1 : 1;
    const room = sectors[k].room ?? 0;
    if (k === 0 && !o.field!.publicEntry)
      errors.push(`public gate ${o.id} is not public`);
    if (
      k > 0 &&
      (!o.field!.exit ||
        o.field!.limit !== forwardFieldQuota(g, f, room) ||
        o.field!.direction !== -prevSide)
    )
      errors.push(`forward field ${o.id} has wrong rules`);
  }
  pairs.forEach((n, k) => {
    if (n !== 1) errors.push(`sectors ${k}/${k + 1} share ${n} fields`);
  });
  errors.push(...stationErrors(g, f, fields));
  // Blocking any study sector must sever every entry-to-stairs path.
  for (const s of sectors.slice(1, 5))
    if (
      contains(
        floodFrom(f, f.entry, [], (x, y) => owner[y * W + x] === s.order),
        f.stairs,
      )
    )
      errors.push(`bypass around ${s.id}`);
  errors.push(...sectorShapeErrors(g, f, sectors, gates, owner, front));
  return errors;
}

/** Wide-cell connectivity per sector and walled single-doorway sub-rooms. */
function sectorShapeErrors(
  g: Game,
  f: Floor,
  sectors: Sector[],
  gates: (Furniture | undefined)[],
  owner: Int8Array,
  front: (o: Furniture, order: number) => Point | undefined,
) {
  const errors: string[] = [];
  const b = f.boundary!;
  // Corners carved by a designed room shape are solid by intent.
  const carved = new Set(
    (f.generation?.corners ?? [])
      .flatMap(cornerCells)
      .map((c) => c.y * W + c.x),
  );
  for (const s of sectors) {
    const k = s.order;
    const inSector = (x: number, y: number) =>
      x >= 0 && y >= 0 && x < W && y < H && owner[y * W + x] === k;
    const previous = gates[k - 1],
      next = gates[k];
    const start =
      k === 0 ? { x: 21, y: b.bottom - 1 } : previous && front(previous, k);
    const exit = k === 5 ? { x: 21, y: b.top } : next && front(next, k);
    if (!start || !exit) {
      errors.push(`sector ${s.id} gate fronts missing`);
      continue;
    }
    const seen = wideFlood(f.tiles, inSector, start);
    const reach = (p: Point) => seen[p.y * W + p.x] === 1;
    if (!reach(exit)) errors.push(`sector ${s.id} gates lack wide route`);
    const prefix = `f${f.index}-${s.id}`;
    for (const st of f.stations) {
      if (g.encounters[st.encounter]?.questionRoom !== prefix) continue;
      const p = { x: Math.floor(st.x), y: Math.floor(st.y) };
      if (!inSector(p.x, p.y)) errors.push(`terminal ${st.id} outside ${s.id}`);
      else if (!reach(p)) errors.push(`terminal ${st.id} lacks wide route`);
    }
    for (const room of s.rooms) {
      const { rect, doorway } = room;
      if (!sizeFits(room.kind, rect.x2 - rect.x1 + 1, rect.y2 - rect.y1 + 1))
        errors.push(`sub-room ${room.id} has a bad size`);
      const doorCells =
        (doorway.x2 - doorway.x1 + 1) * (doorway.y2 - doorway.y1 + 1);
      let open = 0,
        doorOpen = 0;
      for (let y = rect.y1 - 1; y <= rect.y2 + 1; y++)
        for (let x = rect.x1 - 1; x <= rect.x2 + 1; x++) {
          const ring = !inRect(rect, x, y);
          if (
            !ring &&
            ((f.tiles[y][x] && !carved.has(y * W + x)) || !inSector(x, y))
          )
            errors.push(`sub-room ${room.id} interior blocked at ${x},${y}`);
          if (ring && !f.tiles[y][x]) {
            open++;
            if (inRect(doorway, x, y)) doorOpen++;
          }
        }
      if (doorCells !== 2 || open !== 2 || doorOpen !== 2)
        errors.push(`sub-room ${room.id} needs exactly one 2-cell doorway`);
      if (!reach({ x: doorway.x1, y: doorway.y1 }))
        errors.push(`sub-room ${room.id} doorway lacks wide route`);
    }
  }
  return errors;
}
