import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { soundConnected } from "../src/acoustics";
import { step } from "../src/engine";
import { TestRunner } from "../src/gametest/runner";
import { emptyScenario } from "../src/gametest/schema";
import { distance, type Game, type Roadmap } from "../src/model";
import { survivorPath } from "../src/navigation";
import { floorCols, floorRows } from "../src/site";
import {
  beginFurnitureIndex,
  endFurnitureIndex,
  furnitureNear,
  solid,
} from "../src/spatial";
import { canSee } from "../src/visibility";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
/** Corridor row; world y is ROW + 0.5. */
const ROW = 16;
/** Room interior, north of the corridor: x 70..78 including its shell. */
const ROOM = { x1: 71, x2: 77, y1: ROW - 3, y2: ROW - 2 };
const DOORWAY = 74;
/** Sealed pocket further east, to prove sound and sight stop at a far wall. */
const POCKET = { x1: 82, x2: 86 };

function world() {
  const scenario = emptyScenario();
  scenario.entities = [
    { id: "human", kind: "player", x: 10, y: 12 },
    { id: "npc", kind: "npc", x: 20, y: 12 },
  ];
  const g = new TestRunner(scenario, roadmap).game;
  g.zombies = [];
  g.nextSpawn = Number.MAX_SAFE_INTEGER;
  return g;
}

/** Stamp a second 44-column raster onto the right of the legacy one and carve
 * a corridor, a room and a sealed pocket into it. */
function grow(g: Game) {
  const f = g.floors[0],
    cols = floorCols(f);
  for (const row of f.tiles) for (let x = 0; x < cols; x++) row.push(1);
  // A corridor reaches from inside the original area, through the old east
  // wall, out to x = 80: the wall spine at x = 81 stays solid.
  for (let x = 1; x <= 80; x++) f.tiles[ROW][x] = 0;
  for (let y = ROOM.y1; y <= ROOM.y2; y++)
    for (let x = ROOM.x1; x <= ROOM.x2; x++) f.tiles[y][x] = 0;
  f.tiles[ROW - 1][DOORWAY] = 0;
  for (let y = ROW - 1; y <= ROW + 1; y++)
    for (let x = POCKET.x1; x <= POCKET.x2; x++) f.tiles[y][x] = 0;
  // Props that predate the stamp must not block the new corridor.
  f.furniture = f.furniture.filter(
    (o) => o.x < 39 && Math.abs(o.y - (ROW + 0.5)) >= 1,
  );
  return f;
}

test("a grown floor's own raster carries solid walls, routing, sight and sound past x = 44", () => {
  const g = world(),
    f = g.floors[0];
  assert.equal(floorCols(f), 44);
  assert.equal(floorRows(f), 34);
  // Warm every floor-keyed cache at the legacy size before the raster grows.
  const warm = { x: 6.5, y: ROW + 0.5 },
    warmEnd = { x: 24.5, y: ROW + 0.5 };
  assert.ok(survivorPath(f, warm, warmEnd).length > 0, "legacy route");
  assert.equal(soundConnected(f, warm, warmEnd), true, "legacy acoustics");
  beginFurnitureIndex(g.floors);
  furnitureNear(f, warm, 0.22);
  endFurnitureIndex();
  step(g, 1 / 30);
  grow(g);
  assert.equal(floorCols(f), 88);
  assert.equal(floorRows(f), 34);

  // (1) Solid geometry follows the grown raster, not the module constants.
  const corridor = { x: 60.5, y: ROW + 0.5 },
    room = { x: 74.5, y: ROOM.y2 + 0.5 },
    farWall = { x: 60.5, y: ROW + 2.5 },
    spine = { x: 81.5, y: ROW + 0.5 },
    pocket = { x: 84.5, y: ROW + 0.5 };
  assert.equal(solid(f, corridor), false, "open corridor at x = 60");
  assert.equal(solid(f, room), false, "open floor in the far room");
  assert.equal(solid(f, pocket), false, "open floor in the far pocket");
  assert.equal(
    solid(f, farWall),
    true,
    "wall cell at x = 60 outside the corridor",
  );
  assert.equal(solid(f, spine), true, "wall spine at x = 81");
  // The step-scoped furniture buckets also rebuilt for the wider raster.
  beginFurnitureIndex(g.floors);
  try {
    assert.deepEqual(
      furnitureNear(f, pocket, 0.22),
      [],
      "no props in the far pocket",
    );
  } finally {
    endFurnitureIndex();
  }

  // (2) Routing walks out of the original area, along the corridor and through
  // the doorway; the straight line is blocked by the room's south wall.
  const start = { x: 41.5, y: ROW + 0.5 },
    end = { x: 74.5, y: ROOM.y2 + 0.5 };
  assert.ok(start.x < 44, "starts inside the original raster");
  const route = survivorPath(f, start, end);
  assert.ok(route.length > 0, "a route reaches the far room");
  assert.ok(
    distance(route[route.length - 1], end) < 1.2,
    "the route ends near the target",
  );
  assert.ok(
    route.some((p) => p.x > 44),
    "the route crosses beyond the legacy raster edge",
  );

  // (3) Sight runs along the open corridor and stops at a far wall.
  assert.equal(
    canSee(f, { x: 45.5, y: ROW + 0.5 }, { x: 79.5, y: ROW + 0.5 }, 100),
    true,
    "corridor sight reaches x = 79",
  );
  assert.equal(
    canSee(f, { x: 45.5, y: ROW + 0.5 }, room, 100),
    false,
    "the room's far wall blocks sight",
  );

  // (4) Acoustics use the grown raster: corridor and room are connected, the
  // sealed pocket beyond the spine is not.
  assert.equal(
    soundConnected(f, corridor, room),
    true,
    "corridor and far room share a space",
  );
  assert.equal(
    soundConnected(f, corridor, pocket),
    false,
    "a sealed far pocket is its own space",
  );
});

test("physics rebuilds the grown floor's wall fixtures past x = 44", () => {
  const g = world();
  step(g, 1 / 30); // build the physics layer for the 44 x 34 raster
  const f = grow(g),
    human = g.survivors.find((a) => a.id === "human") ?? g.survivors[0];
  assert.ok(human, "the test world has a controlled survivor");
  assert.equal(solid(f, { x: 60.5, y: ROW + 0.5 }), false);
  Object.assign(human, { x: 60.5, y: ROW + 0.5, floor: 0 });
  for (let i = 0; i < 400; i++) step(g, 1 / 30, { x: 1, y: 0, grab: false });
  assert.ok(human.x > 78, `the actor walks the far corridor (x = ${human.x})`);
  assert.ok(
    human.x < 81,
    `the far wall spine at x = 81 stops the actor (x = ${human.x})`,
  );
});
