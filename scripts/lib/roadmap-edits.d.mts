export const ROADMAP_EDIT_LIMITS: Readonly<{
  maxEdits: number;
  maxFindLength: number;
  maxReplaceLength: number;
}>;
export const KEEP_LOCAL: "keep-local";
export const ROADMAP_EDIT_GUIDANCE: string;
export type RoadmapEdit = { find: string; replace: string };
export function applyRoadmapEdits(local: string, edits: unknown): string;
export function expandRoadmapReconciliation<T>(local: string, answer: T): T;
