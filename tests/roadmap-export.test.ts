import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ensureFinalProgress } from "../src/final-requirements";
import {
  applyLearningAssessment,
  beginLearningAttempt,
  closeLearningSession,
  eligibleLearning,
  initialLearner,
  registerScopes,
} from "../src/learner";
import type { Assessment, Encounter, Roadmap } from "../src/model";
import { prepareRoadmapExport, sha256 } from "../src/roadmap-export";
import { reviewRoadmap } from "../src/roadmap-review";
import { createRecord } from "./helpers/record";
const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
const at = "2026-10-15T16:00:00.000Z";
// Isolated synthetic adapter fixtures: no real save or real human progress is
// written. Exercise the production export's live-mode guard and transaction path.
function fixture() {
  const l = initialLearner(r);
  const g = createRecord(7, r);
  let n = 0;
  function issue() {
    const e = Object.values(g.encounters)[n++],
      c = eligibleLearning(r, l, at);
    e.problem = {
      provenance: "study-mode",
      title: "SYNTHETIC_TASK_SECRET",
      prompt: "SYNTHETIC_PROMPT_SECRET",
      starter: "SYNTHETIC_CODE_SECRET",
      rubric: ["fixture"],
      contract: c,
      scopeDefinitions: [
        {
          id: `${c.objectiveIds[0]}/D${c.depth}`,
          objectiveId: c.objectiveIds[0],
          sourceScope: c.scopes[0],
          depth: c.depth,
          facets: [
            {
              id: "purpose",
              description: "Explain the mechanism and its purpose",
            },
            {
              id: "boundary",
              description: "Explain the relevant boundary behavior",
            },
          ],
        },
      ],
    };
    e.history = [1, 2].map((seq) => ({
      seq,
      at: seq,
      author: "human",
      kind: "reasoning",
      text: "SYNTHETIC_RESPONSE_SECRET",
      revision: 0,
      wallTime: at,
    }));
    registerScopes(r, l, e);
    beginLearningAttempt(r, l, e, at);
    return e;
  }
  function assess(
    e: Encounter,
    facets = ["purpose", "boundary"],
    usable = true,
    outcome: "independent" | "contradicted" = "independent",
  ) {
    const c = e.problem!.contract;
    const a: Assessment = {
      id: `synthetic-${l.version}-${n}`,
      encounter: e.id,
      provenance: "study-mode",
      sourceVersion: l.version,
      status: "pending",
      evidenceCutoffSequence: 2,
      visitOutcome: usable ? "usable" : "unresolved",
      scopeReviews: [
        {
          id: `${c.objectiveIds[0]}/D${c.depth}`,
          completeCoverage: true,
          rationale: "SYNTHETIC_SCOPE_RATIONALE_SECRET",
        },
      ],
      findings: facets.map((facet) => ({
        objectiveId: c.objectiveIds[0],
        facet,
        depth: c.depth,
        outcome,
        evidence: [facet === "purpose" ? 1 : 2],
        completeCheckpointScope: false,
        rationale: "SYNTHETIC_ANSWER_RATIONALE_SECRET",
      })),
    };
    applyLearningAssessment(r, l, e, a, at, "study-mode");
  }
  function nextOrdinary() {
    const first = issue();
    assess(first);
    const second = issue();
    assess(second);
    const third = issue();
    assert.equal(third.problem!.contract.objectiveIds[0], "PE:X09.1");
    assert.equal(third.problem!.contract.review, false);
    return third;
  }
  return { l, issue, assess, nextOrdinary };
}
function block(raw: string, name: string) {
  return raw
    .split(`<!-- BEGIN ${name} -->`)[1]
    .split(`<!-- END ${name} -->`)[0];
}
function part(raw: string, heading: string) {
  return raw.split(`### ${heading}\n`)[1].split("\n### ")[0];
}

test("roadmap export: administrative inspection returns exact original bytes; rejects synthetic and source-corrupt ledgers", async () => {
  const l = initialLearner(r);
  const out = await prepareRoadmapExport(r, l, undefined, at);
  assert.equal(out.content, r.raw);
  assert.equal(out.revision, 9);
  assert.equal(l.sessions.at(-1)?.id, "S0007");
  const synthetic = initialLearner(r, "test");
  await assert.rejects(prepareRoadmapExport(r, synthetic), /Synthetic/);
  await assert.rejects(
    prepareRoadmapExport({ ...r, raw: r.raw + "x" }, l),
    /integrity/,
  );
  l.sourceHash = "wrong";
  await assert.rejects(prepareRoadmapExport(r, l), /source mismatch/);
});

test("roadmap export: adding untouched final requirements to a legacy save cannot mint a revision", async () => {
  const f = fixture();
  const e = f.issue();
  f.assess(e);
  delete f.l.finalProgress;
  const before = await prepareRoadmapExport(r, f.l, undefined, at);
  ensureFinalProgress(r, f.l);
  const after = await prepareRoadmapExport(r, f.l, before, at);
  assert.equal(after.content, before.content);
  assert.equal(after.revision, before.revision);
  assert.equal(after.fingerprint, before.fingerprint);
});

test("roadmap export: complete source-preserving partial save, stable redownload, genuine parent hashes and unique shared IDs", async () => {
  const { l, assess, nextOrdinary } = fixture();
  const e = nextOrdinary();
  assess(e, ["purpose"], false);
  assert.equal(l.cells["PE:X09.1"].states[0], "U");
  const first = await prepareRoadmapExport(r, l, undefined, at);
  assert.equal(first.revision, 10);
  assert.equal(first.parentHash, r.sourceHash);
  assert.equal(first.hash, await sha256(first.content));
  const reviewed = await reviewRoadmap(r, r.raw, first.content);
  assert.equal(
    reviewed.ancestry,
    "direct-descendant",
    JSON.stringify(reviewed.issues),
  );
  assert.deepEqual(
    reviewed.issues.filter((i) => i.severity === "invalid"),
    [],
  );
  assert.ok(reviewed.changes.length > 0);

  for (const name of ["MERGE_RULES", "PY_CURRICULUM", "PE_CURRICULUM"])
    assert.equal(block(first.content, name), block(r.raw, name));
  assert.equal(r.raw, readFileSync("interview_prep_roadmap.md", "utf8"));
  for (const secret of [
    "SYNTHETIC_TASK_SECRET",
    "SYNTHETIC_PROMPT_SECRET",
    "SYNTHETIC_CODE_SECRET",
    "SYNTHETIC_RESPONSE_SECRET",
    "SYNTHETIC_SCOPE_RATIONALE_SECRET",
    "SYNTHETIC_ANSWER_RATIONALE_SECRET",
  ])
    assert.ok(!first.content.includes(secret), secret);
  const pe = block(first.content, "PE_PROGRESS");
  assert.match(
    part(pe, "0.4 Objective checkpoint ledger"),
    /\| X09.1 \| D3 \| U \| U \| U \| — \|/,
  );
  assert.match(
    part(pe, "0.12 Study semantic scope and continuation state"),
    /purpose \| Explain the mechanism and its purpose \| independent/,
  );
  assert.match(
    part(pe, "0.12 Study semantic scope and continuation state"),
    /boundary \| Explain the relevant boundary behavior \| unknown/,
  );
  assert.match(
    part(pe, "0.2 Breadth scheduler and resume packet"),
    /Remaining topics in current lap \| X09/,
  );
  assert.match(first.content, /S0008-A01/);
  assert.match(first.content, /S0008-A03/);
  assert.match(first.content, /S0008-EV05/);
  assert.match(
    part(
      block(first.content, "SHARED_PROGRESS"),
      "S0.4 Merged session history",
    ),
    /S0007 \| .*INTERRUPTED_AT_LAST_SAVE/,
  );
  const repeated = await prepareRoadmapExport(
    r,
    l,
    first,
    "2026-10-16T16:00:00.000Z",
  );
  assert.deepEqual(repeated, first);
  assess(e, ["boundary"]);
  assert.equal(l.cells["PE:X09.1"].states[0], "P");
  const second = await prepareRoadmapExport(r, l, first, at);
  assert.equal(second.revision, 11);
  assert.equal(second.parentHash, first.hash);
  assert.match(second.content, new RegExp(`parent_file_sha256: ${first.hash}`));
  assert.match(
    part(
      block(second.content, "SHARED_PROGRESS"),
      "S0.5 Merged revision history",
    ),
    /\| 10 \|/,
  );
  assert.match(
    part(
      block(second.content, "SHARED_PROGRESS"),
      "S0.5 Merged revision history",
    ),
    /\| 11 \|/,
  );
  const p2 = block(second.content, "PE_PROGRESS");
  assert.match(
    part(p2, "0.1 Learner profile and dashboard"),
    /9\/337; D1 9\/112/,
  );
  assert.match(
    part(p2, "0.1 Learner profile and dashboard"),
    /24\/24 tier-specific diagnostic obligations resolved/,
  );
  assert.match(
    part(p2, "0.2 Breadth scheduler and resume packet"),
    /W1 \/ L02/,
  );
  assert.match(
    part(p2, "0.4 Objective checkpoint ledger"),
    /\| X09.1 \| D3 \| P \| U \| U \| — \|/,
  );
  assert.match(part(p2, "0.2.1 Tier and gate board"), /Tier 2[^\n]+LOCKED/);
  assert.equal(second.gapIds["PE:X09.1/D1"], first.gapIds["PE:X09.1/D1"]);
  for (const t of ["PY", "PE"]) {
    const original = part(
      block(r.raw, `${t}_PROGRESS`),
      "0.5 Assessment evidence register",
    )
      .split("\n")
      .filter((line) => /^\| S\d{4}-EV/.test(line));
    const saved = part(
      block(second.content, `${t}_PROGRESS`),
      "0.5 Assessment evidence register",
    );
    for (const line of original)
      assert.ok(saved.includes(line), "historical evidence remains byte-exact");
    const ids = [...saved.matchAll(/^\| (S\d{4}-EV\d+) \|/gm)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length);
  }
});

test("roadmap export: rejects unproved passes, duplicate IDs, altered source scopes and corrupt cached parents atomically", async () => {
  const { l, issue, assess } = fixture();
  const e = issue();
  assess(e);
  const good = await prepareRoadmapExport(r, l, undefined, at);
  const invalidPass = structuredClone(l);
  invalidPass.cells["PE:X09.1"].states[0] = "P";
  await assert.rejects(prepareRoadmapExport(r, invalidPass), /Unsupported/);
  const duplicate = structuredClone(l);
  duplicate.evidence.push(duplicate.evidence[0]);
  await assert.rejects(prepareRoadmapExport(r, duplicate), /Duplicate/);
  const scope = structuredClone(l);
  Object.values(scope.scopes)[0].sourceScope = "wrong";
  await assert.rejects(prepareRoadmapExport(r, scope), /scope/);
  await assert.rejects(
    prepareRoadmapExport(r, l, { ...good, content: good.content + "tamper" }),
    /integrity/,
  );
  assert.equal(good.hash, await sha256(good.content));
});

test("roadmap export: reopened facet keeps siblings and history; session close does not invent a new visit", async () => {
  const { l, nextOrdinary, assess } = fixture();
  const e = nextOrdinary();
  assess(e);
  const one = await prepareRoadmapExport(r, l, undefined, at);
  assess(e, ["boundary"], false, "contradicted");
  const two = await prepareRoadmapExport(r, l, one, at);
  assert.equal(l.cells["PE:X09.1"].states[0], "R");
  const semantic = part(
    block(two.content, "PE_PROGRESS"),
    "0.12 Study semantic scope and continuation state",
  );
  assert.match(
    semantic,
    /purpose \| Explain the mechanism and its purpose \| independent/,
  );
  assert.match(
    semantic,
    /boundary \| Explain the relevant boundary behavior \| contradicted/,
  );
  const gaps = part(
    block(two.content, "PE_PROGRESS"),
    "0.6 Facet gaps, unknowns, and dependencies",
  );
  assert.match(
    gaps,
    /X09.1 \/ D1[^\n]+OPEN; partial independent facets are preserved/,
  );
  const n = l.attempts.length,
    cycle = l.cycle;
  closeLearningSession(l);
  const closed = await prepareRoadmapExport(r, l, two, at);
  assert.equal(l.attempts.length, n);
  assert.equal(l.cycle, cycle);
  assert.match(closed.content, /next shared attempt S0009-A01/);
  assert.match(
    part(
      block(closed.content, "SHARED_PROGRESS"),
      "S0.4 Merged session history",
    ),
    /S0008 \| .*closed/,
  );
});

test("roadmap export: original gaps close only at their checkpoint depth and reopen without losing source observations", async () => {
  const { l, nextOrdinary, issue, assess } = fixture();
  const third = nextOrdinary();
  assess(third);
  const py = issue();
  assert.equal(py.problem!.contract.objectiveIds[0], "PY:T11.1");
  assess(py);
  const first = await prepareRoadmapExport(r, l, undefined, at);
  const originalGaps = part(
    block(r.raw, "PY_PROGRESS"),
    "0.6 Facet gaps, unknowns, and dependencies",
  );
  const gaps = part(
    block(first.content, "PY_PROGRESS"),
    "0.6 Facet gaps, unknowns, and dependencies",
  );
  assert.match(
    gaps,
    /G0019[^\n]+CLOSED; full checkpoint independently verified/,
  );
  for (const line of originalGaps
    .split("\n")
    .filter((line) => /^\| G\d+ \| [TX]\d+\.\d+ \/ D2/.test(line)))
    assert.ok(gaps.includes(line), "D1 proof never closes a D2 gap");
  assess(py, ["boundary"], false, "contradicted");
  const second = await prepareRoadmapExport(r, l, first, at);
  const restored = part(
    block(second.content, "PY_PROGRESS"),
    "0.6 Facet gaps, unknowns, and dependencies",
  );
  const sourceGap = originalGaps
    .split("\n")
    .find((line) => line.startsWith("| G0019 |"))!;
  assert.ok(
    restored.includes(sourceGap),
    "reopening restores original observation and scope instead of keeping a stale closed row",
  );
  assert.match(
    restored,
    /T11.1 \/ D1[^\n]+OPEN; partial independent facets are preserved/,
  );
});

test("roadmap export: preview-only scope generation cannot create a revision; pending actual study retains semantic scope", async () => {
  const { l, issue, assess } = fixture();
  const e = issue();
  assess(e);
  const first = await prepareRoadmapExport(r, l, undefined, at);
  const c = eligibleLearning(r, l, at),
    preview = createRecord(99, r).encounters["question-0"];
  preview.problem = {
    title: "preview",
    prompt: "preview",
    starter: "",
    rubric: [],
    provenance: "study-mode",
    contract: c,
    scopeDefinitions: [
      {
        id: `${c.objectiveIds[0]}/D${c.depth}`,
        objectiveId: c.objectiveIds[0],
        depth: c.depth,
        sourceScope: c.scopes[0],
        facets: [
          {
            id: "pending-scope",
            description: "Explain the relevant source distinction",
          },
        ],
      },
    ],
  };
  registerScopes(r, l, preview);
  const repeated = await prepareRoadmapExport(
    r,
    l,
    first,
    "2026-10-16T16:00:00.000Z",
  );
  assert.deepEqual(repeated, first);
  beginLearningAttempt(r, l, preview, at);
  const pending = await prepareRoadmapExport(r, l, first, at);
  assert.equal(pending.revision, 11);
  assert.match(
    part(
      block(pending.content, "PE_PROGRESS"),
      "0.12 Study semantic scope and continuation state",
    ),
    /pending-scope \| Explain the relevant source distinction \| unknown/,
  );
  assert.equal(l.evidence.length, 2);
});

test("roadmap export: replacement patterns in facet text stay literal instead of expanding into the document", async () => {
  const { l, issue, assess } = fixture();
  const e = issue();
  const description =
    "Explain shell $$, the quoting forms $' and $`, and the regex token $&";
  const definition = e.problem!.scopeDefinitions![0];
  definition.facets[0].description = description;
  l.scopes[definition.id].facets[0].description = description;
  assess(e, ["purpose"], false);
  const saved = await prepareRoadmapExport(r, l, undefined, at);
  assert.ok(saved.content.includes(description));
  for (const name of ["SHARED_PROGRESS", "PY_PROGRESS", "PE_PROGRESS"])
    assert.equal(saved.content.split(`<!-- BEGIN ${name} -->`).length, 2);
  // Nothing but the projected rows grew: the document was not spliced into itself.
  assert.ok(saved.content.length < r.raw.length * 1.2);
  const again = await prepareRoadmapExport(r, l, saved, at);
  assert.equal(again.hash, saved.hash);
});
