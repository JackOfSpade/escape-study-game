import assert from "node:assert/strict";
import test from "node:test";
import {
  progressDelta,
  summaryText,
  type MapSnapshot,
} from "../src/study-progress-reveal";

const snapshot = (
  topics: Record<string, [number, number, string]>,
  tiers: Record<string, [number, number]> = { "1": [0, 5] },
): MapSnapshot => ({
  tiers: Object.fromEntries(
    Object.entries(tiers).map(([k, [passed, total]]) => [k, { passed, total }]),
  ),
  topics: Object.fromEntries(
    Object.entries(topics).map(([k, [passed, total, status]]) => [
      k,
      { passed, total, status },
    ]),
  ),
});

test("a gained checkpoint is counted and summarised", () => {
  const before = snapshot({ "PY:a/D1": [0, 2, "unassessed"] });
  const after = snapshot({ "PY:a/D1": [1, 2, "partial"] }, { "1": [1, 5] });
  const delta = progressDelta(before, after);
  assert.equal(delta.gained, 1);
  assert.equal(delta.lost, 0);
  assert.equal(delta.topics.length, 1);
  assert.equal(delta.topics[0].key, "PY:a/D1");
  assert.equal(delta.topics[0].completed, false);
  assert.deepEqual(delta.tiers, [
    { tier: "1", from: { passed: 0, total: 5 }, to: { passed: 1, total: 5 } },
  ]);
  assert.equal(summaryText(delta), "+1 checkpoint verified");
});

test("completing a topic is flagged and mentioned", () => {
  const before = snapshot({
    "PY:a/D1": [0, 3, "gap"],
    "PY:b/D1": [1, 2, "partial"],
  });
  const after = snapshot({
    "PY:a/D1": [3, 3, "complete"],
    "PY:b/D1": [1, 2, "partial"],
  });
  const delta = progressDelta(before, after);
  assert.equal(delta.gained, 3);
  assert.deepEqual(
    delta.topics.map((t) => [t.key, t.completed]),
    [["PY:a/D1", true]],
  );
  assert.equal(
    summaryText(delta),
    "+3 checkpoints verified · 1 topic complete",
  );
});

test("a status-only change reports a topic to practise", () => {
  const delta = progressDelta(
    snapshot({ "PY:a/D1": [0, 2, "unassessed"] }),
    snapshot({ "PY:a/D1": [0, 2, "gap"] }),
  );
  assert.equal(delta.gained, 0);
  assert.equal(delta.lost, 0);
  assert.equal(delta.topics.length, 1);
  assert.equal(
    summaryText(delta),
    "Assessment saved · 1 topic marked to practise",
  );
});

test("a regression is counted as lost and asks for a recheck", () => {
  const delta = progressDelta(
    snapshot({ "PY:a/D1": [2, 3, "partial"] }),
    snapshot({ "PY:a/D1": [1, 3, "recheck"] }),
  );
  assert.equal(delta.gained, 0);
  assert.equal(delta.lost, 1);
  assert.equal(summaryText(delta), "1 checkpoint needs a recheck");
  const two = progressDelta(
    snapshot({ "PY:a/D1": [3, 3, "complete"] }),
    snapshot({ "PY:a/D1": [1, 3, "recheck"] }),
  );
  assert.equal(summaryText(two), "2 checkpoints need a recheck");
});

test("topics and tiers missing from the before snapshot are ignored", () => {
  const delta = progressDelta(
    snapshot({}, {}),
    snapshot({ "PY:new/D1": [1, 1, "complete"] }, { "2": [1, 1] }),
  );
  assert.deepEqual(delta, { gained: 0, lost: 0, topics: [], tiers: [] });
});

test("an unchanged map says nothing changed", () => {
  const same = snapshot({ "PY:a/D1": [1, 2, "partial"] });
  const delta = progressDelta(same, structuredClone(same));
  assert.deepEqual(delta, { gained: 0, lost: 0, topics: [], tiers: [] });
  assert.equal(summaryText(delta), "Assessment saved · no change this time");
});
