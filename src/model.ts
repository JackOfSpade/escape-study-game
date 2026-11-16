import type { LearnerLedger, ScopeDefinition } from "./learning-model";
export type Track = "PY" | "PE";
/** A connected AI provider; development practice has no provider. */
export type Provider = "study-mode" | "chatgpt-handoff" | "claude-cli";
export const PROVIDERS: readonly string[] = [
  "study-mode",
  "chatgpt-handoff",
  "claude-cli",
];
export interface Objective {
  id: string;
  target: number;
  cells: string[];
  route: string;
  refs: string;
  reviewDue: string | null;
  scope: string;
}
export interface Roadmap {
  resume?: {
    ratioPosition?: number;
    issues: string[];
    reviews?: Record<string, import("./learning-model").ReviewRecord>;
    identifierCounters?: import("./roadmap-identifiers").IdentifierCounters;
  };
  documentId: string;
  revision: number;
  sourceHash: string;
  raw: string;
  sharedProgress: string;
  tracks: Record<
    Track,
    {
      tier: number;
      lap?: number;
      cleared?: number;
      suspended?: {
        tier: number;
        phase: string;
        lap?: number;
        queue: string[];
      }[];
      phase: string;
      remaining: string[];
      rotation: string[];
      objectives: Objective[];
      topics: Record<string, string>;
      progress: string;
      curriculum: string;
    }
  >;
}
export interface Contract {
  /** Legacy objectiveIds also carries track-qualified topic/integration IDs for final work. */
  kind?: "checkpoint" | "transfer" | "integration";
  id: string;
  track: Track;
  objectiveIds: string[];
  scopes: string[];
  depth: number;
  phase: string;
  review: boolean;
  ledgerVersion: number;
  priorEvidence: string[];
  scheduleNote?: string;
  /** A variety question: probes and records knowledge, never the formal visit. */
  practice?: boolean;
  missingFacets?: string[];
  preservedFacets?: string[];
  historicalScope?: {
    sourceHash: string;
    gaps: {
      id: string;
      objectiveId: string;
      depth: number;
      kind: string;
      preserved: string;
      missing: string;
      evidenceRefs: string;
      status: string;
      nextCheck: string;
      revisit: string;
    }[];
    evidenceRows: string[];
  };
}
export interface StudyState {
  /** Free-form AI impressions; separate from verified curriculum credit. */
  topicAssessments?: Record<
    string,
    import("./topic-assessment").TopicAssessmentRecord
  >;
  roadmapReconciliations?: import("./roadmap-adoption-types").RoadmapReconciliationJob[];
  roadmapAdoptionBackups?: import("./roadmap-adoption-types").RoadmapAdoptionBackup[];
  environmentReviews?: import("./environment-review").EnvironmentReviewJob[];
  environmentObservations?: import("./environment-observations").EnvironmentObservation[];
  roadmapExport?: import("./roadmap-export").RoadmapExport;
  /** Learner-declared gaps conceded in conversation; never mastery. */
  knowledgeGaps?: import("./knowledge-probe").KnowledgeGapRecord[];
  /** Facets established in conversation (answered or implied); never mastery. */
  knowledgeEstablished?: import("./knowledge-probe").KnowledgeEstablishedRecord[];
  profile?: "development" | "live";
  careerFocus?: "product-feature-owner" | "full";
  learner?: LearnerLedger;
  version: number;
  cycle: number;
  cycleOffset?: number;
  /** Completed human questions drive track balance separately from academic visits. */
  studyTurnPosition?: number;
  queues: Record<Track, string[]>;
  phases: Record<Track, string>;
  reviewsServed: string[];
  visits: { id: string; contract: Contract; encounter: string; at: string }[];
  pending?: { contract: Contract; encounter: string };
  session?: string;
  assessments: Assessment[];
  archives: Encounter[];
  /** The unfinished segmented question, kept until its last segment is
   * completed. Only saves from the retired game start one. */
  thread?: import("./question-thread").QuestionThread;
}
export interface Finding {
  objectiveId: string;
  facet: string;
  outcome: "independent" | "assisted" | "unknown" | "contradicted";
  depth?: number;
  execution?: "not-run" | "executed";
  evidence: number[];
  completeCheckpointScope: boolean;
  rationale: string;
}
export interface Assessment {
  /** Immutable provider request retained until an explicit retry succeeds. */
  request?: { provider: Provider; payloadJson: string };
  historicalMappings?: import("./learning-model").HistoricalFacetMapping[];
  id: string;
  encounter: string;
  sourceVersion: number;
  findings: Finding[];
  status: "pending" | "review-required" | "applied";
  provenance: string;
  evidenceCutoffSequence?: number;
  visitOutcome?: "usable" | "unresolved" | "invalid";
  scopeReviews?: {
    id: string;
    /** Whether the registered criteria cover the curriculum, not current learner mastery. */
    completeCoverage: boolean;
    rationale: string;
    definitionIssue?: {
      sourceHash: string;
      sourceQuote: string;
      missingCriterion: string;
    };
  }[];
  helpAttributions?: {
    messageId: string;
    facets: string[];
    rationale: string;
  }[];
}
export interface Artifact {
  executionId?: string;
  wallTime?: string;
  delta?: { prefix: number; removed: string; inserted: string };
  seq: number;
  author: string;
  kind:
    | "edit"
    | "reasoning"
    | "test"
    | "defense"
    | "npc-thought"
    | "npc-proposal"
    | "workspace-view"
    | "source-view"
    | "validation"
    | "activity"
    | "tutor"
    | "completion"
    | "starter"
    | "execution"
    | "chat";
  text: string;
  at: number;
  revision: number;
  refs?: string[];
  presented?: number;
}
export interface Message {
  sourceRefs?: number[];
  requestId?: string;
  id: string;
  author: string;
  kind: "human" | "npc" | "tutor" | "system";
  text: string;
  seq: number;
  worldTime: number;
  presented?: number;
  provenance: string;
}
export interface Submission {
  dialogueRequestId?: string;
  completionRequest?: {
    provider: Provider;
    payloadJson: string;
  };
  id: string;
  revision: number;
  author: string;
  content: string;
  status: "pending" | "complete" | "needs-work" | "error";
  feedback: string;
  seq: number;
}
export interface Problem {
  /** Generation-time typical active solve duration; local policy owns HP. */
  estimatedSolveSeconds?: number;
  runtime?: {
    language: "python" | "typescript";
    environment?: "react";
    steps?: import("../scripts/browser-runner/spec.mjs").BrowserStep[];
  };
  title: string;
  prompt: string;
  rubric: string[];
  starter: string;
  provenance: "development" | Provider;
  validation?: { kind: "trace"; answer: number };
  contract: Contract;
  scopeDefinitions?: ScopeDefinition[];
  /** Ordered parts of a long question, one per conversation. */
  segments?: import("./question-thread").QuestionSegment[];
}
export interface TutorRequest {
  id: string;
  provider: Provider;
  payloadJson: string;
  questionSequence: number;
  state: "pending" | "interrupted" | "applied" | "superseded";
  error?: string;
  responseMessageId?: string;
  /** Resent once automatically when its question resumed after a restart. */
  resent?: boolean;
}
/** A question session the retired ChatGPT chat once ran. Saves still carry it,
 * so learning history reads it; nothing creates or continues one any more. */
export interface DirectStudySession {
  id: string;
  createdAt?: number;
  responseReceivedAt?: number;
  appliedAt?: number;
  provider: Provider;
  payloadJson: string;
  questionFingerprint: string;
  state: "pending" | "interrupted" | "paused" | "applied" | "superseded";
  responseDigest?: string;
  error?: string;
  transportPhase?: string;
  transportPhaseAt?: number;
}
export interface Encounter {
  /** Standalone learning task started from the study workspace. */
  studyOnly?: boolean;
  /** Once-only human completion receipt for track balance. */
  studyTurnRecorded?: boolean;
  directStudy?: DirectStudySession;
  chatDraft?: string;
  /** The segmented question this question works and which of its segments. */
  thread?: { id: string; segment: number };
  tutorRequests?: TutorRequest[];
  /** Knowledge probe: facets, per-turn findings and answer signals. */
  probe?: import("./knowledge-probe").KnowledgeProbe;
  executions?: import("./execution").WorkspaceExecution[];
  runId?: string;
  problemPresentedSequence?: number;
  /** Wall-clock time the problem was first presented; orders topic assessments. */
  problemPresentedAt?: number;
  pendingGeneration?: {
    /** Legacy saved generation requests were always ChatGPT handoffs. */
    provider?: Provider;
    requestId: string;
    payload: Record<string, unknown>;
  };
  id: string;
  /** Saved records written before the study workspace may be shared or owned
   * by someone other than the learner; only the learner's own are worked. */
  mode: "solo" | "shared";
  state: "available" | "in-progress" | "submitted" | "consumed";
  owner?: string;
  problem?: Problem;
  workspace: string;
  workspaceBase?: string;
  revision: number;
  history: Artifact[];
  tutor: Message[];
  /** Team chat from before the study workspace; it remains evidence of the
   * help the learner received, so it is read but never written. */
  group?: Message[];
  submissions: Submission[];
  contributors: string[];
  accepted?: string;
  chatOpen: boolean;
  scroll: number;
  selection: [number, number];
  generation?: string;
  error?: string;
}
export interface Settings {
  /** Interface magnification; omitted by older saves (100%). */
  displayScale?: number;
  /** Saved by the retired ChatGPT worker settings; no longer read. */
  handoffAutonomous?: boolean;
}
/**
 * The saved record: the learner's study state, its questions and their
 * conversations, and the settings. Saves written by the retired game hold
 * more fields; they stay in the object untouched, so a save written here
 * still loads there.
 */
export interface StudyRecord {
  /** The saved record format. */
  schema: 1;
  id: string;
  /** Orders every recorded question artifact and message. */
  seq: number;
  time: number;
  /** The workspace question view, selected and remembered across reloads. */
  studyWorkspace?: { enabled: boolean; encounter?: string };
  /** Last question actually opened by the human; stable across page reload. */
  lastStudyEncounter?: string;
  encounters: Record<string, Encounter>;
  study: StudyState;
  settings: Settings;
  notice: string;
}
/** Advance and return the record's sequence, which orders recorded artifacts. */
export function nextSeq(g: Pick<StudyRecord, "seq">) {
  return ++g.seq;
}
