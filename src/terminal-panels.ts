/**
 * The parts of the open terminal that the study workspace shows: where the
 * question came from, the status line above the conversation, saved-request
 * status and the conversation itself.
 *
 * Each panel is rendered from the encounter it is given and only touches the
 * DOM when its content changed, because the terminal re-renders on every UI
 * tick and a rewrite would clear a selection the learner is making.
 */
import { retryGroupRequest, retryTutorRequest, streamingReply } from "./ai";
import { $, setHtml } from "./dom";
import { escapeHtml as escape } from "./html";
import { encounterGaps, probeSummary } from "./knowledge-probe";
import { encounterKey } from "./learner";
import { markdownToHtml } from "./markdown";
import type { Encounter, Game, Roadmap } from "./model";
import {
  carriedVisits,
  isInactiveVisit,
  segmentCount,
} from "./question-thread";
import { unfinishedEarlierVisits } from "./room-questions";

type Channel = "tutor" | "group";

/** What the question's conversation partner is called. */
const TUTOR = "Tutor";
/** Replies saved by the archived game carry its speaker name. */
const speakerLabel = (author: string) =>
  author === "Terminal AI" ? TUTOR : author;

interface TerminalPanelHost {
  /** The current game: a restart or an import replaces it. */
  game(): Game;
  roadmap: Roadmap;
  persist(): unknown;
  /** Re-render whichever terminal is open. */
  render(): void;
  /** Save and re-render when a started request settles; show its failure. */
  settle(pending: Promise<unknown>, e: Encounter): void;
}

/** Where a terminal's question came from and how it relates to earlier work. */
export function provenanceText(game: Game, e: Encounter): string {
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
  if (e.thread && e.problem) {
    const count = segmentCount(e.problem);
    const goal = e.problem.segments?.[e.thread.segment]?.goal;
    text += isInactiveVisit(game, e)
      ? " · This question continues at the terminal you opened most recently; this one is read-only history."
      : count > 1
        ? ` · Part ${e.thread.segment + 1} of ${count}${goal ? `: ${goal.replace(/[.!?]+$/, "")}` : ""}. Finishing this part earns a key; the next terminal continues the question.`
        : carriedVisits(game, e).length
          ? " · Continued question: your earlier conversation and progress are kept."
          : "";
  }
  const earlier = unfinishedEarlierVisits(game, e);
  if (earlier.runs)
    text += ` · Started in ${earlier.runs === 1 ? "an earlier run" : `${earlier.runs} earlier runs`} but not completed there, so it is asked again: a new run never inherits an unfinished lock. ${
      earlier.established
        ? `${earlier.established} facet${earlier.established === 1 ? "" : "s"} you established then ${earlier.established === 1 ? "is" : "are"} carried over and will not be re-asked.`
        : "Nothing was established before that conversation stopped."
    }`;
  if (
    game.study.learner?.attempts.some(
      (a) =>
        a.encounter === encounterKey(e) && a.status === "externally-resolved",
    )
  )
    text +=
      " · Resolved in your imported roadmap. Your original puzzle and draft remain playable; finishing grants gameplay rewards without another academic visit.";
  return text;
}

/** The line above a solo conversation: its outcome, or how the probe stands. */
export function dialogueStatus(game: Game, e: Encounter) {
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

export function createTerminalPanels(host: TerminalPanelHost) {
  const { roadmap } = host;
  const speaker = (game: Game, author: string) =>
    game.survivors.find((a) => a.id === author)?.name;

  /** Saved private or group questions that are waiting or were interrupted. */
  function requestStatus(e: Encounter, tab: Channel) {
    const box = $("#tutor-request-status");
    const saved = (tab === "tutor" ? e.tutorRequests : e.groupRequests) ?? [];
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
            }${j.state === "interrupted" ? `<button class="quiet" data-question-retry="${escape(j.id)}" data-channel="${tab}">Retry saved ${tab === "tutor" ? "private" : "group"} question</button>` : ""}</p>`,
        )
        .join("");
    if (!setHtml(box, html)) return;
    for (const button of box.querySelectorAll<HTMLButtonElement>(
      "[data-question-retry]",
    ))
      button.onclick = () => {
        const id = button.dataset.questionRetry!;
        host.settle(
          button.dataset.channel === "tutor"
            ? retryTutorRequest(host.game(), e, id, roadmap)
            : retryGroupRequest(host.game(), e, id),
          e,
        );
        host.persist();
        host.render();
      };
  }

  /** The conversation: earlier visits, this visit, then a reply still arriving. */
  function messages(e: Encounter, tab: Channel) {
    const game = host.game();
    const bubble = (
      kind: string,
      name: string,
      text: string,
      carried = false,
    ) =>
      `<div class="message ${escape(kind)}${carried ? " carried" : ""}"><strong>${name}</strong><div class="message-body">${markdownToHtml(text)}</div></div>`;
    const said = (m: Encounter["tutor"][number], carried = false) =>
      bubble(
        m.kind,
        escape(speaker(game, m.author) ?? speakerLabel(m.author)),
        m.text,
        carried,
      );
    const html =
      (tab === "tutor" ? carriedVisits(game, e) : [])
        .map(
          (v) =>
            `<div class="message system carried"><strong>Earlier visit · part ${v.segment + 1}${v.completed ? " · completed" : ""}</strong></div>` +
            v.messages.map((m) => said(m, true)).join(""),
        )
        .join("") +
      e[tab].map((m) => said(m)).join("") +
      (tab === "tutor"
        ? (e.tutorRequests ?? [])
            .map((j) => (j.state === "pending" ? streamingReply(j) : undefined))
            .filter((text): text is string => !!text)
            .map((text) => bubble("tutor", TUTOR, text))
            .join("")
        : "");
    const box = $("#messages");
    if (setHtml(box, html)) box.scrollTop = box.scrollHeight;
  }

  return { requestStatus, messages };
}
