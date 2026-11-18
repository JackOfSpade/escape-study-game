import { isRecord } from "./records";
import type { StudyRecord } from "./model";
export const LOG_KEY = "recent-game-diagnostics-v1";
export const LOG_LIMITS = { games: 3, entries: 400, bytesPerGame: 256_000 };
interface Entry {
  /** Wall-clock time the entry was recorded, ISO 8601. */
  at: string;
  type: string;
  data: unknown;
}
interface RunLog {
  id: string;
  started: string;
  entries: Entry[];
}
interface LogStorage {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
}
/**
 * Per-run serialization cache. Each retained entry is serialized exactly once
 * when recorded (or restored), so retention and writes never re-stringify the
 * whole run. `entries` tracks the array identity the cache describes.
 */
interface RunCache {
  entries: Entry[];
  json: string[];
  bytes: number[];
  sum: number;
  id: string;
  started: string;
  prefix: string;
  prefixBytes: number;
}
/** Operation counters used by regression tests and the benchmark. */
interface RunLogStats {
  /** Individual entries serialized (record/restore), never whole runs. */
  entrySerializations: number;
  /** Full `{version, runs}` documents built; one per executed write. */
  documentSerializations: number;
}
/**
 * UTF-8 byte length of a string, identical to TextEncoder (lone surrogates
 * count as the 3-byte replacement character) without allocating a buffer.
 */
export function utf8Length(s: string) {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}
/** Diagnostics have their own retention policy; pruning never touches learning saves. */
export class RunLogs {
  runs: RunLog[] = [];
  error = "";
  readonly stats: RunLogStats = {
    entrySerializations: 0,
    documentSerializations: 0,
  };
  private queue = Promise.resolve();
  private dirty = false;
  private caches = new WeakMap<RunLog, RunCache>();
  constructor(private storage: LogStorage) {}
  async load() {
    try {
      const raw = await this.storage.read();
      if (raw) {
        const data: unknown = JSON.parse(raw);
        if (isRecord(data) && data.version === 1 && Array.isArray(data.runs)) {
          const retained = new Map<string, RunLog>();
          for (const value of data.runs) {
            const run = restoredRun(value);
            // A run left with nothing readable says nothing; it must not
            // hold one of the few retained slots.
            if (!run?.entries.length) continue;
            retained.delete(run.id);
            retained.set(run.id, run);
          }
          this.runs = [...retained.values()].slice(-LOG_LIMITS.games);
        }
      }
      for (const run of this.runs) this.trim(run);
    } catch {
      this.error = "Could not read previous diagnostics.";
    }
  }
  private cache(run: RunLog): RunCache {
    let c = this.caches.get(run);
    if (
      !c ||
      c.entries !== run.entries ||
      c.json.length !== run.entries.length
    ) {
      const json = run.entries.map((e) => {
        this.stats.entrySerializations++;
        return JSON.stringify(e);
      });
      const bytes = json.map(utf8Length);
      c = {
        entries: run.entries,
        json,
        bytes,
        sum: bytes.reduce((a, b) => a + b, 0),
        id: "",
        started: "",
        prefix: "",
        prefixBytes: -1,
      };
      this.caches.set(run, c);
    }
    if (c.prefixBytes < 0 || c.id !== run.id || c.started !== run.started) {
      c.id = run.id;
      c.started = run.started;
      c.prefix = `{"id":${JSON.stringify(run.id)},"started":${JSON.stringify(run.started)},"entries":[`;
      c.prefixBytes = utf8Length(c.prefix);
    }
    return c;
  }
  private drop(run: RunLog, c: RunCache, count: number) {
    if (count <= 0) return;
    run.entries.splice(0, count);
    c.json.splice(0, count);
    for (const b of c.bytes.splice(0, count)) c.sum -= b;
  }
  /** Bounds the detail tail by count and UTF-8 bytes. */
  private trim(run: RunLog) {
    const c = this.cache(run);
    if (run.entries.length > LOG_LIMITS.entries)
      this.drop(run, c, run.entries.length - LOG_LIMITS.entries);
    const header = c.prefixBytes + utf8Length("]}");
    const n = run.entries.length;
    if (header + c.sum + Math.max(0, n - 1) <= LOG_LIMITS.bytesPerGame) return;
    let bytes = header;
    let keep = 0;
    for (let i = n - 1; i >= 0; i--) {
      const size = c.bytes[i] + (keep ? 1 : 0);
      if (bytes + size > LOG_LIMITS.bytesPerGame) break;
      bytes += size;
      keep++;
    }
    this.drop(run, c, n - keep);
  }
  private serializeRun(run: RunLog) {
    const c = this.cache(run);
    return c.prefix + c.json.join(",") + "]}";
  }
  /** Byte-identical to JSON.stringify({ version: 1, runs: this.runs }). */
  private serialize() {
    this.stats.documentSerializations++;
    return `{"version":1,"runs":[${this.runs.map((r) => this.serializeRun(r)).join(",")}]}`;
  }

  record(g: StudyRecord, type: string, data: unknown = null) {
    // The record's own clock no longer advances, so only wall-clock time can
    // order entries and line them up with the bridge's log.
    const at = new Date().toISOString();
    // Serialize once and keep a detached copy: retained diagnostics cannot
    // drift with later mutation of live objects, so byte accounting always
    // matches what is written.
    const json = JSON.stringify({ at, type, data });
    this.stats.entrySerializations++;
    const entry = JSON.parse(json) as Entry;
    let run = this.runs.find((r) => r.id === g.id);
    if (!run) {
      run = { id: g.id, started: new Date().toISOString(), entries: [] };
      this.runs.push(run);
      this.runs = this.runs.slice(-LOG_LIMITS.games);
    }
    const c = this.cache(run);
    run.entries.push(entry);
    c.json.push(json);
    const bytes = utf8Length(json);
    c.bytes.push(bytes);
    c.sum += bytes;
    this.trim(run);
  }
  export() {
    return JSON.stringify(
      { version: 1, limits: LOG_LIMITS, runs: this.runs },
      null,
      2,
    );
  }
  flush() {
    // Serialize writes; a slower older write cannot overwrite a newer
    // checkpoint. The document is built only when a write actually executes,
    // so superseded flushes during a slow write cost nothing.
    this.dirty = true;
    this.queue = this.queue.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      try {
        await this.storage.write(this.serialize());
        this.error = "";
      } catch {
        this.error =
          "Diagnostics could not be saved. Download them before closing.";
      }
    });
    return this.queue;
  }
}

function restoredRun(value: unknown): RunLog | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    value.id.length > 128 ||
    typeof value.started !== "string" ||
    value.started.length > 64 ||
    !Array.isArray(value.entries)
  )
    return;
  const entries: Entry[] = [];
  for (const e of value.entries.slice(-LOG_LIMITS.entries))
    // Entries stamped with a number came from the record's old clock: the
    // removed game's bulky state dumps, and later entries that all carry the
    // same frozen value. They are dropped so they cannot crowd out a report.
    if (
      isRecord(e) &&
      typeof e.at === "string" &&
      e.at.length <= 64 &&
      typeof e.type === "string" &&
      e.type.length <= 128
    )
      entries.push({ at: e.at, type: e.type, data: e.data ?? null });
  const run: RunLog = { id: value.id, started: value.started, entries };
  return run;
}
