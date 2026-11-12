import assert from "node:assert/strict";
import test from "node:test";
import {
  buildArea,
  enterRegion,
  prefetchArea,
  registerArea,
  setAreaFactory,
  setAreaDesigner,
  setDesignedAreaFactory,
  setAreaRequest,
  takeAreaSwitch,
} from "../src/areas";
import type { AreaPortal, AreaStub, EscapeState } from "../src/escape-types";
import type { Actor, Game } from "../src/model";
import type { SavedRunDesign } from "../src/run-design-contract.mjs";

type AnyRecord = Record<string, unknown>;

function actor(overrides: AnyRecord = {}): Actor {
  return {
    id: "human",
    name: "Dana",
    hp: 80,
    inventory: [],
    keys: [3],
    floor: 0,
    x: 2,
    y: 2,
    ...overrides,
  } as unknown as Actor;
}

function areaGame(overrides: AnyRecord = {}): Game {
  return {
    id: "run-1",
    seed: 7,
    time: 120,
    status: "playing",
    survivors: [actor(), actor({ id: "npc-1", name: "Rook" })],
    floors: [
      {
        // A 40 x 30 open-terrain plan: a region's edge points are well defined.
        city: { bounds: { left: 0, right: 40, top: 0, bottom: 30 } },
        furniture: [{ id: "main-gate", x: 10, y: 30 }],
        entry: { x: 12, y: 30 },
        tiles: [],
      },
    ],
    study: { marker: "study" },
    settings: { marker: "settings" },
    ...overrides,
  } as unknown as Game;
}

function stub(overrides: Partial<AreaStub> = {}): AreaStub {
  return {
    id: "pad",
    name: "Landing pad",
    brief: "A frost-caked pad.",
    state: "ready",
    seed: 42,
    plan: { name: "Landing pad", premise: "A pad", rooms: [], people: [] },
    ...overrides,
  };
}

function portal(overrides: Partial<AreaPortal> = {}): AreaPortal {
  return {
    id: "p1",
    from: "bay",
    to: "pad",
    transition: "lift",
    at: { floor: 0, x: 4, y: 5 },
    label: "the pad hatch",
    ...overrides,
  };
}

function escapeState(overrides: AnyRecord = {}): EscapeState {
  return {
    areas: {
      start: "bay",
      current: "bay",
      areas: {
        bay: stub({
          id: "bay",
          name: "Rocket bay",
          brief: "The bay",
          seed: 1,
          plan: {
            name: "Rocket bay",
            premise: "The bay",
            rooms: [],
            people: [],
          },
        }),
        pad: stub(),
      },
      portals: [portal()],
    },
    areaStore: {},
    log: [],
    persona: { name: "Dana", role: "engineer", backstory: "" },
    voices: { playerGender: "female", player: "p", pa: "pa", npcs: {} },
    ...overrides,
  } as unknown as EscapeState;
}

function sourceGame(escape: EscapeState = escapeState()): Game {
  return areaGame({ escape });
}

/**
 * Portal records are gone from the player's path: these areas are regions, so
 * entering one means calling enterRegion with the region's id. Tests that used
 * to name a crossing now resolve it to the region it leads to.
 */
function enterPortal(g: Game, portalId: string) {
  const crossing = g.escape!.areas.portals.find(
    (candidate) => candidate.id === portalId,
  );
  assert.ok(crossing, `no crossing ${portalId}`);
  return enterRegion(g, crossing.to);
}

test("registerArea adds the stub and portal once", () => {
  const g = areaGame({ escape: escapeState() });
  const escape = g.escape!;
  const extra = stub({ id: "roof", name: "Roof" });
  const door = portal({ id: "p9", to: "roof" });
  registerArea(g, extra, door);
  registerArea(g, extra, door);
  assert.equal(escape.areas.areas.roof, extra);
  assert.equal(
    escape.areas.portals.filter((candidate) => candidate.id === "p9").length,
    1,
  );
  assert.equal(escape.areas.portals.length, 2);
});

test("registerArea is a no-op without an escape state", () => {
  const g = areaGame();
  registerArea(g, stub({ id: "roof" }), portal({ id: "p9", to: "roof" }));
  assert.equal(g.escape, undefined);
});

test("prefetchArea stores the plan from an AI answer", async () => {
  const g = sourceGame();
  const escape = g.escape!;
  escape.areas.areas.pad!.state = "stub";
  escape.areas.areas.pad!.plan = undefined;
  let payload: AnyRecord | undefined;
  setAreaRequest((operation, sent) => {
    assert.equal(operation, "escape-area");
    payload = sent as AnyRecord;
    return Promise.resolve({
      areaId: "pad",
      name: "Frost pad",
      premise: "A pad under ice.",
      rooms: [{ name: "Bunk", purpose: "Sleep" }],
      people: [{ name: "Rook", role: "pilot", activity: "fuelling" }],
    });
  });
  prefetchArea(g, "pad");
  assert.equal(escape.areas.areas.pad!.state, "generating");
  assert.equal(payload?.requestId, "area-pad");
  assert.equal(payload?.areaId, "pad");
  assert.deepEqual(payload?.setting, escape.persona);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const generated = escape.areas.areas.pad!;
  assert.equal(generated.state, "ready");
  assert.deepEqual(generated.plan, {
    name: "Frost pad",
    premise: "A pad under ice.",
    rooms: [{ name: "Bunk", purpose: "Sleep" }],
    people: [{ name: "Rook", role: "pilot", activity: "fuelling" }],
  });
  setAreaRequest(undefined);
});

test("prefetchArea falls back offline without throwing", async () => {
  const g = sourceGame();
  const escape = g.escape!;
  const target = escape.areas.areas.pad!;
  target.state = "failed";
  target.plan = undefined;
  setAreaRequest(() => Promise.reject(new Error("offline")));
  prefetchArea(g, "pad");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(target.state, "ready");
  assert.deepEqual(target.plan, {
    name: "Landing pad",
    premise: "A frost-caked pad.",
    rooms: [],
    people: [],
  });
  // A synchronous throw is contained too.
  escape.areas.areas.roof = stub({
    id: "roof",
    name: "Roof",
    brief: "The roof.",
    state: "stub",
  });
  setAreaRequest(() => {
    throw new Error("bridge is down");
  });
  assert.doesNotThrow(() => prefetchArea(g, "roof"));
  assert.equal(escape.areas.areas.roof!.state, "ready");
  setAreaRequest(undefined);
});

test("enterPortal returns preparing for an area that is not ready", () => {
  const g = sourceGame();
  const escape = g.escape!;
  escape.areas.areas.pad!.state = "stub";
  escape.areas.areas.pad!.plan = undefined;
  setAreaRequest(() => new Promise(() => {}));
  assert.equal(enterPortal(g, "p1"), "preparing");
  assert.equal(escape.areas.areas.pad!.state, "generating");
  assert.equal(escape.areas.current, "bay");
  setAreaRequest(undefined);
});

test("enterPortal swaps to a destination game and parks the source", () => {
  const g = sourceGame();
  const escape = g.escape!;
  const sourceHuman = g.survivors[0];
  sourceHuman.hp = 55;
  setAreaFactory((seed) =>
    areaGame({
      id: `generated-${seed}`,
      seed,
      time: 0,
      survivors: [
        actor({
          id: "human",
          name: "",
          hp: 100,
          inventory: ["badge"],
          keys: [],
        }),
        actor({ id: "npc-1", name: "placeholder", role: "pilot" }),
      ],
      study: undefined,
      settings: undefined,
      escape: undefined,
    }),
  );
  assert.equal(enterPortal(g, "p1"), "entered");
  const dest = takeAreaSwitch(g);
  assert.ok(dest);
  assert.equal(takeAreaSwitch(g), undefined);
  assert.equal(dest.study, g.study);
  assert.equal(dest.settings, g.settings);
  assert.equal(dest.escape, escape);
  assert.equal(dest.time, g.time);
  const moved = dest.survivors[0];
  assert.equal(moved.id, "human");
  assert.equal(moved.name, "Dana");
  assert.equal(moved.hp, 55);
  assert.deepEqual(moved.keys, [3]);
  assert.deepEqual(moved.inventory, sourceHuman.inventory);
  assert.deepEqual(
    { floor: moved.floor, x: moved.x, y: moved.y },
    // A region is entered at its bounds edge facing back; the fixture crossing
    // sits nearer the source's west edge, so arrival is on the east edge.
    { floor: 0, x: 36, y: 15 },
  );
  const parked = escape.areaStore.bay!;
  assert.equal(parked.parkedAt, g.time);
  assert.equal("study" in parked.game, false);
  assert.equal("escape" in parked.game, false);
  assert.equal(escape.areas.current, "pad");
  // The way back is the edge crossing registered on arrival, not a portal.
  const back = escape.areas.portals.find(
    (candidate) => candidate.from === dest.id && candidate.to === "bay",
  );
  assert.ok(back);
  assert.equal(back?.label, "Rocket bay");
  assert.equal(back?.transition, "walk");
  assert.deepEqual(back?.at, { floor: 0, x: 36, y: 15 });
  assert.equal(back?.objectId, undefined);
  const departure = escape.log.at(-1);
  assert.equal(departure?.kind, "departure");
  assert.match(departure?.text ?? "", /Travelled to Landing pad/);
});

test("re-entering a parked source reuses its parked game", () => {
  const g = sourceGame();
  const escape = g.escape!;
  const sourceFloors = g.floors;
  setAreaFactory((seed) =>
    areaGame({ id: `generated-${seed}`, seed, time: 0 }),
  );
  assert.equal(enterPortal(g, "p1"), "entered");
  const dest = takeAreaSwitch(g)!;
  const parkedCopy = escape.areaStore.bay!.game;
  // The way back is a region edge crossing registered on arrival, not p1-back.
  const back = escape.areas.portals.find(
    (candidate) => candidate.from === dest.id && candidate.to === "bay",
  );
  assert.ok(back);
  assert.equal(enterRegion(dest, back.to), "entered");
  const returned = takeAreaSwitch(dest)!;
  assert.notEqual(returned, g);
  assert.equal(returned.id, parkedCopy.id);
  assert.equal(returned.floors, sourceFloors);
  assert.equal(returned.floors, parkedCopy.floors);
  assert.equal(escape.areas.current, "bay");
});

test("an exit destination means the player got away", () => {
  const escape = escapeState();
  escape.areas.areas.pad!.exit = true;
  const g = sourceGame(escape);
  assert.equal(enterPortal(g, "p1"), "entered");
  assert.equal(g.status, "escaped");
  assert.equal(g.endedAt, g.time);
  assert.equal(takeAreaSwitch(g), undefined);
  assert.equal(escape.areaStore.bay, undefined);
  assert.equal(escape.log.at(-1)?.kind, "departure");
  // An exit region is reached, not stepped through: the log names the place.
  assert.match(escape.log.at(-1)?.text ?? "", /Reached Landing pad/);
});

test("a follower moves with the player into the destination", () => {
  const g = sourceGame();
  const escape = g.escape!;
  const follower = actor({
    id: "npc-2",
    name: "Iris",
    socialState: { goal: { kind: "follow" } },
  } as AnyRecord);
  g.survivors.push(follower);
  setAreaFactory((seed) =>
    areaGame({ id: `generated-${seed}`, seed, time: 0 }),
  );
  assert.equal(enterPortal(g, "p1"), "entered");
  const dest = takeAreaSwitch(g)!;
  const movedFollower = dest.survivors.find(
    (candidate) => candidate.id === "npc-2",
  );
  assert.ok(movedFollower);
  assert.equal(movedFollower?.name, "Iris");
  // The follower steps in beside the human on the arrival edge, inside the
  // destination's east bounds edge.
  assert.deepEqual(
    { x: movedFollower?.x, y: movedFollower?.y },
    { x: 37, y: 15 },
  );
  assert.equal(
    g.survivors.some((candidate) => candidate.id === "npc-2"),
    false,
  );
  assert.equal(
    escape.areaStore.bay!.game.survivors.some(
      (candidate) => candidate.id === "npc-2",
    ),
    false,
  );
});

test("buildArea names NPCs from the plan and keeps ids stable", () => {
  const g = sourceGame();
  const escape = g.escape!;
  escape.areas.areas.pad!.plan = {
    name: "Frost pad",
    premise: "A pad under ice.",
    rooms: [],
    people: [{ name: "Rook", role: "pilot", activity: "fuelling" }],
  };
  setAreaFactory((seed) =>
    areaGame({
      id: `generated-${seed}`,
      seed,
      survivors: [
        actor(),
        actor({ id: "npc-1", name: "placeholder", role: "worker" }),
      ],
    }),
  );
  const built = buildArea(g, "pad");
  assert.equal(built.id, "run-1-pad");
  assert.equal(built.survivors[1].id, "npc-1");
  assert.equal(built.survivors[1].name, "Rook");
  assert.equal(built.survivors[1].role, "pilot");
});

/** A destination with a distinctive cast, so a designed game is recognisable. */
function designedGame(seed = 909): Game {
  return areaGame({
    id: `designed-${seed}`,
    seed,
    time: 0,
    survivors: [
      actor({ id: "human", name: "", hp: 100, escaped: true }),
      actor({ id: "npc-1", name: "Wick", role: "boatswain" }),
    ],
    study: undefined,
    settings: undefined,
    escape: undefined,
  });
}

/**
 * A saved design the tests treat as an opaque token: the real one is validated
 * by the design pipeline, and these cases only check which design is kept.
 */
function savedDesign(marker = "dock"): SavedRunDesign {
  return {
    version: 1,
    source: "fixture",
    requestId: `req-${marker}`,
    generationId: `gen-${marker}`,
    fingerprint: `fingerprint-${marker}`,
    design: { marker },
  } as unknown as SavedRunDesign;
}

test("prefetchArea designs an area and enterPortal prefers the designed game", async () => {
  // The designer now resolves to a saved design, and the registered designed
  // factory is what builds the destination: the old live-game map is gone.
  const escape = escapeState();
  escape.areas.areas.dock = stub({ id: "dock", name: "Dock", brief: "A dock" });
  escape.areas.portals.push(portal({ id: "p-dock", to: "dock" }));
  const g = sourceGame(escape);
  const asked: string[] = [];
  const saved = savedDesign();
  setAreaDesigner(async (target) => {
    asked.push(target.id);
    return saved;
  });
  const builtFrom: SavedRunDesign[] = [];
  setDesignedAreaFactory((_seed, design) => {
    builtFrom.push(design);
    return designedGame();
  });
  setAreaFactory((seed) => areaGame({ id: `factory-${seed}`, seed }));
  prefetchArea(g, "dock");
  assert.deepEqual(asked, ["dock"]);
  assert.equal(escape.areas.areas.dock!.state, "generating");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(escape.areas.areas.dock!.state, "ready");
  assert.equal(escape.areas.areas.dock!.design, saved);
  assert.equal(enterPortal(g, "p-dock"), "entered");
  const dest = takeAreaSwitch(g)!;
  assert.equal(dest.id, "run-1-dock");
  assert.equal(dest.seed, 909);
  assert.equal(dest.survivors[1].name, "Wick");
  assert.deepEqual(builtFrom, [saved]);
  setAreaDesigner(undefined);
});

test("a failed area design falls back to the seed-only factory", async () => {
  const escape = escapeState();
  escape.areas.areas.lab = stub({ id: "lab", name: "Lab", brief: "A lab" });
  escape.areas.portals.push(portal({ id: "p-lab", to: "lab" }));
  const g = sourceGame(escape);
  setAreaDesigner(() => Promise.reject(new Error("design offline")));
  setAreaFactory((seed) =>
    areaGame({
      id: `factory-${seed}`,
      seed,
      survivors: [actor(), actor({ id: "npc-1", name: "placeholder" })],
    }),
  );
  prefetchArea(g, "lab");
  assert.equal(escape.areas.areas.lab!.state, "generating");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(escape.areas.areas.lab!.state, "ready");
  assert.equal(enterPortal(g, "p-lab"), "entered");
  const dest = takeAreaSwitch(g)!;
  assert.equal(dest.seed, 42);
  assert.equal(dest.survivors[1].name, "placeholder");
  setAreaDesigner(undefined);
});

test("enterPortal stays preparing while an area design is pending", async () => {
  const escape = escapeState();
  escape.areas.areas.wait = stub({
    id: "wait",
    name: "Waiting room",
    brief: "A waiting room",
  });
  escape.areas.portals.push(portal({ id: "p-wait", to: "wait" }));
  const g = sourceGame(escape);
  // The designer resolves to the saved design now; the game comes from the
  // designed factory (the old map of live games is gone).
  let finish!: (saved: SavedRunDesign) => void;
  setAreaDesigner(
    () =>
      new Promise<SavedRunDesign>((resolve) => {
        finish = resolve;
      }),
  );
  setDesignedAreaFactory((_seed, _saved) => designedGame());
  setAreaFactory((seed) => areaGame({ id: `factory-${seed}`, seed }));
  prefetchArea(g, "wait");
  assert.equal(enterPortal(g, "p-wait"), "preparing");
  assert.equal(escape.areas.areas.wait!.state, "generating");
  assert.equal(escape.areas.current, "bay");
  finish(savedDesign("wait"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(enterPortal(g, "p-wait"), "entered");
  assert.equal(takeAreaSwitch(g)!.seed, 909);
  setAreaDesigner(undefined);
});

test("arriving in an area sets its id and clears the human's escaped flag", () => {
  const escape = escapeState();
  const g = sourceGame(escape);
  setAreaFactory((seed) =>
    areaGame({
      id: `factory-${seed}`,
      seed,
      survivors: [
        actor({ id: "human", name: "", escaped: true }),
        actor({ id: "npc-1", name: "placeholder" }),
      ],
    }),
  );
  assert.equal(enterPortal(g, "p1"), "entered");
  const dest = takeAreaSwitch(g)!;
  assert.equal(dest.areaId, "pad");
  assert.equal(dest.survivors[0].escaped, false);
});

test("a successful area design stores the saved design on the stub", async () => {
  const escape = escapeState();
  escape.areas.areas.dock = stub({ id: "dock", name: "Dock", brief: "A dock" });
  escape.areas.portals.push(portal({ id: "p-dock", to: "dock" }));
  const g = sourceGame(escape);
  const saved = savedDesign("dock");
  const asked: string[] = [];
  setAreaDesigner(async (target) => {
    asked.push(target.id);
    return saved;
  });
  prefetchArea(g, "dock");
  assert.equal(escape.areas.areas.dock!.design, undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(asked, ["dock"]);
  assert.equal(escape.areas.areas.dock!.design, saved);
  assert.equal(escape.areas.areas.dock!.state, "ready");
  setAreaDesigner(undefined);
});

test("buildArea builds a fresh game per call from the saved design", () => {
  const escape = escapeState();
  const target = escape.areas.areas.pad!;
  const saved = savedDesign("pad");
  target.design = saved;
  const g = sourceGame(escape);
  const calls: { seed: number; saved: SavedRunDesign }[] = [];
  setDesignedAreaFactory((seed, design) => {
    calls.push({ seed, saved: design });
    return designedGame();
  });
  // The seed-only factory would build a different, office-like area.
  setAreaFactory((seed) => areaGame({ id: `factory-${seed}`, seed }));
  const first = buildArea(g, "pad");
  const second = buildArea(g, "pad");
  assert.notEqual(first, second);
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((call) => call.seed),
    [42, 42],
  );
  assert.equal(calls[0].saved, saved);
  assert.equal(calls[1].saved, saved);
  for (const built of [first, second]) {
    assert.equal(built.id, "run-1-pad");
    assert.equal(built.seed, 909);
    assert.equal(built.survivors[1].name, "Wick");
  }
});

test("a stub carrying a saved design builds without calling the designer", () => {
  const escape = escapeState();
  // As after a reload: the saved design is on the stub and no session map has
  // seen it, so the stub must go straight to the designed factory.
  const target = escape.areas.areas.pad!;
  target.design = savedDesign("pad");
  target.state = "stub";
  const g = sourceGame(escape);
  let designs = 0;
  setAreaDesigner(async () => {
    designs++;
    return savedDesign("other");
  });
  let builds = 0;
  setDesignedAreaFactory((_seed, _saved) => {
    builds++;
    return designedGame();
  });
  prefetchArea(g, "pad");
  assert.equal(designs, 0);
  assert.equal(target.state, "ready");
  const built = buildArea(g, "pad");
  assert.equal(builds, 1);
  assert.equal(built.survivors[1].name, "Wick");
  setAreaDesigner(undefined);
});

test("re-entering after a Restart yields a new game, not the played one", () => {
  const escape = escapeState();
  escape.areas.areas.pad!.design = savedDesign("pad");
  const g = sourceGame(escape);
  let builds = 0;
  setDesignedAreaFactory((_seed, _saved) => {
    builds++;
    return designedGame();
  });
  assert.equal(enterPortal(g, "p1"), "entered");
  const played = takeAreaSwitch(g)!;
  played.survivors[0].hp = 5;
  played.survivors[1].name = "played";
  // A Restart drops every parked area; the saved design stays on the stub.
  escape.areaStore = {};
  assert.equal(enterPortal(g, "p1"), "entered");
  const again = takeAreaSwitch(g)!;
  assert.equal(builds, 2);
  assert.notEqual(again, played);
  assert.equal(again.survivors[0].hp, 80);
  assert.equal(again.survivors[1].name, "Wick");
  assert.equal(played.survivors[0].hp, 5);
});

test("a companion keeps their voice when they follow the player to another area", () => {
  const g = sourceGame();
  const escape = g.escape!;
  // Start-area voices are keyed by actor id; "bay" is the start area here.
  escape.voices.npcs["npc-2"] = "warm";
  g.survivors.push(
    actor({
      id: "npc-2",
      name: "Iris",
      socialState: { goal: { kind: "follow" } },
    } as AnyRecord),
  );
  setAreaFactory((seed) =>
    areaGame({ id: `generated-${seed}`, seed, time: 0 }),
  );
  assert.equal(enterPortal(g, "p1"), "entered");
  takeAreaSwitch(g);
  // In the generated area "pad" the voice key is prefixed with the area.
  assert.equal(escape.voices.npcs["pad:npc-2"], "warm");
});

test("a renamed companion keeps their voice under the new id", () => {
  const g = sourceGame();
  const escape = g.escape!;
  escape.voices.npcs["npc-1"] = "dry";
  // The source companion shares the generator id npc-1 with a destination NPC.
  g.survivors = [
    actor(),
    actor({
      id: "npc-1",
      name: "Iris",
      socialState: { goal: { kind: "follow" } },
    } as AnyRecord),
  ];
  setAreaFactory((seed) =>
    areaGame({ id: `generated-${seed}`, seed, time: 0 }),
  );
  assert.equal(enterPortal(g, "p1"), "entered");
  const dest = takeAreaSwitch(g)!;
  const companion = dest.survivors.find((a) => a.name === "Iris")!;
  assert.equal(companion.id, "npc-1-companion");
  assert.equal(escape.voices.npcs["pad:npc-1-companion"], "dry");
  // The destination's own npc-1 is a different person with no voice copied.
  assert.equal(escape.voices.npcs["pad:npc-1"], undefined);
});
