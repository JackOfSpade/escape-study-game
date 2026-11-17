import assert from "node:assert/strict";
import test from "node:test";
import { closeLearningSession } from "../src/learner";
import { decode, encode, recover } from "../src/persistence";
import { replayRetention, retentionEventText } from "../src/retention-history";
import {
  adoptReconciledRoadmap,
  compileRoadmapAdoption,
  reconcileRoadmap,
} from "../src/roadmap-adoption";
import { prepareRoadmapExport, sha256 } from "../src/roadmap-export";
import { inspectMergedDocument } from "../src/roadmap-structure";
import { createGame } from "./helpers/record";
import {
  baselineFixture,
  setCheckpointStatus,
} from "./helpers/baseline-correction";
import { gradeScheduled } from "./helpers/later-baseline-evidence";
import {
  laterId,
  laterScope,
  r,
  recordTargetReview,
  retentionCorrection,
  retentionFixture,
} from "./helpers/retention-correction";

for (const observedAt of ["2026-10-17T08:00:00Z", "2026-10-17T17:00:00Z", null])
  test(`delayed grading uses actual observation time rather than response arrival: ${observedAt}`, () => {
    const g = createGame(73, r);
    g.study.profile = "live";
    const l = g.study.learner!,
      review = l.reviews[laterScope];
    for (const [key, other] of Object.entries(l.reviews))
      if (key !== laterScope) other.due = "2099-01-01";
    review.lastIndependentAt = "2026-10-16T16:00:00Z";
    delete review.lastIndependentDate;
    review.due = "2026-10-17";
    closeLearningSession(l);
    const { c } = gradeScheduled(
      g,
      "independent",
      "2026-10-20T16:00:00Z",
      0,
      observedAt,
    );
    assert.ok(c.review && c.objectiveIds.includes(laterId));
    const expected = observedAt === "2026-10-17T17:00:00Z" ? 1 : 0;
    assert.equal(l.reviews[laterScope].verifiedReviews, expected);
    assert.equal(
      l.retentionHistory?.filter((e) => e.scopeId === laterScope).length ?? 0,
      expected,
    );
    assert.equal(
      l.reviews[laterScope].due,
      expected ? "2026-10-24" : "2026-10-17",
    );
    if (expected)
      assert.deepEqual(
        replayRetention(r, l, laterScope),
        l.reviews[laterScope],
      );
  });

test("actual delayed reviews retain exact receipt-backed before/after history without duplicate events", async () => {
  const { g, events } = retentionFixture();
  const l = g.study.learner!;
  assert.equal(events[0].before.verifiedReviews, 0);
  assert.equal(events[1].after.verifiedReviews, 2);
  assert.deepEqual(replayRetention(r, l, laterScope), l.reviews[laterScope]);
  const restored = recover(decode(encode(g)));
  assert.deepEqual(
    restored.study.learner!.retentionHistory,
    l.retentionHistory,
  );
  const file = await prepareRoadmapExport(r, l);
  for (const event of events)
    assert.ok(file.content.includes(retentionEventText(event)));
});
for (const removed of [[0], [1], [0, 1]])
  test(`source correction replays remaining retention after withdrawing review(s) ${removed.join(",")}`, async () => {
    const { g, events } = retentionFixture();
    const l = g.study.learner!,
      before = structuredClone(l);
    const expected =
      removed.length === 2
        ? events[0].before
        : removed[0] === 1
          ? events[0].after
          : {
              ...events[1].after,
              stage: 1,
              verifiedReviews: 1,
              due: "2026-11-02",
            };
    const fixture = await retentionCorrection(
      g,
      removed.map((i) => events[i].attemptId),
      expected,
    );
    await reconcileRoadmap(
      g,
      r,
      fixture.raw,
      async (p) => fixture.proposal(p),
      undefined,
      "chatgpt-handoff",
    );
    const job = g.study.roadmapReconciliations!.at(-1)!;
    assert.equal(job.state, "ready", job.error);
    assert.deepEqual(l.reviews, before.reviews);
    await adoptReconciledRoadmap(g, r, job.id);
    const current = g.study.learner!;
    assert.deepEqual(
      current.reviews[laterScope],
      JSON.parse(JSON.stringify(expected)),
    );
    assert.equal(
      current.cells[laterId].states[0],
      "P",
      "valid original checkpoint remains supported",
    );
    for (const key of [
      "evidence",
      "attempts",
      "receipts",
      "retentionHistory",
      "cycle",
      "sessions",
    ] as const)
      assert.deepEqual(current[key], before[key]);
    const restored = recover(decode(encode(g)));
    assert.deepEqual(
      replayRetention(r, restored.study.learner!, laterScope),
      current.reviews[laterScope],
    );
    restored.study.learner!.version++;
    const exported = await prepareRoadmapExport(
      r,
      restored.study.learner!,
      restored.study.roadmapExport,
    );
    for (const event of events)
      assert.ok(exported.content.includes(retentionEventText(event)));
  });

test("retention correction refuses missing declaration, audit removal, fabricated counts and lost assessment provenance", async () => {
  const { g, events } = retentionFixture();
  const fixture = await retentionCorrection(
    g,
    [events[1].attemptId],
    events[0].after,
  );
  await reconcileRoadmap(g, r, fixture.raw, async (p) => fixture.proposal(p));
  const job = g.study.roadmapReconciliations!.at(-1)!;
  assert.equal(job.state, "ready", job.error);
  for (const kind of ["declaration", "audit", "count", "receipt"]) {
    const bad = structuredClone(job),
      l = structuredClone(g.study.learner!);
    if (kind === "declaration") delete bad.proposal!.retentionUpdates;
    if (kind === "audit")
      bad.proposal!.canonical = bad.proposal!.canonical.replace(
        retentionEventText(events[0]),
        "",
      );
    if (kind === "count")
      bad.proposal!.decisions.forEach((d) => {
        d.choice = "merged";
      });
    if (kind === "count")
      bad.proposal!.canonical = bad.proposal!.canonical.replace(
        `| ${laterScope} | 1 |`,
        `| ${laterScope} | 2 |`,
      );
    if (kind === "receipt") delete l.receipts[events[0].assessmentId];
    bad.proposalHash = await sha256(JSON.stringify(bad.proposal));
    await assert.rejects(
      compileRoadmapAdoption(r, l, bad),
      /retention|delayed-review|Retention/,
    );
  }
});

test("a later legitimate review continues from the corrected stage and preserves withdrawn transactions", async () => {
  const { g, events } = retentionFixture();
  const expected = {
    ...events[1].after,
    stage: 1,
    verifiedReviews: 1,
    due: "2026-11-02",
  };
  const fixture = await retentionCorrection(g, [events[0].attemptId], expected);
  await reconcileRoadmap(g, r, fixture.raw, async (p) => fixture.proposal(p));
  const job = g.study.roadmapReconciliations!.at(-1)!;
  assert.equal(job.state, "ready", job.error);
  await adoptReconciledRoadmap(g, r, job.id);
  recordTargetReview(g, "2026-11-20T16:00:00Z");
  const l = g.study.learner!,
    history = l.retentionHistory!.filter((e) => e.scopeId === laterScope);
  assert.equal(history.length, 3);
  assert.equal(l.reviews[laterScope].verifiedReviews, 2);
  assert.equal(l.reviews[laterScope].stage, 2);
  assert.deepEqual(replayRetention(r, l, laterScope), l.reviews[laterScope]);
  assert.deepEqual(history.slice(0, 2), events);
});

test("a simultaneous original-score and later-review withdrawal preserves both histories and replays exact retention", async () => {
  const { g, events } = retentionFixture(1),
    original = await baselineFixture(g, laterId);
  const reviewed = await retentionCorrection(
    g,
    [events[0].attemptId],
    events[0].before,
  );
  let raw = setCheckpointStatus(
    reviewed.raw,
    laterId,
    original.partial ? "G" : "U",
  );
  raw = raw.replace(
    original.previous,
    inspectMergedDocument(original.raw).rows.get(original.key)!,
  );
  const decision = [...inspectMergedDocument(raw).rows].find(
    ([key, row]) =>
      key.startsWith("SHARED_PROGRESS/S0.3 Shared decisions/") &&
      row.includes("Synthetic source review found supplied reasoning"),
  )!;
  const cells = decision[1]
    .split("|")
    .slice(1, -1)
    .map((s) => s.trim());
  cells[3] += `, PY:${original.task}`;
  raw = raw.replace(decision[1], `| ${cells.join(" | ")} |`);
  await reconcileRoadmap(g, r, raw, async (p) => {
    const out = reviewed.proposal(p),
      old = original.proposal(p);
    out.definitions = old.definitions;
    out.mappings = old.mappings;
    out.completeScopes = old.completeScopes;
    out.attemptUpdates!.push({
      ...old.attemptUpdates![0],
      correctionDecision: out.attemptUpdates![0].correctionDecision,
    });
    return out;
  });
  const job = g.study.roadmapReconciliations!.at(-1)!;
  assert.equal(job.state, "ready", job.error);
  await adoptReconciledRoadmap(g, r, job.id);
  assert.deepEqual(
    g.study.learner!.reviews[laterScope],
    JSON.parse(JSON.stringify(events[0].before)),
  );
  assert.equal(
    g.study.learner!.cells[laterId].states[0],
    original.partial ? "G" : "U",
  );
  assert.deepEqual(
    g.study.learner!.retentionHistory!.filter((e) => e.scopeId === laterScope),
    events,
  );
});
