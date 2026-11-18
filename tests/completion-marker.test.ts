import assert from "node:assert/strict";
import test from "node:test";
import type { Encounter } from "../src/model";
import { completionMarkerIndex } from "../src/terminal-panels";

const question = (
  state: Encounter["state"],
  messageSeqs: number[],
  accepted?: number,
) =>
  ({
    state,
    tutor: messageSeqs.map((seq) => ({ seq })),
    submissions: accepted === undefined ? [] : [{ id: "s", seq: accepted }],
    accepted: accepted === undefined ? undefined : "s",
  }) as unknown as Encounter;

test("an unfinished question has no completion marker", () => {
  assert.equal(
    completionMarkerIndex(question("in-progress", [1, 2])),
    undefined,
  );
});

test("the marker follows the reply that finished the question", () => {
  assert.equal(completionMarkerIndex(question("consumed", [1, 2, 3], 4)), 3);
});

test("discussion after completion stays below the marker", () => {
  assert.equal(
    completionMarkerIndex(question("consumed", [1, 2, 3, 6, 7], 4)),
    3,
  );
});

test("a finished record without its accepted answer is marked at the end", () => {
  assert.equal(completionMarkerIndex(question("consumed", [1, 2])), 2);
});
