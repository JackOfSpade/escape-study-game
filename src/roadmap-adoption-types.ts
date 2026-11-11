import type {
  FacetProof,
  LearnerLedger,
  ScopeDefinition,
} from "./learning-model";
import type { Provider } from "./model";
export interface ActiveAttemptSnapshot {
  attemptId: string;
  encounter: string;
  workHash: string;
  humanCutoff: number;
  humanSequences: number[];
}
export interface ImportedFacetMapping {
  scopeId: string;
  facet: string;
  outcome: FacetProof["outcome"];
  evidenceIds: string[];
  sourceExcerpts: Record<string, string>;
  rationale: string;
}
export interface RoadmapReconciliationPayload {
  /** Captured transport identity; omitted only by legacy native reviews. */
  provider?: Provider;
  requestId: string;
  sourceHash: string;
  localHash: string;
  candidateHash: string;
  localVersion: number;
  local: string;
  candidate: string;
  context: Pick<
    LearnerLedger,
    | "cycle"
    | "cycleOffset"
    | "studyTurnPosition"
    | "tracks"
    | "reviews"
    | "scopes"
    | "verifiedScopes"
    | "currentSession"
    | "identifierCounters"
    | "retentionHistory"
  > & { activeAttempts?: ActiveAttemptSnapshot[] };
  instruction: string;
}
export interface RoadmapReconciliation {
  retentionUpdates?: { scopeId: string; rationale: string }[];
  requestId: string;
  localHash: string;
  candidateHash: string;
  canonical: string;
  definitions: ScopeDefinition[];
  mappings: ImportedFacetMapping[];
  completeScopes: string[];
  branchConflicts?: { track: "PY" | "PE"; id: string }[];
  branchRationale?: string;
  attemptUpdates?: {
    track: "PY" | "PE";
    attemptId: string;
    rationale: string;
    correctionDecision?: { id: string; excerpt: string };
    resolveCurrent?: {
      encounter: string;
      workHash: string;
      humanCutoff?: number;
      assessedHumanSequences?: number[];
    };
  }[];
  environment?: {
    envId: string;
    status: "U" | "G" | "P";
    evidenceIds: string[];
    rationale: string;
  }[];
  decisions: {
    key: string;
    choice: "local" | "incoming" | "merged";
    rationale: string;
  }[];
  rationale: string;
}
/** A review that recommends keeping the local roadmap: nothing to adopt. */
export interface RoadmapKeepLocal {
  outcome: "keep-local";
  requestId: string;
  localHash: string;
  candidateHash: string;
  decisions: RoadmapReconciliation["decisions"];
  rationale: string;
}
export interface RoadmapAdoptionReceipt {
  id: string;
  sourceHash: string;
  localHash: string;
  incomingHash: string;
  canonicalHash: string;
  reviewedAt: string;
  adoptedAt: string;
  localServedAttempts?: string[];
  localAttemptIds?: string[];
  localEvidenceIds?: string[];
  localSessionStates?: Record<
    string,
    LearnerLedger["sessions"][number]["status"]
  >;
  provenance: Provider;
  proposal: RoadmapReconciliation;
  proposalHash: string;
}
export interface RoadmapReconciliationJob {
  review?: import("./roadmap-review").RoadmapReview;
  id: string;
  state:
    "pending" | "ready" | "error" | "interrupted" | "applied" | "kept-local";
  payload: RoadmapReconciliationPayload;
  requestHash: string;
  proposal?: RoadmapReconciliation;
  proposalHash?: string;
  /** Set when the review recommends keeping the local roadmap unchanged. */
  keepLocal?: Pick<RoadmapKeepLocal, "decisions" | "rationale">;
  error?: string;
}
export interface RoadmapAdoptionBackup {
  id: string;
  at: string;
  local: string;
  incoming: string;
  ledger: LearnerLedger;
  exportCache?: import("./roadmap-export").RoadmapExport;
}
