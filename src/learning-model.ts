import type { Provider, Contract, Track } from "./model";
export type CellState = "U" | "G" | "P" | "R" | "—";
export interface ScopeDefinition {
  id: string;
  objectiveId: string;
  depth: number;
  sourceScope: string;
  facets: { id: string; description: string }[];
}
export interface FacetProof {
  outcome: "independent" | "assisted" | "unknown" | "contradicted";
  /** For an assisted facet: answered after a hint, or given the step. */
  assistance?: "hinted" | "given";
  evidenceIds: string[];
  updatedAt: string;
}
export interface HistoricalFacetMapping {
  scopeId: string;
  facet: string;
  sourceHash: string;
  evidenceIds: string[];
  outcome: FacetProof["outcome"];
  rationale: string;
  /** Exact source observation excerpt required for an independent part of a MIXED row. */
  sourceExcerpts?: Record<string, string>;
}
interface HistoricalFacetReview extends HistoricalFacetMapping {
  assessmentId: string;
  reviewedAt: string;
}
interface LearningCell {
  states: CellState[];
  proofs: Record<string, string[]>;
  facets: Record<string, FacetProof>;
  sourceRefs: string;
}
interface FinalProgress {
  kind: "transfer" | "integration";
  status: CellState;
  proofs: Record<string, string[]>;
  facets: Record<string, FacetProof>;
  sourceRefs: string;
}
export const isFinalTarget = (id: string) =>
  /^(PY|PE):(?:[TX]\d{2}|I\d{2})$/.test(id);
export const reviewSignature = (record: ReviewRecord | undefined) =>
  JSON.stringify(
    Object.entries(record ?? {})
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
export const scopeKey = (id: string, depth: number) =>
  `${id}/${isFinalTarget(id) ? "T4" : `D${depth}`}`;
export function learningProgress(
  l: LearnerLedger,
  id: string,
): LearningCell | FinalProgress {
  const p = l.cells[id] ?? l.finalProgress?.[id];
  if (!p) throw Error(`Missing learning progress ${id}`);
  return p;
}
export function progressStatus(p: LearningCell | FinalProgress, depth: number) {
  return "states" in p ? p.states[depth - 1] : p.status;
}
export function setProgressStatus(
  p: LearningCell | FinalProgress,
  depth: number,
  status: CellState,
) {
  if ("states" in p) p.states[depth - 1] = status;
  else p.status = status;
}
export interface ReviewRecord {
  objectiveId: string;
  depth: number;
  due: string;
  stage: number;
  lastIndependentAt?: string;
  lastIndependentDate?: string;
  sequence?: string;
  verifiedReviews: number;
}
/** Original delayed-review transactions remain immutable after correction. */
export interface RetentionEvent {
  scopeId: string;
  assessmentId: string;
  attemptId: string;
  at: string;
  evidenceIds: string[];
  before: ReviewRecord;
  after: ReviewRecord;
}
export interface LearningEvidence {
  provider?: Provider | "test-fixture";
  id: string;
  attemptId: string;
  encounter: string;
  objectiveId: string;
  depth: number;
  facet: string;
  outcome: string;
  assistance?: "hinted" | "given";
  artifactSequences: number[];
  helpMessageIds: string[];
  at: string;
  observedAt?: string;
  execution: "not-run" | "executed";
  rationale: string;
}
export interface LearningAttempt {
  id: string;
  session: string;
  encounter: string;
  contract: Contract;
  status:
    | "in-progress"
    | "served"
    | "interrupted"
    | "suspended"
    | "externally-resolved";
  externalResolution?: {
    adoptionId: string;
    canonicalHash: string;
    sourceRow: string;
    disposition: string;
    humanCutoff: number;
    assessedHumanSequences: number[];
    at: string;
  };
  startedAt: string;
  lap?: number;
  endedAt?: string;
  parentAttempt?: string;
}
interface TrackState {
  tier: number;
  cleared: number;
  phase: string;
  queue: string[];
  lap: number;
  suspended: { tier: number; phase: string; queue: string[]; lap?: number }[];
}
export interface LearnerLedger {
  retentionHistory?: RetentionEvent[];
  identifierCounters?: import("./roadmap-identifiers").IdentifierCounters;
  roadmapAdoptions?: import("./roadmap-adoption-types").RoadmapAdoptionReceipt[];
  environmentEvidence?: import("./environment-status").EnvironmentEvidence[];
  schema: 1;
  mode: "live" | "test";
  sourceHash: string;
  version: number;
  cycle: number;
  cycleOffset?: number;
  /** Completed human questions; scheduling only, never proof or a served visit. */
  studyTurnPosition?: number;
  careerFocus?: "product-feature-owner" | "full";
  cells: Record<string, LearningCell>;
  finalProgress?: Record<string, FinalProgress>;
  historicalReviews?: HistoricalFacetReview[];
  scopes: Record<string, ScopeDefinition>;
  verifiedScopes: string[];
  tracks: Record<Track, TrackState>;
  reviews: Record<string, ReviewRecord>;
  sessions: {
    id: string;
    status: "imported" | "open" | "closed" | "INTERRUPTED_AT_LAST_SAVE";
    startedAt?: string;
  }[];
  currentSession?: string;
  attempts: LearningAttempt[];
  evidence: LearningEvidence[];
  receipts: Record<
    string,
    { signature: string; version: number; evidenceIds: string[] }
  >;
  continuations: {
    attemptId: string;
    encounter: string;
    objectiveIds: string[];
    depth: number;
    at: string;
  }[];
}

/** A continuation family consumes one visit, while retaining every attempt. */
export function learningAttemptRoot(
  l: LearnerLedger,
  attempt: LearningAttempt,
) {
  const seen = new Set<string>();
  while (attempt.parentAttempt) {
    if (seen.has(attempt.id)) throw Error("Cyclic learning continuation");
    seen.add(attempt.id);
    const parent = l.attempts.find((a) => a.id === attempt.parentAttempt);
    if (!parent) throw Error("Missing learning continuation parent");
    attempt = parent;
  }
  return attempt.id;
}

export function servedLearningAttempts(l: LearnerLedger) {
  const seen = new Set<string>();
  return l.attempts
    .filter((a) => a.status === "served")
    .sort((a, b) => (a.endedAt ?? "").localeCompare(b.endedAt ?? ""))
    .filter((a) => {
      const root = learningAttemptRoot(l, a);
      if (seen.has(root)) return false;
      seen.add(root);
      return true;
    });
}

export const studyRatioPosition = (s: {
  cycle: number;
  cycleOffset?: number;
  studyTurnPosition?: number;
}) => s.studyTurnPosition ?? (s.cycle + (s.cycleOffset ?? 0)) % 3;

const FACET_OUTCOMES: readonly FacetProof["outcome"][] = [
  "independent",
  "assisted",
  "unknown",
  "contradicted",
];
/**
 * Shape checks shared by every facet mapping (historical, imported): a known
 * facet of the scope, a valid outcome, a bounded rationale and a bounded,
 * duplicate-free evidence list. Source-specific evidence rules stay with the
 * caller.
 */
export function facetMappingShapeValid(
  definition: ScopeDefinition | undefined,
  m: {
    facet: string;
    outcome: string;
    rationale?: string;
    evidenceIds: unknown;
  },
): boolean {
  return (
    !!definition &&
    definition.facets.some((f) => f.id === m.facet) &&
    (FACET_OUTCOMES as readonly string[]).includes(m.outcome) &&
    !!m.rationale?.trim() &&
    m.rationale.length <= 1500 &&
    Array.isArray(m.evidenceIds) &&
    m.evidenceIds.length > 0 &&
    m.evidenceIds.length <= 20 &&
    new Set(m.evidenceIds).size === m.evidenceIds.length
  );
}
/**
 * Facet list rules shared by generated and imported scope definitions: 1 to 40
 * facets, unique stable ids, non-empty descriptions. `importedText` adds the
 * bounds an uploaded file must respect (length, no line breaks or fences).
 */
export function scopeFacetsValid(
  facets: unknown,
  importedText = false,
): facets is ScopeDefinition["facets"] {
  return (
    Array.isArray(facets) &&
    facets.length > 0 &&
    facets.length <= 40 &&
    new Set(facets.map((f) => f?.id)).size === facets.length &&
    facets.every(
      (f) =>
        !!f &&
        typeof f.id === "string" &&
        /^[-\w.]{1,100}$/.test(f.id) &&
        typeof f.description === "string" &&
        !!f.description.trim() &&
        (!importedText ||
          (f.description.length <= 500 && !/[\r\n]|```/.test(f.description))),
    )
  );
}
