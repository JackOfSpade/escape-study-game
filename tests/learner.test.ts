import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assess, edit, ensureProblem, submit } from "../src/ai";
import {
  beginVisit,
  eligible,
  finishVisit,
  initialStudy,
  syncLearningView,
} from "../src/curriculum";
import {
  applyLearningAssessment,
  beginLearningAttempt,
  closeLearningSession,
  eligibleLearning,
  encounterKey,
  initialLearner,
  interruptLearningAttempt,
  isDelayedReview,
  localDate,
  reconcileGates,
  registerScopes,
} from "../src/learner";
import { type Assessment, type Encounter, type Roadmap } from "../src/model";
import { decode, encode } from "../src/persistence";
import { replayRetention } from "../src/retention-history";
import { createGame } from "../src/world";
import { devProblem } from "./helpers/practice-questions";
import { recordSpawn, spawnContract } from "../src/topic-spawn";
import type { Game } from "../src/model";

const r = JSON.parse(readFileSync("public/curriculum.json", "utf8")) as Roadmap;
const when = "2026-10-15T16:00:00.000Z";
function fixture() {
  const l = initialLearner(r, "test");
  l.reviews = {};
  const g = createGame(10, r),
    e = g.encounters["f0-room0"],
    c = eligibleLearning(r, l, when);
  const def = {
    id: `${c.objectiveIds[0]}/D1`,
    objectiveId: c.objectiveIds[0],
    depth: 1,
    sourceScope: c.scopes[0],
    facets: [
      { id: "purpose", description: "Explain the mechanism and its purpose" },
      {
        id: "boundary",
        description: "Trace and explain the relevant boundary",
      },
    ],
  };
  e.problem = {
    title: "Isolated ledger fixture",
    prompt: "This is a test fixture, not actual study.",
    rubric: ["purpose", "boundary"],
    starter: "",
    provenance: "study-mode",
    contract: c,
    scopeDefinitions: [def],
  };
  e.history = [
    {
      seq: 1,
      author: "human",
      kind: "reasoning",
      text: "Independent fixture purpose reasoning.",
      at: 1,
      revision: 0,
      wallTime: when,
    },
    {
      seq: 2,
      author: "human",
      kind: "test",
      text: "An independent fixture boundary test design.",
      at: 2,
      revision: 0,
      wallTime: when,
    },
  ];
  registerScopes(r, l, e);
  beginLearningAttempt(r, l, e, when);
  const proposal = (id: string, facets: string[], version = 0): Assessment => ({
    id,
    encounter: e.id,
    sourceVersion: version,
    provenance: "test-fixture",
    status: "pending",
    visitOutcome: "unresolved",
    evidenceCutoffSequence: 2,
    scopeReviews: [
      {
        id: def.id,
        completeCoverage: true,
        rationale: "Isolated fixture scope review, not real learning.",
      },
    ],
    findings: facets.map((f) => ({
      objectiveId: c.objectiveIds[0],
      depth: 1,
      facet: f,
      outcome: "independent",
      evidence: [f === "purpose" ? 1 : 2],
      completeCheckpointScope: false,
      rationale: "Explicitly simulated valid test evidence.",
    })),
  });
  return { l, g, e, c, proposal };
}
test("import is administrative; all original cells, evidence refs and current queues survive", () => {
  const l = initialLearner(r);
  assert.equal(l.attempts.length, 0);
  assert.equal(l.evidence.length, 0);
  assert.equal(l.currentSession, undefined);
  assert.equal(Object.keys(l.cells).length, 192);
  assert.equal(
    Object.entries(l.cells).filter(
      ([id, c]) => id.startsWith("PY:") && c.states[0] === "P",
    ).length,
    2,
  );
  assert.equal(
    Object.entries(l.cells).filter(
      ([id, c]) => id.startsWith("PE:") && c.states[0] === "P",
    ).length,
    8,
  );
  assert.equal(l.cells["PY:T01.1"].sourceRefs, r.tracks.PY.objectives[0].refs);
  assert.deepEqual(l.tracks.PY.queue, r.tracks.PY.remaining);
  assert.deepEqual(l.tracks.PE.queue, ["X09"]);
  assert.equal(l.sessions.at(-1)?.id, "S0007");
  assert.equal(l.sessions.at(-1)?.status, "open");
  assert.equal(eligibleLearning(r, l, when).objectiveIds[0], "PY:T05.2");
});
test("full extension definitions are imported, including the real-history X09 boundary", () => {
  for (const t of ["PY", "PE"] as const)
    for (const o of r.tracks[t].objectives)
      assert.ok(o.scope.length > 20, o.id);
  assert.match(
    r.tracks.PE.objectives.find((o) => o.id === "PE:X09.1")!.scope,
    /real facts/,
  );
  assert.match(
    r.tracks.PE.objectives.find((o) => o.id === "PE:X08.1")!.scope,
    /closure|runtime/,
  );
  assert.ok(r.tracks.PE.topics.X09.includes("Project"));
});
/** Old development path: the encounter's private synthetic question, assigned explicitly. */
function issueDev(g: Game, e: Encounter, roadmap: Roadmap) {
  const contract = spawnContract(roadmap, g.study);
  e.problem = devProblem(g, roadmap, contract);
  e.workspace = e.problem.starter;
  e.state = "in-progress";
  recordSpawn(g.study, contract, e.id, g.time);
}
test("new actual study allocates S0008 once; development practice allocates no real attempt", async () => {
  const { l, e } = fixture();
  assert.equal(l.currentSession, "S0008");
  assert.equal(l.attempts[0].id, "S0008-A01");
  assert.equal(
    l.sessions.find((s) => s.id === "S0007")!.status,
    "INTERRUPTED_AT_LAST_SAVE",
  );
  beginLearningAttempt(r, l, e, when);
  assert.equal(l.attempts.length, 1);
  const g = createGame(4, r);
  const dev = g.encounters["f0-room0"];
  issueDev(g, dev, r);
  await ensureProblem(g, dev, r);
  beginVisit(r, g.study, dev);
  finishVisit(r, g.study, dev);
  assert.equal(g.study.session, "DEVELOPMENT");
  assert.equal(g.study.learner!.attempts.length, 0);
  assert.equal(g.study.learner!.cycle, 0);
});
test("complementary independent facets merge in reverse response order; partial evidence never passes full scope", () => {
  const { l, e, c, proposal } = fixture();
  const later = proposal("boundary-first", ["boundary"]);
  applyLearningAssessment(r, l, e, later, when, "test-fixture");
  assert.notEqual(l.cells[c.objectiveIds[0]].states[0], "P");
  assert.equal(l.cycle, 0);
  const earlier = proposal("purpose-late", ["purpose"], 0);
  earlier.visitOutcome = "usable";
  applyLearningAssessment(r, l, e, earlier, when, "test-fixture");
  assert.equal(l.cells[c.objectiveIds[0]].states[0], "P");
  assert.equal(l.cycle, 1);
  assert.deepEqual(
    l.evidence.map((e) => e.id),
    ["S0008-EV01", "S0008-EV02"],
  );
  assert.equal(l.reviews[`${c.objectiveIds[0]}/D1`].due, "2026-10-18");
  assert.equal(l.tracks.PY.queue[0], "T10");
  const before = JSON.stringify(l);
  applyLearningAssessment(r, l, e, earlier, when, "test-fixture");
  assert.equal(JSON.stringify(l), before);
  const conflicting = structuredClone(earlier);
  conflicting.findings[0].rationale = "Changed response";
  assert.throws(
    () => applyLearningAssessment(r, l, e, conflicting, when, "test-fixture"),
    /Conflicting duplicate/,
  );
  assert.equal(JSON.stringify(l), before);
});
test("prior help is scoped per facet; neutral re-asking cannot restore supplied independent scope", () => {
  const { l, e, c, proposal } = fixture();
  e.tutor = [
    {
      id: "help",
      author: "tutor",
      kind: "tutor",
      text: "The supplied boundary answer.",
      seq: 0,
      worldTime: 0,
      presented: 0,
      provenance: "test",
    },
  ];
  const independent = proposal("unrelated-purpose", ["purpose"]);
  independent.helpAttributions = [
    {
      messageId: "help",
      facets: ["boundary"],
      rationale: "Fixture help supplied only the boundary reasoning.",
    },
  ];
  applyLearningAssessment(r, l, e, independent, when, "test-fixture");
  assert.equal(
    l.cells[c.objectiveIds[0]].facets["D1:purpose"].outcome,
    "independent",
  );
  const copied = proposal("copied-boundary", ["boundary"]);
  copied.helpAttributions = independent.helpAttributions;
  const before = JSON.stringify(l);
  assert.throws(
    () => applyLearningAssessment(r, l, e, copied, when, "test-fixture"),
    /supplied key step/,
  );
  assert.equal(JSON.stringify(l), before);
  const missingAttribution = proposal("unknown-help", ["boundary"]);
  assert.throws(
    () =>
      applyLearningAssessment(
        r,
        l,
        e,
        missingAttribution,
        when,
        "test-fixture",
      ),
    /explicit facet/,
  );
});
test("later catch-up exposure cannot taint earlier independent reasoning", () => {
  const { l, e, proposal } = fixture();
  e.group = [
    {
      id: "catch-up",
      author: "npc-0",
      kind: "npc",
      text: "Later displayed idea with an earlier fictional timestamp.",
      seq: 4,
      worldTime: 0,
      presented: 4,
      provenance: "catch-up",
    },
  ];
  const p = proposal("before-exposure", ["purpose"]);
  applyLearningAssessment(r, l, e, p, when, "test-fixture");
  assert.equal(p.status, "applied");
});
test("no NPC, defense, unknown IDs, missing refs, nonexistent execution, or future version can mint credit", () => {
  for (const change of [
    (_a: Assessment, e: Encounter) => {
      e.history[0].author = "npc-0";
    },
    (_a: Assessment, e: Encounter) => {
      e.history[0].kind = "defense";
    },
    (a: Assessment) => {
      a.findings[0].objectiveId = "PE:T99.9";
    },
    (a: Assessment) => {
      a.findings[0].evidence = [999];
    },
    (a: Assessment) => {
      a.findings[0].execution = "executed";
    },
    (a: Assessment) => {
      a.sourceVersion = 900;
    },
    (a: Assessment) => {
      a.evidenceCutoffSequence = 0;
    },
  ]) {
    const { l, e, proposal } = fixture(),
      a = proposal("rejected", ["purpose"]);
    change(a, e);
    const before = JSON.stringify(l);
    assert.throws(() =>
      applyLearningAssessment(r, l, e, a, when, "test-fixture"),
    );
    assert.equal(JSON.stringify(l), before);
  }
});
test("a test provider cannot alter a real learner profile", () => {
  const { l, e, proposal } = fixture();
  l.mode = "live";
  assert.throws(
    () =>
      applyLearningAssessment(
        r,
        l,
        e,
        proposal("test", ["purpose"]),
        when,
        "test-fixture",
      ),
    /cannot mix/,
  );
  assert.equal(l.evidence.length, 0);
});
test("verified complementary scope is required; a model full-scope flag cannot shrink the facet denominator", () => {
  const { l, e, c, proposal } = fixture();
  const a = proposal("partial-with-pass-claim", ["purpose"]);
  a.findings[0].completeCheckpointScope = true;
  applyLearningAssessment(r, l, e, a, when, "test-fixture");
  assert.notEqual(l.cells[c.objectiveIds[0]].states[0], "P");
  const mutated = structuredClone(e);
  mutated.problem!.scopeDefinitions![0].facets.pop();
  const before = JSON.stringify(l);
  assert.throws(() => registerScopes(r, l, mutated), /cannot be rewritten/);
  assert.equal(JSON.stringify(l), before);
});
test("an actual contradiction reopens only its facet and checkpoint, preserving independent sibling work", () => {
  const { l, e, c, proposal } = fixture();
  applyLearningAssessment(
    r,
    l,
    e,
    proposal("full", ["purpose", "boundary"]),
    when,
    "test-fixture",
  );
  assert.equal(l.cells[c.objectiveIds[0]].states[0], "P");
  const contradiction = proposal("contradiction", ["boundary"], 1);
  contradiction.findings[0].outcome = "contradicted";
  applyLearningAssessment(r, l, e, contradiction, when, "test-fixture");
  assert.equal(l.cells[c.objectiveIds[0]].states[0], "R");
  assert.equal(
    l.cells[c.objectiveIds[0]].facets["D1:purpose"].outcome,
    "independent",
  );
  assert.equal(l.evidence.length, 3);
});
test("retention uses actual elapsed time and separate practice sequences, never game time or midnight alone", () => {
  assert.equal(localDate("2026-10-16T01:00:00Z"), "2026-10-15");
  const v = {
    objectiveId: "PY:T01.1",
    depth: 1,
    due: "2026-10-18",
    stage: 0,
    verifiedReviews: 0,
    lastIndependentAt: "2026-10-15T23:59:00Z",
    sequence: "S0008",
  };
  assert.equal(isDelayedReview(v, "2026-10-16T00:01:00Z", "S0009"), false);
  assert.equal(isDelayedReview(v, "2026-10-18T00:01:00Z", "S0008"), false);
  assert.equal(isDelayedReview(v, "2026-10-18T00:01:00Z", "S0009"), true);
  assert.equal(
    isDelayedReview(
      { ...v, lastIndependentAt: undefined, lastIndependentDate: "2026-10-15" },
      "2026-10-16T16:00:00Z",
      "S0009",
    ),
    false,
  );
  assert.equal(
    isDelayedReview(
      { ...v, lastIndependentAt: undefined, lastIndependentDate: undefined },
      "2026-11-18T16:00:00Z",
      "S0009",
    ),
    false,
  );
});
test("strict per-track gates and cross-track lead limit survive reopening", () => {
  const l = initialLearner(r, "test");
  for (const o of r.tracks.PY.objectives) l.cells[o.id].states[0] = "P";
  reconcileGates(r, l);
  assert.equal(l.tracks.PY.tier, 2);
  assert.equal(l.tracks.PE.tier, 1);
  for (const o of r.tracks.PY.objectives)
    if (o.target >= 2) l.cells[o.id].states[1] = "P";
  reconcileGates(r, l);
  assert.equal(l.tracks.PY.tier, 2);
  assert.equal(l.tracks.PY.phase, "TIER_GATE");
  l.reviews = {};
  const c = eligibleLearning(r, l, when);
  assert.equal(c.track, "PE");
  assert.match(c.scheduleNote!, /M3.2/);
  for (const o of r.tracks.PE.objectives) l.cells[o.id].states[0] = "P";
  reconcileGates(r, l);
  assert.equal(l.tracks.PY.tier, 3);
  l.cells["PE:T01.1"].states[0] = "R";
  reconcileGates(r, l);
  assert.equal(l.tracks.PE.tier, 1);
  assert.equal(l.tracks.PY.tier, 2);
  assert.ok(l.tracks.PY.suspended.some((s) => s.tier === 3));
});
test("run-local terminal names never collide in persistent study visits or archived attempts", async () => {
  const a = createGame(15, r);
  const e = a.encounters["f0-room0"];
  issueDev(a, e, r);
  await ensureProblem(a, e, r);
  beginVisit(r, a.study, e);
  finishVisit(r, a.study, e);
  const b = createGame(15, r, a.study);
  const other = b.encounters["f0-room0"];
  issueDev(b, other, r);
  assert.notEqual(encounterKey(e), encounterKey(other));
  await ensureProblem(b, other, r);
  beginVisit(r, b.study, other);
  finishVisit(r, b.study, other);
  assert.equal(b.study.visits.length, 2);
  const restored = decode(encode(b));
  assert.deepEqual(restored.study, b.study);
});
test("unfinished learning links a new encounter to scope history without transferring a draft or consuming a visit twice", () => {
  const { l, e, proposal } = fixture();
  applyLearningAssessment(
    r,
    l,
    e,
    proposal("partial", ["purpose"]),
    when,
    "test-fixture",
  );
  interruptLearningAttempt(l, e, when);
  closeLearningSession(l);
  const g = createGame(21, r),
    next = g.encounters["f0-room0"];
  next.problem = structuredClone(e.problem);
  next.problem!.contract = eligibleLearning(r, l, when);
  beginLearningAttempt(r, l, next, when);
  assert.equal(l.currentSession, "S0009");
  assert.equal(l.attempts[1].parentAttempt, l.attempts[0].id);
  assert.equal(next.workspace, "");
  assert.ok(next.problem!.contract.preservedFacets!.includes("purpose"));
  assert.deepEqual(next.problem!.contract.missingFacets, ["boundary"]);
});
test("development assessments cannot apply academic evidence; live disconnection never substitutes a development pass", async () => {
  const g = createGame(2, r);
  const e = g.encounters["f0-room0"];
  issueDev(g, e, r);
  await ensureProblem(g, e, r);
  edit(
    g,
    e,
    "A long enough development answer that discusses the contract and its boundary without proving actual learning.",
    0,
  );
  await assess(g, e, r);
  assert.equal(g.study.learner!.evidence.length, 0);
  assert.equal(g.study.assessments[0].status, "review-required");
  g.study.profile = "live";
  await submit(g, e, r);
  assert.notEqual(e.state, "consumed");
  assert.equal(e.submissions.at(-1)?.status, "error");
  assert.equal(g.study.learner!.evidence.length, 0);
});

test("review scheduling extends only after fresh independent whole-scope delayed work", () => {
  const l = initialLearner(r, "test"),
    g = createGame(31, r),
    e = g.encounters["f0-room0"],
    c = eligibleLearning(r, l, when),
    id = c.objectiveIds[0];
  assert.equal(c.review, true);
  const def = {
    id: `${id}/D1`,
    objectiveId: id,
    depth: 1,
    sourceScope: c.scopes[0],
    facets: [
      { id: "scope", description: "The complete isolated test review scope" },
    ],
  };
  e.problem = {
    title: "Review fixture",
    prompt: "Isolated review",
    starter: "",
    rubric: ["scope"],
    provenance: "study-mode",
    contract: c,
    scopeDefinitions: [def],
  };
  e.history = [
    {
      seq: 1,
      author: "human",
      kind: "reasoning",
      text: "Fresh independent review fixture.",
      at: 1,
      revision: 1,
      wallTime: when,
    },
  ];
  registerScopes(r, l, e);
  beginLearningAttempt(r, l, e, when);
  const a: Assessment = {
    id: "review-success",
    encounter: e.id,
    sourceVersion: 0,
    findings: [
      {
        objectiveId: id,
        facet: "scope",
        outcome: "independent",
        evidence: [1],
        completeCheckpointScope: true,
        rationale: "Fixture complete review.",
      },
    ],
    scopeReviews: [
      {
        id: def.id,
        completeCoverage: true,
        rationale: "Fixture scope verified.",
      },
    ],
    visitOutcome: "usable",
    status: "pending",
    provenance: "test-fixture",
  };
  applyLearningAssessment(r, l, e, a, when, "test-fixture");
  assert.equal(l.reviews[def.id].verifiedReviews, 1);
  assert.equal(l.reviews[def.id].due, "2026-10-22");
  assert.equal(l.cells[id].states[0], "P");
  const unknown = {
    ...structuredClone(a),
    id: "unknown-repeat",
    sourceVersion: l.version,
    findings: [{ ...a.findings[0], outcome: "unknown" as const, evidence: [] }],
  };
  applyLearningAssessment(
    r,
    l,
    e,
    unknown,
    "2026-10-19T16:00:00Z",
    "test-fixture",
  );
  assert.equal(l.reviews[def.id].verifiedReviews, 1);
  assert.equal(l.cells[id].states[0], "P");
});
test("a delayed full-scope review can accumulate fresh facets across assessments with exact receipt provenance", () => {
  const { l, e, c, proposal } = fixture(),
    scope = `${c.objectiveIds[0]}/D1`;
  e.problem!.contract.review = true;
  l.attempts[0].contract.review = true;
  l.reviews[scope] = {
    objectiveId: c.objectiveIds[0],
    depth: 1,
    due: "2026-10-15",
    stage: 0,
    verifiedReviews: 0,
    lastIndependentAt: "2026-10-13T16:00:00.000Z",
    sequence: "S0007",
  };
  applyLearningAssessment(
    r,
    l,
    e,
    proposal("delayed-partial-purpose", ["purpose"]),
    when,
    "test-fixture",
  );
  assert.equal(l.reviews[scope].verifiedReviews, 0);
  applyLearningAssessment(
    r,
    l,
    e,
    proposal("delayed-partial-boundary", ["boundary"], l.version),
    when,
    "test-fixture",
  );
  assert.equal(l.reviews[scope].verifiedReviews, 1);
  assert.equal(l.retentionHistory!.length, 1);
  assert.equal(l.retentionHistory![0].evidenceIds.length, 2);
  assert.deepEqual(replayRetention(r, l, scope), l.reviews[scope]);
});
test("late results for an interrupted visit and its continuation merge without double-serving the ratio", () => {
  const { l, e, proposal } = fixture();
  interruptLearningAttempt(l, e, when);
  const next = structuredClone(e);
  next.runId = "continuation-run";
  next.problem!.contract = eligibleLearning(r, l, when);
  beginLearningAttempt(r, l, next, when);
  const child = proposal("child-first", ["boundary"]);
  child.encounter = next.id;
  child.visitOutcome = "usable";
  applyLearningAssessment(r, l, next, child, when, "test-fixture");
  assert.equal(l.cycle, 1);
  const old = proposal("old-arrives-late", ["purpose"], 0);
  old.visitOutcome = "usable";
  applyLearningAssessment(r, l, e, old, when, "test-fixture");
  assert.equal(l.cycle, 1);
  assert.equal(l.evidence.length, 2);
  assert.equal(l.cells["PY:T11.1"].states[0], "P");
});
test("repeated interruptions retire the whole continuation family and project one served visit", () => {
  const { l, e, proposal } = fixture();
  const encounters = [e];
  for (let run = 1; run <= 2; run++) {
    interruptLearningAttempt(l, encounters.at(-1)!, when);
    const next = structuredClone(e);
    next.runId = `interrupted-run-${run}`;
    next.problem!.contract = eligibleLearning(r, l, when);
    beginLearningAttempt(r, l, next, when);
    encounters.push(next);
  }
  const completed = proposal("third-run-served", ["purpose", "boundary"]);
  completed.visitOutcome = "usable";
  applyLearningAssessment(r, l, encounters[2], completed, when, "test-fixture");
  assert.deepEqual(l.continuations, [], "all interrupted ancestors retire");
  for (let i = 1; i >= 0; i--) {
    const late = proposal(`ancestor-${i}-late`, ["purpose"]);
    late.visitOutcome = "usable";
    applyLearningAssessment(r, l, encounters[i], late, when, "test-fixture");
  }
  assert.equal(l.cycle, 1);
  const study = initialStudy(r, "live");
  study.learner = l;
  syncLearningView(study);
  assert.equal(study.visits.length, 1, "one family consumes one formal visit");
});
test("an interrupted ancestor served by a late result releases its active continuation", () => {
  const { l, e, proposal } = fixture();
  interruptLearningAttempt(l, e, when);
  const next = structuredClone(e);
  next.runId = "active-continuation";
  next.problem!.contract = eligibleLearning(r, l, when);
  beginLearningAttempt(r, l, next, when);
  const late = proposal("ancestor-served-first", ["purpose", "boundary"]);
  late.visitOutcome = "usable";
  applyLearningAssessment(r, l, e, late, when, "test-fixture");
  assert.equal(
    l.attempts[1].status,
    "interrupted",
    "the replacement task no longer blocks the scheduler",
  );
  assert.deepEqual(l.continuations, []);
  assert.equal(l.cycle, 1);
  assert.equal(eligibleLearning(r, l, when).track, "PE");
});
test("a late assessment of older same-facet work cannot undo a later contradiction or repair", () => {
  for (const latestOutcome of ["independent", "contradicted"] as const) {
    const { l, e, c, proposal } = fixture();
    const fresh = proposal(`fresh-${latestOutcome}`, ["purpose"]);
    fresh.findings[0].evidence = [2];
    fresh.findings[0].outcome = latestOutcome;
    applyLearningAssessment(r, l, e, fresh, when, "test-fixture");
    const late = proposal(`stale-${latestOutcome}`, ["purpose"]);
    late.findings[0].outcome =
      latestOutcome === "independent" ? "contradicted" : "independent";
    applyLearningAssessment(r, l, e, late, when, "test-fixture");
    assert.equal(
      l.cells[c.objectiveIds[0]].facets["D1:purpose"].outcome,
      latestOutcome,
    );
    assert.equal(l.evidence.length, 2, "both assessments remain auditable");
  }
});
test("assessment ordering across runs uses actual observation times rather than encounter-local sequence numbers", () => {
  const { l, e, c, proposal } = fixture();
  interruptLearningAttempt(l, e, when);
  const next = structuredClone(e);
  next.runId = "later-observation-run";
  next.problem!.contract = eligibleLearning(r, l, when);
  const later = "2026-10-15T16:10:00.000Z";
  next.history[0].wallTime = later;
  beginLearningAttempt(r, l, next, later);
  applyLearningAssessment(
    r,
    l,
    next,
    proposal("newer-observed-purpose", ["purpose"]),
    later,
    "test-fixture",
  );
  const stateBeforeLate = l.cells[c.objectiveIds[0]].states[0];
  const stale = proposal("old-run-contradiction", ["purpose"]);
  stale.findings[0].outcome = "contradicted";
  stale.findings[0].evidence = [2];
  applyLearningAssessment(r, l, e, stale, later, "test-fixture");
  assert.equal(
    l.cells[c.objectiveIds[0]].facets["D1:purpose"].outcome,
    "independent",
  );
  assert.equal(
    l.cells[c.objectiveIds[0]].states[0],
    stateBeforeLate,
    "stale contradiction does not reopen the cell",
  );
  assert.equal(l.evidence.length, 2);
});
test("controlled bridge fixture: live snapshot completion awards access before separate validated learning assessment", async () => {
  const originalFetch = globalThis.fetch;
  const ai = await import("../src/ai");
  let releaseCompletion!: (value: Response) => void;
  let releaseAssessment!: (value: Response) => void;
  let generated: any;
  const response = (body: unknown) =>
    new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
    });
  globalThis.fetch = async (input, init) => {
    if (String(input) === "/api/status")
      return response({
        mode: "claude-cli",
        label: "Isolated transport fixture",
        capabilities: ["generate", "tutor", "group", "complete", "assess"],
        detail:
          "Test fixture only; this is not a native Study Mode verification.",
      });
    const body = JSON.parse(String(init?.body));
    if (body.operation === "generate") {
      const c = body.payload.contract;
      generated = {
        title: "Fixture prediction",
        prompt: "Isolated pipeline fixture.",
        starter: "",
        rubric: ["scope"],
        contract: c,
        scopeDefinitions: [
          {
            id: `${c.objectiveIds[0]}/D${c.depth}`,
            objectiveId: c.objectiveIds[0],
            depth: c.depth,
            sourceScope: c.scopes[0],
            facets: [
              {
                id: "scope",
                description: "Complete scope in this transport fixture",
              },
            ],
          },
        ],
      };
      return response(generated);
    }
    if (body.operation === "complete")
      return new Promise((resolve) => {
        releaseCompletion = resolve;
      });
    if (body.operation === "assess")
      return new Promise((resolve) => {
        releaseAssessment = resolve;
      });
    return response({ text: "Fixture guidance" });
  };
  try {
    await ai.checkBridge();
    const g = createGame(33, r);
    g.study = initialStudy(r, "live");
    g.status = "playing";
    const e = g.encounters["f0-room0"];
    await ai.ensureProblem(g, e, r);
    assert.equal(e.problem!.provenance, "claude-cli");
    ai.edit(
      g,
      e,
      "This human-authored fixture explanation supplies the scope to be assessed, with no executed-code claim.",
      0,
      r,
    );
    const task = ai.submit(g, e, r);
    assert.equal(e.state, "submitted");
    const time = g.time;
    const engine = await import("../src/engine");
    for (let i = 0; i < 10; i++) engine.step(g, 0.1);
    assert.ok(g.time > time + 0.9);
    releaseCompletion(
      response({
        complete: true,
        feedback: "Fixture completion only.",
        qualified: ["human"],
      }),
    );
    await task;
    assert.equal(e.state, "consumed");
    assert.ok(g.survivors[0].access.includes(0));
    assert.equal(g.study.learner!.evidence.length, 0);
    assert.equal(
      g.study.learner!.cycle,
      0,
      "World win must not serve a formal visit before assessment",
    );
    assert.ok(releaseAssessment);
    releaseAssessment(
      response({
        findings: [
          {
            objectiveId: generated.contract.objectiveIds[0],
            facet: "scope",
            outcome: "independent",
            evidence: [e.history.find((h) => h.kind === "edit")!.seq],
            completeCheckpointScope: true,
            rationale: "Isolated transport fixture.",
          },
        ],
        visitOutcome: "usable",
        scopeReviews: [
          {
            id: generated.scopeDefinitions[0].id,
            completeCoverage: true,
            rationale: "Isolated fixture scope.",
          },
        ],
        helpAttributions: [],
      }),
    );
    for (let i = 0; i < 10 && g.study.assessments[0].status === "pending"; i++)
      await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(g.study.assessments[0].status, "applied");
    assert.equal(g.study.learner!.evidence.length, 1);
    assert.equal(g.study.learner!.cycle, 1);
    assert.equal(g.study.learner!.attempts[0].id, "S0008-A01");
    assert.equal(g.study.learner!.evidence[0].execution, "not-run");
  } finally {
    globalThis.fetch = originalFetch;
    await ai.checkBridge();
  }
});

test("reopened lower gates suspend an unfinished higher task and restore the exact saved queue later", () => {
  const l = initialLearner(r, "test");
  l.reviews = {};
  for (const track of ["PY", "PE"] as const)
    for (const o of r.tracks[track].objectives) {
      l.cells[o.id].states[0] = "P";
      if (track === "PY" && o.target >= 2) l.cells[o.id].states[1] = "P";
    }
  reconcileGates(r, l);
  assert.equal(l.tracks.PY.tier, 3);
  l.tracks.PY.phase = "REPAIR_VERIFY";
  l.tracks.PY.queue = ["T11", "T10"];
  l.tracks.PY.lap = 5;
  const g = createGame(77, r),
    e = g.encounters["f0-room0"],
    c = eligibleLearning(r, l, when);
  assert.equal(c.depth, 3);
  e.problem = {
    title: "Higher fixture",
    prompt: "Fixture only",
    rubric: [],
    starter: "",
    provenance: "study-mode",
    contract: c,
  };
  beginLearningAttempt(r, l, e, when);
  l.cells["PE:T01.1"].states[0] = "R";
  reconcileGates(r, l);
  assert.equal(l.attempts[0].status, "suspended");
  assert.throws(() => beginLearningAttempt(r, l, e, when), /suspended/);
  l.cells["PE:T01.1"].states[0] = "P";
  reconcileGates(r, l);
  assert.equal(l.tracks.PY.tier, 3);
  assert.equal(l.tracks.PY.lap, 5);
  assert.deepEqual(l.tracks.PY.queue, ["T11", "T10"]);
  assert.equal(l.attempts[0].status, "in-progress");
});
test("uncertain curriculum coverage retains partial work without using a full-scope claim to promote it", () => {
  const { l, e, c, proposal } = fixture(),
    a = proposal("uncertain", ["purpose", "boundary"]);
  a.scopeReviews![0].completeCoverage = false;
  applyLearningAssessment(r, l, e, a, when, "test-fixture");
  assert.notEqual(l.cells[c.objectiveIds[0]].states[0], "P");
  assert.equal(l.evidence.length, 2);
  assert.equal(l.verifiedScopes.length, 0);
});
test("death detaches a suspended higher task so repaired gates resume with a fresh linked question instead of an unreachable old lock", () => {
  const l = initialLearner(r, "test");
  l.reviews = {};
  for (const track of ["PY", "PE"] as const)
    for (const o of r.tracks[track].objectives) {
      l.cells[o.id].states[0] = "P";
      if (track === "PY" && o.target >= 2) l.cells[o.id].states[1] = "P";
    }
  reconcileGates(r, l);
  l.tracks.PY.phase = "REPAIR_VERIFY";
  l.tracks.PY.queue = ["T11", "T10"];
  l.tracks.PY.lap = 5;
  const g = createGame(77, r),
    e = g.encounters["f0-room0"],
    c = eligibleLearning(r, l, when);
  g.study.learner = l;
  e.problem = {
    title: "Synthetic higher task",
    prompt: "Original question retained only in its old world",
    starter: "",
    rubric: [],
    provenance: "study-mode",
    contract: c,
  };
  e.workspace = "HIGHER_PRIVATE_DRAFT";
  e.history = [
    {
      seq: 1,
      author: "human",
      kind: "reasoning",
      text: "Synthetic unfinished higher-scope reasoning",
      at: 0,
      wallTime: when,
      revision: 0,
    },
  ];
  beginLearningAttempt(r, l, e, when);
  const parent = l.attempts[0].id;
  l.cells["PE:T01.1"].states[0] = "R";
  reconcileGates(r, l);
  assert.equal(l.attempts[0].status, "suspended");
  g.study.archives.push(e);
  interruptLearningAttempt(l, e, when);
  interruptLearningAttempt(l, e, when);
  assert.equal(l.attempts[0].status, "interrupted");
  assert.equal(l.continuations.length, 1);
  const saved = decode(encode(g)),
    fresh = createGame(78, r, saved.study),
    restored = fresh.study.learner!;
  restored.cells["PE:T01.1"].states[0] = "P";
  reconcileGates(r, restored);
  assert.equal(restored.attempts[0].status, "interrupted");
  assert.deepEqual(restored.tracks.PY.queue, ["T11", "T10"]);
  assert.equal(restored.tracks.PY.lap, 5);
  const next = eligibleLearning(r, restored, when),
    nextEncounter = fresh.encounters["f0-room0"];
  assert.equal(next.depth, 3);
  nextEncounter.problem = {
    title: "Synthetic fresh linked task",
    prompt: "New unseen same-scope question",
    starter: "",
    rubric: [],
    provenance: "study-mode",
    contract: next,
  };
  const a = beginLearningAttempt(r, restored, nextEncounter, when);
  assert.equal(a.parentAttempt, parent);
  assert.notEqual(a.encounter, l.attempts[0].encounter);
  assert.equal(nextEncounter.workspace, "");
  assert.equal(fresh.study.archives[0].workspace, "HIGHER_PRIVATE_DRAFT");
  assert.equal(restored.cycle, 0);
  assert.equal(restored.evidence.length, 0);
});
test("an unrelated runtime result cannot validate the submitted human artifact", () => {
  const { l, e, proposal } = fixture();
  e.history.push({
    seq: 3,
    author: "runner",
    kind: "execution",
    text: "Unrelated execution output",
    at: 3,
    revision: 0,
    refs: ["artifact:999"],
  });
  const a = proposal("wrong-runtime", ["purpose"]);
  a.evidenceCutoffSequence = 3;
  a.findings[0].execution = "executed";
  assert.throws(
    () => applyLearningAssessment(r, l, e, a, when, "test-fixture"),
    /execution evidence/,
  );
});
test("matching artifact references without a captured runner receipt cannot invent execution", () => {
  const { l, e, proposal } = fixture();
  const a = proposal("forged-matching-runtime", ["purpose"]);
  const seq = a.findings[0].evidence[0];
  e.history.push({
    seq: 3,
    author: "runner",
    kind: "execution",
    text: "Claimed success",
    at: 3,
    revision: 0,
    refs: [`artifact:${seq}`],
  });
  a.evidenceCutoffSequence = 3;
  a.findings[0].execution = "executed";
  assert.throws(
    () => applyLearningAssessment(r, l, e, a, when, "test-fixture"),
    /execution evidence/,
  );
});
test("non-eligible shared work is saved without stealing the next formal visit", () => {
  const g = createGame(88, r);
  g.study = initialStudy(r, "live");
  const e = g.encounters["f0-room0"];
  const c = eligible(r, g.study);
  e.problem = {
    title: "Existing group contract",
    prompt: "An existing group task",
    starter: "",
    rubric: [],
    provenance: "study-mode",
    contract: { ...c, track: "PE", objectiveIds: ["PE:T01.1"] },
  };
  edit(
    g,
    e,
    "My useful contribution remains saved even though this is not my scheduled formal study visit.",
    0,
    r,
  );
  assert.ok(e.workspace.includes("useful contribution"));
  assert.equal(g.study.learner!.attempts.length, 0);
  assert.equal(eligible(r, g.study).track, "PY");
  assert.match(e.error!, /scheduled/);
});

test("edit evidence records the actual human diff instead of claiming ownership of supplied starter code", async () => {
  const g = createGame(55, r),
    e = g.encounters["f0-room0"];
  await ensureProblem(g, e, r);
  const starter = e.workspace;
  edit(g, e, `${starter}\nMy own reasoning.`, 0);
  const h = e.history.at(-1)!;
  assert.equal(h.delta!.removed, "");
  assert.equal(h.delta!.inserted, "\nMy own reasoning.");
  assert.equal(h.delta!.prefix, starter.length);
});
test("provided problem/starter exposure is persistent, scoped assistance for the assessor", async () => {
  const { l, g, e, proposal } = fixture(),
    ai = await import("../src/ai");
  ai.presentProblem(g, e);
  const exposure = e.problemPresentedSequence!;
  // Rebase controlled artifact sequence after the actual presentation event.
  e.history = e.history.filter((h) => h.author !== "human");
  e.history.push({
    seq: exposure + 1,
    author: "human",
    kind: "reasoning",
    text: "A supplied-key-step fixture",
    at: 2,
    revision: 0,
  });
  const a = proposal("supplied-context", ["purpose"]);
  a.findings[0].evidence = [exposure + 1];
  a.evidenceCutoffSequence = exposure + 1;
  a.helpAttributions = [
    {
      messageId: `problem:${encounterKey(e)}`,
      facets: ["purpose"],
      rationale: "Fixture question itself supplied the assessed key step.",
    },
  ];
  assert.throws(
    () => applyLearningAssessment(r, l, e, a, when, "test-fixture"),
    /supplied key step/,
  );
  const before = e.history.length;
  ai.presentProblem(g, e);
  assert.equal(e.history.length, before);
});

test("long editor histories stay compact and reconstruct exact arbitrary revisions", async () => {
  const { workspaceAt } = await import("../src/workspace-history");
  const g = createGame(57, r),
    e = g.encounters["f0-room0"];
  await ensureProblem(g, e, r);
  const base = "Long working draft.\n".repeat(4000);
  edit(g, e, base, 0);
  const versions = [base];
  for (let i = 0; i < 100; i++) {
    const next = `${e.workspace}\nBoundary note ${i}.`;
    edit(g, e, next, e.revision);
    versions.push(next);
  }
  assert.equal(workspaceAt(e).content, e.workspace);
  for (const i of [0, 20, 50, 100])
    assert.equal(
      workspaceAt(e, e.history.filter((h) => h.kind === "edit")[i].seq).content,
      versions[i],
    );
  assert.ok(
    JSON.stringify(e.history).length < base.length * 4,
    "History must store deltas, not 100 complete long drafts",
  );
  const restored = decode(encode(g));
  assert.equal(workspaceAt(restored.encounters[e.id]).content, e.workspace);
});

test("an assisted follow-up cannot revoke an already verified definition merely by treating learner mastery as scope coverage", () => {
  const { l, e, c, proposal } = fixture();
  const first = proposal("prior-valid-definition", ["purpose", "boundary"]);
  applyLearningAssessment(r, l, e, first, when, "test-fixture");
  assert.equal(l.cells[c.objectiveIds[0]].states[0], "P");
  e.tutor.push({
    id: "later-tutor",
    author: "tutor",
    kind: "tutor",
    text: "Supplied purpose and boundary reasoning for the later response.",
    seq: 3,
    presented: 3,
    worldTime: 0,
    provenance: "test-fixture",
  });
  e.history.push({
    seq: 4,
    author: "human",
    kind: "reasoning",
    text: "I repeat the later tutor's explanation.",
    at: 4,
    revision: 0,
    wallTime: when,
  });
  const assisted = proposal(
    "later-assisted-coverage",
    ["purpose", "boundary"],
    l.version,
  );
  assisted.evidenceCutoffSequence = 4;
  for (const finding of assisted.findings) {
    finding.outcome = "assisted";
    finding.evidence = [4];
  }
  assisted.helpAttributions = [
    {
      messageId: "later-tutor",
      facets: ["*"],
      rationale: "Supplied before the repeated response.",
    },
  ];
  assisted.scopeReviews![0] = {
    id: e.problem!.scopeDefinitions![0].id,
    completeCoverage: false,
    rationale:
      "All current answers are assisted, so independent mastery was not demonstrated.",
  };
  const before = JSON.stringify(l);
  let rejection: unknown;
  try {
    applyLearningAssessment(r, l, e, assisted, when, "test-fixture");
  } catch (error) {
    rejection = error;
  }
  assert.equal(l.cells[c.objectiveIds[0]].states[0], "P");
  assert.match(
    String(rejection),
    /Verified scope requires an explicit source-bound definition issue/,
  );
  assert.equal(
    JSON.stringify(l),
    before,
    "an ambiguous scope review cannot erase prior legitimate proof or create a failure",
  );
});

test("an explicit source-bound missing criterion can withdraw verified coverage without inventing learner failure", () => {
  const { l, e, c, proposal } = fixture();
  applyLearningAssessment(
    r,
    l,
    e,
    proposal("complete-before-criteria-review", ["purpose", "boundary"]),
    when,
    "test-fixture",
  );
  const evidence = structuredClone(l.evidence),
    a = proposal("source-bound-criteria-review", [], l.version);
  a.scopeReviews![0] = {
    id: e.problem!.scopeDefinitions![0].id,
    completeCoverage: false,
    rationale:
      "Reviewing the definition itself, independently of the learner's answer.",
    definitionIssue: {
      sourceHash: r.sourceHash,
      sourceQuote:
        "D1 checks purpose, representation/state, essential assumptions and a simple relevant boundary",
      missingCriterion:
        "The controlled two-facet definition does not explicitly cover essential assumptions.",
    },
  };
  assert.ok(
    r.tracks[c.track].curriculum.includes(
      a.scopeReviews![0].definitionIssue!.sourceQuote,
    ),
  );
  applyLearningAssessment(r, l, e, a, when, "test-fixture");
  assert.equal(l.cells[c.objectiveIds[0]].states[0], "G");
  assert.equal(l.verifiedScopes.includes(a.scopeReviews![0].id), false);
  assert.deepEqual(l.evidence, evidence);
  assert.ok(l.receipts[a.id]);
});

test("a definition challenge rejects invented source, missing criterion and internally contradictory coverage atomically", () => {
  for (const change of [
    (a: Assessment) =>
      (a.scopeReviews![0].definitionIssue!.sourceHash = "invented"),
    (a: Assessment) =>
      (a.scopeReviews![0].definitionIssue!.sourceQuote =
        "An invented rule not in the protected curriculum."),
    (a: Assessment) =>
      (a.scopeReviews![0].definitionIssue!.missingCriterion = ""),
    (a: Assessment) => (a.scopeReviews![0].completeCoverage = true),
  ]) {
    const { l, e, proposal } = fixture();
    applyLearningAssessment(
      r,
      l,
      e,
      proposal("valid-before-bad-challenge", ["purpose", "boundary"]),
      when,
      "test-fixture",
    );
    const a = proposal("malformed-criteria-challenge", [], l.version);
    a.scopeReviews![0] = {
      id: e.problem!.scopeDefinitions![0].id,
      completeCoverage: false,
      rationale: "Controlled invalid challenge.",
      definitionIssue: {
        sourceHash: r.sourceHash,
        sourceQuote:
          "D1 checks purpose, representation/state, essential assumptions and a simple relevant boundary",
        missingCriterion:
          "Missing essential assumptions in the controlled definition.",
      },
    };
    change(a);
    const before = JSON.stringify(l);
    assert.throws(
      () => applyLearningAssessment(r, l, e, a, when, "test-fixture"),
      /Invalid source-bound scope definition issue/,
    );
    assert.equal(JSON.stringify(l), before);
  }
});

test("unknown execution labels cannot bypass actual-run evidence checks or enter the learning ledger", () => {
  for (const value of ["passed", "failed", true, {}, "EXECUTED", null]) {
    const { l, e, proposal } = fixture(),
      a = proposal("invalid-execution-label", ["purpose", "boundary"]);
    a.visitOutcome = "usable";
    (a.findings[0] as unknown as { execution: unknown }).execution = value;
    const before = JSON.stringify(l);
    assert.throws(
      () => applyLearningAssessment(r, l, e, a, when, "test-fixture"),
      /execution|malformed/i,
    );
    assert.equal(
      JSON.stringify(l),
      before,
      "reject the entire transaction without passes, visits, evidence or counters",
    );
  }
});

test("F10 assistance on a later boundary does not erase an earlier independent purpose facet or certify the helped boundary", () => {
  const { l, e, c, proposal } = fixture();
  e.history = e.history.slice(0, 1);
  e.tutor.push({
    id: "boundary-help",
    author: "Terminal AI",
    kind: "tutor",
    text: "Synthetic supplied boundary answer",
    seq: 2,
    presented: 3,
    worldTime: 2,
    provenance: "test-fixture",
  });
  e.history.push({
    seq: 4,
    author: "human",
    kind: "reasoning",
    text: "Boundary answer repeats the supplied key step.",
    at: 4,
    revision: 0,
    wallTime: when,
  });
  const a = proposal("mixed-facet-help", ["purpose", "boundary"]);
  a.evidenceCutoffSequence = 4;
  a.visitOutcome = "usable";
  a.findings[1].outcome = "assisted";
  a.findings[1].evidence = [4];
  a.helpAttributions = [
    {
      messageId: "boundary-help",
      facets: ["boundary"],
      rationale: "Only the later boundary work uses this supplied key step.",
    },
  ];
  applyLearningAssessment(r, l, e, a, when, "test-fixture");
  const cell = l.cells[c.objectiveIds[0]];
  assert.equal(cell.facets["D1:purpose"].outcome, "independent");
  assert.equal(cell.facets["D1:boundary"].outcome, "assisted");
  assert.equal(cell.states[0], "G");
  assert.deepEqual(
    l.evidence.find((x) => x.facet === "purpose")!.helpMessageIds,
    [],
  );
  assert.deepEqual(
    l.evidence.find((x) => x.facet === "boundary")!.helpMessageIds,
    ["boundary-help"],
  );
  const restored = decode(
    encode({
      ...createGame(8, r),
      study: { ...initialStudy(r, "live"), learner: l },
    }),
  );
  assert.deepEqual(restored.study.learner!.cells[c.objectiveIds[0]], cell);
  const invented = structuredClone(a);
  invented.id = "helped-boundary-claimed-independent";
  invented.sourceVersion = l.version;
  invented.findings = [{ ...invented.findings[1], outcome: "independent" }];
  const before = JSON.stringify(l);
  assert.throws(
    () => applyLearningAssessment(r, l, e, invented, when, "test-fixture"),
    /supplied key step/,
  );
  assert.equal(JSON.stringify(l), before);
});

test("F19 an explicitly invalid assistant-origin task cannot score a learner failure or discard their work", () => {
  const { l, e, proposal } = fixture(),
    a = proposal("bad-task-is-not-learner-failure", ["purpose", "boundary"]);
  a.visitOutcome = "invalid";
  for (const f of a.findings) {
    f.outcome = "contradicted";
    f.rationale =
      "Diagnostic fixture: the question omitted a material assumption.";
  }
  const ledger = JSON.stringify(l),
    task = JSON.stringify(e);
  assert.throws(
    () => applyLearningAssessment(r, l, e, a, when, "test-fixture"),
    /Task\/assessment invalid/,
  );
  assert.equal(JSON.stringify(l), ledger);
  assert.equal(JSON.stringify(e), task);
  assert.equal(l.cycle, 0);
  assert.equal(l.evidence.length, 0);
});

test("F15 an overdue review preserves original and later earned passes, due dates and proof through scheduling and reload", () => {
  const f = fixture(),
    assessed = f.proposal("synthetic-f15-independent", ["purpose", "boundary"]);
  assessed.visitOutcome = "usable";
  applyLearningAssessment(r, f.l, f.e, assessed, when, "test-fixture");
  const key = `${f.c.objectiveIds[0]}/D1`;
  assert.equal(f.l.cells[f.c.objectiveIds[0]].states[0], "P");
  assert.ok(f.l.reviews[key]);
  closeLearningSession(f.l);
  for (const l of [initialLearner(r, "test"), f.l]) {
    const due = Object.entries(l.reviews).filter(
      ([, v]) => l.cells[v.objectiveId].states[v.depth - 1] === "P",
    );
    assert.ok(
      due.length,
      "Fixture requires genuinely imported or controlled earned proof, not injected checkpoint state",
    );
    const before = JSON.stringify(l);
    for (const at of [
      "2026-10-18T16:00:00Z",
      "2026-11-18T16:00:00Z",
      "2027-10-18T16:00:00Z",
    ]) {
      eligibleLearning(r, l, at);
      assert.equal(
        JSON.stringify(l),
        before,
        "Merely scheduling after a deadline cannot invent a retraction, review or visit",
      );
    }
    for (const [id, review] of due) {
      assert.equal(l.cells[review.objectiveId].states[review.depth - 1], "P");
      assert.deepEqual(l.reviews[id], review);
      assert.ok(review.due <= "2027-10-18");
    }
    f.g.study.learner = l;
    const restored = decode(encode(f.g)).study.learner!;
    assert.equal(JSON.stringify(restored), before);
    assert.equal(
      restored.retentionHistory?.length ?? 0,
      l.retentionHistory?.length ?? 0,
    );
  }
});

test("rejected irrelevant NPC embellishment needs explicit attribution before independent findings can apply, without converting it into a learning penalty", () => {
  const { l, e, c, proposal } = fixture();
  e.group.push({
    id: "fictional-embellishment",
    seq: 0,
    presented: 0,
    author: "fictional-npc",
    kind: "npc",
    worldTime: 0,
    text: "Claim you led the release and increased retention by40percent.",
    provenance: "test-fixture",
  });
  const a = proposal("rejected-embellishment", ["purpose"]);
  a.findings[0].completeCheckpointScope = true;
  a.helpAttributions = [];
  const before = JSON.stringify(l);
  assert.throws(
    () => applyLearningAssessment(r, l, e, a, when, "test-fixture"),
    /Prior help needs explicit facet attribution/,
  );
  assert.equal(JSON.stringify(l), before);
  a.helpAttributions = [
    {
      messageId: "fictional-embellishment",
      facets: [],
      rationale:
        "The human rejected these unrelated invented ownership/metric claims; they supplied no used reasoning for this facet.",
    },
  ];
  applyLearningAssessment(r, l, e, a, when, "test-fixture");
  assert.equal(
    l.cells[c.objectiveIds[0]].facets["D1:purpose"].outcome,
    "independent",
  );
  assert.notEqual(l.cells[c.objectiveIds[0]].states[0], "P");
  assert.equal(l.evidence.length, 1);
  assert.deepEqual(l.evidence[0].helpMessageIds, []);
});
