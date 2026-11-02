import {
  validateTopicAssessments,
  topicAssessmentTopics,
  TOPIC_ASSESSMENT_INSTRUCTION,
} from "../scripts/lib/topic-assessment.mjs";
import {
  topicAssessmentContext,
  recordTopicAssessments,
} from "./topic-assessment";
import { QUESTION_ADAPTATION_GUIDANCE } from "../scripts/lib/study-question-policy.mjs";
/**
 * Direct native ChatGPT question sessions.
 *
 * The game posts one immutable question snapshot to a regular ChatGPT
 * conversation through the handoff bridge. The learner answers natively in
 * ChatGPT; nothing is relayed per answer. When the assistant finishes, the
 * bridge returns one completion with the transcript it attributes to the
 * conversation. That completion is validated in full against the frozen
 * snapshot before anything in the game is mutated.
 */
import {
  applyDirectCompletion,
  assess,
  presentProblem,
  recordAttributedMessage,
} from "./ai";
import {
  bridgeRequest,
  DIRECT_STUDY_TIMEOUT_MS,
  nativeStudyScope,
  newStudyChat,
  status,
} from "./bridge-client";
import { completionVerdict } from "./completion-verdict";
import { beginVisit, countStudyTurn, eligible } from "./curriculum";
import { encounterKey } from "./learner";
import { sha256 } from "./digest";
import { isRecord } from "./records";
import {
  concessionFeedback,
  encounterProbeContract,
  knowledgeProbeContext,
  parseProbeReply,
  probeFacets,
  probeState,
  recordProbeTurn,
  type ProbeFacet,
  type ProbeReply,
  type ProbeFinding,
} from "./knowledge-probe";
import {
  event,
  type DirectStudySession,
  type Encounter,
  type Game,
  type Provider,
  type Roadmap,
  type Submission,
} from "./model";

export type DirectStudySessionRecord = DirectStudySession;
const sessionOf = (e: Encounter) => e.directStudy;

export const DIRECT_STUDY_CAPABILITY = "direct-study";
export const DIRECT_STUDY_MODE = "terminal-direct";
/** Native transcript entries are model-transcribed, never live game input. */
export const NATIVE_TRANSCRIPT_PROVENANCE = "chatgpt-host-model-transcript";
export const TRANSCRIPT_LIMITS = {
  entries: 100,
  entryChars: 8000,
  totalChars: 100_000,
} as const;
const DIRECT_PROVIDER: Provider = "chatgpt-handoff";

export const DIRECT_STUDY_FORMAT = {
  topicAssessments: [
    {
      topicId: "each topic ID in topicAssessmentContext.topicIds",
      text: "your free-form updated assessment of this learner’s knowledge, including reasonable tentative inferences",
    },
  ],
  text: "string, final assistant message (<=8000 chars)",
  complete: "true",
  outcome: "solved|gap",
  questionFingerprint: "the exact questionFingerprint of this question",
  transcript:
    "[{role:'user'|'assistant', text}] exact native chat turns in order (<=100 entries, each <=8000 chars, total <=100000)",
  knowledge: {
    facets: [
      {
        id: "a probe facet id from probe.facets",
        status: "demonstrated|implied|gap",
        impliedBy: "for implied only",
        note: "short evidence excerpt",
        partOf: "declared prerequisite part only",
        description: "declared part description only",
      },
    ],
    signal: { fluency: "fluent|partial|guessing|declared-gap", note: "" },
  },
} as const;

export const DIRECT_STUDY_INSTRUCTION =
  "@study: Present the issued task in this regular ChatGPT conversation and talk normally until it is finished. Preserve what is assessed, with freedom to improve how it is explained. Your own explanations are assistance, never learner evidence. When finished submit one logical completion through finish_study_question with outcome solved (only when the learner's own answers establish the named facets as demonstrated) or gap (naming each missing facet with status gap; never mark unasked facets as gaps), the exact questionFingerprint, the exact transcript of the native turns in order, and knowledge.facets naming the observed findings. A solved outcome must establish every original base facet; a gap outcome records only explicit missing facets and may leave unasked siblings unassessed. The tool supplies the completion flag; do not pass a complete argument. Treat this as one logical completion: if a call returns retryable or fails with a temporary connection error or timeout, retry the identical finish_study_question arguments at most once in this turn. An identical retry is safe if the first response was lost. Do not retry a permission or safety denial, authentication failure, disconnected chat or stale question; explain the returned error and leave the question pending for recovery in this same chat. Never report a submission as accepted without an accepted tool receipt. Follow any bound continuation in the tool receipt to complete the separate source-bound assessment in this same chat; completion alone never certifies independent mastery. " +
  QUESTION_ADAPTATION_GUIDANCE +
  " " +
  TOPIC_ASSESSMENT_INSTRUCTION;

const inFlight = new WeakMap<object, Promise<void>>();
const opening = new WeakMap<Encounter, Promise<void>>();

/** Unfinished question, including one explicitly stopped by the learner. */
export function unfinishedDirectStudy(e: Encounter): boolean {
  const s = sessionOf(e);
  return !!s && ["pending", "interrupted", "paused"].includes(s.state);
}

/** Stop accepting the old chat's result without discarding the issued task. */
export function pauseDirectStudy(e: Encounter): boolean {
  const s = sessionOf(e);
  if (!s || !["pending", "interrupted"].includes(s.state)) return false;
  s.state = "paused";
  delete s.error;
  delete s.transportPhase;
  delete s.transportPhaseAt;
  return true;
}

/** A fresh delivery identity prevents an old chat's completion being reused. */
export async function resumeDirectStudyInNewChat(
  g: Game,
  e: Encounter,
  r: Roadmap,
  onChange?: () => void,
): Promise<void> {
  const previous = sessionOf(e);
  if (previous?.state !== "paused") return;
  let payload: ReturnType<typeof buildPayload>;
  try {
    payload = await savedPayload(previous, e);
  } catch (error) {
    previous.error = String(error);
    onChange?.();
    return;
  }
  // Another click can have resumed this same paused session while hashing.
  if (sessionOf(e) !== previous || previous.state !== "paused") return;
  const id = `direct-${crypto.randomUUID()}`;
  payload.requestId = id;
  previous.state = "superseded";
  e.directStudy = {
    id,
    createdAt: Date.now(),
    provider: previous.provider,
    payloadJson: JSON.stringify(payload),
    questionFingerprint: previous.questionFingerprint,
    state: "interrupted",
  };
  newStudyChat();
  return retryDirectStudy(g, e, r, onChange);
}

interface Snapshot {
  runId: string;
  encounterId: string;
  problem: unknown;
  workspace: string;
  revision: number;
  profile: string;
  provider: Provider;
}
function snapshotOf(g: Game, e: Encounter): Snapshot {
  return {
    runId: e.runId ?? g.id,
    encounterId: e.id,
    problem: e.problem ?? null,
    workspace: e.workspace,
    revision: e.revision,
    profile: g.study.profile ?? "development",
    provider: DIRECT_PROVIDER,
  };
}
/** Opaque binding of the immutable question snapshot. World time and events
 * are deliberately excluded: only task-invalidating changes alter it. */
export function directStudyFingerprint(g: Game, e: Encounter) {
  return sha256(JSON.stringify(snapshotOf(g, e)));
}

function connected(g: Game) {
  const s = status();
  return (
    s.mode === DIRECT_PROVIDER &&
    s.capabilities.includes(DIRECT_STUDY_CAPABILITY) &&
    (g.study.profile === "live" || g.study.profile === "development")
  );
}

function ownedElsewhere(e: Encounter) {
  return e.mode === "solo" && !!e.owner && e.owner !== "human";
}

function buildPayload(
  g: Game,
  e: Encounter,
  r: Roadmap,
  id: string,
  fingerprint: string,
  guidance?: string,
) {
  const problem = e.problem!;
  const runId = e.runId ?? g.id;
  const track = problem.contract.track;
  const context = knowledgeProbeContext(g, track);
  const supportsTopicAssessments =
    status().capabilities.includes("topic-assessments");
  const responseFormat: Record<string, unknown> = { ...DIRECT_STUDY_FORMAT };
  if (!supportsTopicAssessments) delete responseFormat.topicAssessments;
  return {
    requestId: id,
    sessionId: `${runId}/${e.id}/private`,
    mode: DIRECT_STUDY_MODE,
    runId,
    encounterId: e.id,
    questionFingerprint: fingerprint,
    profile: g.study.profile ?? "development",
    problem,
    workspace: e.workspace,
    draftRevision: e.revision,
    // Captured pre-session conversation, sent once for context only.
    messages: e.tutor.map((m) => ({
      id: m.id,
      author: m.author,
      kind: m.kind,
      text: m.text,
      seq: m.seq,
      provenance: m.provenance,
    })),
    ...(e.chatDraft
      ? { unsentDraft: { text: e.chatDraft, learnerEvidence: false } }
      : {}),
    probe: encounterProbeContract(e, problem),
    probeHistory: (e.probe?.turns ?? []).slice(-16),
    instruction: supportsTopicAssessments
      ? DIRECT_STUDY_INSTRUCTION
      : DIRECT_STUDY_INSTRUCTION.replace(TOPIC_ASSESSMENT_INSTRUCTION, ""),
    responseFormat,
    ...(supportsTopicAssessments
      ? {
          topicAssessmentContext: topicAssessmentContext(
            g,
            r,
            problem.contract,
          ),
        }
      : {}),
    learning: problem.contract,
    scopeDefinitions: problem.scopeDefinitions ?? [],
    ...(context ? { knowledgeContext: context } : {}),
    ...(guidance ? { guidance } : {}),
    studyPrompt: "@study",
    prompt: [
      "@study",
      problem.title,
      problem.prompt,
      problem.rubric.length
        ? `Rubric:\n${problem.rubric.map((x) => `- ${x}`).join("\n")}`
        : "",
      e.workspace ? `Current saved work:\n${e.workspace}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

/** Create (or reuse) the immutable session and launch it without waiting. */
export function beginDirectStudy(
  g: Game,
  e: Encounter,
  r: Roadmap,
  options?: { guidance?: string; onChange?: () => void },
): Promise<void> {
  const pending = opening.get(e);
  if (pending) return pending;
  const operation = openDirectStudy(g, e, r, options);
  opening.set(e, operation);
  const finish = () => opening.delete(e);
  void operation.then(finish, finish);
  return operation;
}

async function openDirectStudy(
  g: Game,
  e: Encounter,
  r: Roadmap,
  options?: { guidance?: string; onChange?: () => void },
): Promise<void> {
  const onChange = options?.onChange;
  if (g.encounters[e.id] !== e) throw Error("Encounter is not in this run");
  if (!e.problem) throw Error("No issued question to study");
  const current = sessionOf(e);
  if (current?.state === "paused") return;
  if (current && inFlight.has(current)) return;
  if (!connected(g)) {
    e.error =
      "Connect ChatGPT with direct study support to open this question there. Your work is saved.";
    onChange?.();
    return;
  }
  if (ownedElsewhere(e)) {
    e.error = "Another survivor owns this terminal.";
    onChange?.();
    return;
  }
  const snapshot = JSON.stringify(snapshotOf(g, e));
  const fingerprint = await sha256(snapshot);
  if (
    g.encounters[e.id] !== e ||
    sessionOf(e) !== current ||
    JSON.stringify(snapshotOf(g, e)) !== snapshot
  )
    throw Error("The question or saved work changed while opening; try again.");
  if (!connected(g) || ownedElsewhere(e)) return;
  if (
    current &&
    (current.state === "pending" || current.state === "interrupted")
  ) {
    if (current.questionFingerprint === fingerprint) {
      void retryDirectStudy(g, e, r, onChange);
      return;
    }
    // The captured task changed; the old session becomes inert but remains saved.
    current.state = "superseded";
    current.error =
      "The question or saved work changed; this captured question is retained but cannot award.";
  } else if (current?.state === "applied") return;
  if (e.state === "consumed") return;
  // Bind matching development visits in both views. An older issued survival
  // question stays answerable without taking over a different scheduled visit.
  // Live issuance remains source-bound through presentProblem.
  if (g.study.profile === "development") {
    const next = eligible(r, g.study),
      c = e.problem!.contract;
    if (
      e.studyOnly ||
      (c.track === next.track &&
        JSON.stringify(c.objectiveIds) === JSON.stringify(next.objectiveIds) &&
        (!g.study.pending || g.study.pending.encounter === encounterKey(e)))
    )
      beginVisit(r, g.study, e);
  }
  presentProblem(g, e, r);
  const runId = e.runId ?? g.id;
  const id = `direct-${runId}-${e.id}-${fingerprint.slice(0, 16)}`;
  const payload = buildPayload(g, e, r, id, fingerprint, options?.guidance);
  const session: DirectStudySessionRecord = {
    id,
    provider: DIRECT_PROVIDER,
    payloadJson: JSON.stringify(payload),
    questionFingerprint: fingerprint,
    state: "interrupted",
    createdAt: Date.now(),
  };
  e.directStudy = session;
  // A native session takes over this same question. A delayed legacy reply
  // must not finish it a second time; retain its captured packet for audit.
  for (const job of e.tutorRequests ?? [])
    if (job.state === "pending" || job.state === "interrupted")
      job.state = "superseded";
  delete e.error;
  onChange?.();
  void retryDirectStudy(g, e, r, onChange);
}

interface Transcript {
  role: "user" | "assistant";
  text: string;
}
interface ValidResponse {
  text: string;
  outcome: "solved" | "gap";
  knowledge?: unknown;
  questionFingerprint: string;
  transcript: Transcript[];
  probe: ProbeReply;
  topicAssessments: { topicId: string; text: string }[];
}

/** Strict, side-effect-free validation of a completion response. */
export function validateDirectResponse(
  answer: unknown,
  fingerprint: string,
  facets: ProbeFacet[],
  previous: ProbeFinding[] = [],
  topicScope?: { topics: string[]; required: boolean },
): ValidResponse {
  if (!isRecord(answer)) throw Error("Invalid direct study response");
  if (
    Object.keys(answer).some(
      (key) =>
        ![
          "text",
          "complete",
          "outcome",
          "questionFingerprint",
          "transcript",
          "knowledge",
          "topicAssessments",
        ].includes(key),
    )
  )
    throw Error("Unknown direct study response field");
  if (answer.complete !== true)
    throw Error("Direct study response must be a completion");
  if (answer.questionFingerprint !== fingerprint)
    throw Error("Direct study response belongs to a different question");
  if (
    typeof answer.text !== "string" ||
    !answer.text.trim() ||
    answer.text.length > TRANSCRIPT_LIMITS.entryChars
  )
    throw Error("Invalid direct study final text");
  if (answer.outcome !== "solved" && answer.outcome !== "gap")
    throw Error("Direct study outcome must be solved or gap");
  const topicAssessments = validateTopicAssessments(
    answer.topicAssessments,
    topicScope?.topics ?? [],
    topicScope?.required ?? false,
  );
  const raw = answer.transcript;
  if (
    !Array.isArray(raw) ||
    !raw.length ||
    raw.length > TRANSCRIPT_LIMITS.entries
  )
    throw Error("Direct study transcript must have 1-100 entries");
  let total = 0;
  const transcript: Transcript[] = [];
  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).some((k) => k !== "role" && k !== "text") ||
      (entry.role !== "user" && entry.role !== "assistant") ||
      typeof entry.text !== "string" ||
      !entry.text.trim() ||
      entry.text.length > TRANSCRIPT_LIMITS.entryChars
    )
      throw Error("Invalid direct study transcript entry");
    total += entry.text.length;
    transcript.push({ role: entry.role, text: entry.text });
  }
  if (total > TRANSCRIPT_LIMITS.totalChars)
    throw Error("Direct study transcript exceeds 100000 characters");
  if (!transcript.some((t) => t.role === "user"))
    throw Error("Direct study transcript has no learner answers");
  const knowledge = answer.knowledge;
  if (
    !isRecord(knowledge) ||
    Object.keys(knowledge).some(
      (key) => key !== "facets" && key !== "signal",
    ) ||
    !Array.isArray(knowledge.facets) ||
    knowledge.facets.length > 64
  )
    throw Error("Direct study knowledge must contain bounded facet findings");
  for (const rawFinding of knowledge.facets) {
    if (
      !isRecord(rawFinding) ||
      Object.keys(rawFinding).some(
        (key) =>
          ![
            "id",
            "status",
            "impliedBy",
            "note",
            "partOf",
            "description",
          ].includes(key),
      ) ||
      typeof rawFinding.id !== "string" ||
      !rawFinding.id.trim() ||
      rawFinding.id.length > 200 ||
      !["demonstrated", "implied", "gap"].includes(String(rawFinding.status))
    )
      throw Error("Invalid direct study facet finding");
    for (const key of ["impliedBy", "note", "partOf", "description"] as const)
      if (
        rawFinding[key] !== undefined &&
        (typeof rawFinding[key] !== "string" ||
          (key !== "note" && !rawFinding[key].trim()) ||
          rawFinding[key].length > (key === "note" ? 400 : 200))
      )
        throw Error(`Invalid direct study facet ${key}`);
    if (
      (rawFinding.status === "implied") !==
      (rawFinding.impliedBy !== undefined)
    )
      throw Error(
        "Implied findings need a demonstrated anchor, used only for implied findings",
      );
    if (
      (rawFinding.partOf !== undefined) !==
      (rawFinding.description !== undefined)
    )
      throw Error(
        "A declared prerequisite needs both a parent and description",
      );
  }
  if (
    knowledge.signal !== undefined &&
    (!isRecord(knowledge.signal) ||
      Object.keys(knowledge.signal).some(
        (key) => key !== "fluency" && key !== "note",
      ) ||
      (knowledge.signal.note !== undefined &&
        (typeof knowledge.signal.note !== "string" ||
          knowledge.signal.note.length > 400)))
  )
    throw Error("Invalid direct study answer signal");
  const probe = parseProbeReply(
    { complete: true, outcome: answer.outcome, knowledge: answer.knowledge },
    facets,
    1,
  );
  // The legacy parser tolerates unknown and duplicate labels when reading old
  // observations. A new completion cannot silently discard forged findings.
  if (probe.findings.length !== knowledge.facets.length)
    throw Error(
      "Direct study findings contain unknown, duplicate or out-of-depth facets",
    );
  for (const [index, finding] of probe.findings.entries()) {
    const rawFinding = knowledge.facets[index];
    const existing = facets.find((facet) => facet.id === finding.id);
    if (
      existing &&
      isRecord(rawFinding) &&
      rawFinding.partOf !== undefined &&
      (existing.partOf !== rawFinding.partOf ||
        existing.description !== rawFinding.description)
    )
      throw Error("A finding cannot redefine an existing question facet");
  }
  const latest = new Map(previous.map((finding) => [finding.id, finding]));
  for (const finding of probe.findings) latest.set(finding.id, finding);
  for (const finding of probe.findings) {
    if (
      finding.status === "implied" &&
      (!finding.impliedBy ||
        latest.get(finding.impliedBy)?.status !== "demonstrated")
    )
      throw Error("An implied facet must name a demonstrated facet");
  }
  const gaps = probe.findings.filter((f) => f.status === "gap");
  if (answer.outcome === "gap" && !gaps.length)
    throw Error("A gap outcome must name the missing facets");
  if (answer.outcome === "solved") {
    if (gaps.length) throw Error("A solved outcome cannot also report gaps");
    const established = (facet: ProbeFacet) => {
      const finding = latest.get(facet.id);
      return (
        finding?.status === "demonstrated" ||
        (finding?.status === "implied" &&
          !!finding.impliedBy &&
          latest.get(finding.impliedBy)?.status === "demonstrated")
      );
    };
    const required = facets.filter((facet) => !facet.partOf);
    if (!required.length || !required.every(established))
      throw Error(
        "A solved outcome must establish every original question facet",
      );
  }
  return {
    text: answer.text,
    outcome: answer.outcome,
    knowledge: answer.knowledge,
    questionFingerprint: fingerprint,
    transcript,
    probe,
    topicAssessments,
  };
}

function digestOf(v: ValidResponse) {
  return sha256(
    JSON.stringify({
      text: v.text,
      outcome: v.outcome,
      knowledge: v.knowledge ?? null,
      questionFingerprint: v.questionFingerprint,
      transcript: v.transcript,
      ...(v.topicAssessments.length
        ? { topicAssessments: v.topicAssessments }
        : {}),
    }),
  );
}

/** Parse and authenticate persisted task bytes before delivery or replacement. */
async function savedPayload(s: DirectStudySession, e: Encounter) {
  if (s.createdAt !== undefined && !Number.isFinite(s.createdAt))
    throw Error("Saved direct question has an invalid creation time");
  const rawPayload = JSON.parse(s.payloadJson);
  if (
    !isRecord(rawPayload) ||
    rawPayload.requestId !== s.id ||
    rawPayload.questionFingerprint !== s.questionFingerprint ||
    rawPayload.mode !== DIRECT_STUDY_MODE ||
    typeof rawPayload.workspace !== "string" ||
    !Number.isSafeInteger(rawPayload.draftRevision) ||
    !isRecord(rawPayload.problem)
  )
    throw Error("Saved direct question does not match its session");
  const payload = rawPayload as unknown as ReturnType<typeof buildPayload>;
  if (
    payload.sessionId !== `${payload.runId}/${e.id}/private` ||
    (payload.profile !== "live" && payload.profile !== "development") ||
    payload.encounterId !== e.id ||
    !payload.runId ||
    payload.draftRevision < 0 ||
    s.provider !== DIRECT_PROVIDER ||
    (await sha256(
      JSON.stringify({
        runId: payload.runId,
        encounterId: payload.encounterId,
        problem: payload.problem,
        workspace: payload.workspace,
        revision: payload.draftRevision,
        profile: payload.profile,
        provider: s.provider,
      }),
    )) !== s.questionFingerprint
  )
    throw Error("Saved direct question has an invalid immutable identity");
  return payload;
}

/** Retry the exact saved session; resolves after completion or interruption. */
export function retryDirectStudy(
  g: Game,
  e: Encounter,
  r: Roadmap,
  onChange?: () => void,
): Promise<void> {
  const s = sessionOf(e);
  if (!s || (s.state !== "pending" && s.state !== "interrupted"))
    return Promise.resolve();
  const running = inFlight.get(s);
  if (running) return running;
  s.state = "pending";
  delete s.error;
  delete s.transportPhase;
  delete s.transportPhaseAt;
  const operation = (async () => {
    try {
      if (!connected(g) || status().mode !== s.provider)
        throw Error(
          "Reconnect ChatGPT with direct study support to resume this exact question",
        );
      const payload = await savedPayload(s, e);
      const archived = () => g.study.archives.includes(e);
      const check = async () => {
        if (s.createdAt !== undefined && !Number.isFinite(s.createdAt))
          throw Error("Saved direct question has an invalid creation time");
        if ((g.encounters[e.id] !== e && !archived()) || sessionOf(e) !== s)
          throw Error("This question was replaced; no result applied");
        if (s.state !== "pending") throw Error("Session is no longer pending");
        if ((e.runId ?? g.id) !== payload.runId || payload.encounterId !== e.id)
          throw Error("A new run replaced this question; no result applied");
        if (
          !archived() &&
          (g.study.profile ?? "development") !== payload.profile
        )
          throw Error("Study profile changed; no result applied");
        if (
          JSON.stringify(e.problem ?? null) !== JSON.stringify(payload.problem)
        )
          throw Error("The question changed; no result applied");
        if (status().mode !== s.provider)
          throw Error("Provider changed while the question was open");
        // A later NPC acceptance legitimately rewrites the world record; the
        // native answers then remain learning-only.
        if (e.state !== "consumed") {
          if (!archived() && ownedElsewhere(e))
            throw Error("Another survivor owns this terminal now");
          if (
            e.workspace !== payload.workspace ||
            e.revision !== payload.draftRevision ||
            (!archived() &&
              (await directStudyFingerprint(g, e)) !== s.questionFingerprint)
          )
            throw Error("Saved work changed after the question opened");
        }
      };
      await check();
      const answer = await bridgeRequest(
        "tutor",
        payload,
        (phase) => {
          if (s.state !== "pending") return;
          if (s.transportPhase !== phase) {
            s.transportPhaseAt = Date.now();
            s.transportPhase = phase;
            onChange?.();
          }
        },
        {
          timeoutMs: DIRECT_STUDY_TIMEOUT_MS,
          isActive: () => s.state === "pending",
          nativeScope: nativeStudyScope(g, e),
        },
      );
      await check();
      s.responseReceivedAt = Date.now();
      const facets: ProbeFacet[] =
        e.probe?.facets ??
        (Array.isArray(payload.probe?.facets)
          ? payload.probe.facets
          : probeFacets(payload.problem));
      const previous: ProbeFinding[] = probeState(e).facets.flatMap((facet) =>
        facet.status === "open"
          ? []
          : [
              {
                id: facet.id,
                status: facet.status,
                ...(facet.impliedBy ? { impliedBy: facet.impliedBy } : {}),
              },
            ],
      );
      const valid = validateDirectResponse(
        answer,
        s.questionFingerprint,
        facets,
        previous,
        {
          topics: topicAssessmentTopics(payload.problem.contract),
          required: !!payload.topicAssessmentContext,
        },
      );
      const digest = await digestOf(valid);
      await check();
      // Everything below is synchronous: no partial application is possible.
      const submissionId = `direct-${s.id}`;
      const live =
        !archived() &&
        g.encounters[e.id] === e &&
        (e.runId ?? g.id) === g.id &&
        e.state !== "consumed";
      if (
        live &&
        e.submissions.some(
          (x) => x.status === "pending" && x.id !== submissionId,
        )
      )
        throw Error(
          "An earlier answer check is still pending; no duplicate reward applied",
        );
      if (e.tutor.some((m) => m.requestId === s.id))
        throw Error("This question's transcript is already recorded");
      // A restarted run has its own sequence counter. Archived transcripts
      // must append after their own earlier artifacts and visible help too.
      g.seq = [...e.history, ...e.tutor, ...e.group, ...e.submissions].reduce(
        (seq, entry) => Math.max(seq, entry.seq),
        Math.max(g.seq, e.problemPresentedSequence ?? 0),
      );
      const append = (role: Transcript["role"], text: string) => {
        const m = recordAttributedMessage(
          g,
          e,
          "tutor",
          role === "user" ? "human" : "Terminal AI",
          role === "user" ? "human" : "tutor",
          text,
          NATIVE_TRANSCRIPT_PROVENANCE,
        );
        m.requestId = s.id;
        // These messages were already read in native ChatGPT. Preserve their
        // actual order so supplied answers cannot count as independent work.
        m.presented = m.seq;
        e.history.find((artifact) => artifact.seq === m.seq)!.presented = m.seq;
        return m;
      };
      for (const t of valid.transcript) {
        append(t.role, t.text);
      }
      if (
        valid.transcript.at(-1)?.text !== valid.text ||
        valid.transcript.at(-1)?.role !== "assistant"
      )
        append("assistant", valid.text);
      const firstUser = e.tutor.find(
        (m) => m.requestId === s.id && m.kind === "human",
      )!;
      const statement = valid.transcript
        .filter((t) => t.role === "user")
        .map((t) => t.text)
        .join("\n\n");
      const gaps = recordProbeTurn(g, e, valid.probe, {
        requestId: s.id,
        questionSequence: firstUser.seq,
        provider: s.provider,
        statement,
      });
      // A human can finish the captured question after an NPC unlocks its
      // world station. Count the study once without repeating the world reward.
      if (!archived() && g.encounters[e.id] === e && (e.runId ?? g.id) === g.id)
        countStudyTurn(g.study, e);
      if (live && !e.submissions.some((x) => x.id === submissionId)) {
        const ev = event(
          g,
          "submission",
          "ChatGPT finished the native study conversation.",
          e.floor,
          "human",
          e.id,
        );
        const feedback =
          valid.outcome === "gap"
            ? concessionFeedback(
                gaps.length
                  ? gaps.map((gap) => gap.facet.description)
                  : valid.probe.findings
                      .filter((f) => f.status === "gap")
                      .map(
                        (f) =>
                          facets.find((x) => x.id === f.id)?.description ??
                          f.id,
                      ),
                valid.text,
              )
            : valid.text;
        const verdict = completionVerdict({
          complete: true,
          feedback,
          qualified: ["human"],
        });
        const submission: Submission = {
          id: submissionId,
          revision: payload.draftRevision,
          author: "human",
          content: [
            payload.workspace ? `Saved work:\n${payload.workspace}` : "",
            statement,
          ]
            .filter(Boolean)
            .join("\n\n"),
          seq: ev.seq,
          status: "pending",
          feedback,
          dialogueRequestId: s.id,
        };
        e.submissions.push(submission);
        applyDirectCompletion(g, e, r, submission, verdict, onChange);
      } else if (!live && !e.problem?.contract.practice) {
        // A consumed world lock or an earlier run cannot reward the new run,
        // but its exact human artifacts still deserve a scoped assessment.
        void assess(g, e, r, g.seq).then(onChange, onChange);
      }
      if (valid.topicAssessments.length)
        recordTopicAssessments(g, e, valid.topicAssessments, {
          requestId: s.id,
          questionFingerprint: s.questionFingerprint,
          sourceHash:
            payload.topicAssessmentContext?.sourceHash ?? r.sourceHash,
          startedAt: s.createdAt,
        });
      s.state = "applied";
      s.responseDigest = digest;
      s.appliedAt = Date.now();
      delete s.transportPhase;
      delete s.transportPhaseAt;
    } catch (error) {
      if (
        (s.state as string) === "superseded" ||
        (s.state as string) === "paused" ||
        (s.state as string) === "applied"
      )
        return;
      s.state = "interrupted";
      s.error = String(error);
      delete s.transportPhase;
      delete s.transportPhaseAt;
    } finally {
      onChange?.();
    }
  })();
  inFlight.set(s, operation);
  void operation.finally(() => inFlight.delete(s));
  onChange?.();
  return operation;
}

/** Retry every saved unfinished session once; caller decides when. */
export function resumeDirectStudies(
  g: Game,
  r: Roadmap,
  onChange?: () => void,
): void {
  for (const e of new Set([
    ...Object.values(g.encounters),
    ...g.study.archives,
  ]))
    if (unfinishedDirectStudy(e)) void retryDirectStudy(g, e, r, onChange);
}
