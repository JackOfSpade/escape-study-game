import assert from "node:assert/strict";
import test from "node:test";
import {
  ENVIRONMENT_FACTS,
  ENVIRONMENT_LIMITS,
  environmentDuplicateErrors,
  environmentSurfaceFingerprint,
  expandContentText,
  normalizeEnvironmentText,
  parseEnvironmentContent,
  parseEnvironmentSummaries,
  summarizeEnvironment,
  type SurfaceSlot,
  type EnvironmentContent,
} from "../src/environment-contract.mjs";
import {
  parseRunDesign,
  parseRunDesignRequest,
  parseRunStructure,
  parseRunStructureReply,
  parseRunContentReply,
  parseRunContentRepairCandidate,
  parseSavedRunDesign,
  runStructureFingerprint,
  runDesignFingerprint,
} from "../src/run-design-contract.mjs";
import { sceneDesignFixture } from "./helpers/run-design";

function structure() {
  const source = sceneDesignFixture();
  const { streetLabels: _, ...exterior } = source.exterior;
  return parseRunStructure({
    ...source,
    version: 3,
    exterior,
    relationships: [
      {
        from: source.roster[0].name,
        to: source.roster[1].name,
        kind: "friend",
        detail: "They exchange pressed flowers after the night shift.",
      },
    ],
    floors: source.floors.map(({ stories: _, scene, ...floor }) => ({
      ...floor,
      scene: {
        version: 2,
        rooms: scene!.rooms.map((room) => ({
          ...room,
          furniture: room.furniture.map(
            ({ label: _, props, ...furniture }) => ({
              ...furniture,
              props: props.map(({ label: _, text: __, ...prop }) => prop),
            }),
          ),
        })),
      },
    })),
  });
}
function slots(count = 2): SurfaceSlot[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `floor0/wall-${i}/poster`,
    floor: 0,
    scope: "interior",
    role: "wall-poster",
    room: i % 4,
    owner: null,
    binding: {
      kind: "fixed",
      x: i + 3,
      y: 3,
      z: 1.6,
      yaw: 0,
      pitch: 0,
      width: 0.62,
      height: 0.86,
    },
    context: "A wall poster in the fictional archive.",
    maxTitle: 48,
    maxBody: 240,
    allowsArt: true,
  }));
}
function content(s = slots()): EnvironmentContent {
  return {
    version: 1,
    surfaceFingerprint: environmentSurfaceFingerprint(s),
    fragments: [],
    entries: s.map((slot, i) => ({
      surfaceId: slot.id,
      layout: "text",
      title: [
        { text: i === 0 ? "Pressing room ledger" : "A lunch invitation" },
      ],
      body: [
        {
          text:
            i === 0
              ? "Someone stored a blue iris between the missing ledger pages."
              : "The lunch table still holds a folded invitation for the night crew.",
        },
      ],
      description: "",
      drawing: null,
    })),
  };
}
function request(s = slots()) {
  const blueprint = structure();
  return parseRunDesignRequest({
    version: 2,
    designVersion: 3,
    phase: "content",
    requestId: "design-content-one",
    generationId: "design-generation-v3",
    seed: 42,
    structure: blueprint,
    structureFingerprint: runStructureFingerprint(blueprint),
    builderVersion: "environment-v1",
    surfaces: s,
    surfaceFingerprint: environmentSurfaceFingerprint(s),
    recentContent: [],
  });
}

test("version 3 separates strict provisional structure from complete accepted saves", () => {
  const blueprint = structure(),
    p = request();
  assert.throws(() => parseRunDesign(blueprint), /missing/);
  assert.throws(
    () => parseRunStructure({ ...blueprint, environment: {} }),
    /unknown/,
  );
  const env = { ...content(), surfaces: p.surfaces },
    design = parseRunDesign({ ...blueprint, environment: env });
  const saved = {
    version: 1,
    source: "fixture",
    requestId: p.requestId,
    generationId: p.generationId,
    fingerprint: runDesignFingerprint(design),
    design,
  };
  assert.deepEqual(parseSavedRunDesign(saved), saved);
  assert.throws(
    () =>
      parseSavedRunDesign({
        ...saved,
        design: blueprint,
        fingerprint: runStructureFingerprint(blueprint),
      }),
    /missing/,
  );
  assert.throws(
    () =>
      parseRunStructure({
        ...blueprint,
        relationships: [
          { ...blueprint.relationships[0], to: "not in the roster" },
        ],
      }),
    /roster/,
  );
  assert.throws(
    () =>
      parseRunStructure({
        ...blueprint,
        floors: blueprint.floors.map((f) => ({ ...f, stories: [] })),
      }),
    /unknown/,
  );
});

test("captured phases bind replies and reject structural mutations or stale surface inventories", () => {
  const p = request(),
    c = content();
  assert.deepEqual(
    parseRunContentReply({ requestId: p.requestId, content: c }, p).content,
    c,
  );
  for (const bad of [
    { requestId: "design-stale", content: c },
    { requestId: p.requestId, content: c, structure: p.structure },
    {
      requestId: p.requestId,
      content: { ...c, surfaceFingerprint: "0123456789abcdef" },
    },
  ])
    assert.throws(() => parseRunContentReply(bad, p));
  const structural = parseRunDesignRequest({
    version: 2,
    designVersion: 3,
    phase: "structure",
    requestId: "design-structure",
    generationId: p.generationId,
    seed: 42,
    recent: [],
  });
  assert.deepEqual(
    parseRunStructureReply(
      { requestId: structural.requestId, structure: p.structure },
      structural,
    ).structure,
    p.structure,
  );
  assert.throws(
    () =>
      parseRunStructureReply(
        { requestId: structural.requestId, content: c },
        structural,
      ),
    /missing or unknown|unknown field/,
  );
  assert.throws(
    () =>
      parseRunDesignRequest({
        ...p,
        surfaces: p.surfaces.map((s, i) =>
          i ? s : { ...s, binding: { ...s.binding, x: 9 } },
        ),
      }),
    /fingerprint/,
  );
  for (const field of [
    "study",
    "curriculum",
    "messages",
    "credentials",
    "provider",
  ])
    assert.throws(
      () => parseRunDesignRequest({ ...p, [field]: "private" }),
      /unknown/,
    );
});

test("surface completeness and normalized near-copies are rejected without preventing captured repair", () => {
  const p = request(),
    good = content();
  for (const bad of [
    { ...good, entries: good.entries.slice(0, 1) },
    { ...good, entries: [good.entries[0], good.entries[0]] },
    {
      ...good,
      entries: good.entries.map((e, i) =>
        i ? { ...e, surfaceId: "unknown/object" } : e,
      ),
    },
    {
      ...good,
      entries: good.entries.map((e, i) =>
        i
          ? {
              ...e,
              body: [
                {
                  text: "SOMEONE stored a BLUE iris, between the missing ledger pages!",
                },
              ],
            }
          : e,
      ),
    },
    {
      ...good,
      entries: good.entries.map((e, i) =>
        i
          ? {
              ...e,
              body: [
                {
                  text: "Someone stored a red iris between the missing ledger pages.",
                },
              ],
            }
          : e,
      ),
    },
    {
      ...good,
      entries: good.entries.map((e, i) =>
        i
          ? {
              ...e,
              body: [
                {
                  text: "Between the missing ledger pages someone stored a blue iris.",
                },
              ],
            }
          : e,
      ),
    },
  ]) {
    assert.throws(() =>
      parseRunContentReply({ requestId: p.requestId, content: bad }, p),
    );
    const candidate = parseRunContentRepairCandidate(
      { requestId: p.requestId, content: bad },
      p,
    );
    assert.deepEqual(
      parseRunDesignRequest({
        ...p,
        requestId: "design-content-repair",
        repair: { candidate, errors: ["Repair the named surface writing."] },
      }).repair!.candidate,
      candidate,
    );
  }
  assert.equal(
    normalizeEnvironmentText("Ｆｏｌｄｅｒ — BLUE\u200b / ７"),
    "folder blue 7",
  );
  assert.throws(
    () =>
      parseRunContentRepairCandidate(
        { requestId: p.requestId, content: { ...good, script: "run()" } },
        p,
      ),
    /unknown/,
  );
  assert.throws(
    () =>
      parseRunContentRepairCandidate(
        { requestId: "design-other", content: good },
        p,
      ),
    /requestId/,
  );
});

test("intentional fragments are exact explicit memberships and direction words come from engine facts", () => {
  const s = slots(),
    c = content(s);
  c.fragments = [
    {
      id: "archive-brand",
      kind: "branding",
      text: "The Pressed Iris Archive",
      reason: "Both posters belong to the same organization.",
      surfaces: s.map((x) => x.id),
    },
  ];
  c.entries.forEach((e) => (e.title = [{ fragmentId: "archive-brand" }]));
  assert.deepEqual(
    environmentDuplicateErrors(parseEnvironmentContent(c, structure(), s)),
    [],
  );
  assert.equal(
    expandContentText(c.entries[0].title, c.fragments),
    "The Pressed Iris Archive",
  );
  const direction = structuredClone(c);
  direction.fragments = [
    {
      id: "roof-rule",
      kind: "direction",
      fact: "rooftop-extraction",
      reason: "Both signs point readers toward the real extraction floor.",
      surfaces: s.map((x) => x.id),
    },
  ];
  direction.entries.forEach((e) => (e.title = [{ fragmentId: "roof-rule" }]));
  assert.equal(
    expandContentText(
      parseEnvironmentContent(direction, structure(), s).entries[0].title,
      direction.fragments,
    ),
    ENVIRONMENT_FACTS["rooftop-extraction"],
  );
  assert.throws(
    () =>
      parseEnvironmentContent(
        {
          ...c,
          fragments: c.fragments.map((f) => ({ ...f, surfaces: [s[0].id] })),
        },
        structure(),
        s,
      ),
    /entries/,
  );
  assert.throws(
    () =>
      parseEnvironmentContent(
        {
          ...direction,
          fragments: direction.fragments.map((f) => ({
            ...f,
            text: "Every force field is free",
          })),
        },
        structure(),
        s,
      ),
    /unknown/,
  );
  const hiddenCopy = structuredClone(c);
  hiddenCopy.entries[1].body = hiddenCopy.entries[0].body;
  assert.throws(
    () => parseEnvironmentContent(hiddenCopy, structure(), s),
    /Distinct writing/,
  );
});

test("drawings are bounded primitives and cannot inject executable or untracked text operations", () => {
  const s = slots(),
    c = content(s),
    e = c.entries[0];
  e.layout = "mixed";
  e.description = "A blue ellipse encircled by a charcoal line.";
  e.drawing = {
    version: 1,
    background: "transparent",
    primitives: [
      {
        kind: "ellipse",
        x: 0.2,
        y: 0.2,
        w: 0.6,
        h: 0.6,
        rotation: 0,
        fill: "#336699",
        stroke: "#202020",
        width: 0.01,
        opacity: 0.8,
      },
      {
        kind: "stroke",
        points: [
          { x: 0.1, y: 0.1 },
          { x: 0.9, y: 0.9 },
        ],
        width: 0.01,
        color: "#202020",
        opacity: 1,
      },
    ],
  };
  assert.deepEqual(parseEnvironmentContent(c, structure(), s), c);
  const invalid = [
    { ...e.drawing, source: "https://example.invalid/picture.svg" },
    {
      ...e.drawing,
      primitives: [{ kind: "text", text: "Untracked words", x: 0, y: 0 }],
    },
    {
      ...e.drawing,
      primitives: [
        {
          kind: "stroke",
          points: [
            { x: NaN, y: 0 },
            { x: 1, y: 1 },
          ],
          width: 0.01,
          color: "#000000",
          opacity: 1,
        },
      ],
    },
    {
      ...e.drawing,
      primitives: Array.from({ length: 25 }, () => e.drawing!.primitives[0]),
    },
  ];
  for (const drawing of invalid)
    assert.throws(() =>
      parseEnvironmentContent(
        { ...c, entries: [{ ...e, drawing }, c.entries[1]] },
        structure(),
        s,
      ),
    );
  assert.throws(
    () =>
      parseEnvironmentContent(
        c,
        structure(),
        s.map((x, i) => (i ? x : { ...x, allowsArt: false })),
      ),
    /fingerprint/,
  );
  const summary = summarizeEnvironment(c);
  assert.equal(summary.art.length, 1);
  assert.match(
    summary.artDescriptions![0],
    /blue ellipse.*1 ellipse, 1 stroke/,
  );
  assert.deepEqual(parseEnvironmentSummaries([summary]), [summary]);
  assert.throws(
    () => parseEnvironmentSummaries([{ ...summary, messages: ["private"] }]),
    /unknown/,
  );
});

test("whole-run drawing budgets apply even when every object is individually valid", () => {
  const art = (count: number, points: boolean) => {
    const s = slots(count),
      c = content(s);
    for (const e of c.entries) {
      e.layout = "art";
      e.title = [];
      e.body = [];
      e.description =
        "An abstract charcoal composition on the surviving paper.";
      e.drawing = {
        version: 1,
        background: "transparent",
        primitives: points
          ? Array.from({ length: 2 }, () => ({
              kind: "stroke" as const,
              points: Array.from({ length: 64 }, (_, i) => ({
                x: i / 64,
                y: i % 2 ? 0.2 : 0.8,
              })),
              width: 0.01,
              color: "#223344",
              opacity: 1,
            }))
          : Array.from({ length: 24 }, () => ({
              kind: "ellipse" as const,
              x: 0.2,
              y: 0.2,
              w: 0.2,
              h: 0.2,
              rotation: 0,
              fill: "#223344",
              stroke: null,
              width: 0.01,
              opacity: 1,
            })),
      };
    }
    return { s, c };
  };
  for (const { s, c } of [art(86, false), art(65, true)])
    assert.throws(
      () => parseEnvironmentContent(c, structure(), s),
      /run drawing complexity/,
    );
  const s = slots(),
    c = content(s);
  c.entries[0].title = [{ text: "!!!" }];
  c.entries[0].body = [];
  assert.throws(
    () => parseEnvironmentContent(c, structure(), s),
    /text layout/,
  );
  const short = content(s);
  short.entries.forEach((e) => (e.body = [{ text: "Call home." }]));
  assert.throws(
    () => parseEnvironmentContent(short, structure(), s),
    /Distinct writing/,
  );
});

test("drawing descriptions obey cross-object uniqueness while same-object reuse remains valid", () => {
  const s = slots(),
    p = request(s),
    c = content(s);
  for (const e of c.entries) {
    e.layout = "mixed";
    e.drawing = {
      version: 1,
      background: "transparent",
      primitives: [
        {
          kind: "ellipse",
          x: 0.2,
          y: 0.2,
          w: 0.5,
          h: 0.5,
          rotation: 0,
          fill: "#223344",
          stroke: null,
          width: 0.01,
          opacity: 1,
        },
      ],
    };
  }
  c.entries[0].description =
    "A blue oval surrounds a pencilled shoreline beneath a tilted compass rose.";
  c.entries[1].description =
    "A family portrait shows two siblings carrying a basket of ripe apples.";
  c.entries[0].body = [{ text: c.entries[0].description }];
  assert.deepEqual(
    parseEnvironmentContent(c, p.structure, s),
    c,
    "an object's own caption may repeat its printed words",
  );
  for (const description of [
    c.entries[0].description,
    "A red oval surrounds a pencilled shoreline beneath a tilted compass rose.",
  ]) {
    const duplicate = structuredClone(c);
    duplicate.entries[1].description = description;
    assert.throws(
      () => parseEnvironmentContent(duplicate, p.structure, s),
      /Distinct writing.*description/,
    );
    assert.deepEqual(
      parseRunContentRepairCandidate(
        { requestId: p.requestId, content: duplicate },
        p,
      ),
      duplicate,
    );
  }
  const crossField = structuredClone(c);
  crossField.entries[0].body = [
    { text: "The orange pencil rolled beneath the visitor ledger." },
  ];
  crossField.entries[1].body = [{ text: crossField.entries[0].description }];
  assert.throws(
    () => parseEnvironmentContent(crossField, p.structure, s),
    /Distinct writing.*description/,
  );
});

test("a shared artwork description requires identical drawings and explicit shared-fragment references", () => {
  const s = slots(),
    p = request(s),
    c = content(s);
  c.fragments = [
    {
      id: "repeated-logo",
      kind: "branding",
      text: "The Blue Iris Archive",
      reason: "The same organization mark appears on both posters.",
      surfaces: s.map((x) => x.id),
    },
  ];
  for (const e of c.entries) {
    e.title = [{ fragmentId: "repeated-logo" }];
    e.layout = "mixed";
    e.description =
      "A cobalt oval encloses the archive's familiar iris emblem.";
    e.drawing = {
      version: 1,
      background: "transparent",
      primitives: [
        {
          kind: "ellipse",
          x: 0.2,
          y: 0.2,
          w: 0.5,
          h: 0.5,
          rotation: 0,
          fill: "#223344",
          stroke: null,
          width: 0.01,
          opacity: 1,
        },
      ],
    };
  }
  assert.deepEqual(parseEnvironmentContent(c, p.structure, s), c);
  const different = structuredClone(c);
  const primitive = different.entries[1].drawing!.primitives[0];
  assert.equal(primitive.kind, "ellipse");
  if (primitive.kind !== "ellipse") throw Error("Expected ellipse");
  primitive.fill = "#443322";
  assert.throws(
    () => parseEnvironmentContent(different, p.structure, s),
    /Distinct writing.*description/,
  );
  const accidental = structuredClone(c);
  accidental.fragments = [];
  accidental.entries[0].title = [{ text: "The north notice" }];
  accidental.entries[1].title = [{ text: "A reception poster" }];
  assert.throws(
    () => parseEnvironmentContent(accidental, p.structure, s),
    /Distinct writing.*description/,
  );
  const unused = structuredClone(c);
  unused.entries[1].title = [{ text: "A reception poster" }];
  assert.throws(
    () => parseEnvironmentContent(unused, p.structure, s),
    /unused members/,
  );
});

test("ordinary prose cannot grant mechanics while typed facts and mundane workplace narratives remain valid", () => {
  const s = slots(),
    p = request(s);
  for (const text of [
    "No keys are needed to climb the stairs.",
    "You don't need keys to ascend.",
    "You can jump through red force fields without a key.",
    "Force fields can be disabled by pushing this poster.",
    "Reading this note grants you three keys.",
    "You gain 100 HP by touching the sketch.",
    "Extraction is in the street behind reception.",
  ]) {
    const c = content(s);
    c.entries[0].body = [{ text }];
    assert.throws(
      () => parseEnvironmentContent(c, p.structure, s),
      /gameplay instruction|rule\/reward claim/,
    );
    assert.deepEqual(
      parseRunContentRepairCandidate({ requestId: p.requestId, content: c }, p),
      c,
    );
  }
  const benign = content(s);
  benign.entries[0].body = [
    {
      text: "Mara left her brass keys beside the stairs while carrying a box of old meeting notes.",
    },
  ];
  assert.deepEqual(parseEnvironmentContent(benign, p.structure, s), benign);
  const branding = content(s);
  branding.fragments = [
    {
      id: "false-reward",
      kind: "branding",
      text: "This poster awards a key",
      reason: "A repeated organization slogan",
      surfaces: s.map((x) => x.id),
    },
  ];
  branding.entries.forEach((e) => (e.title = [{ fragmentId: "false-reward" }]));
  assert.throws(
    () => parseEnvironmentContent(branding, p.structure, s),
    /fragment false-reward/,
  );
  const art = content(s);
  art.entries[0].layout = "mixed";
  art.entries[0].drawing = {
    version: 1,
    background: "transparent",
    primitives: [
      {
        kind: "ellipse",
        x: 0.2,
        y: 0.2,
        w: 0.5,
        h: 0.5,
        rotation: 0,
        fill: "#223344",
        stroke: null,
        width: 0.01,
        opacity: 1,
      },
    ],
  };
  art.entries[0].description = "Touch this drawing to receive a key.";
  assert.throws(
    () => parseEnvironmentContent(art, p.structure, s),
    /description.*gameplay instruction/,
  );
  const typed = content(s);
  typed.fragments = [
    {
      id: "real-route",
      kind: "direction",
      fact: "rooftop-extraction",
      reason: "The real extraction destination",
      surfaces: s.map((x) => x.id),
    },
  ];
  typed.entries.forEach((e) => (e.title = [{ fragmentId: "real-route" }]));
  assert.deepEqual(parseEnvironmentContent(typed, p.structure, s), typed);
  assert.ok(
    !summarizeEnvironment(typed).phrases.includes(
      normalizeEnvironmentText(ENVIRONMENT_FACTS["rooftop-extraction"]),
    ),
  );
  typed.entries[0].title.unshift({ text: "Not: " });
  assert.throws(
    () => parseEnvironmentContent(typed, p.structure, s),
    /must stand alone/,
  );
});

test("escaped multibyte content plus its exact inventory compose below accepted-save and transport budgets", () => {
  const count = 280,
    s = slots(count);
  for (const slot of s)
    slot.context = 'A "catalogued" \\ archive ' + "界".repeat(70);
  const c = content(s);
  const glyphs = (seed: number, length: number) => {
    let state = seed + 1;
    return Array.from({ length }, () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return String.fromCharCode(0x4e00 + (state % 19000));
    }).join("");
  };
  c.entries.forEach((e, i) => {
    e.title = [{ text: glyphs(i + 1000, 48) }];
    e.body = [{ text: glyphs(i + 2000, 240) }];
    e.description = '"\\' + glyphs(i + 3000, 158);
  });
  c.surfaceFingerprint = environmentSurfaceFingerprint(s);
  const p = request(s),
    accepted = parseRunContentReply(
      { requestId: p.requestId, content: c },
      p,
    ).content;
  const design = parseRunDesign({
    ...p.structure,
    environment: { ...accepted, surfaces: s },
  });
  const bytes = (v: unknown) =>
    new TextEncoder().encode(JSON.stringify(v)).length;
  assert.ok(
    bytes(design) > 540000,
    "this regression must exceed the old non-composable manifest ceiling",
  );
  assert.ok(bytes(c) < ENVIRONMENT_LIMITS.contentBytes);
  assert.ok(bytes(design) < 900000);
  const escaped = "\ud800",
    summary = {
      fingerprint: "0123456789abcdef",
      phrases: Array.from({ length: 32 }, () => escaped.repeat(120)),
      art: Array.from({ length: 32 }, () => "0123456789abcdef"),
      artDescriptions: Array.from({ length: 32 }, () => escaped.repeat(160)),
    };
  const recentContent = Array.from({ length: 5 }, () => summary);
  assert.ok(bytes(recentContent) > 260000);
  assert.deepEqual(parseEnvironmentSummaries(recentContent), recentContent);
  assert.deepEqual(
    parseRunDesignRequest({
      ...p,
      recentContent,
      repair: {
        candidate: c,
        errors: ["Preserve the individual authored content."],
      },
    }).repair!.candidate,
    c,
  );
  const { artDescriptions: _, ...retained } = summary;
  assert.deepEqual(parseEnvironmentSummaries([retained]), [retained]);
});

test("every over-budget title and body is reported in one readable-budget error", () => {
  const s = slots(),
    c = content(s);
  c.entries[0].title = [{ text: "An overlong poster title ".repeat(3) }];
  c.entries[1].body = [
    { text: "The lunch table still holds a folded invitation. ".repeat(3) },
    { text: "The night crew is named on the inside of the card. ".repeat(3) },
  ];
  const titleLength = expandContentText(c.entries[0].title, c.fragments).length,
    bodyLength = expandContentText(c.entries[1].body, c.fragments).length;
  assert.ok(titleLength > s[0].maxTitle && bodyLength > s[1].maxBody);
  assert.throws(
    () => parseEnvironmentContent(c, structure(), s),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.match(
        message,
        /: 2 entries exceed their surface's readable budget: /,
      );
      assert.ok(
        message.includes(
          `entries[0].title for surface ${s[0].id} has ${titleLength} characters and exceeds the surface's readable budget of ${s[0].maxTitle}`,
        ),
      );
      assert.ok(
        message.includes(
          `entries[1].body for surface ${s[1].id} has ${bodyLength} characters and exceeds the surface's readable budget of ${s[1].maxBody}`,
        ),
      );
      assert.ok(message.endsWith("; shorten each to its limit"));
      return true;
    },
  );
  const single = content(s);
  single.entries[0].title = [{ text: "An overlong poster title ".repeat(3) }];
  assert.throws(
    () => parseEnvironmentContent(single, structure(), s),
    /1 entry exceeds its surface's readable budget: entries\[0\]\.title/,
  );
});
