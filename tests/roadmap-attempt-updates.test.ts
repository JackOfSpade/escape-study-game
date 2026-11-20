// Synthetic external continuation only; never actual learner certification.
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
import type { RoadmapReconciliationPayload } from "../src/roadmap-adoption-types";
import { prepareRoadmapExport } from "../src/roadmap-export";
import { createRecord } from "./helpers/record";
const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
const oldRow = r.raw.split("\n").find((s) => s.startsWith("| S0004-A13 |"))!;
const observation =
  "| S0004-EV99 | S0004-A13 | 2026-10-16 | T02.1 | D1 synthetic assisted metric definition | GUIDED | HINT | 1 | Synthetic external continuation; the learner used a supplied metric hint. No independent pass or actual runtime execution. |";
function fixture() {
  const g = createRecord(7, r);
  g.study.profile = "live";
  return g;
}
function candidate(
  disposition = "COMPLETED; assisted narrow continuation, not mastery",
) {
  const c = oldRow
    .split("|")
    .slice(1, -1)
    .map((s) => s.trim());
  c[3] = disposition;
  c[4] = "S0004-EV99";
  c[5] =
    "Historical pending task continued externally; preserve all unknown facets";
  const updatedRow = `| ${c.join(" | ")} |`;
  const raw = r.raw
    .replace(/^revision: 9$/m, "revision: 10")
    .replace(/^previous_revision: 8$/m, "previous_revision: 9")
    .replace(/^parent_file_sha256: .+$/m, `parent_file_sha256: ${r.sourceHash}`)
    .replace(oldRow, updatedRow);
  const marker = "### 0.5.1 Attempt status register";
  const pe = raw.indexOf("<!-- BEGIN PE_PROGRESS -->");
  const where = raw.indexOf(marker, pe);
  return raw.slice(0, where) + observation + "\n\n" + raw.slice(where);
}
const reply = (p: RoadmapReconciliationPayload) => ({
  requestId: p.requestId,
  localHash: p.localHash,
  candidateHash: p.candidateHash,
  canonical: p.candidate,
  definitions: [],
  mappings: [],
  completeScopes: [],
  decisions: [],
  attemptUpdates: [
    {
      track: "PE" as const,
      attemptId: "S0004-A13",
      rationale:
        "Synthetic review of an actual source-recorded assisted continuation; not an ID collision",
    },
  ],
  rationale: "Synthetic historical disposition reconciliation only",
});
test("reviewed historical continuation retains exact before/after rows in a portable audit without inventing local study or changing mastery", async () => {
  const g = fixture(),
    before = structuredClone(g.study.learner!);
  await reconcileRoadmap(g, r, candidate(), async (p) => reply(p));
  const job = g.study.roadmapReconciliations![0];
  assert.equal(job.state, "ready", job.error);
  assert.equal(g.study.learner!.version, before.version);
  const proposed = job.proposal!.canonical;
  const encoded = /<!-- ATTEMPT_UPDATE (.+) -->/.exec(proposed)![1];
  const audit = JSON.parse(decodeURIComponent(encoded));
  assert.equal(audit.previousRow, oldRow);
  assert.equal(
    audit.updatedRow,
    candidate()
      .split("\n")
      .find((s) => s.startsWith("| S0004-A13 |")),
  );
  assert.equal(audit.localHash, job.payload.localHash);
  assert.equal(audit.incomingHash, job.payload.candidateHash);
  await adoptReconciledRoadmap(g, r, job.id);
  assert.equal(g.study.roadmapExport!.content, proposed);
  assert.deepEqual(g.study.learner!.cells, before.cells);
  assert.equal(g.study.learner!.attempts.length, 0);
  assert.equal(g.study.learner!.evidence.length, 0);
  assert.equal(g.study.visits.length, 0);
  const restored = recover(decode(encode(g)));
  assert.equal(
    (
      await prepareRoadmapExport(
        r,
        restored.study.learner!,
        restored.study.roadmapExport,
      )
    ).content,
    proposed,
  );
  assert.equal(restored.study.roadmapAdoptionBackups![0].local, r.raw);
  const l = restored.study.learner!,
    e = restored.encounters["question-0"],
    c = eligibleLearning(r, l, "2026-10-16T16:00:00Z");
  e.problem = {
    title: "Synthetic later actual app study",
    prompt: "Continue eligible work",
    starter: "",
    rubric: [],
    provenance: "study-mode",
    contract: c,
  };
  beginLearningAttempt(r, l, e, "2026-10-16T16:00:00Z");
  const next = await prepareRoadmapExport(r, l, restored.study.roadmapExport);
  assert.equal(next.parentHash, restored.study.roadmapExport!.hash);
  assert.equal(
    next.content.split("\n").find((s) => s.startsWith("| S0004-A13 |")),
    audit.updatedRow,
  );
  assert.ok(next.content.includes(`<!-- ATTEMPT_UPDATE ${encoded} -->`));
  assert.equal(l.evidence.length, 0);
});
test("an undeclared continuation, changed issuance, fabricated disposition or reused terminal ID cannot bypass history preservation", async () => {
  for (const bad of [
    "undeclared",
    "scope",
    "date",
    "missing-observation",
    "duplicate",
    "terminal",
    "wrong-track",
    "unknown-update",
    "missing-replacement",
  ]) {
    const g = fixture(),
      before = JSON.stringify(g.study.learner);
    let raw = candidate();
    if (bad === "scope") {
      const row = raw.split("\n").find((s) => s.startsWith("| S0004-A13 |"))!;
      raw = raw.replace(
        row,
        row.replace(oldRow.split("|")[3], " Another unrelated task "),
      );
    }
    if (bad === "terminal") {
      const row = raw.split("\n").find((s) => s.startsWith("| S0007-A01 |"))!;
      raw = raw.replace(
        row,
        row.replace(
          "COMPLETED; independent narrow closure facet",
          "INVALIDATED; synthetic later correction",
        ),
      );
    }
    if (bad === "date") {
      const row = raw.split("\n").find((s) => s.startsWith("| S0004-A13 |"))!;
      raw = raw.replace(row, row.replace("2026-09-15", "2026-09-16"));
    }
    if (bad === "missing-observation")
      raw = raw.replace(observation + "\n", "");
    if (bad === "missing-replacement")
      raw = candidate("SUPERSEDED; pending scope replaced");
    await reconcileRoadmap(g, r, raw, async (p) => {
      const out = reply(p);
      if (bad === "undeclared") out.attemptUpdates = [];
      if (bad === "duplicate")
        out.attemptUpdates.push({ ...out.attemptUpdates[0] });
      if (bad === "terminal") out.attemptUpdates[0].attemptId = "S0007-A01";
      if (bad === "wrong-track") out.attemptUpdates[0].track = "PY" as any;
      if (bad === "unknown-update")
        out.attemptUpdates[0].attemptId = "S9999-A01";
      return out;
    });
    assert.equal(g.study.roadmapReconciliations![0].state, "error", bad);
    assert.equal(JSON.stringify(g.study.learner), before, bad);
    assert.equal(g.study.roadmapExport, undefined);
    if (bad === "terminal")
      assert.match(
        g.study.roadmapReconciliations![0].error!,
        /terminal history/,
      );
  }
});
test("later reconciliation cannot strip or rewrite a prior portable attempt audit", async () => {
  for (const bad of ["delete", "edit", "duplicate"]) {
    const g = fixture();
    await reconcileRoadmap(g, r, candidate(), async (p) => reply(p));
    await adoptReconciledRoadmap(g, r, g.study.roadmapReconciliations![0].id);
    const local = g.study.roadmapExport!;
    const incoming = local.content
      .replace(/^revision: 10$/m, "revision: 11")
      .replace(/^previous_revision: 9$/m, "previous_revision: 10")
      .replace(/^parent_file_sha256: .+$/m, `parent_file_sha256: ${local.hash}`)
      .replace("| Learner | Mid-level", "| Learner | Updated; Mid-level");
    await reconcileRoadmap(g, r, incoming, async (p) => ({
      ...reply(p),
      attemptUpdates: [],
      canonical: p.candidate.replace(/<!-- ATTEMPT_UPDATE .+ -->/, (audit) =>
        bad === "delete"
          ? ""
          : bad === "duplicate"
            ? `${audit}\n${audit}`
            : "<!-- ATTEMPT_UPDATE fabricated -->",
      ),
    }));
    assert.equal(g.study.roadmapReconciliations!.at(-1)!.state, "error");
    assert.match(g.study.roadmapReconciliations!.at(-1)!.error!, /audit/);
    assert.equal(g.study.roadmapExport!.content, local.content);
  }
});
test("a historical disposition declaration cannot resolve an actual current attempt or replace its draft/session", async () => {
  const g = fixture(),
    l = g.study.learner!,
    e = g.encounters["question-0"],
    c = eligibleLearning(r, l, "2026-10-16T16:00:00Z");
  e.problem = {
    title: "Synthetic active task",
    prompt: "Keep my actual task",
    starter: "",
    rubric: [],
    provenance: "study-mode",
    contract: c,
  };
  e.workspace = "private unfinished draft";
  beginLearningAttempt(r, l, e, "2026-10-16T16:00:00Z");
  const a = l.attempts[0],
    local = await prepareRoadmapExport(r, l);
  g.study.roadmapExport = local;
  let incoming = local.content
    .replace(/^revision: 10$/m, "revision: 11")
    .replace(/^previous_revision: 9$/m, "previous_revision: 10")
    .replace(/^parent_file_sha256: .+$/m, `parent_file_sha256: ${local.hash}`);
  const row = incoming.split("\n").find((s) => s.startsWith(`| ${a.id} |`))!;
  const changed = row
    .split("|")
    .slice(1, -1)
    .map((s) => s.trim());
  changed[3] = "DECLINED; external administrative claim";
  incoming = incoming.replace(row, `| ${changed.join(" | ")} |`);
  const before = JSON.stringify(l);
  await reconcileRoadmap(g, r, incoming, async (p) => ({
    ...reply(p),
    attemptUpdates: [
      {
        track: c.track,
        attemptId: a.id,
        rationale: "Synthetic attempted external closure",
      },
    ],
  }));
  const job = g.study.roadmapReconciliations![0];
  assert.equal(job.state, "error");
  assert.match(job.error!, /current attempt/);
  assert.equal(JSON.stringify(l), before);
  assert.equal(e.workspace, "private unfinished draft");
  assert.equal(g.study.roadmapExport!.hash, local.hash);
});
