import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { activateCareerFocus } from "../src/career-profile";
import { beginVisit, initialStudy } from "../src/curriculum";
import { eligibleLearning } from "../src/learner";
import type { Roadmap } from "../src/model";
import { prepareRoadmapExport } from "../src/roadmap-export";
import { reviewRoadmap } from "../src/roadmap-review";
import { inspectMergedDocument } from "../src/roadmap-structure";
import { createGame } from "./helpers/record";
const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
const at = "2026-10-22T16:00:00Z";
const block = (text: string, name: string) =>
  text.split(`<!-- BEGIN ${name} -->`)[1].split(`<!-- END ${name} -->`)[0];

test("source export recomputes original gates instead of projecting role-profile clearance as full mastery", async () => {
  const s = initialStudy(r, "live"),
    l = s.learner!;
  const g = createGame(13, r, s),
    e = Object.values(g.encounters)[0];
  const contract = eligibleLearning(r, l, at);
  e.problem = {
    title: "Synthetic export fixture",
    prompt: "Explain the task",
    starter: "",
    rubric: ["Explain the behavior"],
    provenance: "study-mode",
    contract,
  };
  beginVisit(r, s, e);
  activateCareerFocus(r, s);
  // Deliberately set profile-only operational clearance; original objective
  // cells remain unchanged. The exporter must derive original gates itself.
  l.tracks.PE = {
    tier: 3,
    cleared: 3,
    phase: "COMPLETE",
    queue: [],
    lap: 1,
    suspended: [],
  };
  const before = JSON.stringify(l);
  const exported = await prepareRoadmapExport(r, l, undefined, at);
  assert.equal(
    JSON.stringify(l),
    before,
    "export never mutates active scheduling or observations",
  );
  assert.equal(r.raw, readFileSync("interview_prep_roadmap.md", "utf8"));
  for (const name of ["MERGE_RULES", "PY_CURRICULUM", "PE_CURRICULUM"])
    assert.equal(block(exported.content, name), block(r.raw, name));
  const pe = block(exported.content, "PE_PROGRESS");
  assert.doesNotMatch(pe, /Tier 3 \/ COMPLETE/);
  assert.doesNotMatch(pe, /PE cleared through 3/);
  assert.ok(pe.includes(`Tier ${r.tracks.PE.tier} / ${r.tracks.PE.phase}`));
  assert.match(exported.content, /PE cleared through 0/);
  const reviewed = await reviewRoadmap(r, r.raw, exported.content);
  assert.deepEqual(
    reviewed.issues.filter((i) => i.severity === "invalid"),
    [],
  );
  activateCareerFocus(r, s, "full");
  const restored = await prepareRoadmapExport(r, l, exported, at);
  assert.equal(restored.revision, exported.revision);
  assert.equal(restored.fingerprint, exported.fingerprint);
  assert.equal(restored.content, exported.content);
});

test("activating a role profile alone exports the exact original bytes and allocates no session", async () => {
  const s = initialStudy(r, "live");
  const before = structuredClone(s.learner!.sessions);
  activateCareerFocus(r, s);
  const exported = await prepareRoadmapExport(r, s.learner!, undefined, at);
  assert.equal(exported.content, r.raw);
  assert.deepEqual(s.learner!.sessions, before);
});

test("reviewed adoption under a role focus keeps exact source bytes and ancestry across export and focus toggles", async () => {
  const { reconcileRoadmap, adoptReconciledRoadmap } =
    await import("../src/roadmap-adoption");
  const s = initialStudy(r, "live"),
    g = createGame(91, r, s);
  activateCareerFocus(r, s);
  const originalCells = structuredClone(s.learner!.cells),
    originalSessions = structuredClone(s.learner!.sessions);
  const revision = (text: string, parent: string, n: number) =>
    text
      .replace(/^revision: \d+$/m, `revision: ${n}`)
      .replace(/^previous_revision: \d+$/m, `previous_revision: ${n - 1}`)
      .replace(/^parent_file_sha256: .+$/m, `parent_file_sha256: ${parent}`);
  let candidate = revision(r.raw, r.sourceHash, r.revision + 1).replace(
    "| Learner | Mid-level",
    "| Learner | Reviewed administrative profile; Mid-level",
  );
  for (let round = 0; round < 2; round++) {
    await reconcileRoadmap(g, r, candidate, async (p) => ({
      requestId: p.requestId,
      localHash: p.localHash,
      candidateHash: p.candidateHash,
      canonical: p.candidate,
      definitions: [],
      mappings: [],
      completeScopes: [],
      decisions: [...inspectMergedDocument(p.candidate).rows]
        .filter(([key, row]) => {
          const prior = inspectMergedDocument(p.local).rows.get(key);
          return prior !== undefined && prior !== row;
        })
        .map(([key]) => ({
          key,
          choice: "incoming" as const,
          rationale:
            "Explicitly accept the reviewed administrative row while retaining its prior source",
        })),
      rationale: "Synthetic administrative adoption; no new demonstration",
    }));
    const job = s.roadmapReconciliations!.at(-1)!;
    assert.equal(job.state, "ready", job.error);
    const adopted = await adoptReconciledRoadmap(g, r, job.id),
      cache = s.roadmapExport!;
    assert.equal(cache.content, adopted.cache.content);
    assert.equal(s.learner!.careerFocus, "product-feature-owner");
    const pe = adopted.parsed.tracks.PE;
    assert.deepEqual(
      (s.learner as unknown as { careerFullTrack: unknown }).careerFullTrack,
      {
        tier: pe.tier,
        cleared: pe.cleared,
        phase: pe.phase,
        lap: pe.lap,
        queue: pe.remaining,
        suspended: pe.suspended ?? [],
      },
      "full restore cursor follows the newly reviewed full source",
    );
    const after = await prepareRoadmapExport(r, s.learner!, cache, at);
    assert.equal(after.content, cache.content);
    assert.equal(after.hash, cache.hash);
    assert.equal(
      after.revision,
      cache.revision,
      "administrative role settings never create a phantom child revision",
    );
    activateCareerFocus(r, s, "full");
    const full = await prepareRoadmapExport(r, s.learner!, cache, at);
    assert.equal(full.hash, cache.hash);
    activateCareerFocus(r, s);
    assert.equal(
      (await prepareRoadmapExport(r, s.learner!, cache, at)).hash,
      cache.hash,
    );
    assert.deepEqual(s.learner!.cells, originalCells);
    assert.deepEqual(s.learner!.sessions, originalSessions);
    assert.deepEqual(s.learner!.evidence, []);
    for (const name of ["MERGE_RULES", "PY_CURRICULUM", "PE_CURRICULUM"])
      assert.equal(block(cache.content, name), block(r.raw, name));
    candidate = revision(cache.content, cache.hash, cache.revision + 1).replace(
      "Reviewed administrative profile; Mid-level",
      "Reviewed second administrative profile; Mid-level",
    );
  }
});
