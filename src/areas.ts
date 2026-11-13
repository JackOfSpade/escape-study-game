/**
 * Connected places (docs/ESCAPE_REDESIGN.md section 16).
 *
 * A near place is a site: it is generated apart and stamped into the same
 * shared floors, so walking into it is walking, not a transition. A far place
 * is a region: its own parked `Game`, reached by travelling to the world edge.
 * `study`, `settings` and `escape` always move with the player.
 */
import { bridgeRequest } from "./bridge-client";
import type {
  AreaPortal,
  AreaStub,
  EscapeEvent,
  EscapeState,
} from "./escape-types";
import type { Actor, Game } from "./model";
import { floorCols, floorRows } from "./site";
import { nextSiteOrigin, stampSite } from "./site-stamp";
import { npcVoiceKey } from "./voice-key";
import type { SavedRunDesign } from "./run-design-contract.mjs";

/** Builds an area's own `Game` from its seed. Registered by `src/main.ts`. */
export type AreaFactory = (seed: number) => Game;

/** One AI request, resolved with the answer or rejected. */
type AreaRequest = (operation: string, payload: unknown) => unknown;

const defaultRequest: AreaRequest = (operation, payload) =>
  bridgeRequest(operation, payload);

let areaFactory: AreaFactory | undefined;
let areaRequest: AreaRequest = defaultRequest;

/** Register the generator that builds an area game (main.ts supplies it). */
export function setAreaFactory(fn: AreaFactory): void {
  areaFactory = fn;
}

/** Designs one area's own venue-specific building. Registered by `src/main.ts`. */
export type AreaDesigner = (
  stub: AreaStub,
  signal: AbortSignal,
) => Promise<SavedRunDesign>;

/** Builds a fresh area game from an accepted design. Registered by `src/main.ts`. */
export type DesignedAreaFactory = (seed: number, saved: SavedRunDesign) => Game;

let areaDesigner: AreaDesigner | undefined;
let designedAreaFactory: DesignedAreaFactory | undefined;

/**
 * Register the background designer (`src/area-design.ts`) that builds a real
 * place for each area. Without one, areas keep the seed-only generator.
 */
export function setAreaDesigner(fn?: AreaDesigner): void {
  areaDesigner = fn;
}

/**
 * Register the generator that rebuilds a designed area from its saved design.
 * Without one, areas keep the seed-only generator even when a design exists.
 */
export function setDesignedAreaFactory(fn: DesignedAreaFactory): void {
  designedAreaFactory = fn;
}

/** Designs still running, keyed by area id. */
const designing = new Map<string, AbortController>();
/** Areas whose design failed, so a broken place is never designed twice. */
const designFailures = new Map<string, string>();

const reason = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Swap the AI request function. Exported for tests; the game keeps the default. */
export function setAreaRequest(fn?: AreaRequest): void {
  areaRequest = fn ?? defaultRequest;
}

/** Prepared destination games, keyed by the game the player is leaving. */
const switches = new WeakMap<Game, Game>();

/** Returns the game prepared by `enterRegion` and clears it, or undefined. */
export function takeAreaSwitch(g: Game): Game | undefined {
  const next = switches.get(g);
  if (next) switches.delete(g);
  return next;
}

/**
 * Add a newly discovered place. Sites carry no portal record: they are stamped
 * into the shared floors. A region records the edge crossing that reaches it.
 */
export function registerArea(
  g: Game,
  stub: AreaStub,
  portal?: AreaPortal,
): void {
  const escape = g.escape;
  if (!escape) return;
  if (!escape.areas.areas[stub.id]) escape.areas.areas[stub.id] = stub;
  if (!portal) return;
  if (!escape.areas.portals.some((candidate) => candidate.id === portal.id))
    escape.areas.portals.push(portal);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.trim()
    ? value.trim().slice(0, max)
    : undefined;

/** The offline plan: the procedural building never needs the AI expansion. */
function offlinePlan(stub: AreaStub): NonNullable<AreaStub["plan"]> {
  return { name: stub.name, premise: stub.brief, rooms: [], people: [] };
}

/** Read an escape-area answer into a plan, dropping unusable entries. */
function readPlan(
  stub: AreaStub,
  answer: unknown,
): NonNullable<AreaStub["plan"]> {
  if (!isRecord(answer)) return offlinePlan(stub);
  const rawRooms = Array.isArray(answer.rooms) ? answer.rooms : [];
  const rawPeople = Array.isArray(answer.people) ? answer.people : [];
  const rooms = rawRooms.flatMap((room) => {
    if (!isRecord(room)) return [];
    const name = text(room.name, 80);
    const purpose = text(room.purpose, 280);
    return name && purpose ? [{ name, purpose }] : [];
  });
  const people = rawPeople.flatMap((person) => {
    if (!isRecord(person)) return [];
    const name = text(person.name, 60);
    const role = text(person.role, 60);
    if (!name || !role) return [];
    return [{ name, role, activity: text(person.activity, 160) ?? "" }];
  });
  return {
    name: text(answer.name, 60) ?? stub.name,
    premise: text(answer.premise, 600) ?? stub.brief,
    rooms,
    people,
  };
}

/**
 * Start the AI design of one area in the background.
 *
 * Returns true when a design is running, so the caller keeps the area
 * `generating` rather than `ready`. A stub that already carries a saved design
 * (from this session, or loaded after a reload) is never designed again.
 */
function startDesign(g: Game, stub: AreaStub): boolean {
  const designer = areaDesigner;
  if (!designer) return false;
  if (stub.design) return false;
  if (designing.has(stub.id)) return true;
  if (designFailures.has(stub.id)) return false;
  const controller = new AbortController();
  designing.set(stub.id, controller);
  stub.state = "generating";
  const settle = (saved: SavedRunDesign | undefined, failure?: string) => {
    designing.delete(stub.id);
    if (saved) stub.design = saved;
    else designFailures.set(stub.id, failure ?? "Area design failed");
    if (g.escape?.areas.areas[stub.id] === stub) stub.state = "ready";
  };
  let pending: Promise<SavedRunDesign>;
  try {
    pending = Promise.resolve(designer(stub, controller.signal));
  } catch (error) {
    settle(undefined, reason(error));
    return false;
  }
  void pending.then(
    (saved) => settle(saved),
    (error: unknown) => settle(undefined, reason(error)),
  );
  return true;
}

/** Start generating an area in the background (no-op when ready or in progress). */
export function prefetchArea(g: Game, areaId: string): void {
  try {
    const escape = g.escape;
    const stub = escape?.areas.areas[areaId];
    if (!escape || !stub) return;
    if (stub.plan) {
      if (stub.state === "generating" && designing.has(stub.id)) return;
      if (!startDesign(g, stub)) stub.state = "ready";
      return;
    }
    if (stub.state === "generating" || stub.state === "queued") return;
    stub.state = "generating";
    const settle = (answer: unknown, failed: boolean) => {
      if (g.escape?.areas.areas[areaId] !== stub) return;
      try {
        stub.plan = failed ? offlinePlan(stub) : readPlan(stub, answer);
      } catch {
        stub.plan = offlinePlan(stub);
      }
      if (!startDesign(g, stub)) stub.state = "ready";
    };
    const payload = {
      requestId: `area-${areaId}`,
      areaId,
      brief: stub.brief,
      name: stub.name,
      setting: escape.persona,
    };
    let pending: unknown;
    try {
      pending = areaRequest("escape-area", payload);
    } catch {
      settle(undefined, true);
      return;
    }
    if (
      typeof pending === "object" &&
      pending !== null &&
      typeof (pending as { then?: unknown }).then === "function"
    ) {
      const promise = pending as Promise<unknown>;
      void promise.then(
        (answer) => settle(answer, false),
        () => settle(undefined, true),
      );
    } else settle(pending, false);
  } catch {
    // Prefetching is background work: it never breaks the frame.
  }
}

/**
 * Build a destination area's game.
 *
 * A saved design always wins: the designed factory rebuilds a fresh game from
 * it, so a Restart or a second visit never reuses a played area. Without a
 * design (or without that factory) the seed-only generator runs.
 *
 * NPCs are renamed from the plan in order (`name`, `role`) but keep their ids:
 * voice keys (`escape.voices.npcs`), `owner`/`intent`/`station` references and
 * the social state all key off actor ids, so keeping ids means nothing else has
 * to be rewritten when the area is regenerated.
 */
export function buildArea(g: Game, areaId: string): Game {
  const stub = g.escape?.areas.areas[areaId];
  if (!stub) throw Error(`Unknown area: ${areaId}`);
  if (stub.design && designedAreaFactory) {
    const designed = designedAreaFactory(stub.seed, stub.design);
    designed.id = `${g.id}-${areaId}`;
    return designed;
  }
  if (!areaFactory) throw Error("No area factory is registered");
  const built = areaFactory(stub.seed);
  built.id = `${g.id}-${areaId}`;
  const people = stub.plan?.people ?? [];
  const npcs = built.survivors.filter((actor) => actor.id !== "human");
  npcs.forEach((actor, index) => {
    const person = people[index];
    if (!person) return;
    actor.name = person.name;
    if (person.role) actor.role = person.role;
  });
  return built;
}

type Point = { floor: number; x: number; y: number };

type Gate = { id?: string; x: number; y: number };

type FloorLike = {
  furniture?: Gate[];
  entry?: { x: number; y: number };
  tiles?: number[][];
};

/** The first non-wall tile within two tiles of a point, when the floor has tiles. */
function walkableNear(
  floor: FloorLike,
  point: { x: number; y: number },
): { x: number; y: number } | undefined {
  const tiles = floor.tiles;
  if (!tiles) return point;
  for (let radius = 0; radius <= 2; radius++)
    for (let dy = -radius; dy <= radius; dy++)
      for (let dx = -radius; dx <= radius; dx++) {
        const x = Math.round(point.x) + dx,
          y = Math.round(point.y) + dy;
        const tile = tiles[y]?.[x];
        if (tile !== undefined && tile !== 0) return { x, y };
      }
  return point;
}

/** Where a freshly arrived human stands in the destination area. */
function entranceOf(dest: Game): Point | undefined {
  const floor = dest.floors[0] as FloorLike | undefined;
  if (!floor) return undefined;
  const gate = (floor.furniture ?? []).find((item) => item.id === "main-gate");
  if (gate) {
    const entry = floor.entry;
    if (entry) {
      const dx = Math.sign(entry.x - gate.x),
        dy = Math.sign(entry.y - gate.y);
      if (dx && Math.abs(entry.x - gate.x) >= Math.abs(entry.y - gate.y))
        return { floor: 0, x: gate.x + dx, y: gate.y };
      if (dy) return { floor: 0, x: gate.x, y: gate.y + dy };
      return { floor: 0, x: gate.x + (dx || 1), y: gate.y };
    }
    return { floor: 0, x: gate.x, y: gate.y };
  }
  if (floor.entry) return { floor: 0, ...walkableNear(floor, floor.entry)! };
  return undefined;
}

/** Move the human's state onto the destination's own human actor. */
function moveHuman(
  source: Game,
  dest: Game,
  arrival?: Point,
): Actor | undefined {
  const from = source.survivors.find((actor) => actor.id === "human");
  const to = dest.survivors.find((actor) => actor.id === "human");
  if (!from || !to) return undefined;
  to.name = from.name;
  to.hp = from.hp;
  to.inventory = from.inventory;
  to.keys = from.keys;
  const at = arrival ?? entranceOf(dest);
  if (at) {
    to.floor = at.floor;
    to.x = at.x;
    to.y = at.y;
    to.target = undefined;
    to.navTarget = undefined;
  }
  return to;
}

/** A follower walks into the destination area right behind the human. */
function moveFollower(
  source: Game,
  dest: Game,
  human: Actor | undefined,
  escape: EscapeState,
  fromArea: string,
  toArea: string,
): void {
  const follower = source.survivors.find(
    (actor) =>
      actor.id !== "human" && actor.socialState?.goal?.kind === "follow",
  );
  if (!follower) return;
  source.survivors = source.survivors.filter((actor) => actor !== follower);
  const moved = { ...follower };
  // Generated areas reuse generator ids; a companion keeps a unique one.
  while (dest.survivors.some((actor) => actor.id === moved.id))
    moved.id = `${moved.id}-companion`;
  if (human) {
    moved.floor = human.floor;
    moved.x = human.x + 1;
    moved.y = human.y;
  }
  dest.survivors.push(moved);
  // Voices are keyed by area (and the id may have changed above), so the
  // companion's voice moves with them: the same person sounds the same.
  const voices = escape.voices?.npcs;
  if (voices) {
    const before = npcVoiceKey(escape, fromArea, follower.id);
    const after = npcVoiceKey(escape, toArea, moved.id);
    if (voices[before] && before !== after) voices[after] = voices[before];
  }
}

/** Shallow copy of the source game without the state the player carries. */
function parkSource(source: Game, escape: EscapeState, areaId: string): void {
  const parked = { ...source } as unknown as Record<string, unknown>;
  delete parked.study;
  delete parked.escape;
  escape.areaStore[areaId] = {
    game: parked as unknown as Omit<Game, "study" | "escape">,
    parkedAt: source.time,
  };
}

/* ------------------------------------------------------------------ */
/* Sites: near places stamped into the shared world                     */
/* ------------------------------------------------------------------ */

/** The plot a site is assumed to need: 44 x 34 tiles. */
export const SITE_WIDTH = 44;
export const SITE_HEIGHT = 34;

/** Every site stub: a place the player can walk to. */
function siteStubs(g: Game): AreaStub[] {
  return Object.values(g.escape?.areas.areas ?? {}).filter(
    (stub) => stub.kind === "site",
  );
}

/** Every far place: a region with its own parked game. */
function regionStubs(g: Game): AreaStub[] {
  return Object.values(g.escape?.areas.areas ?? {}).filter(
    (stub) => stub.kind !== "site",
  );
}

/**
 * Stamp one site into the shared floors. A stub without a design waits while
 * its designer still runs; without a designer the seed-only factory is enough.
 */
function stampStub(g: Game, stub: AreaStub): boolean {
  if (g.sites?.some((site) => site.id === stub.id)) return true;
  if (areaDesigner && !stub.design && !designFailures.has(stub.id))
    return false;
  let source: Game;
  try {
    source = buildArea(g, stub.id);
  } catch {
    return false;
  }
  const origin = stub.origin ?? nextSiteOrigin(g);
  stampSite(g, source, { id: stub.id, name: stub.name, origin });
  stub.origin = { x: origin.x, y: origin.y };
  stub.stamped = true;
  stub.state = "ready";
  return true;
}

/**
 * Stamp every ready site into the shared world and return their ids. A stamp
 * is synchronous, so the caller may run it mid-frame.
 */
export function stampReadySites(g: Game): string[] {
  const stamped: string[] = [];
  for (const stub of siteStubs(g)) {
    if (stub.stamped) continue;
    if (stampStub(g, stub)) stamped.push(stub.id);
  }
  return stamped;
}

/**
 * Re-stamp the sites the loop had already reached after a Restart rebuilds the
 * world. The designs live on the stubs, so every place comes back unchanged.
 */
export function restampSites(g: Game): string[] {
  const stamped: string[] = [];
  for (const stub of siteStubs(g)) {
    if (!stub.stamped) continue;
    if (g.sites?.some((site) => site.id === stub.id)) continue;
    if (stampStub(g, stub)) stamped.push(stub.id);
  }
  return stamped;
}

/** True when a point lies on or beside a site's plot. */
function onPlot(
  origin: { x: number; y: number },
  at: { x: number; y: number },
  reach: number,
): boolean {
  return (
    at.x >= origin.x - reach &&
    at.x <= origin.x + SITE_WIDTH + reach &&
    at.y >= origin.y - reach &&
    at.y <= origin.y + SITE_HEIGHT + reach
  );
}

const humanOf = (g: Game): Actor | undefined =>
  g.survivors.find((actor) => actor.id === "human" && actor.alive !== false);

/**
 * The site the human reached whose building is still being prepared: the game
 * shows a loading screen and calls `prefetchArea` for it.
 */
export function siteLoadingDue(g: Game): AreaStub | undefined {
  const human = humanOf(g);
  if (!human || human.floor !== 0) return undefined;
  for (const stub of siteStubs(g)) {
    if (stub.stamped || !stub.origin) continue;
    if (onPlot(stub.origin, human, 3)) return stub;
  }
  return undefined;
}

/** The exit site the human walked into, ending the loop as escaped. */
export function exitSiteReached(g: Game): AreaStub | undefined {
  const human = humanOf(g);
  if (!human || human.floor !== 0) return undefined;
  return siteStubs(g).find(
    (stub) =>
      stub.exit === true && !!stub.origin && onPlot(stub.origin, human, 0),
  );
}

/* ------------------------------------------------------------------ */
/* Regions: far places with their own world, reached at the edge       */
/* ------------------------------------------------------------------ */

type Side = "east" | "west" | "north" | "south";

interface Bounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The open-terrain bounds of the ground floor. */
function boundsOf(g: Game): Bounds {
  const floor = g.floors[0];
  const city = floor?.city?.bounds;
  if (city)
    return {
      left: city.left,
      right: city.right,
      top: city.top,
      bottom: city.bottom,
    };
  return {
    left: 0,
    right: floor ? floorCols(floor) : 0,
    top: 0,
    bottom: floor ? floorRows(floor) : 0,
  };
}

/** The world edge point a region is reached from (east unless told otherwise). */
export function regionEdgePoint(g: Game, side: Side = "east"): Point {
  const b = boundsOf(g);
  const y = Math.round((b.top + b.bottom) / 2);
  const x = Math.round((b.left + b.right) / 2);
  if (side === "west") return { floor: 0, x: b.left, y };
  if (side === "south") return { floor: 0, x, y: b.bottom };
  if (side === "north") return { floor: 0, x, y: b.top };
  return { floor: 0, x: b.right, y };
}

/** The bounds side an edge point lies on. */
function sideOf(b: Bounds, at: { x: number; y: number }): Side {
  const options: Array<[Side, number]> = [
    ["east", Math.abs(at.x - b.right)],
    ["west", Math.abs(at.x - b.left)],
    ["south", Math.abs(at.y - b.bottom)],
    ["north", Math.abs(at.y - b.top)],
  ];
  return options.sort((a, z) => a[1] - z[1])[0][0];
}

const oppositeSide = (side: Side): Side =>
  side === "east"
    ? "west"
    : side === "west"
      ? "east"
      : side === "south"
        ? "north"
        : "south";

/** How close to the bounds edge counts as walking off it. */
const EDGE_REACH = 2;

/**
 * The region the human is walking to: they have reached the edge of the open
 * terrain on the side that region lies beyond.
 */
export function regionEdgeCrossed(g: Game): AreaStub | undefined {
  const escape = g.escape;
  if (!escape) return undefined;
  const human = humanOf(g);
  if (!human || human.floor !== 0) return undefined;
  const bounds = boundsOf(g);
  for (const stub of regionStubs(g)) {
    // A region is never its own destination: its crossing belongs to the
    // region the player came from.
    if (stub.id === escape.areas.current) continue;
    const crossing = escape.areas.portals.find((p) => p.to === stub.id);
    // Without a recorded crossing there is nothing to walk to: the start area
    // is a region too, and a bare stub must never act as a destination.
    if (!crossing) continue;
    const side = sideOf(bounds, crossing.at);
    const reached =
      side === "east"
        ? human.x >= bounds.right - EDGE_REACH
        : side === "west"
          ? human.x <= bounds.left + EDGE_REACH
          : side === "south"
            ? human.y >= bounds.bottom - EDGE_REACH
            : human.y <= bounds.top + EDGE_REACH;
    if (reached) return stub;
  }
  return undefined;
}

/** Where a traveller steps into a region: the edge facing the way they came. */
function arrivalPoint(dest: Game, side: Side): Point {
  const at = regionEdgePoint(dest, side);
  // Further in than EDGE_REACH, so arriving never counts as crossing straight
  // back to the region the player just left.
  const inset = EDGE_REACH + 2;
  if (side === "west") return { ...at, x: at.x + inset };
  if (side === "east") return { ...at, x: at.x - inset };
  if (side === "north") return { ...at, y: at.y + inset };
  return { ...at, y: at.y - inset };
}

/** The edge crossing back to where the player just came from. */
function ensureReturnCrossing(
  escape: EscapeState,
  dest: Game,
  from: string,
  label: string,
  at: Point,
): void {
  if (
    escape.areas.portals.some(
      (p) => p.to === from && p.at.x === at.x && p.at.y === at.y,
    )
  )
    return;
  escape.areas.portals.push({
    id: `${dest.id}-${from}-back`,
    from: dest.id,
    to: from,
    transition: "walk",
    at,
    label,
  });
}

/**
 * Travel to a region. Returns "preparing" while its world is generated (the
 * caller shows a loading overlay and retries) and "entered" once the switch is
 * ready; the caller swaps games with `takeAreaSwitch`.
 */
export function enterRegion(g: Game, id: string): "entered" | "preparing" {
  const escape = g.escape;
  if (!escape) return "preparing";
  const stub = escape.areas.areas[id];
  if (!stub) return "preparing";
  if (stub.state !== "ready" || !stub.plan) {
    prefetchArea(g, id);
    if (stub.state !== "ready" || !stub.plan) return "preparing";
  }
  // A design still running is background work: the frame keeps its status.
  if (designing.has(stub.id) && !escape.areaStore[stub.id]) return "preparing";
  const event = (text: string, areaId: string): EscapeEvent => ({
    at: g.time,
    kind: "departure",
    areaId,
    text,
  });
  if (stub.exit === true) {
    g.status = "escaped";
    g.endedAt = g.time;
    escape.log.push(event(`Reached ${stub.name}`, escape.areas.current));
    return "entered";
  }
  const from = escape.areas.current;
  const crossing = escape.areas.portals.find((p) => p.to === id);
  const at = crossing?.at ?? regionEdgePoint(g);
  const arrivalSide = oppositeSide(sideOf(boundsOf(g), at));
  const parked = escape.areaStore[stub.id];
  let dest: Game;
  if (parked) {
    dest = {
      ...parked.game,
      study: g.study,
      settings: g.settings,
      escape,
    } as Game;
  } else {
    dest = buildArea(g, stub.id);
    dest.study = g.study;
    dest.settings = g.settings;
    dest.escape = escape;
  }
  dest.time = g.time;
  dest.areaId = stub.id;
  const human = moveHuman(g, dest, arrivalPoint(dest, arrivalSide));
  // A parked area marks its human escaped while the player is away.
  if (human) human.escaped = false;
  moveFollower(g, dest, human, escape, from, stub.id);
  parkSource(g, escape, from);
  const backAt: Point = human
    ? { floor: human.floor, x: human.x, y: human.y }
    : arrivalPoint(dest, arrivalSide);
  ensureReturnCrossing(
    escape,
    dest,
    from,
    escape.areas.areas[from]?.name ?? from,
    backAt,
  );
  escape.areas.current = stub.id;
  escape.log.push(event(`Travelled to ${stub.name}`, stub.id));
  switches.set(g, dest);
  return "entered";
}
