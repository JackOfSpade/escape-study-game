import type { Game } from "./model";
import { isRecord } from "./records";

export const AUDIT_LIMITS = {
  bytes: 64_000,
  timeline: 48,
  events: 96,
  spectator: 24,
};
interface AuditEntry {
  at: number;
  type: string;
  data: unknown;
}
interface PerformanceTotals {
  samples: number;
  frames: number;
  wallMs: number;
  slowFrames: number;
  fps: number;
  minFps: number;
  maxFrameMs: number;
  maxSimulationMs: number;
  maxWorkMs: number;
}
export interface RunAudit {
  version: 1;
  firstObservedAt: number;
  partial: boolean;
  configuration: {
    rules?: string;
    pacing?: string;
    generator?: number;
    fieldPacing?: Game["fieldPacing"];
  };
  timeline: AuditEntry[];
  events: AuditEntry[];
  spectator: AuditEntry[];
  ended?: AuditEntry;
  performance: { playable?: PerformanceTotals; spectator?: PerformanceTotals };
  dropped: {
    timeline: number;
    events: number;
    spectator: number;
    details: number;
  };
}
const serialized = new WeakMap<RunAudit, { json: string; details: number }>();
export function auditJson(audit: RunAudit) {
  const cached = serialized.get(audit);
  if (cached?.details === audit.dropped.details) return cached.json;
  const json = JSON.stringify(audit);
  serialized.set(audit, { json, details: audit.dropped.details });
  return json;
}
const round = (n: number) => Math.round(n * 100) / 100;
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e12;
const importantWorld = new Set([
  "death",
  "breach",
  "climb",
  "survivor-stairs",
  "horde-climb",
  "rescue",
  "board",
  "extraction",
]);
/**
 * What a run was generated from. These entries are written once, at the start
 * of a run, so the rolling detail tail drops them within a minute of play;
 * the audit keeps their scalar fields for the whole run.
 */
const generationMetadata: Record<string, readonly string[]> = {
  "run-design": [
    "title",
    "source",
    "form",
    "venue",
    "neighbors",
    "ground",
    "weather",
    "generationId",
    "fingerprint",
    "escape",
    "loop",
    "catastropheId",
    "catastropheTitle",
    "catastropheKinds",
    "exteriorSigns",
  ],
  "catastrophe-prepared": [
    "source",
    "requests",
    "repeated",
    "failure",
    "detail",
    "catastropheId",
    "durationMs",
  ],
  // Only where the sheet came from: its content stays sealed, logs included.
  "truth-prepared": ["source", "durationMs"],
};
function state(g: Game) {
  const human = g.survivors.find((a) => a.id === "human");
  return {
    status: g.status,
    paused: !!g.paused,
    human: human && {
      floor: human.floor,
      x: round(human.x),
      y: round(human.y),
      hp: round(human.hp),
      alive: human.alive,
      escaped: human.escaped,
      keys: human.keys,
      activity: human.activity,
    },
    floors: g.floors.map((f) => ({
      floor: f.index,
      survivors: g.survivors.filter(
        (a) => a.floor === f.index && a.alive && !a.escaped,
      ).length,
      zombies: g.zombies.filter((z) => z.floor === f.index && z.hp > 0).length,
    })),
    deaths: g.stats.deaths,
    rescued: g.stats.rescued,
    breaches: g.stats.breaches,
  };
}
export function spectatorRecord(audit: RunAudit | undefined, at: number) {
  if (!audit?.ended) return false;
  const data = audit.ended.data;
  // A frame can advance several ticks after death before it captures logs.
  // Keep that entire final capture together when we observed the live run.
  const boundary =
    audit.firstObservedAt <= audit.ended.at &&
    isRecord(data) &&
    finite(data.observedAt)
      ? data.observedAt
      : audit.ended.at;
  return at > boundary;
}
/** Small, content-free lifecycle evidence survives eviction of full snapshots.
 * Game state is sampled, never learner work, chat text, tokens or credentials. */
export function updateAudit(
  g: Game,
  current: RunAudit | undefined,
  entry: AuditEntry,
): RunAudit | undefined {
  // Benchmark/oracle callers intentionally supply a minimal synthetic Game.
  if (!Array.isArray(g.survivors) || !Array.isArray(g.floors)) return current;
  const audit: RunAudit = current ?? {
    version: 1,
    firstObservedAt: entry.at,
    partial: g.time > 0.1,
    configuration: {
      rules: g.rules,
      pacing: g.pacing,
      generator: g.floors[0]?.generation?.version,
    },
    timeline: [],
    events: [],
    spectator: [],
    performance: {},
    dropped: { timeline: 0, events: 0, spectator: 0, details: 0 },
  };
  serialized.delete(audit);
  if (g.fieldPacing && !spectatorRecord(audit, entry.at))
    audit.configuration.fieldPacing = structuredClone(g.fieldPacing);
  const ended = g.status === "dead" || g.status === "escaped";
  if (ended && !audit.ended) {
    audit.ended = {
      at: round(g.endedAt ?? g.time),
      type: "run-ended",
      data: {
        ...state(g),
        observedAt: entry.at,
        exact: g.endedAt === undefined || Math.abs(g.time - g.endedAt) < 0.001,
      },
    };
  }
  const spectator = spectatorRecord(audit, entry.at);
  if (
    !spectator &&
    (!audit.timeline.length || entry.at - audit.timeline.at(-1)!.at >= 30)
  ) {
    audit.timeline.push({ at: entry.at, type: "checkpoint", data: state(g) });
    if (audit.timeline.length > AUDIT_LIMITS.timeline) {
      // Keep the opening and distributed checkpoints across the whole run.
      audit.timeline = audit.timeline.filter(
        (_, i, all) => i % 2 === 0 || i === all.length - 1,
      );
      audit.dropped.timeline +=
        AUDIT_LIMITS.timeline + 1 - audit.timeline.length;
    }
  }
  const data = isRecord(entry.data) ? entry.data : {};
  if (
    entry.type === "performance" &&
    [
      "frames",
      "wallMs",
      "slowFrames",
      "fps",
      "maxFrameMs",
      "maxSimulationMs",
      "maxWorkMs",
    ].every((k) => finite(data[k])) &&
    Number(data.wallMs) > 0
  ) {
    const phase = spectator ? "spectator" : "playable";
    const p = (audit.performance[phase] ??= {
      samples: 0,
      frames: 0,
      wallMs: 0,
      slowFrames: 0,
      fps: 0,
      minFps: Number(data.fps),
      maxFrameMs: 0,
      maxSimulationMs: 0,
      maxWorkMs: 0,
    });
    p.samples++;
    p.frames += Number(data.frames);
    p.wallMs += Number(data.wallMs);
    p.slowFrames += Number(data.slowFrames);
    p.fps = round((Math.max(0, p.frames - p.samples) * 1000) / p.wallMs);
    p.minFps = Math.min(p.minFps, Number(data.fps));
    for (const key of ["maxFrameMs", "maxSimulationMs", "maxWorkMs"] as const)
      p[key] = Math.max(p[key], Number(data[key]));
  }
  const important =
    entry.type in generationMetadata ||
    entry.type === "native-study-transport" ||
    entry.type === "browser-error" ||
    entry.type === "unhandled-rejection" ||
    entry.type === "restart" ||
    (entry.type === "world" && importantWorld.has(String(data.type)));
  if (important) {
    // Whitelist metadata even if a caller accidentally passes a private payload.
    const metadata: Record<string, unknown> = {};
    for (const key of [
      "seq",
      "occurredAt",
      "type",
      "actor",
      "floor",
      "encounter",
      "requestId",
      "state",
      "phase",
      "createdAt",
      "phaseAt",
      "responseReceivedAt",
      "appliedAt",
      "requestBytes",
      "file",
      "line",
      "column",
      ...(generationMetadata[entry.type] ?? []),
    ]) {
      const value = data[key];
      if (typeof value === "number" && Number.isFinite(value))
        metadata[key] = value;
      else if (typeof value === "string") metadata[key] = value.slice(0, 200);
    }
    const stream = spectator && entry.type === "world" ? "spectator" : "events";
    audit[stream].push({ at: entry.at, type: entry.type, data: metadata });
    if (audit[stream].length > AUDIT_LIMITS[stream]) {
      audit[stream].shift();
      audit.dropped[stream]++;
    }
  }
  if (spectator && entry.type === "snapshot") {
    audit.spectator.push({ at: entry.at, type: "snapshot", data: state(g) });
    if (audit.spectator.length > AUDIT_LIMITS.spectator) {
      audit.spectator.shift();
      audit.dropped.spectator++;
    }
  }
  // A second byte cap handles Unicode IDs and restored unusual populations.
  while (
    auditJson(audit).length * 3 > AUDIT_LIMITS.bytes &&
    (audit.spectator.length || audit.events.length || audit.timeline.length > 1)
  ) {
    serialized.delete(audit);
    if (audit.spectator.length) {
      audit.spectator.shift();
      audit.dropped.spectator++;
    } else if (audit.events.length) {
      audit.events.shift();
      audit.dropped.events++;
    } else {
      audit.timeline.splice(1, 1);
      audit.dropped.timeline++;
    }
  }
  return audit;
}

/** Old v1 logs remain readable; missing audit means historical coverage unknown. */
export function restoreAudit(value: unknown): RunAudit | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !finite(value.firstObservedAt) ||
    typeof value.partial !== "boolean" ||
    !isRecord(value.configuration) ||
    !isRecord(value.performance) ||
    !isRecord(value.dropped)
  )
    return;
  for (const key of ["timeline", "events", "spectator"] as const) {
    const items = value[key];
    if (
      !Array.isArray(items) ||
      items.length > AUDIT_LIMITS[key] ||
      !items.every(
        (e) =>
          isRecord(e) &&
          finite(e.at) &&
          typeof e.type === "string" &&
          e.type.length <= 128,
      )
    )
      return;
  }
  if (
    !["timeline", "events", "spectator", "details"].every((k) =>
      finite((value.dropped as Record<string, unknown>)[k]),
    )
  )
    return;
  if (
    value.ended !== undefined &&
    (!isRecord(value.ended) ||
      !finite(value.ended.at) ||
      value.ended.type !== "run-ended")
  )
    return;
  for (const key of ["playable", "spectator"]) {
    const p = value.performance[key];
    if (
      p !== undefined &&
      (!isRecord(p) ||
        ![
          "samples",
          "frames",
          "wallMs",
          "slowFrames",
          "fps",
          "minFps",
          "maxFrameMs",
          "maxSimulationMs",
          "maxWorkMs",
        ].every((k) => finite(p[k])))
    )
      return;
  }
  if (JSON.stringify(value).length * 3 > AUDIT_LIMITS.bytes) return;
  return value as unknown as RunAudit;
}
