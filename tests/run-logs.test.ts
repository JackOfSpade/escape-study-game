import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import { RunLogs, LOG_LIMITS, utf8Length } from "../src/run-logs";
import { createGame } from "./helpers/record";
import type { Roadmap } from "../src/model";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
const record = () => createGame(11, roadmap);
const memory = () => ({ read: async () => null, write: async () => {} });
function storedLogs() {
  let stored: string | null = null;
  return {
    read: async () => stored,
    write: async (value: string) => {
      stored = value;
    },
  };
}

test("the last three records' diagnostics survive reload, prune older ones and bound each without learning content", async () => {
  const storage = storedLogs(),
    logs = new RunLogs(storage),
    g = record();
  const study = JSON.stringify(g.study);
  for (let i = 0; i < 5; i++) {
    g.id = `run-${i}`;
    logs.record(g, "start");
  }
  for (let i = 0; i < 700; i++)
    logs.record(g, "bounded", { payload: "x".repeat(2000) });
  await logs.flush();
  const restored = new RunLogs(storage);
  await restored.load();
  assert.deepEqual(
    restored.runs.map((r) => r.id),
    ["run-2", "run-3", "run-4"],
  );
  for (const run of restored.runs) {
    assert.ok(run.entries.length <= LOG_LIMITS.entries);
    assert.ok(JSON.stringify(run).length <= LOG_LIMITS.bytesPerGame);
  }
  assert.equal(JSON.stringify(g.study), study);
  assert.ok(!(await storage.read())!.includes('"history"'));
});

test("corrupt diagnostic records are skipped individually and cannot poison the newest valid run", async () => {
  const g = record(),
    original = new RunLogs(memory());
  original.record(g, "first");
  const good = original.runs[0];
  const restored = new RunLogs({
    read: async () =>
      JSON.stringify({
        version: 1,
        runs: [
          null,
          {},
          good,
          // Logs written by older builds carried a summary and an audit.
          {
            ...good,
            seed: 7,
            summary: { duration: "bad" },
            audit: { events: [] },
            entries: [
              null,
              { at: "2026-11-18T18:04:51.504Z", type: "valid", data: { x: 2 } },
            ],
          },
        ],
      }),
    write: async () => {},
  });
  await restored.load();
  assert.equal(restored.runs.length, 1);
  assert.equal(restored.runs[0].entries[0].type, "valid");
  assert.deepEqual(Object.keys(restored.runs[0]).sort(), [
    "entries",
    "id",
    "started",
  ]);
  restored.record(g, "after-load");
  assert.equal(restored.runs[0].entries.length, 2);
});

test("unparseable stored diagnostics report a read error and leave logging usable", async () => {
  const logs = new RunLogs({
    read: async () => "{not json",
    write: async () => {},
  });
  await logs.load();
  assert.equal(logs.error, "Could not read previous diagnostics.");
  assert.equal(logs.runs.length, 0);
  logs.record(record(), "ok");
  assert.equal(logs.runs[0].entries.length, 1);
});

test("diagnostic retention caps UTF-8 bytes, including multibyte data and an oversized newest entry", () => {
  const g = record(),
    logs = new RunLogs(memory());
  for (let i = 0; i < 150; i++)
    logs.record(g, "unicode", { i, text: "🧪".repeat(1000) });
  assert.ok(
    Buffer.byteLength(JSON.stringify(logs.runs[0])) <= LOG_LIMITS.bytesPerGame,
  );
  assert.ok(logs.runs[0].entries.length > 1);
  logs.record(g, "too-big", { text: "🧪".repeat(LOG_LIMITS.bytesPerGame) });
  assert.equal(logs.runs[0].entries.length, 0);
  logs.record(g, "new-tail");
  assert.equal(logs.runs[0].entries.length, 1);
});

test("utf8Length matches Buffer UTF-8 encoding including escapes and lone surrogates", () => {
  for (const s of [
    "",
    "plain",
    "é",
    "€",
    "🧪",
    "\ud800",
    "\udc00x",
    "a\ud83d",
    '{"q":"\\u0000"}',
    "x".repeat(5000) + "🧪",
  ])
    assert.equal(utf8Length(s), Buffer.byteLength(s));
});

test("record never stringifies or encodes the whole retained run", () => {
  const g = record(),
    logs = new RunLogs(memory());
  for (let i = 0; i < 300; i++) logs.record(g, "burst", { i });
  const before = logs.stats.entrySerializations;
  logs.record(g, "one-more", { i: 300 });
  assert.equal(logs.stats.entrySerializations - before, 1);
});

test("slow diagnostic storage coalesces superseded writes while retaining ordered durable completion", async () => {
  const writes: string[] = [];
  let release!: () => void;
  let active = 0,
    maxActive = 0;
  const logs = new RunLogs({
      read: async () => null,
      write: async (value) => {
        active++;
        maxActive = Math.max(maxActive, active);
        writes.push(value);
        if (writes.length === 1)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        active--;
      },
    }),
    g = record();
  logs.record(g, "first");
  const first = logs.flush();
  await settle();
  const pending: Promise<void>[] = [];
  for (let i = 0; i < 100; i++) {
    logs.record(g, `event-${i}`);
    pending.push(logs.flush());
  }
  release();
  await first;
  await Promise.all(pending);
  assert.equal(writes.length, 2);
  assert.equal(maxActive, 1);
  assert.equal(JSON.parse(writes[0]).runs[0].entries.at(-1).type, "first");
  assert.equal(JSON.parse(writes[1]).runs[0].entries.at(-1).type, "event-99");
  assert.equal(logs.stats.documentSerializations, 2);
  assert.equal(writes[1], JSON.stringify({ version: 1, runs: logs.runs }));
});

test("failed diagnostic writes surface an error and the next flush retries with the newest state", async () => {
  const writes: string[] = [];
  let fail = true;
  const logs = new RunLogs({
    read: async () => null,
    write: async (value) => {
      if (fail) throw new Error("quota");
      writes.push(value);
    },
  });
  const g = record();
  logs.record(g, "a");
  await logs.flush();
  assert.equal(
    logs.error,
    "Diagnostics could not be saved. Download them before closing.",
  );
  assert.equal(writes.length, 0);
  fail = false;
  logs.record(g, "b");
  await logs.flush();
  assert.equal(logs.error, "");
  assert.equal(writes.length, 1);
  assert.deepEqual(
    JSON.parse(writes[0]).runs[0].entries.map((e: { type: string }) => e.type),
    ["a", "b"],
  );
});

test("recorded diagnostics are detached from later mutation of live objects", async () => {
  const storage = storedLogs(),
    logs = new RunLogs(storage),
    live = { mode: "free", contacts: [1] };
  logs.record(record(), "snapshot", { live });
  live.mode = "changed-later";
  live.contacts.push(2, 3, 4);
  await logs.flush();
  const saved = JSON.parse((await storage.read())!).runs[0].entries[0].data;
  assert.deepEqual(saved, { live: { mode: "free", contacts: [1] } });
  assert.equal(
    await storage.read(),
    JSON.stringify({ version: 1, runs: logs.runs }),
  );
});

test("entries carry wall-clock time, and old-clock entries from earlier builds are dropped on load", async () => {
  const g = record(),
    fresh = new RunLogs(memory());
  const before = Date.now();
  fresh.record(g, "terminal-message", { chars: 3 });
  const at = Date.parse(fresh.runs[0].entries[0].at);
  assert.ok(at >= before && at <= Date.now());
  const stale = { at: 157.03, type: "snapshot", data: { actors: [] } };
  const restored = new RunLogs({
    read: async () =>
      JSON.stringify({
        version: 1,
        runs: [
          {
            id: "old-only",
            started: "2026-11-13T09:31:37.147Z",
            entries: [stale],
          },
          {
            id: g.id,
            started: "2026-11-15T06:56:13.014Z",
            entries: [
              stale,
              { at: 157.03, type: "terminal-message", data: { chars: 34 } },
              fresh.runs[0].entries[0],
            ],
          },
        ],
      }),
    write: async () => {},
  });
  await restored.load();
  assert.deepEqual(
    restored.runs.map((r) => r.id),
    [g.id],
  );
  assert.deepEqual(restored.runs[0].entries, fresh.runs[0].entries);
});
