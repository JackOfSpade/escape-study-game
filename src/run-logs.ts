import { isRecord } from "./records";
import type { Game } from "./model";
import {
  AUDIT_LIMITS,
  auditJson,
  restoreAudit,
  spectatorRecord,
  updateAudit,
  type RunAudit,
} from "./run-log-audit";
export const LOG_KEY = "recent-game-diagnostics-v1";
export const LOG_LIMITS = { games: 3, entries: 400, bytesPerGame: 256_000 };
const TRANSPORT_MARKS = 64;
interface Entry {
  at: number;
  type: string;
  data: unknown;
}
interface RunLog {
  id: string;
  seed: number;
  started: string;
  entries: Entry[];
  audit?: RunAudit;
  /** What this run has already logged, so a page reload never replays it. */
  marks?: { world: number; transport: Record<string, string> };
  summary?: {
    duration: number;
    outcome: string;
    deaths: number;
    rescued: number;
    breaches: number;
    snapshots: number;
    peakZombies: number;
  };
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
  seed: number;
  started: string;
  prefix: string;
  prefixBytes: number;
}
/** Operation counters used by regression tests and the benchmark. */
export interface RunLogStats {
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
  private observed = new Map<
    string,
    { seq: number; time: number; status: Game["status"]; paused: boolean }
  >();
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
            if (!run) continue;
            retained.delete(run.id);
            retained.set(run.id, run);
          }
          this.runs = [...retained.values()].slice(-LOG_LIMITS.games);
        }
      }
      for (const run of this.runs) this.trim(run);
    } catch {
      this.error = "Could not read previous game logs.";
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
        seed: NaN,
        started: "",
        prefix: "",
        prefixBytes: -1,
      };
      this.caches.set(run, c);
    }
    if (
      c.prefixBytes < 0 ||
      c.id !== run.id ||
      !Object.is(c.seed, run.seed) ||
      c.started !== run.started
    ) {
      c.id = run.id;
      c.seed = run.seed;
      c.started = run.started;
      c.prefix = `{"id":${JSON.stringify(run.id)},"seed":${JSON.stringify(run.seed)},"started":${JSON.stringify(run.started)},"entries":[`;
      c.prefixBytes = utf8Length(c.prefix);
    }
    return c;
  }
  private suffix(run: RunLog) {
    const summary =
      run.summary === undefined
        ? ""
        : `,"summary":${JSON.stringify(run.summary)}`;
    const audit =
      run.audit === undefined ? "" : `,"audit":${auditJson(run.audit)}`;
    const marks =
      run.marks === undefined ? "" : `,"marks":${JSON.stringify(run.marks)}`;
    return `]${summary}${audit}${marks}}`;
  }
  private drop(run: RunLog, c: RunCache, count: number) {
    if (count <= 0) return;
    run.entries.splice(0, count);
    c.json.splice(0, count);
    for (const b of c.bytes.splice(0, count)) c.sum -= b;
    if (run.audit) run.audit.dropped.details += count;
  }
  /**
   * Bounds the detail tail by count and UTF-8 bytes. Real runs reserve 64 KB
   * for lifecycle evidence; older minimal logs retain their original policy.
   */
  private trim(run: RunLog) {
    const c = this.cache(run);
    if (run.entries.length > LOG_LIMITS.entries)
      this.drop(run, c, run.entries.length - LOG_LIMITS.entries);
    // Reserve audit space from the start: spectator samples and late transport
    // receipts must never compete with the playable detail tail after death.
    const header =
      c.prefixBytes +
      utf8Length(this.suffix(run)) +
      (run.audit
        ? Math.max(0, AUDIT_LIMITS.bytes - utf8Length(auditJson(run.audit))) +
          32
        : 0);
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
    return c.prefix + c.json.join(",") + this.suffix(run);
  }
  /** Byte-identical to JSON.stringify({ version: 1, runs: this.runs }). */
  private serialize() {
    this.stats.documentSerializations++;
    return `{"version":1,"runs":[${this.runs.map((r) => this.serializeRun(r)).join(",")}]}`;
  }

  record(g: Game, type: string, data: unknown = null) {
    const at = Math.round(g.time * 100) / 100;
    // Serialize once and keep a detached copy: retained diagnostics cannot
    // drift with later mutation of live physics/path objects, so byte
    // accounting always matches what is written.
    const json = JSON.stringify({ at, type, data });
    this.stats.entrySerializations++;
    const entry = JSON.parse(json) as Entry;
    let run = this.runs.find((r) => r.id === g.id);
    if (!run) {
      run = {
        id: g.id,
        seed: g.seed,
        started: new Date().toISOString(),
        entries: [],
      };
      this.runs.push(run);
      this.runs = this.runs.slice(-LOG_LIMITS.games);
      for (const id of this.observed.keys())
        if (!this.runs.some((r) => r.id === id)) this.observed.delete(id);
    }
    run.summary = {
      duration: Math.max(
        run.summary?.duration ?? 0,
        // The human's run lasts until death/extraction even though the
        // world (and spectator sampling) continues afterwards.
        Math.round((g.endedAt ?? g.time) * 100) / 100,
      ),
      outcome: type === "restart" ? "restarted" : g.status,
      deaths: g.stats.deaths,
      rescued: g.stats.rescued,
      breaches: g.stats.breaches,
      snapshots: run.summary?.snapshots ?? 0,
      peakZombies: Math.max(
        run.summary?.peakZombies ?? 0,
        g.zombies.filter((z) => z.hp > 0).length,
      ),
    };
    if (type === "snapshot") run.summary.snapshots++;
    run.audit = updateAudit(g, run.audit, entry);
    // Leave old minimal/legacy records byte-compatible with the rolling
    // logger; only real worlds acquire the optional lifecycle audit.
    if (!run.audit) delete run.audit;
    if (spectatorRecord(run.audit, at)) {
      this.trim(run);
      return;
    }
    const c = this.cache(run);
    run.entries.push(entry);
    c.json.push(json);
    const bytes = utf8Length(json);
    c.bytes.push(bytes);
    c.sum += bytes;
    this.trim(run);
  }
  capture(g: Game, force = false) {
    if (g.status === "ready") return;
    const previous = this.observed.get(g.id);
    const paused = !!g.paused;
    const transition =
      !previous || previous.status !== g.status || previous.paused !== paused;
    // An unchanged world (same time, event sequence, status and pause) adds no
    // information; repeated ended/paused captures must never evict history.
    if (
      previous &&
      !transition &&
      previous.seq === g.seq &&
      previous.time === g.time
    )
      return;
    // The world keeps running after the human's run ends, so the normal 2s
    // sampling applies to every active status; transitions always record.
    if (
      !force &&
      previous &&
      !transition &&
      g.time - previous.time < 2 &&
      previous.time <= g.time
    )
      return;
    const logged =
      previous?.seq ?? this.runs.find((r) => r.id === g.id)?.marks?.world ?? 0;
    for (const e of g.events.filter((e) => e.seq > logged))
      this.record(g, "world", {
        seq: e.seq,
        occurredAt: e.at,
        type: e.type,
        actor: e.actor,
        floor: e.floor,
        encounter: e.encounter,
        position: e.position,
      });
    const round = (n: number) => Math.round(n * 100) / 100;
    const audit = this.runs.find((r) => r.id === g.id)?.audit;
    this.record(
      g,
      "snapshot",
      spectatorRecord(audit, round(g.time))
        ? null
        : {
            status: g.status,
            paused: !!g.paused,
            actors: g.survivors.map((a) => ({
              id: a.id,
              floor: a.floor,
              x: round(a.x),
              y: round(a.y),
              hp: round(a.hp),
              alive: a.alive,
              escaped: a.escaped,
              activity: a.activity,
              keys: a.keys,
              studyLoop: a.studyLoop && {
                phase: a.studyLoop.phase,
                station: a.studyLoop.station,
                target: a.studyLoop.waypoints[0],
                window: round(a.studyLoop.window),
              },
              handling: a.handling,
              physics: a.physics,
              blocked: a.blockedTime,
              doorway: a.doorTraffic && {
                id: a.doorTraffic.door,
                lane: a.doorTraffic.lane,
                side: a.doorTraffic.side,
              },
              traffic: a.trafficPass && {
                side: a.trafficPass.side,
                remaining: round(Math.max(0, a.trafficPass.until - g.time)),
              },
              path: a.path.slice(0, 2),
              plan: a.defensePlan && {
                object: a.defensePlan.object,
                idle: a.defensePlan.idle,
                target: a.defensePlan.target,
              },
            })),
            furniture: g.floors.flatMap((f) =>
              f.furniture
                .filter(
                  (o) =>
                    o.moved > 0 ||
                    o.hp < o.maxHp ||
                    o.door ||
                    o.field ||
                    o.id === "main-gate",
                )
                .map((o) => ({
                  id: o.id,
                  kind: o.kind,
                  turning: o.turning,
                  x: round(o.x),
                  y: round(o.y),
                  w: o.w,
                  h: o.h,
                  angle: round(o.angle ?? 0),
                  physics: o.physics,
                  door: o.door && {
                    latched: o.door.latched,
                    side: o.door.side,
                  },
                  field: o.field && {
                    used: o.field.used,
                    limit: o.field.limit,
                    authorized: [...o.field.authorized],
                    crossing: [...o.field.crossing],
                  },
                  hp: round(o.hp),
                  maxHp: round(o.maxHp),
                  destroyed: o.destroyed,
                })),
            ),
            zombieCount: g.zombies.filter((z) => z.hp > 0).length,
            zombiesOmitted: Math.max(
              0,
              g.zombies.filter((z) => z.hp > 0).length - 80,
            ),
            zombies: g.zombies
              .filter((z) => z.hp > 0)
              .slice(-80)
              .map((z) => ({
                id: z.id,
                floor: z.floor,
                x: round(z.x),
                y: round(z.y),
                hp: round(z.hp),
                target: z.target,
                path: z.path.slice(0, 2),
              })),
          },
    );
    this.observed.set(g.id, {
      seq: g.seq,
      time: g.time,
      status: g.status,
      paused,
    });
    const run = this.runs.find((r) => r.id === g.id);
    if (run) (run.marks ??= { world: 0, transport: {} }).world = g.seq;
    this.flush();
  }
  /** Marks a study transport state, returning whether it is new to this run's
   * log. An archived request that settled before this log began belongs to an
   * earlier run's history, so a new run does not repeat it. */
  noteTransport(
    g: Game,
    id: string,
    state: string,
    archivedSettledAt?: number,
  ) {
    const run = this.runs.find((r) => r.id === g.id);
    const seen = run?.marks?.transport;
    if (seen?.[id] === state) return false;
    if (
      archivedSettledAt !== undefined &&
      seen?.[id] === undefined &&
      archivedSettledAt < (run ? Date.parse(run.started) : Date.now())
    )
      return false;
    if (run) {
      const marks = (run.marks ??= { world: 0, transport: {} });
      delete marks.transport[id];
      marks.transport[id] = state;
      const ids = Object.keys(marks.transport);
      if (ids.length > TRANSPORT_MARKS) delete marks.transport[ids[0]];
    }
    return true;
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
          "Game logs could not be saved. Download them before closing.";
      }
    });
    return this.queue;
  }
}

/** Logs written before marks existed fall back to their retained world events. */
function restoredMarks(value: unknown, run: RunLog): RunLog["marks"] {
  if (
    isRecord(value) &&
    typeof value.world === "number" &&
    Number.isFinite(value.world) &&
    isRecord(value.transport)
  ) {
    const transport = Object.fromEntries(
      Object.entries(value.transport)
        .filter(
          (mark): mark is [string, string] =>
            mark[0].length <= 256 &&
            typeof mark[1] === "string" &&
            mark[1].length <= 256,
        )
        .slice(-TRANSPORT_MARKS),
    );
    return { world: value.world, transport };
  }
  const seqs = [
    ...run.entries,
    ...(run.audit?.events ?? []),
    ...(run.audit?.spectator ?? []),
  ].flatMap((e) =>
    e.type === "world" && isRecord(e.data) && typeof e.data.seq === "number"
      ? [e.data.seq]
      : [],
  );
  return seqs.length ? { world: Math.max(...seqs), transport: {} } : undefined;
}

function restoredRun(value: unknown): RunLog | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    value.id.length > 128 ||
    typeof value.started !== "string" ||
    value.started.length > 64 ||
    typeof value.seed !== "number" ||
    !Number.isFinite(value.seed) ||
    !Array.isArray(value.entries)
  )
    return;
  const entries: Entry[] = [];
  for (const e of value.entries.slice(-LOG_LIMITS.entries))
    if (
      isRecord(e) &&
      typeof e.at === "number" &&
      Number.isFinite(e.at) &&
      typeof e.type === "string" &&
      e.type.length <= 128
    )
      entries.push({ at: e.at, type: e.type, data: e.data ?? null });
  const run: RunLog = {
    id: value.id,
    seed: value.seed,
    started: value.started,
    entries,
  };
  const summary = value.summary;
  if (
    isRecord(summary) &&
    typeof summary.outcome === "string" &&
    summary.outcome.length <= 32
  ) {
    const counts = [
      "duration",
      "deaths",
      "rescued",
      "breaches",
      "snapshots",
      "peakZombies",
    ] as const;
    if (
      counts.every(
        (k) =>
          typeof summary[k] === "number" &&
          Number.isFinite(summary[k]) &&
          (summary[k] as number) >= 0,
      )
    )
      run.summary = {
        duration: summary.duration as number,
        outcome: summary.outcome,
        deaths: summary.deaths as number,
        rescued: summary.rescued as number,
        breaches: summary.breaches as number,
        snapshots: summary.snapshots as number,
        peakZombies: summary.peakZombies as number,
      };
  }
  const audit = restoreAudit(value.audit);
  if (audit) run.audit = audit;
  const marks = restoredMarks(value.marks, run);
  if (marks) run.marks = marks;
  return run;
}
