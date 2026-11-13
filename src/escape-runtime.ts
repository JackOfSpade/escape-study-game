/**
 * Escape director runtime (docs/ESCAPE_REDESIGN.md sections 4-6 and 10).
 *
 * Thin, stable contract over `src/director.ts`: `src/main.ts` calls these,
 * tests call the director directly, and a game without `g.escape` (every
 * historical save) is a strict no-op.
 */
import {
  escapeFrame as directorFrame,
  escapeInteract as directorInteract,
  escapeJournal as directorJournal,
} from "./director";
import type { Game } from "./model";

export type { DirectorRequest } from "./director";
export {
  ensureTaskStation,
  resetDirectorRequest,
  setDirectorRequest,
  taskForStation,
} from "./director";

/** What the player engaged with when pressing E on something that is not a terminal. */
export interface Engagement {
  kind: "attempt" | "read";
  /** Furniture id, portal id or document id. */
  subjectId: string;
  /** Visible label of the thing. */
  label: string;
}

/**
 * Once per simulated frame block while the game runs (not while paused or
 * waiting on AI): PA schedule, omens, intent prediction, background area
 * generation and the event log.
 */
export function escapeFrame(g: Game, dt: number): void {
  if (!g.escape) return;
  directorFrame(g, dt);
}

/**
 * The player pressed E on something with no terminal. Returns true when the
 * director handled it (the interaction is then consumed).
 */
export function escapeInteract(g: Game, engagement: Engagement): boolean {
  if (!g.escape) return false;
  return directorInteract(g, engagement);
}

/** Lines for the journal panel, newest last. */
export function escapeJournal(g: Game): string[] {
  if (!g.escape) return [];
  return directorJournal(g);
}
