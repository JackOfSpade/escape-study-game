import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { eligible } from "../src/curriculum";
import { claimStation, step, vault } from "../src/engine";
import type { Roadmap } from "../src/model";
import { decode, encode, recover } from "../src/persistence";
import { createGame } from "../src/world";
import { devProblem } from "./helpers/practice-questions";
const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
test("D07 a late human can vault another survivor’s damaged cover and use a fresh shared opportunity without a morality tax or fabricated contribution", async () => {
  const g = createGame(42, roadmap),
    f = g.floors[0],
    h = g.survivors[0],
    other = g.survivors[1],
    e = g.encounters["f0-room0"];
  const shelf = structuredClone(f.furniture.find((o) => o.kind === "shelf")!);
  Object.assign(shelf, {
    id: "other-survivor-cover",
    x: 12.5,
    y: 10.5,
    w: 1,
    h: 3,
    hp: 1200,
    credited: [other.id],
  });
  // Controlled existing fortification. Physical preparation itself has separate
  // generated-layout tests; no ownership is assigned to the arriving human.
  f.furniture = [shelf];
  f.tiles = Array.from({ length: 34 }, () => Array(44).fill(0));
  for (let y = 0; y < 34; y++) if (y < 9 || y > 11) f.tiles[y][12] = 1;
  f.stations = [
    { ...f.stations.find((s) => s.encounter === e.id)!, x: 14.5, y: 10.5 },
  ];
  for (const npc of g.survivors.slice(1)) npc.escaped = true;
  g.status = "playing";
  g.zombies = [];
  g.nextSpawn = Number.MAX_SAFE_INTEGER;
  g.surge.anchor = Number.MAX_SAFE_INTEGER;
  Object.assign(h, { x: 11.45, y: 10.5, heading: { x: 1, y: 0 } });
  const inventory = structuredClone(h.inventory),
    learning = JSON.stringify(g.study.learner),
    hp = h.hp;
  assert.equal(e.mode, "shared");
  assert.equal(e.state, "available");
  assert.ok(vault(g, h, shelf.id));
  for (let i = 0; i < 36; i++) step(g, 1 / 30);
  assert.equal(h.vault, undefined);
  assert.ok(h.x > 13.5);
  assert.ok(claimStation(g, h, f.stations[0].id));
  // The game has no local questions: the terminal gets the synthetic fixture.
  e.problem = devProblem(g, roadmap, eligible(roadmap, g.study));
  e.workspace = e.problem.starter;
  e.state = "in-progress";
  assert.ok(e.problem);
  assert.equal(e.state, "in-progress");
  assert.equal(h.hp, hp);
  assert.deepEqual(h.inventory, inventory);
  assert.deepEqual(h.access, []);
  assert.ok(!e.contributors.includes(h.id));
  assert.equal(shelf.hp, 1200);
  assert.deepEqual(shelf.credited, [other.id]);
  assert.equal(JSON.stringify(g.study.learner), learning);
  const saved = recover(decode(encode(g)));
  assert.deepEqual(saved.encounters[e.id].problem, e.problem);
  assert.equal(saved.encounters[e.id].state, "in-progress");
  assert.deepEqual(saved.survivors[0].access, []);
});
