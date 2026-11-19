/**
 * A question worked one part at a time: which part is open, and how the
 * question pane and the conversation show it. The learner sees the shared
 * material with the open part only. When the tutor confirms it the
 * conversation offers a "Next part" button; pressing it puts the next part in
 * its place and clears the conversation on screen. A finished question shows
 * every part and the whole conversation.
 */
import { stagedParts } from "../scripts/lib/question-parts.mjs";
import { escapeHtml as escape } from "./html";
import { markdownToHtml } from "./markdown";
import type { Encounter } from "./model";

type Staged = Pick<Encounter, "problem" | "partsDone">;
type Open = Staged & Pick<Encounter, "state" | "partReady">;

/** The part the learner can see, 1-based, or undefined for a question that
 * is shown whole. */
export function openPart(e: Staged) {
  const parts = stagedParts(e.problem);
  if (!parts) return undefined;
  const index = Math.min(e.partsDone?.length ?? 0, parts.length - 1);
  return { part: index + 1, of: parts.length, question: parts[index] };
}

/** The last message of the part before the open one: the conversation on
 * screen starts after it. Undefined on the first part, on a question shown
 * whole and on a finished question, which shows everything. */
export function clearedThrough(e: Staged & Pick<Encounter, "state">) {
  const parts = stagedParts(e.problem);
  if (!parts || e.state === "consumed") return undefined;
  return (e.partsDone ?? []).slice(0, parts.length - 1).at(-1);
}

/** What a tutor request says about the open part. `since` separates the
 * messages of earlier parts, which the learner no longer sees, from those
 * written with this part on screen. */
export function requestStage(e: Open) {
  const open = openPart(e);
  if (!open) return undefined;
  const since = clearedThrough({ ...e, state: "in-progress" });
  return {
    ...open,
    ...(since !== undefined ? { since } : {}),
    ...(nextPartReady(e) ? { confirmed: true } : {}),
  };
}

/** Whether the tutor has confirmed the open part and a later one waits. */
export function nextPartReady(e: Open) {
  const open = openPart(e);
  return (
    e.state !== "consumed" &&
    e.partReady !== undefined &&
    !!open &&
    open.part < open.of
  );
}

/** Leave the confirmed part: the next one opens and the conversation so far
 * drops off the screen. It stays in the record. */
export function advancePart(e: Open & Pick<Encounter, "tutor">) {
  if (!nextPartReady(e)) return false;
  (e.partsDone ??= []).push(e.tutor.at(-1)?.seq ?? e.partReady!);
  delete e.partReady;
  return true;
}

/** The offer that ends the conversation once the open part is confirmed. */
export function nextPartOffer(e: Open): string {
  const open = openPart(e);
  if (!open || !nextPartReady(e)) return "";
  return `<div class="message-complete message-part next-part"><strong>✓ Part ${open.part} of ${open.of} answered</strong><span>Ask anything more about it here, or move on. The conversation clears for the next part.</span><button type="button" data-next-part>Next part</button></div>`;
}

const partHtml = (
  text: string,
  number: number,
  of: number,
  kind: "question-part" | "question-part-done",
) =>
  `<section class="${kind}" data-part="${number}"><span class="eyebrow part-label">Part ${number} of ${of}</span>${markdownToHtml(text)}</section>`;

/** The question pane for a question that has its text. */
export function questionHtml(e: Staged & Pick<Encounter, "state">): string {
  const problem = e.problem;
  if (!problem) return "";
  const parts = stagedParts(problem);
  const open = openPart(e);
  if (!parts || !open) return markdownToHtml(problem.prompt);
  const shared = markdownToHtml(problem.staged!.shared);
  const of = parts.length;
  if (e.state === "consumed")
    return (
      shared +
      parts
        .map((text, i) => partHtml(text, i + 1, of, "question-part-done"))
        .join("")
    );
  const earlier = parts.slice(0, open.part - 1);
  return (
    shared +
    partHtml(open.question, open.part, of, "question-part") +
    (earlier.length
      ? `<details class="earlier-parts"><summary>Earlier part${earlier.length === 1 ? "" : "s"}</summary>${earlier
          .map((text, i) => partHtml(text, i + 1, of, "question-part-done"))
          .join("")}</details>`
      : "")
  );
}

/** The line that follows the last message of each finished part, keyed by
 * that message's sequence number. */
export function partMarkers(e: Staged): Map<number, string> {
  const markers = new Map<number, string>();
  const of = stagedParts(e.problem)?.length;
  if (!of) return markers;
  (e.partsDone ?? [])
    .slice(0, of - 1)
    .forEach((seq, i) =>
      markers.set(
        seq,
        `<div class="message-complete message-part"><strong>✓ Part ${i + 1} of ${of} answered</strong><span>${escape(
          `Part ${i + 2} follows.`,
        )}</span></div>`,
      ),
    );
  return markers;
}
