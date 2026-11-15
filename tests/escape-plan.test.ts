import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  requestPlan,
  resetDirectorRequest,
  setDirectorRequest,
} from "../src/director";
import {
  activePlan,
  adoptPlan,
  currentStep,
  fallbackTruth,
  offlinePlan,
  parsePlanAnswer,
  parseTruthSheet,
  planAnchors,
  planObjective,
  planRequest,
  planTick,
} from "../src/escape-plan";
import { createEscapeState, loopReset } from "../src/escape-state";
import {
  PLAN_MEANS,
  PLAN_RESOURCES,
  type TruthSheet,
} from "../src/escape-types";
import type { Game, Roadmap } from "../src/model";
import { planKeyAction } from "../src/plan-box";
import { createPlayableGame } from "../src/world";
import {
  PLAN_MEANS as CONTRACT_MEANS,
  PLAN_RESOURCES as CONTRACT_RESOURCES,
  validateEscapeAnswer,
} from "../scripts/lib/escape-contracts.mjs";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);

function escapeRun(seed = 5): Game {
  const g = createPlayableGame(seed, roadmap);
  g.status = "playing";
  g.paused = false;
  g.zombies = [];
  g.nextSpawn = 1e9;
  g.escape = createEscapeState(g, { gender: "female", seed });
  return g;
}

/** A sheet where only the named means gets out and nothing else is odd. */
function sheet(viable: TruthSheet["viable"], extra: Partial<TruthSheet> = {}) {
  const base = fallbackTruth(1);
  const means: TruthSheet["means"] = {};
  for (const name of PLAN_MEANS)
    means[name] =
      name === viable
        ? { outcome: "escapes", reveal: "You are out." }
        : { outcome: "wall", reveal: `No way out by ${name}.` };
  return { ...base, viable, means, resources: {}, ...extra } as TruthSheet;
}

/** Put the human on the current step and stand still until it is done. */
function carryOut(g: Game, seconds = 90) {
  const effects: string[] = [];
  for (let t = 0; t < seconds * 10; t++) {
    const step = currentStep(activePlan(g.escape));
    if (!step) break;
    const a = g.survivors[0];
    a.x = step.at.x;
    a.y = step.at.y;
    a.floor = step.at.floor;
    g.time += 0.1;
    const effect = planTick(g, 0.1);
    if (effect.kind !== "none") effects.push(effect.kind);
    if (effect.kind === "escape" || effect.kind === "die") break;
  }
  return effects;
}

test("the plan vocabulary is the same in the game and in the AI contract", () => {
  assert.deepEqual([...CONTRACT_MEANS], [...PLAN_MEANS]);
  assert.deepEqual([...CONTRACT_RESOURCES], [...PLAN_RESOURCES]);
});

test("every seed's fallback truth sheet is valid and has a way out", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const truth = fallbackTruth(seed);
    assert.deepEqual(parseTruthSheet(truth), truth, `seed ${seed}`);
    assert.equal(truth.means[truth.viable]?.outcome, "escapes");
    assert.notEqual(truth.viable, "walk-out", "walking out is never free");
    assert.deepEqual(fallbackTruth(seed), truth, "the same seed repeats");
  }
});

test("a truth sheet without a working way out, or that walls it off, is rejected", () => {
  const good = sheet("drive");
  assert.ok(parseTruthSheet(good));
  const noRule = structuredClone(good);
  delete noRule.means.sail;
  assert.equal(parseTruthSheet(noRule), undefined, "every means needs a rule");
  const deadEnd = structuredClone(good);
  deadEnd.means.drive = { outcome: "wall", reveal: "Closed." };
  assert.equal(parseTruthSheet(deadEnd), undefined, "viable must escape");
  const walled = structuredClone(good);
  walled.resources.vehicle = { kind: "wall", reveal: "No cars at all." };
  assert.equal(
    parseTruthSheet(walled),
    undefined,
    "the way that works cannot depend on a wall",
  );
});

test("a plan request never carries the catastrophe or the truth sheet", () => {
  const g = escapeRun();
  g.escape!.truth = sheet("drive");
  const text = JSON.stringify(planRequest(g, "hotwire a car", "plan-1"));
  assert.ok(!text.includes(g.escape!.catastrophe.id));
  assert.ok(!text.includes("No way out by"));
  assert.ok(!/truth|catastrophe|viable/.test(text));
});

test("a plan that works: reach, then work, then out", () => {
  const g = escapeRun();
  g.escape!.truth = sheet("drive");
  const plan = adoptPlan(g, "drive away", offlinePlan(g, "hotwire the car"))!;
  assert.equal(plan.means, "drive");
  assert.equal(plan.steps.length, 2);
  assert.deepEqual(planObjective(g)?.title, plan.steps[0].text);
  assert.deepEqual(carryOut(g), ["escape"]);
  assert.equal(plan.state, "escaped");
});

test("a gap adds one more thing to do, writes what was found, and the plan goes on", () => {
  const g = escapeRun();
  g.escape!.truth = sheet("drive", {
    resources: {
      vehicle: {
        kind: "gap",
        reveal: "The engine bay is empty.",
        fix: { text: "Find an engine", label: "spare engine", seconds: 4 },
      },
    },
  });
  const plan = adoptPlan(g, "drive away", offlinePlan(g, "drive the van"))!;
  const effects = carryOut(g);
  assert.deepEqual(effects, ["escape"]);
  assert.deepEqual(
    plan.steps.map((s) => s.label),
    [plan.steps[0].label, "spare engine", plan.steps[2].label],
    "the fix was inserted before the step that needed it",
  );
  assert.ok(
    g.escape!.ledger.journal.some((e) => e.line === "The engine bay is empty."),
    "the journal keeps what the world showed",
  );
  assert.ok(g.escape!.places?.["spare engine"], "the engine has a fixed place");
});

test("a wall ends the plan and tells the player why", () => {
  const g = escapeRun();
  g.escape!.truth = sheet("drive", {
    resources: {
      exit: {
        kind: "wall",
        reveal: "Men at the gate turn you back.",
        harm: 20,
      },
    },
  });
  const plan = adoptPlan(g, "walk out", offlinePlan(g, "walk out the door"))!;
  assert.deepEqual(carryOut(g), ["harm"]);
  assert.equal(plan.state, "failed");
  assert.equal(plan.outcome, "Men at the gate turn you back.");
  assert.equal(activePlan(g.escape), undefined);
  assert.equal(g.notice, "Men at the gate turn you back.");
});

test("a way out the sheet makes deadly kills at the last step, not before", () => {
  const g = escapeRun();
  const truth = sheet("climb");
  truth.means.drive = { outcome: "dies", reveal: "The car goes up in flame." };
  g.escape!.truth = truth;
  const plan = adoptPlan(g, "drive away", offlinePlan(g, "drive a car"))!;
  assert.deepEqual(carryOut(g), ["die"]);
  assert.equal(plan.state, "failed");
  assert.ok(plan.steps.every((s) => s.state === "done"));
});

test("timed steps only progress while the player stands still at the spot", () => {
  const g = escapeRun();
  g.escape!.truth = sheet("drive");
  const plan = adoptPlan(g, "drive", offlinePlan(g, "drive a car"))!,
    a = g.survivors[0],
    work = plan.steps[1];
  plan.steps[0].state = "done";
  a.floor = work.at.floor;
  a.x = work.at.x + 30;
  a.y = work.at.y;
  planTick(g, 0.1);
  assert.equal(work.progress, 0, "far away: nothing happens");
  a.x = work.at.x;
  planTick(g, 0.1);
  for (let i = 0; i < 10; i++) {
    a.x += 0.1;
    planTick(g, 0.1);
  }
  const moving = work.progress;
  for (let i = 0; i < 10; i++) planTick(g, 0.1);
  assert.ok(work.progress > moving + 0.8, "standing still is what counts");
  assert.ok(moving < 0.3, `walking about made ${moving}s of progress`);
});

test("a new plan drops the old one, and a restart keeps the truth and the places only", () => {
  const g = escapeRun();
  const first = adoptPlan(g, "drive", offlinePlan(g, "drive a car"))!;
  const second = adoptPlan(g, "climb", offlinePlan(g, "climb to the roof"))!;
  assert.equal(first.state, "dropped");
  assert.equal(activePlan(g.escape), second);
  g.escape!.truth = sheet("climb");
  const next = loopReset(g.escape!);
  assert.equal(next.plans, undefined);
  assert.deepEqual(next.truth, g.escape!.truth);
  assert.deepEqual(next.places, g.escape!.places);
});

test("the builder's answer is used when valid and replaced offline when not", async () => {
  const g = escapeRun();
  const anchor = planAnchors(g)[0].id;
  const answer = {
    verdict: "possible",
    reply: "The staff cars are out front.",
    means: "drive",
    steps: [
      {
        kind: "reach",
        text: "Get to the staff car park",
        label: "staff car",
        anchorId: anchor,
        resource: "none",
        seconds: 0,
      },
      {
        kind: "work",
        text: "Get the car started",
        label: "staff car",
        anchorId: anchor,
        resource: "vehicle",
        seconds: 10,
      },
    ],
  };
  assert.ok(parsePlanAnswer(g, answer));
  assert.equal(
    parsePlanAnswer(g, {
      ...answer,
      steps: [{ ...answer.steps[0], anchorId: "nowhere" }],
    }),
    undefined,
    "a step must be at a real place",
  );
  try {
    setDirectorRequest(async (operation, payload) => {
      assert.equal(operation, "escape-plan");
      return {
        requestId: (payload as { requestId: string }).requestId,
        ...answer,
      };
    });
    await new Promise<void>((done) =>
      assert.ok(requestPlan(g, "take a staff car", done)),
    );
    assert.equal(g.notice, "The staff cars are out front.");
    assert.equal(activePlan(g.escape)?.steps.length, 2);
    assert.equal(g.escape!.planPending, undefined);

    setDirectorRequest(async () => ({ nonsense: true }));
    await new Promise<void>((done) =>
      requestPlan(g, "climb to the roof", done),
    );
    assert.equal(
      activePlan(g.escape)?.means,
      "climb",
      "offline plan took over",
    );

    setDirectorRequest(async () => ({
      verdict: "impossible",
      reply: "There is no sea here.",
    }));
    const before = activePlan(g.escape);
    await new Promise<void>((done) => requestPlan(g, "sail away", done));
    assert.equal(g.notice, "There is no sea here.");
    assert.equal(
      activePlan(g.escape),
      before,
      "an impossible plan changes nothing",
    );
  } finally {
    resetDirectorRequest();
  }
});

test("the AI contract accepts a sound plan and truth sheet and rejects unsound ones", () => {
  const payload = {
    requestId: "plan-1",
    anchors: [{ id: "entrance", name: "the main entrance" }],
    people: [{ id: "npc-1", name: "Odile", role: "projectionist" }],
  };
  const step = {
    kind: "work",
    text: "Start the car",
    label: "staff car",
    anchorId: "entrance",
    resource: "vehicle",
    seconds: 10,
  };
  const good = {
    requestId: "plan-1",
    verdict: "possible",
    reply: "The cars are out front.",
    means: "drive",
    steps: [step],
  };
  assert.deepEqual(validateEscapeAnswer("escape-plan", payload, good), good);
  for (const bad of [
    { ...good, means: "teleport" },
    { ...good, steps: [] },
    { ...good, steps: [{ ...step, anchorId: "the moon" }] },
    { ...good, steps: [{ ...step, resource: "magic" }] },
    { ...good, steps: [{ ...step, kind: "ask" }] },
    { ...good, steps: [{ ...step, seconds: 600 }] },
  ])
    assert.throws(() => validateEscapeAnswer("escape-plan", payload, bad));
  assert.deepEqual(
    validateEscapeAnswer("escape-plan", payload, {
      requestId: "plan-1",
      verdict: "impossible",
      reply: "There is no sea here.",
    }),
    {
      requestId: "plan-1",
      verdict: "impossible",
      reply: "There is no sea here.",
    },
  );

  const truth = fallbackTruth(3);
  const truthPayload = { requestId: "truth-1" };
  const accepted = validateEscapeAnswer("escape-truth", truthPayload, {
    requestId: "truth-1",
    sheet: truth,
  }) as { sheet: unknown };
  assert.ok(parseTruthSheet(accepted.sheet), "the game can use what passes");
  const noWayOut = structuredClone(truth);
  noWayOut.means[truth.viable] = { outcome: "wall", reveal: "Closed." };
  assert.throws(() =>
    validateEscapeAnswer("escape-truth", truthPayload, {
      requestId: "truth-1",
      sheet: noWayOut,
    }),
  );
});

test("P opens the plan box only in a playable escape game, and Enter sends it", () => {
  const base = {
    open: false,
    inInput: false,
    key: "p",
    composing: false,
    repeat: false,
    modified: false,
    busy: false,
    planable: true,
  };
  assert.equal(planKeyAction(base), "open");
  assert.equal(planKeyAction({ ...base, planable: false }), "pass");
  assert.equal(planKeyAction({ ...base, busy: true }), "pass");
  assert.equal(planKeyAction({ ...base, modified: true }), "pass");
  const open = { ...base, open: true, inInput: true };
  assert.equal(planKeyAction({ ...open, key: "p" }), "pass", "typing a p");
  assert.equal(planKeyAction({ ...open, key: "Enter" }), "send");
  assert.equal(planKeyAction({ ...open, key: "Escape" }), "close");
  assert.equal(planKeyAction({ ...open, inInput: false, key: "w" }), "close");
});
