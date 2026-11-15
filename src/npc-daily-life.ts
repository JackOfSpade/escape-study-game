import type { Actor, Game, Point } from "./model";
import { distance } from "./model";
import type { SocialMotor } from "./npc-social-runtime";
import type { DailyLife } from "./escape-types";

/** Minimum and maximum time an NPC stands still between errands. */
const STAY_MIN = 40;
const STAY_MAX = 120;
/** How long an NPC keeps trying to reach a destination before giving up. */
const WALK_LIMIT = 60;
/** Close enough to count as arrived, and as back home. */
const ARRIVE = 0.6;
/** A visit point stands this far short of the furniture it targets. */
const VISIT_GAP = 0.9;
/** Prefer errands that actually take the NPC somewhere. */
const WORTH_WALKING = 2.5;

// The nearest existing activities: other systems (chatter, door traffic,
// reply chance) read this field and only know the legacy vocabulary.
type Activity = NonNullable<Actor["activity"]>;
const IDLE: Activity = "waiting";
const WALKING: Activity = "exploring";

/** Small deterministic hash; the routine never uses Math.random. */
function hash(seed: number, id: string, salt: number): number {
  let h = 2166136261 ^ Math.imul(Math.trunc(seed) || 0, 0x9e3779b1);
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= Math.imul(salt | 0, 0x85ebca6b);
  h = Math.imul(h, 16777619);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return h >>> 0;
}

function unit(seed: number, id: string, salt: number): number {
  return hash(seed, id, salt) / 4294967296;
}

function staySeconds(g: Game, a: Actor, salt: number): number {
  return STAY_MIN + unit(g.seed, a.id, salt) * (STAY_MAX - STAY_MIN);
}

/** The stand-off point 0.9 m from `o`, on the side facing the NPC's home. */
function visitPoint(
  g: Game,
  a: Actor,
  life: DailyLife,
  visit: number,
): Point | undefined {
  const floor = g.floors[a.floor];
  if (!floor) return undefined;
  const points = floor.furniture
    .filter((o) => !o.destroyed)
    .map((o) => {
      const dx = life.home.x - o.x,
        dy = life.home.y - o.y,
        n = Math.hypot(dx, dy);
      return n > 1e-3
        ? { x: o.x + (dx / n) * VISIT_GAP, y: o.y + (dy / n) * VISIT_GAP }
        : { x: o.x + VISIT_GAP, y: o.y };
    });
  if (!points.length) return undefined;
  const worth = points.filter((p) => distance(p, life.home) >= WORTH_WALKING);
  const pool = worth.length ? worth : points;
  return pool[hash(g.seed, a.id, visit) % pool.length];
}

/**
 * Escape redesign: an NPC's ordinary day.
 *
 * The NPC alternates between standing still and walking to one of two places:
 * its home point (where it was first seen) and a visit point beside a piece of
 * furniture on the same floor. It uses only the social motor, so it can never
 * open a field, claim a station, take loot or touch the helicopter. The
 * routine is stored on `EscapeState.daily` so it survives a save, and every
 * choice comes from a hash of the seed and the actor id.
 */
export function dailyLifeStep(
  g: Game,
  a: Actor,
  dt: number,
  motor: SocialMotor,
): void {
  void dt;
  const escape = g.escape;
  if (!escape) return;
  if (!a.alive || a.escaped) return;
  if (!g.floors?.[a.floor]) return;

  const daily = (escape.daily ??= {});
  let life = daily[a.id];
  if (!life) {
    life = {
      home: { x: a.x, y: a.y, floor: a.floor },
      state: "staying",
      until: g.time + staySeconds(g, a, 0),
      visits: 0,
    };
    daily[a.id] = life;
  }

  if (life.state === "staying") {
    a.activity = IDLE;
    motor.stop();
    if (g.time < life.until) return;
    // First walk of the day goes visiting; then home and away alternate.
    const spot =
      life.visits % 2 === 0
        ? visitPoint(g, a, life, life.visits)
        : { x: life.home.x, y: life.home.y };
    life.visits += 1;
    if (!spot) {
      life.until = g.time + staySeconds(g, a, life.visits);
      return;
    }
    life.state = "walking";
    life.target = { x: spot.x, y: spot.y, floor: a.floor };
    life.until = g.time + WALK_LIMIT;
    a.activity = WALKING;
    motor.walkTo({ ...life.target });
    return;
  }

  const target = life.target;
  if (!target) {
    life.state = "staying";
    life.until = g.time + staySeconds(g, a, life.visits);
    a.activity = IDLE;
    motor.stop();
    return;
  }
  a.activity = WALKING;
  motor.walkTo({ ...target });
  const arrived = a.floor === target.floor && distance(a, target) < ARRIVE;
  if (!arrived && g.time < life.until) return;
  // Arriving ends the errand; a walk that ran out of time gives up in place.
  motor.stop();
  life.state = "staying";
  delete life.target;
  life.until = g.time + staySeconds(g, a, life.visits);
  a.activity = IDLE;
}
