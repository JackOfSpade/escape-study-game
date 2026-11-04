import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DOOR_SWING, doorFrame, doorPose, ensureDoor } from "../src/doors";
import { pushFurniture, rotate, step } from "../src/engine";
import type { Roadmap, Zombie } from "../src/model";
import { CONFIG, distance } from "../src/model";
import { routePose, survivorPath, walkSegment } from "../src/navigation";
import { canPlace, inFurniture, solid } from "../src/spatial";
import { actor, createGame } from "../src/world";
const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
function quiet(seed = 11) {
  const g = createGame(seed, r);
  g.status = "playing";
  g.survivors[0].escaped = true;
  g.survivors = g.survivors.slice(0, 2);
  g.nextSpawn = Number.MAX_SAFE_INTEGER;
  g.spawned = CONFIG.openingHorde;
  g.nextSpawn = 999999;
  return g;
}
const zombie = (id: string, x: number, y: number): Zombie => ({
  id,
  x,
  y,
  floor: 0,
  hp: 60,
  path: [],
  repath: 0,
  cooldown: 0,
  memory: 0,
  stagger: 0,
  origin: "outside",
});

test("survivor navigation: a barricaded room uses a complete vault across the doorway instead of repeated lengthwise jumps", () => {
  const g = quiet(),
    f = g.floors[0],
    a = g.survivors[1],
    door = f.furniture.find((o) => o.id === "f0-room0-door")!,
    shelf = f.furniture.find((o) => o.id === "f0-room0-shelf5")!;
  door.open = true;
  shelf.x = 16.708;
  Object.assign(a, {
    x: 15.5,
    y: door.y,
    access: [0],
    role: "analyst",
    path: [],
  });
  const route = survivorPath(f, a, f.stairs);
  const traversal = route.find((p) => p.action === "vault");
  assert.equal(traversal?.obstacle, shelf.id);
  assert.ok(traversal!.x > 17);
  for (let i = 0; i < 300 && a.floor === 0; i++) step(g, 0.1);
  assert.equal(
    a.floor,
    1,
    "actor physically vaults and reaches the upstairs landing",
  );
  const jumps = g.events.filter((e) => e.type === "vault" && e.actor === a.id);
  assert.equal(jumps.length, 1, "no endless back-and-forth vaults");
});

test("survivor navigation: a closed door is a reachable exploration goal and opens through actual interaction", () => {
  const g = quiet(),
    a = g.survivors[1],
    f = g.floors[0],
    door = f.furniture.find((o) => o.id === "f0-room0-door")!;
  Object.assign(a, {
    x: 20.5,
    y: door.y,
    role: "analyst",
    target: { x: door.x, y: door.y },
  });
  const route = survivorPath(f, a, door);
  assert.ok(route.some((p) => p.action === "door" && p.obstacle === door.id));
  for (let i = 0; i < 150 && !door.open; i++) step(g, 0.1);
  assert.equal(door.open, true);
  assert.ok(g.events.some((e) => e.type === "door" && e.actor === a.id));
});

test("survivor navigation: generated station routes respect actor clearance, walls, other furniture and bounded valid traversals", () => {
  for (const seed of [1, 11, 42]) {
    const g = createGame(seed, r);
    for (const f of g.floors)
      for (const station of f.stations) {
        const route = survivorPath(f, f.entry, station);
        assert.ok(route.length, `seed ${seed} ${station.id}`);
        let from = f.entry;
        for (const p of route) {
          assert.equal(solid(f, p, 0.22, p.obstacle), false);
          if (p.action) {
            const o = f.furniture.find((o) => o.id === p.obstacle)!;
            assert.ok(o);
            assert.ok(distance(from, p) <= 4.7);
            assert.ok(
              inFurniture({ x: (from.x + p.x) / 2, y: (from.y + p.y) / 2 }, o),
            );
          }
          assert.ok(
            walkSegment(f, from, p, p.obstacle),
            `invalid segment ${station.id} ${JSON.stringify({ from, p })}`,
          );
          from = p;
        }
      }
  }
});

test("outside arrivals never overlap and the horde physically enters instead of jamming at its spawn", () => {
  const g = quiet();
  g.survivors = g.survivors.slice(0, 1);
  g.spawned = 0;
  g.nextSpawn = 0;
  const closedGate = g.floors[0].furniture.find((o) => o.id === "main-gate")!;
  closedGate.hp = 4;
  for (let i = 0; i < 1200; i++) {
    step(g, 0.1);
    for (const z of g.zombies)
      for (const other of g.zombies)
        if (z !== other && z.floor === other.floor && z.hp > 0 && other.hp > 0)
          assert.ok(distance(z, other) >= 0.429, `overlap ${z.id}/${other.id}`);
  }
  assert.ok(g.zombies.some((z) => z.floor > 0 || z.y < 24));
  assert.ok(
    g.spawned <= Math.ceil(g.time / CONFIG.spawnInterval) * CONFIG.openingBatch,
  );
});

test("legacy overlapping zombies separate by contact correction and bounded walking while preserving wall collision", () => {
  const g = quiet();
  g.survivors = g.survivors.slice(0, 1);
  g.zombies = [
    zombie("z0", 21.5, 32.5),
    zombie("z1", 21.5, 32.5),
    zombie("z2", 21.7, 32.5),
  ];
  for (let i = 0; i < 100; i++) {
    const before = g.zombies.map((z) => ({ ...z }));
    step(g, 0.1);
    g.zombies.forEach((z, j) => {
      const overlap = before.some(
        (other, k) => k !== j && distance(before[j], other) < 0.52,
      );
      assert.ok(
        distance(z, before[j]) <=
          CONFIG.zombieSpeed * 0.1 + (overlap ? 0.52 : 0) + 0.015,
      );
      assert.equal(solid(g.floors[0], z), false);
    });
  }
  for (const z of g.zombies)
    for (const other of g.zombies)
      if (z !== other) assert.ok(distance(z, other) >= 0.495);
});

test("an NPC can recover after eight simulated mistakes instead of exhausting a fixed milestone bank", () => {
  const g = quiet(),
    a = g.survivors[1],
    e = g.encounters["f0-room1"],
    st = g.floors[0].stations.find((s) => s.encounter === e.id)!;
  Object.assign(a, {
    ...st,
    intent: e.id,
    role: "analyst",
    station: st.id,
    thought: 230,
    milestone: 8,
  });
  e.owner = a.id;
  e.state = "in-progress";
  e.npcProgress = 0.95;
  for (let i = 0; i < 500; i++) {
    if (g.encounters[e.id].state === "consumed") break;
    step(g, 0.1);
  }
  assert.equal(e.state, "consumed");
  assert.equal(g.study.learner!.evidence.length, 0);
});

test("contact-limited damage: a queue behind one attacker cannot reach through its body to hit the same barricade", () => {
  function fixture(n: number) {
    const g = quiet();
    g.survivors = g.survivors.slice(0, 1);
    const f = g.floors[0];
    f.tiles = Array.from({ length: 34 }, () => Array(44).fill(1));
    for (let y = 2; y < 33; y++) f.tiles[y][20] = 0;
    f.stairs = { x: 20.5, y: 3.5 };
    f.furniture = [
      {
        id: "contact",
        floor: 0,
        x: 20.5,
        y: 10.5,
        w: 1,
        h: 1,
        kind: "fridge",
        hp: 2100,
        maxHp: 2100,
        speed: 0.38,
        rotation: 0,
        destroyed: false,
        movers: [],
        moved: 0,
        credited: [],
        turning: 0,
      },
    ];
    g.zombies = Array.from({ length: n }, (_, i) =>
      zombie(`z${i}`, 20.5, 11.3 + i * 0.46),
    );
    // Pressure is driven by an audible source at the near face, rather than
    // knowledge of the hidden stairs beyond this opaque barricade.
    g.effects.push({
      kind: "decoy",
      floor: 0,
      x: 20.5,
      y: 11.25,
      radius: 10,
      until: g.time + 20,
    });
    return g;
  }
  const single = fixture(1),
    queue = fixture(30);
  for (let i = 0; i < 200; i++) {
    step(single, 0.1);
    step(queue, 0.1);
  }
  assert.equal(
    single.floors[0].furniture[0].hp,
    queue.floors[0].furniture[0].hp,
  );
  assert.ok(single.floors[0].furniture[0].hp < 2100);
});

test("a defender can fortify a full shared room without a terminal seat; a closed door does not hide its second-layer contribution", () => {
  const g = quiet(),
    f = g.floors[0],
    e = g.encounters["f0-room0"],
    builder = g.survivors[1];
  const door = f.furniture.find((o) => o.id === "f0-room0-door")!,
    shelf = f.furniture.find((o) => o.id === "f0-room0-shelf5")!;
  door.open = false;
  Object.assign(builder, {
    x: shelf.x - 1.2,
    y: shelf.y,
    intent: e.id,
    role: "builder",
    station: undefined,
  });
  const stations = f.stations.filter((s) => s.encounter === e.id);
  for (const [i, st] of stations.entries()) {
    const seated = actor(`seated-${i}`, `fixture ${i}`, i);
    Object.assign(seated, {
      x: st.x,
      y: st.y,
      intent: e.id,
      station: st.id,
      role: "analyst",
      activity: "studying",
    });
    g.survivors.push(seated);
  }
  for (let i = 0; i < 180 && !e.contributors.includes(builder.id); i++)
    step(g, 0.1);
  assert.ok(e.contributors.includes(builder.id));
  assert.ok(shelf.moved >= 0.8);
  assert.equal(shelf.hp, shelf.maxHp, "helpers create no durability bonus");
  assert.equal(
    builder.station,
    undefined,
    "defense does not require stealing a study station",
  );
  assert.ok(
    builder.x < shelf.x,
    "defender pushes from the protected room side",
  );
  assert.ok(
    g.events.some(
      (event) => event.type === "defense" && event.actor === builder.id,
    ),
  );
});

test("arriving NPCs release the physical entrance through interaction, with no timed closure", () => {
  const g = createGame(11, r);
  g.status = "playing";
  g.survivors[0].escaped = true;
  const arrivals = g.survivors
    .slice(1)
    .filter((a) => a.y > 28)
    .map((a) => a.id);
  const gate = g.floors[0].furniture.find((o) => o.id === "main-gate")!;
  let released = false,
    swung = false;
  for (let i = 0; i < 90; i++) {
    step(g, 0.1);
    released ||= gate.door?.latched === false;
    swung ||= Math.abs(gate.angle ?? 0) > 0.1;
  }
  assert.ok(released);
  assert.equal(gate.hp, 600);
  assert.ok(swung);
  assert.ok(
    g.events.some((e) => e.type === "door" && e.actor?.startsWith("npc-")),
  );
  assert.ok(
    g.survivors.some((a) => arrivals.includes(a.id) && a.y < 28),
    "outside arrivals actually pass the physical leaf",
  );
  assert.ok(
    g.survivors.every((a) => a.exploringDoor?.id !== "main-gate"),
    "outside is not a study exploration goal",
  );
  assert.equal(g.events.filter((e) => e.type === "entrance-close").length, 0);
});

test("defense rewards cannot be farmed by late touching or returning an initially sealing object to its old place", () => {
  const g = quiet(),
    f = g.floors[0],
    a = g.survivors[1],
    e = g.encounters["f0-room0"],
    shelf = f.furniture.find((o) => o.id === "f0-room0-shelf5")!;
  Object.assign(a, {
    x: shelf.x - 1.2,
    y: shelf.y,
    intent: e.id,
    role: "builder",
  });
  for (let i = 0; i < 180 && !e.contributors.includes(a.id); i++) step(g, 0.1);
  assert.ok(e.contributors.includes(a.id));
  const late = g.survivors[0];
  Object.assign(late, {
    escaped: false,
    x: shelf.x - 1.2,
    y: shelf.y,
    handling: shelf.id,
  });
  pushFurniture(g, late, -1, 0, 0.1);
  assert.equal(e.contributors.includes(late.id), false);
  assert.equal(g.study.learner!.evidence.length, 0);
  const fresh = quiet(),
    ff = fresh.floors[0],
    actor = fresh.survivors[1],
    ee = fresh.encounters["f0-room0"],
    oo = ff.furniture.find((o) => o.id === "f0-room0-shelf5")!;
  Object.assign(oo, {
    x: 16.4,
    initial: { x: 16.4, y: oo.y, w: oo.w, h: oo.h },
  });
  Object.assign(actor, { x: oo.x - 1.2, y: oo.y, handling: oo.id });
  for (let i = 0; i < 35; i++) pushFurniture(fresh, actor, -1, 0, 0.1);
  for (let i = 0; i < 35; i++) pushFurniture(fresh, actor, 1, 0, 0.1);
  assert.equal(ee.contributors.includes(actor.id), false);
});

test("right-hand room defense finds a free handling position beside the nearby office shelf", () => {
  for (const seed of [11, 42, 1337]) {
    const g = quiet(seed),
      f = g.floors[0],
      a = g.survivors[1],
      e = g.encounters["f0-room3"],
      shelf = f.furniture.find((o) => o.id === "f0-room3-shelf5")!;
    Object.assign(a, { x: 36, y: 20.5, intent: e.id, role: "builder" });
    for (let i = 0; i < 250 && !e.contributors.includes(a.id); i++)
      step(g, 0.1);
    assert.ok(
      e.contributors.includes(a.id),
      `failed right-hand defense seed ${seed}`,
    );
    assert.ok(a.x > shelf.x);
    assert.equal(shelf.hp, shelf.maxHp);
  }
});

test("pursuit finishes the physical distance within a shared grid cell instead of freezing outside attack range", () => {
  const g = quiet(),
    a = g.survivors[1];
  Object.assign(a, { x: 20.2, y: 20.2, speed: 0 });
  g.zombies = [zombie("z0", 20.9, 20.9)];
  for (let i = 0; i < 8; i++) step(g, 0.1);
  assert.ok(a.hp < 100);
});

test("a narrow attack face keeps its contact slot through cooldown; alternating neighbors cannot multiply its damage", () => {
  function fixture(two: boolean) {
    const g = quiet();
    g.survivors = g.survivors.slice(0, 1);
    const f = g.floors[0];
    f.tiles = Array.from({ length: 34 }, () => Array(44).fill(1));
    for (let y = 2; y < 33; y++) f.tiles[y][20] = 0;
    f.stairs = { x: 20.5, y: 3.5 };
    f.furniture = [
      {
        id: "end-face",
        floor: 0,
        x: 20.5,
        y: 10.5,
        w: 1,
        h: 2.8,
        kind: "shelf",
        hp: 2600,
        maxHp: 2600,
        speed: 0.32,
        rotation: 0,
        destroyed: false,
        movers: [],
        moved: 0,
        credited: [],
        turning: 0,
      },
    ];
    g.zombies = [
      zombie("z0", 20.25, 12.2),
      ...(two ? [zombie("z1", 20.75, 12.2)] : []),
    ];
    return g;
  }
  const one = fixture(false),
    two = fixture(true);
  for (let i = 0; i < 200; i++) {
    step(one, 0.1);
    step(two, 0.1);
  }
  assert.equal(one.floors[0].furniture[0].hp, two.floors[0].furniture[0].hp);
});

test("a decisive rotation can earn defense access contribution without inventing movement distance or extra durability", () => {
  const g = quiet(),
    f = g.floors[0],
    a = g.survivors[1],
    e = g.encounters["f0-room0"],
    o = f.furniture.find((o) => o.id === "f0-room0-shelf5")!;
  Object.assign(o, {
    x: 16.4,
    w: 2.8,
    h: 1,
    moved: 0,
    initial: { x: 16.4, y: o.y, w: 2.8, h: 1 },
  });
  Object.assign(a, { x: 14.45, y: o.y });
  assert.equal(rotate(g, a), true);
  assert.ok(e.contributors.includes(a.id));
  assert.equal(o.moved, 0);
  assert.equal(o.hp, o.maxHp);
});

test("a broad barricade behind a one-tile mouth exposes only one sustained attack position", () => {
  function fixture(two: boolean) {
    const g = quiet();
    g.survivors = g.survivors.slice(0, 1);
    const f = g.floors[0];
    f.tiles = Array.from({ length: 34 }, () => Array(44).fill(0));
    for (let y = 0; y < 34; y++) f.tiles[y][20] = y === 15 ? 0 : 1;
    f.furniture = [
      {
        id: "inner-cover",
        floor: 0,
        x: 19.4,
        y: 15.5,
        w: 1,
        h: 2.8,
        kind: "shelf",
        hp: 2600,
        maxHp: 2600,
        speed: 0.32,
        rotation: 1,
        destroyed: false,
        movers: [],
        moved: 0,
        credited: [],
        turning: 0,
      },
    ];
    f.stairs = { x: 15.5, y: 15.5 };
    g.zombies = [
      zombie("z0", 20.22, 15.25),
      ...(two ? [zombie("z1", 20.22, 15.75)] : []),
    ];
    return g;
  }
  const one = fixture(false),
    two = fixture(true);
  for (let i = 0; i < 200; i++) {
    step(one, 0.1);
    step(two, 0.1);
  }
  assert.equal(two.floors[0].furniture[0].hp, one.floors[0].furniture[0].hp);
});

test("moving a barricade into an NPC's committed doorway route invalidates it before another blocked step and the NPC exits", () => {
  const g = quiet(),
    f = g.floors[0],
    a = g.survivors[1],
    door = f.furniture.find((o) => o.id === "f0-room0-door")!,
    shelf = f.furniture.find((o) => o.id === "f0-room0-shelf5")!;
  door.open = true;
  Object.assign(a, {
    x: 15.5,
    y: door.y,
    access: [0],
    role: "analyst",
    path: [],
  });
  ensureDoor(door, f);
  Object.assign(door, doorPose(door, -DOOR_SWING));
  door.door!.side = -1;
  step(g, 1 / 30);
  assert.ok(a.routeGeometry);
  shelf.x = 16.708;
  shelf.y = doorFrame(door).y;
  assert.ok(canPlace(f, shelf, shelf));
  const before = { x: a.x, y: a.y };
  step(g, 1 / 30);
  const next = a.path[0];
  assert.ok(
    a.vault || !next || next.action || walkSegment(f, a, next),
    "next ordinary segment must reflect the moved barricade",
  );
  assert.ok(distance(before, a) <= a.speed / 30 + 1e-6);
  for (let i = 0; i < 900 && a.floor === 0; i++) step(g, 1 / 30);
  assert.equal(
    a.floor,
    1,
    "survivor crosses the barricade and physically climbs",
  );
  assert.equal(
    g.events.filter((e) => e.type === "vault" && e.actor === a.id).length,
    1,
  );
  assert.equal(g.study.learner!.evidence.length, 0);
});

test("a swinging door keeps the route graph until its swing changes routing", () => {
  const leaf = (angle: number, latched = false) =>
    ({
      id: "door",
      x: 10 + angle,
      y: 5 - angle,
      angle,
      door: { latched },
    }) as unknown as Parameters<typeof routePose>[0];
  // A leaf pushed through its near-closed arc is ignored by routing.
  assert.deepEqual(routePose(leaf(0.02)), routePose(leaf(0.45)));
  assert.deepEqual(routePose(leaf(-0.3)), routePose(leaf(0)));
  // A swung leaf is routed around at its exact pose.
  assert.notDeepEqual(routePose(leaf(0.45)), routePose(leaf(0.8)));
  assert.notDeepEqual(routePose(leaf(0.801)), routePose(leaf(0.805)));
  // Ordinary furniture still rebuilds on any move.
  const chair = (x: number) =>
    ({ id: "chair", x, y: 5 }) as unknown as Parameters<typeof routePose>[0];
  assert.notDeepEqual(routePose(chair(3)), routePose(chair(3.001)));
});
