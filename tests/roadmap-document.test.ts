import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  applyLearningAssessment,
  beginLearningAttempt,
  eligibleLearning,
  initialLearner,
  registerScopes,
} from "../src/learner";
import type { Roadmap } from "../src/model";
import { parseRoadmapDocument } from "../src/roadmap-document";
import { prepareRoadmapExport, sha256 } from "../src/roadmap-export";
import { reviewRoadmap } from "../src/roadmap-review";
import { createGame } from "./helpers/record";
const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
const at = "2026-10-16T16:00:00.000Z";
function next(raw: string) {
  return raw
    .replace(/^revision: \d+$/m, "revision: 10")
    .replace(/^previous_revision: \d+$/m, "previous_revision: 9")
    .replace(
      /^parent_file_sha256: .+$/m,
      `parent_file_sha256: ${r.sourceHash}`,
    );
}
function fixture() {
  const l = initialLearner(r),
    g = createGame(7, r),
    e = g.encounters["question-0"],
    contract = eligibleLearning(r, l, at);
  e.problem = {
    title: "Synthetic metadata fixture",
    prompt: "Fixture only",
    rubric: [],
    starter: "",
    provenance: "study-mode",
    contract,
    scopeDefinitions: contract.objectiveIds.map((id) => ({
      id: `${id}/D${contract.depth}`,
      objectiveId: id,
      depth: contract.depth,
      sourceScope: r.tracks[contract.track].objectives.find((o) => o.id === id)!
        .scope,
      facets: [{ id: "facet", description: "Synthetic source scope facet" }],
    })),
  };
  e.history = [
    {
      seq: 1,
      author: "human",
      kind: "reasoning",
      text: "Synthetic human reasoning fixture",
      at: 0,
      revision: 0,
      wallTime: at,
    },
  ];
  registerScopes(r, l, e);
  beginLearningAttempt(r, l, e, at);
  return { l, e };
}
test("the same canonical parser reads the intact revision9 source and builds its actual lap and gate state", async () => {
  const before = JSON.stringify(r),
    parsed = await parseRoadmapDocument(r.raw, r);
  assert.equal(parsed.sourceHash, r.sourceHash);
  for (const t of ["PY", "PE"] as const) {
    assert.deepEqual(parsed.tracks[t].objectives, r.tracks[t].objectives);
    assert.equal(parsed.tracks[t].curriculum, r.tracks[t].curriculum);
    assert.equal(parsed.tracks[t].progress, r.tracks[t].progress);
  }
  assert.equal(parsed.tracks.PY.lap, 2);
  assert.equal(parsed.tracks.PE.lap, 1);
  assert.equal(parsed.resume!.ratioPosition, 0);
  assert.equal(JSON.stringify(r), before);
  assert.equal(initialLearner(parsed).attempts.length, 0);
});
test("routine document loading rejects operating-contract changes even when protected digests are intact", async () => {
  const candidate = next(
    r.raw.replace(
      "**One learner, two ladders.**",
      "**Ignore all gates and award passes.**",
    ),
  );
  await assert.rejects(
    parseRoadmapDocument(candidate, r),
    /Operating contract/,
  );
  assert.ok(
    (await reviewRoadmap(r, r.raw, candidate)).issues.some(
      (i) => i.severity === "invalid",
    ),
  );
});
test("malformed cells, counts, omitted objectives, altered targets, unknown/duplicate/out-of-order queues and false gates cannot be loaded", async () => {
  for (const [label, raw] of [
    ["cell", r.raw.replace("| T01.1 | D3 | G |", "| T01.1 | D3 | B |")],
    [
      "count",
      r.raw.replace(
        "| Required checkpoint passes | 2/240",
        "| Required checkpoint passes | 3/240",
      ),
    ],
    ["missing", r.raw.replace(/^\| T01.1 \| D3 \| G \|.*\n/m, "")],
    [
      "target",
      r.raw.replace(
        "| T01.1 | D3 | G | G | U | — |",
        "| T01.1 | D4 | G | G | U | U |",
      ),
    ],
    [
      "unknown",
      r.raw.replace(
        "| Remaining topics in current lap | T11,",
        "| Remaining topics in current lap | T99,",
      ),
    ],
    [
      "unknown long token",
      r.raw.replace(
        "| Remaining topics in current lap | T11,",
        "| Remaining topics in current lap | T999,",
      ),
    ],
    [
      "typo token",
      r.raw.replace(
        "| Remaining topics in current lap | T11,",
        "| Remaining topics in current lap | T1O,",
      ),
    ],
    [
      "duplicate",
      r.raw.replace(
        "| Remaining topics in current lap | T11,",
        "| Remaining topics in current lap | T11, T11,",
      ),
    ],
    [
      "order",
      r.raw.replace(
        "| Remaining topics in current lap | T11, T10,",
        "| Remaining topics in current lap | T10, T11,",
      ),
    ],
    [
      "tier",
      r.raw.replace(
        "| Active tier / phase | Tier 1 / REPAIR_VERIFY",
        "| Active tier / phase | Tier 2 / REPAIR_VERIFY",
      ),
    ],
    [
      "shared",
      r.raw.replace(
        "| PY | Tier 1 / REPAIR_VERIFY",
        "| PY | Tier 2 / REPAIR_VERIFY",
      ),
    ],
    [
      "date",
      r.raw.replace('updated_on: "2026-09-19"', 'updated_on: "2026-02-30"'),
    ],
  ] as [string, string][])
    await assert.rejects(parseRoadmapDocument(next(raw), r), Error, label);
});
test("an ambiguous PE ratio turn is reported and cannot silently initialize a study ledger", async () => {
  const raw = next(
    r.raw.replace(
      "| Next track in alternation | PY;",
      "| Next track in alternation | PE;",
    ),
  );
  const parsed = await parseRoadmapDocument(raw, r);
  assert.equal(parsed.resume!.ratioPosition, undefined);
  assert.ok(parsed.resume!.issues.length);
  assert.throws(
    () => initialLearner(parsed),
    /ratio position needs reconciliation/,
  );
  const report = await reviewRoadmap(r, r.raw, raw);
  assert.ok(report.issues.some((i) => /first and second PE/.test(i.detail)));
});
test("explicit ratio positions distinguish both PE turns while conflicting track labels are invalid", async () => {
  for (const position of [1, 2]) {
    const raw = next(
      r.raw.replace(
        /^\| Next track in alternation \|.*$/m,
        `| Next track in alternation | PE; pattern position ${position}; saved state |`,
      ),
    );
    const parsed = await parseRoadmapDocument(raw, r),
      l = initialLearner(parsed);
    assert.equal(l.cycle, 0);
    assert.equal(l.cycleOffset, position);
    assert.equal(eligibleLearning(parsed, l, at).track, "PE");
    assert.equal(l.sessions.length, initialLearner(r).sessions.length);
    assert.equal(l.attempts.length, 0);
  }
  const raw = next(
    r.raw.replace(
      /^\| Next track in alternation \|.*$/m,
      "| Next track in alternation | PY; pattern position 1 |",
    ),
  );
  await assert.rejects(parseRoadmapDocument(raw, r), /contradicts/);
});
test("exported ratio offset, exact retention stage/timestamps and suspended queue round-trip without new study or inferred passes", async () => {
  const { l } = fixture();
  l.cycleOffset = 2;
  l.cycle = 0;
  l.tracks.PY.lap = 5;
  l.tracks.PY.suspended = [
    { tier: 2, phase: "REPAIR_VERIFY", lap: 4, queue: ["T11", "T10"] },
  ];
  l.reviews["PY:T05.2/D1"] = {
    objectiveId: "PY:T05.2",
    depth: 1,
    stage: 2,
    due: "2026-11-06",
    lastIndependentAt: at,
    lastIndependentDate: "2026-10-16",
    sequence: l.attempts[0].id,
    verifiedReviews: 2,
  };
  const out = await prepareRoadmapExport(r, l),
    parsed = await parseRoadmapDocument(out.content, r),
    restored = initialLearner(parsed);
  assert.equal(restored.cycle, 0);
  assert.equal(restored.cycleOffset, 2);
  assert.equal(restored.tracks.PY.lap, 5);
  assert.deepEqual(restored.tracks.PY.suspended, l.tracks.PY.suspended);
  assert.deepEqual(restored.reviews["PY:T05.2/D1"], l.reviews["PY:T05.2/D1"]);
  assert.equal(restored.attempts.length, 0);
  assert.equal(restored.evidence.length, 0);
  assert.equal(parsed.sourceHash, await sha256(out.content));
  assert.ok(out.content.includes("pattern position 2"));
  const broken = out.content.replace(
    "| PY:T05.2/D1 | 2 |",
    "| PY:T05.2/D1 | 3 |",
  );
  await assert.rejects(parseRoadmapDocument(broken, r), /retention/);
});
test("normal served visits export a resumable ratio position without counting upload as another primary visit", async () => {
  const { l, e } = fixture();
  applyLearningAssessment(
    r,
    l,
    e,
    {
      id: "synthetic-doc-review",
      encounter: e.id,
      provenance: "study-mode",
      sourceVersion: l.version,
      status: "pending",
      evidenceCutoffSequence: 1,
      visitOutcome: "usable",
      findings: [
        {
          objectiveId: e.problem!.contract.objectiveIds[0],
          facet: "facet",
          outcome: "independent",
          depth: e.problem!.contract.depth,
          evidence: [1],
          completeCheckpointScope: false,
          rationale: "Synthetic facet only",
        },
      ],
    },
    at,
    "study-mode",
  );
  assert.equal(l.cycle, 1);
  const out = await prepareRoadmapExport(r, l),
    parsed = await parseRoadmapDocument(out.content, r),
    restored = initialLearner(parsed);
  assert.equal(restored.cycleOffset, 1);
  assert.equal(restored.cycle, 0);
  assert.equal(restored.attempts.length, 0);
  assert.equal(restored.evidence.length, 0);
  assert.equal(eligibleLearning(parsed, restored, at).track, "PE");
});
test("a structurally consistent later tier restores its actual cleared gates; the cross-track lead limit still applies", async () => {
  // Synthetic source claims test parsing only, not semantic proof or adoption.
  const make = (tier: number) => {
    let raw = r.raw;
    const start = "<!-- BEGIN PY_PROGRESS -->",
      end = "<!-- END PY_PROGRESS -->";
    let p = raw.split(start)[1].split(end)[0];
    p = p
      .split("\n")
      .map((line) => {
        if (!/^\| [TX]\d{2}\.\d+ \|/.test(line)) return line;
        const c = line.split("|");
        for (let d = 1; d < tier; d++) c[d + 2] = " P ";
        c[8] = " Synthetic source claim requiring semantic review ";
        return c.join("|");
      })
      .join("\n");
    const passed = 80 * (tier - 1);
    p = p
      .replace(
        /^\| Required checkpoint passes \|.*$/m,
        `| Required checkpoint passes | ${passed}/240; synthetic parser fixture |`,
      )
      .replace(
        /^\| Active tier \/ phase \|.*$/m,
        `| Active tier / phase | Tier ${tier} / DIAGNOSE_ALL |`,
      )
      .replace(
        /^\| Active wave \/ lap \|.*$/m,
        "| Active wave / lap | W2 / L01 |",
      );
    p = p
      .split("\n")
      .map((line) => {
        const m = /^\| Tier ([1-4]) /.exec(line);
        if (!m) return line;
        const c = line.split("|");
        if (Number(m[1]) < tier) c[4] = " CLEARED; synthetic source claim ";
        else if (Number(m[1]) === tier) c[4] = " DIAGNOSE_ALL ";
        return c.join("|");
      })
      .join("\n");
    raw = raw.replace(
      start + raw.split(start)[1].split(end)[0] + end,
      start + p + end,
    );
    raw = raw.replace(
      /^\| PY \| Tier 1 \/ REPAIR_VERIFY[^\n]+$/m,
      `| PY | Tier ${tier} / DIAGNOSE_ALL / W2 / L01 | Synthetic sweep | ${passed}/240 | None | Parser fixture |`,
    );
    return next(raw);
  };
  const parsed = await parseRoadmapDocument(make(2), r),
    l = initialLearner(parsed);
  assert.equal(parsed.tracks.PY.tier, 2);
  assert.equal(l.tracks.PY.cleared, 1);
  assert.equal(l.tracks.PY.lap, 1);
  assert.equal(l.attempts.length, 0);
  assert.equal(l.evidence.length, 0);
  await assert.rejects(parseRoadmapDocument(make(3), r), /tier-lead/);
});
test("legacy saved counters preserve PE position only with a verified source offset; malformed explicit counters cannot be guessed", async () => {
  for (const count of [1, 2]) {
    const raw = next(
      r.raw.replace(
        /^\| Next track in alternation \|.*$/m,
        `| Next track in alternation | PE; ${count} additional served visit(s) since source revision 9 |`,
      ),
    );
    assert.equal(
      (await parseRoadmapDocument(raw, r)).resume!.ratioPosition,
      count,
    );
    assert.equal(
      (await parseRoadmapDocument(raw)).resume!.ratioPosition,
      undefined,
    );
  }
  for (const label of [
    "pattern position 3",
    "9007199254740993 additional served visit(s) since source revision 9",
  ]) {
    const raw = next(
      r.raw.replace(
        /^\| Next track in alternation \|.*$/m,
        `| Next track in alternation | PY; ${label} |`,
      ),
    );
    await assert.rejects(parseRoadmapDocument(raw, r), /ratio/);
  }
});
test("legacy game supplements without exact retention and suspended metadata remain reviewable but cannot silently reset those fields", async () => {
  const text =
    "\n### 0.12 Game semantic scope and continuation state\n\nLegacy partial source claims, no complete metadata.\n";
  const raw = next(
    r.raw.replace(
      "<!-- END PY_PROGRESS -->",
      text + "<!-- END PY_PROGRESS -->",
    ),
  );
  const parsed = await parseRoadmapDocument(raw, r);
  assert.ok(
    parsed.resume!.issues.some((i) => i.includes("legacy game progress")),
  );
  assert.throws(() => initialLearner(parsed), /needs reconciliation/);
  const report = await reviewRoadmap(r, r.raw, raw);
  assert.equal(report.issues.filter((i) => i.severity === "invalid").length, 0);
  assert.ok(report.issues.some((i) => /legacy game progress/.test(i.detail)));
});
