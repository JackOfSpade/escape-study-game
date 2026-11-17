import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  activateCareerFocus,
  careerPriority,
  careerProfileSummary,
  careerScopeGuidance,
  CORE_IDS,
  effectiveTarget,
  REFERENCE_IDS,
} from "../src/career-profile";
import { beginVisit, eligible, initialStudy } from "../src/curriculum";
import { curriculumReadiness } from "../src/final-requirements";
import { eligibleLearning, reconcileGates } from "../src/learner";
import { parseProbeReply, probeContract } from "../src/knowledge-probe";
import type { Roadmap } from "../src/model";
import { createGame } from "./helpers/record";
const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
const at = "2026-10-22T16:00:00Z";

test("the exact 51 objective role core changes future PE targets while Python and the source stay intact", () => {
  assert.equal(CORE_IDS.length, 51);
  assert.equal(new Set(CORE_IDS).size, 51);
  assert.equal(CORE_IDS.filter((id) => REFERENCE_IDS.includes(id)).length, 0);
  const before = JSON.stringify(r);
  for (const o of r.tracks.PE.objectives) {
    assert.equal(effectiveTarget(o), o.target);
    assert.equal(effectiveTarget(o, "full"), o.target);
    assert.equal(
      effectiveTarget(o, "product-feature-owner"),
      CORE_IDS.includes(o.id) ? Math.min(o.target, 3) : 0,
    );
  }
  for (const o of r.tracks.PY.objectives)
    assert.equal(effectiveTarget(o, "product-feature-owner"), o.target);
  assert.equal(careerPriority("PE:T04.1"), "reference");
  assert.equal(careerPriority("PE:T02.2"), "optional");
  const s = initialStudy(r, "live");
  const retained = structuredClone({
    cells: s.learner!.cells,
    reviews: s.learner!.reviews,
    evidence: s.learner!.evidence,
  });
  activateCareerFocus(r, s);
  assert.equal(careerProfileSummary(r, s).core, 51);
  assert.ok(
    careerProfileSummary(r, s).active.required <
      careerProfileSummary(r, s).full.required,
  );
  assert.equal(
    (s.learner as unknown as { careerCarryover?: unknown }).careerCarryover,
    undefined,
    "activation before world creation issues no old contract",
  );
  assert.deepEqual(
    {
      cells: s.learner!.cells,
      reviews: s.learner!.reviews,
      evidence: s.learner!.evidence,
    },
    retained,
  );
  assert.equal(JSON.stringify(r), before);
});

test("future development and live questions use only core objectives", () => {
  for (const profile of ["development", "live"] as const) {
    const s = initialStudy(r, profile);
    activateCareerFocus(r, s);
    s.cycleOffset = 1;
    s.learner!.cycleOffset = 1;
    const formal = eligible(r, s, "2026-10-22");
    assert.equal(formal.track, "PE");
    assert.ok(
      formal.objectiveIds.every((id) => careerPriority(id) === "core"),
      formal.objectiveIds.join(),
    );
  }
  const s = initialStudy(r, "live");
  const g = createGame(12, r, s);
  const e = Object.values(g.encounters)[0];
  const contract = eligibleLearning(r, s.learner!, at);
  e.problem = {
    title: "Synthetic issued question",
    prompt: "Explain the issued task",
    starter: "",
    rubric: ["Explain"],
    provenance: "study-mode",
    contract,
  };
  beginVisit(r, s, e);
  const issued = structuredClone(e.problem);
  const attempt = structuredClone(s.learner!.attempts[0]);
  activateCareerFocus(r, s);
  assert.deepEqual(e.problem, issued);
  assert.deepEqual(s.learner!.attempts[0], attempt);
  assert.deepEqual(eligibleLearning(r, s.learner!, at), contract);
});

test("focused PE finishes at depth3, preserves PY4 and full readiness, and full restore reopens deferred work and reviews", () => {
  const s = initialStudy(r, "live"),
    l = s.learner!;
  activateCareerFocus(r, s);
  // Isolated planner cells, never exported as learner evidence.
  for (const o of r.tracks.PE.objectives)
    if (careerPriority(o.id) === "core")
      for (let d = 1; d <= effectiveTarget(o, "product-feature-owner"); d++)
        l.cells[o.id].states[d - 1] = "P";
  for (const o of r.tracks.PY.objectives)
    for (let d = 1; d <= Math.min(o.target, 3); d++)
      l.cells[o.id].states[d - 1] = "P";
  l.tracks.PE = {
    tier: 3,
    cleared: 2,
    phase: "REPAIR_VERIFY",
    lap: 1,
    queue: [],
    suspended: [],
  };
  l.tracks.PY = {
    tier: 3,
    cleared: 2,
    phase: "REPAIR_VERIFY",
    lap: 1,
    queue: [],
    suspended: [],
  };
  l.reviews = {
    "PE:T04.1/D1": {
      objectiveId: "PE:T04.1",
      depth: 1,
      due: "2020-01-01",
      stage: 0,
      verifiedReviews: 0,
    },
  };
  reconcileGates(r, l);
  assert.equal(l.tracks.PE.phase, "COMPLETE");
  assert.equal(l.tracks.PE.cleared, 3);
  assert.equal(l.tracks.PE.tier, 3);
  assert.equal(l.tracks.PY.tier, 4, "Python keeps its original final tier");
  assert.equal(curriculumReadiness(r, l, "PE").curriculumTargetsMet, false);
  l.reviews = {};
  const python = eligibleLearning(r, l, at);
  assert.equal(python.track, "PY");
  assert.equal(python.depth, 4);
  l.reviews = {
    "PE:T04.1/D1": {
      objectiveId: "PE:T04.1",
      depth: 1,
      due: "2020-01-01",
      stage: 0,
      verifiedReviews: 0,
    },
  };
  const unchanged = JSON.stringify({
    cells: l.cells,
    reviews: l.reviews,
    evidence: l.evidence,
  });
  activateCareerFocus(r, s, "full");
  assert.notEqual(l.tracks.PE.phase, "COMPLETE");
  l.cycleOffset = 1;
  const restored = eligibleLearning(r, l, at);
  assert.equal(restored.objectiveIds[0], "PE:T04.1");
  assert.equal(restored.review, true);
  assert.equal(
    JSON.stringify({
      cells: l.cells,
      reviews: l.reviews,
      evidence: l.evidence,
    }),
    unchanged,
  );
});

test("new probes are bounded to one prerequisite level and scope guidance excludes protocol trivia", () => {
  const c = { track: "PE" as const, objectiveIds: ["PE:T04.1"], depth: 1 };
  assert.match(
    careerScopeGuidance(c, "product-feature-owner"),
    /never add them as mandatory facets/,
  );
  assert.equal(careerScopeGuidance(c, "full"), "");
  const facets = [{ id: "root", description: "Explain rendering" }];
  assert.equal(
    probeContract({ rubric: ["Explain rendering"] }).maxPrerequisiteDepth,
    1,
  );
  const reply = {
    text: "Recorded",
    complete: true,
    outcome: "gap",
    knowledge: {
      facets: [
        {
          id: "child",
          description: "Needed concept",
          partOf: "root",
          status: "gap",
        },
        {
          id: "grandchild",
          description: "Protocol internals",
          partOf: "child",
          status: "gap",
        },
      ],
    },
  };
  assert.deepEqual(
    parseProbeReply(reply, facets, 1).findings.map((f) => f.id),
    ["child"],
  );
  assert.equal(
    parseProbeReply(reply, facets).findings.length,
    2,
    "legacy parser can read retained depth2 observations",
  );
});
