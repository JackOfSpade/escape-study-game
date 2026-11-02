import { studyMapHtml } from "./study-map";
import { eligible, syncLearningView } from "./curriculum";
import { encounterKey, interruptLearningAttempt } from "./learner";
import type { Encounter, Game, Roadmap } from "./model";

export const STUDY_VIEW_KEY = "learning-workspace-view-v1";

export function enterStudyWorkspace(g: Game) {
  if (!g.studyWorkspace?.enabled)
    g.studyWorkspace = {
      ...g.studyWorkspace,
      enabled: true,
      wasPaused: !!g.paused,
    };
  g.paused = true;
}

export function exitStudyWorkspace(g: Game) {
  if (!g.studyWorkspace?.enabled) return;
  g.paused = g.studyWorkspace.wasPaused;
  g.studyWorkspace.enabled = false;
}

/** Prefer the actual unfinished task over creating another visit or chat. */
export function workspaceQuestion(g: Game): Encounter | undefined {
  const current = Object.values(g.encounters);
  const selected = workspaceSelectedQuestion(g);
  const available = (e: Encounter) =>
    e.state !== "consumed" &&
    !(e.mode === "solo" && e.owner && e.owner !== "human");
  const preferSelected = (
    candidates: Encounter[],
    matches: (e: Encounter) => boolean,
  ) =>
    selected && candidates.includes(selected) && matches(selected)
      ? selected
      : candidates.find(matches);
  const pending = preferSelected(
    current,
    (e) =>
      available(e) &&
      (e.studyOnly || e.owner === "human" || e.id === g.lastStudyEncounter) &&
      !!(e.pendingGeneration || e.generation),
  );
  if (pending) return pending;
  const bound =
    g.study.pending?.encounter ??
    g.study.learner?.attempts.find((a) => a.status === "in-progress")
      ?.encounter;
  if (bound) {
    const e = current.find((e) => encounterKey(e) === bound && available(e));
    if (e) return e;
  }
  return preferSelected(
    current,
    (e) =>
      available(e) &&
      !!(
        e.studyOnly ||
        (e.problem && e.problemPresentedSequence !== undefined)
      ),
  );
}

/** No station, RNG consumption, actor movement or scope changes are needed. */
export function nextWorkspaceQuestion(g: Game, roadmap: Roadmap): Encounter {
  if (!g.studyWorkspace?.enabled)
    throw Error("Open the study workspace first.");
  const assessment = workspaceAssessment(g);
  const learner = g.study.profile === "live" ? g.study.learner : undefined;
  if (learner) {
    // A finished conversation cannot accept more answers. An unresolved
    // assessment keeps its formal visit open, so retain it as a continuation
    // before issuing fresh work. The normal scheduler still owns track order.
    const unfinished = new Set(
      learner.attempts
        .filter((a) => ["in-progress", "suspended"].includes(a.status))
        .map((a) => a.encounter),
    );
    let interrupted = false;
    for (const e of [...Object.values(g.encounters), ...g.study.archives])
      if (
        unfinished.has(encounterKey(e)) &&
        e.state === "consumed" &&
        assessmentForQuestion(g, e)?.status === "applied"
      ) {
        interruptLearningAttempt(learner, e);
        interrupted = true;
      }
    if (interrupted) syncLearningView(g.study);
  }
  const current = workspaceQuestion(g);
  if (current) {
    g.studyWorkspace.encounter = encounterKey(current);
    return current;
  }
  if (assessment && assessment.status !== "applied")
    throw Error(
      "Finish reviewing your previous learning result before starting another question.",
    );
  // Respect curriculum gates before allocating any new saved task.
  eligible(roadmap, g.study);
  const id = `study-${crypto.randomUUID()}`;
  const e: Encounter = {
    id,
    runId: g.id,
    studyOnly: true,
    floor: 0,
    mode: "solo",
    reward: "loot",
    state: "available",
    owner: "human",
    workspace: "",
    revision: 0,
    history: [],
    group: [],
    tutor: [],
    submissions: [],
    contributors: [],
    chatCursor: 0,
    chatOpen: false,
    recentSpeakers: [],
    npcProgress: 0,
    loot: [],
    scroll: 0,
    selection: [0, 0],
  };
  g.encounters[id] = e;
  g.studyWorkspace.encounter = encounterKey(e);
  return e;
}

export function workspaceAssessment(g: Game) {
  if (g.study.profile !== "live") return undefined;
  const e = workspaceSelectedQuestion(g);
  return e ? assessmentForQuestion(g, e) : undefined;
}

function assessmentForQuestion(g: Game, e: Encounter) {
  const prefix = `assessment-${encounterKey(e)}-`;
  // Legacy assessment IDs are safe only when their unscoped encounter ID is
  // unambiguous. Physical station IDs are reused by later building runs.
  const unambiguous = [
    ...Object.values(g.encounters),
    ...g.study.archives,
  ].every(
    (other) => other.id !== e.id || encounterKey(other) === encounterKey(e),
  );
  for (let i = g.study.assessments.length - 1; i >= 0; i--) {
    const a = g.study.assessments[i];
    if (
      a.encounter === e.id &&
      (a.id.startsWith(prefix) ||
        (unambiguous && !a.id.startsWith("assessment-")))
    )
      return a;
  }
  return undefined;
}

export function workspaceSelectedQuestion(g: Game) {
  return [...Object.values(g.encounters), ...g.study.archives].find(
    (e) => encounterKey(e) === g.studyWorkspace?.encounter,
  );
}

/** Counts come from the same ledger as the game; observations are separate. */
export function workspaceProgressHtml(g: Game, roadmap: Roadmap): string {
  const issued = workspaceQuestion(g)?.problem?.contract;
  return studyMapHtml(g, roadmap, issued);
}
