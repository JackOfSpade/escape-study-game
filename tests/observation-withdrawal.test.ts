// Synthetic source-bound reviews only. No actual human results are corrected.
import assert from "node:assert/strict";
import test from "node:test";
import { finalRequirementStatus } from "../src/final-requirements";
import { independentProofValid } from "../src/historical-proof";
import { beginLearningAttempt, eligibleLearning } from "../src/learner";
import { decode, encode, recover } from "../src/persistence";
import { adoptReconciledRoadmap } from "../src/roadmap-adoption";
import { prepareRoadmapExport } from "../src/roadmap-export";
import {
  evidence,
  final,
  r,
  setup,
  withdraw,
} from "./helpers/observation-withdrawal";
test("later reviewed invalidation withdraws an older imported pass without changing observations or inventing a learner failure", async () => {
  const g = await setup(),
    before = structuredClone(g.study.learner!),
    old = JSON.stringify(g.study.learner!.roadmapAdoptions![0]);
  assert.equal(
    independentProofValid(
      r,
      g.study.learner!,
      "PY:T01",
      4,
      "primary",
      "S0007-EV98",
    ),
    true,
  );
  const job = await withdraw(g);
  assert.equal(job.state, "ready", job.error);
  assert.equal(
    JSON.stringify(g.study.learner),
    JSON.stringify(before),
    "proposal is not applied before adoption",
  );
  await adoptReconciledRoadmap(g, r, job.id);
  const l = g.study.learner!;
  assert.equal(finalRequirementStatus(r, l, final), "U");
  assert.equal(
    independentProofValid(r, l, "PY:T01", 4, "primary", "S0007-EV98"),
    false,
  );
  assert.equal(
    l.finalProgress!["PY:T01"].facets["D4:primary"].outcome,
    "unknown",
  );
  assert.deepEqual(
    l.finalProgress!["PY:T01"].facets["D4:primary"].evidenceIds,
    ["S0007-EV98"],
  );
  assert.equal(JSON.stringify(l.roadmapAdoptions![0]), old);
  assert.ok(job.proposal!.canonical.includes(evidence));
  assert.ok(job.proposal!.canonical.includes("<!-- ATTEMPT_UPDATE "));
  assert.deepEqual(l.cells, before.cells);
  assert.deepEqual(l.tracks, before.tracks);
  assert.deepEqual(l.evidence, before.evidence);
  assert.equal(g.study.visits.length, 0);
  const copy = recover(decode(encode(g)));
  assert.equal(
    independentProofValid(
      r,
      copy.study.learner!,
      "PY:T01",
      4,
      "primary",
      "S0007-EV98",
    ),
    false,
  );
  const e = copy.encounters["question-0"];
  e.problem = {
    title: "Later synthetic study",
    prompt: "Continue eligible scope",
    starter: "",
    rubric: [],
    provenance: "study-mode",
    contract: eligibleLearning(r, copy.study.learner!, "2026-10-17T12:00:00Z"),
  };
  beginLearningAttempt(r, copy.study.learner!, e, "2026-10-17T12:00:00Z");
  const next = await prepareRoadmapExport(
    r,
    copy.study.learner!,
    copy.study.roadmapExport,
  );
  assert.ok(next.content.includes(evidence));
  assert.ok(next.content.includes("INVALIDATED; ambiguous supplied task"));
  assert.notEqual(next.content, job.proposal!.canonical);
  // Even a directly retained local observation cannot bypass the latest task
  // disposition. This isolated proof query does not export an orphan fixture.
  copy.study.learner!.evidence.push({
    id: "S0007-EV98",
    attemptId: "S0007-A98",
    encounter: "fixture",
    objectiveId: "PY:T01",
    depth: 4,
    facet: "primary",
    outcome: "independent",
    artifactSequences: [1],
    helpMessageIds: [],
    at: "2026-10-16T12:00:00Z",
    execution: "not-run",
    rationale: "Synthetic direct-evidence guard",
  });
  assert.equal(
    independentProofValid(
      r,
      copy.study.learner!,
      "PY:T01",
      4,
      "primary",
      "S0007-EV98",
    ),
    false,
  );
});
test("unaffected independent facets are retained and require partial rather than unknown status", async () => {
  const g = await setup(true),
    job = await withdraw(g, "G");
  assert.equal(job.state, "ready", job.error);
  await adoptReconciledRoadmap(g, r, job.id);
  const l = g.study.learner!;
  assert.equal(finalRequirementStatus(r, l, final), "G");
  assert.equal(
    l.finalProgress!["PY:T01"].facets["D4:primary"].outcome,
    "unknown",
  );
  assert.equal(
    l.finalProgress!["PY:T01"].facets["D4:secondary"].outcome,
    "independent",
  );
  assert.equal(
    independentProofValid(r, l, "PY:T01", 4, "secondary", "S0007-EV99"),
    true,
  );
});
test("retaining an unsupported pass, treating withdrawal as a failure, dropping unaffected facets or recycling invalidated proof rejects", async () => {
  for (const [status, partial, recycle] of [
    ["P", false, false],
    ["R", false, false],
    ["U", true, false],
    ["P", false, true],
  ] as const) {
    const g = await setup(partial),
      before = JSON.stringify(g.study.learner),
      job = await withdraw(g, status, recycle);
    assert.equal(job.state, "error", `${status}/${partial}/${recycle}`);
    assert.equal(JSON.stringify(g.study.learner), before);
  }
});

test("withdrawal preserves a separately observed existing material gap rather than erasing it or inventing a new failure", async () => {
  const g = await setup(true, true),
    before = structuredClone(
      g.study.learner!.finalProgress!["PY:T01"].facets["D4:secondary"],
    );
  const refused = await withdraw(g, "U");
  assert.equal(refused.state, "error");
  // A fresh review, not retrying the rejected exact canonical file.
  const accepted = await withdraw(g, "G");
  assert.equal(accepted.state, "ready", accepted.error);
  await adoptReconciledRoadmap(g, r, accepted.id);
  const p = g.study.learner!.finalProgress!["PY:T01"];
  assert.equal(p.status, "G");
  assert.equal(p.facets["D4:primary"].outcome, "unknown");
  assert.deepEqual(p.facets["D4:secondary"], before);
});

for (const outcome of ["assisted", "contradicted"] as const) {
  test(`reviewed invalidation retracts sole ${outcome} support without deleting its observations or inventing failure`, async () => {
    const g = await setup(false, false, outcome),
      before = structuredClone(g.study.learner!);
    const job = await withdraw(g, "U");
    assert.equal(job.state, "ready", job.error);
    assert.deepEqual(
      g.study.learner,
      before,
      "review must be inert until adopted",
    );
    await adoptReconciledRoadmap(g, r, job.id);
    const l = g.study.learner!,
      facet = l.finalProgress!["PY:T01"].facets["D4:primary"];
    assert.equal(facet.outcome, "unknown");
    assert.deepEqual(facet.evidenceIds, ["S0007-EV98"]);
    assert.equal(finalRequirementStatus(r, l, final), "U");
    assert.ok(
      job.proposal!.canonical.includes(
        outcome === "assisted"
          ? "| GUIDED | HINT |"
          : "| TRANSFER | NONE | 1 |",
      ),
    );
    assert.deepEqual(l.evidence, before.evidence);
    assert.deepEqual(l.tracks, before.tracks);
    assert.deepEqual(l.reviews, before.reviews);
    assert.equal(g.study.visits.length, 0);
    const restored = recover(decode(encode(g)));
    assert.equal(
      restored.study.learner!.finalProgress!["PY:T01"].facets["D4:primary"]
        .outcome,
      "unknown",
    );
    const exported = await prepareRoadmapExport(
      r,
      restored.study.learner!,
      restored.study.roadmapExport,
    );
    assert.ok(
      exported.content.includes("INVALIDATED; ambiguous supplied task"),
    );
    assert.ok(exported.content.includes("<!-- ATTEMPT_UPDATE "));
  });
}

for (const outcome of ["assisted", "contradicted"] as const) {
  test(`invalidating one ${outcome} observation preserves alternate valid support and refuses an unknown final status`, async () => {
    const g = await setup(true, false, outcome, true),
      before = structuredClone(
        g.study.learner!.finalProgress!["PY:T01"].facets,
      );
    const refused = await withdraw(g, "U");
    assert.equal(refused.state, "error");
    assert.match(refused.error!, /erase an observed gap|preserve unaffected/);
    const accepted = await withdraw(g, "G");
    assert.equal(accepted.state, "ready", accepted.error);
    await adoptReconciledRoadmap(g, r, accepted.id);
    assert.deepEqual(g.study.learner!.finalProgress!["PY:T01"].facets, before);
    assert.equal(finalRequirementStatus(r, g.study.learner!, final), "G");
  });
  test(`withdrawn ${outcome} facet preserves a separate independently supported facet`, async () => {
    const g = await setup(true, false, outcome),
      before = structuredClone(
        g.study.learner!.finalProgress!["PY:T01"].facets["D4:secondary"],
      );
    const refused = await withdraw(g, "U");
    assert.equal(refused.state, "error");
    const accepted = await withdraw(g, "G");
    assert.equal(accepted.state, "ready", accepted.error);
    await adoptReconciledRoadmap(g, r, accepted.id);
    const p = g.study.learner!.finalProgress!["PY:T01"];
    assert.equal(p.facets["D4:primary"].outcome, "unknown");
    assert.deepEqual(p.facets["D4:secondary"], before);
    assert.equal(p.status, "G");
  });
}

test("explicit source review can restore earlier independent proof after the intervening contradiction is invalidated, without a new assessment", async () => {
  const g = await setup(false, false, "contradicted", false, true),
    before = structuredClone(g.study.learner!);
  const job = await withdraw(g, "P", false, true);
  assert.equal(job.state, "ready", job.error);
  await adoptReconciledRoadmap(g, r, job.id);
  const l = g.study.learner!;
  assert.equal(finalRequirementStatus(r, l, final), "P");
  assert.equal(
    independentProofValid(r, l, "PY:T01", 4, "primary", "S0007-EV97"),
    true,
  );
  assert.equal(
    independentProofValid(r, l, "PY:T01", 4, "primary", "S0007-EV98"),
    false,
  );
  assert.deepEqual(l.evidence, before.evidence);
  assert.deepEqual(l.reviews, before.reviews);
  assert.equal(g.study.visits.length, 0);
});

test("earlier independent work cannot erase an unaffected contradiction or one with alternate valid support", async () => {
  for (const alternate of [false, true]) {
    const g = await setup(alternate, false, "contradicted", alternate, true),
      before = JSON.stringify(g.study.learner);
    const job = await withdraw(g, "P", false, true, alternate);
    assert.equal(job.state, "error");
    assert.match(job.error!, /qualifying later independent observation/);
    assert.equal(JSON.stringify(g.study.learner), before);
  }
});

test("withdrawing the sole scored failure permits unknown, while a separately valid material contradiction keeps its R status", async () => {
  const g = await setup(false, false, "contradicted", false, false, "R");
  const corrected = await withdraw(g, "U");
  assert.equal(corrected.state, "ready", corrected.error);
  await adoptReconciledRoadmap(g, r, corrected.id);
  assert.equal(g.study.learner!.finalProgress!["PY:T01"].status, "U");
  assert.equal(
    g.study.learner!.finalProgress!["PY:T01"].facets["D4:primary"].outcome,
    "unknown",
  );
  const retained = await setup(true, true, "independent", false, false, "R");
  const negative = structuredClone(
    retained.study.learner!.finalProgress!["PY:T01"].facets["D4:secondary"],
  );
  const refused = await withdraw(retained, "G");
  assert.equal(refused.state, "error");
  const accepted = await withdraw(retained, "R");
  assert.equal(accepted.state, "ready", accepted.error);
  await adoptReconciledRoadmap(retained, r, accepted.id);
  assert.equal(retained.study.learner!.finalProgress!["PY:T01"].status, "R");
  assert.deepEqual(
    retained.study.learner!.finalProgress!["PY:T01"].facets["D4:secondary"],
    negative,
  );
});
