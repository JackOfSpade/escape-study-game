// Controlled native-grade transactions and source review, not real learner results.
import assert from "node:assert/strict";
import test from "node:test";
import { sha256 } from "../src/digest";
import { facetProofValid } from "../src/historical-proof";
import { eligibleLearning } from "../src/learner";
import { baselineCheckpointValid } from "../src/observation-validity";
import { decode, encode, recover } from "../src/persistence";
import {
  adoptReconciledRoadmap,
  compileRoadmapAdoption,
  reconcileRoadmap,
} from "../src/roadmap-adoption";
import { prepareRoadmapExport } from "../src/roadmap-export";
import { createGame } from "./helpers/record";
import {
  baselineFixture,
  roadmap as r,
  setCheckpointStatus,
} from "./helpers/baseline-correction";
import {
  gradeScheduled,
  laterAt,
  laterBaselineFixture,
  laterId,
  laterScope,
} from "./helpers/later-baseline-evidence";
const id = "PY:T05.2",
  scope = `${id}/D1`;
for (const outcome of ["independent", "contradicted", "assisted"] as const)
  test(`an older baseline-score audit preserves later ${outcome} work and exact retention history`, async () => {
    const { g, e, c, expected, fixture } = await laterBaselineFixture(outcome);
    const l = g.study.learner!;
    assert.deepEqual(c.objectiveIds, [id]);
    assert.equal(c.review, true);
    if (outcome === "independent") {
      assert.equal(l.reviews[scope].verifiedReviews, 1);
      assert.equal(l.reviews[scope].stage, 1);
    }
    const before = structuredClone(l),
      artifact = structuredClone(e);
    await reconcileRoadmap(g, r, fixture.raw, async (p) => fixture.proposal(p));
    const job = g.study.roadmapReconciliations!.at(-1)!;
    assert.equal(job.state, "ready", job.error);
    assert.deepEqual(g.study.learner, before);
    for (const wrong of [
      "U",
      ...(expected === "P"
        ? ["G", "R"]
        : expected === "R"
          ? ["G", "P"]
          : ["P", "R"]),
    ]) {
      const bad = structuredClone(job);
      bad.proposal!.canonical = setCheckpointStatus(
        bad.proposal!.canonical,
        id,
        wrong,
      );
      bad.proposalHash = await sha256(JSON.stringify(bad.proposal));
      await assert.rejects(
        compileRoadmapAdoption(r, before, bad),
        /preserve|contradiction|Unsupported|support|withdrawal/,
      );
    }
    await adoptReconciledRoadmap(g, r, job.id);
    const current = g.study.learner!;
    assert.equal(current.cells[id].states[0], expected);
    assert.equal(baselineCheckpointValid(r, current, id, 1), false);
    assert.deepEqual(current.evidence, before.evidence);
    assert.deepEqual(current.attempts, before.attempts);
    assert.deepEqual(current.reviews, before.reviews);
    assert.deepEqual(current.cells[id].facets, before.cells[id].facets);
    assert.deepEqual(e, artifact);
    assert.equal(current.cycle, before.cycle);
    const ev = current.evidence.find((ev) => ev.objectiveId === id)!;
    assert.equal(
      facetProofValid(r, current, id, 1, "source-0", ev.id, outcome),
      true,
    );
    assert.equal(
      facetProofValid(
        r,
        current,
        id,
        1,
        "source-0",
        fixture.ref,
        "independent",
      ),
      false,
    );
    const restored = recover(decode(encode(g)));
    assert.equal(restored.study.learner!.cells[id].states[0], expected);
    restored.study.learner!.version++;
    const exported = await prepareRoadmapExport(
      r,
      restored.study.learner!,
      restored.study.roadmapExport,
    );
    assert.ok(exported.content.includes(fixture.decision));
    assert.ok(exported.content.includes(fixture.history.evidenceRows[0]));
    assert.equal(restored.study.learner!.cycle, before.cycle);
  });

test("an older baseline correction preserves both a verified retention pass and a subsequently observed failure", async () => {
  const g = createGame(92, r);
  g.study.profile = "live";
  gradeScheduled(g, "independent", laterAt, 0);
  const l = g.study.learner!;
  assert.equal(l.reviews[laterScope].verifiedReviews, 1);
  let failed = false;
  for (let n = 1; n <= 24; n++) {
    const c = eligibleLearning(r, l, "2026-10-26T16:00:00Z");
    const target = c.objectiveIds.includes(laterId) && c.review;
    gradeScheduled(
      g,
      target ? "contradicted" : "independent",
      "2026-10-26T16:00:00Z",
      n,
    );
    if (target) {
      failed = true;
      break;
    }
  }
  assert.ok(failed);
  assert.equal(l.cells[laterId].states[0], "R");
  assert.equal(l.reviews[laterScope].verifiedReviews, 1);
  const before = structuredClone(l);
  const fixture = await baselineFixture(g, laterId, "R");
  await reconcileRoadmap(g, r, fixture.raw, async (p) => fixture.proposal(p));
  const job = g.study.roadmapReconciliations!.at(-1)!;
  assert.equal(job.state, "ready", job.error);
  await adoptReconciledRoadmap(g, r, job.id);
  assert.equal(g.study.learner!.cells[laterId].states[0], "R");
  assert.deepEqual(
    g.study.learner!.reviews,
    JSON.parse(JSON.stringify(before.reviews)),
  );
  assert.deepEqual(g.study.learner!.evidence, before.evidence);
  assert.deepEqual(g.study.learner!.attempts, before.attempts);
});
