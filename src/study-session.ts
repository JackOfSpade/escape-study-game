/**
 * The study workspace's own controls: its status line, its save indicator and
 * the buttons that start, retry, re-review and regenerate a question. The
 * terminal that shows the question stays with the application shell, which
 * this reaches through a small host.
 */
import { assess, canRegenerate, checkBridge, regenerateQuestion } from "./ai";
import { $, setText } from "./dom";
import { encounterKey } from "./learner";
import type { Encounter, StudyRecord, Roadmap } from "./model";
import {
  nextWorkspaceQuestion,
  workspaceAssessment,
  workspaceQuestion,
  workspaceSelectedQuestion,
} from "./study-workspace";
import { createStudyWorkspaceView } from "./study-workspace-view";

interface StudySessionHost {
  /** The current record: an import replaces it. */
  game(): StudyRecord;
  roadmap: Roadmap;
  /** Saves the record; false when the save failed. */
  persist(): Promise<boolean>;
  /** The last save failure, or "" when the last save worked. */
  saveError(): string;
  /** Whether a question is open in the terminal. */
  terminalOpen(): boolean;
  /** The question the workspace is showing or preparing. */
  displayedQuestion(): Encounter | undefined;
  /** Record this as the learner's latest question. */
  rememberQuestion(e: Encounter): void;
  /** Open this question in the workspace's terminal. */
  openTerminal(e: Encounter): void;
  /** Ask for this question's problem, joining a request already under way. */
  prepareQuestion(e: Encounter): Promise<void>;
  /** Retry whatever the latest question was waiting for. */
  resumeQuestions(): void;
  log(type: string, data?: unknown): void;
}

export function installStudySession(host: StudySessionHost) {
  const { roadmap } = host;
  let starting = false,
    saving = false,
    saveGeneration = 0,
    /** The status line only clears a message it wrote itself. */
    statusShown = false;

  const view = createStudyWorkspaceView($("#study-workspace"), roadmap, () => ({
    game: host.game(),
    starting,
    saving,
    saveError: host.saveError(),
    terminalOpen: host.terminalOpen(),
  }));

  function renderWorkspace() {
    view.render();
    const game = host.game();
    // Offered beside the skill map, for the question that is waiting there.
    const waiting = workspaceQuestion(game);
    $("#study-regenerate").hidden = !(
      !starting &&
      waiting &&
      canRegenerate(game, waiting)
    );
  }

  /** What the study view says about the question being prepared. It only clears
   * a message it wrote itself, so other notices on the line are left alone. */
  function renderStatus() {
    if (!host.game().studyWorkspace?.enabled) {
      statusShown = false;
      return;
    }
    const e = host.displayedQuestion();
    const failed = !!e && !e.generation && (!!e.error || !!e.pendingGeneration);
    const text = !e
      ? ""
      : e.generation
        ? "Preparing your next study question…"
        : failed
          ? (e.error ?? "Preparation was interrupted. Retry the saved request.")
          : "";
    $("#study-question-retry").hidden = !failed;
    if (text) {
      setText("#study-message", text);
      statusShown = true;
    } else if (statusShown) {
      setText("#study-message", "");
      statusShown = false;
    }
  }

  function render() {
    renderWorkspace();
    renderStatus();
  }

  /** Save, showing the workspace's saving indicator until the newest save ends. */
  async function save() {
    const generation = ++saveGeneration;
    const savedGame = host.game();
    if (savedGame.studyWorkspace?.enabled) {
      saving = true;
      renderWorkspace();
    }
    await host.persist();
    if (generation !== saveGeneration || host.game() !== savedGame) return;
    saving = false;
    if (savedGame.studyWorkspace?.enabled) renderWorkspace();
  }

  /** A question's preparation moved on: show it and keep it. */
  function questionChanged() {
    renderStatus();
    void save();
  }

  $("#study-question-retry").onclick = () => {
    const e = host.displayedQuestion();
    if (!e) return;
    void checkBridge().then(() => {
      host.resumeQuestions();
      void host.prepareQuestion(e);
    });
  };
  $("#study-save-retry").onclick = () => void save();
  $("#study-next").onclick = async () => {
    if (starting) return;
    const game = host.game();
    // Reopen an unfinished question rather than starting another.
    const unfinished = workspaceQuestion(game);
    if (unfinished && !host.terminalOpen()) {
      host.openTerminal(unfinished);
      render();
      return;
    }
    starting = true;
    setText("#study-message", "");
    statusShown = false;
    try {
      const e = nextWorkspaceQuestion(game, roadmap);
      game.studyWorkspace!.encounter = encounterKey(e);
      host.rememberQuestion(e);
      host.openTerminal(e);
      await host.prepareQuestion(e);
    } catch (error) {
      setText("#study-message", String(error));
    } finally {
      starting = false;
      render();
      void host.persist();
    }
  };
  $("#study-review-retry").onclick = async () => {
    const game = host.game();
    const a = workspaceAssessment(game);
    const e = workspaceSelectedQuestion(game);
    if (!a || !e) return;
    await assess(game, e, roadmap, a.evidenceCutoffSequence, true);
    questionChanged();
  };
  $("#study-regenerate").onclick = () => {
    const game = host.game();
    const e = workspaceQuestion(game);
    if (!e || starting || !canRegenerate(game, e)) return;
    if (
      e.tutor.some((m) => m.kind === "human") &&
      !confirm(
        "Write a new question on this topic? This question and your conversation are discarded. Your skill map does not change.",
      )
    )
      return;
    const title = e.problem?.title;
    if (!regenerateQuestion(game, e, roadmap)) return;
    host.log("question-regenerated", { encounter: e.id, title });
    // The new question opens as it is written, as a started one does.
    host.openTerminal(e);
    render();
    void host.prepareQuestion(e).finally(() => {
      renderWorkspace();
      void host.persist();
    });
    void host.persist();
  };

  return { render, renderWorkspace, renderStatus, save, questionChanged };
}
