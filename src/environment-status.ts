import { PROVIDERS } from "./model";
import type { EnvironmentObservation } from "./environment-observations";
import type { FinalRequirement } from "./final-requirements";
import { importedEnvironmentStatus } from "./imported-proof";
import type { LearnerLedger } from "./learning-model";
import type { Provider, Artifact, Message, Roadmap } from "./model";
export interface EnvironmentReviewPayload {
  requestId: string;
  /** Absent only on legacy native review packets. */
  provider?: Provider;
  sourceHash: string;
  definition: Pick<FinalRequirement, "id" | "scope" | "kind">;
  observation: EnvironmentObservation;
  attribution?: { history: Artifact[]; tutor: Message[]; group: Message[] };
  instruction: string;
}
export interface EnvironmentJudgment {
  requestId: string;
  sourceHash: string;
  observationId: string;
  observationFingerprint: string;
  envId: string;
  classification: "reported-exposure" | "partially-observed" | "observed";
  learnerWork: boolean;
  learnerWorkQuote: string;
  reviewedOutputs: {
    kind: "supplied-output" | "runner-receipt" | "runner-code";
    excerpt: string;
  }[];
  covered: string[];
  remaining: string[];
  completeScope: boolean;
  rationale: string;
}
export interface EnvironmentEvidence {
  id: string;
  reviewedAt: string;
  provenance: Provider;
  reviewProfile: "live";
  payload: EnvironmentReviewPayload;
  judgment: EnvironmentJudgment;
  requestHash: string;
  judgmentHash: string;
}
export function environmentOutput(p: EnvironmentReviewPayload, kind: string) {
  if (kind === "supplied-output") return p.observation.suppliedOutput?.text;
  if (kind === "runner-receipt")
    return p.observation.execution
      ? JSON.stringify(p.observation.execution.receipt)
      : undefined;
  if (kind === "runner-code") return p.observation.execution?.code;
  return undefined;
}
/** Structural evidence checks; semantic full-scope judgment belongs to the connected reviewer. */
export function validateEnvironmentEvidence(
  r: Roadmap,
  d: FinalRequirement,
  v: EnvironmentEvidence,
) {
  const p = v.payload,
    j = v.judgment,
    o = p.observation;
  if (
    !PROVIDERS.includes(v.provenance) ||
    v.provenance !== (p.provider ?? "study-mode") ||
    !/^[a-f0-9]{64}$/.test(v.requestHash) ||
    !/^[a-f0-9]{64}$/.test(v.judgmentHash) ||
    !v.id.startsWith("environment-review-") ||
    p.requestId !== v.id ||
    j.requestId !== v.id ||
    p.sourceHash !== r.sourceHash ||
    j.sourceHash !== r.sourceHash ||
    o.sourceHash !== r.sourceHash ||
    v.reviewProfile !== "live" ||
    d.kind !== "environment" ||
    p.definition.kind !== "environment" ||
    d.id !== j.envId ||
    d.id !== o.envId ||
    d.id !== p.definition.id ||
    d.scope !== o.sourceScope ||
    d.scope !== p.definition.scope ||
    j.observationId !== o.id ||
    j.observationFingerprint !== o.fingerprint ||
    !Number.isFinite(Date.parse(v.reviewedAt))
  )
    throw Error("Environment review source, identity or provenance mismatch");
  if (
    !["reported-exposure", "partially-observed", "observed"].includes(
      j.classification,
    ) ||
    typeof j.learnerWork !== "boolean" ||
    typeof j.completeScope !== "boolean" ||
    typeof j.learnerWorkQuote !== "string" ||
    typeof j.rationale !== "string" ||
    !j.rationale.trim() ||
    j.rationale.length > 8000 ||
    !Array.isArray(j.reviewedOutputs) ||
    j.reviewedOutputs.length > 12 ||
    !Array.isArray(j.covered) ||
    !Array.isArray(j.remaining) ||
    [...j.covered, ...j.remaining].some(
      (s) => typeof s !== "string" || !s.trim() || s.length > 2000,
    ) ||
    j.covered.length > 30 ||
    j.remaining.length > 30
  )
    throw Error("Malformed environment judgment");
  for (const ref of j.reviewedOutputs) {
    const text = environmentOutput(p, ref.kind);
    if (
      !["supplied-output", "runner-receipt", "runner-code"].includes(
        ref.kind,
      ) ||
      typeof ref.excerpt !== "string" ||
      !ref.excerpt.trim() ||
      ref.excerpt.length > 2000 ||
      !text?.includes(ref.excerpt)
    )
      throw Error("Environment output reference was not actually supplied");
  }
  if (
    j.learnerWork &&
    (!j.learnerWorkQuote.trim() ||
      !o.learnerStatement.includes(j.learnerWorkQuote))
  )
    throw Error("Learner work needs an exact statement reference");
  if (
    j.classification !== "reported-exposure" &&
    (!j.learnerWork || !j.reviewedOutputs.length || !j.covered.length)
  )
    throw Error(
      "Reported exposure alone cannot become observed environment work",
    );
  if (
    j.classification === "observed" &&
    (!j.completeScope || j.remaining.length)
  )
    throw Error("Full ENV observation requires the complete source scope");
  if (j.classification !== "observed" && j.completeScope)
    throw Error("Partial or reported work cannot claim complete ENV scope");
  return j.classification === "observed"
    ? "P"
    : j.classification === "partially-observed"
      ? "G"
      : "U";
}
export function environmentStatus(
  r: Roadmap,
  l: LearnerLedger,
  d: FinalRequirement,
) {
  let status = d.status;
  for (const v of l.environmentEvidence ?? []) {
    if (v.payload.definition.id !== d.id) continue;
    const next = validateEnvironmentEvidence(r, d, v);
    if (next === "P" || (next === "G" && status !== "P")) status = next;
  }
  const imported = importedEnvironmentStatus(r, l, d.id, d.scope);
  if (imported === "P" || (imported === "G" && status !== "P"))
    status = imported;
  return status;
}
