import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { TestRunner } from "../src/gametest/runner";
import { emptyScenario } from "../src/gametest/schema";
import type { Game, Roadmap } from "../src/model";
import { readableInFront } from "../src/readables";
import type { SceneObservation } from "../src/scene-observations";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);

/** A real synthetic world whose human stands at (9, 15). */
function world(): { g: Game; human: { x: number; y: number; floor: number } } {
  const scenario = emptyScenario();
  scenario.entities = [{ id: "human", kind: "player", x: 9, y: 15 }];
  const g = new TestRunner(scenario, roadmap).game;
  const human = g.survivors[0];
  assert.ok(human, "the scenario spawned the human");
  return { g, human };
}

/** A stub observation at an offset from the human, in degrees off +x. */
function at(
  human: { x: number; y: number },
  degrees: number,
  distance: number,
  overrides: Partial<SceneObservation> = {},
): SceneObservation {
  const radians = (degrees * Math.PI) / 180;
  return {
    id: "scene.prop:stub",
    title: "Note",
    text: "Read me.",
    elevation: 1.2,
    x: human.x + Math.cos(radians) * distance,
    y: human.y + Math.sin(radians) * distance,
    ...overrides,
  };
}

test("picks the readable in the cone and ignores one behind and one too far", () => {
  const { g, human } = world();
  const reading = readableInFront(g, 0, [
    at(human, 180, 1, { id: "behind", title: "Behind", text: "no" }),
    at(human, 0, 2.6, { id: "far", title: "Far", text: "no" }),
    at(human, 0, 1.5, {
      id: "scene.surface:memo",
      title: "Memo",
      text: "  Turn the valve before the shift ends.  ",
    }),
  ]);
  assert.deepEqual(reading, {
    id: "scene.surface:memo",
    label: "Memo",
    text: "Turn the valve before the shift ends.",
  });
});

test("the cone is 35 degrees either side of yaw", () => {
  const { g, human } = world();
  const inside = readableInFront(g, 0, [
    at(human, -34, 1.2, { id: "inside", text: "inside the cone" }),
    at(human, 40, 1.2, { id: "outside", text: "outside the cone" }),
  ]);
  assert.equal(inside?.id, "inside");
  const outside = readableInFront(g, 0, [
    at(human, 41, 1.2, { id: "wider", text: "outside the cone" }),
    at(human, -180, 1.2, { id: "behind", text: "behind you" }),
  ]);
  assert.equal(outside, undefined);
});

test("yaw follows the atan2 convention and reaches 2.5 tiles but not beyond", () => {
  const { g, human } = world();
  // Facing -y (south in screen terms) only sees the detail placed to the -y.
  const south = readableInFront(g, -Math.PI / 2, [
    at(human, -90, 2.5, { id: "south", text: "a sign on the south wall" }),
    at(human, 0, 1, { id: "east", text: "a sign on the east wall" }),
  ]);
  assert.equal(south?.id, "south");
  const tooFar = readableInFront(g, -Math.PI / 2, [
    at(human, -90, 2.51, { id: "further", text: "out of reach" }),
  ]);
  assert.equal(tooFar, undefined);
});

test("smallest angle wins over proximity, ties prefer the nearer detail", () => {
  const { g, human } = world();
  const centred = readableInFront(g, 0, [
    at(human, 30, 0.6, { id: "side", text: "close but off to the side" }),
    at(human, 0, 2.4, { id: "centred", text: "far but straight ahead" }),
  ]);
  assert.equal(centred?.id, "centred");
  const nearer = readableInFront(g, 0, [
    at(human, 12, 2, { id: "next", text: "same angle, further" }),
    at(human, 12, 1, { id: "close", text: "same angle, nearer" }),
  ]);
  assert.equal(nearer?.id, "close");
});

test("text is trimmed to 600 characters and label/id fall back when absent", () => {
  const { g, human } = world();
  const long = `   ${"a".repeat(700)}   `;
  const reading = readableInFront(g, 0, [
    at(human, 0, 1, { id: "", title: "", text: long }),
  ]);
  assert.ok(reading);
  assert.equal(reading.text.length, 600);
  assert.equal(reading.text, "a".repeat(600));
  assert.equal(reading.label, "writing");
  assert.equal(
    reading.id,
    `${human.floor}:${Math.round((human.x + 1) * 10)}:${Math.round(human.y * 10)}`,
  );
});

test("a detail with no text is not readable", () => {
  const { g, human } = world();
  const reading = readableInFront(g, 0, [
    at(human, 0, 1, { id: "blank", text: "   " }),
    at(human, 0, 1.5, { id: "empty", text: "" }),
  ]);
  assert.equal(reading, undefined);
});

test("readableInFront without injected details needs a survivor", () => {
  const { g } = world();
  g.survivors.splice(0, g.survivors.length);
  assert.equal(readableInFront(g, 0, []), undefined);
});
