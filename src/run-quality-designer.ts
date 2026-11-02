const designSource = () => "claude-cli" as const;
import {
  parseSavedRunDesign,
  runDesignFingerprint,
  runDesignNoveltyErrors,
  type EnvironmentContent,
  type EnvironmentSummary,
  type RunDesignSummary,
  type RunStructureV3,
  type SavedRunDesign,
} from "./run-design-contract.mjs";
import {
  mergeQualityEntries,
  parseQualityReply,
  parseQualityRequest,
  qualityContentBatches,
  runQualityContentNoveltyErrors,
  type QualityFinding,
  type QualityRunDesignRequest,
} from "./run-quality-contract.mjs";
import type { ProvisionalRun } from "./world";
import type { RunDesignActivity, RunDesignStage } from "./run-design-progress";

/** These are runaway guards, not a target number of calls or a quality score. */
export const QUALITY_REPAIR_ATTEMPTS = 8;
export const QUALITY_REVIEW_ROUNDS = 8;
const STALLED_ROUNDS = 2;
const FINAL_WORLD_PAUSE = "The final saved world could not be prepared";
type WorldRequest = Extract<
  QualityRunDesignRequest,
  { structure: RunStructureV3 }
>;
type StructureRequest = Extract<
  QualityRunDesignRequest,
  { phase: "structure" }
>;
type ReviewStage = "structure" | "content";

interface ReviewLedger {
  rounds: number;
  stalls: number;
  findings: QualityFinding[];
  issueFingerprint: string | null;
  fingerprints: string[];
  approvedFingerprint: string | null;
  stop: "pending" | "ready" | "plateau";
}
export interface QualityDesignDraft {
  version: 3;
  targetRunId: string;
  request: QualityRunDesignRequest;
  /** One counter for the current exact authoring task, never transport retries. */
  attempts: number;
  failure: { fingerprint: string | null; repeats: number };
  exhausted: boolean;
  pauseReason: string;
  reviews: { structure: ReviewLedger; content: ReviewLedger };
}
interface QualityOptions<T> {
  signal: AbortSignal;
  capture: (draft: QualityDesignDraft) => void | Promise<void>;
  progress?: (text: string) => void;
  activity?: (activity: RunDesignActivity) => void;
  preview?: (seed: number, structure: RunStructureV3) => ProvisionalRun;
  finalize?: (candidate: ProvisionalRun, saved: SavedRunDesign) => T;
}
type QualitySend = (
  request: QualityRunDesignRequest,
  draft: QualityDesignDraft,
  signal: AbortSignal,
) => Promise<unknown>;

function emptyReview(): ReviewLedger {
  return {
    rounds: 0,
    stalls: 0,
    findings: [],
    issueFingerprint: null,
    fingerprints: [],
    approvedFingerprint: null,
    stop: "pending",
  };
}
function requireThat(ok: unknown, message: string): asserts ok {
  if (!ok) throw Error(`Saved quality design: ${message}`);
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: unknown, keys: string[]) {
  requireThat(record(value), "expected an object");
  requireThat(
    Object.keys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key)),
    "unexpected or missing fields",
  );
}
function finiteInteger(value: unknown, min: number, max: number) {
  return (
    Number.isInteger(value) && Number(value) >= min && Number(value) <= max
  );
}
function fingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{16}$/u.test(value);
}
function printable(value: unknown, min: number, max: number) {
  return (
    typeof value === "string" &&
    value.trim().length >= min &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}
function readReview(value: ReviewLedger): ReviewLedger {
  exactKeys(value, [
    "rounds",
    "stalls",
    "findings",
    "issueFingerprint",
    "fingerprints",
    "approvedFingerprint",
    "stop",
  ]);
  requireThat(
    finiteInteger(value.rounds, 0, QUALITY_REVIEW_ROUNDS) &&
      finiteInteger(value.stalls, 0, STALLED_ROUNDS) &&
      ["pending", "ready", "plateau"].includes(value.stop),
    "invalid review counters",
  );
  requireThat(
    Array.isArray(value.findings) && value.findings.length <= 12,
    "invalid review findings",
  );
  const ids = new Set<string>();
  for (const finding of value.findings) {
    exactKeys(finding, [
      "id",
      "priority",
      "target",
      "problem",
      "evidence",
      "recommendation",
    ]);
    requireThat(
      /^[a-z][a-z0-9-]{0,39}$/u.test(finding.id) &&
        !ids.has(finding.id) &&
        ["major", "minor"].includes(finding.priority) &&
        printable(finding.target, 1, 256) &&
        [finding.problem, finding.evidence, finding.recommendation].every((s) =>
          printable(s, 1, 300),
        ),
      "invalid review evidence",
    );
    ids.add(finding.id);
  }
  requireThat(
    (value.issueFingerprint === null || fingerprint(value.issueFingerprint)) &&
      Array.isArray(value.fingerprints) &&
      value.fingerprints.length <= QUALITY_REVIEW_ROUNDS + 1 &&
      value.fingerprints.every(fingerprint) &&
      new Set(value.fingerprints).size === value.fingerprints.length,
    "invalid review history",
  );
  requireThat(
    value.stop === "pending"
      ? value.approvedFingerprint === null
      : fingerprint(value.approvedFingerprint) &&
          value.rounds > 0 &&
          !value.findings.some((f) => f.priority === "major") &&
          (value.stop !== "ready" || value.findings.length === 0),
    "invalid review approval",
  );
  return structuredClone(value);
}
function currentStage(request: QualityRunDesignRequest): ReviewStage {
  return request.phase.startsWith("content") ? "content" : "structure";
}
function requestCandidate(
  request: QualityRunDesignRequest,
  stage: ReviewStage,
) {
  if (stage === "content" && "content" in request) return request.content;
  if (stage === "structure") {
    if ("structure" in request) return request.structure;
    if (request.phase === "structure") return request.repair?.candidate;
  }
  return undefined;
}

/** Only one current packet and small review ledgers are stored, not a transcript
 * of every full candidate and request. All completed art lives in that packet. */
export function parseQualityDraft(value: unknown): QualityDesignDraft {
  const d = value as QualityDesignDraft;
  exactKeys(d, [
    "version",
    "targetRunId",
    "request",
    "attempts",
    "failure",
    "exhausted",
    "pauseReason",
    "reviews",
    // Drafts saved by the retired chat carried a chat code and queue receipt.
    ...(record(d) && Object.hasOwn(d, "chatCode") ? ["chatCode"] : []),
    ...(record(d) && Object.hasOwn(d, "receipt") ? ["receipt"] : []),
  ]);
  requireThat(
    new TextEncoder().encode(JSON.stringify(d)).length <= 1700000,
    "draft exceeds its bounded storage size",
  );
  requireThat(
    d.version === 3 && printable(d.targetRunId, 1, 128),
    "invalid identity",
  );
  const request = parseQualityRequest(d.request);
  requireThat(
    finiteInteger(d.attempts, 1, QUALITY_REPAIR_ATTEMPTS) &&
      typeof d.exhausted === "boolean" &&
      printable(d.pauseReason, 0, 600) &&
      (d.exhausted ? d.pauseReason.length > 0 : d.pauseReason === ""),
    "invalid repair budget",
  );
  exactKeys(d.failure, ["fingerprint", "repeats"]);
  requireThat(
    (d.failure.fingerprint === null || fingerprint(d.failure.fingerprint)) &&
      finiteInteger(d.failure.repeats, 0, STALLED_ROUNDS) &&
      (d.failure.fingerprint === null) === (d.failure.repeats === 0),
    "invalid repair history",
  );
  exactKeys(d.reviews, ["structure", "content"]);
  const reviews = {
    structure: readReview(d.reviews.structure),
    content: readReview(d.reviews.content),
  };
  const untouched = (ledger: ReviewLedger) =>
    ledger.rounds === 0 &&
    ledger.stalls === 0 &&
    !ledger.findings.length &&
    ledger.issueFingerprint === null &&
    !ledger.fingerprints.length &&
    ledger.stop === "pending";
  if (request.phase === "concepts" || request.phase === "selection")
    requireThat(
      untouched(reviews.structure),
      "review history predates its candidate",
    );
  if (
    request.phase !== "content-review" &&
    request.phase !== "content-revision"
  )
    requireThat(
      untouched(reviews.content),
      "content review predates complete writing",
    );
  if (request.phase === "structure" && !request.repair)
    requireThat(
      untouched(reviews.structure),
      "structural review has no repair candidate",
    );
  for (const stage of ["structure", "content"] as const) {
    const approved = reviews[stage].approvedFingerprint;
    if (approved) {
      const candidate = requestCandidate(request, stage);
      requireThat(
        candidate && runDesignFingerprint(candidate) === approved,
        "approval no longer matches its reviewed candidate",
      );
    }
  }
  if (request.phase.startsWith("content"))
    requireThat(
      reviews.structure.stop !== "pending",
      "environment authoring has no reviewed structure",
    );
  if (request.phase === "content-batch") {
    const next = nextBatch(request.surfaces, request.content);
    requireThat(
      next &&
        next.groupId === request.groupId &&
        JSON.stringify(next.targets) === JSON.stringify(request.targets),
      "batch does not follow the saved accepted prefix",
    );
  }
  const saved: QualityDesignDraft & { chatCode?: unknown; receipt?: unknown } =
    { ...structuredClone(d), request, reviews };
  delete saved.chatCode;
  delete saved.receipt;
  return saved;
}

export function createQualityDraft(identity: {
  targetRunId: string;
  generationId: string;
  seed: number;
  recent: RunDesignSummary[];
  recentContent: EnvironmentSummary[];
}): QualityDesignDraft {
  return parseQualityDraft({
    version: 3,
    targetRunId: identity.targetRunId,
    request: {
      version: 3,
      designVersion: 3,
      phase: "concepts",
      requestId: `${identity.generationId}-1`,
      generationId: identity.generationId,
      seed: identity.seed,
      recent: identity.recent,
      recentContent: identity.recentContent,
    },
    attempts: 1,
    failure: { fingerprint: null, repeats: 0 },
    exhausted: false,
    pauseReason: "",
    reviews: { structure: emptyReview(), content: emptyReview() },
  });
}

/** A manual retry opens a fresh bounded improvement cycle, keeping its exact
 * packet and every accepted object. Reload alone never opens another cycle. */
export function retryQualityDraft(draft: QualityDesignDraft) {
  if (!draft.exhausted) return;
  const retryFinalWorld = draft.pauseReason.startsWith(FINAL_WORLD_PAUSE);
  draft.exhausted = false;
  draft.pauseReason = "";
  draft.attempts = 1;
  draft.failure = { fingerprint: null, repeats: 0 };
  // An approved editorial review stays approved when only the local final
  // world check failed. Retry that exact candidate; do not ask the model to
  // revise content for an engine or storage error it cannot diagnose.
  if (retryFinalWorld) return;
  const stage = currentStage(draft.request),
    candidate = requestCandidate(draft.request, stage),
    previous = draft.reviews[stage];
  draft.reviews[stage] = {
    ...emptyReview(),
    rounds: previous.findings.length ? 1 : 0,
    findings: previous.findings,
    issueFingerprint: previous.issueFingerprint,
    fingerprints:
      candidate && previous.rounds > 0 ? [runDesignFingerprint(candidate)] : [],
  };
}

function base(request: QualityRunDesignRequest) {
  const { version, designVersion, generationId, seed, recent, recentContent } =
    request;
  return { version, designVersion, generationId, seed, recent, recentContent };
}
function world(request: WorldRequest) {
  const {
    concept,
    rationale,
    structure,
    structureFingerprint,
    surfaces,
    surfaceFingerprint,
    builderVersion,
  } = request;
  return {
    concept,
    rationale,
    structure,
    structureFingerprint,
    surfaces,
    surfaceFingerprint,
    builderVersion,
  };
}
function structureWorld(
  request: StructureRequest,
  structure: RunStructureV3,
  candidate: ProvisionalRun,
) {
  return {
    concept: request.concept,
    rationale: request.rationale,
    structure,
    structureFingerprint: candidate.structureFingerprint,
    surfaces: candidate.surfaces,
    surfaceFingerprint: candidate.surfaceFingerprint,
    builderVersion: candidate.builderVersion,
  };
}
function nextBatch(
  surfaces: WorldRequest["surfaces"],
  content: EnvironmentContent,
) {
  const ids = new Set(content.entries.map((e) => e.surfaceId));
  let missing: ReturnType<typeof qualityContentBatches>[number] | undefined;
  for (const batch of qualityContentBatches(surfaces)) {
    const present = batch.targets.filter((id) => ids.has(id)).length;
    requireThat(
      present === 0 || present === batch.targets.length,
      "a partially accepted authoring batch cannot be resumed",
    );
    if (!present) missing ??= batch;
    else requireThat(!missing, "accepted authoring batches are out of order");
  }
  return missing;
}
function cleanErrors(errors: string[]) {
  return errors
    .slice(0, 20)
    .map((e) => e.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 400));
}
function issueSignature(findings: QualityFinding[]) {
  const normalize = (s: string) =>
    s
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  // Model-assigned IDs and rewritten recommendations cannot manufacture progress.
  return runDesignFingerprint(
    findings
      .map((f) => [f.priority, f.target, normalize(f.problem)])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
}
function findingErrors(findings: QualityFinding[]) {
  return cleanErrors(
    findings.map(
      (f) =>
        `${f.priority}: ${f.target}: ${f.problem} Evidence: ${f.evidence} Revise: ${f.recommendation}`,
    ),
  );
}
function message(request: QualityRunDesignRequest) {
  switch (request.phase) {
    case "concepts":
      return "Exploring three distinct settings, casts and visual directions…";
    case "selection":
      return "Choosing the strongest direction against your recent runs…";
    case "structure":
      return "Designing the building, occupants and their personal objects…";
    case "structure-review":
      return "Reviewing the building’s identity, rooms and survivor stories…";
    case "content-plan":
      return "Planning room stories, everyday details and illustration themes…";
    case "content-batch": {
      const batches = qualityContentBatches(request.surfaces),
        index = batches.findIndex((b) => b.targets[0] === request.targets[0]);
      return `Writing and illustrating object group ${index + 1} of ${batches.length}…`;
    }
    case "content-review":
      return "Reviewing the complete writing and artwork for coherence and variety…";
    case "content-revision":
      return "Refining the specific objects identified in the review…";
  }
}

function activityDetail(
  request: QualityRunDesignRequest,
): Pick<RunDesignActivity, "stage" | "detail"> {
  const stage: RunDesignStage = request.phase.startsWith("content")
    ? request.phase === "content-review" || request.phase === "content-revision"
      ? "review"
      : "details"
    : "design";
  let detail: string;
  switch (request.phase) {
    case "concepts":
      detail = "Exploring settings…";
      break;
    case "selection":
      detail = "Choosing a setting…";
      break;
    case "structure":
      detail = "Designing the building…";
      break;
    case "structure-review":
      detail = "Reviewing the building…";
      break;
    case "content-plan":
      detail = "Planning room details…";
      break;
    case "content-batch": {
      const batches = qualityContentBatches(request.surfaces),
        index = batches.findIndex((b) => b.targets[0] === request.targets[0]);
      detail = `Writing details · group ${index + 1} of ${batches.length}`;
      break;
    }
    case "content-review":
      detail = "Reviewing writing and artwork…";
      break;
    case "content-revision":
      detail = "Refining details…";
      break;
  }
  return { stage, detail };
}

/** The caller alone installs the returned completed game. This routine never
 * changes a live run or contacts a model itself. */
export async function prepareQualityRun<T>(
  draft: QualityDesignDraft,
  options: QualityOptions<T>,
  send: QualitySend,
) {
  const { signal } = options;
  signal.throwIfAborted();
  if (!options.preview || !options.finalize)
    throw Error(
      "This client cannot prepare a reviewed run. Update the game before retrying.",
    );
  if (draft.exhausted)
    throw Error(
      // Older saved drafts can contain the retired fallback in their status text.
      draft.pauseReason.replace(
        "Choose Retry to continue, Cancel, or an explicit procedural run.",
        "Choose Retry to continue or Cancel.",
      ),
    );
  // Validate callers that resume an in-memory draft as strictly as a disk reload.
  parseQualityDraft(draft);
  let candidate: ProvisionalRun | undefined;
  const capture = async () => {
    signal.throwIfAborted();
    await options.capture(draft);
    signal.throwIfAborted();
  };
  const transition = async (fields: Record<string, unknown>, reset = true) => {
    const request = parseQualityRequest({
      ...base(draft.request),
      ...fields,
      requestId: `design-${crypto.randomUUID()}`,
    });
    draft.request = request;
    if (reset) {
      draft.attempts = 1;
      draft.failure = { fingerprint: null, repeats: 0 };
    }
    await capture();
  };
  const rebuild = (request: WorldRequest) => {
    options.activity?.({
      stage: "design",
      state: "checking",
      detail: "Checking the building…",
    });
    const rebuilt = options.preview!(request.seed, request.structure);
    if (
      rebuilt.structureFingerprint !== request.structureFingerprint ||
      rebuilt.surfaceFingerprint !== request.surfaceFingerprint ||
      rebuilt.builderVersion !== request.builderVersion ||
      JSON.stringify(rebuilt.surfaces) !== JSON.stringify(request.surfaces)
    )
      throw Error(
        "The saved object inventory no longer matches this game version. Cancel this design and start a new one; accepted writing will not be attached to different objects.",
      );
    return rebuilt;
  };
  if ("structure" in draft.request) candidate = rebuild(draft.request);

  const setPaused = (reason: string) => {
    draft.exhausted = true;
    draft.pauseReason =
      `${reason} Your accepted work and exact request are saved. Choose Retry to continue or Cancel.`.slice(
        0,
        600,
      );
  };
  const pause = async (reason: string): Promise<never> => {
    setPaused(reason);
    await capture();
    throw Error(draft.pauseReason);
  };
  const repair = async (
    request: QualityRunDesignRequest,
    errors: string[],
    failedValue: unknown,
    structure?: RunStructureV3,
  ) => {
    // Correlation IDs change on every semantic repair; they are not a creative
    // change and must not conceal the same repeatedly invalid model result.
    const failure = runDesignFingerprint(
      record(failedValue) && Object.hasOwn(failedValue, "requestId")
        ? Object.fromEntries(
            Object.entries(failedValue).filter(([key]) => key !== "requestId"),
          )
        : failedValue,
    );
    draft.failure = {
      fingerprint: failure,
      repeats:
        draft.failure.fingerprint === failure
          ? Math.min(STALLED_ROUNDS, draft.failure.repeats + 1)
          : 1,
    };
    const exhausted =
      draft.attempts >= QUALITY_REPAIR_ATTEMPTS ||
      draft.failure.repeats >= STALLED_ROUNDS;
    if (!exhausted) draft.attempts++;
    if (exhausted)
      setPaused(
        "The current authoring task is repeating an invalid result or needs further repair.",
      );
    await transition(
      {
        ...request,
        repair:
          request.phase === "structure"
            ? { candidate: structure, errors: cleanErrors(errors) }
            : { errors: cleanErrors(errors) },
      },
      false,
    );
    if (exhausted) throw Error(draft.pauseReason);
  };
  const approve = async (
    stage: ReviewStage,
    value: unknown,
    plateau: boolean,
  ) => {
    const ledger = draft.reviews[stage];
    ledger.stop = plateau ? "plateau" : "ready";
    ledger.approvedFingerprint = runDesignFingerprint(value);
    await capture();
  };
  const noProgress = async (
    stage: ReviewStage,
    request: QualityRunDesignRequest,
    value: unknown,
  ) => {
    const ledger = draft.reviews[stage];
    ledger.stalls = Math.min(STALLED_ROUNDS, ledger.stalls + 1);
    if (ledger.stalls >= STALLED_ROUNDS) {
      if (
        ledger.findings.length &&
        ledger.findings.every((f) => f.priority === "minor")
      ) {
        await approve(stage, value, true);
        return;
      }
      // Do not leave a completed no-op request as the retry target.
      setPaused(
        "Review still identifies a material issue, but revisions are no longer improving it.",
      );
      await transition({ ...request }, false);
      throw Error(draft.pauseReason);
    }
    await transition({
      ...request,
      repair:
        request.phase === "structure"
          ? {
              candidate: value,
              errors: [
                "The proposal repeats an already reviewed candidate. Make the concrete changes in the review; renaming issue IDs or returning unchanged data is not progress.",
                ...findingErrors(ledger.findings),
              ].slice(0, 20),
            }
          : {
              errors: [
                "The revision repeats an already reviewed candidate. Change the identified objects meaningfully while preserving unrelated entries.",
              ],
            },
    });
  };
  const review = async (
    stage: ReviewStage,
    value: unknown,
    findings: QualityFinding[],
  ) => {
    const ledger = draft.reviews[stage],
      next = issueSignature(findings),
      candidateFingerprint = runDesignFingerprint(value);
    ledger.rounds++;
    if (findings.length && ledger.issueFingerprint === next)
      ledger.stalls = Math.min(STALLED_ROUNDS, ledger.stalls + 1);
    else ledger.stalls = 0;
    ledger.findings = findings;
    ledger.issueFingerprint = next;
    if (!ledger.fingerprints.includes(candidateFingerprint))
      ledger.fingerprints.push(candidateFingerprint);
    if (!findings.length) {
      await approve(stage, value, false);
      return true;
    }
    if (
      ledger.rounds >= QUALITY_REVIEW_ROUNDS ||
      ledger.stalls >= STALLED_ROUNDS
    ) {
      if (findings.every((f) => f.priority === "minor")) {
        await approve(stage, value, true);
        return true;
      }
      // The new refinement request is captured by the caller before pausing.
      return false;
    }
    return false;
  };
  const finish = async (
    request: Extract<WorldRequest, { content: EnvironmentContent }>,
  ) => {
    // This also retries a failed final-review capture in the same in-memory
    // draft. An approval flag alone is not proof its durable write succeeded.
    await capture();
    const errors = runQualityContentNoveltyErrors(
      request.content,
      request.recentContent,
    );
    if (errors.length) await pause(cleanErrors(errors).join("; "));
    try {
      const design = {
        ...request.structure,
        environment: { ...request.content, surfaces: request.surfaces },
      };
      const saved = parseSavedRunDesign({
        version: 1,
        source: designSource(),
        requestId: request.requestId,
        generationId: request.generationId,
        fingerprint: runDesignFingerprint(design),
        design,
      });
      signal.throwIfAborted();
      options.progress?.(
        draft.reviews.content.stop === "plateau"
          ? "The reviewed run is ready; remaining suggestions reached diminishing returns. Checking its final saved world…"
          : "The reviewed writing and artwork are ready. Checking the final saved world…",
      );
      const finalCandidate = candidate ?? rebuild(request);
      options.activity?.({
        stage: "review",
        state: "checking",
        detail: "Checking your escape…",
      });
      const game = options.finalize!(finalCandidate, saved);
      signal.throwIfAborted();
      return { seed: request.seed, saved, game };
    } catch (error) {
      signal.throwIfAborted();
      const detail = cleanErrors([
        error instanceof Error ? error.message : String(error),
      ])[0];
      return pause(`${FINAL_WORLD_PAUSE}: ${detail}`);
    }
  };

  for (;;) {
    signal.throwIfAborted();
    const request = draft.request;
    // A durable final review can resume directly; a failed capture can never
    // release another request or activate the candidate in the same attempt.
    if (draft.reviews.structure.stop !== "pending") {
      if (request.phase === "structure-review") {
        await transition({ ...world(request), phase: "content-plan" });
        continue;
      }
      if (request.phase === "structure" && request.repair) {
        options.activity?.({
          stage: "design",
          state: "checking",
          detail: "Checking the building…",
        });
        candidate = options.preview(request.seed, request.repair.candidate);
        await transition({
          ...structureWorld(request, request.repair.candidate, candidate),
          phase: "content-plan",
        });
        continue;
      }
    }
    if (
      draft.reviews.content.stop !== "pending" &&
      (request.phase === "content-review" ||
        request.phase === "content-revision")
    ) {
      // An older saved draft may have been approved before a new deterministic
      // content check existed. Repair the named later surface instead of asking
      // for another empty review of the same already-approved candidate.
      const repeatedArt = runQualityContentNoveltyErrors(
        request.content,
        request.recentContent,
      )
        .map((error) =>
          /^surface:(\S+) repeats artwork from surface:(\S+) within this run;/u.exec(
            error,
          ),
        )
        .find((match) => match);
      if (repeatedArt) {
        const [, later, earlier] = repeatedArt,
          finding: QualityFinding = {
            id: "repeated-artwork",
            priority: "major",
            target: `surface:${later}`,
            problem: "This drawing exactly repeats an earlier surface.",
            evidence: `${later} and ${earlier} have identical drawing data without a shared branding or clue fragment.`,
            recommendation: `Give ${later} a distinct drawing while preserving the other accepted surfaces.`,
          },
          findings = [finding];
        draft.reviews.content = {
          ...emptyReview(),
          findings,
          issueFingerprint: issueSignature(findings),
          fingerprints: [runDesignFingerprint(request.content)],
        };
        await transition({
          ...world(request),
          phase: "content-revision",
          plan: request.plan,
          content: request.content,
          findings,
        });
        continue;
      }
      return finish(request);
    }

    options.progress?.(message(request));
    await capture();
    options.activity?.({ ...activityDetail(request), state: "working" });
    const raw = await send(request, draft, signal);
    signal.throwIfAborted();
    let reply;
    try {
      reply = parseQualityReply(raw, request);
    } catch (error) {
      signal.throwIfAborted();
      // Malformed structure data cannot enter a repair candidate; an exact
      // retry never discards this packet.
      if (
        request.phase !== "content-batch" &&
        request.phase !== "content-revision"
      )
        throw error;
      await repair(
        request,
        [error instanceof Error ? error.message : String(error)],
        raw,
      );
      continue;
    }
    if (request.phase === "concepts" && "concepts" in reply) {
      await transition({ phase: "selection", concepts: reply.concepts });
    } else if (request.phase === "selection" && "selectedId" in reply) {
      await transition({
        phase: "structure",
        concept: request.concepts.find((c) => c.id === reply.selectedId),
        rationale: reply.rationale,
      });
    } else if (request.phase === "structure" && "structure" in reply) {
      const structure = reply.structure,
        errors = runDesignNoveltyErrors(structure, request.recent);
      let next: ProvisionalRun | undefined;
      if (!errors.length) {
        try {
          options.activity?.({
            stage: "design",
            state: "checking",
            detail: "Checking the building…",
          });
          next = options.preview(request.seed, structure);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      signal.throwIfAborted();
      if (errors.length) {
        const reviewedCandidate = request.repair?.candidate,
          preserveReviewed =
            reviewedCandidate &&
            draft.reviews.structure.findings.length > 0 &&
            draft.reviews.structure.fingerprints.includes(
              runDesignFingerprint(reviewedCandidate),
            );
        await repair(
          request,
          preserveReviewed
            ? [
                "The attempted revision was rejected. The captured candidate is the last valid reviewed building; continue from that baseline and resolve the original review findings below.",
                ...findingErrors(draft.reviews.structure.findings),
                ...errors.slice(0, 6).map((e) => `Rejected revision: ${e}`),
              ]
            : errors,
          structure,
          preserveReviewed ? reviewedCandidate : structure,
        );
        continue;
      }
      const ledger = draft.reviews.structure;
      if (
        ledger.findings.length &&
        ledger.fingerprints.includes(runDesignFingerprint(structure))
      ) {
        await noProgress("structure", request, request.repair!.candidate);
        continue;
      }
      candidate = next!;
      await transition({
        phase: "structure-review",
        ...structureWorld(request, structure, candidate),
      });
    } else if (request.phase === "structure-review" && "findings" in reply) {
      if (await review("structure", request.structure, reply.findings))
        continue;
      const ledger = draft.reviews.structure,
        stalled =
          ledger.rounds >= QUALITY_REVIEW_ROUNDS ||
          ledger.stalls >= STALLED_ROUNDS;
      if (stalled)
        setPaused(
          "The structural review still identifies material issues after the refinement loop stopped improving.",
        );
      await transition({
        phase: "structure",
        concept: request.concept,
        rationale: request.rationale,
        repair: {
          candidate: request.structure,
          errors: findingErrors(reply.findings),
        },
      });
      if (stalled) throw Error(draft.pauseReason);
    } else if (request.phase === "content-plan" && "plan" in reply) {
      const content: EnvironmentContent = {
          version: 1,
          surfaceFingerprint: request.surfaceFingerprint,
          fragments: reply.plan.fragments,
          entries: [],
        },
        batch = nextBatch(request.surfaces, content);
      if (!batch)
        throw Error("The validated world contains no authorable surfaces.");
      await transition({
        ...world(request),
        phase: "content-batch",
        plan: reply.plan,
        content,
        ...batch,
      });
    } else if (
      (request.phase === "content-batch" ||
        request.phase === "content-revision") &&
      "entries" in reply
    ) {
      const content = mergeQualityEntries(request, reply.entries),
        errors = runQualityContentNoveltyErrors(content, request.recentContent);
      if (errors.length) {
        await repair(request, errors, reply.entries);
        continue;
      }
      if (
        request.phase === "content-revision" &&
        draft.reviews.content.fingerprints.includes(
          runDesignFingerprint(content),
        )
      ) {
        await noProgress("content", request, request.content);
        continue;
      }
      const batch = nextBatch(request.surfaces, content);
      await transition({
        ...world(request),
        plan: request.plan,
        content,
        ...(batch
          ? { phase: "content-batch", ...batch }
          : { phase: "content-review" }),
      });
    } else if (request.phase === "content-review" && "findings" in reply) {
      if (await review("content", request.content, reply.findings)) continue;
      const ledger = draft.reviews.content,
        stalled =
          ledger.rounds >= QUALITY_REVIEW_ROUNDS ||
          ledger.stalls >= STALLED_ROUNDS;
      if (stalled)
        setPaused(
          "The environmental review still identifies material issues after the refinement loop stopped improving.",
        );
      await transition({
        ...world(request),
        phase: "content-revision",
        plan: request.plan,
        content: request.content,
        findings: reply.findings,
      });
      if (stalled) throw Error(draft.pauseReason);
    } else {
      throw Error(
        "The quality reply does not match its captured authoring phase.",
      );
    }
  }
}
