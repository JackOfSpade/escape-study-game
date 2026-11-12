import { catastropheState, omensDue } from "./catastrophe";
import { doorSideOf, latchDoor, lockDoor, unlockDoor } from "./doors";
import { damageSurvivor, human } from "./engine";
import type {
  Behaviour,
  CatastropheSpec,
  EscapeEvent,
  HunterBehaviour,
  PhaseName,
} from "./escape-types";
import { floorSectors } from "./floor-plan";
import {
  registerRoomPowerOverrides,
  roomIdAt,
  roomIdsForFloor,
  roomPowerAt,
} from "./interior-lighting";
import {
  distance,
  event,
  rand,
  type Actor,
  type Floor,
  type Game,
  type Point,
  type Zombie,
} from "./model";
import { solid } from "./spatial";
import { roomPowerKey } from "./room-power-key";
import { canSee } from "./visibility";

const MAX_LOG = 600;
const WARNING_LEAD = 1.5;

interface HunterState {
  start: number;
  next: number;
  spawned: number;
}
interface Flicker {
  key: string;
  until: number;
}
interface GasRoom {
  floor: number;
  id: string;
  until: number;
}
interface Warning {
  rule: number;
  at: number;
}
interface Runtime {
  phase: PhaseName | "calm";
  last: number;
  hazard: Map<number, Float32Array>;
  hazardStart: Map<number, number>;
  sight: Map<number, Float32Array>;
  hunters: Map<number, HunterState>;
  collapseNext: Map<number, number>;
  flickers: Flicker[];
  gas: GasRoom[];
  warned: WeakMap<Actor, Warning>;
}
const runtimes = new WeakMap<Game, Runtime>();

function runtime(g: Game, dt: number): Runtime {
  let rt = runtimes.get(g);
  if (!rt) {
    rt = {
      phase: "calm",
      last: Math.max(0, g.time - dt),
      hazard: new Map(),
      hazardStart: new Map(),
      sight: new Map(),
      hunters: new Map(),
      collapseNext: new Map(),
      flickers: [],
      gas: [],
      warned: new WeakMap(),
    };
    runtimes.set(g, rt);
  }
  return rt;
}

function appendLog(
  g: Game,
  kind: EscapeEvent["kind"],
  text: string,
  extra: Partial<EscapeEvent> = {},
) {
  const escape = g.escape;
  if (!escape) return;
  escape.log.push({
    at: g.time,
    kind,
    // Every area logs under its own id, even when the player is elsewhere.
    areaId: g.areaId ?? escape.areas.start,
    text,
    phase: runtimes.get(g)?.phase ?? "calm",
    ...extra,
  });
  if (escape.log.length > MAX_LOG)
    escape.log.splice(0, escape.log.length - MAX_LOG);
}

const cellCache = new WeakMap<
  Floor,
  { tiles: Floor["tiles"]; poses: number; tick: number; cells: Point[] }
>();
const poseBits = new Float64Array(1),
  poseWords = new Uint32Array(poseBits.buffer);
function poseMix(h: number, value: number) {
  poseBits[0] = value;
  h = Math.imul(h ^ poseWords[0]!, 0x01000193);
  return Math.imul(h ^ poseWords[1]!, 0x01000193);
}
/** Furniture poses that decide which cells stay free, mixed into one number. */
function furnitureStamp(f: Floor) {
  let h = Math.imul(2166136261 ^ f.furniture.length, 0x01000193);
  for (const o of f.furniture) {
    h = poseMix(h, o.x);
    h = poseMix(h, o.y);
    h = poseMix(h, o.w);
    h = poseMix(h, o.h);
    h = poseMix(h, o.angle ?? 0);
    h = Math.imul(h ^ ((o.destroyed ? 1 : 0) | (o.open ? 2 : 0)), 0x01000193);
  }
  return h | 0;
}
/** Walkable interior cells, optionally restricted to one rect. Whole-floor
 * scans are shared per tick: omens, hazards and hunters all ask for the same
 * list, and the furniture checksum keeps it exact when geometry changes. */
function freeCells(
  g: Game,
  floor: number,
  rect?: { x1: number; y1: number; x2: number; y2: number },
) {
  const f = g.floors[floor];
  if (!f) return [];
  if (rect) return scanFreeCells(f, rect);
  const tick = g.tick ?? 0,
    saved = cellCache.get(f),
    poses = furnitureStamp(f);
  if (
    saved &&
    saved.tiles === f.tiles &&
    saved.poses === poses &&
    saved.tick === tick
  )
    return saved.cells;
  const cells = scanFreeCells(f, undefined);
  cellCache.set(f, { tiles: f.tiles, poses, tick, cells });
  return cells;
}
function scanFreeCells(
  f: Floor,
  rect?: { x1: number; y1: number; x2: number; y2: number },
) {
  const cells: Point[] = [];
  for (
    let y = Math.max(0, rect?.y1 ?? 1);
    y <= (rect?.y2 ?? f.tiles.length - 2);
    y++
  )
    for (
      let x = Math.max(0, rect?.x1 ?? 1);
      x <= (rect?.x2 ?? (f.tiles[y]?.length ?? 0) - 2);
      x++
    ) {
      if (f.tiles[y]?.[x] !== 0) continue;
      const p = { x: x + 0.5, y: y + 0.5 };
      if (solid(f, p, 0.3)) continue;
      cells.push(p);
    }
  return cells;
}

/** The origin, fixed once found: the catastrophe happens where it started. */
type Origin = Point & {
  floor: number;
  room?: string;
  rect?: { x1: number; y1: number; x2: number; y2: number };
};
const origins = new WeakMap<
  Game,
  { floor: Floor | undefined; specId: string; hint?: string; origin: Origin }
>();
/** The catastrophe's origin on floor 0, matched to a named room when possible. */
export function catastropheOrigin(g: Game): Origin {
  const spec = g.escape?.catastrophe,
    hint = spec?.origin.roomHint?.toLowerCase(),
    floor = g.floors[0],
    specId = spec?.id ?? "",
    saved = origins.get(g);
  if (
    saved &&
    saved.floor === floor &&
    saved.specId === specId &&
    saved.hint === hint
  )
    return saved.origin;
  const origin = computeOrigin(g, hint);
  origins.set(g, { floor, specId, hint, origin });
  return origin;
}

function computeOrigin(g: Game, hint: string | undefined): Origin {
  const f = g.floors[0];
  if (f && hint)
    for (const sector of floorSectors(f)) {
      const rooms = [
        { id: sector.id, kind: sector.id, rect: sector.blocks[0] },
        ...sector.rooms.map((r) => ({ id: r.id, kind: r.kind, rect: r.rect })),
      ];
      for (const room of rooms)
        if (
          room.rect &&
          (room.id.toLowerCase().includes(hint) ||
            room.kind.toLowerCase().includes(hint) ||
            (f.name ?? "").toLowerCase().includes(hint))
        ) {
          const cells = freeCells(g, 0, room.rect);
          if (cells.length)
            return { ...cells[0]!, floor: 0, room: room.id, rect: room.rect };
        }
    }
  const cells = freeCells(g, 0);
  return {
    ...(cells[Math.floor(cells.length / 2)] ?? { x: 1.5, y: 1.5 }),
    floor: 0,
  };
}

function doorBlocksCrossing(g: Game, floor: number, from: Point, to: Point) {
  const f = g.floors[floor],
    mx = (from.x + to.x) / 2,
    my = (from.y + to.y) / 2;
  return f.furniture.some(
    (o) =>
      !!o.door?.latched &&
      !o.destroyed &&
      Math.abs(o.door.frame.x - mx) < 0.6 &&
      Math.abs(o.door.frame.y - my) < 0.6,
  );
}

/** Rebuild a floor's hazard front from the origin by bounded breadth-first spread. */
function hazardGrid(
  g: Game,
  origin: Point & { floor: number },
  maxTiles: number,
  blocked: boolean,
  obscures: number,
  previous: Float32Array | undefined,
) {
  const f = g.floors[origin.floor],
    width = f?.tiles[0]?.length ?? 0,
    height = f?.tiles.length ?? 0,
    grid = new Float32Array(width * height),
    sight = new Float32Array(width * height).fill(1);
  if (!f || !width || !height) return { grid, sight };
  const seen = new Uint8Array(width * height),
    startX = Math.floor(origin.x),
    startY = Math.floor(origin.y);
  if (f.tiles[startY]?.[startX] !== 0) return { grid, sight };
  const queue: { x: number; y: number; d: number }[] = [
    { x: startX, y: startY, d: 0 },
  ];
  seen[startY * width + startX] = 1;
  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head]!;
    const from = { x: cell.x + 0.5, y: cell.y + 0.5 };
    if (cell.d <= maxTiles) {
      grid[cell.y * width + cell.x] = 1;
      sight[cell.y * width + cell.x] = 1 - 0.7 * obscures;
    }
    if (cell.d >= maxTiles) continue;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = cell.x + dx,
        ny = cell.y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (seen[ny * width + nx] || f.tiles[ny]?.[nx] !== 0) continue;
      const to = { x: nx + 0.5, y: ny + 0.5 };
      if (blocked && doorBlocksCrossing(g, origin.floor, from, to)) continue;
      seen[ny * width + nx] = 1;
      queue.push({ x: nx, y: ny, d: cell.d + 1 });
    }
  }
  // Keep an older, larger front when a phase lowers the radius.
  if (previous)
    for (let i = 0; i < grid.length; i++)
      if (!grid[i] && previous[i]) {
        grid[i] = previous[i]!;
        sight[i] = 1 - 0.7 * obscures;
      }
  return { grid, sight };
}

/** This game's own hazard grid for one floor, created when missing. */
function hazardCells(g: Game, floor: number) {
  const f = g.floors[floor],
    width = f?.tiles[0]?.length ?? 0,
    height = f?.tiles.length ?? 0;
  if (!f || !width || !height) return undefined;
  const rt = runtime(g, 0);
  let grid = rt.hazard.get(floor);
  if (!grid || grid.length !== width * height) {
    grid = new Float32Array(width * height);
    rt.hazard.set(floor, grid);
  }
  return { grid, width, height };
}

/** Mark a cell of this game's hazard grid (a front carried through a portal). */
export function seedHazard(
  g: Game,
  floor: number,
  x: number,
  y: number,
  intensity: number,
): void {
  const cells = hazardCells(g, floor);
  if (!cells) return;
  const cx = Math.floor(x),
    cy = Math.floor(y);
  if (cx < 0 || cy < 0 || cx >= cells.width || cy >= cells.height) return;
  const index = cy * cells.width + cx;
  cells.grid[index] = Math.max(cells.grid[index] ?? 0, intensity);
}

/** Hazard intensity at a cell of this game's own grid, 0 when there is none. */
export function hazardAt(g: Game, floor: number, x: number, y: number): number {
  const rt = runtimes.get(g),
    f = g.floors[floor],
    grid = rt?.hazard.get(floor);
  if (!rt || !f || !grid) return 0;
  const width = f.tiles[0]?.length ?? 0;
  if (!width) return 0;
  const cx = Math.floor(x),
    cy = Math.floor(y);
  if (cx < 0 || cy < 0 || cx >= width || cy >= f.tiles.length) return 0;
  return grid[cy * width + cx] ?? 0;
}

function tickHazards(
  g: Game,
  spec: CatastropheSpec,
  active: Behaviour[],
  intensity: number,
  dt: number,
  rt: Runtime,
) {
  const origin = catastropheOrigin(g);
  const damaged = new Set<Actor>();
  for (const behaviour of active) {
    if (behaviour.kind !== "hazard") continue;
    const index = spec.behaviours.indexOf(behaviour);
    if (!rt.hazardStart.has(index)) rt.hazardStart.set(index, g.time);
    const elapsed =
      Math.max(0, g.time - rt.hazardStart.get(index)!) * Math.max(0, intensity);
    const maxTiles = behaviour.spreadRate * elapsed;
    const built = hazardGrid(
      g,
      origin,
      maxTiles,
      behaviour.blockedByClosedDoors,
      behaviour.obscures,
      rt.hazard.get(origin.floor),
    );
    const width = g.floors[origin.floor]?.tiles[0]?.length ?? 1;
    rt.hazard.set(origin.floor, built.grid);
    rt.sight.set(origin.floor, built.sight);
    for (const a of g.survivors) {
      if (!a.alive || a.escaped || a.floor !== origin.floor || damaged.has(a))
        continue;
      const cell = Math.floor(a.y) * width + Math.floor(a.x);
      if ((built.grid[cell] ?? 0) <= 0.3) continue;
      damaged.add(a);
      damageSurvivor(g, a, behaviour.damagePerSecond * dt, behaviour.medium);
    }
  }
}

/** Sight multiplier for actors standing in an obscuring hazard front. */
export function hazardSightScale(
  g: Game,
  a: { floor: number; x: number; y: number },
) {
  if (!g.escape) return 1;
  const rt = runtimes.get(g),
    f = g.floors[a.floor],
    grid = rt?.sight.get(a.floor);
  if (!rt || !f || !grid) return 1;
  const width = f.tiles[0]?.length ?? 1,
    value = grid[Math.floor(a.y) * width + Math.floor(a.x)];
  return value === undefined ? 1 : value;
}

function spawnHunter(g: Game, index: number, behaviour: HunterBehaviour) {
  void behaviour;
  const origin = catastropheOrigin(g);
  let spot: Point | undefined;
  if (origin.rect) spot = freeCells(g, origin.floor, origin.rect)[0];
  if (!spot) {
    const humanActor = human(g),
      candidates = freeCells(g, origin.floor);
    for (let attempt = 0; attempt < 40 && candidates.length; attempt++) {
      const candidate = candidates[Math.floor(rand(g) * candidates.length)]!;
      if (
        !spot ||
        (humanActor.floor === origin.floor &&
          distance(candidate, humanActor) > distance(spot, humanActor))
      )
        spot = candidate;
    }
  }
  if (!spot) return;
  const zombie: Zombie = {
    id: `hunter-${index}-${g.spawned++}`,
    floor: origin.floor,
    x: spot.x,
    y: spot.y,
    hp: 60,
    path: [],
    repath: 0,
    cooldown: 0,
    memory: 0,
    stagger: 0,
    origin: "outside",
    hunter: index,
  };
  g.zombies.push(zombie);
  const spawn = event(
    g,
    "catastrophe-hunter",
    "Something moves in the dark.",
    origin.floor,
  );
  spawn.position = { ...spot };
}

function tickHunters(
  g: Game,
  spec: CatastropheSpec,
  active: Behaviour[],
  intensity: number,
  rt: Runtime,
) {
  for (const behaviour of active) {
    if (behaviour.kind !== "hunter") continue;
    const index = spec.behaviours.indexOf(behaviour);
    let state = rt.hunters.get(index);
    if (!state) {
      state = { start: g.time, next: g.time, spawned: 0 };
      rt.hunters.set(index, state);
    }
    const living = g.zombies.filter(
        (z) => z.hunter === index && z.hp > 0,
      ).length,
      target = Math.max(
        1,
        Math.round(behaviour.count * Math.max(0.2, intensity)),
      );
    if (behaviour.spawn === "waves") {
      if (g.time >= state.next) {
        for (let n = living; n < target; n++) spawnHunter(g, index, behaviour);
        state.next = g.time + 45;
      }
    } else if (behaviour.spawn === "breeding") {
      if (
        g.time >= state.next &&
        state.spawned < behaviour.count &&
        living < target
      ) {
        spawnHunter(g, index, behaviour);
        state.spawned++;
        state.next = g.time + 30;
      }
    } else {
      for (let n = living; n < target; n++) spawnHunter(g, index, behaviour);
    }
  }
}

function omenRoomKey(
  g: Game,
  hint: string | undefined,
  fallback: { room?: string },
) {
  const id = hint
    ? (roomIdAt(g.floors[0]!, {
        x: catastropheOrigin(g).x,
        y: catastropheOrigin(g).y,
      }) ?? undefined)
    : fallback.room;
  const resolved = hint ?? fallback.room ?? id;
  return resolved ? roomPowerKey(g, 0, resolved) : undefined;
}

function tickOmens(
  g: Game,
  spec: CatastropheSpec,
  from: number,
  to: number,
  rt: Runtime,
) {
  const origin = catastropheOrigin(g);
  for (const omen of omensDue(spec, from, to)) {
    appendLog(g, "omen", omen.text, {
      floor: origin.floor,
      room: omen.roomHint,
      phase: rt.phase,
    });
    const notice = event(g, "omen", omen.text, origin.floor);
    notice.position = { ...origin };
    switch (omen.effect) {
      case "flicker": {
        const key = omenRoomKey(g, omen.roomHint, origin);
        if (key && g.escape) {
          g.escape.roomPower[key] = "dim";
          rt.flickers.push({ key, until: g.time + 20 });
        }
        break;
      }
      case "alarm":
        event(g, "alarm", "An alarm begins to sound.");
        break;
      case "lockdown": {
        const f = g.floors[origin.floor],
          nearest = f?.furniture
            .filter((o) => o.door && !o.destroyed)
            .sort(
              (a, b) =>
                distance(a.door!.frame, origin) -
                distance(b.door!.frame, origin),
            )[0];
        if (nearest?.door) {
          if (!nearest.door.latched) latchDoor(g, nearest);
          lockDoor(nearest, doorSideOf(nearest, origin), "lockdown", g.time);
          event(
            g,
            "door-lock",
            "A lock engages from the outside.",
            nearest.floor,
            undefined,
            nearest.id,
          );
        }
        break;
      }
      case "noise": {
        const noise = event(g, "noise", omen.text, origin.floor);
        noise.position = { ...origin };
        break;
      }
    }
  }
  rt.flickers = rt.flickers.filter((flicker) => {
    if (flicker.until > g.time) return true;
    if (g.escape?.roomPower[flicker.key] === "dim")
      delete g.escape.roomPower[flicker.key];
    return false;
  });
}

function reflectionInView(g: Game, a: Actor): boolean {
  const f = g.floors[a.floor];
  if (!f) return false;
  return f.furniture.some((o) => {
    if (o.destroyed || distance(a, o) > 4) return false;
    const dx = o.x - a.x,
      dy = o.y - a.y,
      n = Math.hypot(dx, dy) || 1;
    if ((a.heading.x * dx + a.heading.y * dy) / n <= 0.5) return false;
    if (!canSee(f, a, o, 4, o.id)) return false;
    const object = o as unknown as {
      label?: string;
      object?: { label?: string; name?: string; parts?: { finish?: string }[] };
    };
    const label = `${o.kind} ${object.label ?? ""} ${object.object?.label ?? ""} ${object.object?.name ?? ""}`;
    return (
      /mirror|window|glass|screen|monitor|tv/i.test(label) ||
      !!object.object?.parts?.some((part) => part.finish === "glass")
    );
  });
}

function ruleTriggers(
  g: Game,
  a: Actor,
  behaviour: Extract<Behaviour, { kind: "perception-rule" }>,
): boolean {
  const f = g.floors[a.floor];
  if (!f) return false;
  switch (behaviour.trigger) {
    case "makes-sound":
      return (
        (a.noiseUntil ?? 0) > g.time &&
        (a.noiseLevel ?? 0) >= (behaviour.threshold ?? 0)
      );
    case "in-darkness":
      return roomPowerAt(g, a.floor, a.x, a.y) === "outage";
    case "sees-own-reflection":
      return reflectionInView(g, a);
    case "looks-at-entity":
      return g.zombies.some((z) => {
        if (z.hp <= 0 || z.floor !== a.floor || z.hunter === undefined)
          return false;
        const hunter = g.escape?.catastrophe.behaviours[z.hunter];
        const range = hunter?.kind === "hunter" ? hunter.sightRange : 9;
        if (distance(a, z) > range) return false;
        const dx = z.x - a.x,
          dy = z.y - a.y,
          n = Math.hypot(dx, dy) || 1;
        return (
          (a.heading.x * dx + a.heading.y * dy) / n > 0.5 &&
          canSee(f, a, z, range)
        );
      });
  }
  return false;
}

const WARNING_TEXT: Record<string, string> = {
  whisper: "Something whispers just behind the ear.",
  frost: "Breath fogs; the air turns biting cold.",
  flicker: "The lights stutter around you.",
  ringing: "A thin ringing builds in the ears.",
  none: "",
};

function tickPerception(
  g: Game,
  spec: CatastropheSpec,
  active: Behaviour[],
  dt: number,
  rt: Runtime,
) {
  for (const behaviour of active) {
    if (behaviour.kind !== "perception-rule") continue;
    const index = spec.behaviours.indexOf(behaviour);
    for (const a of g.survivors) {
      if (!a.alive || a.escaped) continue;
      if (!ruleTriggers(g, a, behaviour)) {
        rt.warned.delete(a);
        continue;
      }
      const warned = rt.warned.get(a);
      if (!warned || warned.rule !== index) {
        rt.warned.set(a, { rule: index, at: g.time });
        if (behaviour.warning !== "none")
          event(
            g,
            "catastrophe-warning",
            WARNING_TEXT[behaviour.warning] ?? "Something is wrong.",
            a.floor,
            a.id,
          );
        continue;
      }
      if (g.time - warned.at < WARNING_LEAD) continue;
      damageSurvivor(
        g,
        a,
        behaviour.effect === "instant-death"
          ? 1_000_000
          : (behaviour.damagePerSecond ?? 1) * dt,
        behaviour.trigger,
      );
    }
  }
}

function randomRoom(g: Game): { floor: number; id: string } | undefined {
  const floors = g.floors
    .map((_, floor) => floor)
    .filter((floor) => roomIdsForFloor(g.floors[floor]!).length);
  if (!floors.length) return undefined;
  const floor = floors[Math.floor(rand(g) * floors.length)]!,
    ids = roomIdsForFloor(g.floors[floor]!);
  return { floor, id: ids[Math.floor(rand(g) * ids.length)]! };
}

function randomPoint(g: Game): Point & { floor: number } {
  const cells = freeCells(g, 0);
  return {
    ...(cells[Math.floor(rand(g) * cells.length)] ?? { x: 1.5, y: 1.5 }),
    floor: 0,
  };
}

function tickCollapse(
  g: Game,
  spec: CatastropheSpec,
  active: Behaviour[],
  rt: Runtime,
) {
  for (const behaviour of active) {
    if (behaviour.kind !== "collapse") continue;
    const index = spec.behaviours.indexOf(behaviour);
    if (!rt.collapseNext.has(index))
      rt.collapseNext.set(index, g.time + behaviour.cadence);
    while (g.time >= (rt.collapseNext.get(index) ?? Infinity)) {
      rt.collapseNext.set(
        index,
        (rt.collapseNext.get(index) ?? g.time) + behaviour.cadence,
      );
      const target =
        behaviour.targets[
          Math.floor(rand(g) * Math.max(1, behaviour.targets.length))
        ] ?? "power";
      if (target === "power") {
        const room = randomRoom(g);
        if (room && g.escape)
          g.escape.roomPower[roomPowerKey(g, room.floor, room.id)] = "outage";
      } else if (target === "doors") {
        const doors = g.floors
          .flatMap((f) => f.furniture)
          .filter((o) => o.door && !o.destroyed);
        const door = doors[Math.floor(rand(g) * doors.length)];
        if (door) {
          if (rand(g) < 0.5) unlockDoor(door);
          else lockDoor(door, rand(g) < 0.5 ? 1 : -1, "collapse", g.time);
        }
      } else if (target === "structure") {
        const point = randomPoint(g);
        const collapse = event(
          g,
          "collapse",
          "Something gives way above.",
          point.floor,
        );
        collapse.position = { ...point };
        for (const a of g.survivors)
          if (
            a.alive &&
            !a.escaped &&
            a.floor === point.floor &&
            distance(a, point) <= 2
          )
            damageSurvivor(g, a, 30, "falling debris");
        for (const z of g.zombies)
          if (z.hp > 0 && z.floor === point.floor && distance(z, point) <= 2) {
            z.hp = Math.max(0, z.hp - 30);
            if (z.hp <= 0 && z.hunter !== undefined) z.downAt ??= g.time;
          }
      } else {
        const room = randomRoom(g);
        if (room) {
          rt.gas.push({ ...room, until: g.time + 60 });
          event(g, "gas", "A vent hisses somewhere nearby.", room.floor);
        }
      }
    }
  }
}

function tickGas(g: Game, dt: number, rt: Runtime) {
  rt.gas = rt.gas.filter((room) => room.until > g.time);
  for (const room of rt.gas)
    for (const a of g.survivors) {
      if (!a.alive || a.escaped || a.floor !== room.floor) continue;
      if (roomIdAt(g.floors[room.floor]!, a) === room.id)
        damageSurvivor(g, a, dt, "gas");
    }
}

/** The escape catastrophe: phases, omens, hunters, hazards, perception rules and collapse. */
export function catastropheTick(g: Game, dt: number): void {
  const escape = g.escape;
  if (!escape) return;
  // An escape game has no horde: the city seeds its zombies when the world is
  // built, before the escape state exists, so they are removed here. Only
  // catastrophe hunters (alive or as bodies) remain.
  if (g.zombies.some((z) => z.hunter === undefined))
    g.zombies = g.zombies.filter((z) => z.hunter !== undefined);
  const spec = escape.catastrophe,
    state = catastropheState(spec, g.time),
    rt = runtime(g, dt),
    from = Math.min(rt.last, g.time),
    area = g.areaId ?? escape.areas.start,
    // The catastrophe happens where it started; other areas only feel it.
    inOrigin = area === (spec.origin.areaId ?? escape.areas.start);
  rt.last = g.time;
  registerRoomPowerOverrides(g);
  if (state.phase !== rt.phase) {
    rt.phase = state.phase;
    // Sealed: the phase change goes to the epilogue log only. It is never a
    // world event, which the HUD shows and NPCs perceive; people notice the
    // catastrophe only through what it actually does.
    appendLog(g, "phase", `The catastrophe entered its ${state.phase} phase.`, {
      phase: state.phase,
    });
  }
  if (inOrigin) tickOmens(g, spec, from, g.time, rt);
  for (const z of g.zombies)
    if (z.hunter !== undefined && z.hp <= 0 && z.downAt === undefined)
      z.downAt = g.time;
  if (inOrigin) {
    tickHazards(g, spec, state.behaviours, state.intensity, dt, rt);
    tickHunters(g, spec, state.behaviours, state.intensity, rt);
  }
  // Perception rules are properties of the catastrophe, not of its area.
  tickPerception(g, spec, state.behaviours, dt, rt);
  if (inOrigin) {
    tickCollapse(g, spec, state.behaviours, rt);
    tickGas(g, dt, rt);
  }
}
