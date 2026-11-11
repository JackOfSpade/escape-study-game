import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildRoadmapCases,
  RECONCILE_OPERATION,
  writeRoadmapCases,
} from "../scripts/ai-capture/build-roadmap-cases";
// @ts-expect-error Local .mjs module is exercised directly without a declaration shim.
import { buildPrompt } from "../scripts/claude-gateway.mjs";

const CASES = buildRoadmapCases({ count: 6 });

/** Recorded observations (assessment evidence rows) that name one objective. */
function objectiveObservations(document: string, objective: string) {
  return document
    .split("\n")
    .filter(
      (line) =>
        /^\| S\d+-EV\d+ \|/.test(line) && line.includes(`| ${objective} |`),
    );
}

test("buildRoadmapCases builds six distinct reconcile-roadmap payloads", async () => {
  const cases = await CASES;
  assert.equal(cases.length, 6);
  assert.equal(new Set(cases.map((item) => item.id)).size, 6);
  assert.equal(
    new Set(cases.map((item) => JSON.stringify(item.payload))).size,
    6,
    "every conflict must produce a distinct payload",
  );
  assert.equal(
    new Set(cases.map((item) => item.payload.candidate)).size,
    6,
    "every conflict must produce a distinct candidate document",
  );
  assert.equal(
    new Set(cases.map((item) => item.payload.local)).size,
    1,
    "only the candidate revision may vary between cases",
  );
  for (const item of cases) {
    assert.equal(item.operation, RECONCILE_OPERATION);
    for (const key of [
      "provider",
      "requestId",
      "sourceHash",
      "localHash",
      "candidateHash",
      "localVersion",
      "local",
      "candidate",
      "context",
      "instruction",
    ])
      assert.ok(key in item.payload, `${item.id} payload lacks ${key}`);
    assert.ok(item.payload.local.length > 100000);
    assert.ok(item.payload.candidate.length > 100000);
    assert.notEqual(
      item.payload.local,
      item.payload.candidate,
      `${item.id} local and candidate documents are identical`,
    );
  }
});

test("every payload is accepted by buildPrompt", async () => {
  const cases = await CASES;
  for (const item of cases) {
    const prompt = buildPrompt(item.operation, item.payload);
    assert.equal(typeof prompt.system, "string");
    assert.equal(typeof prompt.user, "string");
    assert.ok(prompt.system.length > 0, `${item.id} has no system prompt`);
    const sent = JSON.parse(prompt.user) as {
      local: string;
      candidate: string;
    };
    assert.equal(sent.local, item.payload.local, `${item.id} local document`);
    assert.equal(
      sent.candidate,
      item.payload.candidate,
      `${item.id} candidate document`,
    );
  }
});

test("one case removes the recorded observations behind an evidenced objective", async () => {
  const cases = await CASES;
  const removal = cases.find((item) =>
    item.id.endsWith("remove-objective-observations"),
  );
  assert.ok(removal, "no observation-removal case was built");
  const local = objectiveObservations(removal.payload.local, "T01.2");
  assert.ok(local.length > 0, "local roadmap records no T01.2 observations");
  assert.deepEqual(
    objectiveObservations(removal.payload.candidate, "T01.2"),
    [],
    "candidate still carries T01.2 observations",
  );
  // The builder keeps the objective roster and checkpoint rows intact, so the
  // conflict is the deletion of the evidence those rows depend on.
  for (const document of [removal.payload.local, removal.payload.candidate])
    assert.ok(
      document.split("\n").some((line) => line.startsWith("| T01.2 | D3 |")),
      "T01.2 checkpoint row missing",
    );
});

test("writeRoadmapCases keeps output private and merges index.json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roadmap-cases-"));
  try {
    writeFileSync(
      join(dir, "index.json"),
      `${JSON.stringify({ "materialize-work": 4 })}\n`,
    );
    const { cases, index } = await writeRoadmapCases(dir, 2);
    assert.equal(cases.length, 2);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    const file = join(dir, `${RECONCILE_OPERATION}.json`);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "index.json")).mode & 0o777, 0o600);
    assert.deepEqual(index, {
      "materialize-work": 4,
      [RECONCILE_OPERATION]: 2,
    });
    const written = JSON.parse(readFileSync(file, "utf8")) as unknown[];
    assert.equal(written.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
