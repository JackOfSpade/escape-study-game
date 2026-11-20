import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decode, encode, load, recover } from "../src/persistence";

/**
 * `tests/fixtures/legacy-save/save.json` is a synthetic save written by the
 * earlier escape-game build: its full record (building, survivors, zombies,
 * run design, escape state) with a non-trivial learning record inside it.
 * `learning-record.json` is what that build's own loader returned for it. The
 * learning record must load identically here, and the legacy fields must come
 * back out of a save byte for byte.
 */
const stored = readFileSync("tests/fixtures/legacy-save/save.json", "utf8");
const expected = JSON.parse(
  readFileSync("tests/fixtures/legacy-save/learning-record.json", "utf8"),
);
/** What the study workspace reads or writes; every other field is legacy. */
const STUDY_FIELDS = [
  "schema",
  "id",
  "seq",
  "time",
  "encounters",
  "study",
  "settings",
  "notice",
  "lastStudyEncounter",
  "studyWorkspace",
];
const stripEnvelope = (data: string) =>
  JSON.parse(JSON.parse(data).payload) as Record<string, unknown>;

test("a save written by the earlier escape-game build loads with its learning record intact", () => {
  const g = recover(decode(JSON.parse(stored).data));
  for (const key of Object.keys(expected))
    assert.deepEqual(
      JSON.parse(
        JSON.stringify((g as unknown as Record<string, unknown>)[key]),
      ),
      expected[key],
      `${key} differs from what the earlier build loaded`,
    );
  // The record is substantial: questions, conversations, evidence, retention.
  assert.ok(Object.keys(g.encounters).length >= 5);
  assert.ok(g.study.learner!.evidence.length >= 1);
  assert.ok(g.study.learner!.retentionHistory!.length >= 1);
  assert.ok(g.study.assessments.length >= 2);
  assert.ok(g.study.archives.length >= 1);
  assert.ok(g.study.knowledgeGaps!.length >= 1);
  assert.ok(g.study.environmentObservations!.length >= 1);
});

test("saving again writes every legacy field back unchanged", () => {
  const original = stripEnvelope(JSON.parse(stored).data);
  const g = recover(decode(JSON.parse(stored).data));
  const written = stripEnvelope(encode(g));
  const legacy = Object.keys(original).filter((k) => !STUDY_FIELDS.includes(k));
  for (const key of ["floors", "survivors", "zombies", "design", "escape"])
    assert.ok(legacy.includes(key), `fixture lacks the ${key} field`);
  for (const key of legacy)
    assert.equal(
      JSON.stringify(written[key]),
      JSON.stringify(original[key]),
      `${key} changed`,
    );
  // Nothing is added besides what the study record already held.
  assert.deepEqual(
    Object.keys(written).filter((k) => !(k in original)),
    [],
  );
  // And the result is a valid save that loads to the same learning record.
  const again = recover(decode(encode(g)));
  assert.deepEqual(again.study, g.study);
  assert.deepEqual(again.encounters, g.encounters);
});

test("the stored copy goes through load() like any save", async () => {
  const durable = stored;
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open() {
        const db = {
          transaction() {
            const tx = {} as IDBTransaction;
            Object.assign(tx, {
              objectStore: () => ({
                get() {
                  const req = { result: durable } as IDBRequest;
                  queueMicrotask(() => {
                    req.onsuccess?.call(req, new Event("success"));
                    tx.oncomplete?.call(tx, new Event("complete"));
                  });
                  return req;
                },
              }),
            });
            return tx;
          },
        };
        const req = { result: db } as unknown as IDBOpenDBRequest;
        queueMicrotask(() => req.onsuccess?.call(req, new Event("success")));
        return req;
      },
    },
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => null, setItem() {} },
  });
  const g = recover((await load())!);
  assert.equal(g.id, expected.id);
  assert.deepEqual(g.study, expected.study);
});
