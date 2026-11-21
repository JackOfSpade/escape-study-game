import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Roadmap, StudyRecord } from "../src/model";
import {
  encode,
  exportRecoveryBackup,
  flushSaves,
  legacyCleanupSettled,
  load,
  rejectedCopy,
  save,
} from "../src/persistence";
import { readDurable } from "../src/storage";
import { watchStudyEvents } from "../src/study-events";
import { fakeIndexedDB, fakeLocalStorage } from "./helpers/fake-indexeddb";
import { createRecord } from "./helpers/record";

const KEY = "study-save-v1",
  LEGACY_KEY = "dead-air-save-v1",
  DB = "study-durable-state",
  LEGACY_DB = "dead-air-durable-state",
  LOGS = "recent-study-diagnostics-v1";
const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
const idb = fakeIndexedDB(),
  local = fakeLocalStorage();
idb.install();
local.install();
const events: [string, Record<string, unknown>][] = [];
watchStudyEvents((type, data) => events.push([type, data]));

const stored = (g: StudyRecord, serial: number) =>
  JSON.stringify({ format: 2, serial, data: encode(g) });
const serialOf = (raw: unknown) => JSON.parse(String(raw)).serial as number;
async function saved(g: StudyRecord, options?: { background?: boolean }) {
  await save(g, options);
  await flushSaves();
  await legacyCleanupSettled();
}
const legacyOpensCreate = () =>
  idb.opens.some((o) => o.name === LEGACY_DB && o.version !== undefined);

beforeEach(() => {
  idb.reset();
  idb.install();
  local.reset();
  events.length = 0;
});

test("a save only in the earlier localStorage key loads and moves to the new key", async () => {
  const g = createRecord(801, roadmap);
  local.items.set(LEGACY_KEY, stored(g, 10));
  const loaded = (await load())!;
  assert.equal(loaded.id, g.id);
  await saved(loaded);
  assert.ok(serialOf(local.items.get(KEY)) > 10);
  assert.ok(serialOf(idb.get(DB, KEY)) > 10);
  assert.equal(local.items.has(LEGACY_KEY), false);
  assert.ok(!idb.has(LEGACY_DB), "the earlier database is never created");
  assert.ok(!legacyOpensCreate());
});

test("a save only in the earlier database loads, and the database is deleted after a newer durable write, keeping other entries", async () => {
  const g = createRecord(802, roadmap);
  idb.seed(LEGACY_DB, {
    [LEGACY_KEY]: stored(g, 20),
    [LOGS]: "synthetic logs",
  });
  const loaded = (await load())!;
  assert.equal(loaded.id, g.id);
  // Diagnostics not yet written under the new name are read from the old one.
  assert.equal(await readDurable(LOGS), "synthetic logs");
  assert.ok(idb.has(LEGACY_DB), "loading alone removes nothing");
  await saved(loaded);
  assert.ok(serialOf(idb.get(DB, KEY)) > 20);
  assert.ok(!idb.has(LEGACY_DB));
  assert.equal(idb.get(DB, LOGS), "synthetic logs");
  assert.ok(!legacyOpensCreate(), "the earlier database is opened read-only");
  assert.ok(
    events.some(
      ([type, data]) =>
        type === "save-legacy-copy-removed" && data.store === "legacy-durable",
    ),
  );
});

test("the newest serial wins across legacy and new copies, in both directions", async () => {
  const older = createRecord(803, roadmap),
    newer = createRecord(804, roadmap);
  // A tab still on the earlier build saved after this build's last save.
  idb.seed(DB, { [KEY]: stored(older, 5) });
  local.items.set(KEY, stored(older, 5));
  local.items.set(LEGACY_KEY, stored(newer, 9));
  assert.equal((await load())!.id, newer.id);

  idb.reset();
  local.reset();
  idb.seed(LEGACY_DB, { [LEGACY_KEY]: stored(older, 3) });
  local.items.set(KEY, stored(newer, 7));
  assert.equal((await load())!.id, newer.id);
  assert.equal(rejectedCopy(), undefined);
});

test("nothing legacy is removed before the new copy is safely written", async () => {
  const g = createRecord(805, roadmap);
  idb.seed(LEGACY_DB, { [LEGACY_KEY]: stored(g, 30) });
  local.items.set(LEGACY_KEY, stored(g, 30));
  const loaded = (await load())!;
  idb.hold();
  // A background checkpoint skips the synchronous mirror, so only the durable
  // write can make the legacy copies redundant.
  const pending = save(loaded, { background: true });
  await delay(5);
  assert.ok(idb.has(LEGACY_DB));
  assert.ok(local.items.has(LEGACY_KEY));
  idb.release();
  await pending;
  await legacyCleanupSettled();
  assert.ok(!idb.has(LEGACY_DB));
  assert.equal(local.items.has(LEGACY_KEY), false);
});

test("failed new writes leave every legacy copy in place", async () => {
  const g = createRecord(806, roadmap);
  idb.seed(LEGACY_DB, { [LEGACY_KEY]: stored(g, 40) });
  local.items.set(LEGACY_KEY, stored(g, 40));
  const loaded = (await load())!;
  idb.failures.write.add(DB);
  local.failures.write.add(KEY);
  await assert.rejects(saved(loaded), /Synthetic disk error/);
  await legacyCleanupSettled();
  assert.ok(idb.has(LEGACY_DB));
  assert.equal(serialOf(idb.get(LEGACY_DB, LEGACY_KEY)), 40);
  assert.equal(serialOf(local.items.get(LEGACY_KEY)), 40);
  // A successful mirror alone retires only the legacy localStorage copy (the
  // save then counts as checkpointed although its durable write failed).
  local.failures.write.clear();
  await saved(loaded);
  assert.equal(local.items.has(LEGACY_KEY), false);
  assert.ok(idb.has(LEGACY_DB));
  // An aborted durable transaction does not count as written either.
  idb.failures.write.clear();
  idb.hold();
  const aborted = save(loaded, { background: true });
  await delay(5);
  idb.release(true);
  await aborted.catch(() => {});
  await legacyCleanupSettled();
  assert.ok(idb.has(LEGACY_DB));
});

test("the earlier database is never created when absent, with or without databases()", async () => {
  for (const withDatabases of [true, false]) {
    idb.reset();
    idb.install({ withDatabases });
    local.reset();
    assert.equal(await load(), null);
    const g = createRecord(807, roadmap);
    await saved(g);
    assert.equal(JSON.parse(await exportRecoveryBackup()).legacyDurable, null);
    assert.deepEqual(idb.names(), [DB]);
    assert.ok(!legacyOpensCreate());
    if (!withDatabases)
      assert.ok(
        idb.opens.some((o) => o.name === LEGACY_DB),
        "the abort path was exercised",
      );
  }
  idb.install();
});

test("a legacy copy newer than what was just written is kept", async () => {
  const g = createRecord(808, roadmap);
  idb.seed(LEGACY_DB, { [LEGACY_KEY]: stored(g, 50) });
  local.items.set(LEGACY_KEY, stored(g, 50));
  const loaded = (await load())!;
  // A tab on the earlier build saves after this one loaded.
  const future = Date.now() * 1000 + 1e12;
  idb.set(LEGACY_DB, LEGACY_KEY, stored(g, future));
  local.items.set(LEGACY_KEY, stored(g, future));
  await saved(loaded);
  assert.equal(serialOf(idb.get(LEGACY_DB, LEGACY_KEY)), future);
  assert.equal(serialOf(local.items.get(LEGACY_KEY)), future);
  // The next load picks it up.
  assert.equal(
    serialOf(JSON.parse(await exportRecoveryBackup()).legacyLocal),
    future,
  );
});

test("an unreadable legacy store blocks loading only when that store has no new copy", async () => {
  const g = createRecord(809, roadmap);
  idb.seed(LEGACY_DB, { [LEGACY_KEY]: stored(g, 60) });
  idb.failures.open.add(LEGACY_DB);
  await assert.rejects(load(), /could not be read/);
  idb.reset();
  idb.seed(LEGACY_DB, { [LEGACY_KEY]: stored(g, 60) });
  idb.seed(DB, { [KEY]: stored(g, 70) });
  idb.failures.open.add(LEGACY_DB);
  assert.equal((await load())!.id, g.id);
  assert.ok(
    events.some(
      ([type, data]) =>
        type === "save-legacy-read-failed" && data.store === "legacy-durable",
    ),
  );
  // A failed cleanup is logged, never thrown, and retried by a later save.
  await saved(g);
  assert.ok(idb.has(LEGACY_DB));
  assert.ok(events.some(([type]) => type === "save-legacy-cleanup-failed"));
  idb.failures.open.clear();
  await saved(g);
  assert.ok(!idb.has(LEGACY_DB));
});

test("a delete blocked by another tab never holds up saving and finishes later", async () => {
  const g = createRecord(810, roadmap);
  idb.seed(LEGACY_DB, { [LEGACY_KEY]: stored(g, 80) });
  const other = idb.stubbornConnection(LEGACY_DB);
  try {
    const loaded = (await load())!;
    await save(loaded);
    await flushSaves();
    // The blocked notice is asynchronous; under a loaded test run it can
    // arrive well after the save settles.
    const blocked = () =>
      events.some(([type]) => type === "save-legacy-cleanup-blocked");
    for (let waited = 0; !blocked() && waited < 5_000; waited += 5)
      await delay(5);
    assert.ok(blocked());
    assert.ok(idb.has(LEGACY_DB));
    // Further saves go through while the delete waits.
    await save(loaded);
    await flushSaves();
  } finally {
    // Never leave a blocked delete behind for the next test.
    other.db.close();
    await legacyCleanupSettled();
  }
  assert.ok(!idb.has(LEGACY_DB));
});

test("damaged legacy copies are reported with their bytes and removed only once offered", async () => {
  const g = createRecord(811, roadmap);
  idb.seed(DB, { [KEY]: `${stored(g, 90).slice(0, -30)}synthetic damage` });
  local.items.set(KEY, stored(g, 90));
  local.items.set(LEGACY_KEY, "synthetic damaged legacy local");
  idb.seed(LEGACY_DB, { [LEGACY_KEY]: "synthetic damaged legacy durable" });
  assert.equal((await load())!.id, g.id);
  const refused = rejectedCopy()!;
  assert.equal(refused.store, "durable");
  assert.deepEqual(
    refused.others?.map((c) => [c.store, c.raw]),
    [
      ["legacy-durable", "synthetic damaged legacy durable"],
      ["legacy-local", "synthetic damaged legacy local"],
    ],
  );
  const backup = JSON.parse(await exportRecoveryBackup());
  assert.equal(backup.format, "study-recovery-v1");
  assert.deepEqual([backup.key, backup.legacyKey], [KEY, LEGACY_KEY]);
  assert.equal(backup.legacyLocal, "synthetic damaged legacy local");
  assert.equal(backup.legacyDurable, "synthetic damaged legacy durable");
  await saved(g);
  assert.equal(local.items.has(LEGACY_KEY), false);
  assert.ok(!idb.has(LEGACY_DB));

  // Damaged bytes that load() did not offer stay where they are.
  idb.reset();
  local.reset();
  local.items.set(KEY, stored(g, 95));
  assert.equal((await load())!.id, g.id);
  local.items.set(LEGACY_KEY, "synthetic damage written after load");
  await saved(g);
  assert.equal(
    local.items.get(LEGACY_KEY),
    "synthetic damage written after load",
  );
});
