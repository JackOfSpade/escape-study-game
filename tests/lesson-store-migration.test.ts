import assert from "node:assert/strict";
import test from "node:test";
import { fnv1a } from "../src/hash";
import {
  createLessonStore,
  LEGACY_LESSON_DB,
  LESSON_DB,
  type LessonEntry,
  type LessonIdb,
} from "../src/lesson-store";
import { fakeLessonIdb } from "./helpers/fake-lesson-idb";

const LESSON = {
  v: 1,
  title: "Sliding windows",
  summary: "One idea.",
  minutes: 5,
  sections: [
    {
      id: "idea",
      title: "The idea",
      blocks: [{ kind: "prose", text: "A window keeps a running total." }],
    },
    {
      id: "more",
      title: "More",
      blocks: [{ kind: "prose", text: "Second section." }],
    },
  ],
};

const record = (key: string): LessonEntry =>
  ({
    key,
    state: "ready",
    requestId: `lesson-${key}-1`,
    attempt: 1,
    lesson: structuredClone(LESSON),
    createdAt: "2026-11-19T10:00:00.000Z",
    responses: {},
    chat: [],
    chatSeq: 0,
  }) as LessonEntry;

const encoded = (key: string) => {
  const payload = JSON.stringify(record(key));
  return JSON.stringify({ schema: 1, payload, checksum: fnv1a(payload) });
};

/** What an earlier build left behind: two sound records and values the
 * reader skips (a bad checksum, a non-string and plain junk). */
const LEGACY_ROWS: Record<string, unknown> = {
  "gap-a": encoded("gap-a"),
  "gap-b": encoded("gap-b"),
  "bad-checksum": encoded("bad-checksum").replace(
    /"checksum":\d+/,
    '"checksum":1',
  ),
  "not-a-string": { key: "x", note: "kept as it is" },
  junk: "{{{ not json",
};

const legacyFake = (faults: Parameters<typeof fakeLessonIdb>[0] = {}) => {
  const fake = fakeLessonIdb(faults);
  fake.seed(LEGACY_LESSON_DB, { lessons: structuredClone(LEGACY_ROWS) });
  return fake;
};
const storeOn = (idb: LessonIdb) => createLessonStore(() => idb);
const keys = (records: LessonEntry[]) => records.map((r) => r.key).sort();
const currentRows = (fake: ReturnType<typeof fakeLessonIdb>) =>
  Object.fromEntries(fake.rows(LESSON_DB, "lessons") ?? []);

test("the names are the study names", () => {
  assert.equal(LESSON_DB, "study-lessons");
  assert.equal(LEGACY_LESSON_DB, "dead-air-lessons");
});

for (const listing of [true, false]) {
  const label = listing ? "" : " (no databases() listing)";

  test(`every legacy value is copied as it is, under the same key, then the legacy database is deleted${label}`, async () => {
    const fake = legacyFake();
    const s = storeOn(listing ? fake.factory : fake.withoutListing());
    assert.deepEqual(keys(await s.all()), ["gap-a", "gap-b"]);
    await fake.settle();
    // Byte for byte, including the values the reader skips.
    assert.deepEqual(currentRows(fake), LEGACY_ROWS);
    const marker = fake.rows(LESSON_DB, "meta")?.get("legacy-migration") as {
      from: string;
      copied: number;
    };
    assert.equal(marker.from, LEGACY_LESSON_DB);
    assert.equal(marker.copied, Object.keys(LEGACY_ROWS).length);
    assert.equal(fake.exists(LEGACY_LESSON_DB), false);
    assert.deepEqual(fake.log.deleted, [LEGACY_LESSON_DB]);
  });

  test(`an absent legacy database is never created${label}`, async () => {
    const fake = fakeLessonIdb();
    const s = storeOn(listing ? fake.factory : fake.withoutListing());
    await s.put(record("gap-a"));
    assert.deepEqual(keys(await s.all()), ["gap-a"]);
    await fake.settle();
    assert.equal(fake.exists(LEGACY_LESSON_DB), false);
    assert.ok(!fake.log.created.some((c) => c.startsWith(LEGACY_LESSON_DB)));
    // Without a listing the store probes the name; with one it does not.
    assert.equal(
      fake.log.opened.includes(`${LEGACY_LESSON_DB}@undefined`),
      !listing,
    );
    assert.ok(
      !fake.log.opened.some((o) => o.startsWith(`${LEGACY_LESSON_DB}@1`)),
    );
    // No marker: a legacy database that turns up later is still moved.
    assert.equal(fake.rows(LESSON_DB, "meta")?.size, 0);
  });
}

test("the legacy database is deleted only after the copy commits", async () => {
  const fake = legacyFake();
  const s = storeOn(fake.factory);
  await s.all();
  await fake.settle();
  const copies = fake.log.puts.filter((p) => p.startsWith(`${LESSON_DB}/`));
  assert.equal(copies.length, Object.keys(LEGACY_ROWS).length + 1); // + marker
  assert.deepEqual(fake.log.deleted, [LEGACY_LESSON_DB]);
});

test("a failed copy keeps the legacy database, keeps lessons readable and is retried on the next open", async () => {
  let failing = true;
  const fake = legacyFake({
    failPut: (db, key) => failing && db === LESSON_DB && key === "gap-b",
  });
  const first = storeOn(fake.factory);
  // This session falls back to the untouched legacy database.
  assert.deepEqual(keys(await first.all()), ["gap-a", "gap-b"]);
  await first.put(record("gap-c"));
  await fake.settle();
  assert.equal(fake.exists(LEGACY_LESSON_DB), true);
  assert.deepEqual(fake.log.deleted, []);
  // The copy was all or nothing: no partial rows and no marker.
  assert.deepEqual(currentRows(fake), {});
  assert.equal(fake.rows(LESSON_DB, "meta")?.size, 0);
  const legacy = Object.fromEntries(fake.rows(LEGACY_LESSON_DB, "lessons")!);
  assert.deepEqual(
    Object.keys(legacy).sort(),
    [...Object.keys(LEGACY_ROWS), "gap-c"].sort(),
  );

  failing = false;
  const second = storeOn(fake.factory);
  assert.deepEqual(keys(await second.all()), ["gap-a", "gap-b", "gap-c"]);
  await fake.settle();
  assert.deepEqual(currentRows(fake), legacy);
  assert.equal(fake.exists(LEGACY_LESSON_DB), false);
});

test("a legacy database that cannot be read is left alone and tried again", async () => {
  let failing = true;
  const fake = legacyFake({
    failRead: (db) => failing && db === LEGACY_LESSON_DB,
  });
  const first = storeOn(fake.factory);
  assert.deepEqual(await first.all(), []);
  await first.put(record("gap-new"));
  await fake.settle();
  assert.equal(fake.exists(LEGACY_LESSON_DB), true);
  failing = false;
  const second = storeOn(fake.factory);
  // The legacy rows join the one written meanwhile.
  assert.deepEqual(keys(await second.all()), ["gap-a", "gap-b", "gap-new"]);
  await fake.settle();
  assert.equal(fake.exists(LEGACY_LESSON_DB), false);
});

test("a later open does not migrate again, even while the legacy delete is blocked", async () => {
  const fake = legacyFake();
  // An old tab still holds the legacy database open and ignores versionchange.
  const old = await new Promise<IDBDatabase>((resolve) => {
    const req = fake.factory.open(LEGACY_LESSON_DB, 1);
    req.onsuccess = () => resolve(req.result);
  });
  const first = storeOn(fake.factory);
  assert.deepEqual(keys(await first.all()), ["gap-a", "gap-b"]);
  await fake.settle();
  assert.equal(fake.exists(LEGACY_LESSON_DB), true, "delete is blocked");
  await first.remove("gap-a");
  const putsBefore = fake.log.puts.length;

  const second = storeOn(fake.factory);
  // The removed lesson does not come back from the legacy copy.
  assert.deepEqual(keys(await second.all()), ["gap-b"]);
  await fake.settle();
  assert.equal(fake.log.puts.length, putsBefore);

  old.close();
  await fake.settle();
  assert.equal(fake.exists(LEGACY_LESSON_DB), false);
});

test("a failed legacy delete is not an error and is retried on a later open", async () => {
  let failing = true;
  const fake = legacyFake({ failDelete: () => failing });
  const first = storeOn(fake.factory);
  assert.deepEqual(keys(await first.all()), ["gap-a", "gap-b"]);
  await fake.settle();
  assert.equal(fake.exists(LEGACY_LESSON_DB), true);
  failing = false;
  const putsBefore = fake.log.puts.length;
  const second = storeOn(fake.factory);
  assert.deepEqual(keys(await second.all()), ["gap-a", "gap-b"]);
  await fake.settle();
  assert.equal(fake.exists(LEGACY_LESSON_DB), false);
  assert.equal(fake.log.puts.length, putsBefore);
});

test("two stores opening at once copy the legacy records once", async () => {
  const fake = legacyFake();
  const a = storeOn(fake.factory),
    b = storeOn(fake.factory);
  const [ra, rb] = await Promise.all([a.all(), b.all()]);
  assert.deepEqual(keys(ra), ["gap-a", "gap-b"]);
  assert.deepEqual(keys(rb), ["gap-a", "gap-b"]);
  await fake.settle();
  const copies = fake.log.puts.filter((p) =>
    p.startsWith(`${LESSON_DB}/lessons/`),
  );
  assert.equal(copies.length, Object.keys(LEGACY_ROWS).length);
  assert.equal(new Set(copies).size, copies.length);
  // Both really raced: each read the legacy database before either copied.
  assert.equal(
    fake.log.opened.filter((o) => o.startsWith(LEGACY_LESSON_DB)).length,
    2,
  );
  assert.deepEqual(
    fake.log.puts.filter((p) => p.startsWith(`${LESSON_DB}/meta/`)),
    [`${LESSON_DB}/meta/legacy-migration`],
  );
  assert.deepEqual(currentRows(fake), LEGACY_ROWS);
  assert.equal(fake.exists(LEGACY_LESSON_DB), false);
});

test("a record already in the current database keeps its current value", async () => {
  const fake = fakeLessonIdb();
  const s = storeOn(fake.factory);
  await s.put(record("gap-a"));
  const mine = fake.rows(LESSON_DB, "lessons")!.get("gap-a");
  fake.seed(LEGACY_LESSON_DB, {
    lessons: { "gap-a": "older", ...{ "gap-b": encoded("gap-b") } },
  });
  const later = storeOn(fake.factory);
  assert.deepEqual(keys(await later.all()), ["gap-a", "gap-b"]);
  assert.equal(fake.rows(LESSON_DB, "lessons")!.get("gap-a"), mine);
});

test("migration opens only the two lesson databases, never the save's", async () => {
  for (const make of [
    (f: ReturnType<typeof fakeLessonIdb>) => f.factory,
    (f: ReturnType<typeof fakeLessonIdb>) => f.withoutListing(),
  ]) {
    const fake = legacyFake();
    fake.seed("study-durable-state", { saves: { k: "save" } });
    fake.seed("dead-air-durable-state", { saves: { k: "save" } });
    const s = storeOn(make(fake));
    await s.all();
    await s.put(record("gap-z"));
    await fake.settle();
    const names = new Set(fake.log.opened.map((o) => o.split("@")[0]));
    assert.ok(names.has(LESSON_DB));
    for (const n of names)
      assert.ok([LESSON_DB, LEGACY_LESSON_DB].includes(n), `opened ${n}`);
    assert.deepEqual(fake.log.deleted, [LEGACY_LESSON_DB]);
    assert.equal(fake.rows("study-durable-state", "saves")?.get("k"), "save");
    assert.equal(
      fake.rows("dead-air-durable-state", "saves")?.get("k"),
      "save",
    );
  }
});
