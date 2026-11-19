/**
 * The parts of the open terminal that the study workspace shows: where the
 * question came from, the status line above the conversation, saved-request
 * status and the conversation itself.
 *
 * Each panel is rendered from the encounter it is given and only touches the
 * DOM when its content changed, because the terminal re-renders on every UI
 * tick and a rewrite would clear a selection the learner is making.
 */
import { retryTutorRequest, streamingReply } from "./ai";
import { $, setHtml } from "./dom";
import { escapeHtml as escape } from "./html";
import { encounterGaps, gapsClosedBy, probeSummary } from "./knowledge-probe";
import { encounterKey } from "./learner";
import { markdownToHtml } from "./markdown";
import {
  advancePart,
  clearedThrough,
  nextPartOffer,
  partMarkers,
} from "./question-parts";
import { settleTutorRequest } from "./run-learning";
import type { Encounter, StudyRecord, Roadmap } from "./model";

/** What the question's conversation partner is called. */
const TUTOR = "Tutor";
/** Every saved reply carries this stored speaker name. */
const speakerLabel = (author: string) =>
  author === "Terminal AI" ? TUTOR : author;

/** One chat bubble: the speaker's name as plain text and the message as
 * markdown, which markdownToHtml escapes. Shared by the question's
 * conversation and the lesson's tutor chat. */
export function messageBubble(kind: string, name: string, text: string) {
  return `<div class="message ${escape(kind)}"><strong>${escape(name)}</strong><div class="message-body">${markdownToHtml(text)}</div></div>`;
}

interface TerminalPanelHost {
  /** The current record: an import replaces it. */
  game(): StudyRecord;
  roadmap: Roadmap;
  persist(): unknown;
  /** Re-render whichever terminal is open. */
  render(): void;
  /** Save and re-render when a started request settles; show its failure. */
  settle(pending: Promise<unknown>, e: Encounter): void;
}

/** Where a terminal's question came from and how it relates to earlier work. */
export function provenanceText(game: StudyRecord, e: Encounter): string {
  let text =
    e.problem?.provenance === "claude-cli"
      ? "Claude CLI"
      : e.problem?.provenance === "chatgpt-handoff"
        ? "ChatGPT handoff · Saved provider provenance"
        : e.problem?.provenance === "study-mode"
          ? "Study bridge · Saved provider provenance"
          : !e.problem && game.study.profile === "live"
            ? "Live study request · Awaiting a validated problem"
            : "Earlier practice question · No academic credit";
  if (e.problem?.contract.practice)
    text +=
      " · Practice question: what you show here is recorded and can close a gap, but this is not a scheduled visit and gives no credit";
  if (
    game.study.learner?.attempts.some(
      (a) =>
        a.encounter === encounterKey(e) && a.status === "externally-resolved",
    )
  )
    text +=
      " · Resolved in your imported roadmap. Your original question and draft remain open; finishing it does not start another academic visit.";
  return text;
}

/** The line above a solo conversation: its outcome, or how the probe stands. */
export function dialogueStatus(game: StudyRecord, e: Encounter) {
  const probeLine = probeSummary(e);
  const recorded = encounterGaps(game, e);
  const conceded = recorded.filter((r) => !r.resolved);
  const closed = recorded.length - conceded.length;
  const text =
    e.state === "consumed"
      ? `${
          conceded.length
            ? `Solved with a recorded gap. Recorded for later study: ${conceded.map((r) => r.facet.description).join("; ")}.`
            : closed
              ? `Solved. ${closed === 1 ? "The recorded gap was" : `${closed} recorded gaps were`} closed later.`
              : "Solved."
        } You can keep discussing the question.${probeLine ? ` ${probeLine}.` : ""}`
      : probeLine
        ? `Knowledge probe · ${probeLine}. Say so if you do not know something; the gap is recorded.`
        : "Work through the question with your tutor. Your answers stay in this conversation.";
  return { hidden: e.state !== "consumed" && !probeLine, text };
}

/** How many messages precede the "question complete" marker: those up to the
 * reply that finished it, so later discussion follows the marker. Undefined
 * while the question is unfinished. */
export function completionMarkerIndex(e: Encounter): number | undefined {
  if (e.state !== "consumed") return undefined;
  const accepted = e.submissions.find((s) => s.id === e.accepted);
  if (!accepted) return e.tutor.length;
  let index = 0;
  while (index < e.tutor.length && e.tutor[index].seq < accepted.seq) index++;
  return index;
}
const COMPLETION_MARKER =
  '<div class="message-complete"><strong>✓ Question complete</strong><span>Your result is saved. You can keep discussing it here, or open the Skill map for the next question.</span></div>';

/** The notice under a reply that closed a gap recorded at this question. */
export function gapClosedMarker(
  game: StudyRecord,
  e: Encounter,
  m: Encounter["tutor"][number],
): string {
  if (m.kind !== "tutor") return "";
  const closed = gapsClosedBy(game, e, m.requestId);
  return closed.length
    ? `<div class="message-complete gap-closed"><strong>✓ Gap closed</strong><span>${escape(
        closed.map((r) => r.facet.description).join("; "),
      )}. Saved: this is no longer a study target.</span></div>`
    : "";
}

export function createTerminalPanels(host: TerminalPanelHost) {
  const { roadmap } = host;
  /** Saved questions that are waiting or were interrupted. */
  function requestStatus(e: Encounter) {
    const box = $("#tutor-request-status");
    const saved = e.tutorRequests ?? [];
    const open = saved.filter(
      (j) => j.state !== "applied" && j.state !== "superseded",
    );
    // An error that belongs to a saved request is not repeated on its own.
    const chatError =
      e.error && !saved.some((j) => j.error === e.error) ? e.error : undefined;
    box.hidden = !chatError && !open.length;
    const html =
      (chatError ? `<p>${escape(chatError)}</p>` : "") +
      open
        .map(
          (j) =>
            `<p>${
              j.state === "pending"
                ? "Waiting for a reply."
                : escape(j.error ?? "Saved question interrupted.")
            }${j.state === "interrupted" ? `<button class="quiet" data-question-retry="${escape(j.id)}">Retry saved question</button>` : ""}</p>`,
        )
        .join("");
    if (!setHtml(box, html)) return;
    for (const button of box.querySelectorAll<HTMLButtonElement>(
      "[data-question-retry]",
    ))
      button.onclick = () => {
        const id = button.dataset.questionRetry!;
        host.settle(retryTutorRequest(host.game(), e, id, roadmap), e);
        host.persist();
        host.render();
      };
  }

  /** The conversation, then a reply still arriving. */
  function messages(e: Encounter) {
    const said = (m: Encounter["tutor"][number]) =>
      messageBubble(
        m.kind,
        m.author === "human" ? "You" : speakerLabel(m.author),
        m.text,
      );
    const done = completionMarkerIndex(e);
    const parts = partMarkers(e);
    // Earlier parts' messages left the screen when their part was left.
    const cleared = clearedThrough(e) ?? -Infinity;
    const pending = (e.tutorRequests ?? []).some((j) => j.state === "pending");
    const html =
      e.tutor
        .map((m, i) =>
          m.seq <= cleared
            ? ""
            : (i === done ? COMPLETION_MARKER : "") +
              said(m) +
              gapClosedMarker(host.game(), e, m) +
              (parts.get(m.seq) ?? ""),
        )
        .join("") +
      (pending ? "" : nextPartOffer(e)) +
      (done === e.tutor.length ? COMPLETION_MARKER : "") +
      (e.tutorRequests ?? [])
        .map((j) => (j.state === "pending" ? streamingReply(j) : undefined))
        .filter((text): text is string => !!text)
        .map((text) => messageBubble("tutor", TUTOR, text))
        .join("");
    const box = $("#messages");
    if (!setHtml(box, html)) return;
    box.scrollTop = box.scrollHeight;
    const next = box.querySelector<HTMLButtonElement>("[data-next-part]");
    if (next)
      next.onclick = () => {
        if (!advancePart(e)) return;
        // A request interrupted on the part just left is not retried on the next.
        for (const job of e.tutorRequests ?? [])
          if (job.state === "interrupted")
            settleTutorRequest(job, "superseded");
        delete e.error;
        host.persist();
        host.render();
        $<HTMLTextAreaElement>("#chat-input").focus();
      };
  }

  return { requestStatus, messages };
}
