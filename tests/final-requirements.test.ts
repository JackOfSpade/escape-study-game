import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  curriculumReadiness,
  finalRequirements,
} from "../src/final-requirements";
import { initialLearner } from "../src/learner";
import type { Roadmap, Track } from "../src/model";

const r = JSON.parse(readFileSync("public/curriculum.json", "utf8")) as Roadmap;

function passedOrdinaryFixture(source: Roadmap, track: Track) {
  const l = initialLearner(source, "test");
  for (const o of source.tracks[track].objectives) {
    for (let depth = 1; depth <= o.target; depth++) {
      const key = `${o.id}/D${depth}`,
        ref = `synthetic-${key}`;
      l.cells[o.id].states[depth - 1] = "P";
      l.scopes[key] = {
        id: key,
        objectiveId: o.id,
        depth,
        sourceScope: o.scope,
        facets: [
          {
            id: "scope",
            description: "Complete synthetic scope; not human learning",
          },
        ],
      };
      l.verifiedScopes.push(key);
      l.cells[o.id].facets[`D${depth}:scope`] = {
        outcome: "independent",
        evidenceIds: [ref],
        updatedAt: "2026-10-16T12:00:00Z",
      };
      l.evidence.push({
        id: ref,
        attemptId: "fixture",
        encounter: "fixture",
        objectiveId: o.id,
        depth,
        facet: "scope",
        outcome: "independent",
        artifactSequences: [1],
        helpMessageIds: [],
        at: "2026-10-16T12:00:00Z",
        execution: "not-run",
        rationale: "Synthetic fixture only",
      });
    }
  }
  return l;
}
function passImportedFinals(source: Roadmap, track: Track) {
  // A synthetic alternate source, never written into the real source or live ledger.
  source.tracks[track].progress = source.tracks[track].progress
    .replace(/^(\| T\d{2} \| )U( \| — \| U \| — \|)$/gm, "$1P$2")
    .replace(/^(\| I\d{2} \| ACTIVE \| )U( \|)/gm, "$1P$2");
}

test("final registry derives all active transfers, selected integrations and separate ENV from revision 9", () => {
  const py = finalRequirements(r, "PY"),
    pe = finalRequirements(r, "PE");
  assert.equal(py.filter((d) => d.kind === "transfer").length, 16);
  assert.equal(pe.filter((d) => d.kind === "transfer").length, 20);
  assert.deepEqual(
    pe.filter((d) => d.kind === "integration" && d.selected).map((d) => d.name),
    ["I01", "I02", "I03", "I05", "I06"],
  );
  assert.equal(
    py.filter((d) => d.kind === "integration" && d.selected).length,
    6,
  );
  assert.equal(pe.filter((d) => d.kind === "environment").length, 6);
  assert.ok(!pe.some((d) => d.kind === "transfer" && d.name.startsWith("X")));
  assert.match(
    pe.find((d) => d.id === "PE:I03")!.scope,
    /race handling, accessibility/,
  );
  assert.match(py.find((d) => d.id === "PY:T01")!.scope, /changed assumptions/);
  assert.notEqual(py[0].scope, pe[0].scope);
});

test("ordinary checkpoint completion leaves all topic transfers and selected integrations required", () => {
  for (const track of ["PY", "PE"] as const) {
    const l = passedOrdinaryFixture(r, track),
      before = JSON.stringify(l);
    const report = curriculumReadiness(r, l, track);
    assert.equal(report.checkpoints.passed, report.checkpoints.total);
    assert.equal(report.unresolvedMaterialGaps.length, 0);
    assert.equal(report.transfers.passed, 0);
    assert.equal(report.integrations.passed, 0);
    assert.equal(report.curriculumTargetsMet, false);
    assert.equal(report.tier4RequirementsMet, false);
    assert.equal(JSON.stringify(l), before);
    assert.equal(Object.keys(l.cells).length, 192);
  }
});

test("ENV and delayed retention never substitute for or block a final tier gate", () => {
  const source = structuredClone(r);
  passImportedFinals(source, "PE");
  const l = passedOrdinaryFixture(source, "PE");
  const report = curriculumReadiness(source, l, "PE");
  assert.equal(report.transfers.passed, 20);
  assert.equal(report.integrations.passed, 5);
  assert.equal(report.tier4RequirementsMet, true);
  assert.equal(report.trackedEnvironmentObserved, false);
  assert.equal(report.retention.verified, 0);
  source.tracks.PE.progress = source.tracks.PE.progress.replace(
    /^(\| ENV\d{2} \|.*? \|.*? \| )U( \|)/gm,
    "$1P$2",
  );
  assert.equal(
    curriculumReadiness(source, l, "PE").trackedEnvironmentObserved,
    true,
  );
  source.tracks.PE.progress = source.tracks.PE.progress.replace(
    "| I06 | ACTIVE | P |",
    "| I06 | ACTIVE | G |",
  );
  assert.equal(
    curriculumReadiness(source, l, "PE").tier4RequirementsMet,
    false,
  );
});

test("integration requirements follow selected source scope instead of default hard-coded denominators", () => {
  const source = structuredClone(r);
  passImportedFinals(source, "PE");
  source.tracks.PE.progress = source.tracks.PE.progress.replace(
    "| I04 | NOT_SELECTED | U |",
    "| I04 | ACTIVE | U |",
  );
  const l = passedOrdinaryFixture(source, "PE"),
    report = curriculumReadiness(source, l, "PE");
  assert.equal(report.integrations.total, 6);
  assert.equal(report.integrations.passed, 5);
  assert.equal(report.tier4RequirementsMet, false);
});

test("readiness rejects unsupported new passes and cannot close depth-specific gaps from a blank definition", () => {
  const l = initialLearner(r, "test");
  for (const cell of Object.values(l.cells))
    cell.states = cell.states.map((v) => (v === "—" ? v : "P"));
  l.scopes["PY:T01.1/D1"] = {
    id: "PY:T01.1/D1",
    objectiveId: "PY:T01.1",
    depth: 1,
    sourceScope: r.tracks.PY.objectives[0].scope,
    facets: [],
  };
  l.verifiedScopes.push("PY:T01.1/D1");
  const report = curriculumReadiness(r, l, "PY");
  assert.equal(report.checkpoints.passed, 2);
  assert.ok(report.unresolvedMaterialGaps.includes("PY:G0001"));
  assert.ok(report.unresolvedMaterialGaps.includes("PY:G0007"));
  assert.equal(report.curriculumTargetsMet, false);
});

test("missing, duplicate or divergent final source records fail visibly", () => {
  const source = structuredClone(r);
  source.tracks.PE.progress = source.tracks.PE.progress.replace(
    "| T01 | U | — | U | — |",
    "",
  );
  assert.throws(() => finalRequirements(source, "PE"), /Missing active topic/);
  source.tracks.PE.progress = r.tracks.PE.progress.replace(
    "| I01 | ACTIVE | U | — | End-to-end feature slice |",
    "| I01 | ACTIVE | U | — | End-to-end feature slice |\n| I01 | ACTIVE | U | — | duplicate |",
  );
  assert.throws(() => finalRequirements(source, "PE"), /Duplicate/);
  const l = initialLearner(r, "test");
  l.sourceHash = "divergent";
  assert.throws(() => curriculumReadiness(r, l, "PY"), /source mismatch/);
});

test("a truncated gap row stays an unresolved gap instead of failing readiness", () => {
  const source = structuredClone(r);
  source.tracks.PY.progress = source.tracks.PY.progress.replace(
    "### 0.7 ",
    "| G9999 | T01.1 / D1 | truncated |\n\n### 0.7 ",
  );
  const report = curriculumReadiness(
    source,
    initialLearner(source, "test"),
    "PY",
  );
  assert.ok(report.unresolvedMaterialGaps.includes("PY:G9999"));
  assert.equal(report.curriculumTargetsMet, false);
});
