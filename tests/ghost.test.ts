import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { human, step, toggleDoor } from "../src/engine";
import { TestRunner, TEST_DT } from "../src/gametest/runner";
import { emptyScenario, type Spawn } from "../src/gametest/schema";
import { beginGhost, ghostStep, isGhost } from "../src/ghost";
import type { Game, Roadmap } from "../src/model";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);

function world(entities: Spawn[], edit?: (game: Game) => void) {
  const scenario = emptyScenario();
  scenario.entities = [
    { id: "human", kind: "player", x: 12, y: 12, heading: { x: 0, y: -1 } },
    ...entities,
  ];
  const game = new TestRunner(scenario, roadmap).game;
  edit?.(game);
  return game;
}

function advance(game: Game, input: { x: number; y: number }, ticks: number) {
  for (let tick = 0; tick < ticks; tick++)
    step(game, TEST_DT, { ...input, grab: false });
}

function kill(game: Game) {
  const player = human(game),
    at = { x: player.x, y: player.y, floor: player.floor };
  game.status = "dead";
  player.hp = 0;
  player.alive = false;
  return at;
}

test("a dead human walks on as a ghost from where the body fell", () => {
  const game = world([]),
    player = human(game),
    death = kill(game),
    downAt = player.downAt;
  advance(game, { x: 1, y: 0 }, 90);
  assert.equal(isGhost(player), true);
  assert.deepEqual(player.ghost?.body, death);
  assert.ok(
    Math.hypot(player.x - death.x, player.y - death.y) > 1,
    "the ghost moved more than a metre",
  );
  // The outcome of the run is untouched by becoming a ghost.
  assert.equal(player.alive, false);
  assert.equal(player.escaped, false);
  assert.equal(player.hp, 0);
  assert.equal(player.downAt, downAt);
});

test("ghost movement is idempotent and does not restart the death position", () => {
  const game = world([]),
    player = human(game),
    death = kill(game);
  advance(game, { x: 1, y: 0 }, 30);
  const captured = { ...player.ghost!.body! };
  beginGhost(game);
  advance(game, { x: 0, y: 1 }, 30);
  assert.deepEqual(player.ghost?.body, death);
  assert.deepEqual(player.ghost?.body, captured);
});

test("a ghost walking into a wall stays on its own side", () => {
  const game = world([], (g) => {
    // An interior wall column east of the ghost's start.
    for (let y = 8; y < 16; y++) g.floors[0].tiles[y][15] = 1;
  });
  const player = human(game);
  kill(game);
  advance(game, { x: 1, y: 0 }, 120);
  assert.ok(player.x > 12.05, "the ghost tried to walk east");
  assert.ok(player.x < 15, `the ghost crossed the wall at x=${player.x}`);
});

test("a ghost cannot move furniture or pass through it", () => {
  const game = world([{ id: "shelf", kind: "shelf", x: 14.5, y: 12 }]);
  const shelf = game.floors[0].furniture[0],
    before = { x: shelf.x, y: shelf.y, angle: shelf.angle },
    player = human(game);
  kill(game);
  advance(game, { x: 1, y: 0 }, 150);
  assert.deepEqual(
    { x: shelf.x, y: shelf.y, angle: shelf.angle },
    before,
    "the ghost never pushes or turns furniture",
  );
  assert.equal(shelf.moved, 0);
  assert.ok(player.x < shelf.x, `the ghost passed through to x=${player.x}`);
});

test("a ghost is stopped by a latched door it cannot work", () => {
  const game = world([{ id: "door", kind: "door", x: 16, y: 12 }]);
  const door = game.floors[0].furniture[0],
    player = human(game);
  kill(game);
  advance(game, { x: 1, y: 0 }, 150);
  assert.equal(door.door?.latched, true);
  assert.equal(toggleDoor(game, player, door.id), false);
  assert.equal(door.door?.latched, true);
  assert.equal(door.door?.swung, false);
  assert.ok(player.x < door.x, `the ghost passed the door to x=${player.x}`);
});

test("a ghost is invisible and inaudible to zombies for five seconds", () => {
  const game = world([{ id: "zombie", kind: "zombie", x: 14, y: 12 }]);
  const player = human(game),
    zombie = game.zombies[0];
  game.status = "escaped";
  player.escaped = true;
  const hp = player.hp;
  // Walk back and forth two metres from the zombie: real movement, no noise.
  for (let tick = 0; tick < 300; tick++)
    step(game, TEST_DT, { x: tick % 2 ? 1 : -1, y: 0, grab: false });
  assert.equal(isGhost(player), true);
  assert.equal(zombie.target, undefined);
  assert.equal(player.hp, hp);
  assert.equal(player.alive, true);
});

test("a moving ghost never makes noise", () => {
  const game = world([]),
    player = human(game);
  player.noiseUntil = game.time + 0.4;
  player.noiseLevel = 4;
  const noise = { until: player.noiseUntil, level: player.noiseLevel };
  kill(game);
  advance(game, { x: 0, y: -1 }, 120);
  assert.equal(player.noiseUntil, noise.until);
  assert.equal(player.noiseLevel, noise.level);
});

test("an escaped human becomes a bodyless ghost that still walks", () => {
  const game = world([]),
    player = human(game),
    start = { x: player.x, y: player.y };
  game.status = "escaped";
  player.escaped = true;
  advance(game, { x: 0, y: -1 }, 90);
  assert.equal(isGhost(player), true);
  assert.equal(player.ghost?.body, undefined);
  assert.ok(
    Math.hypot(player.x - start.x, player.y - start.y) > 1,
    "the escaped ghost moved more than a metre",
  );
});

test("ghostStep ignores a grab request and still walks", () => {
  const game = world([{ id: "shelf", kind: "shelf", x: 14.5, y: 12 }]);
  const player = human(game),
    shelf = game.floors[0].furniture[0];
  kill(game);
  beginGhost(game);
  assert.equal(isGhost(player), true);
  for (let tick = 0; tick < 120; tick++)
    ghostStep(game, player, { x: 1, y: 0, grab: true }, TEST_DT);
  assert.equal(shelf.moved, 0);
  assert.equal(shelf.x, 14.5);
  assert.ok(player.x > 12.05, "the ghost ignored the grab and walked");
  assert.ok(player.x < shelf.x);
});
