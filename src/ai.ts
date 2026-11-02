import { fnv1a } from "./hash";
import { QUESTION_DESIGN_GUIDANCE } from "../scripts/lib/study-question-policy.mjs";
import { devProblem } from "./practice-problem";
import { adoptQuestionPacing, validSolveEstimate } from "./field-pacing";
import { roomEncounters, assignRoomProblem } from "./room-questions";
import { completionVerdict } from "./completion-verdict";
import { careerScopeGuidance, studyFocus } from "./career-profile";
import {
  knowledgeProbeContext,
  parseProbeReply,
  probeRecordsForTrack,
  concessionFeedback,
  encounterProbeContract,
  probeFacets,
  recordProbeTurn,
  TERMINAL_DIALOGUE_FORMAT,
  TERMINAL_DIALOGUE_INSTRUCTION,
} from "./knowledge-probe";
import { bridgeRequest as request, status } from "./bridge-client";
export { checkBridge, status, type BridgeStatus } from "./bridge-client";
import { browserSteps } from "../scripts/browser-runner/spec.mjs";
import {
  coverCatchupsWithRecordedLog,
  generateCatchup,
  unseenWork,
  workKinds,
} from "./chat-catchup";
import {
  beginVisit,
  countStudyTurn,
  eligible,
  finishVisit,
} from "./curriculum";
import { complete } from "./engine";
import { recordSpawn, spawnContract } from "./topic-spawn";
import { reviewEnvironment } from "./environment-review";
import { executionEvidence, runWorkspace } from "./execution";
import { groupSnapshot, validateGroupReply } from "./group-grounding";
import { trackProgressContext } from "./imported-proof";
import { encounterKey, initialLearner, registerScopes } from "./learner";
import {
  type Actor,
  type Provider,
  type Contract,
  type Encounter,
  type Game,
  type Message,
  type Problem,
  type Roadmap,
  type Submission,
  event,
  rand,
} from "./model";
import {
  hasHumanStudyContext,
  npcProfile,
  relevantFocus,
  taskSkill,
} from "./npc-cognition";
import { materializeNpcWork } from "./npc-materialization";
import { inspectNpcOutcome, outcomeIsVisible } from "./npc-outcome";
import { humanUsingWorkspace, npcAtWorkstation } from "./npc-work-access";
import { reconcileRoadmap } from "./roadmap-adoption";
import { settleTutorRequest } from "./run-learning";
import { assess } from "./learning-assessment";
export { assess } from "./learning-assessment";
import { canSee } from "./visibility";
import { applyAutonomousProposal, proposalText } from "./workspace-proposals";
const live = (g: Game) =>
  g.study.profile === "live" && status().mode !== "development";
const interactiveConnected = (g: Game) =>
  live(g) ||
  (g.study.profile === "development" && status().mode !== "development");
const completionConnected = (g: Game, e: Encounter) =>
  live(g) ||
  (g.study.profile === "development" &&
    e.problem?.provenance === "development" &&
    status().mode !== "development");
const activeProvider = (): Provider =>
  status().mode === "development" ? "study-mode" : (status().mode as Provider);
/** Work captured while disconnected is bound to the provider that wrote its
 * question, or to Claude CLI, the only one that can serve it on reconnect. */
const capturedProvider = (problem?: Problem): Provider =>
  status().mode === "claude-cli"
    ? "claude-cli"
    : isAiProvenance(problem?.provenance)
      ? problem.provenance
      : "claude-cli";
export const isAiProvenance = (p?: string): p is Provider =>
  p === "study-mode" || p === "chatgpt-handoff" || p === "claude-cli";
const autonomousAllowed = () =>
  status().capabilities.includes("autonomous-work");
export function materializeObservedWork(g: Game, e: Encounter, retry = false) {
  if (!live(g) || !status().capabilities.includes("materialize-work")) return;
  const provider = activeProvider();
  return materializeNpcWork(
    g,
    e,
    (payload) =>
      optionalProviderRequest(
        g,
        provider,
        "materialize-work",
        payload,
        "materialize-work",
        payload.autonomyAllowed === true || payload.background === true,
      ),
    retry,
    {
      allowAutonomous: autonomousAllowed(),
      provider,
    },
  );
}
export function inspectCompletedNpcWork(
  g: Game,
  e: Encounter,
  r: Roadmap,
  retry = false,
) {
  if (!live(g) || !status().capabilities.includes("materialize-outcome")) {
    e.outcomeNotice =
      "Exact survivor solutions require the connected outcome-inspection capability. The simulated world result is preserved.";
    return;
  }
  const provider = activeProvider();
  return inspectNpcOutcome(
    g,
    e,
    r,
    {
      provider,
      request: (operation, payload) =>
        optionalProviderRequest(
          g,
          provider,
          operation,
          payload,
          "materialize-outcome",
        ),
      validate(p, c) {
        if (!isAiProvenance(p.provenance))
          throw Error(
            "Reconstructed problem must retain its saved provider provenance",
          );
        validateProblem(p, e, r, g, c);
        registerScopes(r, structuredClone(g.study.learner!), {
          ...e,
          problem: p,
        });
      },
    },
    retry,
  );
}
async function optionalProviderRequest<
  T extends object = Record<string, unknown>,
>(
  g: Game,
  provider: Provider,
  operation: string,
  payload: unknown,
  capability = operation,
  autonomous = false,
) {
  const connected = () =>
    live(g) &&
    status().mode === provider &&
    status().capabilities.includes(capability) &&
    (!autonomous || autonomousAllowed());
  if (!connected())
    throw Error(
      "Reconnect the original provider; captured request remains saved",
    );
  const result = await request<T>(operation, payload);
  if (!connected())
    throw Error(
      "Provider changed while request was pending; no result applied",
    );
  return result;
}

function validateProblem(
  p: Problem,
  e: Encounter,
  r: Roadmap,
  g: Game,
  c = eligible(r, g.study),
) {
  if (
    p?.estimatedSolveSeconds !== undefined &&
    !validSolveEstimate(p.estimatedSolveSeconds)
  )
    throw Error(`Invalid generated solve-time estimate for ${e.id}`);
  if (
    !p ||
    typeof p.prompt !== "string" ||
    p.prompt.length > 30000 ||
    typeof p.title !== "string" ||
    !Array.isArray(p.rubric) ||
    !p.rubric.every((x) => typeof x === "string") ||
    typeof p.starter !== "string" ||
    (p.runtime &&
      (!["python", "typescript"].includes(p.runtime.language) ||
        p.contract.depth < 2 ||
        (p.contract.track === "PY" && p.runtime.language !== "python"))) ||
    p.contract.depth !== c.depth ||
    JSON.stringify(p.contract.objectiveIds) !==
      JSON.stringify(c.objectiveIds) ||
    p.contract.track !== c.track
  )
    throw Error(`Invalid or out-of-scope generated problem for ${e.id}`);
  if (
    p.runtime?.environment !== undefined &&
    (p.runtime.environment !== "react" || p.runtime.language !== "typescript")
  )
    throw Error("Invalid generated execution environment");
  if (p.runtime?.steps !== undefined && p.runtime.environment !== "react")
    throw Error("Browser checks require the isolated React environment");
  if (p.runtime?.environment === "react")
    p.runtime.steps = browserSteps(p.runtime.steps);
  // The provider authors the question; scheduler metadata remains local authority.
  // This also prevents a response from stripping preserved historical scope.
  if (
    p.contract.ledgerVersion !== c.ledgerVersion ||
    p.contract.review !== c.review ||
    (p.contract.kind ?? "checkpoint") !== (c.kind ?? "checkpoint") ||
    p.contract.phase !== c.phase
  )
    throw Error(`Stale or altered learning contract for ${e.id}`);
  p.contract = structuredClone(c);
}
const generationCurrent = (g: Game, e: Encounter, id: string) =>
  g.encounters[e.id] === e &&
  e.generation === id &&
  e.state !== "consumed" &&
  !e.problem;
const roomGenerations = new WeakMap<Game, Map<string, Promise<void>>>();
export async function ensureProblem(g: Game, e: Encounter, r: Roadmap) {
  refreshUnissuedPractice(g, e, r);
  if (!e.questionRoom) return ensureIndividualProblem(g, e, r);
  if (e.state === "consumed" || g.encounters[e.id] !== e) return;
  const peers = roomEncounters(g, e);
  const existing = peers.find((peer) => peer.problem);
  if (existing?.problem) {
    assignRoomProblem(g, existing, existing.problem);
    return;
  }
  let pending = roomGenerations.get(g);
  if (!pending) roomGenerations.set(g, (pending = new Map()));
  const running = pending.get(e.questionRoom);
  if (running) {
    await running;
    return;
  }
  // Retry the original captured generation instead of issuing a different question.
  const source = peers.find((peer) => peer.pendingGeneration) ?? e;
  const operation = (async () => {
    await ensureIndividualProblem(g, source, r);
    if (source.problem && g.encounters[source.id] === source)
      assignRoomProblem(g, source, source.problem);
    else for (const peer of peers) if (!peer.problem) peer.error = source.error;
  })();
  pending.set(e.questionRoom, operation);
  try {
    await operation;
  } finally {
    if (pending.get(e.questionRoom) === operation)
      pending.delete(e.questionRoom);
  }
}

/** Development rooms preload one track for the whole world. Refresh only an
 * untouched private prompt at opening time; issued tasks and NPC work stay frozen.
 * Use a separate deterministic stream so opening a terminal cannot change physics RNG.
 */
function refreshUnissuedPractice(g: Game, e: Encounter, r: Roadmap) {
  const p = e.problem;
  if (
    g.encounters[e.id] !== e ||
    g.study.profile !== "development" ||
    p?.provenance !== "development" ||
    e.mode !== "solo" ||
    e.state === "consumed" ||
    (e.owner && e.owner !== "human") ||
    e.problemPresentedSequence !== undefined ||
    e.directStudy ||
    e.pendingGeneration ||
    e.generation ||
    e.revision !== 0 ||
    e.workspace !== p.starter ||
    e.history.length ||
    e.tutor.length ||
    e.group.length ||
    e.submissions.length ||
    e.npcProgress > 0 ||
    e.npcWork?.length ||
    e.executions?.length
  )
    return;
  let formal: Contract;
  try {
    formal = eligible(r, g.study);
  } catch {
    // Preserve existing tasks when the curriculum has no eligible replacement.
    return;
  }
  if (
    p.contract.track === formal.track &&
    (p.contract.practice ||
      JSON.stringify(p.contract.objectiveIds) ===
        JSON.stringify(formal.objectiveIds))
  )
    return;
  const contract = e.studyOnly ? formal : spawnContract(r, g.study, formal);
  const rng = fnv1a(e.id, g.seed);
  e.problem = devProblem({ ...g, rng }, r, contract);
  e.workspace = e.problem.starter;
  delete e.error;
  recordSpawn(g.study, contract, e.id, g.time);
}
const QUESTION_GENERATION_POLICY =
  "Diagnose before teaching. Write a standalone question: the prompt alone must supply the essential scenario, interface, implementation, data, timing and business-rule facts needed to answer without using the chat. For classification, list the concrete items to classify and their relevant behavior, lifetime and source without supplying their classifications. For tracing, debugging or critique, supply the relevant code, event sequence or evidence. Distinguish fixed facts from intentional design choices; if the learner may choose an example or an approach, say so explicitly rather than expecting them to infer an unspecified implementation. Ask a bounded task that matches the supplied scenario; never paste a capability statement into an unrelated generic story. Every requirement in the rubric must be visible in the question; do not grade unstated assumptions or add unrelated decisions, personal history or edge cases. Before returning the question, check that it can be answered from the prompt alone and repair missing context without revealing the solution. For D1, keep the learner workspace starter empty; put essential scenario or code-reading material in the prompt without supplying the key explanation, endpoint update, worked result or a leading solution hint. Do not interpret an objective's implementation verb as a D1 implementation requirement. Preserve legitimate prior context and assistance attribution without presenting supplied steps as fresh independent understanding. Use probeRecords: build the question around open gaps inside the eligible scope with the facet they blocked as the apex; only a gap marked reuseInScopeDefinitions may add its exact facet id to scopeDefinitions, and existing stable scope definitions are copied exactly; do not spend the question on established facets unless the scope requires them; re-ask what a closed gap blocked. The prompt is read by the learner: never mention the scheduled scope, objective IDs, tiers, depth, scheduling or that this is a formal visit; ask the question in plain language. Keep it minimal: write the smallest self-contained diagnostic that exercises the objective, with one main problem and at most one or two directly connected follow-ups. Include only the essential facts, not pasted project context or a full-project audit. For code review, include the actual code under review, including any required helper and its authorization semantics; a prose proposal supports design review only. Prefer short snippets, traces or evidence, and never turn an objective's scope verbs into a D1 implementation task. The visible task and rubric must match, without leaking the solution. An honestly integrative objective may stay integrative on a small feature. A narrow example never establishes unrelated facets or mastery. " +
  QUESTION_DESIGN_GUIDANCE;
const QUESTION_PACING_GUIDANCE =
  "Include estimatedSolveSeconds: a finite number from 30 to 900 estimating typical prepared learner time for the whole bounded question, including reading, reasoning, expected tutoring exchanges and any coding/testing. Exclude network/model queue waiting. This is game pacing metadata, not a grade, mastery claim, door HP or instruction to change difficulty. The game applies its own slower-player margin and safety bounds.";
const QUESTION_RUNTIME_SUPPORT = {
  scripts: ["python", "typescript"],
  react:
    "Optional D2+ TypeScript runtime: {language:typescript,environment:react,steps:[{kind:click|fill|press|expect-text|expect-count,selector:CSS,...}]}. Single TSX module default-exporting App; only installed React imports, no network, workers or external packages. At most eight bounded interaction/check steps. Runtime errors/DOM checks/preview are observations, never automatic correctness or ENV credit; TSX transpilation is not static TypeScript type checking. Docker runtime must be installed locally.",
};
/** The request for one generated question. It carries no run, floor or terminal
 * facts, which is what lets a prepared question serve any room. */
function generationPayload(
  g: Game,
  r: Roadmap,
  contract: Contract,
  requestId: string,
  encounterId: string,
) {
  const study = g.study;
  return {
    requestId,
    encounterId,
    contract,
    careerScopeGuidance: careerScopeGuidance(contract, studyFocus(study)),
    generationPolicy: QUESTION_GENERATION_POLICY,
    pacingGuidance: QUESTION_PACING_GUIDANCE,
    runtimeSupport: QUESTION_RUNTIME_SUPPORT,
    existingScopeDefinitions: study.learner?.scopes,
    probeRecords: probeRecordsForTrack(g, contract.track, contract),
    progressContext: trackProgressContext(study.learner!, r, contract.track),
    curriculum: r.tracks[contract.track].curriculum,
  };
}
/** A tutor reply while it is still being written. Display only: never saved,
 * and the validated answer replaces it. */
const streamingReplies = new WeakMap<object, string>();
let onStreamingReply: (() => void) | undefined;
export const streamingReply = (job: object) => streamingReplies.get(job);
export function watchStreamingReplies(listener: () => void) {
  onStreamingReply = listener;
}
const preparing = new WeakMap<object, Promise<void>>();
/** A failed preparation must wait, or a signed-out CLI would spend a call on
 * every interface tick. It backs off from one minute up to thirty. */
const preparationBackoff = new WeakMap<
  object,
  { failures: number; retryAt: number }
>();
/** Whether a prepared question is still the one the schedule would issue. */
function stillSchedulable(r: Roadmap, g: Game, c: Contract) {
  if (c.practice) return true;
  if (g.study.learner?.attempts.some((a) => a.status === "in-progress"))
    return false;
  try {
    const now = eligible(r, g.study);
    return (
      now.track === c.track &&
      now.depth === c.depth &&
      now.review === c.review &&
      now.kind === c.kind &&
      now.ledgerVersion === c.ledgerVersion &&
      JSON.stringify(now.objectiveIds) === JSON.stringify(c.objectiveIds)
    );
  } catch {
    return false;
  }
}
/** Generate the next terminal's question ahead of time. It waits for the last
 * assessment so the question knows which gaps that answer closed or exposed. */
/** Older saves can hold work waiting on a chat connection that no longer
 * exists. Free it so the player can carry on in the game's own terminal; the
 * question and the learner's own work stay. */
export function releaseRetiredChatRequests(g: Game) {
  if (status().mode !== "claude-cli") return;
  for (const e of [...Object.values(g.encounters), ...g.study.archives]) {
    if (e.pendingGeneration && e.pendingGeneration.provider !== "claude-cli")
      delete e.pendingGeneration;
    const session = e.directStudy;
    if (
      session &&
      session.provider === "chatgpt-handoff" &&
      ["pending", "interrupted", "paused"].includes(session.state)
    )
      delete e.directStudy;
    for (const job of e.tutorRequests ?? [])
      if (job.state === "pending" && job.provider !== "claude-cli")
        job.state = "superseded";
    for (const submission of e.submissions)
      if (
        submission.status === "pending" &&
        submission.completionRequest?.provider !== "claude-cli"
      ) {
        submission.status = "error";
        submission.feedback =
          "This answer was waiting on a connection that no longer exists. Submit it again.";
        delete submission.completionRequest;
      }
  }
}
export function prepareNextQuestion(g: Game, r: Roadmap) {
  const study = g.study;
  if (
    !live(g) ||
    status().mode !== "claude-cli" ||
    g.status !== "playing" ||
    study.preparedQuestion ||
    preparing.has(study) ||
    (preparationBackoff.get(study)?.retryAt ?? 0) > Date.now() ||
    study.assessments.some((a) => a.status === "pending") ||
    Object.values(g.encounters).some(
      (e) =>
        !!e.generation ||
        (e.history.length > 0 &&
          e.state !== "consumed" &&
          e.problemPresentedSequence !== undefined &&
          e.owner === "human"),
    )
  )
    return;
  const provider = activeProvider();
  let contract: Contract;
  try {
    contract = spawnContract(r, study);
    study.learner ??= initialLearner(r);
    if (!stillSchedulable(r, g, contract)) return;
  } catch {
    return;
  }
  const requestId = `gen-${g.id}-prepared-${crypto.randomUUID()}`;
  const operation = request<Problem>(
    "generate",
    generationPayload(g, r, contract, requestId, "prepared"),
  )
    .then((problem) => {
      // A dropped profile or provider cannot leave its question behind.
      if (g.study !== study || status().mode !== provider) return;
      problem.provenance = provider;
      study.preparedQuestion = { provider, contract, problem };
      preparationBackoff.delete(study);
    })
    // A failed preparation is silent: opening a terminal generates as usual.
    .catch(() => {
      const failures = (preparationBackoff.get(study)?.failures ?? 0) + 1;
      preparationBackoff.set(study, {
        failures,
        retryAt: Date.now() + Math.min(30, 2 ** (failures - 1)) * 60_000,
      });
    })
    .finally(() => preparing.delete(study));
  preparing.set(study, operation);
}
/** Hand over the ready question, dropping it if the schedule has moved on. */
function takePrepared(g: Game, r: Roadmap) {
  const prepared = g.study.preparedQuestion;
  if (!prepared) return undefined;
  delete g.study.preparedQuestion;
  return prepared.provider === status().mode &&
    stillSchedulable(r, g, prepared.contract)
    ? prepared
    : undefined;
}
async function ensureIndividualProblem(g: Game, e: Encounter, r: Roadmap) {
  if (e.problem || e.state === "consumed") return;
  if (g.study.profile === "live" && status().mode === "development") {
    e.error =
      "Live study connection unavailable; work is preserved. Reconnect to continue this live profile.";
    return;
  }
  if (e.generation) return;
  const generation =
      e.pendingGeneration?.requestId ??
      `gen-${g.id}-${e.id}-${crypto.randomUUID()}`,
    study = g.study,
    profile = study.profile,
    native = live(g);
  e.generation = generation;
  let prepared: ReturnType<typeof takePrepared>,
    regenerate = false;
  try {
    let p: Problem;
    if (native && !e.studyOnly && !e.pendingGeneration) {
      // Arriving during preparation joins that call rather than paying twice.
      await preparing.get(study);
      if (!generationCurrent(g, e, generation)) return;
      prepared = takePrepared(g, r);
    }
    if (
      e.pendingGeneration &&
      (!native ||
        // Saves from before providers were recorded were ChatGPT handoffs.
        status().mode !== (e.pendingGeneration.provider ?? "chatgpt-handoff"))
    )
      throw Error(
        "Reconnect the original generation provider to retry this saved question",
      );
    // The spawn policy keeps the formal visit reachable and rotates other
    // terminals across cooled topics; a saved generation keeps its contract.
    const contract =
      prepared?.contract ??
      (e.pendingGeneration?.payload?.contract as Contract | undefined) ??
      (e.studyOnly ? eligible(r, study) : spawnContract(r, study));
    if (prepared) p = prepared.problem;
    else if (native) {
      const payload =
        e.pendingGeneration?.payload ??
        generationPayload(g, r, contract, generation, e.id);
      const provider = activeProvider();
      e.pendingGeneration = {
        provider,
        requestId: generation,
        payload: structuredClone(payload),
      };
      p = await request<Problem>("generate", payload);
      p.provenance = provider;
    } else
      p = devProblem(
        e.studyOnly ? { ...g, rng: g.seed ^ study.version } : g,
        r,
        contract,
      );
    if (
      g.study !== study ||
      study.profile !== profile ||
      !generationCurrent(g, e, generation)
    )
      return;
    validateProblem(p, e, r, g, contract);
    if (native) {
      g.study.learner ??= initialLearner(r);
      registerScopes(r, g.study.learner, { ...e, problem: p });
    }
    e.problem = p;
    if (!e.studyOnly) adoptQuestionPacing(g, e.floor, p);
    delete e.error;
    delete e.pendingGeneration;
    if (e.revision === 0 && !e.workspace) e.workspace = p.starter;
    e.state = "in-progress";
    if (!e.studyOnly)
      recordSpawn(g.study, p.contract, e.questionRoom ?? e.id, g.time);
  } catch (err) {
    // A stale prepared question costs one fresh generation, not an error.
    if (prepared) regenerate = true;
    else if (
      g.study === study &&
      study.profile === profile &&
      generationCurrent(g, e, generation)
    )
      e.error = String(err);
  } finally {
    if (e.generation === generation) delete e.generation;
  }
  if (regenerate) await ensureIndividualProblem(g, e, r);
}
export function edit(
  g: Game,
  e: Encounter,
  text: string,
  revision: number,
  r?: Roadmap,
) {
  if (e.state === "consumed") return false;
  if (revision !== e.revision)
    throw Error("Workspace changed. Refresh before editing.");
  if (text === e.workspace) return true;
  if (r && g.study.profile === "live") {
    try {
      beginVisit(r, g.study, e);
    } catch (err) {
      e.error = String(err);
    }
  }
  const old = e.workspace;
  e.workspaceBase ??= old;
  e.workspace = text;
  e.revision++;
  const ev = event(
    g,
    "edit",
    "Human workspace edit saved.",
    e.floor,
    "human",
    e.id,
  );
  let prefix = 0;
  while (
    prefix < old.length &&
    prefix < text.length &&
    old[prefix] === text[prefix]
  )
    prefix++;
  let endOld = old.length,
    endNew = text.length;
  while (
    endOld > prefix &&
    endNew > prefix &&
    old[endOld - 1] === text[endNew - 1]
  ) {
    endOld--;
    endNew--;
  }
  e.history.push({
    seq: ev.seq,
    author: "human",
    kind: "edit",
    delta: {
      prefix,
      removed: old.slice(prefix, endOld),
      inserted: text.slice(prefix, endNew),
    },
    text: text.slice(prefix, endNew) || `Removed: ${old.slice(prefix, endOld)}`,
    at: g.time,
    wallTime: new Date().toISOString(),
    revision: e.revision,
    refs: [`previous:${old.length}`],
  });
  return true;
}
export function presentProblem(g: Game, e: Encounter, r?: Roadmap) {
  // A displayed scheduled assessment is issued even before an answer exists.
  // Generation alone, development practice and completed-lock inspection are not issuance.
  if (
    r &&
    g.study.profile === "live" &&
    isAiProvenance(e.problem?.provenance) &&
    e.state !== "consumed" &&
    !g.study.learner?.attempts.some((a) => a.encounter === encounterKey(e))
  ) {
    try {
      beginVisit(r, g.study, e);
    } catch (err) {
      // Unscheduled shared survival work remains available without becoming a personal visit.
      e.error = String(err);
    }
  }
  if (!e.problem || e.problemPresentedSequence !== undefined) return;
  const ev = event(
    g,
    "problem-presented",
    "Task and supplied starter became available to the human.",
    e.floor,
    "generator",
    e.id,
  );
  e.problemPresentedSequence = ev.seq;
  e.history.push({
    seq: ev.seq,
    author: "generator",
    kind: "starter",
    text: JSON.stringify({
      prompt: e.problem.prompt,
      starter: e.problem.starter,
    }),
    at: g.time,
    wallTime: new Date().toISOString(),
    revision: e.revision,
    presented: ev.seq,
  });
}
function message(
  g: Game,
  e: Encounter,
  channel: "group" | "tutor",
  author: string,
  kind: Message["kind"],
  text: string,
  provenance: string,
  sourceSeq?: number | number[],
) {
  const ev = event(
    g,
    "message",
    `${author}: ${text.slice(0, 120)}`,
    e.floor,
    author,
    e.id,
  );
  const m: Message = {
    id: `message-${ev.seq}`,
    author,
    kind,
    text,
    seq: ev.seq,
    worldTime: g.time,
    presented: kind === "human" || kind === "system" ? ev.seq : undefined,
    provenance,
    sourceRefs:
      sourceSeq === undefined
        ? undefined
        : Array.isArray(sourceSeq)
          ? sourceSeq
          : [sourceSeq],
  };
  e[channel].push(m);
  e.history.push({
    seq: ev.seq,
    author,
    kind: kind === "tutor" ? "tutor" : kind === "human" ? "reasoning" : "chat",
    text,
    at: g.time,
    wallTime: new Date().toISOString(),
    revision: e.revision,
    refs:
      sourceSeq === undefined
        ? undefined
        : (Array.isArray(sourceSeq) ? sourceSeq : [sourceSeq]).map(String),
    presented: m.presented,
  });
  return m;
}
/** Record one attributed tutor/group message (shared with direct study). */
export function presentMessages(
  g: Game,
  e: Encounter,
  channel: "group" | "tutor",
) {
  for (const m of e[channel]) {
    if (m.presented !== undefined) continue;
    const ev = event(
      g,
      "message-presented",
      `${m.author} message became visible.`,
      e.floor,
      m.author,
      e.id,
    );
    m.presented = ev.seq;
    const original = e.history.find((h) => h.seq === m.seq);
    if (original) original.presented = ev.seq;
    for (const ref of m.sourceRefs ?? []) {
      const proposal = e.history.find(
        (h) =>
          h.seq === ref && h.kind === "npc-proposal" && h.author === m.author,
      );
      if (proposal) proposal.presented = ev.seq;
    }
  }
}
export function openChat(g: Game, e: Encounter) {
  if (e.chatOpen) return;
  e.chatOpen = true;
  if (live(g) && status().capabilities.includes("retrospective-group"))
    return nativeCatchup(g, e);
  // Below: a local recorded-work summary; nothing asynchronous to await.
  e.catchupNotice = live(g)
    ? "Recorded work summary · this bridge does not support retrospective dialogue."
    : g.study.profile === "live"
      ? "Recorded work summary · bridge catch-up unavailable."
      : "Recorded work summary · development mode.";
  const cutoff = g.seq;
  const fresh = unseenWork(e, cutoff);
  if (fresh.length > 3) {
    const older = fresh.slice(0, -3);
    const authors = [
      ...new Set(
        older.map(
          (h) => g.survivors.find((a) => a.id === h.author)?.name ?? h.author,
        ),
      ),
    ];
    message(
      g,
      e,
      "group",
      "Room log",
      "system",
      `Catch-up summary: ${older.length} earlier work/activity events involving ${authors.join(", ")}. Their saved artifacts remain available; no unseen conversation or executed tests are implied.`,
      "grounded-event-range-summary",
      older.map((h) => h.seq),
    );
  }
  for (const h of fresh.slice(-3)) {
    const a = g.survivors.find((a) => a.id === h.author);
    const technical = ["npc-thought", "npc-proposal"].includes(h.kind);
    message(
      g,
      e,
      "group",
      technical ? h.author : "Room log",
      technical ? "npc" : "system",
      `${technical ? `Saved work summary${a && (!a.alive || a.escaped) ? ` from ${a.name}, who has since left` : ""}` : "Room update"}: ${h.text}`,
      "grounded-development-catch-up",
      h.seq,
    );
  }
  e.chatCursor = cutoff;
  coverCatchupsWithRecordedLog(e);
  return undefined;
}
function nativeCatchup(g: Game, e: Encounter) {
  const provider = activeProvider();
  return generateCatchup(g, e, {
    provider,
    request: async (payload) => {
      const connected = () =>
        live(g) &&
        status().mode === provider &&
        status().capabilities.includes("retrospective-group");
      if (!connected()) throw Error("Reconnect the original catch-up provider");
      const result = await request("group", payload);
      if (!connected())
        throw Error("Catch-up provider changed; no dialogue applied");
      return result;
    },
    append: (author, kind, text, provenance, refs) =>
      message(g, e, "group", author, kind, text, provenance, refs),
  });
}
export function retryChatCatchup(g: Game, e: Encounter) {
  if (live(g) && status().capabilities.includes("retrospective-group"))
    return nativeCatchup(g, e);
  // Below: a local recorded-work summary; nothing asynchronous to await.
  return Promise.resolve();
}
export function presentWorkLog(g: Game, e: Encounter) {
  for (const h of e.history.filter(
    (h) => workKinds.has(h.kind) && h.author !== "human",
  )) {
    if (h.presented !== undefined) continue;
    const ev = event(
      g,
      "work-presented",
      "Recorded group work became visible.",
      e.floor,
      h.author,
      e.id,
    );
    h.presented = ev.seq;
  }
}
export function closeChat(_g: Game, e: Encounter) {
  e.chatOpen = false;
  // Work while open remains work history, never invented timestamped dialogue.
}

export function npcCanRespond(g: Game, e: Encounter, a: Actor) {
  return (
    a.id !== "human" &&
    a.alive &&
    !a.escaped &&
    !a.vault &&
    !a.stairTravel &&
    a.activity !== "fleeing" &&
    a.floor === e.floor &&
    a.intent === e.id &&
    a.thought > 5 &&
    g.zombies.every(
      (z) =>
        z.hp <= 0 ||
        z.floor !== a.floor ||
        Math.hypot(z.x - a.x, z.y - a.y) > 4 ||
        !canSee(g.floors[a.floor], a, z, 4),
    )
  );
}
export function responders(g: Game, e: Encounter, text: string) {
  const available = g.survivors.filter((a) => npcCanRespond(g, e, a));
  const ranked = available
    .map((a) => ({
      a,
      score:
        (text.toLowerCase().includes(a.name.toLowerCase()) ? 4 : 0) +
        taskSkill(a, e) * 0.8 +
        npcProfile(a).strengths[relevantFocus(text)] * 0.6 +
        ((e.npcWork ?? []).some(
          (w) => w.actor === a.id && w.focus === relevantFocus(text),
        )
          ? 0.2
          : 0) +
        a.social * 0.25 +
        (e.recentSpeakers.includes(a.id) ? -0.5 : 0) +
        rand(g) * 1.5,
    }))
    .sort((a, b) => b.score - a.score);
  const count = ranked.length > 2 && rand(g) < 0.2 ? 2 : 1;
  return ranked
    .slice(0, Math.min(count, Math.max(1, ranked.length - 1)))
    .map((x) => x.a);
}
const tutorInFlight = new WeakMap<object, Promise<void>>();
export function retryTutorRequest(
  g: Game,
  e: Encounter,
  id: string,
  r?: Roadmap,
): Promise<void> {
  const job = e.tutorRequests?.find((j) => j.id === id);
  if (!job || job.state === "applied" || job.state === "superseded")
    return Promise.resolve();
  const pending = tutorInFlight.get(job);
  if (pending) return pending;
  const study = g.study,
    profile = study.profile;
  job.state = "pending";
  delete job.error;
  const operation = (async () => {
    try {
      if (!interactiveConnected(g) || status().mode !== job.provider)
        throw Error(
          "Reconnect the original tutor connection to retry this saved request",
        );
      const payload = JSON.parse(job.payloadJson);
      if (
        payload.requestId !== job.id ||
        payload.sessionId !== `${e.runId}/${e.id}/private` ||
        !e.tutor.some(
          (m) => m.kind === "human" && m.seq === job.questionSequence,
        )
      )
        throw Error(
          "Saved tutor request does not match its original private question",
        );
      const dialogue = payload.mode === "terminal-dialogue";
      const checkSnapshot = () => {
        const captured = payload.messages
          ?.filter((m: Message) => m.kind === "human")
          .at(-1);
        const current = e.tutor.filter((m) => m.kind === "human").at(-1);
        if (
          g.study !== study ||
          study.profile !== profile ||
          job.state !== "pending" ||
          !interactiveConnected(g) ||
          status().mode !== job.provider ||
          g.encounters[e.id] !== e ||
          (dialogue &&
            (e.mode !== "solo" ||
              (e.owner && e.owner !== "human") ||
              JSON.stringify(payload.problem) !== JSON.stringify(e.problem) ||
              payload.draftRevision !== e.revision ||
              payload.workspace !== e.workspace ||
              current?.seq !== job.questionSequence ||
              captured?.seq !== current?.seq ||
              captured?.text !== current?.text))
        )
          throw Error(
            "Saved terminal conversation changed during review; no reward applied",
          );
      };
      checkSnapshot();
      const existing = e.tutor.find(
        (m) => m.kind === "tutor" && m.requestId === job.id,
      );
      if (existing) {
        settleTutorRequest(job, "applied");
        job.responseMessageId = existing.id;
        return;
      }
      const answer = await request("tutor", payload, {
        onText: (text) => {
          if (job.state !== "pending") return;
          streamingReplies.set(job, text);
          onStreamingReply?.();
        },
      }).finally(() => streamingReplies.delete(job));
      if (
        typeof answer.text !== "string" ||
        !answer.text.trim() ||
        answer.text.length > 100_000 ||
        ((dialogue || answer.complete !== undefined) &&
          typeof answer.complete !== "boolean")
      )
        throw Error("Invalid tutor reply");
      if (dialogue && answer.text.length > 8000)
        throw Error("Terminal reply exceeds 8000 characters");
      const probe = dialogue
        ? parseProbeReply(
            answer as Record<string, unknown>,
            // Sub-facets declared on earlier turns belong to the universe too.
            e.probe?.facets ??
              (Array.isArray(payload.probe?.facets)
                ? payload.probe.facets
                : probeFacets(payload.problem)),
            1,
          )
        : undefined;
      checkSnapshot();
      if (dialogue && answer.complete === true && !r)
        throw Error(
          "Reconnect this saved conversation with its curriculum before awarding access",
        );
      if (
        dialogue &&
        answer.complete === true &&
        e.state !== "consumed" &&
        e.submissions.some((s) => s.status === "pending")
      )
        throw Error(
          "An earlier answer check is still pending; no duplicate reward applied",
        );
      const delivered = message(
        g,
        e,
        "tutor",
        "Terminal AI",
        "tutor",
        answer.text,
        job.provider,
        job.questionSequence,
      );
      delivered.requestId = job.id;
      job.responseMessageId = delivered.id;
      const gaps = probe
        ? recordProbeTurn(g, e, probe, {
            requestId: job.id,
            questionSequence: job.questionSequence,
            provider: job.provider,
            statement:
              payload.messages
                ?.filter((m: Message) => m.kind === "human")
                .at(-1)?.text ?? "",
          })
        : [];
      if (dialogue && answer.complete === true && e.state !== "consumed") {
        const ev = event(
          g,
          "submission",
          "Terminal AI reviewed the captured conversation.",
          e.floor,
          "human",
          e.id,
        );
        const captured = [
          payload.workspace ? `Saved work:\n${payload.workspace}` : "",
          ...payload.messages
            .filter((m: Message) => m.kind === "human")
            .map((m: Message) => m.text),
        ]
          .filter(Boolean)
          .join("\n\n");
        const feedback =
          probe?.outcome === "gap"
            ? concessionFeedback(
                gaps.map((gap) => gap.facet.description),
                answer.text,
              )
            : answer.text;
        // Validate before recording a pending submission, so a rejected
        // verdict can never leave one behind to block later awards.
        const verdict = completionVerdict({
          complete: true,
          feedback,
          qualified: ["human"],
        });
        const submission: Submission = {
          id: `dialogue-${job.id}`,
          revision: payload.draftRevision,
          author: "human",
          content: captured,
          seq: ev.seq,
          status: "pending",
          feedback,
          dialogueRequestId: job.id,
        };
        e.submissions.push(submission);
        applyCompletion(g, e, r!, submission, verdict);
      }
      settleTutorRequest(job, "applied");
    } catch (error) {
      if ((job.state as string) === "superseded") return;
      job.state = "interrupted";
      job.error = String(error);
    }
  })();
  tutorInFlight.set(job, operation);
  void operation.finally(() => tutorInFlight.delete(job));
  return operation;
}
const groupInFlight = new WeakMap<object, Promise<void>>();
export function retryGroupRequest(
  g: Game,
  e: Encounter,
  id: string,
): Promise<void> {
  const job = e.groupRequests?.find((j) => j.id === id);
  if (!job || job.state === "applied" || job.state === "superseded")
    return Promise.resolve();
  const pending = groupInFlight.get(job);
  if (pending) return pending;
  const study = g.study,
    profile = study.profile;
  e.groupRequest = job.id;
  if (job.error && e.error === job.error) delete e.error;
  job.state = "pending";
  delete job.error;
  const operation = (async () => {
    try {
      const checkConnection = () => {
        if (
          g.study !== study ||
          study.profile !== profile ||
          g.encounters[e.id] !== e ||
          !interactiveConnected(g) ||
          status().mode !== job.provider
        )
          throw Error(
            "Reconnect the original group connection and encounter to retry this saved question",
          );
      };
      checkConnection();
      const payload = JSON.parse(job.payloadJson);
      const snapshot = payload as ReturnType<typeof groupSnapshot>;
      if (
        payload.requestId !== job.id ||
        payload.sessionId !== `${e.runId}/${e.id}/public` ||
        e.runId !== g.id ||
        !e.group.some(
          (m) => m.kind === "human" && m.seq === job.questionSequence,
        ) ||
        !Array.isArray(payload.speakers) ||
        !payload.speakers.length
      )
        throw Error(
          "Saved group request does not match its original public question",
        );
      if (e.revision !== snapshot.sourceRevision)
        throw Error(
          "Workspace changed since this saved group question; ask a new question for the current revision.",
        );
      const selected: Game["survivors"] = payload.speakers.map(
        (speaker: { id: string }) => {
          const actor = g.survivors.find((a) => a.id === speaker.id);
          if (!actor)
            throw Error("A saved group speaker is no longer available");
          return actor;
        },
      );
      // Delivery is atomic after validation. A persisted request marker makes
      // an explicit retry idempotent even if its state was interrupted.
      if (e.group.some((m) => m.kind === "npc" && m.requestId === job.id)) {
        job.state = "applied";
        return;
      }
      if (selected.some((actor) => !npcCanRespond(g, e, actor)))
        throw Error(
          "A saved group speaker is away or in danger; retry when they can respond.",
        );
      const requestId = job.id,
        workspace = payload.workspace;
      const reply = await request("group", payload);
      if (e.groupRequest !== job.id) {
        job.state = "superseded";
        return;
      }
      checkConnection();
      if (e.revision !== snapshot.sourceRevision)
        throw Error(
          "Workspace changed during group reply; your question remains saved. Ask again for the current revision.",
        );
      const messages = validateGroupReply(
        reply,
        snapshot,
        selected.map((a) => a.id),
        workspace,
      );
      if (e.state === "consumed" && messages.some((m) => m.patch))
        throw Error(
          "Completed survivor solutions are read-only; preserve the validated reconstruction",
        );
      if (messages.some((m) => m.patch) && e.mode !== "shared")
        throw Error("Workspace candidates require a shared encounter");
      if (
        messages.some(
          (m) =>
            !npcCanRespond(
              g,
              e,
              selected.find((a) => a.id === m.author)!,
            ),
        )
      )
        throw Error(
          "A saved group speaker moved away or encountered danger; their reply remains available for retry.",
        );
      for (const m of messages) {
        const a = selected.find((a) => a.id === m.author)!;
        let proposalSequence: number | undefined;
        if (m.kind === "proposal") {
          const ev = event(
            g,
            "npc-proposal",
            `${a.name} supplied an unvalidated candidate for revision ${snapshot.sourceRevision}.`,
            e.floor,
            a.id,
            e.id,
          );
          proposalSequence = ev.seq;
          e.history.push({
            seq: ev.seq,
            author: a.id,
            kind: "npc-proposal",
            text: m.patch ? proposalText(m.text, m.patch) : m.text,
            delta: m.patch ? structuredClone(m.patch) : undefined,
            at: g.time,
            revision: snapshot.sourceRevision,
            refs: m.refs.map(String),
          });
          if (m.patch) {
            e.proposals ??= [];
            e.proposals.push({
              id: `${requestId}/${a.id}`,
              author: a.id,
              sourceRevision: snapshot.sourceRevision,
              sourceSequence: snapshot.cutoff,
              artifactSequence: ev.seq,
              patch: structuredClone(m.patch),
              state: "pending",
            });
          }
        }
        const delivered = message(
          g,
          e,
          "group",
          a.id,
          "npc",
          m.kind === "proposal"
            ? `Candidate for workspace revision ${snapshot.sourceRevision} (not executed or validated):\n${m.patch ? proposalText(m.text, m.patch) : m.text}`
            : m.text,
          job.provider,
          proposalSequence === undefined
            ? m.refs
            : [...m.refs, proposalSequence],
        );
        delivered.requestId = requestId;
      }

      job.state = "applied";
    } catch (error) {
      if ((job.state as string) === "superseded") return;
      job.state = "interrupted";
      job.error = String(error);
      e.error = job.error;
    } finally {
      if (e.groupRequest === job.id) delete e.groupRequest;
    }
  })();
  groupInFlight.set(job, operation);
  void operation.finally(() => groupInFlight.delete(job));
  return operation;
}
export async function send(
  g: Game,
  e: Encounter,
  channel: "group" | "tutor",
  text: string,
  r: Roadmap,
) {
  const reconstruction = outcomeIsVisible(g, e, r)
    ? e.outcomeInspection?.candidate
    : undefined;
  const problem = e.problem ?? reconstruction?.problem;
  const workspace = reconstruction?.solution ?? e.workspace;
  if (!text.trim() || !problem) return;
  if (
    channel === "tutor" &&
    e.tutorRequests?.some((j) => j.state === "pending")
  )
    return;
  if (channel === "tutor")
    for (const job of e.tutorRequests ?? [])
      if (job.state === "interrupted") settleTutorRequest(job, "superseded");
  delete e.error;
  message(g, e, channel, "human", "human", text, "live-human");
  try {
    if (e.state !== "consumed") beginVisit(r, g.study, e);
  } catch {
    /* Non-eligible participation stays world-only. */
  }
  if (channel === "tutor") {
    if (
      e.mode === "solo" ||
      g.study.profile === "live" ||
      interactiveConnected(g)
    ) {
      const provider = capturedProvider(problem);
      const id = `tutor-${g.id}-${e.id}-${g.seq}`;
      const payload = {
        requestId: id,
        sessionId: `${g.id}/${e.id}/private`,
        ...(e.mode === "solo" && e.state !== "consumed"
          ? {
              mode: "terminal-dialogue",
              responseFormat: TERMINAL_DIALOGUE_FORMAT,
              instruction: TERMINAL_DIALOGUE_INSTRUCTION,
              probe: encounterProbeContract(e, problem),
            }
          : {}),
        problem,
        workspace,
        draftRevision: e.revision,
        submissions: e.submissions.slice(-5).map((s) => ({
          id: s.id,
          revision: s.revision,
          content: s.content,
          status: s.status,
          feedback: s.feedback,
        })),
        ...(reconstruction
          ? {
              retrospectiveOutcome:
                "Reconstruction authored now from a simulated NPC-only completion; no historical execution or human assessment.",
            }
          : {}),
        messages: structuredClone(e.tutor),
        executions: (e.executions ?? [])
          .filter((j) => j.status === "finished")
          .map(executionEvidence),
        learning: problem.contract,
        prompt: text,
        curriculum: r.tracks[problem.contract.track].curriculum,
        progressContext: [
          trackProgressContext(g.study.learner, r, problem.contract.track),
          knowledgeProbeContext(g, problem.contract.track),
        ]
          .filter(Boolean)
          .join("\n\n"),
      };
      (e.tutorRequests ??= []).push({
        id,
        provider,
        payloadJson: JSON.stringify(payload),
        questionSequence: e.tutor.at(-1)!.seq,
        state: "pending",
      });
      await retryTutorRequest(g, e, id, r);
    } else {
      e.error =
        "The study connection is unavailable. Check that Claude CLI is installed and signed in, then retry. Your question and answer draft are saved.";
    }
    return;
  }
  if (g.study.profile === "live" && !live(g)) {
    e.error =
      "Live tutor connection unavailable. Your question and work remain saved.";
    return;
  }
  const selected = responders(g, e, text);
  e.recentSpeakers = selected.map((a) => a.id);
  if (!selected.length) return;
  if (interactiveConnected(g)) {
    const requestId = `group-${g.id}-${e.id}-${g.seq}`;
    for (const prior of e.groupRequests ?? [])
      if (prior.state === "pending" || prior.state === "interrupted") {
        prior.state = "superseded";
        prior.error =
          "A newer group question superseded this reply; its captured context remains retained.";
      }
    const snapshot = groupSnapshot(e, requestId, g.seq),
      groupProvider = status().mode;
    const payload = {
      ...snapshot,
      mode: "reply",
      proposalFormat: {
        kind: "single-range",
        fields: ["prefix", "removed", "inserted"],
        offsetUnit: "utf16-code-units",
        maxChangedCharacters: 32000,
        instruction:
          "Optional patch on proposal messages only. Capture exact source text; no claim of application or test success. The human reviews before applying.",
      },
      sessionId: `${g.id}/${e.id}/public`,
      speakers: selected.map((a) => ({
        id: a.id,
        name: a.name,
        skill: taskSkill(a, e),
        role: a.role,
        profile: npcProfile(a),
        activity: a.activity,
      })),
      problem,
      workspace,
      draftRevision: e.revision,
      ...(reconstruction
        ? {
            retrospectiveOutcome:
              "Read-only reconstructed NPC solution; no new edits or historical execution claims.",
          }
        : {}),
      messages: e.group,
      workRecords: (e.npcWork ?? []).slice(-16),
    };
    (e.groupRequests ??= []).push({
      id: requestId,
      provider: groupProvider as Provider,
      payloadJson: JSON.stringify(payload),
      questionSequence: e.group.at(-1)!.seq,
      state: "pending",
    });
    await retryGroupRequest(g, e, requestId);
  } else
    for (const a of selected) {
      const last = e.history
        .filter((h) => h.author === a.id && h.kind === "npc-thought")
        .at(-1);
      message(
        g,
        e,
        "group",
        a.id,
        "npc",
        taskSkill(a, e) < 0.6
          ? "I am still working through the contract. Which assumption makes your example hold?"
          : last
            ? `My last work note: ${last.text} I have not executed any code. Can you show the boundary you are worried about?`
            : "I have a candidate idea, but have not validated it. Let’s trace your example against the stated constraints.",
        "development-grounded-reply",
        taskSkill(a, e) >= 0.6 ? last?.seq : undefined,
      );
    }
}
export async function submit(
  g: Game,
  e: Encounter,
  r: Roadmap,
  author = "human",
  proposalId?: string,
) {
  const candidate = e.proposals?.find((p) => p.id === proposalId);
  if (
    author !== "human" &&
    (!live(g) ||
      !autonomousAllowed() ||
      (candidate?.provider ?? "study-mode") !== status().mode ||
      !npcAtWorkstation(g, e, author) ||
      humanUsingWorkspace(g, e) ||
      !candidate?.autonomous ||
      !candidate.appliedAutomatically ||
      candidate.sourceProblem !== JSON.stringify(e.problem) ||
      candidate.author !== author ||
      candidate.appliedRevision !== e.revision ||
      candidate.submissionId)
  )
    return;
  if (
    !e.problem ||
    e.state === "consumed" ||
    e.submissions.some((s) => s.status === "pending")
  )
    return;
  try {
    if (author === "human") beginVisit(r, g.study, e);
  } catch (err) {
    e.error = String(err);
  }
  const ev = event(
      g,
      "submission",
      "Submission captured; movement remains available.",
      e.floor,
      author,
      e.id,
    ),
    s: Submission = {
      id: `submit-${g.id}-${ev.seq}`,
      revision: e.revision,
      author,
      content: e.workspace,
      status: "pending" as "pending" | "complete" | "needs-work" | "error",
      feedback: "Checking captured revision…",
      seq: ev.seq,
    };
  e.submissions.push(s);
  if (candidate && author !== "human") candidate.submissionId = s.id;
  e.state = "submitted";
  return retrySubmission(g, e, r, s.id);
}
const completionInFlight = new WeakMap<Submission, Promise<void>>();
export function retrySubmission(
  g: Game,
  e: Encounter,
  r: Roadmap,
  id: string,
): Promise<void> {
  const s = e.submissions.find((item) => item.id === id);
  if (
    !s ||
    !e.problem ||
    e.state === "consumed" ||
    g.encounters[e.id] !== e ||
    s.status === "complete" ||
    s.status === "needs-work" ||
    e.submissions.some((other) => other !== s && other.status === "pending")
  )
    return Promise.resolve();
  const pending = completionInFlight.get(s);
  if (pending) return pending;
  const operation = evaluateSubmission(g, e, r, s);
  completionInFlight.set(s, operation);
  void operation.finally(() => completionInFlight.delete(s));
  return operation;
}
async function evaluateSubmission(
  g: Game,
  e: Encounter,
  r: Roadmap,
  s: Submission,
) {
  if (!e.problem) return;
  const author = s.author;
  s.status = "pending";
  s.feedback = "Checking captured revision…";
  e.state = "submitted";
  try {
    if (
      s.completionRequest &&
      (!completionConnected(g, e) ||
        status().mode !== s.completionRequest.provider)
    )
      throw Error(
        "Reconnect the original completion provider to retry this saved evaluation",
      );
    if (author !== "human" && !autonomousAllowed())
      throw Error(
        "Unattended NPC work was disabled; captured submission retained without release",
      );
    if (author !== "human" && e.problem.runtime && !s.completionRequest) {
      const job = await runWorkspace(g, e, r, author);
      if (!job?.receipt?.executed)
        throw Error(
          "NPC runtime validation unavailable; captured submission retained without automatic retry",
        );
    }
    let result: { complete: boolean; feedback: string; qualified: string[] };
    if (!s.completionRequest) {
      // Bind a disconnected capture to the provider that wrote the question.
      const provider: Provider = capturedProvider(e.problem);
      const payload = {
        requestId: s.id,
        encounterId: e.id,
        problem: e.problem,
        submission: { ...s },
        submitter: author,
        responseFormat: {
          complete: "boolean",
          feedback: "string",
          qualified: "array of survivor IDs",
        },
        instruction:
          "Judge the exact submitted answer against the question and rubric. Accept only a semantically correct, sufficiently supported answer. Headings, answer length and chat activity are not proof. Return only the structured completion JSON; gameplay acceptance does not certify individual mastery.",
        ...(author !== "human"
          ? {
              provider,
              autonomyAllowed: true,
            }
          : {}),
        history:
          author === "human" ? e.history : groupSnapshot(e, s.id, s.seq).events,
        executions: (e.executions ?? [])
          .filter(
            (j) =>
              j.revision === s.revision &&
              j.code === s.content &&
              j.status === "finished",
          )
          .map(executionEvidence),
      };
      s.completionRequest = {
        provider,
        payloadJson: JSON.stringify(payload),
      };
    }
    if (g.study.profile === "live" && !live(g))
      throw Error(
        "Live completion unavailable; captured work retained. Development evaluation cannot replace it.",
      );
    if (completionConnected(g, e)) {
      const saved = s.completionRequest,
        payload = JSON.parse(saved.payloadJson);
      if (status().mode !== saved.provider)
        throw Error(
          "Reconnect the original completion provider to retry this saved evaluation",
        );
      if (
        payload.requestId !== s.id ||
        payload.encounterId !== e.id ||
        payload.submitter !== s.author ||
        payload.submission?.id !== s.id ||
        payload.submission?.content !== s.content ||
        payload.submission?.revision !== s.revision ||
        payload.submission?.seq !== s.seq ||
        payload.submission?.author !== s.author ||
        JSON.stringify(payload.problem) !== JSON.stringify(e.problem)
      )
        throw Error(
          "Saved completion request no longer matches its captured question and revision",
        );
      result =
        author === "human"
          ? await request<typeof result>("complete", payload)
          : await optionalProviderRequest<typeof result>(
              g,
              saved.provider,
              "complete",
              payload,
              "autonomous-work",
              true,
            );
      if (
        !completionConnected(g, e) ||
        status().mode !== saved.provider ||
        JSON.stringify(payload.problem) !== JSON.stringify(e.problem)
      )
        throw Error(
          "Original completion connection or captured question changed during review",
        );
    } else {
      throw Error(
        "The study connection is unavailable. Check that Claude CLI is installed and signed in, then retry. No AI acceptance was received; your captured answer is saved.",
      );
    }
    result = completionVerdict(result);
    applyCompletion(g, e, r, s, result);
  } catch (err) {
    if ((e.state as string) === "consumed" && e.accepted === s.id) return;
    s.status = "error";
    s.feedback = `Evaluation unavailable; snapshot retained. ${String(err)}`;
    if ((e.state as string) !== "consumed" && g.encounters[e.id] === e)
      e.state = "in-progress";
  }
}
// Both legacy answer reviews and conversational completion use the same reward
// and evidence path. Only a validated provider reply may reach this function.
function applyCompletion(
  g: Game,
  e: Encounter,
  r: Roadmap,
  s: Submission,
  result: ReturnType<typeof completionVerdict>,
  onAssessment?: () => void,
) {
  const author = s.author;
  if ((e.state as string) === "consumed" || g.encounters[e.id] !== e) {
    if (e.accepted === s.id) return;
    s.status = "error";
    s.feedback =
      "This evaluation was superseded; the accepted terminal record remains unchanged.";
    return;
  }
  s.status = result.complete ? "complete" : "needs-work";
  s.feedback = result.feedback;
  if (result.complete) {
    const allowed = new Set(
      e.history
        .filter(
          (h) =>
            [
              "defense",
              "edit",
              "reasoning",
              "test",
              "npc-thought",
              "npc-proposal",
            ].includes(h.kind) && h.seq <= s.seq,
        )
        .map((h) => h.author),
    );
    const qualified = [
      ...new Set([
        ...e.contributors.filter((a) =>
          e.history.some((h) => h.author === a && h.seq <= s.seq),
        ),
        ...result.qualified.filter((id) => allowed.has(id)),
      ]),
    ];
    e.contributors = qualified;
    if (author === "human") countStudyTurn(g.study, e);
    complete(g, e.id, s.id, qualified, result.feedback);
    e.workspace = s.content;
    e.revision = s.revision;
    finishVisit(r, g.study, e);
    if (
      // Variety practice records probe knowledge but is never assessed as a visit.
      !e.problem?.contract.practice &&
      (author === "human" ||
        e.history.some(
          (h) =>
            h.author === "human" &&
            ["edit", "reasoning", "test", "defense"].includes(h.kind) &&
            h.seq <= s.seq,
        ))
    )
      void assess(g, e, r, s.seq).then(onAssessment, onAssessment);
  } else {
    e.state = "in-progress";
    if (author !== "human") {
      const feedback = event(
        g,
        "validation",
        "NPC submission needs more work.",
        e.floor,
        "validator",
        e.id,
      );
      e.history.push({
        seq: feedback.seq,
        author: "validator",
        kind: "validation",
        text: `Semantic feedback for ${s.id}: ${result.feedback}. This is not a runtime receipt.`,
        at: g.time,
        revision: s.revision,
        refs: [s.id],
      });
    }
  }
}
/** Opt-in public NPC work. Never retries a captured submission or failed batch. */
const autonomousRuns = new WeakMap<Game, Promise<void>>();
export function autonomousNpcWork(
  g: Game,
  r: Roadmap,
): Promise<void> | undefined {
  if (
    !live(g) ||
    !autonomousAllowed() ||
    !status().capabilities.includes("materialize-work") ||
    g.status !== "playing"
  )
    return;
  const provider = activeProvider();
  const running = autonomousRuns.get(g);
  if (running) return running;
  for (const e of Object.values(g.encounters)) {
    if (
      !hasHumanStudyContext(e) ||
      !isAiProvenance(e.problem?.provenance) ||
      e.mode !== "shared" ||
      e.state === "consumed" ||
      humanUsingWorkspace(g, e) ||
      e.submissions.some((s) => s.status === "pending")
    )
      continue;
    const p = e.proposals?.find(
      (p) =>
        p.autonomous &&
        (p.provider ?? "study-mode") === provider &&
        !p.submissionId &&
        p.state !== "dismissed" &&
        npcAtWorkstation(g, e, p.author) &&
        (p.state === "pending"
          ? p.sourceRevision === e.revision
          : p.appliedAutomatically && p.appliedRevision === e.revision),
    );
    let task: Promise<void> | undefined;
    if (p)
      task = (async () => {
        try {
          if (p.state === "pending") applyAutonomousProposal(g, e, p.id);
          await submit(g, e, r, p.author, p.id);
        } catch (error) {
          e.materializationNotice = String(error);
          p.state = "dismissed";
        }
      })();
    else
      task = materializeNpcWork(
        g,
        e,
        (payload) =>
          optionalProviderRequest(
            g,
            provider,
            "materialize-work",
            payload,
            "autonomous-work",
            true,
          ),
        false,
        { background: true, allowAutonomous: true, provider },
      );
    if (task) {
      autonomousRuns.set(g, task);
      void task.finally(() => autonomousRuns.delete(g));
      return task;
    }
  }
  return undefined;
}

export function reviewEnvironmentObservation(
  g: Game,
  r: Roadmap,
  id: string,
  retry = false,
) {
  if (!live(g) || !status().capabilities.includes("review-environment"))
    throw Error(
      "Environment review is unavailable. The saved packet remains downloadable for external review.",
    );
  const provider = activeProvider();
  return reviewEnvironment(
    g,
    r,
    id,
    async (payload) => {
      const connected = () =>
        live(g) &&
        status().mode === provider &&
        status().capabilities.includes("review-environment");
      if (!connected())
        throw Error(
          "Reconnect the original environment review provider; captured packet remains saved",
        );
      const result = await request("review-environment", payload);
      if (!connected())
        throw Error("Environment review provider changed; no result applied");
      return result;
    },
    retry,
    provider,
  );
}

export function reconcileUploadedRoadmap(
  g: Game,
  r: Roadmap,
  candidate: string,
  retryId?: string,
  captured?: () => Promise<void>,
) {
  if (!live(g) || !status().capabilities.includes("reconcile-roadmap"))
    throw Error(
      "Roadmap reconciliation is unavailable; comparison and files remain available without changing learning state",
    );
  const provider = activeProvider();
  return reconcileRoadmap(
    g,
    r,
    candidate,
    async (payload) => {
      if (!live(g) || status().mode !== provider)
        throw Error(
          "Reconnect the original roadmap review provider; captured files remain saved",
        );
      await captured?.();
      if (!live(g) || status().mode !== provider)
        throw Error(
          "Reconnect the original roadmap review provider; captured files remain saved",
        );
      return request("reconcile-roadmap", payload);
    },
    retryId,
    provider,
  );
}
