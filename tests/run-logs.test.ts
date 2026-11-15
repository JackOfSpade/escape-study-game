import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import { RunLogs, LOG_LIMITS, utf8Length } from "../src/run-logs";
import { createGame } from "../src/world";
import type { Game, Roadmap } from "../src/model";
import {
  LegacyRunLogs,
  legacyTrimRun,
  normalized,
  prng,
  runBenchmark,
  syntheticGame,
  type LegacyRun,
  type LogGame,
} from "../scripts/benchmark-run-logs";
const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
function scene() {
  const g = createGame(11, roadmap);
  g.status = "playing";
  g.survivors = g.survivors.slice(0, 1);
  g.zombies = [];
  return { g };
}
const asGame = (g: LogGame) => g as unknown as Game;
const memory = () => ({ read: async () => null, write: async () => {} });
test("last-three-game logs survive reload, prune old games and bound each game without learning content", async () => {
  let stored: string | null = null;
  const storage = {
    read: async () => stored,
    write: async (value: string) => {
      stored = value;
    },
  };
  const logs = new RunLogs(storage),
    { g } = scene();
  const study = JSON.stringify(g.study);
  for (let i = 0; i < 5; i++) {
    g.id = `run-${i}`;
    logs.record(g, "start");
    logs.capture(g, true);
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
  assert.ok(!stored!.includes('"study"'));
  assert.ok(!stored!.includes('"history"'));
});
test("a run ending between periodic snapshots saves its final state without waiting for another simulation tick", async () => {
  let stored: string | null = null;
  const logs = new RunLogs({
      read: async () => stored,
      write: async (value) => {
        stored = value;
      },
    }),
    { g } = scene();
  logs.capture(g);
  g.time = 0.1;
  g.status = "dead";
  g.survivors[0].alive = false;
  logs.capture(g);
  await logs.flush();
  const saved = JSON.parse(stored!);
  assert.equal(saved.runs[0].entries.at(-1).data.status, "dead");
  assert.equal(saved.runs[0].entries.at(-1).data.actors[0].alive, false);
});
test("pruned diagnostic tails keep a compact whole-run outcome summary", () => {
  const { g } = scene(),
    logs = new RunLogs(memory());
  for (let i = 0; i < 450; i++) {
    g.time = i;
    logs.record(g, "snapshot", { position: i });
  }
  g.time = 450;
  g.status = "dead";
  g.stats.deaths = 1;
  logs.capture(g, true);
  const run = logs.runs[0];
  assert.ok(run.entries.length <= LOG_LIMITS.entries);
  assert.equal(run.summary!.duration, 450);
  assert.equal(run.summary!.outcome, "dead");
  assert.equal(run.summary!.deaths, 1);
  assert.ok(run.summary!.snapshots >= 450);
  logs.record(g, "restart");
  assert.equal(run.summary!.outcome, "restarted");
});
test("corrupt diagnostic records are skipped individually and cannot poison the newest valid run", async () => {
  const { g } = scene(),
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
          {
            ...good,
            summary: { duration: "bad" },
            entries: [null, { at: 1, type: "valid", data: { x: 2 } }],
          },
        ],
      }),
    write: async () => {},
  });
  await restored.load();
  assert.equal(restored.runs.length, 1);
  assert.equal(restored.runs[0].entries[0].type, "valid");
  assert.equal(restored.runs[0].summary, undefined);
  restored.record(g, "after-load");
  assert.ok(Number.isFinite(restored.runs[0].summary!.duration));
});
test("unparseable stored diagnostics report a read error and leave logging usable", async () => {
  const logs = new RunLogs({
    read: async () => "{not json",
    write: async () => {},
  });
  await logs.load();
  assert.equal(logs.error, "Could not read previous game logs.");
  assert.equal(logs.runs.length, 0);
  logs.record(asGame(syntheticGame("after-corrupt", 1)), "ok");
  assert.equal(logs.runs[0].entries.length, 1);
});
test("diagnostic retention caps UTF-8 bytes, including multibyte data and an oversized newest entry", () => {
  const { g } = scene(),
    logs = new RunLogs(memory());
  for (let i = 0; i < 150; i++)
    logs.record(g, "unicode", { i, text: "🧟".repeat(1000) });
  assert.ok(
    Buffer.byteLength(JSON.stringify(logs.runs[0])) <= LOG_LIMITS.bytesPerGame,
  );
  assert.ok(logs.runs[0].entries.length > 1);
  logs.record(g, "too-big", { text: "🧟".repeat(LOG_LIMITS.bytesPerGame) });
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
    "🧟",
    "\ud83e",
    "a\udc00b",
    "\ud83e\ud83e\udddf",
    JSON.stringify({ q: '"\\\n\t\u0001', z: "🧟é\ud800" }),
  ])
    assert.equal(utf8Length(s), Buffer.byteLength(s), JSON.stringify(s));
});

/** Applies an identical record sequence to the legacy oracle and RunLogs. */
function differential(
  seed: number,
  steps: number,
  payload: (rand: () => number, i: number) => unknown,
  initial?: { legacy: LegacyRunLogs; current: RunLogs },
) {
  const rand = prng(seed);
  const legacy =
    initial?.legacy ??
    new LegacyRunLogs(
      { write: async () => {} },
      () => "2000-01-01T00:00:00.000Z",
    );
  const current = initial?.current ?? new RunLogs(memory());
  const games = [0, 1, 2, 3].map((i) => syntheticGame(`diff-${seed}-${i}`, i));
  for (let i = 0; i < steps; i++) {
    // Mostly the newest game, occasionally a new run evicting the oldest.
    const g = games[Math.min(3, Math.floor(i / (steps / 4)))];
    g.time += rand() * 7; // duration digits grow through 1, 2, 3, 4 places
    if (rand() < 0.05) g.stats.deaths++;
    g.zombies = Array.from({ length: Math.floor(rand() * 15) }, () => ({
      hp: 1,
    }));
    const type = rand() < 0.3 ? "snapshot" : rand() < 0.5 ? "world" : 'é"type';
    const data = payload(rand, i);
    legacy.record(g, type, data);
    current.record(asGame(g), type, data);
    if (normalized(legacy.runs) !== normalized(current.runs))
      assert.fail(`retention diverged at step ${i} (seed ${seed})`);
    for (const run of current.runs) {
      assert.ok(run.entries.length <= LOG_LIMITS.entries);
      assert.ok(
        Buffer.byteLength(JSON.stringify(run)) <= LOG_LIMITS.bytesPerGame,
      );
    }
  }
  return { legacy, current };
}
const alphabet = [
  "a",
  "é",
  "€",
  "🧟",
  '"',
  "\\",
  "\n",
  "\u0001",
  "\ud800",
  "<",
];
const text = (rand: () => number, n: number) =>
  Array.from(
    { length: n },
    () => alphabet[Math.floor(rand() * alphabet.length)],
  ).join("");
test("differential: unicode/escaping retention equals legacy whole-run trim", () => {
  const { current } = differential(1, 900, (rand) => ({
    text: text(rand, Math.floor(rand() * 3000)),
    nested: { list: [text(rand, 5), null, -0, 1e21] },
  }));
  assert.ok(current.runs.some((r) => r.entries.length > 1));
});
test("differential: count cap with tiny entries equals legacy", () => {
  const { current } = differential(2, 2400, (_rand, i) => i);
  assert.equal(current.runs.at(-1)!.entries.length, LOG_LIMITS.entries);
});
test("differential: oversized newest entries clear the tail exactly like legacy", () => {
  const { current } = differential(3, 400, (rand, i) =>
    i % 37 === 36
      ? { huge: "🧟".repeat(LOG_LIMITS.bytesPerGame / 3) }
      : { text: text(rand, 2000) },
  );
  assert.ok(current.runs.length > 0);
});
test("differential: summary digit growth at the exact byte boundary matches legacy", () => {
  // Fill a run to just under the cap so the header growth alone forces pruning.
  const legacy = new LegacyRunLogs(
    { write: async () => {} },
    () => "2000-01-01T00:00:00.000Z",
  );
  const current = new RunLogs(memory());
  const g = syntheticGame("edge", 9);
  const base = new RunLogs(memory());
  base.record(asGame(g), "probe", "");
  const empty = Buffer.byteLength(JSON.stringify(base.runs[0]));
  const target = LOG_LIMITS.bytesPerGame - empty - 2;
  const filler = "x".repeat(
    target -
      Buffer.byteLength(JSON.stringify({ at: 0, type: "probe", data: "" })),
  );
  for (const [time, data] of [
    [9.99, filler],
    [10, ""],
    [99.99, ""],
    [100, ""],
    [1000, "é"],
  ] as const) {
    g.time = time;
    legacy.record(g, "probe", data);
    current.record(asGame(g), "probe", data);
    assert.equal(
      normalized(current.runs),
      normalized(legacy.runs),
      `time ${time}`,
    );
  }
  assert.ok(current.runs[0].entries.length >= 1);
});
test("differential: restored runs are trimmed and continue identically to legacy", async () => {
  const rand = prng(7);
  const raw = JSON.stringify({
    version: 1,
    runs: [0, 1, 2, 3].map((i) => ({
      id: `stored-${i}`,
      seed: i,
      started: "1999-01-01T00:00:00.000Z",
      // Same key order restoredRun produces, so serialized forms compare.
      entries: Array.from({ length: 600 }, (_, n) => ({
        at: n,
        type: "world",
        data: { t: text(rand, 900) },
      })),
      summary: {
        duration: 5,
        outcome: "playing",
        deaths: 0,
        rescued: 0,
        breaches: 0,
        snapshots: 3,
        peakZombies: 1,
      },
    })),
  });
  const current = new RunLogs({ read: async () => raw, write: async () => {} });
  await current.load();
  const legacy = new LegacyRunLogs(
    { write: async () => {} },
    () => "2000-01-01T00:00:00.000Z",
  );
  const parsed = (JSON.parse(raw).runs as LegacyRun[]).slice(-LOG_LIMITS.games);
  for (const run of parsed) {
    run.entries = run.entries.slice(-LOG_LIMITS.entries);
    legacyTrimRun(run);
  }
  legacy.runs = parsed;
  assert.equal(normalized(current.runs), normalized(legacy.runs));
  assert.ok(current.runs[0].entries.length < 400);
  // Recording onto a restored run keeps matching (stored-3 is the newest).
  const g = syntheticGame("stored-3", 3);
  for (let i = 0; i < 50; i++) {
    g.time = 10 + i;
    const data = { t: text(rand, 1500) };
    legacy.record(g, "world", data);
    current.record(asGame(g), "world", data);
  }
  assert.equal(normalized(current.runs), normalized(legacy.runs));
});
test("record never stringifies or encodes the whole retained run", () => {
  const current = new RunLogs(memory());
  const legacy = new LegacyRunLogs({ write: async () => {} });
  const g = syntheticGame("ops", 1);
  for (let i = 0; i < 200; i++) {
    current.record(asGame(g), "fill", { t: "x".repeat(1200) });
    legacy.record(g, "fill", { t: "x".repeat(1200) });
  }
  assert.ok(Buffer.byteLength(JSON.stringify(current.runs[0])) > 200_000);
  const original = JSON.stringify;
  const originalEncode = TextEncoder.prototype.encode;
  let stringified = 0,
    runArgs = 0,
    encodes = 0;
  JSON.stringify = ((value: unknown, ...rest: unknown[]) => {
    if (
      value &&
      typeof value === "object" &&
      Array.isArray((value as { entries?: unknown }).entries)
    )
      runArgs++;
    const out = (original as unknown as (...a: unknown[]) => string).call(
      JSON,
      value,
      ...rest,
    );
    stringified += out?.length ?? 0;
    return out;
  }) as typeof JSON.stringify;
  TextEncoder.prototype.encode = function (this: TextEncoder, s?: string) {
    encodes++;
    return originalEncode.call(this, s);
  };
  try {
    current.record(asGame(g), "probe", { t: "y".repeat(1200) });
    const currentCost = { stringified, runArgs, encodes };
    stringified = runArgs = encodes = 0;
    legacy.record(g, "probe", { t: "y".repeat(1200) });
    const legacyCost = { stringified, runArgs, encodes };
    JSON.stringify = original;
    TextEncoder.prototype.encode = originalEncode;
    assert.equal(currentCost.runArgs, 0);
    assert.equal(currentCost.encodes, 0);
    assert.ok(
      currentCost.stringified < 5_000,
      `stringified ${currentCost.stringified}`,
    );
    // The oracle demonstrates the counter detects whole-run serialization.
    assert.ok(legacyCost.runArgs >= 1);
    assert.ok(legacyCost.stringified > 200_000);
  } finally {
    JSON.stringify = original;
    TextEncoder.prototype.encode = originalEncode;
  }
});
test("slow diagnostic storage coalesces superseded snapshots while retaining ordered durable completion", async () => {
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
    { g } = scene();
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
  // Only executed writes build a document; legacy built one per flush (101).
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
  const g = syntheticGame("fail", 1);
  logs.record(asGame(g), "a");
  await logs.flush();
  assert.equal(
    logs.error,
    "Game logs could not be saved. Download them before closing.",
  );
  assert.equal(writes.length, 0);
  fail = false;
  logs.record(asGame(g), "b");
  await logs.flush();
  assert.equal(logs.error, "");
  assert.equal(writes.length, 1);
  assert.deepEqual(
    JSON.parse(writes[0]).runs[0].entries.map((e: { type: string }) => e.type),
    ["a", "b"],
  );
  // A flush with nothing new since the previous executed write still writes
  // (matching legacy: every flush call requests a write).
  await logs.flush();
  assert.equal(writes.length, 2);
});
test("recorded diagnostics are detached from later mutation of live objects", async () => {
  let stored = "";
  const logs = new RunLogs({
    read: async () => null,
    write: async (v) => {
      stored = v;
    },
  });
  const physics = { mode: "free", contacts: [1] };
  const g = syntheticGame("detached", 1);
  logs.record(asGame(g), "snapshot", { physics });
  physics.mode = "pinned-with-a-much-longer-label";
  physics.contacts.push(2, 3, 4);
  await logs.flush();
  const saved = JSON.parse(stored).runs[0].entries[0].data;
  assert.deepEqual(saved, { physics: { mode: "free", contacts: [1] } });
  assert.deepEqual(logs.runs[0].entries[0].data, {
    physics: { mode: "free", contacts: [1] },
  });
  assert.equal(stored, JSON.stringify({ version: 1, runs: logs.runs }));
});
test("benchmark compares legacy and current on identical synthetic bursts with equal results", async () => {
  const report = await runBenchmark({ games: 2, bursts: 12, events: 20 });
  assert.equal(report.retainedEqual, true);
  assert.equal(report.storedEqual, true);
  assert.equal(report.records, 2 * 12 * 21);
  assert.ok(Number.isFinite(report.legacyMs) && report.legacyMs >= 0);
  assert.ok(Number.isFinite(report.currentMs) && report.currentMs >= 0);
  assert.equal(report.legacySerializations, 2 * 12 + 1);
  assert.ok(
    report.currentDocumentSerializations <= report.legacySerializations,
  );
});
test("repeated unchanged ended captures cannot evict earlier live diagnostics", () => {
  const logs = new RunLogs(memory()),
    { g } = scene();
  g.id = "ended-repeat";
  for (let i = 1; i <= 30; i++) {
    g.time = i * 2.5;
    logs.capture(g);
  }
  const run = logs.runs[0];
  const live = run.entries.filter(
    (e) =>
      e.type === "snapshot" &&
      (e.data as { status: string }).status === "playing",
  ).length;
  assert.equal(live, 30);
  g.status = "dead";
  g.endedAt = g.time;
  g.seq++;
  g.events.push({
    seq: g.seq,
    at: g.time,
    type: "death",
    floor: 0,
    actor: "human",
    text: "lost",
  });
  logs.capture(g, true);
  const afterEnd = run.entries.length;
  // A browser frame loop forcing captures of an unchanged ended world.
  for (let i = 0; i < LOG_LIMITS.entries * 2; i++) logs.capture(g, true);
  assert.equal(run.entries.length, afterEnd);
  const deaths = run.entries.filter(
    (e) => e.type === "world" && (e.data as { type: string }).type === "death",
  );
  assert.equal(deaths.length, 1);
  // Pause transition is genuine and recorded once; repeats are not.
  g.paused = true;
  logs.capture(g, true);
  logs.capture(g, true);
  assert.equal(run.entries.length, afterEnd + 1);
  assert.equal((run.entries.at(-1)!.data as { paused: boolean }).paused, true);
  g.paused = false;
  // The world keeps running after death: sampled at the normal 2s cadence.
  g.time += 1;
  logs.capture(g);
  assert.equal(run.entries.length, afterEnd + 1); // playable tail stays frozen
  assert.equal(run.audit!.spectator.length, 1); // un-pause snapshot
  g.time += 0.5;
  logs.capture(g);
  assert.equal(run.entries.length, afterEnd + 1); // throttled
  assert.equal(run.audit!.spectator.length, 1);
  g.time += 2;
  logs.capture(g);
  assert.equal(run.entries.length, afterEnd + 1);
  assert.equal(run.audit!.spectator.length, 2);
  assert.equal(
    run.entries.filter(
      (e) =>
        e.type === "snapshot" &&
        (e.data as { status: string }).status === "playing",
    ).length,
    30,
  );
  assert.equal(run.summary!.outcome, "dead");
  assert.equal(run.summary!.duration, 75);
});

test("long spectator activity preserves playable death evidence, performance and late study receipts across reload", async () => {
  let stored: string | null = null;
  const storage = {
    read: async () => stored,
    write: async (v: string) => {
      stored = v;
    },
  };
  const logs = new RunLogs(storage),
    { g } = scene();
  const performance = {
    frames: 121,
    wallMs: 2000,
    slowFrames: 2,
    fps: 60,
    maxFrameMs: 80,
    maxSimulationMs: 40,
    maxWorkMs: 45,
  };
  logs.capture(g);
  logs.record(g, "native-study-transport", {
    requestId: "question-1",
    phase: "waiting",
    payloadJson: "PRIVATE QUESTION",
    transcript: "PRIVATE ANSWER",
  });
  logs.record(g, "performance", performance);
  for (let i = 1; i <= 70; i++) {
    g.time = i * 3;
    logs.record(g, "detail", { payload: "x".repeat(4000) });
    logs.capture(g);
  }
  g.status = "dead";
  g.endedAt = g.time;
  g.stats.deaths = 1;
  g.survivors[0].alive = false;
  g.survivors[0].hp = 0;
  g.events.push({
    seq: ++g.seq,
    at: g.time,
    type: "death",
    actor: "human",
    floor: 0,
    text: "lost",
  });
  logs.capture(g, true);
  const playable = JSON.stringify(logs.runs[0].entries),
    ending = JSON.stringify(logs.runs[0].audit!.ended);
  for (let i = 0; i < 500; i++) {
    g.time += 3;
    g.events.push({
      seq: ++g.seq,
      at: g.time,
      type: "horde-climb",
      floor: 0,
      text: "climb",
    });
    logs.capture(g);
    logs.record(g, "performance", {
      ...performance,
      frames: 241,
      fps: 120,
      slowFrames: 0,
      maxFrameMs: 10,
    });
  }
  logs.record(g, "native-study-transport", {
    requestId: "question-1",
    phase: "applied",
    appliedAt: g.time,
    transcript: "PRIVATE ANSWER",
  });
  logs.record(g, "browser-error", { file: "game.js", line: 42 });
  await logs.flush();
  const loaded = new RunLogs(storage);
  await loaded.load();
  const run = loaded.runs[0],
    audit = run.audit!;
  assert.equal(JSON.stringify(run.entries), playable);
  assert.equal(JSON.stringify(audit.ended), ending);
  assert.equal(audit.performance.playable!.fps, 60);
  assert.equal(audit.performance.playable!.slowFrames, 2);
  assert.equal(audit.performance.spectator!.fps, 120);
  assert.equal(audit.performance.spectator!.samples, 500);
  assert.deepEqual(
    audit.events
      .filter((e) => e.type === "native-study-transport")
      .map((e) => (e.data as { phase: string }).phase),
    ["waiting", "applied"],
  );
  assert.ok(
    audit.events.some(
      (e) =>
        e.type === "world" && (e.data as { type: string }).type === "death",
    ),
  );
  assert.ok(audit.events.some((e) => e.type === "browser-error"));
  assert.ok(audit.dropped.spectator > 0);
  assert.ok(audit.dropped.details > 0);
  assert.equal(audit.timeline[0].at, 0);
  assert.equal(audit.partial, false);
  assert.ok(Buffer.byteLength(JSON.stringify(run)) <= LOG_LIMITS.bytesPerGame);
  assert.ok(!JSON.stringify(audit).includes("PRIVATE"));
  assert.equal(stored, JSON.stringify({ version: 1, runs: logs.runs }));
});

test("timeline compaction retains opening and recent progress with explicit coverage loss", () => {
  const logs = new RunLogs(memory()),
    { g } = scene();
  for (let i = 0; i < 400; i++) {
    g.time = i * 31;
    logs.capture(g);
  }
  const audit = logs.runs[0].audit!;
  assert.equal(audit.timeline[0].at, 0);
  assert.equal(audit.timeline.at(-1)!.at, g.time);
  assert.ok(audit.timeline.length <= 48);
  assert.ok(audit.dropped.timeline > 0);
  assert.ok(
    Buffer.byteLength(JSON.stringify(logs.runs[0])) <= LOG_LIMITS.bytesPerGame,
  );
});

test("late observation marks incomplete historical coverage and never invents an exact end snapshot", async () => {
  const { g } = scene();
  g.status = "dead";
  g.endedAt = 50;
  g.time = 700;
  const logs = new RunLogs(memory());
  logs.capture(g);
  const audit = logs.runs[0].audit!;
  assert.equal(audit.partial, true);
  assert.equal(audit.firstObservedAt, 700);
  assert.equal(audit.ended!.at, 50);
  assert.equal((audit.ended!.data as { exact: boolean }).exact, false);
  assert.equal(audit.timeline.length, 0);
  const raw = JSON.parse(logs.export());
  raw.runs[0].audit.performance.playable = { samples: "invalid" };
  const loaded = new RunLogs({
    read: async () => JSON.stringify(raw),
    write: async () => {},
  });
  await loaded.load();
  assert.equal(loaded.runs[0].audit, undefined);
  assert.equal(loaded.runs.length, 1);
});

test("many long runs, Unicode event bursts and spectating stay within three 256 KB records", async () => {
  let stored = "";
  const logs = new RunLogs({
    read: async () => stored,
    write: async (v) => {
      stored = v;
    },
  });
  for (let n = 0; n < 8; n++) {
    const { g } = scene();
    g.id = `bounded-${n}`;
    logs.capture(g);
    for (let i = 0; i < 160; i++) {
      g.time += 31;
      logs.record(g, "native-study-transport", {
        requestId: `q-${i}`,
        phase: "🧟".repeat(200),
        payloadJson: "ignored by audit",
      });
      logs.capture(g);
    }
    g.status = "dead";
    g.endedAt = g.time;
    logs.capture(g, true);
    for (let i = 0; i < 120; i++) {
      g.time += 3;
      logs.capture(g);
    }
    await logs.flush();
    assert.ok(logs.runs.length <= LOG_LIMITS.games);
    for (const run of logs.runs) {
      assert.ok(
        Buffer.byteLength(JSON.stringify(run)) <= LOG_LIMITS.bytesPerGame,
      );
      assert.ok(run.entries.length <= LOG_LIMITS.entries);
      assert.ok(run.audit!.timeline.length <= 48);
      assert.ok(run.audit!.events.length <= 96);
      assert.ok(run.audit!.spectator.length <= 24);
    }
    assert.ok(
      Buffer.byteLength(stored) <=
        LOG_LIMITS.games * LOG_LIMITS.bytesPerGame + 128,
    );
  }
  const loaded = new RunLogs({
    read: async () => stored,
    write: async () => {},
  });
  await loaded.load();
  assert.deepEqual(
    loaded.runs.map((r) => r.id),
    ["bounded-5", "bounded-6", "bounded-7"],
  );
  assert.ok(loaded.runs.every((r) => !!r.audit?.ended));
});

test("a delayed final frame keeps its death events and final snapshot in the playable tail", () => {
  const logs = new RunLogs(memory()),
    { g } = scene();
  logs.capture(g);
  g.time = 30.1;
  g.endedAt = 30;
  g.status = "dead";
  g.events.push({
    seq: ++g.seq,
    at: 30,
    type: "death",
    actor: "human",
    floor: 0,
    text: "lost",
  });
  logs.capture(g);
  const run = logs.runs[0];
  assert.ok(
    run.entries.some(
      (e) =>
        e.type === "world" && (e.data as { type: string }).type === "death",
    ),
  );
  assert.equal((run.entries.at(-1)!.data as { status: string }).status, "dead");
  assert.equal(run.audit!.ended!.at, 30);
  assert.equal(
    (run.audit!.ended!.data as { observedAt: number }).observedAt,
    30.1,
  );
  const playable = JSON.stringify(run.entries);
  g.time = 33;
  logs.capture(g);
  assert.equal(JSON.stringify(run.entries), playable);
  assert.equal(run.audit!.spectator.at(-1)!.at, 33);
});

function storedLogs() {
  let saved: string | null = null;
  return {
    read: async () => saved,
    write: async (value: string) => {
      saved = value;
    },
  };
}
function worldEvent(g: Game, type: string) {
  g.events.push({ seq: ++g.seq, at: g.time, type, floor: 0, text: type });
}

test("reloading never replays world events or study transport into the same run", async () => {
  const storage = storedLogs();
  const { g } = scene();
  g.id = "reload-replay";
  let logs = new RunLogs(storage);
  await logs.load();
  worldEvent(g, "survivor-stairs");
  logs.capture(g);
  assert.equal(logs.noteTransport(g, "question-1", "pending"), true);
  assert.equal(logs.noteTransport(g, "question-1", "pending"), false);
  await logs.flush();
  const worldCount = () =>
    logs.runs[0].entries.filter((e) => e.type === "world").length;
  for (let reload = 0; reload < 5; reload++) {
    logs = new RunLogs(storage);
    await logs.load();
    logs.capture(g, true);
    assert.equal(worldCount(), 1);
    assert.equal(logs.noteTransport(g, "question-1", "pending"), false);
    await logs.flush();
  }
  assert.equal(logs.noteTransport(g, "question-1", "applied"), true);
  worldEvent(g, "survivor-stairs");
  g.time += 3;
  logs.capture(g);
  assert.equal(worldCount(), 2);
  const seqs = logs.runs[0].entries
    .filter((e) => e.type === "world")
    .map((e) => (e.data as { seq: number }).seq);
  assert.deepEqual(seqs, [1, 2]);
});

test("a log written before reload marks resumes from its retained world events", async () => {
  const storage = storedLogs();
  const { g } = scene();
  g.id = "legacy-marks";
  worldEvent(g, "survivor-stairs");
  await storage.write(
    JSON.stringify({
      version: 1,
      runs: [
        {
          id: g.id,
          seed: g.seed,
          started: new Date().toISOString(),
          entries: [{ at: 0, type: "world", data: { seq: 1 } }],
        },
      ],
    }),
  );
  const logs = new RunLogs(storage);
  await logs.load();
  logs.capture(g, true);
  assert.equal(
    logs.runs[0].entries.filter((e) => e.type === "world").length,
    1,
  );
});

test("a new run does not repeat study history that settled before its log began", async () => {
  const { g } = scene();
  g.id = "archive-history";
  const logs = new RunLogs(memory());
  logs.record(g, "start");
  const started = Date.parse(logs.runs[0].started);
  assert.equal(logs.noteTransport(g, "old", "applied", started - 1000), false);
  assert.equal(logs.noteTransport(g, "late", "applied", started + 1000), true);
  assert.equal(logs.noteTransport(g, "live", "pending"), true);
  // An archived request this run already saw pending still reports its receipt.
  assert.equal(logs.noteTransport(g, "live", "applied", started - 1000), true);
});

test("transport marks stay bounded inside the run's byte budget", async () => {
  const { g } = scene();
  g.id = "transport-bound";
  const logs = new RunLogs(memory());
  logs.record(g, "start");
  for (let i = 0; i < 500; i++)
    logs.noteTransport(g, `direct-run-${i}`, `pending/${i}`);
  assert.equal(Object.keys(logs.runs[0].marks!.transport).length, 64);
  assert.ok(logs.noteTransport(g, "direct-run-499", "pending/499") === false);
});

test("what a run was generated from outlives the detail tail", async () => {
  let stored: string | null = null;
  const storage = {
    read: async () => stored,
    write: async (value: string) => {
      stored = value;
    },
  };
  const logs = new RunLogs(storage),
    { g } = scene();
  logs.record(g, "catastrophe-prepared", {
    source: "offline",
    requests: 1,
    repeated: 0,
    failure: "invalid",
    detail: "2 problem(s): title too long",
    catastropheId: "fallback-fire",
    durationMs: 1234,
    spec: { premise: "never retained" },
  });
  logs.record(g, "run-design", {
    title: "St Example",
    source: "claude-cli",
    form: "building",
    venue: "custom",
    neighbors: "buildings",
    ground: "cobble",
    weather: "ash",
    requestId: "design-1",
    generationId: "design-2",
    fingerprint: "abc",
    escape: 1,
    loop: 0,
    catastropheId: "fallback-fire",
    catastropheTitle: "The Fire",
    catastropheKinds: "hazard,collapse",
    catastrophe: { title: "The Fire", behaviours: ["hazard"], hunters: 0 },
    exteriorSigns: 3,
  });
  // A minute of play: large snapshots push both entries out of the tail.
  for (let i = 0; i < 400; i++) {
    g.time += 2;
    logs.record(g, "snapshot", { payload: "x".repeat(4000) });
  }
  await logs.flush();
  const loaded = new RunLogs(storage);
  await loaded.load();
  const run = loaded.runs[0];
  assert.ok(!run.entries.some((e) => e.type === "run-design"));
  const design = run.audit!.events.find((e) => e.type === "run-design")!,
    prepared = run.audit!.events.find(
      (e) => e.type === "catastrophe-prepared",
    )!;
  assert.deepEqual(design.data, {
    requestId: "design-1",
    title: "St Example",
    source: "claude-cli",
    form: "building",
    venue: "custom",
    neighbors: "buildings",
    ground: "cobble",
    weather: "ash",
    generationId: "design-2",
    fingerprint: "abc",
    escape: 1,
    loop: 0,
    catastropheId: "fallback-fire",
    catastropheTitle: "The Fire",
    catastropheKinds: "hazard,collapse",
    exteriorSigns: 3,
  });
  assert.deepEqual(prepared.data, {
    source: "offline",
    requests: 1,
    repeated: 0,
    failure: "invalid",
    detail: "2 problem(s): title too long",
    catastropheId: "fallback-fire",
    durationMs: 1234,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(run)) <= LOG_LIMITS.bytesPerGame);
});
test("an escape game's seeded horde never counts toward the zombie peak", () => {
  const logs = new RunLogs(memory()),
    { g } = scene();
  type Zombie = Game["zombies"][number];
  g.zombies = [{ id: "z-1", hp: 10 } as unknown as Zombie];
  logs.record(g, "legacy");
  assert.equal(logs.runs[0].summary!.peakZombies, 1);
  g.id = "run-escape";
  g.escape = {} as NonNullable<Game["escape"]>;
  logs.record(g, "start");
  assert.equal(logs.runs[1].summary!.peakZombies, 0);
  g.zombies[0].hunter = {} as NonNullable<Zombie["hunter"]>;
  logs.record(g, "later");
  assert.equal(logs.runs[1].summary!.peakZombies, 1);
});
