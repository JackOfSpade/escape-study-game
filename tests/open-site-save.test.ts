import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fnv1a } from "../src/hash";
import { CONFIG, type Game, type Roadmap } from "../src/model";
import { decode, encode } from "../src/persistence";
import { parseRunDesign, type RunDesign } from "../src/run-design-contract.mjs";
import { extractionPoints } from "../src/site";
import { createPlayableGame } from "../src/world";
import { environmentDesignFixture } from "./helpers/environment-design";
import { savedRunDesign } from "./helpers/run-design";

const roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
) as Roadmap;

function openDesign(): RunDesign {
  const design = parseRunDesign(
    JSON.parse(
      readFileSync("tests/fixtures/run-designs/open-market.json", "utf8"),
    ),
  );
  if (design.version !== 3 || design.setting?.form !== "open")
    throw Error("Expected the complete open-market fixture");
  return design;
}

function openGame(): Game {
  return createPlayableGame(
    42,
    roadmap,
    undefined,
    savedRunDesign(openDesign()),
  );
}

/** The stored envelope decode() expects, for saves written by hand. */
function envelope(game: unknown) {
  const payload = JSON.stringify(game);
  return JSON.stringify({ schema: 1, payload, checksum: fnv1a(payload) });
}

const actorState = (g: Game) =>
  g.survivors.map((a) => ({
    id: a.id,
    floor: a.floor,
    x: a.x,
    y: a.y,
    hp: a.hp,
    keys: a.keys ?? 0,
    activity: a.activity ?? "exploring",
    routeProgress: a.routeProgress ?? null,
  }));

test("an open game round-trips through the real save path", () => {
  const g = openGame();
  const ground = g.floors[0];
  assert.equal(ground.open, true);
  assert.ok(g.extraction, "an open start site has a ground pickup");
  assert.equal(extractionPoints(g).length, 1);

  const human = g.survivors[0];
  assert.equal(human.id, "human");
  human.keys = 2;
  human.routeProgress = { x: human.x, y: human.y, best: 4.25, at: 33 };

  const again = decode(encode(g));
  assert.deepEqual(
    again.floors.map((f) => f.open),
    g.floors.map(() => true),
  );
  assert.equal(again.floors.length, CONFIG.floors + 1);
  for (const floor of again.floors)
    if (floor.index > 0)
      assert.deepEqual(floor.furniture, [], `solid layer ${floor.index}`);
  assert.deepEqual(again.extraction, g.extraction);
  assert.deepEqual(extractionPoints(again), extractionPoints(g));
  assert.deepEqual(actorState(again), actorState(g));
  assert.deepEqual(again.survivors[0].routeProgress, human.routeProgress);
  assert.deepEqual(again.design, g.design);
});

test("an enclosed fixture game still round-trips identically", () => {
  const g = createPlayableGame(
    42,
    roadmap,
    undefined,
    savedRunDesign(environmentDesignFixture("harbor-inscriptions")),
  );
  assert.equal(g.extraction, undefined);
  const again = decode(encode(g));
  const shape = (game: Game) => ({
    extraction: game.extraction ?? null,
    floors: game.floors.map((f) => ({
      index: f.index,
      open: f.open ?? null,
      design: f.design?.name ?? null,
      exterior: f.exteriorDesign?.buildingName ?? null,
      environment: f.environment?.surfaces.length ?? null,
      tutorial: f.furniture.map((o) => [o.id, o.x, o.y, o.kind]),
      stations: (f.stations ?? []).map((s) => [s.id, s.x, s.y]),
      stairs: f.stairs,
      entry: f.entry,
    })),
    actors: actorState(game),
  });
  assert.deepEqual(shape(again), shape(g));
});

test("an old save without the open fields decodes them as undefined", () => {
  const g = createPlayableGame(
    42,
    roadmap,
    undefined,
    savedRunDesign(environmentDesignFixture("harbor-inscriptions")),
  );
  const raw = JSON.parse(JSON.parse(encode(g)).payload) as Game & {
    extraction?: unknown;
  };
  for (const floor of raw.floors) delete floor.open;
  delete raw.extraction;
  const again = decode(envelope(raw));
  assert.ok(again.floors.every((f) => f.open === undefined));
  assert.equal(again.extraction, undefined);
  assert.deepEqual(
    again.floors.map((f) => f.furniture.length),
    g.floors.map((f) => f.furniture.length),
  );
  assert.deepEqual(extractionPoints(again), extractionPoints(g));
});

test("an open save written before the optional fields regains both", () => {
  const g = openGame();
  const raw = JSON.parse(JSON.parse(encode(g)).payload) as Game & {
    extraction?: unknown;
  };
  for (const floor of raw.floors) delete floor.open;
  delete raw.extraction;
  const again = decode(envelope(raw));
  assert.ok(again.floors.every((f) => f.open === true));
  assert.deepEqual(again.extraction, g.extraction);
});
