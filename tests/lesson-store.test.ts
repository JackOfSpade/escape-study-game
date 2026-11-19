import assert from "node:assert/strict";
import test from "node:test";
import { fnv1a } from "../src/hash";
import {
  createLessonStore,
  validLessonRecord,
  type LessonEntry,
} from "../src/lesson-store";

/** A small in-memory IndexedDB: one object store per database, with the
 * handful of calls the lesson store makes, answered asynchronously. */
function fakeIdb() {
  const opened: string[] = [],
    rows = new Map<string, unknown>();
  let blocked = false,
    createdStores = 0;
  const factory = {
    open(name: string, version?: number) {
      opened.push(`${name}@${version}`);
      const req = {} as IDBOpenDBRequest;
      queueMicrotask(() => {
        if (blocked) {
          req.onblocked?.call(req, {} as IDBVersionChangeEvent);
          return;
        }
        const stores = new Set<string>();
        const db = {} as IDBDatabase;
        Object.assign(db, {
          objectStoreNames: { contains: (n: string) => stores.has(n) },
          createObjectStore(n: string) {
            stores.add(n);
            createdStores++;
          },
          close() {},
          transaction() {
            const tx = {} as IDBTransaction;
            const done = () =>
              queueMicrotask(() => tx.oncomplete?.call(tx, new Event("x")));
            Object.assign(tx, {
              objectStore() {
                return {
                  getAll() {
                    const r = {} as IDBRequest;
                    queueMicrotask(() => {
                      Object.assign(r, { result: [...rows.values()] });
                      r.onsuccess?.call(r, new Event("success"));
                      done();
                    });
                    return r;
                  },
                  put(value: unknown, key: string) {
                    rows.set(key, value);
                    done();
                  },
                  delete(key: string) {
                    rows.delete(key);
                    done();
                  },
                };
              },
            });
            return tx;
          },
        });
        Object.assign(req, { result: db });
        req.onupgradeneeded?.call(req, {} as IDBVersionChangeEvent);
        req.onsuccess?.call(req, new Event("success"));
      });
      return req;
    },
  };
  return {
    factory,
    opened,
    rows,
    created: () => createdStores,
    block: (on: boolean) => (blocked = on),
  };
}

const LESSON = {
  v: 1,
  title: "Sliding windows",
  summary: "One idea.",
  minutes: 5,
  sections: [
    {
      id: "idea",
      title: "The idea",
      blocks: [
        { kind: "prose", text: "A window keeps a running total." },
        {
          kind: "predict",
          prompt: "What happens next?",
          options: [
            { id: "a", text: "Add" },
            { id: "b", text: "Subtract" },
          ],
          correctId: "a",
          explanation: "It adds.",
        },
      ],
    },
    {
      id: "more",
      title: "More",
      blocks: [{ kind: "prose", text: "Second section." }],
    },
  ],
};

const record = (over: Record<string, unknown> = {}): LessonEntry =>
  ({
    key: "gap-1",
    state: "ready",
    requestId: "lesson-gap-1-1-abc",
    attempt: 1,
    lesson: structuredClone(LESSON),
    createdAt: "2026-11-19T10:00:00.000Z",
    responses: { "idea/1": "a" },
    chat: [
      {
        id: "m1",
        role: "learner",
        text: "Why add?",
        at: "2026-11-19T10:01:00.000Z",
        state: "sent",
      },
      {
        id: "m2",
        role: "tutor",
        text: "Because it enters.",
        at: "2026-11-19T10:01:05.000Z",
        state: "sent",
        section: "idea",
      },
    ],
    chatSeq: 1,
    gapDescription: "Update the running total",
    ...over,
  }) as LessonEntry;

const envelope = (payload: string, checksum = fnv1a(payload)) =>
  JSON.stringify({ schema: 1, payload, checksum });
const store = (h: ReturnType<typeof fakeIdb>) =>
  createLessonStore(() => h.factory);

test("a record round trips through the lesson database", async () => {
  const h = fakeIdb(),
    s = store(h),
    rec = record();
  await s.put(rec);
  assert.deepEqual(await s.all(), [rec]);
  assert.equal(typeof h.rows.get("gap-1"), "string");
  const e = JSON.parse(h.rows.get("gap-1") as string);
  assert.equal(e.schema, 1);
  assert.equal(e.checksum, fnv1a(e.payload));
});

test("only the lesson database is ever opened", async () => {
  const h = fakeIdb(),
    s = store(h);
  await s.put(record());
  await s.all();
  await s.remove("gap-1");
  assert.ok(h.opened.length >= 1);
  assert.deepEqual([...new Set(h.opened)], ["dead-air-lessons@1"]);
  assert.ok(!h.opened.some((o) => o.includes("durable-state")));
  assert.equal(h.created(), 1);
});

test("remove deletes one record and leaves the others", async () => {
  const h = fakeIdb(),
    s = store(h);
  await s.put(record());
  await s.put(record({ key: "gap-2" }));
  await s.remove("gap-1");
  assert.deepEqual(
    (await s.all()).map((r) => r.key),
    ["gap-2"],
  );
});

test("put replaces the record under its key", async () => {
  const h = fakeIdb(),
    s = store(h);
  await s.put(record());
  await s.put(record({ readAt: "2026-11-19T11:00:00.000Z" }));
  const all = await s.all();
  assert.equal(all.length, 1);
  assert.equal(all[0].readAt, "2026-11-19T11:00:00.000Z");
});

test("a later change to the record cannot reach a write already started", async () => {
  const h = fakeIdb(),
    s = store(h),
    rec = record();
  const pending = s.put(rec);
  rec.chat.length = 0;
  await pending;
  assert.equal((await s.all())[0].chat.length, 2);
});

test("unsound values are skipped, not thrown on and not deleted", async () => {
  const h = fakeIdb(),
    s = store(h);
  await s.put(record());
  const good = JSON.stringify(record({ key: "keep" }));
  h.rows.set("not-a-string", { key: "x" });
  h.rows.set("not-json", "{{{");
  h.rows.set("bad-checksum", envelope(good, fnv1a(good) + 1));
  h.rows.set(
    "wrong-schema",
    JSON.stringify({ schema: 2, payload: good, checksum: fnv1a(good) }),
  );
  h.rows.set(
    "malformed",
    envelope(JSON.stringify({ key: "m", state: "ready" })),
  );
  h.rows.set("not-an-object", envelope("[1,2]"));
  const badLesson = JSON.stringify(
    record({ key: "bad-lesson", lesson: { v: 1, title: "x" } }),
  );
  h.rows.set("bad-lesson", envelope(badLesson));
  const all = await s.all();
  assert.deepEqual(
    all.map((r) => r.key),
    ["gap-1"],
  );
  // Nothing was removed.
  assert.equal(h.rows.size, 8);
});

test("a stored lesson is replaced by its normalised clean copy", () => {
  const dirty = record();
  const sections = (dirty.lesson as any).sections;
  sections[0].blocks[0].onclick = "alert(1)";
  sections[0].blocks[0].text = "  A window keeps a running total.  ";
  sections[1].blocks.push({ kind: "diagram", alt: "x", nodes: "nope" });
  const clean = validLessonRecord(JSON.parse(JSON.stringify(dirty)));
  assert.ok(clean?.lesson);
  assert.equal("onclick" in clean.lesson.sections[0].blocks[0], false);
  assert.equal(
    (clean.lesson.sections[0].blocks[0] as { text: string }).text,
    "A window keeps a running total.",
  );
  assert.equal(clean.lesson.sections[1].blocks.length, 1);
});

test("shape checks reject records that are out of bounds", () => {
  const ok = (over: Record<string, unknown>) =>
    validLessonRecord(JSON.parse(JSON.stringify(record(over)))) !== undefined;
  assert.equal(ok({}), true);
  assert.equal(ok({ state: "ready", lesson: undefined }), false);
  assert.equal(ok({ state: "bogus" }), false);
  assert.equal(ok({ key: "" }), false);
  assert.equal(ok({ attempt: -1 }), false);
  assert.equal(ok({ attempt: 1.5 }), false);
  assert.equal(ok({ responses: [] }), false);
  assert.equal(ok({ chatSeq: "1" }), false);
  assert.equal(ok({ state: "pending", lesson: undefined }), true);
  assert.equal(ok({ state: "failed", lesson: undefined, error: "x" }), true);
  assert.equal(ok({ state: "failed", lesson: undefined, error: 3 }), false);
});

test("chat and responses are bounded", () => {
  const msg = (i: number, over: Record<string, unknown> = {}) => ({
    id: `m${i}`,
    role: i % 2 ? "tutor" : "learner",
    text: "hi",
    at: "2026-11-19T10:00:00.000Z",
    state: "sent",
    ...over,
  });
  const chat = (n: number) => Array.from({ length: n }, (_, i) => msg(i));
  const ok = (over: Record<string, unknown>) =>
    validLessonRecord(JSON.parse(JSON.stringify(record(over)))) !== undefined;
  assert.equal(ok({ chat: chat(200) }), true);
  assert.equal(ok({ chat: chat(201) }), false);
  assert.equal(ok({ chat: [msg(0, { text: "x".repeat(8000) })] }), true);
  assert.equal(ok({ chat: [msg(0, { text: "x".repeat(8001) })] }), false);
  assert.equal(ok({ chat: [msg(0, { role: "system" })] }), false);
  assert.equal(ok({ chat: [msg(0, { state: "done" })] }), false);
  assert.equal(ok({ chat: ["not a message"] }), false);
  const responses = (n: number, len = 5) =>
    Object.fromEntries(
      Array.from({ length: n }, (_, i) => [`idea/${i}`, "x".repeat(len)]),
    );
  assert.equal(ok({ responses: responses(64) }), true);
  assert.equal(ok({ responses: responses(65) }), false);
  assert.equal(ok({ responses: responses(1, 4000) }), true);
  assert.equal(ok({ responses: responses(1, 4001) }), false);
  assert.equal(ok({ responses: { "idea/1": 5 } }), false);
});

test("a tutor message pointing at a section the lesson lacks loses the pointer", () => {
  const rec = record();
  (rec.chat[1] as any).section = "nowhere";
  const clean = validLessonRecord(JSON.parse(JSON.stringify(rec)));
  assert.ok(clean);
  assert.equal("section" in clean.chat[1], false);
});

test("a blocked open fails and a later open is tried afresh", async () => {
  const h = fakeIdb(),
    s = store(h);
  h.block(true);
  await assert.rejects(s.all(), /blocking/);
  h.block(false);
  await s.put(record());
  assert.equal((await s.all()).length, 1);
  assert.equal(h.opened.length, 2);
});

test("a synchronous open failure is not cached", async () => {
  const h = fakeIdb();
  let tries = 0;
  const s = createLessonStore(() => {
    if (tries++ === 0) throw Error("Storage temporarily denied");
    return h.factory;
  });
  await assert.rejects(s.all(), /temporarily denied/);
  assert.deepEqual(await s.all(), []);
  assert.equal(tries, 2);
});
