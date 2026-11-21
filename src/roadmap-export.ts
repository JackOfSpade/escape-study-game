import { sha256 } from "./digest";
import { verifyEnvironmentPayload } from "./environment-review";
import { validateEnvironmentEvidence } from "./environment-status";
import {
  historicalReviewAuthorized,
  independentProofValid,
  validateHistoricalMapping,
} from "./historical-proof";
import {
  importedEnvironmentEvidence,
  importedMappingValid,
} from "./imported-proof";
import {
  eligibleLearning,
  localDate,
  reconcileGates,
  restoreFullQueues,
} from "./learner";
import { roleFocused } from "./career-profile";
import type { LearnerLedger } from "./learning-model";
import { learningAttemptRoot, servedLearningAttempts } from "./learning-model";
import type { Roadmap, Track } from "./model";
import {
  baselineCheckpointValid,
  baselineReviewSuspended,
} from "./observation-validity";
import { retentionEventText } from "./retention-history";
import {
  assessedToken,
  isAssessedTokenFor,
  SUPPLEMENT_HEADING,
  SUPPLEMENT_HEADINGS,
} from "./roadmap-export-names";
import { externalResolutionRow } from "./roadmap-active-work";
import { terminalCorrectionRow } from "./roadmap-attempt-updates";
import {
  allocationCounters,
  attemptDisposition,
  formatIdentifier,
  projectIdentifierCounters,
} from "./roadmap-identifiers";

import {
  curriculumReadiness,
  finalRequirements,
  finalRequirementStatus,
  learningTarget,
} from "./final-requirements";
import {
  isFinalTarget,
  learningProgress,
  progressStatus,
  scopeKey,
  studyRatioPosition,
} from "./learning-model";
import { CELL_SEPARATOR } from "./table-row";
export interface RoadmapExport {
  fingerprint: string;
  content: string;
  revision: number;
  hash: string;
  parentHash: string;
  ledgerVersion: number;
  gapIds: Record<string, string>;
}
const tracks = ["PY", "PE"] as const;
export { sha256 } from "./digest";

function block(raw: string, name: string) {
  const start = `<!-- BEGIN ${name} -->`,
    end = `<!-- END ${name} -->`;
  if (raw.split(start).length !== 2 || raw.split(end).length !== 2)
    throw Error(`Missing or repeated ${name} block`);
  return raw.split(start)[1].split(end)[0];
}
function gapLineMap(source: string, track?: string) {
  const text = track ? block(source, `${track}_PROGRESS`) : source;
  const lines = new Map<string, string>();
  for (const line of section(
    text,
    "0.6 Facet gaps, unknowns, and dependencies",
  ).text.split("\n")) {
    const id = /^\| (G\d{4}) \|/.exec(line)?.[1];
    if (id && !lines.has(id)) lines.set(id, line);
  }
  return lines;
}
function replaceBlock(raw: string, name: string, value: string) {
  const old = block(raw, name);
  // A replacer function keeps "$&", "$'" and "$$" in learner or curriculum text
  // literal; a replacement string would expand them into the document.
  return raw.replace(
    `<!-- BEGIN ${name} -->${old}<!-- END ${name} -->`,
    () => `<!-- BEGIN ${name} -->${value}<!-- END ${name} -->`,
  );
}
const section = (raw: string, heading: string) => {
  const start = raw.indexOf(`### ${heading}\n`);
  if (start < 0) throw Error(`Missing progress section ${heading}`);
  const end = raw.indexOf("\n### ", start + 4);
  return {
    start,
    end: end < 0 ? raw.length : end,
    text: raw.slice(start, end < 0 ? raw.length : end),
  };
};
function inSection(
  raw: string,
  heading: string,
  edit: (text: string) => string,
) {
  const s = section(raw, heading);
  return raw.slice(0, s.start) + edit(s.text) + raw.slice(s.end);
}
// Generated cells are single-line Markdown text. Never interpolate raw prompts,
// solutions, conversations or free-form assessment rationales into the roadmap.
function cell(value: unknown) {
  return String(value)
    .replace(/\|/g, "&#124;")
    .replace(/[\r\n]+/g, " ")
    .trim();
}
const row = (cells: unknown[]) => `| ${cells.map(cell).join(" | ")} |`;
const split = (line: string) =>
  line
    .slice(1, -1)
    .split(CELL_SEPARATOR)
    .map((c) => c.trim());
function table(raw: string, edit: (cells: string[]) => string[] | undefined) {
  return raw
    .split("\n")
    .map((line) => {
      if (!line.startsWith("| ")) return line;
      const next = edit(split(line));
      return next ? row(next) : line;
    })
    .join("\n");
}
function fields(raw: string, changes: Record<string, string>) {
  const found = new Set<string>();
  const result = table(raw, (c) => {
    if (!Object.hasOwn(changes, c[0])) return;
    found.add(c[0]);
    return [c[0], changes[c[0]]];
  });
  for (const k of Object.keys(changes))
    if (!found.has(k)) throw Error(`Missing saved field ${k}`);
  return result;
}
function upsert(raw: string, rows: string[][]) {
  const byId = new Map(rows.map((r) => [r[0], r]));
  let result = table(raw, (c) => {
    const next = byId.get(c[0]);
    byId.delete(c[0]);
    return next;
  });
  const pos = result.lastIndexOf("\n| ");
  if (pos < 0) throw Error("Missing progress table");
  const end = result.indexOf("\n", pos + 1);
  const at = end < 0 ? result.length : end;
  result =
    result.slice(0, at) +
    [...byId.values()].map((r) => `\n${row(r)}`).join("") +
    result.slice(at);
  return result;
}
const short = (id: string) => id.split(":").at(-1)!;
const topic = (id: string) => short(id).split(".")[0];
function count(
  r: Roadmap,
  l: LearnerLedger,
  t: Track,
  depth?: number,
  name?: string,
) {
  const objectives = r.tracks[t].objectives.filter(
    (o) => !name || topic(o.id) === name,
  );
  const depths = depth ? [depth] : [1, 2, 3, 4];
  let passed = 0,
    total = 0;
  for (const o of objectives)
    for (const d of depths)
      if (o.target >= d) {
        total++;
        if (l.cells[o.id].states[d - 1] === "P") passed++;
      }
  return { passed, total, text: `${passed}/${total}` };
}
function wave(l: LearnerLedger, t: Track) {
  const s = l.tracks[t];
  return `W${s.tier === 1 && s.phase === "DIAGNOSE_ALL" ? 0 : s.tier} / L${String(s.lap).padStart(2, "0")}`;
}
function reviewText(r: Roadmap, l: LearnerLedger, t: Track) {
  return (
    Object.values(l.reviews)
      .filter((v) => v.objectiveId.startsWith(`${t}:`))
      .sort(
        (a, b) =>
          a.due.localeCompare(b.due) ||
          a.objectiveId.localeCompare(b.objectiveId),
      )
      .map(
        (v) =>
          `${short(v.objectiveId)} D${v.depth} due ${v.due}${baselineReviewSuspended(r, l, v) ? "; original score withdrawn; retention suspended pending scheduled repair" : ""}; delayed verifications ${v.verifiedReviews}; ${v.lastIndependentAt ? `last observed ${v.lastIndependentAt}` : v.lastIndependentDate ? `prior date ${v.lastIndependentDate}, exact time unknown` : "observation time unknown"}`,
      )
      .join("; ") || "None scheduled"
  );
}
function sessionNeedsProjection(l: LearnerLedger, id: string) {
  if (!l.attempts.some((a) => a.session === id)) return false;
  const source = l.roadmapAdoptions?.at(-1);
  if (
    source?.localSessionStates?.[id] &&
    source.localSessionStates[id] !==
      l.sessions.find((s) => s.id === id)?.status
  )
    return true;
  const attempts = l.attempts.filter(
    (a) => a.session === id && a.status !== "externally-resolved",
  );
  if (!attempts.length) return false;
  if (!source?.localAttemptIds) return true;
  return (
    attempts.some(
      (a) =>
        !source.localAttemptIds!.includes(a.id) ||
        (a.status === "served" && !source.localServedAttempts?.includes(a.id)),
    ) ||
    l.evidence.some(
      (e) =>
        e.attemptId.startsWith(`${id}-`) &&
        !source.localEvidenceIds?.includes(e.id),
    )
  );
}
function pendingText(l: LearnerLedger, t?: Track) {
  return (
    l.attempts
      .filter(
        (a) =>
          !["served", "externally-resolved"].includes(a.status) &&
          (!t || a.contract.track === t),
      )
      .map(
        (a) =>
          `${a.id} ${a.status}: ${a.contract.objectiveIds.join(", ")} D${a.contract.depth}; original encounter ${a.encounter}; ${a.parentAttempt ? `continues ${a.parentAttempt}` : "no task transfer"}`,
      )
      .join("; ") || "None"
  );
}
function nextText(r: Roadmap, l: LearnerLedger, at: string) {
  try {
    const c = eligibleLearning(r, structuredClone(l), at);
    return `${c.track}: ${c.objectiveIds.join(", ")} D${c.depth}; ${c.review ? "bounded due retention review" : c.phase}; preserved facets ${c.preservedFacets?.join(", ") || "see evidence and gap tables"}; missing facets ${c.missingFacets?.join(", ") || "unknown scope remains to be probed"}${c.scheduleNote ? `; ${c.scheduleNote}` : ""}`;
  } catch {
    if (tracks.every((t) => l.tracks[t].phase === "COMPLETE"))
      return "Curriculum gates complete; continue when actual maintenance reviews become due. ENV and retention remain separate reports.";
    return "Both tracks have unresolved curriculum gates; resolve actual gate evidence before issuing further work. No filler or automatic difficulty increase.";
  }
}
function validate(r: Roadmap, l: LearnerLedger) {
  if (l.mode !== "live")
    throw Error("Synthetic test evidence cannot be exported as real progress");
  if (l.sourceHash !== r.sourceHash)
    throw Error("Export source mismatch; explicit migration required");
  if (
    Object.keys(l.cells).length !==
    r.tracks.PY.objectives.length + r.tracks.PE.objectives.length
  )
    throw Error("Incomplete objective ledger");
  const ids = [...l.attempts.map((a) => a.id), ...l.evidence.map((e) => e.id)];
  if (new Set(ids).size !== ids.length)
    throw Error("Duplicate learning identifiers");
  const baselineSessions = new Set(
    [...r.raw.matchAll(/^\| (S\d{4}) \|/gm)].map((m) => m[1]),
  );
  for (const a of l.attempts) {
    if (
      !l.sessions.some((s) => s.id === a.session) ||
      !a.id.startsWith(`${a.session}-A`) ||
      baselineSessions.has(a.session)
    )
      throw Error("Invalid or historical attempt allocation");
    learningAttemptRoot(l, a);
  }
  for (const e of l.evidence) {
    const a = l.attempts.find((a) => a.id === e.attemptId);
    if (
      !a ||
      !e.id.startsWith(`${a.session}-EV`) ||
      !a.contract.objectiveIds.includes(e.objectiveId) ||
      e.depth !== a.contract.depth ||
      !l.scopes[scopeKey(e.objectiveId, e.depth)]?.facets.some(
        (f) => f.id === e.facet,
      )
    )
      throw Error("Orphaned curriculum evidence");
  }
  for (const review of l.historicalReviews ?? []) {
    validateHistoricalMapping(r, l, review);
    if (!historicalReviewAuthorized(l, review))
      throw Error("Historical proof has no matching assessment receipt");
  }
  for (const t of tracks)
    for (const o of r.tracks[t].objectives) {
      const c = l.cells[o.id];
      if (!c || c.states.length !== 4 || c.sourceRefs !== o.refs)
        throw Error(`Invalid imported source refs ${o.id}`);
      for (let d = 1; d <= 4; d++) {
        if (
          !(d <= o.target ? ["U", "G", "P", "R"] : ["—"]).includes(
            c.states[d - 1],
          )
        )
          throw Error(`Invalid checkpoint ${o.id}/D${d}`);
        if (
          c.states[d - 1] === "P" &&
          !baselineCheckpointValid(r, l, o.id, d)
        ) {
          const key = `${o.id}/D${d}`,
            def = l.scopes[key];
          if (
            !def ||
            !l.verifiedScopes.includes(key) ||
            !def.facets.length ||
            !def.facets.every((f) => {
              const p = c.facets[`D${d}:${f.id}`];
              return (
                p?.outcome === "independent" &&
                p.evidenceIds.some((ref) =>
                  independentProofValid(r, l, o.id, d, f.id, ref),
                )
              );
            })
          )
            throw Error(`Unsupported new checkpoint pass ${key}`);
        }
      }
    }
  for (const [id, p] of Object.entries(l.finalProgress ?? {})) {
    const track = id.startsWith("PY:") ? "PY" : "PE";
    const d = finalRequirements(r, track).find(
      (d) => d.id === id && d.selected && d.kind !== "environment",
    );
    if (
      !d ||
      p.kind !== d.kind ||
      p.sourceRefs !== d.sourceRefs ||
      !["U", "G", "P", "R"].includes(p.status)
    )
      throw Error("Invalid final requirement record");
    if (p.status === "P" && finalRequirementStatus(r, l, d) !== "P")
      throw Error(`Unsupported final requirement pass ${id}`);
  }
  for (const d of Object.values(l.scopes)) {
    const o = learningTarget(
      r,
      d.objectiveId.startsWith("PY:") ? "PY" : "PE",
      d.objectiveId,
    );
    if (
      !o ||
      d.sourceScope !== o.scope ||
      d.id !== scopeKey(o.id, d.depth) ||
      d.depth > o.target ||
      (o.kind !== "checkpoint" && d.depth !== 4)
    )
      throw Error("Changed authoritative scope");
    const isUsed =
      l.evidence.some((e) => scopeKey(e.objectiveId, e.depth) === d.id) ||
      l.attempts.some(
        (a) =>
          a.contract.objectiveIds.includes(d.objectiveId) &&
          a.contract.depth === d.depth,
      );
    for (const f of d.facets)
      if (
        isUsed &&
        (!f.description.trim() ||
          f.description.length > 500 ||
          /[\r\n]|```/.test(f.description))
      )
        throw Error(
          "Export requires concise semantic facet criteria, without code blocks or transcripts",
        );
  }
}

/** Complete semantic progress save. The caller commits this cache only after
 * success. Original source bytes and all three protected blocks are immutable. */
function projectEnvironment(raw: string, r: Roadmap, l: LearnerLedger) {
  const entries = l.environmentEvidence ?? [];
  if (!entries.length) return raw;
  const definitions = finalRequirements(r, "PE").filter(
    (d) => d.kind === "environment",
  );
  let p = block(raw, "PE_PROGRESS");
  p = inSection(p, "0.8.1 Environment-backed verification", (text) =>
    table(text, (c) => {
      const d = definitions.find((d) => d.name === c[0]);
      if (!d) return;
      const reviewed = entries.filter((v) => v.payload.definition.id === d.id);
      if (!reviewed.length) return;
      const imported = importedEnvironmentEvidence(r, l, d.id, d.scope);
      c[3] = finalRequirementStatus(r, l, d);
      c[4] = [d.sourceRefs, ...imported.refs, ...reviewed.map((v) => v.id)]
        .filter((s) => s && s !== "—")
        .join(", ");
      c[5] = [
        ...imported.notes,
        `Reviewed practical work: ${reviewed.map((v) => `${v.judgment.classification}; ${v.judgment.covered.length} covered components; ${v.judgment.remaining.length} remaining components`).join(" / ")}. Runtime/ownership claims remain bounded to the reviewed packet; no academic checkpoint or tier credit.`,
      ].join(" / ");
      return c;
    }),
  );
  p = inSection(p, "0.1 Learner profile and dashboard", (text) =>
    fields(text, {
      "Environment verification": `${definitions.filter((d) => finalRequirementStatus(r, l, d) === "P").length}/${definitions.length} ENV items observed; reviewed practical work only, separate from academic mastery and never a tier gate`,
    }),
  );
  const heading = "0.13 Practical environment review receipts";
  if (!p.includes(`### ${heading}\n`))
    p += `\n\n### ${heading}\n\n| Review | Item | Packet | Classification | Reviewed at | Request SHA-256 | Judgment SHA-256 |\n|---|---|---|---|---|---|---|\n`;
  p = inSection(p, heading, (text) =>
    upsert(
      text,
      entries.map((v) => [
        v.id,
        v.payload.definition.id,
        v.payload.observation.id,
        v.judgment.classification,
        v.reviewedAt,
        v.requestHash,
        v.judgmentHash,
      ]),
    ),
  );
  return replaceBlock(raw, "PE_PROGRESS", p);
}

/** Full-source view of an active ledger. Administrative role settings and its
 * narrower operational gates never change the original document's meaning. */
export function sourceLedgerProjection(r: Roadmap, ledger: LearnerLedger) {
  const l = structuredClone(ledger);
  if (roleFocused(l.careerFocus)) {
    l.careerFocus = "full";
    restoreFullQueues(r, l);
    reconcileGates(r, l);
  }
  delete l.careerFocus;
  delete (l as LearnerLedger & { careerCarryover?: unknown }).careerCarryover;
  delete (l as LearnerLedger & { careerFullTrack?: unknown }).careerFullTrack;
  return l;
}
/** Pass the source to project an active ledger. The export path already holds
 * a sourceLedgerProjection and hashes it directly; raw fallback is retained
 * for compatibility, not used for active production adoption caches. */
export async function roadmapSemanticFingerprint(
  ledger: LearnerLedger,
  r?: Roadmap,
) {
  const l = r ? sourceLedgerProjection(r, ledger) : ledger;
  const semantic = {
    ...l,
    projection: "canonical-attempts-and-shared-identifiers-v1",
    scopes: Object.fromEntries(
      Object.entries(l.scopes).filter(
        ([key, d]) =>
          l.roadmapAdoptions?.some((v) =>
            v.proposal.mappings.some((m) => m.scopeId === key),
          ) ||
          l.evidence.some((e) => scopeKey(e.objectiveId, e.depth) === key) ||
          l.attempts.some(
            (a) =>
              a.contract.objectiveIds.includes(d.objectiveId) &&
              a.contract.depth === d.depth,
          ),
      ),
    ),
  };
  // Adding untouched final-requirement defaults during a legacy-save upgrade or
  // question preview is administrative, not a new learning revision.
  delete semantic.finalProgress;
  const usedFinal = Object.fromEntries(
    Object.entries(l.finalProgress ?? {}).filter(
      ([id]) =>
        l.roadmapAdoptions?.some((v) =>
          v.proposal.mappings.some(
            (m) => l.scopes[m.scopeId]?.objectiveId === id,
          ),
        ) ||
        l.evidence.some((e) => e.objectiveId === id) ||
        l.attempts.some((a) => a.contract.objectiveIds.includes(id)),
    ),
  );
  if (Object.keys(usedFinal).length) semantic.finalProgress = usedFinal;
  return sha256(JSON.stringify(semantic));
}
export async function prepareRoadmapExport(
  r: Roadmap,
  ledger: LearnerLedger,
  cache?: RoadmapExport,
  at = new Date().toISOString(),
): Promise<RoadmapExport> {
  const l = sourceLedgerProjection(r, ledger);
  // The source file represents the original curriculum. A role-profile gate
  // is useful scheduling state, but is never proof that its deferred original
  // objectives passed. Recompute only this disposable projection under the
  // original requirements; the active profile and learner records stay intact.
  if ((await sha256(r.raw)) !== r.sourceHash)
    throw Error("Original roadmap integrity failure");
  validate(r, l);
  for (const receipt of l.roadmapAdoptions ?? []) {
    if (
      (await sha256(JSON.stringify(receipt.proposal))) !==
        receipt.proposalHash ||
      (await sha256(receipt.proposal.canonical)) !== receipt.canonicalHash
    )
      throw Error("Adopted source receipt integrity failure");
    for (const mapping of receipt.proposal.mappings)
      importedMappingValid(r, l, receipt, mapping);
  }
  for (const a of l.attempts)
    if (a.status === "externally-resolved" || a.externalResolution)
      externalResolutionRow(l, a);
  const envIds = new Set<string>();
  for (const v of l.environmentEvidence ?? []) {
    const d = finalRequirements(r, "PE").find(
      (d) => d.id === v.payload.definition.id && d.kind === "environment",
    );
    if (!d || envIds.has(v.id))
      throw Error("Unknown or duplicate environment evidence");
    envIds.add(v.id);
    validateEnvironmentEvidence(r, d, v);
    await verifyEnvironmentPayload(v.payload);
    if (
      (await sha256(JSON.stringify(v.payload))) !== v.requestHash ||
      (await sha256(JSON.stringify(v.judgment))) !== v.judgmentHash
    )
      throw Error("Environment review receipt integrity failure");
  }
  const fingerprint = await roadmapSemanticFingerprint(l);
  if (cache) {
    if (
      (await sha256(cache.content)) !== cache.hash ||
      cache.ledgerVersion > l.version
    )
      throw Error("Saved export integrity or ancestry failure");
    if (
      Number(/^revision: (\d+)$/m.exec(cache.content)?.[1]) !==
        cache.revision ||
      cache.revision < r.revision
    )
      throw Error("Saved export revision metadata is inconsistent");
    for (const name of ["MERGE_RULES", "PY_CURRICULUM", "PE_CURRICULUM"])
      if (block(cache.content, name) !== block(r.raw, name))
        throw Error(`Saved export changed protected ${name}`);
    if (cache.fingerprint === fingerprint) return structuredClone(cache);
  }
  if (
    !l.attempts.length &&
    !l.evidence.length &&
    !l.roadmapAdoptions?.length &&
    !l.environmentEvidence?.length
  ) {
    // Merely opening, previewing scope definitions, or inspecting the roadmap is
    // administrative and cannot allocate a study session or revision.
    return {
      fingerprint,
      content: r.raw,
      revision: r.revision,
      hash: r.sourceHash,
      parentHash: /^parent_file_sha256: (.+)$/m.exec(r.raw)?.[1] ?? "",
      ledgerVersion: l.version,
      gapIds: {},
    };
  }
  const parent = cache?.content ?? r.raw,
    parentHash = await sha256(parent),
    revision = (cache?.revision ?? r.revision) + 1,
    date = localDate(at);
  for (const name of ["MERGE_RULES", "PY_CURRICULUM", "PE_CURRICULUM"])
    if (block(parent, name) !== block(r.raw, name))
      throw Error(`Export parent changed protected ${name}`);
  if (
    !l.attempts.length &&
    !l.evidence.length &&
    l.environmentEvidence?.length
  ) {
    let content = projectEnvironment(parent, r, l)
      .replace(/^revision: \d+$/m, `revision: ${revision}`)
      .replace(
        /^previous_revision: \d+$/m,
        `previous_revision: ${revision - 1}`,
      )
      .replace(/^parent_file_sha256: .+$/m, `parent_file_sha256: ${parentHash}`)
      .replace(/^updated_on: .+$/m, `updated_on: ${date}`);
    for (const t of tracks) {
      let p = block(content, `${t}_PROGRESS`);
      p = inSection(p, "0.2 Breadth scheduler and resume packet", (text) =>
        fields(text, {
          "Save anchor": `Merged revision ${revision}, ${date}; complete parent SHA-256 ${parentHash}; academic scheduler unchanged; practical ENV review only`,
        }),
      );
      p = inSection(p, "0.11 Revision and migration history", (text) =>
        upsert(text, [
          [
            `Merged ${revision}`,
            date,
            "Practical ENV review save; academic scheduler and historical evidence unchanged",
            "No academic checkpoint, primary visit, tier or retention credit",
          ],
        ]),
      );
      content = replaceBlock(content, `${t}_PROGRESS`, p);
    }
    const shared = inSection(
      block(content, "SHARED_PROGRESS"),
      "S0.5 Merged revision history",
      (text) =>
        upsert(text, [
          [
            String(revision),
            date,
            `Environment review save from revision ${revision - 1}; complete parent SHA-256 ${parentHash}; curriculum and academic history unchanged`,
            `${l.environmentEvidence!.length} cumulative practical reviews; no study session, attempt, academic evidence, primary visit, tier or retention credit`,
          ],
        ]),
    );
    const anchored = inSection(
      shared,
      "S0.2 Shared scheduler and resume packet",
      (text) =>
        fields(text, {
          "Save anchor": `Merged revision ${revision}, ${date}; previous revision ${revision - 1}; complete parent SHA-256 ${parentHash}; practical ENV review only, no study visit`,
        }),
    );
    content = projectIdentifierCounters(
      replaceBlock(content, "SHARED_PROGRESS", anchored),
      allocationCounters(r, l, parent),
    );
    return {
      fingerprint,
      content,
      revision,
      hash: await sha256(content),
      parentHash,
      ledgerVersion: l.version,
      gapIds: { ...cache?.gapIds },
    };
  }
  const gapIds = { ...cache?.gapIds };
  const counters = allocationCounters(r, l, parent);
  counters.nextGap = Math.max(
    counters.nextGap,
    ...Object.values(gapIds).map((id) => Number(id.slice(1)) + 1),
  );
  for (const ev of [
    ...l.evidence,
    ...(l.historicalReviews ?? []).map((m) => ({
      objectiveId: l.scopes[m.scopeId].objectiveId,
      depth: l.scopes[m.scopeId].depth,
    })),
    ...(l.roadmapAdoptions ?? []).flatMap((v) =>
      v.proposal.mappings.map((m) => ({
        objectiveId: l.scopes[m.scopeId].objectiveId,
        depth: l.scopes[m.scopeId].depth,
      })),
    ),
  ]) {
    const key = scopeKey(ev.objectiveId, ev.depth);
    if (!gapIds[key]) {
      if (counters.nextGap > 9999)
        throw Error(
          "Gap identifier range exhausted; explicit schema migration required",
        );
      gapIds[key] = formatIdentifier("G", counters.nextGap++, 4);
    }
  }
  const served = servedLearningAttempts(l),
    priorServed = l.roadmapAdoptions?.at(-1)?.localServedAttempts,
    recentServed = priorServed
      ? served.filter((a) => !priorServed.includes(a.id))
      : served,
    next = nextText(r, l, at),
    current = l.currentSession ?? l.sessions.at(-1)!.id;
  const allocationSession =
    l.currentSession ?? formatIdentifier("S", counters.nextSession, 4);
  counters.attempts[allocationSession] ??= 1;
  counters.evidence[allocationSession] ??= 1;
  const reserved = `${allocationSession}: next shared attempt ${formatIdentifier(`${allocationSession}-A`, counters.attempts[allocationSession])}, evidence ${formatIdentifier(`${allocationSession}-EV`, counters.evidence[allocationSession])}; next gap ${formatIdentifier("G", counters.nextGap, 4)}; next shared decision ${formatIdentifier("DEC", counters.nextDecision, 4)}; next genuinely new session ${formatIdentifier("S", counters.nextSession, 4)}`;
  const anchor = `Merged revision ${revision}, ${date}; previous revision ${revision - 1}; actual complete parent SHA-256 ${parentHash}. Downloading this unchanged saved state again does not allocate identifiers or another revision.`;
  let content = parent
    .replace(/^revision: \d+$/m, `revision: ${revision}`)
    .replace(/^previous_revision: \d+$/m, `previous_revision: ${revision - 1}`)
    .replace(/^parent_file_sha256: .+$/m, `parent_file_sha256: ${parentHash}`)
    .replace(/^updated_on: .+$/m, `updated_on: ${date}`);
  for (const t of tracks) {
    const state = l.tracks[t],
      objs = r.tracks[t].objectives,
      attempts = l.attempts.filter((a) => a.contract.track === t),
      evs = l.evidence.filter((e) => e.objectiveId.startsWith(`${t}:`));
    let p = block(content, `${t}_PROGRESS`);
    const readiness = curriculumReadiness(r, l, t);
    const phase = `Tier ${state.tier} / ${state.phase} / ${wave(l, t)}`;
    const counts = `${count(r, l, t).text}; ${[1, 2, 3, 4].map((d) => `D${d} ${count(r, l, t, d).text}`).join(", ")}`;
    const fulfilled = objs.filter((o) =>
      o.cells
        .map((_, i) => i + 1)
        .filter((d) => d <= o.target)
        .every((d) => l.cells[o.id].states[d - 1] === "P"),
    ).length;
    p = inSection(p, "0.1 Learner profile and dashboard", (s) =>
      fields(s, {
        "Required checkpoint passes": counts,
        "Objectives meeting their target": `${fulfilled}/${objs.length}; evidence only, not an estimate of unobserved knowledge`,
        "Current curriculum phase": phase,
        "Current / most recently active session": `${current}; ${l.sessions.find((s) => s.id === current)?.status ?? "no active session"}; track attempts ${attempts.map((a) => a.id).join(", ") || "none"}`,
        "Last completed study session":
          l.sessions
            .filter(
              (session) =>
                session.status === "closed" &&
                attempts.some((a) => a.session === session.id),
            )
            .at(-1)?.id ??
          block(parent, `${t}_PROGRESS`)
            .split("\n")
            .find((line) => line.startsWith("| Last completed study session |"))
            ?.match(/S\d{4}/)?.[0] ??
          "None confirmed",
        "Next new session ID": reserved.split("next genuinely new session ")[1],
        "Last saved study session": `${current}; merged revision ${revision}; ${date}; save does not imply a session close`,
        "Topics eligible to skip all instruction": `${r.tracks[t].rotation.filter((name) => readiness.requirements.some((d) => d.kind === "transfer" && d.name === name && d.status === "P") && objs.filter((o) => topic(o.id) === name).every((o) => Array.from({ length: o.target }, (_, i) => i + 1).every((depth) => l.cells[o.id].states[depth - 1] === "P"))).length}/${readiness.transfers.total}`,
        "Topic transfer checks": `${readiness.transfers.passed}/${readiness.transfers.total} verified; independent changed-context evidence only`,
        "Integration coverage": `${readiness.integrations.passed}/${readiness.integrations.total} selected required areas verified`,
        Retention: reviewText(r, l, t),
        "Stop condition":
          "Progress export only. Resume the exact scheduler below; no task or new learning is implied by this save.",
      }),
    );
    const baselinePacket = section(
      r.tracks[t].progress,
      "0.2 Breadth scheduler and resume packet",
    ).text;
    const baselineLap = Number(
      /\| Active wave \/ lap \| W\d+ \/ L(\d+)/.exec(baselinePacket)?.[1],
    );
    const oldVisited =
      state.tier === r.tracks[t].tier && state.lap === baselineLap
        ? (baselinePacket
            .split("\n")
            .find((line) =>
              line.startsWith("| Topics visited in current lap |"),
            )
            ?.match(/[TX]\d{2}/g) ?? [])
        : [];
    const visited = [
      ...new Set([
        ...oldVisited,
        ...served
          .filter(
            (a) =>
              a.contract.track === t &&
              !a.contract.review &&
              a.contract.depth === state.tier &&
              a.lap === state.lap,
          )
          .flatMap((a) => a.contract.objectiveIds.map(topic)),
      ]),
    ];
    p = inSection(p, "0.2 Breadth scheduler and resume packet", (s) =>
      fields(s, {
        "Active tier / phase": `Tier ${state.tier} / ${state.phase}`,
        "Highest tier previously opened": `Tier ${Math.max(state.tier, ...state.suspended.map((v) => v.tier))}; history is not the difficulty ceiling`,
        "Suspended positions":
          state.suspended
            .map(
              (v) =>
                `Tier ${v.tier} / ${v.phase} / L${v.lap ?? "unknown"}: ${v.queue.join(", ")}`,
            )
            .join("; ") || "None",
        "Active wave / lap": wave(l, t),
        "Current difficulty ceiling": `D${state.tier}; use the unchanged curriculum's depth contract; survival conditions do not increase it`,
        "Remaining topics in current lap":
          state.queue.join(", ") || "None; reconcile actual gate evidence",
        "Current lap roster": r.tracks[t].rotation.join(", "),
        "Evidence-covered / explicitly removed entries this lap":
          r.tracks[t].rotation
            .filter((name) => {
              const n = count(r, l, t, state.tier, name);
              return (
                n.total &&
                n.passed === n.total &&
                !visited.includes(name) &&
                !state.queue.includes(name)
              );
            })
            .join(", ") ||
          "None newly removed; independent partial facets do not remove a topic",
        "Carryover / blocked objectives":
          l.continuations
            .filter((c) => c.objectiveIds.some((id) => id.startsWith(`${t}:`)))
            .map(
              (c) =>
                `${c.attemptId}: ${c.objectiveIds.join(", ")} D${c.depth}; missing original context permits only a linked fresh same-scope task`,
            )
            .join("; ") || "None",
        "Active scheduling exceptions":
          [
            ...new Set(
              attempts.map((a) => a.contract.scheduleNote).filter(Boolean),
            ),
          ].join("; ") || "None",
        "Last primary topic / consecutive visits": recentServed
          .filter((a) => a.contract.track === t)
          .at(-1)
          ?.contract.objectiveIds.map(topic)
          .join(", ")
          ? `${recentServed.filter((a) => a.contract.track === t).at(-1)!.id}; ${recentServed
              .filter((a) => a.contract.track === t)
              .at(-1)!
              .contract.objectiveIds.map(topic)
              .join(
                ", ",
              )}; one bounded visit; reviews do not consume ordinary breadth`
          : split(
              block(parent, `${t}_PROGRESS`)
                .split("\n")
                .find((line) =>
                  line.startsWith(
                    "| Last primary topic / consecutive visits |",
                  ),
                )!,
            )[1],
        "Topics visited in current lap": visited.join(", ") || "None",
        "Shallowest outstanding required depth":
          [1, 2, 3, 4]
            .find((d) => count(r, l, t, d).passed < count(r, l, t, d).total)
            ?.toString()
            .replace(/^/, "D") ??
          "All checkpoint cells P; separate transfer/integration/readiness gates still apply",
        "Due reviews": reviewText(r, l, t),
        "Unfinished attempt": pendingText(l, t),
        "Next action in this conversation": next,
        "Next action after a new-session upload": `${current} must be treated as INTERRUPTED_AT_LAST_SAVE if it was open. Allocate the next shared session only on actual new study; preserve the queue, partial facets and reserved IDs. ${next}. Original task drafts are kept in the study backup, not in this roadmap; if unavailable, issue a fresh same-scope continuation linked to its attempt instead of inventing or transferring the task.`,
        "Next decision rule": `1 PY : 2 PE primary visits; one bounded due review before ordinary breadth; preserve partial independent facets. ${next}`,
        "Tier 2 gate":
          state.cleared >= 1
            ? "CLEARED at D1; later gates and the shared lead limit still apply"
            : `LOCKED until all ${objs.length} D1 checkpoints are P and contradictions resolved`,
        "Queued facet work": `Original gap rows retained with depth-specific status; additional semantic facets and current gaps appear in 0.12. Preserve independent siblings; unknown is not failure.`,
        "Do not repeat":
          "Do not restart a diagnostic sweep, lap or attempt solely because of a save or new run. Preserve the ordered remaining queue and independent facets. Use fresh same-scope tasks only where required by the curriculum or missing original task context.",
        "Reserved next identifiers": reserved,
        "Save anchor": anchor,
      }),
    );
    p = inSection(p, "0.4 Objective checkpoint ledger", (s) =>
      table(s, (c) => {
        const id = `${t}:${c[0]}`,
          obj = objs.find((o) => o.id === id);
        if (!obj) return;
        const current = l.cells[id],
          changed = evs.filter((e) => e.objectiveId === id);
        const refs =
          [
            obj.refs === "—" ? "" : obj.refs,
            ...changed.map((e) => e.id),
            ...Object.values(current.facets).flatMap((p) => p.evidenceIds),
            ...Object.entries(gapIds)
              .filter(([key]) => key.startsWith(`${id}/`))
              .map(([, id]) => id),
          ]
            .filter(Boolean)
            .join("; ") || "—";
        const reviews =
          Object.values(l.reviews)
            .filter((v) => v.objectiveId === id)
            .map((v) => `D${v.depth} ${v.due}`)
            .join("; ") || "—";
        return [
          c[0],
          c[1],
          ...current.states,
          changed.length
            ? current.states.slice(0, obj.target).every((s) => s === "P")
              ? "REVIEW"
              : "GAP_ONLY"
            : c[6],
          refs,
          reviews,
        ];
      }),
    );
    p = inSection(p, "0.5 Assessment evidence register", (s) => {
      // An evidence row is an immutable fact once exported. A parent written
      // by an earlier build names its mode with the legacy token; keep that
      // exact mode so the row stays byte-identical across re-exports and
      // devices. Rows this export adds use the current token.
      const parentModes = new Map(
        s
          .split("\n")
          .filter((line) => line.startsWith("| "))
          .map((line) => split(line))
          .map((c) => [c[0], c[5]] as const),
      );
      const mode = (e: (typeof evs)[number]) => {
        const kept = parentModes.get(e.id);
        return kept !== undefined && isAssessedTokenFor(kept, e.outcome)
          ? kept
          : assessedToken(e.outcome);
      };
      return upsert(
        s,
        evs.map((e) => [
          e.id,
          e.attemptId,
          localDate(e.at),
          short(e.objectiveId),
          `${isFinalTarget(e.objectiveId) ? "Tier 4 final requirement" : `D${e.depth}`} / ${e.facet}: ${l.scopes[scopeKey(e.objectiveId, e.depth)].facets.find((f) => f.id === e.facet)!.description}`,
          mode(e),
          e.outcome === "assisted"
            ? "ASSISTED"
            : e.outcome === "independent"
              ? "NONE FOR THIS FACET"
              : "Not independently certified",
          e.outcome === "independent"
            ? "2 (facet only; full scope requires 0.12 coverage)"
            : e.outcome === "assisted"
              ? "1"
              : e.outcome === "contradicted"
                ? "0 (material contradiction)"
                : "N/A",
          `${e.outcome}; artifact references ${e.artifactSequences.join(", ") || "none"}; ${e.execution === "executed" ? "Actual recorded execution evidence" : "Text/artifacts reviewed; not executed"}; observed ${e.observedAt ?? "time unknown"}; assistance source references ${e.helpMessageIds.join(", ") || "none"}. Raw work and task text excluded.`,
        ]),
      );
    });
    p = inSection(p, "0.5.1 Attempt status register", (s) =>
      upsert(
        s,
        attempts
          .filter((a) => !terminalCorrectionRow(l, a.id, t))
          .map((a) =>
            a.status === "externally-resolved"
              ? split(externalResolutionRow(l, a))
              : [
                  a.id,
                  `${a.session} / ${localDate(a.startedAt)}`,
                  `${a.contract.objectiveIds.map(short).join(", ")} / D${a.contract.depth}; ${a.contract.review ? "bounded review" : a.contract.phase}`,
                  attemptDisposition(
                    a,
                    evs.some((e) => e.attemptId === a.id),
                    l.attempts.find((child) => child.parentAttempt === a.id)
                      ?.id,
                  ),
                  evs
                    .filter((e) => e.attemptId === a.id)
                    .map((e) => e.id)
                    .join(", ") || "No assessed evidence yet; no credit",
                  `${a.parentAttempt ? `Continues ${a.parentAttempt}. ` : ""}${l.attempts.find((child) => child.parentAttempt === a.id) ? `Replacement ${l.attempts.find((child) => child.parentAttempt === a.id)!.id} actually issued for unfinished scope. ` : ""}Original task stays at ${a.encounter}; fresh same-scope continuation if that task is unavailable. ${a.contract.scheduleNote ?? ""}`,
                ],
          ),
      ),
    );
    p = inSection(p, "0.6 Facet gaps, unknowns, and dependencies", (s) => {
      const baseGapLines = gapLineMap(r.tracks[t].progress);
      let parentGapLines: Map<string, string> | undefined;
      let out = table(s, (c) => {
        if (!/^G\d{4}$/.test(c[0])) return;
        const baseLine = baseGapLines.get(c[0]);
        const importedLine =
          baseLine ?? (parentGapLines ??= gapLineMap(parent, t)).get(c[0]);
        if (!importedLine) return;
        c = split(importedLine);
        const m = /^([TX]\d{2}\.\d+) \/ D([1-4])$/.exec(c[1]);
        if (!m) return;
        const key = `${t}:${m[1]}/D${m[2]}`,
          d = Number(m[2]);
        if (
          !evs.some((e) => scopeKey(e.objectiveId, e.depth) === key) &&
          !l.historicalReviews?.some((m) => m.scopeId === key) &&
          !l.roadmapAdoptions?.some((v) =>
            v.proposal.mappings.some((m) => m.scopeId === key),
          )
        )
          return;
        if (!l.verifiedScopes.includes(key)) return c;
        if (l.cells[`${t}:${m[1]}`]?.states[d - 1] === "P") {
          c[5] += `; full-scope proof ${l.cells[`${t}:${m[1]}`].proofs[String(d)]?.join(", ")}`;
          c[6] =
            "CLOSED; full checkpoint independently verified; original observation retained";
          return c;
        }
        if (!baseLine && c[6].startsWith("CLOSED"))
          c[6] =
            "OPEN; imported prior scope requires retest; original observation retained";
        return c;
      });
      const rows = Object.entries(gapIds)
        .filter(([key]) => key.startsWith(`${t}:`))
        .map(([key, id]) => {
          const def = l.scopes[key],
            c = learningProgress(l, def.objectiveId);
          const independent = def.facets
            .filter(
              (f) =>
                c.facets[`D${def.depth}:${f.id}`]?.outcome === "independent",
            )
            .map((f) => `${f.id}: ${f.description}`);
          const missing = def.facets
            .filter(
              (f) =>
                c.facets[`D${def.depth}:${f.id}`]?.outcome !== "independent",
            )
            .map(
              (f) =>
                `${f.id}: ${c.facets[`D${def.depth}:${f.id}`]?.outcome ?? "unknown"}; ${f.description}`,
            );
          return [
            id,
            `${short(def.objectiveId)} / ${isFinalTarget(def.objectiveId) ? "Tier 4 final requirement" : `D${def.depth}`}`,
            "SEMANTIC_FACET_SCOPE",
            independent.join("; ") || "None newly independent",
            missing.join("; ") ||
              (l.verifiedScopes.includes(key)
                ? "None in verified scope"
                : "Whole-checkpoint scope coverage remains unverified"),
            [
              ...new Set([
                ...evs
                  .filter((e) => scopeKey(e.objectiveId, e.depth) === key)
                  .map((e) => e.id),
                ...(l.historicalReviews ?? [])
                  .filter((m) => m.scopeId === key)
                  .flatMap((m) => m.evidenceIds),
              ]),
            ].join(", "),
            progressStatus(c, def.depth) === "P"
              ? isFinalTarget(def.objectiveId)
                ? "CLOSED; full independent final requirement proof"
                : "CLOSED; full independent checkpoint proof"
              : "OPEN; partial independent facets are preserved",
            "Probe/repair only missing or contradicted facets using a fresh task; independent exit evidence required",
            `Curriculum-scheduled D${def.depth} work; not higher-tier authorization`,
          ];
        });
      out = upsert(out, rows);
      return out;
    });
    p = inSection(p, "0.3 Topic placement and breadth board", (s) =>
      table(s, (c) => {
        const members = objs.filter((o) => topic(o.id) === c[0]);
        if (!members.length) return;
        const header = split(
          s.split("\n").find((v) => v.startsWith("| Topic |"))!,
        );
        for (const d of [1, 2, 3, 4]) {
          const n = count(r, l, t, d, c[0]);
          c[header.indexOf(`D${d}`)] = n.total ? n.text : "—";
          const index = header.indexOf(`Tier ${d} diagnostic`);
          if (
            served.some(
              (a) =>
                a.contract.track === t &&
                !a.contract.review &&
                a.contract.depth === d &&
                a.contract.objectiveIds.some((id) => topic(id) === c[0]),
            )
          )
            c[index] = "SAMPLED";
        }
        const recent = attempts
          .filter((a) =>
            a.contract.objectiveIds.some((id) => topic(id) === c[0]),
          )
          .at(-1);
        if (recent) {
          c[header.indexOf("Last visit")] =
            `${recent.id}; ${recent.status}; scope ${recent.contract.objectiveIds.map(short).join(", ")} D${recent.contract.depth}; old history remains in evidence/attempt registers`;
          c[header.indexOf("Placement")] = members.every(
            (o) => l.cells[o.id].states[0] === "P",
          )
            ? "D1_VERIFIED; later scopes separate"
            : "MIXED; preserved facets and missing scope in 0.12";
        }
        const targetMet = members.every((o) =>
          Array.from({ length: o.target }, (_, i) => i).every(
            (i) => l.cells[o.id].states[i] === "P",
          ),
        );
        const transfer = readiness.requirements.find(
          (d) => d.kind === "transfer" && d.name === c[0],
        );
        if (targetMet) {
          c[header.indexOf("Placement")] =
            transfer?.status === "P" || (!transfer && c[0].startsWith("X"))
              ? "SKIP_ALL_INSTRUCTION"
              : "TARGET_MET; transfer separate";
          c[header.indexOf("Full instruction skip")] =
            !transfer && c[0].startsWith("X")
              ? "YES; required targets met; no separate transfer gate"
              : transfer?.status === "P"
                ? "YES; independent targets and transfer"
                : "NO; transfer unresolved or not a separate gate";
        }
        return c;
      }),
    );
    p = inSection(p, "0.2.1 Tier and gate board", (s) =>
      table(s, (c) => {
        const d = Number(/^Tier ([1-4])/.exec(c[0])?.[1]);
        if (!d) return;
        const status =
          d <= state.cleared
            ? "CLEARED"
            : d === state.tier
              ? `${state.phase}; ${wave(l, t)}`
              : state.suspended.some((v) => v.tier === d)
                ? "SUSPENDED; ordered position in resume packet"
                : "LOCKED";
        c[3] = status;
        c[4] = `${count(r, l, t, d).text} D${d}; ${d === 4 ? `${readiness.transfers.passed}/${readiness.transfers.total} transfers; ${readiness.integrations.passed}/${readiness.integrations.total} selected integrations; ENV remains separate` : "partial facets retained separately"}`;
        if (d <= state.cleared)
          c[5] =
            "Checkpoint gate cleared; shared lead limit and subsequent tier gates still apply";
        else
          c[5] =
            d === state.tier
              ? "Continue exact ordered resume packet; sampling alone does not clear the checkpoint gate"
              : "Open only after preceding gates and shared lead limit permit";
        // Keep imported diagnostic coverage; add only real served, non-review obligations.
        if (d === 4) {
          const roster = [
            ...readiness.requirements
              .filter((v) => v.kind === "transfer")
              .map((v) => v.id),
            ...new Set(
              objs
                .filter(
                  (o) => o.id.split(":")[1].startsWith("X") && o.target === 4,
                )
                .map((o) => `${t}:${topic(o.id)}`),
            ),
          ];
          const resolved = roster.filter(
            (id) =>
              readiness.requirements.some(
                (v) => v.id === id && v.status === "P",
              ) ||
              (id.split(":")[1].startsWith("X") &&
                objs
                  .filter((o) => topic(o.id) === topic(id) && o.target === 4)
                  .every((o) => l.cells[o.id].states[3] === "P")) ||
              served.some(
                (a) =>
                  a.contract.track === t &&
                  a.contract.depth === 4 &&
                  !a.contract.review &&
                  a.contract.objectiveIds.some((target) =>
                    a.contract.kind === "transfer"
                      ? target === id
                      : id.split(":")[1].startsWith("X") &&
                        `${t}:${topic(target)}` === id,
                  ),
              ),
          );
          c[2] = `${resolved.length}/${roster.length} tier-specific diagnostic obligations resolved; transfers and extension D4 scope remain distinct`;
        }
        if (d < 4) {
          const board = section(
            p,
            "0.3 Topic placement and breadth board",
          ).text;
          const hdr = split(
            board.split("\n").find((line) => line.startsWith("| Topic |"))!,
          );
          const index = hdr.indexOf(`Tier ${d} diagnostic`);
          const resolved = board
            .split("\n")
            .filter((line) => /^\| [TX]\d{2} \|/.test(line))
            .filter((line) =>
              /SAMPLED|COVERED|REMOVED/.test(split(line)[index]),
            ).length;
          c[2] = `${resolved}/${r.tracks[t].rotation.length} tier-specific diagnostic obligations resolved; imported and actually served evidence only`;
        }
        return c;
      }),
    );
    const currentGate = section(p, "0.2.1 Tier and gate board")
      .text.split("\n")
      .find((line) => line.startsWith(`| Tier ${state.tier} `))!;
    p = inSection(p, "0.1 Learner profile and dashboard", (s) =>
      fields(s, {
        "Diagnostic sweep": `Tier ${state.tier} / ${state.phase}; ${split(currentGate)[2]}; diagnostic completion is not checkpoint mastery`,
      }),
    );
    const finalSummary = (id: string) => {
      const def = l.scopes[scopeKey(id, 4)],
        progress = l.finalProgress?.[id];
      const independent =
        def?.facets
          .filter(
            (f) => progress?.facets[`D4:${f.id}`]?.outcome === "independent",
          )
          .map((f) => `${f.id}: ${f.description}`) ?? [];
      const missing =
        def?.facets
          .filter(
            (f) => progress?.facets[`D4:${f.id}`]?.outcome !== "independent",
          )
          .map(
            (f) =>
              `${f.id}: ${progress?.facets[`D4:${f.id}`]?.outcome ?? "unknown"}; ${f.description}`,
          ) ?? [];
      const refs = evs.filter((e) => e.objectiveId === id).map((e) => e.id);
      return {
        covered: independent.join("; "),
        missing: missing.join("; "),
        refs,
      };
    };
    p = inSection(p, "0.8 Integration coverage", (s) =>
      table(s, (c) => {
        const d = readiness.requirements.find(
          (d) => d.id === `${t}:${c[0]}` && d.kind === "integration",
        );
        if (!d || !d.selected || !evs.some((e) => e.objectiveId === d.id))
          return;
        const summary = finalSummary(d.id);
        c[2] = d.status;
        c[3] = [d.sourceRefs, summary.refs.join(", "), summary.covered]
          .filter((v) => v && v !== "—")
          .join("; ");
        c[4] =
          d.status === "P"
            ? "Complete independently verified selected integration scope; retention and ENV remain separate"
            : summary.missing ||
              "Whole integration scope remains unresolved; preserve valid partial components";
        return c;
      }),
    );
    p = inSection(p, "0.7 Topic transfer and retention", (s) =>
      table(s, (c) => {
        const d = readiness.requirements.find(
          (d) => d.id === `${t}:${c[0]}` && d.kind === "transfer",
        );
        if (d && evs.some((e) => e.objectiveId === d.id)) {
          const summary = finalSummary(d.id);
          c[1] = d.status;
          c[2] = [
            d.sourceRefs,
            summary.refs.join(", "),
            summary.covered,
            d.status === "P"
              ? "Full independent transfer coverage"
              : summary.missing || "Whole transfer scope remains unresolved",
          ]
            .filter((v) => v && v !== "—")
            .join("; ");
        }
        const reviews = Object.values(l.reviews).filter(
          (v) =>
            v.objectiveId === `${t}:${c[0]}` ||
            v.objectiveId.startsWith(`${t}:${c[0]}.`),
        );
        if (!reviews.length) return c;
        c[3] = reviews.some((v) => v.verifiedReviews > 0)
          ? "PARTIAL; scope-specific delayed checks only"
          : "U; no new delayed verification";
        c[4] = reviews
          .map(
            (v) =>
              `${short(v.objectiveId)} D${v.depth}: ${v.verifiedReviews} delayed verifications, due ${v.due}`,
          )
          .join("; ");
        return c;
      }),
    );
    p = inSection(p, "0.10 Session, wave, and phase history", (s) => {
      let out = table(s, (c) => {
        if (
          l.sessions.find((v) => v.id === c[0])?.status ===
            "INTERRUPTED_AT_LAST_SAVE" &&
          !c[1].includes("INTERRUPTED_AT_LAST_SAVE")
        ) {
          c[1] += "; INTERRUPTED_AT_LAST_SAVE; no invented closing time";
          return c;
        }
        return undefined;
      });
      const sessions = l.sessions.filter((session) =>
        attempts.some((a) => a.session === session.id),
      );
      out = upsert(
        out,
        sessions.map((session) => [
          session.id,
          `${localDate(session.startedAt ?? attempts.find((a) => a.session === session.id)!.startedAt)}; ${session.status}`,
          `${phase}; exact current state, historical contracts in attempt register`,
          served
            .filter((a) => a.session === session.id && a.contract.track === t)
            .map(
              (a) =>
                `${a.id}: ${a.contract.objectiveIds.map(short).join(", ")} D${a.contract.depth}${a.contract.review ? " review" : ""}`,
            )
            .join("; ") || "No primary visit served yet",
          evs
            .filter((e) => e.id.startsWith(`${session.id}-`))
            .map((e) => `${e.id}: ${e.outcome} ${e.facet}`)
            .join("; ") || "No assessed evidence yet",
          next,
        ]),
      );
      return out;
    });
    p = inSection(p, "0.11 Revision and migration history", (s) =>
      upsert(s, [
        [
          `Merged ${revision}`,
          date,
          "Source-preserving study progress save; full original history retained; semantic facet scope and exact queue exported",
          `${evs.length} cumulative new evidence rows; no credit from saving, tutor work or defense`,
        ],
      ]),
    );
    const historical = (l.historicalReviews ?? []).filter((m) =>
      l.scopes[m.scopeId].objectiveId.startsWith(`${t}:`),
    );
    // A parent written by an earlier build carries the legacy 0.12 heading;
    // remove the section under either heading so it is never duplicated.
    for (const heading of SUPPLEMENT_HEADINGS)
      while (p.includes(`### ${heading}\n`)) {
        const old = section(p, heading);
        p = p.slice(0, old.start) + p.slice(old.end);
      }
    const supplementHeading = SUPPLEMENT_HEADING;
    const scopes = Object.values(l.scopes).filter(
      (d) =>
        d.objectiveId.startsWith(`${t}:`) &&
        (l.roadmapAdoptions?.some((v) =>
          v.proposal.mappings.some((m) => m.scopeId === d.id),
        ) ||
          evs.some((e) => scopeKey(e.objectiveId, e.depth) === d.id) ||
          attempts.some(
            (a) =>
              a.contract.depth === d.depth &&
              a.contract.objectiveIds.includes(d.objectiveId),
          )),
    );
    p =
      p.trimEnd() +
      `\n\n### ${supplementHeading}\n\nProgress only. Original task prompts, code, solutions and transcripts are intentionally excluded. The study backup retains them. If unavailable, use a fresh same-scope continuation and preserve independent facets rather than reconstructing the old task. Generated scope criteria require independent whole-scope coverage review before a new P is valid. Historical imported facets remain in the original evidence and gap registers; new facet definitions do not erase them.\n\n`;
    if (historical.length)
      p +=
        "Historical facet reconciliation (no new observation IDs):\n\n" +
        [
          row([
            "Scope",
            "Facet",
            "Source hash",
            "Original evidence",
            "Reviewed outcome",
            "Assessment receipt",
          ]),
          "|---|---|---|---|---|---|",
          ...historical.map((m) =>
            row([
              m.scopeId,
              m.facet,
              m.sourceHash,
              m.evidenceIds.join(", "),
              m.outcome,
              m.assessmentId,
            ]),
          ),
        ].join("\n") +
        "\n\n";
    p +=
      [
        row([
          "Scope",
          "Facet",
          "Semantic criterion",
          "Current finding",
          "Evidence refs",
          "Whole-scope coverage",
        ]),
        "|---|---|---|---|---|---|",
        ...scopes.flatMap((d) =>
          d.facets.map((f) => {
            const proof = learningProgress(l, d.objectiveId).facets[
              `D${d.depth}:${f.id}`
            ];
            return row([
              d.id,
              f.id,
              f.description,
              proof?.outcome ?? "unknown",
              proof?.evidenceIds.join(", ") || "—",
              l.verifiedScopes.includes(d.id)
                ? "REVIEWED_COMPLETE; P still needs every facet independent"
                : "UNVERIFIED; no new full checkpoint credit",
            ]);
          }),
        ),
      ].join("\n") + "\n\n";
    p +=
      [
        row([
          "Review scope",
          "Stage",
          "Due",
          "Last independent at",
          "Last independent date",
          "Sequence",
          "Verified reviews",
        ]),
        "|---|---|---|---|---|---|---|",
        ...Object.entries(l.reviews)
          .filter(([, v]) => v.objectiveId.startsWith(`${t}:`))
          .map(([key, v]) =>
            row([
              key,
              v.stage,
              v.due,
              v.lastIndependentAt ?? "—",
              v.lastIndependentDate ?? "—",
              v.sequence ?? "—",
              v.verifiedReviews,
            ]),
          ),
      ].join("\n") + "\n\n";
    p +=
      [
        row(["Suspended state", "Tier", "Phase", "Lap", "Queue"]),
        "|---|---|---|---|---|",
        ...l.tracks[t].suspended.map((v, i) =>
          row([
            String(i + 1),
            v.tier,
            v.phase,
            v.lap ?? "—",
            v.queue.join(", ") || "—",
          ]),
        ),
      ].join("\n") + "\n\n";
    content = replaceBlock(content, `${t}_PROGRESS`, p);
  }
  let shared = block(content, "SHARED_PROGRESS");
  shared = inSection(shared, "S0.1 Unified dashboard", (s) =>
    table(s, (c) => {
      if (!tracks.includes(c[0] as Track)) return;
      const t = c[0] as Track,
        st = l.tracks[t];
      const p = block(content, `${t}_PROGRESS`),
        gate = section(p, "0.2.1 Tier and gate board").text;
      const sweep = gate
        .split("\n")
        .find((line) => line.startsWith(`| Tier ${st.tier} `));
      return [
        t,
        `Tier ${st.tier} / ${st.phase} / ${wave(l, t)}`,
        sweep ? split(sweep)[2] : "See gate board",
        `${count(r, l, t).text}; D1 ${count(r, l, t, 1).text}`,
        pendingText(l, t),
        next,
      ];
    }),
  );
  shared = inSection(shared, "S0.2 Shared scheduler and resume packet", (s) =>
    fields(s, {
      "Track served by the last primary visit":
        recentServed.at(-1)?.contract.track ??
        split(
          shared
            .split("\n")
            .find((line) =>
              line.startsWith("| Track served by the last primary visit |"),
            )!,
        )[1],
      "Next track in alternation": `${(["PY", "PE", "PE"] as const)[studyRatioPosition(l)]}; pattern position ${studyRatioPosition(l)}; ${l.cycle} app-recorded served visit(s) since source revision ${r.revision}; imported source visits remain in their original history; unfinished visit and gate exceptions take precedence`,
      "Planned continuation order": next,
      "Tier-lead status": `PY cleared through ${l.tracks.PY.cleared}; PE cleared through ${l.tracks.PE.cleared}. A track may not start a tier more than one above the other track's current tier; independent gate evidence required.`,
      "Next action in this conversation": next,
      "Next action after a new-session upload": `Preserve this exact state; mark an unclosed ${current} INTERRUPTED_AT_LAST_SAVE and allocate the next shared session only on actual study. Missing task context requires a fresh same-scope linked continuation, not invented work. ${next}`,
      "Reserved next identifiers (shared counters)": reserved,
      "Save anchor": anchor,
    }),
  );
  shared = inSection(shared, "S0.4 Merged session history", (s) => {
    let out = table(s, (c) => {
      if (
        l.sessions.find((v) => v.id === c[0])?.status ===
          "INTERRUPTED_AT_LAST_SAVE" &&
        !c[1].includes("INTERRUPTED_AT_LAST_SAVE")
      ) {
        c[1] += "; INTERRUPTED_AT_LAST_SAVE; no invented closing time";
        return c;
      }
      return undefined;
    });
    out = upsert(
      out,
      l.sessions
        .filter((session) => sessionNeedsProjection(l, session.id))
        .map((session) => {
          const result = [
            session.id,
            `${localDate(session.startedAt ?? l.attempts.find((a) => a.session === session.id)!.startedAt)}; ${session.status}`,
            tracks
              .map(
                (t) =>
                  `${t}: ${
                    served
                      .filter(
                        (a) =>
                          a.session === session.id && a.contract.track === t,
                      )
                      .map(
                        (a) =>
                          `${a.id} ${a.contract.objectiveIds.map(short).join(", ")} D${a.contract.depth}${a.contract.review ? " review" : ""}`,
                      )
                      .join("; ") || "no primary visit served"
                  }`,
              )
              .join(". "),
            tracks
              .map(
                (t) =>
                  `${t}: ${
                    l.evidence
                      .filter(
                        (e) =>
                          e.id.startsWith(`${session.id}-`) &&
                          e.objectiveId.startsWith(`${t}:`),
                      )
                      .map((e) => e.id)
                      .join(", ") || "none"
                  }`,
              )
              .join(". "),
            `${next}; ${pendingText(l)}`,
          ];
          const source = l.roadmapAdoptions?.at(-1),
            retained =
              source &&
              block(source.proposal.canonical, "SHARED_PROGRESS")
                .split("\n")
                .find((line) => line.startsWith(`| ${session.id} |`));
          if (source && retained) {
            const original = split(retained),
              addedVisits = served.filter(
                (a) =>
                  a.session === session.id &&
                  !source.localServedAttempts?.includes(a.id),
              ),
              addedEvidence = l.evidence.filter(
                (e) =>
                  e.attemptId.startsWith(`${session.id}-`) &&
                  !source.localEvidenceIds?.includes(e.id),
              );
            result[2] = [
              original[2],
              addedVisits.length
                ? `Additional study visits: ${addedVisits.map((a) => `${a.id} ${a.contract.track} ${a.contract.objectiveIds.map(short).join(", ")} D${a.contract.depth}`).join("; ")}`
                : "",
            ]
              .filter(Boolean)
              .join("; ");
            result[3] = [
              original[3],
              addedEvidence.length
                ? `Additional study evidence: ${addedEvidence.map((e) => e.id).join(", ")}`
                : "",
            ]
              .filter(Boolean)
              .join("; ");
          }
          return result;
        }),
    );
    return out;
  });
  shared = inSection(shared, "S0.5 Merged revision history", (s) =>
    upsert(s, [
      [
        String(revision),
        date,
        `Complete semantic study progress save from actual revision ${revision - 1}; parent SHA-256 ${parentHash}; no original curriculum or historical evidence removed`,
        `${l.evidence.length} cumulative additional assessed evidence rows; ${served.length} unique additional primary visits; saving itself awards no credit`,
      ],
    ]),
  );
  content = replaceBlock(content, "SHARED_PROGRESS", shared);
  content = projectEnvironment(content, r, l);
  content = projectIdentifierCounters(content, counters);
  for (const event of l.retentionHistory ?? []) {
    const audit = retentionEventText(event);
    if (!content.includes(audit)) {
      let progress = block(content, "SHARED_PROGRESS").trimEnd();
      if (!progress.includes("### S0.8 Delayed review transaction audit\n"))
        progress +=
          "\n\n### S0.8 Delayed review transaction audit\n\nOriginal evidence-linked review transactions. Withdrawn reviews remain historical facts; only explicitly reviewed valid transactions count toward the current retention schedule.\n";
      content = replaceBlock(
        content,
        "SHARED_PROGRESS",
        progress + "\n\n" + audit + "\n",
      );
    }
  }
  for (const name of ["MERGE_RULES", "PY_CURRICULUM", "PE_CURRICULUM"])
    if (block(content, name) !== block(r.raw, name))
      throw Error(`Protected ${name} changed during export`);
  for (const t of tracks) {
    const p = block(content, `${t}_PROGRESS`),
      ledger = section(p, "0.4 Objective checkpoint ledger").text;
    const rows = ledger
      .split("\n")
      .filter((line) => /^\| [TX]\d{2}\.\d+ \|/.test(line));
    if (rows.length !== r.tracks[t].objectives.length)
      throw Error("Export lost objective rows");
    for (const line of rows) {
      const c = split(line);
      if (c.slice(2, 6).join(",") !== l.cells[`${t}:${c[0]}`].states.join(","))
        throw Error("Export checkpoint projection mismatch");
    }
    for (const heading of [
      "0.5 Assessment evidence register",
      "0.5.1 Attempt status register",
      "0.6 Facet gaps, unknowns, and dependencies",
    ]) {
      const ids = section(p, heading)
        .text.split("\n")
        .filter((line) => /^\| (?:S\d{4}-(?:A|EV)\d+|G\d{4}) \|/.test(line))
        .map((line) => split(line)[0]);
      if (new Set(ids).size !== ids.length)
        throw Error("Export duplicated evidence, attempt or gap row");
    }
  }
  return {
    fingerprint,
    content,
    revision,
    hash: await sha256(content),
    parentHash,
    ledgerVersion: l.version,
    gapIds,
  };
}
