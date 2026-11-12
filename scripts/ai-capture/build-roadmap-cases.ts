#!/usr/bin/env node
/**
 * Build offline ladder cases for the `reconcile-roadmap` AI call.
 *
 * Every payload is produced by the real builder (`reconcileRoadmap` in
 * src/roadmap-adoption.ts) against the checked-in roadmap and a live learner,
 * with an intercepted requester: nothing leaves the machine and no provider is
 * called. Candidates are realistic sibling revisions of the same roadmap file
 * (revision 10, parent = the checked-in revision 9 digest) that differ only in
 * the conflict under test.
 *
 * Note on objective-level conflicts: `reconcileRoadmap` parses the candidate
 * with `parseRoadmapDocument(candidate, r)`, which requires exactly 80 PY / 112
 * PE objectives and an unchanged (id, target, scope) roster, and it treats the
 * curriculum blocks as protected. Adding, removing, renaming or reordering
 * objectives therefore fails before a payload exists ("Incomplete or duplicate
 * ... objective roster", "Protected PY_CURRICULUM changed", "Changed PY
 * objective selection, order, target or scope"). The conflict families below
 * are the ones a reconcile candidate can actually express: added or rewritten
 * assessment records, removal of the recorded observations behind an objective
 * that already has evidence, contradictory facet definitions, a mixed revision
 * and a near-identical revision.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyLearningAssessment,
  beginLearningAttempt,
  eligibleLearning,
  registerScopes,
} from "../../src/learner";
import type { Roadmap } from "../../src/model";
import { reconcileRoadmap } from "../../src/roadmap-adoption";
import type { RoadmapReconciliation } from "../../src/roadmap-adoption-types";
import { prepareRoadmapExport } from "../../src/roadmap-export";
import { createGame } from "../../src/world";

export const RECONCILE_OPERATION = "reconcile-roadmap" as const;
export const DEFAULT_COUNT = 6;

export type RoadmapPayload = { local: string; candidate: string } & Record<
  string,
  unknown
>;

export type RoadmapCase = {
  id: string;
  operation: typeof RECONCILE_OPERATION;
  payload: RoadmapPayload;
  /** Imported progress a ready reply must carry; ignored by the offline ladder. */
  expected?: RoadmapExpectation;
};

/** The reply fields that carry imported study progress into an adopted file. */
export type RoadmapExpectation = Pick<
  RoadmapReconciliation,
  "definitions" | "mappings" | "completeScopes"
>;

const ROADMAP_FILE = "public/curriculum.json";

/** Split into lines, run one row-level edit, and rejoin. */
function rows(text: string, edit: (lines: string[]) => void) {
  const lines = text.split("\n");
  edit(lines);
  return lines.join("\n");
}

function only(lines: string[], prefix: string, what: string) {
  const found = lines
    .map((line, index) => ({ line, index }))
    .filter((entry) => entry.line.startsWith(prefix));
  if (found.length !== 1)
    throw Error(
      `${what}: expected exactly one row starting ${JSON.stringify(prefix)}, found ${found.length}`,
    );
  return found[0];
}

function editOnce(text: string, before: string, after: string) {
  const first = text.indexOf(before);
  if (first < 0) throw Error(`anchor missing: ${JSON.stringify(before)}`);
  if (text.indexOf(before, first + 1) >= 0)
    throw Error(`ambiguous anchor: ${JSON.stringify(before)}`);
  return `${text.slice(0, first)}${after}${text.slice(first + before.length)}`;
}

function insertAfter(text: string, prefix: string, added: string[]) {
  return rows(text, (lines) => {
    const { index } = only(lines, prefix, "insertAfter");
    lines.splice(index + 1, 0, ...added);
  });
}

/** Insert rows after the one row that contains `marker` (marker is unique). */
function insertAfterRow(text: string, marker: string, added: string[]) {
  return rows(text, (lines) => {
    const found = lines
      .map((line, index) => ({ line, index }))
      .filter(
        (entry) => entry.line.startsWith("|") && entry.line.includes(marker),
      );
    if (found.length !== 1)
      throw Error(
        `insertAfterRow: expected one row containing ${JSON.stringify(marker)}, found ${found.length}`,
      );
    lines.splice(found[0].index + 1, 0, ...added);
  });
}

/** Replace the one row that contains `marker` (marker must be unique). */
function replaceRow(text: string, marker: string, row: string) {
  return rows(text, (lines) => {
    const found = lines
      .map((line, index) => ({ line, index }))
      .filter(
        (entry) => entry.line.startsWith("|") && entry.line.includes(marker),
      );
    if (found.length !== 1)
      throw Error(
        `replaceRow: expected one row containing ${JSON.stringify(marker)}, found ${found.length}`,
      );
    lines[found[0].index] = row;
  });
}

/** Replace every occurrence of exact text, requiring the expected count. */
function replaceAll(
  text: string,
  before: string,
  after: string,
  count: number,
) {
  const seen = text.split(before).length - 1;
  if (seen !== count)
    throw Error(
      `replaceAll: expected ${count} occurrences of ${JSON.stringify(before)}, found ${seen}`,
    );
  return text.split(before).join(after);
}

function dropRows(text: string, prefixes: string[]) {
  return rows(text, (lines) => {
    for (const prefix of prefixes) {
      const { index } = only(lines, prefix, "dropRows");
      lines.splice(index, 1);
    }
  });
}

function moveAfter(text: string, moving: string, anchor: string) {
  return rows(text, (lines) => {
    const from = only(lines, moving, "moveAfter source");
    const [row] = lines.splice(from.index, 1);
    const to = only(lines, anchor, "moveAfter anchor");
    lines.splice(to.index + 1, 0, row);
  });
}

/** Replace cells (0-based, first cell is the row id) of one markdown row. */
function editCells(
  text: string,
  prefix: string,
  changes: Record<number, string>,
) {
  return rows(text, (lines) => {
    const { index, line } = only(lines, prefix, "editCells");
    // "| a | b |" -> ["a", "b"]: drop the outer "| " and " |" so a rewritten
    // row keeps the document's exact single-space cell padding.
    const cells = line.slice(2, -2).split(" | ");
    for (const [at, value] of Object.entries(changes))
      cells[Number(at)] = value;
    lines[index] = `| ${cells.join(" | ")} |`;
  });
}

/** Drop every recorded observation (evidence row) that names one objective. */
function dropObjectiveObservations(text: string, objective: string) {
  const lines = text.split("\n");
  const kept = lines.filter(
    (line) =>
      !(/^\| S\d+-EV\d+ \|/.test(line) && line.includes(`| ${objective} |`)),
  );
  if (kept.length === lines.length)
    throw Error(`no recorded observations for ${objective}`);
  return kept.join("\n");
}

const ADDED_T07 = [
  "| S0006-EV19 | S0006-A16 | 2026-09-19 | T07.1 | D1 late-save reread of the retained-tail contract | DIAGNOSTIC | NONE | 2 | Independently restated that the old tail must stay reachable after rewiring, then stopped before giving the traversal argument. Preserves the earlier narrow facet without adding a checkpoint pass. Described only |",
  "| S0006-EV20 | S0006-A16 | 2026-09-19 | T07.2 | D1 late-save reread of update ordering at the reconnection point | DIAGNOSTIC | NONE | 2 | Named the updates that must happen before the rewiring step in the clarified replacement interpretation. Ordering completeness and end-of-chain handling remain unassessed. Described only |",
];

export type RoadmapRecipe = {
  id: string;
  conflict: string;
  /** Candidate document text derived from the checked-in local roadmap. */
  edit(raw: string): string;
};

export const RECIPES: RoadmapRecipe[] = [
  {
    id: "add-learning-records",
    conflict:
      "candidate only adds assessment records (the builder forbids adding objectives: the roster is fixed at 80 PY / 112 PE)",
    edit: (raw) => insertAfter(raw, "| S0006-EV17 |", ADDED_T07),
  },
  {
    id: "rewrite-and-reorder-observations",
    conflict:
      "candidate rewords and reorders existing recorded observations (objectives cannot be renamed)",
    edit: (raw) =>
      moveAfter(
        editOnce(
          editOnce(
            raw,
            "D1 ownership/access preservation during linked traversal",
            "D1 reference ownership and access preservation on a linked traversal",
          ),
          "D1 pre-rewire update ordering that preserves unprocessed nodes",
          "D1 ordering of pre-rewire updates that keeps unprocessed nodes reachable",
        ),
        "| S0006-EV16 |",
        "| S0006-EV17 |",
      ),
  },
  {
    id: "remove-objective-observations",
    conflict:
      "candidate removes every recorded observation behind PY:T01.2, an objective the local roadmap has evidence for; those observations must be preserved",
    edit: (raw) => dropObjectiveObservations(raw, "T01.2"),
  },
  {
    id: "conflicting-facet-definitions",
    conflict:
      "candidate contradicts the local definition of the remaining PY:T01.2 cost-model facets",
    edit: (raw) =>
      editCells(
        editCells(raw, "| G0002 |", {
          3: "Guided S0001 and S0002 statements only; no independent time or space derivation was ever recorded",
          4: "The complete D1 cost model, including the S0004 derivation this revision no longer recognises",
          7: "Re-derive the whole cost model in a fresh context; do not credit the earlier guided statements",
        }),
        "| G0008 |",
        {
          3: "Guided reasoning only; the D2 cost derivation is disputed by this revision",
          4: "A fresh independent D2 cost derivation, including the auxiliary-space bound refused locally",
        },
      ),
  },
  {
    id: "mixed-revision",
    conflict:
      "candidate both adds records, rewrites one observation and drops an evidenced one",
    edit: (raw) =>
      dropRows(
        editOnce(
          insertAfter(raw, "| S0006-EV17 |", [ADDED_T07[0]]),
          "D1 ordering-contract clarification and implementation consequence",
          "D1 ordering-contract clarification, later re-read as an implementation consequence",
        ),
        ["| S0002-EV06 |"],
      ),
  },
  {
    id: "near-identical",
    conflict:
      "candidate is the local revision with one hyphen removed from an administrative revision note",
    edit: (raw) =>
      editOnce(
        raw,
        "Shared DEC0027 adds the common-idiom practice rule across both tracks, so future PY examples",
        "Shared DEC0027 adds the common idiom practice rule across both tracks, so future PY examples",
      ),
  },
];

const ADMIN_DATE = "2026-09-20";
const ADMIN_SESSION = "S0007";
const ADMIN_DECISION = "DEC0028";
const NEXT_DECISION = "DEC0029";

/** One learner-requested administrative change, recorded as revision 10. */
export type AdoptRecipe = RoadmapRecipe & {
  /** Cells 2-5 of the new shared decision row (id, date/session and status fixed). */
  decision: { type: string; scope: string; reason: string; expiry: string };
  /** One clause naming the change in each track's revision-history row. */
  recorded: string;
};

const decisionRow = (recipe: AdoptRecipe) =>
  `| ${[
    ADMIN_DECISION,
    `${ADMIN_DATE} / ${ADMIN_SESSION}`,
    recipe.decision.type,
    recipe.decision.scope,
    recipe.decision.reason,
    recipe.decision.expiry,
    "ACTIVE",
  ].join(" | ")} |`;

/**
 * Record one learner-requested administrative change the way the roadmap's own
 * protocol records a distinct saved change: `updated_on` plus one revision bump
 * (`revise()` sets `previous_revision` and `parent_file_sha256`), a new shared
 * decision row after DEC0027, advanced shared decision counters in the S0.2
 * declaration and both reserved rows, a revision-history row in each track, and
 * save anchors that describe merged revision 10 and its parent. Nothing here
 * adds, reorders or re-scores a record; the change is learner-reported, never
 * evidence and never a mastery claim.
 */
export function recordAdministrativeRevision(raw: string, recipe: AdoptRecipe) {
  const parent = createHash("sha256").update(raw).digest("hex");
  const history = (track: "PY" | "PE") =>
    `| Merged r10 | ${ADMIN_DATE} | ${recipe.recorded} Shared ${ADMIN_DECISION} records the learner's request; ${track} curriculum and learning evidence are unchanged, so this administrative save closes no study. | None; no ${track} learning evidence or checkpoint state changed. |`;
  let text = recipe.edit(raw);
  text = insertAfterRow(text, "| DEC0027 |", [decisionRow(recipe)]);
  text = replaceAll(
    text,
    "next shared decision DEC0028",
    `next shared decision ${NEXT_DECISION}`,
    2,
  );
  text = editOnce(
    text,
    "and decision DEC0028.",
    `and decision ${NEXT_DECISION}.`,
  );
  text = editOnce(
    text,
    "G0048 and shared DEC0027 are allocated",
    `G0048 and shared DEC0027–${ADMIN_DECISION} are allocated`,
  );
  text = editOnce(
    text,
    'updated_on: "2026-09-19"',
    `updated_on: "${ADMIN_DATE}"`,
  );
  text = replaceRow(
    text,
    "| Save anchor | Merged revision 9, 2026-09-19",
    `| Save anchor | Merged revision 10, ${ADMIN_DATE}, is a mid-session save from uploaded merged revision 9 (parent SHA-256 \`${parent}\`). It records the learner-requested administrative change as ${ADMIN_DECISION} with no study outcome and no evidence claim. Next distinct saved change becomes merged revision 11 |`,
  );
  text = replaceRow(
    text,
    "Track PY learning state is unchanged inside merged revision 9",
    `| Save anchor | Track PY learning state is unchanged inside merged revision 10; shared ${ADMIN_DECISION} records the learner-requested administrative change. Revision 10 parent is \`${parent}\` and PY curriculum bytes are unchanged. Next distinct merged save becomes revision 11 |`,
  );
  text = replaceRow(
    text,
    "Track PE updated inside merged revision 9",
    `| Save anchor | Track PE carries the ${ADMIN_DECISION} administrative note inside merged revision 10 from uploaded merged revision 9 parent \`${parent}\`; no PE learning record moved. Curriculum bytes are unchanged and the next distinct merged save becomes revision 11 |`,
  );
  text = insertAfterRow(
    text,
    "Mid-session S0007 save affected PE learning state only",
    [history("PY")],
  );
  text = insertAfterRow(
    text,
    "Mid-session S0007 save: X08 W0 visit completed using TypeScript",
    [history("PE")],
  );
  text = editOnce(
    text,
    "If revision 9 is used in a genuinely new session",
    "If revision 10 is used in a genuinely new session",
  );
  text = editOnce(
    text,
    "S0007; merged revision 9; 2026-09-19; mid-session save, not a session close",
    `S0007; merged revision 10; ${ADMIN_DATE}; mid-session administrative save, not a session close`,
  );
  return text;
}

/**
 * Cases where adopting the incoming revision is the correct review. Every
 * candidate is a sibling revision whose only changes are administrative rows:
 * no recorded observation, objective, gate or rule block moves, and the change
 * is fully recorded as revision 10 (DEC0028, advanced counters, a
 * revision-history row and updated save anchors), so the game accepts adoption
 * once each changed row is resolved as "incoming".
 */
export const ADOPT_RECIPES: AdoptRecipe[] = [
  {
    id: "administrative-profile",
    conflict:
      "candidate records a learner-reported design-systems profile addition in the shared Learner row and PE Section 0.1 as a complete revision 10; local work is untouched and the incoming administrative profile should be adopted",
    decision: {
      type: "LEARNER_PROFILE",
      scope:
        "Both tracks; shared S0.1 Learner row and PE Section 0.1 career goal",
      reason:
        "Learner asked that the reported profile note an added design-systems depth. This is a learner-reported preference, not evidence, and it changes no objective, checkpoint, evidence row or denominator",
      expiry:
        "Until the learner reports a different profile; confers no learning credit",
    },
    recorded:
      "The shared Learner row and the PE Section 0.1 career goal note the learner-reported design-systems depth.",
    edit: (raw) =>
      editCells(
        editOnce(
          raw,
          "rather than repeating current work (learner statement, 2026-09-15) |",
          "rather than repeating current work (learner statement, 2026-09-15; S0007 learner-reported update adds design-systems depth, recorded as DEC0028 and not treated as evidence) |",
        ),
        "| Learner |",
        {
          1: "Mid-level engineer pivoting from internal tools to customer-facing product work; administrative profile updated from S0007 to add design-systems depth, with details in PE Section 0.1 (contact details deliberately not stored)",
        },
      ),
  },
  {
    id: "administrative-deadline-window",
    conflict:
      "candidate records the learner-reported interview window as an availability note in the shared session-length row, with a complete revision 10 record; no study record moves and the note should be adopted",
    decision: {
      type: "SCHEDULE_AVAILABILITY",
      scope:
        "Both tracks; shared S0.1 session length and interview deadline row",
      reason:
        "Learner reported an on-site interview loop from 2026-10-05 to 2026-10-09 and asked that no study visit or due review fall inside it. Availability only: no session, attempt, evidence row, checkpoint or denominator changes",
      expiry:
        "Until 2026-10-09 passes; revisit only if the learner moves the loop",
    },
    recorded:
      "The shared session-length row notes the learner-reported 2026-10-05 to 2026-10-09 interview window with no study visit inside it.",
    edit: (raw) =>
      editCells(raw, "| Session length / interview deadline |", {
        1: "On-site interview loop 2026-10-05 to 2026-10-09 (learner report, DEC0028): schedule no study visit or due review inside that window. Session length itself is still unconfirmed",
      }),
  },
  {
    id: "administrative-decision-reason",
    conflict:
      "candidate rewords the reason of one administrative shared decision (DEC0019) without changing its scope, status or effect and records that clarification as a complete revision 10; the clearer wording should be adopted",
    decision: {
      type: "DECISION_CLARIFICATION",
      scope:
        "Shared S0.3 administrative decision DEC0019 and its ratio and format rule",
      reason:
        "Learner asked for clearer wording in the reason of shared decision DEC0019. Only that wording changes; its scope, status, 1 PY : 2 PE ratio and effect are unchanged and no study record moves",
      expiry: "Wording only; DEC0019 stays ACTIVE until the learner changes it",
    },
    recorded:
      "The reason of shared administrative decision DEC0019 is reworded for clarity at the learner's request with no change to its scope, status, ratio or effect.",
    edit: (raw) =>
      editOnce(
        raw,
        "Two interview-loop research reports (S0.6) agree that algorithms remain in many loops",
        "Two interview-loop research reports (S0.6) agree that algorithm questions remain in many loops",
      ),
  },
];

/** Turn a raw candidate into a sibling revision of the checked-in roadmap. */
export function revise(raw: string, parent: string, revision = 10) {
  return raw
    .replace(/^revision: \d+$/m, `revision: ${revision}`)
    .replace(/^previous_revision: \d+$/m, `previous_revision: ${revision - 1}`)
    .replace(/^parent_file_sha256: .+$/m, `parent_file_sha256: "${parent}"`);
}

export function loadRoadmap(file = ROADMAP_FILE): Roadmap {
  return JSON.parse(readFileSync(resolve(file), "utf8")) as Roadmap;
}

async function capturePayload(
  roadmap: Roadmap,
  candidate: string,
): Promise<RoadmapPayload> {
  const { payload } = await openReconciliation(roadmap, candidate);
  return payload;
}

/**
 * Start a reconciliation with an intercepted requester and hand back both the
 * captured payload and the game that owns it, so a caller can resume the same
 * saved request offline. No provider is contacted.
 */
export async function openReconciliation(
  roadmap: Roadmap,
  candidate: string,
): Promise<{ g: ReturnType<typeof createGame>; payload: RoadmapPayload }> {
  const g = createGame(7, roadmap);
  g.study.profile = "live";
  let payload: unknown;
  await reconcileRoadmap(g, roadmap, candidate, async (captured) => {
    payload = captured;
    throw Error("offline capture: no provider request is made");
  });
  if (!payload)
    throw Error("reconcileRoadmap never reached its request stage; no payload");
  return { g, payload: payload as RoadmapPayload };
}

/** Build one adopt case per recipe: the candidate changes administrative rows only. */
export async function buildAdoptCases({
  roadmap,
}: { roadmap?: Roadmap } = {}): Promise<RoadmapCase[]> {
  const base = roadmap ?? loadRoadmap();
  const seen = new Map<string, string>();
  const cases: RoadmapCase[] = [];
  for (const recipe of ADOPT_RECIPES) {
    // A fresh copy keeps one case's learner state out of the next payload.
    const local: Roadmap = JSON.parse(JSON.stringify(base)) as Roadmap;
    const candidate = revise(
      recordAdministrativeRevision(local.raw, recipe),
      local.sourceHash,
    );
    if (candidate === local.raw)
      throw Error(`Adopt recipe ${recipe.id} produced an unchanged candidate`);
    const payload = await capturePayload(local, candidate);
    const hash = createHash("sha256")
      .update(JSON.stringify([payload.local, payload.candidate]))
      .digest("hex");
    if (seen.has(hash))
      throw Error(
        `Adopt recipes ${seen.get(hash)} and ${recipe.id} produced the same payload`,
      );
    seen.set(hash, recipe.id);
    cases.push({
      id: `${RECONCILE_OPERATION}-adopt-${recipe.id}`,
      operation: RECONCILE_OPERATION,
      payload,
    });
  }
  return cases;
}

export const ADOPT_FILE = `${RECONCILE_OPERATION}-adopt.json`;

/** Write the adopt case file and merge its count into the shared index. */
export async function writeAdoptCases(
  out: string,
  built?: RoadmapCase[],
): Promise<{ cases: RoadmapCase[]; index: Record<string, number> }> {
  const cases = built ?? [
    ...(await buildAdoptCases()),
    ...(await buildProgressAdoptCases()),
  ];
  const target = resolve(out);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  chmodSync(target, 0o700);
  const file = join(target, ADOPT_FILE);
  writeFileSync(file, `${JSON.stringify(cases, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  const indexFile = join(target, "index.json");
  let index: Record<string, number> = {};
  try {
    const existing: unknown = JSON.parse(readFileSync(indexFile, "utf8"));
    if (!existing || typeof existing !== "object" || Array.isArray(existing))
      throw Error("index.json must hold an operation -> count object");
    index = existing as Record<string, number>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  index[`${RECONCILE_OPERATION}-adopt`] = cases.length;
  writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(indexFile, 0o600);
  return { cases, index };
}

/** Build `count` distinct reconcile-roadmap payloads without any network. */
export async function buildRoadmapCases({
  count = DEFAULT_COUNT,
  roadmap,
}: { count?: number; roadmap?: Roadmap } = {}): Promise<RoadmapCase[]> {
  if (!Number.isInteger(count) || count < 1)
    throw Error("count must be a positive integer");
  if (count > RECIPES.length)
    throw Error(
      `Only ${RECIPES.length} reconcile-roadmap conflict recipes exist; asked for ${count}`,
    );
  const base = roadmap ?? loadRoadmap();
  const seen = new Map<string, string>();
  const cases: RoadmapCase[] = [];
  for (const recipe of RECIPES.slice(0, count)) {
    // A fresh copy keeps one case's learner state out of the next payload.
    const local: Roadmap = JSON.parse(JSON.stringify(base)) as Roadmap;
    const candidate = revise(recipe.edit(local.raw), local.sourceHash);
    if (candidate === local.raw)
      throw Error(`Recipe ${recipe.id} produced an unchanged candidate`);
    const payload = await capturePayload(local, candidate);
    const hash = createHash("sha256")
      .update(JSON.stringify([payload.local, payload.candidate]))
      .digest("hex");
    if (seen.has(hash))
      throw Error(
        `Recipes ${seen.get(hash)} and ${recipe.id} produced the same payload`,
      );
    seen.set(hash, recipe.id);
    cases.push({
      id: `${RECONCILE_OPERATION}-${recipe.id}`,
      operation: RECONCILE_OPERATION,
      payload,
    });
  }
  return cases;
}

/** Write the reconcile-roadmap case file and merge the shared count index. */
export async function writeRoadmapCases(
  out: string,
  count = DEFAULT_COUNT,
): Promise<{ cases: RoadmapCase[]; index: Record<string, number> }> {
  const cases = await buildRoadmapCases({ count });
  const target = resolve(out);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  chmodSync(target, 0o700);
  const file = join(target, `${RECONCILE_OPERATION}.json`);
  writeFileSync(file, `${JSON.stringify(cases, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  const indexFile = join(target, "index.json");
  let index: Record<string, number> = {};
  try {
    const existing: unknown = JSON.parse(readFileSync(indexFile, "utf8"));
    if (!existing || typeof existing !== "object" || Array.isArray(existing))
      throw Error("index.json must hold an operation -> count object");
    index = existing as Record<string, number>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  index[RECONCILE_OPERATION] = cases.length;
  writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(indexFile, 0o600);
  return { cases, index };
}

function argument(name: string, fallback?: string) {
  const at = process.argv.indexOf(name);
  if (at === -1) return fallback;
  const value = process.argv[at + 1];
  if (!value) throw Error(`${name} needs a value`);
  return value;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  const out = argument("--out", ".local/ai-cases")!;
  const set = argument("--set", "default");
  if (set !== "default" && set !== "adopt")
    throw Error(
      `--set must be "default" or "adopt" (got ${JSON.stringify(set)})`,
    );
  const count = Number(argument("--count", String(DEFAULT_COUNT)));
  const written =
    set === "adopt" ? writeAdoptCases(out) : writeRoadmapCases(out, count);
  written.then(
    ({ cases, index }) => {
      const characters = cases.reduce(
        (sum, item) =>
          sum +
          String(item.payload.local).length +
          String(item.payload.candidate).length,
        0,
      );
      console.log(
        `Wrote ${cases.length} ${set === "adopt" ? `${RECONCILE_OPERATION}-adopt` : RECONCILE_OPERATION} cases to ${resolve(out)} (${characters} local+candidate characters); index: ${JSON.stringify(index)}.`,
      );
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}

/** A fresh live game, mirroring the study fixture the reference test proves. */
function liveStudy(roadmap: Roadmap) {
  const g = createGame(7, roadmap);
  g.study.profile = "live";
  g.status = "playing";
  g.zombies = [];
  g.nextSpawn = Number.MAX_SAFE_INTEGER;
  if (!g.study.learner) throw Error("a live study profile has no learner");
  return { g, l: g.study.learner };
}

/**
 * Run real study through the game's own learner functions and export the
 * resulting descendant revision. One round records an independent observation
 * on a single facet without completing the checkpoint scope; the full three
 * rounds complete it and pass the checkpoint.
 */
async function studiedProgressFile(roadmap: Roadmap, rounds: number) {
  const { g, l } = liveStudy(roadmap);
  let n = 0;
  for (let i = 0; i < rounds; i++) {
    const e = Object.values(g.encounters)[n++],
      c = eligibleLearning(roadmap, l, "2026-10-16T16:00:00Z");
    e.problem = {
      title: "Synthetic external study",
      prompt: "Synthetic only",
      rubric: [],
      starter: "",
      provenance: "study-mode",
      contract: c,
      scopeDefinitions: c.objectiveIds.map((id) => ({
        id: `${id}/D${c.depth}`,
        objectiveId: id,
        depth: c.depth,
        sourceScope: c.scopes[c.objectiveIds.indexOf(id)],
        facets: [
          { id: "scope", description: "Synthetic complete same-depth scope" },
        ],
      })),
    };
    e.history = [
      {
        seq: 1,
        author: "human",
        kind: "reasoning",
        text: "Synthetic external human contribution",
        at: 0,
        revision: 0,
        wallTime: "2026-10-16T16:00:00Z",
      },
    ];
    registerScopes(roadmap, l, e);
    beginLearningAttempt(roadmap, l, e, "2026-10-16T16:00:00Z");
    applyLearningAssessment(
      roadmap,
      l,
      e,
      {
        id: `synthetic-external-${i}`,
        encounter: e.id,
        provenance: "study-mode",
        sourceVersion: l.version,
        status: "pending",
        evidenceCutoffSequence: 1,
        visitOutcome: "usable",
        scopeReviews: e.problem.scopeDefinitions!.map((d) => ({
          id: d.id,
          completeCoverage: true,
          rationale: "Synthetic complete source scope",
        })),
        findings: c.objectiveIds.map((id) => ({
          objectiveId: id,
          depth: c.depth,
          facet: "scope",
          outcome: "independent",
          evidence: [1],
          completeCheckpointScope: false,
          rationale: "Synthetic only",
        })),
      },
      "2026-10-16T16:00:00Z",
      "study-mode",
    );
  }
  const file = await prepareRoadmapExport(roadmap, l);
  const expected: RoadmapExpectation = {
    definitions: Object.values(l.scopes),
    mappings: l.evidence.map((ev) => {
      const row = file.content
        .split("\n")
        .find((line) => line.startsWith(`| ${ev.id} |`));
      if (!row) throw Error(`exported file has no evidence row for ${ev.id}`);
      const cells = row
        .split("|")
        .slice(1, -1)
        .map((v) => v.trim());
      return {
        scopeId: `${ev.objectiveId}/D${ev.depth}`,
        facet: ev.facet,
        outcome: "independent" as const,
        evidenceIds: [ev.id],
        sourceExcerpts: { [ev.id]: cells[8] },
        rationale:
          "Synthetic source correspondence; not actual human certification",
      };
    }),
    completeScopes: l.verifiedScopes,
  };
  return { file, l, expected };
}

/** Descendants that carry real study progress, not hand-written rows. */
const PROGRESS_ADOPT_RECIPES = [
  { id: "progress-one-observation", rounds: 1 },
  { id: "progress-checkpoint-pass", rounds: 3 },
] as const;

/**
 * Build adopt cases whose candidate is a genuine descendant holding imported
 * evidence, and record the reply fields that carry that progress across.
 */
export async function buildProgressAdoptCases({
  roadmap,
}: { roadmap?: Roadmap } = {}): Promise<RoadmapCase[]> {
  const base = roadmap ?? loadRoadmap();
  const cases: RoadmapCase[] = [];
  for (const recipe of PROGRESS_ADOPT_RECIPES) {
    // A fresh copy keeps one case's learner state out of the next payload.
    const local: Roadmap = JSON.parse(JSON.stringify(base)) as Roadmap;
    const { file, expected } = await studiedProgressFile(local, recipe.rounds);
    if (file.content === local.raw)
      throw Error(
        `Progress recipe ${recipe.id} produced an unchanged candidate`,
      );
    const payload = await capturePayload(local, file.content);
    if (payload.candidate !== file.content)
      throw Error(
        `Progress recipe ${recipe.id} captured a different candidate`,
      );
    if (payload.local !== local.raw)
      throw Error(
        `Progress recipe ${recipe.id} captured a different local file`,
      );
    cases.push({
      id: `${RECONCILE_OPERATION}-adopt-${recipe.id}`,
      operation: RECONCILE_OPERATION,
      payload,
      expected,
    });
  }
  return cases;
}
