import type {
  RunStructureV3,
  RunDesignSummary,
} from "./run-design-contract.mjs";
import type {
  SurfaceSlot,
  SurfaceContent,
  RepeatFragment,
  EnvironmentContent,
  EnvironmentSummary,
} from "./environment-contract.mjs";
export interface QualityConcept {
  id: string;
  title: string;
  premise: string;
  spatialIdentity: string;
  castTension: string;
  visualLanguage: string;
  everydayLife: string;
  escapeMood: string;
  novelty: string;
}
export interface QualityFinding {
  id: string;
  priority: "major" | "minor";
  target: string;
  problem: string;
  evidence: string;
  recommendation: string;
}
export interface QualityRoomPlan {
  id: string;
  story: string;
  ordinaryLife: string;
  occupantEvidence: string;
  artDirection: string;
}
export interface QualityContentPlan {
  rooms: QualityRoomPlan[];
  fragments: RepeatFragment[];
}
/** The exact place a designed run must be, when the caller names one. */
export interface QualityPlace {
  name: string;
  brief: string;
}
interface QualityRequestBase {
  version: 3;
  designVersion: 3;
  requestId: string;
  generationId: string;
  seed: number;
  recent: RunDesignSummary[];
  recentContent: EnvironmentSummary[];
  place?: QualityPlace;
}
export interface QualityConceptsRequest extends QualityRequestBase {
  phase: "concepts";
}
export interface QualitySelectionRequest extends QualityRequestBase {
  phase: "selection";
  concepts: QualityConcept[];
}
export interface QualityStructureRequest extends QualityRequestBase {
  phase: "structure";
  concept: QualityConcept;
  rationale: string;
  repair?: { candidate: RunStructureV3; errors: string[] };
}
interface QualityContext extends QualityRequestBase {
  concept: QualityConcept;
  rationale: string;
  structure: RunStructureV3;
  surfaces: SurfaceSlot[];
  structureFingerprint: string;
  surfaceFingerprint: string;
  builderVersion: string;
}
export interface QualityStructureReviewRequest extends QualityContext {
  phase: "structure-review";
}
export interface QualityContentPlanRequest extends QualityContext {
  phase: "content-plan";
}
export interface QualityContentBatchRequest extends QualityContext {
  phase: "content-batch";
  plan: QualityContentPlan;
  groupId: string;
  targets: string[];
  content: EnvironmentContent;
  repair?: { errors: string[] };
}
export interface QualityContentReviewRequest extends QualityContext {
  phase: "content-review";
  plan: QualityContentPlan;
  content: EnvironmentContent;
}
export interface QualityContentRevisionRequest extends QualityContext {
  phase: "content-revision";
  plan: QualityContentPlan;
  content: EnvironmentContent;
  findings: QualityFinding[];
  repair?: { errors: string[] };
}
export type QualityRunDesignRequest =
  | QualityConceptsRequest
  | QualitySelectionRequest
  | QualityStructureRequest
  | QualityStructureReviewRequest
  | QualityContentPlanRequest
  | QualityContentBatchRequest
  | QualityContentReviewRequest
  | QualityContentRevisionRequest;
export interface QualityConceptsReply {
  requestId: string;
  concepts: QualityConcept[];
}
export interface QualitySelectionReply {
  requestId: string;
  selectedId: string;
  rationale: string;
}
export interface QualityStructureReply {
  requestId: string;
  structure: RunStructureV3;
}
export interface QualityReviewReply {
  requestId: string;
  findings: QualityFinding[];
}
export interface QualityContentPlanReply {
  requestId: string;
  plan: QualityContentPlan;
}
export interface QualityEntriesReply {
  requestId: string;
  entries: SurfaceContent[];
}
export type QualityRunDesignReply =
  | QualityConceptsReply
  | QualitySelectionReply
  | QualityStructureReply
  | QualityReviewReply
  | QualityContentPlanReply
  | QualityEntriesReply;
export function parseQualityRequest(value: unknown): QualityRunDesignRequest;
export function parseQualityReply(
  value: unknown,
  request: QualityConceptsRequest,
): QualityConceptsReply;
export function parseQualityReply(
  value: unknown,
  request: QualitySelectionRequest,
): QualitySelectionReply;
export function parseQualityReply(
  value: unknown,
  request: QualityStructureRequest,
): QualityStructureReply;
export function parseQualityReply(
  value: unknown,
  request: QualityStructureReviewRequest | QualityContentReviewRequest,
): QualityReviewReply;
export function parseQualityReply(
  value: unknown,
  request: QualityContentPlanRequest,
): QualityContentPlanReply;
export function parseQualityReply(
  value: unknown,
  request: QualityContentBatchRequest | QualityContentRevisionRequest,
): QualityEntriesReply;
export function parseQualityReply(
  value: unknown,
  request: QualityRunDesignRequest,
): QualityRunDesignReply;
export function qualitySurfaceGroups(
  surfaces: readonly SurfaceSlot[],
): { id: string; surfaceIds: string[] }[];
export function qualityContentBatches(
  surfaces: readonly SurfaceSlot[],
): { groupId: string; targets: string[] }[];
export function parseQualityPartialContent(
  value: unknown,
  structure: RunStructureV3,
  surfaces: readonly SurfaceSlot[],
): EnvironmentContent;
export function mergeQualityEntries(
  request: QualityContentBatchRequest | QualityContentRevisionRequest,
  entries: readonly SurfaceContent[],
): EnvironmentContent;
export function qualityReviewTargets(
  request: QualityRunDesignRequest,
): string[];
export function runQualityContentNoveltyErrors(
  content: EnvironmentContent,
  recentContent: readonly EnvironmentSummary[],
): string[];
export const QUALITY_GUIDANCE: string;

export function qualityGuidance(): string;
