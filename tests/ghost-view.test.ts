import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { human, step } from "../src/engine";
import { TestRunner, TEST_DT } from "../src/gametest/runner";
import { emptyScenario } from "../src/gametest/schema";
import { ghostActive, ghostBody, ghostNotice } from "../src/ghost-view";
import type { Game, Roadmap } from "../src/model";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);

function world() {
  const scenario = emptyScenario();
  scenario.entities = [
    { id: "human", kind: "player", x: 12, y: 12, heading: { x: 0, y: -1 } },
  ];
  return new TestRunner(scenario, roadmap).game;
}

/** End the human's run where it stands, as the engine does on death. */
function die(game: Game) {
  const player = human(game),
    at = { x: player.x, y: player.y, floor: player.floor };
  game.status = "dead";
  player.hp = 0;
  player.alive = false;
  return at;
}

function advance(game: Game, ticks: number) {
  for (let tick = 0; tick < ticks; tick++)
    step(game, TEST_DT, { x: 0, y: 0, grab: false });
}

test("ghostActive is false while playing and true after a stepped death", () => {
  const game = world();
  assert.equal(ghostActive(game), false);
  die(game);
  advance(game, 1);
  assert.equal(ghostActive(game), true);
});

test("ghostBody is the death position, but only on the death floor", () => {
  const game = world(),
    death = die(game);
  advance(game, 1);
  assert.deepEqual(ghostBody(game, death.floor), { x: death.x, y: death.y });
  assert.equal(ghostBody(game, death.floor + 1), undefined);
});

test("an escaped human leaves no body to stand over", () => {
  const game = world(),
    player = human(game);
  game.status = "escaped";
  player.escaped = true;
  advance(game, 1);
  assert.equal(ghostActive(game), true);
  assert.equal(ghostBody(game, player.floor), undefined);
});

test("ghostNotice says exactly what a ghost may and may not do", () => {
  assert.deepEqual(ghostNotice(), {
    title: "You are a ghost.",
    description:
      "Nobody can see or hear you, and you cannot touch anything. Walk where you like.",
  });
});
