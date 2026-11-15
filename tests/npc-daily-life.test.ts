import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { step } from "../src/engine";
import {
  createEscapeState,
  isEscapeState,
  loopReset,
} from "../src/escape-state";
import type { DailyLife, EscapeState } from "../src/escape-types";
import type { Actor, Game, Roadmap } from "../src/model";
import { visitPoint } from "../src/npc-daily-life";
import { createPlayableGame } from "../src/world";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);

/** Ten simulation steps per second: enough detail for a 600 s day. */
const DT = 0.1;

function escapeRun(seed: number): Game {
  const g = createPlayableGame(seed, roadmap);
  g.status = "playing";
  g.paused = false;
  g.zombies = [];
  g.nextSpawn = 1e9;
  g.escape = createEscapeState(g, { gender: "female", seed });
  return g;
}

function crew(g: Game): Actor[] {
  return g.survivors.filter((a) => a.id !== "human");
}

function round(n: number, places = 6): number {
  const k = 10 ** places;
  return Math.round(n * k) / k;
}

/** Everything the ordinary day must never touch. */
function protectedState(g: Game) {
  return {
    encounters: JSON.parse(JSON.stringify(g.encounters)),
    stations: JSON.parse(JSON.stringify(g.floors.map((f) => f.stations))),
    survivors: JSON.parse(
      JSON.stringify(
        g.survivors.map((a) => ({
          id: a.id,
          station: a.station,
          keys: a.keys,
          inventory: a.inventory,
          access: a.access,
        })),
      ),
    ),
    helicopter: JSON.parse(JSON.stringify(g.helicopter)),
  };
}

test("a 600 s escape day moves nobody's business but the NPCs' own feet", () => {
  const g = escapeRun(20240607);
  const npc = crew(g);
  assert.ok(npc.length > 0, "the crew exists");
  const start = npc.map((a) => ({
    id: a.id,
    x: a.x,
    y: a.y,
    floor: a.floor,
  }));
  const before = protectedState(g);
  const moved = new Set<string>(),
    returned = new Set<string>();

  for (let i = 0; i < Math.round(600 / DT); i++) {
    // Keep hunters out of the test: routines are the only NPC driver here.
    g.zombies = [];
    step(g, DT);
    for (const s of start) {
      const a = g.survivors.find((b) => b.id === s.id);
      if (!a || !a.alive) continue;
      const away =
        a.floor === s.floor ? Math.hypot(a.x - s.x, a.y - s.y) : Infinity;
      if (away > 2) moved.add(s.id);
      if (moved.has(s.id) && away <= 1.5) returned.add(s.id);
    }
  }

  assert.deepEqual(protectedState(g), before);
  assert.ok(moved.size > 0, "at least one NPC walked somewhere");
  assert.ok(
    [...moved].some((id) => returned.has(id)),
    "at least one NPC came back to its home point",
  );
  const daily = g.escape!.daily;
  assert.ok(daily);
  for (const s of start) {
    const life: DailyLife | undefined = daily![s.id];
    assert.ok(life, `${s.id} has no daily routine`);
    assert.deepEqual(life.home, { x: s.x, y: s.y, floor: s.floor });
  }
});

test("the same seed replays the same day", () => {
  const positions = (seed: number) => {
    const g = escapeRun(seed);
    for (let i = 0; i < 2500; i++) {
      g.zombies = [];
      step(g, DT);
    }
    return crew(g).map((a) => ({
      id: a.id,
      x: round(a.x),
      y: round(a.y),
      floor: a.floor,
      state: g.escape!.daily![a.id].state,
      visits: g.escape!.daily![a.id].visits,
    }));
  };
  assert.deepEqual(positions(5150), positions(5150));
});

test("old saves validate and a restarted loop begins the day again", () => {
  const g = escapeRun(12);
  step(g, DT);
  const escape = g.escape!;
  assert.ok(escape.daily && Object.keys(escape.daily).length > 0);

  const old: EscapeState = JSON.parse(JSON.stringify(escape));
  delete old.daily;
  assert.equal(isEscapeState(old), true, "a save without daily still loads");

  const reset = loopReset(escape);
  assert.equal("daily" in reset, false);
  assert.equal(isEscapeState(reset), true);
});

test("an errand goes to a work point of the NPC's floor, or to furniture where there is none", () => {
  const g = escapeRun(11),
    a = crew(g)[0],
    floor = g.floors[a.floor],
    life: DailyLife = {
      home: { x: a.x, y: a.y, floor: a.floor },
      state: "staying",
      until: 0,
      visits: 0,
    };
  assert.ok(floor.stations.length > 0, "the floor has work points");
  const nearest = (p: { x: number; y: number }, list: typeof floor.stations) =>
    Math.min(...list.map((s) => Math.hypot(s.x - p.x, s.y - p.y)));
  for (let visit = 0; visit < 6; visit++) {
    const spot = visitPoint(g, a, life, visit)!;
    assert.ok(
      Math.abs(nearest(spot, floor.stations) - 0.9) < 1e-6,
      "the NPC stops 0.9 m short of a work point",
    );
  }
  floor.stations = [];
  const fallback = visitPoint(g, a, life, 0)!,
    furniture = floor.furniture.filter((o) => !o.destroyed);
  assert.ok(
    Math.abs(
      Math.min(
        ...furniture.map((o) => Math.hypot(o.x - fallback.x, o.y - fallback.y)),
      ) - 0.9,
    ) < 1e-6,
    "without work points it stops 0.9 m short of furniture",
  );
});
