/**
 * Hot-path regressions for multi-building worlds: the per-frame costs that used
 * to scale with (NPCs x furniture) or (calls x free cells) must stay cheap
 * without changing the answers the engine reaches.
 *
 *   node --import tsx --test tests/hot-path-perf.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { catastropheOrigin } from "../src/catastrophe-runtime";
import { step, type Input } from "../src/engine";
import { createEscapeState } from "../src/escape-state";
import type { Actor, Game, Point, Roadmap } from "../src/model";
import { survivorPath, survivorPaths } from "../src/navigation";
import { nextSiteOrigin, stampSite } from "../src/site-stamp";
import { createPlayableGame } from "../src/world";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
const idle: Input = { x: 0, y: 0, grab: false };

/** A live building with no zombies, as scripts/benchmark-sites.ts builds them. */
function world(seed: number): Game {
  const g = createPlayableGame(seed, roadmap);
  g.zombies = [];
  g.nextSpawn = Number.MAX_SAFE_INTEGER;
  g.status = "playing";
  return g;
}
function siteWorld(sites: number, seed = 7): Game {
  const g = world(seed);
  for (let i = 1; i < sites; i++)
    stampSite(g, world(100 + i), {
      id: `s${i}`,
      name: `S${i}`,
      origin: nextSiteOrigin(g),
    });
  return g;
}
function actorsOn(g: Game, floor: number): Actor[] {
  return g.survivors.filter(
    (a) => a.id !== "human" && a.alive && a.floor === floor,
  );
}
/** A route token is `${version}|${access}`, so versions never repeat. */
function version(token: string | undefined) {
  const n = Number((token ?? "0|").split("|")[0]);
  return Number.isFinite(n) ? n : 0;
}

test("route invalidation still fires for moved furniture only", () => {
  const g = siteWorld(2);
  step(g, 1 / 30, idle);
  step(g, 1 / 30, idle);
  const f = g.floors[0];
  const actors = actorsOn(g, 0);
  assert.ok(actors.length > 4, "two-site world must have NPCs on the ground");
  // Freeze every pose: doors open and static, props held where they are, so no
  // frame in the quiet window carries a furniture change at all.
  const frozen = f.furniture.map((o) => {
    if (o.door) {
      o.open = true;
      o.angle = 0;
    }
    return { o, x: o.x, y: o.y, angle: o.angle, open: o.open };
  });
  const restore = () => {
    for (const s of frozen) {
      s.o.x = s.x;
      s.o.y = s.y;
      s.o.angle = s.angle;
      s.o.open = s.open;
      s.o.turning = 0;
    }
  };
  restore();
  const seen = new Map<string, string | undefined>();
  let changed = 0;
  // 200 otherwise idle frames: with furniture held identical, the shared floor
  // token may never change, so no route can be dropped for geometry reasons.
  for (let i = 0; i < 200; i++) {
    step(g, 1 / 30, idle);
    restore();
    for (const a of actors) {
      if (a.floor !== 0 || !a.alive) continue;
      const before = seen.get(a.id),
        now = a.routeGeometry;
      assert.ok(
        version(now) >= version(before),
        `${a.id} route token ran backwards`,
      );
      if (before !== undefined && before !== now) changed++;
      seen.set(a.id, now);
    }
  }
  assert.equal(
    changed,
    0,
    `${changed} NPC frames changed route geometry without a furniture move`,
  );
  // A deliberate 0.5-tile chair move must still change the walker's route
  // geometry; then standing the chair on the route's next node must drop that
  // route (a replanned path may immediately replace it, so the check is that
  // the blocked node is no longer first).
  for (const a of actorsOn(g, 0)) a.repath = 1e9;
  const walkers = actorsOn(g, 0).filter(
    (a) => a.path.length > 1 && a.target && !a.path[0]!.action,
  );
  assert.ok(walkers.length > 0, "some ground NPC must be walking a path");
  const chair = f.furniture.find(
    (o) => !o.field && !o.door && !o.destroyed && o.w <= 1.2,
  );
  assert.ok(chair, "ground floor must keep a movable plant or chair");
  const node = walkers[0]!.path[0]!;
  chair.x = node.x - 1.5;
  chair.y = node.y;
  step(g, 1 / 30, idle);
  chair.x += 0.5;
  step(g, 1 / 30, idle);
  const walker = walkers.find((a) => a.path.length > 1);
  assert.ok(walker, "a walker must still be walking after a 0.5-tile move");
  const target = walker.path[0]!;
  chair.x = target.x;
  chair.y = target.y;
  let dropped = false;
  for (let i = 0; i < 6 && !dropped; i++) {
    step(g, 1 / 30, idle);
    const first = walker.path[0];
    dropped =
      walker.repath < 1e8 &&
      (!first || first.x !== target.x || first.y !== target.y);
  }
  assert.ok(dropped, "a route through the moved chair must be dropped");
});

test("catastropheOrigin is memoised per game and spec", () => {
  const g = siteWorld(2);
  g.escape = createEscapeState(g, { gender: "male", seed: 7 });
  const first = catastropheOrigin(g);
  assert.strictEqual(
    catastropheOrigin(g),
    first,
    "repeated calls must return the memoised origin itself",
  );
  assert.deepEqual(catastropheOrigin(g), first);
  const twin = siteWorld(2);
  twin.escape = createEscapeState(twin, { gender: "male", seed: 7 });
  assert.deepEqual(
    catastropheOrigin(twin),
    first,
    "the memoised origin must equal a fresh computation",
  );
  const hint = g.escape.catastrophe.origin.roomHint;
  g.escape.catastrophe.origin.roomHint = `${hint ?? "atrium"} lobby`;
  const moved = catastropheOrigin(g);
  assert.notStrictEqual(moved, first, "a changed room hint recomputes");
  assert.equal(moved.floor, 0);
});

test("survivorPaths matches survivorPath for every end", () => {
  const g = siteWorld(2);
  step(g, 1 / 30, idle);
  const f = g.floors[0];
  const actor = actorsOn(g, 0).find((a) => a.alive);
  assert.ok(actor, "the ground floor must hold an NPC");
  const start: Point = { x: actor.x, y: actor.y };
  const ends: Point[] = f.stations.slice(0, 4).map((s) => ({ x: s.x, y: s.y }));
  ends.push(
    { x: actor.x + 0.4, y: actor.y + 0.4 },
    { x: actor.x + 9, y: actor.y - 7 },
  );
  const batched = survivorPaths(f, start, ends);
  assert.equal(batched.length, ends.length);
  for (let i = 0; i < ends.length; i++)
    assert.deepEqual(batched[i], survivorPath(f, start, ends[i]!), `end ${i}`);
});

test("three struck sites stay inside the frame budget", () => {
  const g = siteWorld(3);
  g.escape = createEscapeState(g, { gender: "male", seed: 7 });
  const t = g.escape.catastrophe.timeline;
  t.graceSeconds = 1;
  for (const p of t.phases) p.at = Math.min(p.at, 5);
  // The first frame builds every floor's route graph: a startup cost, not a
  // steady-state frame, so warm up once and measure the next 300 frames.
  step(g, 1 / 30, idle);
  const times: number[] = [];
  for (let i = 0; i < 300; i++) {
    const at = performance.now();
    step(g, 1 / 30, idle);
    times.push(performance.now() - at);
  }
  const mean = times.reduce((n, x) => n + x, 0) / times.length;
  // Measured 12.5 ms alone against a 23 ms baseline (196 ms before the route
  // fixes). Under the parallel full suite the same world measured 34 ms, so
  // the default bound only catches a return of the old costs; PERF_BUDGET=1
  // applies the tight single-process budget.
  const budget = process.env.PERF_BUDGET ? 20 : 80;
  assert.ok(
    mean < budget,
    `mean frame ${mean.toFixed(2)}ms must stay under ${budget}ms`,
  );
});
