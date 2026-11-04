import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { complete, step, toggleDoor } from "../src/engine";
import { fieldAllows, updateFields, SWARM } from "../src/force-fields";
import { TestRunner } from "../src/gametest/runner";
import { emptyScenario } from "../src/gametest/schema";
import { createPlayableGame } from "../src/world";
import { doorwayGoal } from "../src/exploration";
import { survivorPath } from "../src/navigation";
import { decode, encode } from "../src/persistence";
import { CONFIG, type Roadmap } from "../src/model";
import { sectorAt } from "../src/floor-plan";
const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
const fixture = (id: string) =>
  new TestRunner(
    JSON.parse(readFileSync(`tests/fixtures/gametest/${id}.json`, "utf8")),
    roadmap,
  );

test("fresh worlds have fields, movable office furniture clear of every opening, independent solo stations, keys and no equipment", () => {
  for (const seed of [1, 42, 2682889803]) {
    const g = createPlayableGame(seed, roadmap);
    for (const f of g.floors) {
      const fields = f.furniture.filter((o) => o.field);
      assert.ok(fields.every((o) => !o.door));
      for (const o of f.furniture.filter((o) => !o.field)) {
        assert.match(
          o.id,
          /^f\d-(room\d(?:[bc]|r\d+)?|(?:entry|lobby)[bc]?)-[a-z]+\d+-/,
        );
        assert.ok(o.speed > 0 && o.hp === o.maxHp, o.id);
        // No piece can seal or crowd a field opening.
        for (const field of fields)
          assert.ok(
            Math.abs(o.x - field.x) > field.w / 2 + 1 ||
              Math.abs(o.y - field.y) > field.h / 2 + 1,
            `${o.id} near ${field.id}`,
          );
      }
    }
    assert.ok(
      g.floors
        .slice(0, 4)
        .every((f) => f.furniture.filter((o) => !o.field).length >= 10),
    );
    const stations = g.floors.flatMap((f) => f.stations);
    assert.equal(
      new Set(stations.map((s) => s.encounter)).size,
      stations.length,
    );
    assert.ok(
      Object.values(g.encounters).every(
        (e) => e.mode === "solo" && e.reward === "stairs" && !e.loot.length,
      ),
    );
    assert.ok(g.survivors.every((a) => a.keys === 0 && !a.inventory.length));
  }
});
test("keys are consumed once, never shared, and remain spent through save/restore", () => {
  const r = fixture("force-field-personal");
  const a = r.game.survivors[0],
    other = r.game.survivors[1],
    door = r.game.floors[0].furniture[0];
  assert.equal(fieldAllows(door, a), false);
  assert.ok(toggleDoor(r.game, a, door.id));
  assert.equal(a.keys, 0);
  assert.ok(toggleDoor(r.game, a, door.id));
  assert.equal(a.keys, 0);
  assert.equal(fieldAllows(door, other), false);
  const restored = decode(encode(r.game));
  assert.equal(restored.survivors[0].keys, 0);
  assert.ok(
    fieldAllows(restored.floors[0].furniture[0], restored.survivors[0]),
  );
});
test("merged forward opening consumes free passes on first touch, closes permanently and stays green with floor access", () => {
  const g = createPlayableGame(42, roadmap),
    a = g.survivors[0];
  const o = g.floors[0].furniture.find((o) => o.id === "f0-room2-forward")!;
  assert.equal(o.field!.exit, true);
  assert.ok([-1, 1].includes(o.field!.direction!));
  assert.ok(o.field!.limit! >= 3);
  o.field!.limit = 1;
  const f = o.field!;
  f.leaf = { open: 1, side: 1, hold: 30 };
  // Vertical openings cross along x, horizontal ones along y; the free pass is
  // granted to arrivals from the side opposite the field's direction.
  const axis = o.h >= o.w ? "x" : "y",
    d = f.direction!;
  const at = (offset: number) =>
    Object.assign(a, { x: o.x, y: o.y, [axis]: o[axis] + offset });
  assert.equal(fieldAllows(o, a), true, "free passes remain");
  at(-d * 1.2);
  updateFields(g);
  at(0);
  updateFields(g);
  assert.ok(f.crossing.includes(a.id));
  assert.equal(
    f.used,
    1,
    "The pass must be consumed before the survivor finishes crossing",
  );
  at(d * 1.2);
  updateFields(g);
  assert.equal(f.used, 1);
  assert.equal(fieldAllows(o, a), false);
  at(-d * 1.2);
  updateFields(g);
  at(d * 1.2);
  updateFields(g);
  assert.equal(f.used, 1);
  assert.ok(
    g.events.some((e) => e.type === "field-sealed"),
    "Reaching the quota seals the opening",
  );
  assert.equal(fieldAllows(o, a), false);
  // No alternate opening joins the same two sectors.
  const fl = g.floors[0];
  const joins = (other: typeof o) => {
    const ox = other.h >= other.w ? 1 : 0,
      oy = 1 - ox;
    return [-1, 1]
      .map(
        (s) =>
          sectorAt(fl, { x: other.x + s * ox, y: other.y + s * oy })?.order ??
          -1,
      )
      .sort()
      .join();
  };
  assert.equal(
    fl.furniture.filter((other) => other.field && joins(other) === joins(o))
      .length,
    1,
    "No alternate opening between the same sectors",
  );
  a.access.push(0);
  assert.ok(fieldAllows(o, a));
  updateFields(g);
  assert.equal(f.used, 1);
});
test("NPC routes exclude red fields when they have no key", () => {
  const r = fixture("force-field-personal"),
    g = r.game;
  const a = g.survivors[0],
    other = g.survivors[1];
  assert.ok(
    survivorPath(g.floors[0], a, { x: 16, y: 11.8 }).some(
      (p) => p.action === "door",
    ),
  );
  assert.equal(survivorPath(g.floors[0], other, { x: 16, y: 13.2 }).length, 0);
  assert.ok(toggleDoor(g, a, "field"));
  assert.ok(survivorPath(g.floors[0], a, { x: 16, y: 11.8 }).length);
});
test("solo completion grants a personal key and stair credential exactly once", () => {
  const g = createPlayableGame(42, roadmap),
    a = g.survivors[0],
    e = Object.values(g.encounters)[0];
  assert.ok(complete(g, e.id, "synthetic", [a.id], "synthetic test"));
  assert.equal(a.keys, 1);
  assert.ok(a.access.includes(0));
  assert.equal(g.survivors[1].keys, 0);
  assert.equal(complete(g, e.id, "synthetic", [a.id], "synthetic test"), false);
  assert.equal(a.keys, 1);
});
test("normal AI breaks green and red fields instead of walking through", () => {
  for (const forceField of ["green", "red"] as const) {
    const s = emptyScenario();
    Object.assign(s, {
      rules: "force-fields",
      simulation: "game",
      maxTicks: 300,
    });
    s.entities = [
      { id: "human", kind: "player", x: 15, y: 12.5 },
      { id: "attacker", kind: "zombie", x: 11.6, y: 12.5 },
      {
        id: "field",
        kind: "door",
        x: 12.5,
        y: 12.5,
        w: 1,
        h: 3,
        hp: 20,
        forceField,
      },
    ];
    s.maps = fixture("force-field-green").scenario.maps;
    s.checks = [
      {
        name: "Field is broken by a zombie",
        mode: "eventually",
        query: { type: "property", id: "field", field: "hp" },
        op: "lte",
        expected: 0,
      },
    ];
    const r = new TestRunner(s, roadmap),
      result = r.run();
    assert.equal(result.status, "passed", JSON.stringify(result));
    assert.ok(r.game.floors[0].furniture[0].destroyed);
  }
});
test("zombie motors cover half player distance, including during surges", () => {
  const s = emptyScenario();
  Object.assign(s, { rules: "force-fields", simulation: "game", maxTicks: 30 });
  s.entities = [
    { id: "human", kind: "player", x: 20, y: 12.5 },
    { id: "attacker", kind: "zombie", x: 10.5, y: 12.5 },
  ];
  const r = new TestRunner(s, roadmap);
  r.game.surge.state = "active";
  r.game.surge.started = 0;
  r.game.surge.duration = 100;
  for (let i = 0; i < 30; i++)
    step(r.game, 1 / 30, { x: 0, y: 0, grab: false });
  const travelled = r.game.zombies[0].x - 10.5;
  assert.ok(travelled > 1.5, `Zombie must actually pursue: ${travelled}`);
  assert.ok(travelled <= CONFIG.playerSpeed * SWARM.speedRatio + 0.01);
});
test("continuous spawning respects the living cap, removes dead bodies and replenishes beyond the opening horde", () => {
  const s = emptyScenario();
  Object.assign(s, {
    rules: "force-fields",
    simulation: "game",
    naturalSpawns: true,
    startTime: 10,
  });
  const r = new TestRunner(s, roadmap),
    g = r.game;
  g.zombies = Array.from({ length: SWARM.cap }, (_, i) => ({
    id: `cap-${i}`,
    floor: Math.floor(i / 120),
    x: 3.5 + (i % 20) * 1.1,
    y: 5.5 + Math.floor((i % 120) / 20) * 1.1,
    hp: 60,
    path: [],
    repath: 0,
    cooldown: 0,
    memory: 0,
    stagger: 10,
    origin: "outside" as const,
  }));
  g.spawned = 10000;
  step(g, 1 / 30);
  assert.equal(g.zombies.length, SWARM.cap);
  assert.equal(g.spawned, 10000);
  for (const z of g.zombies.slice(0, 4)) z.hp = 0;
  g.nextSpawn = g.time;
  step(g, 1 / 30);
  assert.equal(g.zombies.length, SWARM.cap);
  assert.equal(g.spawned, 10004);
  assert.ok(g.zombies.every((z) => z.hp > 0));
});

test("swept first-touch order beats actor array order and rejects an overlapping later entrant", () => {
  const r = fixture("force-field-midway-rejection"),
    g = r.game;
  const [a, b] = g.survivors,
    o = g.floors[0].furniture[0];
  // Human is farther through at the end, but NPC touched first along its actual sweep.
  Object.assign(a, { x: 12.4, y: 11.8 });
  Object.assign(b, { x: 12.1, y: 13.2 });
  const before = new Map([
    [a.id, { x: 11.4, y: a.y }],
    [b.id, { x: 11.7, y: b.y }],
  ]);
  updateFields(g, before);
  assert.equal(o.field!.used, 1);
  assert.deepEqual(o.field!.crossing, [b.id]);
  assert.ok(a.x <= 11.73);
  assert.equal(b.x, 12.1);
  assert.equal(fieldAllows(o, a), false);
  assert.equal(fieldAllows(o, b), true);
});
test("legacy grace passes cannot bypass an exhausted red field", () => {
  const r = fixture("force-field-midway-rejection"),
    g = r.game;
  const o = g.floors[0].furniture[0];
  o.field!.used = 3;
  o.field!.crossing = g.survivors.map((a) => a.id);
  o.field!.sides = Object.fromEntries(g.survivors.map((a) => [a.id, -1]));
  updateFields(g);
  assert.equal(o.field!.used, 1);
  assert.deepEqual(o.field!.crossing, []);
  for (const a of g.survivors) {
    assert.ok(a.x <= 11.73);
    assert.equal(fieldAllows(o, a), false);
  }
});

test("zero-key floors retain a free study route and enough initial solo opportunities", () => {
  for (let seed = 1; seed <= 32; seed++) {
    const g = createPlayableGame(seed, roadmap),
      a = g.survivors[0];
    for (const f of g.floors.filter((f) => f.index < 4)) {
      a.floor = f.index;
      Object.assign(a, f.entry);
      const publicDoor = f.furniture.find((o) => o.field?.publicEntry)!;
      assert.ok(publicDoor);
      assert.equal(publicDoor.field!.limit, undefined);
      let capacity = 0;
      for (let room = 0; room < 4; room++) {
        const stations = f.stations.filter(
          (s) =>
            g.encounters[s.encounter].questionRoom ===
            `f${f.index}-room${room}`,
        );
        // The single opening a room is entered through: the public door for
        // room 2, otherwise the previous stage's merged forward field.
        const entry = f.doors[room];
        const door = f.furniture.find(
          (o) => o.field && o.x === entry.x && o.y === entry.y,
        )!;
        assert.ok(door, `seed ${seed} floor ${f.index} room ${room} entry`);
        assert.equal(door.field!.publicEntry === true, room === 2);
        capacity += Math.min(stations.length, door.field!.limit ?? Infinity);
        if (door.field!.limit !== undefined)
          door.field!.used = door.field!.limit;
      }
      assert.ok(
        capacity >= g.survivors.length,
        `seed ${seed}, floor ${f.index}: ${capacity}`,
      );
      const labs = f.stations.filter(
        (s) => g.encounters[s.encounter].questionRoom === `f${f.index}-room2`,
      );
      for (const s of labs) {
        const path = survivorPath(f, a, s);
        assert.ok(path.length, `seed ${seed}: ${s.id}`);
        assert.ok(
          path.every((p) => p.action !== "door"),
          `Free route must not need a key: ${s.id}`,
        );
      }
    }
  }
});

test("E denies zero-key survivors without starting a timed unlock", () => {
  const r = fixture("force-field-no-key"),
    g = r.game,
    o = g.floors[0].furniture[0];
  for (const a of g.survivors) {
    for (let i = 0; i < 5; i++) assert.equal(toggleDoor(g, a, o.id), false);
    assert.equal(a.keys, 0);
    assert.equal(fieldAllows(o, a), false);
  }
  assert.match(g.notice, /key required|one key required/i);
  assert.equal(r.run().status, "passed");
  assert.deepEqual(o.field!.authorized, []);
});
test("loading a pending retired hack clears it and preserves earned access and keys", () => {
  const g = createPlayableGame(42, roadmap),
    a = g.survivors[0],
    o = g.floors[0].furniture[0];
  a.keys = 1;
  o.field!.authorized.push(a.id);
  Object.assign(a, {
    hack: { door: o.id, elapsed: 7.9 },
    hackAttempts: { [o.id]: 1 },
    hackResult: { until: 99, text: "HACKING" },
    activity: "hacking",
  });
  g.notice = "Hacking: stay still";
  const restored = decode(encode(g)),
    b = restored.survivors[0];
  assert.equal(b.activity, "exploring");
  for (const field of ["hack", "hackAttempts", "hackResult"])
    assert.equal(field in b, false);
  assert.equal(b.keys, 1);
  assert.ok(fieldAllows(restored.floors[0].furniture[0], b));
  assert.doesNotMatch(restored.notice, /hack/i);
});

test("locked field endpoints and exploration cannot masquerade as usable hinged doors", () => {
  const r = fixture("force-field-explore-alternate"),
    g = r.game,
    a = g.survivors[1],
    f = g.floors[0],
    o = f.furniture.find((o) => o.id === "locked")!;
  assert.deepEqual(survivorPath(f, a, o), []);
  assert.equal(doorwayGoal(f, a, o), undefined);
  a.keys = 1;
  assert.ok(survivorPath(f, a, o).some((p) => p.action === "door"));
  assert.ok(doorwayGoal(f, a, o));
  assert.ok(toggleDoor(g, a, o.id));
  assert.equal(a.keys, 0);
  assert.ok(doorwayGoal(f, a, o));
  assert.equal(doorwayGoal(f, g.survivors[2], o), undefined);
});
test("restored unusable door pursuits are discarded and crowded NPCs take the green alternative", () => {
  const r = fixture("force-field-explore-alternate"),
    g = r.game;
  for (const a of g.survivors.slice(1)) {
    a.target = { x: 27.8, y: 24.5 };
    a.exploringDoor = { id: "locked", floor: 0, goal: { ...a.target } };
    a.path = [
      { x: 25.45, y: 24.5 },
      { x: 26.5, y: 24.5, action: "door", obstacle: "locked" },
    ];
  }
  r.game = decode(encode(g));
  r.advance(1);
  assert.ok(
    r.game.survivors.slice(1).every((a) => a.exploringDoor?.id !== "locked"),
  );
  assert.equal(r.run().status, "passed");
});
test("a quota exhausted during a cached approach reroutes the remaining zero-key crowd", () => {
  const r = fixture("force-field-explore-alternate"),
    g = r.game,
    o = g.floors[0].furniture.find((o) => o.id === "locked")!;
  Object.assign(o.field!, {
    limit: 1,
    used: 0,
    direction: 1,
    leaf: { open: 1, side: 1, hold: 30 },
  });
  Object.assign(g.survivors[0], { floor: 0, x: 26.5, y: 24.5 });
  for (const a of g.survivors.slice(1)) {
    a.target = { x: 27.8, y: 24.5 };
    a.exploringDoor = { id: o.id, floor: 0, goal: { ...a.target } };
    a.path = survivorPath(g.floors[0], a, a.target);
  }
  r.advance(1);
  assert.equal(o.field!.used, 1);
  assert.equal(r.run().status, "passed");
  assert.ok(g.survivors.slice(1).every((a) => a.keys === 0));
});
test("an inaccessible retained task gives way to a reachable study terminal", () => {
  const r = fixture("force-field-explore-alternate"),
    g = r.game,
    a = g.survivors[1];
  for (const b of g.survivors.slice(2)) b.escaped = true;
  const source = createPlayableGame(42, roadmap),
    questions = Object.values(source.encounters);
  const red = structuredClone(
      questions.find((e) => e.questionRoom === "f0-room3")!,
    ),
    green = structuredClone(
      questions.find((e) => e.questionRoom === "f0-room2")!,
    );
  g.encounters = { [red.id]: red, [green.id]: green };
  g.floors[0].stations = [
    { id: "red-task", encounter: red.id, x: 30, y: 24.5 },
    { id: "green-task", encounter: green.id, x: 15, y: 24.5 },
  ];
  Object.assign(a, {
    intent: red.id,
    station: "red-task",
    seen: ["red-task", "green-task"],
    taskSearch: { floor: 0, seen: 2, after: 0, station: "red-task" },
  });
  for (let i = 0; i < 240; i++) step(g, 1 / 30);
  assert.equal(a.intent, green.id);
  assert.equal(a.station, "green-task");
  assert.ok(a.x < 17);
  assert.equal(red.npcProgress, 0);
  assert.equal(a.keys, 0);
});
