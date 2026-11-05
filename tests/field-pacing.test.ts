import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  adoptQuestionPacing,
  FIELD_PACING,
  fieldPressureDps,
  initializeFieldPacing,
  rebalanceFields,
  solveEstimate,
  validSolveEstimate,
} from "../src/field-pacing";
import { redesign } from "../src/force-fields";
import { TestRunner } from "../src/gametest/runner";
import { emptyScenario } from "../src/gametest/schema";
import {
  type Furniture,
  type Game,
  type Problem,
  type Roadmap,
} from "../src/model";
import { decode, encode, recover } from "../src/persistence";
import { createGame, createPlayableGame } from "../src/world";
import { devProblem, preparePracticeRooms } from "./helpers/practice-questions";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);

/** Synthetic factories only: no save storage, study connector or AI request. */
function unpaced(seed = 42) {
  const g = createGame(seed, roadmap, undefined, { layout: "forward" });
  redesign(g, { randomized: true });
  preparePracticeRooms(g, roadmap);
  return g;
}

function entry(g: Game, floor = 0): Furniture {
  const field = g.floors[floor].furniture.find((o) => o.field?.publicEntry);
  assert.ok(field, `Missing public study field on floor ${floor}`);
  return field;
}

function problem(g: Game, seconds?: number, depth = 1): Problem {
  // Playable worlds carry no questions; the fixture supplies one without touching g.
  const source =
    Object.values(g.encounters).find((e) => e.problem)?.problem ??
    devProblem(structuredClone(g), roadmap);
  return {
    ...structuredClone(source),
    contract: { ...structuredClone(source.contract), depth },
    estimatedSolveSeconds: seconds,
  };
}

function geometry(g: Game) {
  return g.floors.map((f) => ({
    tiles: f.tiles,
    boundary: f.boundary,
    generation: f.generation,
    stations: f.stations,
    entry: f.entry,
    stairs: f.stairs,
    furniture: f.furniture.map((o) => ({
      id: o.id,
      kind: o.kind,
      x: o.x,
      y: o.y,
      w: o.w,
      h: o.h,
      field: o.field,
    })),
  }));
}

test("D1 gives the first study hall a 504-second deadline with a slower-player cushion", () => {
  const g = createPlayableGame(42, roadmap);
  const main = g.floors[0].furniture.find((o) => o.id === "main-gate")!;
  const field = entry(g);
  assert.equal(g.fieldPacing?.version, 1);
  assert.deepEqual(g.fieldPacing?.floors[0], {
    floor: 0,
    estimatedSolveSeconds: 180,
    deadline: 504,
    planning: {
      at: 0,
      holdSeconds: 297.21,
      upstreamSeconds: 26.79,
      graceSeconds: 180,
      referenceDps: 16.8,
      hp: 4994,
      maxHp: 4994,
      locked: false,
    },
  });
  assert.equal(main.hp, 600);
  assert.equal(fieldPressureDps(main), 22.4);
  assert.equal(fieldPressureDps(field), 16.8);
  // 180 s spawn grace + 600/22.4 s main gate + 4994/16.8 s study field.
  // This covers the 504 s deadline, rather than merely the 180 s estimate.
  const protection = 180 + main.hp / 22.4 + field.hp / 16.8;
  assert.equal(field.hp, 4994);
  assert.equal(field.maxHp, 4994);
  assert.ok(protection >= 504 && protection < 504.1, `${protection} seconds`);
  assert.ok(
    protection > 180 * 2,
    "The first puzzle allows a slow first attempt",
  );
});

test("alternative rooms and independent terminals share one maximum floor estimate", () => {
  const g = unpaced();
  const encounters = Object.values(g.encounters).filter(
    (e) => e.floor === 0 && e.questionRoom,
  );
  assert.ok(encounters.length > 4);
  for (const e of encounters) e.problem = problem(g, 600);
  encounters[0].problem = problem(g, 400);
  initializeFieldPacing(g);
  assert.equal(g.fieldPacing?.floors[0].estimatedSolveSeconds, 600);
  assert.equal(g.fieldPacing?.floors[0].deadline, 1260);
  const before = encode(g);
  for (let i = 0; i < encounters.length; i++)
    adoptQuestionPacing(g, 0, problem(g, 600));
  adoptQuestionPacing(g, 0, problem(g, 300));
  assert.equal(encode(g), before, "More alternatives do not add serial work");
  adoptQuestionPacing(g, 0, problem(g, 900));
  assert.equal(g.fieldPacing?.floors[0].estimatedSolveSeconds, 900);
  assert.equal(g.fieldPacing?.floors[0].deadline, 1800);
  assert.equal(g.fieldPacing?.floors[1].estimatedSolveSeconds, 180);
});

test("later floors credit only the remaining durability on the upstream route", () => {
  const laterHealth: number[] = [];
  for (const damage of [0, 600, 1200]) {
    const g = unpaced();
    const upstream = g.floors[0].furniture.find(
      (o) => o.id === "f0-room2-forward",
    )!;
    assert.equal(upstream.hp, 1200);
    upstream.hp -= damage;
    upstream.destroyed = upstream.hp === 0;
    initializeFieldPacing(g);
    assert.equal(
      entry(g).hp,
      4994,
      "A downstream door does not fund the first hall",
    );
    laterHealth.push(entry(g, 1).hp);
  }
  assert.deepEqual(laterHealth, [1449, 2049, 2649]);
});

test("late question generation uses an absolute run deadline and never refreshes grace", () => {
  const opening = unpaced();
  initializeFieldPacing(opening);
  adoptQuestionPacing(opening, 0, problem(opening, 600));

  const late = unpaced();
  late.time = 300;
  initializeFieldPacing(late);
  assert.equal(
    entry(late).hp,
    2978,
    "Elapsed unprotected time reduces new holding time",
  );
  adoptQuestionPacing(late, 0, problem(late, 600));
  assert.equal(late.time, 300);
  assert.equal(late.fieldPacing?.floors[0].deadline, 1260);
  assert.equal(
    late.fieldPacing?.floors[0].deadline,
    opening.fieldPacing?.floors[0].deadline,
  );
  assert.ok(
    Math.abs(entry(opening).hp - entry(late).hp - 120 * 16.8) <= 1,
    "Only the original first 180 seconds are credited as spawn grace",
  );
  const hp = entry(late).hp;
  late.time = 600;
  initializeFieldPacing(late);
  adoptQuestionPacing(late, 0, problem(late, 600));
  rebalanceFields(late);
  assert.equal(
    entry(late).hp,
    hp,
    "Retries neither refill nor shorten an intact promise",
  );
  assert.equal(late.fieldPacing?.floors[0].deadline, 1260);
});

test("only pristine fields can grow; damage and breaches survive harder questions and checkpoints", () => {
  const g = createPlayableGame(42, roadmap);
  const damaged = entry(g);
  const breached = entry(g, 1);
  const originalMax = damaged.maxHp;
  damaged.hp -= 37;
  breached.hp = 0;
  breached.destroyed = true;
  const pristine = entry(g, 2);
  const pristineMax = pristine.maxHp;
  const saved = recover(decode(encode(g)));
  for (const world of [g, saved]) {
    adoptQuestionPacing(world, 0, problem(world, 900));
    adoptQuestionPacing(world, 1, problem(world, 900));
    adoptQuestionPacing(world, 2, problem(world, 900));
    rebalanceFields(world);
    assert.equal(entry(world).hp, originalMax - 37);
    assert.equal(entry(world).maxHp, originalMax);
    assert.equal(entry(world, 1).hp, 0);
    assert.equal(entry(world, 1).destroyed, true);
    assert.ok(
      entry(world, 2).maxHp > pristineMax,
      "An untouched later hall may gain slack",
    );
    assert.equal(entry(world, 2).hp, entry(world, 2).maxHp);
  }
  assert.deepEqual(saved.fieldPacing, g.fieldPacing);
  assert.deepEqual(
    saved.floors.map((_, i) => (i < 4 ? entry(saved, i).hp : undefined)),
    g.floors.map((_, i) => (i < 4 ? entry(g, i).hp : undefined)),
  );
});

test("fresh playable worlds opt in while historical factories and saves retain their HP", () => {
  const legacy = createGame(42, roadmap);
  assert.equal(legacy.fieldPacing, undefined);
  initializeFieldPacing(legacy);
  assert.equal(legacy.fieldPacing, undefined, "Ordinary doors are not retuned");
  const redesigned = unpaced();
  assert.equal(redesigned.fieldPacing, undefined);
  assert.equal(entry(redesigned).hp, 1200);
  const saved = recover(decode(encode(redesigned)));
  assert.equal(saved.fieldPacing, undefined);
  assert.equal(entry(saved).hp, 1200);
  assert.equal(createPlayableGame(42, roadmap).fieldPacing?.version, 1);
});

test("save/reload preserves policy, remaining HP and question timing without reinitialization", () => {
  const g = createPlayableGame(42, roadmap);
  g.time = 237;
  adoptQuestionPacing(g, 1, problem(g, 700));
  entry(g).hp -= 53;
  const expected = structuredClone({
    policy: g.fieldPacing,
    fields: g.floors.flatMap((f) =>
      f.furniture
        .filter((o) => o.field)
        .map((o) => ({
          id: o.id,
          hp: o.hp,
          maxHp: o.maxHp,
          destroyed: o.destroyed,
        })),
    ),
  });
  const loaded = recover(decode(encode(g)));
  assert.equal(loaded.time, 237);
  assert.deepEqual(loaded.fieldPacing, expected.policy);
  assert.deepEqual(
    loaded.floors.flatMap((f) =>
      f.furniture
        .filter((o) => o.field)
        .map((o) => ({
          id: o.id,
          hp: o.hp,
          maxHp: o.maxHp,
          destroyed: o.destroyed,
        })),
    ),
    expected.fields,
  );
});

test("solve estimates are finite, bounded and fall back by academic depth", () => {
  const g = unpaced();
  for (const value of [
    undefined,
    null,
    "180",
    NaN,
    Infinity,
    -Infinity,
    -1,
    0,
    29,
    901,
  ])
    assert.equal(validSolveEstimate(value), false, String(value));
  for (const value of [30, 180, 899.5, 900]) {
    assert.equal(validSolveEstimate(value), true);
    assert.equal(solveEstimate(problem(g, value)), value);
  }
  for (const [depth, expected] of [
    [1, 180],
    [2, 300],
    [3, 450],
    [4, 600],
  ] as const) {
    assert.equal(solveEstimate(undefined, depth), expected);
    assert.equal(solveEstimate(problem(g, NaN, depth)), expected);
    assert.equal(solveEstimate(problem(g, Infinity, depth)), expected);
    assert.equal(solveEstimate(problem(g, 29, depth)), expected);
    assert.equal(solveEstimate(problem(g, 901, depth)), expected);
  }
  assert.equal(solveEstimate(undefined, NaN), 180);
  assert.equal(solveEstimate(undefined, Infinity), 180);
  assert.equal(solveEstimate(undefined, -1), 180);
  assert.equal(solveEstimate(undefined, 99), 600);
});

test("health respects finite hold and HP ceilings even after all upstream protection is gone", () => {
  const g = unpaced();
  initializeFieldPacing(g);
  adoptQuestionPacing(g, 0, problem(g, 900));
  adoptQuestionPacing(g, 1, problem(g, 900));
  for (const o of g.floors[0].furniture) {
    o.hp = 0;
    o.destroyed = true;
  }
  const field = entry(g, 1);
  field.w = 10;
  field.h = 1;
  rebalanceFields(g);
  assert.equal(field.maxHp, FIELD_PACING.maxHp);
  assert.equal(field.hp, 100_000);
  assert.ok(field.hp / fieldPressureDps(field) <= FIELD_PACING.maxHoldSeconds);
  for (const budget of g.fieldPacing!.floors) {
    assert.ok(Number.isFinite(budget.deadline));
    assert.ok(
      budget.estimatedSolveSeconds >= 30 && budget.estimatedSolveSeconds <= 900,
    );
  }
  for (let floor = 0; floor < 4; floor++) {
    const o = entry(g, floor);
    assert.ok(Number.isFinite(o.hp) && o.hp >= 0 && o.hp <= FIELD_PACING.maxHp);
  }
});

test("horizontal and vertical gate frontages receive equal holding time", () => {
  for (const width of [1, 2, 3, 4]) {
    assert.equal(
      fieldPressureDps({ w: width, h: 1 }),
      fieldPressureDps({ w: 1, h: width }),
    );
  }
  const horizontal = unpaced();
  const vertical = unpaced();
  for (const f of horizontal.floors)
    for (const o of f.furniture)
      if (o.field) Object.assign(o, { w: Math.max(o.w, o.h), h: 1 });
  for (const f of vertical.floors)
    for (const o of f.furniture)
      if (o.field) Object.assign(o, { w: 1, h: Math.max(o.w, o.h) });
  initializeFieldPacing(horizontal);
  initializeFieldPacing(vertical);
  assert.deepEqual(horizontal.fieldPacing, vertical.fieldPacing);
  for (let floor = 0; floor < 4; floor++)
    assert.equal(entry(horizontal, floor).hp, entry(vertical, floor).hp);
});

test("field pacing consumes no RNG and changes no generated layout", () => {
  for (const seed of [7, 42, 3705527980]) {
    const g = unpaced(seed);
    const before = structuredClone(geometry(g));
    const rng = g.rng;
    initializeFieldPacing(g);
    adoptQuestionPacing(g, 0, problem(g, 900));
    rebalanceFields(g);
    assert.equal(g.rng, rng);
    assert.deepEqual(geometry(g), before);
    const fresh = createPlayableGame(seed, roadmap);
    assert.equal(fresh.rng, rng);
    assert.deepEqual(geometry(fresh), before);
  }
});

test("normal zombie attacks consume a configured green field's minimum hold and breach after a checkpoint", () => {
  const scenario = emptyScenario();
  Object.assign(scenario, {
    id: "field-pacing-timed-breach",
    name: "One surge attacker consumes an isolated green field hold",
    startTime: 480,
    maxTicks: 930,
  });
  scenario.entities = [
    { id: "human", kind: "player", x: 17.5, y: 15.5 },
    { id: "attacker", kind: "zombie", x: 14.6, y: 15.5 },
    {
      id: "study-field",
      kind: "door",
      x: 15.5,
      y: 15.5,
      w: 1,
      h: 1,
      hp: 1,
      maxHp: 1,
      forceField: "green",
    },
  ];
  scenario.maps = [
    {
      floor: 0,
      rows: Array.from({ length: 34 }, (_, y) =>
        Array.from({ length: 44 }, (_, x) =>
          x === 0 || x === 43 || y === 0 || y === 33 || (x === 15 && y !== 15)
            ? "#"
            : ".",
        ).join(""),
      ),
    },
  ];
  scenario.actions = [{ tick: 451, type: "checkpoint" }];
  scenario.checks = [
    {
      name: "Real attacks reduce the initial health",
      mode: "at",
      tick: 300,
      query: { type: "property", id: "study-field", field: "hp" },
      op: "lte",
      expected: 140,
    },
    {
      name: "Holding time is not consumed immediately",
      mode: "at",
      tick: 810,
      query: { type: "property", id: "study-field", field: "hp" },
      op: "gte",
      expected: 1,
    },
    {
      name: "Timed attacks breach the field",
      mode: "at",
      tick: 930,
      query: { type: "property", id: "study-field", field: "hp" },
      op: "eq",
      expected: 0,
    },
    {
      name: "Player survives the protected interval",
      mode: "at",
      tick: 810,
      query: { type: "property", id: "human", field: "hp" },
      op: "eq",
      expected: 100,
    },
  ];
  const runner = new TestRunner(scenario, roadmap);
  const g = runner.game;
  g.rules = "force-fields";
  entryForArena(g).field!.publicEntry = true;
  Object.assign(g.surge, { state: "active", started: g.time, duration: 1000 });
  initializeFieldPacing(g);
  assert.equal(entry(g).hp, 168);
  assert.ok(Math.abs(entry(g).hp / fieldPressureDps(entry(g)) - 30) < 1e-10);
  runner.run();
  assert.equal(runner.status, "passed", JSON.stringify(runner.report()));
  assert.equal(runner.game.stats.breaches, 1);
  assert.ok(runner.game.events.some((e) => e.type === "barricade-hit"));
  assert.ok(runner.actionResults.some((a) => a.type === "checkpoint" && a.ok));
  assert.equal(entry(runner.game).maxHp, 168);
  assert.equal(entry(runner.game).destroyed, true);
});

function entryForArena(g: Game) {
  const field = g.floors[0].furniture.find((o) => o.id === "study-field");
  assert.ok(field?.field);
  return field;
}
