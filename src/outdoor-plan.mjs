// The AI-drawn outdoors (docs/AI_RUN_DESIGNS.md, "Outdoors").
//
// A design describes the ground around its building as data: a playable
// rectangle, an ambient ground, and up to OUTDOOR_LIMITS.regions shaped
// regions (paths and plazas to walk on; rock, water, dome walls, buildings and
// so on that block movement). The engine compiles the plan into the same
// rectangle-based CityPlan that collision, sight, sound, navigation and both
// renderers already read, so no system needs to understand discs or rings.
//
// Pure data in, pure data out: no DOM, no engine imports. Coordinates are the
// start site's tile frame in metres: the building occupies x 0..44 and
// y 0..34, its main entrance faces south (+y).
import { GROUNDS } from "./grounds.mjs";

export const OUTDOOR_VERSION = 1;
/** Walkable regions: drawn as paths and plazas, never solid. */
export const OUTDOOR_WALKABLE_KINDS = Object.freeze(["path", "plaza"]);
/** Solid regions that also block sight and sound lines. */
export const OUTDOOR_OPAQUE_KINDS = Object.freeze([
  "building",
  "rocks",
  "cliff",
  "trees",
  "ice",
  "coral",
  "dunes",
  "crystals",
  "tents",
  "hedges",
  "ruins",
  "dome-wall",
  "structure",
  "vehicle",
]);
/** Solid regions that stop bodies but can be seen across. */
export const OUTDOOR_LOW_KINDS = Object.freeze(["water", "fence", "low-wall"]);
export const OUTDOOR_REGION_KINDS = Object.freeze([
  ...OUTDOOR_WALKABLE_KINDS,
  ...OUTDOOR_OPAQUE_KINDS,
  ...OUTDOOR_LOW_KINDS,
]);
export const OUTDOOR_SHAPES = Object.freeze(["rect", "disc", "ring"]);
/** What closes the sky: nothing, a transparent dome, or a cave roof. */
export const OUTDOOR_ENCLOSURES = Object.freeze(["open-sky", "dome", "cavern"]);
/** The unreachable view beyond the playable bounds. */
export const OUTDOOR_BACKDROPS = Object.freeze([
  "skyline",
  "mountains",
  "sea",
  "dunes",
  "forest",
  "ice-field",
  "stars",
  "cavern-wall",
  "none",
]);
export const OUTDOOR_LIMITS = Object.freeze({
  regions: 120,
  /** Collision rectangles after discs and rings are rasterised. */
  compiled: 320,
  /** The furthest any bound may reach from the building frame. */
  reach: 150,
  /** Clear ground every bound keeps around the building footprint. */
  margin: 10,
  /** Smallest and largest region extents in metres. */
  size: [1, 200],
  radius: [2, 100],
  thickness: [0.3, 8],
  height: [0.2, 60],
  gaps: 4,
  gapWidth: [2.5, 20],
  /** Walkable ground the entrance must reach outside the building. */
  minWalkable: 600,
  /** Clear apron in front of the main entrance: width × depth. */
  apron: [8, 6],
});

const SITE = Object.freeze({ width: 44, height: 34 });
const DISC_STRIP = 2;
const RING_SEGMENT = 4;

const fail = (ok, message) => {
  if (!ok) throw Error(`Run design: ${message}`);
};
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function keys(value, required, optional, path) {
  fail(record(value), `${path} must be an object`);
  const allowed = [...required, ...optional];
  for (const key of Object.keys(value))
    fail(allowed.includes(key), `${path} has an unknown field ${key}`);
  for (const key of required)
    fail(Object.hasOwn(value, key), `${path} is missing ${key}`);
}
function number(value, min, max, path) {
  fail(
    typeof value === "number" &&
      Number.isFinite(value) &&
      value >= min &&
      value <= max,
    `${path} must be a number between ${min} and ${max}`,
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

export const isWalkableKind = (kind) => OUTDOOR_WALKABLE_KINDS.includes(kind);
export const isOpaqueKind = (kind) => OUTDOOR_OPAQUE_KINDS.includes(kind);

function parseRegion(r, n, path) {
  const at = `${path}.regions[${n}]`;
  fail(record(r), `${at} must be an object`);
  choice(r.shape, OUTDOOR_SHAPES, `${at}.shape`);
  const shapeKeys =
    r.shape === "rect"
      ? ["x", "y", "w", "h"]
      : r.shape === "disc"
        ? ["x", "y", "r"]
        : ["x", "y", "r", "thickness", "gaps"];
  const walkable = isWalkableKind(r.kind);
  keys(
    r,
    ["kind", "shape", ...shapeKeys, "color"],
    walkable ? ["ground"] : ["height"],
    at,
  );
  choice(r.kind, OUTDOOR_REGION_KINDS, `${at}.kind`);
  const reach = OUTDOOR_LIMITS.reach;
  number(r.x, -reach, SITE.width + reach, `${at}.x`);
  number(r.y, -reach, SITE.height + reach, `${at}.y`);
  if (r.shape === "rect") {
    number(r.w, ...OUTDOOR_LIMITS.size, `${at}.w`);
    number(r.h, ...OUTDOOR_LIMITS.size, `${at}.h`);
  } else number(r.r, ...OUTDOOR_LIMITS.radius, `${at}.r`);
  if (r.shape === "ring") {
    fail(walkable === false, `${at}: a ring must be a solid kind (a wall)`);
    number(r.thickness, ...OUTDOOR_LIMITS.thickness, `${at}.thickness`);
    fail(
      Array.isArray(r.gaps) && r.gaps.length <= OUTDOOR_LIMITS.gaps,
      `${at}.gaps needs 0–${OUTDOOR_LIMITS.gaps} entries`,
    );
    r.gaps.forEach((g, i) => {
      keys(g, ["angle", "width"], [], `${at}.gaps[${i}]`);
      number(g.angle, 0, 360, `${at}.gaps[${i}].angle`);
      number(g.width, ...OUTDOOR_LIMITS.gapWidth, `${at}.gaps[${i}].width`);
    });
  }
  color(r.color, `${at}.color`);
  if (walkable) {
    if (Object.hasOwn(r, "ground")) choice(r.ground, GROUNDS, `${at}.ground`);
  } else number(r.height, ...OUTDOOR_LIMITS.height, `${at}.height`);
}

/** Shape-only validation; checkOutdoorGeometry judges it against a site. */
export function parseOutdoorPlan(value, path = "setting.outdoors") {
  keys(
    value,
    ["version", "bounds", "ground", "enclosure", "backdrop", "regions"],
    [],
    path,
  );
  fail(value.version === OUTDOOR_VERSION, `${path}.version must be 1`);
  keys(value.bounds, ["left", "right", "top", "bottom"], [], `${path}.bounds`);
  const b = value.bounds,
    reach = OUTDOOR_LIMITS.reach,
    margin = OUTDOOR_LIMITS.margin;
  number(b.left, -reach, -margin, `${path}.bounds.left`);
  number(
    b.right,
    SITE.width + margin,
    SITE.width + reach,
    `${path}.bounds.right`,
  );
  number(b.top, -reach, -margin, `${path}.bounds.top`);
  number(
    b.bottom,
    SITE.height + margin,
    SITE.height + reach,
    `${path}.bounds.bottom`,
  );
  choice(value.ground, GROUNDS, `${path}.ground`);
  choice(value.enclosure, OUTDOOR_ENCLOSURES, `${path}.enclosure`);
  choice(value.backdrop, OUTDOOR_BACKDROPS, `${path}.backdrop`);
  fail(
    Array.isArray(value.regions) &&
      value.regions.length <= OUTDOOR_LIMITS.regions,
    `${path}.regions needs 0–${OUTDOOR_LIMITS.regions} entries`,
  );
  value.regions.forEach((r, n) => parseRegion(r, n, path));
  return value;
}

/** Axis-aligned rectangles (centre x/y, extents w/h) that cover a region.
 * A disc becomes horizontal strips; a ring becomes overlapping segment boxes
 * with its gaps left open. Collision and sight only ever see rectangles. */
export function regionRectangles(r) {
  if (r.shape === "rect") return [{ x: r.x, y: r.y, w: r.w, h: r.h }];
  if (r.shape === "disc") {
    const out = [],
      strips = Math.max(1, Math.ceil((2 * r.r) / DISC_STRIP)),
      step = (2 * r.r) / strips;
    for (let i = 0; i < strips; i++) {
      const top = r.y - r.r + i * step,
        // The strip edge nearest the centre has the longest chord.
        nearest = Math.min(Math.abs(top - r.y), Math.abs(top + step - r.y)),
        crosses = top <= r.y && top + step >= r.y,
        half = crosses ? r.r : Math.sqrt(Math.max(0, r.r * r.r - nearest ** 2));
      if (half > 0.05)
        out.push({ x: r.x, y: top + step / 2, w: 2 * half, h: step });
    }
    return out;
  }
  const out = [],
    count = Math.max(12, Math.ceil((2 * Math.PI * r.r) / RING_SEGMENT)),
    arc = ((2 * Math.PI * r.r) / count) * 1.15;
  for (let i = 0; i < count; i++) {
    const angle = ((i + 0.5) / count) * 2 * Math.PI,
      degrees = (angle * 180) / Math.PI,
      gap = r.gaps.some((g) => {
        const half = ((g.width / 2 + arc / 2) / r.r) * (180 / Math.PI),
          delta = Math.abs(((degrees - g.angle + 540) % 360) - 180);
        return delta < half;
      });
    if (gap) continue;
    const c = Math.cos(angle),
      s = Math.sin(angle);
    out.push({
      x: r.x + c * r.r,
      y: r.y + s * r.r,
      w: Math.abs(s) * arc + Math.abs(c) * r.thickness,
      h: Math.abs(c) * arc + Math.abs(s) * r.thickness,
    });
  }
  return out;
}

const left = (r) => r.x - r.w / 2,
  right = (r) => r.x + r.w / 2,
  top = (r) => r.y - r.h / 2,
  bottom = (r) => r.y + r.h / 2;
export function rectanglesOverlap(a, b, pad = 0) {
  return (
    left(a) < right(b) + pad &&
    right(a) > left(b) - pad &&
    top(a) < bottom(b) + pad &&
    bottom(a) > top(b) - pad
  );
}
const box = (l, t, r, b) => ({
  x: (l + r) / 2,
  y: (t + b) / 2,
  w: r - l,
  h: b - t,
});
/** `a` minus `b`: up to four rectangles, slivers under 0.2 m dropped. */
export function subtractRectangle(a, b) {
  if (!rectanglesOverlap(a, b)) return [a];
  const al = left(a),
    ar = right(a),
    at = top(a),
    ab = bottom(a),
    bl = Math.max(al, left(b)),
    br = Math.min(ar, right(b)),
    bt = Math.max(at, top(b)),
    bb = Math.min(ab, bottom(b));
  return [
    box(al, at, ar, bt),
    box(al, bb, ar, ab),
    box(al, bt, bl, bb),
    box(br, bt, ar, bb),
  ].filter((r) => r.w >= 0.2 && r.h >= 0.2);
}

/** The solid rectangles of a plan, tagged with their source region. Walkable
 * regions carve their footprint out of every solid, whatever the order, so a
 * causeway can cross water and a lane can cut through a block of stalls. */
export function outdoorSolids(plan) {
  const carves = plan.regions
    .filter((r) => isWalkableKind(r.kind))
    .flatMap(regionRectangles);
  const out = [];
  plan.regions.forEach((r, region) => {
    if (isWalkableKind(r.kind)) return;
    let pieces = regionRectangles(r);
    for (const carve of carves)
      pieces = pieces.flatMap((piece) => subtractRectangle(piece, carve));
    for (const rect of pieces)
      out.push({
        ...rect,
        kind: r.kind,
        height: r.height,
        color: r.color,
        opaque: isOpaqueKind(r.kind),
        region,
      });
  });
  return out;
}

/**
 * Judge a parsed plan against the site it surrounds. `site` is
 * {building:{left,right,top,bottom}, entrance:{x,y}, keepClear:[rect]} in the
 * plan's frame. Returns repair instructions; an empty list means it is sound.
 */
export function checkOutdoorGeometry(plan, site) {
  const errors = [],
    solids = outdoorSolids(plan),
    b = plan.bounds,
    house = site.building,
    shell = box(
      house.left - 1.5,
      house.top - 1.5,
      house.right + 1.5,
      house.bottom + 1.5,
    ),
    [apronWidth, apronDepth] = OUTDOOR_LIMITS.apron,
    apron = box(
      site.entrance.x - apronWidth / 2,
      site.entrance.y,
      site.entrance.x + apronWidth / 2,
      site.entrance.y + apronDepth,
    );
  if (solids.length > OUTDOOR_LIMITS.compiled)
    errors.push(
      `setting.outdoors compiles to ${solids.length} collision rectangles; the limit is ${OUTDOOR_LIMITS.compiled}. Use fewer or larger regions, fewer discs and rings, or smaller radii.`,
    );
  const named = new Set();
  for (const s of solids) {
    const at = `setting.outdoors.regions[${s.region}] (${s.kind})`;
    if (named.has(s.region)) continue;
    if (rectanglesOverlap(s, shell)) {
      named.add(s.region);
      errors.push(
        `${at} overlaps the building or the 1.5 m strip around it (x ${house.left}..${house.right}, y ${house.top}..${house.bottom}). Move or shrink it.`,
      );
    } else if (rectanglesOverlap(s, apron)) {
      named.add(s.region);
      errors.push(
        `${at} blocks the clear apron in front of the main entrance (x ${left(apron)}..${right(apron)}, y ${top(apron)}..${bottom(apron)}). Keep that ground open.`,
      );
    } else if (site.keepClear.some((k) => rectanglesOverlap(s, k))) {
      named.add(s.region);
      errors.push(
        `${at} blocks the service route beside the building that the stairs and exits need (${site.keepClear
          .map((k) => `x ${left(k)}..${right(k)}, y ${top(k)}..${bottom(k)}`)
          .join("; ")}). Keep it open.`,
      );
    }
  }
  // Flood the 1 m raster from the apron: the walkable ground the player can
  // actually reach from the door, outside the building.
  const cols = Math.ceil(b.right - b.left),
    rows = Math.ceil(b.bottom - b.top),
    blocked = new Uint8Array(cols * rows),
    mark = (r) => {
      const x0 = Math.max(0, Math.floor(left(r) - b.left)),
        x1 = Math.min(cols - 1, Math.ceil(right(r) - b.left) - 1),
        y0 = Math.max(0, Math.floor(top(r) - b.top)),
        y1 = Math.min(rows - 1, Math.ceil(bottom(r) - b.top) - 1);
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) blocked[y * cols + x] = 1;
    };
  mark(box(house.left, house.top, house.right, house.bottom));
  for (const s of solids) mark(s);
  // The cell just outside the door; a solid there is already the apron error.
  const start =
      Math.floor(site.entrance.y + 0.5 - b.top) * cols +
      Math.floor(site.entrance.x - b.left),
    open = start >= 0 && start < blocked.length && !blocked[start];
  let reached = 0;
  if (open) {
    const queue = [start];
    blocked[start] = 2;
    while (queue.length) {
      const cell = queue.pop(),
        x = cell % cols;
      reached++;
      for (const next of [
        x > 0 ? cell - 1 : -1,
        x < cols - 1 ? cell + 1 : -1,
        cell - cols,
        cell + cols,
      ])
        if (next >= 0 && next < blocked.length && !blocked[next]) {
          blocked[next] = 2;
          queue.push(next);
        }
    }
  }
  if (open && reached < OUTDOOR_LIMITS.minWalkable)
    errors.push(
      `Only ${reached} m² of ground can be walked to from the main entrance; at least ${OUTDOOR_LIMITS.minWalkable} m² is needed. Open gaps in walls and rings, carve paths through solid regions, or widen the bounds.`,
    );
  return errors;
}

/** A compact, text-free description of the place for other AI calls. */
export function outdoorSummary(plan) {
  return {
    enclosure: plan.enclosure,
    backdrop: plan.backdrop,
    ground: plan.ground,
    kinds: [...new Set(plan.regions.map((r) => r.kind))].sort(),
  };
}
