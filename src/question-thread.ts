import type { Encounter, Game, Message, Problem } from "./model";
import { adoptQuestionPacing } from "./field-pacing";
import { encounterKey, interruptLearningAttempt } from "./learner";
import { onEscapeSegment } from "./escape-terminal";
import { segmentSummary } from "../scripts/lib/question-segments.mjs";

/** One part of a long question: one terminal visit, one key. */
export interface QuestionSegment {
  goal: string;
  /** Zero-based indexes into the problem's rubric; each belongs to one segment. */
  rubricItems: number[];
  /** scopeDefinitions facet ids this part exercises. */
  facets: string[];
  estimatedSolveSeconds: number;
}
/** One terminal visit that worked a segment of the thread. */
export interface ThreadVisit {
  /** `encounterKey` of the terminal: `${runId}/${encounterId}`. */
  encounter: string;
  runId: string;
  segment: number;
  at: number;
  completed?: boolean;
  /** Whether the human actually received the key (false after death). */
  keyGranted?: boolean;
  summary?: string;
}
/**
 * The learner's unfinished question. It lives in study state, so it is saved
 * in the same atomic snapshot as the terminals and keys it refers to, and it
 * moves with the study state into the next run. The very next solo terminal
 * the human opens continues it, with its earlier conversation and progress.
 */
export interface QuestionThread {
  id: string;
  problem: Problem;
  /** Index of the segment being worked. */
  segment: number;
  visits: ThreadVisit[];
  /** The visit allowed to complete the current segment. */
  active?: string;
  startedAt: string;
  finishedAt?: string;
}

export const segmentCount = (p: Pick<Problem, "segments">) =>
  p.segments?.length || 1;

/** The open thread, if any. A finished one stays as context for assessments. */
export function openThread(g: Game) {
  const t = g.study.thread;
  return t && !t.finishedAt ? t : undefined;
}

/** A thread terminal: a solo world terminal, never a study-only or linked one. */
const threadable = (e: Encounter) =>
  e.mode === "solo" && !e.studyOnly && (!e.owner || e.owner === "human");

/** The problem with the current segment's estimate, for field pacing. */
export function segmentPacing(p: Problem, segment: number): Problem {
  const s = p.segments?.[segment];
  return s
    ? {
        ...p,
        segments: undefined,
        estimatedSolveSeconds: s.estimatedSolveSeconds,
      }
    : p;
}

/** Start a thread when the human is first shown a question at a solo terminal. */
export function startThread(g: Game, e: Encounter) {
  if (
    !threadable(e) ||
    !e.problem ||
    e.thread ||
    e.state === "consumed" ||
    openThread(g)
  )
    return undefined;
  const key = encounterKey(e);
  const t: QuestionThread = {
    id: `thread-${key}`,
    problem: structuredClone(e.problem),
    segment: 0,
    visits: [
      { encounter: key, runId: e.runId ?? g.id, segment: 0, at: Date.now() },
    ],
    active: key,
    startedAt: new Date().toISOString(),
  };
  g.study.thread = t;
  e.thread = { id: t.id, segment: 0 };
  return t;
}

/** A terminal that already holds another question the human started. */
function holdsOtherWork(e: Encounter) {
  return (
    e.problemPresentedSequence !== undefined ||
    e.tutor.some((m) => m.kind === "human") ||
    e.submissions.some((s) => s.author === "human")
  );
}

/**
 * On opening a terminal: continue the open thread there. Returns true when
 * `e` now works the thread's current segment. A terminal that is consumed,
 * study-only, linked, or already holds another started question is left as it
 * is; an earlier visit of this thread opens read-only.
 */
export function bindThread(g: Game, e: Encounter) {
  const t = openThread(g);
  if (!t || !threadable(e) || g.encounters[e.id] !== e) return false;
  const key = encounterKey(e);
  if (e.thread) {
    if (
      e.thread.id !== t.id ||
      e.thread.segment !== t.segment ||
      e.state === "consumed"
    )
      return false;
    moveActive(g, t, key);
    return true;
  }
  if (e.state === "consumed" || holdsOtherWork(e)) return false;
  moveActive(g, t, key);
  e.problem = structuredClone(t.problem);
  e.thread = { id: t.id, segment: t.segment };
  delete e.pendingGeneration;
  delete e.generation;
  delete e.error;
  if (e.revision === 0) e.workspace = e.problem.starter;
  e.state = "in-progress";
  t.visits.push({
    encounter: key,
    runId: e.runId ?? g.id,
    segment: t.segment,
    at: Date.now(),
  });
  adoptQuestionPacing(g, e.floor, segmentPacing(t.problem, t.segment));
  return true;
}

/** Only one terminal can complete a segment: the one opened last. */
function moveActive(g: Game, t: QuestionThread, key: string) {
  if (t.active === key) return;
  const previous = Object.values(g.encounters).find(
    (x) => encounterKey(x) === t.active,
  );
  // The learning attempt follows the question to its new terminal.
  if (previous && previous.state !== "consumed" && g.study.learner)
    interruptLearningAttempt(g.study.learner, previous);
  t.active = key;
}

/** Whether `e` is the terminal allowed to complete the thread's current segment. */
export function isActiveVisit(g: Game, e: Encounter) {
  const t = openThread(g);
  return (
    !!t &&
    e.thread?.id === t.id &&
    e.thread.segment === t.segment &&
    t.active === encounterKey(e)
  );
}

/** A terminal that worked an earlier segment, or this one somewhere else. */
export function isInactiveVisit(g: Game, e: Encounter) {
  return !!e.thread && !isActiveVisit(g, e) && e.state !== "consumed";
}

/**
 * Record a completed segment and advance. Idempotent: it acts only for the
 * active visit of the current segment, and the caller runs it in the same
 * synchronous step that consumed the terminal and granted its key, so one
 * snapshot always holds both or neither. Returns the thread when it finished.
 */
export function completeSegment(
  g: Game,
  e: Encounter,
  options: { keyGranted: boolean; summary?: unknown },
) {
  if (!isActiveVisit(g, e)) return undefined;
  const t = g.study.thread!;
  const key = encounterKey(e);
  const visit = t.visits
    .filter((v) => v.encounter === key && v.segment === t.segment)
    .at(-1);
  if (visit) {
    visit.completed = true;
    visit.keyGranted = options.keyGranted;
    const summary = segmentSummary(options.summary);
    if (summary) visit.summary = summary;
  }
  delete t.active;
  t.segment++;
  let finished: QuestionThread | undefined;
  if (t.segment >= segmentCount(t.problem)) {
    t.finishedAt = new Date().toISOString();
    finished = t;
  }
  // An escape task worked at this station ticks one step per segment.
  onEscapeSegment(g, e);
  return finished;
}

/** Every terminal this thread visited that this save still holds. */
export function threadEncounters(g: Game, t: QuestionThread) {
  const all = [...Object.values(g.encounters), ...g.study.archives];
  const keys = new Set(t.visits.map((v) => v.encounter));
  const found = new Map<string, Encounter>();
  for (const e of all) {
    const key = encounterKey(e);
    if (keys.has(key) && e.thread?.id === t.id && !found.has(key))
      found.set(key, e);
  }
  return t.visits
    .map((v) => found.get(v.encounter))
    .filter((e, i, list): e is Encounter => !!e && list.indexOf(e) === i);
}

export interface CarriedVisit {
  segment: number;
  encounter: string;
  completed: boolean;
  messages: Message[];
}
/** Earlier visits' conversations, oldest first, for display and the tutor. */
export function carriedVisits(g: Game, e: Encounter): CarriedVisit[] {
  const t = g.study.thread;
  if (!t || e.thread?.id !== t.id) return [];
  const self = encounterKey(e);
  const byKey = new Map(
    threadEncounters(g, t).map((x) => [encounterKey(x), x]),
  );
  const seen = new Set<string>();
  const out: CarriedVisit[] = [];
  for (const v of t.visits) {
    if (v.encounter === self) break;
    if (seen.has(v.encounter)) continue;
    seen.add(v.encounter);
    const x = byKey.get(v.encounter);
    if (!x) continue;
    out.push({
      segment: v.segment,
      encounter: v.encounter,
      completed: !!v.completed,
      messages: x.tutor.filter((m) => m.kind === "human" || m.kind === "tutor"),
    });
  }
  return out;
}

const MAX_CARRIED_MESSAGES = 40;
const MAX_CARRIED_TEXT = 4000;
/** The segment block of a tutor payload: the current part, summaries of the
 * finished parts and this part's conversation from earlier visits. Finished
 * parts are summarized, so the prompt stays bounded however long the thread. */
export function segmentPayload(g: Game, e: Encounter) {
  const t = g.study.thread;
  const p = e.problem;
  if (!t || !p || e.thread?.id !== t.id) return undefined;
  const index = e.thread.segment;
  const s = p.segments?.[index];
  const carried = carriedVisits(g, e);
  const earlier = t.visits
    .filter((v) => v.segment < index && v.completed)
    .map((v) => ({
      index: v.segment,
      goal: p.segments?.[v.segment]?.goal ?? p.title,
      summary: v.summary ?? "No summary was recorded for this part.",
    }));
  return {
    index,
    count: segmentCount(p),
    goal: s?.goal ?? p.title,
    rubric: s ? s.rubricItems.map((i) => p.rubric[i]) : p.rubric,
    facets: s?.facets ?? [],
    estimatedSolveSeconds: s?.estimatedSolveSeconds ?? p.estimatedSolveSeconds,
    earlier,
    carriedConversation: carried
      .filter((v) => v.segment === index)
      .flatMap((v) => v.messages)
      .slice(-MAX_CARRIED_MESSAGES)
      .map((m) => ({
        author: m.author,
        kind: m.kind,
        text: m.text.slice(0, MAX_CARRIED_TEXT),
      })),
  };
}

/** The part of a whole question an assessed visit covered, or undefined. */
export function assessmentSegment(g: Game, e: Encounter) {
  const t = g.study.thread;
  const p = e.problem;
  if (!e.thread || !p?.segments?.length) return undefined;
  const index = e.thread.segment;
  const s = p.segments[index];
  if (!s) return undefined;
  return {
    index,
    count: p.segments.length,
    goal: s.goal,
    rubric: s.rubricItems.map((i) => p.rubric[i]),
    facets: s.facets,
    earlier:
      t?.id === e.thread.id
        ? t.visits
            .filter((v) => v.segment < index && v.completed)
            .map((v) => ({ index: v.segment, summary: v.summary ?? "" }))
        : [],
  };
}

/** Assessment waits until the whole thread is finished. */
export function assessmentDeferred(g: Game, e: Encounter) {
  const t = openThread(g);
  return !!t && e.thread?.id === t.id;
}

/**
 * The human's last message on this terminal, when its tutor request was cut
 * off by a reload, crash or relay restart and has not yet been resent. It is
 * resent once, as the same request, so the turn is neither lost nor doubled.
 */
export function resendableRequest(e: Encounter) {
  const job = e.tutorRequests?.at(-1);
  const last = e.tutor.at(-1);
  if (
    !e.thread ||
    !job ||
    job.state !== "interrupted" ||
    job.resent ||
    !last ||
    last.kind !== "human" ||
    last.seq !== job.questionSequence
  )
    return undefined;
  return job;
}

/** An unanswered message carried from an earlier run's terminal: offered as
 * the new terminal's draft instead of being copied as new evidence. */
export function carriedUnanswered(g: Game, e: Encounter) {
  if (e.tutor.length || e.chatDraft) return undefined;
  const carried = carriedVisits(g, e).filter(
    (v) => v.segment === e.thread?.segment && !v.completed,
  );
  const last = carried.at(-1)?.messages.at(-1);
  return last?.kind === "human" ? last.text : undefined;
}
