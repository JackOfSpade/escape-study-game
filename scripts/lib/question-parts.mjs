import { isRecord as object } from "./is-record.mjs";

/**
 * A question worked one part at a time. Generation returns the shared
 * material as `prompt` and each ask as an entry of `parts`; the learner sees
 * the shared material with one part. Once the tutor confirms it
 * (`partComplete`) the learner is offered the next part, which replaces it
 * when they ask for it. It stays one question: one conversation, one
 * completion and one assessment.
 */
export const MAX_PARTS = 5;
/** What a newly generated question may have; stored questions keep MAX_PARTS. */
export const MAX_GENERATED_PARTS = 3;
const MAX_PART_CHARS = 6000;

export const PARTS_GENERATION_GUIDANCE = `One part at a time: the learner works a question one ask at a time, so also return parts, an array of 1 to ${MAX_GENERATED_PARTS} strings, usually one, and keep prompt for the shared material only. Wherever these instructions say the question or the prompt must supply or show something, that means prompt and the part on screen read together. prompt holds the scenario, code, data, interfaces and fixed facts that two or more parts need, or all of the material when there is one part, and asks nothing itself: no numbered questions and no 'answer the following'. Each entry of parts is one complete ask, in the order to be worked, worded as it should appear on screen and without a number or a 'Part' label, which the app adds. The learner first sees prompt with parts[0] only; each later part replaces the one before it after the tutor confirms that one, and prompt stays on screen throughout. So every part must be answerable from prompt and its own text: a fact two or more parts need goes in prompt; a fact only one part needs goes in that part's own text, so the learner does not read material up front that the open part never uses; a fact a later part needs must never appear only in an earlier part. A later part may build on what an earlier part concluded but must not depend on its exact wording. prompt and each part must not give away the answer to that part or to a later one. Split by distinct ask: a follow-up that tests something the main question does not is a separate part, while several items worked the same way stay together in one part. A question with a single ask has one part, and a part is never added to pad.`;

export const PARTS_TUTOR_GUIDANCE =
  "One part at a time (whenever payload.stage is present): the learner is shown this question in parts. They see problem.staged.shared and only part payload.stage.part of payload.stage.of, whose text is payload.stage.question; earlier parts are finished and later parts are hidden from them. Work only on the current part: judge the answers against what this part asks, and never mention, quote, preview or ask about a later part, or ask for anything that only a later part asks. Add partComplete (true or false) to every reply. Return partComplete:true with complete:false when everything this part asks has been answered and accepted, or when the learner says they do not know what remains of it or wants to move on from it (then record each facet they gave up as a gap in knowledge.facets). In that reply text confirms in one or two sentences what was accepted, and what was left open if anything was; it asks no question and does not introduce the next part, because the app then shows the learner a button that opens the next part. Until they press it the same part stays open and payload.stage.confirmed is true: the learner may ask more about this part, so answer what they ask, keep partComplete:true and still do not introduce the next part. When they press it the app shows the next part and clears the conversation from their screen. payload.stage.since, when present, is the seq of the last message before the current part opened: messages up to that seq belong to earlier parts and the learner can no longer see them, while later messages were written with the current part on screen. The learner usually answers a new part straight away without restating it, so read every learner message after payload.stage.since as an answer to payload.stage.question, never as a late answer to an earlier part, and never ask them to repeat or paste the question. Do not refer to an earlier message as if it were still visible; restate what you need from it. Otherwise return partComplete:false and follow up on this part only. While payload.stage.part is less than payload.stage.of never return complete:true: the app rejects it, because the learner has not seen the remaining parts. On the last part partComplete stays false and complete:true finishes the whole question as usual, judged over every part.";

/** Why `parts` on a generated problem is malformed, or undefined when it is
 * absent (a question shown whole) or well formed. */
export function partsProblem(parts, max = MAX_PARTS) {
  if (parts === undefined) return undefined;
  if (
    !Array.isArray(parts) ||
    !parts.length ||
    parts.length > max ||
    !parts.every(
      (part) =>
        typeof part === "string" &&
        part.trim() &&
        part.length <= MAX_PART_CHARS,
    )
  )
    return `parts must be an array of 1 to ${max} nonempty strings, one per ask`;
  return undefined;
}

/** The whole question as one text: what every reader other than the staged
 * display uses (assessment, history, reports). */
export function composePrompt(shared, parts) {
  const material = shared.trim();
  const asks =
    parts.length === 1
      ? [parts[0].trim()]
      : parts.map(
          (part, i) => `**Part ${i + 1} of ${parts.length}**\n\n${part.trim()}`,
        );
  return [material, ...asks].filter(Boolean).join("\n\n");
}

/** The parts of a stored problem that is worked one part at a time. */
export function stagedParts(problem) {
  const staged = object(problem) ? problem.staged : undefined;
  if (
    !object(staged) ||
    typeof staged.shared !== "string" ||
    !Array.isArray(staged.parts) ||
    staged.parts.length < 2 ||
    !staged.parts.every((part) => typeof part === "string")
  )
    return undefined;
  return staged.parts;
}

/** The request's own account of which part is open: {part, of}, 1-based. */
function requestStage(payload) {
  const stage = object(payload) ? payload.stage : undefined;
  if (
    !object(stage) ||
    !Number.isInteger(stage.part) ||
    !Number.isInteger(stage.of) ||
    stage.part < 1 ||
    stage.part > stage.of
  )
    return undefined;
  return stage;
}

/** Whether this reply closes the request's current part and opens the next. */
export function closesPart(payload, answer) {
  const stage = requestStage(payload);
  return (
    !!stage &&
    stage.part < stage.of &&
    answer.partComplete === true &&
    answer.complete !== true
  );
}

/** Why a tutor reply breaks the one-part-at-a-time rule, or undefined. */
export function partReplyProblem(payload, answer) {
  const stage = requestStage(payload);
  if (!stage) return undefined;
  if (
    answer.partComplete !== undefined &&
    typeof answer.partComplete !== "boolean"
  )
    return "partComplete must be true or false";
  if (answer.complete === true && stage.part < stage.of)
    return `The learner has only seen part ${stage.part} of ${stage.of}, so the question cannot be complete yet. To leave this part, whether it is answered or the learner wants to move on, return complete:false with partComplete:true and no outcome, and record any facet they gave up as a gap in knowledge.facets.`;
  return undefined;
}
