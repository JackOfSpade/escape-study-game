/**
 * What the study flow reports to diagnostics: that a reply, a completion, a
 * grading or a save copy settled, and how. Identifiers, states and counts
 * only; never the learner's words or the question's text.
 */
type Listener = (type: string, data: Record<string, unknown>) => void;
let listener: Listener | undefined;
export function watchStudyEvents(next: Listener | undefined) {
  listener = next;
}
/** A failing listener must never disturb the learning flow it observes. */
export function studyEvent(type: string, data: Record<string, unknown>) {
  try {
    listener?.(type, data);
  } catch {}
}
/** An error message short enough for a diagnostic entry. */
export const briefError = (error: unknown) => String(error).slice(0, 300);
