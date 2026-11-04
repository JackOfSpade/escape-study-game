import { redesign } from "../force-fields";
import { doorFrame, doorPose, ensureDoor, unlatchDoor } from "../doors";
import {
  CONFIG,
  FURNITURE,
  H,
  W,
  type Furniture,
  type Game,
  type Roadmap,
  type Zombie,
} from "../model";
import { actor, createGame, createPlayableGame } from "../world";
import { runDesignFingerprint } from "../run-design-contract.mjs";
import type { Scenario, Spawn } from "./schema";
export function entity(g: Game, id: string) {
  return (
    g.survivors.find((e) => e.id === id) ??
    g.zombies.find((e) => e.id === id) ??
    g.floors.flatMap((f) => f.furniture).find((e) => e.id === id)
  );
}
export function remove(g: Game, id: string) {
  if (id === "human") throw Error("The test player cannot be removed.");
  g.survivors = g.survivors.filter((e) => e.id !== id);
  g.zombies = g.zombies.filter((e) => e.id !== id);
  for (const f of g.floors)
    f.furniture = f.furniture.filter((e) => e.id !== id);
}
export function spawn(g: Game, s: Spawn, replace = false) {
  const previous = entity(g, s.id);
  if (previous && !replace) throw Error(`Entity ID already exists: ${s.id}`);
  if (s.id !== "human") remove(g, s.id);
  const floor = s.floor ?? 0;
  if (s.kind === "player" || s.kind === "npc") {
    if (s.kind === "npc" && g.survivors.length + g.zombies.length >= 128)
      throw Error("Character limit reached.");
    const a = actor(
      s.id,
      s.kind === "player" ? "Test player" : s.id,
      Math.max(1, g.survivors.length),
    );
    if (previous && "role" in previous)
      for (const key of [
        "role",
        "risk",
        "social",
        "skill",
        "technical",
      ] as const)
        Object.assign(a, { [key]: previous[key] });
    Object.assign(a, {
      x: s.x,
      y: s.y,
      floor,
      hp: s.hp ?? 100,
      alive: (s.hp ?? 100) > 0,
      heading: s.heading ?? { x: 1, y: 0 },
      access: s.credential ? [floor] : [],
      keys: s.keys ?? (g.rules ? 0 : undefined),
      ...(g.rules ? { inventory: [], speed: CONFIG.playerSpeed } : {}),
    });
    if (s.kind === "player") g.survivors[0] = a;
    else g.survivors.push(a);
    return;
  }
  if (s.kind === "zombie") {
    if (g.survivors.length + g.zombies.length >= 128)
      throw Error("Character limit reached.");
    const z: Zombie = {
      id: s.id,
      x: s.x,
      y: s.y,
      floor,
      hp: s.hp ?? 60,
      path: [],
      repath: 0,
      cooldown: 0,
      memory: 0,
      stagger: 0,
      origin: "outside",
    };
    g.zombies.push(z);
    return;
  }
  if (g.floors.reduce((n, f) => n + f.furniture.length, 0) >= 512)
    throw Error("Furniture limit reached.");
  const spec = FURNITURE[s.kind];
  const o: Furniture = {
    id: s.id,
    kind: s.kind,
    floor,
    x: s.x,
    y: s.y,
    w: s.w ?? spec.w,
    h: s.h ?? spec.h,
    hp: s.hp ?? spec.hp,
    maxHp:
      s.maxHp ??
      (previous && "maxHp" in previous
        ? Math.max(previous.maxHp, s.hp ?? spec.hp)
        : Math.max(spec.hp, s.hp ?? spec.hp)),
    speed: spec.speed,
    rotation: 0,
    destroyed: (s.hp ?? spec.hp) <= 0,
    movers: [],
    moved: 0,
    credited: [],
    turning: 0,
    angle: ((s.angle ?? 0) * Math.PI) / 180,
  };
  if (s.forceField)
    o.field = {
      authorized: [],
      crossing: [],
      sides: {},
      used: 0,
      exit: s.forceField === "exit",
      ...(s.forceField === "red"
        ? { limit: 0 }
        : s.freeLimit
          ? { limit: s.freeLimit, direction: s.freeDirection ?? 1 }
          : {}),
      ...(s.leafOpen ? { leaf: { open: 1, side: 1, hold: 0 } } : {}),
    };
  if (o.kind === "door" && !o.field) {
    o.angle = 0;
    ensureDoor(o, g.floors[floor]);
    if (s.released || s.angle) unlatchDoor(o);
    o.angle = ((s.angle ?? 0) * Math.PI) / 180;
    if (o.door && o.angle) {
      o.door.side = Math.sign(o.angle) as -1 | 0 | 1;
      o.door.swung = true;
    }
    Object.assign(o, doorPose(o, o.angle));
  }
  o.initial = { x: o.x, y: o.y, w: o.w, h: o.h };
  g.floors[floor].furniture.push(o);
}
export function createTestWorld(s: Scenario, roadmap: Roadmap) {
  const saved = s.design
    ? {
        version: 1 as const,
        source: "fixture" as const,
        requestId: `gametest-${s.id}-design`,
        generationId: `gametest-${s.id}-generation`,
        fingerprint: runDesignFingerprint(s.design),
        design: s.design,
      }
    : undefined;
  const g =
    s.design?.version === 3
      ? createPlayableGame(s.seed, roadmap, undefined, saved)
      : createGame(s.seed, roadmap, undefined, {
          layout:
            s.layout === "randomized" ? "forward" : (s.layout ?? "legacy"),
          ...(saved ? { design: saved } : {}),
        });
  if (s.design?.version === 3 && !s.naturalSpawns) {
    g.zombies = [];
    g.spawned = 0;
  }
  g.id = `gametest-${s.id}`;
  g.status = "playing";
  g.time = s.startTime;
  g.paused = false;
  if (!s.naturalSpawns) g.nextSpawn = Number.MAX_SAFE_INTEGER;
  g.surge.anchor = Number.MAX_SAFE_INTEGER;
  if (s.template === "arena") {
    g.survivors = g.survivors.slice(0, 1);
    g.zombies = [];
    g.encounters = {};
    Object.assign(g.survivors[0], { x: 3.5, y: 3.5 });
    for (const f of g.floors) {
      f.tiles = Array.from({ length: H }, (_, y) =>
        Array.from({ length: W }, (_, x) =>
          x === 0 || y === 0 || x === W - 1 || y === H - 1 ? 1 : 0,
        ),
      );
      f.furniture = [];
      f.stations = [];
      f.doors = [];
      f.rooms = [];
      f.entry = { x: 3.5, y: 3.5 };
      f.stairs = { x: 38.5, y: 12.5 };
      f.dark = 0;
    }
  }
  if (s.template === "arena" && s.naturalSpawns)
    for (let x = 18; x <= 25; x++) g.floors[0].tiles[H - 1][x] = 0;
  if (s.rules === "force-fields" && s.design?.version !== 3)
    redesign(g, roadmap, { randomized: s.layout === "randomized" });
  // Scenario identity replaces the factory run ID. Keep private study sessions
  // bound to that same synthetic run, just as they are in a playable game.
  for (const encounter of Object.values(g.encounters)) encounter.runId = g.id;
  for (const map of s.maps)
    g.floors[map.floor].tiles = map.rows.map((row) =>
      [...row].map((c) => (c === "#" ? 1 : 0)),
    );
  for (const id of s.deleted) remove(g, id);
  for (const e of s.entities) spawn(g, e, true);
  g.events = [];
  g.seq = 0;
  return g;
}
/** Capture layout only, never study state, drafts, chats or runtime credentials. */
export function captureLayout(g: Game, s: Scenario): Scenario {
  // An arena capture stores actual geometry and must not re-run an authored
  // building plan. City captures retain their matching synthetic design.
  const { design, ...captured } = structuredClone(s);
  const entities: Spawn[] = [
    ...g.survivors
      .filter((a) => a.alive && !a.escaped)
      .map((a) => ({
        id: a.id,
        kind: a.id === "human" ? ("player" as const) : ("npc" as const),
        x: a.x,
        y: a.y,
        floor: a.floor,
        hp: a.hp,
        heading: a.heading,
        credential: a.access.includes(a.floor),
        ...(a.keys !== undefined ? { keys: a.keys } : {}),
      })),
    ...g.zombies
      .filter((z) => z.hp > 0)
      .map((z) => ({
        id: z.id,
        kind: "zombie" as const,
        x: z.x,
        y: z.y,
        floor: z.floor,
        hp: z.hp,
      })),
    ...g.floors.flatMap((f) =>
      f.furniture
        .filter((o) => !o.destroyed)
        .map((o) => {
          const frame = o.door ? doorFrame(o) : o;
          return {
            id: o.id,
            kind: o.kind,
            x: frame.x,
            y: frame.y,
            floor: o.floor,
            hp: o.hp,
            maxHp: o.maxHp,
            w: frame.w,
            h: frame.h,
            angle: layoutAngle(o),
            released: o.door ? !o.door.latched : undefined,
            ...(o.field
              ? {
                  forceField: o.field.exit
                    ? ("exit" as const)
                    : o.field.limit === 0
                      ? ("red" as const)
                      : ("green" as const),
                  ...(o.field.limit
                    ? {
                        freeLimit: o.field.limit,
                        freeDirection:
                          o.field.direction === -1
                            ? (-1 as const)
                            : (1 as const),
                      }
                    : {}),
                }
              : {}),
          };
        }),
    ),
  ];
  if (!entities.some((e) => e.id === "human"))
    entities.unshift({ id: "human", kind: "player", x: 3.5, y: 3.5 });
  return {
    ...captured,
    ...(g.floors[0].city && design ? { design } : {}),
    template: g.floors[0].city ? "building" : "arena",
    layout: g.floors[0].city
      ? "randomized"
      : s.layout === "randomized"
        ? "legacy"
        : s.layout,
    city: !!g.floors[0].city,
    startTime: g.time,
    entities,
    deleted: [],
    maps: g.floors.map((f) => ({
      floor: f.index,
      rows: f.tiles.map((row) => row.map((c) => (c ? "#" : ".")).join("")),
    })),
    actions: [],
    checks: [],
  };
}

export function layoutAngle(o: Furniture) {
  const degrees = (((o.angle ?? 0) * 180) / Math.PI + 180) % 360;
  const wrapped = ((degrees + 360) % 360) - 180;
  return o.door ? Math.max(-70, Math.min(70, wrapped)) : wrapped;
}
