// JSON Schemas for structured output of every quality-flow design stage. The
// Claude CLI validates the reply against them before it returns (the model
// corrects shape mistakes in the same turn instead of costing a repair round).
// They describe shape only: the run-design validators remain the authority
// for cross-field rules, geometry, novelty and writing quality.
import { PROP_CATALOG, SCENE_FURNITURE_KINDS } from "./scene-catalog.mjs";
import {
  CANOPY_STYLES,
  FACADES,
  FLOOR_FINISHES,
  OBJECT_AXES,
  OBJECT_FINISHES,
  OBJECT_LIMITS,
  OBJECT_ROLES,
  OBJECT_SHAPES,
  OBJECT_WEIGHTS,
  ROOF_FEATURE_LIMIT,
  ROOM_FUNCTIONS,
  TERMINAL_STYLES,
  VENUES,
  WINDOW_STYLES,
} from "./setting-catalog.mjs";
import { TITLE_CARD_FONTS } from "./run-design-contract.mjs";

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
  color: hex,
  finish: oneOf(OBJECT_FINISHES),
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
  interior: obj({
    roomFloor: oneOf(FLOOR_FINISHES),
    hallFloor: oneOf(FLOOR_FINISHES),
    roomTint: hex,
    hallTint: hex,
    wall: hex,
    trim: hex,
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
  filler: nullable(
    obj(
      Object.fromEntries(ROOM_FUNCTIONS.map((fn) => [fn, arr(str(24), 1, 6)])),
    ),
  ),
});
const condition = oneOf(["intact", "worn", "damaged"]);
const prop = obj({
  id: slug(24),
  kind: oneOf(Object.keys(PROP_CATALOG)),
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
  },
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
    floors: arr(floor, 4, 4),
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
