/**
 * A question worked one part at a time: which part is open, and how the
 * question pane and the conversation show it. The learner sees the shared
 * material with the open part only; the next part takes its place when the
 * tutor confirms the open one. A finished question shows every part.
 */
import { stagedParts } from "../scripts/lib/question-parts.mjs";
import { escapeHtml as escape } from "./html";
import { markdownToHtml } from "./markdown";
import type { Encounter } from "./model";

type Staged = Pick<Encounter, "problem" | "partsDone">;

/** The part the learner can see, 1-based, or undefined for a question that
 * is shown whole. */
export function openPart(e: Staged) {
  const parts = stagedParts(e.problem);
  if (!parts) return undefined;
  const index = Math.min(e.partsDone?.length ?? 0, parts.length - 1);
  return { part: index + 1, of: parts.length, question: parts[index] };
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

/** The line that follows the tutor message which closed a part, keyed by that
 * message's sequence number. */
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
          `The question now shows part ${i + 2}.`,
        )}</span></div>`,
      ),
    );
  return markers;
}
