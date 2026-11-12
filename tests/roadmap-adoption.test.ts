// Synthetic native-review fixtures only. No real learner source/progress is written.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { presentProblem } from "../src/ai";
import { evidencePacket } from "../src/curriculum";
import { groupSnapshot } from "../src/group-grounding";
import {
  applyLearningAssessment,
  beginLearningAttempt,
  eligibleLearning,
  registerScopes,
} from "../src/learner";
import type { Roadmap } from "../src/model";
import { npcWorkContext } from "../src/npc-cognition";
import { decode, encode, recover } from "../src/persistence";
import {
  adoptReconciledRoadmap,
  reconcileRoadmap,
  roadmapAdoptionBusy,
} from "../src/roadmap-adoption";
import type {
  RoadmapReconciliation,
  RoadmapReconciliationPayload,
} from "../src/roadmap-adoption-types";
import { prepareRoadmapExport, sha256 } from "../src/roadmap-export";
import { presentRoadmapReview } from "../src/roadmap-exposure";
import { createGame } from "../src/world";
const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
function fixture() {
  const g = createGame(7, r);
  g.study.profile = "live";
  g.status = "playing";
  g.zombies = [];
  g.nextSpawn = Number.MAX_SAFE_INTEGER;
  return { g, l: g.study.learner! };
}
function revision(raw: string, parent: string, n = 10) {
  return raw
    .replace(/^revision: \d+$/m, `revision: ${n}`)
    .replace(/^previous_revision: \d+$/m, `previous_revision: ${n - 1}`)
    .replace(/^parent_file_sha256: .+$/m, `parent_file_sha256: ${parent}`);
}
function candidate() {
  return revision(r.raw, r.sourceHash).replace(
    "| Learner | Mid-level",
    "| Learner | Updated administrative profile; Mid-level",
  );
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
      "Synthetic native review only; not genuine semantic certification",
  };
}
test("the reconcile instruction names the game's own evidence modes and incoming descendant records", async () => {
  const { g } = fixture();
  let instruction = "";
  await reconcileRoadmap(g, r, candidate(), async (p) => {
    instruction = p.instruction;
    return reply(p);
  });
  for (const mode of [
    "GAME_AI_ASSESSED_INDEPENDENT",
    "GAME_AI_ASSESSED_ASSISTED",
    "GAME_AI_ASSESSED_CONTRADICTED",
    "GAME_AI_ASSESSED_UNKNOWN",
  ])
    assert.ok(instruction.includes(mode), `instruction omits ${mode}`);
  assert.ok(
    instruction.includes("source records from the device that saved it"),
    "instruction does not treat incoming descendant records as source records",
  );
});
test("the reconcile instruction spells out the definitions and mappings shapes", async () => {
  const { g } = fixture();
  let instruction = "";
  await reconcileRoadmap(g, r, candidate(), async (p) => {
    instruction = p.instruction;
    return reply(p);
  });
  assert.ok(
    instruction.includes(
      "{id,objectiveId,depth,sourceScope,facets:[{id,description}]}",
    ),
    "instruction does not spell out the definitions entry shape",
  );
  assert.ok(
    instruction.includes(
      "{scopeId,facet,outcome,evidenceIds,sourceExcerpts,rationale}",
    ),
    "instruction does not spell out the mappings entry shape",
  );
});
test("visible roadmap material is private assistance at its actual presentation cutoff, never NPC context or human proof", () => {
  const { g, l } = fixture(),
    h = g.survivors[0],
    e = g.encounters["f0-room0"],
    station = g.floors[0].stations.find((s) => s.encounter === e.id)!;
  g.floors[0].furniture = [];
  g.floors[0].tiles = Array.from({ length: 34 }, () => Array(44).fill(0));
  Object.assign(h, { x: station.x, y: station.y, station: station.id });
  e.humanEngaged = true;
  e.problem = {
    title: "Synthetic open task",
    prompt: "Independent boundary check",
    starter: "",
    rubric: [],
    provenance: "study-mode",
    contract: eligibleLearning(r, l, "2026-10-16T16:00:00Z"),
  };
  const before = JSON.stringify(l),
    cutoff = g.seq,
    context = npcWorkContext(e);
  presentRoadmapReview(
    g,
    "review/proposal/summary",
    "PRIVATE_REVIEW_MATERIAL: a supplied boundary step",
  );
  const source = e.history.at(-1)!;
  assert.equal(source.kind, "source-view");
  assert.equal(source.author, "roadmap");
  assert.equal(source.presented, source.seq);
  assert.equal(evidencePacket(e, r, cutoff).assistanceSources.length, 0);
  const packet = evidencePacket(e, r);
  assert.ok(
    packet.assistanceSources.some(
      (s) =>
        s.text.includes("PRIVATE_REVIEW_MATERIAL") &&
        s.provenance === "visible-private-roadmap-review",
    ),
  );
  assert.equal(
    JSON.stringify(groupSnapshot(e, "public", g.seq)).includes(
      "PRIVATE_REVIEW_MATERIAL",
    ),
    false,
  );
  assert.equal(npcWorkContext(e), context);
  assert.equal(JSON.stringify(l), before);
  assert.equal(g.study.visits.length, 0);
  const count = e.history.length;
  presentRoadmapReview(
    g,
    "review/proposal/summary",
    "PRIVATE_REVIEW_MATERIAL: a supplied boundary step",
  );
  assert.equal(e.history.length, count);
  const restored = recover(decode(encode(g)));
  presentRoadmapReview(
    restored,
    "review/proposal/summary",
    "PRIVATE_REVIEW_MATERIAL: a supplied boundary step",
  );
  assert.equal(restored.encounters[e.id].history.length, count);
});
test("roadmap inspection away from an active reachable question creates no assistance exposure or study attempt", () => {
  const { g, l } = fixture(),
    before = JSON.stringify(l);
  presentRoadmapReview(g, "review/away", "Administrative file inspection");
  assert.equal(Object.values(g.encounters).flatMap((e) => e.history).length, 0);
  assert.equal(JSON.stringify(l), before);
  assert.equal(g.study.visits.length, 0);
});
test("source review after leaving a retained question still records private assistance without changing archived or unobserved tasks", () => {
  const { g, l } = fixture(),
    e = g.encounters["f0-room0"];
  e.problem = {
    title: "Synthetic previously viewed task",
    prompt: "Retained question",
    starter: "",
    rubric: [],
    provenance: "study-mode",
    contract: eligibleLearning(r, l, "2026-10-16T16:00:00Z"),
  };
  presentProblem(g, e);
  const before = JSON.stringify(l),
    publicBefore = npcWorkContext(e);
  const unobserved = g.encounters["f0-room1"];
  unobserved.problem = structuredClone(e.problem);
  const archived = structuredClone(e);
  archived.runId = "old-frozen-run";
  g.study.archives.push(archived);
  const archiveBefore = JSON.stringify(archived),
    cutoff = g.seq;
  g.survivors[0].station = undefined;
  presentRoadmapReview(
    g,
    "detached/progress/diff",
    "PRIVATE_SOURCE_AFTER_LEAVING: retained boundary explanation",
  );
  assert.ok(
    evidencePacket(e, r).assistanceSources.some((s) =>
      s.text.includes("PRIVATE_SOURCE_AFTER_LEAVING"),
    ),
  );
  assert.equal(
    evidencePacket(e, r, cutoff).assistanceSources.some((s) =>
      s.text.includes("PRIVATE_SOURCE_AFTER_LEAVING"),
    ),
    false,
  );
  assert.equal(
    JSON.stringify(groupSnapshot(e, "public", g.seq)).includes(
      "PRIVATE_SOURCE_AFTER_LEAVING",
    ),
    false,
  );
  assert.equal(npcWorkContext(e), publicBefore);
  assert.equal(unobserved.history.length, 0);
  assert.equal(JSON.stringify(archived), archiveBefore);
  assert.equal(JSON.stringify(l), before);
});
test("explicit adoption publishes the reviewed complete parent atomically without replacing world/work or creating study activity", async () => {
  const { g, l } = fixture(),
    world = JSON.stringify(g.floors),
    encounters = JSON.stringify(g.encounters),
    sessions = JSON.stringify(l.sessions),
    incoming = candidate();
  await reconcileRoadmap(g, r, incoming, async (p) => reply(p));
  const j = g.study.roadmapReconciliations![0];
  assert.equal(j.state, "ready", j.error);
  assert.equal(g.study.learner, l);
  assert.equal(g.study.roadmapExport, undefined);
  await adoptReconciledRoadmap(g, r, j.id);
  assert.equal(j.state, "applied");
  assert.equal(g.study.roadmapExport!.content, incoming);
  assert.equal(JSON.stringify(g.floors), world);
  assert.equal(JSON.stringify(g.encounters), encounters);
  assert.equal(JSON.stringify(g.study.learner!.sessions), sessions);
  assert.equal(g.study.learner!.attempts.length, 0);
  assert.equal(g.study.learner!.evidence.length, 0);
  assert.equal(g.study.visits.length, 0);
  assert.equal(
    g.study.roadmapAdoptionBackups![0].ledger.sourceHash,
    r.sourceHash,
  );
  assert.equal(
    (await prepareRoadmapExport(r, g.study.learner!, g.study.roadmapExport))
      .content,
    incoming,
  );
  const restored = recover(decode(encode(g)));
  assert.equal(
    (
      await prepareRoadmapExport(
        r,
        restored.study.learner!,
        restored.study.roadmapExport,
      )
    ).content,
    incoming,
  );
});
test("review is coalesced and a failed request requires explicit retry of the exact normalized snapshot after reload", async () => {
  const { g } = fixture();
  let captured: any,
    calls = 0;
  const first = reconcileRoadmap(g, r, candidate(), async (p) => {
    captured = p;
    calls++;
    throw Error("offline");
  });
  assert.equal(
    reconcileRoadmap(g, r, candidate(), async () => {}),
    first,
  );
  await first;
  const j = g.study.roadmapReconciliations![0];
  assert.equal(j.state, "error");
  await reconcileRoadmap(g, r, candidate(), async () => {
    throw Error("must not reroll");
  });
  assert.equal(calls, 1);
  j.state = "pending";
  const restored = recover(decode(encode(g)));
  assert.equal(restored.study.roadmapReconciliations![0].state, "interrupted");
  await reconcileRoadmap(
    restored,
    r,
    "ignored retry input",
    async (p) => {
      assert.deepEqual(p, captured);
      calls++;
      return reply(p);
    },
    j.id,
  );
  assert.equal(calls, 2);
  assert.equal(restored.study.roadmapReconciliations![0].state, "ready");
});
test("ChatGPT roadmap review preserves provider and exact payload through outage, reload, retry and explicit adoption", async () => {
  const { g } = fixture();
  let captured!: RoadmapReconciliationPayload;
  await reconcileRoadmap(
    g,
    r,
    candidate(),
    async (p) => {
      captured = p;
      throw Error("synthetic outage");
    },
    undefined,
    "chatgpt-handoff",
  );
  const restored = recover(decode(encode(g))),
    job = restored.study.roadmapReconciliations![0];
  assert.equal(captured.provider, "chatgpt-handoff");
  let calls = 0;
  await reconcileRoadmap(
    restored,
    r,
    candidate(),
    async () => {
      calls++;
    },
    job.id,
    "study-mode",
  );
  assert.equal(calls, 0);
  assert.match(job.error!, /original roadmap review provider/);
  await reconcileRoadmap(
    restored,
    r,
    "ignored input",
    async (p) => {
      calls++;
      assert.deepEqual(p, captured);
      return reply(p);
    },
    job.id,
    "chatgpt-handoff",
  );
  assert.equal(calls, 1);
  assert.equal(job.state, "ready", job.error);
  assert.equal(restored.study.learner!.roadmapAdoptions?.length ?? 0, 0);
  await adoptReconciledRoadmap(restored, r, job.id);
  assert.equal(
    restored.study.learner!.roadmapAdoptions!.at(-1)!.provenance,
    "chatgpt-handoff",
  );
  assert.equal(restored.study.visits.length, 0);
});
test("saved provider identity is hashed while legacy reviews retain native provenance", async () => {
  const { g } = fixture();
  await reconcileRoadmap(
    g,
    r,
    candidate(),
    async (p) => reply(p),
    undefined,
    "chatgpt-handoff",
  );
  const job = g.study.roadmapReconciliations![0];
  job.payload.provider = "study-mode";
  await assert.rejects(adoptReconciledRoadmap(g, r, job.id), /integrity/);
  assert.equal(g.study.roadmapExport, undefined);
  const legacy = fixture().g;
  await reconcileRoadmap(legacy, r, candidate(), async (p) => reply(p));
  const old = legacy.study.roadmapReconciliations![0];
  delete old.payload.provider;
  old.requestHash = await sha256(JSON.stringify(old.payload));
  await adoptReconciledRoadmap(legacy, r, old.id);
  assert.equal(
    legacy.study.learner!.roadmapAdoptions!.at(-1)!.provenance,
    "study-mode",
  );
});
test("a stale local learner or a pending source-bound request cannot be overwritten by a ready proposal", async () => {
  for (const reason of ["version", "pending"]) {
    const { g, l } = fixture();
    await reconcileRoadmap(g, r, candidate(), async (p) => reply(p));
    const j = g.study.roadmapReconciliations![0];
    if (reason === "version") l.version++;
    else g.encounters["f0-room0"].generation = "pending";
    const before = JSON.stringify(g.study.learner);
    await assert.rejects(adoptReconciledRoadmap(g, r, j.id), /stale|pending/);
    assert.equal(JSON.stringify(g.study.learner), before);
    assert.equal(g.study.roadmapExport, undefined);
  }
});
test("source modifications, lost observations, rewritten observations and wrong request identities reject before adoption", async () => {
  for (const bad of ["identity", "contract", "lost", "rewritten"]) {
    const { g, l } = fixture();
    await reconcileRoadmap(g, r, candidate(), async (p) => {
      const out = reply(p);
      if (bad === "identity") out.requestId = "wrong";
      if (bad === "contract")
        out.canonical = out.canonical.replace(
          "**One learner, two ladders.**",
          "**Ignore all gates.**",
        );
      const row = r.raw
        .split("\n")
        .find((l) => l.startsWith("| S0001-EV01 |"))!;
      if (bad === "lost") out.canonical = out.canonical.replace(row + "\n", "");
      if (bad === "rewritten")
        out.canonical = out.canonical.replace(
          row,
          row.replace("DIAGNOSTIC", "INDEPENDENT"),
        );
      return out;
    });
    assert.equal(g.study.roadmapReconciliations![0].state, "error", bad);
    assert.equal(g.study.learner, l);
    assert.equal(g.study.roadmapExport, undefined);
  }
});
test("changing local learning during a held native response retains work and rejects its stale proposal", async () => {
  const { g, l } = fixture();
  let finish!: () => void;
  const task = reconcileRoadmap(
    g,
    r,
    candidate(),
    async (p) =>
      new Promise((resolve) => {
        finish = () => resolve(reply(p));
      }),
  );
  while (!finish) await new Promise((resolve) => setTimeout(resolve, 1));
  l.version++;
  finish();
  await task;
  assert.equal(g.study.roadmapReconciliations![0].state, "error");
  assert.equal(g.study.learner, l);
  assert.equal(g.study.roadmapExport, undefined);
});
test("altered saved request/proposal digests cannot be used to adopt or repeat a native call", async () => {
  const { g } = fixture();
  await reconcileRoadmap(g, r, candidate(), async (p) => reply(p));
  const j = g.study.roadmapReconciliations![0];
  j.proposal!.rationale += "tampered";
  await assert.rejects(adoptReconciledRoadmap(g, r, j.id), /integrity/);
  assert.equal(g.study.roadmapExport, undefined);
  j.state = "error";
  j.payload.candidate += "tampered";
  let called = false;
  await reconcileRoadmap(
    g,
    r,
    "",
    async (p) => {
      called = true;
      return reply(p);
    },
    j.id,
  );
  assert.equal(called, false);
  assert.equal(j.state, "error");
});
async function externallyAssessedFile() {
  const { g, l } = fixture();
  let n = 0;
  for (let i = 0; i < 3; i++) {
    const e = Object.values(g.encounters)[n++],
      c = eligibleLearning(r, l, "2026-10-16T16:00:00Z");
    e.problem = {
      title: "Synthetic external study",
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
        text: "Synthetic external human contribution",
        at: 0,
        revision: 0,
        wallTime: "2026-10-16T16:00:00Z",
      },
    ];
    registerScopes(r, l, e);
    beginLearningAttempt(r, l, e, "2026-10-16T16:00:00Z");
    applyLearningAssessment(
      r,
      l,
      e,
      {
        id: `synthetic-external-${i}`,
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
      "2026-10-16T16:00:00Z",
      "study-mode",
    );
  }
  const file = await prepareRoadmapExport(r, l);
  const make = (p: RoadmapReconciliationPayload): RoadmapReconciliation => {
    const definitions = Object.values(l.scopes),
      mappings = l.evidence.map((ev) => {
        const row = file.content
            .split("\n")
            .find((line) => line.startsWith(`| ${ev.id} |`))!,
          c = row
            .split("|")
            .slice(1, -1)
            .map((v) => v.trim());
        return {
          scopeId: `${ev.objectiveId}/D${ev.depth}`,
          facet: ev.facet,
          outcome: "independent" as const,
          evidenceIds: [ev.id],
          sourceExcerpts: { [ev.id]: c[8] },
          rationale:
            "Synthetic source correspondence; not actual human certification",
        };
      });
    return {
      ...reply(p),
      canonical: file.content,
      definitions,
      mappings,
      completeScopes: l.verifiedScopes,
    };
  };
  return { file, l, make };
}
for (const provider of ["study-mode", "chatgpt-handoff"] as const)
  test(`new imported checkpoint proof through ${provider} is source-bound, preserves original IDs, survives reload, and becomes the next export parent`, async () => {
    const external = await externallyAssessedFile(),
      { g } = fixture();
    assert.equal(external.l.cells["PE:X09.1"].states[0], "P");
    await reconcileRoadmap(
      g,
      r,
      external.file.content,
      async (p) => external.make(p),
      undefined,
      provider,
    );
    const job = g.study.roadmapReconciliations![0];
    assert.equal(job.state, "ready", job.error);
    await adoptReconciledRoadmap(g, r, job.id);
    const l = g.study.learner!;
    assert.equal(l.cells["PE:X09.1"].states[0], "P");
    assert.equal(l.evidence.length, 0);
    assert.equal(l.attempts.length, 0);
    assert.equal(l.sessions.at(-1)!.id, "S0008");
    assert.equal(l.currentSession, undefined);
    assert.equal(l.reviews["PE:X09.1/D1"].due, "2026-10-19");
    const restored = recover(decode(encode(g))),
      ledger = restored.study.learner!,
      e = restored.encounters["f0-room0"],
      c = eligibleLearning(r, ledger, "2026-10-16T16:00:00Z");
    e.problem = {
      title: "Synthetic new actual game study",
      prompt: "Fixture",
      rubric: [],
      starter: "",
      provenance: "study-mode",
      contract: c,
    };
    beginLearningAttempt(r, ledger, e, "2026-10-16T16:00:00Z");
    assert.equal(ledger.currentSession, "S0009");
    assert.equal(ledger.attempts[0].id, "S0009-A01");
    const next = await prepareRoadmapExport(
      r,
      ledger,
      restored.study.roadmapExport,
    );
    assert.equal(next.parentHash, external.file.hash);
    assert.equal(next.revision, 11);
    assert.ok(next.content.includes(external.l.evidence.at(-1)!.id));
    assert.match(next.content, /\| X09.1 \| D3 \| P \|/);
    const lastPrimary = (raw: string) =>
      raw
        .split("\n")
        .find((line) =>
          line.startsWith("| Track served by the last primary visit |"),
        );
    assert.equal(lastPrimary(next.content), lastPrimary(external.file.content));
    assert.equal(
      g.study.roadmapExport!.gapIds["PE:X09.1/D1"],
      external.file.gapIds["PE:X09.1/D1"],
    );
    assert.equal(
      next.gapIds["PE:X09.1/D1"],
      external.file.gapIds["PE:X09.1/D1"],
    );
  });
test("guided, missing-scope and fabricated imported passes cannot be promoted by native prose or score alone", async () => {
  const external = await externallyAssessedFile();
  for (const bad of [
    "guided",
    "mixed-low-score",
    "mixed-guided",
    "mixed-valid",
    "invalidated",
    "facet",
    "coverage",
    "excerpt",
    "fabricated",
  ]) {
    const { g, l } = fixture();
    let incoming = external.file.content;
    if (
      ["guided", "mixed-low-score", "mixed-guided", "mixed-valid"].includes(bad)
    ) {
      const row = incoming
        .split("\n")
        .find((line) => line.startsWith("| S0008-EV03 |"))!;
      let changed = row.replace(
        "| NONE FOR THIS FACET |",
        bad === "guided" ? "| ASSISTED |" : "| MIXED |",
      );
      if (bad.startsWith("mixed"))
        changed = changed.replace(
          "independent; artifact",
          "independently demonstrated; artifact",
        );
      if (bad === "mixed-low-score")
        changed = changed.replace(
          "| 2 (facet only; full scope requires 0.12 coverage) |",
          "| 1 | ",
        );
      if (bad === "mixed-guided")
        changed = changed.replace("GAME_AI_ASSESSED_INDEPENDENT", "GUIDED");
      incoming = incoming.replace(row, changed);
    }
    if (bad === "invalidated") {
      const row = incoming
        .split("\n")
        .find((line) => line.startsWith("| S0008-A03 |"))!;
      const c = row
        .split("|")
        .slice(1, -1)
        .map((s) => s.trim());
      c[3] = "INVALIDATED; entire assessment contract withdrawn";
      incoming = incoming.replace(row, `| ${c.join(" | ")} |`);
    }
    await reconcileRoadmap(g, r, incoming, async (p) => {
      const out = external.make(p);
      out.canonical = p.candidate;
      const target = out.mappings.find((m) => m.scopeId === "PE:X09.1/D1")!;
      if (bad.startsWith("mixed"))
        target.sourceExcerpts[target.evidenceIds[0]] = p.candidate
          .split("\n")
          .find((line) => line.startsWith("| S0008-EV03 |"))!
          .split("|")
          .slice(1, -1)
          .map((s) => s.trim())[8];
      if (bad === "facet") {
        target.facet = "unobserved-facet";
        out.definitions.find((d) => d.id === target.scopeId)!.facets = [
          { id: target.facet, description: "Synthetic different component" },
        ];
      }
      if (bad === "coverage") out.completeScopes = [];
      if (bad === "excerpt")
        target.sourceExcerpts[target.evidenceIds[0]] =
          "Invented evidence quote";
      if (bad === "fabricated") {
        const row = out.canonical
          .split("\n")
          .find((line) => line.startsWith("| S0008-EV03 |"))!;
        out.canonical = out.canonical.replace(
          row,
          row.replaceAll("S0008-EV03", "S0008-EV99"),
        );
        target.evidenceIds = ["S0008-EV99"];
        target.sourceExcerpts = {
          "S0008-EV99": Object.values(target.sourceExcerpts)[0],
        };
      }
      return out;
    });
    if (bad === "mixed-valid") {
      const job = g.study.roadmapReconciliations![0];
      assert.equal(job.state, "ready", job.error);
      await adoptReconciledRoadmap(g, r, job.id);
      assert.equal(g.study.learner!.cells["PE:X09.1"].states[0], "P");
      continue;
    }
    assert.equal(
      g.study.roadmapReconciliations![0].state,
      "error",
      `${bad}: ${g.study.roadmapReconciliations![0].error}`,
    );
    assert.equal(g.study.learner, l);
    assert.equal(l.cells["PE:X09.1"].states[0], "U");
    if (["guided", "mixed-low-score", "mixed-guided"].includes(bad))
      assert.match(
        g.study.roadmapReconciliations![0].error!,
        /Assisted source work/,
      );
    if (bad === "facet")
      assert.match(g.study.roadmapReconciliations![0].error!, /named facet/);
    if (bad === "invalidated")
      assert.match(
        g.study.roadmapReconciliations![0].error!,
        /non-invalidated/,
      );
  }
});
/** Exact line edits turning `local` into `target`; the synthetic fixtures only
 * rewrite lines in place, so each changed line is one unambiguous find. */
function lineEdits(local: string, target: string) {
  const from = local.split("\n"),
    to = target.split("\n");
  assert.equal(
    from.length,
    to.length,
    "synthetic proposal only rewrites existing lines",
  );
  return from
    .map((line, index) => ({ find: line, replace: to[index] }))
    .filter((edit) => edit.find !== edit.replace);
}
test("an edits reply becomes the complete proposed file without the model writing it", async () => {
  const { g } = fixture(),
    incoming = candidate();
  let local!: string,
    edits: { find: string; replace: string }[] = [];
  await reconcileRoadmap(g, r, incoming, async (p) => {
    local = p.local;
    edits = lineEdits(p.local, incoming);
    return {
      requestId: p.requestId,
      localHash: p.localHash,
      candidateHash: p.candidateHash,
      edits,
      definitions: [],
      mappings: [],
      completeScopes: [],
      decisions: [],
      rationale:
        "Synthetic native review only; not genuine semantic certification",
    };
  });
  const j = g.study.roadmapReconciliations![0];
  assert.equal(j.state, "ready", j.error);
  assert.equal(edits.length, 4);
  assert.notEqual(local, incoming);
  assert.equal(j.proposal!.canonical, incoming);
  assert.equal("edits" in j.proposal!, false);
  assert.equal(g.study.learner!.roadmapAdoptions?.length ?? 0, 0);
});
test("a keep-local reply keeps the local roadmap and offers nothing to adopt", async () => {
  const { g, l } = fixture(),
    before = JSON.stringify(l),
    decisions = [
      {
        key: "revision",
        choice: "local" as const,
        rationale: "The incoming revision belongs to another learner",
      },
    ];
  await reconcileRoadmap(g, r, candidate(), async (p) => ({
    requestId: p.requestId,
    localHash: p.localHash,
    candidateHash: p.candidateHash,
    outcome: "keep-local" as const,
    decisions,
    rationale: "The incoming file is not this learner's progress",
  }));
  const j = g.study.roadmapReconciliations![0];
  assert.equal(j.state, "kept-local", j.error);
  assert.equal(
    j.keepLocal!.rationale,
    "The incoming file is not this learner's progress",
  );
  assert.deepEqual(j.keepLocal!.decisions, decisions);
  assert.equal(j.proposal, undefined);
  assert.equal(j.proposalHash, undefined);
  assert.equal(g.study.learner, l);
  assert.equal(JSON.stringify(l), before);
  assert.equal(g.study.roadmapExport, undefined);
  assert.equal(roadmapAdoptionBusy(g), false);
  await assert.rejects(
    adoptReconciledRoadmap(g, r, j.id),
    /ready roadmap reconciliation/,
  );
  assert.equal(j.state, "kept-local");
  assert.equal(JSON.stringify(l), before);
});
