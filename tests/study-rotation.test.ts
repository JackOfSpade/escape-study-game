import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { applyCompletion, ensureProblem } from "../src/ai";
import { completionVerdict } from "../src/completion-verdict";
import { beginVisit, eligible, initialStudy } from "../src/curriculum";
import { complete } from "../src/engine";
import { TestRunner } from "../src/gametest/runner";
import { emptyScenario } from "../src/gametest/schema";
import {
  event,
  type Encounter,
  type Roadmap,
  type Submission,
  type Track,
} from "../src/model";
import { decode, encode, recover } from "../src/persistence";
import { devProblem } from "../src/practice-problem";
import { retainRunLearning } from "../src/run-learning";
import {
  enterStudyWorkspace,
  nextWorkspaceQuestion,
} from "../src/study-workspace";
import { recordSpawn, spawnContract } from "../src/topic-spawn";
import { createPlayableGame } from "../src/world";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
function world(profile: "development" | "live" = "development") {
  const runner = new TestRunner(
    {
      ...emptyScenario(),
      id: "study-track-rotation",
      template: "building",
      layout: "randomized",
      rules: "force-fields",
      simulation: "game",
      maxTicks: 1,
      checks: [
        {
          name: "Human survives",
          mode: "always",
          query: { type: "property", id: "human", field: "alive" },
          op: "eq",
          expected: true,
        },
      ],
    },
    roadmap,
  );
  assert.equal(runner.run().status, "passed");
  runner.game.study = initialStudy(roadmap, profile);
  return runner.game;
}
function practice(g: ReturnType<typeof world>, id: string) {
  const formal = eligible(roadmap, g.study);
  recordSpawn(g.study, formal, `cool-${id}`, g.time);
  const contract = spawnContract(roadmap, g.study, formal);
  assert.equal(contract.practice, true);
  const source = Object.values(g.encounters).find((e) => e.mode === "solo")!;
  const e: Encounter = {
    ...structuredClone(source),
    id,
    runId: g.id,
    owner: "human",
    state: "in-progress",
    history: [],
    tutor: [],
    group: [],
    submissions: [],
    contributors: [],
    revision: 0,
    workspace: "",
    npcProgress: 0,
  };
  delete e.questionRoom;
  delete e.problemPresentedSequence;
  e.problem = devProblem(g, roadmap, contract);
  g.encounters[id] = e;
  beginVisit(roadmap, g.study, e);
  return e;
}
function finishHuman(g: ReturnType<typeof world>, e: Encounter) {
  const wasConsumed = e.state === "consumed";
  let s = e.submissions.find((s) => s.id === `answer-${e.id}`);
  if (!s) {
    const ev = event(
      g,
      "submission",
      "Synthetic bounded human answer",
      e.floor,
      "human",
      e.id,
    );
    e.history.push({
      seq: ev.seq,
      at: g.time,
      author: "human",
      kind: "reasoning",
      text: ev.text,
      revision: e.revision,
    });
    s = {
      id: `answer-${e.id}`,
      author: "human",
      content: ev.text,
      revision: e.revision,
      seq: ev.seq,
      status: "pending",
      feedback: "",
    } satisfies Submission;
    e.submissions.push(s);
  }
  applyCompletion(
    g,
    e,
    roadmap,
    s,
    completionVerdict({
      complete: true,
      qualified: ["human"],
      feedback: "Synthetic validated human completion",
    }),
  );
  return !wasConsumed && e.state === "consumed";
}

for (const profile of ["development", "live"] as const) {
  test(`${profile}: completed human practice follows PY/PE/PE across reload and runs without academic credit`, () => {
    let g = world(profile);
    const before = structuredClone(g.study);
    const tracks: Track[] = [];
    for (let i = 0; i < 7; i++) {
      const e = practice(g, `practice-${i}`);
      tracks.push(e.problem!.contract.track);
      assert.equal(finishHuman(g, e), true);
      assert.equal(finishHuman(g, e), false);
      assert.equal(
        complete(g, e.id, "duplicate", ["human"], "Duplicate"),
        false,
      );
      g = recover(decode(encode(g)));
      retainRunLearning(g, true);
      g = createPlayableGame(1200 + i, roadmap, g.study);
    }
    assert.deepEqual(tracks, ["PY", "PE", "PE", "PY", "PE", "PE", "PY"]);
    assert.equal(g.study.cycle, before.cycle);
    assert.deepEqual(g.study.visits, before.visits);
    assert.deepEqual(g.study.queues, before.queues);
    assert.deepEqual(g.study.learner!.cells, before.learner!.cells);
    assert.deepEqual(g.study.learner!.attempts, before.learner!.attempts);
    assert.deepEqual(g.study.learner!.evidence, before.learner!.evidence);
  });
}

test("NPC completions and off-track saved questions cannot skip the next Python turn", () => {
  const g = world();
  g.study.cycle = 1;
  const oldPE = practice(g, "old-pe");
  g.study.cycle = 0;
  finishHuman(g, oldPE);
  assert.equal(eligible(roadmap, g.study).track, "PY");
  const npc = practice(g, "npc");
  complete(g, npc.id, "npc-answer", ["npc-0"], "NPC work");
  assert.equal(eligible(roadmap, g.study).track, "PY");
});

test("a completed practice question advances the shared scheduler used by standalone study", async () => {
  const g = world();
  const e = practice(g, "game-practice");
  finishHuman(g, e);
  enterStudyWorkspace(g);
  const next = nextWorkspaceQuestion(g, roadmap);
  await ensureProblem(g, next, roadmap);
  assert.equal(next.problem!.contract.track, "PE");
  beginVisit(roadmap, g.study, next);
  finishHuman(g, next);
  assert.equal(g.study.visits.length, 1);
  assert.equal(eligible(roadmap, g.study).track, "PE");
});

test("untouched solo terminals refresh a preloaded old track while issued questions stay frozen", async () => {
  const g = world();
  const untouched = Object.values(g.encounters).find((e) => e.mode === "solo")!;
  untouched.owner = "human";
  const frozen = structuredClone(untouched);
  frozen.id = "issued-question";
  frozen.problemPresentedSequence = 7;
  g.encounters[frozen.id] = frozen;
  const original = structuredClone(frozen.problem);
  const e = practice(g, "practice");
  finishHuman(g, e);
  const before = structuredClone({
    rng: g.rng,
    floors: g.floors,
    learner: g.study.learner,
  });
  await ensureProblem(g, untouched, roadmap);
  assert.equal(untouched.problem!.contract.track, "PE");
  assert.deepEqual(
    { rng: g.rng, floors: g.floors, learner: g.study.learner },
    before,
  );
  await ensureProblem(g, frozen, roadmap);
  assert.deepEqual(frozen.problem, original);
});

test("preloaded NPC work and shared room questions are preserved after the track changes", async () => {
  const g = world();
  const source = Object.values(g.encounters).find((e) => e.mode === "solo")!;
  const npc = structuredClone(source);
  npc.id = "npc-work";
  npc.npcProgress = 0.3;
  g.encounters[npc.id] = npc;
  const shared = structuredClone(source);
  shared.id = "shared-work";
  shared.mode = "shared";
  g.encounters[shared.id] = shared;
  const originals = [
    structuredClone(npc.problem),
    structuredClone(shared.problem),
  ];
  const e = practice(g, "human-practice");
  finishHuman(g, e);
  await ensureProblem(g, npc, roadmap);
  await ensureProblem(g, shared, roadmap);
  assert.deepEqual([npc.problem, shared.problem], originals);
});
