import {
  checkBridge,
  edit,
  ensureProblem,
  generatingEncounter,
  generationProgress,
  offeredHelp,
  presentMessages,
  presentProblem,
  releaseRetiredChatRequests,
  retrySubmission,
  send,
  status,
  submit,
  watchStreamingReplies,
} from "./ai";
import { mountBugReport } from "./bug-report";
import {
  activateCareerFocus,
  careerProfileSummary,
  type CareerFocus,
} from "./career-profile";
import { connectionSteps } from "./connection-steps";
import { initialStudy, syncLearningView } from "./curriculum";
import { displayScale } from "./display-scale";
import { $, setHtml, setNodeText, setText } from "./dom";
import { canRunWorkspace, runWorkspace } from "./execution";
import { executionText } from "./execution-presentation";
import studyShell from "./study-shell.html?raw";
import { escapeHtml as escape } from "./html";
import { createInspector } from "./inspector-panel";
import { encounterKey } from "./learner";
import { moveToLiveStudy } from "./live-study";
import { markdownToHtml } from "./markdown";
import type { Encounter, StudyRecord, Roadmap } from "./model";
import {
  decode,
  download,
  encode,
  exportRecoveryBackup,
  load,
  recover,
  rejectedCopy,
  save,
} from "./persistence";
import { LOG_KEY, RunLogs } from "./run-logs";
import { readDurable, writeDurable } from "./storage";
import { installStudySession } from "./study-session";
import {
  enterStudyWorkspace,
  workspaceQuestion,
  workspaceSelectedQuestion,
} from "./study-workspace";
import "./style.css";
import "./study-workspace.css";
import {
  createTerminalPanels,
  dialogueStatus,
  provenanceText,
} from "./terminal-panels";
import { settleRequest } from "./terminal-request";
import { submissionView } from "./terminal-view";
import { emptyRecord } from "./record";

const app = $("#app");
const roadmap: Roadmap = await fetch("/curriculum.json").then((r) => r.json());
let game: StudyRecord,
  saveError = "",
  saveRecoveryError = "",
  /** The encounter open in the terminal, if any. */
  active: string | undefined,
  lastUI = 0,
  editorRevision = 0,
  /** The learner's latest question, open or still being prepared. */
  lastQuestion: string | undefined;
try {
  const saved = await load();
  game = recover(saved ?? newSave());
} catch (err) {
  game = newSave();
  saveRecoveryError = `Saved progress could not be loaded: ${String(err)}. Existing checkpoints have been protected. Retry loading, or export recovery data before restoring a backup.`;
  saveError = saveRecoveryError;
}
/** The save is one record holding the learning state, its questions and the
 * settings. A first visit starts from an empty one. */
function newSave() {
  const study = initialStudy(roadmap, "live");
  activateRunFocus(study);
  return emptyRecord(study);
}
/** Apply the saved role profile, or the default one, to a study state. */
function activateRunFocus(study: StudyRecord["study"]) {
  activateCareerFocus(
    roadmap,
    study,
    study.careerFocus ?? study.learner?.careerFocus ?? "product-feature-owner",
  );
}
moveToLiveStudy(game, roadmap);
activateRunFocus(game.study);
function latestStudyEncounter(g: StudyRecord): string | undefined {
  const saved = g.lastStudyEncounter && g.encounters[g.lastStudyEncounter];
  if (
    saved &&
    (saved.problem || saved.pendingGeneration || saved.generation) &&
    saved.state !== "consumed"
  )
    return saved.id;
  return Object.values(g.encounters)
    .filter(
      (e) =>
        e.problem &&
        e.state !== "consumed" &&
        e.problemPresentedSequence !== undefined,
    )
    .sort(
      (a, b) =>
        (b.problemPresentedSequence ?? -1) - (a.problemPresentedSequence ?? -1),
    )[0]?.id;
}
lastQuestion = latestStudyEncounter(game);
const runLogs = new RunLogs({
  read: () => readDurable(LOG_KEY),
  write: (value) => writeDurable(LOG_KEY, value),
});
await runLogs.load();
await checkBridge();
app.innerHTML = studyShell;
// One stored copy was refused while the other loaded. The first save replaces
// it, so its bytes are offered for download while they are still in memory.
const refusedCopy = rejectedCopy();
if (refusedCopy) {
  const notice = $("#study-load-notice");
  notice.hidden = false;
  $("#study-load-notice-save").onclick = () =>
    download(
      "learning-workspace-rejected-save.json",
      JSON.stringify(
        { format: "dead-air-rejected-copy-v1", ...refusedCopy },
        null,
        2,
      ),
    );
  $("#study-load-notice-dismiss").onclick = () => {
    notice.hidden = true;
  };
}
const editor = $<HTMLTextAreaElement>("#workspace");
syncDisplayScale();

// ---- Saving ----------------------------------------------------------------

let saveToken = 0;
async function persist() {
  // A placeholder record must never overwrite a checkpoint that failed to load
  // or recover. Only a validated, explicitly imported backup releases this guard.
  if (saveRecoveryError) return false;
  const token = ++saveToken;
  try {
    await save(game);
    if (token === saveToken) saveError = "";
    return true;
  } catch (err) {
    if (token === saveToken)
      saveError = `Save failed: ${String(err)}. Your result is still in this tab. Retry saving before leaving.`;
    return false;
  }
}
async function persistOrThrow(context = "Local save failed") {
  if (!(await persist())) throw Error(saveError || context);
}

// ---- The learner's question ------------------------------------------------

/** The question being prepared for the learner, if any. */
function pendingQuestion() {
  const last = lastQuestion && game.encounters[lastQuestion];
  return last &&
    last.state !== "consumed" &&
    (last.pendingGeneration || last.generation)
    ? last
    : undefined;
}
function displayedQuestion() {
  return game.studyWorkspace?.enabled
    ? (workspaceQuestion(game) ?? workspaceSelectedQuestion(game))
    : (pendingQuestion() ??
        (lastQuestion ? game.encounters[lastQuestion] : undefined));
}
function resumeQuestions() {
  releaseRetiredChatRequests(game);
  const e = lastQuestion ? game.encounters[lastQuestion] : undefined;
  if (
    e &&
    e.state !== "consumed" &&
    // A question that never reached Claude (connection down) also retries.
    (e.problem || e.pendingGeneration || e.error) &&
    !e.generation
  )
    void prepareQuestion(e);
}
const questionPreparations = new WeakMap<Encounter, Promise<void>>();
/** Preserve the requested generation through a reload and join repeated
 * retries before opening its resulting question in the terminal. */
function prepareQuestion(e: Encounter): Promise<void> {
  const pending = questionPreparations.get(e);
  if (pending) return pending;
  const requestGame = game;
  const operation = (async () => {
    try {
      const generated = ensureProblem(requestGame, e, roadmap);
      studySession.questionChanged();
      await generated;
      if (game !== requestGame || game.encounters[e.id] !== e) return;
      if (e.problem) showTerminal(e);
      else {
        studySession.questionChanged();
        // A request that failed may mean Claude went away; the terminal shows the steps.
        if (active === e.id) await recheckConnection();
      }
    } catch (error) {
      if (game !== requestGame) return;
      e.error = String(error);
      studySession.questionChanged();
    }
  })();
  questionPreparations.set(e, operation);
  void operation.finally(() => questionPreparations.delete(e));
  return operation;
}

// ---- Menu, settings and the inspector --------------------------------------

// Settings and agent tools are subpages of the menu dialog.
let menuPanel: string | undefined;
function panelToggle(id: string) {
  return $(id === "settings" ? "#settings-toggle" : "#curriculum-button");
}
function showMenuHome(focus?: HTMLElement) {
  for (const id of ["settings", "inspector"]) {
    $(`#${id}`).hidden = true;
    panelToggle(id).setAttribute("aria-expanded", "false");
  }
  menuPanel = undefined;
  $("#pause-home").hidden = false;
  $("#pause-panels").hidden = true;
  $("#pause-panel-header").hidden = true;
  const menu = $<HTMLDialogElement>("#pause-menu");
  delete menu.dataset.panel;
  menu.setAttribute("aria-labelledby", "pause-title");
  if (menu.open && focus) focus.focus();
}
function openPanel(id: string, focus: string) {
  if (!$<HTMLDialogElement>("#pause-menu").open) studyMenu(true);
  showMenuHome();
  menuPanel = id;
  $("#pause-home").hidden = true;
  $("#pause-panels").hidden = false;
  $("#pause-panel-header").hidden = false;
  $(`#${id}`).hidden = false;
  if (id === "settings") renderCareerControls();
  panelToggle(id).setAttribute("aria-expanded", "true");
  const menu = $<HTMLDialogElement>("#pause-menu");
  menu.dataset.panel = id;
  menu.setAttribute("aria-labelledby", `${id}-title`);
  $("#pause-panels").scrollTop = 0;
  $(focus).focus();
}
function closePanel(id: string) {
  if (menuPanel === id) showMenuHome(panelToggle(id));
}
$("#pause-back").onclick = () => {
  if (menuPanel) closePanel(menuPanel);
};
/** When the menu last closed: the Escape that closed it through the dialog's
 * own cancel event must not open it again as a keydown. */
let studyMenuClosedAt = -Infinity;
function studyMenu(open: boolean) {
  const menu = $<HTMLDialogElement>("#pause-menu");
  showMenuHome();
  if (!open) {
    if (menu.open) menu.close();
    studyMenuClosedAt = performance.now();
    return;
  }
  if (!menu.open) menu.showModal();
  $("#settings-toggle").focus();
}
$("#study-menu").onclick = () => studyMenu(true);
$("#menu-close").onclick = () => studyMenu(false);
$("#pause-menu").addEventListener("cancel", (event) => {
  event.preventDefault();
  if (menuPanel) closePanel(menuPanel);
  else studyMenu(false);
});
window.addEventListener("keydown", (ev) => {
  // Escape opens the menu; the dialog's cancel event closes it again.
  if (
    game.studyWorkspace?.enabled &&
    ev.code === "Escape" &&
    !ev.repeat &&
    !$<HTMLDialogElement>("#pause-menu").open &&
    performance.now() - studyMenuClosedAt > 200
  ) {
    ev.preventDefault();
    studyMenu(true);
  }
});
$("#save-button").onclick = async () => {
  await persist();
  game.notice =
    saveError ||
    "Run saved locally. Export a backup from Settings to move between browsers.";
  $("#pause-save-status").textContent = game.notice;
};
function renderCareerControls() {
  const profile = careerProfileSummary(roadmap, game.study);
  for (const id of ["career-focus", "settings-career-focus"])
    $<HTMLSelectElement>(`#${id}`).value = profile.focus;
  const text = `${profile.label}: ${profile.active.passed}/${profile.active.required} required depth checkpoints. Full original scope: ${profile.full.passed}/${profile.full.required}. The role profile requires ${profile.core} core PE objectives through D3; reference and optional topics do not gate advancement. Python interview fundamentals stay unchanged. Existing questions and learning evidence are preserved.`;
  setText("#career-focus-summary", text);
  setText("#settings-career-summary", text);
}
for (const id of ["career-focus", "settings-career-focus"])
  $(`#${id}`).onchange = () => {
    activateCareerFocus(
      roadmap,
      game.study,
      $<HTMLSelectElement>(`#${id}`).value as CareerFocus,
    );
    syncLearningView(game.study);
    renderCareerControls();
    void persist();
    if (!$("#inspector").hidden) renderInspector();
  };
const renderInspector = createInspector({
  game: () => game,
  roadmap,
  persist,
  persistOrThrow,
  saveError: () => saveError,
  renderCareerControls,
});
$("#curriculum-button").onclick = () => {
  openPanel("inspector", "#inspector-title");
  renderInspector();
};
$("#close-inspector").onclick = () => closePanel("inspector");
function syncDisplayScale() {
  const scale = displayScale(game.settings.displayScale),
    percent = String(Math.round(scale * 100));
  document.documentElement.style.setProperty("--display-scale", String(scale));
  $<HTMLInputElement>("#display-scale").value = percent;
  $("#display-scale-value").textContent = `${percent}%`;
  $("#display-scale").setAttribute("aria-valuetext", `${percent}%`);
}
$("#display-scale").oninput = () => {
  game.settings.displayScale = displayScale(
    Number($<HTMLInputElement>("#display-scale").value) / 100,
  );
  syncDisplayScale();
};
$("#display-scale").onchange = () => void persist();
$("#settings-toggle").onclick = () => {
  syncDisplayScale();
  if ($("#settings").hidden) openPanel("settings", "#settings-career-focus");
  else closePanel("settings");
  $("#bridge-detail").textContent = status().detail;
};
$("#settings-close").onclick = () => {
  closePanel("settings");
  void persist();
  void checkBridge().then(() => {
    if (active) renderTerminal();
  });
};
$("#reconnect").onclick = () => {
  void checkBridge().then(() => {
    $("#bridge-detail").textContent = status().detail;
    resumeQuestions();
  });
};

// ---- Backups and recovery --------------------------------------------------

$("#export").onclick = () =>
  download("learning-workspace-backup.json", encode(game));
$("#import").onchange = async () => {
  const file = $<HTMLInputElement>("#import").files?.[0];
  if (file) await restoreRunBackup(file);
};
$("#save-recovery-retry").onclick = () => window.location.reload();
$("#save-recovery-export").onclick = async () => {
  try {
    download("learning-workspace-recovery.json", await exportRecoveryBackup());
  } catch (error) {
    setText(
      "#save-recovery-status",
      `${saveRecoveryError} Export failed: ${String(error)}`,
    );
  }
};
$("#save-recovery-import").onchange = async () => {
  const file = $<HTMLInputElement>("#save-recovery-import").files?.[0];
  if (file) await restoreRunBackup(file);
};
/** Replace everything in this tab with a backup file's record. */
async function restoreRunBackup(file: File) {
  setText("#import-status", "");
  try {
    const next = recover(decode(await file.text()));
    moveToLiveStudy(next, roadmap);
    activateRunFocus(next.study);
    closeTerminal();
    game = next;
    saveRecoveryError = "";
    lastQuestion = latestStudyEncounter(game);
    resumeQuestions();
    syncDisplayScale();
    if (!(await persist())) {
      game.notice =
        "Import opened in this tab but could not be saved. Export a full run backup before leaving, then retry the import when storage works.";
      const message = `${game.notice} ${saveError}`;
      setText("#import-status", message);
      setText("#save-recovery-status", message);
    }
    showStudy();
  } catch (err) {
    game.notice = `Import rejected: ${String(err)}`;
    setText("#import-status", game.notice);
    if (saveRecoveryError)
      setText("#save-recovery-status", `${saveRecoveryError} ${game.notice}`);
  }
}

// ---- The workspace ---------------------------------------------------------

const studySession = installStudySession({
  game: () => game,
  roadmap,
  persist,
  saveError: () => saveError,
  terminalOpen: () => !!active,
  displayedQuestion,
  rememberQuestion: (e) => {
    lastQuestion = e.id;
    game.lastStudyEncounter = e.id;
  },
  openTerminal: openStudyTerminal,
  prepareQuestion,
  resumeQuestions,
  log: (type, data) => runLogs.record(game, type, data),
});
/** Show the workspace for the current record, or the recovery card while a
 * checkpoint that failed to load is still protected. */
function showStudy() {
  $("#save-recovery").hidden = !saveRecoveryError;
  if (saveRecoveryError) {
    setText("#save-recovery-status", saveRecoveryError);
    return;
  }
  closeTerminal();
  enterStudyWorkspace(game);
  const current = workspaceQuestion(game);
  if (current) {
    game.studyWorkspace!.encounter = encounterKey(current);
    lastQuestion = current.id;
  }
  $<HTMLDialogElement>("#pause-menu").close();
  $("#study-workspace").hidden = false;
  if (current) openStudyTerminal(current);
  studySession.render();
  $(workspaceQuestion(game) ? "#study-session-title" : "#study-next").focus({
    preventScroll: true,
  });
  void persist();
}
mountBugReport({
  log: (type, data) => {
    runLogs.record(game, type, data);
    void runLogs.flush();
  },
  async collect() {
    const e =
      (active ? game.encounters[active] : undefined) ??
      workspaceSelectedQuestion(game);
    const shown = (selector: string) => {
      const node = document.querySelector<HTMLElement>(selector);
      return node && !node.hidden ? (node.textContent ?? "").trim() : "";
    };
    const build = await fetch("/_app-health", {
      signal: AbortSignal.timeout(3000),
    })
      .then((r) => r.json())
      .then((health) => String(health.build).slice(0, 16))
      .catch(() => undefined);
    return {
      url: location.origin + location.pathname,
      build,
      userAgent: navigator.userAgent,
      viewport: `${innerWidth}×${innerHeight} at ${devicePixelRatio}x`,
      view: $("#study-workspace").dataset.view ?? "question",
      terminalOpen: !!active,
      connection: `${status().mode}${status().reason ? ` (${status().reason})` : ""}: ${status().detail}`,
      saveError: saveError || undefined,
      status: Object.fromEntries(
        (
          [
            ["session", "#study-message"],
            ["save", "#study-save-status"],
            ["dialogue", "#dialogue-status"],
            ["tutor request", "#tutor-request-status"],
            ["submission", "#submission-status"],
          ] as const
        )
          .map(([name, selector]) => [name, shown(selector)])
          .filter(([, value]) => value),
      ),
      question: e
        ? {
            title: e.problem?.title ?? "",
            provenance: $("#terminal-provenance").textContent ?? "",
            state: e.state,
            error: e.error,
            generation: e.generation,
            prompt: e.problem?.prompt,
            messages: e.tutor.map(({ kind, author, text }) => ({
              kind,
              author,
              text,
            })),
            requests: (e.tutorRequests ?? []).map(({ state, error }) => ({
              state,
              error,
            })),
            draft: e.chatDraft || undefined,
          }
        : undefined,
      logs: runLogs.export(),
    };
  },
});
// Error text is code-authored (a thrown message), bounded, and stays in this
// browser's diagnostics until the learner files a bug report.
const errorText = (value: unknown) =>
  String(
    value instanceof Error ? `${value.name}: ${value.message}` : value,
  ).slice(0, 300);
window.addEventListener("error", (event) => {
  runLogs.record(game, "browser-error", {
    file: event.filename.split("/").pop(),
    line: event.lineno,
    column: event.colno,
    message: errorText(event.error ?? event.message),
  });
  void runLogs.flush();
});
window.addEventListener("unhandledrejection", (event) => {
  runLogs.record(game, "unhandled-rejection", {
    message: errorText(event.reason),
  });
  void runLogs.flush();
});

// ---- The terminal: one question and its conversation -----------------------

function closeTerminal() {
  if (active) {
    const e = game.encounters[active];
    if (e) {
      e.scroll = editor.scrollTop;
      e.selection = [editor.selectionStart, editor.selectionEnd];
      e.chatOpen = false;
    }
  }
  active = undefined;
  $("#terminal").hidden = true;
  editor.blur();
  void persist();
}
/** Opens a question in the workspace's terminal. */
function openStudyTerminal(e: Encounter) {
  if (active && active !== e.id) closeTerminal();
  lastQuestion = e.id;
  game.lastStudyEncounter = e.id;
  active = e.id;
  showTerminal(e);
}
/** Without Claude a terminal cannot be used, only explain how to enable it. */
const connectionLocked = (e: Encounter) =>
  status().mode !== "claude-cli" && e.state !== "consumed";
const terminalConnectionLocked = () => {
  const e = active ? game.encounters[active] : undefined;
  return !!e && connectionLocked(e);
};
const LOCKED_CONNECTION_POLL_MS = 2500;
const OPEN_CONNECTION_POLL_MS = 15000;
let connectionCheckedAt = 0;
let connectionChecking: Promise<void> | undefined;
function recheckConnection() {
  connectionChecking ??= (async () => {
    const lockedId = terminalConnectionLocked() ? active : undefined;
    await checkBridge();
    connectionCheckedAt = performance.now();
    connectionChecking = undefined;
    const e = active ? game.encounters[active] : undefined;
    if (!e) return;
    if (lockedId === e.id && !connectionLocked(e))
      void startConnectedQuestion(e);
    renderTerminal(true);
  })();
  return connectionChecking;
}
function watchTerminalConnection() {
  if (
    performance.now() - connectionCheckedAt >=
    (terminalConnectionLocked()
      ? LOCKED_CONNECTION_POLL_MS
      : OPEN_CONNECTION_POLL_MS)
  )
    void recheckConnection();
}
/** Ownership of a saved solo question starts once Claude can serve it. */
function startConnectedQuestion(e: Encounter) {
  delete e.error;
  if (
    e.mode === "solo" &&
    !e.studyOnly &&
    e.state !== "consumed" &&
    (!e.owner || e.owner === "human")
  )
    e.owner = "human";
  return prepareQuestion(e);
}
function renderConnectionSteps() {
  const { problem, steps } = connectionSteps(status());
  setText("#terminal-connect-problem", problem);
  setHtml(
    $("#terminal-connect-steps"),
    steps
      .map(
        (step) =>
          `<li>${escape(step.text)}${step.command ? `<code>${escape(step.command)}</code>` : ""}</li>`,
      )
      .join(""),
  );
}
function showTerminal(e: Encounter) {
  if (active !== e.id) return;
  $("#terminal").hidden = false;
  renderTerminal(true);
}
const GENERATION_STEPS = [
  "Connected to Claude",
  "Claude is writing a curriculum-scoped problem",
  "Checking the problem against your roadmap",
  "Opening it in this terminal",
];
const generationSeen = new Map<string, number>();
/** Live stages and elapsed time while Claude writes this terminal's question.
 * The request is a single call, so the stages are the client's own. */
function generationHtml(e: Encounter) {
  const source = generatingEncounter(e);
  if (!source?.generation) return undefined;
  const progress = generationProgress(source);
  const phase = progress?.phase ?? "writing";
  let started = generationSeen.get(source.generation);
  if (started === undefined) {
    started = progress?.startedAt ?? Date.now();
    generationSeen.set(source.generation, started);
  }
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const current = phase === "checking" ? 2 : 1;
  const steps = GENERATION_STEPS.map((label, i) => {
    const text =
      i === 1 && phase === "joining"
        ? "Finishing the question Claude started preparing in the background"
        : label;
    const state = i < current ? "done" : i === current ? "active" : "todo";
    return `<li class="${state}">${escape(text)}</li>`;
  }).join("");
  return `<div class="generation-progress" role="status"><div class="generation-bar" aria-hidden="true"><span></span></div><ol class="generation-steps">${steps}</ol><p class="generation-elapsed">Elapsed <strong>${clock}</strong>${seconds >= 60 ? " · Still working: a validated problem can take a few minutes." : ""}</p><p class="generation-note">You can leave immediately; the request is saved.</p></div>`;
}
const terminalPanels = createTerminalPanels({
  game: () => game,
  roadmap,
  persist,
  render: () => renderTerminal(),
  settle: settleTerminalRequest,
});
watchStreamingReplies(() => renderTerminal());
function renderTerminal(force = false) {
  if (!active || $("#terminal").hidden) return;
  const e = game.encounters[active];
  // A replaced record may no longer hold the question that was open.
  if (!e) return;
  const locked = connectionLocked(e);
  $("#terminal-connect").hidden = !locked;
  $("#terminal-body").hidden = locked;
  if (locked) {
    setText("#terminal-type", "QUESTION LOCKED");
    setText("#problem-title", "Connect Claude to open this question");
    setText("#terminal-provenance", "Your work is saved.");
    renderConnectionSteps();
    return;
  }
  renderHeading(e);
  renderAnswer(e, force);
  presentMessages(game, e);
  terminalPanels.requestStatus(e);
  terminalPanels.messages(e);
  $("#help-choice").hidden = !offeredHelp(e).length;
}
/** The question, its title and what the conversation beside it is for. */
function renderHeading(e: Encounter) {
  const composer = $<HTMLTextAreaElement>("#chat-input");
  setText("#conversation-title", "Answer");
  // The panel is titled "Answer" and needs no further instruction.
  $("#conversation-context").hidden = true;
  setText("#conversation-context", "");
  setText(
    "#answer-context",
    "This is your submission. Your tutor can help in the panel beside it.",
  );
  const dialogue = e.mode === "solo";
  $("#terminal").classList.toggle("dialogue-terminal", dialogue);
  $("#legacy-answer").hidden = dialogue;
  const progress = dialogueStatus(game, e);
  $("#dialogue-status").hidden = !dialogue || progress.hidden;
  setText("#dialogue-status", progress.text);
  $("#saved-answer").hidden = !dialogue || !e.workspace;
  setText("#saved-answer-text", e.workspace);
  $("#submission-help").hidden = dialogue;
  composer.setAttribute(
    "aria-label",
    dialogue ? "Message your tutor" : "Message",
  );
  presentProblem(game, e, roadmap);
  setText("#terminal-type", "QUESTION");
  setText(
    "#problem-title",
    e.problem?.title ??
      (e.state === "consumed"
        ? "Completed question"
        : e.error
          ? "Connection unavailable"
          : "Connecting…"),
  );
  // One write: appending to the line would replace its text on every tick.
  setText("#terminal-provenance", provenanceText(game, e));
  setHtml(
    $("#problem"),
    e.problem?.prompt !== undefined
      ? markdownToHtml(e.problem.prompt)
      : (e.state !== "consumed" && !e.error && generationHtml(e)) ||
          escape(
            e.state === "consumed"
              ? "No saved question is available for this completed record."
              : (e.error ??
                  "Generating a stable curriculum-scoped problem. You can leave immediately."),
          ),
  );
}
/** The message draft, and the answer editor a question outside a solo
 * conversation still submits from, with its checks and captured runs. */
function renderAnswer(e: Encounter, force: boolean) {
  const composer = $<HTMLTextAreaElement>("#chat-input");
  if (force || document.activeElement !== composer)
    composer.value = e.chatDraft ?? "";
  editor.dataset.mode = e.problem?.runtime ? "code" : "text";
  if (force || document.activeElement !== editor || e.state === "consumed") {
    if (editor.value !== e.workspace) editor.value = e.workspace;
    editorRevision = e.revision;
    if (force) {
      editor.scrollTop = e.scroll;
      editor.setSelectionRange(...e.selection);
    }
  }
  editor.readOnly = e.state === "consumed";
  setText(
    "#revision",
    `v${e.revision}${e.state === "consumed" ? " · consumed / read-only" : ""}`,
  );
  const checking = e.submissions.some((s) => s.status === "pending");
  $<HTMLButtonElement>("#submit").disabled =
    !e.problem || e.state === "consumed" || checking;
  const retry = $<HTMLButtonElement>("#retry-submission");
  retry.hidden =
    e.state === "consumed" || e.submissions.at(-1)?.status !== "error";
  retry.disabled = checking;
  const run = $<HTMLButtonElement>("#run-code");
  run.hidden = !canRunWorkspace(game, e, roadmap);
  run.disabled = e.executions?.some((job) => job.status === "pending") ?? false;
  setNodeText(
    run,
    run.disabled
      ? "Running captured code…"
      : e.problem?.runtime?.environment === "react"
        ? "Run React checks"
        : `Run ${e.problem?.runtime?.language ?? "code"}`,
  );
  $("#execution-results").hidden = !e.executions?.length;
  setText(
    "#execution-output",
    (e.executions ?? []).slice(-5).map(executionText).join("\n\n"),
  );
  renderExecutionPreview(e);
  const submission = submissionView(e);
  setText("#submission-status", submission.label);
  $("#submission-status").dataset.state = submission.tone;
  setText("#submission-help", submission.help);
}
/** Captured React output is shown only as a bounded inline JPEG. */
const PREVIEW_URL = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;
const PREVIEW_MAX_CHARS = 180025;
function renderExecutionPreview(e: Encounter) {
  const job = (e.executions ?? [])
    .slice()
    .reverse()
    .find(
      (job) =>
        job.preview &&
        PREVIEW_URL.test(job.preview.dataUrl) &&
        job.preview.dataUrl.length <= PREVIEW_MAX_CHARS,
    );
  const figure = $("#execution-preview"),
    key = job ? `${e.id}/${job.id}/${job.preview!.sha256}` : "";
  figure.hidden = !job;
  if (figure.dataset.capture === key) return;
  figure.dataset.capture = key;
  figure.replaceChildren();
  if (!job?.preview) return;
  const image = document.createElement("img"),
    caption = document.createElement("figcaption");
  image.src = job.preview.dataUrl;
  image.width = job.preview.width;
  image.height = job.preview.height;
  image.alt = `Captured React output for workspace revision ${job.revision}`;
  setNodeText(
    caption,
    `Saved browser output · v${job.revision}. Task checks run automatically; this image does not establish correctness or independent understanding.`,
  );
  figure.append(image, caption);
}
editor.addEventListener("input", () => {
  if (!active) return;
  try {
    if (
      edit(game, game.encounters[active], editor.value, editorRevision, roadmap)
    )
      editorRevision = game.encounters[active].revision;
    void persist();
  } catch (err) {
    game.notice = String(err);
    renderTerminal(true);
  }
});
/** Save and repaint once a request the terminal started has settled. A
 * request that throws is shown on its terminal instead of being lost. */
function settleTerminalRequest(pending: Promise<unknown>, e: Encounter) {
  void settleRequest(pending, e, () => {
    void persist();
    renderTerminal();
  });
}
/** Start a request for the open question, then save and show its pending state. */
function startTerminalRequest(start: (e: Encounter) => Promise<unknown>) {
  const e = active ? game.encounters[active] : undefined;
  if (!e) return;
  settleTerminalRequest(start(e), e);
  renderTerminal();
  void persist();
}
$("#run-code").onclick = () =>
  startTerminalRequest((e) => runWorkspace(game, e, roadmap));
$("#terminal-connect-retry").onclick = () => void recheckConnection();
$("#submit").onclick = () =>
  startTerminalRequest((e) => submit(game, e, roadmap));
$("#retry-submission").onclick = () => {
  const s = active ? game.encounters[active]?.submissions.at(-1) : undefined;
  if (s?.status !== "error") return;
  startTerminalRequest((e) => retrySubmission(game, e, roadmap, s.id));
};
// Help that costs credit is given only after this explicit choice.
$("#help-accept").onclick = () => {
  const e = active ? game.encounters[active] : undefined;
  const offers = e ? offeredHelp(e) : [];
  if (!e || !offers.length) return;
  startTerminalRequest(() =>
    send(game, e, "Yes, give me the help.", roadmap, offers),
  );
};
$("#help-retry").onclick = () => $<HTMLTextAreaElement>("#chat-input").focus();
$("#help-skip").onclick = () => {
  const e = active ? game.encounters[active] : undefined;
  if (!e || !offeredHelp(e).length) return;
  startTerminalRequest(() => send(game, e, "I want to move on.", roadmap));
};
$("#chat-input").addEventListener("input", () => {
  if (!active) return;
  game.encounters[active].chatDraft =
    $<HTMLTextAreaElement>("#chat-input").value;
  void persist();
});
$("#chat-input").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    $<HTMLFormElement>("#chat-form").requestSubmit();
  }
});
$("#chat-form").onsubmit = (ev) => {
  ev.preventDefault();
  if (!active) return;
  const e = game.encounters[active],
    input = $<HTMLTextAreaElement>("#chat-input"),
    text = input.value;
  if (!text.trim() || e.tutorRequests?.some((j) => j.state === "pending")) {
    runLogs.record(game, "terminal-message-blocked", {
      reason: !text.trim() ? "empty" : "tutor-pending",
    });
    return;
  }
  input.value = "";
  e.chatDraft = "";
  runLogs.record(game, "terminal-message", { chars: text.length });
  startTerminalRequest(() => send(game, e, text, roadmap));
};

// ---- Page lifecycle ---------------------------------------------------------

window.addEventListener("blur", () => void persist());
// A closing tab gets a full save: its synchronous local copy lands even when
// the IndexedDB write cannot finish before the page goes away.
window.addEventListener("pagehide", () => void persist());
window.addEventListener("online", () => {
  if (!saveRecoveryError) void checkBridge().then(() => resumeQuestions());
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void persist();
});
/** The periodic repaint: status lines, the skill map and the open question. */
function ui() {
  $("#log-status").textContent =
    runLogs.error ||
    "Logs stay on this browser: newest 3 records, at most 256 KB each. Older diagnostics are deleted automatically; learning is retained.";
  syncLearningView(game.study);
  studySession.renderStatus();
  studySession.renderWorkspace();
  if (active) watchTerminalConnection();
  renderTerminal();
}
function tick(time: number) {
  if (time - lastUI > 200) {
    lastUI = time;
    ui();
  }
  requestAnimationFrame(tick);
}
// Agent diagnostics stay out of the learner's menu. Browser acceptance
// fixtures use these hooks in synthetic browser contexts.
Object.assign(window, {
  __deadAir: {
    get game() {
      return game;
    },
    roadmap,
    /** Agent-only entry: diagnostics have no control in the interface. */
    openAgentMenu() {
      const open = $<HTMLDialogElement>("#pause-menu").open;
      if (open) showMenuHome();
      else studyMenu(true);
      document.body.classList.add("agent-tools");
    },
    /** The newest three records' diagnostics, read by agents, never a download. */
    logs() {
      return runLogs.export();
    },
  },
});
showStudy();
resumeQuestions();
ui();
requestAnimationFrame(tick);
