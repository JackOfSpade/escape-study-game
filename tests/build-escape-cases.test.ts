import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEscapeCases,
  OPERATIONS,
  payloadFingerprint,
  type Operation,
} from "../scripts/ai-capture/build-escape-cases";

let book: Awaited<ReturnType<typeof buildEscapeCases>> | undefined;

async function built() {
  book ??= await buildEscapeCases({ perOp: 3, seedBase: 41 });
  return book;
}

test("every escape operation builds valid, distinct ladder cases", async () => {
  const cases = await built();
  const ids = new Set<string>();
  for (const operation of OPERATIONS) {
    const entries = cases[operation];
    assert.ok(entries.length >= 1, `${operation} captured no cases`);
    assert.equal(
      new Set(entries.map((entry) => entry.id)).size,
      entries.length,
    );
    const fingerprints = new Set(
      entries.map((entry) => payloadFingerprint(entry.payload)),
    );
    assert.equal(
      fingerprints.size,
      entries.length,
      `${operation} captured duplicate payloads`,
    );
    for (const entry of entries) {
      assert.equal(entry.operation, operation);
      assert.ok(
        entry.id.startsWith(`${operation}-`),
        `${entry.id} is not tagged with ${operation}`,
      );
      assert.ok(!ids.has(entry.id), `duplicate case id ${entry.id}`);
      ids.add(entry.id);
      const payload = entry.payload as Record<string, unknown>;
      assert.equal(typeof payload, "object");
      assert.ok(!Array.isArray(payload), `${entry.id} payload is an array`);
      assert.ok(
        Object.keys(payload).length > 0,
        `${entry.id} has an empty payload`,
      );
    }
  }
});

test("escape-converse covers first lines and ongoing replies", async () => {
  const entries = (await built())["escape-converse"];
  const first = entries.filter((entry) => entry.id.endsWith("-first"));
  const reply = entries.filter((entry) => entry.id.endsWith("-reply"));
  assert.ok(first.length >= 1, "no first-line conversation case");
  assert.ok(reply.length >= 1, "no ongoing-reply conversation case");
  assert.ok(
    first.some((entry) => (entry.payload as { reason?: unknown }).reason),
    "first-line cases carry a reason",
  );
});

test("every case names a known escape operation and nothing else", async () => {
  const cases = await built();
  const known = new Set<string>(OPERATIONS);
  const seen = new Set<Operation>();
  for (const [operation, entries] of Object.entries(cases))
    for (const entry of entries) {
      assert.ok(known.has(operation));
      assert.ok(known.has(entry.operation));
      seen.add(entry.operation);
    }
  assert.deepEqual([...seen].sort(), [...OPERATIONS].sort());
});
