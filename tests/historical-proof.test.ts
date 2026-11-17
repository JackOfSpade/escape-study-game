import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  historicalProofValid,
  historicalRecords,
} from "../src/historical-proof";
import {
  applyLearningAssessment,
  beginLearningAttempt,
  eligibleLearning,
  initialLearner,
  interruptLearningAttempt,
  registerScopes,
} from "../src/learner";
import type { Assessment, Roadmap } from "../src/model";
import { decode, encode } from "../src/persistence";
import { prepareRoadmapExport } from "../src/roadmap-export";
import { createGame } from "./helpers/record";

const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
const at = "2026-10-16T16:00:00.000Z";
function fixture(id = "PY:T07.1", mode: "test" | "live" = "test") {
  const l = initialLearner(r, mode),
    g = createGame(7, r);
  const track = id.startsWith("PY:") ? "PY" : "PE",
    topic = id.split(":")[1].split(".")[0];
  const priorReview = l.reviews[`${id}/D1`];
  l.reviews = {};
  const objective = r.tracks[track].objectives.find((o) => o.id === id)!;
  if (objective.cells[0] === "P") l.reviews[`${id}/D1`] = priorReview;
  for (const o of r.tracks[track].objectives)
    if (o.id.startsWith(`${track}:${topic}.`) && o.id < id)
      l.cells[o.id].states[0] = "P";
  l.tracks[track].queue = [topic];
  l.cycle = track === "PY" ? 0 : 1;
  let serial = 0;
  const issue = () => {
    const c = eligibleLearning(r, l, at),
      e = structuredClone(g.encounters["question-0"]);
    e.id = `historical-${++serial}`;
    assert.deepEqual(c.objectiveIds, [id]);
    e.problem = {
      title: "Synthetic reconciliation task",
      prompt: "Synthetic task only",
      starter: "",
      rubric: ["scope"],
      provenance: "study-mode",
      contract: c,
      scopeDefinitions: [
        {
          id: `${id}/D1`,
          objectiveId: id,
          depth: 1,
          sourceScope: objective.scope,
          facets: [
            {
              id: "known",
              description:
                "Preserve the already-observed narrow reasoning facet",
            },
            {
              id: "remaining",
              description:
                "Independently explain the remaining relevant boundary",
            },
          ],
        },
      ],
    };
    e.history = [
      {
        seq: 1,
        author: "human",
        kind: "reasoning",
        text: "Synthetic current reasoning; not actual user evidence",
        revision: 0,
        at: 0,
        wallTime: at,
      },
    ];
    registerScopes(r, l, e);
    beginLearningAttempt(r, l, e, at);
    return e;
  };
  const proposal = (
    e: ReturnType<typeof issue>,
    ref = "S0006-EV16",
    fresh = true,
  ): Assessment => ({
    id: `review-${serial}-${l.version}`,
    encounter: e.id,
    sourceVersion: l.version,
    provenance: mode === "test" ? "test-fixture" : "study-mode",
    status: "pending",
    visitOutcome: fresh ? "usable" : "unresolved",
    scopeReviews: [
      {
        id: `${id}/D1`,
        completeCoverage: fresh,
        rationale:
          "Synthetic semantic coverage review, not real native verification",
      },
    ],
    historicalMappings: [
      {
        scopeId: `${id}/D1`,
        facet: "known",
        sourceHash: r.sourceHash,
        evidenceIds: [ref],
        outcome: "independent",
        rationale:
          "Synthetic explicit equivalence of the original narrow observation and stable facet",
      },
    ],
    findings: fresh
      ? [
          {
            objectiveId: id,
            facet: "remaining",
            depth: 1,
            outcome: "independent",
            evidence: [1],
            completeCheckpointScope: false,
            rationale: "Synthetic current boundary observation",
          },
        ]
      : [],
  });
  const apply = (e: ReturnType<typeof issue>, a: Assessment) =>
    applyLearningAssessment(
      r,
      l,
      e,
      a,
      at,
      mode === "test" ? "test-fixture" : "study-mode",
    );
  return { l, g, issue, proposal, apply };
}

test("reviewed historical partial proof complements fresh missing scope without copying old observation IDs", () => {
  const f = fixture(),
    e = f.issue();
  assert.equal(f.l.historicalReviews, undefined);
  const a = f.proposal(e);
  f.apply(e, a);
  assert.equal(f.l.cells["PY:T07.1"].states[0], "P");
  assert.deepEqual(f.l.cells["PY:T07.1"].facets["D1:known"].evidenceIds, [
    "S0006-EV16",
  ]);
  assert.equal(f.l.evidence.length, 1);
  assert.equal(f.l.evidence[0].id, "S0008-EV01");
  assert.ok(f.l.cells["PY:T07.1"].proofs["1"].includes("S0006-EV16"));
  assert.equal(f.l.reviews["PY:T07.1/D1"].lastIndependentAt, at);
  assert.equal(
    historicalProofValid(r, f.l, "PY:T07.1", 1, "known", "S0006-EV16"),
    true,
  );
  const version = f.l.version;
  f.apply(e, a);
  assert.equal(f.l.version, version);
});

test("historical proof survives interruption and reload while new locks retain only scope, not old drafts", () => {
  const f = fixture(),
    e = f.issue(),
    a = f.proposal(e, "S0006-EV16", false);
  f.apply(e, a);
  assert.equal(f.l.evidence.length, 0);
  assert.notEqual(f.l.cells["PY:T07.1"].states[0], "P");
  interruptLearningAttempt(f.l, e, at);
  const next = f.issue();
  assert.deepEqual(next.problem!.contract.preservedFacets, ["known"]);
  assert.deepEqual(next.problem!.contract.missingFacets, ["remaining"]);
  const complete = f.proposal(next);
  delete complete.historicalMappings;
  f.apply(next, complete);
  assert.equal(f.l.cells["PY:T07.1"].states[0], "P");
  assert.equal(f.l.cycle, 1);
  f.g.study.learner = f.l;
  assert.deepEqual(
    decode(encode(f.g)).study.learner!.historicalReviews,
    f.l.historicalReviews,
  );
});

test("wrong source, scope, track, depth and unknown facets reject atomically", () => {
  const f = fixture(),
    e = f.issue(),
    before = JSON.stringify(f.l);
  const changes = [
    { sourceHash: "other" },
    { scopeId: "PY:T07.1/D2" },
    { facet: "invented" },
    { evidenceIds: ["S0004-EV03"] },
    { evidenceIds: ["S0001-EV08"] },
  ];
  for (const change of changes) {
    const a = f.proposal(e);
    Object.assign(a.historicalMappings![0], change);
    assert.throws(() => f.apply(e, a), /Historical|historical/);
    assert.equal(JSON.stringify(f.l), before);
  }
});

test("assisted history stays assisted and mixed rows require an exact independent excerpt", () => {
  const assisted = fixture("PE:T05.2"),
    e = assisted.issue(),
    a = assisted.proposal(e, "S0005-EV03", false);
  assert.throws(() => assisted.apply(e, a), /assistance cannot/);
  a.historicalMappings![0].outcome = "assisted";
  assisted.apply(e, a);
  assert.equal(
    assisted.l.cells["PE:T05.2"].facets["D1:known"].outcome,
    "assisted",
  );
  assert.notEqual(assisted.l.cells["PE:T05.2"].states[0], "P");
  const mixed = fixture("PY:T08.2"),
    m = mixed.issue(),
    proposal = mixed.proposal(m, "S0005-EV10", false);
  assert.throws(() => mixed.apply(m, proposal), /mixed rows need/);
  proposal.historicalMappings![0].sourceExcerpts = {
    "S0005-EV10":
      "Independently said something not present in the source observation",
  };
  assert.throws(() => mixed.apply(m, proposal), /mixed rows need/);
  const record = historicalRecords(r, "PY:T08.2", 1).find(
    (row) => row.id === "S0005-EV10",
  )!;
  proposal.historicalMappings![0].sourceExcerpts = {
    "S0005-EV10": record.observation.split(". ")[0] + ".",
  };
  mixed.apply(m, proposal);
  assert.equal(
    mixed.l.cells["PY:T08.2"].facets["D1:known"].outcome,
    "independent",
  );
  assert.notEqual(mixed.l.cells["PY:T08.2"].states[0], "P");
});

test("new contradictory work and later source review corrections retain audit history without reviving invalid proof", () => {
  const f = fixture(),
    e = f.issue();
  f.apply(e, f.proposal(e, "S0006-EV16", false));
  const correction = f.proposal(e, "S0006-EV16", false);
  correction.historicalMappings![0].outcome = "unknown";
  f.apply(e, correction);
  assert.equal(f.l.historicalReviews!.length, 2);
  assert.equal(
    historicalProofValid(r, f.l, "PY:T07.1", 1, "known", "S0006-EV16"),
    false,
  );
  const fresh = f.proposal(e, "S0006-EV16", false);
  fresh.findings = [
    {
      objectiveId: "PY:T07.1",
      facet: "known",
      depth: 1,
      outcome: "contradicted",
      evidence: [1],
      completeCheckpointScope: false,
      rationale: "Synthetic current contradiction",
    },
  ];
  f.apply(e, fresh);
  const retry = f.proposal(e, "S0006-EV16", false);
  f.apply(e, retry);
  assert.equal(
    f.l.cells["PY:T07.1"].facets["D1:known"].outcome,
    "contradicted",
  );
  assert.notEqual(f.l.cells["PY:T07.1"].states[0], "P");
});

test("uncertain reconciliation does not demote an imported full pass or reset its old review date", () => {
  const f = fixture("PY:T06.1"),
    e = f.issue(),
    due = f.l.reviews["PY:T06.1/D1"].due;
  const a = f.proposal(e, "S0005-EV07", false);
  a.historicalMappings![0].outcome = "unknown";
  f.apply(e, a);
  assert.equal(f.l.cells["PY:T06.1"].states[0], "P");
  assert.equal(f.l.reviews["PY:T06.1/D1"].due, due);
});

test("reconstructing an omitted source review keeps its original date instead of inventing a current observation", () => {
  const f = fixture("PY:T06.1"),
    e = f.issue();
  // Synthetic legacy bookkeeping repair of a pass already present in the source.
  f.l.cells["PY:T06.1"].states[0] = "G";
  delete f.l.reviews["PY:T06.1/D1"];
  const a = f.proposal(e, "S0005-EV07", false);
  a.scopeReviews![0].completeCoverage = true;
  a.historicalMappings!.push({
    ...a.historicalMappings![0],
    facet: "remaining",
  });
  f.apply(e, a);
  const review = f.l.reviews["PY:T06.1/D1"];
  assert.equal(review.lastIndependentDate, "2026-09-16");
  assert.equal(review.lastIndependentAt, undefined);
  assert.equal(review.due, "2026-09-19");
  assert.equal(review.verifiedReviews, 0);
  assert.equal(f.l.evidence.length, 0);
});

test("NPC-only completion cannot create a human attempt to authorize historical reconciliation", () => {
  const f = fixture(),
    e = f.issue();
  f.l.attempts = [];
  e.history = [];
  const before = JSON.stringify(f.l),
    a = f.proposal(e, "S0006-EV16", false);
  assert.throws(() => f.apply(e, a), /needs a real human technical attempt/);
  assert.equal(JSON.stringify(f.l), before);
});

test("export preserves original observations, records source reconciliation and rejects tampered review receipts", async () => {
  const f = fixture("PY:T07.1", "live"),
    e = f.issue();
  f.apply(e, f.proposal(e));
  const exported = await prepareRoadmapExport(r, f.l, undefined, at);
  assert.match(
    exported.content,
    /Historical facet reconciliation \(no new observation IDs\)/,
  );
  assert.equal([...exported.content.matchAll(/^\| S0006-EV16 \|/gm)].length, 1);
  assert.match(exported.content, /\| G0017 \|[^\n]*CLOSED; full checkpoint/);
  assert.ok(exported.content.includes("S0008-EV01"));
  assert.ok(!exported.content.includes("Synthetic explicit equivalence"));
  const again = await prepareRoadmapExport(r, f.l, exported, at);
  assert.equal(again.content, exported.content);
  f.l.historicalReviews![0].assessmentId = "no-receipt";
  await assert.rejects(
    prepareRoadmapExport(r, f.l, exported, at),
    /matching assessment receipt/,
  );
});
