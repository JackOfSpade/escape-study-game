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
import {
  bindThread,
  carriedUnanswered,
  carriedVisits,
  isInactiveVisit,
  openThread,
  resendableRequest,
  segmentCount,
} from "./question-thread";
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
import { connectionSteps } from "./connection-steps";
import { moveToLiveStudy } from "./live-study";
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
  generatingEncounter,
  generationProgress,
} from "./ai";
import { AudioDirector } from "./audio";
import { eligible, initialStudy, syncLearningView } from "./curriculum";
import { doorFrame } from "./doors";
import { displayScale } from "./display-scale";
import {
  endLoop,
  epilogueForNewGame,
  prepareCatastrophe,
} from "./escape-prepare";
import { escapeFrame, escapeInteract, escapeJournal } from "./escape-runtime";
import { createEscapeState, loopReset } from "./escape-state";
import { startTask, taskIndicator } from "./escape-tasks";
import { taskAtStation, takeEscapeDecision } from "./escape-terminal";
import type { VoiceGender } from "./escape-types";
import { installPlayerChat } from "./player-chat";
import {
  board,
  canReachStation,
  claimStation,
  extractionFloor,
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
import { isOpenSite, siteFormOf } from "./open-site";
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
import {
  rememberVisibleTiles,
  render,
  renderMinimap,
  setPointer,
} from "./render";
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
import {
  enterRegion,
  exitSiteReached,
  prefetchArea,
  regionEdgeCrossed,
  restampSites,
  setAreaDesigner,
  setAreaFactory,
  setDesignedAreaFactory,
  siteLoadingDue,
  stampReadySites,
  takeAreaSwitch,
} from "./areas";
import { buildDesignedArea, startAreaDesign } from "./area-design";
import { escapeRead } from "./director";
import { crossRegionEdges, tickParkedAreas } from "./parked-areas";
import { readableInFront } from "./readables";
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
import {
  TITLE_CARD_FONTS,
  type RunTitleCard,
  type RunTitleCardStyle,
  type SavedRunDesign,
} from "./run-design-contract.mjs";
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
  const study = initialStudy(roadmap, "live");
  activateRunFocus(study);
  const preview = createGame(seed, roadmap, study);
  preview.preparingRun = true;
  return preview;
}
// Apply the role profile before the factory builds the run.
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
moveToLiveStudy(game, roadmap);
activateCareerFocus(
  roadmap,
  game.study,
  game.study.careerFocus ??
    game.study.learner?.careerFocus ??
    "product-feature-owner",
);
// Areas are their own games, built from the seed alone; the roadmap stays here.
setAreaFactory((seed) => createGame(seed, roadmap, undefined));
// A newly reached area is designed for its place (a rocket is built as a
// rocket); the seed-only factory above stays the fallback when design fails.
setAreaDesigner((stub, signal) => startAreaDesign(stub, { roadmap, signal }));
// Every entry rebuilds the area fresh from its saved design, so a reload or a
// Restart gets the same place back rather than the office fallback.
setDesignedAreaFactory((seed, saved) =>
  buildDesignedArea(seed, roadmap, saved),
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
// A closing tab gets a full save: its synchronous local copy lands even when
// the IndexedDB write cannot finish before the page goes away.
window.addEventListener("pagehide", () => void persist());
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
function persist() {
  return checkpoint(false);
}
async function checkpoint(background: boolean) {
  persistLook();
  // A placeholder world must never overwrite a checkpoint that failed to load
  // or recover. Only a validated, explicitly imported backup releases this guard.
  if (saveRecoveryError) return false;
  runLogs.capture(game);
  const token = ++saveToken;
  const at = game.time;
  lastSave = at;
  try {
    await save(game, { background });
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
let autosavePending = false;
let autosaveCount = 0;
/** Every this many autosaves (about 30 s) is a full save: its design check and
 * synchronous mirror bound how old the last known-good local copy can get. */
const FULL_AUTOSAVE_EVERY = 10;
/** Autosave time spent between frames, attributed to the next frame's report. */
let idlePersistMs = 0;
/** Autosave in the browser's idle time, not inside a frame's budget. The world
 * is between simulation steps there, so the snapshot is still consistent. */
function scheduleAutosave() {
  if (autosavePending) return;
  autosavePending = true;
  const run = () => {
    autosavePending = false;
    const started = performance.now();
    void checkpoint(autosaveCount++ % FULL_AUTOSAVE_EVERY !== 0);
    idlePersistMs += performance.now() - started;
  };
  if (typeof requestIdleCallback === "function")
    requestIdleCallback(run, { timeout: 1000 });
  else setTimeout(run, 0);
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
      } else {
        questionChanged();
        // A request that failed may mean Claude went away; the terminal shows the steps.
        if (active === e.id) await recheckConnection();
      }
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
$("#generate-run").onclick = () => void newGame($("#pause-save-status"));
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
  () => ({
    game,
    starting: studyStarting,
    saving: studySaving,
    saveError,
    terminalOpen: !!active,
  }),
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
  // Reopen an unfinished question rather than starting another.
  const unfinished = workspaceQuestion(game);
  if (unfinished && !active) {
    openStudyTerminal(unfinished);
    renderStudyWorkspace();
    renderStudyStatus();
    return;
  }
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
  void (async () => {
    // Old saves have no escape state; the first game asks for the voice once.
    if (!game.escape) {
      const gender = await askGender();
      if (!gender || game.status !== "ready") return;
      game.escape = createEscapeState(game, { gender, seed: game.seed });
      try {
        await prepareCatastrophe(game);
      } catch (error) {
        game.notice = `${game.notice} The catastrophe could not be prepared; the offline plan stays. (${String(error)})`;
      }
      await persist();
    }
    startRun();
  })();
}
/** Designs already summarised on this page: one "run-design" entry per game. */
const loggedRunDesigns = new Set<string>();
/** What a design was built from, read defensively: it is validated blueprint
 * data, but an old save may lack any of it. */
function recordRunDesign(g: Game) {
  if (loggedRunDesigns.has(g.id)) return;
  loggedRunDesigns.add(g.id);
  const saved = g.design as unknown as
    { source?: unknown; design?: unknown } | undefined;
  const design = saved?.design as
    | {
        title?: unknown;
        setting?: {
          venue?: unknown;
          surroundings?: {
            ground?: unknown;
            neighbors?: unknown;
            weather?: unknown;
          };
        };
      }
    | undefined;
  const setting = design?.setting,
    surroundings = setting?.surroundings,
    spec = (
      g.escape as unknown as
        { catastrophe?: { title?: unknown; behaviours?: unknown } } | undefined
    )?.catastrophe,
    behaviours = (Array.isArray(spec?.behaviours) ? spec.behaviours : []) as {
      kind?: unknown;
      count?: unknown;
    }[],
    surfaces = (
      g.floors[0] as unknown as
        { environment?: { surfaces?: unknown } } | undefined
    )?.environment?.surfaces;
  runLogs.record(g, "run-design", {
    title: design?.title ?? null,
    source: saved?.source ?? null,
    form: siteFormOf(design),
    venue: setting?.venue ?? null,
    neighbors: surroundings?.neighbors ?? null,
    ground: surroundings?.ground ?? null,
    weather: surroundings?.weather ?? null,
    catastrophe: spec
      ? {
          title: spec.title ?? null,
          behaviours: behaviours.map((b) => b.kind ?? null),
          hunters: behaviours.reduce(
            (sum, b) => sum + (b.kind === "hunter" ? Number(b.count) || 0 : 0),
            0,
          ),
        }
      : null,
    exteriorSigns: Array.isArray(surfaces)
      ? (surfaces as { scope?: unknown; role?: unknown }[]).filter(
          (s) =>
            s.scope === "exterior" &&
            (s.role === "storefront-sign" || s.role === "street-sign"),
        ).length
      : null,
  });
}
function startRun() {
  document.body.classList.remove("agent-tools");
  game.status = "playing";
  game.paused = false;
  running = true;
  quitMenu = false;
  leaveSpectator();
  audio.start();
  audio.update(game);
  $("#start-card").hidden = true;
  $("#start-card").classList.remove("title-card");
  quietNotice();
  focusWorld(true);
  recordRunDesign(game);
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
/** The level a restart replays: the current design and seed, with no model call.
 * Saves from before this rule, or a design this build rejects, get a new one. */
function currentRunChoice(g: Game): RunChoice | undefined {
  if (!g.design || g.preparingRun) return undefined;
  const choice = { seed: g.seed, saved: structuredClone(g.design) };
  try {
    createGame(choice.seed, roadmap, structuredClone(g.study), choice.saved);
    return choice;
  } catch {
    return undefined;
  }
}
/** A restart first archives this run's learning and writes it durably; a new
 * run starts only once that save succeeded, or on a second press after a
 * failed save. It replays the current level unless asked to generate a new one,
 * and only a completed generation changes what later restarts replay. */
let designingNextRun = false;
async function fresh(
  statusLine?: HTMLElement,
  {
    generate = false,
    gender,
  }: { generate?: boolean; gender?: VoiceGender } = {},
) {
  if (saveRecoveryError) {
    if (statusLine) statusLine.textContent = saveRecoveryError;
    return false;
  }
  if (restarting || designingNextRun) return false;
  designingNextRun = true;
  const beforeDesign = game;
  let choice: RunChoice | undefined, reused: RunChoice | undefined;
  try {
    firstPersonControls.release();
    keys.clear();
    jumpRequested = false;
    reused = generate ? undefined : currentRunChoice(game);
    choice = reused ?? (await chooseRunDesign(game, roadmap));
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
  // A replay is the next loop: the old loop ends and its plan carries over.
  if (reused && previous.escape) endLoop(previous, "restarted");
  // Encounter drafts are archived; a new run never inherits a nearly completed lock.
  delete previous.study.pending;
  game = newPlayableGame(choice.seed, previous.study, choice.saved);
  game.settings = previous.settings;
  if (!reused && gender) {
    // Only a generated game gets escape state, and only once its catastrophe
    // is prepared (or has fallen back to the offline plan).
    game.escape = createEscapeState(game, { gender, seed: game.seed });
    try {
      await prepareCatastrophe(game);
    } catch (error) {
      game.notice = `${game.notice} The catastrophe could not be prepared; the offline plan stays. (${String(error)})`;
    }
  } else if (previous.escape) {
    game.escape = loopReset(previous.escape);
    // The fresh world has none of the buildings the last loop reached: stamp
    // every place that was already built before the loop starts again.
    restampSites(game);
  }
  // A restart ends any loading screen the last loop was showing.
  hidePreparing();
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
  if ((await persist()) && !reused) finishRunDesign(previous.id, choice);
  return true;
}
/** The last loop's epilogue is read before generation and stays on screen
 * (plain text) while the new building and its catastrophe are prepared. */
function showEpilogue(text: string) {
  const panel = document.getElementById("epilogue-panel");
  const body = document.getElementById("epilogue-text");
  if (!panel || !body) return;
  body.textContent = text;
  panel.hidden = false;
  document.body.classList.add("epilogue-open");
}
function hideEpilogue() {
  const panel = document.getElementById("epilogue-panel");
  const body = document.getElementById("epilogue-text");
  if (body) body.textContent = "";
  if (!panel) return;
  panel.hidden = true;
  document.body.classList.remove("epilogue-open");
}
let genderPrompt: Promise<VoiceGender | undefined> | undefined;
/** The player's voice gender, asked at a new game and once at the first run. */
function askGender(): Promise<VoiceGender | undefined> {
  genderPrompt ??= new Promise((resolve) => {
    const dialog = document.querySelector<HTMLDialogElement>("#gender-dialog");
    if (!dialog) {
      resolve("female");
      return;
    }
    let settled = false;
    const finish = (value: VoiceGender | undefined) => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      genderPrompt = undefined;
      resolve(value);
    };
    dialog.addEventListener("cancel", (event) => {
      // A new game needs a voice: cancelling leaves the run as it was.
      event.preventDefault();
      finish(undefined);
    });
    document
      .getElementById("gender-man")
      ?.addEventListener("click", () => finish("male"));
    document
      .getElementById("gender-woman")
      ?.addEventListener("click", () => finish("female"));
    if (!dialog.open) dialog.showModal();
    document
      .querySelector<HTMLButtonElement>("#gender-woman")
      ?.focus({ preventScroll: true });
  });
  return genderPrompt;
}
let newGameBusy = false;
/** New game: the last loop's epilogue, the player's voice, then a generated
 * design whose catastrophe is sealed before Start appears. */
async function newGame(statusLine?: HTMLElement) {
  if (newGameBusy || saveRecoveryError) return false;
  newGameBusy = true;
  const before = game;
  try {
    let epilogue: string | undefined;
    try {
      epilogue = await epilogueForNewGame(game);
    } catch {
      epilogue = undefined;
    }
    if (epilogue) showEpilogue(epilogue);
    const gender = await askGender();
    if (!gender || game !== before) {
      if (statusLine && !gender) statusLine.textContent = "New game cancelled.";
      return false;
    }
    return await fresh(statusLine, { generate: true, gender });
  } finally {
    hideEpilogue();
    newGameBusy = false;
  }
}
/** The notice text stays in the DOM for assistive tech and checks, but is only
 * shown for a few seconds after it changes. Whatever was already there when a
 * run starts (its opening story, now on the title card) is never flashed. */
const NOTICE_SHOWN_MS = 6000;
let noticeSeen: string | undefined;
let noticeUntil = 0;
function syncNotice() {
  const text = saveError || game.notice;
  const el = $("#notice");
  el.textContent = text;
  // A faded message is finished with, so the same message set again (another
  // full-pack attempt, say) counts as new and is shown again.
  if (
    !saveError &&
    noticeUntil &&
    performance.now() >= noticeUntil &&
    game.status === "playing" &&
    text === noticeSeen
  ) {
    game.notice = "";
    noticeSeen = "";
    noticeUntil = 0;
    el.textContent = "";
  } else if (noticeSeen === undefined) noticeSeen = text;
  else if (text !== noticeSeen) {
    noticeSeen = text;
    noticeUntil = text ? performance.now() + NOTICE_SHOWN_MS : 0;
  }
  el.classList.toggle("shown", !!saveError || performance.now() < noticeUntil);
}
function quietNotice() {
  noticeSeen = saveError || game.notice;
  noticeUntil = 0;
}
/** Typography for a design that predates designer-chosen title cards. */
const DEFAULT_TITLE_CARD: RunTitleCard = {
  title: { font: "space-grotesk", color: "#e8f1ee", size: 64 },
  story: { font: "dm-sans", color: "#a7bcbb", size: 18 },
};
const loadedTitleFonts = new Set(["space-grotesk", "dm-sans"]);
function titleFont(style: RunTitleCardStyle) {
  const font = TITLE_CARD_FONTS[style.font] ?? TITLE_CARD_FONTS["dm-sans"];
  if (!loadedTitleFonts.has(style.font) && TITLE_CARD_FONTS[style.font]) {
    loadedTitleFonts.add(style.font);
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(font.family).replace(/%20/g, "+")}&display=swap`;
    document.head.append(link);
  }
  return `"${font.family}", ${font.fallback}`;
}
/** The run opens on a black screen with the designer's title and backstory
 * in the designer's own typography, and the Start button beneath. */
function titleCardHtml(saved: SavedRunDesign) {
  const d = saved.design,
    card = d.titleCard ?? DEFAULT_TITLE_CARD;
  const style = (s: RunTitleCardStyle, vw: number) =>
    `font-family:${escape(titleFont(s))};color:${s.color};font-size:min(${s.size}px, ${vw}vw)`;
  return `<div class="title-card-inner"><h2 class="title-card-title" style="${style(card.title, 11)}">${escape(d.title)}</h2><div class="title-card-story" style="${style(card.story, 5)}"><p>${escape(d.premise)}</p><p>${escape(d.opening)}</p></div><button id="start">Start game ↗</button><small class="agent-only">${escape(status().detail)}</small></div>`;
}
function startCard() {
  endHumanLoop(game);
  const card = $("#start-card");
  card.classList.remove("title-card");
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
  if (game.status === "ready" && game.design && !game.preparingRun) {
    card.classList.add("title-card");
    card.innerHTML = titleCardHtml(game.design);
  } else if (game.status === "ready")
    card.innerHTML = `${game.preparingRun ? '<span class="eyebrow">A NEW ESCAPE</span>' : ""}<h2>${game.design ? escape(game.design.design.title) : "The dead are<br>on your heels."}</h2><p>${game.design ? escape(game.design.design.premise) : "Twenty survivors. Four floors. Four seats.<br>Choose your route. Learn your way out."}</p>${game.preparingRun ? "<p>Claude will prepare your game session before play.</p>" : ""}<button id="start">${game.preparingRun ? "Prepare game ↗" : "Start game ↗"}</button><small class="agent-only">${escape(status().detail)}</small>`;
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
  view = clampView(next, game);
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
    floors.innerHTML = spectatorFloors(game)
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
  const box = canvas.getBoundingClientRect();
  setPointer(ev.clientX - box.left, ev.clientY - box.top);
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
canvas.addEventListener("pointerleave", () => setPointer());
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
/** A station by id, wherever in the building it stands. */
function stationById(id: string) {
  for (const floor of game.floors) {
    const found = floor.stations.find((s) => s.id === id);
    if (found) return found;
  }
  return undefined;
}
/** The escape task performed at a station, whatever its state (a finished one
 * no longer answers `taskAtStation`, but its title is still needed). */
function taskAt(stationId: string) {
  return game.escape?.tasks.find((t) => t.stationId === stationId);
}
/**
 * The unanswered encounter an escape task's station moves to next, so one
 * station carries every segment and then the next question without closing.
 * It clones the worked terminal's identity and clears its answer, conversation
 * and thread binding; the thread (or a fresh question) fills it in again.
 */
function nextTaskEncounter(e: Encounter, segment: number): Encounter {
  const fresh: Encounter = {
    ...structuredClone(e),
    id: `${e.id}-p${segment}`,
    state: "available",
    owner: "human",
    revision: 0,
    workspace: "",
    history: [],
    group: [],
    tutor: [],
    submissions: [],
    contributors: [],
    recentSpeakers: [],
    npcProgress: 0,
    loot: [],
    chatCursor: 0,
    chatOpen: false,
    scroll: 0,
    selection: [0, 0],
  };
  delete fresh.thread;
  delete fresh.problem;
  delete fresh.workspaceBase;
  delete fresh.accepted;
  delete fresh.generation;
  delete fresh.pendingGeneration;
  delete fresh.error;
  delete fresh.problemPresentedSequence;
  delete fresh.problemPresentedAt;
  delete fresh.chatDraft;
  return fresh;
}
/**
 * Rebind a task's station to a fresh encounter and open it there. `continue`
 * resumes the unfinished thread on its next segment; `next-question` asks for
 * the next question on the same station once the thread is done. The terminal
 * itself stays where it is and is only re-rendered.
 */
function bindTaskStation(
  stationId: string,
  old: Encounter,
  decision: "continue" | "next-question",
) {
  const station = stationById(stationId);
  if (!station) return;
  const segment = game.study.thread?.segment ?? 0;
  const fresh = nextTaskEncounter(old, segment);
  game.encounters[fresh.id] = fresh;
  station.encounter = fresh.id;
  active = fresh.id;
  lastQuestion = fresh.id;
  game.lastStudyEncounter = fresh.id;
  // The thread resumes its next segment here; when it cannot, the station asks
  // for the next question rather than leaving a dead terminal.
  const resumed = decision === "continue" && continueThread(fresh);
  if (!resumed) void startConnectedQuestion(fresh);
  showEmbeddedTerminal(fresh);
  persist();
}
/**
 * Apply what a completed segment decided for this terminal: stay for the next
 * segment, carry on to the next question, or close with the finished task.
 * Called from the per-frame UI pass, so it runs once per decision.
 */
function applyEscapeDecision() {
  const decision = takeEscapeDecision(game);
  if (!decision) return;
  const a = human(game);
  const station = a.station ? stationById(a.station) : undefined;
  const task = station ? taskAt(station.id) : undefined;
  const old = station ? game.encounters[station.encounter] : undefined;
  if (!station || !task || !old || active !== old.id) return;
  if (decision === "close") {
    closeTerminal();
    game.notice = `${task.title}: done.`;
    persist();
    return;
  }
  bindTaskStation(station.id, old, decision);
}
/** Opening a task's station starts its task; the HUD shows the counter. */
function beginEscapeTask(stationId: string) {
  if (!game.escape) return;
  const task = taskAtStation(game, stationId);
  if (!task) return;
  startTask(task);
  syncEscapeHud();
}
/**
 * An escape station whose task is still being worked reopens on its next
 * segment instead of reporting that the terminal is complete.
 */
function reopenTaskStation(stationId: string): boolean {
  if (!game.escape) return false;
  const station = stationById(stationId);
  const task = station ? taskAtStation(game, station.id) : undefined;
  const old = station ? game.encounters[station.encounter] : undefined;
  if (!station || !old || !task) return false;
  if (!claimStation(game, human(game), station.id)) return false;
  startTask(task);
  syncEscapeHud();
  // A thread still in progress resumes; a finished one asks the next question.
  bindTaskStation(
    station.id,
    old,
    openThread(game) ? "continue" : "next-question",
  );
  return true;
}
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
  questionWait = undefined;
  revealPending = undefined;
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
  // The study view is built around the open question; leaving it there only
  // stranded the learner, so the button exists only in the game view.
  $("#leave").hidden = inStudy;
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
/** Continue the unfinished question at the terminal being opened, and resend
 * a turn a reload or relay restart cut off. Saved at once, so the binding and
 * the resend survive the next crash too. */
function continueThread(e: Encounter, resend = true) {
  const bound = bindThread(game, e);
  if (bound) {
    const draft = carriedUnanswered(game, e);
    if (draft) e.chatDraft = draft;
    // Resend only over a live connection, so the one automatic retry is not spent offline.
    const job = resend ? resendableRequest(e) : undefined;
    if (job) {
      job.resent = true;
      void retryTutorRequest(game, e, job.id, roadmap).then(() => {
        persist();
        if (active === e.id) renderTerminal();
      });
    }
    void persist();
  }
  return bound;
}
/** Opens an encounter in the study view's terminal. It has no physical station. */
function openStudyTerminal(e: Encounter) {
  if (active && active !== e.id) closeTerminal();
  continueThread(e);
  lastQuestion = e.id;
  game.lastStudyEncounter = e.id;
  active = e.id;
  finalQuestion = false;
  showEmbeddedTerminal(e);
}
/** After death the last tutor question stays answerable; no station is
 * claimed and engine rewards skip the dead human. */
function openFinalQuestion(e: Encounter) {
  continueThread(e);
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
/**
 * F in an escape game: try or use the object (or door) in front of the player.
 * The director answers with what the player learns, and may turn it into a
 * task, a route or a place. E keeps its grip, door and terminal behaviour.
 */
function engage() {
  if (!game.escape || game.status !== "playing" || game.paused) return;
  const a = human(game);
  const yaw = firstPersonPlaying()
    ? firstPersonControls.yaw
    : Math.atan2(a.heading.y, a.heading.x);
  // Writing in front of the player (a note, sign or screen) is read first.
  const readable = readableInFront(game, yaw);
  if (readable) {
    if (escapeRead(game, readable)) void persist();
    return;
  }
  const target = firstPersonPlaying()
    ? lookTarget(game, firstPersonControls.yaw)
    : undefined;
  const object =
    target?.kind === "grip" || target?.kind === "door"
      ? target.object
      : (nearestGrip(game, a) ?? nearbyDoor(game, a));
  if (!object) {
    game.notice = "There is nothing within reach to try or read.";
    return;
  }
  const label = (object as { label?: string }).label?.trim() || object.kind;
  if (escapeInteract(game, { kind: "attempt", subjectId: object.id, label }))
    void persist();
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
  if (board(game, a)) return;
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
          "Door open: walk through and it closes behind you. Zombies must break it.";
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
    // An escape task's station carries on with its next segment instead.
    if (reopenTaskStation(st.id)) return;
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
  // An escape task performed at this station starts as its terminal opens.
  beginEscapeTask(st.id);
  // A recent check is trusted and confirmed behind; an old one is confirmed
  // first, so a signed-out CLI never claims the terminal or sends a request.
  if (performance.now() - connectionCheckedAt > OPEN_CONNECTION_POLL_MS)
    await recheckConnection();
  else void recheckConnection();
  if (active !== e.id) return;
  if (connectionLocked(e)) {
    continueThread(e, false);
    showEmbeddedTerminal(e);
    return;
  }
  continueThread(e);
  const preparing = startConnectedQuestion(e);
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
/** Solo ownership starts here, so walking away from a locked terminal claims nothing. */
function startConnectedQuestion(e: Encounter) {
  delete e.error;
  if (
    e.mode === "solo" &&
    !finalQuestion &&
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
  return !!embeddedWait();
}
/** A question that took at least this long to arrive waits behind a reveal
 * button, because the player may have stepped away during the wait. A quick
 * answer is shown directly: the player is evidently still there. */
const REVEAL_AFTER_MS = 3000;
/** The open terminal whose question the player is waiting for, and since when. */
let questionWait: { encounter: string; since: number } | undefined;
/** The terminal whose arrived question is held until the player reveals it. */
let revealPending: string | undefined;
/** Whether this terminal's arrived question is still held for the player.
 * Holding also defers issuance, so the presentation time is when it was seen. */
function holdsReveal(e: Encounter) {
  const unseen =
    !!e.problem &&
    e.problemPresentedSequence === undefined &&
    e.state !== "consumed" &&
    !game.studyWorkspace?.enabled;
  if (revealPending === e.id) {
    if (unseen) return true;
    revealPending = undefined;
  }
  if (
    unseen &&
    questionWait?.encounter === e.id &&
    Date.now() - questionWait.since >= REVEAL_AFTER_MS
  ) {
    revealPending = e.id;
    questionWait = undefined;
    return true;
  }
  return false;
}
function revealQuestion() {
  revealPending = undefined;
  questionWait = undefined;
  renderTerminal(true);
  $<HTMLTextAreaElement>("#chat-input").focus({ preventScroll: true });
  void persist();
}
/** Why the simulation is held for Claude, if it is. */
function embeddedWait():
  "locked" | "question" | "reveal" | "reply" | undefined {
  if (terminalConnectionLocked()) return "locked";
  const e =
    status().mode === "claude-cli" && active
      ? game.encounters[active]
      : undefined;
  if (!e) return undefined;
  if (generatingEncounter(game, e)) {
    if (questionWait?.encounter !== e.id)
      questionWait = { encounter: e.id, since: Date.now() };
    return "question";
  }
  if (holdsReveal(e)) return "reveal";
  return e.tutorRequests?.some(
    (j) => j.state === "pending" && j.provider === "claude-cli",
  ) ||
    e.submissions.some(
      (s) =>
        s.status === "pending" &&
        s.completionRequest?.provider === "claude-cli",
    )
    ? "reply"
    : undefined;
}
const GENERATION_STEPS = [
  "Connected to Claude",
  "Claude is writing a curriculum-scoped problem",
  "Checking the problem against your roadmap",
  "Opening it in this terminal",
];
const generationSeen = new Map<string, number>();
let generationRenderedAt = 0;
/** Live stages and elapsed time while Claude writes this terminal's question.
 * The request is a single call, so the stages are the client's own. */
function generationHtml(e: Encounter) {
  const source = generatingEncounter(game, e);
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
  const paused = embeddedWait() === "question";
  return `<div class="generation-progress" role="status"><div class="generation-bar" aria-hidden="true"><span></span></div><ol class="generation-steps">${steps}</ol><p class="generation-elapsed">Elapsed <strong>${clock}</strong>${seconds >= 60 ? " · Still working: a validated problem can take a few minutes." : ""}</p><p class="generation-note">${paused ? "The game is paused while Claude writes and stays paused until you reveal the question, so the wait costs you nothing. " : ""}You can leave immediately; the request is saved.</p></div>`;
}
/** Mark the held game beside the terminal and keep the progress clock live. */
let replyPauseShown: string | undefined;
function syncReplyPause(time: number) {
  const open =
    !!active &&
    !$("#terminal").hidden &&
    document.body.classList.contains("terminal-open");
  const wait = open ? embeddedWait() : undefined;
  const key = wait ?? "";
  if (key !== replyPauseShown) {
    replyPauseShown = key;
    const box = $("#reply-pause");
    box.hidden = !wait;
    setText(
      "#reply-pause-detail",
      wait === "question"
        ? "Waiting for Claude to write your question. Zombies, survivors and timers are frozen."
        : wait === "reveal"
          ? "Your question is ready. Zombies, survivors and timers stay frozen until you reveal it in the terminal."
          : wait === "reply"
            ? "Waiting for Claude's reply. Zombies, survivors and timers are frozen."
            : "Connect Claude to continue. Zombies, survivors and timers are frozen.",
    );
  }
  if (wait === "question" && time - generationRenderedAt >= 500) {
    generationRenderedAt = time;
    renderTerminal();
  }
}
/** The question has arrived after a long wait: keep the game held and the
 * question covered until the player chooses to reveal it. */
function renderRevealGate(e: Encounter) {
  setText(
    "#terminal-type",
    `${e.mode === "shared" ? "LINKED ROOM · ONE WORKSPACE" : e.questionRoom ? "ROOM QUESTION · PRIVATE ANSWER" : "INDIVIDUAL STATION"} / QUESTION READY`,
  );
  setText("#problem-title", "Your question is ready");
  setText(
    "#terminal-provenance",
    "Game paused · Zombies, survivors and timers stay frozen until you reveal it",
  );
  const steps = GENERATION_STEPS.map(
    (label) => `<li class="done">${escape(label)}</li>`,
  ).join("");
  const problem = $("#problem");
  setHtml(
    problem,
    `<div class="question-ready" role="status"><ol class="generation-steps">${steps}</ol><p class="question-ready-note">Claude finished writing your question. The game stays paused until you reveal it, and resumes the moment you do.</p><button type="button" id="reveal-question">Reveal question and resume ▸</button></div>`,
  );
  const button = $<HTMLButtonElement>("#reveal-question");
  button.onclick = revealQuestion;
  $<HTMLTextAreaElement>("#chat-input").disabled = true;
  if (
    !ownsKeyboard(document.activeElement) ||
    document.activeElement === $("#chat-input")
  )
    button.focus({ preventScroll: true });
}
function renderTerminal(force = false) {
  if (
    !active ||
    (game.paused && !game.studyWorkspace?.enabled) ||
    $("#terminal").hidden
  )
    return;
  const e = game.encounters[active];
  const locked = connectionLocked(e);
  $("#terminal-connect").hidden = !locked;
  $("#terminal-body").hidden = locked;
  if (locked) {
    setText("#terminal-type", "TERMINAL LOCKED / GAME PAUSED");
    setText("#problem-title", "Connect Claude to use this terminal");
    setText(
      "#terminal-provenance",
      "The game is paused while you do this. Your work is saved. Leave the terminal to keep playing without it.",
    );
    renderConnectionSteps();
    return;
  }
  const composer = $<HTMLTextAreaElement>("#chat-input");
  if (holdsReveal(e)) {
    renderRevealGate(e);
    return;
  }
  composer.disabled = false;
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
  if (force || document.activeElement !== composer)
    composer.value = e.chatDraft ?? "";
  $("#saved-answer").hidden = !dialogue || !e.workspace;
  setText("#saved-answer-text", e.workspace);
  $("#submission-help").hidden = dialogue;
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
            : "Earlier practice question · No academic credit",
  );
  if (e.problem?.contract.practice)
    $("#terminal-provenance").textContent +=
      " · Variety practice on another topic of this tier: knowledge is probed and recorded, but this is not the scheduled visit";
  if (e.thread && e.problem) {
    const count = segmentCount(e.problem);
    const goal = e.problem.segments?.[e.thread.segment]?.goal;
    $("#terminal-provenance").textContent += isInactiveVisit(game, e)
      ? " · This question continues at the terminal you opened most recently; this one is read-only history."
      : count > 1
        ? ` · Part ${e.thread.segment + 1} of ${count}${goal ? `: ${goal.replace(/[.!?]+$/, "")}` : ""}. Finishing this part earns a key; the next terminal continues the question.`
        : carriedVisits(game, e).length
          ? " · Continued question: your earlier conversation and progress are kept."
          : "";
  }
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
      : (e.state !== "consumed" && !e.error && generationHtml(e)) ||
          escape(
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
  const carried = tab === "tutor" ? carriedVisits(game, e) : [];
  const carriedHtml = carried
    .map(
      (v) =>
        `<div class="message system carried"><strong>Earlier visit · part ${v.segment + 1}${v.completed ? " · completed" : ""}</strong></div>` +
        v.messages
          .map(
            (m) =>
              `<div class="message ${m.kind} carried"><strong>${escape(game.survivors.find((a) => a.id === m.author)?.name ?? m.author)}</strong><div class="message-body">${markdownToHtml(m.text)}</div></div>`,
          )
          .join(""),
    )
    .join("");
  const html =
    carriedHtml +
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
$("#terminal-connect-retry").onclick = () => void recheckConnection();
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
  ) {
    runLogs.record(game, "terminal-message-blocked", {
      channel: tab,
      reason: !text.trim() ? "empty" : "tutor-pending",
    });
    return;
  }
  input.value = "";
  e.chatDraft = "";
  runLogs.record(game, "terminal-message", {
    channel: tab,
    chars: text.length,
  });
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
    moveToLiveStudy(next, roadmap);
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
  // While escorted the NPC walks the player; Space is the break-free gesture.
  if (human(game).escortedBy) return { x: 0, y: 0 };
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
  if (ev.code === "KeyJ") {
    journalOpen = !journalOpen;
    syncEscapeHud();
    return;
  }
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
  if (ev.code === "KeyF" && game.escape) engage();
  if (ev.code === "Space") {
    // Escorted? Space is the break-free gesture, not a jump or a vault.
    if (breakFree(game)) return;
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
let journalOpen = false;
const endedLoops = new WeakSet<Game>();
/** Death or escape ends the loop once, whichever path notices the status first. */
function endHumanLoop(g: Game) {
  if (!g.escape) return;
  if (g.status !== "dead" && g.status !== "escaped") return;
  if (endedLoops.has(g)) return;
  endedLoops.add(g);
  endLoop(g, g.status === "escaped" ? "escaped" : "died");
}
/** Journal panel (J, hidden by default) and the running task's indicator line. */
function syncEscapeHud() {
  const state = game.escape;
  const panel = document.getElementById("journal-panel");
  const list = document.getElementById("journal-lines");
  if (panel) panel.hidden = !journalOpen || !state;
  if (panel && !panel.hidden && list && state) {
    const lines = escapeJournal(game);
    const signature = lines.join("\n");
    if (list.dataset.signature !== signature) {
      list.dataset.signature = signature;
      list.textContent = "";
      for (const line of lines) {
        const p = document.createElement("p");
        p.textContent = line;
        list.append(p);
      }
    }
  }
  const indicator = document.getElementById("task-indicator");
  const task = state?.tasks.find((t) => t.state === "in-progress");
  if (indicator) {
    indicator.hidden = !task;
    const text = task ? taskIndicator(task) : "";
    if (indicator.textContent !== text) indicator.textContent = text;
  }
}
let escortPress = { at: 0, count: 0 };
/** Three Space presses within two seconds break free of an NPC's escort. */
function breakFree(g: Game): boolean {
  const a = human(g);
  if (!a.escortedBy) return false;
  const now = performance.now();
  escortPress =
    now - escortPress.at > 2000
      ? { at: now, count: 1 }
      : { at: now, count: escortPress.count + 1 };
  if (escortPress.count >= 3) {
    a.escortedBy = undefined;
    escortPress = { at: 0, count: 0 };
    g.notice = "You pull free of your escort.";
    void persist();
  }
  return true;
}
function ui() {
  applyEscapeDecision();
  syncEscapeHud();
  setText("#npc-voice-status", npcVoices.message);
  $("#log-status").textContent =
    runLogs.error ||
    "Logs stay on this browser: newest 3 games, at most 256 KB each. Older diagnostics are deleted automatically; learning is retained.";
  syncLearningView(game.study);
  if (game.studyWorkspace?.enabled) {
    renderStudyStatus();
    renderStudyWorkspace();
    if (active) watchTerminalConnection();
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
  $("#floor-label").textContent = floorTitle(shown, game);
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
  syncNotice();
  // The pickup level of this run: a building's roof, an open site's ground.
  const pickupFloor = extractionFloor(game);
  $("#next-title").textContent =
    game.status === "escaped"
      ? "Extraction confirmed."
      : game.status === "dead"
        ? "Escape attempt ended."
        : a.floor === pickupFloor
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
          ? `Swarm begins in ${Math.ceil(spawnGrace(game) - game.time)}s. Press E to open a green-lit door; it closes behind you. E uses a key on a red-lit door.`
          : `Zombies spawn in ${Math.ceil(spawnGrace(game) - game.time)}s. E releases a door latch; move to push it open.`
        : a.floor === pickupFloor
          ? isOpenSite(game)
            ? "Reach the ground pad and press E while a helicopter is boarding. Four seats per trip."
            : "Reach the helipad and press E while a helicopter is boarding. Four seats per trip."
          : a.access.includes(a.floor)
            ? "Your credential is personal. Walk into the staircase at the north edge of the floor. Space jumps; watch for broken guards."
            : game.rules === "force-fields"
              ? "Solve a solo terminal for personal stair access and one key. Other entrance passes run out; the rear study hall stays available. Press E to open a door; a door someone else opened still stops you without access. E uses a key on a red-lit door. Space jumps."
              : "Find a glowing terminal. Solo work or meaningful shared-room defense can earn your credential. Walk into light furniture to push it; E grips heavier pieces to drag and pivot. Space jumps; facing a barricade vaults it.";
  $("#pickup").textContent =
    game.status === "escaped"
      ? `PICKUP ${game.helicopter.trip} · EXTRACTED`
      : game.status === "dead"
        ? ""
        : a.floor === pickupFloor
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
    if (!game.paused) watchTerminalConnection();
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
    endHumanLoop(game);
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
/** A full-screen loading overlay, shown only while something is generated. */
type Preparing = { kind: "site" | "region"; id: string; name: string };
let preparing: Preparing | undefined;
function showPreparing(next: Preparing): void {
  preparing = next;
  const label =
    next.kind === "site"
      ? `Building ${next.name}…`
      : `Travelling to ${next.name}…`;
  const text = $("#world-loading-text");
  if (text.textContent !== label) text.textContent = label;
  $("#world-loading").hidden = false;
}
function hidePreparing(): void {
  preparing = undefined;
  const overlay = $("#world-loading");
  if (!overlay.hidden) overlay.hidden = true;
}
/** Retry the place being prepared, then resume the paused simulation. */
function resumeWhenPrepared(): void {
  const asked = preparing;
  if (!asked) return;
  if (!game.escape) {
    hidePreparing();
    return;
  }
  if (asked.kind === "site") {
    // A stamp is synchronous: the same frame that finishes it resumes play.
    stampReadySites(game);
    const due = siteLoadingDue(game);
    if (!due || due.id !== asked.id) hidePreparing();
    return;
  }
  if (enterRegion(game, asked.id) !== "entered") return;
  hidePreparing();
  const next = takeAreaSwitch(game);
  if (next) {
    if (active) closeTerminal();
    game = next;
    persist();
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
  // A place being built or reached pauses the world behind a loading screen.
  resumeWhenPrepared();
  if (
    simulationActive(game) &&
    !game.paused &&
    !preparing &&
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
    // The escape director advances once per simulated frame block.
    if (game.escape && steps > 0) {
      escapeFrame(game, steps / 30);
      // Ready near places join the shared floors: a stamp is safe mid-frame.
      stampReadySites(game);
      // Parked regions keep living, and hunters follow at the matching edges.
      tickParkedAreas(game, steps / 30);
      crossRegionEdges(game);
      // A site the player reached is built before they can walk in.
      const due = siteLoadingDue(game);
      if (due) {
        prefetchArea(game, due.id);
        showPreparing({ kind: "site", id: due.id, name: due.name });
      }
      // Reaching the edge of the world travels to the region beyond it.
      const region = regionEdgeCrossed(game);
      if (region && enterRegion(game, region.id) === "preparing") {
        showPreparing({ kind: "region", id: region.id, name: region.name });
      }
      // An exit site ends the loop when the human walks into it.
      const exit = exitSiteReached(game);
      if (exit) {
        game.status = "escaped";
        game.endedAt = game.time;
      }
    }
    // A region switch prepared by the director swaps the active game.
    const next = game.escape ? takeAreaSwitch(game) : undefined;
    if (next) {
      if (active) closeTerminal();
      game = next;
      persist();
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
    if (game.time - lastSave > 3) scheduleAutosave();
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
  syncReplyPause(time);
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
  );
  const renderMs = performance.now() - renderStarted;
  if (time - lastUI > 200) {
    const uiStarted = performance.now();
    ui();
    uiMs += performance.now() - uiStarted;
    lastUI = time;
  }
  // Times only the synchronous part (diagnostic capture and save kickoff).
  persistMs += idlePersistMs;
  const betweenFramesMs = idlePersistMs;
  idlePersistMs = 0;
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
      totalMs: performance.now() - frameStarted + betweenFramesMs,
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
// In-world player speech is installed once for the life of the page; the host
// reads the current game, so restarts and imports need no re-install.
installPlayerChat({
  game: () => game,
  yaw: () => firstPersonControls.yaw,
  keyboardBusy: () => ownsKeyboard(document.activeElement),
  log: (type, data) => runLogs.record(game, type, data),
});
ui();
requestAnimationFrame(frame);
