import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  adoptReconciledRoadmap,
  reconcileRoadmap,
} from "../src/roadmap-adoption";
import { inspectMergedDocument } from "../src/roadmap-structure";
import { createGame } from "../src/world";
import {
  ADOPT_FILE,
  ADOPT_RECIPES,
  buildAdoptCases,
  buildProgressAdoptCases,
  loadRoadmap,
  RECONCILE_OPERATION,
  writeAdoptCases,
  type RoadmapCase,
  type RoadmapPayload,
} from "../scripts/ai-capture/build-roadmap-cases";
import { scoreRoadmapReplies } from "../scripts/ai-capture/score-roadmap-replies";

/** One build per file: the roadmap is large and the recipes are deterministic. */
const ADOPT_CASES = buildAdoptCases();

/**
 * Exact edits turning `local` into `target`. An adopt candidate both rewrites
 * and inserts rows, so every changed run is replaced by its new text, or
 * inserted after the unchanged row it follows. The edits are then replayed to
 * prove they rebuild the candidate byte for byte.
 */
function lineEdits(local: string, target: string) {
  const from = local.split("\n"),
    to = target.split("\n"),
    n = from.length,
    m = to.length,
    lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] =
        from[i] === to[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const matched: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (from[i] === to[j]) matched.push([i++, j++]);
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }
  const edits: { find: string; replace: string }[] = [];
  const occurrences = (text: string, find: string) => {
    if (!find) return Number.POSITIVE_INFINITY;
    let count = 0;
    for (
      let at = text.indexOf(find);
      at !== -1;
      at = text.indexOf(find, at + 1)
    )
      if (++count > 1) break;
    return count;
  };
  let text = local;
  /**
   * Emit one edit for a hunk. The anchor starts at the changed rows and grows
   * into neighbouring unchanged rows, never reaching back past the previous
   * hunk, until it occurs exactly once in the document as it now stands.
   */
  const emit = (
    ls: number,
    le: number,
    ts: number,
    te: number,
    floor: number,
  ) => {
    if (ls === le && ts === te) return floor;
    for (let before = 0, after = 0; ;) {
      const start = Math.max(floor, ls - before),
        end = Math.min(n, le + after),
        find = from.slice(start, end).join("\n");
      if (find && occurrences(text, find) === 1) {
        const replace = [
          ...from.slice(start, ls),
          ...to.slice(ts, te),
          ...from.slice(le, end),
        ].join("\n");
        const at = text.indexOf(find);
        text = text.slice(0, at) + replace + text.slice(at + find.length);
        edits.push({ find, replace });
        return le;
      }
      assert.ok(
        !(start === floor && end === n),
        `no unique anchor for the change at line ${ls}`,
      );
      if (ls - before > floor) before++;
      else after++;
    }
  };
  let done = 0,
    started = 0,
    floor = 0;
  for (const [i, j] of [...matched, [n, m] as [number, number]]) {
    floor = emit(done, i, started, j, floor);
    done = i + 1;
    started = j + 1;
  }
  assert.equal(text, target, "the edits must rebuild the incoming candidate");
  return edits;
}

/** The reply a model should send when the incoming revision is right. */
function adoptionReply(
  payload: Pick<RoadmapPayload, "local" | "candidate"> & {
    requestId?: unknown;
    localHash?: unknown;
    candidateHash?: unknown;
  },
): Record<string, unknown> {
  const incoming = inspectMergedDocument(payload.candidate),
    prior = inspectMergedDocument(payload.local),
    decisions = [...incoming.rows]
      .filter(([key, row]) => {
        const was = prior.rows.get(key);
        return was !== undefined && was !== row;
      })
      .map(([key]) => ({
        key,
        choice: "incoming" as const,
        rationale:
          "Accept the reviewed administrative row verbatim; no evidence row changes",
      }));
  return {
    requestId: payload.requestId,
    localHash: payload.localHash,
    candidateHash: payload.candidateHash,
    edits: lineEdits(payload.local, payload.candidate),
    definitions: [],
    mappings: [],
    completeScopes: [],
    decisions,
    rationale:
      "Synthetic adoption of an administrative-only descendant revision",
  };
}

test("the adopt set holds at least three distinct administrative-only revisions", async () => {
  const cases = await ADOPT_CASES;
  assert.ok(ADOPT_RECIPES.length >= 3, "fewer than three adopt recipes");
  assert.equal(cases.length, ADOPT_RECIPES.length);
  assert.equal(ADOPT_FILE, `${RECONCILE_OPERATION}-adopt.json`);
  assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
  assert.equal(
    new Set(cases.map((item) => item.payload.candidate)).size,
    cases.length,
    "every adopt recipe must produce a distinct candidate",
  );
  assert.equal(
    new Set(cases.map((item) => item.payload.local)).size,
    1,
    "only the candidate revision may vary between adopt cases",
  );
  for (const item of cases) {
    assert.equal(item.operation, RECONCILE_OPERATION);
    assert.ok(item.id.startsWith(`${RECONCILE_OPERATION}-adopt-`), item.id);
    assert.ok(item.payload.local.length > 100000, `${item.id} local`);
    assert.ok(item.payload.candidate.length > 100000, `${item.id} candidate`);
    assert.notEqual(item.payload.local, item.payload.candidate, item.id);
  }
});

test("the real reconcileRoadmap reaches ready for every adopt case from an edits reply", async () => {
  const cases = await ADOPT_CASES;
  for (const item of cases) {
    const recipe = ADOPT_RECIPES.find(
      (entry) => item.id === `${RECONCILE_OPERATION}-adopt-${entry.id}`,
    );
    assert.ok(recipe, `${item.id} has no adopt recipe`);
    assert.ok(
      item.payload.candidate.includes(
        `| DEC0028 | 2026-09-20 / S0007 | ${recipe.decision.type} |`,
      ) &&
        item.payload.candidate.includes(
          "| Save anchor | Merged revision 10, 2026-09-20, is a mid-session save from uploaded merged revision 9 (parent SHA-256 `",
        ) &&
        item.payload.candidate.includes("| Merged r10 | 2026-09-20 | "),
      `${item.id} candidate is not a fully recorded revision 10`,
    );
    const roadmap = loadRoadmap(),
      g = createGame(7, roadmap);
    g.study.profile = "live";
    let edits: { find: string; replace: string }[] = [];
    await reconcileRoadmap(
      g,
      roadmap,
      item.payload.candidate,
      async (payload) => {
        assert.equal(
          payload.local,
          item.payload.local,
          `${item.id} local snapshot`,
        );
        const reply = adoptionReply(payload);
        edits = reply.edits as { find: string; replace: string }[];
        return reply;
      },
    );
    assert.ok(edits.length > 0, `${item.id} reply carries no edits`);
    const job = g.study.roadmapReconciliations?.at(-1);
    assert.equal(job?.state, "ready", `${item.id}: ${job?.error}`);
    assert.equal(
      (job?.proposal as { canonical?: string } | undefined)?.canonical,
      item.payload.candidate,
      `${item.id} proposal is not the incoming document`,
    );
  }
});

test("the scorer separates adoptable, keep-local and rejected replies", async () => {
  const cases = await ADOPT_CASES;
  const item = cases[0];
  const good = adoptionReply(item.payload);
  const observation = item.payload.local
    .split("\n")
    .find((line) => line.startsWith("| S0002-EV06 |"));
  assert.ok(observation, "local roadmap records no S0002-EV06 observation");
  const broken = {
    ...good,
    edits: [{ find: `\n${observation}`, replace: "" }],
  };
  const base = {
    caseId: item.id,
    operation: RECONCILE_OPERATION,
    setting: "synthetic:high",
  };
  const score = await scoreRoadmapReplies({
    rows: [
      { ...base, rep: 0, outcome: "valid", answers: [good] },
      {
        ...base,
        rep: 1,
        outcome: "valid",
        answers: [
          {
            outcome: "keep-local",
            decisions: [{ key: "revision", choice: "local" }],
            rationale: "The incoming file is not this learner's progress",
          },
        ],
      },
      { ...base, rep: 2, outcome: "valid", answers: [broken] },
      { ...base, rep: 3, outcome: "invalid", answers: [good] },
      {
        ...base,
        operation: "materialize-work",
        outcome: "valid",
        answers: [good],
      },
    ],
    cases,
  });
  assert.deepEqual(
    score.rows.map((row) => row.classification),
    ["adoptable", "keep-local", "rejected"],
    "non reconcile-roadmap and invalid rows must not be scored",
  );
  assert.deepEqual(score.rows[1], {
    ...score.rows[1],
    classification: "keep-local",
  });
  const rejected = score.rows[2];
  assert.ok(rejected.error, "a rejected reply records the validator error");
  assert.ok(rejected.error!.length <= 200);
  assert.deepEqual(
    score.settings.map((entry) => ({
      setting: entry.setting,
      adoptable: entry.adoptable,
      rejected: entry.rejected,
      keepLocal: entry.keepLocal,
      total: entry.total,
    })),
    [
      {
        setting: "synthetic:high",
        adoptable: 1,
        rejected: 1,
        keepLocal: 1,
        total: 3,
      },
    ],
  );
  assert.equal(score.settings[0].adoptableRate, 1 / 3);
});

test("writeAdoptCases writes a private adopt file and keeps the shared index", async () => {
  const cases = await ADOPT_CASES;
  const dir = mkdtempSync(join(tmpdir(), "roadmap-adopt-"));
  try {
    writeFileSync(
      join(dir, "index.json"),
      `${JSON.stringify({ [RECONCILE_OPERATION]: 6 })}\n`,
    );
    const { written, index } = await writeAdoptCases(dir, cases).then(
      async (result) => ({
        ...result,
        written: JSON.parse(
          readFileSync(join(dir, ADOPT_FILE), "utf8"),
        ) as unknown[],
      }),
    );
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, ADOPT_FILE)).mode & 0o777, 0o600);
    assert.equal(written.length, cases.length);
    assert.deepEqual(index, {
      [RECONCILE_OPERATION]: 6,
      [`${RECONCILE_OPERATION}-adopt`]: cases.length,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** One build per file: progress cases replay real study and export a file. */
const PROGRESS_CASES = buildProgressAdoptCases();

const PROGRESS_IDS = [
  `${RECONCILE_OPERATION}-adopt-progress-one-observation`,
  `${RECONCILE_OPERATION}-adopt-progress-checkpoint-pass`,
];

/** A fresh live game, as the reference adoption test uses. */
function liveGame() {
  const roadmap = loadRoadmap(),
    g = createGame(7, roadmap);
  g.study.profile = "live";
  g.status = "playing";
  g.zombies = [];
  g.nextSpawn = Number.MAX_SAFE_INTEGER;
  return { roadmap, g };
}

/** The reply that accepts the descendant and carries its imported progress. */
function progressReply(
  payload: Parameters<typeof adoptionReply>[0],
  item: RoadmapCase,
): Record<string, unknown> {
  const expected = item.expected;
  assert.ok(expected, `${item.id} stores no expected progress`);
  return {
    ...adoptionReply(payload),
    definitions: expected.definitions,
    mappings: expected.mappings,
    completeScopes: expected.completeScopes,
    rationale:
      "Synthetic adoption of a descendant that carries imported study progress",
  };
}

/** Reconcile one progress case on a fresh live game, then adopt it. */
async function adoptProgress(id: string) {
  const cases = await PROGRESS_CASES,
    item = cases.find((entry) => entry.id === id);
  assert.ok(item, `${id} was not built`);
  assert.ok(item.expected, `${id} stores no expected progress`);
  const { roadmap, g } = liveGame();
  let edits = 0;
  await reconcileRoadmap(
    g,
    roadmap,
    item.payload.candidate,
    async (payload) => {
      assert.equal(payload.local, item.payload.local, `${id} local snapshot`);
      const answer = progressReply(payload, item as Required<typeof item>);
      edits = (answer.edits as unknown[]).length;
      return answer;
    },
  );
  const job = g.study.roadmapReconciliations?.at(-1);
  assert.equal(job?.state, "ready", `${id}: ${job?.error}`);
  assert.ok(edits > 0, `${id} reply carries no edits`);
  assert.deepEqual(job?.proposal?.definitions, item.expected.definitions);
  assert.deepEqual(job?.proposal?.mappings, item.expected.mappings);
  assert.deepEqual(job?.proposal?.completeScopes, item.expected.completeScopes);
  await adoptReconciledRoadmap(g, roadmap, job!.id);
  const l = g.study.learner;
  assert.ok(l, `${id} adopted game has no learner`);
  assert.deepEqual(
    [...l.verifiedScopes].sort(),
    [...item.expected.completeScopes].sort(),
    `${id} imported complete scopes`,
  );
  for (const definition of item.expected.definitions)
    assert.ok(
      l.scopes[definition.id],
      `${id} lost imported scope ${definition.id}`,
    );
  assert.equal(l.evidence.length, 0, `${id} kept pre-import evidence inline`);
  return { item, l };
}

test("the progress cases carry real study progress", async () => {
  const cases = await PROGRESS_CASES;
  assert.deepEqual(
    cases.map((item) => item.id),
    PROGRESS_IDS,
  );
  const observation = cases[0],
    pass = cases[1];
  for (const item of cases) assert.ok(item.expected, `${item.id} expected`);
  const observed = observation.expected!.mappings,
    observedScopes = observation.expected!.completeScopes;
  assert.equal(
    observed.length,
    1,
    "one study round must import exactly one evidence facet",
  );
  assert.equal(
    observedScopes.length,
    1,
    "one study round must complete exactly one scope",
  );
  assert.deepEqual(
    observed.map((m) => m.scopeId),
    observedScopes,
  );
  assert.ok(
    observed.every(
      (m) => m.outcome === "independent" && m.evidenceIds.length === 1,
    ),
    "an imported observation is not one independent evidence row",
  );
  assert.ok(
    observation.expected!.definitions.some((d) => d.id === observedScopes[0]),
    "the one-observation case recorded no scope definition for its observation",
  );
  assert.ok(
    !observedScopes.includes("PE:X09.1/D1"),
    "one study round must not reach the three-round checkpoint pass",
  );
  assert.ok(
    pass.expected!.completeScopes.includes("PE:X09.1/D1"),
    "three rounds must complete the checkpoint scope",
  );
  assert.equal(pass.expected!.completeScopes.length, 3);
  assert.equal(
    new Set(cases.map((item) => item.payload.candidate)).size,
    2,
    "the progress cases must carry distinct descendants",
  );
  for (const item of cases) {
    assert.equal(item.payload.local, loadRoadmap().raw, item.id);
    assert.notEqual(item.payload.local, item.payload.candidate, item.id);
  }
});

test("a lone independent observation is adopted as one imported scope", async () => {
  const { item, l } = await adoptProgress(PROGRESS_IDS[0]);
  const [scopeId] = item.expected!.completeScopes;
  const scope = item.expected!.definitions.find((d) => d.id === scopeId);
  assert.ok(scope, "the observation case imported no scope definition");
  assert.equal(
    l.cells[scope.objectiveId].states[scope.depth - 1],
    "P",
    "the imported independent observation is not a pass in the descendant",
  );
  assert.equal(
    l.cells[scope.objectiveId].facets[`D${scope.depth}:scope`]?.outcome,
    "independent",
    "the imported independent observation is missing",
  );
  assert.deepEqual(l.verifiedScopes, [scopeId]);
  assert.ok(
    !l.verifiedScopes.includes("PE:X09.1/D1"),
    "one observation must not import the three-round checkpoint pass",
  );
});

test("the three-round checkpoint pass is adopted as a real pass", async () => {
  const { item, l } = await adoptProgress(PROGRESS_IDS[1]);
  const scope = item.expected!.definitions.find(
    (d) => d.objectiveId === "PE:X09.1" && d.depth === 1,
  );
  assert.ok(scope, "the pass case imported no PE:X09.1/D1 scope");
  assert.equal(l.cells["PE:X09.1"].states[0], "P");
  assert.ok(l.verifiedScopes.includes("PE:X09.1/D1"));
  assert.equal(
    l.cells["PE:X09.1"].facets[`D${scope.depth}:scope`]?.outcome,
    "independent",
  );
  assert.ok(l.reviews["PE:X09.1/D1"], "the imported pass scheduled no review");
});

test("writeAdoptCases appends the progress cases after the administrative ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roadmap-adopt-progress-"));
  try {
    const { cases } = await writeAdoptCases(dir);
    assert.ok(
      cases.length > ADOPT_RECIPES.length,
      "the default adopt set holds no progress cases",
    );
    assert.deepEqual(
      cases.slice(0, ADOPT_RECIPES.length).map((item) => item.id),
      ADOPT_RECIPES.map(
        (recipe) => `${RECONCILE_OPERATION}-adopt-${recipe.id}`,
      ),
    );
    assert.deepEqual(
      cases.slice(ADOPT_RECIPES.length).map((item) => item.id),
      PROGRESS_IDS,
    );
    const written = JSON.parse(
      readFileSync(join(dir, ADOPT_FILE), "utf8"),
    ) as RoadmapCase[];
    assert.deepEqual(
      written.map((item) => item.id),
      cases.map((item) => item.id),
    );
    assert.deepEqual(
      written.filter((item) => item.expected).map((item) => item.id),
      PROGRESS_IDS,
    );
    for (const item of written.filter((entry) => entry.expected))
      assert.ok(item.expected!.mappings.length > 0, item.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
