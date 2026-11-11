import { isRecord } from "./is-record.mjs";

/**
 * Segmented study questions. A question longer than about 1.5 segments is
 * planned at generation time as ordered segments of about ten minutes; each
 * terminal visit works one segment and earns one key. See
 * docs/QUESTION_DESIGN.md ("Segmented questions") for the evidence behind
 * these numbers.
 */
export const SEGMENT_POLICY = Object.freeze({
  targetSeconds: 600,
  minSeconds: 360,
  maxSeconds: 900,
  /** A question estimated at or below this stays one segment. */
  splitAboveSeconds: 900,
  maxWholeSeconds: 3600,
  minSegments: 2,
  maxSegments: 6,
  /** Suggested per-segment targets for depths 1-4. */
  depthTargets: Object.freeze([420, 600, 780, 840]),
  maxGoalLength: 600,
  maxSummaryLength: 1200,
});

export const SEGMENT_GENERATION_GUIDANCE =
  "Include estimatedSolveSeconds for the whole question, a finite number from 30 to 3600: typical prepared learner time including reading, reasoning, expected tutoring exchanges and any coding/testing, excluding network/model queue waiting. This is game pacing metadata, not a grade, mastery claim, door HP or instruction to change difficulty. " +
  "A question estimated at 900 seconds or less stays whole: omit segments. A longer question must include segments, an ordered array of 2 to 6 parts the learner works one per terminal visit, with a walk between visits as the break: [{goal,rubricItems,facets,estimatedSolveSeconds}]. " +
  "goal is one player-facing sentence naming the sub-goal of that part. rubricItems lists zero-based indexes into rubric; every rubric index belongs to exactly one segment. facets lists the scopeDefinitions facet ids that part exercises. estimatedSolveSeconds is that part's own time, 360 to 900 seconds, aiming near 420 at depth 1, 600 at depth 2 and 780-840 at depths 3-4; the parts add up to the whole estimate. " +
  "Place each boundary where a natural sub-goal is complete, never mid-thought or on a timer. The first part must be substantive, not a warm-up. Do not split a question merely to reach a count; do not inflate a question to make it longer. The prompt still states the whole question; segments only order the work.";

export const SEGMENT_TUTOR_GUIDANCE =
  "When payload.segment is present the question is split into parts worked one per terminal visit. Work only toward payload.segment.goal and its rubric; do not ask for later parts and do not re-ask earlier parts, whose summaries are in payload.segment.earlier. payload.segment.carriedConversation holds this part's conversation from an earlier terminal visit; continue it rather than starting over. complete:true means the current part is done (the game grants a key and the learner continues the next part at the next terminal); it never requires the whole question. With complete:true, include segmentSummary: at most 1200 characters stating what the learner established and what remained open in this part, for the next part's tutor. Never mention keys or timing as pressure.";

const integer = (n) => Number.isSafeInteger(n);
const estimate = (n, min, max) =>
  typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;

/** Throw a precise reason when a generated problem's segment plan is invalid.
 * A question without segments must stay within one segment's length. */
export function validateQuestionSegments(problem) {
  const fail = (note) => {
    throw Error(note);
  };
  if (!isRecord(problem)) fail("Problem must be an object");
  const p = SEGMENT_POLICY;
  const whole = problem.estimatedSolveSeconds;
  const segments = problem.segments;
  if (segments === undefined) {
    if (whole !== undefined && !estimate(whole, 30, p.splitAboveSeconds))
      fail(
        `estimatedSolveSeconds above ${p.splitAboveSeconds} requires segments; a whole question is 30 to ${p.splitAboveSeconds} seconds`,
      );
    return;
  }
  if (!estimate(whole, p.splitAboveSeconds + 1, p.maxWholeSeconds))
    fail(
      `A segmented question needs estimatedSolveSeconds above ${p.splitAboveSeconds} and at most ${p.maxWholeSeconds}; shorter questions stay whole`,
    );
  if (
    !Array.isArray(segments) ||
    segments.length < p.minSegments ||
    segments.length > p.maxSegments
  )
    fail(`segments must be an array of ${p.minSegments} to ${p.maxSegments}`);
  const rubric = Array.isArray(problem.rubric) ? problem.rubric : [];
  const facetIds = new Set(
    (Array.isArray(problem.scopeDefinitions) ? problem.scopeDefinitions : [])
      .flatMap((d) => (isRecord(d) && Array.isArray(d.facets) ? d.facets : []))
      .map((f) => (isRecord(f) ? f.id : undefined))
      .filter((id) => typeof id === "string"),
  );
  const covered = new Map();
  const goals = new Set();
  let sum = 0;
  segments.forEach((s, index) => {
    const at = `segments[${index}]`;
    if (!isRecord(s)) fail(`${at} must be an object`);
    if (
      typeof s.goal !== "string" ||
      !s.goal.trim() ||
      s.goal.length > p.maxGoalLength
    )
      fail(
        `${at}.goal must be a nonempty sentence of at most ${p.maxGoalLength} characters`,
      );
    const goal = s.goal.trim().toLowerCase();
    if (goals.has(goal)) fail(`${at}.goal repeats an earlier segment`);
    goals.add(goal);
    if (!Array.isArray(s.rubricItems) || !s.rubricItems.length)
      fail(`${at}.rubricItems must list at least one rubric index`);
    for (const item of s.rubricItems) {
      if (!integer(item) || item < 0 || item >= rubric.length)
        fail(`${at}.rubricItems has an index outside the rubric`);
      if (covered.has(item))
        fail(`rubric item ${item} belongs to more than one segment`);
      covered.set(item, index);
    }
    if (
      !Array.isArray(s.facets) ||
      !s.facets.length ||
      !s.facets.every((f) => typeof f === "string" && facetIds.has(f))
    )
      fail(`${at}.facets must list scopeDefinitions facet ids`);
    if (!estimate(s.estimatedSolveSeconds, p.minSeconds, p.maxSeconds))
      fail(
        `${at}.estimatedSolveSeconds must be ${p.minSeconds} to ${p.maxSeconds}`,
      );
    sum += s.estimatedSolveSeconds;
  });
  if (covered.size !== rubric.length)
    fail("Every rubric item must belong to exactly one segment");
  if (sum < whole * 0.75 || sum > whole * 1.25)
    fail(
      "Segment estimates must add up to the whole estimatedSolveSeconds (within 25%)",
    );
}

/** A bounded segment summary from a tutor reply, or undefined. */
export function segmentSummary(value) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, SEGMENT_POLICY.maxSummaryLength)
    : undefined;
}
