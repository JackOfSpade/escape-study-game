import type { Encounter, StudyRecord, Message, Problem } from "./model";
import { encounterKey } from "./learner";
import { segmentSummary } from "../scripts/lib/question-segments.mjs";

/** One part of a long question: one conversation. */
export interface QuestionSegment {
  goal: string;
  /** Zero-based indexes into the problem's rubric; each belongs to one segment. */
  rubricItems: number[];
  /** scopeDefinitions facet ids this part exercises. */
  facets: string[];
  estimatedSolveSeconds: number;
}
/** One conversation that worked a segment of the thread. */
interface ThreadVisit {
  /** `encounterKey` of the terminal: `${runId}/${encounterId}`. */
  encounter: string;
  runId: string;
  segment: number;
  at: number;
  completed?: boolean;
  summary?: string;
}
/**
 * A learner's unfinished segmented question. It lives in study state, so it is
 * saved in the same atomic snapshot as the conversations it refers to. Only
 * saves from the retired game hold one: nothing starts a thread any more, but
 * a saved one can still be completed and assessed.
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
export function openThread(g: StudyRecord) {
  const t = g.study.thread;
  return t && !t.finishedAt ? t : undefined;
}

/** Whether `e` is the conversation allowed to complete the thread's current segment. */
export function isActiveVisit(g: StudyRecord, e: Encounter) {
  const t = openThread(g);
  return (
    !!t &&
    e.thread?.id === t.id &&
    e.thread.segment === t.segment &&
    t.active === encounterKey(e)
  );
}

/** A conversation that worked an earlier segment, or this one somewhere else. */
export function isInactiveVisit(g: StudyRecord, e: Encounter) {
  return !!e.thread && !isActiveVisit(g, e) && e.state !== "consumed";
}

/**
 * Record a completed segment and advance. Idempotent: it acts only for the
 * active visit of the current segment, and the caller runs it in the same
 * synchronous step that consumed the question, so one snapshot always holds
 * both or neither. Returns the thread when it finished.
 */
export function completeSegment(
  g: StudyRecord,
  e: Encounter,
  options: { summary?: unknown },
) {
  if (!isActiveVisit(g, e)) return undefined;
  const t = g.study.thread!;
  const key = encounterKey(e);
  const visit = t.visits
    .filter((v) => v.encounter === key && v.segment === t.segment)
    .at(-1);
  if (visit) {
    visit.completed = true;
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
  return finished;
}

/** Every conversation this thread visited that this save still holds. */
export function threadEncounters(g: StudyRecord, t: QuestionThread) {
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

interface CarriedVisit {
  segment: number;
  encounter: string;
  completed: boolean;
  messages: Message[];
}
/** Earlier visits' conversations, oldest first, for display and the tutor. */
export function carriedVisits(g: StudyRecord, e: Encounter): CarriedVisit[] {
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
export function segmentPayload(g: StudyRecord, e: Encounter) {
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
export function assessmentSegment(g: StudyRecord, e: Encounter) {
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
export function assessmentDeferred(g: StudyRecord, e: Encounter) {
  const t = openThread(g);
  return !!t && e.thread?.id === t.id;
}
