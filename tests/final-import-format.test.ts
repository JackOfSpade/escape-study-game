// Synthetic source-bound final review fixtures, never actual learner certification.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  finalRequirements,
  finalRequirementStatus,
} from "../src/final-requirements";
import { beginLearningAttempt, eligibleLearning } from "../src/learner";
import type { Roadmap, Track } from "../src/model";
import { decode, encode, recover } from "../src/persistence";
import {
  adoptReconciledRoadmap,
  reconcileRoadmap,
} from "../src/roadmap-adoption";
import { prepareRoadmapExport } from "../src/roadmap-export";
import {
  projectIdentifierCounters,
  readIdentifierCounters,
} from "../src/roadmap-identifiers";
import { inspectMergedDocument } from "../src/roadmap-structure";
import { createRecord } from "./helpers/record";
const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
const excerpt =
  "Synthetic independent changed-context reasoning covers the complete reviewed requirement; actual runtime execution was not claimed.";
async function review(track: Track, name: string, mode = "valid") {
  const g = createRecord(7, r);
  g.study.profile = "live";
  const requirement = finalRequirements(r, track).find((d) => d.name === name)!;
  const id = "S0007-EV98",
    task = "S0007-A98";
  let raw = r.raw
    .replace(/^revision: 9$/m, "revision: 10")
    .replace(/^previous_revision: 8$/m, "previous_revision: 9")
    .replace(
      /^parent_file_sha256: .+$/m,
      `parent_file_sha256: ${r.sourceHash}`,
    );
  let at = raw.indexOf(
    "### 0.5.1 Attempt status register",
    raw.indexOf(`<!-- BEGIN ${track}_PROGRESS -->`),
  );
  let title =
    mode === "conflicting-label"
      ? "D2 ordinary task / Tier 4 final requirement"
      : mode === "wrong-depth"
        ? "D2 ordinary task"
        : mode === "explicit"
          ? "D4 independent changed-context work"
          : "Independent changed-context work";
  const scope =
    mode === "checkpoint-scope"
      ? "T01.1"
      : mode === "wrong-scope"
        ? "T02"
        : name;
  const observation = `| ${id} | ${task} | 2026-10-16 | ${scope} | ${title} | ${mode === "guided" ? "GUIDED" : "TRANSFER"} | ${mode === "guided" ? "HINT" : "NONE"} | 3 | ${excerpt} |`;
  raw = raw.slice(0, at) + observation + "\n\n" + raw.slice(at);
  at = raw.indexOf("### 0.6 Facet gaps", at);
  raw =
    raw.slice(0, at) +
    `| ${task} | S0007 / 2026-10-16 | ${name} independent changed-context assessment | ${mode === "invalidated" ? "INVALIDATED" : "COMPLETED"}; source-recorded result | ${id} | Synthetic actual source task, no app visit |\n\n` +
    raw.slice(at);
  const registerKey = [...inspectMergedDocument(raw).rows.keys()].find(
    (k) =>
      k.startsWith(
        `${track}_PROGRESS/${name.startsWith("I") ? "0.8 Integration coverage" : "0.7 Topic transfer and retention"}/`,
      ) && k.endsWith("/" + name),
  )!;
  const row = inspectMergedDocument(raw).rows.get(registerKey)!;
  const cells = row
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim());
  const statusIndex = name.startsWith("I") ? 2 : 1,
    refIndex = name.startsWith("I") ? 3 : 2;
  cells[statusIndex] = "P";
  cells[refIndex] =
    mode === "missing-link" ? "—" : mode === "prefix-link" ? "S0007-EV980" : id;
  if (mode === "review-only-link") {
    cells[2] = "—";
    cells[4] = id;
  }
  if (mode === "unselected") cells[1] = "NOT_SELECTED";
  const blockStart = raw.indexOf(`<!-- BEGIN ${track}_PROGRESS -->`),
    blockEnd = raw.indexOf(`<!-- END ${track}_PROGRESS -->`);
  raw =
    raw.slice(0, blockStart) +
    raw.slice(blockStart, blockEnd).replace(row, `| ${cells.join(" | ")} |`) +
    raw.slice(blockEnd);
  raw = projectIdentifierCounters(
    raw,
    readIdentifierCounters(raw, false).counters,
  );
  const definition = {
    id: requirement.id + "/T4",
    objectiveId: requirement.id,
    depth: 4,
    sourceScope: requirement.scope,
    facets: [
      {
        id: "whole-scope",
        description:
          "Synthetic reviewed complete source scope, not a real assessment",
      },
    ],
  };
  await reconcileRoadmap(g, r, raw, async (p) => ({
    requestId: p.requestId,
    localHash: p.localHash,
    candidateHash: p.candidateHash,
    canonical: p.candidate,
    definitions: [definition],
    mappings: [
      {
        scopeId: definition.id,
        facet: "whole-scope",
        outcome: "independent",
        evidenceIds: [id],
        sourceExcerpts: { [id]: excerpt },
        rationale:
          "Synthetic semantic mapping of exact source observations only",
      },
    ],
    completeScopes: [definition.id],
    decisions: [],
    rationale: "Synthetic manual final-record format support",
  }));
  return { g, requirement };
}
for (const [track, name] of [
  ["PY", "T01"],
  ["PE", "T01"],
  ["PY", "I01"],
  ["PE", "I01"],
] as [Track, string][])
  test(`manual ${track}:${name} final evidence resolves depth from its exact authoritative register link, persists and survives changed export`, async () => {
    const { g, requirement } = await review(track, name),
      job = g.study.roadmapReconciliations!.at(-1)!;
    assert.equal(job.state, "ready", job.error);
    const before = structuredClone(g.study.learner!);
    await adoptReconciledRoadmap(g, r, job.id);
    assert.equal(finalRequirementStatus(r, g.study.learner!, requirement), "P");
    assert.deepEqual(g.study.learner!.cells, before.cells);
    assert.equal(g.study.learner!.evidence.length, 0);
    assert.equal(g.study.visits.length, 0);
    assert.equal(
      g.study.learner!.tracks[track].tier,
      before.tracks[track].tier,
    );
    const copy = recover(decode(encode(g))),
      learner = copy.study.learner!;
    assert.equal(finalRequirementStatus(r, learner, requirement), "P");
    const e = copy.encounters["question-0"];
    e.problem = {
      title: "Later synthetic actual study",
      prompt: "Continue scope",
      starter: "",
      rubric: [],
      provenance: "study-mode",
      contract: eligibleLearning(r, learner, "2026-10-17T12:00:00Z"),
    };
    beginLearningAttempt(r, learner, e, "2026-10-17T12:00:00Z");
    const exported = await prepareRoadmapExport(
      r,
      learner,
      copy.study.roadmapExport,
    );
    assert.notEqual(exported.content, job.proposal!.canonical);
    assert.equal(finalRequirementStatus(r, learner, requirement), "P");
    const register = [...inspectMergedDocument(exported.content).rows].find(
      ([k]) =>
        k.startsWith(
          `${track}_PROGRESS/${name.startsWith("I") ? "0.8 Integration coverage" : "0.7 Topic transfer and retention"}/`,
        ) && k.endsWith("/" + name),
    )![1];
    assert.ok(register.includes("S0007-EV98"));
  });
test("manual final register linkage cannot override an explicit lower depth, another scope, guidance, invalidation or a missing/extraneous reference", async () => {
  for (const mode of [
    "wrong-depth",
    "conflicting-label",
    "checkpoint-scope",
    "review-only-link",
    "wrong-scope",
    "guided",
    "invalidated",
    "missing-link",
    "prefix-link",
    "unselected",
  ]) {
    const { g } = await review(
      "PE",
      mode === "unselected" ? "I01" : "T01",
      mode,
    );
    assert.equal(g.study.roadmapReconciliations!.at(-1)!.state, "error", mode);
    assert.equal(g.study.learner!.roadmapAdoptions?.length ?? 0, 0, mode);
    assert.equal(g.study.visits.length, 0, mode);
    assert.equal(g.study.learner!.evidence.length, 0, mode);
  }
});
test("explicit D4 final evidence remains supported", async () => {
  const { g } = await review("PE", "I01", "explicit");
  const job = g.study.roadmapReconciliations!.at(-1)!;
  assert.equal(job.state, "ready", job.error);
});
