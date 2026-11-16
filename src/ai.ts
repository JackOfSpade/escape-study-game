import { fnv1a } from "./hash";
import { QUESTION_DESIGN_GUIDANCE } from "../scripts/lib/study-question-policy.mjs";
import {
  SEGMENT_GENERATION_GUIDANCE,
  validateQuestionSegments,
} from "../scripts/lib/question-segments.mjs";
import {
  completeSegment,
  isActiveVisit,
  segmentPayload,
  threadEncounters,
} from "./question-thread";
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
import { isRecord } from "./records";
export { checkBridge, status, type BridgeStatus } from "./bridge-client";
import { browserSteps } from "../scripts/browser-runner/spec.mjs";
import {
  beginVisit,
  countStudyTurn,
  eligible,
  finishVisit,
} from "./curriculum";
import { reviewEnvironment } from "./environment-review";
import { executionEvidence } from "./execution";
import { trackProgressContext } from "./imported-proof";
import {
  encounterKey,
  initialLearner,
  interruptLearningAttempt,
  registerScopes,
} from "./learner";
import {
  type Provider,
  type Contract,
  type Encounter,
  type StudyRecord,
  type Message,
  type Problem,
  type Roadmap,
  type Submission,
  nextSeq,
} from "./model";
import { reconcileRoadmap } from "./roadmap-adoption";
import { settleTutorRequest } from "./run-learning";
import { assess } from "./learning-assessment";
import {
  recordTopicAssessments,
  topicAssessmentContext,
  validateTopicAssessments,
} from "./topic-assessment";
export { assess } from "./learning-assessment";

/** The stored author of every tutor message, in saved conversations too. */
const TUTOR_AUTHOR = "Terminal AI";
const live = (g: StudyRecord) =>
  g.study.profile === "live" && status().mode !== "development";
const interactiveConnected = (g: StudyRecord) =>
  live(g) ||
  (g.study.profile === "development" && status().mode !== "development");
const completionConnected = (g: StudyRecord, e: Encounter) =>
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
const isAiProvenance = (p?: string): p is Provider =>
  p === "study-mode" || p === "chatgpt-handoff" || p === "claude-cli";
function validateProblem(
  p: Problem,
  e: Encounter,
  r: Roadmap,
  g: StudyRecord,
  c = eligible(r, g.study),
) {
  try {
    validateQuestionSegments(p);
  } catch (error) {
    throw Error(
      `Invalid generated question plan for ${e.id}: ${String(error)}`,
    );
  }
  if (
    !p ||
    typeof p.prompt !== "string" ||
    p.prompt.length > 30000 ||
    typeof p.title !== "string" ||
    !Array.isArray(p.rubric) ||
    !p.rubric.every((x) => typeof x === "string") ||
    typeof p.starter !== "string" ||
    // A reply without a contract is malformed, not a property-access crash.
    !isRecord(p.contract) ||
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
const generationCurrent = (g: StudyRecord, e: Encounter, id: string) =>
  g.encounters[e.id] === e &&
  e.generation === id &&
  e.state !== "consumed" &&
  !e.problem;
const QUESTION_GENERATION_POLICY =
  "Diagnose before teaching. Write a standalone question: the prompt alone must supply the essential scenario, interface, implementation, data, timing and business-rule facts needed to answer without using the chat. For classification, list the concrete items to classify and their relevant behavior, lifetime and source without supplying their classifications. For tracing, debugging or critique, supply the relevant code, event sequence or evidence. Distinguish fixed facts from intentional design choices; if the learner may choose an example or an approach, say so explicitly rather than expecting them to infer an unspecified implementation. Ask a bounded task that matches the supplied scenario; never paste a capability statement into an unrelated generic story. Every requirement in the rubric must be visible in the question; do not grade unstated assumptions or add unrelated decisions, personal history or edge cases. Before returning the question, check that it can be answered from the prompt alone and repair missing context without revealing the solution. For D1, keep the learner workspace starter empty; put essential scenario or code-reading material in the prompt without supplying the key explanation, endpoint update, worked result or a leading solution hint. Do not interpret an objective's implementation verb as a D1 implementation requirement. Preserve legitimate prior context and assistance attribution without presenting supplied steps as fresh independent understanding. Use probeRecords: build the question around open gaps inside the eligible scope with the facet they blocked as the apex; only a gap marked reuseInScopeDefinitions may add its exact facet id to scopeDefinitions, and existing stable scope definitions are copied exactly; do not spend the question on established facets unless the scope requires them; re-ask what a closed gap blocked. The prompt is read by the learner: never mention the scheduled scope, objective IDs, tiers, depth, scheduling or that this is a formal visit; ask the question in plain language. Keep it minimal: write the smallest self-contained diagnostic that exercises the objective, with one main problem and at most one or two directly connected follow-ups. Include only the essential facts, not pasted project context or a full-project audit. For code review, include the actual code under review, including any required helper and its authorization semantics; a prose proposal supports design review only. Prefer short snippets, traces or evidence, and never turn an objective's scope verbs into a D1 implementation task. The visible task and rubric must match, without leaking the solution. An honestly integrative objective may stay integrative on a small feature. A narrow example never establishes unrelated facets or mastery. " +
  QUESTION_DESIGN_GUIDANCE;
const QUESTION_SEGMENT_GUIDANCE = SEGMENT_GENERATION_GUIDANCE;
const QUESTION_RUNTIME_SUPPORT = {
  scripts: ["python", "typescript"],
  react:
    "Optional D2+ TypeScript runtime: {language:typescript,environment:react,steps:[{kind:click|fill|press|expect-text|expect-count,selector:CSS,...}]}. Single TSX module default-exporting App; only installed React imports, no network, workers or external packages. At most eight bounded interaction/check steps. Runtime errors/DOM checks/preview are observations, never automatic correctness or ENV credit; TSX transpilation is not static TypeScript type checking. Docker runtime must be installed locally.",
};
/** The request for one generated question. */
function generationPayload(
  g: StudyRecord,
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
    segmentGuidance: QUESTION_SEGMENT_GUIDANCE,
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
/** Older saves can hold work waiting on a chat connection that no longer
 * exists. Free it so the learner can carry on in the workspace; the question
 * and the learner's own work stay. */
export function releaseRetiredChatRequests(g: StudyRecord) {
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
/** Where a question request is, for the progress display. The
 * request is one bridge call, so these are the client-side stages around it. */
type GenerationPhase = "joining" | "writing" | "checking";
const generationProgresses = new WeakMap<
  Encounter,
  { id: string; phase: GenerationPhase; startedAt: number }
>();
/** The question's own request, while it is writing the problem. */
export function generatingEncounter(e: Encounter) {
  return !e.problem && e.state !== "consumed" && e.generation ? e : undefined;
}
export function generationProgress(e: Encounter) {
  const p = generationProgresses.get(e);
  return p && p.id === e.generation ? p : undefined;
}
function markGeneration(e: Encounter, id: string, phase: GenerationPhase) {
  const p = generationProgresses.get(e);
  if (p?.id === id) p.phase = phase;
  else generationProgresses.set(e, { id, phase, startedAt: Date.now() });
}
export async function ensureProblem(g: StudyRecord, e: Encounter, r: Roadmap) {
  if (e.problem || e.state === "consumed") return;
  // Every question comes from Claude; there is no local stand-in.
  if (!live(g)) {
    e.error = "Claude is not connected. Your work is saved.";
    return;
  }
  if (e.generation) return;
  const generation =
      e.pendingGeneration?.requestId ??
      `gen-${g.id}-${e.id}-${crypto.randomUUID()}`,
    study = g.study,
    profile = study.profile;
  e.generation = generation;
  markGeneration(e, generation, "writing");
  try {
    if (
      e.pendingGeneration &&
      // Saves from before providers were recorded were ChatGPT handoffs.
      status().mode !== (e.pendingGeneration.provider ?? "chatgpt-handoff")
    )
      throw Error(
        "Reconnect the original generation provider to retry this saved question",
      );
    // A saved generation keeps its contract.
    const contract =
      (e.pendingGeneration?.payload?.contract as Contract | undefined) ??
      eligible(r, study);
    const payload =
      e.pendingGeneration?.payload ??
      generationPayload(g, r, contract, generation, e.id);
    const provider = activeProvider();
    e.pendingGeneration = {
      provider,
      requestId: generation,
      payload: structuredClone(payload),
    };
    const p = await request<Problem>("generate", payload);
    p.provenance = provider;
    if (
      g.study !== study ||
      study.profile !== profile ||
      !generationCurrent(g, e, generation)
    )
      return;
    markGeneration(e, generation, "checking");
    validateProblem(p, e, r, g, contract);
    g.study.learner ??= initialLearner(r);
    registerScopes(r, g.study.learner, { ...e, problem: p });
    e.problem = p;
    delete e.error;
    delete e.pendingGeneration;
    if (e.revision === 0 && !e.workspace) e.workspace = p.starter;
    e.state = "in-progress";
  } catch (err) {
    if (
      g.study === study &&
      study.profile === profile &&
      generationCurrent(g, e, generation)
    )
      e.error = String(err);
  } finally {
    if (e.generation === generation) delete e.generation;
  }
}
/** A workspace question that can be thrown away and written again. */
const regenerable = (g: StudyRecord, e: Encounter) =>
  !!e.studyOnly &&
  !!e.problem &&
  e.state !== "consumed" &&
  !e.generation &&
  g.encounters[e.id] === e;
export const canRegenerate = (g: StudyRecord, e: Encounter) =>
  regenerable(g, e) && live(g) && status().mode === "claude-cli";
/**
 * Discard a workspace question and its conversation and ask for a fresh one on
 * the same scheduled contract, so a change to question writing can be seen
 * without answering first. Nothing is completed: the visit stays bound to this
 * encounter, no assessment runs, and what the discarded conversation recorded
 * about the learner is removed. The caller then prepares the question as usual.
 */
export function regenerateQuestion(g: StudyRecord, e: Encounter, r: Roadmap) {
  if (!regenerable(g, e)) return false;
  const contract = structuredClone(e.problem!.contract);
  // Without this the identical request tends to return the same question.
  const replaces = {
    title: e.problem!.title,
    prompt: e.problem!.prompt.slice(0, 1200),
  };
  const key = encounterKey(e);
  const mine = (record: { encounter: string }) =>
    record.encounter === key || record.encounter === e.id;
  const study = g.study;
  if (study.knowledgeGaps)
    study.knowledgeGaps = study.knowledgeGaps.filter((x) => !mine(x));
  if (study.knowledgeEstablished)
    study.knowledgeEstablished = study.knowledgeEstablished.filter(
      (x) => !mine(x),
    );
  if (e.thread && study.thread?.id === e.thread.id) delete study.thread;
  delete e.problem;
  delete e.thread;
  delete e.probe;
  delete e.tutorRequests;
  delete e.chatDraft;
  delete e.executions;
  delete e.error;
  delete e.workspaceBase;
  delete e.problemPresentedSequence;
  delete e.problemPresentedAt;
  e.tutor = [];
  e.history = [];
  e.submissions = [];
  e.workspace = "";
  e.revision = 0;
  e.state = "available";
  // A saved generation keeps its contract: the same topic is asked again.
  const requestId = `gen-${g.id}-${e.id}-${crypto.randomUUID()}`;
  e.pendingGeneration = {
    provider: activeProvider(),
    requestId,
    payload: structuredClone({
      ...generationPayload(g, r, contract, requestId, e.id),
      replaces,
    }),
  };
  return true;
}
export function edit(
  g: StudyRecord,
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
  const ev = { seq: nextSeq(g) };
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
export function presentProblem(g: StudyRecord, e: Encounter, r?: Roadmap) {
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
      // A question outside the schedule stays open without becoming a visit.
      e.error = String(err);
    }
  }
  if (!e.problem || e.problemPresentedSequence !== undefined) return;
  const ev = { seq: nextSeq(g) };
  e.problemPresentedSequence = ev.seq;
  if (e.problemPresentedAt === undefined) e.problemPresentedAt = Date.now();
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
  g: StudyRecord,
  e: Encounter,
  author: string,
  kind: Message["kind"],
  text: string,
  provenance: string,
  sourceSeq?: number | number[],
) {
  const ev = { seq: nextSeq(g) };
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
  e.tutor.push(m);
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
/** Record that each tutor message became visible to the learner. */
export function presentMessages(g: StudyRecord, e: Encounter) {
  for (const m of e.tutor) {
    if (m.presented !== undefined) continue;
    const seq = nextSeq(g);
    m.presented = seq;
    const original = e.history.find((h) => h.seq === m.seq);
    if (original) original.presented = seq;
  }
}
const tutorInFlight = new WeakMap<object, Promise<void>>();
export function retryTutorRequest(
  g: StudyRecord,
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
            "Saved terminal conversation changed during review; no credit applied",
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
      // Only the conversation opened last may finish the continued question's part.
      if (dialogue && e.thread && !isActiveVisit(g, e)) answer.complete = false;
      if (dialogue && answer.complete === true && !r)
        throw Error(
          "Reconnect this saved conversation with its curriculum before accepting the answer",
        );
      if (
        dialogue &&
        answer.complete === true &&
        e.state !== "consumed" &&
        e.submissions.some((s) => s.status === "pending")
      )
        throw Error(
          "An earlier answer check is still pending; no duplicate credit applied",
        );
      // Validate the whole assessment list before any completion effect.
      const topicUpdates =
        dialogue && answer.complete === true && e.state !== "consumed"
          ? validateTopicAssessments(e, answer.topicAssessments)
          : [];
      const delivered = message(
        g,
        e,
        TUTOR_AUTHOR,
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
        const ev = { seq: nextSeq(g) };
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
        // Same synchronous step as the completion: one snapshot holds both or neither.
        if (e.thread && (e.state as string) === "consumed") {
          const finished = completeSegment(g, e, {
            summary: answer.segmentSummary,
          });
          if (finished)
            for (const visit of threadEncounters(g, finished))
              void assess(g, visit, r!);
        }
        if (topicUpdates.length)
          recordTopicAssessments(g, e, topicUpdates, {
            requestId: job.id,
            questionFingerprint: `${e.id}:${fnv1a(JSON.stringify(e.problem))}`,
            startedAt: e.problemPresentedAt,
            sourceHash:
              payload.topicAssessmentContext?.sourceHash ?? r?.sourceHash,
          });
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
export async function send(
  g: StudyRecord,
  e: Encounter,
  text: string,
  r: Roadmap,
) {
  const problem = e.problem;
  if (!text.trim() || !problem) return;
  if (e.tutorRequests?.some((j) => j.state === "pending")) return;
  for (const job of e.tutorRequests ?? [])
    if (job.state === "interrupted") settleTutorRequest(job, "superseded");
  delete e.error;
  message(g, e, "human", "human", text, "live-human");
  try {
    if (e.state !== "consumed") beginVisit(r, g.study, e);
  } catch {
    /* Non-eligible participation stays unscheduled. */
  }
  if (
    e.mode !== "solo" &&
    g.study.profile !== "live" &&
    !interactiveConnected(g)
  ) {
    e.error =
      "The study connection is unavailable. Check that Claude CLI is installed and signed in, then retry. Your question and answer draft are saved.";
    return;
  }
  const provider = capturedProvider(problem);
  const id = `tutor-${g.id}-${e.id}-${g.seq}`;
  const capture = () => ({
    requestId: id,
    sessionId: `${g.id}/${e.id}/private`,
    ...(e.mode === "solo" && e.state !== "consumed"
      ? {
          mode: "terminal-dialogue",
          responseFormat: TERMINAL_DIALOGUE_FORMAT,
          instruction: TERMINAL_DIALOGUE_INSTRUCTION,
          probe: encounterProbeContract(e, problem),
          ...(e.thread ? { segment: segmentPayload(g, e) } : {}),
          ...(g.study.profile === "live" && r
            ? {
                topicAssessmentContext: topicAssessmentContext(
                  g,
                  r,
                  problem.contract,
                ),
              }
            : {}),
        }
      : {}),
    problem,
    workspace: e.workspace,
    draftRevision: e.revision,
    submissions: e.submissions.slice(-5).map((s) => ({
      id: s.id,
      revision: s.revision,
      content: s.content,
      status: s.status,
      feedback: s.feedback,
    })),
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
  });
  let payloadJson: string;
  try {
    payloadJson = JSON.stringify(capture());
  } catch (err) {
    // The message is recorded; a context that cannot be captured (a track
    // the roadmap no longer holds, say) is reported, never left unhandled.
    e.error = `Your message is saved, but its question context could not be prepared. ${String(err)}`;
    return;
  }
  (e.tutorRequests ??= []).push({
    id,
    provider,
    payloadJson,
    questionSequence: e.tutor.at(-1)!.seq,
    state: "pending",
  });
  await retryTutorRequest(g, e, id, r);
}
export async function submit(g: StudyRecord, e: Encounter, r: Roadmap) {
  if (
    !e.problem ||
    e.state === "consumed" ||
    e.submissions.some((s) => s.status === "pending")
  )
    return;
  try {
    beginVisit(r, g.study, e);
  } catch (err) {
    e.error = String(err);
  }
  const s: Submission = {
    id: `submit-${g.id}-${nextSeq(g)}`,
    revision: e.revision,
    author: "human",
    content: e.workspace,
    status: "pending",
    feedback: "Checking captured revision…",
    seq: g.seq,
  };
  e.submissions.push(s);
  e.state = "submitted";
  return retrySubmission(g, e, r, s.id);
}
const completionInFlight = new WeakMap<Submission, Promise<void>>();
export function retrySubmission(
  g: StudyRecord,
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
  g: StudyRecord,
  e: Encounter,
  r: Roadmap,
  s: Submission,
) {
  if (!e.problem) return;
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
    let result: { complete: boolean; feedback: string; qualified: string[] };
    if (!s.completionRequest) {
      // Bind a disconnected capture to the provider that wrote the question.
      const provider: Provider = capturedProvider(e.problem);
      const payload = {
        requestId: s.id,
        encounterId: e.id,
        problem: e.problem,
        submission: { ...s },
        submitter: s.author,
        responseFormat: {
          complete: "boolean",
          feedback: "string",
          qualified: "array of IDs",
        },
        instruction:
          "Judge the exact submitted answer against the question and rubric. Accept only a semantically correct, sufficiently supported answer. Headings, answer length and chat activity are not proof. Return only the structured completion JSON; answer acceptance does not certify individual mastery.",
        history: e.history,
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
      result = await request<typeof result>("complete", payload);
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
// Every validated completion uses this exactly-once reward and evidence path.
// Only a validated provider reply may reach it; tests apply a fixed verdict here.
export function applyCompletion(
  g: StudyRecord,
  e: Encounter,
  r: Roadmap,
  s: Submission,
  result: ReturnType<typeof completionVerdict>,
  onAssessment?: () => void,
) {
  if ((e.state as string) === "consumed" || g.encounters[e.id] !== e) {
    if (e.accepted === s.id) return;
    s.status = "error";
    s.feedback =
      "This evaluation was superseded; the accepted record remains unchanged.";
    return;
  }
  s.status = result.complete ? "complete" : "needs-work";
  s.feedback = result.feedback;
  if (result.complete) {
    const worked = e.history.some(
      (h) =>
        h.author === "human" &&
        ["defense", "edit", "reasoning", "test"].includes(h.kind) &&
        h.seq <= s.seq,
    );
    e.contributors =
      worked && result.qualified.includes("human") ? ["human"] : [];
    countStudyTurn(g.study, e);
    completeQuestion(g, e, s.id, result.feedback);
    e.workspace = s.content;
    e.revision = s.revision;
    finishVisit(r, g.study, e);
    // Variety practice records probe knowledge but is never assessed as a visit.
    if (!e.problem?.contract.practice)
      void assess(g, e, r, s.seq).then(onAssessment, onAssessment);
  } else {
    e.state = "in-progress";
  }
}
/** Close an answered question: its record is final and its attempt stays open
 * only until a valid assessment settles it. A closed question stays closed. */
export function completeQuestion(
  g: StudyRecord,
  e: Encounter,
  submissionId: string,
  provenance: string,
) {
  if (e.state === "consumed") return false;
  e.state = "consumed";
  if (g.study.learner) interruptLearningAttempt(g.study.learner, e);
  e.accepted = submissionId;
  const submission = e.submissions.find((s) => s.id === submissionId);
  if (submission) {
    submission.status = "complete";
    submission.feedback = provenance;
    e.workspace = submission.content;
    e.revision = submission.revision;
  }
  e.chatOpen = false;
  e.history.push({
    seq: nextSeq(g),
    author: "system",
    kind: "completion",
    text: `Study question completed. ${provenance}`,
    at: g.time,
    revision: e.revision,
  });
  return true;
}
export function reviewEnvironmentObservation(
  g: StudyRecord,
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
  g: StudyRecord,
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
