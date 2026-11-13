import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { step, type Input } from "../src/engine";
import type { Actor, Floor, Game, Point, Roadmap } from "../src/model";
import type { Site } from "../src/site";
import {
  homeSite,
  inFootprint,
  nextSiteOrigin,
  stampSite,
} from "../src/site-stamp";
import { solid } from "../src/spatial";
import { createPlayableGame } from "../src/world";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);

const idle: Input = { x: 0, y: 0, grab: false };

/** A live building with its storeys and its own city plan. */
function world(seed: number): Game {
  const g = createPlayableGame(seed, roadmap);
  g.zombies = [];
  g.nextSpawn = Number.MAX_SAFE_INTEGER;
  g.status = "playing";
  return g;
}

/** Start building, a stamped second building and the shared yard between them. */
function twoBuildings(startSeed: number, annexSeed: number) {
  const g = world(startSeed),
    source = world(annexSeed),
    site = stampSite(g, source, {
      id: "annex",
      name: "Annex",
      origin: nextSiteOrigin(g),
    }),
    f = g.floors[0];
  return { g, site, f };
}

/** Centre of a site's main gate on the ground floor. */
function gateCentre(f: Floor, gate: string): Point {
  const door = f.furniture.find((o) => o.id === gate);
  assert.ok(door, `${gate} exists`);
  return { x: door.x + door.w / 2, y: door.y + door.h / 2 };
}

/** First walkable open-ground cell west of a site's gate. */
function openYard(f: Floor, site: Site, from: Point): Point {
  const row = site.boundary.rows[Math.floor(from.y)];
  assert.ok(row, `the gate row of ${site.id} is inside its footprint`);
  for (let x = Math.floor(row.left) - 2; x > 2; x--) {
    const p = { x: x + 0.5, y: Math.floor(from.y) + 0.5 };
    if (f.tiles[Math.floor(p.y)]?.[x] === 0 && !solid(f, p)) return p;
  }
  throw Error(`no open ground west of ${site.id}`);
}

/** True when the actor stands inside its building or just outside its own gate. */
function atHome(g: Game, a: Actor): boolean {
  const site = homeSite(g, a);
  if (!site) return false;
  if (inFootprint(site, a)) return true;
  const gate = site.gate && gateCentre(g.floors[0], site.gate);
  return (
    !!gate && Math.max(Math.abs(a.x - gate.x), Math.abs(a.y - gate.y)) <= 3
  );
}

/** Every station an NPC holds must sit in the NPC's own building. */
function assertOwnStations(g: Game) {
  const stationSite = (id: string) => {
    for (const floor of g.floors) {
      const st = floor.stations.find((s) => s.id === id);
      if (st) return st.site ?? "start";
    }
    return undefined;
  };
  let held = 0;
  for (const a of g.survivors) {
    if (a.id === "human" || !a.alive || a.escaped || !a.station) continue;
    held++;
    assert.equal(
      stationSite(a.station),
      a.home ?? "start",
      `${a.id} holds a station of its own building (${a.station})`,
    );
  }
  assert.ok(held > 0, "some NPCs still hold a work station");
}

/** How many of a building's own living NPCs are home, and how many it has. */
function stayingHome(g: Game, home: string) {
  const counts = { home: 0, total: 0 };
  for (const a of g.survivors) {
    if (a.id === "human" || !a.alive || a.escaped) continue;
    if ((a.home ?? "start") !== home) continue;
    counts.total++;
    if (atHome(g, a)) counts.home++;
  }
  return counts;
}

/** Drop everybody but one building's residents, keeping the human in the yard. */
function onlyResidents(g: Game, site: string | undefined) {
  const human = g.survivors.find((a) => a.id === "human");
  assert.ok(human, "the playable world has a human");
  const keep = g.survivors.filter(
    (a) => a.id === "human" || (a.home ?? "start") === (site ?? "start"),
  );
  assert.ok(keep.length > 1, `${site ?? "start"} has residents`);
  g.survivors = keep;
  return { human, keep };
}

test("the start building keeps its people when a second building is next door", () => {
  const { g, site, f } = twoBuildings(7, 77),
    { human } = onlyResidents(g, undefined),
    startGate = gateCentre(f, "main-gate"),
    annexGate = gateCentre(f, "annex:main-gate"),
    yard = openYard(f, site, annexGate);
  // Stand the player in the shared yard, between the two gates.
  human.x = yard.x;
  human.y = yard.y;
  human.floor = 0;
  human.path = [];
  delete human.target;
  assert.ok(
    yard.x > startGate.x && yard.x < annexGate.x,
    "the player stands between the buildings",
  );
  for (let t = 0; t < 15 * 30; t++) step(g, 1 / 30, idle);
  const start = stayingHome(g, "start");
  assert.ok(start.total > 0, "the start building still has living NPCs");
  assert.ok(
    start.home / start.total >= 0.8,
    `${start.home}/${start.total} start NPCs stayed home`,
  );
  assertOwnStations(g);
});

test("a stamped building's residents keep its stations and stay home", () => {
  const { g, site, f } = twoBuildings(11, 1111),
    { human } = onlyResidents(g, "annex"),
    annexGate = gateCentre(f, "annex:main-gate"),
    yard = openYard(f, site, annexGate);
  human.x = yard.x;
  human.y = yard.y;
  human.floor = 0;
  human.path = [];
  delete human.target;
  for (const a of g.survivors)
    if (a.id.startsWith("annex:"))
      assert.equal(a.home, "annex", `${a.id} lives in the stamped building`);

  for (let t = 0; t < 60 * 30; t++) step(g, 1 / 30, idle);
  const annex = stayingHome(g, "annex");
  assert.ok(annex.total > 0, "the stamped building still has living NPCs");
  assert.ok(
    annex.home / annex.total >= 0.8,
    `${annex.home}/${annex.total} stamped NPCs stayed home`,
  );
  assertOwnStations(g);

  // A panicking resident is not tied to its building: it may run out of the gate.
  const npc = g.survivors.find(
    (a) => a.id.startsWith("annex:") && a.alive && !a.escaped && !a.studyLoop,
  );
  assert.ok(npc, "a stamped resident is still alive");
  npc.x = yard.x;
  npc.y = yard.y;
  npc.floor = 0;
  npc.path = [];
  delete npc.target;
  delete npc.navTarget;
  delete npc.station;
  const starts = { x: npc.x, y: npc.y };
  assert.ok(!inFootprint(site, npc), "it starts outside its own footprint");
  npc.activity = "fleeing";
  npc.fleeTarget = { x: Math.max(2.5, starts.x - 8), y: starts.y };
  npc.fleeFloor = 0;
  npc.fleeUntil = g.time + 30;
  let furthest = 0;
  for (let t = 0; t < 8 * 30; t++) {
    step(g, 1 / 30, idle);
    furthest = Math.max(
      furthest,
      Math.max(Math.abs(npc.x - annexGate.x), Math.abs(npc.y - annexGate.y)),
    );
    if (furthest > 4) break;
  }
  assert.ok(
    furthest > 4,
    "panic carried it well beyond its own gate (furthest " +
      furthest.toFixed(2) +
      " tiles)",
  );
});
