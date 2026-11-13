import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { hazardAt, seedHazard } from "../src/catastrophe-runtime";
import type {
  AreaPortal,
  CatastropheSpec,
  EscapeState,
} from "../src/escape-types";
import { TestRunner } from "../src/gametest/runner";
import { emptyScenario } from "../src/gametest/schema";
import { human } from "../src/engine";
import type { Game, Roadmap, Zombie } from "../src/model";
import { crossRegionEdges, tickParkedAreas } from "../src/parked-areas";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);

function fixture() {
  const scenario = emptyScenario();
  scenario.entities = [
    { id: "human", kind: "player", x: 5.5, y: 12.5 },
  ] as typeof scenario.entities;
  return new TestRunner(scenario, roadmap).game;
}

function catastrophe(): CatastropheSpec {
  return {
    id: "parked-test",
    title: "Parked test",
    premise: "Nothing yet.",
    origin: { areaId: "a" },
    behaviours: [],
    timeline: {
      graceSeconds: 0,
      phases: [{ name: "onset", at: 0, behaviours: [], intensity: 1 }],
    },
    omens: [],
    publicStory: "Nothing to see.",
  };
}

function escapeState(portals: AreaPortal[]): EscapeState {
  return {
    catastrophe: catastrophe(),
    roomPower: {},
    log: [],
    areas: { start: "a", current: "a", areas: {}, portals },
    areaStore: {},
  } as unknown as EscapeState;
}

interface Pair {
  active: Game;
  parked: Game;
  escape: EscapeState;
  src: { floor: number; x: number; y: number };
  back: { floor: number; x: number; y: number };
}

/** One active area `a` and one parked area `a1`, joined by a portal. */
function areaPair(transition: AreaPortal["transition"]): Pair {
  const active = fixture(),
    parked = fixture(),
    f = active.floors[0]!,
    width = f.tiles[0]!.length,
    height = f.tiles.length;
  const src = {
      floor: 0,
      x: Math.floor(width / 3) + 0.5,
      y: Math.floor(height / 2) + 0.5,
    },
    back = {
      floor: 0,
      x: Math.floor((width * 2) / 3) + 0.5,
      y: Math.floor(height / 2) + 0.5,
    };
  const escape = escapeState([
    { id: "out", from: "a1", to: "a", transition, at: src, label: "side door" },
    {
      id: "in",
      from: "a",
      to: "a1",
      transition,
      at: back,
      label: "side door",
    },
  ]);
  (active as unknown as { escape: EscapeState }).escape = escape;
  const detached = parked as unknown as {
    study?: unknown;
    escape?: unknown;
    areaId?: string;
  };
  delete detached.study;
  delete detached.escape;
  detached.areaId = "a1";
  escape.areaStore.a1 = {
    game: parked as unknown as EscapeState["areaStore"][string]["game"],
    parkedAt: 0,
  };
  return { active, parked, escape, src, back };
}

function hunter(id: string, at: { floor: number; x: number; y: number }) {
  return {
    id,
    floor: at.floor,
    x: at.x,
    y: at.y,
    hp: 60,
    path: [],
    repath: 0,
    cooldown: 0,
    memory: 0,
    stagger: 0,
    origin: "outside",
    hunter: 0,
  } as unknown as Zombie;
}

test("parked areas step at 10 Hz with study and escape attached only briefly", () => {
  const { active, parked, escape } = areaPair("walk"),
    detached = parked as unknown as { study?: unknown; escape?: unknown };
  tickParkedAreas(active, 0.05);
  assert.equal(parked.time, 0, "half a tick advances nothing");
  tickParkedAreas(active, 0.05);
  assert.ok(parked.time >= 0.1, "two halves make one 0.1 s step");
  assert.equal(detached.study, undefined, "study is detached again");
  assert.equal(detached.escape, undefined, "escape is detached again");
  assert.equal(escape.areaStore.a1!.game === (parked as never), true);
});

test("a parked area runs at most three steps per call and keeps the remainder", () => {
  const { active, parked } = areaPair("walk");
  tickParkedAreas(active, 1);
  assert.equal(
    Number(parked.time.toFixed(3)),
    0.3,
    "a one second gap is capped at three steps",
  );
  tickParkedAreas(active, 0.1);
  assert.equal(
    Number(parked.time.toFixed(3)),
    0.6,
    "the time left over from the capped call still runs, three steps at a time",
  );
});

test("the parked area's own human is marked gone exactly once", () => {
  const { active, parked } = areaPair("walk"),
    actor = human(parked)!;
  assert.equal(actor.escaped, false);
  tickParkedAreas(active, 0.1);
  assert.equal(actor.escaped, true, "the player is no longer in this area");
  // areas.ts resets this when the player returns; the module must not redo it.
  actor.escaped = false;
  tickParkedAreas(active, 0.1);
  assert.equal(actor.escaped, false, "the departure is only recorded once");
});

test("a failing parked step is swallowed and logged once", () => {
  const { active, parked } = areaPair("walk");
  Object.defineProperty(parked, "floors", {
    configurable: true,
    get() {
      throw new Error("broken area");
    },
  });
  const original = console.warn,
    warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    tickParkedAreas(active, 0.1);
    tickParkedAreas(active, 0.1);
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1, "one warning per broken area");
  assert.match(String(warnings[0]![0]), /a1/);
  assert.equal(
    (parked as unknown as { escape?: unknown }).escape,
    undefined,
    "escape is detached even after a failed step",
  );
});

test("a hunter in a parked region follows the player to the matching edge", () => {
  const { active, parked, escape, src, back } = areaPair("walk"),
    zombie = hunter("crosser", src);
  parked.zombies.push(zombie);
  // Only regions are parked now, so a hunter crosses a region edge.
  crossRegionEdges(active);
  assert.ok(
    active.zombies.includes(zombie),
    "the hunter is now in the active region",
  );
  assert.ok(
    !parked.zombies.includes(zombie),
    "and no longer in the parked one",
  );
  assert.equal(zombie.x, back.x);
  assert.equal(zombie.y, back.y);
  assert.deepEqual(zombie.path, []);
  assert.equal(zombie.repath, 0);
  const logged = escape.log.filter((entry) => entry.kind === "departure");
  assert.equal(logged.length, 1);
  // Nothing is stepped through any more: the crossing names the edge.
  assert.equal(logged[0]!.text, "A hunter crossed the side door edge.");
  assert.equal(logged[0]!.areaId, "a");
});

test("hazards never cross a region edge", () => {
  const pair = areaPair("door");
  seedHazard(pair.parked, pair.src.floor, pair.src.x, pair.src.y, 1);
  crossRegionEdges(pair.active);
  // Hazards are seeded per region and stay there: only hunters travel.
  assert.ok(
    hazardAt(pair.parked, pair.src.floor, pair.src.x, pair.src.y) > 0.5,
    "the smoke front stays in the region it was seeded in",
  );
  assert.equal(
    hazardAt(pair.active, pair.back.floor, pair.back.x, pair.back.y),
    0,
    "the active region gains no hazard from the parked one",
  );
});
