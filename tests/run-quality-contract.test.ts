import assert from "node:assert/strict";
import test from "node:test";
import {
  parseQualityRequest,
  parseQualityReply,
  parseQualityPartialContent,
  mergeQualityEntries,
  qualitySurfaceGroups,
  qualityContentBatches,
  qualityReviewTargets,
  runQualityContentNoveltyErrors,
  type QualityContentBatchRequest,
  type QualityContentRevisionRequest,
  type QualityContentPlan,
  type QualityConcept,
} from "../src/run-quality-contract.mjs";
import {
  parseRunDesignRequest,
  parseRunDesignReply,
  runStructureFingerprint,
  runDesignFingerprint,
  RUN_DESIGN_GUIDANCE,
} from "../src/run-design-contract.mjs";
import {
  parseEnvironmentContent,
  environmentSurfaceFingerprint,
  type EnvironmentContent,
  type SurfaceSlot,
  type SurfaceContent,
} from "../src/environment-contract.mjs";
import { environmentStructureFixture } from "./helpers/environment-design";
import { qualityFixtureReply } from "./helpers/quality-design";

const structure = environmentStructureFixture();
const base = {
  version: 3 as const,
  designVersion: 3 as const,
  requestId: "design-quality-request",
  generationId: "design-quality-generation",
  seed: 42,
  recent: [],
  recentContent: [],
};
const chosen: QualityConcept = {
  id: "harbor-records",
  title: structure.title,
  premise: structure.premise,
  spatialIdentity: "A civic records hall wraps around a crowded arrival court.",
  castTension:
    "A clerk and former supervisor disagree about unfinished surveys.",
  visualLanguage: "Faded tide charts contrast with dark brass office fittings.",
  everydayLife:
    "Shared lunch orders and repaired umbrellas mark years of routine.",
  escapeMood: "A wary climb through familiar workplaces filled with strangers.",
  novelty:
    "Each department preserves a different practical relationship to the harbor.",
};
const surfaces: SurfaceSlot[] = Array.from({ length: 4 }, (_, i) => ({
  id: `f${i < 2 ? 0 : 1}:wall:quality-${i}`,
  floor: i < 2 ? 0 : 1,
  scope: "interior",
  role: "wall-poster",
  room: i < 2 ? 0 : null,
  owner: null,
  binding: {
    kind: "fixed",
    x: 4 + i,
    y: 4,
    z: 1.7,
    width: 0.6,
    height: 0.8,
    yaw: 0,
    pitch: 0,
  },
  context: "A distinct wall artifact in the captured fictional workplace.",
  maxTitle: 48,
  maxBody: 160,
  allowsArt: true,
}));
const context = {
  ...base,
  concept: chosen,
  rationale:
    "The chosen setting connects room purposes and personal evidence into one distinctive place.",
  structure,
  surfaces,
  structureFingerprint: runStructureFingerprint(structure),
  surfaceFingerprint: environmentSurfaceFingerprint(surfaces),
  builderVersion: "environment-v1",
};
const bodies = [
  "Mina left the repaired blue umbrella beside the parcel shelf for Tuesday's courier.",
  "Our lunch club finally agreed to retire the cracked soup bowl after eleven faithful winters.",
  "A folded invoice records three crates of survey pencils and an unresolved shipping charge.",
  "Pressed honeysuckle flowers lie between the pages of an unfinished desk calendar.",
];
const entries: SurfaceContent[] = surfaces.map((s, i) => ({
  surfaceId: s.id,
  layout: "text",
  title: [{ text: ["Courier", "Lunch club", "Invoice", "Honeysuckle"][i] }],
  body: [{ text: bodies[i] }],
  description: "",
  drawing: null,
}));
function content(current: SurfaceContent[] = []): EnvironmentContent {
  return {
    version: 1,
    surfaceFingerprint: context.surfaceFingerprint,
    fragments: [],
    entries: structuredClone(current),
  };
}
function plan(): QualityContentPlan {
  return {
    rooms: qualitySurfaceGroups(surfaces).map(({ id }) => ({
      id,
      story:
        "Long-serving occupants preserve different traces of their shared workplace.",
      ordinaryLife:
        "Meals and deliveries remain visible beside unfinished paperwork.",
      occupantEvidence:
        "The supplied coworkers leave mutually consistent dated references.",
      artDirection:
        "Simple specific sketches contrast with practical annotated diagrams.",
    })),
    fragments: [],
  };
}
function batch(
  index = 0,
  current: SurfaceContent[] = [],
): QualityContentBatchRequest {
  return {
    ...context,
    phase: "content-batch",
    plan: plan(),
    ...qualityContentBatches(surfaces)[index],
    content: content(current),
  };
}
function finding(target = `surface:${surfaces[0].id}`) {
  return {
    id: "occupant-evidence",
    priority: "minor" as const,
    target,
    problem: "The note does not identify who left the repaired object.",
    evidence:
      "The current passage describes an umbrella without connecting its owner to nearby work.",
    recommendation:
      "Tie the artifact to the clerk's courier duties without inventing a game reward.",
  };
}

test("quality request dispatch preserves exact phase shapes and independent concept selection", () => {
  const request = parseRunDesignRequest({ ...base, phase: "concepts" });
  assert.equal(request.version, 3);
  const synthetic = qualityFixtureReply(request, structure, []);
  const reply = parseRunDesignReply(synthetic, request);
  assert.ok("concepts" in reply);
  const selection = parseQualityRequest({
    ...base,
    phase: "selection",
    concepts: reply.concepts,
  });
  assert.deepEqual(
    parseQualityReply(
      {
        requestId: base.requestId,
        selectedId: reply.concepts[1].id,
        rationale:
          "Its distinct spatial rhythm and cast relationships offer the strongest fresh direction.",
      },
      selection,
    ),
    {
      requestId: base.requestId,
      selectedId: reply.concepts[1].id,
      rationale:
        "Its distinct spatial rhythm and cast relationships offer the strongest fresh direction.",
    },
  );
  assert.throws(
    () =>
      parseQualityReply(
        {
          requestId: base.requestId,
          selectedId: "invented-concept",
          rationale: "A choice outside the captured alternatives.",
        },
        selection,
      ),
    /captured concept/,
  );
  assert.throws(
    () =>
      parseQualityReply(
        { ...synthetic, requestId: "design-stale" },
        request as any,
      ),
    /requestId/,
  );
  assert.throws(
    () => parseQualityRequest({ ...base, phase: "concepts", content: {} }),
    /unknown fields/,
  );
  assert.throws(
    () =>
      parseQualityRequest({
        ...base,
        phase: "concepts",
        repair: { errors: ["x"] },
      }),
    /unknown fields/,
  );
  assert.match(RUN_DESIGN_GUIDANCE, /quality-first phase contract/);
});

test("renamed or lightly reworded concept identities cannot masquerade as three alternatives", () => {
  const request = parseQualityRequest({ ...base, phase: "concepts" });
  const good = qualityFixtureReply(request, structure, []);
  assert.ok(good.concepts);
  const duplicate = structuredClone(good);
  assert.ok(duplicate.concepts);
  duplicate.concepts[1] = {
    ...duplicate.concepts[0],
    id: "second-name",
    title: "Another title",
  };
  assert.throws(
    () => parseQualityReply(duplicate, request),
    /repeat their premise/,
  );
  const similar = structuredClone(good);
  assert.ok(similar.concepts);
  similar.concepts[1].spatialIdentity =
    similar.concepts[0].spatialIdentity.replace("Connected", "Adjacent");
  assert.throws(() => parseQualityReply(similar, request), /spatialIdentity/);
});

test("quality grouping covers each exact surface once in deterministic coherent chunks", () => {
  const many = Array.from({ length: 53 }, (_, i) => ({
    ...surfaces[0],
    id: `wall-${String(i).padStart(2, "0")}`,
  }));
  many.push({ ...surfaces[0], id: "shop-sign", scope: "exterior" });
  const batches = qualityContentBatches(many);
  assert.deepEqual(
    batches.map((b) => b.targets.length),
    [1, 24, 24, 5],
  );
  assert.equal(new Set(batches.flatMap((b) => b.targets)).size, many.length);
  assert.deepEqual(qualityContentBatches([...many].reverse()), batches);
  assert.throws(
    () => parseQualityRequest({ ...batch(), targets: [surfaces[0].id] }),
    /deterministic group/,
  );
  assert.throws(
    () => parseQualityRequest(batch(0, [entries[0]])),
    /already authored/,
  );
});

test("inventory fingerprints, plan coverage and review targets remain exact data boundaries", () => {
  const review = parseQualityRequest({ ...context, phase: "structure-review" });
  assert.ok(
    qualityReviewTargets(review).includes(
      `survivor:${structure.roster[0].name}`,
    ),
  );
  assert.throws(
    () =>
      parseQualityRequest({
        ...context,
        phase: "content-plan",
        structureFingerprint: "0".repeat(16),
      }),
    /structure fingerprint/,
  );
  assert.throws(
    () =>
      parseQualityRequest({
        ...context,
        phase: "content-plan",
        surfaces: [...surfaces].reverse(),
      }),
    /surface fingerprint/,
  );
  const request = parseQualityRequest({ ...context, phase: "content-plan" });
  assert.deepEqual(
    parseQualityReply({ requestId: base.requestId, plan: plan() }, request),
    { requestId: base.requestId, plan: plan() },
  );
  const missing = plan();
  missing.rooms.pop();
  assert.throws(
    () =>
      parseQualityReply({ requestId: base.requestId, plan: missing }, request),
    /plan.rooms/,
  );
  assert.throws(
    () =>
      parseQualityReply(
        { requestId: base.requestId, findings: [finding("surface:unknown")] },
        review,
      ),
    /exact review target/,
  );
  assert.throws(
    () =>
      parseQualityRequest({
        ...context,
        phase: "content-review",
        plan: plan(),
        content: content(entries.slice(0, 2)),
      }),
    /entries needs/,
    "a partial manifest cannot bypass complete editorial review",
  );
  assert.throws(
    () =>
      parseQualityRequest({
        ...context,
        phase: "content-plan",
        rationale: "q".repeat(1_500_000),
      }),
    /request exceeds/,
  );
  const final = parseQualityRequest({
    ...context,
    phase: "content-review",
    plan: plan(),
    content: content(entries),
  });
  assert.throws(
    () =>
      parseQualityReply(
        { requestId: base.requestId, findings: [finding("room:0:0")] },
        final,
      ),
    /exact review target/,
  );
  assert.throws(
    () =>
      parseQualityReply(
        { requestId: base.requestId, findings: [], score: 100 },
        final,
      ),
    /unknown fields/,
  );
});

test("strict partial content permits only unwritten entries and unwritten fragment members", () => {
  const fragment = {
    id: "shared-brand",
    kind: "branding" as const,
    text: "Harbor survey service",
    reason: "The same department mark labels its paired notices.",
    surfaces: [surfaces[0].id, surfaces[1].id],
  };
  const first = { ...entries[0], title: [{ fragmentId: fragment.id }] };
  const partial = { ...content([first]), fragments: [fragment] };
  assert.deepEqual(
    parseQualityPartialContent(partial, structure, surfaces),
    partial,
  );
  assert.throws(
    () => parseEnvironmentContent(partial, structure, surfaces),
    /entries needs/,
  );
  assert.throws(
    () =>
      parseQualityPartialContent(
        { ...partial, entries: [entries[0]] },
        structure,
        surfaces,
      ),
    /unused members/,
  );
  assert.throws(
    () =>
      parseQualityPartialContent(
        { ...partial, entries: [...partial.entries, partial.entries[0]] },
        structure,
        surfaces,
      ),
    /duplicated surface/,
  );
  assert.throws(
    () =>
      parseQualityPartialContent(
        { ...partial, entries: [{ ...first, surfaceId: "unbound" }] },
        structure,
        surfaces,
      ),
    /unknown/,
  );
  assert.throws(
    () =>
      parseQualityPartialContent(
        {
          ...partial,
          fragments: [{ ...fragment, surfaces: [surfaces[0].id, "unbound"] }],
        },
        structure,
        surfaces,
      ),
    /inventory surface/,
  );
  const tiny = surfaces.map((s, i) =>
    i === 1 ? { ...s, maxTitle: 0, maxBody: 0 } : s,
  );
  assert.throws(
    () =>
      parseQualityPartialContent(
        { ...partial, surfaceFingerprint: environmentSurfaceFingerprint(tiny) },
        structure,
        tiny,
      ),
    /cannot fit/,
  );
});

test("incremental writes retain global duplicate, mechanics, drawing and readable-budget checks", () => {
  const request = parseQualityRequest(batch()) as QualityContentBatchRequest;
  const reply = parseQualityReply(
    { requestId: base.requestId, entries: [entries[1], entries[0]] },
    request,
  );
  const first = mergeQualityEntries(request, reply.entries);
  assert.deepEqual(
    first.entries,
    entries.slice(0, 2),
    "inventory order is canonical even when reply order differs",
  );
  const next = parseQualityRequest(
    batch(1, first.entries),
  ) as QualityContentBatchRequest;
  assert.throws(
    () =>
      parseQualityReply(
        {
          requestId: base.requestId,
          entries: [{ ...entries[2], body: entries[0].body }, entries[3]],
        },
        next,
      ),
    /Distinct writing/,
  );
  assert.throws(
    () =>
      parseQualityReply(
        {
          requestId: base.requestId,
          entries: [
            {
              ...entries[2],
              body: [{ text: "Climb the stairs without clearance." }],
            },
            entries[3],
          ],
        },
        next,
      ),
    /gameplay instruction/,
  );
  assert.throws(
    () =>
      parseQualityReply(
        {
          requestId: base.requestId,
          entries: [
            { ...entries[2], body: [{ text: "q".repeat(161) }] },
            entries[3],
          ],
        },
        next,
      ),
    /readable budget/,
  );
  assert.throws(
    () =>
      parseQualityReply(
        {
          requestId: base.requestId,
          entries: [
            { ...entries[2], body: [{ text: "q".repeat(161) }] },
            entries[3],
          ],
        },
        next,
      ),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return [
        `surface ${entries[2].surfaceId}`,
        "has 161 characters",
        "readable budget of 160",
      ].every((part) => message.includes(part));
    },
    "the budget error names the surface, the actual length and the limit",
  );
  assert.throws(
    () =>
      parseQualityReply(
        { requestId: base.requestId, entries: [entries[0], entries[3]] },
        next,
      ),
    /exactly its requested targets/,
  );
  const full = mergeQualityEntries(next, [entries[2], entries[3]]);
  assert.deepEqual(
    parseEnvironmentContent(full, structure, surfaces),
    content(entries),
  );
});

test("targeted revisions preserve untouched entries, complete content and immutable fragments", () => {
  const request = parseQualityRequest({
    ...context,
    phase: "content-revision",
    plan: plan(),
    content: content(entries),
    findings: [finding()],
  }) as QualityContentRevisionRequest;
  const changed = {
    ...entries[0],
    body: [
      {
        text: "The courier's green satchel still holds a carefully folded bicycle repair receipt.",
      },
    ],
  };
  const merged = mergeQualityEntries(request, [changed]);
  assert.deepEqual(merged.entries[0], changed);
  assert.deepEqual(merged.entries.slice(1), entries.slice(1));
  assert.throws(
    () => mergeQualityEntries(request, [changed, entries[1]]),
    /exactly identified/,
  );
  assert.throws(
    () => mergeQualityEntries(request, [entries[1]]),
    /exactly identified/,
  );
  assert.deepEqual(
    mergeQualityEntries(request, [entries[0]]),
    request.content,
    "controller detects no-op without treating valid data as malformed",
  );
  const global = parseQualityRequest({
    ...request,
    findings: [finding("run")],
  }) as QualityContentRevisionRequest;
  assert.deepEqual(mergeQualityEntries(global, [changed]).entries[0], changed);
  assert.throws(
    () =>
      parseQualityReply(
        { requestId: base.requestId, entries: [changed], fragments: [] },
        request,
      ),
    /unknown fields/,
  );
});

test("new quality flow rejects recent normalized prose and exact artwork while respecting intentional branding", () => {
  const summary = {
    fingerprint: "0123456789abcdef",
    phrases: [bodies[0]],
    art: [] as string[],
    artDescriptions: [] as string[],
  };
  assert.match(
    runQualityContentNoveltyErrors(content(entries), [summary]).join(" "),
    /surface:.*body repeats recent/,
  );
  const renamed = content(entries);
  renamed.entries[0].title = [{ text: "Different heading" }];
  renamed.entries[0].body = [
    { text: bodies[0].replace("Tuesday", "Wednesday") },
  ];
  assert.ok(runQualityContentNoveltyErrors(renamed, [summary]).length > 0);
  const short = { ...summary, phrases: ["Lunch club"] };
  assert.deepEqual(
    runQualityContentNoveltyErrors(content(entries), [short]),
    [],
  );
  const drawing = {
    version: 1 as const,
    background: "transparent",
    primitives: [
      {
        kind: "ellipse" as const,
        x: 0.2,
        y: 0.3,
        w: 0.4,
        h: 0.3,
        rotation: 0,
        fill: "#336699",
        stroke: null,
        width: 0.02,
        opacity: 1,
      },
    ],
  };
  const illustrated = content(entries);
  illustrated.entries[0] = {
    ...illustrated.entries[0],
    layout: "mixed",
    drawing,
    description:
      "A blue oval depicts an ink puddle beside the archivist's stamped delivery ledger.",
  };
  const artSummary = {
    ...summary,
    phrases: [],
    art: [runDesignFingerprint(drawing)],
    artDescriptions: [illustrated.entries[0].description + " [1 ellipse]"],
  };
  assert.equal(
    runQualityContentNoveltyErrors(illustrated, [artSummary]).length,
    2,
  );
  illustrated.fragments = [
    {
      id: "seal",
      kind: "branding",
      text: "Harbor archive",
      reason: "An intentionally repeated institutional seal.",
      surfaces: [surfaces[0].id, surfaces[1].id],
    },
  ];
  illustrated.entries[0].title = [{ fragmentId: "seal" }];
  assert.deepEqual(
    runQualityContentNoveltyErrors(illustrated, [artSummary]),
    [],
  );
  const request = { ...batch(), recentContent: [summary] };
  assert.throws(
    () => mergeQualityEntries(request, entries.slice(0, 2)),
    /repeats recent/,
  );
});

test("quality authoring rejects repeated drawings on later surfaces unless shared art is explicit", () => {
  const drawing = {
    version: 1 as const,
    background: "transparent",
    primitives: [
      {
        kind: "rect" as const,
        x: 0.12,
        y: 0.18,
        w: 0.76,
        h: 0.64,
        rotation: 0,
        fill: "#336699",
        stroke: null,
        width: 0.02,
        opacity: 1,
      },
    ],
  };
  const repeated = content(entries);
  for (const i of [0, 1])
    repeated.entries[i] = {
      ...repeated.entries[i],
      layout: "mixed",
      drawing: structuredClone(drawing),
      description: [
        "A blue rectangular map of local docks.",
        "A cobalt block marks the storage aisle.",
      ][i],
    };
  repeated.entries[1].drawing = {
    primitives: structuredClone(drawing.primitives),
    background: drawing.background,
    version: drawing.version,
  };
  // The historical save parser remains compatible; the new guard belongs to
  // the quality authoring flow that receives the complete accepted prefix.
  assert.doesNotThrow(() =>
    parseEnvironmentContent(repeated, structure, surfaces),
  );
  const errors = runQualityContentNoveltyErrors(repeated, []);
  assert.equal(errors.length, 1);
  assert.match(
    errors[0],
    new RegExp(
      `^surface:${surfaces[1].id} repeats artwork from surface:${surfaces[0].id} within this run`,
    ),
  );
  assert.throws(
    () => mergeQualityEntries(batch(), repeated.entries.slice(0, 2)),
    /repeats artwork.*within this run/,
  );
  const acceptedFirstBatch = mergeQualityEntries(batch(), [
    repeated.entries[0],
    entries[1],
  ]);
  const laterArt: SurfaceContent = {
    ...entries[2],
    layout: "mixed",
    drawing: structuredClone(drawing),
    description: "A blue block indexes harbor freight.",
  };
  assert.throws(
    () =>
      mergeQualityEntries(batch(1, acceptedFirstBatch.entries), [
        laterArt,
        entries[3],
      ]),
    new RegExp(`surface:${surfaces[2].id} repeats artwork.*within this run`),
  );

  for (const kind of ["branding", "clue"] as const) {
    const shared = structuredClone(repeated);
    shared.fragments = [
      {
        id: "seal",
        kind,
        text: "Harbor archive seal",
        reason: "Both posters show the same institutional mark.",
        surfaces: [surfaces[0].id, surfaces[1].id],
      },
    ];
    for (const i of [0, 1]) {
      shared.entries[i].title = [{ fragmentId: "seal" }];
      shared.entries[i].description =
        "The same cobalt seal marks both posters.";
    }
    assert.doesNotThrow(() =>
      parseEnvironmentContent(shared, structure, surfaces),
    );
    assert.deepEqual(runQualityContentNoveltyErrors(shared, []), []);
  }

  const oneSided = structuredClone(repeated);
  oneSided.fragments = [
    {
      id: "seal",
      kind: "branding",
      text: "Harbor archive seal",
      reason: "Both posters belong to the same institution.",
      surfaces: [surfaces[0].id, surfaces[1].id],
    },
  ];
  oneSided.entries[0].title = [{ fragmentId: "seal" }];
  assert.match(
    runQualityContentNoveltyErrors(oneSided, [])[0],
    /repeats artwork.*within this run/,
    "declared membership alone does not permit reuse without both references",
  );

  const direction = structuredClone(repeated);
  direction.fragments = [
    {
      id: "route",
      kind: "direction",
      fact: "rooftop-extraction",
      reason: "Both posters carry the approved extraction fact.",
      surfaces: [surfaces[0].id, surfaces[1].id],
    },
  ];
  for (const i of [0, 1])
    direction.entries[i].title = [{ fragmentId: "route" }];
  assert.doesNotThrow(() =>
    parseEnvironmentContent(direction, structure, surfaces),
  );
  assert.match(
    runQualityContentNoveltyErrors(direction, [])[0],
    /repeats artwork.*within this run/,
    "a direction fact does not license repeated artwork",
  );
});

test("partial authoring retains global drawing complexity limits before completion", () => {
  const many = Array.from({ length: 86 }, (_, i) => ({
    ...surfaces[0],
    id: `drawing-${i}`,
  }));
  const drawn: SurfaceContent[] = many.map((s, i) => ({
    surfaceId: s.id,
    layout: "art",
    title: [],
    body: [],
    description: `Ink study ${i}`,
    drawing: {
      version: 1,
      background: "transparent",
      primitives: Array.from({ length: 24 }, () => ({
        kind: "rect",
        x: 0,
        y: 0,
        w: 0.02,
        h: 0.02,
        rotation: 0,
        fill: "#123456",
        stroke: null,
        width: 0.002,
        opacity: 1,
      })),
    },
  }));
  assert.throws(
    () =>
      parseQualityPartialContent(
        {
          ...content(drawn),
          surfaceFingerprint: environmentSurfaceFingerprint(many),
        },
        structure,
        many,
      ),
    /drawing complexity/,
  );
});

test("a place brief is validated and carried by every concept request", () => {
  const place = {
    name: "Deep-sea research lab",
    brief:
      "A pressurised lab standing on the trench floor, tiled in cold ceramic.",
  };
  const parsed = parseQualityRequest({ ...base, phase: "concepts", place });
  assert.deepEqual(parsed.place, place);
  assert.match(
    RUN_DESIGN_GUIDANCE,
    /When the request carries place, every concept must be that exact place/,
  );
  // A request without a place keeps its historical shape: no empty field.
  assert.equal(
    "place" in parseQualityRequest({ ...base, phase: "concepts" }),
    false,
  );
});

test("an over-long place brief is rejected", () => {
  assert.throws(
    () =>
      parseQualityRequest({
        ...base,
        phase: "concepts",
        place: { name: "Orbital rocket", brief: "x".repeat(601) },
      }),
    /place\.brief/,
  );
});

test("a place accepts no unknown keys", () => {
  assert.throws(
    () =>
      parseQualityRequest({
        ...base,
        phase: "concepts",
        place: {
          name: "Orbital rocket",
          brief: "The cramped interior of a sounding rocket.",
          kind: "vehicle",
        },
      }),
    /place has missing or unknown fields/,
  );
});
