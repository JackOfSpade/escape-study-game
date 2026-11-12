import assert from "node:assert/strict";
import test from "node:test";
import {
  abandonTask,
  advanceTask,
  createTask,
  resetTasksForLoop,
  startTask,
  suggestSteps,
  taskIndicator,
  terminalDecision,
} from "../src/escape-tasks";
import type { EscapeTask } from "../src/escape-types";

function task(overrides: Partial<EscapeTask> = {}): EscapeTask {
  return {
    ...createTask(
      {
        title: "  Loosen the hatch bolts  ",
        unit: " bolts ",
        steps: 4,
        objectId: "hatch-bolts",
        areaId: "rocket-bay",
        fromFacts: ["fact-hatch"],
      },
      "task-hatch",
    ),
    ...overrides,
  };
}

test("createTask validates and builds an available task", () => {
  const created = createTask(
    {
      title: "  Loosen the hatch bolts  ",
      unit: " bolts ",
      steps: 4,
      objectId: "hatch-bolts",
      areaId: "rocket-bay",
      fromFacts: ["fact-hatch", "fact-badge"],
      onComplete: "fact-hatch-open",
    },
    "task-hatch",
  );
  assert.deepEqual(created, {
    id: "task-hatch",
    title: "Loosen the hatch bolts",
    unit: "bolts",
    steps: 4,
    done: 0,
    objectId: "hatch-bolts",
    areaId: "rocket-bay",
    fromFacts: ["fact-hatch", "fact-badge"],
    state: "available",
    onComplete: "fact-hatch-open",
  });
  assert.equal("onComplete" in created, true);

  const plain = createTask(
    {
      title: "Trace the wiring",
      unit: "wires",
      steps: 1,
      objectId: "panel",
      areaId: "corridor",
      fromFacts: [],
    },
    "task-wires",
  );
  assert.equal("onComplete" in plain, false);
  assert.deepEqual(plain.fromFacts, []);
});

test("createTask rejects out-of-bounds input with an Error", () => {
  const base = {
    title: "Loosen the hatch bolts",
    unit: "bolts",
    steps: 4,
    objectId: "hatch-bolts",
    areaId: "rocket-bay",
    fromFacts: [],
  };
  const rejects = (input: typeof base, why: string) =>
    assert.throws(() => createTask(input, "task"), Error, why);

  rejects({ ...base, title: "" }, "empty title");
  rejects({ ...base, title: "   " }, "blank title");
  rejects({ ...base, title: "x".repeat(81) }, "title over 80");
  rejects({ ...base, unit: "" }, "empty unit");
  rejects({ ...base, unit: "u".repeat(25) }, "unit over 24");
  rejects({ ...base, steps: 0 }, "zero steps");
  rejects({ ...base, steps: 9 }, "nine steps");
  rejects({ ...base, steps: 2.5 }, "fractional steps");
  rejects({ ...base, objectId: " " }, "blank objectId");
  rejects({ ...base, areaId: "" }, "empty areaId");

  const longest = createTask(
    { ...base, title: "x".repeat(80), unit: "u".repeat(24) },
    "task-long",
  );
  assert.equal(longest.title.length, 80);
  assert.equal(longest.unit.length, 24);
});

test("startTask only starts an available task", () => {
  const fresh = task();
  assert.equal(startTask(fresh).state, "in-progress");
  assert.equal(startTask(fresh).state, "in-progress");
  const complete = task({ state: "complete" });
  assert.equal(startTask(complete).state, "complete");
  const abandoned = task({ state: "abandoned" });
  assert.equal(startTask(abandoned).state, "abandoned");
});

test("advanceTask counts checkpoints and completes on the last step", () => {
  const running = startTask(task({ steps: 3 }));
  assert.deepEqual(advanceTask(running), { completed: false, changed: true });
  assert.equal(running.done, 1);
  assert.deepEqual(advanceTask(running), { completed: false, changed: true });
  assert.equal(running.done, 2);
  assert.deepEqual(advanceTask(running), { completed: true, changed: true });
  assert.equal(running.done, 3);
  assert.equal(running.state, "complete");
  assert.deepEqual(advanceTask(running), { completed: false, changed: false });
  assert.equal(running.done, 3);

  const untouched: EscapeTask[] = [
    task({ state: "available" }),
    task({ state: "abandoned" }),
    task({ state: "complete", done: 4 }),
  ];
  for (const each of untouched) {
    const before = { ...each };
    assert.deepEqual(advanceTask(each), {
      completed: false,
      changed: false,
    });
    assert.deepEqual(each, before);
  }
});

test("terminalDecision picks close, next-question or continue", () => {
  const running = startTask(task());
  const table: {
    task: EscapeTask;
    threadFinished: boolean;
    expected: "continue" | "next-question" | "close";
  }[] = [
    { task: running, threadFinished: false, expected: "continue" },
    { task: running, threadFinished: true, expected: "next-question" },
    {
      task: task({ state: "complete", done: 4 }),
      threadFinished: false,
      expected: "close",
    },
    {
      task: task({ state: "complete", done: 4 }),
      threadFinished: true,
      expected: "close",
    },
    {
      task: task({ state: "abandoned" }),
      threadFinished: false,
      expected: "continue",
    },
    {
      task: task({ state: "abandoned" }),
      threadFinished: true,
      expected: "next-question",
    },
    {
      task: task({ state: "available" }),
      threadFinished: true,
      expected: "next-question",
    },
  ];
  for (const row of table)
    assert.equal(
      terminalDecision({ task: row.task, threadFinished: row.threadFinished }),
      row.expected,
      `${row.task.state}/${row.threadFinished}`,
    );
});

test("suggestSteps rounds and clamps, ignoring the question split", () => {
  const cases: [number, number, number][] = [
    [4, 0, 4],
    [4, 1, 4],
    [4, 3, 4],
    [4, 40, 4],
    [3.4, 0, 3],
    [3.5, 2, 4],
    [0, 6, 1],
    [-5, 3, 1],
    [9, 2, 8],
    [12.7, 0, 8],
  ];
  for (const [requested, segmentsRemaining, expected] of cases)
    assert.equal(
      suggestSteps(requested, segmentsRemaining),
      expected,
      `${requested} requested with ${segmentsRemaining} segments left`,
    );
  for (const segments of [0, 1, 2, 5, 9])
    assert.equal(suggestSteps(5.2, segments), suggestSteps(5.2, 0));
});

test("resetTasksForLoop rewinds progress but keeps abandoned tasks", () => {
  const tasks = [
    task({ id: "a", state: "in-progress", done: 2 }),
    task({ id: "b", state: "complete", done: 4 }),
    task({ id: "c", state: "abandoned", done: 1 }),
    task({ id: "d", state: "available", done: 0 }),
  ];
  const before = tasks.map((each) => ({ ...each }));
  const reset = resetTasksForLoop(tasks);

  assert.notEqual(reset, tasks);
  assert.deepEqual(
    reset.map((each) => [each.id, each.state, each.done]),
    [
      ["a", "available", 0],
      ["b", "available", 0],
      ["c", "abandoned", 0],
      ["d", "available", 0],
    ],
  );
  assert.deepEqual(
    tasks,
    before,
    "the loop reset must not touch the previous loop's tasks",
  );
  assert.notEqual(reset[0], tasks[0]);
  assert.notEqual(reset[0]!.fromFacts, tasks[0]!.fromFacts);
  reset[0]!.fromFacts.push("fact-extra");
  assert.deepEqual(tasks[0]!.fromFacts, ["fact-hatch"]);
});

test("taskIndicator reads exactly like the world indicator", () => {
  assert.equal(
    taskIndicator(task({ done: 2 })),
    "Loosen the hatch bolts · 2/4 bolts",
  );
  assert.equal(
    taskIndicator(task({ done: 0, state: "available" })),
    "Loosen the hatch bolts · 0/4 bolts",
  );
  assert.equal(
    taskIndicator(task({ done: 4, steps: 4, state: "complete" })),
    "Loosen the hatch bolts · 4/4 bolts",
  );
  assert.equal(taskIndicator(task()).includes("\u00b7"), true);
});

test("abandonTask drops a task unless it is already complete", () => {
  const dropped = abandonTask(task({ state: "in-progress", done: 1 }));
  assert.equal(dropped.state, "abandoned");
  assert.equal(dropped.done, 1);
  const withReason = abandonTask(task(), "the hatch opened on its own");
  assert.equal(withReason.state, "abandoned");
  const complete = abandonTask(
    task({ state: "complete", done: 4 }),
    "already finished",
  );
  assert.equal(complete.state, "complete");
  const twice = abandonTask(abandonTask(task({ state: "in-progress" })));
  assert.equal(twice.state, "abandoned");
});
