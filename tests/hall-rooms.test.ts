import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  LEVEL_STEP_UNITS,
  cellLevel,
  cellUnits,
  ceilingHeight,
  groundLevel,
  HALL_CEILING,
  levelErrors,
} from "../src/floor-levels";
import { hallSector, sectorOfRoom, sectorRooms } from "../src/floor-plan";
import { furnishingErrors } from "../src/office-layout";
import { pursuitLayoutErrors } from "../src/pursuit-layout";
import { type Floor, type Game, type Roadmap, H, W } from "../src/model";
import { decode, encode } from "../src/persistence";
import {
  parseRunDesign,
  parseRunStructure,
  type RunHall,
  type RunStructureV3,
} from "../src/run-design-contract.mjs";
import { designReplySchema } from "../src/run-design-schema.mjs";
import {
  finalizeDesignedRun,
  previewDesignedRun,
  structureGame,
  type ProvisionalRun,
} from "../src/world";
import { savedRunDesign } from "./helpers/run-design";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
const fixture = (name: string): RunStructureV3 => {
  const { environment: _environment, ...json } = JSON.parse(
    readFileSync(`tests/fixtures/run-designs/${name}.json`, "utf8"),
  );
  return json;
};
const planetarium = () => fixture("planetarium-hall");
const build = (structure: RunStructureV3, seed = 42) =>
  structureGame(seed, roadmap, undefined, parseRunStructure(structure));
/** Distinct letters-only phrases (the contract rejects similar writing). */
const words = (n: number) =>
  [n, n * 7 + 3, n * 13 + 5]
    .map((v) => "x" + v.toString(26).replace(/[0-9]/g, (d) => "qrstuvwxyz"[+d]))
    .join(" ");
/** Plain accepted writing for every surface of a provisional run. */
const plainEnvironment = (token: ProvisionalRun) => ({
  version: 1,
  surfaceFingerprint: token.surfaceFingerprint,
  surfaces: token.surfaces,
  fragments: [],
  entries: token.surfaces.map((s, i) =>
    s.maxTitle || s.maxBody
      ? {
          surfaceId: s.id,
          layout: "text",
          title: s.maxTitle ? [{ text: words(i) }] : [],
          body: s.maxTitle ? [] : [{ text: words(i) }],
          description: "",
          drawing: null,
        }
      : {
          surfaceId: s.id,
          layout: "art",
          title: [],
          body: [],
          description: `Disc ${words(i)}`,
          drawing: {
            version: 1,
            background: "#e9e1cc",
            primitives: [
              {
                kind: "ellipse",
                x: 0.15,
                y: 0.15,
                w: 0.7,
                h: 0.7,
                rotation: 0,
                fill: "#1b1b1b",
                stroke: "#20262b",
                width: 0.012 + i / 100000,
                opacity: 1,
              },
            ],
          },
        },
  ),
});
const HALL: RunHall = {
  rooms: [0, 1, 3],
  focus: "n",
  seating: "none",
  stage: null,
  rake: 0,
  pit: null,
  platforms: [],
};
const stationsOf = (g: Game, f: Floor, rooms: number[]) =>
  f.stations.filter((s) =>
    rooms.some(
      (room) =>
        g.encounters[s.encounter].questionRoom === `f${f.index}-room${room}`,
    ),
  );
const chainFields = (f: Floor) =>
  f.furniture.filter((o) => o.field && o.id !== "main-gate");

test("contract: a hall is optional, bounded and only merges adjacent rooms", () => {
  const plain = fixture("mars-habitat");
  assert.doesNotThrow(() => parseRunStructure(plain));
  const withNull = fixture("mars-habitat");
  for (const floor of withNull.floors) floor.hall = null;
  assert.doesNotThrow(() => parseRunStructure(withNull));
  assert.doesNotThrow(() => parseRunStructure(planetarium()));

  const bad = (change: (hall: RunHall, s: RunStructureV3) => void) => {
    const s = planetarium();
    change(s.floors[0].hall!, s);
    return () => parseRunStructure(s);
  };
  // roomOrder [0,1,3]: rooms 0 and 3 are not next to each other.
  assert.throws(
    bad((h) => (h.rooms = [0, 3])),
    /next to each other/,
  );
  assert.throws(
    bad((h) => (h.rooms = [0, 0])),
    /repeat/,
  );
  assert.throws(bad((h) => (h.rooms = [2, 0])));
  assert.throws(bad((h) => (h.rooms = [0])));
  assert.throws(bad((h) => (h.rake = 2)));
  assert.throws(bad((h) => (h.stage = { depth: 3, height: 2 })));
  assert.throws(bad((h) => (h.pit = { width: 6, length: 4, drop: 1 })));
  assert.throws(bad((h) => (h.focus = "up" as "n")));
  assert.throws(
    bad((h) =>
      h.platforms.push(
        { side: "n", width: 4, depth: 2, height: 0.6 },
        { side: "s", width: 4, depth: 2, height: 0.6 },
      ),
    ),
  );
  // Halls belong to version 3 enclosed buildings.
  const open = fixture("open-market-structure");
  open.floors[0].hall = {
    ...HALL,
    rooms: open.floors[0].roomOrder.slice(0, 2),
  };
  assert.throws(() => parseRunStructure(open), /enclosed/);
});

test("schema: every structure reply states its floors' hall", () => {
  const schema = designReplySchema({ version: 3, phase: "structure" }),
    floor = schema.properties.structure.properties.floors.items;
  assert.ok(floor.required.includes("hall"));
  const hall = floor.properties.hall.anyOf[0];
  assert.deepEqual(hall.required, [
    "rooms",
    "focus",
    "seating",
    "stage",
    "rake",
    "pit",
    "platforms",
  ]);
  assert.deepEqual(floor.properties.hall.anyOf[1], { type: "null" });
});

test("a hall replaces three study rooms with one room holding all their terminals", () => {
  const g = build(planetarium()),
    f = g.floors[0],
    hall = hallSector(f)!,
    sectors = f.generation!.sectors!;
  assert.deepEqual(
    sectors.map((s) => s.id),
    ["entry", "room2", "room0", "lobby"],
  );
  assert.deepEqual(hall.merged, [0, 1, 3]);
  assert.deepEqual(sectorRooms(hall), [0, 1, 3]);
  for (const room of [0, 1, 3]) assert.equal(sectorOfRoom(f, room), hall);
  assert.deepEqual(pursuitLayoutErrors(g, f), []);
  assert.deepEqual(furnishingErrors(f), []);

  // The public gate, the free hall's exit and the hall's one exit.
  assert.deepEqual(
    chainFields(f)
      .map((o) => o.id)
      .sort(),
    ["f0-room0-forward", "f0-room2-door", "f0-room2-forward"],
  );
  // Study capacity is unchanged: the same stations as a floor without a hall.
  const flat = planetarium();
  flat.floors[0].hall = null;
  const reference = build(flat).floors[0];
  assert.equal(f.stations.length, reference.stations.length);
  const held = stationsOf(g, f, [0, 1, 3]);
  assert.equal(held.length, stationsOf(g, reference, [0, 1, 3]).length);
  assert.ok(held.length >= 12);
  const inHall = (p: { x: number; y: number }) =>
    hall.blocks.some(
      (b) => p.x >= b.x1 && p.x < b.x2 + 1 && p.y >= b.y1 && p.y < b.y2 + 1,
    );
  assert.ok(held.every(inHall));
  // One large room: at least 30 m across and no sub-rooms.
  const widest = Math.max(...hall.blocks.map((b) => b.x2 - b.x1 + 1));
  assert.ok(widest >= 30, `hall is ${widest} m wide`);
  assert.equal(hall.rooms.length, 0);
  // Other floors keep the six-sector chain.
  for (const other of g.floors.slice(1, 4)) {
    assert.equal(other.generation!.sectors!.length, 6);
    assert.equal(hallSector(other), undefined);
    assert.equal(other.generation!.levels, undefined);
  }
});

test("a hall of two rooms leaves the third beside it", () => {
  const s = planetarium();
  s.floors[0].hall = { ...HALL, rooms: [1, 3] };
  // The furniture authored for the planetarium's stage room stays valid in
  // the smaller remaining room on this seed.
  const g = build(s),
    f = g.floors[0];
  assert.deepEqual(
    f.generation!.sectors!.map((x) => x.id),
    ["entry", "room2", "room0", "room1", "lobby"],
  );
  assert.deepEqual(hallSector(f)!.merged, [1, 3]);
  assert.equal(chainFields(f).length, 4);
  assert.deepEqual(pursuitLayoutErrors(g, f), []);
  // A flat hall stores no levels.
  assert.equal(f.generation!.levels, undefined);
});

test("hall levels: stage, pit, rake and platform are all reached by 30 cm steps", () => {
  const g = build(planetarium()),
    f = g.floors[0],
    hall = hallSector(f)!;
  assert.deepEqual(levelErrors(f), []);
  const cells: { x: number; y: number }[] = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (
        f.tiles[y][x] === 0 &&
        hall.blocks.some(
          (b) => x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2,
        )
      )
        cells.push({ x, y });
  const units = cells.map((c) => cellUnits(f, c.x, c.y));
  // Stage 0.9 m, pit 0.45 m down, rear platform 1.5 m.
  assert.equal(Math.max(...units), 10);
  assert.equal(Math.min(...units), -3);
  assert.ok(units.filter((u) => u === 6).length >= 12, "flat stage top");
  assert.ok(units.filter((u) => u === -3).length >= 8, "flat pit floor");
  // Every pair of neighbouring open cells is one walkable step apart, also
  // across the hall's edge into its door openings.
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (f.tiles[y][x] !== 0) continue;
      for (const [nx, ny] of [
        [x + 1, y],
        [x, y + 1],
      ])
        if (f.tiles[ny]?.[nx] === 0)
          assert.ok(
            Math.abs(cellUnits(f, x, y) - cellUnits(f, nx, ny)) <=
              LEVEL_STEP_UNITS,
            `step between ${x},${y} and ${nx},${ny}`,
          );
    }
  // Door openings and the cells in front of them stay at storey height.
  for (const o of chainFields(f))
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++)
        assert.equal(
          cellUnits(f, Math.floor(o.x + dx), Math.floor(o.y + dy)),
          0,
        );
  // Levels stay inside the hall.
  assert.equal(cellLevel(f, 21, 27), 0);
  // The ground under a body blends between steps instead of jumping.
  const step = cells.find(
    (c) =>
      f.tiles[c.y][c.x + 1] === 0 &&
      cellUnits(f, c.x + 1, c.y) - cellUnits(f, c.x, c.y) === 2 &&
      cellUnits(f, c.x, c.y - 1) === cellUnits(f, c.x, c.y) &&
      cellUnits(f, c.x, c.y + 1) === cellUnits(f, c.x, c.y) &&
      cellUnits(f, c.x + 1, c.y - 1) === cellUnits(f, c.x + 1, c.y) &&
      cellUnits(f, c.x + 1, c.y + 1) === cellUnits(f, c.x + 1, c.y),
  )!;
  assert.ok(step, "a plain 30 cm step exists");
  const low = cellLevel(f, step.x, step.y);
  assert.ok(
    Math.abs(groundLevel(f, { x: step.x + 0.5, y: step.y + 0.5 }) - low) < 1e-9,
  );
  assert.ok(
    Math.abs(groundLevel(f, { x: step.x + 1, y: step.y + 0.5 }) - low - 0.15) <
      1e-9,
  );
  // The hall is taller than the rooms around it.
  assert.equal(ceilingHeight(f, cells[0].x, cells[0].y), HALL_CEILING);
  assert.ok(ceilingHeight(f, 21, 27) < HALL_CEILING);
});

test("a hall with seating fills with rows of the venue's seat facing the focus", () => {
  const g = build(planetarium()),
    f = g.floors[0];
  // Focus west: row seats face -x, i.e. heading pi/2.
  const seats = f.furniture.filter(
    (o) =>
      o.object?.id === "theatre-seat" &&
      /^f0-room0[a-z]?-/.test(o.id) &&
      Math.abs((o.angle ?? 0) - Math.PI / 2) < 1e-6,
  );
  assert.ok(seats.length >= 24, `${seats.length} row seats`);
  // Authored furniture of every merged room stands inside the hall.
  const hall = hallSector(f)!;
  for (const room of [0, 1, 3]) {
    const placed = f.furniture.filter((o) =>
      o.id.startsWith(`f0-scene-room${room}-`),
    );
    assert.ok(placed.length > 0, `room ${room} furniture`);
    for (const o of placed)
      assert.ok(
        hall.blocks.some(
          (b) => o.x >= b.x1 && o.x < b.x2 + 1 && o.y >= b.y1 && o.y < b.y2 + 1,
        ),
        `${o.id} inside the hall`,
      );
  }
  // Each merged room keeps its own plaque position.
  const plaques = f.scene!.rooms.map((r) => `${r.plaque.x},${r.plaque.y}`);
  assert.equal(new Set(plaques).size, 4);
});

test("halls build in every plan family", () => {
  for (const family of ["stack", "columns", "serpentine"] as const) {
    const s = fixture("radio-broadcast");
    const index = s.floors.findIndex((floor) => floor.family === family);
    assert.ok(index >= 0, family);
    s.floors[index].hall = {
      ...HALL,
      // Pairs whose leftover room still fits the fixture's own furniture.
      rooms:
        family === "serpentine"
          ? s.floors[index].roomOrder.slice(0, 2)
          : s.floors[index].roomOrder.slice(1),
      stage: { depth: 2, height: 0.6 },
      rake: 0.6,
    };
    const g = build(s),
      f = g.floors[index];
    assert.deepEqual(pursuitLayoutErrors(g, f), [], family);
    assert.equal(f.generation!.sectors!.length, 5, family);
    assert.ok(f.generation!.levels, family);
  }
});

test("a design without a hall builds exactly as before", () => {
  const withNull = fixture("mars-habitat");
  for (const floor of withNull.floors) floor.hall = null;
  const a = build(fixture("mars-habitat")),
    b = build(withNull);
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(a.floors[i].tiles, b.floors[i].tiles);
    assert.deepEqual(a.floors[i].generation, b.floors[i].generation);
    assert.deepEqual(
      a.floors[i].furniture.map((o) => [o.id, o.x, o.y, o.angle]),
      b.floors[i].furniture.map((o) => [o.id, o.x, o.y, o.angle]),
    );
    assert.deepEqual(a.floors[i].stations, b.floors[i].stations);
  }
});

test("a saved hall floor reloads with its sectors and levels", () => {
  const structure = parseRunStructure(planetarium()),
    token = previewDesignedRun(42, roadmap, undefined, structure),
    g = finalizeDesignedRun(
      token,
      savedRunDesign(
        parseRunDesign({
          ...structure,
          environment: plainEnvironment(token),
        }),
      ),
    ),
    loaded = decode(encode(g));
  assert.deepEqual(
    loaded.floors[0].generation,
    JSON.parse(JSON.stringify(g.floors[0].generation)),
  );
  assert.ok(loaded.floors[0].generation!.levels);
  assert.deepEqual(levelErrors(loaded.floors[0]), []);
  assert.deepEqual(pursuitLayoutErrors(loaded, loaded.floors[0]), []);
});
