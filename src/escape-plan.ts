/**
 * Plans and the sealed truth sheet (docs/ESCAPE_REDESIGN.md section 17).
 *
 * The player states a plan in plain words. A builder that knows nothing of
 * the catastrophe or the truth sheet turns it into physical steps. The world
 * then answers each step when the player actually tries it, from a truth
 * sheet written before any plan existed: a step may be fine, may turn out to
 * need one more thing (a gap), or may be closed in this game (a wall). When
 * the last step is done the sheet rules on the way out itself.
 *
 * This module is pure game state: no DOM, no bridge, no engine import. The
 * caller applies the effect each tick returns.
 */
import { commitFact, learn } from "./fact-ledger";
import {
  PLAN_MEANS,
  PLAN_RESOURCES,
  type EscapePlan,
  type EscapeState,
  type MeansRule,
  type PlanMeans,
  type PlanResource,
  type PlanStep,
  type PlanStepKind,
  type TruthEntry,
  type TruthSheet,
} from "./escape-types";
import type { Actor, Game } from "./model";
import { isRecord } from "./records";

/** Close enough to a step's spot to be doing it. */
const PLAN_REACH = 1.8;
/** Close enough to a person to be asking them. */
const PLAN_ASK_REACH = 2.4;
/** Moving faster than this (m/s) is walking, not working. */
const STILL_SPEED = 0.35;
export const PLAN_LIMITS = Object.freeze({
  text: 240,
  steps: 6,
  stepText: 120,
  label: 40,
  seconds: 60,
  reply: 240,
  reveal: 240,
  anchors: 48,
});

const STEP_KINDS: readonly PlanStepKind[] = ["reach", "fetch", "work", "ask"];

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function hash(seed: number, text: string): number {
  let h = 2166136261 ^ Math.imul(Math.trunc(seed) || 0, 0x9e3779b1);
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  return (h ^ (h >>> 15)) >>> 0;
}

const clean = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return text && text.length <= max ? text : undefined;
};

const isMeans = (value: unknown): value is PlanMeans =>
  typeof value === "string" &&
  (PLAN_MEANS as readonly string[]).includes(value);

const isResource = (value: unknown): value is PlanResource =>
  typeof value === "string" &&
  (PLAN_RESOURCES as readonly string[]).includes(value);

/* ------------------------------------------------------------------ */
/* The truth sheet                                                     */
/* ------------------------------------------------------------------ */

function truthEntry(value: unknown): TruthEntry | undefined {
  if (!isRecord(value)) return undefined;
  const reveal = clean(value.reveal, PLAN_LIMITS.reveal);
  if (!reveal) return undefined;
  if (value.kind === "wall") {
    const harm =
      typeof value.harm === "number" && Number.isFinite(value.harm)
        ? Math.max(0, Math.min(100, Math.round(value.harm)))
        : 0;
    return harm ? { kind: "wall", reveal, harm } : { kind: "wall", reveal };
  }
  if (value.kind !== "gap" || !isRecord(value.fix)) return undefined;
  const text = clean(value.fix.text, PLAN_LIMITS.stepText),
    label = clean(value.fix.label, PLAN_LIMITS.label),
    seconds = value.fix.seconds;
  if (
    !text ||
    !label ||
    typeof seconds !== "number" ||
    !Number.isFinite(seconds)
  )
    return undefined;
  return {
    kind: "gap",
    reveal,
    fix: {
      text,
      label,
      seconds: Math.max(1, Math.min(PLAN_LIMITS.seconds, Math.round(seconds))),
    },
  };
}

function meansRule(value: unknown): MeansRule | undefined {
  if (!isRecord(value)) return undefined;
  const reveal = clean(value.reveal, PLAN_LIMITS.reveal);
  if (
    !reveal ||
    (value.outcome !== "escapes" &&
      value.outcome !== "wall" &&
      value.outcome !== "dies")
  )
    return undefined;
  return { outcome: value.outcome, reveal };
}

/**
 * A usable truth sheet, or undefined. Every means must have a rule, the
 * viable means must escape, and nothing the viable route could need may be a
 * wall, so every game has at least one way out.
 */
export function parseTruthSheet(value: unknown): TruthSheet | undefined {
  if (!isRecord(value) || value.version !== 1 || !isMeans(value.viable))
    return undefined;
  if (!isRecord(value.means) || !isRecord(value.resources)) return undefined;
  const means: TruthSheet["means"] = {};
  for (const name of PLAN_MEANS) {
    const rule = meansRule(value.means[name]);
    if (!rule) return undefined;
    means[name] = rule;
  }
  if (means[value.viable]?.outcome !== "escapes") return undefined;
  const resources: TruthSheet["resources"] = {};
  for (const [name, raw] of Object.entries(value.resources)) {
    if (!isResource(name) || name === "none") return undefined;
    const entry = truthEntry(raw);
    if (!entry) return undefined;
    resources[name] = entry;
  }
  for (const name of VIABLE_NEEDS[value.viable])
    if (resources[name]?.kind === "wall") return undefined;
  return { version: 1, resources, means, viable: value.viable };
}

/** What each means cannot do without; a viable route never has one walled. */
const VIABLE_NEEDS: Record<PlanMeans, readonly PlanResource[]> = {
  "walk-out": ["exit"],
  drive: ["vehicle", "fuel", "key"],
  fly: ["aircraft", "fuel"],
  sail: ["boat"],
  climb: ["roof", "rope"],
  tunnel: ["tunnel", "tool"],
  hide: ["supplies"],
  "call-help": ["phone", "radio", "power"],
  wait: [],
  other: [],
};

const WALLS: Record<PlanMeans, string> = {
  "walk-out":
    "People you have never seen are standing at every way off the grounds. One of them walks you back without a word.",
  drive:
    "The road is closed a little way out. A line of vehicles sits across it with their lights off.",
  fly: "Nothing here is going to leave the ground today.",
  sail: "The water is no way out. Whatever is wrong is out there too.",
  climb: "From up here there is nowhere to go but back down.",
  tunnel: "The way down ends in a wall that was poured long ago.",
  hide: "Hiding only means it finds you later.",
  "call-help":
    "Someone answers, listens, and says help is already there. Nobody comes.",
  wait: "Waiting changes nothing. It comes all the same.",
  other: "It comes to nothing. That way is shut.",
};

const ESCAPES: Record<PlanMeans, string> = {
  "walk-out": "Nobody stops you. You keep walking until it is all behind you.",
  drive: "The road is open. You drive until the place is a light behind you.",
  fly: "The ground falls away and takes all of it with it.",
  sail: "The shore slides back and nothing follows you over the water.",
  climb: "From the top there is a way across, and you take it.",
  tunnel: "The dark goes on, and then there is air, and you are out.",
  hide: "It passes over. When you come out, it is finished.",
  "call-help": "They believe you. Someone comes, and takes you out of it.",
  wait: "You hold still, and it is over before it reaches you.",
  other: "It works. You are out.",
};

/** Means a deterministic sheet may choose as the way out. */
const FALLBACK_VIABLE: readonly PlanMeans[] = [
  "drive",
  "climb",
  "tunnel",
  "call-help",
  "hide",
];

/**
 * The deterministic truth sheet of a game that has no authored one: the same
 * seed always gives the same sheet. One means escapes; walking out the front
 * never does; a couple of things have something missing.
 */
export function fallbackTruth(seed: number): TruthSheet {
  const viable = FALLBACK_VIABLE[hash(seed, "viable") % FALLBACK_VIABLE.length];
  const means: TruthSheet["means"] = {};
  for (const name of PLAN_MEANS)
    means[name] =
      name === viable
        ? { outcome: "escapes", reveal: ESCAPES[name] }
        : name !== "walk-out" && hash(seed, `dies:${name}`) % 4 === 0
          ? {
              outcome: "dies",
              reveal:
                "It was waiting for exactly this. There is no time to understand what went wrong.",
            }
          : { outcome: "wall", reveal: WALLS[name] };
  const resources: TruthSheet["resources"] = {
    vehicle: {
      kind: "gap",
      reveal: "It turns over once and dies. The battery has been taken out.",
      fix: {
        text: "Find a battery that will do",
        label: "spare battery",
        seconds: 8,
      },
    },
    key: {
      kind: "gap",
      reveal: "Locked, and the key is not where it should be.",
      fix: {
        text: "Find where the key went",
        label: "key cabinet",
        seconds: 6,
      },
    },
    rope: {
      kind: "gap",
      reveal: "There is nothing here long enough to trust your weight to.",
      fix: {
        text: "Find something to climb with",
        label: "coil of cable",
        seconds: 8,
      },
    },
  };
  if (viable !== "call-help")
    resources.phone = {
      kind: "wall",
      reveal: "Every line gives the same flat tone.",
    };
  if (viable !== "walk-out")
    resources.exit = {
      kind: "wall",
      reveal: WALLS["walk-out"],
    };
  return { version: 1, resources, means, viable };
}

/** The game's truth sheet, created from the seed the first time it is needed. */
function ensureTruth(g: Game): TruthSheet | undefined {
  const escape = g.escape;
  if (!escape) return undefined;
  escape.truth ??= fallbackTruth(g.seed);
  return escape.truth;
}

/* ------------------------------------------------------------------ */
/* Anchors: the places a plan may happen at                            */
/* ------------------------------------------------------------------ */

interface PlanAnchor {
  id: string;
  name: string;
  floor: number;
  x: number;
  y: number;
}

/**
 * Real, reachable spots the builder may send the player to: the entrance and
 * the ground outside it, each level's stairs, and every labelled object.
 */
export function planAnchors(g: Game): PlanAnchor[] {
  const anchors: PlanAnchor[] = [];
  const ground = g.floors[0];
  const gate = ground?.furniture.find((o) => o.id === "main-gate");
  if (gate) {
    anchors.push({
      id: "entrance",
      name: "the main entrance",
      floor: 0,
      x: gate.x,
      y: gate.y,
    });
    anchors.push({
      id: "outside-front",
      name: "the ground just outside the entrance",
      floor: 0,
      x: gate.x,
      y: gate.y + 6,
    });
  }
  const top = g.floors.length - 1;
  for (const floor of g.floors) {
    const name = floor.name?.trim() || `level ${floor.index + 1}`;
    if (floor.stairs)
      anchors.push({
        id: `stairs-${floor.index}`,
        name:
          floor.index === top
            ? `the top of the place (${name})`
            : `the stairs on ${name}`,
        floor: floor.index,
        x: floor.stairs.x,
        y: floor.stairs.y,
      });
  }
  const seen = new Set<string>();
  for (const floor of g.floors)
    for (const o of floor.furniture) {
      const label = (o as { label?: string }).label?.trim();
      if (!label || o.destroyed || o.kind === "door") continue;
      const key = label.toLowerCase();
      if (seen.has(key) || anchors.length >= PLAN_LIMITS.anchors) continue;
      seen.add(key);
      anchors.push({
        id: `obj-${o.id}`,
        name: `${label} (${floor.name?.trim() || `level ${floor.index + 1}`})`,
        floor: floor.index,
        x: o.x,
        y: o.y,
      });
    }
  return anchors;
}

/* ------------------------------------------------------------------ */
/* Building a plan                                                     */
/* ------------------------------------------------------------------ */

interface PlanAnswer {
  verdict: "possible" | "impossible";
  reply: string;
  means: PlanMeans;
  steps: {
    kind: PlanStepKind;
    text: string;
    label: string;
    anchorId: string;
    resource: PlanResource;
    seconds: number;
    npcId?: string;
  }[];
}

/** The builder's request. It never carries the catastrophe or the truth sheet. */
export function planRequest(g: Game, text: string, requestId: string) {
  const escape = g.escape!;
  return {
    requestId,
    plan: text,
    setting: escape.persona,
    place: {
      title: g.design?.design.title ?? "",
      premise: g.design?.design.premise ?? "",
    },
    anchors: planAnchors(g).map(({ id, name }) => ({ id, name })),
    people: g.survivors
      .filter((a) => a.id !== "human" && a.alive)
      .slice(0, 24)
      .map((a) => ({ id: a.id, name: a.name, role: a.role })),
    known: escape.ledger.journal.slice(-12).map((entry) => entry.line),
  };
}

/** A structurally sound answer for this game, or undefined. */
export function parsePlanAnswer(
  g: Game,
  value: unknown,
): PlanAnswer | undefined {
  if (!isRecord(value)) return undefined;
  const reply = clean(value.reply, PLAN_LIMITS.reply);
  if (!reply) return undefined;
  if (value.verdict === "impossible")
    return { verdict: "impossible", reply, means: "other", steps: [] };
  if (value.verdict !== "possible" || !isMeans(value.means)) return undefined;
  if (
    !Array.isArray(value.steps) ||
    value.steps.length < 1 ||
    value.steps.length > PLAN_LIMITS.steps
  )
    return undefined;
  const anchors = new Set(planAnchors(g).map((a) => a.id));
  const people = new Set(g.survivors.map((a) => a.id));
  const steps: PlanAnswer["steps"] = [];
  for (const raw of value.steps) {
    if (!isRecord(raw)) return undefined;
    const kind = raw.kind as PlanStepKind,
      text = clean(raw.text, PLAN_LIMITS.stepText),
      label = clean(raw.label, PLAN_LIMITS.label);
    if (!STEP_KINDS.includes(kind) || !text || !label) return undefined;
    if (typeof raw.anchorId !== "string" || !anchors.has(raw.anchorId))
      return undefined;
    if (!isResource(raw.resource)) return undefined;
    const seconds =
      kind === "reach"
        ? 0
        : typeof raw.seconds === "number" && Number.isFinite(raw.seconds)
          ? Math.max(2, Math.min(PLAN_LIMITS.seconds, Math.round(raw.seconds)))
          : 8;
    const step: PlanAnswer["steps"][number] = {
      kind,
      text,
      label,
      anchorId: raw.anchorId,
      resource: raw.resource,
      seconds,
    };
    if (kind === "ask") {
      if (
        typeof raw.npcId !== "string" ||
        raw.npcId === "human" ||
        !people.has(raw.npcId)
      )
        return undefined;
      step.npcId = raw.npcId;
    }
    steps.push(step);
  }
  return { verdict: "possible", reply, means: value.means, steps };
}

const KEYWORDS: readonly [RegExp, PlanMeans, PlanResource, string, string][] = [
  [
    /\b(car|van|truck|drive|hot-?wire|bus|bike|motor)/i,
    "drive",
    "vehicle",
    "a vehicle left near the entrance",
    "Get it running",
  ],
  [
    /\b(helicopter|plane|fly|aircraft|drone|balloon)/i,
    "fly",
    "aircraft",
    "something that flies",
    "Get it into the air",
  ],
  [
    /\b(boat|sail|swim|raft|ferry|ship)/i,
    "sail",
    "boat",
    "a boat",
    "Get it onto the water",
  ],
  [
    /\b(roof|climb|ladder|rope|window)/i,
    "climb",
    "roof",
    "the way up",
    "Find a way across from the top",
  ],
  [
    /\b(tunnel|sewer|basement|dig|vent|duct|cellar)/i,
    "tunnel",
    "tunnel",
    "a way down",
    "Force a way through",
  ],
  [
    /\b(hide|barricade|lock (myself|ourselves)|shelter|bunker)/i,
    "hide",
    "supplies",
    "a place to hold out",
    "Shut yourself in",
  ],
  [
    /\b(call|phone|radio|police|signal|message|sos)/i,
    "call-help",
    "phone",
    "a telephone",
    "Get through to someone",
  ],
  [/\b(wait|stay|do nothing)/i, "wait", "none", "where you are", "Hold still"],
  [
    /\b(walk|leave|door|gate|run|exit|out)/i,
    "walk-out",
    "exit",
    "the way out",
    "Walk out",
  ],
];

/**
 * A plan built without the model, from keywords: used when the bridge is
 * unreachable and in tests. It only ever uses the fixed anchors.
 */
export function offlinePlan(g: Game, text: string): PlanAnswer {
  const anchors = planAnchors(g),
    id = (wanted: string) =>
      anchors.find((a) => a.id === wanted)?.id ?? anchors[0]?.id ?? "";
  const top = `stairs-${g.floors.length - 1}`;
  const match = KEYWORDS.find(([pattern]) => pattern.test(text));
  const [, means, resource, label, action] = match ?? [
    undefined,
    "other" as PlanMeans,
    "none" as PlanResource,
    "the way out",
    "Try it",
  ];
  const where =
    means === "climb"
      ? id(top)
      : means === "walk-out"
        ? id("entrance")
        : means === "hide" || means === "wait" || means === "call-help"
          ? (anchors.find((a) => a.id.startsWith("obj-"))?.id ?? id("entrance"))
          : id("outside-front");
  if (!where)
    return {
      verdict: "impossible",
      reply: "There is nowhere here to even begin that.",
      means: "other",
      steps: [],
    };
  return {
    verdict: "possible",
    reply: `Right. ${action}: start with ${label}.`,
    means,
    steps: [
      {
        kind: "reach",
        text: `Get to ${label}`,
        label,
        anchorId: where,
        resource: "none",
        seconds: 0,
      },
      {
        kind: "work",
        text: action,
        label,
        anchorId: where,
        resource,
        seconds: means === "wait" ? 30 : 12,
      },
    ],
  };
}

/**
 * Make an answer the game's current plan. An earlier active plan is dropped;
 * a thing the plan names keeps the place it was first given, in every loop.
 */
export function adoptPlan(
  g: Game,
  text: string,
  answer: PlanAnswer,
): EscapePlan | undefined {
  const escape = g.escape;
  if (!escape || answer.verdict !== "possible") return undefined;
  const anchors = new Map(planAnchors(g).map((a) => [a.id, a]));
  const places = (escape.places ??= {});
  const plans = (escape.plans ??= []);
  for (const plan of plans) if (plan.state === "active") plan.state = "dropped";
  const id = `plan-${escape.loop}-${plans.length + 1}`;
  const steps: PlanStep[] = [];
  for (const [index, raw] of answer.steps.entries()) {
    const anchor = anchors.get(raw.anchorId);
    if (!anchor) return undefined;
    const key = raw.label.toLowerCase();
    const at = (places[key] ??= {
      x: anchor.x,
      y: anchor.y,
      floor: anchor.floor,
    });
    const step: PlanStep = {
      id: `${id}-s${index + 1}`,
      kind: raw.kind,
      text: raw.text,
      label: raw.label,
      at: { ...at },
      resource: raw.resource,
      seconds: raw.seconds,
      state: "pending",
      progress: 0,
    };
    if (raw.npcId) step.npcId = raw.npcId;
    steps.push(step);
  }
  const plan: EscapePlan = {
    id,
    loop: escape.loop,
    text: text.slice(0, PLAN_LIMITS.text),
    means: answer.means,
    steps,
    state: "active",
  };
  plans.push(plan);
  return plan;
}

/* ------------------------------------------------------------------ */
/* Playing a plan                                                      */
/* ------------------------------------------------------------------ */

export const activePlan = (escape?: EscapeState): EscapePlan | undefined =>
  escape?.plans?.find((plan) => plan.state === "active");

export const currentStep = (plan?: EscapePlan): PlanStep | undefined =>
  plan?.steps.find((step) => step.state === "pending");

/** Where the current step is right now (a person moves; a thing does not). */
export function stepSpot(
  g: Game,
  step: PlanStep,
): { x: number; y: number; floor: number } {
  if (step.kind === "ask" && step.npcId) {
    const person = g.survivors.find((a) => a.id === step.npcId);
    if (person) return { x: person.x, y: person.y, floor: person.floor };
  }
  return step.at;
}

/** What the caller must do to the world after a tick. */
type PlanEffect =
  | { kind: "none" }
  | { kind: "harm"; amount: number; cause: string }
  | { kind: "die"; cause: string }
  | { kind: "escape" };

const lastSpots = new WeakMap<Game, { x: number; y: number; floor: number }>();

/** Write what the world just showed into the journal, once per text. */
function reveal(g: Game, escape: EscapeState, text: string, id: string): void {
  g.notice = text;
  if (escape.ledger.journal.some((entry) => entry.line === text)) return;
  const fact = commitFact(
    escape.ledger,
    {
      text,
      subject: { kind: "route", id },
      source: "observation",
      visibility: ["public"],
      loop: escape.loop,
      durable: true,
    },
    g.time,
  );
  learn(escape.ledger, fact.id, text.slice(0, 160), "attempt", g.time);
}

function fail(g: Game, escape: EscapeState, plan: EscapePlan, text: string) {
  plan.state = "failed";
  plan.outcome = text;
  reveal(g, escape, text, plan.means);
}

/**
 * Advance the active plan by `dt` seconds. The human must be at the step's
 * spot; timed steps progress only while standing still. The first arrival at
 * a step asks the truth sheet about what it needs.
 */
export function planTick(g: Game, dt: number): PlanEffect {
  const escape = g.escape,
    a: Actor | undefined = g.survivors[0];
  if (!escape || !a || g.status !== "playing" || !a.alive)
    return { kind: "none" };
  const plan = activePlan(escape),
    step = currentStep(plan);
  const before = lastSpots.get(g);
  lastSpots.set(g, { x: a.x, y: a.y, floor: a.floor });
  if (!plan || !step) return { kind: "none" };
  const truth = ensureTruth(g)!;
  const spot = stepSpot(g, step),
    reach = step.kind === "ask" ? PLAN_ASK_REACH : PLAN_REACH;
  if (a.floor !== spot.floor || Math.hypot(a.x - spot.x, a.y - spot.y) > reach)
    return { kind: "none" };

  // First arrival: the world shows what is really true of this thing.
  if (!step.resolved) {
    step.resolved = true;
    const entry =
      step.resource === "none" ? undefined : truth.resources[step.resource];
    if (entry?.kind === "wall") {
      fail(g, escape, plan, entry.reveal);
      return entry.harm
        ? { kind: "harm", amount: entry.harm, cause: entry.reveal }
        : { kind: "none" };
    }
    if (
      entry?.kind === "gap" &&
      !plan.steps.some((s) => s.label === entry.fix.label)
    ) {
      reveal(g, escape, entry.reveal, step.resource);
      const places = (escape.places ??= {});
      const at = (places[entry.fix.label.toLowerCase()] ??= gapSpot(
        g,
        step,
        entry.fix.label,
      ));
      plan.steps.splice(plan.steps.indexOf(step), 0, {
        id: `${step.id}-fix`,
        kind: "fetch",
        text: entry.fix.text,
        label: entry.fix.label,
        at: { ...at },
        resource: "none",
        seconds: entry.fix.seconds,
        state: "pending",
        progress: 0,
        resolved: true,
      });
      return { kind: "none" };
    }
  }

  if (step.seconds > 0) {
    const speed =
      before && before.floor === a.floor && dt > 0
        ? Math.hypot(a.x - before.x, a.y - before.y) / dt
        : 0;
    if (speed > STILL_SPEED) return { kind: "none" };
    step.progress = Math.min(step.seconds, step.progress + dt);
    if (step.progress < step.seconds) return { kind: "none" };
  }
  step.state = "done";
  if (currentStep(plan)) return { kind: "none" };

  // The plan is carried out: the sheet rules on the way out itself.
  const rule = truth.means[plan.means] ?? {
    outcome: "wall",
    reveal: WALLS.other,
  };
  if (rule.outcome === "escapes") {
    plan.state = "escaped";
    plan.outcome = rule.reveal;
    g.notice = rule.reveal;
    return { kind: "escape" };
  }
  fail(g, escape, plan, rule.reveal);
  return rule.outcome === "dies"
    ? { kind: "die", cause: rule.reveal }
    : { kind: "none" };
}

/** Somewhere else in the place for the missing thing: another labelled object. */
function gapSpot(g: Game, step: PlanStep, label: string) {
  const others = planAnchors(g).filter(
    (a) =>
      a.id.startsWith("obj-") &&
      (a.floor !== step.at.floor ||
        Math.hypot(a.x - step.at.x, a.y - step.at.y) > 6),
  );
  const pick = others.length
    ? others[hash(g.seed, label) % others.length]
    : undefined;
  return pick ? { x: pick.x, y: pick.y, floor: pick.floor } : { ...step.at };
}

/* ------------------------------------------------------------------ */
/* What the player is shown                                            */
/* ------------------------------------------------------------------ */

const AHEAD = [
  "ahead",
  "ahead to the right",
  "to the right",
  "behind to the right",
  "behind",
  "behind to the left",
  "to the left",
  "ahead to the left",
];

/** The objective lines for the active plan, or undefined when there is none. */
export function planObjective(
  g: Game,
): { title: string; description: string } | undefined {
  const plan = activePlan(g.escape),
    step = currentStep(plan),
    a = g.survivors[0];
  if (!plan || !step || !a) return undefined;
  const spot = stepSpot(g, step),
    done = plan.steps.filter((s) => s.state === "done").length,
    count = `Step ${done + 1} of ${plan.steps.length}`;
  if (spot.floor !== a.floor) {
    const level =
      g.floors[spot.floor]?.name?.trim() || `level ${spot.floor + 1}`;
    return {
      title: step.text,
      description: `${count}. ${step.label}: on ${level}, ${spot.floor > a.floor ? "above" : "below"} you.`,
    };
  }
  const dx = spot.x - a.x,
    dy = spot.y - a.y,
    metres = Math.hypot(dx, dy),
    reach = step.kind === "ask" ? PLAN_ASK_REACH : PLAN_REACH;
  if (metres <= reach)
    return {
      title: step.text,
      description:
        step.seconds > 0
          ? `${count}. Stay here and keep still: ${Math.ceil(step.seconds - step.progress)} s left.`
          : `${count}.`,
    };
  const turn = Math.atan2(dy, dx) - Math.atan2(a.heading.y, a.heading.x),
    sector = ((Math.round(turn / (Math.PI / 4)) % 8) + 8) % 8;
  return {
    title: step.text,
    description: `${count}. ${step.label}: ${Math.round(metres)} m ${AHEAD[sector]}.`,
  };
}
