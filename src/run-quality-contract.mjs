// Quality-first authoring protocol. Every phase is bounded fictional data;
// completed saves continue to use the unchanged complete RunDesignV3 schema.
import {
  parseRunDesignRequest,
  parseRunStructure,
  runStructureFingerprint,
  runDesignFingerprint,
} from "./run-design-contract.mjs";
import {
  parseEnvironmentContent,
  parseEnvironmentPartialContent,
  parseEnvironmentSurfaces,
  parseEnvironmentSummaries,
  environmentSurfaceFingerprint,
  environmentTextIsNearCopy,
  normalizeEnvironmentText,
} from "./environment-contract.mjs";

const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const fail = (ok, message) => {
  if (!ok) throw Error(`Run quality: ${message}`);
};
function object(v, keys, p) {
  fail(
    record(v) &&
      Object.keys(v).every((k) => keys.includes(k)) &&
      keys.every((k) => Object.hasOwn(v, k)),
    `${p} has missing or unknown fields`,
  );
}
function text(v, max, p) {
  fail(
    typeof v === "string" &&
      v.trim().length > 0 &&
      v.length <= max &&
      !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(v),
    `${p} needs 1–${max} printable characters`,
  );
}
function array(v, min, max, p, check) {
  fail(
    Array.isArray(v) && v.length >= min && v.length <= max,
    `${p} needs ${min}–${max} entries`,
  );
  v.forEach((x, i) => check(x, `${p}[${i}]`));
}
function bounded(v, max, p) {
  fail(
    new TextEncoder().encode(JSON.stringify(v)).length <= max,
    `${p} exceeds ${max} bytes`,
  );
}
function slug(v, max, p) {
  text(v, max, p);
  fail(
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(v),
    `${p} needs a lowercase slug`,
  );
}
const conceptFields = [
  "id",
  "title",
  "premise",
  "spatialIdentity",
  "castTension",
  "visualLanguage",
  "everydayLife",
  "escapeMood",
  "novelty",
];
function concept(v, p) {
  object(v, conceptFields, p);
  slug(v.id, 40, `${p}.id`);
  for (const k of conceptFields.filter((k) => k !== "id"))
    text(v[k], k === "title" ? 64 : 240, `${p}.${k}`);
}
function conceptIdentityCopy(left, right) {
  if (environmentTextIsNearCopy(left, right)) return true;
  const a = new Set(normalizeEnvironmentText(left).split(" "));
  const b = new Set(normalizeEnvironmentText(right).split(" "));
  if (Math.min(a.size, b.size) < 6) return false;
  const shared = [...a].filter((word) => b.has(word)).length;
  return shared / (a.size + b.size - shared) >= 0.72;
}
function concepts(v) {
  array(v, 3, 3, "concepts", concept);
  fail(new Set(v.map((c) => c.id)).size === 3, "concept IDs are duplicated");
  for (let i = 0; i < v.length; i++)
    for (let j = 0; j < i; j++) {
      for (const field of ["title", "premise", "spatialIdentity"])
        fail(
          !conceptIdentityCopy(v[i][field], v[j][field]),
          `concepts ${v[j].id} and ${v[i].id} repeat their ${field}; propose substantively different identities`,
        );
      const differences = [
        "castTension",
        "visualLanguage",
        "everydayLife",
        "escapeMood",
      ].filter((k) => !environmentTextIsNearCopy(v[i][k], v[j][k]));
      fail(
        differences.length >= 3,
        `concepts ${v[j].id} and ${v[i].id} need distinct cast, visual and ordinary-life directions`,
      );
    }
}

export function qualitySurfaceGroups(surfaces) {
  const groups = new Map();
  for (const s of surfaces) {
    const id =
      s.scope === "exterior"
        ? "exterior"
        : s.room === null
          ? `f${s.floor}-common`
          : `f${s.floor}-room${s.room}`;
    const members = groups.get(id) ?? [];
    members.push(s.id);
    groups.set(id, members);
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([id, members]) => ({
      id,
      surfaceIds: [...members].sort((a, b) => a.localeCompare(b, "en")),
    }));
}
export function qualityContentBatches(surfaces) {
  return qualitySurfaceGroups(surfaces).flatMap(({ id, surfaceIds }) => {
    const batches = [];
    for (let i = 0; i < surfaceIds.length; i += 24)
      batches.push({ groupId: id, targets: surfaceIds.slice(i, i + 24) });
    return batches;
  });
}
export function parseQualityPartialContent(value, structure, surfaces) {
  return parseEnvironmentPartialContent(value, structure, surfaces);
}
export function qualityReviewTargets(request) {
  const targets = ["run"];
  if (request.phase === "structure-review") {
    for (let f = 0; f < request.structure.floors.length; f++) {
      targets.push(`floor:${f}`);
      for (let r = 0; r < 4; r++) targets.push(`room:${f}:${r}`);
    }
    for (const person of request.structure.roster)
      targets.push(`survivor:${person.name}`);
  }
  for (const slot of request.surfaces ?? []) targets.push(`surface:${slot.id}`);
  return targets;
}
function findings(value, request) {
  const allowed = new Set(qualityReviewTargets(request)),
    ids = new Set(),
    passages = new Set();
  array(value, 0, 12, "findings", (f, p) => {
    object(
      f,
      ["id", "priority", "target", "problem", "evidence", "recommendation"],
      p,
    );
    slug(f.id, 40, `${p}.id`);
    fail(!ids.has(f.id), `${p}.id is duplicated`);
    ids.add(f.id);
    fail(["major", "minor"].includes(f.priority), `${p}.priority is invalid`);
    fail(allowed.has(f.target), `${p}.target is not an exact review target`);
    for (const key of ["problem", "evidence", "recommendation"])
      text(f[key], 300, `${p}.${key}`);
    const passage = `${f.target}/${normalizeEnvironmentText(f.problem)}`;
    fail(!passages.has(passage), `${p} repeats a finding`);
    passages.add(passage);
  });
}
function contentPlan(v, request) {
  object(v, ["rooms", "fragments"], "plan");
  const groups = new Set(
      qualitySurfaceGroups(request.surfaces).map((g) => g.id),
    ),
    seen = new Set();
  array(v.rooms, groups.size, groups.size, "plan.rooms", (r, p) => {
    object(
      r,
      ["id", "story", "ordinaryLife", "occupantEvidence", "artDirection"],
      p,
    );
    fail(
      groups.has(r.id) && !seen.has(r.id),
      `${p}.id is unknown or duplicated`,
    );
    seen.add(r.id);
    for (const k of [
      "story",
      "ordinaryLife",
      "occupantEvidence",
      "artDirection",
    ])
      text(r[k], 400, `${p}.${k}`);
  });
  parseQualityPartialContent(
    {
      version: 1,
      surfaceFingerprint: request.surfaceFingerprint,
      fragments: v.fragments,
      entries: [],
    },
    request.structure,
    request.surfaces,
  );
}
const phases = [
  "concepts",
  "selection",
  "structure",
  "structure-review",
  "content-plan",
  "content-batch",
  "content-review",
  "content-revision",
];
const common = [
  "version",
  "designVersion",
  "phase",
  "requestId",
  "generationId",
  "seed",
  "recent",
  "recentContent",
];
const context = [
  "concept",
  "rationale",
  "structure",
  "surfaces",
  "structureFingerprint",
  "surfaceFingerprint",
  "builderVersion",
];
export function parseQualityRequest(v) {
  bounded(v, 1500000, "request");
  fail(
    v?.version === 3 && v.designVersion === 3 && phases.includes(v.phase),
    "unsupported request version or phase",
  );
  const extras =
    v.phase === "concepts"
      ? []
      : v.phase === "selection"
        ? ["concepts"]
        : v.phase === "structure"
          ? ["concept", "rationale"]
          : [
              ...context,
              ...([
                "content-batch",
                "content-review",
                "content-revision",
              ].includes(v.phase)
                ? ["plan", "content"]
                : []),
              ...(v.phase === "content-batch" ? ["groupId", "targets"] : []),
              ...(v.phase === "content-revision" ? ["findings"] : []),
            ];
  const canRepair = ["structure", "content-batch", "content-revision"].includes(
    v.phase,
  );
  object(
    v,
    [
      ...common,
      ...extras,
      // `place` and `repair` are optional: absent they keep the old shape.
      ...(Object.hasOwn(v, "place") ? ["place"] : []),
      ...(canRepair && Object.hasOwn(v, "repair") ? ["repair"] : []),
    ],
    "request",
  );
  parseRunDesignRequest({
    version: 1,
    requestId: v.requestId,
    generationId: v.generationId,
    seed: v.seed,
    recent: v.recent,
  });
  parseEnvironmentSummaries(v.recentContent);
  if (Object.hasOwn(v, "place")) {
    object(v.place, ["name", "brief"], "place");
    text(v.place.name, 60, "place.name");
    text(v.place.brief, 600, "place.brief");
  }
  if (v.phase === "selection") concepts(v.concepts);
  if (!["concepts", "selection"].includes(v.phase)) {
    concept(v.concept, "concept");
    text(v.rationale, 600, "rationale");
  }
  if (context.every((k) => Object.hasOwn(v, k))) {
    const structure = parseRunStructure(v.structure),
      surfaces = parseEnvironmentSurfaces(
        v.surfaces,
        structure.roster.map((a) => a.name),
      );
    fail(
      v.structureFingerprint === runStructureFingerprint(structure),
      "structure fingerprint mismatch",
    );
    fail(
      v.surfaceFingerprint === environmentSurfaceFingerprint(surfaces),
      "surface fingerprint mismatch",
    );
    text(v.builderVersion, 64, "builderVersion");
  }
  if (
    ["content-batch", "content-review", "content-revision"].includes(v.phase)
  ) {
    contentPlan(v.plan, v);
    const checked =
      v.phase === "content-batch"
        ? parseQualityPartialContent(v.content, v.structure, v.surfaces)
        : parseEnvironmentContent(v.content, v.structure, v.surfaces);
    fail(
      JSON.stringify(checked.fragments) === JSON.stringify(v.plan.fragments),
      "content changed the accepted plan fragments",
    );
  }
  if (v.phase === "content-batch") {
    fail(
      qualityContentBatches(v.surfaces).some(
        (b) =>
          b.groupId === v.groupId &&
          JSON.stringify(b.targets) === JSON.stringify(v.targets),
      ),
      "batch targets must be one exact deterministic group/chunk",
    );
    const accepted = new Set(v.content.entries.map((e) => e.surfaceId));
    fail(
      v.targets.every((id) => !accepted.has(id)),
      "batch targets include already authored entries",
    );
  }
  if (v.phase === "content-revision") {
    findings(v.findings, v);
    fail(v.findings.length > 0, "revision needs actionable findings");
  }
  if (v.repair) {
    object(
      v.repair,
      v.phase === "structure" ? ["candidate", "errors"] : ["errors"],
      "repair",
    );
    if (v.phase === "structure") parseRunStructure(v.repair.candidate);
    array(v.repair.errors, 1, 20, "repair.errors", (e, p) => text(e, 400, p));
  }
  return clone(v);
}
export function runQualityContentNoveltyErrors(content, recentContent) {
  const recent = parseEnvironmentSummaries(recentContent),
    errors = [],
    inRunArt = new Map(),
    shareableArt = new Map(
      content.fragments
        .filter((f) => f.kind === "branding" || f.kind === "clue")
        .map((f) => [f.id, f]),
    );
  // Compare the drawing data itself. A hash or a changed object key order must
  // not turn different art into a match or conceal identical art.
  const drawingData = (drawing) =>
    JSON.stringify(drawing, (_key, value) =>
      record(value)
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, value[key]]),
          )
        : value,
    );
  const sharedArtFragments = (entry) =>
    new Set(
      [...entry.title, ...entry.body].flatMap((part) => {
        const fragment = shareableArt.get(part.fragmentId);
        return fragment?.surfaces.includes(entry.surfaceId)
          ? [fragment.id]
          : [];
      }),
    );
  const phrases = recent
    .flatMap((s) => s.phrases)
    .filter((s) => normalizeEnvironmentText(s).length >= 12);
  const descriptions = recent
    .flatMap((s) => s.artDescriptions ?? [])
    .map((s) => s.replace(/\s*\[[^\]]*\]\s*$/u, ""));
  const art = new Set(recent.flatMap((s) => s.art));
  for (const e of content.entries) {
    const own = (parts) =>
      parts
        .filter((p) => "text" in p)
        .map((p) => p.text)
        .join("");
    const branded = [...e.title, ...e.body].some(
      (p) =>
        "fragmentId" in p &&
        content.fragments.some(
          (f) =>
            f.id === p.fragmentId &&
            f.kind === "branding" &&
            f.surfaces.includes(e.surfaceId),
        ),
    );
    for (const [field, value] of [
      ["title", own(e.title)],
      ["body", own(e.body)],
      ...(e.drawing && !branded ? [["description", e.description]] : []),
    ]) {
      if (normalizeEnvironmentText(value).length < 12) continue;
      const history =
        field === "description" ? [...phrases, ...descriptions] : phrases;
      if (
        history.some(
          (p) =>
            environmentTextIsNearCopy(value, p) ||
            (normalizeEnvironmentText(p).length >= 80 &&
              normalizeEnvironmentText(value).startsWith(
                normalizeEnvironmentText(p),
              )),
        )
      )
        errors.push(
          `surface:${e.surfaceId} ${field} repeats recent-run writing; create a new specific passage or subject, not a renamed or lightly reworded copy.`,
        );
    }
    if (e.drawing && !branded && art.has(runDesignFingerprint(e.drawing)))
      errors.push(
        `surface:${e.surfaceId} repeats recent-run artwork; choose a different subject and composition.`,
      );
    if (e.drawing) {
      const signature = drawingData(e.drawing),
        shared = sharedArtFragments(e),
        previous = inRunArt.get(signature) ?? [],
        conflict = previous.find(
          (earlier) => ![...shared].some((id) => earlier.shared.has(id)),
        );
      if (conflict)
        errors.push(
          `surface:${e.surfaceId} repeats artwork from surface:${conflict.id} within this run; make a distinct drawing or reference the same declared branding/clue fragment on both surfaces.`,
        );
      previous.push({ id: e.surfaceId, shared });
      inRunArt.set(signature, previous);
    }
    if (errors.length >= 20) break;
  }
  return errors.slice(0, 20);
}
export function mergeQualityEntries(request, entries) {
  fail(
    ["content-batch", "content-revision"].includes(request.phase),
    "entry merge needs a batch or revision request",
  );
  array(entries, 1, 24, "entries", (e, p) =>
    fail(
      record(e) && typeof e.surfaceId === "string",
      `${p} needs an exact surface ID`,
    ),
  );
  const ids = entries.map((e) => e.surfaceId),
    known = new Set(request.surfaces.map((s) => s.id));
  fail(
    new Set(ids).size === ids.length && ids.every((id) => known.has(id)),
    "replacement surface IDs are unknown or duplicated",
  );
  if (request.phase === "content-batch")
    fail(
      ids.length === request.targets.length &&
        request.targets.every((id) => ids.includes(id)),
      "batch reply must contain exactly its requested targets",
    );
  else {
    const required = [
      ...new Set(
        request.findings
          .filter((f) => f.target.startsWith("surface:"))
          .map((f) => f.target.slice(8)),
      ),
    ];
    const global = request.findings.some((f) => f.target === "run");
    fail(
      required.every((id) => ids.includes(id)) &&
        (global || ids.every((id) => required.includes(id))),
      "revision must replace exactly identified surface targets unless a run finding permits a broader patch",
    );
  }
  const replaced = new Map(entries.map((e) => [e.surfaceId, e]));
  const combined =
    request.phase === "content-batch"
      ? [...request.content.entries, ...entries]
      : request.content.entries.map((e) => replaced.get(e.surfaceId) ?? e);
  const order = new Map(request.surfaces.map((slot, i) => [slot.id, i]));
  combined.sort((a, b) => order.get(a.surfaceId) - order.get(b.surfaceId));
  const merged = { ...request.content, entries: combined };
  const checked =
    request.phase === "content-batch"
      ? parseQualityPartialContent(merged, request.structure, request.surfaces)
      : parseEnvironmentContent(merged, request.structure, request.surfaces);
  const errors = runQualityContentNoveltyErrors(checked, request.recentContent);
  fail(!errors.length, errors.join("; "));
  return checked;
}
export function parseQualityReply(value, request) {
  bounded(value, 600000, "reply");
  fail(
    request.version === 3 && phases.includes(request.phase),
    "reply needs a quality request",
  );
  const fields =
    request.phase === "concepts"
      ? ["concepts"]
      : request.phase === "selection"
        ? ["selectedId", "rationale"]
        : request.phase === "structure"
          ? ["structure"]
          : request.phase.endsWith("review")
            ? ["findings"]
            : request.phase === "content-plan"
              ? ["plan"]
              : ["entries"];
  object(value, ["requestId", ...fields], "reply");
  fail(value.requestId === request.requestId, "reply requestId does not match");
  if (request.phase === "concepts") concepts(value.concepts);
  else if (request.phase === "selection") {
    fail(
      request.concepts.some((c) => c.id === value.selectedId),
      "selectedId is not a captured concept",
    );
    text(value.rationale, 600, "rationale");
  } else if (request.phase === "structure") parseRunStructure(value.structure);
  else if (request.phase.endsWith("review")) findings(value.findings, request);
  else if (request.phase === "content-plan") contentPlan(value.plan, request);
  else mergeQualityEntries(request, value.entries);
  return clone(value);
}

// A hoisted pure function avoids a temporal-dead-zone when either contract is
// the first module imported. Structural parsers are shared through that cycle.
export function qualityGuidance() {
  return `For request.version:3/designVersion:3, use the quality-first phase contract below. Quality and meaningful uniqueness take priority over generation speed or the number of model turns. Spend focused attention on choices, evidence and revision; do not inflate runtime assets or invent mechanics. The engine supplies real geometry validation and captured immutable state, and you must not claim to have run checks you did not perform. Read every captured payload chunk. Continue only through the existing bound continuation for this generation/chat; stop if it returns waiting. Never upgrade a retained request.version:1 or 2.
All replies contain exactly the captured requestId and the fields for their phase. concepts: return concepts, exactly3 {id:lowercase slug<=40,title<=64,premise<=240,spatialIdentity<=240,castTension<=240,visualLanguage<=240,everydayLife<=240,escapeMood<=240,novelty<=240}. Propose genuinely different spatial experiences, institutions, ordinary routines, relationships and visual motifs, using recent summaries to avoid repetition. Each concept is set in one specific kind of building (spatialIdentity names it, real or fantastical, e.g. a lighthouse, a bakery, a wizard's library, a deep-sea lab, a bathhouse, a circus); the structure must then build that place, inside and out. When the request carries place, every concept must be that exact place (its spatialIdentity names it), consistent with place.brief, and the structure must build it inside and out; concepts may still differ in routine, cast and mood. selection: return {selectedId,rationale<=600}; independently compare the captured alternatives and select the strongest coherent, distinctive direction rather than automatically choosing the first.
structure: return {structure:RunStructureV3}, using the selected concept and rationale and the version3 structural schema below; include setting so the venue, form, rooms, furniture, finishes, silhouette, exterior and the drawn outdoors (setting.outdoors: the real ground, terrain, water, walls, neighbouring structures, enclosure and backdrop around this particular place, never a default city unless the premise is in a city) match the premise's building (form:open for an open-air place such as an open-air market, plaza, campsite or harbour quay, which is one ground-level floor; form:enclosed for a building, which keeps four); honor repair.candidate/errors if present. The structure's title, premise and opening are shown on the black opening card before play: set up only the place, the people and an ordinary-seeming tension, and never name, hint at or foreshadow the catastrophe (no zombies, the dead or undead, corpses, infection, outbreak, plague, quarantine, hordes or anything rising or coming back); new designs that break this are sent back for repair. structure-review: return {findings:Finding[]}; examine the actual supplied structure/inventory against concept, recent runs, whether the setting, rooms, furniture and exterior make it unmistakably the premise's kind of building rather than a generic office, whether the form matches the premise (an open-air premise built as an enclosed building, or a building premise built open, is a major finding), whether setting.outdoors draws the place's real surroundings (city buildings, shopfronts or a skyline around a place that is not in a city, or a bare empty plain where the premise implies terrain, water or neighbours, is a major finding; target run), room identities, relationships, furnishing variety and coherent ordinary-life details. Finding={id:lowercase slug<=40,priority:major|minor,target,problem<=300,evidence<=300,recommendation<=300}, at most12 unique actionable findings. Cite concrete supplied data and a useful change; no numerical self-scores, vague praise, speculative mechanics, or invented validators. Structure targets: run, floor:0..3 (floor:0 only for an open site), room:<floor>:<room0..3>, survivor:<exact roster name>, or surface:<exact inventory ID>. Empty findings means no material improvement identified.
content-plan: return {plan:{rooms:RoomPlan[],fragments:RepeatFragment[]}}. RoomPlan={id,story<=400,ordinaryLife<=400,occupantEvidence<=400,artDirection<=400}. Include every actual inventory group exactly once: exterior for all exterior surfaces; f<floor>-room<room> for interior room surfaces; f<floor>-common for interior surfaces without a room. Each group needs a distinct coherent story and evidence of prior occupants, not a generic crisis theme. Plan the ordinary artifacts of this particular place (what its workers, visitors or inhabitants would really write, post, log or leave behind, in its own jargon; the place may be real or fantastical) alongside evacuation and survivor traces; every sign and note should read as written inside this building. Connect selected objects through roster relationships without making every note part of one emergency. Set explicit shared fragments now using the environmental fragment schema; fragments and memberships cannot change during writing.
content-batch: return {entries:SurfaceContent[]} for exactly targets, no other surfaces. Read the global plan and accepted content, but focus on this room/group. Vary concise/long writing, subjects, voices, visual compositions and presentation to suit each object's real dimensions. Within this quality flow, identical drawings are allowed only when both surfaces reference the same declared branding or clue fragment; a direction fragment permits repeated fixed text, not repeated art. All prior entries and global fragments stay fixed. content-review: return {findings:Finding[]} with targets only run or surface:<exact ID>. Review the complete assembled writing/art for contradictions, weak room stories, overly generic or repetitive passages/drawings, insufficient ordinary-life evidence, recent-run resemblance and factual game-rule claims. Compare time stamps across floors and check that the opening's concrete promises have a visible narrative payoff. Do not manufacture changes just to prolong review. content-revision: return {entries:SurfaceContent[]} replacing every explicitly targeted surface and no others; a run-level finding permits a coherent patch of up to24 known entries. Do not change fragments, geometry, inventory, or untouched entries. A revision must make meaningful progress on its evidence; mere renaming, recoloring, padding or reverting earlier fixes is not progress.
The environment schema, text/readability budgets, per-drawing/run complexity limits and exact bindings below still apply. Shared fragments are not blanket exceptions for copied ordinary prose. Recent writing and exact non-brand artwork reuse is rejected. The controller performs targeted repairs/reviews until ready or demonstrated diminishing returns; unresolved major/hard failures remain visible for Retry/Cancel. Validated data is not a guarantee of artistic quality.`;
}
export const QUALITY_GUIDANCE = qualityGuidance();
