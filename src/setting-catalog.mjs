// The run's physical setting: which kind of building the premise takes place
// in, its interior finishes and its exterior style. Shared by the offline
// validator, the world builder and both renderers. Every choice is bounded
// data: catalog names, colors, or AI-composed objects built from primitive
// parts. The engine still owns geometry, collisions, physics and access rules.

import { SCENE_FURNITURE_KINDS } from "./scene-catalog.mjs";

export const VENUES = Object.freeze(["office", "broadcast", "custom"]);
export const ROOM_FUNCTIONS = Object.freeze([
  "reception",
  "break",
  "cubicles",
  "meeting",
  "storage",
  "manager",
]);
/** Engine-owned physics for AI-composed objects: the designer only picks a
 * class. Health, push resistance and drag speed never come from the model. */
export const OBJECT_WEIGHTS = Object.freeze({
  light: Object.freeze({ hp: 140, speed: 1.5, resist: 25 }),
  medium: Object.freeze({ hp: 650, speed: 0.8, resist: 140 }),
  heavy: Object.freeze({ hp: 1800, speed: 0.4, resist: 320 }),
});
export const OBJECT_SHAPES = Object.freeze([
  "box",
  "cylinder",
  "cone",
  "sphere",
  "wedge",
  "torus",
]);
/** What an object is for. The furnishing planner arranges pieces by role
 * (seats around surfaces, storage along walls, dividers between work
 * positions) and never by guessing from a name or a size. */
export const OBJECT_ROLES = Object.freeze([
  "seat",
  "surface",
  "storage",
  "equipment",
  "display",
  "divider",
  "bed",
  "decor",
  "light",
]);
/** Roles of the built-in furniture kinds, so one planner serves both. */
export const BUILTIN_ROLES = Object.freeze({
  chair: "seat",
  officeChair: "seat",
  sofa: "seat",
  armchair: "seat",
  desk: "surface",
  table: "surface",
  cafeTable: "surface",
  coffeeTable: "surface",
  reception: "surface",
  mixingConsole: "surface",
  shelf: "storage",
  cabinet: "storage",
  drawers: "storage",
  recordShelf: "storage",
  box: "storage",
  fridge: "storage",
  vending: "storage",
  partition: "divider",
  soundPanel: "divider",
  whiteboard: "display",
  screen: "display",
  plant: "decor",
  onAirLight: "light",
  cooler: "equipment",
  printer: "equipment",
  coffeeMaker: "equipment",
  microwave: "equipment",
  micStand: "equipment",
  turntable: "equipment",
  studioMonitor: "equipment",
  equipmentRack: "equipment",
  reelToReel: "equipment",
});
/** The role of a built-in kind or of a composed object. */
export function furnitureRole(kind, object) {
  return object ? object.role : (BUILTIN_ROLES[kind] ?? "decor");
}
export const OBJECT_FINISHES = Object.freeze([
  "matte",
  "metal",
  "glass",
  "glow",
]);
/** Which way a cylinder or cone runs: up, across the width, or along the depth. */
export const OBJECT_AXES = Object.freeze(["up", "across", "along"]);
export const OBJECT_LIMITS = Object.freeze({
  objects: 24,
  parts: 24,
  totalParts: 400,
  size: Object.freeze({ w: [0.25, 4], d: [0.2, 3], h: [0.1, 3.2] }),
  minPart: 0.02,
  /** Bounds of one part's centre and extents, in the object's own frame. */
  part: Object.freeze({
    x: [-2, 2],
    y: [-1.5, 1.5],
    z: [0, 3.2],
    w: [0.02, 4],
    d: [0.02, 3],
    h: [0.02, 3.2],
  }),
});
/** Tolerance (metres) for parts touching or reaching the footprint edge. */
const SNAP = 0.02;
export const FLOOR_FINISHES = Object.freeze([
  "carpet",
  "studioCarpet",
  "parquet",
  "terrazzo",
  "rubber",
  "polished",
  "lino",
]);
export const FACADES = Object.freeze([
  "concrete",
  "brick",
  "glass",
  "stucco",
  "metal",
  "clapboard",
]);
export const WINDOW_STYLES = Object.freeze([
  "punched",
  "strip",
  "ribbon",
  "slit",
]);
export const CANOPY_STYLES = Object.freeze([
  "flat",
  "gabled",
  "marquee",
  "none",
]);
export const ROOF_FEATURE_KINDS = Object.freeze([
  "mast",
  "dish",
  "beacon",
  "watertank",
  "chimney",
  "solar",
  "vent",
  "billboard",
]);
export const ROOF_FEATURE_LIMIT = 6;
/** The place's own study work station: every style fills the same footprint
 * as the office desk, so reach, collision and facing never change. */
export const TERMINAL_STYLES = Object.freeze([
  "desk",
  "console",
  "lectern",
  "pedestal",
  "kiosk",
  "altar",
  "cabinet",
]);

/** What each of the six furnishing functions becomes in a venue. The engine
 * keeps the same functional plan (terminal access, clearances, egress); the
 * venue changes the furniture it is built from. */
export const VENUE_ROOM_MEANINGS = Object.freeze({
  office: Object.freeze({
    reception: "front desk and waiting area",
    break: "break room with kitchen counter",
    cubicles: "open-plan cubicles",
    meeting: "meeting room",
    storage: "storage and print room",
    manager: "private manager's office",
  }),
  broadcast: Object.freeze({
    reception: "station lobby and front desk",
    break: "green room where guests wait to go on air",
    cubicles: "newsroom with desks between acoustic panels",
    meeting: "live studio around a microphone table",
    storage: "record and tape library",
    manager: "control room behind the mixing desk",
  }),
});

const fail = (ok, message) => {
  if (!ok) throw Error(`Run design: ${message}`);
};
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function object(value, keys, path) {
  fail(record(value), `${path} must be an object`);
  fail(
    Object.keys(value).every((key) => keys.includes(key)),
    `${path} has an unknown field`,
  );
  fail(
    keys.every((key) => Object.hasOwn(value, key)),
    `${path} is missing a field`,
  );
}
function choice(value, choices, path) {
  fail(choices.includes(value), `${path} must be one of ${choices.join(", ")}`);
}
function color(value, path) {
  fail(
    typeof value === "string" && /^#[0-9a-fA-F]{6}$/u.test(value),
    `${path} needs a six-digit hex color`,
  );
}
function number(value, min, max, path) {
  fail(
    typeof value === "number" &&
      Number.isFinite(value) &&
      value >= min &&
      value <= max,
    `${path} must be between ${min} and ${max}`,
  );
}
function text(value, min, max, path) {
  fail(
    typeof value === "string" &&
      value.trim().length >= min &&
      value.length <= max &&
      !/[\u0000-\u001f\u007f]/u.test(value),
    `${path} must be ${min}–${max} printable characters`,
  );
}
function unit(value, path) {
  fail(
    typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 1,
    `${path} must be between 0 and 1`,
  );
}

/** Parts must stay inside the declared envelope, with at least one on the floor. */
function partErrors(o, path) {
  const half = { w: o.size.w / 2, d: o.size.d / 2 };
  o.parts.forEach((part, n) => {
    const p = `${path}.parts[${n}]`;
    fail(
      Math.abs(part.x) + part.w / 2 <= half.w + SNAP &&
        Math.abs(part.y) + part.d / 2 <= half.d + SNAP &&
        part.z >= -SNAP &&
        part.z + part.h <= o.size.h + SNAP,
      `${p} extends outside the object's size envelope`,
    );
  });
  // One grounded part anchors the piece; the rest may float, since parts
  // are purely visual (hanging lamps, levitating books, signs on a frame).
  fail(
    o.parts.some((part) => part.z <= SNAP),
    `${path} needs at least one part standing on the floor (z:0)`,
  );
  if (o.surface) {
    const top = surfaceTop(o);
    fail(
      top !== null,
      `${path}.surface needs a flat-topped box or cylinder part covering at least half of the footprint`,
    );
  }
}

/** Height of the widest flat top able to hold props, or null. Raised parts
 * standing on it (a book rest, a hood, a dome) are fine: props pack around
 * them, and a top with no room left is reported when props are placed. */
export function surfaceTop(o) {
  let best = null,
    area = 0;
  for (const part of o.parts) {
    if (
      part.shape !== "box" &&
      !(part.shape === "cylinder" && part.axis === "up")
    )
      continue;
    const size = part.w * part.d;
    if (size < 0.5 * o.size.w * o.size.d) continue;
    const top = part.z + part.h;
    // A plinth or base a hand-span off the floor is not a table.
    if (top < 0.3) continue;
    if (
      best === null ||
      size > area + 1e-9 ||
      (Math.abs(size - area) <= 1e-9 && top > best)
    ) {
      best = top;
      area = size;
    }
  }
  return best;
}

export function parseCustomObject(o, path) {
  object(o, ["id", "name", "role", "weight", "size", "surface", "parts"], path);
  fail(
    typeof o.id === "string" && /^[a-z][a-z0-9-]{1,23}$/u.test(o.id),
    `${path}.id must be a lowercase slug of 2–24 characters`,
  );
  text(o.name, 1, 32, `${path}.name`);
  choice(o.role, OBJECT_ROLES, `${path}.role`);
  choice(o.weight, Object.keys(OBJECT_WEIGHTS), `${path}.weight`);
  object(o.size, ["w", "d", "h"], `${path}.size`);
  for (const k of ["w", "d", "h"])
    number(o.size[k], ...OBJECT_LIMITS.size[k], `${path}.size.${k}`);
  fail(typeof o.surface === "boolean", `${path}.surface must be boolean`);
  fail(
    Array.isArray(o.parts) &&
      o.parts.length >= 1 &&
      o.parts.length <= OBJECT_LIMITS.parts,
    `${path}.parts needs 1–${OBJECT_LIMITS.parts} entries`,
  );
  o.parts.forEach((part, n) => {
    const p = `${path}.parts[${n}]`;
    object(
      part,
      ["shape", "axis", "x", "y", "z", "w", "d", "h", "color", "finish"],
      p,
    );
    choice(part.shape, OBJECT_SHAPES, `${p}.shape`);
    choice(part.axis, OBJECT_AXES, `${p}.axis`);
    for (const k of ["x", "y", "z", "w", "d", "h"])
      number(part[k], ...OBJECT_LIMITS.part[k], `${p}.${k}`);
    color(part.color, `${p}.color`);
    choice(part.finish, OBJECT_FINISHES, `${p}.finish`);
  });
  partErrors(o, path);
  return o;
}

/** Validate data only; the builder resolves roof positions against the shell. */
export function parseSetting(value, path = "setting") {
  object(
    value,
    ["venue", "interior", "exterior", "terminal", "objects", "filler"],
    path,
  );
  choice(value.venue, VENUES, `${path}.venue`);
  object(
    value.terminal,
    ["style", "body", "accent", "screen"],
    `${path}.terminal`,
  );
  choice(value.terminal.style, TERMINAL_STYLES, `${path}.terminal.style`);
  color(value.terminal.body, `${path}.terminal.body`);
  color(value.terminal.accent, `${path}.terminal.accent`);
  color(value.terminal.screen, `${path}.terminal.screen`);
  const i = value.interior;
  object(
    i,
    ["roomFloor", "hallFloor", "roomTint", "hallTint", "wall", "trim"],
    `${path}.interior`,
  );
  choice(i.roomFloor, FLOOR_FINISHES, `${path}.interior.roomFloor`);
  choice(i.hallFloor, FLOOR_FINISHES, `${path}.interior.hallFloor`);
  color(i.roomTint, `${path}.interior.roomTint`);
  color(i.hallTint, `${path}.interior.hallTint`);
  color(i.wall, `${path}.interior.wall`);
  color(i.trim, `${path}.interior.trim`);
  fail(
    Array.isArray(value.objects) &&
      value.objects.length <= OBJECT_LIMITS.objects,
    `${path}.objects needs 0–${OBJECT_LIMITS.objects} entries`,
  );
  const ids = new Set();
  // Check every object before failing, so one repair round can fix them all.
  const problems = [];
  value.objects.forEach((o, n) => {
    try {
      parseCustomObject(o, `${path}.objects[${n}]`);
    } catch (error) {
      problems.push(String(error.message).replace(/^Run design: /u, ""));
      if (typeof o?.id === "string") ids.add(o.id);
      return;
    }
    fail(!ids.has(o.id), `${path}.objects[${n}].id is repeated`);
    fail(
      !ROOF_FEATURE_KINDS.includes(o.id),
      `${path}.objects[${n}].id must not reuse a built-in roof feature name`,
    );
    fail(
      !SCENE_FURNITURE_KINDS.includes(o.id),
      `${path}.objects[${n}].id must not reuse a built-in furniture name`,
    );
    ids.add(o.id);
  });
  fail(!problems.length, problems.join("; "));
  fail(
    value.objects.reduce((n, o) => n + o.parts.length, 0) <=
      OBJECT_LIMITS.totalParts,
    `${path}.objects use more than ${OBJECT_LIMITS.totalParts} parts in total`,
  );
  if (value.venue === "custom") {
    object(value.filler, ROOM_FUNCTIONS, `${path}.filler`);
    for (const fn of ROOM_FUNCTIONS) {
      const list = value.filler[fn];
      fail(
        Array.isArray(list) && list.length >= 1 && list.length <= 6,
        `${path}.filler.${fn} needs 1–6 entries`,
      );
      list.forEach((name, n) =>
        fail(
          ids.has(name) || SCENE_FURNITURE_KINDS.includes(name),
          `${path}.filler.${fn}[${n}] must name a built-in furniture kind or one of setting.objects`,
        ),
      );
    }
  } else
    fail(
      value.filler === null,
      `${path}.filler must be null unless venue is custom`,
    );
  const e = value.exterior;
  object(
    e,
    [
      "facade",
      "facadeColor",
      "trimColor",
      "windows",
      "canopy",
      "canopyGlow",
      "roofFeatures",
    ],
    `${path}.exterior`,
  );
  choice(e.facade, FACADES, `${path}.exterior.facade`);
  color(e.facadeColor, `${path}.exterior.facadeColor`);
  color(e.trimColor, `${path}.exterior.trimColor`);
  choice(e.windows, WINDOW_STYLES, `${path}.exterior.windows`);
  choice(e.canopy, CANOPY_STYLES, `${path}.exterior.canopy`);
  color(e.canopyGlow, `${path}.exterior.canopyGlow`);
  fail(
    Array.isArray(e.roofFeatures) &&
      e.roofFeatures.length <= ROOF_FEATURE_LIMIT,
    `${path}.exterior.roofFeatures needs 0–${ROOF_FEATURE_LIMIT} entries`,
  );
  e.roofFeatures.forEach((feature, n) => {
    const p = `${path}.exterior.roofFeatures[${n}]`;
    object(feature, ["kind", "x", "y"], p);
    fail(
      typeof feature.kind === "string" &&
        (ROOF_FEATURE_KINDS.includes(feature.kind) || ids.has(feature.kind)),
      `${p}.kind must be one of ${ROOF_FEATURE_KINDS.join(", ")} or an id from setting.objects`,
    );
    unit(feature.x, `${p}.x`);
    unit(feature.y, `${p}.y`);
  });
  return value;
}

const list = (values) => values.join("|");
const meanings = Object.entries(VENUE_ROOM_MEANINGS)
  .map(
    ([venue, rooms]) =>
      `${venue}: ${Object.entries(rooms)
        .map(([type, meaning]) => `${type}=${meaning}`)
        .join("; ")}`,
  )
  .join(". ");

export const SETTING_GUIDANCE = `Include setting at the top level of every new design (optional only so older designs stay valid). The building must physically be the place the premise describes, inside and out, never a generic office with themed names. The place may be real or fantastical, historical, futuristic or surreal; the same tools build all of them. setting:{venue:${list(VENUES)},interior:{roomFloor:${list(FLOOR_FINISHES)},hallFloor:same choices,roomTint:hex color blended into the room floor finish,hallTint:hex color blended into the hall floor,wall:hex interior wall color,trim:hex skirting and door-frame color},exterior:{facade:${list(FACADES)},facadeColor:hex,trimColor:hex,windows:${list(WINDOW_STYLES)},canopy:${list(CANOPY_STYLES)},canopyGlow:hex color of the entrance light,roofFeatures:0..${ROOF_FEATURE_LIMIT} {kind:${list(ROOF_FEATURE_KINDS)} or the id of one of your objects,x:0..1,y:0..1}},terminal:{style:${list(TERMINAL_STYLES)},body:hex main material,accent:hex trim and secondary parts,screen:hex glowing face},objects:0..${OBJECT_LIMITS.objects} CustomObject,filler:null, or for venue custom {${ROOM_FUNCTIONS.join(",")}: each 1..6 furniture names}}.
venue picks the furniture the engine uses for every room you do not furnish yourself, and the meaning of each floor's roomTypes: ${meanings}. For venue custom, roomTypes keep their functional layout (reception=entry desk area, break=social/kitchen area, cubicles=rows of work positions, meeting=a central gathering table, storage=shelving and stores, manager=a private command or office space) and you say what each becomes through filler: the furniture names (built-in kinds or your objects' ids) the engine arranges there. List the room's signature piece first and include at least one seat and one surface; the engine arranges by role: seats around surfaces, storage along the walls, dividers between the work positions of cubicles (a divider is a thin piece, at most 0.6 m deep), equipment and display pieces beside them. Choose broadcast for radio, television, podcast, recording or transmission premises; office only when the premise really is an office; custom for every other place.
CustomObject lets you invent the premise's own furniture when no built-in kind fits: {id:lowercase slug 2..24 not a built-in kind,name:1..32 shown to the player,role:${list(OBJECT_ROLES)},weight:light|medium|heavy,size:{w:${OBJECT_LIMITS.size.w.join("..")},d:${OBJECT_LIMITS.size.d.join("..")},h:${OBJECT_LIMITS.size.h.join("..")}} metres,surface:boolean,parts:1..${OBJECT_LIMITS.parts} Part}. role says what the piece is for (seat to sit on, surface to work or eat at, storage, equipment, display, divider between work positions, bed, decor, light) and nothing else decides how it is placed. Part={shape:${list(OBJECT_SHAPES)},axis:${list(OBJECT_AXES)},x,y,z,w,d,h,color:hex,finish:${list(OBJECT_FINISHES)}} in metres in the object's own frame: x across its width (centre 0, within ±${OBJECT_LIMITS.part.x[1]}), y from back (-d/2, the side against a wall; within ±${OBJECT_LIMITS.part.y[1]}) to front (+d/2, the side people use), z the part's bottom above the floor (0..${OBJECT_LIMITS.part.z[1]}); w,d,h are the part's extents. A cylinder, sphere, cone, wedge or torus fills its w×d×h box. axis turns the shape: a cylinder or cone runs up, across the width or along the depth (a lying capsule, pipe or tank is axis across or along; a cone points up, +x or +y); a wedge is a right-triangular prism, full height at the back for axis up (a ramp, roof, hood or chute seen from the front), rising toward +x for across and toward the front for along; a torus is a ring lying flat for axis up (a hoop, tyre, halo or lifebuoy on the floor), standing upright facing the front for along (a porthole, portal or wheel) and facing sideways for across; boxes and spheres use axis up. Parts are axis-aligned and must stay inside size. At least one part stands on the floor (z:0); other parts may rest on parts or float free, for hanging lamps, levitating books, drifting runes or signs on a frame, because parts are visual only and never change collision. glow parts emit their color (screens, status lights, flames, tubes, runes, embers). surface:true needs a flat box or upright cylinder part at least 0.3 m high covering at least half the footprint (wedges and tori never count); props are then placed on it, packed around any parts standing on that top. The engine derives collision from w×d and health, push resistance and drag from weight (light pieces slide when walked into, heavy ones hold a crowd), so describe only shape and look. Use your objects by their id as scene furniture kind and in filler, alongside built-in kinds. Build recognizable silhouettes from several parts (bases, frames, panels, screens, handles, lights) rather than single boxes, and invent pieces that only this place would have; total parts across objects at most ${OBJECT_LIMITS.totalParts}.
The study terminals the player uses are the place's own work stations, never a generic office desk with a monitor: a scribe's lectern, a ship console, a ticket kiosk, an altar with a glowing slab, a lab cabinet, a stone pedestal. Pick terminal.style and the body, accent and screen colours to match the place; the screen colour is the glowing face of the terminal. They share one footprint, so style changes only the look.
Roof feature x/y are normalized across the building's roof from west to east and north (stairs) to south (entrance); the engine moves each to the nearest free roof spot that keeps the helipad, its approach and the stairs clear. Features are visual only. A roof feature kind may also be the id of one of your objects, drawn from its parts (a lantern room, a dome, a chimney stack, a weathervane, a crow's nest), so the skyline can be as particular as the interior.
Make the building recognizable from the street and from inside by principle, not by cliche: a silhouette on the skyline (roof features), a few signature pieces whose shape tells the use at a glance, materials and finishes that fit the place (floor, tints, facade, windows), light that suits it (glow parts, canopyGlow) and signs and labels in the place's own words. Vary widely between runs; the premise decides, for example a lighthouse, a bakery, a wizard's library, a deep-sea lab, a bathhouse, a circus, a monastery, a ferry terminal or an orbital greenhouse each look and furnish nothing alike.`;
