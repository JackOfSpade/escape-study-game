export const HELP_GATE_GUIDANCE: string;
export interface DeclaredHelp {
  /** Free rungs: what is wrong, or a reworded question. */
  nudges: string[];
  /** A concrete hint that leaves the step to the learner. */
  hints: string[];
  /** The step or the full answer. */
  gives: string[];
  /** Facets this reply warned about before hinting. */
  offers: string[];
}
export function validHelp(help: unknown): boolean;
export function unlockedHelp(messages: unknown): string[];
export function helpGateProblem(
  payload: unknown,
  answer: Record<string, unknown>,
  required?: boolean,
): string | undefined;
export function helpStreamGate(
  payload: unknown,
): ((raw: string) => boolean) | undefined;
