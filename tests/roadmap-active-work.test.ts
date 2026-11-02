// Synthetic external assessment fixtures, never real learner certification.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assess, checkBridge } from "../src/ai";
import { syncLearningView } from "../src/curriculum";
import {
  applyLearningAssessment,
  beginLearningAttempt,
  closeLearningSession,
  eligibleLearning,
  registerScopes,
} from "../src/learner";
import type { Assessment, Roadmap } from "../src/model";
import { decode, encode, recover } from "../src/persistence";
import {
  adoptReconciledRoadmap,
  reconcileRoadmap,
} from "../src/roadmap-adoption";
import type { RoadmapReconciliationPayload } from "../src/roadmap-adoption-types";
import { prepareRoadmapExport } from "../src/roadmap-export";
import { reviewRoadmap } from "../src/roadmap-review";
import { createGame } from "../src/world";
const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
const at = "2026-10-16T16:00:00Z";
async function fixture(otherUnfinished = false, leaveSourceOpen = false) {
  const g = createGame(7, r),
    l = g.study.learner!,
    e = g.encounters["f0-room0"];
  g.study.profile = "live";
  const c = eligibleLearning(r, l, at);
  e.problem = {
    title: "Synthetic preserved current question",
    prompt: "Keep this exact task",
    starter: "",
    rubric: [],
    provenance: "study-mode",
    contract: c,
    scopeDefinitions: c.objectiveIds.map((id, i) => ({
      id: `${id}/D${c.depth}`,
      objectiveId: id,
      depth: c.depth,
      sourceScope: c.scopes[i],
      facets: [
        { id: "scope", description: "Synthetic actual same-depth scope" },
      ],
    })),
  };
  e.workspace = "PRIVATE_CURRENT_DRAFT";
  e.history.push({
    seq: ++g.seq,
    author: "human",
    kind: "reasoning",
    text: "PRIVATE_CURRENT_REASONING",
    revision: 0,
    at: 0,
    wallTime: at,
  });
  registerScopes(r, l, e);
  beginLearningAttempt(r, l, e, at);
  if (otherUnfinished)
    l.attempts.push({
      ...structuredClone(l.attempts[0]),
      id: "S0008-A99",
      encounter: `${e.runId}/synthetic-other-unfinished`,
      status: "interrupted",
    });
  g.study.roadmapExport = await prepareRoadmapExport(r, l);
  const external = structuredClone(l),
    attempt = external.attempts[0];
  const assessment: Assessment = {
    id: "synthetic-external-current",
    encounter: e.id,
    sourceVersion: external.version,
    provenance: "study-mode",
    status: "pending",
    evidenceCutoffSequence: g.seq,
    visitOutcome: "usable",
    findings: c.objectiveIds.map((id) => ({
      objectiveId: id,
      depth: c.depth,
      facet: "scope",
      outcome: "assisted",
      completeCheckpointScope: false,
      evidence: [g.seq],
      rationale: "Synthetic source assistance, not independent credit",
    })),
  };
  applyLearningAssessment(r, external, e, assessment, at);
  if (!leaveSourceOpen) closeLearningSession(external);
  const source = await prepareRoadmapExport(r, external, g.study.roadmapExport);
  const reply = async (p: RoadmapReconciliationPayload) => ({
    requestId: p.requestId,
    localHash: p.localHash,
    candidateHash: p.candidateHash,
    canonical: source.content,
    definitions: [],
    mappings: [],
    completeScopes: [],
    decisions: (await reviewRoadmap(r, p.local, p.candidate)).changes
      .filter((c) => c.conflict)
      .map((c) => ({
        key: c.key,
        choice: "incoming" as const,
        rationale: "Synthetic explicit source continuation conflict resolution",
      })),
    attemptUpdates: [
      {
        track: c.track,
        attemptId: attempt.id,
        rationale:
          "Synthetic explicit resolution of this captured current attempt",
        resolveCurrent: {
          encounter: p.context.activeAttempts!.find(
            (a) => a.attemptId === attempt.id,
          )!.encounter,
          workHash: p.context.activeAttempts!.find(
            (a) => a.attemptId === attempt.id,
          )!.workHash,
        },
      },
    ],
    rationale:
      "Synthetic externally completed same-task assessment; preserve the gameplay puzzle",
  });
  return { g, l, e, c, attempt, source, reply, assessment };
}
for (const transport of ["study-mode", "chatgpt-handoff"] as const)
  test(`explicit external resolution through ${transport} preserves the exact playable puzzle and draft, closes only the settled session and imports no duplicate game visit`, async () => {
    const f = await fixture(),
      before = JSON.stringify(f.e),
      world = JSON.stringify(f.g.floors);
    await reconcileRoadmap(
      f.g,
      r,
      f.source.content,
      async (p) => {
        assert.ok(p.context.activeAttempts![0].workHash);
        assert.equal(
          JSON.stringify(p).includes("PRIVATE_CURRENT_DRAFT"),
          false,
        );
        assert.equal(
          JSON.stringify(p).includes("PRIVATE_CURRENT_REASONING"),
          false,
        );
        return f.reply(p);
      },
      undefined,
      transport,
    );
    const job = f.g.study.roadmapReconciliations![0];
    assert.equal(job.state, "ready", job.error);
    await adoptReconciledRoadmap(f.g, r, job.id);
    const l = f.g.study.learner!;
    assert.equal(l.attempts[0].status, "externally-resolved");
    assert.equal(l.currentSession, undefined);
    assert.equal(
      l.sessions.find((s) => s.id === f.attempt.session)!.status,
      "closed",
    );
    assert.equal(l.cycle, 0);
    assert.equal(l.evidence.length, 0);
    assert.equal(f.g.study.visits.length, 0);
    assert.equal(JSON.stringify(f.e), before);
    assert.equal(JSON.stringify(f.g.floors), world);
    assert.equal(f.e.state, "available");
    assert.equal(beginLearningAttempt(r, l, f.e, at).id, f.attempt.id);
    assert.equal(l.attempts.length, 1);
    assert.throws(
      () =>
        applyLearningAssessment(
          r,
          l,
          f.e,
          { ...f.assessment, id: "duplicate-after-import" },
          at,
        ),
      /resolved in the imported roadmap/,
    );
    const saved = recover(decode(encode(f.g))),
      restored = saved.study.learner!,
      next = eligibleLearning(r, restored, at);
    assert.notEqual(next.track, f.c.track);
    const e = saved.encounters["f0-room1"];
    e.problem = {
      title: "Synthetic next eligible question",
      prompt: "New question",
      starter: "",
      rubric: [],
      provenance: "study-mode",
      contract: next,
    };
    const a = beginLearningAttempt(r, restored, e, at);
    assert.equal(a.session, "S0009");
    syncLearningView(saved.study);
    assert.equal(saved.study.visits.length, 0);
    const exported = await prepareRoadmapExport(
      r,
      restored,
      saved.study.roadmapExport,
    );
    assert.equal(exported.parentHash, saved.study.roadmapExport!.hash);
    assert.equal(
      exported.content
        .split("\n")
        .find((line) => line.startsWith(`| ${f.attempt.id} |`)),
      l.attempts[0].externalResolution!.sourceRow,
    );
    const oldSession = f.source.content
      .split("\n")
      .find((line) => line.startsWith(`| ${f.attempt.session} |`));
    assert.equal(
      exported.content
        .split("\n")
        .find((line) => line.startsWith(`| ${f.attempt.session} |`)),
      oldSession,
    );
  });
test("a changed draft, human reasoning, private tutor exchange or question rejects current-work adoption without losing edits", async () => {
  for (const change of [
    "workspace",
    "reasoning",
    "tutor",
    "question",
    "run-context",
  ]) {
    const f = await fixture();
    await reconcileRoadmap(f.g, r, f.source.content, async (p) => f.reply(p));
    const job = f.g.study.roadmapReconciliations![0];
    assert.equal(job.state, "ready", job.error);
    if (change === "workspace") {
      f.e.workspace += " new edit";
      f.e.revision++;
    }
    if (change === "reasoning")
      f.e.history.push({
        ...f.e.history[0],
        seq: ++f.g.seq,
        text: "New actual human reasoning",
      });
    if (change === "tutor")
      f.e.tutor.push({
        id: "new-private",
        seq: ++f.g.seq,
        author: "human",
        kind: "human",
        text: "New private question",
        worldTime: 0,
        provenance: "synthetic-private-human-message",
      });
    if (change === "question") f.e.problem!.prompt += " changed contract";
    if (change === "run-context")
      f.e.executions = [
        {
          id: "synthetic-new-human-run",
          author: "human",
          status: "finished",
          receipt: { executed: true },
        } as any,
      ];
    const before = JSON.stringify(f.e),
      learner = JSON.stringify(f.g.study.learner);
    await assert.rejects(
      adoptReconciledRoadmap(f.g, r, job.id),
      /human work changed/,
    );
    assert.equal(JSON.stringify(f.e), before);
    assert.equal(JSON.stringify(f.g.study.learner), learner);
    assert.equal(f.g.study.roadmapAdoptionBackups, undefined);
  }
});
test("a genuinely changed work snapshot permits explicit fresh reconciliation, while unrelated world events cannot reroll the same source review", async () => {
  const f = await fixture();
  let calls = 0;
  const provider = async (p: RoadmapReconciliationPayload) => {
    calls++;
    return f.reply(p);
  };
  await reconcileRoadmap(f.g, r, f.source.content, provider);
  const old = f.g.study.roadmapReconciliations![0];
  assert.equal(old.state, "ready", old.error);
  f.g.seq++;
  f.e.history.push({
    seq: f.g.seq,
    author: "npc-unrelated",
    kind: "npc-thought",
    text: "Unrelated physical-world note",
    revision: 0,
    at: 1,
  });
  await reconcileRoadmap(f.g, r, f.source.content, provider);
  assert.equal(calls, 1);
  f.e.history.push({
    seq: ++f.g.seq,
    author: "human",
    kind: "reasoning",
    text: "New technical reasoning not covered by the external source",
    revision: 0,
    at: 2,
    wallTime: at,
  });
  f.e.workspace += " new reasoning draft";
  await assert.rejects(
    adoptReconciledRoadmap(f.g, r, old.id),
    /human work changed/,
  );
  await reconcileRoadmap(f.g, r, f.source.content, provider);
  const fresh = f.g.study.roadmapReconciliations!.at(-1)!;
  assert.equal(calls, 2);
  assert.equal(fresh.state, "ready", fresh.error);
  assert.notEqual(fresh.id, old.id);
  await adoptReconciledRoadmap(f.g, r, fresh.id);
  const resolved = f.g.study.learner!.attempts[0].externalResolution!;
  assert.equal(resolved.humanCutoff, f.g.seq);
  assert.equal(resolved.assessedHumanSequences.includes(f.g.seq), false);
  assert.equal(f.e.workspace, "PRIVATE_CURRENT_DRAFT new reasoning draft");
  assert.equal(f.g.study.visits.length, 0);
});
test("late native resolution cannot erase human work added while the response was held", async () => {
  const f = await fixture();
  let finish!: () => void;
  const task = reconcileRoadmap(
    f.g,
    r,
    f.source.content,
    async (p) =>
      new Promise((resolve) => {
        finish = () => resolve(f.reply(p));
      }),
  );
  while (!finish) await new Promise((resolve) => setTimeout(resolve, 1));
  f.e.workspace += " human edit while waiting";
  finish();
  await task;
  assert.equal(f.g.study.roadmapReconciliations![0].state, "error");
  assert.match(
    f.g.study.roadmapReconciliations![0].error!,
    /human work changed/,
  );
  assert.equal(f.g.study.learner, f.l);
  assert.ok(f.e.workspace.includes("human edit while waiting"));
});
test("a reviewed resolution cannot close a session containing another unresolved actual attempt", async () => {
  const f = await fixture(true),
    before = JSON.stringify(f.l);
  await reconcileRoadmap(f.g, r, f.source.content, async (p) => f.reply(p));
  const job = f.g.study.roadmapReconciliations![0];
  assert.equal(job.state, "error");
  assert.match(job.error!, /cannot close or replace/);
  assert.equal(JSON.stringify(f.l), before);
  assert.equal(f.l.currentSession, "S0008");
});
test("a forged resolution identity or source row cannot be exported as an externally completed attempt", async () => {
  for (const tamper of ["row", "identity", "status"]) {
    const f = await fixture();
    await reconcileRoadmap(f.g, r, f.source.content, async (p) => f.reply(p));
    const job = f.g.study.roadmapReconciliations![0];
    assert.equal(job.state, "ready", job.error);
    await adoptReconciledRoadmap(f.g, r, job.id);
    const a = f.g.study.learner!.attempts[0];
    if (tamper === "row") a.externalResolution!.sourceRow += " invented";
    if (tamper === "identity")
      a.externalResolution!.adoptionId = "another-review";
    if (tamper === "status") a.status = "served";
    await assert.rejects(
      prepareRoadmapExport(r, f.g.study.learner!, f.g.study.roadmapExport),
      /resolution/,
    );
  }
});
test("new technical work after import is assessed and retained for review, while the captured work never triggers a duplicate grade or visit", async () => {
  const f = await fixture();
  await reconcileRoadmap(f.g, r, f.source.content, async (p) => f.reply(p));
  const job = f.g.study.roadmapReconciliations![0];
  assert.equal(job.state, "ready", job.error);
  await adoptReconciledRoadmap(f.g, r, job.id);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/api/status"))
      return Response.json({
        mode: "claude-cli",
        label: "Synthetic follow-up reviewer",
        detail: "Not native certification",
        capabilities: ["generate", "tutor", "complete", "assess", "group"],
      });
    const { operation, payload } = JSON.parse(String(init?.body));
    assert.equal(operation, "assess");
    calls++;
    assert.equal(payload.packet.externalAttemptContext.adoptionId, job.id);
    assert.ok(payload.packet.externalAttemptContext.humanCutoff < f.g.seq);
    return Response.json({
      visitOutcome: "unresolved",
      findings: [
        {
          objectiveId: f.c.objectiveIds[0],
          depth: f.c.depth,
          facet: "scope",
          outcome: "assisted",
          completeCheckpointScope: false,
          evidence: [f.g.seq],
          rationale:
            "Synthetic later human contribution retained for a fresh scoped check",
        },
      ],
    });
  };
  try {
    await checkBridge();
    await assess(f.g, f.e, r, f.g.seq);
    assert.equal(calls, 0);
    const before = JSON.stringify(f.g.study.learner);
    f.e.history.push({
      seq: ++f.g.seq,
      author: "human",
      kind: "reasoning",
      text: "Actual later synthetic reasoning",
      at: 1,
      wallTime: at,
      revision: 0,
    });
    await assess(f.g, f.e, r, f.g.seq);
    assert.equal(calls, 1);
    assert.equal(f.g.study.assessments.at(-1)!.findings[0].outcome, "assisted");
    assert.equal(f.g.study.assessments.at(-1)!.status, "review-required");
    assert.equal(JSON.stringify(f.g.study.learner), before);
    assert.equal(f.g.study.visits.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await checkBridge();
  }
});
test("closing a source-open resolved session updates its status without dropping imported visit or evidence history", async () => {
  const f = await fixture(false, true);
  await reconcileRoadmap(f.g, r, f.source.content, async (p) => f.reply(p));
  const job = f.g.study.roadmapReconciliations![0];
  assert.equal(job.state, "ready", job.error);
  await adoptReconciledRoadmap(f.g, r, job.id);
  const l = f.g.study.learner!;
  assert.equal(l.currentSession, "S0008");
  closeLearningSession(l);
  const result = await prepareRoadmapExport(r, l, f.g.study.roadmapExport),
    row = (text: string) =>
      text
        .split("\n")
        .find((line) => line.startsWith("| S0008 |"))!
        .split("|")
        .slice(1, -1)
        .map((s) => s.trim());
  const before = row(f.source.content),
    after = row(result.content);
  assert.match(after[1], /closed/);
  assert.equal(after[2], before[2]);
  assert.equal(after[3], before[3]);
  assert.ok(after[3].includes("S0008-EV01"));
  assert.equal(l.cycle, 0);
  assert.equal(l.evidence.length, 0);
});
