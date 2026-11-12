import type { EscapeTask } from "./escape-types";

/**
 * Tasks mapped onto study checkpoints (docs/ESCAPE_REDESIGN.md section 8).
 *
 * A task is a physical action whose step count is chosen to make sense in the
 * story. Each completed question checkpoint advances the task being worked by
 * one step; the question split never decides the step count. Everything here
 * is pure and mutates only the task it is handed.
 */

const TITLE_LIMIT = 80;
const UNIT_LIMIT = 24;
const STEP_LIMIT = 8;

function requireText(value: string, label: string, limit: number): string {
  if (typeof value !== "string") throw Error(`${label} must be text`);
  const text = value.trim();
  if (!text || text.length > limit)
    throw Error(`${label} must be 1..${limit} characters`);
  return text;
}

function requireId(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw Error(`${label} must be a non-empty id`);
  return value;
}

/** Validate the director's answer and build a fresh, available task. */
export function createTask(
  input: Omit<EscapeTask, "id" | "done" | "state">,
  id: string,
): EscapeTask {
  const title = requireText(input.title, "Task title", TITLE_LIMIT);
  const unit = requireText(input.unit, "Task unit", UNIT_LIMIT);
  if (
    !Number.isInteger(input.steps) ||
    input.steps < 1 ||
    input.steps > STEP_LIMIT
  )
    throw Error(`Task steps must be an integer 1..${STEP_LIMIT}`);
  const objectId = requireId(input.objectId, "Task objectId");
  const areaId = requireId(input.areaId, "Task areaId");
  if (!Array.isArray(input.fromFacts))
    throw Error("Task fromFacts must be a list");
  const task: EscapeTask = {
    id,
    title,
    unit,
    steps: input.steps,
    done: 0,
    objectId,
    areaId,
    fromFacts: [...input.fromFacts],
    state: "available",
  };
  if (input.onComplete !== undefined) task.onComplete = input.onComplete;
  return task;
}

/** Begin work at a terminal. Any other state is left untouched. */
export function startTask(task: EscapeTask): EscapeTask {
  if (task.state === "available") task.state = "in-progress";
  return task;
}

/**
 * One completed question checkpoint while this task is the one being worked.
 * Only an in-progress task moves; anything else reports no change.
 */
export function advanceTask(task: EscapeTask): {
  completed: boolean;
  changed: boolean;
} {
  if (task.state !== "in-progress") return { completed: false, changed: false };
  task.done += 1;
  if (task.done >= task.steps) {
    task.done = task.steps;
    task.state = "complete";
    return { completed: true, changed: true };
  }
  return { completed: false, changed: true };
}

/**
 * What the terminal does at a checkpoint: a finished task closes the terminal
 * and carries the unfinished question to the next task's terminal; a finished
 * question loads the next one; otherwise the same terminal ticked and stays.
 */
export function terminalDecision(input: {
  task: EscapeTask;
  threadFinished: boolean;
}): "continue" | "next-question" | "close" {
  if (input.task.state === "complete") return "close";
  if (input.threadFinished) return "next-question";
  return "continue";
}

/**
 * The step count the director should aim for: the requested count rounded and
 * clamped to 1..8. The number of question segments is informative only; the
 * question split never dictates the task size.
 */
export function suggestSteps(
  requested: number,
  segmentsRemaining: number,
): number {
  // The split is deliberately ignored so the task keeps its story size.
  void segmentsRemaining;
  if (Number.isNaN(requested)) return 1;
  const rounded = Math.round(requested);
  return Math.min(STEP_LIMIT, Math.max(1, rounded));
}

/**
 * A new loop keeps the task list and its identities but rewinds progress:
 * every started or finished task is available again, abandoned stays so.
 */
export function resetTasksForLoop(tasks: EscapeTask[]): EscapeTask[] {
  return tasks.map((task) => ({
    ...task,
    done: 0,
    fromFacts: [...task.fromFacts],
    state: task.state === "abandoned" ? "abandoned" : "available",
  }));
}

/** The world indicator line, e.g. "Loosen the hatch bolts · 2/4 bolts". */
export function taskIndicator(task: EscapeTask): string {
  return `${task.title} · ${task.done}/${task.steps} ${task.unit}`;
}

/** Drop a task. A complete task is history and stays complete. */
export function abandonTask(task: EscapeTask, reason?: string): EscapeTask {
  // The reason is for the caller's event log; tasks have no field for it.
  void reason;
  if (task.state !== "complete") task.state = "abandoned";
  return task;
}
