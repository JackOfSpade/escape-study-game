import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  board,
  canBoard,
  primaryExtraction,
  step,
  type Input,
} from "../src/engine";
import {
  CONFIG,
  HELIPAD,
  type Actor,
  type Game,
  type Roadmap,
} from "../src/model";
import {
  parseRunDesign,
  parseRunStructure,
} from "../src/run-design-contract.mjs";
import { extractionPoints } from "../src/site";
import { createPlayableGame, structureGame } from "../src/world";

const roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
) as Roadmap;
const idle: Input = { x: 0, y: 0, grab: false };

function openMarket(): Game {
  return structureGame(
    42,
    roadmap,
    undefined,
    parseRunStructure(
      JSON.parse(
        readFileSync(
          "tests/fixtures/run-designs/open-market-structure.json",
          "utf8",
        ),
      ),
    ),
  );
}

/** The enclosed control: every design field radio-broadcast carries except the
 * physical city inventory, which a structural proposal does not. */
function radioBroadcast(): Game {
  const { environment: _environment, ...structure } = parseRunDesign(
    JSON.parse(
      readFileSync("tests/fixtures/run-designs/radio-broadcast.json", "utf8"),
    ),
  ) as any;
  return structureGame(42, roadmap, undefined, parseRunStructure(structure));
}

function survivor(g: Game, skip: string[] = []): Actor {
  const a = g.survivors.find((s) => !skip.includes(s.id));
  assert.ok(a, "the run has a survivor to test");
  return a;
}

/** Open a long boarding window on the pickup that is already scheduled. */
function openWindow(g: Game) {
  g.helicopter.passengers = [];
  g.helicopter.until = g.time + 600;
}

test("an open site boards only on its ground pad", () => {
  const g = openMarket();
  const pad = primaryExtraction(g);
  assert.deepEqual(extractionPoints(g), [g.extraction]);
  assert.equal(pad.floor, 0);
  assert.equal(pad.x, g.floors[0].stairs.x);
  assert.equal(pad.y, g.floors[0].stairs.y);
  assert.ok(pad.radius > 0);
  const a = survivor(g);
  openWindow(g);
  a.floor = 0;
  a.x = pad.x;
  a.y = pad.y;
  assert.equal(canBoard(g, a), true, "standing on the pad during a window");
  // On the pad's floor but outside its radius.
  a.x = pad.x + pad.radius + 0.5;
  assert.equal(canBoard(g, a), false, "outside the pad radius");
  // Directly over the pad on one of the solid layers.
  a.x = pad.x;
  a.floor = 1;
  assert.equal(canBoard(g, a), false, "on a floor above the ground pad");
  // Inside the pad with no window open.
  a.floor = 0;
  g.helicopter.until = g.time - 1;
  assert.equal(canBoard(g, a), false, "no boarding window");
  assert.equal(board(g, a), false, "no boarding without a window");
  openWindow(g);
  const rescued = g.stats.rescued;
  assert.equal(board(g, a), true, "boarding on the ground pad");
  assert.equal(a.escaped, true);
  assert.equal(g.stats.rescued, rescued + 1);
  assert.ok(g.helicopter.passengers.includes(a.id));
});

test("an enclosed building still boards only on its roof helipad", () => {
  const g = radioBroadcast();
  const pad = primaryExtraction(g);
  assert.equal(g.extraction, undefined);
  assert.deepEqual(extractionPoints(g), [
    { floor: CONFIG.floors, x: HELIPAD.x, y: HELIPAD.y, radius: pad.radius },
  ]);
  const a = survivor(g);
  openWindow(g);
  a.floor = CONFIG.floors;
  a.x = HELIPAD.x;
  a.y = HELIPAD.y;
  assert.equal(canBoard(g, a), true, "standing on the roof helipad");
  assert.equal(board(g, a), true, "boarding on the roof helipad");
  assert.equal(a.escaped, true);
  // The ground staircase marker is a way up, never a pickup.
  const b = survivor(g, [a.id]);
  b.floor = 0;
  b.x = g.floors[0].stairs.x;
  b.y = g.floors[0].stairs.y;
  assert.equal(canBoard(g, b), false, "the ground stairs never board");
  assert.equal(board(g, b), false, "the ground stairs never board");
  // Directly under the helipad one floor down is still not the pickup.
  b.floor = CONFIG.floors - 1;
  b.x = HELIPAD.x;
  b.y = HELIPAD.y;
  assert.equal(canBoard(g, b), false, "a floor below the roof helipad");
});

test("open-site survivors walk to the ground pad, board there and never climb", () => {
  const g = openMarket();
  g.status = "playing";
  const pad = primaryExtraction(g);
  const a = survivor(g, ["human"]);
  openWindow(g);
  // A credential that would send an enclosed survivor up the stairs instead
  // sends an open-site survivor to the ground pad.
  a.floor = 0;
  a.x = pad.x + pad.radius + 4;
  a.y = pad.y;
  a.access = [0];
  a.alive = true;
  a.hp = 100;
  a.escaped = false;
  let boarded = -1;
  for (let tick = 0; tick < 900 && boarded < 0; tick++) {
    step(g, 1 / 30, idle);
    for (const actor of g.survivors)
      assert.equal(
        actor.floor,
        0,
        `${actor.id} stays on the open site's ground`,
      );
    for (const z of g.zombies)
      assert.equal(z.floor, 0, `${z.id} stays on the open site's ground`);
    if (a.escaped) boarded = tick;
  }
  assert.ok(boarded >= 0, "the survivor boards within the bounded window");
  assert.ok(
    Math.hypot(a.x - pad.x, a.y - pad.y) <= pad.radius + 0.75,
    `boarded at the ground pad (${a.x.toFixed(1)}, ${a.y.toFixed(1)})`,
  );
  assert.ok(g.helicopter.passengers.includes(a.id));
  assert.ok(
    g.events.some((e) => e.type === "board" && e.actor === a.id),
    "the boarding is reported at the ground pad",
  );
});

test("an enclosed survivor is never redirected to an open site's pad", () => {
  const g = createPlayableGame(42, roadmap);
  assert.equal(g.extraction, undefined);
  const pad = primaryExtraction(g);
  assert.equal(pad.floor, CONFIG.floors);
  assert.equal(pad.x, HELIPAD.x);
  assert.equal(pad.y, HELIPAD.y);
  // Every storey keeps its own interior: nothing was turned into an open layer.
  for (const floor of g.floors) assert.equal(floor.open, undefined);
});
