import { createStudyWorkspaceView } from "./study-workspace-view";
import { providerLabel } from "./provider-label";
import { NpcVoiceDirector } from "./npc-voice";
import {
  activateCareerFocus,
  careerProfileSummary,
  type CareerFocus,
} from "./career-profile";
import { simulationActive } from "./simulation-state";
import { spawnGrace } from "./study-pacing";
import { terminalChannel, submissionView } from "./terminal-view";
import { unfinishedLastQuestion } from "./final-question";
import { encounterGaps, probeSummary } from "./knowledge-probe";
import { unfinishedEarlierVisits } from "./room-questions";
import { setTopicEnabled } from "./topic-spawn";
import {
  inspectorSummaryHtml,
  knowledgeHtml,
  readinessHtml,
  topicSpawnHtml,
} from "./inspector-view";
import { FramePerformance } from "./frame-performance";
import gameShell from "./game-shell.html?raw";
import { escapeHtml as escape } from "./html";
import { markdownToHtml } from "./markdown";
import {
  assess,
  autonomousNpcWork,
  checkBridge,
  prepareNextQuestion,
  streamingReply,
  watchStreamingReplies,
  releaseRetiredChatRequests,
  closeChat,
  edit,
  ensureProblem,
  inspectCompletedNpcWork,
  materializeObservedWork,
  presentMessages,
  presentProblem,
  presentWorkLog,
  reconcileUploadedRoadmap,
  retryChatCatchup,
  retryGroupRequest,
  retrySubmission,
  retryTutorRequest,
  reviewEnvironmentObservation,
  send,
  status,
  submit,
} from "./ai";
import { AudioDirector } from "./audio";
import { eligible, initialStudy, syncLearningView } from "./curriculum";
import { doorFrame } from "./doors";
import { displayScale } from "./display-scale";
import {
  board,
  canReachStation,
  claimStation,
  human,
  nearbyDoor,
  nearestGrip,
  nearestStation,
  releaseStation,
  step,
  takeLoot,
  toggleDoor,
  toggleGrip,
  useItem,
  vault,
} from "./engine";
import { renderEnvironmentObservations } from "./environment-ui";
import { itemInfo } from "./equipment";
import { canRunWorkspace, runWorkspace } from "./execution";
import { executionText } from "./execution-presentation";
import { surfacePoint } from "./furniture-geometry";
import { historicalRecords } from "./historical-proof";
import { encounterKey } from "./learner";
import type { Provider } from "./model";
import {
  type Encounter,
  type Game,
  type Roadmap,
  CONFIG,
  DEV,
  distance,
  H,
  W,
} from "./model";
import { outcomeIsVisible, presentNpcOutcome } from "./npc-outcome";
import {
  decode,
  download,
  encode,
  exportRecoveryBackup,
  load,
  recover,
  save,
} from "./persistence";
import { camera } from "./camera";
import { rememberVisibleTiles, render, renderMinimap } from "./render";
import { canLookInGame, FirstPersonControls } from "./view3d/controls";
import { FirstPersonHud } from "./view3d/hud";
import {
  readSavedLook,
  writeSavedLook,
  type SavedLook,
} from "./view3d/look-memory";
import { firstPersonInput } from "./view3d/math";
import { FirstPersonView } from "./view3d/scene";
import { lookTarget } from "./view3d/targeting";
import {
  type SpectatorView,
  SPECTATOR_ZOOM,
  clampView,
  floorTitle,
  initialView,
  spectating,
  spectatorFloors,
} from "./spectator";
import { renderRoadmapAdoption } from "./roadmap-adoption-ui";
import { prepareRoadmapExport } from "./roadmap-export";
import { presentRoadmapReview } from "./roadmap-exposure";
import { reviewRoadmap } from "./roadmap-review";
import { retainRunLearning } from "./run-learning";
import { LOG_KEY, RunLogs } from "./run-logs";
import { readDurable, writeDurable } from "./storage";
import "./style.css";
import "./view3d/style.css";
import "./study-workspace.css";
import { presentSharedWorkspace } from "./workspace-exposure";
import {
  presentWorkspaceProposal,
  reviewWorkspaceProposal,
} from "./workspace-proposals";
import { createPlayableGame as createGame } from "./world";
import { chooseRunDesign, type RunChoice } from "./run-design-ui";
import { clearDesignDraft, rememberDesign } from "./run-designer";
import type { SavedRunDesign } from "./run-design-contract.mjs";
import {
  enterStudyWorkspace,
  exitStudyWorkspace,
  nextWorkspaceQuestion,
  workspaceQuestion,
  workspaceAssessment,
  workspaceSelectedQuestion,
  STUDY_VIEW_KEY,
} from "./study-workspace";
const $ = <T extends HTMLElement = HTMLElement>(s: string) =>
  document.querySelector<T>(s)!;
const app = $("#app");
const roadmap: Roadmap = await fetch("/curriculum.json").then((r) => r.json());
let game: Game,
  saveError = "",
  saveRecoveryError = "",
  active: string | undefined,
  tab: "tutor" | "group" = "tutor",
  keys = new Set<string>(),
  jumpRequested = false,
  running = false,
  last = 0,
  acc = 0,
  lastUI = 0,
  lastSave = 0,
  editorRevision = 0,
  // Free-look over the live building after the run ends. Page state only.
  view: SpectatorView | undefined,
  // The human's last opened terminal; finalQuestion marks post-death answering.
  lastQuestion: string | undefined,
  finalQuestion = false;
const audio = new AudioDirector();
const npcVoices = new NpcVoiceDirector(audio);
window.addEventListener("pagehide", () => npcVoices.dispose());
try {
  const saved = await load();
  game = recover(
    saved ?? newRunPreview(crypto.getRandomValues(new Uint32Array(1))[0]),
  );
  // A design dialog pauses its preview temporarily; that is not a player pause
  // menu that should cover the Start button after reloading a pending request.
  if (game.preparingRun && game.status === "ready") game.paused = false;
} catch (err) {
  game = newRunPreview(123456);
  saveRecoveryError = `Saved progress could not be loaded: ${String(err)}. Existing checkpoints have been protected. Retry loading, or export recovery data before restoring a backup.`;
  saveError = saveRecoveryError;
}
/** The local world is only a backdrop while the first design is being prepared. */
function newRunPreview(seed: number) {
  const study = initialStudy(roadmap);
  activateRunFocus(study);
  const preview = createGame(seed, roadmap, study);
  preview.preparingRun = true;
  return preview;
}
// Apply the role profile before the factory prepares development questions.
function activateRunFocus(study: Game["study"]) {
  activateCareerFocus(
    roadmap,
    study,
    study.careerFocus ?? study.learner?.careerFocus ?? "product-feature-owner",
  );
}
function newPlayableGame(
  seed: number,
  study: Game["study"],
  design: SavedRunDesign,
) {
  activateRunFocus(study);
  return createGame(seed, roadmap, study, design);
}
activateCareerFocus(
  roadmap,
  game.study,
  game.study.careerFocus ??
    game.study.learner?.careerFocus ??
    "product-feature-owner",
);
function latestStudyEncounter(g: Game): string | undefined {
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
app.innerHTML = gameShell;
const canvas = $<HTMLCanvasElement>("#world"),
  canvas3d = $<HTMLCanvasElement>("#view3d"),
  editor = $<HTMLTextAreaElement>("#workspace");
let firstPersonView: FirstPersonView | undefined,
  firstPersonRun: Game | undefined,
  viewFailedRun = "",
  displayedFirstPerson: boolean | undefined,
  savedLook: SavedLook | undefined = readSavedLook(game.id),
  pointerUnlockAt = -Infinity,
  lastMinimap = -Infinity;
const firstPersonControls = new FirstPersonControls(canvas3d, {
  canLook: () =>
    canLookInGame({
      playing: firstPersonPlaying(),
      paused: !!game.paused,
      quitMenu,
      uiVisible: lookUiVisible(),
    }),
  ownsKeyboard,
  onUnlock: () => {
    pointerUnlockAt = performance.now();
    keys.clear();
    jumpRequested = false;
    if (firstPersonPlaying() && !game.paused && !quitMenu) setPaused(true);
  },
  onRetry: () => {
    game.notice = "Click to capture the mouse and look around. Esc pauses.";
  },
  onUnconfined: () => {
    game.notice =
      "This browser isn't locking the mouse, so the view keeps turning while the cursor is at the screen edge. For full mouse capture, open the game in Chrome, Edge, or Safari.";
  },
  onLook: () => {
    savedLook = { id: game.id, ...firstPersonControls.look() };
  },
  onError: () => {
    game.notice =
      "Mouse capture is unavailable. Use the arrow keys to look around.";
  },
});
// Initialize from the recovered survivor before any input or agent hook can
// observe the controls; syncGameView also resets when a new run is activated.
if (savedLook) firstPersonControls.setLook(savedLook.yaw, savedLook.pitch);
else firstPersonControls.reset(human(game).heading);
function persistLook() {
  if (savedLook) writeSavedLook(savedLook);
}
window.addEventListener("pagehide", persistLook);
canvas3d.addEventListener("webglcontextlost", (event) => {
  event.preventDefault();
  if (firstPersonView) useClassicFallback();
});
const firstPersonHud = new FirstPersonHud(
  $("#first-person-hud"),
  $("#interaction-prompt"),
  $("#pointer-hint"),
  $("#damage-vignette"),
);
function firstPersonPlaying() {
  const a = human(game);
  return (
    game.settings.view !== "top-down" &&
    game.status === "playing" &&
    a.alive &&
    !a.escaped &&
    !game.studyWorkspace?.enabled &&
    game.id !== viewFailedRun
  );
}
function lookUiVisible() {
  return !$("#terminal").hidden || !!document.querySelector("dialog[open]");
}
function useClassicFallback() {
  viewFailedRun = game.id;
  firstPersonControls.release();
  game.notice =
    "3D rendering is unavailable. Classic view is active; choose Game view in Settings to retry.";
  syncGameView();
}
function syncGameView() {
  const firstPerson = firstPersonPlaying();
  if (firstPerson && firstPersonRun !== game) {
    firstPersonControls.release();
    const look = savedLook?.id === game.id ? savedLook : readSavedLook(game.id);
    if (look) firstPersonControls.setLook(look.yaw, look.pitch);
    else firstPersonControls.reset(human(game).heading);
    firstPersonRun = game;
    lastMinimap = -Infinity;
  }
  if (firstPerson && !firstPersonView) {
    try {
      firstPersonView = new FirstPersonView(canvas3d);
    } catch {
      useClassicFallback();
      return;
    }
  } else if (!firstPerson) {
    firstPersonControls.release();
    firstPersonView?.dispose();
    firstPersonView = undefined;
    firstPersonRun = undefined;
  }
  if (displayedFirstPerson === firstPerson) return;
  displayedFirstPerson = firstPerson;
  canvas3d.hidden = !firstPerson;
  canvas.classList.toggle("minimap", firstPerson);
  canvas.tabIndex = firstPerson ? -1 : 0;
  canvas.setAttribute(
    "aria-label",
    firstPerson
      ? "Minimap of explored floor layout and player position"
      : "Top-down survival game. Use WASD or arrow keys to move.",
  );
  document.body.classList.toggle("first-person", firstPerson);
  $("#arrow-hint").innerHTML = firstPerson
    ? "<kbd>←/→</kbd> turn · <kbd>↑/↓</kbd> look"
    : "<kbd>↑↓←→</kbd> move";
}
function focusWorld(captureMouse = false) {
  syncGameView();
  (firstPersonPlaying() ? canvas3d : canvas).focus();
  if (captureMouse) firstPersonControls.lock();
}
let studyStarting = false;
let studySaving = false;
let studySaveGeneration = 0;
syncDisplayScale();
let saveToken = 0;
async function persist() {
  persistLook();
  // A placeholder world must never overwrite a checkpoint that failed to load
  // or recover. Only a validated, explicitly imported backup releases this guard.
  if (saveRecoveryError) return false;
  runLogs.capture(game);
  const token = ++saveToken;
  const at = game.time;
  lastSave = at;
  try {
    await save(game);
    if (token === saveToken) saveError = "";
    return true;
  } catch (err) {
    if (token === saveToken)
      saveError = game.studyWorkspace?.enabled
        ? `Save failed: ${String(err)}. Your result is still in this tab. Retry saving before leaving.`
        : `Save failed: ${String(err)}. Export a run backup.`;
    return false;
  }
}
async function persistOrThrow(context = "Local save failed") {
  if (!(await persist())) throw Error(saveError || context);
}
/** The question being prepared for the player, if any. */
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
/** Preserve the requested generation through death/reload and join repeated
 * retries before opening its resulting question in the terminal. */
function prepareQuestion(e: Encounter): Promise<void> {
  const pending = questionPreparations.get(e);
  if (pending) return pending;
  const requestGame = game;
  const operation = (async () => {
    try {
      const generated = ensureProblem(requestGame, e, roadmap);
      questionChanged();
      await generated;
      if (game !== requestGame || game.encounters[e.id] !== e) return;
      if (e.problem) {
        showEmbeddedTerminal(e);
        if (game.status === "dead" || game.status === "escaped") {
          $("#start-card").hidden = true;
          syncSpectatorBar();
        }
      } else questionChanged();
    } catch (error) {
      if (game !== requestGame) return;
      e.error = String(error);
      questionChanged();
    }
  })();
  questionPreparations.set(e, operation);
  void operation.finally(() => questionPreparations.delete(e));
  return operation;
}
function questionChanged() {
  renderStudyStatus();
  void saveStudySession();
}
/** What the study view says about the question being prepared. It only clears
 * a message it wrote itself, so other notices on the line are left alone. */
let studyStatusShown = false;
function renderStudyStatus() {
  if (!game.studyWorkspace?.enabled) {
    studyStatusShown = false;
    return;
  }
  const e = displayedQuestion();
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
    studyStatusShown = true;
  } else if (studyStatusShown) {
    setText("#study-message", "");
    studyStatusShown = false;
  }
}
$("#study-question-retry").onclick = () => {
  const e = displayedQuestion();
  if (!e) return;
  void checkBridge().then(() => {
    resumeQuestions();
    void prepareQuestion(e);
  });
};
async function saveStudySession() {
  const saveGeneration = ++studySaveGeneration;
  const savedGame = game;
  if (game.studyWorkspace?.enabled) {
    studySaving = true;
    renderStudyWorkspace();
  }
  await persist().then(() => {
    if (saveGeneration !== studySaveGeneration || game !== savedGame) return;
    studySaving = false;
    if (game.studyWorkspace?.enabled) renderStudyWorkspace();
  });
}
// Settings and agent tools are subpages of the paused game menu.
let pausePanel: string | undefined;
function panelToggle(id: string) {
  return $(id === "settings" ? "#settings-toggle" : "#curriculum-button");
}
// The open terminal re-renders on every UI tick. Rewriting unchanged text or
// markup replaces its nodes, which clears any selection the player is making,
// so panel writes only touch the DOM when the content actually changes.
function setText(selector: string, text: string) {
  setNodeText($(selector), text);
}
function setNodeText(el: Element, text: string) {
  if (el.textContent !== text) el.textContent = text;
}
const writtenHtml = new WeakMap<Element, string>();
function setHtml(el: Element, html: string) {
  // Compare with what was written: the browser normalises innerHTML (for
  // example &#39; reads back as '), so reading it back never matches.
  if (writtenHtml.get(el) === html) return;
  writtenHtml.set(el, html);
  el.innerHTML = html;
}
function showPauseHome(focus?: HTMLElement) {
  for (const id of ["settings", "inspector"]) {
    $(`#${id}`).hidden = true;
    panelToggle(id).setAttribute("aria-expanded", "false");
  }
  pausePanel = undefined;
  $("#pause-home").hidden = false;
  $("#pause-panels").hidden = true;
  $("#pause-panel-header").hidden = true;
  const menu = $<HTMLDialogElement>("#pause-menu");
  delete menu.dataset.panel;
  menu.setAttribute("aria-labelledby", "pause-title");
  if (menu.open && focus) focus.focus();
}
function openPanel(id: string, focus: string) {
  const menu = $<HTMLDialogElement>("#pause-menu");
  if (!menu.open) setPaused(true);
  showPauseHome();
  pausePanel = id;
  $("#pause-home").hidden = true;
  $("#pause-panels").hidden = false;
  $("#pause-panel-header").hidden = false;
  $(`#${id}`).hidden = false;
  if (id === "settings") renderCareerControls();
  panelToggle(id).setAttribute("aria-expanded", "true");
  menu.dataset.panel = id;
  menu.setAttribute("aria-labelledby", `${id}-title`);
  $("#pause-panels").scrollTop = 0;
  keys.clear();
  jumpRequested = false;
  $(focus).focus();
}
function closePanel(id: string) {
  if (pausePanel !== id) return;
  keys.clear();
  jumpRequested = false;
  showPauseHome(panelToggle(id));
}
$("#pause-back").onclick = () => {
  if (pausePanel) closePanel(pausePanel);
};
function ownsKeyboard(target: EventTarget | null) {
  return (
    target instanceof Element &&
    !!target.closest(
      'input,textarea,select,button,summary,a[href],[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"],[role="slider"]',
    )
  );
}
document.addEventListener("focusin", (ev) => {
  if (ownsKeyboard(ev.target)) {
    keys.clear();
    jumpRequested = false;
    firstPersonControls.release();
  }
});
let pauseFocus: HTMLElement | undefined;
function setPaused(paused: boolean) {
  const menu = $<HTMLDialogElement>("#pause-menu");
  const playing = simulationActive(game);
  keys.clear();
  jumpRequested = false;
  acc = 0;
  if (paused) {
    firstPersonControls.release();
    if (!menu.open)
      pauseFocus =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : undefined;
    if (playing) game.paused = true;
    audio.stop();
    showPauseHome();
    setText("#pause-title", playing ? "Game paused" : "Game menu");
    setText("#resume-game", playing ? "Resume · Esc" : "Back · Esc");
    $("#save-quit").hidden = !playing;
    if (!menu.open) menu.showModal();
    $("#resume-game").focus();
  } else {
    game.paused = false;
    showPauseHome();
    document.body.classList.remove("agent-tools");
    menu.close();
    if (playing) {
      audio.start();
      audio.update(game);
    }
    if (firstPersonPlaying() && !lookUiVisible()) focusWorld(true);
    else if (
      pauseFocus?.isConnected &&
      !pauseFocus.closest("[hidden], #pause-menu")
    )
      pauseFocus.focus();
    else focusWorld();
  }
  if (playing) runLogs.record(game, paused ? "pause" : "resume");
  runLogs.capture(game, true);
  void persist().then((saved) => {
    $("#pause-save-status").textContent = saved
      ? "Run and learning progress saved."
      : saveError;
  });
}
$("#pause-toggle").onclick = () =>
  setPaused(!$<HTMLDialogElement>("#pause-menu").open);
$("#resume-game").onclick = () => setPaused(false);
$("#restart-game").onclick = () => void fresh($("#pause-save-status"));
$("#save-quit").onclick = () => void saveAndQuit();
$("#pause-menu").addEventListener("cancel", (event) => {
  event.preventDefault();
  if (restarting) return;
  if (pausePanel) closePanel(pausePanel);
  else setPaused(false);
});
function setStudyMode(enabled: boolean) {
  if (saveRecoveryError) return;
  firstPersonControls.release();
  keys.clear();
  jumpRequested = false;
  acc = 0;
  closeTerminal();
  if (enabled) {
    enterStudyWorkspace(game);
    const current = workspaceQuestion(game);
    if (current) {
      game.studyWorkspace!.encounter = encounterKey(current);
      lastQuestion = current.id;
    }
    audio.stop();
    document.body.classList.remove("agent-tools", "surge");
    $<HTMLDialogElement>("#pause-menu").close();
  } else {
    exitStudyWorkspace(game);
  }
  document.documentElement.classList.toggle("study-only", enabled);
  document.title = enabled ? "Learning workspace" : "zombie-escape-study-game";
  $(".game-layout").hidden = enabled;
  $("#study-workspace").hidden = !enabled;
  placeTerminal(enabled);
  if (enabled) {
    const resumed = workspaceQuestion(game);
    if (resumed) openStudyTerminal(resumed);
  }
  try {
    if (enabled) localStorage.setItem(STUDY_VIEW_KEY, "1");
    else localStorage.removeItem(STUDY_VIEW_KEY);
  } catch {
    /* The regular game save also retains this view. */
  }
  if (enabled) {
    renderStudyWorkspace();
    renderStudyStatus();
    $(workspaceQuestion(game) ? "#study-session-title" : "#study-next").focus({
      preventScroll: true,
    });
  } else if (game.paused) setPaused(true);
  else {
    if (simulationActive(game)) {
      audio.start();
      audio.update(game);
    }
    focusWorld(true);
  }
  void persist();
}

const studyWorkspaceView = createStudyWorkspaceView(
  $("#study-workspace"),
  roadmap,
  () => ({ game, starting: studyStarting, saving: studySaving, saveError }),
);
function renderStudyWorkspace() {
  studyWorkspaceView.render();
}

$("#study-only-toggle").onclick = () => setStudyMode(true);
$("#study-only-menu").onclick = () => setStudyMode(true);
$("#study-only-exit").onclick = () => setStudyMode(false);
$("#study-save-retry").onclick = () => void saveStudySession();
$("#study-next").onclick = async () => {
  if (studyStarting) return;
  studyStarting = true;
  setText("#study-message", "");
  studyStatusShown = false;
  try {
    const e = nextWorkspaceQuestion(game, roadmap);
    game.studyWorkspace!.encounter = encounterKey(e);
    lastQuestion = e.id;
    game.lastStudyEncounter = e.id;
    openStudyTerminal(e);
    await prepareQuestion(e);
  } catch (error) {
    setText("#study-message", String(error));
  } finally {
    studyStarting = false;
    renderStudyWorkspace();
    renderStudyStatus();
    void persist();
  }
};
$("#study-review-retry").onclick = async () => {
  const a = workspaceAssessment(game);
  const e = workspaceSelectedQuestion(game);
  if (!a || !e) return;
  await assess(game, e, roadmap, a.evidenceCutoffSequence, true);
  questionChanged();
};
window.addEventListener("error", (event) => {
  runLogs.record(game, "browser-error", {
    file: event.filename.split("/").pop(),
    line: event.lineno,
  });
  void runLogs.flush();
});
window.addEventListener("unhandledrejection", () => {
  runLogs.record(game, "unhandled-rejection");
  void runLogs.flush();
});
let designingInitial = false;
async function beginDesignedRun() {
  if (designingInitial || saveRecoveryError) return;
  designingInitial = true;
  const previous = game;
  try {
    // Keep the preview identity durable so a reload can retry its exact request.
    if (!(await persist())) throw Error(saveError);
    firstPersonControls.release();
    keys.clear();
    jumpRequested = false;
    const choice = await chooseRunDesign(previous, roadmap);
    if (!choice || game !== previous) return;
    game = newPlayableGame(
      choice.seed,
      structuredClone(previous.study),
      choice.saved,
    );
    game.settings = previous.settings;
    readyRun();
    if (await persist()) finishRunDesign(previous.id, choice);
  } catch (error) {
    game.notice = `Run could not start: ${String(error)}`;
    const p = document.querySelector("#start-card p");
    if (p) p.textContent = game.notice;
  } finally {
    designingInitial = false;
  }
}
function finishRunDesign(previousId: string, choice: RunChoice) {
  try {
    rememberDesign(choice.saved);
    clearDesignDraft(previousId);
  } catch {
    // The run itself is already durable; blocked optional history is not data loss.
    game.notice += " Recent-design history could not be saved.";
  }
}
/** Preparation can finish while the player is away. Only Start enters play. */
function readyRun() {
  running = false;
  game.status = "ready";
  game.paused = false;
  quitMenu = false;
  acc = 0;
  keys.clear();
  jumpRequested = false;
  audio.stop();
  document.body.classList.remove("agent-tools", "surge");
  $<HTMLDialogElement>("#pause-menu").close();
  leaveSpectator();
  startCard();
  $("#start").focus({ preventScroll: true });
}
function begin() {
  if (saveRecoveryError) return;
  if (game.preparingRun) {
    void beginDesignedRun();
    return;
  }
  document.body.classList.remove("agent-tools");
  game.status = "playing";
  game.paused = false;
  running = true;
  quitMenu = false;
  leaveSpectator();
  audio.start();
  audio.update(game);
  $("#start-card").hidden = true;
  focusWorld(true);
  persist();
}
const HUMAN_EVIDENCE_KINDS = [
  "edit",
  "reasoning",
  "test",
  "defense",
  "execution",
];
function hasHumanEvidence(e: Encounter) {
  return e.history.some(
    (h) => h.author === "human" && HUMAN_EVIDENCE_KINDS.includes(h.kind),
  );
}
function preserveRunLearning(g: Game, archive = false) {
  const retained = retainRunLearning(g, archive);
  for (const e of retained)
    if (hasHumanEvidence(e)) void assess(g, e, roadmap).then(persist);
  if (retained.length) void persist();
}
/** How long a restart waits for this run's assessments before it moves on;
 * later results still land in the shared study state and are saved then. */
const RESTART_ASSESSMENT_WAIT_MS = 12_000;
let restarting = false,
  unsavedRestartConfirmed = false;
/** A restart first archives this run's learning and writes it durably; a new
 * run starts only once that save succeeded, or on a second press after a
 * failed save. */
let designingNextRun = false;
async function fresh(statusLine?: HTMLElement) {
  if (saveRecoveryError) {
    if (statusLine) statusLine.textContent = saveRecoveryError;
    return false;
  }
  if (restarting || designingNextRun) return false;
  designingNextRun = true;
  const beforeDesign = game;
  let choice: RunChoice | undefined;
  try {
    firstPersonControls.release();
    keys.clear();
    jumpRequested = false;
    choice = await chooseRunDesign(game, roadmap);
  } finally {
    designingNextRun = false;
  }
  if (!choice || game !== beforeDesign) return false;
  restarting = true;
  const previous = game;
  const say = (text: string) => {
    if (statusLine) statusLine.textContent = text;
  };
  const controls = [
    ...document.querySelectorAll<HTMLButtonElement>(
      "#pause-menu button, #start-card button",
    ),
  ];
  const disabledBefore = controls.map((button) => button.disabled);
  for (const b of controls) b.disabled = true;
  closeTerminal();
  say("Saving learning progress…");
  const assessing = Promise.allSettled(
    retainRunLearning(previous, true)
      .filter(hasHumanEvidence)
      .map((e) => assess(previous, e, roadmap).then(persist)),
  );
  // Requests are captured synchronously. Save them before waiting on a model,
  // including when a page closes during the restart's assessment grace period.
  void persist();
  const assessed = await Promise.race([
    assessing.then(() => true),
    new Promise<false>((done) =>
      setTimeout(() => done(false), RESTART_ASSESSMENT_WAIT_MS),
    ),
  ]);
  const saved = await persist();
  controls.forEach((button, index) => {
    button.disabled = disabledBefore[index];
  });
  restarting = false;
  if (!saved && !unsavedRestartConfirmed) {
    unsavedRestartConfirmed = true;
    say(`${saveError} Press again to restart without saving.`);
    return false;
  }
  unsavedRestartConfirmed = false;
  runLogs.capture(previous, true);
  runLogs.record(previous, "restart");
  // Encounter drafts are archived; a new run never inherits a nearly completed lock.
  delete previous.study.pending;
  game = newPlayableGame(choice.seed, previous.study, choice.saved);
  game.settings = previous.settings;
  const learningNotice = !saved
    ? "New run ready. The last run's learning could not be saved."
    : assessed
      ? "Learning progress saved. New run ready."
      : "Learning progress saved; assessments finish in the background.";
  game.notice = `${game.notice} ${learningNotice}`;
  say("");
  $<HTMLDialogElement>("#pause-menu").close();
  active = undefined;
  lastQuestion = undefined;
  completionCursor = 0;
  keys.clear();
  jumpRequested = false;
  closeTerminal();
  readyRun();
  if (await persist()) finishRunDesign(previous.id, choice);
  return true;
}
function startCard() {
  const card = $("#start-card");
  if (saveRecoveryError) {
    card.hidden = false;
    card.innerHTML = `<span class="eyebrow">SAVED PROGRESS</span><h2>Save needs<br>recovery.</h2><p id="save-recovery-status" class="save-result failed" role="status">${escape(saveRecoveryError)}</p><button id="save-recovery-retry">Retry loading</button><button id="save-recovery-export" class="quiet">Export recovery data</button><label class="file-label">Restore a run backup <input id="save-recovery-import" type="file" accept=".json,application/json"></label>`;
    $("#save-recovery-retry").onclick = () => window.location.reload();
    $("#save-recovery-export").onclick = async () => {
      try {
        download(
          "zombie-escape-study-game-recovery.json",
          await exportRecoveryBackup(),
        );
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
    return;
  }
  card.classList.toggle(
    "finished",
    game.status === "escaped" || game.status === "dead",
  );
  if (game.status === "playing") {
    card.hidden = true;
    running = true;
    return;
  }
  card.hidden = false;
  const finishable = spectating(game)
    ? (pendingQuestion() ?? unfinishedLastQuestion(game, lastQuestion))
    : undefined;
  if (game.status === "ready")
    card.innerHTML = `<span class="eyebrow">${game.preparingRun ? "A NEW ESCAPE" : "YOUR ESCAPE IS READY"}</span><h2>${game.design ? escape(game.design.design.title) : "The dead are<br>on your heels."}</h2><p>${game.design ? escape(game.design.design.premise) : "Twenty survivors. Four floors. Four seats.<br>Choose your route. Learn your way out."}</p>${game.preparingRun ? "<p>Claude will prepare your game session before play.</p>" : '<p id="run-ready-status" role="status">Your escape is ready. Take your time. Nothing moves until you press Start.</p>'}<button id="start">${game.preparingRun ? "Prepare game ↗" : "Start game ↗"}</button><small class="agent-only">${escape(status().detail)}</small>`;
  else
    card.innerHTML = `<span class="eyebrow">${game.status === "escaped" ? "TRANSMISSION RECEIVED" : "SIGNAL LOST"}</span><h2>${game.status === "escaped" ? "You made it." : "Your work survives."}</h2><p>${escape(game.notice)}<br>${game.stats.rescued} extracted · ${game.stats.deaths} lost · ${Math.floor(game.endedAt ?? game.time)} seconds</p>${finishable ? '<button id="finish-question">Continue in the terminal</button>' : ""}<button id="again">Begin another run ↗</button><button id="backup" class="quiet agent-only">Export work & evidence</button><button id="spectate" class="quiet">Watch the building ↗</button>`;
  document.getElementById("start")?.addEventListener("click", begin);
  document.getElementById("finish-question")?.addEventListener("click", () => {
    if (finishable) openFinalQuestion(finishable);
  });
  document
    .getElementById("again")
    ?.addEventListener("click", () => void fresh(card.querySelector("p")!));
  document.getElementById("spectate")?.addEventListener("click", () => {
    card.hidden = true;
    syncSpectatorBar();
    focusWorld();
  });
  syncSpectatorBar();
  document
    .getElementById("backup")
    ?.addEventListener("click", () =>
      download("zombie-escape-study-game-run.json", encode(game)),
    );
}
/** Save and quit leaves the run paused behind the main menu. */
let quitMenu = false;
async function saveAndQuit() {
  closeTerminal();
  runLogs.capture(game, true);
  $("#pause-save-status").textContent = "Saving…";
  const saved = await persist();
  $("#pause-save-status").textContent = "";
  $<HTMLDialogElement>("#pause-menu").close();
  document.body.classList.remove("agent-tools");
  quitMenu = true;
  const card = $("#start-card");
  card.classList.remove("finished");
  card.hidden = false;
  card.innerHTML = `<span class="eyebrow">A REAL-TIME STUDY ESCAPE</span><h2>The dead are<br>on your heels.</h2><p id="quit-save" class="save-result${saved ? "" : " failed"}" role="status">${saved ? "✓ Run and learning progress saved." : escape(saveError)}</p><button id="continue-run">Continue run ↗</button><button id="new-run" class="quiet">New run · keep learning progress</button>`;
  $("#continue-run").addEventListener("click", continueRun);
  $("#new-run").addEventListener("click", () => void fresh($("#quit-save")));
  $("#continue-run").focus();
}
function continueRun() {
  quitMenu = false;
  $("#start-card").hidden = true;
  setPaused(false);
}
/** The run is over: the whole building can be watched, floor by floor. */
function enterSpectator() {
  view = initialView(game);
  document.body.classList.add("spectating");
  renderSpectatorBar();
  syncSpectatorBar();
}
function leaveSpectator() {
  view = undefined;
  document.body.classList.remove("spectating");
  canvas.classList.remove("dragging");
  syncSpectatorBar();
}
/** The floor bar shows only while the building is watched without the card. */
function syncSpectatorBar() {
  $("#spectator").hidden = !view || !$("#start-card").hidden;
}
function setView(next: SpectatorView) {
  const changedFloor = next.floor !== view?.floor;
  view = clampView(next);
  if (changedFloor) {
    renderSpectatorBar();
    ui();
  }
}
function renderSpectatorBar() {
  if (!view) return;
  const floors = $("#spectator-floors"),
    current = view.floor;
  if (!floors.childElementCount)
    floors.innerHTML = spectatorFloors()
      .map(
        (f) =>
          `<button type="button" class="quiet" data-floor="${f.floor}" title="${escape(f.title)}">${escape(f.label)}</button>`,
      )
      .join("");
  for (const b of floors.querySelectorAll<HTMLButtonElement>("[data-floor]")) {
    const active = Number(b.dataset.floor) === current;
    b.classList.toggle("active", active);
    b.setAttribute("aria-pressed", String(active));
    b.onclick = () => {
      if (!view) return;
      // Another floor opens on its centre; the player's floor on the player.
      setView({
        ...view,
        floor: Number(b.dataset.floor),
        focus: { x: W / 2, y: H / 2 },
      });
      focusWorld();
    };
  }
}
$("#spectator-summary").onclick = () => startCard();
// Dragging the frozen world pans it; the wheel zooms. Both are inert while a
// run is playing.
let dragging: number | undefined;
canvas.addEventListener("pointerdown", (ev) => {
  if (!view || !spectating(game) || ev.button !== 0) return;
  dragging = ev.pointerId;
  canvas.setPointerCapture(ev.pointerId);
  canvas.classList.add("dragging");
});
canvas.addEventListener("pointermove", (ev) => {
  if (dragging !== ev.pointerId || !view) return;
  const rect = canvas.getBoundingClientRect(),
    { scale } = camera(
      rect.width,
      rect.height,
      view.focus,
      view.zoom * displayScale(game.settings.displayScale),
    );
  setView({
    ...view,
    focus: {
      x: view.focus.x - ev.movementX / scale,
      y: view.focus.y - ev.movementY / scale,
    },
  });
});
for (const type of ["pointerup", "pointercancel"] as const)
  canvas.addEventListener(type, (ev) => {
    if (dragging !== ev.pointerId) return;
    dragging = undefined;
    canvas.classList.remove("dragging");
  });
canvas.addEventListener(
  "wheel",
  (ev) => {
    if (!view || !spectating(game)) return;
    ev.preventDefault();
    const step = ev.deltaY < 0 ? SPECTATOR_ZOOM.step : 1 / SPECTATOR_ZOOM.step;
    setView({ ...view, zoom: view.zoom * step });
  },
  { passive: false },
);
function closeTerminal() {
  if (active) {
    const e = game.encounters[active];
    if (e) {
      e.scroll = editor.scrollTop;
      e.selection = [editor.selectionStart, editor.selectionEnd];
      closeChat(game, e);
    }
  }
  active = undefined;
  finalQuestion = false;
  releaseStation(human(game));
  $("#dialogue-reward").hidden = true;
  $("#final-question-notice").hidden = true;
  $("#terminal").hidden = true;
  document.body.classList.remove("terminal-open");
  editor.blur();
  keys.clear();
  jumpRequested = false;
  if (!game.studyWorkspace?.enabled) focusWorld();
  persist();
}
/** The terminal sits in the game layout normally and moves into the study
 * view's slot while that view is on; a comment marks where it came from. */
let terminalHome: Comment | undefined;
function placeTerminal(inStudy: boolean) {
  const terminal = $("#terminal");
  if (inStudy) {
    if (!terminalHome) {
      terminalHome = document.createComment("terminal-home");
      terminal.before(terminalHome);
    }
    $("#study-terminal-slot").append(terminal);
  } else if (terminalHome) {
    terminalHome.replaceWith(terminal);
    terminalHome = undefined;
  }
}
/** Opens an encounter in the study view's terminal. It has no physical station. */
function openStudyTerminal(e: Encounter) {
  if (active && active !== e.id) closeTerminal();
  lastQuestion = e.id;
  game.lastStudyEncounter = e.id;
  active = e.id;
  finalQuestion = false;
  showEmbeddedTerminal(e);
}
/** After death the last tutor question stays answerable; no station is
 * claimed and engine rewards skip the dead human. */
function openFinalQuestion(e: Encounter) {
  lastQuestion = e.id;
  game.lastStudyEncounter = e.id;
  $("#start-card").hidden = true;
  active = e.id;
  finalQuestion = true;
  showEmbeddedTerminal(e);
  void prepareQuestion(e);
  syncSpectatorBar();
  focusWorld();
}
/** Leaving a post-death terminal re-assesses its evidence, then shows the end card. */
function leaveTerminal() {
  const post = finalQuestion;
  closeTerminal();
  if (game.studyWorkspace?.enabled) {
    renderStudyWorkspace();
    renderStudyStatus();
    $("#study-next").focus({ preventScroll: true });
    return;
  }
  if (!post) return;
  preserveRunLearning(game);
  persist();
  startCard();
}
async function interact() {
  if (game.status !== "playing" || game.paused) return;
  const a = human(game);
  if (firstPersonPlaying()) a.heading = firstPersonControls.facing;
  if (a.grip) {
    toggleGrip(game, a);
    runLogs.record(game, "release");
    return;
  }
  if (active) {
    closeTerminal();
    return;
  }
  if (a.floor === CONFIG.floors && board(game, a)) return;
  const target = firstPersonPlaying()
    ? lookTarget(game, firstPersonControls.yaw)
    : undefined;
  if (target?.kind === "item") {
    if (takeLoot(game, a, target.encounter, target.item.id)) void persist();
    else game.notice = "Pack full or cache access not earned.";
    return;
  }
  const object =
      target?.kind === "grip"
        ? target.object
        : target
          ? undefined
          : nearestGrip(game, a),
    station =
      target?.kind === "station"
        ? target.station
        : target
          ? undefined
          : nearestStation(game, a),
    door =
      target?.kind === "door"
        ? target.object
        : target
          ? undefined
          : nearbyDoor(game, a);
  // Staircases are entered by walking in; E never starts a flight.
  if (
    object &&
    distance(a, surfacePoint(a, object)) <
      Math.min(
        station ? distance(a, station) : Infinity,
        door ? distance(a, doorFrame(door)) : Infinity,
      )
  ) {
    if (toggleGrip(game, a, object.id)) {
      game.notice = `Gripping ${object.kind}. Move to drag and pivot; E releases.`;
      runLogs.record(game, "grip", { object: object.id });
    }
    return;
  }
  // A station wins only when it is nearer than the door in reach, or the
  // player can use it; a neighbour's terminal never hides a locked door.
  const usable = (s: typeof station) => {
    const e = s && game.encounters[s.encounter];
    return !!e && !(e.mode === "solo" && e.owner && e.owner !== "human");
  };
  const st =
    station &&
    (!door ||
      (distance(a, station) < distance(a, doorFrame(door)) && usable(station)))
      ? station
      : undefined;
  if (!st) {
    if (door?.field) {
      const before = a.keys ?? 0;
      const allowed = toggleDoor(game, a, door.id);
      if (allowed && (a.keys ?? 0) === before)
        game.notice =
          "This door opens for you: walk through. Zombies must break it.";
      persist();
      return;
    }
    if (door?.door && !door.door.latched)
      game.notice =
        "Push the door to swing it. E near its free end grips it for pulling; E releases.";
    else if (door) {
      const released = toggleDoor(game, a, door.id);
      runLogs.record(game, "door-interact", {
        door: door.id,
        released,
        latched: door.door?.latched,
        floor: a.floor,
        x: a.x,
        y: a.y,
      });
      game.notice = released
        ? "Latch released. Push the door to swing it open; E near the free end grips it for pulling."
        : "Door latch is out of reach. Move closer to release it.";
    }
    return;
  }
  const e = game.encounters[st.encounter];
  if (e.state === "consumed") {
    game.notice =
      "This station is already complete. Find an unused station for your next question.";
    return;
  }
  const pending = pendingQuestion();
  if (pending && pending !== e) {
    game.notice =
      "Your question is still being prepared. It will open in a moment.";
    return;
  }
  if (e.mode === "solo" && e.owner && e.owner !== "human") {
    game.notice =
      "This solo terminal belongs to another survivor. Find an unused station.";
    return;
  }
  closeTerminal();
  if (!claimStation(game, a, st.id)) {
    game.notice =
      "This physical station is occupied. Use another linked terminal.";
    return;
  }
  active = e.id;
  keys.clear();
  jumpRequested = false;
  lastQuestion = e.id;
  game.lastStudyEncounter = e.id;
  if (e.mode === "solo") e.owner = "human";
  // Start preparing first: an untouched preloaded practice question is
  // refreshed to the current track before the terminal presents it.
  const preparing = prepareQuestion(e);
  showEmbeddedTerminal(e);
  await preparing;
}
let workLogSignature = "";
let proposalSignature = "";
let outcomeSignature = "";
function eligibleForUI() {
  try {
    return eligible(roadmap, game.study);
  } catch (err) {
    game.notice = `Curriculum gate: ${String(err)}`;
    return undefined;
  }
}
watchStreamingReplies(() => renderTerminal());
/** The question and conversation appear in the game while Claude CLI serves it. */
function showEmbeddedTerminal(e: Encounter) {
  if (active !== e.id) return;
  $("#terminal").hidden = false;
  // The study view has no game layout for this class to rearrange.
  if (!game.studyWorkspace?.enabled)
    document.body.classList.add("terminal-open");
  renderTerminal(true);
}
/** A slow reply cannot kill the player, but typing and reading still carry risk. */
function waitingOnEmbeddedReply() {
  const e =
    status().mode === "claude-cli" && active
      ? game.encounters[active]
      : undefined;
  return (
    !!e &&
    (!!e.generation ||
      !!e.tutorRequests?.some(
        (j) => j.state === "pending" && j.provider === "claude-cli",
      ) ||
      e.submissions.some(
        (s) =>
          s.status === "pending" &&
          s.completionRequest?.provider === "claude-cli",
      ))
  );
}
function renderTerminal(force = false) {
  if (
    !active ||
    (game.paused && !game.studyWorkspace?.enabled) ||
    $("#terminal").hidden
  )
    return;
  const e = game.encounters[active];
  tab = terminalChannel(e);
  setText(
    "#conversation-title",
    tab === "tutor" ? "Terminal AI" : "Group chat",
  );
  setText(
    "#conversation-context",
    tab === "tutor"
      ? "Answer and reason here. Terminal AI assumes you already know this and asks one focused question at a time; a good answer can also settle the prerequisites it genuinely depends on. If you do not know something, say so: the gap is recorded for later study and the key is still granted. Access and a key are awarded when it marks the conversation complete."
      : "Discuss with your group. They can read the current answer draft. Chatting does not submit it.",
  );
  setText(
    "#answer-context",
    tab === "tutor"
      ? "This is your submission. Your tutor can help in the panel beside it."
      : "This is the group's submission draft. Use group chat beside it to discuss changes.",
  );
  const dialogue = e.mode === "solo";
  $("#terminal").classList.toggle("dialogue-terminal", dialogue);
  $("#legacy-answer").hidden = dialogue;
  const probeLine = probeSummary(e);
  const conceded = encounterGaps(game, e);
  $("#dialogue-status").hidden =
    !dialogue || (e.state !== "consumed" && !probeLine);
  setText(
    "#dialogue-status",
    e.state === "consumed"
      ? `${
          conceded.length
            ? `Solved with a recorded gap · personal access and key awarded. Recorded for later study: ${conceded.map((r) => r.facet.description).join("; ")}.`
            : "Solved · personal access and key awarded."
        } You can keep discussing the question.${probeLine ? ` ${probeLine}.` : ""}`
      : probeLine
        ? `Knowledge probe · ${probeLine}. Say so if you do not know something; the gap is recorded and the key still granted.`
        : "Work through the question with Terminal AI. Your answers stay in this conversation.",
  );
  const composer = $<HTMLTextAreaElement>("#chat-input");
  if (force || document.activeElement !== composer)
    composer.value = e.chatDraft ?? "";
  $("#saved-answer").hidden = !dialogue || !e.workspace;
  setText("#saved-answer-text", e.workspace);
  $("#submission-help").hidden = dialogue;
  const chatPending = (e.tutorRequests ?? []).some(
    (j) => j.state === "pending",
  );
  // A visible NPC-outcome reconstruction supplies the question for chat too.
  const discussable =
    !!e.problem ||
    (outcomeIsVisible(game, e, roadmap) &&
      !!e.outcomeInspection?.candidate?.problem);
  $<HTMLButtonElement>("#chat-form button").disabled =
    !discussable || (dialogue && chatPending);
  $("#chat-input").setAttribute(
    "aria-label",
    dialogue ? "Message Terminal AI" : "Message",
  );
  editor.dataset.mode = e.problem?.runtime ? "code" : "text";
  presentProblem(game, e, roadmap);
  setText(
    "#terminal-type",
    `${e.mode === "shared" ? "LINKED ROOM · ONE WORKSPACE" : e.questionRoom ? "ROOM QUESTION · PRIVATE ANSWER" : "INDIVIDUAL STATION"} / ${e.reward === "loot" ? "EQUIPMENT CACHE" : "PERSONAL STAIR ACCESS"}`,
  );
  setText(
    "#problem-title",
    e.problem?.title ??
      (e.state === "consumed"
        ? "Survivor-completed lock"
        : e.error
          ? "Connection unavailable"
          : "Connecting…"),
  );
  setText(
    "#terminal-provenance",
    e.problem?.provenance === "claude-cli"
      ? "Claude CLI"
      : e.problem?.provenance === "chatgpt-handoff"
        ? "ChatGPT handoff · Saved provider provenance"
        : e.problem?.provenance === "study-mode"
          ? "Study bridge · Saved provider provenance"
          : !e.problem && game.study.profile === "live"
            ? "Live study request · Awaiting a validated problem"
            : "Development practice · AI acceptance required · No academic credit",
  );
  if (e.problem?.contract.practice)
    $("#terminal-provenance").textContent +=
      " · Variety practice on another topic of this tier: knowledge is probed and recorded, but this is not the scheduled visit";
  const earlier = unfinishedEarlierVisits(game, e);
  if (earlier.runs)
    $("#terminal-provenance").textContent +=
      ` · Started in ${earlier.runs === 1 ? "an earlier run" : `${earlier.runs} earlier runs`} but not completed there, so it is asked again: a new run never inherits an unfinished lock. ${
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
    $("#terminal-provenance").textContent +=
      " · Resolved in your imported roadmap. Your original puzzle and draft remain playable; finishing grants gameplay rewards without another academic visit.";
  setHtml(
    $("#problem"),
    e.problem?.prompt !== undefined
      ? markdownToHtml(e.problem.prompt)
      : escape(
          e.state === "consumed"
            ? "Other survivors have already used this one-time terminal. No saved question is available for this simulated NPC-only outcome. It grants no human learning credit. Find an unused terminal to work toward your personal access."
            : (e.error ??
                "Generating a stable curriculum-scoped problem. You can leave immediately."),
        ),
  );
  if (force || document.activeElement !== editor || e.state === "consumed") {
    if (editor.value !== e.workspace) editor.value = e.workspace;
    editorRevision = e.revision;
    presentSharedWorkspace(game, e);
    if (force) {
      editor.scrollTop = e.scroll;
      editor.setSelectionRange(...e.selection);
    }
  }
  editor.readOnly = e.state === "consumed";
  const outcomeBox = $("#npc-outcome"),
    inspection = e.outcomeInspection;
  outcomeBox.hidden = !e.simulatedOutcome;
  if (e.simulatedOutcome) {
    const visible = outcomeIsVisible(game, e, roadmap);
    const ready =
      status().mode !== "development" &&
      game.study.profile === "live" &&
      status().capabilities.includes("materialize-outcome");
    const signature = `${encounterKey(e)}/${inspection?.state}/${inspection?.error}/${e.outcomeNotice}/${ready}/${visible}`;
    if (signature !== outcomeSignature) {
      setText(
        "#npc-outcome-status",
        inspection?.state === "applied" && !visible
          ? "Saved reconstruction deferred because its original outcome or current learning ceiling changed."
          : inspection?.state === "applied"
            ? `Reconstructed now through ${providerLabel(inspection.payload.provider)} from saved simulated NPC work and checked against the question. No historical execution or human learning credit.`
            : inspection?.state === "pending"
              ? "Preparing and checking the saved survivor solution. Survival continues."
              : (inspection?.error ??
                e.outcomeNotice ??
                (ready
                  ? "This lock was completed by simulated survivors. Inspect a consistent solution without changing its outcome."
                  : "Exact survivor solutions require a connected outcome-inspection capability. The simulated world result is preserved.")),
      );
      const button = $<HTMLButtonElement>("#inspect-npc-outcome");
      button.hidden = inspection?.state === "applied";
      button.disabled = !ready || inspection?.state === "pending";
      setNodeText(
        button,
        inspection && inspection.state !== "pending"
          ? "Retry saved solution inspection"
          : "Inspect survivor solution",
      );
      const body = $("#npc-outcome-body");
      body.innerHTML =
        visible && inspection?.candidate
          ? `<details open><summary>Saved survivor solution · reconstruction</summary><p>${escape(inspection.candidate.problem.title)}</p><pre>${escape(inspection.candidate.problem.prompt)}</pre><pre>${escape(inspection.candidate.solution)}</pre><p>${escape(inspection.validation!.feedback)}</p></details>`
          : "";
      outcomeSignature = signature;
    }
    if (inspection?.state === "applied") presentNpcOutcome(game, e, roadmap);
  }

  const proposals = e.proposals ?? [],
    candidateBox = $("#workspace-proposals");
  candidateBox.hidden = !proposals.length;
  const candidateSignature = `${encounterKey(e)}/${e.revision}/${e.state}/${proposals.map((p) => `${p.id}:${p.state}`).join(";")}`;
  if (candidateSignature !== proposalSignature) {
    const opened = new Set(
      [
        ...candidateBox.querySelectorAll<HTMLDetailsElement>("details[open]"),
      ].map((d) => d.dataset.proposal),
    );
    candidateBox.innerHTML = `<p>NPC edits are unvalidated. Applying records the NPC as author and does not award personal mastery. Prepared candidates may be applied and submitted by the NPC after you leave. Run or submit other candidates to check them.</p>${proposals
      .map((p) => {
        const name =
          game.survivors.find((a) => a.id === p.author)?.name ?? p.author;
        const stale = p.sourceRevision !== e.revision;
        return `<details data-proposal="${escape(p.id)}" ${opened.has(p.id) ? "open" : ""}><summary>${escape(name)} · candidate for v${p.sourceRevision} · ${p.state === "pending" && stale ? "stale" : p.state === "applied" ? `applied as v${p.appliedRevision}` : p.state}</summary><pre>${escape(`Remove at character ${p.patch.prefix}:\n${p.patch.removed || "(nothing)"}\n\nInsert:\n${p.patch.inserted || "(nothing)"}`)}</pre>${p.state === "pending" ? `<button data-apply-proposal="${escape(p.id)}" ${stale || e.state === "consumed" ? "disabled" : ""}>Apply NPC edit</button><button class="quiet" data-dismiss-proposal="${escape(p.id)}" ${e.state === "consumed" ? "disabled" : ""}>Dismiss candidate</button>${stale ? "<p>Workspace changed. Ask for a new proposal on the current revision.</p>" : ""}` : ""}</details>`;
      })
      .join("")}`;
    for (const detail of candidateBox.querySelectorAll<HTMLDetailsElement>(
      "details",
    )) {
      detail.ontoggle = () => {
        if (detail.open) {
          presentWorkspaceProposal(game, e, detail.dataset.proposal!);
          persist();
        }
      };
    }
    for (const button of candidateBox.querySelectorAll<HTMLButtonElement>(
      "button",
    )) {
      button.onclick = () => {
        try {
          reviewWorkspaceProposal(
            game,
            e,
            button.dataset.applyProposal ?? button.dataset.dismissProposal!,
            button.dataset.applyProposal ? "apply" : "dismiss",
          );
          persist();
          renderTerminal(true);
        } catch (err) {
          e.error = String(err);
          renderTerminal();
        }
      };
    }
    proposalSignature = candidateSignature;
  }
  setText(
    "#revision",
    `v${e.revision}${e.state === "consumed" ? " · consumed / read-only" : ""}`,
  );
  $<HTMLButtonElement>("#submit").disabled =
    !e.problem ||
    e.state === "consumed" ||
    e.submissions.some((s) => s.status === "pending");
  const disconnected =
    status().mode === "development" && e.state !== "consumed";
  $("#completion-connection").hidden = !disconnected;
  setText(
    "#completion-connection",
    disconnected
      ? "The study connection is unavailable. Your work is saved. Check that Claude CLI is installed and signed in, then retry."
      : "",
  );
  $("#retry-connection").hidden = !disconnected;
  const lastSubmission = e.submissions.at(-1),
    retryCompletion = $<HTMLButtonElement>("#retry-submission");
  retryCompletion.hidden =
    e.state === "consumed" || lastSubmission?.status !== "error";
  retryCompletion.disabled = e.submissions.some((s) => s.status === "pending");
  const runnable = canRunWorkspace(game, e, roadmap);
  const runButton = $<HTMLButtonElement>("#run-code");
  runButton.hidden = !runnable;
  runButton.disabled =
    e.executions?.some((job) => job.status === "pending") ?? false;
  setNodeText(
    runButton,
    runButton.disabled
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
  const previewJob = (e.executions ?? [])
      .slice()
      .reverse()
      .find(
        (job) =>
          job.preview &&
          /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(
            job.preview.dataUrl,
          ) &&
          job.preview.dataUrl.length <= 180025,
      ),
    previewHost = $("#execution-preview"),
    previewKey = previewJob
      ? `${e.id}/${previewJob.id}/${previewJob.preview!.sha256}`
      : "";
  previewHost.hidden = !previewJob;
  if (previewHost.dataset.capture !== previewKey) {
    previewHost.dataset.capture = previewKey;
    previewHost.replaceChildren();
    if (previewJob?.preview) {
      const image = document.createElement("img"),
        caption = document.createElement("figcaption");
      image.src = previewJob.preview.dataUrl;
      image.width = previewJob.preview.width;
      image.height = previewJob.preview.height;
      image.alt = `Captured React output for workspace revision ${previewJob.revision}`;
      setNodeText(
        caption,
        `Saved browser output · v${previewJob.revision}. Task checks run automatically; this image does not establish correctness or independent understanding.`,
      );
      previewHost.append(image, caption);
    }
  }
  const submission = submissionView(e);
  setText("#submission-status", submission.label);
  $("#submission-status").dataset.state = submission.tone;
  setText("#submission-help", submission.help);
  setHtml(
    $("#loot"),
    e.reward === "loot" && e.state === "consumed"
      ? `<p>Finite cache · choose within pack capacity</p>${e.loot.map((i) => `<button data-take="${escape(i.id)}">${escape(itemInfo(i.kind).label)} · ${i.weight} kg</button>`).join("")}`
      : "",
  );
  for (const el of document.querySelectorAll<HTMLButtonElement>("[data-take]"))
    el.onclick = () => {
      if (takeLoot(game, human(game), e.id, el.dataset.take!)) {
        persist();
        renderTerminal();
      } else game.notice = "Pack full or cache access not earned.";
    };
  presentMessages(game, e, tab);
  const latestCatchup = e.catchups?.at(-1);
  $("#catchup-status").hidden = tab !== "group" || !e.catchupNotice;
  setText("#catchup-status", e.catchupNotice ?? "");
  $("#retry-catchup").hidden =
    tab !== "group" ||
    !latestCatchup ||
    !["unavailable", "interrupted"].includes(latestCatchup.state);
  const work = e.history.filter((h) =>
    [
      "npc-thought",
      "npc-proposal",
      "workspace-view",
      "validation",
      "activity",
      "defense",
      "completion",
    ].includes(h.kind),
  );
  const log = $<HTMLDetailsElement>("#work-log");
  setText("#team-work-status", e.materializationNotice ?? "");
  $("#team-work-status").hidden = !e.materializationNotice;
  $("#retry-team-work").hidden = !(e.materializations ?? []).some((j) =>
    ["failed", "interrupted"].includes(j.state),
  );
  log.hidden = tab !== "group" || !work.length;
  setNodeText(
    log.querySelector("summary")!,
    `Recorded group work (${work.length})`,
  );
  if (tab === "group" && log.open) {
    presentWorkLog(game, e);
    const signature = `${encounterKey(e)}/${work.length}/${work.at(-1)?.seq}`;
    if (signature !== workLogSignature) {
      const body = $("#work-log-body"),
        bottom = body.scrollHeight - body.scrollTop - body.clientHeight < 30;
      body.innerHTML = `<p>Recorded ideas can be tentative. A work note is not an executed test or a validated answer.</p>${work.map((h) => `<p><strong>${escape(game.survivors.find((a) => a.id === h.author)?.name ?? h.author)} · ${Math.floor(h.at / 60)}:${String(Math.floor(h.at % 60)).padStart(2, "0")}</strong><br>${escape(h.text)}</p>`).join("")}`;
      if (bottom || !workLogSignature.startsWith(`${encounterKey(e)}/`))
        body.scrollTop = body.scrollHeight;
      workLogSignature = signature;
    }
  }
  const tutorStatus = $("#tutor-request-status");
  const savedRequests = tab === "tutor" ? e.tutorRequests : e.groupRequests;
  const chatError =
    e.error && !(savedRequests ?? []).some((j) => j.error === e.error)
      ? e.error
      : undefined;
  tutorStatus.hidden =
    !chatError &&
    !(savedRequests ?? []).some(
      (j) => j.state !== "applied" && j.state !== "superseded",
    );
  const tutorHtml =
    (chatError ? `<p>${escape(chatError)}</p>` : "") +
    (savedRequests ?? [])
      .filter((j) => j.state !== "applied" && j.state !== "superseded")
      .map(
        (j) =>
          `<p>${
            j.state === "pending"
              ? "Waiting for a reply. Survival continues."
              : escape(j.error ?? "Saved question interrupted.")
          }${j.state === "interrupted" ? `<button class="quiet" data-question-retry="${escape(j.id)}" data-channel="${tab}">Retry saved ${tab === "tutor" ? "private" : "group"} question</button>` : ""}</p>`,
      )
      .join("");
  if (writtenHtml.get(tutorStatus) !== tutorHtml) {
    setHtml(tutorStatus, tutorHtml);
    for (const button of tutorStatus.querySelectorAll<HTMLButtonElement>(
      "[data-question-retry]",
    ))
      button.onclick = () => {
        const pending =
          button.dataset.channel === "tutor"
            ? retryTutorRequest(game, e, button.dataset.questionRetry!, roadmap)
            : retryGroupRequest(game, e, button.dataset.questionRetry!);
        void pending.then(() => {
          persist();
          if (active === e.id) renderTerminal();
        });
        persist();
        renderTerminal();
      };
  }
  const messages = e[tab];
  const html =
    messages
      .map(
        (m) =>
          `<div class="message ${m.kind}"><strong>${escape(game.survivors.find((a) => a.id === m.author)?.name ?? m.author)}</strong><div class="message-body">${markdownToHtml(m.text)}</div></div>`,
      )
      .join("") +
    (tab === "tutor"
      ? (e.tutorRequests ?? [])
          .map((j) => (j.state === "pending" ? streamingReply(j) : undefined))
          .filter(Boolean)
          .map(
            (text) =>
              `<div class="message tutor"><strong>Terminal AI</strong><div class="message-body">${markdownToHtml(text!)}</div></div>`,
          )
          .join("")
      : "");
  if (writtenHtml.get($("#messages")) !== html) {
    setHtml($("#messages"), html);
    $("#messages").scrollTop = $("#messages").scrollHeight;
  }
}
editor.addEventListener("input", () => {
  if (!active) return;
  try {
    if (
      edit(game, game.encounters[active], editor.value, editorRevision, roadmap)
    )
      editorRevision = game.encounters[active].revision;
    persist();
  } catch (err) {
    game.notice = String(err);
    renderTerminal(true);
  }
});
$("#run-code").onclick = () => {
  if (!active) return;
  const e = game.encounters[active];
  void runWorkspace(game, e, roadmap)
    .then(() => {
      persist();
      if (active === e.id) renderTerminal();
    })
    .catch((error) => {
      game.notice = String(error);
    });
  persist();
  renderTerminal();
};
$("#retry-connection").onclick = () => {
  void checkBridge().then(() => {
    resumeQuestions();
    if (active) renderTerminal();
  });
};
$("#submit").onclick = () => {
  if (!active) return;
  const e = game.encounters[active];
  void submit(game, e, roadmap).then(() => {
    persist();
    renderTerminal();
  });
  renderTerminal();
  persist();
};
$("#retry-submission").onclick = () => {
  if (!active) return;
  const e = game.encounters[active],
    s = e.submissions.at(-1);
  if (!s || s.status !== "error") return;
  void retrySubmission(game, e, roadmap, s.id).then(() => {
    persist();
    if (active === e.id) renderTerminal();
  });
  renderTerminal();
  persist();
};
$("#chat-input").addEventListener("input", () => {
  if (!active) return;
  game.encounters[active].chatDraft =
    $<HTMLTextAreaElement>("#chat-input").value;
  persist();
});
$("#chat-input").addEventListener("keydown", (ev) => {
  const key = ev as KeyboardEvent;
  if (key.key === "Enter" && !key.shiftKey && !key.isComposing) {
    key.preventDefault();
    $<HTMLFormElement>("#chat-form").requestSubmit();
  }
});
$("#chat-form").onsubmit = (ev) => {
  ev.preventDefault();
  if (!active) return;
  const e = game.encounters[active],
    input = $<HTMLTextAreaElement>("#chat-input"),
    text = input.value;
  if (
    !text.trim() ||
    (tab === "tutor" && e.tutorRequests?.some((j) => j.state === "pending"))
  )
    return;
  input.value = "";
  e.chatDraft = "";
  void send(game, e, tab, text, roadmap).then(() => {
    persist();
    renderTerminal();
  });
  renderTerminal();
  persist();
};
$("#retry-catchup").onclick = () => {
  if (!active) return;
  const e = game.encounters[active];
  void retryChatCatchup(game, e).then(() => {
    if (active === e.id && tab === "group") renderTerminal();
    persist();
  });
  renderTerminal();
  persist();
};
$("#inspect-npc-outcome").onclick = () => {
  if (!active) return;
  const e = game.encounters[active],
    pending = inspectCompletedNpcWork(game, e, roadmap, !!e.outcomeInspection);
  renderTerminal();
  persist();
  if (pending)
    void pending.then(() => {
      if (active === e.id) renderTerminal();
      persist();
    });
};
$("#retry-team-work").onclick = () => {
  if (!active) return;
  const e = game.encounters[active];
  void materializeObservedWork(game, e, true)?.then(() => {
    if (active === e.id) renderTerminal();
    persist();
  });
  renderTerminal();
};
$("#work-log").ontoggle = () => {
  if (active) {
    renderTerminal();
    persist();
  }
};
$("#leave").onclick = leaveTerminal;
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
$("#curriculum-button").onclick = () => {
  openPanel("inspector", "#inspector-title");
  renderInspector();
};
function renderInspector() {
  renderCareerControls();
  const c = eligibleForUI();
  const readiness = (["PY", "PE"] as const)
    .map((track) => readinessHtml(game, roadmap, track))
    .join("");
  // A full rebuild: the sections below are appended to this fresh summary.
  $("#inspector-content").innerHTML = inspectorSummaryHtml(
    game,
    roadmap,
    c,
    status().detail,
  );
  $("#inspector-content").insertAdjacentHTML("beforeend", readiness);
  $("#inspector-content").insertAdjacentHTML(
    "beforeend",
    knowledgeHtml(game) + topicSpawnHtml(game, roadmap),
  );
  for (const box of $("#inspector-content").querySelectorAll<HTMLInputElement>(
    "[data-topic]",
  ))
    box.onchange = () => {
      setTopicEnabled(
        game.study,
        box.dataset.topicTrack as "PY" | "PE",
        box.dataset.topic!,
        box.checked,
      );
      persist();
    };
  renderEnvironmentObservations(
    $("#inspector-content"),
    game,
    roadmap,
    persistOrThrow,
    game.study.profile === "live" &&
      status().capabilities.includes("review-environment")
      ? (id, retry) => reviewEnvironmentObservation(game, roadmap, id, retry)
      : undefined,
    () => {
      for (const track of ["PY", "PE"] as const) {
        const node = document.querySelector(`[data-readiness="${track}"]`);
        if (node) node.outerHTML = readinessHtml(game, roadmap, track);
      }
    },
  );
  $("#inspector-content").insertAdjacentHTML(
    "beforeend",
    `<details><summary>Review an updated roadmap</summary><p>Compare a merged Markdown file with your saved progress. This preview checks ancestry and row conflicts. Request reconciliation through your connected provider, then review and explicitly adopt its complete proposal. Comparison alone leaves learning unchanged.</p><label class="file-label">Choose roadmap for review <input id="roadmap-review-file" type="file" accept=".md,text/markdown,text/plain"></label><div id="roadmap-review-result" role="status"></div></details>`,
  );
  $("#inspector-content").insertAdjacentHTML(
    "beforeend",
    '<div id="roadmap-adoption-controls"></div>',
  );
  const renderAdoption = (candidate?: string) =>
    renderRoadmapAdoption($("#roadmap-adoption-controls"), {
      getGame: () => game,
      r: roadmap,
      candidate,
      provider:
        status().mode === "development"
          ? "study-mode"
          : (status().mode as Provider),
      persist: persistOrThrow,
      reconcile:
        game.study.profile === "live" &&
        status().capabilities.includes("reconcile-roadmap")
          ? (text, id, captured) =>
              reconcileUploadedRoadmap(game, roadmap, text, id, async () => {
                await persistOrThrow(
                  "Local save failed before roadmap reconciliation",
                );
                captured?.();
              })
          : undefined,
      onAdopted: () => {
        // The adopt button is rebuilt away, so focus a stable target.
        renderInspector();
        $("#inspector-title").focus();
      },
    });
  renderAdoption();
  $<HTMLInputElement>("#roadmap-review-file").onchange = async () => {
    const input = $<HTMLInputElement>("#roadmap-review-file");
    const file = input.files?.[0];
    if (!file) return;
    const output = $("#roadmap-review-result"),
      requestGame = game;
    input.disabled = true;
    output.textContent = "Reviewing a snapshot of current saved progress…";
    try {
      if (file.size > 2_000_000)
        throw Error("Roadmap exceeds the 2 MB review limit");
      // Export preparation runs on a copy: review never allocates live IDs,
      // advances the export cache or changes an ongoing study session.
      const study = structuredClone(game.study);
      const local =
        study.profile === "live" && study.learner
          ? (
              await prepareRoadmapExport(
                roadmap,
                study.learner,
                study.roadmapExport,
              )
            ).content
          : roadmap.raw;
      const candidate = await file.text();
      const report = await reviewRoadmap(roadmap, local, candidate);
      if (game !== requestGame)
        throw Error(
          "Run changed during review; reopen the inspector to review current progress",
        );
      renderAdoption(
        report.ancestry === "identical" ||
          report.issues.some((i) => i.severity === "invalid")
          ? undefined
          : candidate,
      );
      output.innerHTML = `<p><strong>${report.issues.some((i) => i.severity === "invalid") ? "Invalid roadmap" : "Review required"}</strong> · revision ${report.candidateRevision} · ${escape(report.ancestry)}</p><p>${report.changes.length} changed progress rows · ${report.changes.filter((c) => c.conflict).length} conflicts</p>${report.issues.map((i) => `<p>${escape(i.detail)}</p>`).join("")}<details><summary>Progress differences</summary>${report.changes.map((c) => `<p><strong>${escape(c.key)}${c.conflict ? " · CONFLICT" : ""}</strong></p><pre>${escape(`Source: ${c.before ?? "(absent)"}\nLocal: ${c.local ?? "(absent)"}\nIncoming: ${c.incoming ?? "(absent)"}`)}</pre>`).join("") || "<p>No progress row changes.</p>"}</details>${
        report.resume
          ? `<details><summary>Saved resume claims</summary><p>Ratio position: ${report.resume.ratioPosition === undefined ? "needs reconciliation" : `${report.resume.ratioPosition + 1} of PY → PE → PE`}. ${report.resume.retentionRecords} exact retention records; ${report.resume.suspendedQueues} suspended queues.</p>${(
              ["PY", "PE"] as const
            )
              .map((t) => {
                const s = report.resume!.tracks[t];
                return `<p>${t}: Tier ${s.tier} / ${escape(s.phase)} / lap ${s.lap}; cleared through ${s.cleared}. Remaining: ${escape(s.remaining.join(", ") || "none")}.</p>`;
              })
              .join(
                "",
              )}<p>Parsed claims only. Semantic evidence reconciliation and adoption are still required before changing live study.</p></details>`
          : ""
      }<details><summary>File fingerprints</summary><pre>${escape(`Source: ${report.sourceHash}\nLocal snapshot: ${report.localHash}\nIncoming: ${report.candidateHash}`)}</pre></details><p>Comparison is a snapshot taken when review started. Recheck after further study before reconciling.</p>`;
      const differences = output.querySelector<HTMLDetailsElement>("details");
      if (differences)
        differences.ontoggle = () => {
          if (differences.open)
            presentRoadmapReview(
              game,
              `${report.localHash}/${report.candidateHash}/upload-diff`,
              report.changes
                .map(
                  (c) =>
                    `${c.key}\n${c.local ?? "(absent)"}\n${c.incoming ?? "(absent)"}`,
                )
                .join("\n"),
            );
        };
    } catch (err) {
      output.textContent = `Review rejected: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      input.disabled = false;
      input.value = "";
    }
  };

  const historical = game.study.learner?.historicalReviews ?? [];
  if (historical.length)
    $("#inspector-content").insertAdjacentHTML(
      "beforeend",
      `<details><summary>Historical facet reconciliations (${historical.length})</summary><p>Original observations retain their original IDs and dates. Reconciliation dates record review activity, not new human demonstrations. Earlier reviews remain in this audit.</p>${historical
        .map((m) => {
          const def = game.study.learner!.scopes[m.scopeId];
          const observed = def
            ? historicalRecords(roadmap, def.objectiveId, def.depth)
                .filter((r) => m.evidenceIds.includes(r.id))
                .map((r) => `${r.id} observed ${r.date}`)
                .join("; ")
            : "Source scope unavailable";
          return `<p><strong>${escape(m.scopeId)} · ${escape(m.facet)}</strong> · ${escape(m.outcome)}<br>${escape(observed)}<br><small>Reviewed ${escape(m.reviewedAt)} · ${escape(m.assessmentId)}</small></p>`;
        })
        .join("")}</details>`,
    );
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-assessment]",
  ))
    button.onclick = () => {
      const a = game.study.assessments.find(
        (a) => a.id === button.dataset.assessment,
      );
      if (!a) return;
      const e = [
        ...Object.values(game.encounters),
        ...game.study.archives,
      ].find((e) => a.id.startsWith(`assessment-${encounterKey(e)}-`));
      if (!e || button.disabled) return;
      button.disabled = true;
      const requestGame = game,
        pending = assess(game, e, roadmap, a.evidenceCutoffSequence, true);
      // Persist the captured request before its response, so closing/reloading
      // during a retry retains the same evidence and provider.
      void persist();
      void pending.finally(() => {
        void persist();
        button.disabled = false;
        setNodeText(
          button,
          requestGame.study.assessments.find((item) => item.id === a.id)
            ?.status ?? "Saved",
        );
      });
    };
  $("#progress-export").onclick = async () => {
    const button = $<HTMLButtonElement>("#progress-export"),
      requestGame = game;
    button.disabled = true;
    try {
      const prepared = await prepareRoadmapExport(
        roadmap,
        game.study.learner!,
        game.study.roadmapExport,
      );
      if (game !== requestGame)
        throw Error("Run changed during export; retry from the current run");
      game.study.roadmapExport = prepared;
      await persist();
      download("interview_prep_roadmap.md", prepared.content, "text/markdown");
      setText(
        "#progress-export-status",
        `Saved complete revision ${prepared.revision}. Original curriculum and historical evidence preserved. ${saveError || ""}`,
      );
    } catch (err) {
      setText(
        "#progress-export-status",
        `Export needs review: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      button.disabled = false;
    }
  };
  $("#source-export").onclick = () =>
    download("interview_prep_roadmap.md", roadmap.raw, "text/markdown");
  $("#evidence-export").onclick = () =>
    download(
      "zombie-escape-study-game-evidence.json",
      JSON.stringify(
        { study: game.study, encounters: game.encounters },
        null,
        2,
      ),
    );
}
$("#close-inspector").onclick = () => {
  closePanel("inspector");
};
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
  if ($("#settings").hidden) openPanel("settings", "#volume");
  else closePanel("settings");
  $<HTMLInputElement>("#volume").value = String(game.settings.volume);
  $<HTMLInputElement>("#captions").checked = game.settings.captions;
  $<HTMLInputElement>("#npc-voices").checked =
    game.settings.npcVoices !== false;
  $<HTMLInputElement>("#reduced").checked = game.settings.reducedFlash;
  $<HTMLInputElement>("#pass-all-doors").checked =
    game.settings.passAllDoors === true;
  $<HTMLSelectElement>("#game-view").value =
    game.settings.view ?? "first-person";
  $("#bridge-detail").textContent = status().detail;
  $("#audio-status").textContent = audio.error;
};
$("#settings-close").onclick = () => {
  closePanel("settings");
  persist();
  void checkBridge().then(() => {
    if (active) renderTerminal();
  });
};
$("#volume").oninput = () => {
  game.settings.volume = +$<HTMLInputElement>("#volume").value;
};
$("#captions").onchange = () => {
  game.settings.captions = $<HTMLInputElement>("#captions").checked;
};
$("#npc-voices").onchange = () => {
  game.settings.npcVoices = $<HTMLInputElement>("#npc-voices").checked;
  npcVoices.update(game);
  void persist();
};
$("#reduced").onchange = () => {
  game.settings.reducedFlash = $<HTMLInputElement>("#reduced").checked;
};
$("#pass-all-doors").onchange = () => {
  game.settings.passAllDoors = $<HTMLInputElement>("#pass-all-doors").checked;
  DEV.passAllDoors = game.settings.passAllDoors;
  void persist();
};
$("#game-view").onchange = () => {
  game.settings.view =
    $<HTMLSelectElement>("#game-view").value === "top-down"
      ? "top-down"
      : "first-person";
  viewFailedRun = "";
  keys.clear();
  jumpRequested = false;
  syncGameView();
  void persist();
};
$("#reconnect").onclick = () => {
  void checkBridge().then(() => {
    $("#bridge-detail").textContent = status().detail;
    resumeQuestions();
  });
};
$("#live-profile").onclick = async () => {
  if (status().mode === "development") {
    game.notice =
      "Check that Claude CLI is installed and signed in before starting a live profile.";
    setText("#live-profile-status", game.notice);
    return;
  }
  const learner = game.study.learner;
  if (!(await fresh($("#live-profile-status")))) return;
  const next = initialStudy(roadmap, "live");
  if (learner) next.learner = learner;
  next.archives = game.study.archives;
  next.environmentObservations = game.study.environmentObservations ??= [];
  next.environmentReviews = game.study.environmentReviews ??= [];
  next.roadmapReconciliations = game.study.roadmapReconciliations ??= [];
  next.roadmapAdoptionBackups = game.study.roadmapAdoptionBackups ??= [];
  next.assessments = game.study.assessments;
  next.topicAssessments = game.study.topicAssessments;
  next.roadmapExport = game.study.roadmapExport;
  activateCareerFocus(
    roadmap,
    next,
    game.study.careerFocus ?? "product-feature-owner",
  );
  game.study = next;
  // This is a fresh run: discard unissued development questions before live generation.
  for (const e of Object.values(game.encounters))
    if (e.questionRoom && e.problem?.provenance === "development") {
      delete e.problem;
      e.state = "available";
      e.workspace = "";
    }
  game.notice =
    "Live study profile: original curriculum state retained; development visits are not academic evidence.";
  persist();
  showPauseHome();
};
$("#export").onclick = () =>
  download("zombie-escape-study-game-run.json", encode(game));
$("#import").onchange = async () => {
  const file = $<HTMLInputElement>("#import").files?.[0];
  if (file) await restoreRunBackup(file);
};
async function restoreRunBackup(file: File) {
  const importStatus = document.getElementById("import-status");
  if (importStatus) importStatus.textContent = "";
  try {
    const next = recover(decode(await file.text()));
    activateCareerFocus(
      roadmap,
      next.study,
      next.study.careerFocus ??
        next.study.learner?.careerFocus ??
        "product-feature-owner",
    );
    closeTerminal();
    game = next;
    leaveSpectator();
    saveRecoveryError = "";
    lastQuestion = latestStudyEncounter(game);
    resumeQuestions();
    syncDisplayScale();
    completionCursor = 0;
    if (!(await persist())) {
      game.paused = true;
      game.notice =
        "Import opened in this tab but could not be saved. Export a full run backup before leaving, then retry the import when storage works.";
      const message = `${game.notice} ${saveError}`;
      if (importStatus) importStatus.textContent = message;
      const recoveryStatus = document.getElementById("save-recovery-status");
      if (recoveryStatus) recoveryStatus.textContent = message;
      return;
    }
    startCard();
    if (spectating(game)) {
      enterSpectator();
      if (pendingQuestion() || unfinishedLastQuestion(game, lastQuestion)) {
        $("#start-card").hidden = true;
        syncSpectatorBar();
      }
    }
    closePanel("settings");
    setPaused(true);
  } catch (err) {
    game.notice = `Import rejected: ${String(err)}`;
    if (importStatus) importStatus.textContent = game.notice;
    if (saveRecoveryError)
      setText("#save-recovery-status", `${saveRecoveryError} ${game.notice}`);
  }
}
/** WASD/arrow movement as a -1/0/1 vector (y grows downward). */
function moveInput(held: ReadonlySet<string>) {
  return {
    x:
      Number(held.has("KeyD") || held.has("ArrowRight")) -
      Number(held.has("KeyA") || held.has("ArrowLeft")),
    y:
      Number(held.has("KeyS") || held.has("ArrowDown")) -
      Number(held.has("KeyW") || held.has("ArrowUp")),
  };
}
const PAN_KEYS = [
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
];
window.addEventListener("keydown", (ev) => {
  // Study view never reveals the game through Escape or gameplay shortcuts.
  if (game.studyWorkspace?.enabled) return;
  // Let the design modal own its keyboard, including native Escape dismissal.
  if (document.querySelector<HTMLDialogElement>("#run-design-dialog")?.open)
    return;
  if (ev.code === "Escape") {
    ev.preventDefault();
    // Some browsers deliver Escape after the pointer-lock loss already paused us.
    if (performance.now() - pointerUnlockAt < 150) return;
    if (ev.repeat || restarting) return;
    if ($<HTMLDialogElement>("#pause-menu").open) {
      if (pausePanel) closePanel(pausePanel);
      else setPaused(false);
      return;
    }
    if (quitMenu) {
      if (!restarting) continueRun();
      return;
    }
    if (finalQuestion) {
      leaveTerminal();
      return;
    }
    if (spectating(game) && view) {
      // Esc toggles the run summary over the watched building.
      const card = $("#start-card");
      if (card.hidden) startCard();
      else {
        card.hidden = true;
        syncSpectatorBar();
        focusWorld();
      }
    } else setPaused(true);
    return;
  }
  if ($<HTMLDialogElement>("#pause-menu").open) return;
  if (spectating(game) && view) {
    if (ownsKeyboard(ev.target) || !PAN_KEYS.includes(ev.code)) return;
    ev.preventDefault();
    keys.add(ev.code);
    return;
  }
  if (game.status !== "playing" || game.paused || ownsKeyboard(ev.target))
    return;
  if (ev.code === "Tab" && firstPersonControls.isLocked && !lookUiVisible()) {
    // Esc opens the pause menu before keyboard focus can leave captured play.
    ev.preventDefault();
    return;
  }
  if (
    [
      "Space",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "KeyE",
    ].includes(ev.code)
  )
    ev.preventDefault();
  keys.add(ev.code);
  if (ev.repeat) return;
  if (ev.code === "KeyE") void interact();
  if (ev.code === "Space") {
    if (game.rules === "force-fields") {
      jumpRequested = true;
      return;
    }
    const a = human(game),
      { x, y } = moveInput(keys),
      n = Math.hypot(x, y);
    if (firstPersonPlaying()) a.heading = firstPersonControls.facing;
    else if (n) a.heading = { x: x / n, y: y / n };
    const jumped = vault(game, a);
    runLogs.record(game, "vault-attempt", {
      ok: jumped,
      floor: a.floor,
      x: a.x,
      y: a.y,
      heading: a.heading,
      obstacle: a.vault?.obstacle,
      reason: jumped
        ? "started"
        : a.vault
          ? "already-vaulting"
          : a.cooldown > 0
            ? "recovering"
            : "no-safe-faced-route",
    });
    if (!jumped && !a.vault) {
      jumpRequested = true;
      game.notice =
        "Jumping. Face a nearby barricade with a clear landing to vault it.";
    }
  }
});
window.addEventListener("keyup", (ev) => keys.delete(ev.code));
window.addEventListener("blur", () => {
  keys.clear();
  jumpRequested = false;
  persist();
});
window.addEventListener("pagehide", persist);
window.addEventListener("online", () => {
  if (!saveRecoveryError) void checkBridge().then(() => resumeQuestions());
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    keys.clear();
    jumpRequested = false;
    void persist();
  }
});
let completionCursor = 0;
function completionAssessments() {
  // Events are ordered and capped. Only inspect the newly appended suffix.
  let start = game.events.length;
  while (start > 0 && game.events[start - 1].seq > completionCursor) start--;
  let dispatched = false;
  for (const ev of game.events.slice(start)) {
    if (ev.type !== "completion") continue;
    const e = ev.encounter ? game.encounters[ev.encounter] : undefined;
    if (e?.contributors.includes("human")) {
      void assess(game, e, roadmap).then(persist);
      dispatched = true;
    }
  }
  completionCursor = game.seq;
  if (dispatched) void persist();
}
let inventorySignature = "";
let materializing: Promise<void> | undefined;
const FEED_EVENTS = new Set([
  "death",
  "completion",
  "climb",
  "breach",
  "field-key",
  "field-sealed",
  "helicopter",
  "board",
]);
/** The last seen key count per game, so a gain is announced once wherever
 * the player is looking, and a restored or new run is not. */
let rewardWatch: { game: string; keys: number } | undefined;
let rewardToastTimer: ReturnType<typeof setTimeout> | undefined;
let hudPulseTimer: ReturnType<typeof setTimeout> | undefined;
function announceReward() {
  const toast = $("#reward-toast");
  // Restart the entrance animation when a second key follows quickly.
  toast.hidden = true;
  void toast.offsetWidth;
  toast.hidden = false;
  clearTimeout(rewardToastTimer);
  rewardToastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 2400);
  const count = $("#hud-keys");
  count.classList.remove("gained");
  void count.offsetWidth;
  count.classList.add("gained");
  clearTimeout(hudPulseTimer);
  hudPulseTimer = setTimeout(() => count.classList.remove("gained"), 700);
  $("#dialogue-reward").hidden = false;
}
function watchReward(a: ReturnType<typeof human>) {
  const keys = a.keys ?? 0;
  if (!rewardWatch || rewardWatch.game !== game.id) {
    rewardWatch = { game: game.id, keys };
    return;
  }
  if (keys > rewardWatch.keys) announceReward();
  rewardWatch.keys = keys;
}
function ui() {
  setText("#npc-voice-status", npcVoices.message);
  $("#log-status").textContent =
    runLogs.error ||
    "Logs stay on this browser: newest 3 games, at most 256 KB each. Older diagnostics are deleted automatically; learning is retained.";
  syncLearningView(game.study);
  if (game.studyWorkspace?.enabled) {
    renderStudyStatus();
    renderStudyWorkspace();
    renderTerminal();
    return;
  }
  if (!game.paused) completionAssessments();
  const a = human(game);
  watchReward(a);
  document.body.classList.toggle("surge", game.surge.state === "active");
  document.body.classList.toggle("reduced", game.settings.reducedFlash);
  $("#bridge-label").textContent =
    `${status().label} · ${game.study.profile ?? "development"} profile`;
  const shown = spectating(game) && view ? view.floor : a.floor;
  $("#floor-label").textContent = floorTitle(shown);
  $("#floor-name").textContent = game.floors[shown].name;
  $("#health").textContent = String(Math.ceil(a.hp));
  $("#health-fill").style.width = `${a.hp}%`;
  // The HUD overlays the canvas; write to it only when a value changes so the
  // overlay layer is not repainted every frame.
  setText("#hud-health", String(Math.ceil(a.hp)));
  const fill = `${Math.round(a.hp)}%`;
  if ($("#hud-health-fill").style.width !== fill)
    $("#hud-health-fill").style.width = fill;
  setText(
    "#hud-keys",
    `${a.keys ?? 0} ${(a.keys ?? 0) === 1 ? "key" : "keys"}`,
  );
  $("#alive").textContent = String(
    game.survivors.filter((a) => a.alive && !a.escaped).length,
  );
  $("#rescued").textContent = String(game.stats.rescued);
  $("#lost").textContent = String(game.stats.deaths);
  $("#notice").textContent = saveError || game.notice;
  $("#next-title").textContent =
    game.status === "escaped"
      ? "Extraction confirmed."
      : game.status === "dead"
        ? "Escape attempt ended."
        : a.floor === CONFIG.floors
          ? "Hold for extraction."
          : a.y > 28
            ? "Make it inside."
            : a.access.includes(a.floor)
              ? "Find the upward stairs."
              : "Buy yourself some time.";
  $("#next-description").textContent =
    game.status === "escaped" || game.status === "dead"
      ? "Review your saved work or begin another run."
      : game.time < spawnGrace(game)
        ? game.rules === "force-fields"
          ? `Swarm begins in ${Math.ceil(spawnGrace(game) - game.time)}s. Green-lit doors open for you. E uses a key on a red-lit door. The rear study hall stays open.`
          : `Zombies spawn in ${Math.ceil(spawnGrace(game) - game.time)}s. E releases a door latch; move to push it open.`
        : a.floor === CONFIG.floors
          ? "Reach the helipad and press E while a helicopter is boarding. Four seats per trip."
          : a.access.includes(a.floor)
            ? "Your credential is personal. Walk into the staircase at the north edge of the floor. Space jumps; watch for broken guards."
            : game.rules === "force-fields"
              ? "Solve a solo terminal for personal stair access and one key. Other entrance passes run out; the rear study hall stays open. E uses a key on a red-lit door. Green fields still block zombies. Space jumps."
              : "Find a glowing terminal. Solo work or meaningful shared-room defense can earn your credential. Walk into light furniture to push it; E grips heavier pieces to drag and pivot. Space jumps; facing a barricade vaults it.";
  $("#pickup").textContent =
    game.status === "escaped"
      ? `PICKUP ${game.helicopter.trip} · EXTRACTED`
      : game.status === "dead"
        ? ""
        : a.floor === CONFIG.floors
          ? game.time < game.helicopter.until
            ? `BOARDING · ${4 - game.helicopter.passengers.length} seats · ${Math.ceil(game.helicopter.until - game.time)}s`
            : `NEXT PICKUP · ${Math.ceil(game.helicopter.next - game.time)}s`
          : "";
  setText("#hud-pickup", $("#pickup").textContent ?? "");
  if ($("#hud-pickup").hidden !== !$("#pickup").textContent)
    $("#hud-pickup").hidden = !$("#pickup").textContent;
  $("#weight").textContent =
    game.rules === "force-fields"
      ? `${a.keys ?? 0} KEYS`
      : `${a.inventory.reduce((n, i) => n + i.weight, 0)} / ${CONFIG.capacity} KG`;
  document.body.classList.toggle("force-fields", game.rules === "force-fields");
  // Starting a live run stays available once connected; only the recheck is not.
  $("#reconnect").hidden = status().mode === "claude-cli";
  const sig = JSON.stringify([a.inventory, a.keys, game.rules]);
  if (sig !== inventorySignature) {
    inventorySignature = sig;
    $("#inventory").innerHTML =
      game.rules === "force-fields"
        ? "" // Keys are shown in the in-frame HUD.
        : a.inventory
            .map(
              (it) =>
                `<button class="item" data-use="${escape(it.id)}" title="${escape(itemInfo(it.kind).detail)}"><strong>${escape(itemInfo(it.kind).label)}</strong><small>${it.charges} use${it.charges > 1 ? "s" : ""} · ${it.weight}kg<br>${escape(itemInfo(it.kind).short)}</small></button>`,
            )
            .join("") ||
          '<p class="muted">Pack empty. Optional caches hold equipment.</p>';
    if (a.inventory.length)
      $("#inventory").insertAdjacentHTML(
        "beforeend",
        `<details class="equipment-guide"><summary>Equipment effects</summary>${[...new Set(a.inventory.map((it) => it.kind))].map((kind) => `<p><strong>${escape(itemInfo(kind).label)}</strong> — ${escape(itemInfo(kind).detail)}</p>`).join("")}</details>`,
      );
    for (const b of document.querySelectorAll<HTMLButtonElement>("[data-use]"))
      b.onclick = () => {
        useItem(game, a, b.dataset.use!);
        persist();
      };
  }
  const c = eligibleForUI();
  $("#schedule").textContent = c
    ? `1 PY : 2 PE · Next: ${c.track}${c.review ? " retention review" : ""} · D${c.depth}`
    : "Curriculum gate awaiting verified evidence";
  const feed: string[] = [];
  for (let i = game.events.length - 1; i >= 0 && feed.length < 5; i--) {
    const e = game.events[i];
    if (!FEED_EVENTS.has(e.type)) continue;
    feed.push(
      `<p><span>${Math.floor(e.at / 60)}:${String(Math.floor(e.at % 60)).padStart(2, "0")}</span> ${escape(e.text.slice(0, 110))}</p>`,
    );
  }
  setHtml(
    $("#event-feed"),
    feed.join("") || '<p class="muted">The stairwell radio is quiet.</p>',
  );
  const caption = game.settings.captions ? audio.caption : "";
  if ($("#world-caption").textContent !== caption)
    $("#world-caption").textContent = caption;
  if (!game.paused && !materializing) {
    const pending = autonomousNpcWork(game, roadmap);
    if (pending) {
      materializing = pending;
      void pending.finally(() => {
        materializing = undefined;
        if (active) renderTerminal();
        persist();
      });
    }
  }
  if (!game.paused) prepareNextQuestion(game, roadmap);
  if (active) {
    const e = game.encounters[active];
    if (!game.paused && !materializing) {
      const pending = materializeObservedWork(game, e);
      if (pending) {
        materializing = pending;
        void pending.finally(() => {
          materializing = undefined;
          if (active === e.id) renderTerminal();
          persist();
        });
      }
    }
    renderTerminal();
  }
  if (game.status !== "playing" && running) {
    running = false;
    audio.stop();
    preserveRunLearning(game);
    const unfinished =
      pendingQuestion() ?? unfinishedLastQuestion(game, lastQuestion);
    releaseStation(human(game));
    keys.clear();
    jumpRequested = false;
    $("#terminal").hidden = true;
    document.body.classList.remove("terminal-open");
    finalQuestion = false;
    void persist();
    enterSpectator();
    if (unfinished) {
      $("#start-card").hidden = true;
      syncSpectatorBar();
    } else startCard();
  }
}
const framePerformance = new FramePerformance();
let latestFramePerformance: ReturnType<FramePerformance["sample"]>;
let performanceWindow = 0;
let benchmarkDrawCalls = 0;
let benchmarkMinActors = Infinity;
let latestMinActors = Infinity;
function frame(time: number) {
  const frameStarted = performance.now();
  const measuring = simulationActive(game) && !game.paused;
  let simulationMs = 0,
    persistMs = 0,
    uiMs = 0,
    steps = 0;
  const elapsed = Math.min((time - last) / 1000, 0.2);
  last = time;
  DEV.passAllDoors = game.settings.passAllDoors === true;
  syncGameView();
  if (firstPersonPlaying()) {
    if (lookUiVisible()) firstPersonControls.release();
    firstPersonControls.turn(keys, elapsed);
  }
  if (
    simulationActive(game) &&
    !game.paused &&
    !quitMenu &&
    !waitingOnEmbeddedReply()
  ) {
    acc += elapsed;
    let count = 0;
    while (acc >= 1 / 30 && count++ < 6) {
      const focused =
        game.status !== "playing" || ownsKeyboard(document.activeElement);
      const { x, y } = focused ? { x: 0, y: 0 } : moveInput(keys);
      const stepStarted = performance.now();
      const input =
        firstPersonPlaying() && !focused
          ? firstPersonInput(firstPersonControls.yaw, keys)
          : firstPersonPlaying()
            ? { x: 0, y: 0 }
            : { x, y };
      step(game, 1 / 30, {
        ...input,
        grab: false,
        stairWalk: firstPersonPlaying(),
        jump: !focused && jumpRequested,
      });
      jumpRequested = false;
      simulationMs += performance.now() - stepStarted;
      steps++;
      acc -= 1 / 30;
    }
    // A study-only encounter has no physical station to stay near.
    if (active && game.status === "playing" && !game.studyWorkspace?.enabled) {
      const e = game.encounters[active];
      if (
        !game.floors[human(game).floor].stations.some(
          (s) =>
            s.encounter === e.id && canReachStation(game, human(game), s, 2.2),
        )
      )
        closeTerminal();
    }
    if (game.time - lastSave > 3) {
      // Times only the synchronous part (diagnostic capture and save kickoff).
      const persistStarted = performance.now();
      persist();
      persistMs += performance.now() - persistStarted;
    }
  }
  // Spatial listener pose follows looking as well as walking. This also stops
  // pending speech immediately when pausing or the study view disables gameplay.
  audio.update(
    game,
    firstPersonPlaying() ? firstPersonControls.look() : undefined,
  );
  npcVoices.update(game);
  if (view && spectating(game) && !game.paused) {
    // Held keys pan the free camera over the live floor.
    const pan = (16 * elapsed) / view.zoom,
      { x, y } = moveInput(keys);
    if (x || y)
      setView({
        ...view,
        focus: { x: view.focus.x + x * pan, y: view.focus.y + y * pan },
      });
  }
  const renderStarted = performance.now();
  syncGameView();
  if (!game.studyWorkspace?.enabled) {
    if (firstPersonView) {
      try {
        firstPersonView.render(
          game,
          firstPersonControls.yaw,
          firstPersonControls.pitch,
          elapsed,
          steps > 0 || game.paused || lookUiVisible(),
        );
      } catch {
        useClassicFallback();
      }
      if (firstPersonPlaying()) {
        // Discover tiles every frame even when the orientation map is cached.
        rememberVisibleTiles(game);
        if (time - lastMinimap >= 100) {
          renderMinimap(canvas, game);
          lastMinimap = time;
        }
      } else {
        // A failed 3D view immediately restores Classic.
        render(canvas, game);
      }
    } else render(canvas, game, spectating(game) ? view : undefined);
  }
  firstPersonHud.update(
    game,
    firstPersonPlaying(),
    firstPersonControls.isLocked,
    lookUiVisible() || ownsKeyboard(document.activeElement),
    time,
    firstPersonControls.yaw,
    firstPersonControls.pitch,
  );
  const renderMs = performance.now() - renderStarted;
  if (time - lastUI > 200) {
    const uiStarted = performance.now();
    ui();
    uiMs += performance.now() - uiStarted;
    lastUI = time;
  }
  if (measuring) {
    benchmarkDrawCalls = Math.max(
      benchmarkDrawCalls,
      firstPersonView?.drawCalls ?? 0,
    );
    benchmarkMinActors = Math.min(
      benchmarkMinActors,
      firstPersonView?.visibleActors ?? 0,
    );
    const report = framePerformance.sample(game.id, time, {
      simulationMs,
      renderMs,
      totalMs: performance.now() - frameStarted,
      steps,
      persistMs,
      uiMs,
    });
    if (report) {
      latestMinActors = benchmarkMinActors;
      benchmarkMinActors = Infinity;
      latestFramePerformance = report;
      performanceWindow++;
      runLogs.record(game, "performance", {
        ...report,
        zombies: game.zombies.filter((z) => z.hp > 0).length,
        actors: game.survivors.filter((a) => a.alive && !a.escaped).length,
      });
    }
  } else {
    framePerformance.reset();
    benchmarkMinActors = latestMinActors = Infinity;
  }
  requestAnimationFrame(frame);
}
// Agent diagnostics stay out of the player menu. Browser acceptance fixtures
// use these hooks and module-level engine APIs in synthetic browser contexts.
Object.assign(window, {
  __deadAir: {
    get game() {
      return game;
    },
    get view() {
      return view;
    },
    roadmap,
    interact,
    setLook(yaw: number, pitch: number) {
      firstPersonControls.setLook(yaw, pitch);
    },
    look() {
      return firstPersonControls.look();
    },
    /** Read/reset only presentation diagnostics in synthetic agent pages. */
    renderPerformance(reset = false) {
      if (reset) {
        framePerformance.reset();
        latestFramePerformance = undefined;
        benchmarkDrawCalls = 0;
        benchmarkMinActors = latestMinActors = Infinity;
        performanceWindow = 0;
      }
      return {
        window: performanceWindow,
        report: latestFramePerformance,
        drawCalls: firstPersonView?.drawCalls ?? 0,
        maxDrawCalls: benchmarkDrawCalls,
        visibleActors: firstPersonView?.visibleActors ?? 0,
        minVisibleActors: latestMinActors,
        firstPerson: !!firstPersonView,
      };
    },
    /** Exercise the same unexpected-lock-loss path even in browsers that
     * refuse pointer lock. Intentional UI releases use release() instead. */
    unlockLook() {
      firstPersonControls.unlock();
    },
    /** Agent-only entry: diagnostics have no control in the player interface. */
    openAgentMenu() {
      document.body.classList.add("agent-tools");
      if ($<HTMLDialogElement>("#pause-menu").open) showPauseHome();
      else setPaused(true);
    },
    /** The newest three games' diagnostics, read by agents, never a download. */
    logs() {
      runLogs.capture(game, true);
      return runLogs.export();
    },
  },
});
startCard();
let restoreStudyView = !!game.studyWorkspace?.enabled;
try {
  restoreStudyView ||= localStorage.getItem(STUDY_VIEW_KEY) === "1";
} catch {}
if (restoreStudyView) setStudyMode(true);
else if (game.paused) setPaused(true);
if (!restoreStudyView && spectating(game)) {
  enterSpectator();
  if (pendingQuestion() || unfinishedLastQuestion(game, lastQuestion)) {
    $("#start-card").hidden = true;
    syncSpectatorBar();
  }
}
resumeQuestions();
ui();
requestAnimationFrame(frame);
