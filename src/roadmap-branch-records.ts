import { isRecord } from "./records";
import type {
  RoadmapReconciliation,
  RoadmapReconciliationPayload,
} from "./roadmap-adoption-types";
import { inspectMergedDocument } from "./roadmap-structure";
import { CELL_SEPARATOR } from "./table-row";
const journals = (text: string) =>
  text.match(/<!-- BRANCH_RECORDS [^\n]* -->/g) ?? [];
const idOf = (row: string) => row.split(CELL_SEPARATOR)[1]?.trim();
const formal = (key: string) =>
  /^(PY|PE)_PROGRESS\/0\.5(?:\.1)? /.test(key) &&
  /\/S\d{4}-(?:A|EV)\d{2,}$/.test(key);
function readAudit(audit: string) {
  try {
    const v: unknown = JSON.parse(
      decodeURIComponent(
        audit.slice("<!-- BRANCH_RECORDS ".length, -" -->".length),
      ),
    );
    if (
      !isRecord(v) ||
      v.schema !== 1 ||
      typeof v.localHash !== "string" ||
      typeof v.incomingHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(v.localHash) ||
      !/^[a-f0-9]{64}$/.test(v.incomingHash) ||
      !Array.isArray(v.records) ||
      !v.records.length ||
      v.records.length > 20000 ||
      typeof v.rationale !== "string" ||
      !v.rationale.trim() ||
      v.rationale.length > 1500
    )
      throw Error();
    const keys = new Set<string>();
    for (const r of v.records) {
      if (
        !isRecord(r) ||
        typeof r.key !== "string" ||
        !formal(r.key) ||
        keys.has(r.key) ||
        typeof r.row !== "string" ||
        /[\r\n]/.test(r.row) ||
        !r.key.endsWith("/" + idOf(r.row))
      )
        throw Error();
      keys.add(r.key);
    }
  } catch {
    throw Error("Malformed source-qualified branch record audit");
  }
}
/** Preserve distinct incoming observations in an unresolved source-qualified
 * namespace. Never renumber history or promote quarantined observations. */
export function normalizeBranchRecords(
  payload: RoadmapReconciliationPayload,
  proposal: RoadmapReconciliation,
) {
  const local = inspectMergedDocument(payload.local),
    incoming = inspectMergedDocument(payload.candidate),
    merged = inspectMergedDocument(proposal.canonical);
  const retained = new Set<string>(),
    requested = new Set<string>();
  const claims = proposal.branchConflicts ?? [];
  if (!Array.isArray(claims) || claims.length > 1000)
    throw Error("Invalid branch conflict review");
  const records: { key: string; row: string }[] = [];
  for (const claim of claims) {
    if (
      !claim ||
      !["PY", "PE"].includes(claim.track) ||
      !/^S\d{4}-(?:A|EV)\d{2,}$/.test(claim.id)
    )
      throw Error("Invalid source-qualified conflict identity");
    const key = [...incoming.rows.keys()].find(
      (k) =>
        formal(k) &&
        k.startsWith(claim.track + "_PROGRESS/") &&
        k.endsWith("/" + claim.id),
    );
    if (
      !key ||
      requested.has(key) ||
      !local.rows.has(key) ||
      local.rows.get(key) === incoming.rows.get(key)
    )
      throw Error("Branch conflict needs two distinct actual source records");
    requested.add(key);
    const a = local.rows
        .get(key)!
        .split(CELL_SEPARATOR)
        .slice(1, -1)
        .map((s) => s.trim()),
      b = incoming.rows
        .get(key)!
        .split(CELL_SEPARATOR)
        .slice(1, -1)
        .map((s) => s.trim());
    if (
      claim.id.includes("-A") &&
      a.slice(0, 3).join("|") === b.slice(0, 3).join("|")
    )
      throw Error(
        "Same issued task needs an attempt disposition review, not a branch identity claim",
      );
    retained.add(key);
    // Evidence tied to a colliding incoming task must never bind to its local
    // namesake. Preserve the complete incoming observations in the same audit.
    if (claim.id.includes("-A"))
      for (const [k, row] of incoming.rows)
        if (
          formal(k) &&
          k.startsWith(claim.track + "_PROGRESS/0.5 ") &&
          row.split(CELL_SEPARATOR)[2]?.trim() === claim.id
        )
          retained.add(k);
  }
  for (const key of [...retained].sort()) {
    const row = incoming.rows.get(key)!;
    if (merged.rows.get(key) !== local.rows.get(key))
      throw Error(
        "Unresolved branch records must preserve local register identity and quarantine the incoming row",
      );
    records.push({ key, row });
  }
  let canonical = proposal.canonical;
  const previous = new Set([
    ...journals(payload.local),
    ...journals(payload.candidate),
  ]);
  for (const audit of previous) {
    readAudit(audit);
    if (!canonical.includes(audit))
      throw Error("Reconciliation lost a source-qualified branch record audit");
  }
  let expected: string | undefined;
  if (records.length) {
    if (
      typeof proposal.branchRationale !== "string" ||
      !proposal.branchRationale.trim() ||
      proposal.branchRationale.length > 1500
    )
      throw Error(
        "Unresolved branch preservation needs an explicit review rationale",
      );
    expected = `<!-- BRANCH_RECORDS ${encodeURIComponent(JSON.stringify({ schema: 1, localHash: payload.localHash, incomingHash: payload.candidateHash, records, rationale: proposal.branchRationale }))} -->`;
    if (!canonical.includes(expected)) {
      const heading = "### S0.8 Source-qualified unresolved branch records";
      const introduction = canonical.includes(heading + "\n")
        ? ""
        : heading +
          "\n\nConflicting incoming records retain their original identifiers, qualified by the exact source file hash in the audit below. These unresolved observations grant no learning or practical certification.\n\n";
      canonical = canonical.replace(
        "<!-- END SHARED_PROGRESS -->",
        introduction + expected + "\n<!-- END SHARED_PROGRESS -->",
      );
    }
  }
  const audits = journals(canonical);
  if (new Set(audits).size !== audits.length)
    throw Error("Duplicate source-qualified branch record audit");
  for (const audit of audits)
    if (!previous.has(audit) && audit !== expected)
      throw Error("Unsupported source-qualified branch record audit");
  return { proposal: { ...proposal, canonical }, retained, requested };
}
