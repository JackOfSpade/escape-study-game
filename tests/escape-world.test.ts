import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createEscapeState } from "../src/escape-state";
import { openEscapeWorld } from "../src/escape-world";
import type { Game, Roadmap } from "../src/model";
import { createPlayableGame } from "../src/world";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);

function escapeGame(seed = 4242): Game {
  const g = createPlayableGame(seed, roadmap);
  g.escape = createEscapeState(g, { gender: "female", seed });
  return g;
}

test("an escape world has plain latched doors and no force fields", () => {
  const g = escapeGame();
  let doors = 0;
  for (const floor of g.floors)
    for (const o of floor.furniture) {
      const frame = o.door?.frame ?? o;
      assert.ok(frame.w > 0 && frame.h > 0);
      if (o.kind !== "door") continue;
      doors++;
      assert.equal(o.field, undefined, `${o.id} still has a field`);
      assert.ok(o.door, `${o.id} has no hinge`);
      assert.equal(o.door!.latched, true, `${o.id} is not latched`);
      assert.equal(o.door!.swung, false, `${o.id} is not shut`);
      assert.equal(o.open, false, `${o.id} is not closed`);
      assert.equal(o.lock, undefined, `${o.id} is locked`);
    }
  assert.ok(doors > 0, "the building still has doors");
  const gate = g.floors[0].furniture.find((o) => o.id === "main-gate");
  assert.ok(gate, "the main gate survived the conversion");
  assert.equal(gate!.kind, "door");
  assert.equal(gate!.field, undefined);
  assert.equal(gate!.door?.latched, true);
});

test("every survivor may use the stairs to every floor", () => {
  const g = escapeGame(99);
  const floors = g.floors.map((f) => f.index);
  assert.ok(floors.length > 1);
  for (const a of g.survivors) {
    assert.ok(a.access, `${a.id} has no access list`);
    for (const index of floors)
      assert.ok(
        a.access!.includes(index),
        `${a.id} cannot reach floor ${index}`,
      );
  }
});

test("a second openEscapeWorld call changes nothing", () => {
  const g = escapeGame(7);
  const before = JSON.parse(JSON.stringify(g)) as Game;
  openEscapeWorld(g);
  assert.deepEqual(JSON.parse(JSON.stringify(g)), before);
});
