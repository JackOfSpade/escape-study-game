// Shared by the browser and the bridge server. Design replies are bounded JSON data only.
import {
  PROP_CATALOG,
  SCENE_FURNITURE_KINDS,
  SCENE_SURFACE_KINDS,
  parseSceneDesign,
  parseSceneStructure,
} from "./scene-catalog.mjs";
import { SETTING_GUIDANCE, parseSetting } from "./setting-catalog.mjs";
import {
  parseQualityRequest,
  parseQualityReply,
  qualityGuidance,
} from "./run-quality-contract.mjs";
export * from "./run-quality-contract.mjs";
import {
  parseEnvironmentManifest,
  parseEnvironmentContent,
  parseEnvironmentRepairCandidate,
  parseEnvironmentSurfaces,
  parseEnvironmentSummaries,
  environmentSurfaceFingerprint,
  ENVIRONMENT_GUIDANCE,
} from "./environment-contract.mjs";
export {
  parseEnvironmentManifest,
  parseEnvironmentContent,
  parseEnvironmentRepairCandidate,
  parseEnvironmentSurfaces,
  parseEnvironmentSummaries,
  environmentSurfaceFingerprint,
  summarizeEnvironment,
} from "./environment-contract.mjs";
const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function requireThat(ok, message) {
  if (!ok) throw Error(`Run design: ${message}`);
}
function object(v, names, path) {
  requireThat(record(v), `${path} must be an object`);
  requireThat(
    Object.keys(v).every((k) => names.includes(k)),
    `${path} has an unknown field`,
  );
  requireThat(
    names.every((k) => Object.hasOwn(v, k)),
    `${path} is missing a field`,
  );
}
const DOOR_MATERIALS = ["wood", "steel", "glass", "fire", "security"];
const DOOR_WINDOWS = ["none", "slit", "half", "full"];
function parseDoorDesign(d, path) {
  object(d, ["material", "color", "accent", "window", "label", "health"], path);
  requireThat(
    DOOR_MATERIALS.includes(d.material),
    `${path}.material is invalid`,
  );
  requireThat(DOOR_WINDOWS.includes(d.window), `${path}.window is invalid`);
  for (const k of ["color", "accent"])
    requireThat(
      typeof d[k] === "string" && /^#[0-9a-fA-F]{6}$/u.test(d[k]),
      `${path}.${k} needs a six-digit hex color`,
    );
  text(d.label, 32, `${path}.label`);
  requireThat(
    Number.isInteger(d.health) && d.health >= 400 && d.health <= 2400,
    `${path}.health must be an integer from 400 to 2400`,
  );
}
/** Fonts the opening title card may use, keyed by the name the designer
 * returns. Each is a Google Fonts family loaded only when chosen; the stack
 * after it keeps the card readable offline. */
export const TITLE_CARD_FONTS = {
  "space-grotesk": {
    family: "Space Grotesk",
    fallback: "system-ui, sans-serif",
  },
  "dm-sans": { family: "DM Sans", fallback: "system-ui, sans-serif" },
  "archivo-black": { family: "Archivo Black", fallback: "Impact, sans-serif" },
  oswald: { family: "Oswald", fallback: "'Arial Narrow', sans-serif" },
  "bebas-neue": { family: "Bebas Neue", fallback: "Impact, sans-serif" },
  "playfair-display": {
    family: "Playfair Display",
    fallback: "Georgia, serif",
  },
  "cormorant-garamond": {
    family: "Cormorant Garamond",
    fallback: "Garamond, Georgia, serif",
  },
  "libre-baskerville": {
    family: "Libre Baskerville",
    fallback: "Baskerville, Georgia, serif",
  },
  "special-elite": {
    family: "Special Elite",
    fallback: "'Courier New', monospace",
  },
  "courier-prime": {
    family: "Courier Prime",
    fallback: "'Courier New', monospace",
  },
  "ibm-plex-mono": { family: "IBM Plex Mono", fallback: "Menlo, monospace" },
  vt323: { family: "VT323", fallback: "Menlo, monospace" },
  creepster: { family: "Creepster", fallback: "Impact, fantasy" },
  caveat: { family: "Caveat", fallback: "'Comic Sans MS', cursive" },
  "permanent-marker": {
    family: "Permanent Marker",
    fallback: "'Comic Sans MS', cursive",
  },
};
/** Inclusive pixel bounds for each title-card text role. */
export const TITLE_CARD_SIZES = { title: [28, 96], story: [14, 28] };
/** Minimum WCAG contrast against the card's pure black background. */
const TITLE_CARD_CONTRAST = { title: 3, story: 4.5 };
function contrastOnBlack(hex) {
  const channel = (i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return (l + 0.05) / 0.05;
}
function parseTitleCard(card, path) {
  object(card, ["title", "story"], path);
  for (const role of ["title", "story"]) {
    const s = card[role],
      p = `${path}.${role}`;
    object(s, ["font", "color", "size"], p);
    choice(s.font, Object.keys(TITLE_CARD_FONTS), `${p}.font`);
    requireThat(
      typeof s.color === "string" && /^#[0-9a-fA-F]{6}$/u.test(s.color),
      `${p}.color needs a six-digit hex color`,
    );
    requireThat(
      contrastOnBlack(s.color) >= TITLE_CARD_CONTRAST[role],
      `${p}.color is too dark to read on black (contrast ${contrastOnBlack(s.color).toFixed(1)}, needs ${TITLE_CARD_CONTRAST[role]})`,
    );
    number(s.size, ...TITLE_CARD_SIZES[role], `${p}.size`, true);
  }
}
function text(v, max, path) {
  requireThat(
    typeof v === "string" &&
      v.trim().length > 0 &&
      v.length <= max &&
      !/[\u0000-\u001f\u007f]/u.test(v),
    `${path} must be 1–${max} printable characters`,
  );
}
function number(v, min, max, path, integer = false) {
  requireThat(
    typeof v === "number" &&
      Number.isFinite(v) &&
      v >= min &&
      v <= max &&
      (!integer || Number.isInteger(v)),
    `${path} must be ${integer ? "an integer " : ""}between ${min} and ${max}`,
  );
}
function choice(v, values, path) {
  requireThat(
    values.includes(v),
    `${path} must be one of ${values.join(", ")}`,
  );
}
function array(v, min, max, path, check) {
  requireThat(
    Array.isArray(v) && v.length >= min && v.length <= max,
    `${path} needs ${min === max ? min : `${min}–${max}`} entries`,
  );
  v.forEach((entry, i) => check(entry, `${path}[${i}]`, i));
}
function bounded(v, limit) {
  requireThat(
    new TextEncoder().encode(JSON.stringify(v)).length <= limit,
    `packet exceeds ${limit} bytes`,
  );
}
/** Building silhouettes. Every shape keeps the shared stair and entrance
 * columns and two-cell circulation; see createBuildingFootprint. */
export const FOOTPRINT_SHAPES = Object.freeze([
  "rectangle",
  "chamfered",
  "stepped",
  "waisted",
  "tapered",
  "notched",
  "tee",
]);
/** How a study room's corners and sub-rooms are carved from the grid; the
 * plan validators still guarantee routes, terminals and egress. */
export const ROOM_SHAPES = Object.freeze([
  "rect",
  "chamfered",
  "rounded",
  "octagon",
]);
const roomTypes = [
  "break",
  "cubicles",
  "meeting",
  "storage",
  "reception",
  "manager",
];
const roles = ["builder", "analyst", "rusher", "medic", "skeptic"];
const uint = (v, p) => number(v, 0, 4294967295, p, true);
const clone = (v) => JSON.parse(JSON.stringify(v));

function parseBlueprint(v, provisional = false) {
  const v3 = v?.version === 3;
  bounded(
    v,
    v3 ? (provisional ? 100000 : 900000) : v?.version === 2 ? 100000 : 24000,
  );
  if (v3 && !provisional) {
    const { environment: _, ...structure } = v;
    bounded(structure, 100000);
  }
  object(
    v,
    [
      "version",
      "title",
      "premise",
      "opening",
      "footprint",
      "floors",
      "roofName",
      "roster",
      "city",
      "exterior",
      "pacing",
      ...(Object.hasOwn(v, "mainDoor") ? ["mainDoor"] : []),
      ...(Object.hasOwn(v, "titleCard") ? ["titleCard"] : []),
      ...(v3 && Object.hasOwn(v, "setting") ? ["setting"] : []),
      ...(v3
        ? ["relationships", ...(!provisional ? ["environment"] : [])]
        : []),
    ],
    "design",
  );
  if (Object.hasOwn(v, "mainDoor")) parseDoorDesign(v.mainDoor, "mainDoor");
  if (Object.hasOwn(v, "titleCard")) parseTitleCard(v.titleCard, "titleCard");
  if (v3 && Object.hasOwn(v, "setting")) parseSetting(v.setting);
  requireThat(
    v.version === 1 || v.version === 2 || v3,
    "unsupported design version",
  );
  // Only version 3 knows about site forms; an older design is always enclosed.
  const siteForm = v3 ? (v.setting?.form ?? "enclosed") : "enclosed";
  requireThat(
    v3 || v.setting?.form === undefined,
    "setting.form: only a version 3 design may be open or enclosed",
  );
  text(v.title, 64, "title");
  text(v.premise, 240, "premise");
  text(v.opening, 200, "opening");
  const b = v.footprint;
  object(
    b,
    ["shape", "width", "top", "inset", "mirrored", "shoulder"],
    "footprint",
  );
  // Historical versions keep their original four silhouettes.
  choice(
    b.shape,
    v3 ? FOOTPRINT_SHAPES : FOOTPRINT_SHAPES.slice(0, 4),
    "footprint.shape",
  );
  choice(b.width, [36, 38, 40], "footprint.width");
  number(b.top, 2, 4, "footprint.top", true);
  number(b.inset, 2, 4, "footprint.inset", true);
  requireThat(
    typeof b.mirrored === "boolean",
    "footprint.mirrored must be boolean",
  );
  number(b.shoulder, b.top + 8, b.top + 14, "footprint.shoulder", true);
  // An open site is one ground-level plan; an enclosed building keeps four.
  const floorCount = siteForm === "open" ? 1 : 4;
  array(v.floors, floorCount, floorCount, "floors", (f, p) => {
    object(
      f,
      [
        "name",
        "family",
        "roomOrder",
        "layoutSeed",
        "roomTypes",
        "subroomKinds",
        "furnitureDensity",
        "fieldQuotas",
        "power",
        ...(!v3 ? ["stories"] : []),
        "brokenGuard",
        ...(v.version >= 2 ? ["scene"] : []),
        ...(Object.hasOwn(f, "doors") ? ["doors"] : []),
        ...(v3 && Object.hasOwn(f, "roomShapes") ? ["roomShapes"] : []),
      ],
      p,
    );
    if (Object.hasOwn(f, "doors"))
      array(f.doors, 4, 4, `${p}.doors`, (d, q) => parseDoorDesign(d, q));
    text(f.name, 48, `${p}.name`);
    choice(f.family, ["stack", "columns", "serpentine"], `${p}.family`);
    array(f.roomOrder, 3, 3, `${p}.roomOrder`, (n, q) =>
      choice(n, [0, 1, 3], q),
    );
    requireThat(
      new Set(f.roomOrder).size === 3,
      `${p}.roomOrder must be a permutation of [0,1,3]`,
    );
    uint(f.layoutSeed, `${p}.layoutSeed`);
    array(f.roomTypes, 4, 4, `${p}.roomTypes`, (x, q) =>
      choice(x, roomTypes, q),
    );
    array(f.subroomKinds, 1, 4, `${p}.subroomKinds`, (x, q) =>
      choice(x, ["office", "meeting", "storage", "break"], q),
    );
    requireThat(
      new Set(f.subroomKinds).size === f.subroomKinds.length,
      `${p}.subroomKinds must be unique`,
    );
    number(f.furnitureDensity, 0.5, 1.5, `${p}.furnitureDensity`);
    array(f.fieldQuotas, 4, 4, `${p}.fieldQuotas`, (n, q) =>
      number(n, 2, 6, q, true),
    );
    array(f.power, 4, 4, `${p}.power`, (x, q) =>
      choice(x, ["lit", "dim", "outage"], q),
    );
    requireThat(
      f.power[2] === "lit",
      `${p}.power[2] must keep the free study hall lit`,
    );
    if (!v3)
      array(f.stories, 6, 6, `${p}.stories`, (s, q) => {
        object(s, ["title", "lines"], q);
        text(s.title, 36, `${q}.title`);
        array(s.lines, 1, 4, `${q}.lines`, (line, r) => text(line, 50, r));
      });
    object(f.brokenGuard, ["segment", "bay"], `${p}.brokenGuard`);
    choice(f.brokenGuard.segment, [3, 4], `${p}.brokenGuard.segment`);
    choice(f.brokenGuard.bay, [1, 2], `${p}.brokenGuard.bay`);
    if (Object.hasOwn(f, "roomShapes"))
      array(f.roomShapes, 4, 4, `${p}.roomShapes`, (shape, q) =>
        choice(shape, ROOM_SHAPES, q),
      );
  });
  text(v.roofName, 48, "roofName");
  array(v.roster, 19, 19, "roster", (a, p) => {
    object(a, ["name", "role", "skill", "risk", "social"], p);
    text(a.name, 20, `${p}.name`);
    choice(a.role, roles, `${p}.role`);
    number(a.skill, 0.4, 0.9, `${p}.skill`);
    number(a.risk, 0.2, 0.8, `${p}.risk`);
    number(a.social, 0.2, 0.8, `${p}.social`);
  });
  const names = v.roster.map((a) => a.name.trim().toLowerCase());
  requireThat(
    new Set(names).size === 19 && !names.includes("you"),
    "roster needs 19 unique names distinct from You",
  );
  if (v.version >= 2)
    v.floors.forEach((floor, index) =>
      v3
        ? parseSceneStructure(
            floor.scene,
            v.roster.map((a) => a.name),
            `floors[${index}].scene`,
            v.setting?.objects ?? [],
            v.setting?.props ?? [],
          )
        : parseSceneDesign(
            floor.scene,
            v.roster.map((a) => a.name),
            `floors[${index}].scene`,
          ),
    );
  if (v3) {
    const pairs = new Set();
    array(v.relationships, 1, 24, "relationships", (r, p) => {
      object(r, ["from", "to", "kind", "detail"], p);
      for (const k of ["from", "to"])
        requireThat(
          v.roster.some((a) => a.name === r[k]),
          `${p}.${k} must name a roster survivor`,
        );
      requireThat(r.from !== r.to, `${p} cannot relate a person to themselves`);
      choice(
        r.kind,
        ["colleague", "friend", "relative", "mentor", "rival"],
        `${p}.kind`,
      );
      text(r.detail, 120, `${p}.detail`);
      const pair = [r.from, r.to].sort().join("\u0000");
      requireThat(!pairs.has(pair), `${p} repeats a relationship pair`);
      pairs.add(pair);
    });
  }
  const c = v.city;
  object(
    c,
    [
      "roadWidth",
      "boulevardOffset",
      "districtSize",
      "buildingHeightMin",
      "buildingHeightMax",
      "damageRate",
      "palette",
    ],
    "city",
  );
  number(c.roadWidth, 7, 9, "city.roadWidth", true);
  number(c.boulevardOffset, 15, 19, "city.boulevardOffset", true);
  number(c.districtSize, 18, 25, "city.districtSize", true);
  number(c.buildingHeightMin, 9, 18, "city.buildingHeightMin");
  number(c.buildingHeightMax, 25, 45, "city.buildingHeightMax");
  number(c.damageRate, 0, 0.7, "city.damageRate");
  array(c.palette, 3, 6, "city.palette", (color, p) =>
    requireThat(
      typeof color === "string" && /^#[0-9a-fA-F]{6}$/u.test(color),
      `${p} needs a six-digit hex color`,
    ),
  );
  const e = v.exterior;
  object(
    e,
    [
      "buildingName",
      "buildingSubtitle",
      "quarantineTitle",
      "quarantineSubtitle",
      ...(!v3 ? ["streetLabels"] : []),
      "skyline",
    ],
    "exterior",
  );
  for (const k of [
    "buildingName",
    "buildingSubtitle",
    "quarantineTitle",
    "quarantineSubtitle",
  ])
    text(e[k], 48, `exterior.${k}`);
  if (!v3)
    array(e.streetLabels, 8, 8, "exterior.streetLabels", (s, p) =>
      text(s, 28, p),
    );
  object(
    e.skyline,
    ["minHeight", "maxHeight", "damageRate"],
    "exterior.skyline",
  );
  number(e.skyline.minHeight, 24, 60, "skyline.minHeight");
  number(e.skyline.maxHeight, 72, 140, "skyline.maxHeight");
  number(e.skyline.damageRate, 0, 0.7, "skyline.damageRate");
  const p = v.pacing;
  object(
    p,
    [
      "swarmInterval",
      "swarmBatch",
      "swarmCap",
      "npcThinkingScale",
      "firstHelicopter",
      "helicopterInterval",
    ],
    "pacing",
  );
  number(p.swarmInterval, 2.5, 4, "pacing.swarmInterval");
  number(p.swarmBatch, 1, 2, "pacing.swarmBatch", true);
  number(p.swarmCap, 120, 220, "pacing.swarmCap", true);
  number(p.npcThinkingScale, 0.2, 0.35, "pacing.npcThinkingScale");
  number(p.firstHelicopter, 420, 600, "pacing.firstHelicopter");
  number(p.helicopterInterval, 150, 210, "pacing.helicopterInterval");
  if (v3 && !provisional) parseEnvironmentManifest(v.environment, v);
  return clone(v);
}

export function parseRunDesign(v) {
  return parseBlueprint(v);
}
export function parseRunStructure(v) {
  requireThat(v?.version === 3, "a structural proposal must be version 3");
  return parseBlueprint(v, true);
}
export function runStructureFingerprint(v) {
  return runDesignFingerprint(v);
}

// These summaries contain fictional design choices only, never learner state.
export function summarizeRunDesign(d) {
  const b = d.footprint;
  // Inactive parameters cannot make an identical shell count as a new layout.
  const footprint = [
    b.shape,
    b.width,
    b.top,
    b.shape === "rectangle" ? null : b.inset,
    b.shape === "stepped" ? b.mirrored : null,
    b.shape === "stepped" || b.shape === "waisted" || b.shape === "tee"
      ? b.shoulder
      : null,
  ];
  const atmosphere = [
    d.floors.map((f) => [f.roomTypes, f.furnitureDensity, f.power]),
    d.city.palette,
    d.exterior.skyline,
  ];
  const spatial = [
    footprint,
    d.floors.map((f) => [f.family, f.roomOrder]),
    d.city.roadWidth,
    d.city.boulevardOffset,
    d.city.districtSize,
  ];
  // Absent on older designs so their historical summaries stay byte-stable.
  if (d.setting) {
    const { roofFeatures, ...exterior } = d.setting.exterior;
    spatial.push({
      venue: d.setting.venue,
      roof: roofFeatures.map((f) => [
        f.kind,
        Math.round(f.x * 5),
        Math.round(f.y * 5),
      ]),
    });
    atmosphere.push({
      venue: d.setting.venue,
      interior: d.setting.interior,
      exterior,
      // Composed objects by silhouette, so a renamed copy is not a new idea.
      objects: d.setting.objects.map((o) => [
        o.weight,
        Math.round(o.size.w * 4),
        Math.round(o.size.d * 4),
        Math.round(o.size.h * 4),
        o.parts.map((p) => p.shape).sort(),
      ]),
      filler: d.setting.filler,
      surroundings: d.setting.surroundings,
      props: d.setting.props.map((o) => o.parts.map((p) => p.shape).sort()),
    });
    // Carved room shapes change the spatial plan, not just its look.
    if (d.floors.some((f) => f.roomShapes))
      spatial.push(d.floors.map((f) => f.roomShapes ?? null));
    // An open site is a different place, not just a different look. Only the
    // open form is recorded, so enclosed summaries stay byte-stable.
    if (d.setting.form === "open") spatial.push("open-site");
  }
  if (d.version >= 2) {
    const rooms = d.floors.flatMap((f) => f.scene.rooms),
      furniture = rooms.flatMap((r) => r.furniture),
      props = furniture.flatMap((o) => o.props),
      counts = (items) => {
        const result = {};
        for (const item of items)
          result[item.kind] = (result[item.kind] ?? 0) + 1;
        return result;
      };
    // IDs, labels, tabletop decoration and tiny nudges cannot disguise the same
    // physical plan. Compare room-relative fifths and 30-degree heading bins.
    spatial.push(
      runDesignFingerprint(
        d.floors.map((f) =>
          [...f.scene.rooms]
            .sort((a, b) => a.room - b.room)
            .map((r) => [
              r.room,
              r.furniture
                .map((o) => [
                  o.kind,
                  Math.round(o.at.x * 5),
                  Math.round(o.at.y * 5),
                  Math.round((o.angle < 0 ? o.angle + 360 : o.angle) / 30) % 12,
                ])
                .sort((a, b) => {
                  const left = canonical(a),
                    right = canonical(b);
                  return left < right ? -1 : left > right ? 1 : 0;
                }),
            ]),
        ),
      ),
    );
    // Keep history bounded while exposing useful palette/catalog choices.
    // The signature also covers individual owners, arrangements and text.
    atmosphere.push({
      scene: runDesignFingerprint(d.floors.map((f) => f.scene)),
      rooms: rooms.map((r) => [r.room, r.condition, r.palette]),
      furniture: counts(furniture),
      props: counts(props),
    });
  }
  return {
    title: d.title,
    premise: d.premise,
    spatial: canonical(spatial),
    atmosphere: canonical(atmosphere),
    cast: canonical(d.version === 3 ? [d.roster, d.relationships] : d.roster),
    tempo: canonical(d.pacing),
  };
}
export function runDesignNoveltyErrors(design, recent) {
  const next = summarizeRunDesign(design),
    errors = [];
  for (const previous of recent) {
    if (next.spatial === previous.spatial)
      errors.push(
        `Change the building/floor arrangement or street layout from "${previous.title}"; a new seed/name alone is insufficient.`,
      );
    const changes = ["atmosphere", "cast", "tempo"].filter(
      (key) => next[key] !== previous[key],
    ).length;
    if (changes < 2)
      errors.push(
        `Vary at least two of atmosphere, cast and pacing from "${previous.title}".`,
      );
    if (
      next.title.trim().toLowerCase() === previous.title.trim().toLowerCase() ||
      next.premise.trim().toLowerCase() ===
        previous.premise.trim().toLowerCase()
    )
      errors.push(
        `Give this run a new title and premise, distinct from "${previous.title}".`,
      );
  }
  return errors;
}
export function parseRunDesignRequest(v) {
  if (v?.version === 3) return parseQualityRequest(v);
  if (v?.version === 2) return parsePhasedRequest(v);
  // Composable maximum: five summaries, one valid candidate and repair errors.
  bounded(v, v?.designVersion === 2 ? 640000 : 512000);
  requireThat(record(v), "request must be an object");
  object(
    v,
    [
      "version",
      "requestId",
      "generationId",
      "seed",
      "recent",
      ...(Object.hasOwn(v, "designVersion") ? ["designVersion"] : []),
      ...(Object.hasOwn(v, "repair") ? ["repair"] : []),
    ],
    "request",
  );
  requireThat(v.version === 1, "unsupported request version");
  if (Object.hasOwn(v, "designVersion"))
    requireThat(v.designVersion === 2, "designVersion must be 2 when supplied");
  for (const k of ["requestId", "generationId"]) {
    text(v[k], 128, k);
    requireThat(
      /^design-[a-zA-Z0-9-]+$/u.test(v[k]),
      `${k} needs a design- identifier`,
    );
  }
  uint(v.seed, "seed");
  array(v.recent, 0, 5, "recent", (s, p) => {
    object(
      s,
      ["title", "premise", "spatial", "atmosphere", "cast", "tempo"],
      p,
    );
    text(s.title, 64, `${p}.title`);
    text(s.premise, 240, `${p}.premise`);
    for (const k of ["spatial", "atmosphere", "cast", "tempo"])
      text(s[k], 3500, `${p}.${k}`);
  });
  if (v.repair) {
    object(v.repair, ["candidate", "errors"], "repair");
    const candidate = parseRunDesign(v.repair.candidate);
    requireThat(
      candidate.version === (v.designVersion ?? 1),
      "repair candidate version does not match the requested design version",
    );
    array(v.repair.errors, 1, 20, "repair.errors", (s, p) => text(s, 400, p));
  }
  return clone(v);
}
export function parseRunDesignReply(v, request) {
  if (request.version === 3) return parseQualityReply(v, request);
  if (request.version === 2)
    return request.phase === "structure"
      ? parseRunStructureReply(v, request)
      : parseRunContentReply(v, request);
  object(v, ["requestId", "design"], "reply");
  requireThat(
    v.requestId === request.requestId,
    "reply requestId does not match",
  );
  const design = parseRunDesign(v.design);
  requireThat(
    design.version === (request.designVersion ?? 1),
    "reply design version does not match the requested design version",
  );
  return { requestId: v.requestId, design };
}
function parsePhasedRequest(v) {
  bounded(v, 1500000);
  choice(v.phase, ["structure", "content"], "phase");
  requireThat(
    v.designVersion === 3,
    "version 2 requests require designVersion 3",
  );
  const content = v.phase === "content";
  object(
    v,
    [
      "version",
      "designVersion",
      "phase",
      "requestId",
      "generationId",
      "seed",
      ...(content
        ? [
            "structure",
            "structureFingerprint",
            "builderVersion",
            "surfaces",
            "surfaceFingerprint",
            "recentContent",
          ]
        : ["recent"]),
      ...(Object.hasOwn(v, "repair") ? ["repair"] : []),
    ],
    "request",
  );
  for (const k of ["requestId", "generationId"]) {
    text(v[k], 128, k);
    requireThat(
      /^design-[a-zA-Z0-9-]+$/u.test(v[k]),
      `${k} needs a design- identifier`,
    );
  }
  uint(v.seed, "seed");
  if (content) {
    const structure = parseRunStructure(v.structure);
    requireThat(
      v.structureFingerprint === runStructureFingerprint(structure),
      "content structure fingerprint mismatch",
    );
    text(v.builderVersion, 64, "builderVersion");
    const surfaces = parseEnvironmentSurfaces(
      v.surfaces,
      structure.roster.map((a) => a.name),
    );
    requireThat(
      v.surfaceFingerprint === environmentSurfaceFingerprint(surfaces),
      "content surface fingerprint mismatch",
    );
    parseEnvironmentSummaries(v.recentContent);
  } else {
    parseRunDesignRequest({
      version: 1,
      requestId: v.requestId,
      generationId: v.generationId,
      seed: v.seed,
      recent: v.recent,
    });
  }
  if (v.repair) {
    object(v.repair, ["candidate", "errors"], "repair");
    if (content)
      parseEnvironmentRepairCandidate(
        v.repair.candidate,
        v.structure,
        v.surfaces,
      );
    else parseRunStructure(v.repair.candidate);
    array(v.repair.errors, 1, 20, "repair.errors", (s, p) => text(s, 400, p));
  }
  return clone(v);
}
export function parseRunStructureReply(v, request) {
  requireThat(
    request.version === 2 && request.phase === "structure",
    "not a structural request",
  );
  object(v, ["requestId", "structure"], "reply");
  requireThat(
    v.requestId === request.requestId,
    "reply requestId does not match",
  );
  return { requestId: v.requestId, structure: parseRunStructure(v.structure) };
}
export function parseRunContentReply(v, request) {
  requireThat(
    request.version === 2 && request.phase === "content",
    "not a content request",
  );
  object(v, ["requestId", "content"], "reply");
  requireThat(
    v.requestId === request.requestId,
    "reply requestId does not match",
  );
  return {
    requestId: v.requestId,
    content: parseEnvironmentContent(
      v.content,
      request.structure,
      request.surfaces,
    ),
  };
}
export function parseRunContentRepairCandidate(v, request) {
  requireThat(
    request.version === 2 && request.phase === "content",
    "not a content request",
  );
  object(v, ["requestId", "content"], "reply");
  requireThat(
    v.requestId === request.requestId,
    "reply requestId does not match",
  );
  return parseEnvironmentRepairCandidate(
    v.content,
    request.structure,
    request.surfaces,
  );
}
function canonical(v) {
  return JSON.stringify(v, (_key, x) =>
    record(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  );
}
export function runDesignFingerprint(d) {
  const text = canonical(d);
  let a = 2166136261,
    b = 3335557771;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 16777619) >>> 0;
    b = Math.imul(b ^ text.charCodeAt(i), 2246822519) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}
export function parseSavedRunDesign(v) {
  object(
    v,
    ["version", "source", "requestId", "generationId", "fingerprint", "design"],
    "saved design",
  );
  requireThat(v.version === 1, "unsupported saved design");
  choice(v.source, ["chatgpt-handoff", "claude-cli", "fixture"], "source");
  text(v.requestId, 128, "requestId");
  text(v.generationId, 128, "generationId");
  const design = parseRunDesign(v.design);
  requireThat(
    v.fingerprint === runDesignFingerprint(design),
    "saved design fingerprint mismatch",
  );
  return { ...clone(v), design };
}

export const RUN_DESIGN_GUIDANCE = `${qualityGuidance()}\n\nThe exact captured request selects both version and phase. For request.version:2/designVersion:3/phase:structure, return exactly {requestId,structure:{version:3,...}}. The flattened structure uses the structural fields described below, but OMIT every floors[].stories and exterior.streetLabels. Include relationships:1..24 {from:exact roster name,to:another exact roster name,kind:colleague|friend|relative|mentor|rival,detail:1..120}; one relationship per person pair. Every floor scene has version:2 with the scene layout below, but OMIT furniture.label and prop.label/text. Room title/description and exterior names remain thematic context for later writing. This first phase creates geometry and cast only; never include environment or content. Structure≤100000 UTF-8 bytes. The engine constructs an isolated candidate, then requests content for its exact physical surfaces. For phase:content, follow the following separate content contract instead of returning any structural fields:\n${ENVIRONMENT_GUIDANCE}\n
The remainder describes the shared structural schema and retained legacy requests. For retained request.version:1, return exactly {requestId:the captured requestId,design:{...}} following its designVersion; never upgrade that request. Design a distinctive fictional zombie-escape building as JSON, not a study question. The building is the specific place the premise is set in (a radio station, clinic, hotel, archive, office and so on): its venue, rooms, furniture, finishes, signage and exterior must all read as that place. Do not output code, HTML, URLs, learner claims or mechanical rule changes. The engine realizes your choices as collision-tested geometry. Give every floor its own coherent purpose and story; tie signs and notes to this cast and premise. Vary actual spatial choices, furnishing, cast, atmosphere and tempo, not only names or random seeds. Recent fictional summaries identify designs to avoid. If repair is supplied, correct all listed failures while retaining the intended theme. Do not conceal an invalid plan or claim validation was performed.

For retained request.version:1 only: If payload.designVersion is 2, return design.version:2 and include the scene objects below. If designVersion is absent, return design.version:1 and OMIT scene on every floor. Never upgrade a retained request or downgrade a version 2 request. Version3 structure requests use the exceptions stated above. setting and the tapered, notched and tee silhouettes belong to version 3 structures only: retained version 1 and 2 designs must omit setting and use rectangle, chamfered, stepped or waisted.

The common required design fields and bounds are:
version:as requested above; title(1-64 characters), premise(1-240), opening(1-200), roofName(1-48).
footprint:{shape:${FOOTPRINT_SHAPES.join("|")},width:36|38|40,top:integer2..4,inset:integer2..4,mirrored:boolean,shoulder:integer top+8..top+14}. The footprint is the building's silhouette seen from above and from the street: rectangle is a plain block; chamfered cuts all four corners by inset; stepped narrows one side by inset beyond the shoulder row (mirrored picks the side); waisted pinches both sides by inset around the shoulder row; tapered narrows steadily from the full-width entrance front to a back narrower by inset on each side; notched cuts square inset notches into all four corners; tee keeps a full-width back block and a front wing narrower by inset on each side from the shoulder row. Choose the silhouette that suits this building.
${SETTING_GUIDANCE}
floors:exactly4 entries in ascending order for an enclosed site and exactly1 (the ground plan) for an open one, each {name(1-48),family:stack|columns|serpentine,roomOrder:permutation[0,1,3],layoutSeed:uint32,roomTypes:4 entries indexed rooms0..3 each break|cubicles|meeting|storage|reception|manager (their meaning follows setting.venue),subroomKinds:1..4 unique entries office|meeting|storage|break,furnitureDensity:0.5..1.5,fieldQuotas:4 integers2..6 indexed rooms0..3 (the public entrance to room2 is always free; its outgoing field uses quota2),power:4 entries lit|dim|outage indexed rooms0..3 with room2 lit,stories:exactly6 {title(1-36),lines:1..4 strings each1-50},brokenGuard:{segment:3|4,bay:1|2}}. The six story cards are three wall posters, a whiteboard, a desk photo caption and a desk note. These are actual visible words, not instructions to a renderer. layoutSeed fills smaller geometrical details; family/order are your direct choices. Each ordinary floor keeps all four study rooms along the route; no bypasses. Free hall and entry remain readable. An open site furnishes its one floor's four rooms as outdoor zones (stall rows, plazas, pens, terraces) bounded by low fences, stalls and kerbs rather than walls, with its terminals in the open and roofName naming the ground extraction point; setting.form must match the premise, so open-air places are open and buildings are enclosed.
Version3 floors also take roomShapes:4 entries indexed rooms0..3 each ${ROOM_SHAPES.join("|")}: how that study room and its sub-rooms are carved from the grid (chamfered cuts the corners at 45°, rounded curves them, octagon makes eight-sided rooms; rect keeps square corners). The engine keeps every route, terminal and exit valid and may square off a corner that would block one. Optional doors, on any floor: doors:exactly4 DoorDesign where doors[r] is the door leading out of room r and doors[2] also covers the hall entrance, and mainDoor:DoorDesign at the top level for the building's main entrance. DoorDesign:{material:wood|steel|glass|fire|security,color:hex,accent:hex,window:none|slit|half|full,label:1..32 short name shown to the player,health:integer400..2400 starting hit points}. Vary doors so they fit each room and the premise. Glass, half and full windows can be seen through when closed, and doors close themselves when zombies come near. The engine always keeps door access rules and can raise the hall entrance's health to protect study time.
Include titleCard at the top level of every new design (it is optional only so older designs stay valid): {title:TitleStyle,story:TitleStyle}. The game opens on a pure black screen showing the run's title in the title style, then the premise and opening as the scene-setting backstory in the story style, with a Start button beneath. TitleStyle:{font:one of ${Object.keys(TITLE_CARD_FONTS).join("|")},color:six-digit hex readable on pure black (WCAG contrast at least 3 for title and 4.5 for story),size:integer pixels (title ${TITLE_CARD_SIZES.title[0]}..${TITLE_CARD_SIZES.title[1]}, story ${TITLE_CARD_SIZES.story[0]}..${TITLE_CARD_SIZES.story[1]})}. Choose the font, color and size of each so the card sets this premise's particular mood; vary them between runs instead of always choosing the same look, and keep the story readable as several sentences of body text.
roster:exactly19 {name:unique1-20 characters distinct from You,role:builder|analyst|rusher|medic|skeptic,skill:0.4..0.9,risk:0.2..0.8,social:0.2..0.8}. Build a varied ensemble; names referenced in stories must belong to it.
city:{roadWidth:integer7..9,boulevardOffset:integer15..19,districtSize:integer18..25,buildingHeightMin:9..18,buildingHeightMax:25..45,damageRate:0..0.7,palette:3..6 six-digit hex colors}.
exterior:{buildingName,buildingSubtitle,quarantineTitle,quarantineSubtitle:each1-48 characters,streetLabels:exactly8 strings1-28 characters,skyline:{minHeight:24..60,maxHeight:72..140,damageRate:0..0.7}}. All heights are metres.
pacing:{swarmInterval:2.5..4,swarmBatch:integer1..2,swarmCap:integer120..220,npcThinkingScale:0.2..0.35,firstHelicopter:420..600,helicopterInterval:150..210}. Times are seconds.

Version 2 additionally requires scene:{version:1,rooms:[exactly4 RoomScene objects]} on EVERY floor. Author distinct, coherent room scenes connected to the premise and survivors. These are actual placed objects, not prose instructions. RoomScene:{room:integer0..3 unique,title:1..40,description:1..160,owner:exact roster name|null,palette:{surface,metal,accent:each six-digit hex color},condition:kept|worn|ransacked,furniture:1..6 SceneFurniture}. Room conditions are visual atmosphere, not permission to invent hazards or mechanical rules. Across each floor allow at most16 authored furniture items and48 props, and every room needs at least one prop.
SceneFurniture:{id:lowercase slug1..24 unique within its floor,kind:${SCENE_FURNITURE_KINDS.join("|")},at:{x:0..1,y:0..1},angle:-180..180 degrees,color:hex,condition:intact|worn|damaged,owner:exact roster name|null,label:0..40,props:0..8 SceneProp}. Furniture at is the intended normalized point within its study room. The engine finds the nearest valid room position with your angle, keeping terminals, doorways, stairs and credentialed egress clear. It rejects impossible scenes for repair; it never silently removes an authored item. Intact furniture starts at full health, worn at85%, damaged at45%; dimensions, weight and behavior come from the engine's catalog. Use modest groups of meaningful furniture, varying real arrangements and routes as well as their stories. Furnish from the venue and your own setting.objects: a broadcast building (the ready-made venue for radio, television and recording premises) needs mixingConsole, micStand, recordShelf, turntable, studioMonitor, equipmentRack, soundPanel, onAirLight and reelToReel where they belong (an onAirLight is a lit sign on a floor stand; the words it shows are written later with the other surface text, so never include label in the structure), with headphones, record and cassette props, not printers, cubicles and vending machines; any other kind of place, real or fantastical, should get composed objects that only it would have.
SceneProp:{id:lowercase slug1..24 unique within its floor,kind:${Object.keys(PROP_CATALOG).join("|")},at:{x:-1..1,y:-1..1},angle:-180..180 degrees,scale:0.65..1.25,color:hex,accent:hex,condition:intact|worn|damaged,owner:exact roster name|null,label:0..32,text:0..160}. Labels and text are printed on the object; do not repeat the same caption everywhere. Match objects and notes to their owner and room story. Props may only be hosted by ${SCENE_SURFACE_KINDS.join(",")}; all other furniture must have props:[]. Prop at is relative to its host's top:0 is centered,-1/+1 approach the edges. The engine fits the complete rotated object on that surface and performs bounded nearby packing if needed. Small props are attached cosmetic details; they move with the furniture and do not create separate invisible collision boxes. Their conditions are visual. Every furniture and prop id shares one floor-local namespace. IDs start with a letter and otherwise use lowercase letters,digits,hyphens. Owners must match the supplied roster exactly, or be null. Palette and object colors must be six-digit hex values.

The engine always preserves the 180-second opening, safe terminal capacity, door access, climb credentials, real physics and curriculum rules. Avoid signs that contradict these rules. No additional fields. Strings must be printable single lines. Version 1 design must be below24000 UTF-8 bytes; version 2 below100000. Vary physical furniture kinds and visibly different normalized arrangements, not merely ids, colors, tiny position/angle nudges or tabletop props, when a recent spatial plan needs to change.`;
