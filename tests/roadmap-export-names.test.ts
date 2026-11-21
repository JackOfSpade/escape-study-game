// Synthetic fixtures only; no real learner save or progress is written.
// Exports written by earlier builds carry GAME_AI_ASSESSED_* evidence modes and
// the "0.12 Game semantic scope and continuation state" heading. New exports
// write the study names; every reader keeps accepting the legacy ones.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  applyLearningAssessment,
  beginLearningAttempt,
  closeLearningSession,
  eligibleLearning,
  registerScopes,
} from "../src/learner";
import type { Assessment, Roadmap } from "../src/model";
import {
  adoptReconciledRoadmap,
  reconcileRoadmap,
} from "../src/roadmap-adoption";
import type { RoadmapReconciliationPayload } from "../src/roadmap-adoption-types";
import { parseRoadmapDocument } from "../src/roadmap-document";
import {
  prepareRoadmapExport,
  roadmapSemanticFingerprint,
  sha256,
  type RoadmapExport,
} from "../src/roadmap-export";
import {
  assessedToken,
  isAssessedToken,
  isAssessedTokenFor,
  LEGACY_SUPPLEMENT_HEADING,
  SUPPLEMENT_HEADING,
  supplementHeadingIn,
} from "../src/roadmap-export-names";
import { reviewRoadmap } from "../src/roadmap-review";
import { createRecord } from "./helpers/record";

const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
const at = "2026-10-16T16:00:00Z";

/** The same export as an earlier build wrote it. */
function legacyWording(raw: string) {
  return raw
    .replaceAll("STUDY_AI_ASSESSED_", "GAME_AI_ASSESSED_")
    .replaceAll(
      `### ${SUPPLEMENT_HEADING}\n`,
      `### ${LEGACY_SUPPLEMENT_HEADING}\n`,
    )
    .replaceAll("study backup", "game backup")
    .replaceAll("study progress save", "game progress save")
    .replaceAll("app-recorded", "game-recorded")
    .replaceAll("tutor work or defense", "NPC work or defense");
}
async function legacyCache(file: RoadmapExport): Promise<RoadmapExport> {
  const content = legacyWording(file.content);
  assert.notEqual(content, file.content);
  return { ...file, content, hash: await sha256(content) };
}
function block(raw: string, name: string) {
  return raw
    .split(`<!-- BEGIN ${name} -->`)[1]
    .split(`<!-- END ${name} -->`)[0];
}
const cells = (line: string) =>
  line
    .slice(1, -1)
    .split("|")
    .map((c) => c.trim());
/** Evidence rows the app wrote (the original roadmap's history excluded). */
const evidenceRows = (raw: string) => {
  const original = new Set(r.raw.split("\n"));
  return raw
    .split("\n")
    .filter((line) => /^\| S\d{4}-EV\d+ \|/.test(line) && !original.has(line));
};
/** Lines a file adds to the original roadmap. */
const addedLines = (raw: string) => {
  const original = new Set(r.raw.split("\n"));
  return raw.split("\n").filter((line) => !original.has(line));
};

function studied() {
  const g = createRecord(7, r);
  g.study.profile = "live";
  const l = g.study.learner!;
  let n = 0;
  const study = () => {
    const e = Object.values(g.encounters)[n++],
      c = eligibleLearning(r, l, at);
    e.problem = {
      title: "Synthetic study",
      prompt: "Synthetic only",
      rubric: [],
      starter: "",
      provenance: "study-mode",
      contract: c,
      scopeDefinitions: c.objectiveIds.map((id) => ({
        id: `${id}/D${c.depth}`,
        objectiveId: id,
        depth: c.depth,
        sourceScope: c.scopes[c.objectiveIds.indexOf(id)],
        facets: [
          { id: "scope", description: "Synthetic complete same-depth scope" },
        ],
      })),
    };
    e.history = [
      {
        seq: 1,
        author: "human",
        kind: "reasoning",
        text: "Synthetic human contribution",
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
        id: `synthetic-names-${n}`,
        encounter: e.id,
        provenance: "study-mode",
        sourceVersion: l.version,
        status: "pending",
        evidenceCutoffSequence: 1,
        visitOutcome: "usable",
        scopeReviews: e.problem.scopeDefinitions!.map((d) => ({
          id: d.id,
          completeCoverage: true,
          rationale: "Synthetic complete source scope",
        })),
        findings: c.objectiveIds.map((id) => ({
          objectiveId: id,
          depth: c.depth,
          facet: "scope",
          outcome: "independent",
          evidence: [1],
          completeCheckpointScope: false,
          rationale: "Synthetic only",
        })),
      },
      at,
      "study-mode",
    );
  };
  return { g, l, study };
}

test("the compat helpers accept both spellings and write only the study one", () => {
  for (const outcome of [
    "independent",
    "assisted",
    "contradicted",
    "unknown",
  ]) {
    const current = assessedToken(outcome),
      legacy = `GAME_AI_ASSESSED_${outcome.toUpperCase()}`;
    assert.equal(current, `STUDY_AI_ASSESSED_${outcome.toUpperCase()}`);
    assert.ok(isAssessedToken(current) && isAssessedToken(legacy));
    assert.ok(isAssessedTokenFor(current, outcome));
    assert.ok(isAssessedTokenFor(legacy, outcome));
    assert.equal(isAssessedTokenFor(legacy.toLowerCase(), outcome), false);
  }
  assert.equal(
    isAssessedTokenFor("GAME_AI_ASSESSED_ASSISTED", "independent"),
    false,
  );
  assert.equal(isAssessedToken("GUIDED"), false);
  assert.equal(
    supplementHeadingIn(`x\n### ${LEGACY_SUPPLEMENT_HEADING}\n`),
    LEGACY_SUPPLEMENT_HEADING,
  );
  assert.equal(
    supplementHeadingIn(`x\n### ${SUPPLEMENT_HEADING}\n`),
    SUPPLEMENT_HEADING,
  );
});

test("a new export writes only study tokens, heading and wording", async () => {
  const { l, study } = studied();
  for (let i = 0; i < 3; i++) study();
  const file = await prepareRoadmapExport(r, l, undefined, at);
  const added = addedLines(file.content).join("\n");
  assert.equal(
    /game|NPC/i.test(added),
    false,
    "new export lines carry game wording",
  );
  assert.equal(file.content.includes("GAME_AI_ASSESSED_"), false);
  assert.equal(file.content.includes(LEGACY_SUPPLEMENT_HEADING), false);
  for (const t of ["PY", "PE"])
    assert.equal(
      block(file.content, `${t}_PROGRESS`).split(`### ${SUPPLEMENT_HEADING}\n`)
        .length,
      2,
    );
  const rows = evidenceRows(file.content);
  assert.equal(rows.length, 3);
  for (const row of rows)
    assert.equal(cells(row)[5], "STUDY_AI_ASSESSED_INDEPENDENT");
  assert.ok(added.includes("study backup"));
  assert.ok(added.includes("study progress save"));
  assert.ok(added.includes("app-recorded served visit(s)"));
});

test("unchanged progress re-exports a legacy-worded file byte for byte; the fingerprint ignores wording", async () => {
  const { l, study } = studied();
  for (let i = 0; i < 3; i++) study();
  const file = await prepareRoadmapExport(r, l, undefined, at);
  const legacy = await legacyCache(file);
  assert.equal(await roadmapSemanticFingerprint(l), file.fingerprint);
  assert.equal(legacy.fingerprint, file.fingerprint);
  const again = await prepareRoadmapExport(
    r,
    l,
    legacy,
    "2026-10-20T16:00:00Z",
  );
  assert.deepEqual(again, legacy);
  const current = await prepareRoadmapExport(
    r,
    l,
    file,
    "2026-10-20T16:00:00Z",
  );
  assert.deepEqual(current, file);
  // Both spellings parse to the same resume state.
  const [a, b] = await Promise.all([
    parseRoadmapDocument(file.content, r),
    parseRoadmapDocument(legacy.content, r),
  ]);
  assert.deepEqual(a.resume, b.resume);
});

test("an export built on a legacy parent has one study 0.12 section, keeps parent evidence rows and still imports", async () => {
  const { l, study } = studied();
  for (let i = 0; i < 3; i++) study();
  const legacy = await legacyCache(
    await prepareRoadmapExport(r, l, undefined, at),
  );
  const parentRows = evidenceRows(legacy.content);
  assert.equal(parentRows.length, 3);
  for (const row of parentRows)
    assert.equal(cells(row)[5], "GAME_AI_ASSESSED_INDEPENDENT");
  study();
  const next = await prepareRoadmapExport(r, l, legacy, at);
  assert.equal(next.parentHash, legacy.hash);
  for (const t of ["PY", "PE"]) {
    const p = block(next.content, `${t}_PROGRESS`);
    assert.equal(p.split(`### ${SUPPLEMENT_HEADING}\n`).length, 2, t);
    assert.equal(p.includes(LEGACY_SUPPLEMENT_HEADING), false, t);
    assert.equal(p.split("\n### 0.12 ").length, 2, t);
    const history = p
      .split("### 0.11 Revision and migration history\n")[1]
      .split("\n### ")[0]
      .split("\n")
      .filter((line) => line.startsWith("| Merged "))
      .map((line) => cells(line)[0]);
    assert.equal(new Set(history).size, history.length, `${t} 0.11 rows`);
  }
  // Exported evidence rows are immutable facts: the parent's legacy rows stay
  // byte-identical; only the row this export adds uses the study token.
  const rows = evidenceRows(next.content);
  assert.equal(rows.length, 4);
  for (const row of parentRows) assert.ok(rows.includes(row), row);
  const added = rows.filter((row) => !parentRows.includes(row));
  assert.equal(added.length, 1);
  assert.equal(cells(added[0])[5], "STUDY_AI_ASSESSED_INDEPENDENT");
  const ids = rows.map((row) => cells(row)[0]);
  assert.equal(new Set(ids).size, ids.length);
  // No game wording in what this export wrote.
  const original = new Set(legacy.content.split("\n"));
  const written = next.content
    .split("\n")
    .filter((line) => !original.has(line))
    .join("\n");
  assert.equal(/game|NPC/i.test(written), false, written);
  // Still a valid, importable descendant of the legacy parent.
  await parseRoadmapDocument(next.content, r);
  const report = await reviewRoadmap(r, legacy.content, next.content);
  assert.equal(
    report.ancestry,
    "direct-descendant",
    JSON.stringify(report.issues),
  );
  assert.deepEqual(
    report.issues.filter((i) => i.severity === "invalid"),
    [],
  );
  assert.equal(
    report.issues.some((i) => /Historical evidence/.test(i.detail)),
    false,
  );
  // And it re-exports byte for byte while progress is unchanged.
  assert.deepEqual(await prepareRoadmapExport(r, l, next, at), next);
});

/** An open current attempt that another device assessed and exported. */
async function currentAttemptSource(legacy: boolean) {
  const g = createRecord(7, r),
    l = g.study.learner!,
    e = g.encounters["question-0"];
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
  closeLearningSession(external);
  const exported = await prepareRoadmapExport(
    r,
    external,
    g.study.roadmapExport,
  );
  const source = legacy ? legacyWording(exported.content) : exported.content;
  assert.equal(source.includes("GAME_AI_ASSESSED_ASSISTED"), legacy);
  const reply = async (p: RoadmapReconciliationPayload) => {
    const active = p.context.activeAttempts!.find(
      (a) => a.attemptId === attempt.id,
    )!;
    return {
      requestId: p.requestId,
      localHash: p.localHash,
      candidateHash: p.candidateHash,
      canonical: source,
      definitions: [],
      mappings: [],
      completeScopes: [],
      decisions: (await reviewRoadmap(r, p.local, p.candidate)).changes
        .filter((c) => c.conflict)
        .map((c) => ({
          key: c.key,
          choice: "incoming" as const,
          rationale:
            "Synthetic explicit source continuation conflict resolution",
        })),
      attemptUpdates: [
        {
          track: c.track,
          attemptId: attempt.id,
          rationale:
            "Synthetic explicit resolution of this captured current attempt",
          resolveCurrent: {
            encounter: active.encounter,
            workHash: active.workHash,
          },
        },
      ],
      rationale:
        "Synthetic externally completed same-task assessment; preserve the open question",
    };
  };
  return { g, source, reply };
}
for (const legacy of [false, true])
  test(`a resolved current attempt counts ${legacy ? "legacy GAME_AI" : "STUDY_AI"}_ASSESSED_* rows as assessed work`, async () => {
    const f = await currentAttemptSource(legacy);
    await reconcileRoadmap(f.g, r, f.source, f.reply);
    const job = f.g.study.roadmapReconciliations![0];
    assert.equal(job.state, "ready", job.error);
    await adoptReconciledRoadmap(f.g, r, job.id);
    const resolved = f.g.study.learner!.attempts[0].externalResolution!;
    assert.deepEqual(resolved.assessedHumanSequences, [f.g.seq]);
  });
