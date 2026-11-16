/**
 * Reproducible synthetic comparison of the legacy diagnostic logger (whole-run
 * stringify + UTF-8 encode per record, eager serialization per flush) and the
 * current incremental RunLogs. Uses in-memory storage and generated data only;
 * never reads real saves, learner progress or curriculum.
 *
 *   npx tsx scripts/benchmark-run-logs.ts
 */
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { LOG_LIMITS, RunLogs } from "../src/run-logs";
import type { Game } from "../src/model";

interface LegacyEntry {
  at: number;
  type: string;
  data: unknown;
}
export interface LegacyRun {
  id: string;
  seed: number;
  started: string;
  entries: LegacyEntry[];
  summary?: Record<string, number | string>;
}
/** Minimal synthetic game shape consumed by RunLogs.record. */
export interface LogGame {
  id: string;
  seed: number;
  time: number;
  status: string;
  stats: { deaths: number; rescued: number; breaches: number };
  zombies: { hp: number }[];
}

/** Verbatim copy of the previous retention policy (reference oracle). */
export function legacyTrimRun(run: LegacyRun, encoder = new TextEncoder()) {
  if (run.entries.length > LOG_LIMITS.entries)
    run.entries.splice(0, run.entries.length - LOG_LIMITS.entries);
  if (encoder.encode(JSON.stringify(run)).byteLength <= LOG_LIMITS.bytesPerGame)
    return;
  let bytes = encoder.encode(
    JSON.stringify({ ...run, entries: [] }),
  ).byteLength;
  let keep = 0;
  for (let i = run.entries.length - 1; i >= 0; i--) {
    const size =
      encoder.encode(JSON.stringify(run.entries[i])).byteLength +
      (keep ? 1 : 0);
    if (bytes + size > LOG_LIMITS.bytesPerGame) break;
    bytes += size;
    keep++;
  }
  run.entries.splice(0, run.entries.length - keep);
}

/** The previous RunLogs record/flush behaviour, kept only as a benchmark/test oracle. */
export class LegacyRunLogs {
  runs: LegacyRun[] = [];
  error = "";
  serializations = 0;
  private queue = Promise.resolve();
  private pending: string | undefined;
  private encoder = new TextEncoder();
  constructor(
    private storage: { write(value: string): Promise<void> },
    private now = () => new Date().toISOString(),
  ) {}
  record(g: LogGame, type: string, data: unknown = null) {
    let run = this.runs.find((r) => r.id === g.id);
    if (!run) {
      run = { id: g.id, seed: g.seed, started: this.now(), entries: [] };
      this.runs.push(run);
      this.runs = this.runs.slice(-LOG_LIMITS.games);
    }
    const prev = run.summary as Record<string, number> | undefined;
    run.summary = {
      duration: Math.max(prev?.duration ?? 0, Math.round(g.time * 100) / 100),
      outcome: type === "restart" ? "restarted" : g.status,
      deaths: g.stats.deaths,
      rescued: g.stats.rescued,
      breaches: g.stats.breaches,
      snapshots: (prev?.snapshots ?? 0) + (type === "snapshot" ? 1 : 0),
      peakZombies: Math.max(
        prev?.peakZombies ?? 0,
        g.zombies.filter((z) => z.hp > 0).length,
      ),
    };
    run.entries.push({ at: Math.round(g.time * 100) / 100, type, data });
    legacyTrimRun(run, this.encoder);
  }
  flush() {
    this.serializations++;
    this.pending = JSON.stringify({ version: 1, runs: this.runs });
    this.queue = this.queue.then(async () => {
      const snapshot = this.pending;
      if (snapshot === undefined) return;
      this.pending = undefined;
      try {
        await this.storage.write(snapshot);
        this.error = "";
      } catch {
        this.error =
          "Game logs could not be saved. Download them before closing.";
      }
    });
    return this.queue;
  }
}

/** Deterministic PRNG (mulberry32). */
export function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function syntheticGame(id: string, seed: number): LogGame {
  return {
    id,
    seed,
    time: 0,
    status: "playing",
    stats: { deaths: 0, rescued: 0, breaches: 0 },
    zombies: [],
  };
}

/** Synthetic snapshot-sized payload (20 actors) with escaping and multibyte text. */
function syntheticSnapshot(rand: () => number, n: number) {
  return {
    status: "playing",
    paused: false,
    actors: Array.from({ length: 20 }, (_, i) => ({
      id: `npc-${i}`,
      floor: i % 4,
      x: Math.round(rand() * 4400) / 100,
      y: Math.round(rand() * 3400) / 100,
      hp: Math.round(rand() * 10000) / 100,
      alive: true,
      activity: i % 3 ? 'moving "quoted"\n' : "défense 🧟",
      path: [{ x: n, y: i }],
    })),
    zombies: [],
  };
}

/** Normalizes the wall-clock `started` field, the only nondeterministic value. */
export function normalized(runs: unknown) {
  return JSON.stringify(runs, (k, v) => (k === "started" ? "" : v));
}

export async function runBenchmark(
  options = { games: 3, bursts: 60, events: 40 },
) {
  const stamp = "2000-01-01T00:00:00.000Z";
  let legacyStored = "";
  let currentStored = "";
  const legacy = new LegacyRunLogs(
    {
      write: async (v) => {
        legacyStored = v;
      },
    },
    () => stamp,
  );
  const current = new RunLogs({
    read: async () => null,
    write: async (v) => {
      currentStored = v;
    },
  });
  const drive = async (
    record: (g: LogGame, type: string, data: unknown) => void,
    flush: () => Promise<void>,
  ) => {
    const rand = prng(1234);
    let records = 0;
    const started = performance.now();
    for (let game = 0; game < options.games; game++) {
      const g = syntheticGame(`synthetic-${game}`, 1000 + game);
      for (let burst = 0; burst < options.bursts; burst++) {
        g.time = burst * 3 + rand();
        for (let e = 0; e < options.events; e++, records++)
          record(g, "world", {
            seq: burst * options.events + e,
            type: "contact",
            actor: `npc-${e % 20}`,
            floor: e % 4,
          });
        record(g, "snapshot", syntheticSnapshot(rand, burst));
        records++;
        void flush();
      }
    }
    const recordMs = performance.now() - started;
    await flush();
    return { records, ms: performance.now() - started, recordMs };
  };
  const legacyResult = await drive(
    (g, t, d) => legacy.record(g, t, d),
    () => legacy.flush(),
  );
  const currentResult = await drive(
    (g, t, d) => current.record(g as unknown as Game, t, d),
    () => current.flush(),
  );
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    mode: "Synthetic in-memory bounded burst; no real saves, learner content or curriculum",
    limits: LOG_LIMITS,
    options,
    records: currentResult.records,
    legacyMs: round(legacyResult.ms),
    currentMs: round(currentResult.ms),
    speedup: round(legacyResult.ms / Math.max(currentResult.ms, 1e-6)),
    legacySerializations: legacy.serializations,
    currentDocumentSerializations: current.stats.documentSerializations,
    retainedEntries: current.runs.map((r) => r.entries.length),
    retainedEqual: normalized(legacy.runs) === normalized(current.runs),
    storedEqual:
      normalized(JSON.parse(legacyStored)) ===
      normalized(JSON.parse(currentStored)),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const report = await runBenchmark();
  console.log(JSON.stringify(report, null, 2));
  if (!report.retainedEqual || !report.storedEqual) process.exitCode = 1;
}
