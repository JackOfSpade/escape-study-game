import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decode, encode } from "../src/persistence";
import { step } from "../src/engine";
import { TestRunner } from "../src/gametest/runner";
import { emptyScenario } from "../src/gametest/schema";
import { pursuitLayoutErrors } from "../src/pursuit-layout";
import { redesign } from "../src/force-fields";
import { survivorPath } from "../src/navigation";
import { createGame, createPlayableGame } from "../src/world";
import {
  type Floor,
  type Furniture,
  type Game,
  type Point,
  type Roadmap,
  W,
  H,
} from "../src/model";
import {
  SUB_ROOM_SIZES,
  floorSectors,
  inRect,
  sectorAt,
  sizeFits,
  type Sector,
} from "../src/floor-plan";
import {
  fieldClearance,
  furnishOffice,
  pursuitOfficeZones,
} from "../src/office-layout";
const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
function reachable(
  f: Floor,
  start: Point,
  end: Point,
  blocked: (x: number, y: number) => boolean,
) {
  const key = (x: number, y: number) => y * W + x,
    target = key(Math.floor(end.x), Math.floor(end.y)),
    queue = [key(Math.floor(start.x), Math.floor(start.y))],
    seen = new Set(queue);
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i];
    if (n === target) return true;
    const x = n % W,
      y = Math.floor(n / W);
    for (const [xx, yy] of [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ]) {
      const k = key(xx, yy);
      if (
        xx < 0 ||
        xx >= W ||
        yy < 0 ||
        yy >= H ||
        f.tiles[yy][xx] ||
        blocked(xx, yy) ||
        seen.has(k)
      )
        continue;
      seen.add(k);
      queue.push(k);
    }
  }
  return false;
}
/** Sector order owning a cell inside the shell, or -1 (walls and gates). */
function owner(f: Floor, x: number, y: number) {
  const b = f.boundary!;
  if (y < b.top || y >= b.bottom || x < b.rows[y].left || x >= b.rows[y].right)
    return -1;
  return sectorAt(f, { x: x + 0.5, y: y + 0.5 })?.order ?? -1;
}
const covers = (o: Furniture, x: number, y: number) =>
  Math.abs(x + 0.5 - o.x) < o.w / 2 && Math.abs(y + 0.5 - o.y) < o.h / 2;
/** Sector orders on the two sides of a field's middle cell (minus side first). */
function sides(f: Floor, o: Furniture) {
  const x = Math.floor(o.x),
    y = Math.floor(o.y);
  return o.h > o.w
    ? [owner(f, x - 1, y), owner(f, x + 1, y)]
    : [owner(f, x, y - 1), owner(f, x, y + 1)];
}
const chainFields = (f: Floor) =>
  f.furniture.filter((o) => o.field && o.id !== "main-gate");
function freshFloors(seeds: number) {
  const out: { g: Game; f: Floor; seed: number }[] = [];
  for (let seed = 0; seed < seeds; seed++) {
    const g = createPlayableGame(seed, roadmap);
    for (const f of g.floors.slice(0, 4)) out.push({ g, f, seed });
  }
  return out;
}
const floors64 = freshFloors(64);

test("no main-door-to-stairs bypass around the first occupied study hall", () => {
  for (const seed of [2219683494, 42, 3245246807]) {
    const g = createPlayableGame(seed, roadmap);
    for (const f of g.floors.slice(0, 4)) {
      const hall = floorSectors(f).find((s) => s.id === "room2")!;
      assert.equal(
        reachable(f, f.entry, f.stairs, (x, y) => owner(f, x, y) === 1),
        false,
        `seed ${seed} floor ${f.index}: swarm has a hallway around the study hall`,
      );
      assert.equal(hall.order, 1);
      assert.ok(reachable(f, f.entry, f.stairs, () => false));
    }
  }
});

test("every consecutive sector pair shares one 3-cell opening covered by one field", () => {
  const orders = new Set<string>();
  for (const { f, seed } of floors64) {
    const where = `seed ${seed} floor ${f.index}`;
    const sectors = floorSectors(f);
    assert.equal(f.generation!.version, 5, where);
    assert.deepEqual(
      sectors.map((s) => s.order),
      [0, 1, 2, 3, 4, 5],
    );
    assert.equal(sectors[0].id, "entry");
    assert.equal(sectors[1].id, "room2", "the free study hall is first");
    assert.equal(sectors[5].id, "lobby");
    assert.deepEqual(
      sectors
        .slice(2, 5)
        .map((s) => s.room)
        .sort(),
      [0, 1, 3],
    );
    orders.add(sectors.map((s) => s.id).join(","));
    // Openings: open shell cells in no sector, grouped by the pair they join.
    const openings = new Map<string, Point[]>();
    const b = f.boundary!;
    for (let y = b.top; y < b.bottom; y++)
      for (let x = b.rows[y].left; x < b.rows[y].right; x++) {
        if (f.tiles[y][x] || owner(f, x, y) >= 0) continue;
        const pairs = [
          [owner(f, x - 1, y), owner(f, x + 1, y)],
          [owner(f, x, y - 1), owner(f, x, y + 1)],
        ].filter(([a, c]) => a >= 0 && c >= 0);
        assert.equal(pairs.length, 1, `${where}: odd opening at ${x},${y}`);
        const [a, c] = pairs[0].sort();
        assert.equal(c - a, 1, `${where}: sectors ${a}/${c} share an opening`);
        const key = `${a}/${c}`;
        openings.set(key, [...(openings.get(key) ?? []), { x, y }]);
      }
    const fields = chainFields(f);
    assert.equal(fields.length, 5, where);
    for (let k = 0; k < 5; k++) {
      const cells = openings.get(`${k}/${k + 1}`) ?? [];
      assert.equal(cells.length, 3, `${where}: opening ${k}/${k + 1}`);
      const field = fields.filter(
        (o) => [...sides(f, o)].sort().join() === `${k},${k + 1}`,
      );
      assert.equal(field.length, 1, `${where}: fields for ${k}/${k + 1}`);
      for (const c of cells)
        assert.equal(
          fields.filter((o) => covers(o, c.x, c.y)).length,
          1,
          `${where}: uncovered or stacked field at ${c.x},${c.y}`,
        );
      assert.equal(
        field[0].id,
        k === 0
          ? `f${f.index}-room2-door`
          : `f${f.index}-${sectors[k].id}-forward`,
      );
      assert.equal(
        reachable(f, f.entry, f.stairs, (x, y) => covers(field[0], x, y)),
        false,
        `${where}: bypass around field ${field[0].id}`,
      );
    }
  }
  assert.equal(
    orders.size,
    6,
    "all orders of the later rooms occur across seeds",
  );
});

test("blocking any study sector severs the entry from the stairs", () => {
  for (const { f, seed } of floors64)
    for (let order = 1; order <= 4; order++)
      assert.equal(
        reachable(f, f.entry, f.stairs, (x, y) => owner(f, x, y) === order),
        false,
        `seed ${seed} floor ${f.index}: walk-around past sector ${order}`,
      );
});

test("completed zero-key solvers can reach stairs from every room with all entrance quotas exhausted", () => {
  for (let seed = 0; seed < 32; seed++) {
    const g = createPlayableGame(seed, roadmap),
      a = g.survivors[0];
    for (const f of g.floors.slice(0, 4)) {
      a.floor = f.index;
      a.keys = 0;
      a.access = [f.index];
      for (const o of f.furniture)
        if (o.field?.limit !== undefined) o.field.used = o.field.limit;
      for (const sector of floorSectors(f)) {
        if (sector.room === undefined) continue;
        const stations = f.stations.filter(
          (s) =>
            g.encounters[s.encounter].questionRoom ===
            `f${f.index}-room${sector.room}`,
        );
        assert.ok(stations.length > 0);
        for (const s of stations) {
          Object.assign(a, { x: s.x, y: s.y });
          const path = survivorPath(f, a, f.stairs);
          assert.ok(
            path.length,
            `seed ${seed} floor ${f.index} room ${sector.room} ${s.id}`,
          );
          // Vaulting office furniture is free; only a field interaction costs a key.
          assert.ok(
            path.every((p) => p.action !== "door"),
            "Credentialed exits must not cost another key",
          );
        }
      }
    }
  }
});
test("loading older forward worlds preserves their existing geometry and ongoing state", () => {
  for (const version of [2, 3]) {
    const g = createGame(42, roadmap, undefined, { layout: "forward" });
    if (version === 3) redesign(g);
    const before = JSON.stringify(g.floors);
    assert.equal(g.floors[0].generation?.version, version);
    assert.equal(g.floors[0].boundary, undefined);
    const loaded = decode(encode(g));
    assert.equal(JSON.stringify(loaded.floors), before);
  }
  assert.equal(
    createPlayableGame(42, roadmap).floors[0].generation?.version,
    5,
  );
});

test("a pursuer can be drawn aside for actual terminal work inside the new study hall", () => {
  const scenario = emptyScenario();
  Object.assign(scenario, {
    template: "building",
    layout: "forward",
    rules: "force-fields",
    seed: 42,
    simulation: "game",
  });
  scenario.deleted = Array.from({ length: 19 }, (_, i) => `npc-${i}`);
  scenario.entities = [
    { id: "human", kind: "player", floor: 1, x: 40, y: 26 },
    { id: "worker", kind: "npc", x: 15.5, y: 22.5 },
    { id: "chaser", kind: "zombie", x: 19, y: 22.5 },
  ];
  const r = new TestRunner(scenario, roadmap),
    g = r.game,
    a = g.survivors[1],
    s = g.floors[0].stations
      .filter((s) => g.encounters[s.encounter].questionRoom === "f0-room2")
      .sort((a, b) => Math.abs(a.x - 15.5) - Math.abs(b.x - 15.5))[0],
    e = g.encounters[s.encounter];
  Object.assign(a, {
    x: s.x,
    y: s.y,
    intent: e.id,
    seen: [s.id],
    role: "analyst",
    risk: 0.8,
    thought: 20,
    studyLoopBlockedSince: -100,
    studyLoopCheckAt: 0,
  });
  Object.assign(g.zombies[0], { x: s.x + 3.5, y: s.y });
  let worked = false;
  for (let i = 0; i < 2700 && a.alive; i++) {
    step(g, 1 / 30);
    if (
      a.studyLoop?.phase === "work" &&
      a.station === s.id &&
      Math.hypot(a.x - s.x, a.y - s.y) < 1.3 &&
      e.npcProgress > 0
    )
      worked = true;
  }
  assert.ok(
    worked,
    "Physical progress under pursuit, rather than survival alone",
  );
  assert.equal(g.study.learner!.evidence.length, 0);
});

test("a blank arena remains a valid synthetic world when forward force-field rules are selected", () => {
  const s = emptyScenario();
  Object.assign(s, { layout: "forward", rules: "force-fields" });
  const r = new TestRunner(s, roadmap);
  assert.equal(r.game.floors[0].stations.length, 0);
  assert.equal(r.game.floors[0].furniture.length, 0);
});

test("seeds vary plan families, proportions, silhouettes, gates and terminal positions without breaking layout contracts", () => {
  const families = new Set<string>(),
    proportions = new Set<string>(),
    silhouettes = new Set<string>(),
    terminals = new Set<string>();
  let vertical = 0,
    horizontal = 0;
  for (const { g, f, seed } of floors64) {
    assert.deepEqual(pursuitLayoutErrors(g, f), [], `seed ${seed}/${f.index}`);
    families.add(f.generation!.family!);
    const sectors = floorSectors(f);
    proportions.add(
      JSON.stringify(
        sectors.map((s) => s.blocks.map((b) => [b.x2 - b.x1, b.y2 - b.y1])),
      ),
    );
    silhouettes.add(JSON.stringify(f.tiles));
    terminals.add(JSON.stringify(f.stations.map((s) => [s.x, s.y])));
    for (const o of chainFields(f)) {
      const upright = o.h === 3 && o.w === 1;
      assert.ok(
        upright || (o.w === 3 && o.h === 1),
        `${o.id} is not a 3-cell field`,
      );
      if (!o.field!.exit) continue;
      if (upright) vertical++;
      else horizontal++;
    }
    for (const sector of sectors.slice(1, 5)) {
      const stations = f.stations.filter(
        (s) =>
          g.encounters[s.encounter].questionRoom === `f${f.index}-${sector.id}`,
      );
      for (let i = 0; i < stations.length; i++) {
        const a = stations[i];
        assert.equal(sectorAt(f, a)?.id, sector.id, `${a.id} in its sector`);
        for (const b of stations.slice(i + 1))
          assert.ok(
            Math.hypot(a.x - b.x, a.y - b.y) >= 1.4,
            "usable spacing between solo terminals",
          );
      }
    }
  }
  assert.deepEqual(
    [...families].sort(),
    ["columns", "serpentine", "stack"],
    "all three plan families occur",
  );
  assert.ok(vertical > 0, "no vertical forward gate");
  assert.ok(horizontal > 0, "no horizontal forward gate");
  assert.ok(proportions.size >= 100, `only ${proportions.size} proportions`);
  assert.ok(silhouettes.size >= 200, `only ${silhouettes.size} silhouettes`);
  assert.ok(
    terminals.size >= 200,
    `only ${terminals.size} terminal arrangements`,
  );
});

test("forward fields carry exit rules, their quota and a free pass facing the previous sector", () => {
  for (const { f, seed } of floors64) {
    const sectors = floorSectors(f);
    for (const o of chainFields(f)) {
      const [minus, plus] = sides(f, o),
        previous = Math.min(minus, plus);
      if (previous === 0) {
        assert.equal(o.field!.publicEntry, true);
        continue;
      }
      const room = sectors[previous].room!;
      assert.equal(o.id, `f${f.index}-room${room}-forward`);
      assert.equal(o.field!.exit, true);
      assert.equal(o.field!.limit, 3 + ((seed + f.index + room) % 3));
      const axis = o.h >= o.w ? "x" : "y";
      // The cell one step against the free-pass direction is the previous sector.
      const behind = { x: o.x, y: o.y };
      behind[axis] -= o.field!.direction ?? 0;
      assert.equal(
        sectorAt(f, behind)?.order,
        previous,
        `seed ${seed} floor ${f.index}: ${o.id} free pass faces away`,
      );
      assert.equal(o.field!.direction, minus === previous ? 1 : -1);
      assert.deepEqual(sectors[previous].gate, { x: o.x, y: o.y });
      assert.deepEqual(f.rooms![room].forwardExit, { x: o.x, y: o.y });
    }
  }
});

test("sub-rooms are walled dead ends with one 2-cell doorway and a catalogued size", () => {
  const kinds = new Set<string>();
  let study = 0,
    furnished = 0;
  for (const { f, seed } of floors64)
    for (const sector of floorSectors(f)) {
      if (sector.room === undefined) {
        assert.equal(sector.rooms.length, 0, `${sector.id} has no sub-rooms`);
        continue;
      }
      study++;
      if (sector.rooms.length) furnished++;
      if (sector.id === "room2") assert.ok(sector.rooms.length <= 2);
      for (const room of sector.rooms) {
        const where = `seed ${seed} floor ${f.index} ${room.id}`;
        const { rect, doorway } = room;
        kinds.add(room.kind);
        assert.ok(room.kind in SUB_ROOM_SIZES);
        assert.ok(
          sizeFits(room.kind, rect.x2 - rect.x1 + 1, rect.y2 - rect.y1 + 1),
          `${where}: size`,
        );
        assert.equal(
          (doorway.x2 - doorway.x1 + 1) * (doorway.y2 - doorway.y1 + 1),
          2,
        );
        const openRing: Point[] = [];
        for (let y = rect.y1 - 1; y <= rect.y2 + 1; y++)
          for (let x = rect.x1 - 1; x <= rect.x2 + 1; x++) {
            if (inRect(rect, x, y))
              assert.equal(f.tiles[y][x], 0, `${where}: interior ${x},${y}`);
            else if (!f.tiles[y][x]) openRing.push({ x, y });
          }
        assert.deepEqual(
          openRing,
          [
            { x: doorway.x1, y: doorway.y1 },
            { x: doorway.x2, y: doorway.y2 },
          ],
          `${where}: walls other than the doorway`,
        );
      }
    }
  assert.deepEqual([...kinds].sort(), [
    "break",
    "meeting",
    "office",
    "storage",
  ]);
  assert.ok(
    furnished >= 0.4 * study,
    `only ${furnished}/${study} study sectors have sub-rooms`,
  );
});

/** A cell inside some fully open 2x2 square: a body can pass with room. */
function wide(f: Floor, x: number, y: number) {
  const open = (cx: number, cy: number) => f.tiles[cy]?.[cx] === 0;
  return [
    [-1, -1],
    [-1, 0],
    [0, -1],
    [0, 0],
  ].some(
    ([dx, dy]) =>
      open(x + dx, y + dy) &&
      open(x + dx + 1, y + dy) &&
      open(x + dx, y + dy + 1) &&
      open(x + dx + 1, y + dy + 1),
  );
}
test("each sector's gates, doorways and terminals are joined by wide circulation", () => {
  for (const { g, f, seed } of floors64) {
    const b = f.boundary!,
      fields = chainFields(f);
    const gate = (k: number) =>
      fields.find((o) => [...sides(f, o)].sort().join() === `${k},${k + 1}`)!;
    const front = (o: Furniture, order: number): Point => {
      const x = Math.floor(o.x),
        y = Math.floor(o.y);
      const options =
        o.h > o.w
          ? [
              { x: x - 1, y },
              { x: x + 1, y },
            ]
          : [
              { x, y: y - 1 },
              { x, y: y + 1 },
            ];
      return options.find((p) => owner(f, p.x, p.y) === order)!;
    };
    for (const sector of floorSectors(f)) {
      const k = sector.order,
        where = `seed ${seed} floor ${f.index} ${sector.id}`;
      const start =
        k === 0 ? { x: 21, y: b.bottom - 1 } : front(gate(k - 1), k);
      const seen = new Set<number>(),
        queue = [start];
      for (let i = 0; i < queue.length; i++) {
        const { x, y } = queue[i];
        if (seen.has(y * W + x) || owner(f, x, y) !== k || !wide(f, x, y))
          continue;
        seen.add(y * W + x);
        queue.push(
          { x: x + 1, y },
          { x: x - 1, y },
          { x, y: y + 1 },
          { x, y: y - 1 },
        );
      }
      const at = (p: Point) => seen.has(Math.floor(p.y) * W + Math.floor(p.x));
      assert.ok(at(k === 5 ? { x: 21, y: b.top } : front(gate(k), k)), where);
      for (const room of sector.rooms)
        assert.ok(
          at({ x: room.doorway.x1, y: room.doorway.y1 }) &&
            at({ x: room.doorway.x2, y: room.doorway.y2 }),
          `${where}: doorway of ${room.id}`,
        );
      for (const s of f.stations)
        if (
          g.encounters[s.encounter].questionRoom === `f${f.index}-${sector.id}`
        )
          assert.ok(at(s), `${where}: terminal ${s.id}`);
    }
  }
});

test("historical stage floors are read as four band sectors plus two lobbies with gates", () => {
  const g = createGame(42, roadmap, undefined, { layout: "forward" });
  redesign(g);
  const f = g.floors[1],
    stages = f.generation!.stages!;
  const sectors = floorSectors(f);
  assert.deepEqual(
    sectors.map((s) => s.id),
    ["entry", ...stages.map((s) => `room${s.room}`), "lobby"],
  );
  assert.deepEqual(sectors[0].gate, f.doors[2]);
  for (const [i, stage] of stages.entries()) {
    const s = sectors[i + 1];
    assert.equal(s.room, stage.room);
    assert.deepEqual(s.blocks, [
      { x1: 2, y1: stage.front + 1, x2: 41, y2: stage.rear - 1 },
    ]);
    // Every band, including the last one, carries its gate into the next sector.
    assert.deepEqual(s.gate, f.rooms![stage.room].forwardExit);
    assert.ok(s.gate);
  }
  assert.equal(sectors[5].gate, undefined);
  assert.equal(sectors[5].blocks[0].y2, stages.at(-1)!.front - 1);
  const st = f.stations[0];
  assert.equal(sectorAt(f, st)?.blocks[0].y1, sectorBoundsY(f, st));
});
function sectorBoundsY(f: Floor, p: Point) {
  const y = Math.floor(p.y);
  return (
    f.generation!.stages!.find((s) => y > s.front && y < s.rear)!.front + 1
  );
}

test("office furniture replays from the seed alone", () => {
  for (const seed of [3, 42]) {
    const g = createPlayableGame(seed, roadmap);
    for (const f of g.floors.slice(0, 4)) {
      const copy = structuredClone(f);
      copy.furniture = copy.furniture.filter((o) => o.field);
      furnishOffice(
        copy,
        pursuitOfficeZones(copy),
        fieldClearance(copy),
        copy.entry,
        g.seed,
        copy.furniture.filter((o) => /-room\d-door$/.test(o.id)),
      );
      assert.deepEqual(copy.furniture, f.furniture, `seed ${seed}`);
      assert.deepEqual(copy.office, f.office);
      assert.ok(f.furniture.length > 20, "floors are furnished");
    }
  }
});

/** Wall runs of n cells between sectors a and b, away from existing fields. */
function wallRuns(f: Floor, a: number, b: number, n: number) {
  const out: { x: number; y: number; vertical: boolean }[] = [];
  const fields = chainFields(f);
  const free = (x: number, y: number) =>
    f.tiles[y]?.[x] === 1 &&
    owner(f, x, y) < 0 &&
    fields.every((o) => Math.hypot(x + 0.5 - o.x, y + 0.5 - o.y) > 4);
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++)
      for (const vertical of [false, true]) {
        let ok = true;
        for (let i = 0; i < n && ok; i++) {
          const cx = vertical ? x : x + i,
            cy = vertical ? y + i : y;
          const pair = vertical
            ? [owner(f, cx - 1, cy), owner(f, cx + 1, cy)]
            : [owner(f, cx, cy - 1), owner(f, cx, cy + 1)];
          ok = free(cx, cy) && pair.sort().join() === `${a},${b}`;
        }
        if (ok) out.push({ x, y, vertical });
      }
  return out;
}
test("generation validation rejects bypasses, extra openings, broken rooms, inaccessible terminals and insufficient free study capacity", () => {
  const g = createPlayableGame(42, roadmap),
    f = g.floors[0];
  const saved = structuredClone(f);
  const restore = () => Object.assign(f, structuredClone(saved));
  assert.deepEqual(pursuitLayoutErrors(g, f), []);
  // An uncovered hole in a sector wall.
  const hole = wallRuns(f, 1, 2, 1)[0];
  assert.ok(hole, "a plain wall between the hall and the next sector");
  f.tiles[hole.y][hole.x] = 0;
  assert.ok(pursuitLayoutErrors(g, f).some((s) => s.includes("opening")));
  restore();
  assert.deepEqual(pursuitLayoutErrors(g, f), []);
  // A second, covered opening between the same sectors is a walk-around.
  const run = wallRuns(f, 1, 2, 3)[0];
  assert.ok(run, "a 3-cell wall run between the hall and the next sector");
  for (let i = 0; i < 3; i++)
    f.tiles[run.vertical ? run.y + i : run.y][
      run.vertical ? run.x : run.x + i
    ] = 0;
  const forward = f.furniture.find((o) => o.id === "f0-room2-forward")!;
  f.furniture.push({
    ...structuredClone(forward),
    id: "f0-room2-second",
    x: run.vertical ? run.x + 0.5 : run.x + 1.5,
    y: run.vertical ? run.y + 1.5 : run.y + 0.5,
    w: run.vertical ? 1 : 3,
    h: run.vertical ? 3 : 1,
  });
  assert.ok(
    pursuitLayoutErrors(g, f).includes("sectors 1/2 share 2 fields"),
    JSON.stringify(pursuitLayoutErrors(g, f)),
  );
  restore();
  // An opening between non-consecutive sectors or outside the shell.
  const boundary = f.boundary!;
  for (let y = boundary.top; y < boundary.bottom; y++) f.tiles[y][1] = 0;
  for (const y of [boundary.bottom - 2, boundary.top + 1])
    for (let x = 1; x <= boundary.rows[y].left; x++) f.tiles[y][x] = 0;
  assert.ok(pursuitLayoutErrors(g, f).some((s) => s.includes("bypass")));
  restore();
  // A forward field whose free pass faces the wrong way.
  const flipped = f.furniture.find((o) => o.id === "f0-room2-forward")!;
  flipped.field!.direction = -flipped.field!.direction!;
  assert.ok(
    pursuitLayoutErrors(g, f).includes(
      "forward field f0-room2-forward has wrong rules",
    ),
  );
  restore();
  Object.assign(f.stations[1], { x: f.stations[0].x, y: f.stations[0].y });
  assert.ok(
    pursuitLayoutErrors(g, f).some((s) => s.includes("overlapping study")),
  );
  restore();
  f.stations[0].x = 0.5;
  assert.ok(pursuitLayoutErrors(g, f).some((s) => s.includes("egress")));
  restore();
  f.stations = f.stations.filter(
    (s) => g.encounters[s.encounter].questionRoom !== "f0-room2",
  );
  assert.ok(pursuitLayoutErrors(g, f).some((s) => s.includes("zero-key")));
  restore();
  assert.deepEqual(pursuitLayoutErrors(g, f), []);
});

test("validation rejects a sub-room with a second doorway", () => {
  const found = floors64.find(({ f }) =>
    floorSectors(f).some((s: Sector) => s.rooms.length && s.room !== 2),
  )!;
  const g = structuredClone(found.g),
    f = g.floors[found.f.index];
  const room = floorSectors(f).find((s) => s.rooms.length && s.room !== 2)!
    .rooms[0];
  assert.deepEqual(pursuitLayoutErrors(g, f), []);
  // Open the ring cell opposite the doorway's first cell.
  const { rect, doorway } = room;
  const cell =
    doorway.y1 === doorway.y2
      ? {
          x: doorway.x1,
          y: doorway.y1 > rect.y2 ? rect.y1 - 1 : rect.y2 + 1,
        }
      : {
          x: doorway.x1 > rect.x2 ? rect.x1 - 1 : rect.x2 + 1,
          y: doorway.y1,
        };
  f.tiles[cell.y][cell.x] = 0;
  assert.ok(
    pursuitLayoutErrors(g, f).some((s) =>
      s.includes(`sub-room ${room.id} needs exactly one 2-cell doorway`),
    ),
    JSON.stringify(pursuitLayoutErrors(g, f)),
  );
});

test("the vertical-gate lab fixture's ground floor really has a vertical forward gate", () => {
  const r = new TestRunner(
    JSON.parse(
      readFileSync(
        "tests/fixtures/gametest/office-plan-vertical-gate.json",
        "utf8",
      ),
    ),
    roadmap,
  );
  const f = r.game.floors[0];
  assert.equal(f.generation?.version, 5);
  const upright = f.furniture.filter(
    (o) => o.field?.exit && o.w === 1 && o.h === 3,
  );
  assert.ok(upright.length >= 1, "no vertical forward gate on floor 0");
  assert.deepEqual(pursuitLayoutErrors(r.game, f), []);
});
