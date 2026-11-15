import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildingLayoutErrors } from "../src/building-layout";
import { surfaceBelow } from "../src/elevated-physics";
import {
  exteriorStructure,
  stairAccessPortals,
} from "../src/exterior-structure";
import { type Game, type Roadmap, CONFIG } from "../src/model";
import {
  parseRunStructure,
  type RunStructureV4,
} from "../src/run-design-contract.mjs";
import { nextSiteOrigin, stampSite } from "../src/site-stamp";
import { startSite } from "../src/site";
import {
  CORE_LENGTH,
  CORE_WIDTH,
  coreFlight,
  coreRect,
  stairHole,
} from "../src/stair-core";
import { buildStairRoute, cityStairBase } from "../src/stair-route";
import {
  type StairTravel,
  advanceStairs,
  beginStairs,
} from "../src/stair-travel";
import { stairDrawing } from "../src/stairwell";
import { structureGame } from "../src/world";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
const drawn = (): RunStructureV4 =>
  JSON.parse(
    readFileSync("tests/fixtures/run-designs/planetarium-drawn.json", "utf8"),
  );
const build = (structure: unknown, seed = 42) =>
  structureGame(seed, roadmap, undefined, parseRunStructure(structure));
const errorOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return String((error as Error).message);
  }
  return "";
};
const CORE = { x: 5, y: 9 };

test("core geometry: two switchback flights between two landings", () => {
  assert.deepEqual(coreRect(CORE), { x1: 5, y1: 9, x2: 8, y2: 17 });
  assert.equal(CORE_WIDTH, 4);
  assert.equal(CORE_LENGTH, 9);
  const up0 = coreFlight(CORE, 0),
    up1 = coreFlight(CORE, 1);
  // Even levels climb the west pair southward, odd levels the east pair back.
  assert.deepEqual(up0.cells, { x1: 5, y1: 11, x2: 6, y2: 15 });
  assert.deepEqual(up1.cells, { x1: 7, y1: 11, x2: 8, y2: 15 });
  assert.deepEqual(
    [up0.foot, up0.head],
    [
      { x: 6, y: 10 },
      { x: 6, y: 17 },
    ],
  );
  assert.deepEqual(
    [up1.foot, up1.head],
    [
      { x: 8, y: 17 },
      { x: 8, y: 10 },
    ],
  );
  assert.equal(up0.direction, 1);
  assert.equal(up1.direction, -1);
  // A flight arrives on the landing the next one leaves from.
  assert.equal(up0.head.y, up1.foot.y);
  assert.deepEqual(coreFlight(CORE, 2), up0);
});

test("contract: version 4 states its stairs; an open site has none", () => {
  const s = drawn();
  assert.deepEqual(s.stairs, CORE);
  assert.doesNotThrow(() => parseRunStructure(s));
  const missing = drawn() as Partial<RunStructureV4>;
  delete missing.stairs;
  assert.throws(() => parseRunStructure(missing));
  const fraction = drawn();
  fraction.stairs = { x: 5.5, y: 9 };
  assert.throws(() => parseRunStructure(fraction));
  const open = drawn();
  open.setting.form = "open";
  open.floors = open.floors.slice(0, 1);
  assert.throws(() => parseRunStructure(open), /open site/);
  open.stairs = null;
  assert.doesNotThrow(() => parseRunStructure(open));
});

test("the core is carved the same on every level, with its markers on the landings", () => {
  const g = build(drawn());
  assert.deepEqual(buildingLayoutErrors(g), []);
  for (const f of g.floors) {
    assert.deepEqual(f.stairCore, CORE);
    const rect = coreRect(CORE);
    for (let y = rect.y1; y <= rect.y2; y++)
      for (let x = rect.x1; x <= rect.x2; x++) {
        const hole = stairHole(f, x, y),
          landing = y < 11 || y > 15;
        // Landings are open floor; a flight and its opening are closed to
        // people on foot.
        assert.equal(f.tiles[y][x] === 0, !hole, `${f.index}:${x},${y}`);
        if (landing) assert.equal(hole, undefined);
      }
    // This level's own flight, and the opening of the one from below.
    const west = stairHole(f, 5, 13),
      east = stairHole(f, 7, 13);
    const even = f.index % 2 === 0,
      top = f.index === 4;
    assert.equal(even ? west : east, top ? undefined : "flight");
    assert.equal(even ? east : west, f.index === 0 ? undefined : "opening");
    if (!top) assert.deepEqual(f.stairs, coreFlight(CORE, f.index).foot);
    if (f.index > 0)
      assert.deepEqual(f.entry, coreFlight(CORE, f.index - 1).head);
  }
  // No wells in the walls and no stair standing outside on the ground.
  const b = g.floors[0].boundary!;
  for (const f of g.floors.slice(0, 4))
    for (const x of [21, 22]) assert.equal(f.tiles[b.top - 1][x], 1);
  assert.equal(cityStairBase(g), undefined);
  // The site's markers follow the core.
  const site = startSite(g);
  assert.deepEqual(site.stairs[1], { x: 8, y: 17 });
  assert.deepEqual(site.entry[1], { x: 6, y: 17 });
  // The top-down view draws the flight on its own level and the opening
  // above it.
  assert.deepEqual(
    (({ x, y, w, h }) => ({ x, y, w, h }))(stairDrawing(g.floors[0], "up")),
    { x: 5, y: 11, w: 2, h: 5 },
  );
  assert.deepEqual(
    (({ x, y, w, h }) => ({ x, y, w, h }))(stairDrawing(g.floors[1], "down")),
    { x: 5, y: 11, w: 2, h: 5 },
  );
});

test("each flight is one solid stair with rails, a route and an access field", () => {
  const g = build(drawn()),
    structure = exteriorStructure(g);
  assert.equal(structure.slabs.length, 4);
  structure.slabs.forEach((slab, level) => {
    assert.equal(slab.level, level);
    assert.ok(Math.abs(slab.rise - 3.6) < 1e-9);
    assert.equal(slab.top, level * 3.6);
    // Solid down to its own floor, never through the level below.
    assert.equal(slab.solidTo, level * 3.6);
    assert.ok(Math.abs(slab.halfLength - 2.5) < 1e-9);
    assert.equal(slab.x, level % 2 === 0 ? 6 : 8);
  });
  assert.equal(structure.columns.length, 0);
  assert.ok(structure.guards.every((bay) => !bay.broken));
  // Rails stand around each opening at the upper level.
  for (const level of [0, 1, 2, 3]) {
    const around = structure.guards.filter(
      (bay) => bay.level === level && bay.corner,
    );
    assert.ok(around.length >= 7, `level ${level} opening rails`);
    assert.ok(around.every((bay) => bay.base1 === (level + 1) * 3.6));
  }
  const route = buildStairRoute(g, {
    fromFloor: 0,
    toFloor: 1,
    origin: { x: 6, y: 10 },
    destination: { x: 6, y: 17 },
    until: 0,
  });
  assert.deepEqual(route.points, [
    { x: 6, y: 0, z: 10 },
    { x: 6, y: 0, z: 11 },
    { x: 6, y: 3.6, z: 16 },
    { x: 6, y: 3.6, z: 17 },
  ]);
  assert.deepEqual(
    stairAccessPortals(g).map((p) => [p.floor, p.x, p.y, p.direction]),
    [
      [0, 6, 11, 1],
      [1, 8, 16, -1],
      [2, 6, 11, 1],
      [3, 8, 16, -1],
    ],
  );
});

test("the player's body stands on the treads and falls through no floor", () => {
  const g = build(drawn()),
    a = g.survivors[0];
  // Halfway along the first flight the tread is about half a storey up (the
  // body also touches the next riser or two).
  const mid = surfaceBelow(g, a, { x: 6, y: 13.5 }, 2.4);
  assert.equal(mid?.kind, "slab");
  assert.ok(Math.abs(mid!.height - 1.8) < 0.45, `tread at ${mid?.height}`);
  // Over the opening on the level above there is no floor plate to stand on:
  // the highest surface under a body at that level is the flight below.
  const opening = surfaceBelow(g, a, { x: 6, y: 13.5 }, 3.9);
  assert.equal(opening?.kind, "slab");
  // The landings are ordinary floor on both levels.
  assert.equal(surfaceBelow(g, a, { x: 6, y: 10 }, 0.3)?.kind, "plate");
  const head = surfaceBelow(g, a, { x: 6, y: 17 }, 3.9);
  assert.equal(head?.kind, "plate");
  assert.equal(head?.height, 3.6);
});

test("people on foot take the core by timed travel between its landings", () => {
  const g = build(drawn()),
    npc = g.survivors[1];
  Object.assign(npc, { x: 6, y: 9.8, floor: 0, access: [0, 1, 2, 3] });
  assert.equal(beginStairs(g, npc), true);
  assert.equal(npc.stairTravel?.toFloor, 1);
  assert.deepEqual(npc.stairTravel?.destination, { x: 6, y: 17 });
  g.time += CONFIG.stairSeconds + 0.1;
  advanceStairs(g, npc);
  assert.equal(npc.floor, 1);
  assert.equal(npc.stairTravel, undefined);
  assert.ok(Math.hypot(npc.x - 6, npc.y - 17) < 1.2);
  // Down again from the head landing arrives on the foot landing, not in
  // the flight.
  Object.assign(npc, { x: 6, y: 17, stairwell: undefined });
  assert.equal(beginStairs(g, npc, true), true);
  assert.deepEqual((npc.stairTravel as StairTravel | undefined)?.destination, {
    x: 6,
    y: 10,
  });
  g.time += CONFIG.stairSeconds + 0.1;
  advanceStairs(g, npc);
  assert.equal(npc.floor, 0);
  assert.equal(g.floors[0].tiles[Math.floor(npc.y)][Math.floor(npc.x)], 0);
});

test("a core that does not fit is reported with what it needs", () => {
  const at = (x: number, y: number) => {
    const s = drawn();
    s.stairs = { x, y };
    return errorOf(() => build(s));
  };
  assert.match(at(5, 4), /stairs at 5,4 do not fit/);
  assert.match(at(38, 9), /do not fit/);
  assert.match(at(20, 6), /roof pickup pad/);
  // Rooms may not stand on the core or the apron beyond its landings.
  assert.match(at(14, 9), /covers the entrance lane or the stairs/);
});

test("without a core a drawn building keeps wall wells and the outside stair", () => {
  const s = drawn();
  s.stairs = null;
  const g: Game = build(s);
  assert.deepEqual(buildingLayoutErrors(g), []);
  assert.equal(g.floors[0].stairCore, undefined);
  assert.equal(exteriorStructure(g).slabs.length, 40);
  assert.equal(g.floors[0].stairs.x, 22);
});

test("a stamped neighbour brings its own stair core", () => {
  const plain = drawn();
  plain.stairs = null;
  const g = build(plain),
    source = build(drawn(), 7),
    origin = nextSiteOrigin(g),
    site = stampSite(g, source, { id: "annex", name: "Annex", origin });
  for (const index of site.floors) {
    const cores = g.floors[index].cores ?? [];
    assert.equal(cores.length, 1);
    assert.deepEqual(
      { x: cores[0].x, y: cores[0].y, site: cores[0].site },
      { x: CORE.x + origin.x, y: CORE.y + origin.y, site: "annex" },
    );
  }
  assert.equal(stairHole(g.floors[0], 5 + origin.x, 13 + origin.y), "flight");
  // Its flights are interior too: one slab per storey beside the start
  // building's forty outside ones.
  assert.equal(exteriorStructure(g).slabs.length, 44);
});
