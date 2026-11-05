import assert from "node:assert/strict";
import test from "node:test";
import { step } from "../src/engine";
import {
  studyLoopDecision,
  studyLoopMetrics,
  STUDY_LOOP,
} from "../src/npc-study-loop";
import { canSee } from "../src/visibility";
import { decode, encode } from "../src/persistence";
import { loopFixture } from "./helpers/study-loop";

test("a chased NPC draws a zombie away and returns for real terminal work", () => {
  const { g, a, e } = loopFixture();
  let displaced = false,
    workAfterLure = false;
  for (let i = 0; i < 2700; i++) {
    step(g, 1 / 30);
    if (Math.hypot(g.zombies[0].x - 15.5, g.zombies[0].y - 15.5) > 6)
      displaced = true;
    if (
      displaced &&
      a.activity === "studying" &&
      a.station === "study" &&
      e.npcProgress > 0 &&
      a.studyLoop?.phase === "work" &&
      Math.hypot(a.x - 15.5, a.y - 15.5) < 1.3
    )
      workAfterLure = true;
    if (!a.alive) break;
  }
  assert.ok(
    g.events.some((e) => e.type === "npc-loop-start"),
    "Must use a deliberate study loop",
  );
  assert.ok(
    displaced,
    "Real pursuit must draw the zombie away from the terminal",
  );
  assert.ok(
    workAfterLure,
    "Must physically return and record academic progress after drawing the zombie away",
  );
  assert.equal(g.study.learner!.evidence.length, 0);
});

test("an almost-finished puzzle can complete during a real return window without human mastery", () => {
  const { g, a, e } = loopFixture();
  e.npcProgress = 0.95;
  a.thought = 23.8;
  // Begin away from the station, with a pursuer between the actor and its work.
  a.x = 10.5;
  g.zombies[0].x = 13;
  g.zombies[0].y = 15.5;
  for (let i = 0; i < 2700 && a.alive && e.state !== "consumed"; i++)
    step(g, 1 / 30);
  assert.equal(e.state, "consumed");
  assert.ok(a.access.includes(0));
  assert.equal(a.keys, 1);
  assert.equal(g.study.learner!.evidence.length, 0);
});
test("planning cadence and candidate counts stay bounded independently of frame rate", () => {
  const { g, a } = loopFixture();
  a.x = 10.5;
  g.zombies[0].x = 13;
  const m = studyLoopMetrics(g);
  for (let i = 0; i < 300; i++) {
    g.time = i / 30;
    studyLoopDecision(g, a, g.zombies);
  }
  assert.ok(m.decisions > 0);
  assert.ok(m.decisions <= 11, JSON.stringify(m));
  assert.ok(m.candidates <= m.decisions * (STUDY_LOOP.candidates + 1));
});
test("unseen zombie positions cannot influence a loop plan", () => {
  const { g, a } = loopFixture();
  g.time = 1;
  a.x = 10.5;
  g.zombies[0].x = 13;
  const hidden = {
    ...structuredClone(g.zombies[0]),
    id: "hidden",
    x: 35,
    y: 28,
  };
  g.zombies.push(hidden);
  const make = (x: number) => {
    const copy = decode(encode(g));
    copy.zombies[1].x = x;
    const actor = copy.survivors[1];
    const observed = copy.zombies.filter((z) =>
      canSee(copy.floors[0], actor, z, 9),
    );
    studyLoopDecision(copy, actor, observed);
    return JSON.stringify(actor.studyLoop);
  };
  assert.equal(make(35), make(38));
});
test("a room nobody has opened still allows loop study, but foreign ownership and stair credentials exclude it", () => {
  {
    const { g, a, e } = loopFixture();
    delete e.problem;
    assert.deepEqual(studyLoopDecision(g, a, g.zombies), { mode: "work" });
  }
  for (const reason of ["owner", "access"] as const) {
    const { g, a, e } = loopFixture();
    if (reason === "owner") e.owner = "someone-else";
    if (reason === "access") a.access.push(0);
    assert.equal(studyLoopDecision(g, a, g.zombies), undefined);
    assert.equal(a.studyLoop, undefined, reason);
  }
});
test("closed red fields remain solid; loops cannot grant remote progress or access", () => {
  const { g, a, f, e } = loopFixture();
  for (let y = 1; y < 33; y++) f.tiles[y][18] = 1;
  for (let y = 14; y <= 16; y++) f.tiles[y][18] = 0;
  f.furniture = [
    {
      id: "locked",
      kind: "door",
      floor: 0,
      x: 18.5,
      y: 15.5,
      w: 1,
      h: 3,
      hp: 10000,
      maxHp: 10000,
      speed: 0,
      rotation: 0,
      destroyed: false,
      movers: [],
      moved: 0,
      credited: [],
      turning: 0,
      field: { exit: true, authorized: [], crossing: [], sides: {}, used: 0 },
    },
  ];
  f.stations[0].x = 22.5;
  for (let i = 0; i < 1500; i++) step(g, 1 / 30);
  assert.ok(a.x < 18);
  assert.equal(e.npcProgress, 0);
  assert.equal(a.keys, 0);
  assert.deepEqual(a.access, []);
  assert.equal(f.furniture[0].field!.authorized.length, 0);
  assert.ok(g.events.some((e) => e.type === "npc-loop-abandon"));
});
test("an active loop survives a synthetic checkpoint and continues actual study", () => {
  const { r } = loopFixture();
  r.scenario.actions.push({ tick: 180, type: "checkpoint" });
  let worked = false;
  for (let i = 0; i < 2700; i++) {
    r.advance(1);
    const a = r.game.survivors[1],
      e = r.game.encounters[a.intent ?? ""];
    if (
      a.studyLoop?.phase === "work" &&
      a.station === "study" &&
      Math.hypot(a.x - 15.5, a.y - 15.5) < 1.3 &&
      e?.npcProgress > 0
    )
      worked = true;
  }
  assert.equal(r.error, undefined);
  assert.ok(r.actionResults.some((a) => a.type === "checkpoint" && a.ok));
  assert.ok(worked);
});
test("overwhelmed NPCs still take damage and die; a loop grants no immunity or free solve", () => {
  const { g, a, e, f } = loopFixture();
  a.hp = 10;
  for (let y = 13; y <= 17; y++)
    for (let x = 13; x <= 17; x++)
      if (y === 13 || y === 17 || x === 13 || x === 17) f.tiles[y][x] = 1;
  g.zombies = Array.from({ length: 6 }, (_, i) => ({
    ...structuredClone(g.zombies[0]),
    id: `z-${i}`,
    x: 15.5 + Math.cos((i * Math.PI) / 3) * 1.1,
    y: 15.5 + Math.sin((i * Math.PI) / 3) * 1.1,
  }));
  for (let i = 0; i < 600 && a.alive; i++) step(g, 1 / 30);
  assert.equal(a.alive, false);
  assert.equal(a.hp, 0);
  assert.notEqual(e.state, "consumed");
  assert.deepEqual(a.access, []);
});

test("ordinary retreat and return keeps working without invoking desperation planning", () => {
  const { g, a, e } = loopFixture(42, false);
  let worked = 0;
  for (let i = 0; i < 600; i++) {
    step(g, 1 / 30);
    if (a.station === "study" && Math.hypot(a.x - 15.5, a.y - 15.5) < 1.3)
      worked++;
  }
  assert.ok(worked > 0);
  assert.ok(e.npcProgress > 0);
  assert.equal(
    g.events.some((e) => e.type === "npc-loop-start"),
    false,
  );
});
