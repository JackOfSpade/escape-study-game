import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { doorLeaves, doorStyle, presetDoorStyle } from "../src/door-style";
import { DOOR_LEAF, updateDoorLeaves } from "../src/force-fields";
import type { Furniture, Game, Roadmap } from "../src/model";
import {
  parseRunDesign,
  type RunDoorDesign,
} from "../src/run-design-contract.mjs";
import { blocksSight } from "../src/visibility";
import { createPlayableGame } from "../src/world";
import { runDesignFixture, savedRunDesign } from "./helpers/run-design";

const door = (extra: Partial<Furniture> = {}) =>
  ({
    id: "f0-room1-forward",
    floor: 0,
    kind: "door",
    x: 10,
    y: 10,
    w: 1,
    h: 3,
    hp: 900,
    maxHp: 900,
    destroyed: false,
    field: {
      authorized: [],
      crossing: [],
      sides: {},
      used: 0,
      exit: false,
    },
    ...extra,
  }) as Furniture;
const person = (x: number, velocity = 0) => ({
  id: "human",
  access: [],
  floor: 0,
  alive: true,
  x,
  y: 10,
  physics: { x: velocity, y: 0, angular: 0, awake: true },
});
const world = (o: Furniture, survivors: unknown[], zombies: unknown[] = []) =>
  ({
    floors: [{ index: 0, furniture: [o] }],
    survivors,
    zombies,
  }) as unknown as Game;

test("a door swings away from its opener, stays open, and closes only near a zombie", () => {
  const o = door(),
    a = person(9, 2),
    zombie = { hp: 100, floor: 0, x: 30, y: 10 },
    g = world(o, [a], [zombie]);
  updateDoorLeaves(g, DOOR_LEAF.openSeconds);
  assert.equal(o.field!.leaf?.open, 1);
  assert.equal(o.field!.leaf?.side, 1, "swings away from the opener");
  a.x = 14;
  for (let i = 0; i < 120; i++) updateDoorLeaves(g, 1 / 30);
  assert.equal(o.field!.leaf?.open, 1, "stays open with no zombie near");
  zombie.floor = 1;
  zombie.x = o.x;
  for (let i = 0; i < 60; i++) updateDoorLeaves(g, 1 / 30);
  assert.equal(o.field!.leaf?.open, 1, "a zombie on another floor is not near");
  zombie.floor = 0;
  zombie.hp = 0;
  for (let i = 0; i < 60; i++) updateDoorLeaves(g, 1 / 30);
  assert.equal(o.field!.leaf?.open, 1, "a dead zombie is not near");
  zombie.hp = 100;
  zombie.x = o.x + DOOR_LEAF.zombieRange;
  for (let i = 0; i < 60; i++) updateDoorLeaves(g, 1 / 30);
  assert.equal(o.field!.leaf, undefined, "closes and leaves no state");
});

test("a person in the doorway keeps it open even with a zombie near", () => {
  const o = door(),
    g = world(o, [person(10)], [{ hp: 100, floor: 0, x: 11, y: 10 }]);
  for (let i = 0; i < 60; i++) updateDoorLeaves(g, 1 / 30);
  assert.equal(o.field!.leaf?.open, 1);
});

test("standing still beside a door does not hold it open, standing in it does", () => {
  const beside = door();
  updateDoorLeaves(world(beside, [person(9)]), 0.1);
  assert.equal(beside.field!.leaf, undefined);
  const inside = door();
  updateDoorLeaves(world(inside, [person(10)]), 0.1);
  assert.ok(inside.field!.leaf);
});

test("a locked door does not open for someone without access", () => {
  const o = door();
  o.field!.limit = 0;
  o.field!.exit = true;
  updateDoorLeaves(world(o, [person(9, 2)]), 0.1);
  assert.equal(o.field!.leaf, undefined);
});

test("doors never change simulation sight, so zombies keep pressing them", () => {
  assert.equal(blocksSight(door()), false);
  assert.equal(
    blocksSight(
      door({
        field: { ...door().field!, leaf: { open: 1, side: 1, hold: 0 } },
      }),
    ),
    false,
  );
});

test("wide openings become hinged pairs covering the whole span", () => {
  assert.equal(doorLeaves(1.8).length, 1);
  const pair = doorLeaves(3);
  assert.equal(pair.length, 2);
  assert.deepEqual(
    pair.map((l) => l.extend),
    [1, -1],
  );
  assert.deepEqual(
    pair.map((l) => l.hinge),
    [-1.5, 1.5],
  );
  assert.equal(
    doorLeaves(6).reduce((n, l) => n + l.width, 0),
    6,
  );
});

test("undesigned doors look stable, and old saves still get a door", () => {
  assert.deepEqual(presetDoorStyle("a", 7), presetDoorStyle("a", 7));
  assert.ok(doorStyle({ id: "old-save-door" }).label);
  const looks = new Set(
    Array.from({ length: 40 }, (_, i) => presetDoorStyle(`door-${i}`, 1).label),
  );
  assert.ok(looks.size >= 4, "a building shows real variety");
});

const armored = {
  material: "security" as const,
  color: "#2f363d",
  accent: "#d9812f",
  window: "slit" as const,
  label: "Vault annex door",
  health: 2000,
} satisfies RunDoorDesign;
const fixture = () =>
  JSON.parse(
    readFileSync("tests/fixtures/run-designs/harbor-archive.json", "utf8"),
  );

test("a run design can restyle doors and set their health, and bad doors are rejected", () => {
  const good = fixture();
  good.mainDoor = armored;
  good.floors[0].doors = [armored, armored, armored, armored];
  assert.equal(parseRunDesign(good).mainDoor?.health, 2000);
  assert.ok(fixture().floors[0].doors === undefined, "doors stay optional");
  for (const change of [
    { material: "paper" },
    { color: "red" },
    { window: "porthole" },
    { label: "" },
    { health: 100 },
    { health: 2400.5 },
    { extra: true },
    { label: "Vault\nannex" },
  ]) {
    const bad = fixture();
    bad.mainDoor = { ...armored, ...change };
    assert.throws(() => parseRunDesign(bad), JSON.stringify(change));
  }
  const short = fixture();
  short.floors[0].doors = [armored];
  assert.throws(() => parseRunDesign(short));
});

test("a designed door reaches the world, and pacing can only raise the hall entrance", () => {
  const roadmap: Roadmap = JSON.parse(
    readFileSync("public/curriculum.json", "utf8"),
  );
  const design = runDesignFixture();
  const plain = createPlayableGame(
    7,
    roadmap,
    undefined,
    savedRunDesign(design),
  );
  const styled = structuredClone(design);
  styled.floors[1].doors = [0, 1, 2, 3].map(() => ({
    ...armored,
    health: 2400,
  })) as (typeof styled.floors)[1]["doors"];
  const game = createPlayableGame(
    7,
    roadmap,
    undefined,
    savedRunDesign(styled),
  );
  const hit = game.floors[1].furniture.filter((o) => o.field);
  assert.ok(hit.length > 0);
  for (const o of hit) assert.equal(o.doorStyle?.label, "Vault annex door");
  assert.ok(
    hit.filter((o) => !o.field!.publicEntry).every((o) => o.hp === 2400),
  );
  const entry = hit.find((o) => o.field!.publicEntry)!;
  assert.ok(
    entry.hp >= 2400,
    "hall entrance keeps at least its designed health",
  );
  const before = plain.floors[0].furniture.filter((o) => o.field);
  assert.ok(
    before.every((o) => o.doorStyle),
    "undesigned doors get a stored look",
  );
});

test("each designed door lands on its own room's exit, and the main door on the gate", () => {
  const roadmap: Roadmap = JSON.parse(
    readFileSync("public/curriculum.json", "utf8"),
  );
  const styled = structuredClone(runDesignFixture());
  styled.mainDoor = { ...armored, label: "Main doors", health: 2200 };
  styled.floors[1].doors = [0, 1, 2, 3].map((room) => ({
    ...armored,
    label: `Exit of room ${room}`,
    health: 1000 + room * 100,
  })) as (typeof styled.floors)[1]["doors"];
  const game = createPlayableGame(
    7,
    roadmap,
    undefined,
    savedRunDesign(styled),
  );
  const main = game.floors[0].furniture.find((o) => o.id === "main-gate")!;
  assert.equal(main.doorStyle?.label, "Main doors");
  assert.equal(main.maxHp, 2200);
  for (const room of [0, 1, 2, 3]) {
    const exit = game.floors[1].furniture.find(
      (o) => o.id === `f1-room${room}-forward`,
    )!;
    assert.equal(exit.doorStyle?.label, `Exit of room ${room}`);
    assert.equal(exit.maxHp, 1000 + room * 100);
  }
  assert.equal(
    game.floors[1].furniture.find((o) => o.id === "f1-room2-door")?.doorStyle
      ?.label,
    "Exit of room 2",
  );
});
