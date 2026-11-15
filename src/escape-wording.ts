/**
 * Words the escape redesign shows instead of the old zombie-run wording.
 *
 * Pure data-in, string-out helpers: no DOM access and no imports from
 * `main.ts`, so they can be unit tested on their own.
 */
import type { EscapeTask } from "./escape-types";
import type { Game } from "./model";

function taskFor(game: Game): EscapeTask | undefined {
  const tasks = game.escape?.tasks ?? [];
  return (
    tasks.find((t) => t.state === "in-progress") ??
    tasks.find((t) => t.state === "available")
  );
}

/** The objective card: the task the player is on, or how the loop ended. */
export function escapeObjective(game: Game): {
  title: string;
  description: string;
} {
  const review =
    "Review your saved work, restart the loop or begin a new game.";
  if (game.status === "escaped")
    return { title: "You got out.", description: review };
  if (game.status === "dead")
    return { title: "You did not make it.", description: review };
  const task = taskFor(game);
  if (!task) return { title: "", description: "" };
  return {
    title: task.title,
    description: `${task.done} of ${task.steps} steps done.`,
  };
}

/** The end card's eyebrow. */
export function escapeEndEyebrow(game: Game) {
  return game.status === "escaped" ? "YOU GOT OUT" : "YOU DID NOT MAKE IT";
}

/** A level's label: the authored area name, or a plain numbered level. */
export function escapeFloorLabel(game: Game, floor: number) {
  const name = game.floors[floor]?.name?.trim() ?? "";
  return name || `Level ${floor + 1}`;
}
