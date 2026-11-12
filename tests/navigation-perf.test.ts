import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { step, type Input } from "../src/engine";
import { survivorFloor } from "../src/force-fields";
import {
  __graphForTest,
  resetRouteGraphStats,
  routeGraphStats,
  survivorPath,
  survivorPaths,
  type NavStep,
} from "../src/navigation";
import type { Actor, Floor, Game, Point, Roadmap } from "../src/model";
import { nextSiteOrigin, stampSite } from "../src/site-stamp";
import { solid } from "../src/spatial";
import { createPlayableGame } from "../src/world";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
const idle: Input = { x: 0, y: 0, grab: false };

/** A live building with no zombies, as the site-stamp tests build them. */
function world(seed: number): Game {
  const g = createPlayableGame(seed, roadmap);
  g.zombies = [];
  g.nextSpawn = Number.MAX_SAFE_INTEGER;
  g.status = "playing";
  return g;
}
/** The start building plus SITES-1 stamped neighbours. */
function worldWithSites(sites: number): Game {
  const g = world(7);
  for (let i = 1; i < sites; i++)
    stampSite(g, world(100 + i), {
      id: `s${i}`,
      name: `S${i}`,
      origin: nextSiteOrigin(g),
    });
  return g;
}
const routeCost = (start: Point, route: NavStep[]) => {
  let cost = 0,
    from = start;
  for (const p of route) {
    cost +=
      Math.hypot(p.x - from.x, p.y - from.y) +
      (p.action === "vault" ? 2 : p.action === "door" ? 1 : 0);
    from = p;
  }
  return cost;
};
const span = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

test("actors with the same field access share one survivor floor view", () => {
  const source = world(7).floors[0],
    // A private copy of the floor whose fields are floor-access doors: the rule
    // the game itself uses for an opening only one access class may cross.
    f: Floor = {
      ...source,
      furniture: source.furniture.map((o) => ({
        ...o,
        field: o.field
          ? {
              ...o.field,
              exit: true,
              limit: 0,
              used: 0,
              authorized: [],
              crossing: [],
            }
          : o.field,
      })),
    },
    fields = f.furniture.filter((o) => o.field);
  assert.ok(fields.length > 0, "the floor has access-controlled fields");
  const admitted = {
      ...world(7).survivors[0],
      id: "admitted",
      access: [0],
      keys: 0,
    } as Actor,
    twin = { ...admitted, id: "twin" } as Actor,
    denied = { ...admitted, id: "denied", access: [] } as Actor;
  // Identical access answers every field the same way, so one view serves both.
  assert.equal(survivorFloor(f, admitted), survivorFloor(f, twin));
  assert.notEqual(survivorFloor(f, admitted), survivorFloor(f, denied));
  let demonstrated = false;
  for (const field of fields) {
    const gap = Math.max(field.w, field.h) / 2 + 1.1,
      crossX = field.h >= field.w,
      from = crossX
        ? { x: field.x - gap, y: field.y }
        : { x: field.x, y: field.y - gap },
      to = crossX
        ? { x: field.x + gap, y: field.y }
        : { x: field.x, y: field.y + gap },
      start = { ...admitted, ...from } as Actor,
      blocked = { ...denied, ...from } as Actor;
    if (solid(f, start, 0.25, undefined, true)) continue;
    if (solid(f, to, 0.25, undefined, true)) continue;
    if (survivorPath(f, start, to).length !== 1) continue;
    // The admitted actor walks the opening; the denied one cannot.
    assert.notEqual(
      survivorPath(f, blocked, to).length,
      1,
      `${denied.id} cannot walk through ${field.id}`,
    );
    demonstrated = true;
  }
  assert.ok(demonstrated, "a field admits one access class and blocks another");
});
test("a nudged plant rebuilds the route graph incrementally and equals a fresh build", () => {
  const g = worldWithSites(2),
    f = g.floors[0];
  resetRouteGraphStats();
  const first = __graphForTest(f),
    before = routeGraphStats();
  const plant =
    f.furniture.find((o) => o.kind === "plant" && !o.field) ??
    f.furniture.find((o) => !o.field && !o.door && o.kind !== "gate");
  assert.ok(plant, "a movable piece to nudge");
  const original = plant.x;
  plant.x = original + 0.3;
  const incremental = __graphForTest(f),
    after = routeGraphStats();
  assert.ok(after.builds > before.builds, "the nudge rebuilt the graph");
  assert.ok(
    after.incremental > before.incremental,
    "the furniture-only change reused the cached edge tests",
  );
  const fresh = __graphForTest(f, { fresh: true });
  assert.deepEqual(incremental.points, fresh.points);
  assert.deepEqual(incremental.edges, fresh.edges);
  // Moving it back must restore the very graph built before the nudge.
  plant.x = original;
  const restored = __graphForTest(f),
    freshAgain = __graphForTest(f, { fresh: true });
  assert.deepEqual(restored.points, freshAgain.points);
  assert.deepEqual(restored.edges, freshAgain.edges);
  assert.deepEqual(restored.points, first.points);
  assert.deepEqual(restored.edges, first.edges);
});

test("survivorPaths returns the routes single survivorPath calls return", () => {
  const g = worldWithSites(2),
    a = g.survivors.find((s) => s.id !== "human") ?? g.survivors[0],
    f = g.floors[a.floor],
    ends = f.stations.slice(0, 6);
  assert.ok(ends.length >= 3, "the floor offers several candidate stations");
  const routes = survivorPaths(f, a, ends);
  assert.equal(routes.length, ends.length);
  assert.ok(
    routes.some((r) => r.length > 0),
    "at least one station is reachable",
  );
  ends.forEach((end, i) => {
    const single = survivorPath(f, a, end);
    assert.deepEqual(routes[i], single, `route to ${end.id}`);
    assert.equal(routeCost(a, routes[i]), routeCost(a, single));
    // Structure of a shared search: every step is a linked neighbour, and a
    // graph route ends on the destination itself, exactly like the original
    // per-end search (a route that stopped one node short left walkers
    // stranded beside a layered-cover gap).
    for (let k = 1; k < routes[i].length; k++)
      assert.ok(
        span(routes[i][k - 1], routes[i][k]) < 3.2,
        `step ${k} toward ${end.id}`,
      );
    const last = routes[i][routes[i].length - 1];
    if (last && !last.action)
      assert.deepEqual(
        { x: last.x, y: last.y },
        { x: end.x, y: end.y },
        `route to ${end.id} ends on it`,
      );
  });
});

test("three buildings stay inside a frame-time budget", () => {
  const g = worldWithSites(3),
    frames = 150;
  resetRouteGraphStats();
  // The first frame builds each floor once; steady state should not rebuild.
  step(g, 1 / 30, idle);
  const start = performance.now();
  for (let i = 0; i < frames; i++) step(g, 1 / 30, idle);
  const mean = (performance.now() - start) / frames,
    stats = routeGraphStats();
  // 22ms per frame measured here against the ~580ms this world used to cost,
  // so the budget keeps more than five times headroom under the old price.
  assert.ok(mean < 110, `mean ${mean.toFixed(1)}ms per frame`);
  assert.ok(
    stats.builds <= frames / 3,
    `${stats.builds} graph builds over ${frames} frames`,
  );
});
