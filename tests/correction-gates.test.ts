// Controlled synthetic grades exercise real scheduling/adoption, never real learning.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sha256 } from "../src/digest";
import { independentProofValid } from "../src/historical-proof";
import {
  applyLearningAssessment,
  beginLearningAttempt,
  eligibleLearning,
  reconcileGates,
  registerScopes,
} from "../src/learner";
import type { Contract, Encounter, Roadmap } from "../src/model";
import { decode, encode, recover } from "../src/persistence";
import {
  adoptReconciledRoadmap,
  compileRoadmapAdoption,
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
const at = "2026-10-16T16:00:00Z";

test("reviewed lower-pass correction suspends a real issued higher task and preserves exact draft through reload", async () => {
  const g = createRecord(77, r);
  g.study.profile = "live";
  const l = g.study.learner!;
  const base = g.encounters["question-0"];
  function encounter(c: Contract, n: number, world = g): Encounter {
    const e = structuredClone(base);
    e.id = `synthetic-scheduled-${n}`;
    e.problem = {
      title: "Synthetic gate fixture",
      prompt: "No real learner work",
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
          {
            id: "scope",
            description: "Synthetic complete reviewed source scope",
          },
        ],
      })),
    };
    e.workspace = `Exact private draft ${n}`;
    e.history = [
      {
        seq: 1,
        author: "human",
        kind: "reasoning",
        text: "Synthetic independent reasoning for scoped fixture only",
        at: 0,
        revision: 0,
        wallTime: at,
      },
    ];
    world.encounters[e.id] = e;
    registerScopes(r, world.study.learner!, e);
    return e;
  }
  function grade(e: Encounter, n: number, world = g) {
    const l = world.study.learner!,
      c = e.problem!.contract;
    applyLearningAssessment(
      r,
      l,
      e,
      {
        id: `synthetic-${n}`,
        encounter: e.id,
        provenance: "study-mode",
        sourceVersion: l.version,
        status: "pending",
        evidenceCutoffSequence: 1,
        visitOutcome: "usable",
        scopeReviews: e.problem!.scopeDefinitions!.map((d) => ({
          id: d.id,
          completeCoverage: true,
          rationale: "Synthetic whole-scope review",
        })),
        findings: c.objectiveIds.map((objectiveId) => ({
          objectiveId,
          depth: c.depth,
          facet: "scope",
          outcome: "independent",
          evidence: [1],
          completeCheckpointScope: false,
          rationale: "Synthetic grade only",
        })),
      },
      at,
      "study-mode",
    );
  }
  let target: { id: string; contract: Contract } | undefined;
  let higher: Encounter | undefined;
  for (let n = 0; n < 250; n++) {
    const c = eligibleLearning(r, l, at);
    const e = encounter(c, n);
    const a = beginLearningAttempt(r, l, e, at);
    if (c.track === "PY" && c.depth === 2) {
      higher = e;
      break;
    }
    grade(e, n);
    if (
      !target &&
      c.track === "PY" &&
      c.depth === 1 &&
      !c.review &&
      c.objectiveIds.every(
        (id) =>
          r.tracks.PY.objectives.find((o) => o.id === id)!.cells[0] !== "P",
      )
    )
      target = { id: a.id, contract: c };
  }
  assert.ok(
    higher,
    "real scheduler reaches a higher tier through source-backed synthetic grades",
  );
  assert.ok(target);
  const higherAttempt = l.attempts.find((a) =>
    a.encounter.endsWith("/" + higher.id),
  )!;
  assert.equal(higherAttempt.status, "in-progress");
  const originalHigher = structuredClone(higher);
  const oldQueue = structuredClone(l.tracks.PY);
  const file = await prepareRoadmapExport(r, l);
  g.study.roadmapExport = file;
  const external = structuredClone(l);
  for (const id of target.contract.objectiveIds) {
    const baseline = r.tracks.PY.objectives.find((o) => o.id === id)!.cells[0];
    external.cells[id].states[0] = baseline as "U" | "G";
    external.cells[id].facets["D1:scope"].outcome = "unknown";
  }
  reconcileGates(r, external);
  assert.equal(external.tracks.PY.tier, 1);
  assert.equal(
    external.attempts.find((a) => a.id === higherAttempt.id)!.status,
    "suspended",
  );
  let raw = (await prepareRoadmapExport(r, external, file)).content;
  // Preserve the issued higher-task registry row exactly. Suspension follows
  // reviewed gates, not a new assessment disposition or external resolution.
  const higherKey = [...inspectMergedDocument(file.content).rows.keys()].find(
    (k) =>
      k.startsWith("PY_PROGRESS/0.5.1 Attempt status register/") &&
      k.endsWith("/" + higherAttempt.id),
  )!;
  raw = raw.replace(
    inspectMergedDocument(raw).rows.get(higherKey)!,
    inspectMergedDocument(file.content).rows.get(higherKey)!,
  );
  const key = [...inspectMergedDocument(raw).rows.keys()].find(
    (k) =>
      k.startsWith("PY_PROGRESS/0.5.1 Attempt status register/") &&
      k.endsWith("/" + target!.id),
  )!;
  const row = inspectMergedDocument(raw).rows.get(key)!;
  const cells = row
    .split("|")
    .slice(1, -1)
    .map((s) => s.trim());
  cells[3] = "INVALIDATED; source-backed scoring correction";
  raw = raw.replace(row, `| ${cells.join(" | ")} |`);
  const decisionId = `DEC${String(readIdentifierCounters(raw, false).counters.nextDecision).padStart(4, "0")}`;
  const excerpt =
    "Source audit found supplied reasoning in this earlier assessment; withdraw its score without learner failure and retain the exact unfinished higher task.";
  const marker = raw.indexOf("### S0.4 Merged session history");
  raw =
    raw.slice(0, marker).trimEnd() +
    `\n| ${decisionId} | 2026-10-17 / source audit | ASSESSMENT_CORRECTION | PY:${target.id} | ${excerpt} | Preserve all history and drafts | ACTIVE |\n\n` +
    raw.slice(marker);
  raw = projectIdentifierCounters(
    raw,
    readIdentifierCounters(raw, false).counters,
  );
  const before = structuredClone(l);
  await reconcileRoadmap(g, r, raw, async (p) => {
    const prior = inspectMergedDocument(p.local).rows;
    return {
      requestId: p.requestId,
      localHash: p.localHash,
      candidateHash: p.candidateHash,
      canonical: p.candidate,
      definitions: [],
      mappings: [],
      completeScopes: [],
      attemptUpdates: [
        {
          track: "PY",
          attemptId: target!.id,
          rationale: "Controlled source correction",
          correctionDecision: { id: decisionId, excerpt },
        },
      ],
      decisions: [...inspectMergedDocument(p.candidate).rows]
        .filter(([k, row]) => prior.has(k) && prior.get(k) !== row)
        .map(([key]) => ({
          key,
          choice: "incoming",
          rationale: "Exact source correction with preserved higher queue",
        })),
      rationale: "Synthetic source review only",
    };
  });
  const job = g.study.roadmapReconciliations!.at(-1)!;
  assert.equal(job.state, "ready", job.error);
  const missingQueue = structuredClone(job);
  const header = missingQueue.proposal!.canonical.indexOf(
    "| Suspended state | Tier | Phase | Lap | Queue |",
  );
  const savedRow = missingQueue.proposal!.canonical.indexOf("\n| 1 |", header);
  assert.ok(savedRow > header);
  const rowEnd = missingQueue.proposal!.canonical.indexOf("\n", savedRow + 1);
  missingQueue.proposal!.canonical =
    missingQueue.proposal!.canonical.slice(0, savedRow) +
    missingQueue.proposal!.canonical.slice(rowEnd);
  missingQueue.proposalHash = await sha256(
    JSON.stringify(missingQueue.proposal),
  );
  await assert.rejects(
    compileRoadmapAdoption(r, l, missingQueue),
    /preserve.*suspended.*queue/i,
  );
  assert.deepEqual(g.study.learner, before);
  await adoptReconciledRoadmap(g, r, job.id);
  const adopted = g.study.learner!;
  assert.equal(adopted.tracks.PY.tier, 1);
  assert.ok(
    adopted.tracks.PY.suspended.some(
      (s) =>
        s.tier === 2 &&
        s.lap === oldQueue.lap &&
        JSON.stringify(s.queue) === JSON.stringify(oldQueue.queue),
    ),
  );
  assert.equal(
    adopted.attempts.find((a) => a.id === higherAttempt.id)!.status,
    "suspended",
  );
  assert.equal(eligibleLearning(r, adopted, at).depth, 1);
  assert.throws(
    () => beginLearningAttempt(r, adopted, higher!, at),
    /suspended/,
  );
  assert.deepEqual(higher, originalHigher);
  assert.deepEqual(adopted.evidence, before.evidence);
  assert.equal(adopted.cycle, before.cycle);
  const restored = recover(decode(encode(g)));
  assert.equal(
    restored.study.learner!.attempts.find((a) => a.id === higherAttempt.id)!
      .status,
    "suspended",
  );
  assert.deepEqual(
    restored.encounters[higher.id],
    JSON.parse(JSON.stringify(originalHigher)),
  );
  // Repair through the real scheduler and fresh synthetic observations. Never
  // restore the invalidated source score or transfer the higher private draft.
  const afterReload = restored.study.learner!;
  let repairs = 0;
  while (
    afterReload.attempts.find((a) => a.id === higherAttempt.id)!.status ===
      "suspended" &&
    repairs < 40
  ) {
    const c = eligibleLearning(r, afterReload, at);
    assert.equal(c.depth, 1);
    const repair = encounter(c, 1000 + repairs, restored);
    beginLearningAttempt(r, afterReload, repair, at);
    grade(repair, 1000 + repairs, restored);
    repairs++;
  }
  assert.ok(
    repairs > 0 && repairs < 40,
    "lower repair completes through scheduled visits",
  );
  assert.equal(
    afterReload.attempts.find((a) => a.id === higherAttempt.id)!.status,
    "in-progress",
  );
  assert.equal(afterReload.tracks.PY.tier, 2);
  assert.equal(afterReload.tracks.PY.lap, oldQueue.lap);
  assert.deepEqual(afterReload.tracks.PY.queue, oldQueue.queue);
  assert.deepEqual(
    restored.encounters[higher.id],
    JSON.parse(JSON.stringify(originalHigher)),
  );
  assert.equal(
    beginLearningAttempt(r, afterReload, restored.encounters[higher.id], at).id,
    higherAttempt.id,
  );
  for (const id of target.contract.objectiveIds)
    assert.equal(afterReload.cells[id].states[0], "P");
  assert.equal(
    afterReload.cycle,
    before.cycle + repairs,
    "only actual scheduled repair grades serve visits",
  );
  for (const ev of before.evidence.filter((ev) => ev.attemptId === target.id)) {
    assert.equal(
      independentProofValid(
        r,
        afterReload,
        ev.objectiveId,
        ev.depth,
        ev.facet,
        ev.id,
      ),
      false,
      "repair cannot reactivate withdrawn proof",
    );
    assert.ok(
      afterReload.evidence.some(
        (fresh) =>
          fresh.attemptId !== target.id &&
          fresh.objectiveId === ev.objectiveId &&
          fresh.depth === ev.depth &&
          fresh.facet === ev.facet &&
          independentProofValid(
            r,
            afterReload,
            fresh.objectiveId,
            fresh.depth,
            fresh.facet,
            fresh.id,
          ),
      ),
      "restored pass needs fresh valid evidence",
    );
  }
  const later = await prepareRoadmapExport(
    r,
    afterReload,
    restored.study.roadmapExport,
  );
  assert.equal(
    inspectMergedDocument(later.content).rows.get(key)!.split("|")[4].trim(),
    "INVALIDATED; source-backed scoring correction",
  );
  assert.ok(later.content.includes(decisionId));
  assert.equal(
    afterReload.attempts.find((a) => a.id === target.id)!.status,
    "served",
    "withdrawn certification retains actual historical visit",
  );
});
