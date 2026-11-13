import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CONFIG,
  HELIPAD,
  HELIPAD_RADIUS,
  type Game,
  type Roadmap,
} from "../src/model";
import {
  parseRunDesign,
  parseRunStructure,
} from "../src/run-design-contract.mjs";
import { extractionPoints } from "../src/site";
import { nextSiteOrigin, stampSite } from "../src/site-stamp";
import { createPlayableGame, structureGame } from "../src/world";
import { environmentDesignFixture } from "./helpers/environment-design";
import { savedRunDesign } from "./helpers/run-design";

const roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
) as Roadmap;

function openMarket(): Game {
  const design = parseRunDesign(
    JSON.parse(
      readFileSync("tests/fixtures/run-designs/open-market.json", "utf8"),
    ),
  );
  return createPlayableGame(42, roadmap, undefined, savedRunDesign(design));
}

function startGame(): Game {
  return createPlayableGame(
    42,
    roadmap,
    undefined,
    savedRunDesign(environmentDesignFixture("harbor-inscriptions")),
  );
}

/** radio-broadcast without its physical city inventory: a structural proposal. */
function enclosedSource(): Game {
  const design = parseRunDesign(
    JSON.parse(
      readFileSync("tests/fixtures/run-designs/radio-broadcast.json", "utf8"),
    ),
  ) as unknown as Record<string, unknown> & { environment?: unknown };
  const { environment: _environment, ...structure } = design;
  return structureGame(7, roadmap, undefined, parseRunStructure(structure));
}

const ids = (site: string, g: Game, floor: number) =>
  g.floors[floor].furniture
    .filter((o) => o.site === site)
    .map((o) => o.id)
    .sort();

test("an open area stamps as a ground-only site with its own pickup", () => {
  const g = startGame();
  const source = openMarket();
  const origin = nextSiteOrigin(g);
  const before = g.floors.slice(1).map((f) => f.furniture.length);
  const site = stampSite(g, source, {
    id: "market",
    name: "Open market",
    origin,
  });
  assert.deepEqual(
    g.floors.slice(1).map((f) => f.furniture.length),
    before,
    "the shared upper storeys gain nothing from an open site",
  );

  assert.deepEqual(site.floors, [0]);
  assert.deepEqual(Object.keys(site.stairs), ["0"]);
  assert.deepEqual(Object.keys(site.entry), ["0"]);
  assert.deepEqual(site.stairs[0], {
    x: source.floors[0].stairs.x + origin.x,
    y: source.floors[0].stairs.y + origin.y,
  });
  // Exactly the ground floor's furniture and stations, under the site prefix.
  assert.deepEqual(
    ids("market", g, 0),
    source.floors[0].furniture.map((o) => `market:${o.id}`).sort(),
  );
  assert.deepEqual(
    (g.floors[0].stations ?? [])
      .filter((s) => s.site === "market")
      .map((s) => s.id)
      .sort(),
    (source.floors[0].stations ?? []).map((s) => `market:${s.id}`).sort(),
  );
  // No upper storey and no stair marker above the ground pad.
  for (let index = 1; index <= CONFIG.floors; index++) {
    assert.deepEqual(
      g.floors[index].furniture.filter((o) => o.site === "market"),
      [],
      `no stamped furniture on floor ${index}`,
    );
    assert.ok(
      !(g.floors[index].shells ?? []).some((s) => s.site === "market"),
      `no stamped shell on floor ${index}`,
    );
  }
  assert.deepEqual(
    g.floors.map((f) => f.furniture.some((o) => o.site === "market")),
    [true, false, false, false, false],
  );

  const extraction = site.extraction;
  assert.ok(extraction, "the stamped open site keeps its ground pickup");
  assert.equal(extraction.floor, 0);
  const x = Math.floor(extraction.x),
    y = Math.floor(extraction.y);
  const left = Math.min(
    ...site.boundary.rows.filter(Boolean).map((r) => r!.left),
  );
  const right = Math.max(
    ...site.boundary.rows.filter(Boolean).map((r) => r!.right),
  );
  assert.ok(
    x >= left && x <= right && y >= origin.y && y <= site.boundary.bottom,
    `the pickup ${x},${y} sits inside the site's world footprint`,
  );
  assert.equal(
    g.floors[0].tiles[y][x],
    0,
    "the pickup stands on walkable ground",
  );
  assert.deepEqual(
    g.sites?.map((s) => s.id),
    ["market"],
    "the open site is registered in the shared world",
  );

  assert.deepEqual(extractionPoints(g), [
    {
      floor: CONFIG.floors,
      x: HELIPAD.x,
      y: HELIPAD.y,
      radius: HELIPAD_RADIUS,
    },
    { ...extraction, site: "market" },
  ]);
});

test("an enclosed area still stamps every storey it has", () => {
  const g = startGame();
  const source = enclosedSource();
  const origin = nextSiteOrigin(g);
  const site = stampSite(g, source, { id: "station", name: "Station", origin });
  assert.deepEqual(site.floors, [0, 1, 2, 3, 4]);
  assert.equal(site.extraction, undefined);
  assert.deepEqual(
    Object.keys(site.stairs)
      .map(Number)
      .sort((a, b) => a - b),
    source.floors.filter((f) => f.stairs).map((f) => f.index),
  );
  for (const index of [0, 1, 2, 3, 4]) {
    assert.deepEqual(
      ids("station", g, index),
      source.floors[index].furniture.map((o) => `station:${o.id}`).sort(),
      `stamped storey ${index}`,
    );
  }
  assert.deepEqual(extractionPoints(g), [
    {
      floor: CONFIG.floors,
      x: HELIPAD.x,
      y: HELIPAD.y,
      radius: HELIPAD_RADIUS,
    },
  ]);
});
