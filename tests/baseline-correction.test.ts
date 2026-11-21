// Synthetic source audits only; original curriculum and real learning untouched.
import assert from "node:assert/strict";
import test from "node:test";
import { sha256 } from "../src/digest";
import { curriculumReadiness } from "../src/final-requirements";
import { independentProofValid } from "../src/historical-proof";
import { baselineCheckpointValid } from "../src/observation-validity";
import { decode, encode, recover } from "../src/persistence";
import {
  adoptReconciledRoadmap,
  compileRoadmapAdoption,
  reconcileRoadmap,
} from "../src/roadmap-adoption";
import { prepareRoadmapExport } from "../src/roadmap-export";
import { inspectMergedDocument } from "../src/roadmap-structure";
import { createRecord } from "./helpers/record";
import { baselineFixture, roadmap as r } from "./helpers/baseline-correction";
for (const id of ["PY:T05.2", "PE:T01.2", "PY:T06.1"])
  test(`source-authorized baseline correction reviews complete original history and retains partial knowledge: ${id}`, async () => {
    const g = createRecord(7, r);
    g.study.profile = "live";
    const before = structuredClone(g.study.learner!);
    const fixture = await baselineFixture(g, id);
    assert.equal(baselineCheckpointValid(r, before, id, 1), true);
    await reconcileRoadmap(g, r, fixture.raw, async (p) => fixture.proposal(p));
    const job = g.study.roadmapReconciliations!.at(-1)!;
    assert.equal(job.state, "ready", job.error);
    assert.deepEqual(g.study.learner, before);
    // Full semantic coverage is required even though no new mastery is awarded.
    for (const change of ["coverage", "facet", "observation", "known"]) {
      if (change === "known" && !fixture.partial) continue;
      const bad = structuredClone(job);
      if (change === "coverage") bad.proposal!.completeScopes = [];
      if (change === "facet") bad.proposal!.mappings = [];
      if (change === "observation") bad.proposal!.mappings[0].evidenceIds = [];
      if (change === "known")
        bad
          .proposal!.mappings.filter((m) => m.outcome !== "unknown")
          .forEach((m) => (m.outcome = "unknown"));
      bad.proposalHash = await sha256(JSON.stringify(bad.proposal));
      await assert.rejects(
        compileRoadmapAdoption(r, before, bad),
        /historical|facet|mapping|observation|knowledge/i,
      );
    }
    const inventedReview = structuredClone(job);
    const trackForReview = id.startsWith("PY:") ? "PY" : "PE";
    // The legacy 0.12 heading on purpose: files saved by earlier builds carry it.
    const metadata = `\n\n### 0.12 Game semantic scope and continuation state\n\n| Review scope | Stage | Due | Last independent at | Last independent date | Sequence | Verified reviews |\n|---|---|---|---|---|---|---|\n| ${fixture.scope} | 2 | 2030-01-01 | — | 2026-09-15 | S0004 | 10 |\n\n| Suspended state | Tier | Phase | Lap | Queue |\n|---|---|---|---|---|\n\n`;
    inventedReview.proposal!.canonical =
      inventedReview.proposal!.canonical.replace(
        `<!-- END ${trackForReview}_PROGRESS -->`,
        metadata + `<!-- END ${trackForReview}_PROGRESS -->`,
      );
    inventedReview.proposalHash = await sha256(
      JSON.stringify(inventedReview.proposal),
    );
    await assert.rejects(
      compileRoadmapAdoption(r, before, inventedReview),
      /retain exact retention/,
    );
    if (fixture.partial) {
      for (const status of ["U", "R"]) {
        const bad = structuredClone(job),
          rows = inspectMergedDocument(bad.proposal!.canonical).rows;
        const key = [...rows.keys()].find(
          (k) =>
            k.startsWith("PY_PROGRESS/0.4 Objective checkpoint ledger/") &&
            k.endsWith("/T06.1"),
        )!;
        const row = rows.get(key)!,
          cells = row
            .split("|")
            .slice(1, -1)
            .map((c) => c.trim());
        cells[2] = status;
        bad.proposal!.canonical = bad.proposal!.canonical.replace(
          row,
          `| ${cells.join(" | ")} |`,
        );
        bad.proposalHash = await sha256(JSON.stringify(bad.proposal));
        await assert.rejects(
          compileRoadmapAdoption(r, before, bad),
          /preserve unaffected|not a new learner contradiction/,
        );
      }
    }
    await adoptReconciledRoadmap(g, r, job.id);
    const l = g.study.learner!;
    assert.equal(l.cells[id].states[0], fixture.partial ? "G" : "U");
    assert.equal(baselineCheckpointValid(r, l, id, 1), false);
    assert.equal(
      independentProofValid(
        r,
        l,
        id,
        1,
        fixture.proposal(job.payload).mappings.at(-1)!.facet,
        fixture.ref,
      ),
      false,
    );
    assert.deepEqual(l.reviews, before.reviews);
    assert.deepEqual(l.evidence, before.evidence);
    assert.deepEqual(l.attempts, before.attempts);
    assert.equal(l.cycle, before.cycle);
    for (const row of fixture.history.evidenceRows)
      assert.ok(job.proposal!.canonical.includes(row));
    assert.ok(job.proposal!.canonical.includes(fixture.decision));
    const copy = recover(decode(encode(g)));
    assert.equal(
      copy.study.learner!.cells[id].states[0],
      fixture.partial ? "G" : "U",
    );
    // The old baseline exemption cannot launder a pass after withdrawal.
    const unsupported = structuredClone(copy.study.learner!);
    unsupported.cells[id].states[0] = "P";
    await assert.rejects(
      prepareRoadmapExport(r, unsupported),
      /Unsupported new checkpoint pass/,
    );
    const track = id.startsWith("PY:") ? "PY" : "PE";
    assert.equal(
      curriculumReadiness(r, unsupported, track).checkpoints.passed,
      curriculumReadiness(r, copy.study.learner!, track).checkpoints.passed,
      "unsupported baseline flag cannot inflate readiness",
    );
    // Force a changed export and a second import without reasserting the correction.
    copy.study.learner!.version++;
    const later = await prepareRoadmapExport(
      r,
      copy.study.learner!,
      copy.study.roadmapExport,
    );
    assert.equal(
      inspectMergedDocument(later.content)
        .rows.get(fixture.key)!
        .split("|")[4]
        .trim(),
      "INVALIDATED; controlled source scoring correction, preserve original observation",
    );
    assert.ok(later.content.includes(fixture.decision));
    assert.ok(
      later.content.includes("retention suspended pending scheduled repair"),
    );
    copy.study.roadmapExport = later;
    const next = later.content
      .replace(/^revision: \d+$/m, `revision: ${later.revision + 1}`)
      .replace(
        /^previous_revision: \d+$/m,
        `previous_revision: ${later.revision}`,
      )
      .replace(
        /^parent_file_sha256: .+$/m,
        `parent_file_sha256: ${later.hash}`,
      );
    await reconcileRoadmap(copy, r, next, async (p) => ({
      requestId: p.requestId,
      localHash: p.localHash,
      candidateHash: p.candidateHash,
      canonical: p.candidate,
      definitions: [],
      mappings: [],
      completeScopes: [],
      decisions: [],
      rationale:
        "Retain already reviewed correction and exact semantic gap IDs",
    }));
    const again = copy.study.roadmapReconciliations!.at(-1)!;
    assert.equal(again.state, "ready", again.error);
    await adoptReconciledRoadmap(copy, r, again.id);
    assert.equal(
      copy.study.learner!.cells[id].states[0],
      fixture.partial ? "G" : "U",
    );
    assert.equal(baselineCheckpointValid(r, copy.study.learner!, id, 1), false);
  });

test("withdrawn original pass is repaired by real scheduling and fresh proof, with a fresh retention interval", async () => {
  const {
    eligibleLearning,
    beginLearningAttempt,
    registerScopes,
    applyLearningAssessment,
  } = await import("../src/learner");
  const g = createRecord(17, r);
  g.study.profile = "live";
  const fixture = await baselineFixture(g);
  await reconcileRoadmap(g, r, fixture.raw, async (p) => fixture.proposal(p));
  const job = g.study.roadmapReconciliations!.at(-1)!;
  assert.equal(job.state, "ready", job.error);
  await adoptReconciledRoadmap(g, r, job.id);
  const copy = recover(decode(encode(g))),
    l = copy.study.learner!;
  const at = "2026-10-17T16:00:00Z";
  const oldReview = structuredClone(l.reviews[fixture.scope]);
  let repaired = false;
  let visits = 0;
  for (let n = 0; n < 180; n++) {
    const c = eligibleLearning(r, l, at);
    const e = structuredClone(copy.encounters["question-0"]);
    e.id = `synthetic-baseline-repair-${n}`;
    const definition = l.scopes[`${c.objectiveIds[0]}/D${c.depth}`];
    e.problem = {
      title: "Synthetic fresh repair",
      prompt: "Scoped synthetic reasoning only",
      starter: "",
      rubric: [],
      provenance: "study-mode",
      contract: c,
      scopeDefinitions: definition
        ? [structuredClone(definition)]
        : c.objectiveIds.map((id, i) => ({
            id: `${id}/D${c.depth}`,
            objectiveId: id,
            depth: c.depth,
            sourceScope: c.scopes[i],
            facets: [
              {
                id: "scope",
                description:
                  "Synthetic independent full source-scope reasoning",
              },
            ],
          })),
    };
    e.workspace =
      "Fresh learner-authored fixture artifact, no old task transfer";
    e.history = [
      {
        seq: 1,
        author: "human",
        kind: "reasoning",
        text: "Synthetic independent reasoning for controlled full-scope repair",
        at: 0,
        revision: 0,
        wallTime: at,
      },
    ];
    copy.encounters[e.id] = e;
    registerScopes(r, l, e);
    beginLearningAttempt(r, l, e, at);
    if (c.objectiveIds.includes(fixture.id)) {
      assert.equal(
        c.review,
        false,
        "withdrawn pass must get scheduled repair, not a delayed-review credential",
      );
      repaired = true;
    }
    applyLearningAssessment(
      r,
      l,
      e,
      {
        id: `synthetic-repair-${n}`,
        encounter: e.id,
        provenance: "study-mode",
        sourceVersion: l.version,
        status: "pending",
        evidenceCutoffSequence: 1,
        visitOutcome: "usable",
        scopeReviews: e.problem.scopeDefinitions!.map((d) => ({
          id: d.id,
          completeCoverage: true,
          rationale: "Synthetic full-scope review",
        })),
        findings: e.problem.scopeDefinitions!.flatMap((d) =>
          d.facets.map((f) => ({
            objectiveId: d.objectiveId,
            depth: d.depth,
            facet: f.id,
            outcome: "independent",
            evidence: [1],
            completeCheckpointScope: false,
            rationale: "Synthetic fresh independent demonstration",
          })),
        ),
      },
      at,
      "study-mode",
    );
    visits++;
    if (repaired) break;
  }
  assert.ok(
    repaired,
    "unchanged breadth scheduler eventually repairs the withdrawn scope",
  );
  assert.equal(l.cycle, visits);
  assert.equal(l.cells[fixture.id].states[0], "P");
  assert.notEqual(l.reviews[fixture.scope].due, oldReview.due);
  assert.equal(l.reviews[fixture.scope].due, "2026-10-20");
  assert.equal(l.reviews[fixture.scope].stage, 0);
  assert.equal(l.reviews[fixture.scope].verifiedReviews, 0);
  assert.equal(l.reviews[fixture.scope].lastIndependentAt, at);
  assert.equal(baselineCheckpointValid(r, l, fixture.id, 1), false);
  assert.equal(
    independentProofValid(r, l, fixture.id, 1, "source-0", fixture.ref),
    false,
  );
  assert.ok(
    l.evidence.some(
      (ev) =>
        ev.objectiveId === fixture.id &&
        independentProofValid(r, l, ev.objectiveId, ev.depth, ev.facet, ev.id),
    ),
  );
  const later = await prepareRoadmapExport(r, l, copy.study.roadmapExport);
  assert.ok(later.content.includes(fixture.decision));
  assert.ok(
    inspectMergedDocument(later.content)
      .rows.get(fixture.key)!
      .includes("INVALIDATED;"),
  );
});

test("baseline source correction cannot silently replace a later verified retention history", async () => {
  const g = createRecord(7, r);
  g.study.profile = "live";
  g.study.learner!.reviews["PY:T05.2/D1"].stage = 1;
  g.study.learner!.reviews["PY:T05.2/D1"].verifiedReviews = 1;
  const before = structuredClone(g.study.learner!);
  const fixture = await baselineFixture(g);
  await reconcileRoadmap(g, r, fixture.raw, async (p) => fixture.proposal(p));
  const job = g.study.roadmapReconciliations!.at(-1)!;
  assert.equal(job.state, "error");
  assert.match(job.error!, /dedicated retention reassessment/);
  assert.deepEqual(g.study.learner, before);
});

test("baseline withdrawal cannot erase a later actually assessed material contradiction", async () => {
  const {
    eligibleLearning,
    registerScopes,
    beginLearningAttempt,
    applyLearningAssessment,
  } = await import("../src/learner");
  const g = createRecord(31, r);
  g.study.profile = "live";
  const l = g.study.learner!,
    at = "2026-10-17T16:00:00Z",
    id = "PY:T05.2";
  const c = eligibleLearning(r, l, at),
    e = g.encounters["question-0"];
  assert.deepEqual(c.objectiveIds, [id]);
  assert.equal(c.review, true);
  const o = r.tracks.PY.objectives.find((o) => o.id === id)!;
  e.problem = {
    title: "Synthetic observed contradiction",
    prompt: "Controlled current learner failure only",
    starter: "",
    rubric: [],
    provenance: "study-mode",
    contract: c,
    scopeDefinitions: [
      {
        id: `${id}/D1`,
        objectiveId: id,
        depth: 1,
        sourceScope: o.scope,
        facets: [
          {
            id: "source-0",
            description: `Synthetic source-defined facet 0: ${o.scope}`,
          },
        ],
      },
    ],
  };
  e.history = [
    {
      seq: 1,
      author: "human",
      kind: "reasoning",
      text: "Synthetic incorrect invariant in an actual controlled review transaction",
      at: 0,
      revision: 0,
      wallTime: at,
    },
  ];
  registerScopes(r, l, e);
  beginLearningAttempt(r, l, e, at);
  applyLearningAssessment(
    r,
    l,
    e,
    {
      id: "synthetic-contradiction",
      encounter: e.id,
      provenance: "study-mode",
      sourceVersion: l.version,
      status: "pending",
      evidenceCutoffSequence: 1,
      visitOutcome: "usable",
      scopeReviews: [
        {
          id: `${id}/D1`,
          completeCoverage: true,
          rationale: "Synthetic reviewed scope",
        },
      ],
      findings: [
        {
          objectiveId: id,
          depth: 1,
          facet: "source-0",
          outcome: "contradicted",
          evidence: [1],
          completeCheckpointScope: false,
          rationale: "Synthetic observed material error",
        },
      ],
    },
    at,
    "study-mode",
  );
  assert.equal(l.cells[id].states[0], "R");
  g.study.roadmapExport = await prepareRoadmapExport(r, l);
  const before = structuredClone(l),
    work = structuredClone(e);
  const fixture = await baselineFixture(g, id);
  await reconcileRoadmap(g, r, fixture.raw, async (p) => fixture.proposal(p));
  const job = g.study.roadmapReconciliations!.at(-1)!;
  assert.equal(job.state, "error");
  assert.match(
    job.error!,
    /preserve the current independently supported pass or later material contradiction/,
  );
  assert.deepEqual(g.study.learner, before);
  assert.deepEqual(e, work);
});
