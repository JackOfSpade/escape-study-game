// Controlled native-grade fixture; no actual learner or external service is certified.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { independentProofValid } from "../src/historical-proof";
import {
  applyLearningAssessment,
  beginLearningAttempt,
  eligibleLearning,
  encounterKey,
  registerScopes,
} from "../src/learner";
import type { Roadmap } from "../src/model";
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
for (const outcome of ["independent", "assisted", "contradicted"] as const)
  for (const seekBaselineGap of [false, true])
    test(`a reviewed correction of an actual ${outcome} served attempt preserves history, corrected projection and baseline gap=${seekBaselineGap}`, async () => {
      const g = createRecord(7, r);
      g.study.profile = "live";
      const l = g.study.learner!;
      let e = g.encounters["question-0"],
        c = eligibleLearning(r, l, "2026-10-16T16:00:00Z"),
        attempt: ReturnType<typeof beginLearningAttempt> | undefined;
      // Honor actual due-review scheduling first; then correct a newly served
      // ordinary scope. Baseline review retraction needs a separate gate audit.
      for (let i = 0; i < 8; i++) {
        e = Object.values(g.encounters)[i];
        c = eligibleLearning(r, l, "2026-10-16T16:00:00Z");
        e.problem = {
          title: "Synthetic graded app study",
          prompt: "Synthetic source scope only",
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
                description:
                  "Synthetic independently reviewed complete source scope",
              },
            ],
          })),
        };
        e.workspace = "Saved workspace draft and prior task remain preserved";
        e.history = [
          {
            seq: 1,
            author: "human",
            kind: "reasoning",
            text: "Synthetic human explanation for controlled native-grade fixture",
            at: 0,
            revision: 0,
            wallTime: "2026-10-16T16:00:00Z",
          },
        ];
        registerScopes(r, l, e);
        attempt = beginLearningAttempt(r, l, e, "2026-10-16T16:00:00Z");
        const isTarget =
          !c.review &&
          (!seekBaselineGap ||
            c.objectiveIds.some(
              (id) =>
                r.tracks[c.track].objectives.find((o) => o.id === id)!.cells[
                  c.depth - 1
                ] === "G",
            ));
        const actualOutcome = isTarget ? outcome : "independent";
        applyLearningAssessment(
          r,
          l,
          e,
          {
            id: `synthetic-grade-${i}`,
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
              outcome: actualOutcome,
              evidence: [1],
              completeCheckpointScope: false,
              rationale: "Synthetic native grade only",
            })),
          },
          "2026-10-16T16:00:00Z",
          "study-mode",
        );
        const issuedId = attempt.id;
        attempt = l.attempts.find((a) => a.id === issuedId)!;
        assert.equal(attempt.status, "served");
        if (
          !c.review &&
          (!seekBaselineGap ||
            c.objectiveIds.some(
              (id) =>
                r.tracks[c.track].objectives.find((o) => o.id === id)!.cells[
                  c.depth - 1
                ] === "G",
            ))
        )
          break;
      }
      assert.ok(attempt);
      assert.equal(
        c.review,
        false,
        "ordinary scope reached without bypassing due reviews",
      );

      if (seekBaselineGap)
        assert.ok(
          c.objectiveIds.some(
            (id) =>
              r.tracks[c.track].objectives.find((o) => o.id === id)!.cells[
                c.depth - 1
              ] === "G",
          ),
        );
      for (const id of c.objectiveIds)
        assert.equal(l.cells[id].facets[`D${c.depth}:scope`].outcome, outcome);
      const file = await prepareRoadmapExport(r, l);
      g.study.roadmapExport = file;
      const external = structuredClone(l);
      for (const id of c.objectiveIds) {
        const original = r.tracks[c.track].objectives.find((o) => o.id === id)!;
        external.cells[id].states[c.depth - 1] = original.cells[c.depth - 1] as
          "G" | "U";
        external.cells[id].facets[`D${c.depth}:scope`].outcome = "unknown";
      }
      let raw = (await prepareRoadmapExport(r, external, file)).content;
      const key = [...inspectMergedDocument(raw).rows.keys()].find(
        (k) =>
          k.startsWith(`${c.track}_PROGRESS/0.5.1 Attempt status register/`) &&
          k.endsWith("/" + attempt.id),
      )!;
      const row = inspectMergedDocument(raw).rows.get(key)!,
        cells = row
          .split("|")
          .slice(1, -1)
          .map((c) => c.trim());
      cells[3] =
        "INVALIDATED; source-backed scoring correction, no learner failure";
      const corrected = `| ${cells.join(" | ")} |`;
      raw = raw.replace(row, corrected);
      const number = readIdentifierCounters(raw, false).counters.nextDecision,
        decisionId = `DEC${String(number).padStart(4, "0")}`;
      const excerpt =
        "A controlled source audit found supplied reasoning in this task; withdraw its score without creating learner failure or erasing the actual visit.";
      const decision = `| ${decisionId} | 2026-10-17 / source audit | ASSESSMENT_CORRECTION | ${c.track}:${attempt.id} | ${excerpt} | Persistent source interpretation | ACTIVE |`;
      const where = raw.indexOf("### S0.4 Merged session history");
      raw =
        raw.slice(0, where).trimEnd() +
        "\n" +
        decision +
        "\n\n" +
        raw.slice(where);
      raw = projectIdentifierCounters(
        raw,
        readIdentifierCounters(raw, false).counters,
      );
      const before = structuredClone(l),
        encounter = structuredClone(e);
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
              track: c.track,
              attemptId: attempt.id,
              rationale: "Controlled source-backed terminal invalidation",
              correctionDecision: { id: decisionId, excerpt },
            },
          ],
          decisions: [...inspectMergedDocument(p.candidate).rows]
            .filter(([k, row]) => prior.has(k) && prior.get(k) !== row)
            .map(([key]) => ({
              key,
              choice: "incoming" as const,
              rationale:
                "Use the exact reviewed source correction and derived progress state",
            })),
          rationale:
            "Synthetic correction of actual persisted app-assessment structure, not real human learning",
        };
      });
      const job = g.study.roadmapReconciliations!.at(-1)!;
      assert.equal(job.state, "ready", job.error);
      await adoptReconciledRoadmap(g, r, job.id);
      assert.equal(g.study.learner!.cycle, before.cycle);
      assert.deepEqual(g.study.learner!.attempts, before.attempts);
      assert.deepEqual(g.study.learner!.evidence, before.evidence);
      assert.deepEqual(g.encounters[e.id], encounter);
      for (const ev of before.evidence)
        assert.equal(
          independentProofValid(
            r,
            g.study.learner!,
            ev.objectiveId,
            ev.depth,
            ev.facet,
            ev.id,
          ),
          ev.attemptId !== attempt.id,
        );
      for (const id of c.objectiveIds)
        assert.equal(
          g.study.learner!.cells[id].states[c.depth - 1],
          external.cells[id].states[c.depth - 1],
        );
      const copy = recover(decode(encode(g))),
        next = Object.values(copy.encounters).find(
          (q) =>
            !copy.study.learner!.attempts.some(
              (a) => a.encounter === encounterKey(q),
            ),
        )!;
      next.problem = {
        title: "Later synthetic study",
        prompt: "Continue eligible scope",
        starter: "",
        rubric: [],
        provenance: "study-mode",
        contract: eligibleLearning(
          r,
          copy.study.learner!,
          "2026-10-17T12:00:00Z",
        ),
      };
      beginLearningAttempt(
        r,
        copy.study.learner!,
        next,
        "2026-10-17T12:00:00Z",
      );
      const exported = await prepareRoadmapExport(
        r,
        copy.study.learner!,
        copy.study.roadmapExport,
      );
      assert.notEqual(exported.content, job.proposal!.canonical);
      assert.equal(
        inspectMergedDocument(exported.content).rows.get(key),
        corrected,
      );
      assert.ok(exported.content.includes(decision));
      assert.equal(copy.study.learner!.cycle, before.cycle);
      const scopeId = `${c.objectiveIds[0]}/D${c.depth}`,
        projectionId = copy.study.roadmapExport!.gapIds[scopeId];
      assert.ok(projectionId);
      const projected = [...inspectMergedDocument(exported.content).rows].find(
        ([k]) =>
          k.includes("/0.6 Facet gaps, unknowns, and dependencies/") &&
          k.endsWith("/" + projectionId),
      )!;
      assert.equal(projected[1].split("|")[3].trim(), "SEMANTIC_FACET_SCOPE");
      if (seekBaselineGap) {
        const historical = [...inspectMergedDocument(r.raw).rows].filter(
          ([k, row]) =>
            k.startsWith(
              `${c.track}_PROGRESS/0.6 Facet gaps, unknowns, and dependencies/`,
            ) &&
            row.split("|")[2]?.trim() ===
              `${c.objectiveIds[0].split(":")[1]} / D${c.depth}`,
        );
        assert.ok(historical.length > 0);
        for (const [key, row] of historical) {
          const retained = inspectMergedDocument(exported.content).rows.get(
            key,
          )!;
          assert.ok(retained);
          assert.deepEqual(
            retained.split("|").slice(1, 6),
            row.split("|").slice(1, 6),
          );
          assert.notEqual(row.split("|")[1].trim(), projectionId);
        }
        copy.study.roadmapExport = exported;
        const removed = exported.content
          .replace(/^revision: \d+$/m, `revision: ${exported.revision + 1}`)
          .replace(
            /^previous_revision: \d+$/m,
            `previous_revision: ${exported.revision}`,
          )
          .replace(
            /^parent_file_sha256: .+$/m,
            `parent_file_sha256: ${exported.hash}`,
          )
          .replace(projected[1], "");
        await reconcileRoadmap(copy, r, removed, async (p) => ({
          requestId: p.requestId,
          localHash: p.localHash,
          candidateHash: p.candidateHash,
          canonical: p.candidate,
          definitions: [],
          mappings: [],
          completeScopes: [],
          decisions: [],
          rationale: "Synthetic attempted projection deletion",
        }));
        const rejected = copy.study.roadmapReconciliations!.at(-1)!;
        assert.equal(rejected.state, "error");
        assert.match(rejected.error!, /semantic facet gap record/);
      }
    });
