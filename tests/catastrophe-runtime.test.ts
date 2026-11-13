import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  catastropheOrigin,
  catastropheTick,
  hazardAt,
} from "../src/catastrophe-runtime";
import { doorSideOf, ensureDoor, lockDoor } from "../src/doors";
import { step, toggleDoor } from "../src/engine";
import type {
  Behaviour,
  CatastrophePhase,
  CatastropheSpec,
  EscapeState,
  Omen,
} from "../src/escape-types";
import { TestRunner } from "../src/gametest/runner";
import { emptyScenario } from "../src/gametest/schema";
import { roomPowerAt } from "../src/interior-lighting";
import type { Furniture, Game, Roadmap } from "../src/model";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);

function spec(
  behaviours: Behaviour[],
  phases: CatastrophePhase[] = [
    {
      name: "onset",
      at: 0,
      behaviours: behaviours.map((_, i) => i),
      intensity: 1,
    },
  ],
  omens: Omen[] = [],
): CatastropheSpec {
  return {
    id: "test-catastrophe",
    title: "Test catastrophe",
    premise: "The building is failing.",
    origin: { areaId: "a" },
    behaviours,
    timeline: { graceSeconds: 0, phases },
    omens,
    publicStory: "Nothing to see.",
  };
}

function fixture(entities = [] as object[]) {
  const scenario = emptyScenario();
  scenario.entities = [
    { id: "human", kind: "player", x: 5.5, y: 12.5 },
    ...entities,
  ] as typeof scenario.entities;
  return new TestRunner(scenario, roadmap).game;
}

function attach(g: Game, catastrophe: CatastropheSpec) {
  (g as unknown as { escape: EscapeState }).escape = {
    catastrophe,
    roomPower: {},
    log: [],
    areas: { start: "a", current: "a", areas: {}, portals: [] },
  } as unknown as EscapeState;
}

function npc(g: Game, id: string) {
  return g.survivors.find((a) => a.id === id)!;
}

test("phases and omens are logged once at their scheduled times", () => {
  const g = fixture(),
    catastrophe = spec(
      [],
      [
        { name: "onset", at: 1, behaviours: [], intensity: 1 },
        { name: "spread", at: 5, behaviours: [], intensity: 1 },
      ],
      [
        {
          id: "flicker",
          text: "The lights stutter.",
          at: 2,
          areaId: "a",
          effect: "alarm",
        },
      ],
    );
  attach(g, catastrophe);
  g.time = 1;
  catastropheTick(g, 0.1);
  assert.deepEqual(
    g.escape!.log.filter((e) => e.kind === "phase").map((e) => e.phase),
    ["onset"],
  );
  g.time = 3;
  catastropheTick(g, 0.1);
  assert.equal(g.escape!.log.filter((e) => e.kind === "omen").length, 1);
  assert.equal(g.escape!.log.filter((e) => e.kind === "phase").length, 1);
  g.time = 5;
  catastropheTick(g, 0.1);
  assert.deepEqual(
    g.escape!.log.filter((e) => e.kind === "phase").map((e) => e.phase),
    ["onset", "spread"],
  );
});

test("a hazard front spreads, damages an NPC, and a latched door stops it", () => {
  const g = fixture([{ id: "victim", kind: "npc", x: 10.5, y: 12.5 }]),
    hazard: Behaviour = {
      kind: "hazard",
      medium: "smoke",
      spreadRate: 2,
      damagePerSecond: 10,
      blockedByClosedDoors: true,
      obscures: 0.5,
    };
  attach(g, spec([hazard]));
  const origin = catastropheOrigin(g),
    f = g.floors[0],
    doorX = Math.floor(origin.x) + 1,
    doorY = Math.floor(origin.y);
  for (let y = 0; y < f.tiles.length; y++)
    for (let x = 0; x < f.tiles[y]!.length; x++)
      if (x === doorX && y !== doorY) f.tiles[y]![x] = 1;
  const door = {
    id: "hazard-door",
    kind: "door",
    x: doorX + 0.5,
    y: doorY + 0.5,
    w: 0.2,
    h: 1.4,
    angle: 0,
    hp: 100,
    maxHp: 100,
  } as Furniture;
  ensureDoor(door, f);
  door.door!.latched = true;
  f.furniture.push(door);
  const victim = npc(g, "victim");
  victim.x = doorX + 2.5;
  victim.y = doorY + 0.5;
  g.time = 0;
  catastropheTick(g, 0.1);
  g.time = 2;
  catastropheTick(g, 1);
  assert.equal(victim.hp, 100, "the latched door holds the front back");
  door.door!.latched = false;
  g.time = 2.1;
  catastropheTick(g, 1);
  assert.ok(victim.hp < 100, "the front damages an NPC once the door opens");
});

test("makes-sound warns first, then damages only the noisy actor", () => {
  const g = fixture([
    { id: "noisy", kind: "npc", x: 8.5, y: 12.5 },
    { id: "quiet", kind: "npc", x: 12.5, y: 12.5 },
  ]);
  attach(
    g,
    spec([
      {
        kind: "perception-rule",
        trigger: "makes-sound",
        threshold: 5,
        effect: "damage",
        damagePerSecond: 10,
        warning: "whisper",
      },
    ]),
  );
  const noisy = npc(g, "noisy"),
    quiet = npc(g, "quiet");
  noisy.noiseLevel = 9;
  noisy.noiseUntil = 10;
  quiet.noiseLevel = 0;
  g.time = 0;
  catastropheTick(g, 1);
  assert.equal(noisy.hp, 100, "a new trigger only warns");
  g.time = 1.6;
  catastropheTick(g, 1);
  assert.equal(noisy.hp, 90);
  assert.equal(quiet.hp, 100);
});

test("a hunter spawns at onset and a killed hunter stays as a body", () => {
  const g = fixture();
  attach(
    g,
    spec([
      {
        kind: "hunter",
        body: { color: "#330000", scale: 1, silhouette: "humanoid" },
        count: 1,
        speed: 1,
        sightRange: 8,
        hearingWeight: 0.5,
        doors: "break",
        damage: 10,
        spawn: "single",
      },
    ]),
  );
  g.time = 0;
  catastropheTick(g, 0.1);
  const hunter = g.zombies.find((z) => z.hunter === 0);
  assert.ok(hunter, "a hunter is present at onset");
  hunter.hp = 0;
  g.time = 0.2;
  catastropheTick(g, 0.1);
  assert.equal(hunter.downAt, 0.2);
  assert.ok(g.zombies.includes(hunter), "the body is never removed");
});

test("an instant-death rule leaves a dead NPC in g.survivors with downAt", () => {
  const g = fixture([{ id: "doomed", kind: "npc", x: 8.5, y: 12.5 }]);
  attach(
    g,
    spec([
      {
        kind: "perception-rule",
        trigger: "makes-sound",
        threshold: 1,
        effect: "instant-death",
        warning: "ringing",
      },
    ]),
  );
  const doomed = npc(g, "doomed");
  doomed.noiseLevel = 5;
  doomed.noiseUntil = 20;
  g.time = 0;
  catastropheTick(g, 0.1);
  g.time = 2;
  catastropheTick(g, 0.1);
  assert.equal(doomed.alive, false);
  assert.equal(doomed.downAt, 2);
  assert.ok(g.survivors.includes(doomed));
});

test("a locked door refuses its locked side and opens from the other", () => {
  const g = fixture([
    { id: "inside", kind: "npc", x: 9.2, y: 12.5 },
    { id: "outside", kind: "npc", x: 11.8, y: 12.5 },
    {
      id: "locked-door",
      kind: "door",
      x: 10.5,
      y: 12.5,
      w: 0.2,
      h: 1.4,
      angle: 0,
    },
  ]);
  const door = g.floors[0].furniture.find((o) => o.id === "locked-door")!,
    inside = npc(g, "inside"),
    outside = npc(g, "outside");
  ensureDoor(door, g.floors[0]);
  lockDoor(door, doorSideOf(door, inside), "test", 0);
  assert.equal(
    toggleDoor(g, inside, door.id),
    false,
    "the locked face cannot open it",
  );
  assert.ok(door.lock, "refusal leaves the lock in place");
  assert.equal(toggleDoor(g, outside, door.id), true);
  assert.equal(door.lock, undefined);
});

test("roomPowerAt honours a loop override and otherwise the seeded plan", () => {
  const g = fixture();
  (g.floors[0] as unknown as { generation: unknown }).generation = {
    sectors: [
      {
        id: "entry",
        order: 0,
        blocks: [{ x1: 2, y1: 2, x2: 8, y2: 8 }],
        corridors: [],
        rooms: [],
      },
    ],
  };
  assert.equal(roomPowerAt(g, 0, 5, 5), "lit");
  (g as unknown as { escape: EscapeState }).escape = {
    roomPower: { "0:entry": "outage" },
  } as unknown as EscapeState;
  assert.equal(roomPowerAt(g, 0, 5, 5), "outage");
});

test("a non-escape game still spawns the legacy horde", () => {
  const g = fixture(),
    f = g.floors[0];
  for (const row of f.tiles) row.fill(0);
  g.time = 100;
  g.nextSpawn = 0;
  g.spawned = 0;
  step(g, 0.05);
  assert.ok(g.zombies.length > 0, "the horde still spawns without g.escape");
  assert.ok(g.zombies.every((z) => z.hunter === undefined));
});

test("a non-origin area game runs perception rules but no origin behaviours", () => {
  const g = fixture([{ id: "noisy", kind: "npc", x: 8.5, y: 12.5 }]);
  attach(
    g,
    spec(
      [
        {
          kind: "hunter",
          body: { color: "#330000", scale: 1, silhouette: "humanoid" },
          count: 1,
          speed: 1,
          sightRange: 8,
          hearingWeight: 0.5,
          doors: "break",
          damage: 10,
          spawn: "single",
        },
        {
          kind: "hazard",
          medium: "smoke",
          spreadRate: 2,
          damagePerSecond: 10,
          blockedByClosedDoors: true,
          obscures: 0.5,
        },
        {
          kind: "perception-rule",
          trigger: "makes-sound",
          threshold: 5,
          effect: "damage",
          damagePerSecond: 10,
          warning: "whisper",
        },
      ],
      [{ name: "onset", at: 0, behaviours: [0, 1, 2], intensity: 1 }],
      [
        {
          id: "flicker",
          text: "The lights stutter.",
          at: 1,
          areaId: "a",
          effect: "alarm",
        },
      ],
    ),
  );
  (g as Game & { areaId?: string }).areaId = "b";
  const noisy = npc(g, "noisy");
  noisy.noiseLevel = 9;
  noisy.noiseUntil = 10;
  const origin = catastropheOrigin(g);
  g.time = 0;
  catastropheTick(g, 0.1);
  g.time = 2;
  catastropheTick(g, 1);
  assert.equal(
    g.zombies.filter((z) => z.hunter !== undefined).length,
    0,
    "hunters only spawn where the catastrophe started",
  );
  assert.equal(
    g.escape!.log.filter((e) => e.kind === "omen").length,
    0,
    "omens only happen in the origin area",
  );
  assert.equal(
    hazardAt(g, origin.floor, origin.x, origin.y),
    0,
    "the hazard front does not spread outside its origin area",
  );
  assert.equal(noisy.hp, 90, "perception rules still apply in this area");
  assert.ok(
    g.escape!.log.every((e) => e.areaId === "b"),
    "runtime log entries carry this game's area id",
  );
});
