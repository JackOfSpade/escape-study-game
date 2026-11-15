import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  RUN_DESIGN_SUMMARY_LIMIT,
  parseRunDesign,
  parseRunDesignRequest,
  runDesignNoveltyErrors,
  summarizeRunDesign,
  type RunDesign,
} from "../src/run-design-contract.mjs";
import { recentDesigns } from "../src/run-designer";

const HISTORY_KEY = "dead-air-run-design-history-v1";
const fixture = () =>
  JSON.parse(
    readFileSync("tests/fixtures/run-designs/mars-habitat.json", "utf8"),
  );
/** A full cast: 24 distinct pairs, each with the longest allowed detail. */
function crowded() {
  const design = fixture();
  const names: string[] = design.roster.map((a: { name: string }) => a.name);
  design.relationships = Array.from({ length: 24 }, (_, i) => ({
    from: names[i % 19],
    to: names[(i + 1 + Math.floor(i / 19)) % 19],
    kind: "colleague",
    detail: `${i} `.padEnd(
      120,
      "shared a long night shift and never quite forgave it ",
    ),
  }));
  return parseRunDesign(design) as RunDesign;
}
function withHistory(value: string, run: () => void) {
  const previous = Reflect.get(globalThis, "localStorage");
  Reflect.set(globalThis, "localStorage", {
    getItem: (key: string) => (key === HISTORY_KEY ? value : null),
  });
  try {
    run();
  } finally {
    if (previous === undefined)
      Reflect.deleteProperty(globalThis, "localStorage");
    else Reflect.set(globalThis, "localStorage", previous);
  }
}

test("a design with a full cast summarises into history a later request accepts", () => {
  const summary = summarizeRunDesign(crowded());
  // The live failure: the old limit was 3,500 and a real cast reached 3,925.
  assert.ok(summary.cast.length > 3500);
  for (const key of ["spatial", "atmosphere", "cast", "tempo"] as const)
    assert.ok(summary[key].length <= RUN_DESIGN_SUMMARY_LIMIT);
  withHistory(JSON.stringify([summary]), () =>
    assert.deepEqual(recentDesigns(), [summary]),
  );
});

test("a repeated full-cast design is still caught by the novelty check", () => {
  const design = crowded();
  const errors = runDesignNoveltyErrors(design, [summarizeRunDesign(design)]);
  assert.ok(errors.some((e) => /new title and premise/.test(e)));
  assert.ok(errors.some((e) => /building\/floor arrangement/.test(e)));
});

test("one unreadable history entry does not hide the readable ones", () => {
  const good = summarizeRunDesign(parseRunDesign(fixture()) as RunDesign);
  const other = { ...good, title: "Another Place" };
  const broken = { ...good, title: "Too Long", cast: "x".repeat(40000) };
  withHistory(JSON.stringify([good, broken, { title: 3 }, other]), () =>
    assert.deepEqual(recentDesigns(), [good, other]),
  );
  withHistory("not json", () => assert.deepEqual(recentDesigns(), []));
  withHistory('{"title":"x"}', () => assert.deepEqual(recentDesigns(), []));
});

test("a request rejects a summary field beyond the limit", () => {
  const big = summarizeRunDesign(parseRunDesign(fixture()) as RunDesign);
  assert.throws(() =>
    parseRunDesignRequest({
      version: 1,
      requestId: "design-history",
      generationId: "design-history",
      seed: 0,
      recent: [{ ...big, cast: "x".repeat(RUN_DESIGN_SUMMARY_LIMIT + 1) }],
    }),
  );
});
