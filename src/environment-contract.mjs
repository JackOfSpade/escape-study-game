// Fictional environmental inscriptions and drawings. Shared by the browser and the bridge server;
// this module accepts data only and never interprets HTML, SVG, URLs or code.
const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const fail = (ok, message) => {
  if (!ok) throw Error(`Run environment: ${message}`);
};
const clone = (v) => JSON.parse(JSON.stringify(v));
function object(v, keys, p) {
  fail(record(v), `${p} must be an object`);
  fail(
    Object.keys(v).every((k) => keys.includes(k)) &&
      keys.every((k) => Object.hasOwn(v, k)),
    `${p} has missing or unknown fields`,
  );
}
function text(v, min, max, p) {
  fail(
    typeof v === "string" &&
      v.length <= max &&
      (min === 0 || v.trim().length >= min) &&
      !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(v),
    `${p} needs ${min}–${max} printable characters`,
  );
}
function number(v, min, max, p, integer = false) {
  fail(
    typeof v === "number" &&
      Number.isFinite(v) &&
      v >= min &&
      v <= max &&
      (!integer || Number.isInteger(v)),
    `${p} must be ${integer ? "an integer " : ""}between ${min} and ${max}`,
  );
}
function array(v, min, max, p, check) {
  fail(
    Array.isArray(v) && v.length >= min && v.length <= max,
    `${p} needs ${min}–${max} entries`,
  );
  v.forEach((x, i) => check(x, `${p}[${i}]`));
}
function choice(v, values, p) {
  fail(values.includes(v), `${p} has an unsupported value`);
}
function bounded(v, n, p) {
  fail(
    new TextEncoder().encode(JSON.stringify(v)).length <= n,
    `${p} exceeds ${n} bytes`,
  );
}
const color = (v, p) =>
  fail(
    typeof v === "string" && /^#[a-f0-9]{6}$/iu.test(v),
    `${p} needs a six-digit hex color`,
  );
const id = (v, p) => {
  text(v, 1, 128, p);
  fail(
    /^[a-zA-Z0-9][a-zA-Z0-9_./:@+-]*$/u.test(v),
    `${p} needs a stable identifier`,
  );
};
const canonical = (v) =>
  JSON.stringify(v, (_k, x) =>
    record(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  );
const fingerprint = (v) => {
  const s = canonical(v);
  let a = 2166136261,
    b = 3335557771;
  for (let i = 0; i < s.length; i++) {
    a = Math.imul(a ^ s.charCodeAt(i), 16777619) >>> 0;
    b = Math.imul(b ^ s.charCodeAt(i), 2246822519) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
};
export const ENVIRONMENT_LIMITS = Object.freeze({
  contentBytes: 512000,
  manifestBytes: 750000,
  surfaces: 1024,
  surfaceBytes: 220000,
  fragments: 16,
  drawingPrimitives: 2048,
  drawingPoints: 8192,
});
export const ENVIRONMENT_FACTS = Object.freeze({
  "rooftop-extraction": "Helicopter extraction is on the roof.",
  "no-street-extraction": "There is no street extraction.",
  "stairs-require-floor-clearance":
    "Complete a floor terminal before ascending its emergency stairs.",
});
const roles = [
  "wall-poster",
  "wall-whiteboard",
  "desk-papers",
  "desk-photo",
  "desk-note",
  "furniture-whiteboard",
  "furniture-label",
  "prop-face",
  "room-plaque",
  "building-sign",
  "quarantine-sign",
  "storefront-sign",
  "street-sign",
  "graffiti",
];
export function environmentSurfaceFingerprint(surfaces) {
  return fingerprint(surfaces);
}
export function parseEnvironmentSurfaces(value, rosterNames) {
  bounded(value, ENVIRONMENT_LIMITS.surfaceBytes, "surfaces");
  const ids = new Set();
  array(value, 1, ENVIRONMENT_LIMITS.surfaces, "surfaces", (s, p) => {
    object(
      s,
      [
        "id",
        "floor",
        "scope",
        "role",
        "room",
        "owner",
        "binding",
        "context",
        "maxTitle",
        "maxBody",
        "allowsArt",
      ],
      p,
    );
    id(s.id, `${p}.id`);
    fail(!ids.has(s.id), `${p}.id is duplicated`);
    ids.add(s.id);
    number(s.floor, 0, 4, `${p}.floor`, true);
    choice(s.scope, ["interior", "exterior"], `${p}.scope`);
    choice(s.role, roles, `${p}.role`);
    fail(
      s.room === null || [0, 1, 2, 3].includes(s.room),
      `${p}.room is invalid`,
    );
    if (s.owner !== null) {
      text(s.owner, 1, 20, `${p}.owner`);
      if (rosterNames)
        fail(rosterNames.includes(s.owner), `${p}.owner is not in the roster`);
    }
    text(s.context, 0, 240, `${p}.context`);
    number(s.maxTitle, 0, 48, `${p}.maxTitle`, true);
    number(s.maxBody, 0, 240, `${p}.maxBody`, true);
    fail(typeof s.allowsArt === "boolean", `${p}.allowsArt must be boolean`);
    fail(
      s.maxTitle + s.maxBody > 0 || s.allowsArt,
      `${p} has no content capacity`,
    );
    const b = s.binding;
    choice(b?.kind, ["fixed", "furniture", "prop"], `${p}.binding.kind`);
    object(
      b,
      [
        "kind",
        "x",
        "y",
        "z",
        "yaw",
        "pitch",
        "width",
        "height",
        ...(b.kind !== "fixed" ? ["furnitureId"] : []),
        ...(b.kind === "prop" ? ["propId"] : []),
      ],
      `${p}.binding`,
    );
    for (const k of ["x", "y"]) number(b[k], -2000, 2000, `${p}.binding.${k}`);
    number(b.z, -5, 40, `${p}.binding.z`);
    for (const k of ["yaw", "pitch"])
      number(b[k], -Math.PI * 2, Math.PI * 2, `${p}.binding.${k}`);
    number(b.width, 0.005, 12, `${p}.binding.width`);
    number(b.height, 0.005, 8, `${p}.binding.height`);
    if (b.kind !== "fixed") id(b.furnitureId, `${p}.binding.furnitureId`);
    if (b.kind === "prop") id(b.propId, `${p}.binding.propId`);
  });
  return clone(value);
}
const fragmentText = (f) =>
  !f ? "" : f.kind === "direction" ? ENVIRONMENT_FACTS[f.fact] : f.text;
export function expandContentText(parts, fragments) {
  const byId = new Map(fragments.map((f) => [f.id, f]));
  return parts
    .map((p) => ("text" in p ? p.text : fragmentText(byId.get(p.fragmentId))))
    .join("");
}
export function normalizeEnvironmentText(value) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\p{Cf}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}
function shingles(value) {
  const words = value.split(" ");
  return new Set(words.slice(1).map((w, i) => `${words[i]} ${w}`));
}
function similarity(A, B) {
  let common = 0;
  for (const x of A) if (B.has(x)) common++;
  return common / Math.max(1, A.size + B.size - common);
}
const characterGrams = (s) =>
  new Set(
    Array.from({ length: Math.max(0, s.length - 2) }, (_, i) =>
      s.slice(i, i + 3),
    ),
  );
function editSimilarity(a, b, A, B) {
  if (Math.min(a.length, b.length) / Math.max(a.length, b.length) < 0.85)
    return 0;
  // Disjoint prose must not enter the quadratic edit-distance calculation.
  // This also keeps large Unicode manifests inexpensive to validate offline.
  let common = 0;
  for (const g of A) if (B.has(g)) common++;
  if (common / Math.max(1, Math.min(A.size, B.size)) < 0.65) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(
        row[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = row;
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}
/** Compare visible writing and accessible drawing descriptions across objects.
 * Same-object reuse is harmless. Shared art captions require identical drawing
 * data and an explicit shared fragment reference, not merely similar subjects. */
export function environmentDuplicateErrors(content) {
  const seen = [],
    errors = [];
  for (const entry of content.entries) {
    const own = (parts) =>
      parts
        .filter((p) => "text" in p)
        .map((p) => p.text)
        .join("");
    const full = normalizeEnvironmentText(
        `${own(entry.title)} ${own(entry.body)}`,
      ),
      body = normalizeEnvironmentText(own(entry.body)),
      description = entry.drawing
        ? normalizeEnvironmentText(entry.description)
        : "",
      drawing = entry.drawing ? canonical(entry.drawing) : undefined,
      shared = new Set(
        [...entry.title, ...entry.body]
          .filter(
            (p) =>
              "fragmentId" in p &&
              content.fragments.some(
                (f) =>
                  f.id === p.fragmentId && f.surfaces.includes(entry.surfaceId),
              ),
          )
          .map((p) => p.fragmentId),
      );
    const candidates = [
      { text: full, field: "writing" },
      ...(body.length >= 8 && body !== full
        ? [{ text: body, field: "body" }]
        : []),
      ...(description ? [{ text: description, field: "description" }] : []),
    ]
      .filter((v) => v.text)
      .map(({ text, field }) => ({
        text,
        field,
        words: shingles(text),
        tokens: new Set(text.split(" ")),
        grams: characterGrams(text),
      }));
    for (const prior of seen) {
      let duplicate;
      for (const a of candidates)
        for (const b of prior.values) {
          if (
            a.field === "description" &&
            b.field === "description" &&
            a.text === b.text &&
            drawing &&
            drawing === prior.drawing &&
            [...shared].some((id) => prior.shared.has(id))
          )
            continue;
          if (
            a.text === b.text ||
            (Math.min(a.text.length, b.text.length) >= 40 &&
              (similarity(a.words, b.words) >= 0.78 ||
                (Math.min(a.tokens.size, b.tokens.size) >= 8 &&
                  similarity(a.tokens, b.tokens) >= 0.9) ||
                editSimilarity(a.text, b.text, a.grams, b.grams) >= 0.88))
          ) {
            duplicate = [a.field, b.field];
            break;
          }
        }
      if (duplicate) {
        errors.push(
          `Distinct writing required for ${prior.id}.${duplicate[1]} and ${entry.surfaceId}.${duplicate[0]}; use an explicit shared fragment only for intentional branding, direction or connected clues.`,
        );
        break;
      }
    }
    seen.push({ id: entry.surfaceId, values: candidates, drawing, shared });
  }
  return errors;
}

/** The same normalized exact/near-copy policy used by in-run duplicate checks. */
export function environmentTextIsNearCopy(left, right) {
  const a = normalizeEnvironmentText(left),
    b = normalizeEnvironmentText(right);
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 40) return false;
  const A = new Set(a.split(" ")),
    B = new Set(b.split(" "));
  return (
    similarity(shingles(a), shingles(b)) >= 0.78 ||
    (Math.min(A.size, B.size) >= 8 && similarity(A, B) >= 0.9) ||
    editSimilarity(a, b, characterGrams(a), characterGrams(b)) >= 0.88
  );
}

const mechanicClaims = [
  /\b(?:do not|don t) need (?:any )?(?:keys?|clearance|permission|terminal completion)\b/u,
  /\bno (?:keys?|clearance|permission|terminal(?: completion)?|access) (?:is |are )?(?:needed|required|necessary)\b/u,
  /\b(?:keys?|clearance|permission|terminal(?: completion)?) (?:is |are )?(?:not|never) (?:needed|required|necessary)\b/u,
  /\b(?:climb|ascend|use|enter|cross|pass|go up)\b.{0,60}\b(?:stairs?|staircase|force fields?|red fields?|gates?)\b.{0,60}\b(?:without|no|free|unrestricted)\b/u,
  /\b(?:stairs?|staircase) (?:is|are|remain|stay) (?:free|unlocked|open to everyone|unrestricted)\b/u,
  /\b(?:climbing|ascending) is free\b|\b(?:climb|ascend) (?:for )?free\b/u,
  /\b(?:stairs?|staircase|climbing|ascending)\b.{0,30}\b(?:needs? no|requires? no|does not require|doesn t require)\b/u,
  /\b(?:force fields?|red fields?|green fields?)\b.{0,28}\b(?:can|may|will|always|never|require|requires|need|needs|allow|allows|grant|grants|give|gives|passable|harmless|disabled)\b/u,
  /\b(?:bypass|disable|unlock|open|cross|pass|jump|vault|walk|run|push|break|shoot)\b.{0,48}\b(?:force fields?|red fields?|green fields?)\b/u,
  /\b(?:read|reading|touch|touching|collect|collecting|click|clicking|follow|following|this note|this poster|this drawing|this sign)\b.{0,64}\b(?:grants?|gives?|awards?|earns?|get|receive|restores?|heals?|unlocks?)\b.{0,40}\b(?:keys?|access|health|hp|ammo|weapons?|rewards?|points?|credits?|shields?|speed|lives?)\b/u,
  /\b(?:keys?|health|hp|ammo|rewards?|points?|credits?|shields?|speed|lives?)\b.{0,30}\b(?:awarded|granted|earned|restored|unlocked)\b/u,
  /\b(?:grants?|awards?|unlocks?|restores?|heals?)\b.{0,25}\b(?:access|health|hp|keys?|ammo|weapons?|shields?|lives?)\b/u,
  /\b(?:zombies?|enemies?)\b.{0,40}\b(?:cannot|can not|never|won t|do not|don t)\b.{0,24}\b(?:hurt|attack|enter|cross|damage)\b/u,
  /\b(?:helicopter|extraction)\b.{0,24}\b(?:arrives|departs|takes|seats|grants|gives|awards)\b/u,
  /\b(?:escape|extraction|rescue) (?:is|happens|occurs|takes place) (?:in|on|at|from|through)\b/u,
];
const directInstruction =
  /^(?:please |remember to |always |just |simply |to escape )?(?:(?:you|players?|survivors?|anyone|everyone) (?:can |may |should |must |will |do not |don t |need not )?)?(?:climb|ascend|cross|pass|bypass|disable|unlock|open|jump|vault|use|enter|gain|earn|receive|get|collect|claim|award|grant|restore|heal|skip|solve|complete)\b/u;
const mechanicalObject =
  /\b(?:force fields?|red fields?|green fields?|stairs?|staircase|terminal|keys?|clearance|access|health|hp|ammo|weapons?|reward|points?|credits?|shields?|lives?)\b/u;
const ordinaryText = (parts, fragments) =>
  parts
    .map((p) => {
      if ("text" in p) return p.text;
      const f = fragments.find((f) => f.id === p.fragmentId);
      return f?.kind === "direction" ? "" : (f?.text ?? "");
    })
    .join("");

/** A conservative English-language guard for direct gameplay instructions and
 * rule/reward claims. It does not prove arbitrary natural-language semantics;
 * mundane stories about objects remain allowed, and mechanical facts use the
 * engine-approved typed fragments instead of author-controlled prose. */
export function environmentMechanicsErrors(content) {
  const errors = [],
    inspect = (value, where) => {
      const clauses = value.split(/[.!?;:\n]+/u).map(normalizeEnvironmentText);
      if (
        clauses.some(
          (s) =>
            mechanicClaims.some((p) => p.test(s)) ||
            (directInstruction.test(s) && mechanicalObject.test(s)),
        )
      )
        errors.push(
          `${where} contains a direct gameplay instruction or rule/reward claim. Keep ordinary narrative about the building and its people, or use an approved typed direction fact; do not invent access, bypasses or rewards.`,
        );
    };
  for (const f of content.fragments)
    if (f.kind !== "direction") inspect(f.text, `fragment ${f.id}`);
  for (const e of content.entries) {
    for (const field of ["title", "body"]) {
      const parts = e[field];
      if (
        parts.some(
          (p) =>
            "fragmentId" in p &&
            content.fragments.some(
              (f) => f.id === p.fragmentId && f.kind === "direction",
            ),
        ) &&
        parts.length !== 1
      )
        errors.push(
          `${e.surfaceId}.${field}: an approved direction fact must stand alone, without modifying or negating surrounding text.`,
        );
      inspect(
        ordinaryText(parts, content.fragments),
        `${e.surfaceId}.${field}`,
      );
    }
    inspect(e.description, `${e.surfaceId}.description`);
  }
  return errors;
}
function drawing(value, p, totals) {
  object(value, ["version", "background", "primitives"], p);
  fail(value.version === 1, `${p}.version is unsupported`);
  if (value.background !== "transparent")
    color(value.background, `${p}.background`);
  let points = 0;
  const point = (v, q) => {
    object(v, ["x", "y"], q);
    number(v.x, 0, 1, `${q}.x`);
    number(v.y, 0, 1, `${q}.y`);
    points++;
  };
  array(value.primitives, 1, 24, `${p}.primitives`, (v, q) => {
    choice(v?.kind, ["stroke", "rect", "ellipse", "polygon"], `${q}.kind`);
    object(
      v,
      v.kind === "stroke"
        ? ["kind", "points", "width", "color", "opacity"]
        : v.kind === "polygon"
          ? ["kind", "points", "fill", "stroke", "width", "opacity"]
          : [
              "kind",
              "x",
              "y",
              "w",
              "h",
              "rotation",
              "fill",
              "stroke",
              "width",
              "opacity",
            ],
      q,
    );
    number(v.width, 0.002, 0.08, `${q}.width`);
    number(v.opacity, 0.2, 1, `${q}.opacity`);
    if (v.kind === "stroke") {
      color(v.color, `${q}.color`);
      array(v.points, 2, 64, `${q}.points`, point);
    } else {
      if (v.fill !== null) color(v.fill, `${q}.fill`);
      if (v.stroke !== null) color(v.stroke, `${q}.stroke`);
      fail(v.fill !== null || v.stroke !== null, `${q} is invisible`);
      if (v.kind === "polygon") array(v.points, 3, 32, `${q}.points`, point);
      else {
        for (const k of ["x", "y"]) number(v[k], 0, 1, `${q}.${k}`);
        for (const k of ["w", "h"]) number(v[k], 0.002, 1, `${q}.${k}`);
        number(v.rotation, -180, 180, `${q}.rotation`);
        fail(
          v.x + v.w <= 1.000001 && v.y + v.h <= 1.000001,
          `${q} extends beyond the canvas`,
        );
      }
    }
  });
  fail(points <= 128, `${p} exceeds 128 points`);
  totals.primitives += value.primitives.length;
  totals.points += points;
}
function parseContent(
  value,
  structure,
  surfaces,
  repair = false,
  partial = false,
) {
  bounded(value, ENVIRONMENT_LIMITS.contentBytes, "content");
  object(
    value,
    ["version", "surfaceFingerprint", "fragments", "entries"],
    "content",
  );
  fail(value.version === 1, "unsupported content version");
  fail(
    typeof value.surfaceFingerprint === "string" &&
      /^[a-f0-9]{16}$/u.test(value.surfaceFingerprint),
    "content surface fingerprint is invalid",
  );
  const checked = parseEnvironmentSurfaces(
    surfaces,
    structure.roster.map((a) => a.name),
  );
  fail(
    repair ||
      value.surfaceFingerprint === environmentSurfaceFingerprint(checked),
    "surface fingerprint does not match the immutable inventory",
  );
  const slots = new Map(checked.map((s) => [s.id, s])),
    fragments = new Map(),
    usage = new Map();
  array(value.fragments, 0, 16, "fragments", (f, p) => {
    choice(f?.kind, ["branding", "direction", "clue"], `${p}.kind`);
    object(
      f,
      [
        "id",
        "kind",
        "reason",
        "surfaces",
        ...(f.kind === "direction" ? ["fact"] : ["text"]),
      ],
      p,
    );
    id(f.id, `${p}.id`);
    fail(
      f.id.length <= 32 && !fragments.has(f.id),
      `${p}.id is duplicated or too long`,
    );
    text(f.reason, 1, 120, `${p}.reason`);
    if (f.kind === "direction")
      choice(f.fact, Object.keys(ENVIRONMENT_FACTS), `${p}.fact`);
    else text(f.text, 1, 80, `${p}.text`);
    array(
      f.surfaces,
      2,
      f.kind === "clue" ? 6 : 24,
      `${p}.surfaces`,
      (s, q) => {
        id(s, q);
        fail(repair || slots.has(s), `${q} is not an inventory surface`);
      },
    );
    fail(
      new Set(f.surfaces).size === f.surfaces.length,
      `${p}.surfaces are duplicated`,
    );
    if (f.kind === "branding" && !repair)
      fail(
        f.surfaces.every((s) =>
          [
            "wall-poster",
            "furniture-label",
            "prop-face",
            "room-plaque",
            "building-sign",
            "quarantine-sign",
            "storefront-sign",
            "street-sign",
          ].includes(slots.get(s).role),
        ),
        `${p} branding needs a label, plaque, poster or sign`,
      );
    if (partial)
      fail(
        f.surfaces.every((member) => {
          const slot = slots.get(member);
          return (
            fragmentText(f).length <= Math.max(slot.maxTitle, slot.maxBody)
          );
        }),
        `${p} cannot fit every declared member surface`,
      );
    fragments.set(f.id, f);
    usage.set(f.id, new Set());
  });
  const ids = new Set(),
    totals = { primitives: 0, points: 0 },
    budgetErrors = [];
  array(
    value.entries,
    repair || partial ? 0 : checked.length,
    repair ? 1024 : checked.length,
    "entries",
    (e, p) => {
      object(
        e,
        ["surfaceId", "layout", "title", "body", "description", "drawing"],
        p,
      );
      id(e.surfaceId, `${p}.surfaceId`);
      const slot =
        slots.get(e.surfaceId) ??
        (repair
          ? { maxTitle: 1920, maxBody: 1920, allowsArt: true }
          : undefined);
      fail(
        slot && (repair || !ids.has(e.surfaceId)),
        `${p} has an unknown or duplicated surface`,
      );
      ids.add(e.surfaceId);
      choice(e.layout, ["text", "art", "mixed"], `${p}.layout`);
      text(e.description, 0, 160, `${p}.description`);
      for (const field of ["title", "body"]) {
        array(e[field], 0, 8, `${p}.${field}`, (part, q) => {
          object(
            part,
            Object.hasOwn(part ?? {}, "text") ? ["text"] : ["fragmentId"],
            q,
          );
          if ("text" in part) text(part.text, 1, 240, `${q}.text`);
          else {
            const f = fragments.get(part.fragmentId);
            id(part.fragmentId, `${q}.fragmentId`);
            fail(
              repair || (f && f.surfaces.includes(e.surfaceId)),
              `${q} references an undeclared fragment membership`,
            );
            if (f) usage.get(f.id).add(e.surfaceId);
          }
        });
        if (!repair) {
          const length = expandContentText(e[field], value.fragments).length;
          const limit = slot[field === "title" ? "maxTitle" : "maxBody"];
          if (length > limit)
            budgetErrors.push(
              `${p}.${field} for surface ${e.surfaceId} has ${length} characters and exceeds the surface's readable budget of ${limit}`,
            );
        }
      }
      const hasText = !!normalizeEnvironmentText(
        expandContentText(e.title, value.fragments) +
          " " +
          expandContentText(e.body, value.fragments),
      );
      if (e.layout === "text")
        fail(
          hasText && e.drawing === null,
          `${p} text layout requires writing and no drawing`,
        );
      else {
        fail(
          slot.allowsArt && e.drawing !== null,
          `${p} needs an eligible drawing`,
        );
        fail(
          e.description.trim().length > 0,
          `${p} drawing needs an accessible description`,
        );
        fail(
          e.layout === "mixed" ? hasText : !hasText,
          `${p} does not match its layout`,
        );
        drawing(e.drawing, `${p}.drawing`, totals);
      }
    },
  );
  // Correcting one over-budget entry per attempt wastes the designer's few
  // repairs, so every over-budget title and body is reported together.
  if (budgetErrors.length)
    fail(
      false,
      `${budgetErrors.length} ${budgetErrors.length === 1 ? "entry exceeds its" : "entries exceed their"} surface's readable budget: ${budgetErrors.slice(0, 20).join("; ")}${budgetErrors.length > 20 ? `; and ${budgetErrors.length - 20} more` : ""}; shorten each to its limit`,
    );
  for (const f of value.fragments)
    fail(
      repair ||
        (partial
          ? f.surfaces.every(
              (member) => !ids.has(member) || usage.get(f.id).has(member),
            )
          : usage.get(f.id).size === f.surfaces.length),
      `fragment ${f.id} has unused members`,
    );
  fail(
    totals.primitives <= ENVIRONMENT_LIMITS.drawingPrimitives &&
      totals.points <= ENVIRONMENT_LIMITS.drawingPoints,
    "run drawing complexity exceeded",
  );
  if (!repair) {
    const errors = [
      ...environmentMechanicsErrors(value),
      ...environmentDuplicateErrors(value),
    ];
    fail(!errors.length, errors.slice(0, 20).join("; "));
  }
  return clone(value);
}
export function parseEnvironmentContent(value, structure, surfaces) {
  return parseContent(value, structure, surfaces);
}
/** Strict accumulating content: only entries and declared fragment members that
 * have not been authored yet may be absent. Never use this for accepted saves. */
export function parseEnvironmentPartialContent(value, structure, surfaces) {
  return parseContent(value, structure, surfaces, false, true);
}
export function parseEnvironmentRepairCandidate(value, structure, surfaces) {
  return parseContent(value, structure, surfaces, true);
}
export function parseEnvironmentManifest(value, structure) {
  bounded(value, ENVIRONMENT_LIMITS.manifestBytes, "environment");
  object(
    value,
    ["version", "surfaceFingerprint", "surfaces", "fragments", "entries"],
    "environment",
  );
  const { surfaces, ...content } = value;
  return {
    ...parseEnvironmentContent(content, structure, surfaces),
    surfaces: parseEnvironmentSurfaces(
      surfaces,
      structure.roster.map((a) => a.name),
    ),
  };
}
export function summarizeEnvironment(environment) {
  const phrases = environment.entries
    .flatMap((e) => [
      ordinaryText(e.title, environment.fragments),
      ordinaryText(e.body, environment.fragments),
    ])
    .map(normalizeEnvironmentText)
    .filter((s) => s.length >= 12);
  const drawings = new Map();
  for (const e of environment.entries)
    if (e.drawing) {
      const key = fingerprint(e.drawing);
      if (drawings.has(key) || drawings.size === 32) continue;
      const counts = {};
      for (const p of e.drawing.primitives)
        counts[p.kind] = (counts[p.kind] ?? 0) + 1;
      const composition = Object.entries(counts)
        .map(([kind, count]) => `${count} ${kind}`)
        .join(", ");
      drawings.set(
        key,
        `${e.description.slice(0, 110)} [${composition}]`.slice(0, 160),
      );
    }
  return {
    fingerprint: fingerprint(environment),
    phrases: [...new Set(phrases)]
      .sort((a, b) => b.length - a.length || a.localeCompare(b, "en"))
      .slice(0, 32)
      .map((s) => s.slice(0, 120)),
    art: [...drawings.keys()],
    artDescriptions: [...drawings.values()],
  };
}
export function parseEnvironmentSummaries(value) {
  // Five maximally JSON-escaped phrase/art-description histories fit together.
  bounded(value, 320000, "recent content");
  array(value, 0, 5, "recentContent", (s, p) => {
    object(
      s,
      [
        "fingerprint",
        "phrases",
        "art",
        ...(Object.hasOwn(s, "artDescriptions") ? ["artDescriptions"] : []),
      ],
      p,
    );
    fail(/^[a-f0-9]{16}$/u.test(s.fingerprint), `${p}.fingerprint is invalid`);
    array(s.phrases, 0, 32, `${p}.phrases`, (v, q) => text(v, 1, 120, q));
    array(s.art, 0, 32, `${p}.art`, (v, q) =>
      fail(/^[a-f0-9]{16}$/u.test(v), `${q} is invalid`),
    );
    if (Object.hasOwn(s, "artDescriptions")) {
      array(
        s.artDescriptions,
        s.art.length,
        s.art.length,
        `${p}.artDescriptions`,
        (v, q) => text(v, 1, 160, q),
      );
    }
  });
  return clone(value);
}
export const ENVIRONMENT_GUIDANCE = `For a content phase, author every exact supplied surfaceId once. Return {requestId,content:{version:1,surfaceFingerprint:the supplied fingerprint,fragments:[],entries:[]}}. Never alter the structure, inventory, owners, poses, geometry or rules. Read the fictional cast relationships and each slot context. Give different objects distinct, coherent writing. Vary subjects, wording, tone, length and presentation: mundane artifacts of this particular building's everyday work (the paperwork, schedules, logs, tickets, menus, rosters, recipes, charts or ledgers that this kind of place really produces, in its own jargon), lost-property notices and personal mementos should sit alongside evacuation and survivor narratives. Signs, labels and notes must read as written in the premise's venue, not a generic office. Give each room a coherent story about its prior occupants, tied to the supplied relationships and nearby objects. Avoid recentContent phrases and artwork subjects/compositions in artDescriptions; art hashes identify prior exact drawings, not permission to repeat them with another color or seed. No duplicated or lightly reworded passages, changed-title copies or numbered substitutes. SurfaceContent is {surfaceId,layout:text|art|mixed,title:TextPart[],body:TextPart[],description:0..160,drawing:Drawing|null}; TextPart is exactly {text:nonempty string} or {fragmentId:id}. Concatenate parts without automatic spaces. Respect each slot's maxTitle/maxBody character budgets. text layout needs writing and drawing:null; art needs an eligible drawing and no title/body; mixed needs both. Art needs a meaningful accessible description. Room titles/descriptions and exterior names in the structure are context, not already-authored surface text.
Intentional repetition must be explicit: at most16 fragments, each {id:1..32,kind:branding|clue,text:1..80,reason:1..120,surfaces:[exact member IDs]}; branding has2..24 label/plaque/poster/sign members, connected clue2..6 members. Each listed member must reference the fragment. Ordinary writing around shared fragments and accessible drawing descriptions must remain distinct across objects; an object may reuse its own words in its description. Identical drawing descriptions may repeat only for identical drawing data on surfaces that both explicitly reference the same declared branding, clue or direction fragment. This narrow exception supports an intentionally repeated logo or clue; a different drawing or merely matching subject is not exempt. A direction fragment instead uses {id,kind:direction,fact,reason,surfaces}; fact is rooftop-extraction|no-street-extraction|stairs-require-floor-clearance and prints the engine's fixed truthful wording. Put a direction fragment alone in its title or body field, without surrounding words that alter or negate it. A conservative validator rejects direct access/bypass/reward instructions and rule claims in ordinary prose, shared branding/clues and artwork descriptions; it is not a proof of arbitrary natural-language meaning. Mundane narrative references to keys and stairs are allowed. Never invent access rules, functional buttons, playable street exits or mechanical rewards. Existing mechanical signs remain engine-owned.
Create recognizable subject-specific drawings: portraits, botanical sketches, work diagrams, maps and personal doodles that fit the object and room. Vary subjects and compositions across objects and recent runs; do not substitute generic abstract patterns or merely recolor/rename an existing drawing. Drawing is {version:1,background:six-digit hex|transparent,primitives:[1..24]}. No text drawing operations, code, SVG, HTML, URLs or external assets. stroke:{kind:stroke,points:[{x,y}],width,color,opacity}; rect/ellipse:{kind,x,y,w,h,rotation,fill:hex|null,stroke:hex|null,width,opacity}; polygon:{kind:polygon,points,fill,stroke,width,opacity}. Coordinates0..1; rectangles x/y are top-left and must fit the canvas before rotation; rotations-180..180 degrees about center; width0.002..0.08; opacity0.2..1; colors six-digit hex. Stroke2..64 points; polygon3..32; each drawing≤128 points; whole run≤2048 primitives and8192 points. Text uses a fixed readable layout separate from artwork. Content≤512000 UTF-8 bytes; remain concise enough that the complete saved manifest including supplied surfaces fits750000 bytes. If repair is present, correct its named content failures without altering any captured structural input.`;
