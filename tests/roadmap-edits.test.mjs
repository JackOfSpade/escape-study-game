import assert from "node:assert/strict";
import test from "node:test";
import { validateAnswer } from "../scripts/lib/ai-contracts.mjs";
import {
  KEEP_LOCAL,
  applyRoadmapEdits,
  expandRoadmapReconciliation,
} from "../scripts/lib/roadmap-edits.mjs";

const local = [
  "# Roadmap",
  "revision: 1",
  "parent_file_sha256: aaa",
  "| id | scope |",
  "| S0 | shared |",
  "| S1 | shared |",
].join("\n");

test("applyRoadmapEdits applies ordered exact edits and preserves every other byte", () => {
  const edits = [
    { find: "revision: 1", replace: "revision: 2" },
    { find: "| S0 | shared |", replace: "| S0 | shared |\n| S1.1 | new |" },
    { find: "| S1.1 | new |", replace: "| S1.1 | reviewed |" },
    { find: "parent_file_sha256: aaa", replace: "parent_file_sha256: bbb" },
  ];
  assert.equal(
    applyRoadmapEdits(local, edits),
    [
      "# Roadmap",
      "revision: 2",
      "parent_file_sha256: bbb",
      "| id | scope |",
      "| S0 | shared |",
      "| S1.1 | reviewed |",
      "| S1 | shared |",
    ].join("\n"),
  );
});

test("applyRoadmapEdits deletes text when replace is empty", () => {
  assert.equal(
    applyRoadmapEdits(local, [{ find: "| S1 | shared |", replace: "" }]),
    local.replace("| S1 | shared |", ""),
  );
  assert.notEqual(
    applyRoadmapEdits(local, [{ find: "| S1 | shared |", replace: "" }]),
    local,
  );
});

test("applyRoadmapEdits rejects ambiguous, missing and malformed edits", () => {
  assert.throws(
    () => applyRoadmapEdits(local, [{ find: "| S", replace: "| X" }]),
    /edits\[0\]\.find occurs more than once/,
  );
  assert.throws(
    () => applyRoadmapEdits(local, [{ find: "absent row", replace: "x" }]),
    /edits\[0\]\.find does not occur/,
  );
  assert.throws(
    () => applyRoadmapEdits(local, [{ find: "revision: 1", replace: 5 }]),
    /edits\[0\]\.replace must be text/,
  );
  assert.throws(() => applyRoadmapEdits(local, []), /non-empty array/);
  assert.throws(
    () =>
      applyRoadmapEdits(local, [
        { find: "revision: 1", replace: "revision: 1" },
      ]),
    /unchanged/,
  );
});

test("expandRoadmapReconciliation turns edits into canonical and leaves other replies alone", () => {
  const kept = { outcome: KEEP_LOCAL, decisions: [], rationale: "local wins" };
  const expanded = expandRoadmapReconciliation(local, {
    requestId: "r",
    edits: [{ find: "revision: 1", replace: "revision: 3" }],
  });
  assert.equal(expanded.canonical, local.replace("revision: 1", "revision: 3"));
  assert.equal(expanded.requestId, "r");
  assert.equal("edits" in expanded, false);
  assert.equal(expandRoadmapReconciliation(local, kept), kept);
  const canonical = { requestId: "r", canonical: local };
  assert.equal(expandRoadmapReconciliation(local, canonical), canonical);
  assert.equal(expandRoadmapReconciliation(local, null), null);
});

const payload = {
  requestId: "request-1",
  localHash: "local-hash-1",
  candidateHash: "candidate-hash-1",
  local,
};
const job = { operation: "reconcile-roadmap", payload };
const answer = (extra = {}) => ({
  requestId: payload.requestId,
  localHash: payload.localHash,
  candidateHash: payload.candidateHash,
  definitions: [],
  mappings: [],
  completeScopes: [],
  decisions: [],
  rationale: "Incoming rows review; local rows preserved",
  ...extra,
});
const edits = [{ find: "revision: 1", replace: "revision: 2" }];

test("validateAnswer accepts an edits reply and a keep-local reply", () => {
  assert.doesNotThrow(() => validateAnswer(job, answer({ edits })));
  assert.doesNotThrow(() =>
    validateAnswer(job, answer({ outcome: KEEP_LOCAL })),
  );
});

test("validateAnswer rejects keep-local replies that still propose work", () => {
  assert.throws(
    () => validateAnswer(job, answer({ outcome: KEEP_LOCAL, edits })),
    /keep-local answer proposes no edits and no file/,
  );
  assert.throws(
    () =>
      validateAnswer(job, answer({ outcome: KEEP_LOCAL, canonical: local })),
    /keep-local answer proposes no edits and no file/,
  );
  assert.throws(
    () => validateAnswer(job, answer({ outcome: KEEP_LOCAL, decisions: {} })),
    /decisions array/,
  );
});

test("validateAnswer rejects edits that do not apply", () => {
  assert.throws(
    () =>
      validateAnswer(
        job,
        answer({ edits: [{ find: "absent row", replace: "x" }] }),
      ),
    /Roadmap edits do not apply to payload.local: edits\[0\]\.find does not occur/,
  );
  assert.throws(
    () =>
      validateAnswer(job, answer({ edits: [{ find: "| S", replace: "| X" }] })),
    /Roadmap edits do not apply to payload.local: edits\[0\]\.find occurs more than once/,
  );
  assert.throws(
    () => validateAnswer(job, answer({ edits: [] })),
    /Roadmap edits do not apply/,
  );
});

test("validateAnswer rejects the empty or null canonical a model returns", () => {
  assert.throws(
    () => validateAnswer(job, answer({ canonical: "" })),
    /Return edits that turn payload.local into the proposed file/,
  );
  assert.throws(
    () => validateAnswer(job, answer({ canonical: null })),
    /Return edits that turn payload.local into the proposed file/,
  );
  assert.throws(
    () => validateAnswer(job, answer({})),
    /Return edits that turn payload.local into the proposed file/,
  );
  assert.doesNotThrow(() =>
    validateAnswer(
      job,
      answer({ canonical: local.replace("revision: 1", "revision: 2") }),
    ),
  );
});
