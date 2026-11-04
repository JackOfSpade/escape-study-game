import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  claimStation,
  human,
  takeLoot,
  toggleDoor,
  toggleGrip,
} from "../src/engine";
import { TestRunner } from "../src/gametest/runner";
import { emptyScenario } from "../src/gametest/schema";
import type { Actor, Furniture, Roadmap } from "../src/model";
import { interactionPrompt } from "../src/view3d/hud";
import {
  accessDoorPrompt,
  lookTarget,
  lootSlot,
  rayFootprintDistance,
  targetFootprint,
} from "../src/view3d/targeting";
import { createGame } from "../src/world";

const origin = { x: 0, y: 0 };
test("an access door's prompt says what E does, never asks to check it", () => {
  const door = {
    id: "d",
    field: { authorized: [], crossing: [], sides: {}, used: 0, exit: true },
  } as unknown as Furniture;
  const a = { id: "human", access: [], keys: 0 } as unknown as Actor;
  assert.match(accessDoorPrompt(door, a), /^Locked/);
  a.keys = 1;
  assert.equal(accessDoorPrompt(door, a), "E · Use key to open door");
  door.field!.authorized.push("human");
  assert.equal(accessDoorPrompt(door, a), "E · Open door");
  door.field!.leaf = { open: 1, side: 1, hold: 1 };
  assert.equal(accessDoorPrompt(door, a), "");
});

test("targeting ray intersects oriented footprints in metres, including parallel, inside and grazing rays", () => {
  const box = { x: 2, y: 0, w: 1, h: 1 };
  assert.equal(rayFootprintDistance(origin, 10, 0, box), 1.5);
  assert.equal(rayFootprintDistance(origin, -1, 0, box), Infinity);
  assert.equal(rayFootprintDistance({ x: 0, y: 0.5 }, 1, 0, box), 1.5);
  assert.equal(rayFootprintDistance({ x: 0, y: 0.501 }, 1, 0, box), Infinity);
  assert.equal(rayFootprintDistance({ x: 2, y: 0 }, 1, 0, box), 0);
  assert.equal(rayFootprintDistance(origin, 0, 0, box), Infinity);
  assert.equal(rayFootprintDistance(origin, NaN, 1, box), Infinity);
  const rotated = { x: 2, y: 0, w: 2, h: 0.2, angle: Math.PI / 2 };
  assert.ok(
    Math.abs(rayFootprintDistance(origin, 1, 0, rotated) - 1.9) < 1e-10,
  );
});
test("crosshair chooses the first ray hit within that object's normal reach and behind no obstruction", () => {
  const candidates = [
    {
      footprint: { x: 0.4, y: 0.8, w: 0.2, h: 0.2 },
      reach: 2,
      value: "nearest-off-axis",
    },
    { footprint: { x: 1.5, y: 0, w: 0.2, h: 0.2 }, reach: 2, value: "aimed" },
    { footprint: { x: 1.9, y: 0, w: 0.2, h: 0.2 }, reach: 2, value: "behind" },
  ];
  assert.equal(targetFootprint(origin, 0, candidates), "aimed");
  assert.equal(targetFootprint(origin, Math.PI, candidates), undefined);
  assert.equal(targetFootprint(origin, 0, candidates, 1), undefined);
  assert.equal(
    targetFootprint(origin, 0, [{ ...candidates[1], reach: 1.3 }]),
    undefined,
  );
  assert.equal(
    targetFootprint(origin, Math.atan2(0.8, 0.4), candidates),
    "nearest-off-axis",
  );
});
test("crosshair priority considers only reachable ray hits and keeps nearest order within a kind", () => {
  const candidates = [
    {
      footprint: { x: 0.5, y: 0, w: 0.2, h: 0.2 },
      reach: 2,
      priority: 1,
      value: "grip",
    },
    {
      footprint: { x: 1.6, y: 0, w: 0.2, h: 0.2 },
      reach: 2,
      priority: 3,
      value: "far-station",
    },
    {
      footprint: { x: 1.2, y: 0, w: 0.2, h: 0.2 },
      reach: 2,
      priority: 3,
      value: "near-station",
    },
    {
      footprint: { x: 2.3, y: 0, w: 0.2, h: 0.2 },
      reach: 2,
      priority: 4,
      value: "out-of-reach-item",
    },
    {
      footprint: { x: 0.4, y: 0.8, w: 0.2, h: 0.2 },
      reach: 2,
      priority: 4,
      value: "off-axis-item",
    },
  ];
  assert.equal(targetFootprint(origin, 0, candidates), "near-station");
  assert.equal(targetFootprint(origin, 0, candidates, 1), "grip");
});
const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
function fixture() {
  const scenario = emptyScenario();
  scenario.entities = [
    { id: "human", kind: "player", x: 12, y: 12 },
    { id: "near-chair", kind: "chair", x: 12, y: 12.7 },
    { id: "aimed-desk", kind: "desk", x: 13.5, y: 12 },
  ];
  return new TestRunner(scenario, roadmap).game;
}
test("aiming selects and grips a different reachable prop from nearest fallback; prompt names the same prop", () => {
  const game = fixture(),
    a = human(game);
  const target = lookTarget(game, 0);
  assert.equal(target?.kind, "grip");
  assert.equal(target && "object" in target && target.object.id, "aimed-desk");
  assert.equal(interactionPrompt(game), "E · Grip chair");
  assert.equal(interactionPrompt(game, 0), "E · Grip desk");
  assert.equal(
    toggleGrip(
      game,
      a,
      target && "object" in target ? target.object.id : "missing",
    ),
    true,
  );
  assert.equal(a.grip?.object, "aimed-desk");
});
test("look targeting obeys real furniture reach and walls, with nearest prompt fallback on a miss", () => {
  const game = fixture(),
    f = game.floors[0];
  f.furniture[1].x = 15;
  assert.equal(lookTarget(game, 0), undefined);
  assert.equal(interactionPrompt(game, 0), "E · Grip chair");
  assert.equal(interactionPrompt(game, 0), interactionPrompt(game));
  f.tiles[12][13] = 1;
  assert.equal(lookTarget(game, 0), undefined);
});
test("terminal crosshair selection wins over nearer off-axis cover, and loot requires existing collection permission", () => {
  const game = fixture(),
    f = game.floors[0],
    a = human(game),
    e = Object.values(createGame(1, roadmap).encounters)[0];
  game.encounters[e.id] = e;
  f.furniture = [f.furniture[0]];
  f.stations = [{ id: "aimed-terminal", encounter: e.id, x: 13.4, y: 12 }];
  assert.equal(lookTarget(game, 0)?.kind, "station");
  assert.equal(interactionPrompt(game, 0), "E · Open terminal");
  e.state = "consumed";
  e.reward = "loot";
  e.loot = [{ id: "aimed-kit", kind: "medkit", weight: 1, charges: 1 }];
  e.contributors = [a.id];
  const slot = lootSlot(f.stations[0], 0, { x: 0, y: 0 });
  const yaw = Math.atan2(slot.y - a.y, slot.x - a.x);
  assert.equal(lookTarget(game, yaw)?.kind, "item");
  assert.equal(interactionPrompt(game, yaw), "E · Take medkit");
  e.contributors = [];
  assert.equal(lookTarget(game, yaw), undefined);
});

function terminalOnDesk() {
  const scenario = emptyScenario();
  scenario.entities = [
    { id: "human", kind: "player", x: 12, y: 12 },
    { id: "terminal-desk", kind: "desk", x: 13.45, y: 12 },
  ];
  const runner = new TestRunner(scenario, roadmap),
    game = runner.game,
    encounter = Object.values(createGame(1, roadmap).encounters)[0];
  game.encounters[encounter.id] = encounter;
  game.floors[0].stations = [
    { id: "desk-terminal", encounter: encounter.id, x: 13.4, y: 12 },
  ];
  return { runner, game, encounter };
}

test("a terminal on a nearer grippable desk wins the ray and presents its real study prompt", () => {
  const { game } = terminalOnDesk();
  const target = lookTarget(game, 0);
  assert.equal(target?.kind, "station");
  assert.equal(interactionPrompt(game, 0), "E · Open terminal");
  assert.ok(
    target?.kind === "station" &&
      claimStation(game, human(game), target.station.id),
  );
  assert.equal(human(game).station, "desk-terminal");
  assert.equal(human(game).grip, undefined);
});

test("contributed loot on a desk wins the ray over the desk footprint", () => {
  const { game, encounter } = terminalOnDesk();
  encounter.state = "consumed";
  encounter.reward = "loot";
  encounter.loot = [{ id: "desk-loot", kind: "medkit", weight: 1, charges: 1 }];
  encounter.contributors = [human(game).id];
  const slot = lootSlot(game.floors[0].stations[0], 0, { x: 0, y: 0 }),
    a = human(game),
    yaw = Math.atan2(slot.y - a.y, slot.x - a.x),
    target = lookTarget(game, yaw);
  assert.equal(target?.kind, "item");
  assert.equal(target?.kind === "item" && target.item.id, "desk-loot");
  assert.equal(interactionPrompt(game, yaw), "E · Take medkit");
  assert.ok(
    target?.kind === "item" &&
      takeLoot(game, human(game), target.encounter, target.item.id),
  );
  assert.equal(encounter.loot.length, 0);
  assert.ok(human(game).inventory.some((item) => item.id === "desk-loot"));
});

test("a door behind a grippable chair wins the ray, while a wall still blocks the door", () => {
  const scenario = emptyScenario();
  scenario.entities = [
    { id: "human", kind: "player", x: 12, y: 12 },
    { id: "front-chair", kind: "chair", x: 12.75, y: 12 },
    { id: "aimed-door", kind: "door", x: 13.6, y: 12, w: 0.12, h: 1.3 },
  ];
  const game = new TestRunner(scenario, roadmap).game;
  let target = lookTarget(game, 0);
  assert.equal(target?.kind, "door");
  assert.equal(target && "object" in target && target.object.id, "aimed-door");
  assert.equal(interactionPrompt(game, 0), "E · Release door latch");
  assert.ok(
    target?.kind === "door" && toggleDoor(game, human(game), target.object.id),
  );
  assert.equal(game.floors[0].furniture[1].door?.latched, false);
  game.floors[0].tiles[12][13] = 1;
  target = lookTarget(game, 0);
  assert.equal(target?.kind, "grip");
  assert.equal(target && "object" in target && target.object.id, "front-chair");
});

test("a wall blocks a terminal and its loot even when they have higher ray priority", () => {
  const { game, encounter } = terminalOnDesk();
  game.floors[0].tiles[12][13] = 1;
  assert.notEqual(lookTarget(game, 0)?.kind, "station");
  encounter.state = "consumed";
  encounter.reward = "loot";
  encounter.loot = [
    { id: "hidden-loot", kind: "medkit", weight: 1, charges: 1 },
  ];
  encounter.contributors = [human(game).id];
  const slot = lootSlot(game.floors[0].stations[0], 0, { x: 0, y: 0 }),
    a = human(game);
  assert.notEqual(
    lookTarget(game, Math.atan2(slot.y - a.y, slot.x - a.x))?.kind,
    "item",
  );
});
