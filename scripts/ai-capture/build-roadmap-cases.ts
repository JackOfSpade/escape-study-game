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
import type { Roadmap } from "../../src/model";
import { reconcileRoadmap } from "../../src/roadmap-adoption";
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
};

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
    const cells = line.slice(1, -1).split(" | ");
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
  const g = createGame(7, roadmap);
  g.study.profile = "live";
  let payload: unknown;
  await reconcileRoadmap(g, roadmap, candidate, async (captured) => {
    payload = captured;
    throw Error("offline capture: no provider request is made");
  });
  if (!payload)
    throw Error("reconcileRoadmap never reached its request stage; no payload");
  return payload as RoadmapPayload;
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
  const count = Number(argument("--count", String(DEFAULT_COUNT)));
  writeRoadmapCases(out, count).then(
    ({ cases, index }) => {
      const characters = cases.reduce(
        (sum, item) =>
          sum +
          String(item.payload.local).length +
          String(item.payload.candidate).length,
        0,
      );
      console.log(
        `Wrote ${cases.length} ${RECONCILE_OPERATION} cases to ${resolve(out)} (${characters} local+candidate characters); index: ${JSON.stringify(index)}.`,
      );
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
