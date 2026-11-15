import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { doorFrame } from "../src/doors";
import { nearbyDoor, toggleDoor } from "../src/engine";
import { createEscapeState } from "../src/escape-state";
import type { Actor, Furniture, Game, Roadmap } from "../src/model";
import { createPlayableGame } from "../src/world";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);

function standBy(g: Game, a: Actor, door: Furniture): boolean {
  const frame = doorFrame(door);
  const perpendicular =
    frame.h >= frame.w
      ? [
          { x: -1.3, y: 0 },
          { x: 1.3, y: 0 },
          { x: -1.6, y: 0 },
          { x: 1.6, y: 0 },
        ]
      : [
          { x: 0, y: -1.3 },
          { x: 0, y: 1.3 },
          { x: 0, y: -1.6 },
          { x: 0, y: 1.6 },
        ];
  const offsets = [
    ...perpendicular,
    { x: 0.9, y: 0.9 },
    { x: -0.9, y: 0.9 },
    { x: 0.9, y: -0.9 },
    { x: -0.9, y: -0.9 },
  ];
  for (const off of offsets) {
    Object.assign(a, { x: frame.x + off.x, y: frame.y + off.y });
    if (nearbyDoor(g, a)?.id === door.id) return true;
  }
  return false;
}

function reachableDoor(
  g: Game,
  a: Actor,
  field: boolean,
): Furniture | undefined {
  for (const floor of g.floors) {
    a.floor = floor.index;
    for (const o of floor.furniture) {
      if (o.kind !== "door" || o.destroyed) continue;
      if (field !== Boolean(o.field)) continue;
      if (standBy(g, a, o)) return o;
    }
  }
  return undefined;
}

function escapeGame() {
  const g = createPlayableGame(31337, roadmap);
  g.status = "playing";
  g.zombies = [];
  g.escape = createEscapeState(g, { gender: "male", seed: 31337 });
  return g;
}

test("a hand-worked escape door releases and latches shut again", () => {
  const g = escapeGame();
  const a = g.survivors[0];
  const door = reachableDoor(g, a, false);
  assert.ok(door, "a plain door is within reach");
  assert.equal(door!.door?.latched, true);

  assert.equal(toggleDoor(g, a, door!.id), true);
  assert.equal(door!.door?.latched, false);
  assert.equal(door!.open, true);

  const before = g.events.filter((e) => e.type === "door").length;
  assert.equal(toggleDoor(g, a, door!.id), true);
  assert.equal(door!.door?.latched, true);
  assert.equal(door!.door?.swung, false);
  assert.equal(door!.open, false);
  const doorEvents = g.events.filter((e) => e.type === "door");
  assert.equal(doorEvents.length, before + 1);
  assert.equal(doorEvents.at(-1)!.text, `${a.name} closed a door.`);
  assert.equal(doorEvents.at(-1)!.floor, a.floor);
  assert.equal(a.noiseLevel, 8);
  assert.ok(a.noiseUntil! > g.time);
});

test("open true and open false only move the door the way they ask", () => {
  const g = escapeGame();
  const a = g.survivors[0];
  const door = reachableDoor(g, a, false);
  assert.ok(door);

  // Latched: closing is not an action.
  const events = g.events.length;
  assert.equal(toggleDoor(g, a, door!.id, false), false);
  assert.equal(door!.door?.latched, true);
  assert.equal(g.events.length, events);

  // Latched: opening is.
  assert.equal(toggleDoor(g, a, door!.id, true), true);
  assert.equal(door!.door?.latched, false);

  // Already open: opening again is not an action.
  assert.equal(toggleDoor(g, a, door!.id, true), false);
  assert.equal(door!.door?.latched, false);

  // Too far away: neither direction reaches the door.
  Object.assign(a, { x: door!.x + 12, y: door!.y + 12 });
  assert.equal(toggleDoor(g, a, door!.id, false), false);
  assert.equal(door!.door?.latched, false);
});

test("legacy games keep field doors and still refuse open false", () => {
  const g = createPlayableGame(31337, roadmap);
  g.status = "playing";
  g.zombies = [];
  assert.equal(g.escape, undefined, "this is a legacy game");
  const a = g.survivors[0];
  assert.ok(
    g.floors.some((f) => f.furniture.some((o) => o.kind === "door" && o.field)),
    "a legacy world is gated",
  );
  const door = reachableDoor(g, a, true);
  assert.ok(door, "a field door is within reach");
  assert.equal(door!.door, undefined);

  const events = g.events.length;
  assert.equal(toggleDoor(g, a, door!.id, false), false);
  assert.ok(door!.field, "the field survives the refused action");
  assert.equal(door!.door, undefined, "no hinge was created");
  assert.equal(door!.open, false);
  assert.equal(g.events.length, events);
});
