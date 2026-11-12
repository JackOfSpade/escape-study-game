/**
 * NPC social simulation (docs/ESCAPE_REDESIGN.md section 7).
 *
 * Pure data helpers: awareness and alarm, the NPC's model of the player,
 * interaction history, suspicion by role plausibility, outcome validation
 * (authority, at the door), addressee by facing and name, turn-taking and
 * lead check-back timing. Nothing here touches the world, the catastrophe
 * spec or the clock: every time value and every random draw is passed in.
 */
import type {
  AwarenessEvent,
  AwarenessKind,
  InteractionRecord,
  NpcOutcome,
  NpcSocial,
  SocialGoal,
} from "./escape-types";

const AUTHORITY_WORDS = [
  "security",
  "guard",
  "police",
  "officer",
  "marshal",
  "warden",
  "sheriff",
  "soldier",
  "commander",
  "chief of security",
];

/** Roles with the authority to intervene with or detain the player. */
export const AUTHORITY_ROLE = new RegExp(
  `\\b(?:${AUTHORITY_WORDS.join("|")})\\b`,
  "i",
);

const RADIO_WORDS = [
  ...AUTHORITY_WORDS,
  "pilot",
  "dispatcher",
  "controller",
  "captain",
  "foreman",
  "ranger",
];

/** Roles carrying a radio, so a report can be made remotely. */
export const RADIO_ROLE = new RegExp(`\\b(?:${RADIO_WORDS.join("|")})\\b`, "i");

const AWARENESS_LIMIT = 24;
const HISTORY_LIMIT = 32;
const LEAD_CHECK_BACK_SECONDS = 4;
const LEAD_LOST_CHECK_SECONDS = 2;
const LEAD_PRESENT_TILES = 6;
const LEAD_VISIBLE_TILES = 12;
const LEAD_CALLING_SECONDS = 4;
const LEAD_RETURNING_SECONDS = 8;
const LEAD_GIVE_UP_SECONDS = 20;
const EARSHOT_TILES = 10;
const FACING_CONE = Math.PI / 6; // 30 degrees
const ANGLE_EPSILON = 1e-9;
const TURN_COOLDOWN_SECONDS = 2;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function createSocial(
  npc: { role: string; risk: number; social: number },
  relationship: NpcSocial["player"]["relationship"],
): NpcSocial {
  const authority = AUTHORITY_ROLE.test(npc.role);
  return {
    alarm: 0,
    awareness: [],
    player: { relationship, suspicion: 0, history: [] },
    canDetain: authority,
    hasRadio: RADIO_ROLE.test(npc.role),
    checkBackSeconds: authority
      ? LEAD_CHECK_BACK_SECONDS
      : clamp(Math.round(4 + 10 * npc.risk + 4 * (1 - npc.social)), 4, 18),
  };
}

/**
 * How much a single awareness event lifts the alarm, by kind. Event weights
 * in the world come from this table; [alarmAt] reads the stored weight.
 */
export const AWARENESS_WEIGHTS: Record<AwarenessKind, number> = {
  pa: 0.1,
  scream: 0.45,
  running: 0.3,
  body: 0.6,
  "threat-seen": 0.9,
  "hazard-seen": 0.7,
  told: 0.25,
  "suspicious-act": 0.05,
  alarm: 0.5,
};

export function observe(
  s: NpcSocial,
  event: AwarenessEvent,
  now: number,
): void {
  s.awareness.push(event);
  if (s.awareness.length > AWARENESS_LIMIT) {
    s.awareness.splice(0, s.awareness.length - AWARENESS_LIMIT);
  }
  s.alarm = alarmAt(s, now);
}

/**
 * Alarm is one minus the product of each event's remaining weight. A weight
 * halves every 300 seconds; events in the NPC's future are ignored.
 */
export function alarmAt(s: NpcSocial, now: number): number {
  let calm = 1;
  for (const event of s.awareness) {
    if (event.at > now) continue;
    calm *= 1 - event.weight * 0.5 ** ((now - event.at) / 300);
  }
  return clamp(1 - calm, 0, 1);
}

export function recordInteraction(s: NpcSocial, rec: InteractionRecord): void {
  s.player.history.push(rec);
  if (s.player.history.length > HISTORY_LIMIT) {
    s.player.history.splice(0, s.player.history.length - HISTORY_LIMIT);
  }
}

export const SUSPICIOUS_ACTIONS = [
  "repair",
  "hotwire",
  "force-door",
  "tamper",
  "enter-restricted",
  "read-restricted",
  "take",
  "launch",
  "unlock",
] as const;

export type SuspiciousAction = (typeof SUSPICIOUS_ACTIONS)[number];

const ENGINEER_ROLE = /\b(?:engineer|technician|mechanic)\b/i;
const SCIENTIST_ROLE = /\b(?:scientist|researcher|doctor)\b/i;
const PILOT_ROLE = /\b(?:pilot|astronaut)\b/i;

const ROLE_PLAUSIBILITY: readonly [
  RegExp,
  Partial<Record<SuspiciousAction, number>>,
][] = [
  [ENGINEER_ROLE, { repair: 0.9, tamper: 0.9, hotwire: 0.5 }],
  [AUTHORITY_ROLE, { "force-door": 0.9, "enter-restricted": 0.9, unlock: 0.9 }],
  [SCIENTIST_ROLE, { "read-restricted": 0.8 }],
  [PILOT_ROLE, { launch: 0.7 }],
];

/**
 * How plausible an action is for a role, 0..1. Unknown actions are 0; a
 * role's table covers the actions that fit it, everything else falls back to
 * the "teacher/clerk/other" line (0.1, or 0.3 for taking something).
 */
export function actionPlausibility(playerRole: string, action: string): number {
  if (!(SUSPICIOUS_ACTIONS as readonly string[]).includes(action)) {
    return 0;
  }
  for (const [pattern, table] of ROLE_PLAUSIBILITY) {
    if (!pattern.test(playerRole)) continue;
    return table[action as SuspiciousAction] ?? 0.1;
  }
  return action === "take" ? 0.3 : 0.1;
}

export type SuspicionResponse =
  "ignore" | "question" | "watch" | "report" | "intervene" | "detain";

/**
 * A witnessed suspicious act raises suspicion by how implausible it is for
 * the player's role, whether it was seen or heard, and how calm the NPC is.
 * The response is the ladder rung the resulting suspicion falls on.
 */
export function noticeSuspicion(
  s: NpcSocial,
  input: {
    plausibility: number;
    witnessed: "seen" | "heard";
    now: number;
    panicking?: boolean;
  },
): SuspicionResponse {
  if (input.panicking || s.alarm >= 0.7) return "ignore";
  const plausibility = clamp(input.plausibility, 0, 1);
  const gain =
    (1 - plausibility) *
    (input.witnessed === "seen" ? 0.5 : 0.25) *
    (1 - s.alarm * 0.8);
  s.player.suspicion = clamp(s.player.suspicion + gain, 0, 1);
  recordInteraction(s, {
    at: input.now,
    kind: "suspicious",
    text: `Suspicious act ${input.witnessed}.`,
  });
  const suspicion = s.player.suspicion;
  if (suspicion < 0.15) return "ignore";
  if (suspicion < 0.4) return "question";
  if (suspicion < 0.6) return "watch";
  if (suspicion < 0.8) return s.canDetain ? "intervene" : "report";
  return s.canDetain ? "detain" : "report";
}

export interface OutcomeContext {
  canDetain: boolean;
  atDoorIds: readonly string[];
  knownFactIds: readonly string[];
  leadTargets: readonly string[];
}

const SIMPLE_OUTCOMES = new Set<string>([
  "none",
  "follow",
  "stop-following",
  "refuse",
  "ask-for-proof",
  "report",
  "watch",
]);

const CONDITION_MAX = 160;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Gameplay-side gate for an AI outcome: the NPC may only do what its
 * authority and position allow, facts must be known, leads must exist, doors
 * must be within reach and alarm shifts must be small. Accepted outcomes are
 * rebuilt with only their declared keys.
 */
export function validateOutcome(
  o: unknown,
  ctx: OutcomeContext,
): { outcome: NpcOutcome; rejected?: string } {
  const reject = (reason: string) => ({
    outcome: { kind: "none" } as NpcOutcome,
    rejected: reason,
  });
  if (!isRecord(o)) return reject("outcome is not an object");
  const kind = o.kind;
  if (typeof kind !== "string" || kind.length === 0) {
    return reject("outcome kind is missing");
  }
  if (SIMPLE_OUTCOMES.has(kind)) {
    return { outcome: { kind } as NpcOutcome };
  }
  switch (kind) {
    case "share-fact": {
      const factId = o.factId;
      if (typeof factId !== "string" || factId.length === 0) {
        return reject("share-fact needs a factId");
      }
      if (!ctx.knownFactIds.includes(factId)) {
        return reject(`unknown fact: ${factId}`);
      }
      return { outcome: { kind: "share-fact", factId } };
    }
    case "lead": {
      const targetId = o.targetId;
      if (typeof targetId !== "string" || targetId.length === 0) {
        return reject("lead needs a targetId");
      }
      if (!ctx.leadTargets.includes(targetId)) {
        return reject(`unknown lead target: ${targetId}`);
      }
      return { outcome: { kind: "lead", targetId } };
    }
    case "detain":
      if (!ctx.canDetain) return reject("no authority to detain");
      return { outcome: { kind: "detain" } };
    case "intervene":
      if (!ctx.canDetain) return reject("no authority to intervene");
      return { outcome: { kind: "intervene" } };
    case "unlock": {
      const doorId = o.doorId;
      if (typeof doorId !== "string" || doorId.length === 0) {
        return reject("unlock needs a doorId");
      }
      if (!ctx.atDoorIds.includes(doorId)) {
        return reject(`not at door: ${doorId}`);
      }
      return { outcome: { kind: "unlock", doorId } };
    }
    case "alarm": {
      const delta = o.delta;
      if (typeof delta !== "number" || !Number.isFinite(delta)) {
        return reject("alarm delta is not a finite number");
      }
      if (delta < -0.3 || delta > 0.3) {
        return reject(`alarm delta out of range: ${delta}`);
      }
      return { outcome: { kind: "alarm", delta } };
    }
    case "agree-with-conditions": {
      const condition = o.condition;
      if (typeof condition !== "string") {
        return reject("agree-with-conditions needs a condition");
      }
      if (condition.trim().length === 0) {
        return reject("condition is empty");
      }
      if (condition.length > CONDITION_MAX) {
        return reject("condition is longer than 160 characters");
      }
      return {
        outcome: { kind: "agree-with-conditions", condition },
      };
    }
    default:
      return reject(`unknown outcome kind: ${kind}`);
  }
}

export interface Speaker {
  x: number;
  y: number;
  yaw: number;
}

export interface Listener {
  id: string;
  name: string;
  x: number;
  y: number;
  canHear: boolean;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wrapAngle(angle: number): number {
  const turn = 2 * Math.PI;
  return ((((angle + Math.PI) % turn) + turn) % turn) - Math.PI;
}

/**
 * Who a line is aimed at: a spoken first name wins over facing, earliest
 * mention first; otherwise the nearest-to-gaze listener inside a 30 degree
 * cone and within 10 tiles, smallest angle first and nearer on a tie.
 */
export function resolveAddressee(
  speaker: Speaker,
  text: string,
  listeners: readonly Listener[],
): string | undefined {
  let namedId: string | undefined;
  let namedIndex = Infinity;
  for (const listener of listeners) {
    if (!listener.canHear) continue;
    const first = listener.name.trim().split(/\s+/)[0];
    if (!first) continue;
    const match = new RegExp(`\\b${escapeRegExp(first)}\\b`, "i").exec(text);
    if (match && match.index < namedIndex) {
      namedIndex = match.index;
      namedId = listener.id;
    }
  }
  if (namedId !== undefined) return namedId;
  let bestId: string | undefined;
  let bestAngle = Infinity;
  let bestDistance = Infinity;
  for (const listener of listeners) {
    if (!listener.canHear) continue;
    const dx = listener.x - speaker.x;
    const dy = listener.y - speaker.y;
    const distance = Math.hypot(dx, dy);
    if (distance > EARSHOT_TILES) continue;
    const angle = Math.abs(wrapAngle(Math.atan2(dy, dx) - speaker.yaw));
    if (angle > FACING_CONE + ANGLE_EPSILON) continue;
    const better =
      angle < bestAngle - ANGLE_EPSILON ||
      (Math.abs(angle - bestAngle) <= ANGLE_EPSILON && distance < bestDistance);
    if (better) {
      bestAngle = angle;
      bestDistance = distance;
      bestId = listener.id;
    }
  }
  return bestId;
}

export interface SpeakerCandidate {
  id: string;
  addressed: boolean;
  relevance: number;
  social: number;
  spokeAt?: number;
}

/**
 * Turn-taking: whoever just spoke waits 2 seconds, an addressed listener
 * speaks next, otherwise the highest relevance + personality score wins if
 * it clears 0.45. `rng` is the only source of randomness, one draw per
 * candidate in order.
 */
export function chooseNextSpeaker(
  candidates: readonly SpeakerCandidate[],
  now: number,
  rng: () => number,
): string | undefined {
  const available = candidates.filter(
    (c) => c.spokeAt === undefined || now - c.spokeAt >= TURN_COOLDOWN_SECONDS,
  );
  const addressed = available.find((c) => c.addressed);
  if (addressed) return addressed.id;
  let bestId: string | undefined;
  let bestScore = -Infinity;
  for (const candidate of available) {
    const score =
      candidate.relevance * 0.6 + candidate.social * 0.4 + rng() * 0.2;
    if (score >= 0.45 && score > bestScore) {
      bestScore = score;
      bestId = candidate.id;
    }
  }
  return bestId;
}

export type LeadGoal = Extract<SocialGoal, { kind: "lead" }>;

export type LeadEvent = "lost-player" | "found-player" | "gave-up";

/**
 * Lead check-back state machine. A check happens only at `nextCheck`; a
 * player within 6 tiles, or in sight within 12, counts as present. Losing
 * the player starts a 20 second clock: calling at +4, returning at +8,
 * giving up at +20. The input goal is never mutated.
 */
export function advanceLead(
  goal: LeadGoal,
  input: {
    now: number;
    playerDistance: number;
    playerVisible: boolean;
    checkBackSeconds: number;
  },
): { goal: LeadGoal; event?: LeadEvent } {
  const next: LeadGoal = { ...goal };
  if (input.now < goal.nextCheck) return { goal: next };
  const present =
    input.playerDistance <= LEAD_PRESENT_TILES ||
    (input.playerVisible && input.playerDistance <= LEAD_VISIBLE_TILES);
  if (goal.stage === "leading") {
    if (present) {
      next.nextCheck = input.now + input.checkBackSeconds;
      return { goal: next };
    }
    next.stage = "looking";
    next.missingSince = input.now;
    next.nextCheck = input.now + LEAD_LOST_CHECK_SECONDS;
    return { goal: next, event: "lost-player" };
  }
  next.nextCheck = input.now + LEAD_LOST_CHECK_SECONDS;
  if (present) {
    next.stage = "leading";
    next.missingSince = undefined;
    next.nextCheck = input.now + input.checkBackSeconds;
    return { goal: next, event: "found-player" };
  }
  const missingSince = goal.missingSince ?? input.now;
  const missingFor = input.now - missingSince;
  if (missingFor >= LEAD_RETURNING_SECONDS) next.stage = "returning";
  else if (missingFor >= LEAD_CALLING_SECONDS) next.stage = "calling";
  const previousCheck = goal.nextCheck - LEAD_LOST_CHECK_SECONDS;
  if (
    missingFor >= LEAD_GIVE_UP_SECONDS &&
    previousCheck - missingSince < LEAD_GIVE_UP_SECONDS
  ) {
    return { goal: next, event: "gave-up" };
  }
  return { goal: next };
}

export interface SocialPromptSummary {
  alarm: "calm" | "uneasy" | "alarmed" | "panicking";
  recent: string[];
  history: string[];
  relationship: string;
  suspicion: number;
}

/**
 * Compact, NPC-local view for a prompt. It reads only [NpcSocial], so no
 * catastrophe spec can leak into it; `now` is accepted for symmetry with the
 * other helpers but the record already holds resolved state.
 */
export function socialPromptSummary(
  s: NpcSocial,
  _now: number,
): SocialPromptSummary {
  const alarm =
    s.alarm < 0.2
      ? "calm"
      : s.alarm < 0.45
        ? "uneasy"
        : s.alarm < 0.7
          ? "alarmed"
          : "panicking";
  return {
    alarm,
    recent: s.awareness.slice(-6).map((event) => event.text),
    history: s.player.history
      .slice(-8)
      .map((rec) => `${rec.kind}: ${rec.text}`),
    relationship: s.player.relationship,
    suspicion: s.player.suspicion,
  };
}
