/**
 * Several-building frame cost: stamps SITES buildings into one world, plays
 * idle frames and reports mean/worst frame time plus route graph builds.
 *
 *   node --import tsx scripts/benchmark-sites.ts
 *   SITES=4 FRAMES=600 node --import tsx scripts/benchmark-sites.ts
 */
import { readFileSync } from "node:fs";
import { step, type Input } from "../src/engine";
import { routeGraphStats, resetRouteGraphStats } from "../src/navigation";
import { nextSiteOrigin, stampSite } from "../src/site-stamp";
import { createPlayableGame } from "../src/world";
import type { Game, Roadmap } from "../src/model";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
const sites = Math.max(1, Number(process.env.SITES ?? 3)),
  frames = Math.max(1, Number(process.env.FRAMES ?? 300));

/** A live building with no zombies, as the site-stamp tests build them. */
function world(seed: number): Game {
  const g = createPlayableGame(seed, roadmap);
  g.zombies = [];
  g.nextSpawn = Number.MAX_SAFE_INTEGER;
  g.status = "playing";
  return g;
}

const game = world(7);
for (let i = 1; i < sites; i++)
  stampSite(game, world(100 + i), {
    id: `s${i}`,
    name: `S${i}`,
    origin: nextSiteOrigin(game),
  });

const ground = game.floors[0],
  npcs = game.survivors.filter((a) => a.id !== "human").length,
  cols = ground.tiles[0]?.length ?? 0,
  rows = ground.tiles.length;
console.log(
  `sites=${sites} npcs=${npcs} ground=${cols}x${rows} frames=${frames}`,
);

const idle: Input = { x: 0, y: 0, grab: false };
resetRouteGraphStats();
// The first frame builds every floor's graph, which is a startup cost no
// steady-state frame pays, so warm up on one frame and report the rest.
step(game, 1 / 30, idle);
const times: number[] = [];
for (let i = 0; i < frames; i++) {
  const start = performance.now();
  step(game, 1 / 30, idle);
  times.push(performance.now() - start);
}
const stats = routeGraphStats(),
  mean = times.reduce((n, t) => n + t, 0) / times.length,
  worst = Math.max(...times);
console.log(
  `mean=${mean.toFixed(1)}ms worst=${worst.toFixed(1)}ms graphBuilds=${stats.builds} incremental=${stats.incremental}`,
);
