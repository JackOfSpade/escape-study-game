/**
 * Event log, timeline condensing and epilogue packets for the escape
 * redesign (docs/ESCAPE_REDESIGN.md section 10).
 *
 * Pure data helpers only: no engine access, no AI, no I/O. The game records a
 * structured `EscapeEvent[]`; when a loop ends this module turns it into a
 * timeline grouped by catastrophe phase and a packet the epilogue writer (or
 * the deterministic fallback) turns into prose.
 */

import type {
  AreaGraph,
  CatastropheSpec,
  EscapeEvent,
  PhaseName,
} from "./escape-types";

/** Newest events kept on a loop's log. */
export const ESCAPE_LOG_LIMIT = 600;

/** Longest single event text kept on the log. */
const TEXT_LIMIT = 240;

/** Longest timeline handed to the epilogue writer. */
const LINE_LIMIT = 120;

/** Deaths in one area this close together are reported as one line. */
const DEATH_CLUSTER_SECONDS = 30;

/** Kinds of event a capped timeline must never drop. */
function isProtectedKind(kind: EscapeEvent["kind"]): boolean {
  return kind === "phase" || kind === "player-end" || kind === "evacuation";
}

/**
 * Name of the phase a "phase" event announces. The phase name is carried in
 * the event's room or text; fall back to the whole text so distinct phase
 * announcements still each keep their first line.
 */
function phaseKey(e: EscapeEvent): string {
  const hay = `${e.room ?? ""} ${e.actorId ?? ""} ${e.text}`.toLowerCase();
  const hit = /\b(omens|onset|spread|peak)\b/.exec(hay);
  if (hit) return hit[1];
  return (e.room ?? e.text).trim().toLowerCase();
}

/** Is this event the first "phase" event of its phase name in `log`? */
function isFirstPhaseEvent(
  log: readonly EscapeEvent[],
  index: number,
): boolean {
  const e = log[index];
  if (e.kind !== "phase") return false;
  const key = phaseKey(e);
  for (let i = 0; i < index; i++) {
    const prev = log[i];
    if (prev.kind === "phase" && phaseKey(prev) === key) return false;
  }
  return true;
}

/**
 * Trim `e` to the text limit and append it, keeping the newest
 * `ESCAPE_LOG_LIMIT` events. The first phase event of each phase name and
 * every player-end event are never dropped: the oldest other event goes
 * instead.
 */
export function logEvent(log: EscapeEvent[], e: EscapeEvent): void {
  const text =
    e.text.length > TEXT_LIMIT ? e.text.slice(0, TEXT_LIMIT) : e.text;
  log.push({ ...e, text });
  while (log.length > ESCAPE_LOG_LIMIT) {
    let victim = -1;
    for (let i = 0; i < log.length; i++) {
      const candidate = log[i];
      if (candidate.kind === "player-end") continue;
      if (candidate.kind === "phase" && isFirstPhaseEvent(log, i)) continue;
      victim = i;
      break;
    }
    if (victim < 0) return; // nothing droppable: the protected tail stays.
    log.splice(victim, 1);
  }
}

/** 'mm:ss', minutes past 59 included (75:03). Negative/NaN reads as 00:00. */
export function formatClock(seconds: number): string {
  const total =
    Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/** Phase in effect at `at`: latest phase at or before it, else 'calm'. */
function phaseAt(spec: CatastropheSpec, at: number): PhaseName | "calm" {
  let best: PhaseName | "calm" = "calm";
  let bestAt = -Infinity;
  for (const phase of spec.timeline.phases) {
    if (phase.at <= at && phase.at >= bestAt) {
      best = phase.name;
      bestAt = phase.at;
    }
  }
  return best;
}

/** Canonical order in which phase groups are reported. */
function phaseOrder(spec: CatastropheSpec): (PhaseName | "calm")[] {
  const ordered = [...spec.timeline.phases].sort((a, b) => a.at - b.at);
  const names: (PhaseName | "calm")[] = ["calm"];
  for (const phase of ordered)
    if (!names.includes(phase.name)) names.push(phase.name);
  return names;
}

/** One bullet of a condensed timeline, before formatting. */
interface Row {
  at: number;
  seq: number;
  area: string;
  text: string;
  /** The row must survive the line cap. */
  keep: boolean;
  /** Times the same (area, text) repeated consecutively. */
  count: number;
}

/** Row kinds that a death cluster replaces. */
function isDeath(e: EscapeEvent): boolean {
  return e.kind === "death";
}

/** Order events by time, keeping log order for equal timestamps. */
function timeOrder(
  log: readonly EscapeEvent[],
): { e: EscapeEvent; seq: number }[] {
  return log
    .map((e, seq) => ({ e, seq }))
    .sort((a, b) => (a.e.at === b.e.at ? a.seq - b.seq : a.e.at - b.e.at));
}

/** Distinct causes, in order of appearance. */
function causesOf(texts: readonly string[]): string[] {
  const out: string[] = [];
  for (const text of texts) {
    const cause = text.trim().replace(/\.$/, "");
    if (cause && !out.includes(cause)) out.push(cause);
  }
  return out;
}

/**
 * Collapse consecutive deaths in the same area within
 * `DEATH_CLUSTER_SECONDS` of the cluster's first death into one row.
 */
function deathRows(
  events: { e: EscapeEvent; seq: number }[],
  areaName: (id: string) => string,
): Row[] {
  const rows: Row[] = [];
  let i = 0;
  while (i < events.length) {
    const { e, seq } = events[i];
    if (!isDeath(e)) {
      rows.push({
        at: e.at,
        seq,
        area: areaName(e.areaId),
        text: e.text,
        keep: isProtectedKind(e.kind),
        count: 1,
      });
      i++;
      continue;
    }
    const cluster = [e];
    let j = i + 1;
    while (j < events.length) {
      const next = events[j].e;
      if (!isDeath(next) || next.areaId !== e.areaId) break;
      if (next.at - e.at > DEATH_CLUSTER_SECONDS) break;
      cluster.push(next);
      j++;
    }
    if (cluster.length > 2) {
      const causes = causesOf(cluster.map((d) => d.text)).join(", ");
      rows.push({
        at: e.at,
        seq,
        area: areaName(e.areaId),
        text: `${cluster.length} people died (${causes})`,
        keep: false,
        count: 1,
      });
    } else {
      for (const death of cluster) {
        rows.push({
          at: death.at,
          seq,
          area: areaName(death.areaId),
          text: death.text,
          keep: isProtectedKind(death.kind),
          count: 1,
        });
      }
    }
    i = j;
  }
  return rows;
}

/** Collapse consecutive identical (area, text) rows into one `(xN)` row. */
function collapseDuplicates(rows: Row[]): Row[] {
  const out: Row[] = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (last && last.area === row.area && last.text === row.text) {
      last.count += 1;
      last.keep = last.keep || row.keep;
      continue;
    }
    out.push({ ...row, count: 1 });
  }
  return out;
}

/**
 * Timeline grouped by the catastrophe phase in effect at each event, in time
 * order. Each line reads `[mm:ss] <Area>: <text>`; consecutive repeats gain
 * ` (xN)` and clustered deaths one summary line. At most 120 lines, keeping
 * every phase, player-end and evacuation line and dropping the oldest others.
 */
export function condenseTimeline(
  log: readonly EscapeEvent[],
  spec: CatastropheSpec,
  areaNames: Record<string, string>,
): { phase: PhaseName | "calm"; lines: string[] }[] {
  const areaName = (id: string) => areaNames[id] ?? id;
  const buckets = new Map<
    PhaseName | "calm",
    { e: EscapeEvent; seq: number }[]
  >();
  for (const entry of timeOrder(log)) {
    const phase = phaseAt(spec, entry.e.at);
    const bucket = buckets.get(phase);
    if (bucket) bucket.push(entry);
    else buckets.set(phase, [entry]);
  }

  const groups = phaseOrder(spec)
    .filter((phase) => buckets.has(phase))
    .map((phase) => ({
      phase,
      rows: collapseDuplicates(deathRows(buckets.get(phase)!, areaName)),
    }));

  let total = groups.reduce((n, g) => n + g.rows.length, 0);
  while (total > LINE_LIMIT) {
    let oldest: { group: (typeof groups)[number]; index: number } | undefined;
    for (const group of groups) {
      for (let index = 0; index < group.rows.length; index++) {
        const row = group.rows[index];
        if (row.keep) continue;
        if (!oldest) {
          oldest = { group, index };
          break;
        }
      }
    }
    if (!oldest) break; // only protected lines remain.
    oldest.group.rows.splice(oldest.index, 1);
    total--;
  }

  return groups.map((group) => ({
    phase: group.phase,
    lines: group.rows.map(
      (row) =>
        `[${formatClock(row.at)}] ${row.area}: ${row.text}${row.count > 1 ? ` (x${row.count})` : ""}`,
    ),
  }));
}

export type EpiloguePacket = {
  title: string;
  premise: string;
  publicStory: string;
  persona: { name: string; role: string };
  outcome: "escaped" | "died" | "quit";
  /** When the loop ended, as 'mm:ss' game time. */
  endedAt: string;
  timeline: ReturnType<typeof condenseTimeline>;
  visitedAreas: string[];
  unbuiltAreas: { name: string; brief: string }[];
  instruction: string;
};

/** Fixed brief sent with every packet; no headings, no invented detail. */
const INSTRUCTION =
  "Write the epilogue as plain prose, at most six short paragraphs, with no headings. " +
  "Open with what was supposed to happen: the premise. " +
  "Then recount what actually happened using only the timeline, in order, keeping the times and areas. " +
  "Describe the unbuilt areas only as likely, saying 'probably' and never as fact. " +
  "End with the player's fate.";

/** Everything the epilogue writer needs, and nothing it must not see. */
export function epiloguePacket(input: {
  spec: CatastropheSpec;
  log: readonly EscapeEvent[];
  areas: AreaGraph;
  persona: { name: string; role: string };
  outcome: "escaped" | "died" | "quit";
  endedAt: number;
}): EpiloguePacket {
  const stubs = Object.values(input.areas.areas);
  const areaNames: Record<string, string> = {};
  for (const stub of stubs) areaNames[stub.id] = stub.name;
  return {
    title: input.spec.title,
    premise: input.spec.premise,
    publicStory: input.spec.publicStory,
    persona: { name: input.persona.name, role: input.persona.role },
    outcome: input.outcome,
    endedAt: formatClock(input.endedAt),
    timeline: condenseTimeline(input.log, input.spec, areaNames),
    visitedAreas: stubs.filter((s) => s.state === "ready").map((s) => s.name),
    unbuiltAreas: stubs
      .filter((s) => s.state !== "ready")
      .map((s) => ({ name: s.name, brief: s.brief })),
    instruction: INSTRUCTION,
  };
}

/** Sentence text for one phase of the timeline. */
function phaseLabel(phase: PhaseName | "calm"): string {
  if (phase === "calm") return "the calm hours";
  if (phase === "omens") return "the omens";
  return `the ${phase}`;
}

/** One summary sentence per phase: how much was logged, and the first beats. */
function phaseSentence(
  phase: PhaseName | "calm",
  lines: readonly string[],
): string {
  const count = lines.length;
  const what =
    count === 1 ? "1 event was logged" : `${count} events were logged`;
  const first = lines[0] ?? "";
  const second = lines[1];
  const tail = second
    ? `, beginning with ${first} and then ${second}`
    : `, beginning with ${first}`;
  return `During ${phaseLabel(phase)}, ${what}${tail}.`;
}

/** Fate sentence, no AI needed. */
function fateSentence(
  persona: { name: string; role: string },
  outcome: EpiloguePacket["outcome"],
): string {
  const who = `${persona.name}, the ${persona.role},`;
  if (outcome === "escaped") return `${who} got out alive.`;
  if (outcome === "died") return `${who} did not survive.`;
  return `${who} left the loop unfinished.`;
}

/** Cut text to a character budget without splitting a word. */
function clampText(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const cut = text.slice(0, budget);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : cut).trimEnd();
}

/**
 * Deterministic prose epilogue, used when the AI writer is unavailable: the
 * premise, one sentence per phase, every unbuilt area as a "probably"
 * sentence, and the player's fate. Never longer than 4000 characters.
 */
export function fallbackEpilogue(p: EpiloguePacket): string {
  const premise = p.premise.trim().replace(/\.$/, "");
  const paragraphs: string[] = [premise ? `${premise}.` : p.title];
  for (const group of p.timeline) {
    if (group.lines.length === 0) continue;
    paragraphs.push(phaseSentence(group.phase, group.lines));
  }
  if (p.unbuiltAreas.length > 0) {
    const lines = p.unbuiltAreas.map((area) => {
      const brief = area.brief.trim().replace(/\.$/, "");
      return `${area.name} was never entered in that loop, though it probably was much as planned: ${brief}.`;
    });
    paragraphs.push(lines.join(" "));
  }
  paragraphs.push(fateSentence(p.persona, p.outcome));
  const text = clampText(paragraphs.filter(Boolean).join("\n\n"), 4000).trim();
  return text;
}

/**
 * Trimmed epilogue text, or undefined when it is not a usable string: needs
 * 40..4000 characters, no markup tags and no URLs.
 */
export function validateEpilogue(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  if (trimmed.length < 40 || trimmed.length > 4000) return undefined;
  if (/<[a-z/!]/i.test(trimmed)) return undefined;
  if (/https?:\/\//i.test(trimmed)) return undefined;
  return trimmed;
}
