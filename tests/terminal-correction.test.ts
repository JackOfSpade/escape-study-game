// Synthetic source-bound reviews only. No actual human results are corrected.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  finalRequirements,
  finalRequirementStatus,
} from "../src/final-requirements";
import { independentProofValid } from "../src/historical-proof";
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
import { createGame } from "./helpers/record";
const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
const final = finalRequirements(r, "PY").find((d) => d.id === "PY:T01")!;
const excerpt =
  "Synthetic independently observed changed-context reasoning, without supplied choices; full source-defined facet was reviewed.";
const originalTask =
  "| S0007-A98 | S0007 / 2026-10-16 | T01 changed-context assessment | COMPLETED; closed source task with independently reviewed scope | S0007-EV98 | Synthetic source-issued task; no gameplay visit |";
const correctionExcerpt =
  "Source audit found that the assessment supplied the central invariant; withdraw its score without treating it as learner failure.";
const decision = `| DEC0028 | 2026-10-17 / source audit | ASSESSMENT_CORRECTION | PY:S0007-A98 | ${correctionExcerpt} | Persistent; preserve original facts and learner history | ACTIVE |`;
const evidence =
  "| S0007-EV98 | S0007-A98 | 2026-10-16 | T01 | D4 changed-context reasoning | TRANSFER | NONE | 3 | " +
  excerpt +
  " |";
function revision(raw: string, hash: string, n: number) {
  return raw
    .replace(/^revision: \d+$/m, `revision: ${n}`)
    .replace(/^previous_revision: \d+$/m, `previous_revision: ${n - 1}`)
    .replace(/^parent_file_sha256: .+$/m, `parent_file_sha256: ${hash}`);
}
function proposal(p: RoadmapReconciliationPayload): RoadmapReconciliation {
  return {
    requestId: p.requestId,
    localHash: p.localHash,
    candidateHash: p.candidateHash,
    canonical: p.candidate,
    definitions: [],
    mappings: [],
    completeScopes: [],
    decisions: [],
    rationale: "Synthetic source-backed review only, not real learning",
  };
}
function finalRow(raw: string, status: string) {
  const key = [...inspectMergedDocument(raw).rows.keys()].find(
    (k) =>
      k.startsWith("PY_PROGRESS/0.7 Topic transfer and retention/") &&
      k.endsWith("/T01"),
  )!;
  const row = inspectMergedDocument(raw).rows.get(key)!,
    c = row
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
  c[1] = status;
  c[2] = "S0007-EV98" + (raw.includes("| S0007-EV99 |") ? ", S0007-EV99" : "");
  const start = raw.indexOf("<!-- BEGIN PY_PROGRESS -->"),
    end = raw.indexOf("<!-- END PY_PROGRESS -->");
  return (
    raw.slice(0, start) +
    raw.slice(start, end).replace(row, `| ${c.join(" | ")} |`) +
    raw.slice(end)
  );
}
async function setup(partial = false, gap = false) {
  const g = createGame(7, r);
  g.study.profile = "live";
  let raw = revision(r.raw, r.sourceHash, 10),
    at = raw.indexOf(
      "### 0.5.1 Attempt status register",
      raw.indexOf("<!-- BEGIN PY_PROGRESS -->"),
    );
  const extra = evidence
    .replaceAll("98", "99")
    .replace("| 3 |", gap ? "| 1 |" : "| 3 |");
  raw =
    raw.slice(0, at) +
    evidence +
    "\n" +
    (partial ? extra + "\n" : "") +
    "\n" +
    raw.slice(at);
  at = raw.indexOf("### 0.6 Facet gaps", at);
  raw =
    raw.slice(0, at) +
    originalTask +
    "\n" +
    (partial ? originalTask.replaceAll("98", "99") + "\n" : "") +
    "\n" +
    raw.slice(at);
  raw = projectIdentifierCounters(
    finalRow(raw, gap ? "G" : "P"),
    readIdentifierCounters(raw, false).counters,
  );
  await reconcileRoadmap(g, r, raw, async (p) => {
    const out = proposal(p),
      facets = [
        { id: "primary", description: "Synthetic complete source scope facet" },
      ];
    if (partial)
      facets.push({
        id: "secondary",
        description: "Separate synthetic retained scope facet",
      });
    out.definitions = [
      {
        id: "PY:T01/T4",
        objectiveId: "PY:T01",
        depth: 4,
        sourceScope: final.scope,
        facets,
      },
    ];
    out.mappings = facets.map((f, i) => ({
      scopeId: "PY:T01/T4",
      facet: f.id,
      outcome: gap && i === 1 ? "contradicted" : "independent",
      evidenceIds: [`S0007-EV${98 + i}`],
      sourceExcerpts: { [`S0007-EV${98 + i}`]: excerpt },
      rationale: "Synthetic exact-source independent facet mapping",
    }));
    out.completeScopes = gap ? [] : ["PY:T01/T4"];
    return out;
  });
  const job = g.study.roadmapReconciliations!.at(-1)!;
  assert.equal(job.state, "ready", job.error);
  await adoptReconciledRoadmap(g, r, job.id);
  return g;
}
async function withdraw(
  g: ReturnType<typeof createGame>,
  status = "U",
  recycle = false,
) {
  const local = g.study.roadmapExport!;
  let raw = revision(local.content, local.hash, local.revision + 1).replace(
    originalTask,
    originalTask.replace(
      "COMPLETED; closed source task with independently reviewed scope",
      "INVALIDATED; ambiguous supplied task is withdrawn without learner failure",
    ),
  );
  raw = finalRow(raw, status);
  const where = raw.indexOf("### S0.4 Merged session history");
  raw =
    raw.slice(0, where).trimEnd() + "\n" + decision + "\n\n" + raw.slice(where);
  raw = projectIdentifierCounters(
    raw,
    readIdentifierCounters(raw, false).counters,
  );
  await reconcileRoadmap(g, r, raw, async (p) => {
    const out = proposal(p),
      localRows = inspectMergedDocument(p.local).rows;
    out.attemptUpdates = [
      {
        track: "PY",
        attemptId: "S0007-A98",
        correctionDecision: { id: "DEC0028", excerpt: correctionExcerpt },
        rationale:
          "Source-recorded invalidation of supplied task, not a new contradiction or learner failure",
      },
    ];
    out.decisions = [...inspectMergedDocument(p.candidate).rows]
      .filter(([key, row]) => localRows.has(key) && localRows.get(key) !== row)
      .map(([key]) => ({
        key,
        choice: "incoming",
        rationale:
          "Use exact incoming disposition/status and retain the original observations and audit",
      }));
    if (recycle)
      out.mappings = [
        {
          scopeId: "PY:T01/T4",
          facet: "primary",
          outcome: "independent",
          evidenceIds: ["S0007-EV98"],
          sourceExcerpts: { "S0007-EV98": excerpt },
          rationale: "Synthetic invalid recycled proof",
        },
      ];
    return out;
  });
  return g.study.roadmapReconciliations!.at(-1)!;
}
test("source-backed terminal correction withdraws a closed imported pass, retains its exact original history and survives later export", async () => {
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
  const journal = JSON.parse(
    decodeURIComponent(
      /<!-- ATTEMPT_UPDATE (.+) -->/.exec(job.proposal!.canonical)![1],
    ),
  );
  assert.equal(journal.previousRow, originalTask);
  assert.equal(journal.correctionDecision.row, decision);
  assert.equal(journal.correctionDecision.excerpt, correctionExcerpt);
  assert.ok(job.proposal!.canonical.includes(decision));
  assert.ok(l.identifierCounters!.nextDecision >= 29);

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
});
test("terminal correction retains unaffected independent facets and requires partial coverage", async () => {
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

test("terminal correction preserves a separately observed existing material gap", async () => {
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

test("terminal corrections reject missing or fabricated authority, changed issuance/evidence, reopening and reused source decisions", async () => {
  for (const mode of [
    "missing",
    "absent",
    "excerpt",
    "scope",
    "references",
    "promotion",
    "reused",
    "type",
    "status",
    "duplicate-decision",
  ]) {
    const g = await setup(),
      before = JSON.stringify(g.study.learner),
      local = g.study.roadmapExport!;
    let raw = revision(local.content, local.hash, local.revision + 1).replace(
      originalTask,
      originalTask.replace(
        "COMPLETED; closed source task with independently reviewed scope",
        "INVALIDATED; source audit",
      ),
    );
    raw = finalRow(raw, "U");
    const where = raw.indexOf("### S0.4 Merged session history");
    raw =
      raw.slice(0, where).trimEnd() +
      "\n" +
      decision +
      "\n\n" +
      raw.slice(where);
    if (mode === "duplicate-decision")
      raw = raw.replace(decision, decision + "\n\n" + decision);
    if (mode === "scope")
      raw = raw.replace(
        decision,
        decision.replace("PY:S0007-A98", "PE:S0007-A98"),
      );
    if (mode === "type")
      raw = raw.replace(
        decision,
        decision.replace("ASSESSMENT_CORRECTION", "CAREER_TARGET"),
      );
    if (mode === "status")
      raw = raw.replace(
        decision,
        decision.replace("| ACTIVE |", "| REVISED |"),
      );
    if (mode === "references") {
      const row = raw.split("\n").find((s) => s.startsWith("| S0007-A98 |"))!;
      raw = raw.replace(row, row.replace("| S0007-EV98 |", "| — |"));
    }
    if (mode === "promotion")
      raw = raw.replace(
        "INVALIDATED; source audit",
        "COMPLETED; promote after correction",
      );
    raw = projectIdentifierCounters(
      raw,
      readIdentifierCounters(raw, false).counters,
    );
    await reconcileRoadmap(g, r, raw, async (p) => {
      const out = proposal(p),
        localRows = inspectMergedDocument(p.local).rows;
      out.attemptUpdates = [
        {
          track: "PY",
          attemptId: "S0007-A98",
          rationale: "Synthetic correction review",
          ...(mode === "missing"
            ? {}
            : {
                correctionDecision: {
                  id:
                    mode === "absent"
                      ? "DEC0999"
                      : mode === "reused"
                        ? "DEC0024"
                        : "DEC0028",
                  excerpt:
                    mode === "excerpt"
                      ? "Invented explanation absent from the source row"
                      : correctionExcerpt,
                },
              }),
        },
      ];
      out.decisions = [...inspectMergedDocument(p.candidate).rows]
        .filter(
          ([key, row]) => localRows.has(key) && localRows.get(key) !== row,
        )
        .map(([key]) => ({
          key,
          choice: "incoming",
          rationale: "Synthetic source row selection",
        }));
      return out;
    });
    assert.equal(g.study.roadmapReconciliations!.at(-1)!.state, "error", mode);
    assert.equal(JSON.stringify(g.study.learner), before, mode);
  }
});
test("later import cannot strip or rewrite a retained terminal-correction authority decision", async () => {
  for (const mode of ["drop", "edit", "duplicate"]) {
    const g = await setup(),
      job = await withdraw(g);
    assert.equal(job.state, "ready", job.error);
    await adoptReconciledRoadmap(g, r, job.id);
    const local = g.study.roadmapExport!,
      before = JSON.stringify(g.study.learner);
    const raw = revision(local.content, local.hash, local.revision + 1).replace(
      decision,
      mode === "drop"
        ? ""
        : mode === "duplicate"
          ? decision + "\n\n" + decision
          : decision.replace("Persistent;", "Changed;"),
    );
    await reconcileRoadmap(g, r, raw, async (p) => proposal(p));
    assert.equal(g.study.roadmapReconciliations!.at(-1)!.state, "error", mode);
    assert.equal(JSON.stringify(g.study.learner), before, mode);
  }
});

test("an imported final semantic-facet projection retains its own gap ID across another reviewed complete file", async () => {
  const g = await setup(),
    job = await withdraw(g);
  assert.equal(job.state, "ready", job.error);
  await adoptReconciledRoadmap(g, r, job.id);
  const l = g.study.learner!,
    e = g.encounters["question-0"];
  e.problem = {
    title: "Later synthetic issue",
    prompt: "Continue eligible scope",
    starter: "",
    rubric: [],
    provenance: "study-mode",
    contract: eligibleLearning(r, l, "2026-10-17T12:00:00Z"),
  };
  beginLearningAttempt(r, l, e, "2026-10-17T12:00:00Z");
  const projected = await prepareRoadmapExport(r, l, g.study.roadmapExport);
  g.study.roadmapExport = projected;
  const id = projected.gapIds["PY:T01/T4"];
  assert.ok(id);
  const incoming = revision(
    projected.content,
    projected.hash,
    projected.revision + 1,
  );
  await reconcileRoadmap(g, r, incoming, async (p) => proposal(p));
  const reviewed = g.study.roadmapReconciliations!.at(-1)!;
  assert.equal(reviewed.state, "ready", reviewed.error);
  await adoptReconciledRoadmap(g, r, reviewed.id);
  assert.equal(g.study.roadmapExport!.gapIds["PY:T01/T4"], id);
});
