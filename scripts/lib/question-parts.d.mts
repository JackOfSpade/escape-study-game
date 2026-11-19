export const MAX_PARTS: number;
export const PARTS_GENERATION_GUIDANCE: string;
export const PARTS_TUTOR_GUIDANCE: string;
export function partsProblem(parts: unknown): string | undefined;
export function composePrompt(shared: string, parts: string[]): string;
export function stagedParts(problem: unknown): string[] | undefined;
export function closesPart(
  payload: unknown,
  answer: Record<string, unknown>,
): boolean;
export function partReplyProblem(
  payload: unknown,
  answer: Record<string, unknown>,
): string | undefined;
