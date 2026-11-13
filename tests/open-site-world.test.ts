import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildingLayoutErrors } from "../src/building-layout";
import {
  CONFIG,
  HELIPAD,
  HELIPAD_RADIUS,
  H,
  W,
  type Game,
  type Roadmap,
} from "../src/model";
import { pursuitLayoutErrors, zeroKeyTerminals } from "../src/pursuit-layout";
import {
  parseRunDesign,
  parseRunStructure,
} from "../src/run-design-contract.mjs";
import { extractionPoints } from "../src/site";
import { advanceStairs, beginStairs } from "../src/stair-travel";
import { createPlayableGame, structureGame } from "../src/world";

const roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
) as Roadmap;

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

/** The enclosed control: everything radio-broadcast says except the physical
 * city inventory, which a structural proposal does not carry. */
function radioBroadcast(): Game {
  const { environment: _environment, ...structure } = parseRunDesign(
    JSON.parse(
      readFileSync("tests/fixtures/run-designs/radio-broadcast.json", "utf8"),
    ),
  ) as any;
  return structureGame(42, roadmap, undefined, parseRunStructure(structure));
}

test("an open market builds one ground plan over solid upper layers", () => {
  const g = openMarket();
  assert.equal(g.floors.length, CONFIG.floors + 1);
  const ground = g.floors[0];
  assert.equal(ground.open, true);
  assert.ok(ground.stations.length > 0);
  assert.ok(ground.furniture.length > 0);
  const blueprint = parseRunStructure(
    JSON.parse(
      readFileSync(
        "tests/fixtures/run-designs/open-market-structure.json",
        "utf8",
      ),
    ),
  );
  assert.equal(ground.name, blueprint.floors[0].name);
  for (let index = 1; index <= CONFIG.floors; index++) {
    const floor = g.floors[index];
    assert.equal(floor.open, true);
    assert.deepEqual(floor.stations, []);
    assert.deepEqual(floor.furniture, []);
    assert.deepEqual(floor.rooms, []);
    assert.deepEqual(floor.doors, []);
    assert.equal(floor.boundary, undefined);
    assert.equal(floor.generation, undefined);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        assert.equal(
          floor.tiles[y][x],
          1,
          `open layer ${index} tile ${x},${y}`,
        );
  }
  assert.equal(g.floors[CONFIG.floors].name, blueprint.roofName);
});

test("the extraction pad is the ground stair marker on walkable tiles", () => {
  const g = openMarket();
  const ground = g.floors[0];
  const pad = g.extraction;
  assert.ok(pad, "an open site has an extraction point");
  assert.equal(pad!.floor, 0);
  assert.equal(pad!.x, ground.stairs.x);
  assert.equal(pad!.y, ground.stairs.y);
  assert.ok(pad!.radius >= 1.2 && pad!.radius <= 2.2);
  assert.deepEqual(extractionPoints(g), [pad]);
  let covered = 0;
  for (
    let y = Math.floor(pad!.y - pad!.radius);
    y <= Math.ceil(pad!.y + pad!.radius);
    y++
  )
    for (
      let x = Math.floor(pad!.x - pad!.radius);
      x <= Math.ceil(pad!.x + pad!.radius);
      x++
    )
      if (Math.hypot(x + 0.5 - pad!.x, y + 0.5 - pad!.y) <= pad!.radius) {
        covered++;
        assert.equal(
          ground.tiles[y]?.[x],
          0,
          `pad covers solid tile ${x},${y}`,
        );
      }
  assert.ok(covered >= 4, "the pad covers some ground");
});

test("the open ground plan passes the same validators redesign runs", () => {
  const g = openMarket();
  assert.deepEqual(pursuitLayoutErrors(g, g.floors[0]), []);
  assert.deepEqual(buildingLayoutErrors(g), []);
  assert.ok(
    zeroKeyTerminals(g.floors[0]) >= g.survivors.length,
    "zero-key terminal capacity covers every survivor",
  );
});

test("stair travel never lifts anyone off an open site's ground floor", () => {
  const g = openMarket();
  const a = g.survivors[0];
  a.floor = 0;
  a.x = g.extraction!.x;
  a.y = g.extraction!.y;
  assert.equal(beginStairs(g, a), false);
  assert.equal(beginStairs(g, a, true), false);
  for (let tick = 0; tick < 600; tick++) {
    assert.equal(advanceStairs(g, a), false);
    assert.equal(a.floor, 0);
    assert.equal(g.floors[a.floor].open, true);
  }
});

test("an enclosed designed building is untouched by open-site construction", () => {
  const g = radioBroadcast();
  assert.equal(g.floors.length, CONFIG.floors + 1);
  for (const floor of g.floors) assert.equal(floor.open, undefined);
  for (let index = 1; index < CONFIG.floors; index++)
    assert.ok(g.floors[index].stations.length > 0, `floor ${index} stations`);
  assert.equal(g.extraction, undefined);
  const points = extractionPoints(g);
  assert.equal(points.length, 1);
  assert.deepEqual(points[0], {
    floor: CONFIG.floors,
    x: HELIPAD.x,
    y: HELIPAD.y,
    radius: HELIPAD_RADIUS,
  });
  assert.deepEqual(pursuitLayoutErrors(g, g.floors[1]), []);
});

test("an open game's form and pickup survive a plain save round-trip", () => {
  const g = openMarket();
  // The checked-in save envelope needs a complete accepted environment design,
  // which a structure preview does not carry yet; see finish concerns.
  const back = JSON.parse(JSON.stringify(g)) as Game;
  assert.equal(back.floors.length, g.floors.length);
  for (const floor of back.floors) assert.equal(floor.open, true);
  assert.deepEqual(back.extraction, g.extraction);
  assert.deepEqual(extractionPoints(back), [g.extraction]);
  assert.deepEqual(pursuitLayoutErrors(back, back.floors[0]), []);
  // The enclosed control builder still makes no pickup and no open floor.
  const enclosed = createPlayableGame(42, roadmap);
  assert.equal(enclosed.extraction, undefined);
  assert.equal(enclosed.floors[0].open, undefined);
});
