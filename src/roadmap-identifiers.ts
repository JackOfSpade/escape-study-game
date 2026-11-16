import type { LearnerLedger, LearningAttempt } from "./learning-model";
import type { Roadmap } from "./model";
import { inspectMergedDocument } from "./roadmap-structure";

export interface IdentifierCounters {
  nextSession: number;
  nextGap: number;
  nextDecision: number;
  attempts: Record<string, number>;
  evidence: Record<string, number>;
}
const heading = "S0.7 Shared identifier counters";
const positive = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
function validateIdentifierCounters(c: IdentifierCounters) {
  if (
    !c ||
    !positive(c.nextSession) ||
    !positive(c.nextGap) ||
    !positive(c.nextDecision) ||
    !c.attempts ||
    !c.evidence ||
    Array.isArray(c.attempts) ||
    Array.isArray(c.evidence)
  )
    throw Error("Invalid shared identifier counters");
  for (const values of [c.attempts, c.evidence])
    for (const [session, n] of Object.entries(values))
      if (
        !/^S\d{4}$/.test(session) ||
        Number(session.slice(1)) === 0 ||
        !positive(n)
      )
        throw Error("Invalid per-session identifier counter");
}
export function mergeIdentifierCounters(
  ...items: IdentifierCounters[]
): IdentifierCounters {
  const result: IdentifierCounters = {
    nextSession: 1,
    nextGap: 1,
    nextDecision: 1,
    attempts: {},
    evidence: {},
  };
  for (const c of items) {
    validateIdentifierCounters(c);
    result.nextSession = Math.max(result.nextSession, c.nextSession);
    result.nextGap = Math.max(result.nextGap, c.nextGap);
    result.nextDecision = Math.max(result.nextDecision, c.nextDecision);
    for (const kind of ["attempts", "evidence"] as const)
      for (const [session, n] of Object.entries(c[kind]))
        result[kind][session] = Math.max(result[kind][session] ?? 1, n);
  }
  return result;
}
export function countersCover(a: IdentifierCounters, b: IdentifierCounters) {
  validateIdentifierCounters(a);
  validateIdentifierCounters(b);
  return (
    a.nextSession >= b.nextSession &&
    a.nextGap >= b.nextGap &&
    a.nextDecision >= b.nextDecision &&
    Object.entries(b.attempts).every(([s, n]) => (a.attempts[s] ?? 1) >= n) &&
    Object.entries(b.evidence).every(([s, n]) => (a.evidence[s] ?? 1) >= n)
  );
}
const next = (n: number) => {
  if (!Number.isSafeInteger(n) || n < 0 || n >= Number.MAX_SAFE_INTEGER)
    throw Error("Identifier counter exceeds safe integer range");
  return n + 1;
};
/** Only actual progress-row identities count as allocated. Curriculum examples,
 * quoted history and the next-counter declaration are not issued tasks. */
function recordedIdentifierCounters(raw: string): IdentifierCounters {
  const c: IdentifierCounters = {
    nextSession: 1,
    nextGap: 1,
    nextDecision: 1,
    attempts: {},
    evidence: {},
  };
  const doc = inspectMergedDocument(raw),
    seen = new Set<string>();
  for (const [key, line] of doc.rows) {
    const id = line.split("|")[1]?.trim();
    const formal = /^(S\d{4})-(A|EV)(\d{2,})$/.exec(id);
    if (
      /\/0\.5(?:\.1)? /.test(key) &&
      /^S\d+-/.test(id) &&
      (!formal ||
        !positive(Number(formal[3])) ||
        Number(formal[1].slice(1)) === 0 ||
        formatIdentifier(`${formal[1]}-${formal[2]}`, Number(formal[3])) !== id)
    )
      throw Error("Noncanonical assessment identifier in a progress register");
    if (formal && /\/0\.5(?:\.1)? /.test(key)) {
      if (seen.has(id))
        throw Error(`Assessment identifier reused across tracks: ${id}`);
      seen.add(id);
      const kind = formal[2] === "A" ? "attempts" : "evidence";
      c[kind][formal[1]] = Math.max(
        c[kind][formal[1]] ?? 1,
        next(Number(formal[3])),
      );
      c.nextSession = Math.max(c.nextSession, next(Number(formal[1].slice(1))));
    }
    if (/^S\d{4}$/.test(id) && key.startsWith("SHARED_PROGRESS/S0.4 "))
      c.nextSession = Math.max(c.nextSession, next(Number(id.slice(1))));
    if (/^G\d{4}$/.test(id) && key.includes("/0.6 Facet gaps,"))
      c.nextGap = Math.max(c.nextGap, next(Number(id.slice(1))));
    if (/^DEC\d{4}$/.test(id))
      c.nextDecision = Math.max(c.nextDecision, next(Number(id.slice(3))));
  }
  return c;
}
function counterClaim(shared: string): IdentifierCounters | undefined {
  let declared: IdentifierCounters | undefined;
  const field =
    shared
      .split("\n")
      .find((s) =>
        s.startsWith("| Reserved next identifiers (shared counters) |"),
      )
      ?.split("|")[2]
      ?.trim() ?? "";
  const game =
    /^(S\d{4}): next shared attempt (S\d{4})-A(\d+), evidence (S\d{4})-EV(\d+); next gap G(\d+); next shared decision DEC(\d+); next genuinely new session S(\d+)$/.exec(
      field,
    );
  const original =
    /Next (S\d{4}) attempt A(\d+) and evidence EV(\d+); next global gap G(\d+); next shared decision DEC(\d+)\. A genuinely new session after S\d{4} is S(\d+)/.exec(
      field,
    );
  if (game) {
    if (game[1] !== game[2] || game[1] !== game[4])
      throw Error("Shared next identifiers name different allocation sessions");
    declared = {
      nextSession: Number(game[8]),
      nextGap: Number(game[6]),
      nextDecision: Number(game[7]),
      attempts: { [game[1]]: Number(game[3]) },
      evidence: { [game[1]]: Number(game[5]) },
    };
  } else if (original)
    declared = {
      nextSession: Number(original[6]),
      nextGap: Number(original[4]),
      nextDecision: Number(original[5]),
      attempts: { [original[1]]: Number(original[2]) },
      evidence: { [original[1]]: Number(original[3]) },
    };
  return declared;
}
/** Exact portable counters; revision9 and earlier game saves retain a bounded
 * legacy reader. An unfamiliar claim needs reconciliation, never a reset. */
export function readIdentifierCounters(raw: string, strict = true) {
  const doc = inspectMergedDocument(raw),
    minimum = recordedIdentifierCounters(raw),
    shared = doc.blocks.SHARED_PROGRESS;
  const field =
    shared
      .split("\n")
      .find((s) =>
        s.startsWith("| Reserved next identifiers (shared counters) |"),
      )
      ?.split("|")[2] ?? "";
  const prefix = field.split(/\bNext |\bnext shared attempt/)[0];
  for (const match of prefix.matchAll(
    /(S\d{4})-(A|EV)(\d+)(?:[–-](?:\1-)?(?:A|EV)?(\d+))?/g,
  )) {
    const values = match[2] === "A" ? minimum.attempts : minimum.evidence;
    values[match[1]] = Math.max(
      values[match[1]] ?? 1,
      next(Math.max(Number(match[3]), Number(match[4] ?? match[3]))),
    );
    minimum.nextSession = Math.max(
      minimum.nextSession,
      next(Number(match[1].slice(1))),
    );
  }
  for (const m of prefix.matchAll(/\bG(\d{4})(?:[–-]G?(\d{4}))?\b/g))
    minimum.nextGap = Math.max(
      minimum.nextGap,
      next(Math.max(Number(m[1]), Number(m[2] ?? m[1]))),
    );
  for (const m of prefix.matchAll(/\bDEC(\d{4})(?:[–-](?:DEC)?(\d{4}))?\b/g))
    minimum.nextDecision = Math.max(
      minimum.nextDecision,
      next(Math.max(Number(m[1]), Number(m[2] ?? m[1]))),
    );
  let declared: IdentifierCounters | undefined;
  if (shared.includes(`### ${heading}\n`)) {
    const section = shared.split(`### ${heading}\n`)[1].split("\n### ")[0];
    const c: IdentifierCounters = {
      nextSession: 1,
      nextGap: 1,
      nextDecision: 1,
      attempts: {},
      evidence: {},
    };
    const seen = new Set<string>();
    if (section.split("\n").some((s) => s.trim() && !s.startsWith("|")))
      throw Error("Unrecognized content in shared identifier counter metadata");
    for (const row of section.split("\n").filter((s) => s.startsWith("|"))) {
      const cells = row
        .split("|")
        .slice(1, -1)
        .map((s) => s.trim());
      if (cells[0] === "Counter" || cells.every((s) => /^-+$/.test(s)))
        continue;
      if (cells.length !== 3 || !/^\d+$/.test(cells[2]))
        throw Error("Malformed shared identifier counter row");
      const [kind, scope, value] = cells,
        key = `${kind}/${scope}`,
        n = Number(value);
      if (seen.has(key)) throw Error("Duplicate shared identifier counter row");
      seen.add(key);
      if (scope === "GLOBAL" && kind === "session") c.nextSession = n;
      else if (scope === "GLOBAL" && kind === "gap") c.nextGap = n;
      else if (scope === "GLOBAL" && kind === "decision") c.nextDecision = n;
      else if (/^S\d{4}$/.test(scope) && ["attempt", "evidence"].includes(kind))
        (kind === "attempt" ? c.attempts : c.evidence)[scope] = n;
      else throw Error("Unknown shared identifier counter scope");
    }
    if (
      !["session/GLOBAL", "gap/GLOBAL", "decision/GLOBAL"].every((s) =>
        seen.has(s),
      )
    )
      throw Error("Missing global identifier counters");
    declared = c;
  } else {
    declared = counterClaim(shared);
  }
  if (!declared)
    return {
      counters: minimum,
      issue:
        "Saved identifier counters need exact reconciliation before allocating new study IDs.",
    };
  validateIdentifierCounters(declared);
  if (shared.includes(`### ${heading}\n`)) {
    for (const kind of ["attempts", "evidence"] as const)
      for (const session of Object.keys(minimum[kind]))
        if (declared[kind][session] === undefined)
          throw Error("Missing recorded per-session identifier counter");
    const claim = counterClaim(shared);
    if (!claim)
      return {
        counters: mergeIdentifierCounters(minimum, declared),
        issue:
          "Human-readable next identifiers need exact reconciliation with the shared counter table.",
      };
    if (
      strict &&
      (claim.nextSession !== declared.nextSession ||
        claim.nextGap !== declared.nextGap ||
        claim.nextDecision !== declared.nextDecision ||
        Object.entries(claim.attempts).some(
          ([s, n]) => n !== (declared!.attempts[s] ?? 1),
        ) ||
        Object.entries(claim.evidence).some(
          ([s, n]) => n !== (declared!.evidence[s] ?? 1),
        ))
    )
      throw Error(
        "Human-readable next identifiers contradict the shared counter table",
      );
    if (!strict) declared = mergeIdentifierCounters(declared, claim);
  }
  const merged = mergeIdentifierCounters(minimum, declared);
  if (
    strict &&
    (merged.nextSession !== declared.nextSession ||
      merged.nextGap !== declared.nextGap ||
      merged.nextDecision !== declared.nextDecision ||
      Object.entries(declared.attempts).some(
        ([s, n]) => n < (minimum.attempts[s] ?? 1),
      ) ||
      Object.entries(declared.evidence).some(
        ([s, n]) => n < (minimum.evidence[s] ?? 1),
      ))
  )
    throw Error(
      "Saved next identifier counter is below an allocated or reserved progress record",
    );
  return { counters: merged };
}
export function allocationCounters(
  r: Roadmap,
  l: LearnerLedger,
  parent?: string,
): IdentifierCounters {
  const source =
      parent ?? l.roadmapAdoptions?.at(-1)?.proposal.canonical ?? r.raw,
    cached = allocationSources.get(l),
    read =
      cached?.source === source
        ? cached.read
        : readIdentifierCounters(source, false);
  if (cached?.source !== source) allocationSources.set(l, { source, read });
  if (read.issue) throw Error(read.issue);
  const c = mergeIdentifierCounters(
    read.counters,
    ...(l.identifierCounters ? [l.identifierCounters] : []),
  );
  for (const session of l.sessions)
    c.nextSession = Math.max(c.nextSession, next(Number(session.id.slice(1))));
  for (const [kind, ids] of [
    ["attempts", l.attempts],
    ["evidence", l.evidence],
  ] as const)
    for (const item of ids) {
      const m = /^(S\d{4})-(?:A|EV)(\d+)$/.exec(item.id);
      if (!m) throw Error("Malformed actual learning identifier");
      c[kind][m[1]] = Math.max(c[kind][m[1]] ?? 1, next(Number(m[2])));
    }
  return c;
}
const allocationSources = new WeakMap<
  LearnerLedger,
  { source: string; read: ReturnType<typeof readIdentifierCounters> }
>();
export const formatIdentifier = (prefix: string, n: number, width = 2) => {
  if (!positive(n)) throw Error("Invalid next identifier");
  return `${prefix}${String(n).padStart(width, "0")}`;
};
export function projectIdentifierCounters(
  raw: string,
  counters: IdentifierCounters,
  allocationSession?: string,
) {
  const c = structuredClone(counters);
  validateIdentifierCounters(c);
  const doc = inspectMergedDocument(raw),
    old = doc.blocks.SHARED_PROGRESS,
    scope =
      allocationSession ?? Object.keys(counterClaim(old)?.attempts ?? {})[0];
  if (!scope || !/^S\d{4}$/.test(scope))
    throw Error("Counter projection needs an exact allocation session");
  c.attempts[scope] ??= 1;
  c.evidence[scope] ??= 1;
  const rows = [
    ["session", "GLOBAL", c.nextSession],
    ["gap", "GLOBAL", c.nextGap],
    ["decision", "GLOBAL", c.nextDecision],
    ...Object.entries(c.attempts)
      .sort()
      .map(([s, n]) => ["attempt", s, n]),
    ...Object.entries(c.evidence)
      .sort()
      .map(([s, n]) => ["evidence", s, n]),
  ];
  const text = `### ${heading}\n\n| Counter | Scope | Next number |\n|---|---|---|\n${rows.map((c) => `| ${c.join(" | ")} |`).join("\n")}\n\n`;
  let updated = old
    .split("\n")
    .map((line) =>
      line.startsWith("| Reserved next identifiers (shared counters) |")
        ? `| Reserved next identifiers (shared counters) | ${scope}: next shared attempt ${formatIdentifier(`${scope}-A`, c.attempts[scope])}, evidence ${formatIdentifier(`${scope}-EV`, c.evidence[scope])}; next gap ${formatIdentifier("G", c.nextGap, 4)}; next shared decision ${formatIdentifier("DEC", c.nextDecision, 4)}; next genuinely new session ${formatIdentifier("S", c.nextSession, 4)} |`
        : line,
    )
    .join("\n");
  if (updated.includes(`### ${heading}\n`)) {
    const start = updated.indexOf(`### ${heading}\n`),
      end = updated.indexOf("\n### ", start + 4);
    updated =
      updated.slice(0, start) + text + (end < 0 ? "" : updated.slice(end + 1));
  } else updated = updated.trimEnd() + "\n\n" + text;
  return raw.replace(
    `<!-- BEGIN SHARED_PROGRESS -->\n${old}<!-- END SHARED_PROGRESS -->`,
    // A function, so "$" sequences in saved progress text stay literal.
    () =>
      `<!-- BEGIN SHARED_PROGRESS -->\n${updated}<!-- END SHARED_PROGRESS -->`,
  );
}
export function attemptDisposition(
  a: LearningAttempt,
  hasEvidence: boolean,
  replacement?: string,
) {
  if (a.status === "served")
    return "COMPLETED; bounded primary visit served; disposition is not a checkpoint score";
  if (replacement && a.status === "interrupted")
    return `SUPERSEDED; unfinished scope replaced by actually issued ${replacement}; valid prior evidence retained`;
  const prefix = hasEvidence ? "PARTIAL" : "PENDING";
  if (a.status === "interrupted")
    return `${prefix}; INTERRUPTED_AT_LAST_SAVE; original task and valid prior evidence retained`;
  if (a.status === "suspended")
    return `${prefix}; SUSPENDED by a reopened lower gate; preserve higher work`;
  return `${prefix}; current issued task remains unfinished; no inferred failure`;
}
