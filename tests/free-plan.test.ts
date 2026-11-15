import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { cellUnits, ceilingHeight, HALL_CEILING } from "../src/floor-levels";
import { hallSectors, sectorOfRoom } from "../src/floor-plan";
import { freePlanErrors } from "../src/free-plan";
import { furnishingErrors } from "../src/office-layout";
import { pursuitLayoutErrors } from "../src/pursuit-layout";
import { buildingLayoutErrors } from "../src/building-layout";
import { buildInteriorLighting } from "../src/interior-lighting";
import {
  type Floor,
  type Game,
  type Roadmap,
  H,
  W,
  roofIndexOf,
} from "../src/model";
import { exteriorStructure } from "../src/exterior-structure";
import { AUTHORITY_ROLE, RADIO_ROLE } from "../src/npc-social";
import { extractionPoints, roofFloorOf, startSite } from "../src/site";
import { nextSiteOrigin, stampSite } from "../src/site-stamp";
import { decode, encode } from "../src/persistence";
import {
  DRAWN_FLOOR_GUIDANCE,
  RUN_DESIGN_GUIDANCE,
  isDrawnDesign,
  parseRunDesign,
  parseRunStructure,
  runDesignNoveltyErrors,
  summarizeRunDesign,
  type RunFreeRoom,
  type RunStructureV4,
} from "../src/run-design-contract.mjs";
import {
  STRUCTURE_SCHEMAS,
  designReplySchema,
} from "../src/run-design-schema.mjs";
import {
  finalizeDesignedRun,
  previewDesignedRun,
  structureGame,
  type ProvisionalRun,
} from "../src/world";
import { schemaErrors } from "./helpers/json-schema";
import { savedRunDesign } from "./helpers/run-design";

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
const reachable = (f: Floor) => {
  const seen = new Set<number>(),
    queue = [{ x: Math.floor(f.entry.x), y: Math.floor(f.entry.y) }];
  for (let i = 0; i < queue.length; i++) {
    const { x, y } = queue[i],
      k = y * W + x;
    if (x < 0 || y < 0 || x >= W || y >= H || seen.has(k) || f.tiles[y][x])
      continue;
    seen.add(k);
    queue.push(
      { x: x + 1, y },
      { x: x - 1, y },
      { x, y: y + 1 },
      { x, y: y - 1 },
    );
  }
  return seen;
};
const stationsIn = (g: Game, f: Floor, room: number) =>
  f.stations.filter(
    (s) => g.encounters[s.encounter].questionRoom === `f${f.index}-room${room}`,
  );

test("contract: version 4 floors are drawn rooms, bounded and self-furnished", () => {
  const structure = parseRunStructure(drawn());
  assert.equal(structure.version, 4);
  assert.ok(isDrawnDesign(structure));
  assert.ok(!isDrawnDesign({ version: 3 }));

  const bad = (change: (s: RunStructureV4, room: RunFreeRoom) => void) => {
    const s = drawn();
    change(s, s.floors[0].rooms[0]);
    return () => parseRunStructure(s);
  };
  assert.throws(bad((_, room) => (room.w = 2)));
  assert.throws(bad((_, room) => (room.doors = [])));
  assert.throws(bad((_, room) => (room.pattern = "office" as "desk")));
  assert.throws(
    bad((_, room) => (room.filler = ["no-such-thing"])),
    /built-in furniture kind or one of setting.objects/,
  );
  assert.throws(
    bad((_, room) => (room.filler = [])),
    /at least one entry/,
  );
  assert.throws(bad((_, room) => (room.work = 13)));
  assert.throws(
    bad((s) => s.floors[0].rooms.forEach((room) => (room.work = 0))),
    /work points in total/,
  );
  // Hall features need a room large enough to be a hall.
  assert.throws(
    bad((s) => {
      s.floors[0].rooms[1].hall = s.floors[0].rooms[0].hall;
    }),
    /at least 8 cells/,
  );
  // No chain fields and no venue catalog on a drawn design.
  assert.throws(
    bad(
      (s) => ((s.floors[0] as unknown as { family: string }).family = "stack"),
    ),
  );
  assert.throws(
    bad((s) => (s.setting.venue = "office")),
    /venue custom and filler null/,
  );
  // One scene entry per drawn room.
  assert.throws(bad((s) => s.floors[0].scene.rooms.pop()));
  // Version 3 designs are unaffected.
  const v3 = JSON.parse(
    readFileSync("tests/fixtures/run-designs/planetarium-hall.json", "utf8"),
  );
  assert.equal(parseRunStructure(v3).version, 3);
});

test("schema and guidance: fresh structures are version 4 with drawn floors", () => {
  const schema = designReplySchema({ version: 3, phase: "structure" });
  assert.deepEqual(schema.properties.structure, STRUCTURE_SCHEMAS[4]);
  assert.deepEqual(schemaErrors(STRUCTURE_SCHEMAS[4], drawn()), []);
  const floor = STRUCTURE_SCHEMAS[4].properties.floors.items;
  assert.deepEqual(floor.required, [
    "name",
    "furnitureDensity",
    "concourse",
    "rooms",
    "scene",
  ]);
  // A chain floor does not fit the fresh schema.
  const v3 = JSON.parse(
    readFileSync("tests/fixtures/run-designs/planetarium-hall.json", "utf8"),
  );
  assert.ok(schemaErrors(STRUCTURE_SCHEMAS[4], v3).length > 0);
  assert.ok(RUN_DESIGN_GUIDANCE.includes(DRAWN_FLOOR_GUIDANCE));
  assert.match(RUN_DESIGN_GUIDANCE, /structure:\{version:4,/);
  for (const word of ["concourse", "pattern", "work", "HallFeatures", "rows"])
    assert.ok(DRAWN_FLOOR_GUIDANCE.includes(word), word);
});

test("a drawn building is built as drawn: rooms, doorways, concourse, no chain", () => {
  const structure = drawn(),
    g = build(structure);
  assert.deepEqual(buildingLayoutErrors(g), []);
  for (const [index, design] of structure.floors.entries()) {
    const f = g.floors[index],
      sectors = f.generation!.sectors!;
    assert.equal(f.generation!.version, 6);
    assert.deepEqual(
      sectors.map((s) => s.id),
      ["entry", ...design.rooms.map((_, i) => `room${i}`)],
    );
    assert.deepEqual(freePlanErrors(g, f), []);
    assert.deepEqual(pursuitLayoutErrors(g, f), []);
    assert.deepEqual(furnishingErrors(f), []);
    // No force fields except the building's main gate.
    assert.deepEqual(
      f.furniture.filter((o) => o.field).map((o) => o.id),
      index === 0 ? ["main-gate"] : [],
    );
    const seen = reachable(f);
    assert.ok(seen.has(Math.floor(f.stairs.y) * W + Math.floor(f.stairs.x)));
    design.rooms.forEach((room, i) => {
      const block = sectors[i + 1].blocks[0];
      // The interior is exactly the rectangle the design drew.
      assert.deepEqual(block, {
        x1: room.x,
        y1: room.y,
        x2: room.x + room.w - 1,
        y2: room.y + room.h - 1,
      });
      assert.equal(sectorOfRoom(f, i), sectors[i + 1]);
      assert.equal(stationsIn(g, f, i).length, room.work, room.name);
      for (const s of stationsIn(g, f, i)) {
        assert.ok(s.x > block.x1 && s.x < block.x2 + 1);
        assert.ok(s.y > block.y1 && s.y < block.y2 + 1);
        assert.ok(seen.has(Math.floor(s.y) * W + Math.floor(s.x)));
      }
      // Authored scene furniture stands in its own drawn room.
      const placed = f.furniture.filter((o) =>
        o.id.startsWith(`f${index}-scene-room${i}-`),
      );
      assert.ok(placed.length > 0, `${room.name} scene furniture`);
      for (const o of placed)
        assert.ok(
          o.x > block.x1 - 0.01 &&
            o.x < block.x2 + 1.01 &&
            o.y > block.y1 - 0.01 &&
            o.y < block.y2 + 1.01,
          o.id,
        );
    });
    assert.equal(
      f.generation!.doorways!.length,
      design.rooms.reduce((n, room) => n + room.doors.length, 0),
    );
    assert.equal(
      f.stations.length,
      design.rooms.reduce((n, room) => n + room.work, 0),
    );
    // Every station keeps a live encounter and nothing else is left behind.
    for (const s of f.stations) assert.ok(g.encounters[s.encounter]);
  }
  // The roof is still the shared shell.
  assert.equal(g.floors[4].generation?.version, undefined);
});

test("drawn rooms are furnished by their own pattern and list, not office functions", () => {
  const g = build(drawn());
  const ids = (f: Floor, zone: string) =>
    f.furniture
      .filter(
        (o) => o.id.startsWith(`f${f.index}-${zone}-`) && o.kind !== "door",
      )
      .map((o) => o.object?.id ?? o.kind);
  // Star theatre: rows of the room's own seat facing its west focus.
  const theatre = g.floors[0].furniture.filter(
    (o) =>
      o.object?.id === "theatre-seat" &&
      o.id.startsWith("f0-room0-") &&
      Math.abs((o.angle ?? 0) - Math.PI / 2) < 1e-6,
  );
  assert.ok(theatre.length >= 16, `${theatre.length} row seats`);
  // Each room holds only pieces from its own list.
  for (const [index, design] of drawn().floors.entries())
    design.rooms.forEach((room, i) => {
      const placed = ids(g.floors[index], `room${i}`);
      assert.ok(placed.length > 0, `${room.name} has filler`);
      for (const name of placed)
        assert.ok(room.filler.includes(name), `${room.name}: ${name}`);
    });
  // A bays room holds its signature piece.
  const bays = ids(g.floors[1], "room2");
  assert.ok(bays.includes("bunk-pod"));
  // The concourse's larger open areas use the concourse list.
  const concourse = g.floors[1].furniture.filter((o) =>
    /^f1-entry[a-z0-9]*-/.test(o.id),
  );
  assert.ok(concourse.length > 0);
  for (const o of concourse)
    assert.ok(
      drawn().floors[1].concourse.filler.includes(o.object?.id ?? o.kind),
    );
  // No office filler anywhere on a drawn floor unless the design listed it.
  for (const f of g.floors.slice(0, 4))
    for (const kind of ["printer", "vending", "partition", "copier"])
      assert.equal(
        f.furniture.filter((o) => o.kind === kind).length,
        0,
        `${kind} on floor ${f.index}`,
      );
});

test("a drawn hall room has stepped levels, a taller ceiling and its own power", () => {
  const g = build(drawn()),
    f = g.floors[0],
    hall = hallSectors(f);
  assert.equal(hall.length, 1);
  assert.equal(hall[0].id, "room0");
  const block = hall[0].blocks[0];
  let high = 0,
    low = 0;
  for (let y = block.y1; y <= block.y2; y++)
    for (let x = block.x1; x <= block.x2; x++) {
      high = Math.max(high, cellUnits(f, x, y));
      low = Math.min(low, cellUnits(f, x, y));
    }
  assert.equal(high, 10);
  assert.equal(low, -3);
  // Flat at each doorway.
  for (const d of f.generation!.doorways!)
    for (let y = d.y1 - 2; y <= d.y2 + 2; y++)
      for (let x = d.x1 - 2; x <= d.x2 + 2; x++)
        assert.equal(cellUnits(f, x, y), 0);
  assert.equal(ceilingHeight(f, block.x1 + 3, block.y1 + 3), HALL_CEILING);
  assert.ok(ceilingHeight(f, 8, 22) < HALL_CEILING);
  // Room power comes from each drawn room.
  const zones = buildInteriorLighting(f, g.seed).zones;
  assert.equal(zones.find((z) => z.id === "room2")!.power, "dim");
  assert.equal(zones.find((z) => z.id === "room0")!.power, "lit");
  // Carved corners follow each room's shape.
  assert.ok(
    (f.generation!.corners ?? []).some((c) => c.room === 0),
    "rounded theatre corners",
  );
});

test("a drawn doorway carries a hinged door or stays an open gap", () => {
  const structure = drawn(),
    g = build(structure),
    f = g.floors[0];
  // The ticket office door: hinged, latched, styled, and no force field.
  const door = f.furniture.find((o) => o.id === "f0-room1-door0")!;
  assert.ok(door, "ticket office door");
  assert.equal(door.kind, "door");
  assert.equal(door.field, undefined);
  assert.ok(door.door?.latched);
  const authored = structure.floors[0].rooms[1].doors[0].door!;
  assert.equal(door.maxHp, authored.health);
  assert.equal(door.doorStyle?.material, authored.material);
  assert.equal(door.doorStyle?.label, authored.label);
  // It stands in its doorway.
  const gap = f.generation!.doorways!.find(
    (d) => door.door!.frame.x > d.x1 && door.door!.frame.x < d.x2 + 1.01,
  );
  assert.ok(gap, "door frame sits in a doorway");
  // The theatre's wide openings were authored open: no door object there.
  assert.deepEqual(
    structure.floors[0].rooms[0].doors.map((d) => d.door),
    [null, null],
  );
  assert.equal(
    f.furniture.filter((o) => o.id.startsWith("f0-room0-door")).length,
    0,
  );
  // One door object per authored door across the building.
  for (const [index, design] of structure.floors.entries())
    assert.equal(
      g.floors[index].furniture.filter(
        (o) => o.kind === "door" && o.id !== "main-gate",
      ).length,
      design.rooms.flatMap((room) => room.doors).filter((d) => d.door).length,
    );
  // A malformed door is rejected by the contract.
  const bad = drawn();
  bad.floors[0].rooms[1].doors[0].door = { ...authored, health: 10 };
  assert.throws(() => parseRunStructure(bad), /health/);
});

test("drawn floors report every problem a repair needs, by room", () => {
  const change = (edit: (rooms: RunFreeRoom[]) => void) => {
    const s = drawn();
    edit(s.floors[0].rooms);
    return errorOf(() => build(s));
  };
  assert.match(
    change((rooms) => (rooms[1].x = 2)),
    /room 1 "Ticket Office" must lie inside x \d+\.\.\d+, y \d+\.\.\d+/,
  );
  assert.match(
    change((rooms) => (rooms[1].y = 20)),
    /room 1 "Ticket Office" overlaps or touches room 0 "Star Theatre"/,
  );
  assert.match(
    change((rooms) => {
      rooms[1].x = 16;
      rooms[1].w = 6;
    }),
    /covers the entrance lane/,
  );
  // A door on the outer wall side opens into the shell.
  assert.match(
    change((rooms) => {
      rooms[2].x = 30;
      rooms[2].doors = [{ side: "e", at: 0.5, door: null }];
    }),
    /door 0 \(e\) opens into a wall/,
  );
  assert.match(
    change((rooms) => (rooms[1].work = 12)),
    /cannot hold 12 work points/,
  );
  // Two rooms spanning the storey leave only single-cell side passages
  // between the entrance and the stairs.
  const narrow = drawn();
  narrow.stairs = null;
  const upper = narrow.floors[1].rooms;
  Object.assign(upper[0], { x: 5, w: 14 });
  Object.assign(upper[1], { x: 21, w: 18 });
  assert.match(
    errorOf(() => build(narrow)),
    /Invalid drawn floor 1: .*keep passages at least two cells wide/,
  );
  // Two problems come back together.
  const both = change((rooms) => {
    rooms[1].y = 20;
    rooms[2].y = 20;
  });
  assert.match(both, /room 1 .*overlaps/);
  assert.match(both, /room 2 .*overlaps/);
});

test("a room reached only through another room is still reachable", () => {
  const s = drawn(),
    rooms = s.floors[1].rooms;
  // North-east opens only into north-west through their shared wall.
  rooms[1].x = 21;
  rooms[1].w = 14;
  rooms[1].doors = [{ side: "w", at: 0.5, door: null }];
  const g = build(s),
    f = g.floors[1];
  assert.deepEqual(freePlanErrors(g, f), []);
  const seen = reachable(f);
  for (const st of stationsIn(g, f, 1))
    assert.ok(seen.has(Math.floor(st.y) * W + Math.floor(st.x)));
});

test("a complete drawn design is accepted, saved and reloaded", () => {
  const structure = parseRunStructure(drawn()),
    token = previewDesignedRun(42, roadmap, undefined, structure),
    design = parseRunDesign({
      ...structure,
      environment: plainEnvironment(token),
    } as never),
    g = finalizeDesignedRun(token, savedRunDesign(design)),
    loaded = decode(encode(g));
  assert.equal(loaded.design!.design.version, 4);
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(
      loaded.floors[i].generation,
      JSON.parse(JSON.stringify(g.floors[i].generation)),
    );
    assert.deepEqual(freePlanErrors(loaded, loaded.floors[i]), []);
  }
  // Surfaces belong to drawn rooms by index, beyond the old four where drawn.
  const rooms = new Set(
    token.surfaces.filter((s) => s.floor === 1).map((s) => s.room),
  );
  for (const room of [0, 1, 2, 3]) assert.ok(rooms.has(room), `room ${room}`);
  // Novelty summaries tell two drawn plans apart and survive the contract.
  const moved = drawn();
  moved.floors[0].rooms[0].w = 20;
  assert.notEqual(
    summarizeRunDesign(design).spatial,
    summarizeRunDesign({ ...design, floors: moved.floors } as never).spatial,
  );
  assert.ok(Array.isArray(runDesignNoveltyErrors(design, [])));
});

test("a drawn building has as many storeys as the design drew, one to four", () => {
  for (const storeys of [1, 2, 3, 4]) {
    const s = drawn();
    s.floors = s.floors.slice(0, storeys);
    const g = build(s),
      site = startSite(g);
    assert.equal(g.floors.length, storeys + 1, `${storeys} storeys`);
    assert.deepEqual(
      site.floors,
      Array.from({ length: storeys + 1 }, (_, i) => i),
    );
    assert.equal(roofFloorOf(site), storeys);
    assert.deepEqual(buildingLayoutErrors(g), []);
    // The roof sits on the last storey and is where the default pickup is.
    const roof = g.floors[storeys];
    assert.equal(roof.name, s.roofName);
    assert.equal(roof.generation?.sectors, undefined);
    assert.equal(roofIndexOf(roof), storeys);
    assert.equal(roof.stations.length, 0);
    assert.equal(extractionPoints(g)[0].floor, storeys);
    // Every storey below it is a drawn floor with a way up; the roof has none.
    for (const f of g.floors.slice(0, storeys)) {
      assert.equal(f.generation!.version, 6);
      assert.ok(site.stairs[f.index], `up from ${f.index}`);
    }
    assert.equal(site.stairs[storeys], undefined);
    // One interior flight per storey; with wall wells instead, the outside
    // route has ten slabs per storey.
    assert.equal(exteriorStructure(g).slabs.length, storeys);
    const outside = drawn();
    outside.floors = outside.floors.slice(0, storeys);
    outside.stairs = null;
    assert.equal(exteriorStructure(build(outside)).slabs.length, storeys * 10);
  }
  // Four storeys is the unmarked default; fewer is recorded on every floor.
  assert.equal(build(drawn()).floors[0].roof, undefined);
  const two = drawn();
  two.floors = two.floors.slice(0, 2);
  assert.ok(build(two).floors.every((f) => f.roof === 2));
  // The contract bounds the count; chain designs still need exactly four.
  const none = drawn();
  none.floors = [];
  assert.throws(() => parseRunStructure(none));
  const five = drawn();
  five.floors.push(five.floors[3]);
  assert.throws(() => parseRunStructure(five));
  const v3 = JSON.parse(
    readFileSync("tests/fixtures/run-designs/planetarium-hall.json", "utf8"),
  );
  v3.floors = v3.floors.slice(0, 2);
  assert.throws(() => parseRunStructure(v3));
});

test("a taller neighbouring building keeps every storey beside a one-storey start", () => {
  const low = drawn();
  low.floors = low.floors.slice(0, 1);
  const g = build(low),
    source = build(drawn(), 7);
  const site = stampSite(g, source, {
    id: "tower",
    name: "Tower",
    origin: nextSiteOrigin(g),
  });
  assert.deepEqual(site.floors, [0, 1, 2, 3, 4]);
  assert.equal(g.floors.length, 5);
  assert.equal(roofFloorOf(site), 4);
  // The start building is still one storey with its roof on floor 1.
  assert.deepEqual(startSite(g).floors, [0, 1]);
  assert.equal(roofFloorOf(startSite(g)), 1);
  // The added layers are solid where the start building stands.
  assert.ok(g.floors[3].tiles[14].slice(0, 44).every((tile) => tile === 1));
});

test("a drawn design chooses its cast: how many people and what each does", () => {
  const structure = drawn(),
    g = build(structure);
  assert.equal(structure.roster.length, 12);
  // The player plus exactly the authored cast, with their own roles.
  assert.equal(g.survivors.length, 13);
  structure.roster.forEach((person, i) => {
    const actor = g.survivors[i + 1];
    assert.equal(actor.id, `npc-${i}`);
    assert.equal(actor.name, person.name);
    assert.equal(actor.role, person.role);
  });
  assert.equal(g.survivors[1].role, "projectionist");
  // Authority and radios come from the words of the role.
  const supervisor = g.survivors.find((a) => /supervisor/.test(a.role))!;
  assert.ok(AUTHORITY_ROLE.test(supervisor.role));
  assert.ok(RADIO_ROLE.test(supervisor.role));
  assert.ok(!AUTHORITY_ROLE.test("ticket clerk"));

  const person = (n: number) => ({
    name: `Person ${n}`,
    role: "stagehand",
    skill: 0.5,
    risk: 0.5,
    social: 0.5,
  });
  const cast = (size: number) => {
    const s = drawn();
    s.roster = Array.from({ length: size }, (_, n) => person(n));
    s.relationships = [
      { from: "Person 0", to: "Person 1", kind: "colleague", detail: "shift" },
    ];
    const fix = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(fix);
      else if (value && typeof value === "object")
        for (const [key, inner] of Object.entries(value))
          if (key === "owner" && typeof inner === "string")
            (value as { owner: string }).owner = "Person 0";
          else fix(inner);
    };
    fix(s.floors);
    return s;
  };
  // The smallest and the largest cast both build, with no template limit.
  assert.equal(build(cast(4)).survivors.length, 5);
  assert.equal(build(cast(24)).survivors.length, 25);
  assert.throws(() => parseRunStructure(cast(3)));
  assert.throws(() => parseRunStructure(cast(25)));
  const twin = cast(6);
  twin.roster[1].name = "Person 0";
  assert.throws(() => parseRunStructure(twin), /unique names/);
  const blank = cast(6);
  blank.roster[2].role = "";
  assert.throws(() => parseRunStructure(blank));
  // Chain designs keep nineteen people in the five engine roles.
  const v3 = JSON.parse(
    readFileSync("tests/fixtures/run-designs/planetarium-hall.json", "utf8"),
  );
  v3.roster[0].role = "projectionist";
  assert.throws(() => parseRunStructure(v3));
});

test("a drawn design has no city, tempo, notice board or skyline to fill in", () => {
  const s = drawn() as unknown as Record<string, unknown>;
  assert.equal("city" in s, false);
  assert.equal("pacing" in s, false);
  assert.deepEqual(Object.keys(drawn().exterior), [
    "buildingName",
    "buildingSubtitle",
  ]);
  const legacy = JSON.parse(
    readFileSync("tests/fixtures/run-designs/planetarium-hall.json", "utf8"),
  );
  for (const [key, value] of [
    ["city", legacy.city],
    ["pacing", legacy.pacing],
  ] as const) {
    const withField = { ...drawn(), [key]: value };
    assert.throws(() => parseRunStructure(withField), new RegExp(key));
  }
  for (const key of ["quarantineTitle", "skyline"]) {
    const withField = drawn();
    (withField.exterior as unknown as Record<string, unknown>)[key] =
      legacy.exterior[key];
    assert.throws(
      () => parseRunStructure(withField),
      new RegExp(`exterior.${key}`),
    );
  }
  const schema = STRUCTURE_SCHEMAS[4];
  assert.equal(schema.properties.city, undefined);
  assert.equal(schema.properties.pacing, undefined);
  assert.ok(!schema.required.includes("city"));
  assert.deepEqual(Object.keys(schema.properties.exterior.properties), [
    "buildingName",
    "buildingSubtitle",
  ]);
  assert.equal(schema.properties.roster.minItems, 4);
  assert.equal(schema.properties.roster.maxItems, 24);
  assert.equal(schema.properties.roster.items.properties.role.maxLength, 40);
  // Version 3 keeps all of them.
  assert.ok(STRUCTURE_SCHEMAS[3].required.includes("city"));
  assert.ok(STRUCTURE_SCHEMAS[3].properties.pacing);
  // The world still gets its drawn outdoors, and no engine notice surface.
  const token = previewDesignedRun(
    42,
    roadmap,
    undefined,
    parseRunStructure(drawn()),
  );
  assert.ok(token.surfaces.some((x) => x.id === "building:entrance-sign"));
  assert.ok(!token.surfaces.some((x) => x.id === "building:quarantine-sign"));
  assert.ok(build(drawn()).floors[0].city);
  for (const word of ["roster:4..24", "no city and no pacing", "role"])
    assert.ok(RUN_DESIGN_GUIDANCE.includes(word), word);
});
