export const SEGMENT_POLICY: Readonly<{
  targetSeconds: number;
  minSeconds: number;
  maxSeconds: number;
  splitAboveSeconds: number;
  maxWholeSeconds: number;
  minSegments: number;
  maxSegments: number;
  depthTargets: readonly number[];
  maxGoalLength: number;
  maxSummaryLength: number;
}>;
export const SEGMENT_GENERATION_GUIDANCE: string;
export const SEGMENT_TUTOR_GUIDANCE: string;
export function validateQuestionSegments(problem: unknown): void;
export function segmentSummary(value: unknown): string | undefined;
