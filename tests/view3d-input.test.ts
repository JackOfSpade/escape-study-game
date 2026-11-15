import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { human, step, vault, type Input } from "../src/engine";
import { TestRunner, TEST_DT } from "../src/gametest/runner";
import { emptyScenario } from "../src/gametest/schema";
import type { Game, Point, Roadmap } from "../src/model";
import {
  ARROW_PITCH_SPEED,
  arrowPitch,
  arrowTurn,
  firstPersonInput,
  MAX_PITCH,
} from "../src/view3d/math";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
function fixture() {
  const scenario = emptyScenario();
  scenario.entities = [
    { id: "human", kind: "player", x: 12, y: 12, heading: { x: 0, y: -1 } },
  ];
  return new TestRunner(scenario, roadmap).game;
}
function advance(game: Game, input: Input, ticks = 30) {
  for (let tick = 0; tick < ticks; tick++) step(game, TEST_DT, input);
}
function near(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
}
function point(actual: Point, expected: Point) {
  near(actual.x, expected.x);
  near(actual.y, expected.y);
}
const keys = (...codes: string[]) => new Set(codes);

test("first-person horizontal arrows turn at 2.6 rad/s without translating", () => {
  near(arrowTurn(0, false, true, 0.5), 1.3);
  near(arrowTurn(0, true, false, 0.5), -1.3);
  near(arrowTurn(0.4, true, true, 1), 0.4);
  near(arrowTurn(0.4, false, false, 1), 0.4);
  point(firstPersonInput(0.3, keys("ArrowLeft")), { x: 0, y: 0 });
  point(firstPersonInput(0.3, keys("ArrowRight")), { x: 0, y: 0 });
});
test("arrow turn rate is independent of refresh interval and ignores invalid durations", () => {
  for (const hz of [30, 60, 120]) {
    let yaw = 0;
    for (let i = 0; i < hz; i++) yaw = arrowTurn(yaw, false, true, 1 / hz);
    near(yaw, 2.6);
  }
  for (const dt of [0, -1, NaN, Infinity])
    near(arrowTurn(0.3, false, true, dt), 0.3);
});
test("first-person vertical arrows only look and WASD preserves movement", () => {
  point(firstPersonInput(0, keys("ArrowUp")), { x: 0, y: 0 });
  point(firstPersonInput(0, keys("ArrowDown")), { x: 0, y: 0 });
  point(firstPersonInput(Math.PI / 2, keys("ArrowUp")), { x: 0, y: 0 });
  point(firstPersonInput(Math.PI / 2, keys("KeyA")), { x: 1, y: 0 });
  point(firstPersonInput(Math.PI / 2, keys("KeyD")), { x: -1, y: 0 });
  point(firstPersonInput(0, keys("KeyW", "ArrowUp")), { x: 1, y: 0 });
  point(firstPersonInput(0, keys("KeyW", "ArrowDown")), { x: 1, y: 0 });
  point(firstPersonInput(0, keys("KeyD", "ArrowUp")), { x: 0, y: 1 });
});
test("vertical arrows raise and lower pitch at 1.4 rad/s", () => {
  assert.equal(ARROW_PITCH_SPEED, 1.4);
  near(arrowPitch(0.2, true, false, 0.5), 0.9);
  near(arrowPitch(0.2, false, true, 0.5), -0.5);
  near(arrowPitch(0.2, true, true, 1), 0.2);
  near(arrowPitch(0.2, false, false, 1), 0.2);
});
test("arrow pitch clamps at both vertical limits", () => {
  assert.equal(arrowPitch(MAX_PITCH - 0.01, true, false, 1), MAX_PITCH);
  assert.equal(arrowPitch(-MAX_PITCH + 0.01, false, true, 1), -MAX_PITCH);
  assert.equal(arrowPitch(MAX_PITCH, true, false, 1), MAX_PITCH);
  assert.equal(arrowPitch(-MAX_PITCH, false, true, 1), -MAX_PITCH);
});
test("arrow pitch rate is independent of refresh interval and ignores invalid durations", () => {
  for (const hz of [30, 60, 120]) {
    let pitch = 0;
    for (let i = 0; i < hz; i++) pitch = arrowPitch(pitch, true, false, 1 / hz);
    near(pitch, 1.4);
  }
  for (const dt of [0, -1, NaN, Infinity, -Infinity]) {
    assert.equal(arrowPitch(0.3, true, false, dt), 0.3);
    assert.equal(arrowPitch(0.3, false, true, dt), 0.3);
  }
});
test("first-person strafing keeps traffic heading aligned with actual walking direction", () => {
  const game = fixture(),
    player = human(game);
  advance(game, { ...firstPersonInput(0, keys("KeyD")), grab: false });
  assert.ok(player.y > 15, "the real physics motor walks south");
  near(player.x, 12);
  point(player.heading, { x: 0, y: 1 });
});
test("first-person backpedalling faces the walking direction for friendly traffic", () => {
  const game = fixture(),
    player = human(game);
  advance(game, { ...firstPersonInput(0, keys("KeyS")), grab: false });
  assert.ok(player.x < 9, "the real physics motor walks west");
  near(player.y, 12);
  point(player.heading, { x: -1, y: 0 });
});
test("camera-only arrow turning never updates simulation heading or position", () => {
  const game = fixture(),
    player = human(game);
  const yaw = arrowTurn(0, false, true, 0.5);
  step(game, TEST_DT, {
    ...firstPersonInput(yaw, keys("ArrowRight")),
    grab: false,
  });
  point(player.heading, { x: 0, y: -1 });
  point(player, { x: 12, y: 12 });
});
test("classic world input still faces its normalized movement direction", () => {
  const game = fixture(),
    player = human(game);
  advance(game, { x: 1, y: 1, grab: false });
  point(player.heading, { x: Math.SQRT1_2, y: Math.SQRT1_2 });
  near(player.x - 12, player.y - 12);
  assert.ok(Math.hypot(player.x - 12, player.y - 12) > 3);
  assert.ok(Math.hypot(player.x - 12, player.y - 12) < 3.5);
});
test("paused games ignore first-person movement without advancing time", () => {
  const game = fixture();
  game.paused = true;
  const before = JSON.stringify(game);
  step(game, TEST_DT, { ...firstPersonInput(0, keys("KeyW")), grab: false });
  assert.equal(JSON.stringify(game), before);
});
for (const status of ["dead", "escaped"] as const)
  test(`${status} humans keep moving as ghosts while the world advances`, () => {
    const game = fixture(),
      player = human(game),
      start = { ...player };
    game.status = status;
    if (status === "dead") {
      player.hp = 0;
      player.alive = false;
    } else player.escaped = true;
    step(game, TEST_DT, { ...firstPersonInput(0, keys("KeyW")), grab: false });
    const along =
      (player.x - start.x) * player.heading.x +
      (player.y - start.y) * player.heading.y;
    assert.ok(along > 0, "the ghost walked along its heading");
    assert.ok(game.time > 0);
  });
for (const strafing of [false, true])
  test(`engine vault follows the heading supplied at action time ${strafing ? "after strafing" : "from rest"}`, () => {
    const scenario = emptyScenario();
    scenario.entities = [
      { id: "human", kind: "player", x: 10.1, y: 12, heading: { x: 0, y: -1 } },
      { id: "shelf", kind: "shelf", x: 12, y: 12 },
    ];
    const game = new TestRunner(scenario, roadmap).game,
      player = human(game);
    step(game, TEST_DT, { x: 0, y: strafing ? 1 : 0, grab: false });
    const takeoffY = player.y;
    // Main-handler camera snapshots are covered in the first-person browser spec.
    // Here the real engine vault follows the supplied action-time heading.
    player.heading = { x: 1, y: 0 };
    assert.equal(vault(game, player), true);
    assert.equal(player.vault?.obstacle, "shelf");
    assert.ok(player.vault!.to.x > 13.8);
    near(player.vault!.to.y, takeoffY);
    advance(game, { x: 0, y: 0, grab: false }, 40);
    assert.equal(player.vault, undefined);
    assert.ok(player.x > 13.8, "the actual vault lands beyond the shelf");
    near(player.y, takeoffY);
    assert.equal(game.floors[0].furniture[0].hp, 3200);
  });
