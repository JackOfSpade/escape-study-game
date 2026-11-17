import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evidencePacket } from "../src/curriculum";
import { beginLearningAttempt, eligibleLearning } from "../src/learner";
import type { Roadmap } from "../src/model";
import { devProblem } from "./helpers/practice-questions";
import { captureActiveAttempts } from "../src/roadmap-active-work";
import { createGame } from "./helpers/record";

test("retained long study histories stay usable for evidence and roadmap capture", async () => {
  const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8")),
    g = createGame(729, r),
    e = g.encounters["question-0"],
    l = g.study.learner!,
    at = "2026-10-20T12:00:00Z";
  g.study.profile = "live";
  const problem = devProblem(g, r, eligibleLearning(r, l, at));
  problem.provenance = "study-mode";
  e.problem = problem;
  beginLearningAttempt(r, l, e, at);
  const count = 150_001;
  e.group = Array.from({ length: count }, (_, i) => ({
    id: `synthetic-${i}`,
    author: "human",
    kind: "human",
    text: "Synthetic",
    seq: i + 1,
    worldTime: 0,
    provenance: "synthetic",
  }));
  e.history = Array.from({ length: count }, (_, i) => ({
    author: "runner",
    kind: "execution",
    text: "Synthetic",
    seq: i + 1,
    at: 0,
    revision: 0,
  }));
  assert.equal(evidencePacket(e, r).evidenceCutoffSequence, count);
  assert.equal((await captureActiveAttempts(g))[0].humanCutoff, count);
});
