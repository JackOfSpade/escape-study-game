// Isolated synthetic learning fixtures; the user's original roadmap is never changed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  applyLearningAssessment,
  beginLearningAttempt,
  closeLearningSession,
  eligibleLearning,
  initialLearner,
  interruptLearningAttempt,
  registerScopes,
} from "../src/learner";
import type { Assessment, Encounter, Roadmap } from "../src/model";
import { reconcileRoadmap } from "../src/roadmap-adoption";
import { parseRoadmapDocument } from "../src/roadmap-document";
import { prepareRoadmapExport, sha256 } from "../src/roadmap-export";
import {
  allocationCounters,
  attemptDisposition,
  projectIdentifierCounters,
  readIdentifierCounters,
} from "../src/roadmap-identifiers";
import { reviewRoadmap } from "../src/roadmap-review";
import { createRecord } from "./helpers/record";
const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8")),
  at = "2026-10-16T16:00:00Z";
function fixture(source = r) {
  const g = createRecord(7, source),
    l = g.study.learner!;
  g.study.profile = "live";
  let n = 0;
  const issue = () => {
    const e = Object.values(g.encounters)[n++],
      c = eligibleLearning(source, l, at);
    e.problem = {
      title: `Synthetic fresh question ${n}`,
      prompt: "No actual learner certification",
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
            description: "Synthetic complete same-depth criterion",
          },
        ],
      })),
    };
    e.history = [
      {
        seq: 1,
        author: "human",
        kind: "reasoning",
        text: "Synthetic human technical artifact",
        at: 0,
        wallTime: at,
        revision: 0,
      },
    ];
    registerScopes(source, l, e);
    beginLearningAttempt(source, l, e, at);
    return e;
  };
  const assess = (e: Encounter, usable = true) => {
    const c = e.problem!.contract;
    const a: Assessment = {
      id: `synthetic-counters-${n}-${l.version}`,
      encounter: e.id,
      provenance: "study-mode",
      status: "pending",
      sourceVersion: l.version,
      evidenceCutoffSequence: 1,
      visitOutcome: usable ? "usable" : "unresolved",
      findings: c.objectiveIds.map((id) => ({
        objectiveId: id,
        depth: c.depth,
        facet: "scope",
        outcome: "assisted",
        evidence: [1],
        completeCheckpointScope: false,
        rationale: "Synthetic assisted observation, not independent proof",
      })),
    };
    applyLearningAssessment(source, l, e, a, at);
  };
  return { g, l, issue, assess };
}
const sourceRow = (raw: string, id: string) =>
  raw.split("\n").find((s) => s.startsWith(`| ${id} |`))!;
test("original counter claims remain exact, and mentions in ordinary prose never allocate identifiers", async () => {
  const original = readIdentifierCounters(r.raw).counters;
  assert.deepEqual(
    [
      original.nextSession,
      original.nextGap,
      original.nextDecision,
      original.attempts.S0007,
      original.evidence.S0007,
    ],
    [8, 49, 28, 3, 2],
  );
  const raw = r.raw.replace(
      "| Learner | Mid-level",
      "| Learner | Examples S0008-A99 S0008-EV99 G9999 DEC9999; Mid-level",
    ),
    source = { ...r, raw, sourceHash: await sha256(raw) };
  assert.deepEqual(readIdentifierCounters(raw).counters, original);
  const f = fixture(source),
    e = f.issue();
  assert.equal(f.l.attempts[0].id, "S0008-A01");
  const save = await prepareRoadmapExport(source, f.l);
  assert.match(
    save.content,
    /next shared attempt S0008-A02, evidence S0008-EV01/,
  );
  assert.equal(readIdentifierCounters(save.content).counters.nextGap, 49);
  assert.equal(e.problem!.contract.depth, 1);
});
test("the advertised next shared IDs are actually issued once, above saved floors rather than filling holes", async () => {
  const f = fixture(),
    old = f.issue();
  f.l.identifierCounters!.attempts.S0008 = 51;
  f.l.identifierCounters!.evidence.S0008 = 70;
  interruptLearningAttempt(f.l, old, at);
  const before = JSON.stringify(f.l),
    pending = await prepareRoadmapExport(r, f.l);
  assert.equal(JSON.stringify(f.l), before);
  assert.match(
    pending.content,
    /next shared attempt S0008-A51, evidence S0008-EV70/,
  );
  assert.match(
    sourceRow(pending.content, "S0008-A01"),
    /PENDING; INTERRUPTED_AT_LAST_SAVE/,
  );
  const next = f.issue();
  assert.equal(f.l.attempts.at(-1)!.id, "S0008-A51");
  const issued = await prepareRoadmapExport(r, f.l, pending);
  assert.match(
    sourceRow(issued.content, "S0008-A01"),
    /SUPERSEDED;.*S0008-A51/,
  );
  assert.match(sourceRow(issued.content, "S0008-A51"), /PENDING;/);
  f.assess(next);
  assert.equal(f.l.evidence[0].id, "S0008-EV70");
  const served = await prepareRoadmapExport(r, f.l, issued);
  assert.match(
    sourceRow(served.content, "S0008-A51"),
    /COMPLETED;.*not a checkpoint score/,
  );
  assert.match(
    served.content,
    /next shared attempt S0008-A52, evidence S0008-EV71/,
  );
  const parsed = await parseRoadmapDocument(served.content, r);
  assert.deepEqual(parsed.resume!.issues, []);
  assert.equal(parsed.resume!.identifierCounters!.attempts.S0008, 52);
});
test("partial, suspended and interrupted work uses curriculum dispositions without creating a pass or a replacement", async () => {
  const f = fixture(),
    e = f.issue();
  f.assess(e, false);
  const a = f.l.attempts[0],
    before = structuredClone(f.l.cells);
  assert.match(attemptDisposition(a, true), /^PARTIAL;/);
  a.status = "suspended";
  const save = await prepareRoadmapExport(r, f.l);
  assert.match(
    sourceRow(save.content, a.id),
    /PARTIAL; SUSPENDED by a reopened lower gate/,
  );
  assert.doesNotMatch(sourceRow(save.content, a.id), /SUPERSEDED/);
  assert.deepEqual(f.l.cells, before);
  assert.equal(f.l.cycle, 0);
});
test("closing a session advertises the exact first ID of the next actual session, and inspection consumes nothing", async () => {
  const f = fixture(),
    e = f.issue();
  f.assess(e);
  closeLearningSession(f.l);
  const before = JSON.stringify(f.l),
    save = await prepareRoadmapExport(r, f.l);
  assert.match(
    save.content,
    /S0009: next shared attempt S0009-A01, evidence S0009-EV01/,
  );
  assert.equal(JSON.stringify(f.l), before);
  const parsed = await parseRoadmapDocument(save.content, r),
    restored = initialLearner(parsed);
  assert.equal(
    restored.sessions.find((s) => s.id === "S0008")!.status,
    "closed",
  );
  assert.equal(
    restored.sessions.find((s) => s.id === "S0007")!.status,
    "INTERRUPTED_AT_LAST_SAVE",
  );
  const c = eligibleLearning(parsed, restored, at),
    next = {
      ...e,
      id: "new-restored-task",
      problem: { ...e.problem!, contract: c },
    };
  beginLearningAttempt(parsed, restored, next, at);
  assert.equal(restored.currentSession, "S0009");
  assert.equal(restored.attempts[0].id, "S0009-A01");
});
test("counter tables reject missing, duplicate, unknown, unsafe, lower or contradictory declarations", () => {
  const full = projectIdentifierCounters(
    r.raw,
    readIdentifierCounters(r.raw).counters,
  );
  for (const bad of [
    full.replace("| session | GLOBAL | 8 |\n", ""),
    full.replace(
      "| session | GLOBAL | 8 |",
      "| session | GLOBAL | 8 |\n| session | GLOBAL | 8 |",
    ),
    full.replace("| attempt | S0007 | 3 |\n", ""),
    full.replace("| session | GLOBAL | 8 |", "| whatever | GLOBAL | 8 |"),
    full.replace("| gap | GLOBAL | 49 |", "| gap | GLOBAL | 0 |"),
    full.replace(
      "| attempt | S0007 | 3 |",
      "| attempt | S0007 | 9007199254740992 |",
    ),
    full.replace("| attempt | S0007 | 3 |", "| attempt | S0007 | 2 |"),
    full.replace(
      "next shared attempt S0007-A03",
      "next shared attempt S0007-A90",
    ),
    full.replace(
      "### S0.7 Shared identifier counters\n",
      "### S0.7 Shared identifier counters\nUnrecognized reservation instructions\n",
    ),
  ])
    assert.throws(
      () => readIdentifierCounters(bad),
      /counter|identifier|progress row/i,
    );
});
test("unfamiliar saved counter prose requires reconciliation and cannot silently reset allocation", async () => {
  const raw = r.raw.replace(
      sourceRow(r.raw, "Reserved next identifiers (shared counters)"),
      "| Reserved next identifiers (shared counters) | Unclear next values; do not guess |",
    ),
    parsed = await parseRoadmapDocument(raw, r);
  assert.ok(
    parsed.resume!.issues.some((s) => s.includes("identifier counters")),
  );
  assert.throws(() => initialLearner(parsed), /reconcil/);
});
test("older projection counters and engine labels migrate to a new child revision without modifying evidence or allocating study", async () => {
  const f = fixture(),
    e = f.issue();
  f.assess(e);
  const current = await prepareRoadmapExport(r, f.l),
    row = sourceRow(current.content, "S0008-A01"),
    c = row
      .split("|")
      .slice(1, -1)
      .map((s) => s.trim());
  c[3] = "SERVED";
  const content = current.content
    .replace(row, `| ${c.join(" | ")} |`)
    .replace(
      /### S0\.7 Shared identifier counters\n[\s\S]*?(?=<!-- END SHARED_PROGRESS -->)/,
      "",
    )
    .replace("next shared attempt S0008-A02", "next shared attempt S0008-A01");
  const legacy = {
      ...current,
      content,
      hash: await sha256(content),
      fingerprint: "older-projection-format",
    },
    before = JSON.stringify(f.l);
  const fixed = await prepareRoadmapExport(r, f.l, legacy);
  assert.equal(fixed.parentHash, legacy.hash);
  assert.equal(fixed.revision, current.revision + 1);
  assert.match(sourceRow(fixed.content, "S0008-A01"), /COMPLETED;/);
  assert.match(fixed.content, /next shared attempt S0008-A02/);
  assert.equal(JSON.stringify(f.l), before);
  assert.equal(
    fixed.content
      .split("### 0.5 Assessment evidence register")[1]
      .split("### 0.5.1")[0],
    current.content
      .split("### 0.5 Assessment evidence register")[1]
      .split("### 0.5.1")[0],
  );
  assert.equal(
    (await prepareRoadmapExport(r, f.l, fixed)).content,
    fixed.content,
  );
  assert.ok(legacy.content.includes("| SERVED |"));
});
test("native reconciliation cannot lower an unconsumed saved counter floor", async () => {
  const f = fixture();
  f.issue();
  f.l.identifierCounters!.attempts.S0008 = 30;
  const local = await prepareRoadmapExport(r, f.l);
  f.g.study.roadmapExport = local;
  const incoming = local.content
    .replace(/^revision: 10$/m, "revision: 11")
    .replace(/^previous_revision: 9$/m, "previous_revision: 10")
    .replace(/^parent_file_sha256: .+$/m, `parent_file_sha256: ${local.hash}`)
    .replace("next shared attempt S0008-A30", "next shared attempt S0008-A02")
    .replace("| attempt | S0008 | 30 |", "| attempt | S0008 | 2 |");
  await reconcileRoadmap(f.g, r, incoming, async (p) => ({
    requestId: p.requestId,
    localHash: p.localHash,
    candidateHash: p.candidateHash,
    canonical: p.candidate,
    definitions: [],
    mappings: [],
    completeScopes: [],
    decisions: (await reviewRoadmap(r, p.local, p.candidate)).changes
      .filter((c) => c.conflict)
      .map((c) => ({
        key: c.key,
        choice: "incoming",
        rationale: "Synthetic attempted counter rollback",
      })),
    rationale: "Synthetic floor test",
  }));
  const job = f.g.study.roadmapReconciliations![0];
  assert.equal(job.state, "error");
  assert.match(job.error!, /lowered.*counter/);
  assert.equal(f.l.identifierCounters!.attempts.S0008, 30);
});
test("identifier range exhaustion does not close the old session or allocate a new task", () => {
  const f = fixture();
  f.l.identifierCounters = allocationCounters(r, f.l);
  f.l.identifierCounters.nextSession = 10000;
  const before = JSON.stringify(f.l.sessions);
  assert.throws(() => f.issue(), /range exhausted/);
  assert.equal(JSON.stringify(f.l.sessions), before);
  assert.equal(f.l.attempts.length, 0);
});
