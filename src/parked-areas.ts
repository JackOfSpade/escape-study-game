/**
 * Parked regions keep running (supersedes docs/ESCAPE_REDESIGN.md section 12
 * "Area swap", where an area the player left was frozen).
 *
 * Only far places (regions) are parked games: a near place is stamped into the
 * same world, so it is never parked. A parked region is its own `Game` in
 * `escape.areaStore`, without `study` and `escape` (those travel with the
 * player). Here it is stepped on a fixed 10 Hz cadence, with the active game's
 * `study`/`escape` attached only for the duration of each step, and catastrophe
 * hunters cross between regions at the matching world edges. Hazards stay in
 * the region they were seeded in.
 */
import { human, step, type Input } from "./engine";
import type { AreaPortal, EscapeEvent, EscapeState } from "./escape-types";
import { H, W, type Game, type Zombie } from "./model";

const STEP = 0.1;
const MAX_STEPS = 3;
/** How close to the world edge a hunter counts as having travelled. */
const EDGE_REACH = 1.2;
const MAX_LOG = 600;

/** Time owed to each parked game, keyed by the parked game object itself. */
const owed = new WeakMap<object, number>();
/** Parked games whose own human actor has already been marked as gone. */
const departed = new WeakSet<object>();
/** Regions whose step error was logged already. */
const warned = new Set<string>();

const EMPTY_INPUT = { x: 0, y: 0 } as Input;

type ParkedGame = Omit<Game, "study" | "escape"> & {
  study?: Game["study"];
  escape?: EscapeState;
};

function parkedGames(active: Game): Game[] {
  const store = active.escape?.areaStore;
  if (!store) return [];
  const games: Game[] = [];
  for (const id of Object.keys(store)) {
    const entry = store[id];
    if (entry) games.push(entry.game as unknown as Game);
  }
  return games;
}

function areaOf(g: Game, escape: EscapeState): string {
  return g.areaId ?? escape.areas?.start ?? "start";
}

function warnOnce(areaId: string, error: unknown): void {
  if (warned.has(areaId)) return;
  warned.add(areaId);
  console.warn(`Parked region ${areaId} stopped simulating:`, error);
}

/**
 * Advance every parked region's game at up to 10 Hz. Never throws: a broken
 * region is logged once and skipped, and the rest of the world keeps running.
 */
export function tickParkedAreas(active: Game, dt: number): void {
  const escape = active.escape;
  const store = escape?.areaStore;
  if (!escape || !store) return;
  for (const areaId of Object.keys(store)) {
    const entry = store[areaId];
    if (!entry) continue;
    const parked = entry.game as unknown as ParkedGame;
    try {
      const pending = (owed.get(parked) ?? 0) + Math.max(0, dt);
      const steps = Math.min(MAX_STEPS, Math.floor((pending + 1e-9) / STEP));
      owed.set(parked, Math.max(0, pending - steps * STEP));
      // The park is the player's departure: this region's own human actor is
      // no longer present for NPCs, stations or threats.
      const actor = human(parked as unknown as Game);
      if (actor && !departed.has(parked)) {
        actor.escaped = true;
        departed.add(parked);
      }
      if (steps <= 0) continue;
      parked.study = active.study;
      parked.escape = escape;
      try {
        for (let i = 0; i < steps; i++) {
          try {
            step(parked as unknown as Game, STEP, EMPTY_INPUT);
          } catch (error) {
            warnOnce(areaId, error);
            break;
          }
        }
      } finally {
        delete parked.study;
        delete parked.escape;
      }
      // The world clock is shared: a parked game never runs ahead of the player.
      if (parked.time < active.time) parked.time = active.time;
    } catch (error) {
      warnOnce(areaId, error);
    }
  }
}

type Spot = { floor: number; x: number; y: number };

/** The edge crossing that leads back, when the regions registered one. */
function returnCrossing(
  escape: EscapeState,
  crossing: AreaPortal,
): AreaPortal | undefined {
  return (escape.areas?.portals ?? []).find(
    (candidate) =>
      candidate.from === crossing.to && candidate.to === crossing.from,
  );
}

/** Clamp a point into a floor of the destination game. */
function clampInto(dest: Game, floor: number, x: number, y: number): Spot {
  const index = Math.max(
    0,
    Math.min(dest.floors.length - 1, Math.floor(floor) || 0),
  );
  const f = dest.floors[index];
  const width = f?.tiles[0]?.length ?? W,
    height = f?.tiles.length || H;
  return {
    floor: index,
    x: Math.max(0.5, Math.min(width - 1.5, x)),
    y: Math.max(0.5, Math.min(height - 1.5, y)),
  };
}

/** One tile inside the destination's main gate, when it has one. */
function gateSpot(dest: Game): Spot | undefined {
  const f = dest.floors[0];
  const gate = f?.furniture?.find((item) => item.id === "main-gate");
  if (!f || !gate) return undefined;
  const inside = f.entry ?? { x: W / 2, y: H / 2 };
  const dx = Math.sign(inside.x - gate.x),
    dy = Math.sign(inside.y - gate.y);
  const spot =
    Math.abs(dx) >= Math.abs(dy)
      ? { x: gate.x + (dx || 1), y: gate.y }
      : { x: gate.x, y: gate.y + (dy || 1) };
  return clampInto(dest, 0, spot.x, spot.y);
}

/** Where a hunter arrives in the destination region: the matching edge. */
function arrivalSpot(
  dest: Game,
  escape: EscapeState,
  crossing: AreaPortal,
  from: Spot,
): Spot {
  const back = returnCrossing(escape, crossing);
  if (back) return clampInto(dest, back.at.floor, back.at.x, back.at.y);
  return (
    gateSpot(dest) ??
    clampInto(dest, crossing.at.floor, crossing.at.x, crossing.at.y) ??
    from
  );
}

/** The game that holds a region: the active one, else its parked game. */
function gameFor(
  active: Game,
  escape: EscapeState,
  areaId: string,
): Game | undefined {
  if (escape.areas?.current === areaId) return active;
  const parked = escape.areaStore?.[areaId];
  return parked ? (parked.game as unknown as Game) : undefined;
}

function livingHuntersNear(game: Game, at: Spot): Zombie[] {
  return game.zombies.filter(
    (z) =>
      z.hunter !== undefined &&
      z.hp > 0 &&
      z.floor === at.floor &&
      Math.hypot(z.x - at.x, z.y - at.y) <= EDGE_REACH,
  );
}

function logCrossing(
  escape: EscapeState,
  at: number,
  crossing: AreaPortal,
): void {
  const entry: EscapeEvent = {
    at,
    kind: "departure",
    areaId: crossing.to,
    text: `A hunter crossed the ${crossing.label} edge.`,
  };
  escape.log.push(entry);
  if (escape.log.length > MAX_LOG)
    escape.log.splice(0, escape.log.length - MAX_LOG);
}

/** Only far places are regions: a near place shares this world's floors. */
function regionCrossings(escape: EscapeState): AreaPortal[] {
  return (escape.areas?.portals ?? []).filter(
    (crossing) => escape.areas?.areas[crossing.to]?.kind !== "site",
  );
}

/**
 * Hunters near a region edge follow the player into the next region, arriving
 * at the matching edge. Nothing else crosses: hazards stay where they were.
 */
export function crossRegionEdges(active: Game): void {
  const escape = active.escape;
  if (!escape) return;
  const crossings = regionCrossings(escape);
  if (!crossings.length) return;
  for (const game of [active, ...parkedGames(active)]) {
    const area = areaOf(game, escape);
    for (const crossing of crossings) {
      if (crossing.from !== area) continue;
      const dest = gameFor(active, escape, crossing.to);
      if (!dest || dest === game) continue;
      const here: Spot = {
        floor: crossing.at.floor,
        x: crossing.at.x,
        y: crossing.at.y,
      };
      const hunters = livingHuntersNear(game, here);
      if (!hunters.length) continue;
      const spot = arrivalSpot(dest, escape, crossing, here);
      for (const hunter of hunters) {
        game.zombies = game.zombies.filter((z) => z !== hunter);
        hunter.floor = spot.floor;
        hunter.x = spot.x;
        hunter.y = spot.y;
        hunter.path = [];
        hunter.repath = 0;
        dest.zombies.push(hunter);
      }
      logCrossing(escape, active.time, crossing);
    }
  }
}
