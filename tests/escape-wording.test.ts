import assert from "node:assert/strict";
import test from "node:test";
import { createEscapeState } from "../src/escape-state";
import type { EscapeTask } from "../src/escape-types";
import {
  escapeEndEyebrow,
  escapeFloorLabel,
  escapeObjective,
} from "../src/escape-wording";
import type { Game } from "../src/model";

/** Only the fields the escape state reads, as tests/escape-state.test.ts does. */
function fakeGame(overrides: Record<string, unknown> = {}): Game {
  return {
    seed: 1234,
    status: "playing",
    survivors: [{ name: "Ada Reyes", role: "flight engineer" }],
    design: {
      design: {
        title: "Kestrel Station",
        premise: "A mining station is going quiet.",
        opening: "You arrive on the last supply run.",
      },
    },
    floors: [{ name: "Main Hall" }, { name: "" }],
    ...overrides,
  } as unknown as Game;
}

function makeTask(overrides: Partial<EscapeTask> = {}): EscapeTask {
  return {
    id: "t1",
    title: "Loosen the hatch bolts",
    unit: "bolts",
    steps: 4,
    done: 1,
    objectId: "hatch",
    areaId: "start",
    fromFacts: [],
    state: "available",
    ...overrides,
  };
}

/** A memory-only escape run built the same way the game builds one. */
function escapeGame(
  tasks: EscapeTask[] = [],
  status: Game["status"] = "playing",
): Game {
  const game = fakeGame({ status });
  game.escape = createEscapeState(game, { gender: "female", seed: 77 });
  game.escape.tasks.push(...tasks);
  return game;
}

test("escapeObjective shows the in-progress task and its step count", () => {
  const game = escapeGame([
    makeTask({ id: "t1", title: "Restore the radio", steps: 5, done: 2 }),
    makeTask({
      id: "t2",
      title: "Loosen the hatch bolts",
      steps: 4,
      done: 3,
      state: "in-progress",
    }),
  ]);
  assert.deepEqual(escapeObjective(game), {
    title: "Loosen the hatch bolts",
    description: "3 of 4 steps done.",
  });
});

test("escapeObjective falls back to the first available task", () => {
  const game = escapeGame([
    makeTask({
      id: "t1",
      title: "Mend the radio",
      steps: 5,
      done: 5,
      state: "complete",
    }),
    makeTask({
      id: "t2",
      title: "Trace the wiring",
      steps: 2,
      done: 0,
      state: "available",
    }),
  ]);
  assert.deepEqual(escapeObjective(game), {
    title: "Trace the wiring",
    description: "0 of 2 steps done.",
  });
});

test("escapeObjective invites a plan while there is nothing to do yet", () => {
  assert.deepEqual(escapeObjective(escapeGame()), {
    title: "",
    description: "Press P to think of a way out.",
  });
});

test("escapeObjective closes a dead loop with the fixed text", () => {
  const game = escapeGame(
    [makeTask({ id: "t1", state: "in-progress" })],
    "dead",
  );
  assert.deepEqual(escapeObjective(game), {
    title: "You did not make it.",
    description:
      "Review your saved work, restart the loop or begin a new game.",
  });
});

test("escapeObjective closes an escaped loop with the fixed text", () => {
  const game = escapeGame([], "escaped");
  assert.deepEqual(escapeObjective(game), {
    title: "You got out.",
    description:
      "Review your saved work, restart the loop or begin a new game.",
  });
});

test("escapeEndEyebrow follows the run's end", () => {
  assert.equal(escapeEndEyebrow(escapeGame([], "escaped")), "YOU GOT OUT");
  assert.equal(escapeEndEyebrow(escapeGame([], "dead")), "YOU DID NOT MAKE IT");
});

test("escapeFloorLabel uses the authored name and falls back to the level", () => {
  const game = escapeGame();
  assert.equal(escapeFloorLabel(game, 0), "Main Hall");
  assert.equal(escapeFloorLabel(game, 1), "Level 2");
});

test("escapeFloorLabel trims an authored name", () => {
  const game = fakeGame({ floors: [{ name: "  Atrium  " }] });
  assert.equal(escapeFloorLabel(game, 0), "Atrium");
});
