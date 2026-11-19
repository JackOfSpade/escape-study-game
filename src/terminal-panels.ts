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
import { encounterGaps, probeSummary } from "./knowledge-probe";
import { encounterKey } from "./learner";
import { markdownToHtml } from "./markdown";
import { partMarkers } from "./question-parts";
import type { Encounter, StudyRecord, Roadmap } from "./model";

/** What the question's conversation partner is called. */
const TUTOR = "Tutor";
/** Every saved reply carries this stored speaker name. */
const speakerLabel = (author: string) =>
  author === "Terminal AI" ? TUTOR : author;

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
      " · Variety practice on another topic of this tier: knowledge is probed and recorded, but this is not the scheduled visit";
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
  const conceded = encounterGaps(game, e);
  const text =
    e.state === "consumed"
      ? `${
          conceded.length
            ? `Solved with a recorded gap. Recorded for later study: ${conceded.map((r) => r.facet.description).join("; ")}.`
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
    const bubble = (kind: string, name: string, text: string) =>
      `<div class="message ${escape(kind)}"><strong>${name}</strong><div class="message-body">${markdownToHtml(text)}</div></div>`;
    const said = (m: Encounter["tutor"][number]) =>
      bubble(
        m.kind,
        escape(m.author === "human" ? "You" : speakerLabel(m.author)),
        m.text,
      );
    const done = completionMarkerIndex(e);
    const parts = partMarkers(e);
    const html =
      e.tutor
        .map(
          (m, i) =>
            (i === done ? COMPLETION_MARKER : "") +
            said(m) +
            (parts.get(m.seq) ?? ""),
        )
        .join("") +
      (done === e.tutor.length ? COMPLETION_MARKER : "") +
      (e.tutorRequests ?? [])
        .map((j) => (j.state === "pending" ? streamingReply(j) : undefined))
        .filter((text): text is string => !!text)
        .map((text) => bubble("tutor", TUTOR, text))
        .join("");
    const box = $("#messages");
    if (setHtml(box, html)) box.scrollTop = box.scrollHeight;
  }

  return { requestStatus, messages };
}
