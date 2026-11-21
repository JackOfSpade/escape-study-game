import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Roadmap } from "../src/model";
import { sha256 } from "../src/roadmap-export";
import { reviewRoadmap } from "../src/roadmap-review";
const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
function revision(raw: string, parent: string, n = 10) {
  return raw
    .replace(/^revision: \d+$/m, `revision: ${n}`)
    .replace(/^previous_revision: \d+$/m, `previous_revision: ${n - 1}`)
    .replace(/^parent_file_sha256: .+$/m, `parent_file_sha256: "${parent}"`);
}
test("roadmap review preserves exact source, awards nothing and recognizes unchanged bytes", async () => {
  const before = JSON.stringify(r);
  const report = await reviewRoadmap(r, r.raw, r.raw);
  assert.equal(report.ancestry, "identical");
  assert.equal(report.changes.length, 0);
  assert.equal(report.issues.filter((i) => i.severity === "invalid").length, 0);
  assert.equal(JSON.stringify(r), before);
});
test("roadmap review verifies actual complete parent rather than revision alone", async () => {
  const incoming = revision(r.raw, r.sourceHash);
  assert.equal(
    (await reviewRoadmap(r, r.raw, incoming)).ancestry,
    "direct-descendant",
  );
  assert.equal(
    (await reviewRoadmap(r, r.raw, revision(r.raw, "0".repeat(64)))).ancestry,
    "unproven",
  );
  assert.equal(
    (await reviewRoadmap(r, r.raw, revision(r.raw, r.sourceHash, 12))).ancestry,
    "unproven",
  );
  const next = revision(incoming, await sha256(incoming), 11);
  assert.equal(
    (await reviewRoadmap(r, incoming, next)).ancestry,
    "direct-descendant",
  );
});
test("roadmap review reports sibling edits, collisions, deletions and distinct row additions without merging", async () => {
  const local = revision(
    r.raw.replace("| Learner |", "| Local learner |"),
    r.sourceHash,
  );
  const incoming = revision(
    r.raw.replace("| Learner |", "| Incoming learner |"),
    r.sourceHash,
  );
  const result = await reviewRoadmap(r, local, incoming);
  assert.equal(result.ancestry, "sibling");
  assert.ok(result.issues.some((i) => /collides/.test(i.detail)));
  assert.ok(
    result.changes.some(
      (c) => c.key.endsWith("/Learner") && c.incoming === undefined,
    ),
  );
  assert.ok(
    result.changes.some((c) => c.key.endsWith("/Local learner") && c.local),
  );
  const a = revision(
    r.raw.replace("| Learner | Mid-level", "| Learner | Local"),
    r.sourceHash,
  );
  const b = revision(
    r.raw.replace("| Learner | Mid-level", "| Learner | Incoming"),
    r.sourceHash,
  );
  assert.ok(
    (await reviewRoadmap(r, a, b)).changes.some(
      (c) => c.conflict && c.key.endsWith("/Learner"),
    ),
  );
});
test("roadmap review rejects malformed identity, schema, markers and row ambiguity", async () => {
  const mutations = [
    r.raw.replace("document_id: interview_prep_roadmap", "document_id: other"),
    r.raw.replace('merge_schema_version: "1.0"', 'merge_schema_version: "2.0"'),
    r.raw.replace("revision: 9", "revision: 9\nrevision: 10"),
    r.raw.replace("<!-- END PY_PROGRESS -->", ""),
    r.raw + "\n<!-- BEGIN PY_PROGRESS -->\n",
    r.raw.replace("<!-- BEGIN PY_PROGRESS -->", "<!-- BEGIN PROGRESS -->"),
    r.raw.replace(
      "| Learner | Mid-level",
      "| Learner | duplicate |\n| Learner | Mid-level",
    ),
    r.raw.replace(/^revision: 9$/m, "revision: NaN"),
  ];
  for (const raw of mutations)
    assert.ok(
      (await reviewRoadmap(r, r.raw, raw)).issues.some(
        (i) => i.severity === "invalid",
      ),
    );
});
test("roadmap review rejects protected changes even with recomputed candidate digest", async () => {
  const raw = r.raw.replace(
    "<!-- BEGIN MERGE_RULES -->\n",
    "<!-- BEGIN MERGE_RULES -->\nUnauthorized policy\n",
  );
  const block = raw
    .split("<!-- BEGIN MERGE_RULES -->\n")[1]
    .split("<!-- END MERGE_RULES -->")[0];
  const candidate = raw.replace(
    /^merge_rules_sha256: .+$/m,
    `merge_rules_sha256: "${await sha256(block)}"`,
  );
  assert.ok(
    (await reviewRoadmap(r, r.raw, raw)).issues.some((i) =>
      /Digest mismatch/.test(i.detail),
    ),
  );
  assert.ok(
    (await reviewRoadmap(r, r.raw, candidate)).issues.some((i) =>
      /Protected MERGE_RULES changed/.test(i.detail),
    ),
  );
  await assert.rejects(
    reviewRoadmap({ ...r, raw: r.raw + "x" }, r.raw, candidate),
    /integrity/,
  );
});
test("roadmap review surfaces historical evidence modification for review", async () => {
  const row = r.tracks.PY.progress
    .split("### 0.5 Assessment evidence register")[1]
    .split("\n")
    .find((l) => /^\| S\d+-EV/.test(l));
  assert.ok(row);
  const incoming = revision(
    r.raw.replace(row, row.replace(/\|$/, "changed |")),
    r.sourceHash,
  );
  const result = await reviewRoadmap(r, r.raw, incoming);
  assert.ok(result.issues.some((i) => /Historical evidence/.test(i.detail)));
});

test("roadmap review keeps multiple facets and successive historical receipts distinct", async () => {
  // The legacy 0.12 heading on purpose: files saved by earlier builds carry it.
  const supplement = `\n### 0.12 Game semantic scope and continuation state\n\n| Scope | Facet | Semantic criterion |\n|---|---|---|\n| PY:T01.1/D1 | purpose | Purpose |\n| PY:T01.1/D1 | boundary | Boundary |\n\n| Scope | Facet | Assessment receipt |\n|---|---|---|\n| PY:T01.1/D1 | purpose | first |\n| PY:T01.1/D1 | purpose | corrected |\n\n`;
  const candidate = revision(
    r.raw.replace(
      "<!-- END PY_PROGRESS -->",
      supplement + "<!-- END PY_PROGRESS -->",
    ),
    r.sourceHash,
  );
  const report = await reviewRoadmap(r, r.raw, candidate);
  assert.equal(report.ancestry, "direct-descendant");
  assert.deepEqual(
    report.issues.filter((i) => i.severity === "invalid"),
    [],
  );
  assert.ok(report.changes.some((c) => c.key.endsWith("/purpose/first")));
  assert.ok(report.changes.some((c) => c.key.endsWith("/purpose/corrected")));
  const duplicate = candidate.replace(
    "| PY:T01.1/D1 | purpose | corrected |",
    "| PY:T01.1/D1 | purpose | first |",
  );
  assert.ok(
    (await reviewRoadmap(r, r.raw, duplicate)).issues.some((i) =>
      /Duplicate progress row/.test(i.detail),
    ),
  );
});
