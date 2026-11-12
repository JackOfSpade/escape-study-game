import type { Encounter, Game } from "./model";
import type { EscapeTask } from "./escape-types";
import {
  advanceTask,
  startTask,
  taskIndicator,
  terminalDecision,
} from "./escape-tasks";
import { logEvent } from "./escape-log";

/**
 * Study checkpoints ticked onto escape tasks (docs/ESCAPE_REDESIGN.md section
 * 8). A task is worked at one study station; each completed question segment
 * advances it one step. The terminal's next move is decided here and applied
 * by the game shell: this module never touches the DOM or the encounter.
 *
 * No imports from question-thread: completeSegment is the caller, so this file
 * stays free of that cycle.
 */
export type EscapeDecision = "continue" | "next-question" | "close";

/** The escape task whose station this is, while it can still be worked. */
export function taskAtStation(
  g: Game,
  stationId: string,
): EscapeTask | undefined {
  return g.escape?.tasks.find(
    (t) =>
      t.stationId === stationId &&
      (t.state === "available" || t.state === "in-progress"),
  );
}

/** The station the human is standing at, if any. */
function humanStation(g: Game): string | undefined {
  return g.survivors.find((a) => a.id === "human")?.station;
}

/** Decisions waiting for the game shell to apply, one per game. */
const decisions = new WeakMap<Game, EscapeDecision>();

/** Read the decision recorded by the last segment completion, and clear it. */
export function takeEscapeDecision(g: Game): EscapeDecision | undefined {
  const decision = decisions.get(g);
  decisions.delete(g);
  return decision;
}

/**
 * A segment completed at `e`. When `e` is an escape task's station, start the
 * task if it was waiting, tick its counter, log the indicator line, and record
 * what the terminal should do next. Anything else (no escape game, a station
 * without a task) is a no-op.
 */
export function onEscapeSegment(
  g: Game,
  e: Encounter,
): { task: EscapeTask; decision: EscapeDecision } | undefined {
  const escape = g.escape;
  if (!escape) return undefined;
  const stationId = humanStation(g);
  if (!stationId) return undefined;
  const found = taskAtStation(g, stationId);
  if (!found) return undefined;
  const task = found.state === "available" ? startTask(found) : found;
  advanceTask(task);
  const decision = terminalDecision({
    task,
    // A finished thread, or a terminal that never held one, has no next segment.
    threadFinished: !!g.study.thread?.finishedAt || !e.thread,
  });
  logEvent(escape.log, {
    at: g.time,
    kind: "task",
    areaId: escape.areas.current,
    floor: e.floor,
    actorId: "human",
    text: taskIndicator(task),
  });
  decisions.set(g, decision);
  return { task, decision };
}
