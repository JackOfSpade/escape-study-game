// JSON Schemas for structured output of every quality-flow design stage. The
// Claude CLI validates the reply against them before it returns (the model
// corrects shape mistakes in the same turn instead of costing a repair round).
// They describe shape only: the run-design validators remain the authority
// for cross-field rules, geometry, novelty and writing quality.
import { SCENE_FURNITURE_KINDS } from "./scene-catalog.mjs";
import {
  CANOPY_STYLES,
  FACADES,
  FLOOR_FINISHES,
  GROUNDS,
  MOTION_LIMITS,
  NEIGHBOR_STYLES,
  OBJECT_AXES,
  OBJECT_MOTIONS,
  PROP_OBJECT_LIMITS,
  SCENERY_LIMIT,
  WEATHERS,
  OBJECT_FINISHES,
  OBJECT_LIMITS,
  OBJECT_ROLES,
  OBJECT_SHAPES,
  OBJECT_WEIGHTS,
  ROOF_FEATURE_LIMIT,
  ROOM_FUNCTIONS,
  SITE_FORMS,
  TERMINAL_STYLES,
  VENUES,
  WALL_FINISHES,
  WINDOW_STYLES,
} from "./setting-catalog.mjs";
import { ROOM_SHAPES, TITLE_CARD_FONTS } from "./run-design-contract.mjs";
import {
  OUTDOOR_BACKDROPS,
  OUTDOOR_ENCLOSURES,
  OUTDOOR_LIMITS,
  OUTDOOR_LOW_KINDS,
  OUTDOOR_OPAQUE_KINDS,
  OUTDOOR_WALKABLE_KINDS,
} from "./outdoor-plan.mjs";

const obj = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const str = (maxLength, minLength = 1) => ({
  type: "string",
  minLength,
  maxLength,
});
const num = (minimum, maximum) => ({ type: "number", minimum, maximum });
const int = (minimum, maximum) => ({ type: "integer", minimum, maximum });
const arr = (items, minItems, maxItems) => ({
  type: "array",
  items,
  minItems,
  ...(maxItems === undefined ? {} : { maxItems }),
});
const oneOf = (values) => ({ enum: [...values] });
const hex = { type: "string", pattern: "^#[0-9a-fA-F]{6}$" };
const slug = (max) => ({
  type: "string",
  pattern: `^[a-z][a-z0-9-]{0,${max - 1}}$`,
});
const point = (min) => obj({ x: num(min, 1), y: num(min, 1) });
const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });

const finding = obj({
  id: slug(40),
  priority: oneOf(["major", "minor"]),
  target: str(200),
  problem: str(300),
  evidence: str(300),
  recommendation: str(300),
});
const textPart = {
  anyOf: [obj({ text: str(240) }), obj({ fragmentId: str(32) })],
};
// Drawings and fragments keep their detailed bounds in the environment
// validator; the schema guarantees they are objects in the right place.
const looseObject = { type: "object" };
const entry = obj({
  surfaceId: str(200),
  layout: oneOf(["text", "art", "mixed"]),
  title: arr(textPart, 0),
  body: arr(textPart, 0),
  description: str(160, 0),
  drawing: nullable(looseObject),
});
const door = obj({
  material: oneOf(["wood", "steel", "glass", "fire", "security"]),
  color: hex,
  accent: hex,
  window: oneOf(["none", "slit", "half", "full"]),
  label: str(32),
  health: int(400, 2400),
});
const titleStyle = obj({
  font: oneOf(Object.keys(TITLE_CARD_FONTS)),
  color: hex,
  size: int(14, 96),
});
const part = obj({
  shape: oneOf(OBJECT_SHAPES),
  axis: oneOf(OBJECT_AXES),
  x: num(...OBJECT_LIMITS.part.x),
  y: num(...OBJECT_LIMITS.part.y),
  z: num(...OBJECT_LIMITS.part.z),
  w: num(...OBJECT_LIMITS.part.w),
  d: num(...OBJECT_LIMITS.part.d),
  h: num(...OBJECT_LIMITS.part.h),
  pitch: num(-MOTION_LIMITS.tilt, MOTION_LIMITS.tilt),
  roll: num(-MOTION_LIMITS.tilt, MOTION_LIMITS.tilt),
  motion: oneOf(OBJECT_MOTIONS),
  rate: num(...MOTION_LIMITS.rate),
  color: hex,
  finish: oneOf(OBJECT_FINISHES),
});
const customProp = obj({
  id: slug(24),
  name: str(32),
  size: obj({
    w: num(0.02, PROP_OBJECT_LIMITS.size),
    d: num(0.02, PROP_OBJECT_LIMITS.size),
    h: num(0.02, PROP_OBJECT_LIMITS.size),
  }),
  parts: arr(part, 1, PROP_OBJECT_LIMITS.parts),
});
const surroundings = obj({
  ground: oneOf(GROUNDS),
  groundColor: hex,
  pathColor: hex,
  sky: obj({ zenith: hex, horizon: hex }),
  fog: obj({ color: hex, density: num(0, 1) }),
  neighbors: oneOf(NEIGHBOR_STYLES),
  neighborColor: hex,
  weather: oneOf(WEATHERS),
  scenery: arr(slug(24), 0, SCENERY_LIMIT),
});
// The drawn outdoors (src/outdoor-plan.mjs). Its geometry rules (footprint,
// apron, reachable ground, collision budget) are checked by the validator.
const outdoorRegion = (() => {
  const reach = OUTDOOR_LIMITS.reach,
    at = { x: num(-reach, 44 + reach), y: num(-reach, 34 + reach) },
    solid = oneOf([...OUTDOOR_OPAQUE_KINDS, ...OUTDOOR_LOW_KINDS]),
    walk = oneOf(OUTDOOR_WALKABLE_KINDS),
    rect = { w: num(...OUTDOOR_LIMITS.size), h: num(...OUTDOOR_LIMITS.size) },
    radius = { r: num(...OUTDOOR_LIMITS.radius) },
    height = num(...OUTDOOR_LIMITS.height),
    walkable = (shape, extent) =>
      obj(
        {
          kind: walk,
          shape: { const: shape },
          ...at,
          ...extent,
          color: hex,
          ground: oneOf(GROUNDS),
        },
        ["kind", "shape", "x", "y", ...Object.keys(extent), "color"],
      );
  return {
    anyOf: [
      walkable("rect", rect),
      walkable("disc", radius),
      obj({
        kind: solid,
        shape: { const: "rect" },
        ...at,
        ...rect,
        color: hex,
        height,
      }),
      obj({
        kind: solid,
        shape: { const: "disc" },
        ...at,
        ...radius,
        color: hex,
        height,
      }),
      obj({
        kind: solid,
        shape: { const: "ring" },
        ...at,
        ...radius,
        thickness: num(...OUTDOOR_LIMITS.thickness),
        gaps: arr(
          obj({ angle: num(0, 360), width: num(...OUTDOOR_LIMITS.gapWidth) }),
          0,
          OUTDOOR_LIMITS.gaps,
        ),
        color: hex,
        height,
      }),
    ],
  };
})();
const outdoors = obj({
  version: { const: 1 },
  bounds: obj({
    left: num(-OUTDOOR_LIMITS.reach, -OUTDOOR_LIMITS.margin),
    right: num(44 + OUTDOOR_LIMITS.margin, 44 + OUTDOOR_LIMITS.reach),
    top: num(-OUTDOOR_LIMITS.reach, -OUTDOOR_LIMITS.margin),
    bottom: num(34 + OUTDOOR_LIMITS.margin, 34 + OUTDOOR_LIMITS.reach),
  }),
  ground: oneOf(GROUNDS),
  enclosure: oneOf(OUTDOOR_ENCLOSURES),
  backdrop: oneOf(OUTDOOR_BACKDROPS),
  regions: arr(outdoorRegion, 0, OUTDOOR_LIMITS.regions),
});
const customObject = obj({
  id: slug(24),
  name: str(32),
  role: oneOf(OBJECT_ROLES),
  weight: oneOf(Object.keys(OBJECT_WEIGHTS)),
  size: obj({
    w: num(...OBJECT_LIMITS.size.w),
    d: num(...OBJECT_LIMITS.size.d),
    h: num(...OBJECT_LIMITS.size.h),
  }),
  surface: { type: "boolean" },
  parts: arr(part, 1, OBJECT_LIMITS.parts),
});
const setting = obj({
  venue: oneOf(VENUES),
  // Required for fresh requests; the validator keeps it optional so older
  // saved designs stay valid, where absent means "enclosed".
  form: oneOf(SITE_FORMS),
  interior: obj({
    roomFloor: oneOf(FLOOR_FINISHES),
    hallFloor: oneOf(FLOOR_FINISHES),
    roomTint: hex,
    hallTint: hex,
    wall: hex,
    trim: hex,
    // Required for fresh requests; the validator keeps them optional so
    // older saved designs stay valid.
    wallFinish: oneOf(WALL_FINISHES),
    light: hex,
  }),
  exterior: obj({
    facade: oneOf(FACADES),
    facadeColor: hex,
    trimColor: hex,
    windows: oneOf(WINDOW_STYLES),
    canopy: oneOf(CANOPY_STYLES),
    canopyGlow: hex,
    roofFeatures: arr(
      // A built-in roof kind or one of this design's object ids (validator).
      obj({ kind: slug(24), x: num(0, 1), y: num(0, 1) }),
      0,
      ROOF_FEATURE_LIMIT,
    ),
  }),
  terminal: obj({
    style: oneOf(TERMINAL_STYLES),
    body: hex,
    accent: hex,
    screen: hex,
  }),
  objects: arr(customObject, 0, OBJECT_LIMITS.objects),
  props: arr(customProp, 0, PROP_OBJECT_LIMITS.props),
  surroundings,
  // Required for fresh requests; the validator keeps it optional so older
  // saved designs keep the engine's street grid.
  outdoors,
  filler: nullable(
    obj(
      Object.fromEntries(ROOM_FUNCTIONS.map((fn) => [fn, arr(str(24), 1, 6)])),
    ),
  ),
});
const condition = oneOf(["intact", "worn", "damaged"]);
const prop = obj({
  id: slug(24),
  // Built-in props or this design's own setting.props ids (validator checks).
  kind: { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9-]{0,23}$" },
  at: obj({ x: num(-1, 1), y: num(-1, 1) }),
  angle: num(-180, 180),
  scale: num(0.65, 1.25),
  color: hex,
  accent: hex,
  condition,
  owner: nullable(str(20)),
});
const furniture = obj({
  id: slug(24),
  // Built-in kinds or this design's own object ids (checked by the validator).
  kind: { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9-]{0,23}$" },
  at: point(0),
  angle: num(-180, 180),
  color: hex,
  condition,
  owner: nullable(str(20)),
  props: arr(prop, 0, 8),
});
const room = obj({
  room: int(0, 3),
  title: str(40),
  description: str(160),
  owner: nullable(str(20)),
  palette: obj({ surface: hex, metal: hex, accent: hex }),
  condition: oneOf(["kept", "worn", "ransacked"]),
  furniture: arr(furniture, 1, 6),
});
const roomType = oneOf([
  "break",
  "cubicles",
  "meeting",
  "storage",
  "reception",
  "manager",
]);
const floor = obj(
  {
    name: str(48),
    family: oneOf(["stack", "columns", "serpentine"]),
    roomOrder: arr(int(0, 3), 3, 3),
    layoutSeed: int(0, 4294967295),
    roomTypes: arr(roomType, 4, 4),
    subroomKinds: arr(oneOf(["office", "meeting", "storage", "break"]), 1, 4),
    furnitureDensity: num(0.5, 1.5),
    fieldQuotas: arr(int(2, 6), 4, 4),
    power: arr(oneOf(["lit", "dim", "outage"]), 4, 4),
    brokenGuard: obj({ segment: oneOf([3, 4]), bay: oneOf([1, 2]) }),
    scene: obj({ version: { const: 2 }, rooms: arr(room, 4, 4) }),
    doors: arr(door, 4, 4),
    roomShapes: arr(oneOf(ROOM_SHAPES), 4, 4),
  },
  [
    "roomShapes",
    "name",
    "family",
    "roomOrder",
    "layoutSeed",
    "roomTypes",
    "subroomKinds",
    "furnitureDensity",
    "fieldQuotas",
    "power",
    "brokenGuard",
    "scene",
  ],
);
const structure = obj(
  {
    version: { const: 3 },
    title: str(64),
    premise: str(240),
    opening: str(200),
    footprint: obj({
      shape: {
        enum: [
          "rectangle",
          "chamfered",
          "stepped",
          "waisted",
          "tapered",
          "notched",
          "tee",
        ],
      },
      width: oneOf([36, 38, 40]),
      top: int(2, 4),
      inset: int(2, 4),
      mirrored: { type: "boolean" },
      shoulder: int(10, 18),
    }),
    // Shape only: the validator requires one floor for an open site and
    // exactly four for an enclosed one.
    floors: arr(floor, 1, 4),
    roofName: str(48),
    roster: arr(
      obj({
        name: str(20),
        role: oneOf(["builder", "analyst", "rusher", "medic", "skeptic"]),
        skill: num(0.4, 0.9),
        risk: num(0.2, 0.8),
        social: num(0.2, 0.8),
      }),
      19,
      19,
    ),
    city: obj({
      roadWidth: int(7, 9),
      boulevardOffset: int(15, 19),
      districtSize: int(18, 25),
      buildingHeightMin: num(9, 18),
      buildingHeightMax: num(25, 45),
      damageRate: num(0, 0.7),
      palette: arr(hex, 3, 6),
    }),
    exterior: obj({
      buildingName: str(48),
      buildingSubtitle: str(48),
      quarantineTitle: str(48),
      quarantineSubtitle: str(48),
      skyline: obj({
        minHeight: num(24, 60),
        maxHeight: num(72, 140),
        damageRate: num(0, 0.7),
      }),
    }),
    pacing: obj({
      swarmInterval: num(2.5, 4),
      swarmBatch: int(1, 2),
      swarmCap: int(120, 220),
      npcThinkingScale: num(0.2, 0.35),
      firstHelicopter: num(420, 600),
      helicopterInterval: num(150, 210),
    }),
    relationships: arr(
      obj({
        from: str(20),
        to: str(20),
        kind: oneOf(["colleague", "friend", "relative", "mentor", "rival"]),
        detail: str(120),
      }),
      1,
      24,
    ),
    mainDoor: door,
    titleCard: obj({ title: titleStyle, story: titleStyle }),
    setting,
  },
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
    "relationships",
    "titleCard",
    "setting",
  ],
);
const concept = obj({
  id: slug(40),
  title: str(64),
  premise: str(240),
  spatialIdentity: str(240),
  castTension: str(240),
  visualLanguage: str(240),
  everydayLife: str(240),
  escapeMood: str(240),
  novelty: str(240),
});

/** The structured-output schema for a captured quality-flow request, or
 * undefined for retained legacy requests (they keep free-form JSON replies). */
export function designReplySchema(request) {
  if (request?.version !== 3) return undefined;
  const reply = (properties) =>
    obj({ requestId: { const: request.requestId }, ...properties });
  switch (request.phase) {
    case "concepts":
      return reply({ concepts: arr(concept, 3, 3) });
    case "selection":
      return reply({ selectedId: str(40), rationale: str(600) });
    case "structure":
      return reply({ structure });
    case "structure-review":
    case "content-review":
      return reply({ findings: arr(finding, 0, 12) });
    case "content-plan":
      return reply({
        plan: obj({
          rooms: arr(
            obj({
              id: str(40),
              story: str(400),
              ordinaryLife: str(400),
              occupantEvidence: str(400),
              artDirection: str(400),
            }),
            1,
          ),
          fragments: arr(looseObject, 0, 16),
        }),
      });
    case "content-batch":
    case "content-revision":
      return reply({ entries: arr(entry, 1) });
    default:
      return undefined;
  }
}
