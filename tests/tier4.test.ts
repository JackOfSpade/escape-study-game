import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { curriculumReadiness } from "../src/final-requirements";
import {
  applyLearningAssessment,
  beginLearningAttempt,
  closeLearningSession,
  eligibleLearning,
  initialLearner,
  interruptLearningAttempt,
  reconcileGates,
  registerScopes,
} from "../src/learner";
import { scopeKey } from "../src/learning-model";
import type { Assessment, Encounter, Roadmap } from "../src/model";
import { decode, encode } from "../src/persistence";
import { prepareRoadmapExport } from "../src/roadmap-export";
import { createGame } from "./helpers/record";
import { tier4RoadmapFixture } from "./fixtures/tier4-roadmap";

const original: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
const at = "2026-10-16T16:00:00.000Z";

// Synthetic alternate source with prior ordinary checkpoint passes. Nothing is
// written to the user's roadmap/save and these fixtures are not human evidence.

function fixture(mode: "test" | "live" = "test") {
  const r = tier4RoadmapFixture(original),
    l = initialLearner(r, mode),
    g = createGame(7, r);
  l.reviews = {};
  for (const t of ["PY", "PE"] as const) l.tracks[t].cleared = 3;
  let serial = 0;
  const issue = (when = at) => {
    const c = eligibleLearning(r, l, when),
      id = c.objectiveIds[0];
    const e: Encounter = {
      ...structuredClone(g.encounters["question-0"]),
      id: `tier4-${++serial}`,
    };
    e.problem = {
      title: "Synthetic final task",
      prompt: "PRIVATE_SYNTHETIC_PROMPT",
      starter: "",
      provenance: "study-mode",
      rubric: ["scope"],
      contract: c,
      scopeDefinitions: [
        {
          id: scopeKey(id, c.depth),
          objectiveId: id,
          depth: c.depth,
          sourceScope: c.scopes[0],
          facets: [
            {
              id: "reasoning",
              description:
                "Explain central reasoning under changed assumptions",
            },
            {
              id: "boundary",
              description:
                "Independently justify the relevant validity boundaries",
            },
          ],
        },
      ],
    };
    e.history = [1, 2].map((seq) => ({
      seq,
      at: seq,
      wallTime: when,
      author: "human",
      kind: "reasoning",
      revision: 0,
      text: "PRIVATE_SYNTHETIC_RESPONSE",
    }));
    registerScopes(r, l, e);
    beginLearningAttempt(r, l, e, when);
    return e;
  };
  const proposal = (
    e: Encounter,
    facets = ["reasoning", "boundary"],
    outcome: "independent" | "assisted" | "contradicted" = "independent",
    usable = true,
  ): Assessment => ({
    id: `assessment-${serial}-${l.version}`,
    encounter: e.id,
    provenance: mode === "test" ? "test-fixture" : "study-mode",
    sourceVersion: l.version,
    status: "pending",
    evidenceCutoffSequence: 2,
    visitOutcome: usable ? "usable" : "unresolved",
    scopeReviews: [
      {
        id: e.problem!.scopeDefinitions![0].id,
        completeCoverage: true,
        rationale: "Synthetic complete source coverage review",
      },
    ],
    findings: facets.map((facet) => ({
      objectiveId: e.problem!.contract.objectiveIds[0],
      facet,
      depth: 4,
      outcome,
      evidence: [facet === "reasoning" ? 1 : 2],
      completeCheckpointScope: false,
      rationale: "Synthetic final-facet observation",
    })),
  });
  const apply = (e: Encounter, a = proposal(e), when = at) =>
    applyLearningAssessment(
      r,
      l,
      e,
      a,
      when,
      mode === "test" ? "test-fixture" : "study-mode",
    );
  return { r, l, g, issue, proposal, apply };
}

test("Tier 4 schedules all core transfers with 1:2 visits and never creates ordinary D4 cells", () => {
  const f = fixture();
  const cells = JSON.stringify(f.l.cells),
    visits: string[] = [];
  for (let i = 0; i < 3; i++) {
    const e = f.issue();
    visits.push(e.problem!.contract.objectiveIds[0]);
    assert.equal(e.problem!.contract.kind, "transfer");
    f.apply(e);
  }
  assert.deepEqual(visits, ["PY:T01", "PE:T01", "PE:T02"]);
  assert.deepEqual(eligibleLearning(f.r, f.l, at).objectiveIds, ["PY:T02"]);
  assert.equal(JSON.stringify(f.l.cells), cells);
  assert.equal(f.l.cells["PY:T01"], undefined);
  assert.equal(f.l.scopes["PY:T01/D4"], undefined);
  assert.ok(f.l.scopes["PY:T01/T4"]);
  assert.equal(f.l.finalProgress!["PY:T01"].status, "P");
});

test("ordinary core and selected-extension D4 work remains required alongside final requirements", () => {
  const f = fixture();
  const missing = [
    "PY:T16.5",
    "PE:T01.4",
    "PE:T07.5",
    "PE:T16.4",
    "PE:T19.5",
    "PE:X03.3",
    "PE:X07.3",
  ];
  for (const id of missing) f.l.cells[id].states[3] = "U";
  f.l.tracks.PE.queue.push("X03", "X07");
  const observed: string[] = [];
  for (let n = 0; n < 70; n++) {
    if (
      f.l.tracks.PY.phase === "COMPLETE" &&
      f.l.tracks.PE.phase === "COMPLETE"
    )
      break;
    const e = f.issue();
    if (e.problem!.contract.kind === "checkpoint")
      observed.push(e.problem!.contract.objectiveIds[0]);
    f.apply(e);
  }
  assert.deepEqual([...observed].sort(), [...missing].sort());
  assert.equal(f.l.tracks.PY.phase, "COMPLETE");
  assert.equal(f.l.tracks.PE.phase, "COMPLETE");
  assert.equal(Object.keys(f.l.cells).length, 192);
});

test("final partial work survives interruption/new lock and complementary proof without a duplicate primary visit", () => {
  const f = fixture(),
    e = f.issue();
  f.apply(e, f.proposal(e, ["reasoning"], "independent", false));
  assert.notEqual(f.l.finalProgress!["PY:T01"].status, "P");
  interruptLearningAttempt(f.l, e, at);
  const next = f.issue();
  assert.deepEqual(next.problem!.contract.preservedFacets, ["reasoning"]);
  assert.equal(f.l.attempts[1].parentAttempt, f.l.attempts[0].id);
  assert.notEqual(next.id, e.id);
  assert.equal(next.workspace.includes("PRIVATE_SYNTHETIC_RESPONSE"), false);
  f.apply(next, f.proposal(next, ["boundary"]));
  assert.equal(f.l.finalProgress!["PY:T01"].status, "P");
  assert.equal(f.l.cycle, 1);
  const old = f.proposal(e, ["reasoning"]);
  f.apply(e, old);
  assert.equal(f.l.cycle, 1);
  f.g.study.learner = f.l;
  const restored = decode(encode(f.g));
  assert.deepEqual(restored.study.learner!.finalProgress, f.l.finalProgress);
});

test("all final requirements remain runnable after ordinary cells pass, then COMPLETE maintains due reviews", () => {
  const f = fixture();
  let visits = 0;
  while (
    f.l.tracks.PY.phase !== "COMPLETE" ||
    f.l.tracks.PE.phase !== "COMPLETE"
  ) {
    assert.ok(
      visits++ < 60,
      "Final requirements must terminate without filler",
    );
    f.apply(f.issue());
  }
  assert.equal(visits, 47);
  assert.equal(f.l.tracks.PY.cleared, 4);
  assert.equal(f.l.tracks.PE.cleared, 4);
  for (const t of ["PY", "PE"] as const)
    assert.equal(curriculumReadiness(f.r, f.l, t).tier4RequirementsMet, true);
  assert.equal(
    curriculumReadiness(f.r, f.l, "PE").trackedEnvironmentObserved,
    false,
  );
  assert.throws(() => eligibleLearning(f.r, f.l, at), /no due maintenance/);
  closeLearningSession(f.l);
  const later = "2026-10-20T16:00:00.000Z",
    review = f.issue(later);
  assert.equal(review.problem!.contract.review, true);
  f.apply(review, f.proposal(review), later);
  assert.equal(
    f.l.reviews[review.problem!.scopeDefinitions![0].id].verifiedReviews,
    1,
  );
  assert.equal(eligibleLearning(f.r, f.l, later).review, true);
  const contradiction = f.proposal(review, ["boundary"], "contradicted", false);
  f.apply(review, contradiction, later);
  const id = review.problem!.contract.objectiveIds[0],
    track = review.problem!.contract.track;
  assert.equal(f.l.finalProgress![id].status, "R");
  assert.equal(
    f.l.finalProgress![id].facets["D4:reasoning"].outcome,
    "independent",
  );
  assert.equal(f.l.tracks[track].cleared, 3);
  assert.equal(f.l.tracks[track].phase, "REPAIR_VERIFY");
});

test("final tasks obey lower gates and cannot assess unselected integration or ENV targets", () => {
  const f = fixture(),
    e = f.issue(),
    before = JSON.stringify(f.l);
  for (const id of ["PE:I04", "PE:ENV01"]) {
    const invalid = structuredClone(e);
    invalid.problem!.contract.objectiveIds = [id];
    invalid.problem!.scopeDefinitions![0].objectiveId = id;
    invalid.problem!.scopeDefinitions![0].id = scopeKey(id, 4);
    assert.throws(
      () => registerScopes(f.r, f.l, invalid),
      /Invalid curriculum/,
    );
    assert.equal(JSON.stringify(f.l), before);
  }
  f.l.cells["PY:T01.1"].states[0] = "R";
  reconcileGates(f.r, f.l);
  assert.equal(f.l.tracks.PY.tier, 1);
  assert.equal(f.l.attempts[0].status, "suspended");
  assert.throws(() => beginLearningAttempt(f.r, f.l, e, at), /suspended/);
});

test("final scope assistance, unknown author and duplicate receipts obey the ordinary evidence boundary", () => {
  const f = fixture(),
    e = f.issue();
  e.tutor.push({
    id: "help",
    author: "Tutor",
    text: "Supplied key step",
    kind: "tutor",
    seq: 1,
    presented: 1,
    worldTime: 0,
    provenance: "study-mode",
  });
  const a = f.proposal(e);
  const before = JSON.stringify(f.l);
  assert.throws(() => f.apply(e, a), /help needs explicit/);
  assert.equal(JSON.stringify(f.l), before);
  a.helpAttributions = [
    {
      messageId: "help",
      facets: ["reasoning"],
      rationale: "Key step was supplied",
    },
  ];
  assert.throws(() => f.apply(e, a), /supplied key step/);
  a.findings[0].outcome = "assisted";
  f.apply(e, a);
  assert.equal(f.l.finalProgress!["PY:T01"].status, "G");
  const version = f.l.version;
  f.apply(e, a);
  assert.equal(f.l.version, version);
  a.findings[0].outcome = "independent";
  assert.throws(() => f.apply(e, a), /Conflicting duplicate/);
  const other = fixture(),
    foreign = other.issue();
  foreign.history[0].author = "npc";
  assert.throws(() => other.apply(foreign), /Only human-authored/);
  foreign.history[0].author = "human";
  const duplicate = other.proposal(foreign);
  duplicate.findings.push({
    ...duplicate.findings[0],
    outcome: "contradicted",
  });
  assert.throws(() => other.apply(foreign, duplicate), /Duplicate facet/);
  duplicate.findings.pop();
  duplicate.scopeReviews!.push({
    ...duplicate.scopeReviews![0],
    completeCoverage: false,
  });
  assert.throws(() => other.apply(foreign, duplicate), /Duplicate facet/);
  assert.equal(other.l.evidence.length, 0);
});

test("complete Markdown export retains final-facet proof, partial integration and unchanged objective denominator", async () => {
  const f = fixture("live");
  const e = f.issue();
  f.apply(e);
  let integration = f.issue();
  for (let i = 0; integration.problem!.contract.kind !== "integration"; i++) {
    assert.ok(i < 47);
    f.apply(integration);
    integration = f.issue();
  }
  assert.equal(integration.problem!.contract.kind, "integration");
  f.apply(integration, f.proposal(integration, ["reasoning"]));
  const out = await prepareRoadmapExport(f.r, f.l, undefined, at);
  assert.match(out.content, /\| T01 \| P \|[^\n]*S0008-EV/);
  assert.match(out.content, /Tier 4 final requirement/);
  assert.ok(out.content.includes(integration.problem!.scopeDefinitions![0].id));
  assert.ok(!out.content.includes("PRIVATE_SYNTHETIC_"));
  assert.equal(Object.keys(f.l.cells).length, 192);
  assert.equal(out.hash.length, 64);
  const again = await prepareRoadmapExport(f.r, f.l, out, at);
  assert.equal(again.content, out.content);
  const saved = JSON.stringify(f.l);
  f.l.finalProgress![integration.problem!.contract.objectiveIds[0]].status =
    "P";
  await assert.rejects(
    prepareRoadmapExport(f.r, f.l, out, at),
    /Unsupported final requirement pass/,
  );
  Object.assign(f.l, JSON.parse(saved));
});
