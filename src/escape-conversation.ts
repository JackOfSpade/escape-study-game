/**
 * Open conversation for the escape redesign (docs/ESCAPE_REDESIGN.md
 * sections 7 and 9). Plain data in, plain data out: no DOM, no timers and no
 * network, so the prompt payload and its bookkeeping are unit-testable.
 *
 * The catastrophe spec is deliberately out of reach here: this module only
 * ever reads the fact ledger, each NPC's own social state and utterances the
 * NPC could actually hear. Nothing in it may read `g.escape.catastrophe`.
 */
import { factDigest, factsVisibleTo, type FactViewer } from "./fact-ledger";
import { distance, type Actor, type Game } from "./model";
import { npcCanHearSpeech } from "./npc-hearing";
import {
  chooseNextSpeaker,
  recordInteraction,
  socialPromptSummary,
  validateOutcome,
  type OutcomeContext,
  type SocialPromptSummary,
  type SpeakerCandidate,
} from "./npc-social";
import { applySocialOutcome, outcomeContext } from "./npc-social-runtime";
import type { NpcOutcome, NpcSocial, Utterance } from "./escape-types";

export const ESCAPE_CONVERSATION_LIMITS = Object.freeze({
  utterances: 40,
  visibleFacts: 12,
  heard: 6,
  replyGapSeconds: [1.2, 3] as const,
});

export interface ConverseContext {
  /** Why this NPC is about to speak; defaults to a reply. */
  reason?: string;
  /** Actor id this line is aimed at, if any. */
  addresseeId?: string | null;
  /** The utterance being answered, when this is a reply. */
  utteranceId?: string;
}

export interface ConversePayload {
  requestId: string;
  speaker: {
    id: string;
    name: string;
    role: string;
    personality: { risk: number; social: number; skills: number };
  };
  social: SocialPromptSummary | null;
  visibleFacts: string[];
  heard: { speakerId: string; speakerName: string; text: string }[];
  addressee: string | null;
  addresseeId: string | null;
  reason: string;
}

export interface ConverseAnswer {
  requestId?: string;
  speakerId?: string;
  text?: string;
  outcome?: unknown;
}

export interface ConverseResult {
  text: string;
  outcome: NpcOutcome;
  /** Set when the AI's outcome failed validation and was dropped. */
  rejected?: string;
}

const utterances = new WeakMap<Game, Utterance[]>();

function socialOf(npc: Actor | undefined): NpcSocial | undefined {
  return npc?.socialState;
}

function actorNamed(g: Game, id: string | undefined | null) {
  if (!id) return undefined;
  return g.survivors.find((a) => a.id === id);
}

function firstName(name: string | undefined) {
  return name?.trim().split(/\s+/)[0] ?? "";
}

/** Everything this NPC may know about itself and the room it stands in. */
function viewerFor(g: Game, npc: Actor): FactViewer {
  return {
    npcId: npc.id,
    role: npc.role,
    areaId: g.escape?.areas.current,
    documents: [],
  };
}

/** Durable facts this NPC can see, shortest useful form, at most twelve. */
export function visibleFactsFor(g: Game, npc: Actor): string[] {
  const ledger = g.escape?.ledger;
  if (!ledger) return [];
  return factDigest(
    factsVisibleTo(ledger, viewerFor(g, npc)),
    ESCAPE_CONVERSATION_LIMITS.visibleFacts,
  );
}

/** The last utterances this NPC heard, oldest first, at most six. */
export function heardByNpc(g: Game, npcId: string) {
  const all = utterances.get(g) ?? [];
  return all
    .filter((u) => u.heardBy.includes(npcId))
    .slice(-ESCAPE_CONVERSATION_LIMITS.heard)
    .map((u) => ({
      speakerId: u.speakerId,
      speakerName:
        actorNamed(g, u.speakerId)?.name ??
        (u.speakerId === "pa" ? "PA" : u.speakerId),
      text: u.text,
    }));
}

export function conversationRequest(
  g: Game,
  speakerId: string,
  context: ConverseContext = {},
): ConversePayload {
  const npc = actorNamed(g, speakerId),
    addressee = actorNamed(g, context.addresseeId);
  return {
    requestId: `converse-${crypto.randomUUID()}`,
    speaker: {
      id: speakerId,
      name: npc?.name ?? speakerId,
      role: npc?.role ?? "survivor",
      personality: {
        risk: npc?.risk ?? 0.5,
        social: npc?.social ?? 0.5,
        skills: npc?.skill ?? 0,
      },
    },
    social: socialOf(npc) ? socialPromptSummary(socialOf(npc)!, g.time) : null,
    visibleFacts: npc ? visibleFactsFor(g, npc) : [],
    heard: npc ? heardByNpc(g, npc.id) : [],
    addressee: addressee?.name ?? null,
    addresseeId: addressee?.id ?? null,
    reason: context.reason?.trim() || "reply",
  };
}

/** The social state the engine keeps on an NPC, if any. */
function interactionAt(g: Game) {
  return Number.isFinite(g.time) ? g.time : 0;
}

function recordAnswer(
  g: Game,
  npc: Actor,
  outcome: NpcOutcome,
  rejected: string | undefined,
) {
  const social = socialOf(npc);
  if (!social) return;
  const cooperative =
    outcome.kind === "share-fact" ||
    outcome.kind === "lead" ||
    outcome.kind === "follow" ||
    outcome.kind === "unlock" ||
    outcome.kind === "agree-with-conditions";
  const kind =
    rejected !== undefined || outcome.kind === "refuse"
      ? "refused"
      : cooperative
        ? "persuaded"
        : "asked";
  recordInteraction(social, {
    at: interactionAt(g),
    kind,
    text:
      rejected === undefined
        ? `Answered the player (${outcome.kind}).`
        : `Would not go along with the player (${rejected}).`,
  });
}

/**
 * The gate between the AI answer and gameplay. Only an outcome that
 * `validateOutcome` accepts is handed to `applySocialOutcome`; the text is
 * still spoken so a rejected outcome never silences the NPC.
 */
export function handleConverseAnswer(
  g: Game,
  answer: ConverseAnswer | undefined,
): ConverseResult | undefined {
  const speakerId =
    answer && typeof answer.speakerId === "string" ? answer.speakerId : "";
  const npc = actorNamed(g, speakerId);
  if (!npc || npc.id === "human" || !g.escape) return undefined;
  const raw =
    typeof answer?.text === "string" ? answer.text.trim().slice(0, 400) : "";
  if (!raw) return undefined;
  const social = socialOf(npc),
    base = outcomeContext(g, npc.id),
    ctx: OutcomeContext = {
      canDetain: base.canDetain || social?.canDetain === true,
      atDoorIds: base.atDoorIds,
      knownFactIds:
        base.knownFactIds.length > 0
          ? base.knownFactIds
          : factsVisibleTo(g.escape.ledger, viewerFor(g, npc)).map((f) => f.id),
      leadTargets: base.leadTargets,
    };
  const checked = validateOutcome(answer?.outcome, ctx);
  if (checked.rejected === undefined)
    applySocialOutcome(g, npc.id, checked.outcome);
  recordAnswer(g, npc, checked.outcome, checked.rejected);
  return {
    text: raw,
    outcome: checked.outcome,
    ...(checked.rejected === undefined ? {} : { rejected: checked.rejected }),
  };
}

/**
 * Store one line and report who heard it: NPCs on the speaker's floor within
 * speech range with a clear acoustic path. The newest forty lines are kept.
 */
export function recordUtterance(g: Game, u: Utterance): string[] {
  const speaker = actorNamed(g, u.speakerId);
  const heardBy = speaker
    ? g.survivors
        .filter((a) => a.id !== speaker.id)
        .filter((a) => npcCanHearSpeech(g, a, speaker))
        .map((a) => a.id)
    : [...u.heardBy];
  const stored: Utterance = { ...u, heardBy };
  const all = utterances.get(g) ?? [];
  all.push(stored);
  utterances.set(g, all.slice(-ESCAPE_CONVERSATION_LIMITS.utterances));
  return heardBy;
}

export function utterancesFor(g: Game): readonly Utterance[] {
  return utterances.get(g) ?? [];
}

export function utteranceById(g: Game, id: string) {
  return (utterances.get(g) ?? []).find((u) => u.id === id);
}

/** Last time the NPC spoke, so turn taking can make it wait its turn. */
function lastSpokeAt(g: Game, npcId: string) {
  const all = utterances.get(g) ?? [];
  for (let i = all.length - 1; i >= 0; i--)
    if (all[i]!.speakerId === npcId) return all[i]!.at;
  return undefined;
}

function textWords(text: string) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 4),
  );
}

function mentionsSomething(text: string, facts: string[]) {
  const words = textWords(text);
  return facts.some((fact) => {
    const factWords = textWords(fact);
    for (const word of factWords) if (words.has(word)) return true;
    return false;
  });
}

/**
 * Who answers an utterance: the addressee first, otherwise the NPC with the
 * strongest case to speak (it was named, or the line touches something it can
 * see) weighted by how outgoing it is.
 */
export function nextResponder(
  g: Game,
  utterance: Utterance,
  now: number,
  rng: () => number,
): string | undefined {
  const speaker = actorNamed(g, utterance.speakerId);
  const candidates: SpeakerCandidate[] = [];
  for (const npc of g.survivors) {
    if (!utterance.heardBy.includes(npc.id)) continue;
    if (npc.id === utterance.speakerId || npc.id === "human") continue;
    if (!npc.alive || npc.escaped || npc.floor !== utterance.floor) continue;
    if (distance(npc, utterance) > 10) continue;
    const named =
      firstName(npc.name).length > 0 &&
      new RegExp(`\\b${firstName(npc.name)}\\b`, "i").test(utterance.text);
    const relevant = mentionsSomething(utterance.text, visibleFactsFor(g, npc));
    candidates.push({
      id: npc.id,
      addressed: utterance.addressee === npc.id,
      relevance: named ? 1 : relevant ? 0.7 : 0.35,
      social: npc.social ?? 0.5,
      spokeAt: lastSpokeAt(g, npc.id),
    });
  }
  if (!candidates.length) return undefined;
  void speaker;
  return chooseNextSpeaker(candidates, now, rng);
}

const FALLBACK_LINES = Object.freeze([
  "Sorry, what?",
  "Not now, I'm busy.",
  "Hm?",
  "Can it wait?",
  "What is it?",
]);

/**
 * A short acknowledgement for when the AI cannot answer. Deterministic for a
 * speaker, loop and second, and always carries the neutral outcome.
 */
export function fallbackConverseLine(
  g: Game,
  speakerId: string,
  now = Math.floor(g.time),
): ConverseResult {
  let hash = 0x811c9dc5;
  for (const char of `${g.id}\u0000${g.escape?.loop ?? 0}\u0000${speakerId}\u0000${now}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  const index = (hash >>> 0) % FALLBACK_LINES.length;
  return { text: FALLBACK_LINES[index]!, outcome: { kind: "none" } };
}

function angleDelta(a: number, b: number) {
  let delta = (b - a) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return Math.abs(delta);
}

/**
 * Who a spoken line is aimed at: someone named in the text wins, otherwise the
 * listener closest to where the speaker is facing (inside about sixty degrees
 * and within earshot).
 */
export function resolveAddressee(
  speaker: { x: number; y: number; yaw: number },
  text: string,
  listeners: readonly Actor[],
): string | undefined {
  const words = textWords(text);
  const calledBy = (actor: Actor) =>
    actor.name
      .split(/\s+/)
      .map((part) => part.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase())
      .some((part) => part.length >= 3 && words.has(part));
  const named = listeners.find(calledBy);
  if (named) return named.id;
  let best: { id: string; angle: number; distance: number } | undefined;
  for (const actor of listeners) {
    const dx = actor.x - speaker.x,
      dy = actor.y - speaker.y,
      distance = Math.hypot(dx, dy);
    if (distance > 10) continue;
    const angle = angleDelta(Math.atan2(dy, dx), speaker.yaw);
    if (angle > Math.PI / 3) continue;
    if (
      !best ||
      angle < best.angle - 1e-6 ||
      (Math.abs(angle - best.angle) <= 1e-6 && distance < best.distance)
    )
      best = { id: actor.id, angle, distance };
  }
  return best?.id;
}
