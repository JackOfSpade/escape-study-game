import assert from "node:assert/strict";
import test from "node:test";
import { createTask, taskIndicator } from "../src/escape-tasks";
import {
  onEscapeSegment,
  takeEscapeDecision,
  taskAtStation,
} from "../src/escape-terminal";
import type { Encounter, Game, Problem } from "../src/model";

/** A minimal hand-built game: only the fields this mapping reads. */
function setup(
  options: {
    steps?: number;
    done?: number;
    state?: "available" | "in-progress" | "complete";
    finished?: boolean;
    noThread?: boolean;
    noEscape?: boolean;
    station?: string;
  } = {},
) {
  const task = createTask(
    {
      title: "Loosen the hatch bolts",
      unit: "bolts",
      steps: options.steps ?? 4,
      objectId: "hatch-bolts",
      areaId: "rocket-bay",
      fromFacts: [],
    },
    "task-hatch",
  );
  task.stationId = "station-hatch";
  task.done = options.done ?? 0;
  task.state = options.state ?? "in-progress";
  const thread = {
    id: "thread-1",
    problem: { segments: [] } as unknown as Problem,
    segment: 0,
    visits: [],
    startedAt: "2024-01-01T00:00:00.000Z",
    ...(options.finished ? { finishedAt: "2024-01-01T00:10:00.000Z" } : {}),
  };
  const encounter = {
    id: "e1",
    floor: 2,
    mode: "solo",
    state: "consumed",
    ...(options.noThread ? {} : { thread: { id: "thread-1", segment: 0 } }),
  } as unknown as Encounter;
  const g = {
    id: "g1",
    time: 42,
    survivors: [{ id: "human", station: options.station ?? "station-hatch" }],
    study: { thread },
    escape: options.noEscape
      ? undefined
      : {
          tasks: [task],
          log: [],
          areas: { start: "rocket-bay", current: "rocket-bay", areas: {} },
        },
  } as unknown as Game;
  return { g, task, encounter };
}

test("taskAtStation finds the task that is still workable", () => {
  const { g, task } = setup();
  assert.equal(taskAtStation(g, "station-hatch"), task);
  assert.equal(taskAtStation(g, "station-elsewhere"), undefined);
  task.state = "complete";
  assert.equal(taskAtStation(g, "station-hatch"), undefined);
  const { g: legacy } = setup({ noEscape: true });
  assert.equal(taskAtStation(legacy, "station-hatch"), undefined);
});

test("a checkpoint on a four-step task continues at the same terminal", () => {
  const { g, task, encounter } = setup();
  const result = onEscapeSegment(g, encounter);
  assert.equal(result?.decision, "continue");
  assert.equal(result?.task, task);
  assert.equal(task.done, 1);
  assert.equal(task.state, "in-progress");
  assert.equal(takeEscapeDecision(g), "continue");
});

test("an available task starts when its first checkpoint lands", () => {
  const { g, task, encounter } = setup({ state: "available" });
  assert.equal(onEscapeSegment(g, encounter)?.decision, "continue");
  assert.equal(task.state, "in-progress");
  assert.equal(task.done, 1);
});

test("the last step closes the terminal even with segments left", () => {
  const { g, task, encounter } = setup({ done: 3 });
  const result = onEscapeSegment(g, encounter);
  assert.equal(result?.decision, "close");
  assert.equal(task.done, 4);
  assert.equal(task.state, "complete");
});

test("a finished question carries steps left to the next question", () => {
  const { g, task, encounter } = setup({ finished: true });
  assert.equal(onEscapeSegment(g, encounter)?.decision, "next-question");
  assert.equal(task.done, 1);
  assert.equal(task.state, "in-progress");
});

test("a terminal without a thread asks for the next question", () => {
  const { g, encounter } = setup({ noThread: true });
  assert.equal(onEscapeSegment(g, encounter)?.decision, "next-question");
});

test("no escape game is a no-op", () => {
  const { g, encounter } = setup({ noEscape: true });
  assert.equal(onEscapeSegment(g, encounter), undefined);
  assert.equal(takeEscapeDecision(g), undefined);
});

test("a station without a task, or no station, is a no-op", () => {
  const elsewhere = setup({ station: "station-elsewhere" });
  assert.equal(onEscapeSegment(elsewhere.g, elsewhere.encounter), undefined);
  assert.equal(takeEscapeDecision(elsewhere.g), undefined);
  assert.equal(elsewhere.g.escape?.log.length, 0);
  const away = setup();
  delete (away.g.survivors[0] as { station?: string }).station;
  assert.equal(onEscapeSegment(away.g, away.encounter), undefined);
  assert.equal(takeEscapeDecision(away.g), undefined);
  assert.equal(away.g.escape?.log.length, 0);
});

test("the checkpoint writes one task line to the log", () => {
  const { g, task, encounter } = setup();
  onEscapeSegment(g, encounter);
  const log = g.escape!.log;
  assert.equal(log.length, 1);
  assert.deepEqual(log[0], {
    at: 42,
    kind: "task",
    areaId: "rocket-bay",
    floor: 2,
    actorId: "human",
    text: taskIndicator(task),
  });
  assert.equal(log[0].text, "Loosen the hatch bolts · 1/4 bolts");
});

test("takeEscapeDecision returns the decision once and clears it", () => {
  const { g, encounter } = setup();
  onEscapeSegment(g, encounter);
  assert.equal(takeEscapeDecision(g), "continue");
  assert.equal(takeEscapeDecision(g), undefined);
});
