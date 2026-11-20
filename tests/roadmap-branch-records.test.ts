// Synthetic document reconciliation; no real learner progress is changed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { beginLearningAttempt, eligibleLearning } from "../src/learner";
import type { Roadmap } from "../src/model";
import { decode, encode, recover } from "../src/persistence";
import {
  adoptReconciledRoadmap,
  reconcileRoadmap,
} from "../src/roadmap-adoption";
import type {
  RoadmapReconciliation,
  RoadmapReconciliationPayload,
} from "../src/roadmap-adoption-types";
import { prepareRoadmapExport } from "../src/roadmap-export";
import {
  projectIdentifierCounters,
  readIdentifierCounters,
} from "../src/roadmap-identifiers";
import { inspectMergedDocument } from "../src/roadmap-structure";
import { createRecord } from "./helpers/record";
const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
const attempt =
  "| S0007-A98 | S0007 / 2026-10-16 | T02.1 D1 branch-local task | PENDING; no inference | — | Synthetic allocated task, not a visit |";
const evidence =
  "| S0007-EV98 | S0007-A98 | 2026-10-16 | T02.1 | D1 synthetic branch observation | GUIDED | HINT | 1 | Synthetic assisted observation; no independent checkpoint or actual runtime execution. |";
const incomingAttempt = attempt.replace(
  "branch-local task",
  "different incoming task",
);
const incomingEvidence = evidence.replace(
  "Synthetic assisted observation",
  "Distinct incoming assisted observation",
);
const extra = evidence
  .replace("S0007-EV98", "S0007-EV99")
  .replace(
    "Synthetic assisted observation",
    "Second incoming assisted observation",
  );
function revision(raw: string, hash: string, n: number) {
  return raw
    .replace(/^revision: \d+$/m, `revision: ${n}`)
    .replace(/^previous_revision: \d+$/m, `previous_revision: ${n - 1}`)
    .replace(/^parent_file_sha256: .+$/m, `parent_file_sha256: ${hash}`);
}
function reply(p: RoadmapReconciliationPayload): RoadmapReconciliation {
  return {
    requestId: p.requestId,
    localHash: p.localHash,
    candidateHash: p.candidateHash,
    canonical: p.candidate,
    definitions: [],
    mappings: [],
    completeScopes: [],
    decisions: [],
    rationale:
      "Synthetic preservation only; unresolved branch work grants no learning",
  };
}
async function setup() {
  const g = createRecord(7, r);
  g.study.profile = "live";
  let raw = revision(r.raw, r.sourceHash, 10);
  const start = raw.indexOf("<!-- BEGIN PE_PROGRESS -->"),
    pos = raw.indexOf("### 0.5.1 Attempt status register", start);
  raw = raw.slice(0, pos) + evidence + "\n\n" + raw.slice(pos);
  const stop = raw.indexOf("### 0.6 Facet gaps", pos);
  raw = raw.slice(0, stop) + attempt + "\n\n" + raw.slice(stop);
  raw = projectIdentifierCounters(
    raw,
    readIdentifierCounters(raw, false).counters,
  );
  await reconcileRoadmap(g, r, raw, async (p) => reply(p));
  assert.equal(
    g.study.roadmapReconciliations![0].state,
    "ready",
    g.study.roadmapReconciliations![0].error,
  );
  await adoptReconciledRoadmap(g, r, g.study.roadmapReconciliations![0].id);
  return g;
}
async function branch(
  g: ReturnType<typeof createRecord>,
  mutate?: (
    p: RoadmapReconciliation,
    ctx: RoadmapReconciliationPayload,
  ) => void,
  evidenceOnly = false,
) {
  const local = g.study.roadmapExport!;
  let candidate = revision(local.content, local.hash, local.revision + 1)
    .replace(attempt, evidenceOnly ? attempt : incomingAttempt)
    .replace(evidence, incomingEvidence + (evidenceOnly ? "" : "\n" + extra));
  candidate = projectIdentifierCounters(
    candidate,
    readIdentifierCounters(candidate, false).counters,
  );
  await reconcileRoadmap(g, r, candidate, async (ctx) => {
    const p = reply(ctx);
    p.canonical = projectIdentifierCounters(
      revision(ctx.local, ctx.localHash, local.revision + 1),
      readIdentifierCounters(ctx.candidate, false).counters,
    );
    p.branchConflicts = [
      { track: "PE", id: evidenceOnly ? "S0007-EV98" : "S0007-A98" },
    ];
    p.branchRationale =
      "These source-recorded tasks differ in issued scope; preserve both identities, resolve neither academically.";
    const incoming = inspectMergedDocument(ctx.candidate),
      rows = inspectMergedDocument(ctx.local).rows;
    p.decisions = [...incoming.rows]
      .filter(([k, row]) => rows.has(k) && rows.get(k) !== row)
      .map(([key]) => ({
        key,
        choice: (inspectMergedDocument(p.canonical).rows.get(key) ===
        rows.get(key)
          ? "local"
          : "merged") as "local" | "merged",
        rationale:
          "Preserve local row; conflicting incoming history remains source-qualified and unresolved",
      }));
    mutate?.(p, ctx);
    return p;
  });
  return g.study.roadmapReconciliations!.at(-1)!;
}
test("distinct branch-issued task and dependent observations survive explicit adoption, reload and export without renumbering or credit", async () => {
  const g = await setup(),
    before = structuredClone(g.study.learner!);
  const job = await branch(g);
  assert.equal(job.state, "ready", job.error);
  const canonical = job.proposal!.canonical;
  const audit = JSON.parse(
    decodeURIComponent(/<!-- BRANCH_RECORDS (.+) -->/.exec(canonical)![1]),
  );
  assert.equal(audit.incomingHash, job.payload.candidateHash);
  assert.deepEqual(
    audit.records.map((r: any) => r.row).sort(),
    [incomingAttempt, incomingEvidence, extra].sort(),
  );
  assert.ok(canonical.includes(attempt));
  assert.ok(canonical.includes(evidence));
  assert.ok(!canonical.includes(extra));
  assert.equal(g.study.learner!.version, before.version);
  await adoptReconciledRoadmap(g, r, job.id);
  const restored = recover(decode(encode(g)));
  assert.equal(
    (
      await prepareRoadmapExport(
        r,
        restored.study.learner!,
        restored.study.roadmapExport,
      )
    ).content,
    canonical,
  );
  assert.deepEqual(restored.study.learner!.cells, before.cells);
  assert.equal(restored.study.visits.length, 0);
  assert.equal(restored.study.learner!.evidence.length, 0);
  assert.equal(restored.study.learner!.identifierCounters!.evidence.S0007, 100);
  const learner = restored.study.learner!,
    encounter = restored.encounters["question-0"];
  encounter.problem = {
    title: "Synthetic later actual study",
    prompt: "Continue eligible scope",
    starter: "",
    rubric: [],
    provenance: "study-mode",
    contract: eligibleLearning(r, learner, "2026-10-17T16:00:00Z"),
  };
  beginLearningAttempt(r, learner, encounter, "2026-10-17T16:00:00Z");
  const next = await prepareRoadmapExport(
    r,
    learner,
    restored.study.roadmapExport,
  );
  assert.notEqual(
    next.content,
    canonical,
    "exercise a changed export, not only its cached bytes",
  );
  assert.ok(
    next.content.includes(/<!-- BRANCH_RECORDS [^\n]* -->/.exec(canonical)![0]),
  );
  assert.equal(readIdentifierCounters(next.content).issue, undefined);
  assert.ok(
    readIdentifierCounters(next.content).counters.evidence.S0007 >= 100,
  );
});
test("undeclared conflicts, relinked observations, invented audit claims and quarantined proof fail without changing learner state", async () => {
  for (const mode of [
    "undeclared",
    "dependency",
    "missing",
    "duplicate",
    "proof",
    "same-issued",
    "counters",
    "forged-audit",
  ]) {
    const g = await setup(),
      before = JSON.stringify(g.study.learner);
    const job = await branch(g, (p, ctx) => {
      if (mode === "undeclared") p.branchConflicts = [];
      if (mode === "dependency")
        p.canonical = p.canonical.replace(evidence, evidence + "\n" + extra);
      if (mode === "missing") p.branchConflicts![0].id = "S0007-A97";
      if (mode === "duplicate")
        p.branchConflicts!.push({ ...p.branchConflicts![0] });
      if (mode === "same-issued")
        p.branchConflicts = [{ track: "PE", id: "S0007-EV97" }];
      if (mode === "counters")
        p.canonical = projectIdentifierCounters(
          p.canonical,
          readIdentifierCounters(ctx.local, false).counters,
        );
      if (mode === "forged-audit")
        p.canonical = p.canonical.replace(
          "<!-- END PE_PROGRESS -->",
          "<!-- BRANCH_RECORDS arbitrary -->\n<!-- END PE_PROGRESS -->",
        );
      if (mode === "proof")
        p.mappings = [
          {
            scopeId: "PE:T02.1/D1",
            facet: "metric",
            outcome: "assisted",
            evidenceIds: ["S0007-EV98"],
            sourceExcerpts: { "S0007-EV98": "Synthetic assisted observation" },
            rationale: "Synthetic wrong-branch import",
          },
        ];
    });
    assert.equal(job.state, "error", mode);
    if (mode === "proof")
      assert.match(job.error!, /Unresolved source-qualified branch evidence/);
    if (mode === "counters") assert.match(job.error!, /must remain reserved/);
    assert.equal(JSON.stringify(g.study.learner), before, mode);
  }
});

test("evidence-only collision retains both observations of the same actual issued task without rewriting its identity", async () => {
  const g = await setup();
  const job = await branch(g, undefined, true);
  assert.equal(job.state, "ready", job.error);
  const audit = JSON.parse(
    decodeURIComponent(
      /<!-- BRANCH_RECORDS (.+) -->/.exec(job.proposal!.canonical)![1],
    ),
  );
  assert.deepEqual(
    audit.records.map((r: any) => r.row),
    [incomingEvidence],
  );
  assert.ok(job.proposal!.canonical.includes(attempt));
  await adoptReconciledRoadmap(g, r, job.id);
  assert.equal(g.study.learner!.evidence.length, 0);
});
test("subsequent reviewed imports cannot strip, duplicate or alter source-qualified audit history", async () => {
  for (const mode of ["strip", "duplicate", "alter"]) {
    const g = await setup();
    const first = await branch(g);
    await adoptReconciledRoadmap(g, r, first.id);
    const previous = g.study.roadmapExport!,
      before = JSON.stringify(g.study.learner);
    const candidate = revision(
      previous.content,
      previous.hash,
      previous.revision + 1,
    );
    await reconcileRoadmap(g, r, candidate, async (ctx) => {
      const p = reply(ctx),
        audit = /<!-- BRANCH_RECORDS [^\n]* -->/.exec(p.canonical)![0];
      p.canonical = p.canonical.replace(
        audit,
        mode === "strip"
          ? ""
          : mode === "duplicate"
            ? audit + "\n" + audit
            : audit.replace("BRANCH_RECORDS ", "BRANCH_RECORDS %20"),
      );
      return p;
    });
    assert.equal(g.study.roadmapReconciliations!.at(-1)!.state, "error", mode);
    assert.equal(JSON.stringify(g.study.learner), before, mode);
  }
});
