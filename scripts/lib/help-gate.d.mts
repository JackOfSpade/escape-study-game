export const HELP_GATE_GUIDANCE: string;
export interface DeclaredHelp {
  supplies: string[];
  offers: string[];
}
export function validHelp(help: unknown): boolean;
export function confirmedHelp(payload: unknown): string[] | undefined;
export function helpGateProblem(
  payload: unknown,
  answer: Record<string, unknown>,
  required?: boolean,
): string | undefined;
export function helpStreamGate(
  payload: unknown,
): ((raw: string) => boolean) | undefined;
