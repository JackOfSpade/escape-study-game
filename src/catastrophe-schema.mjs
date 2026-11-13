// JSON Schema for the structured `escape-catastrophe` reply
// (docs/ESCAPE_REDESIGN.md section 3). The Claude CLI validates the reply's
// shape against it before returning, so field names, enums, string lengths,
// array sizes and numeric ranges no longer need to live in the prose contract.
// validateCatastrophe in src/catastrophe.ts stays the authority on bounds and
// on cross-field rules (phase order, grace period, behaviour indexes, omen
// times, duplicates, conditional fields). Plain data only, so the gateway can import it.

const obj = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const str = (maxLength) => ({ type: "string", minLength: 1, maxLength });
const num = (minimum, maximum) => ({ type: "number", minimum, maximum });
const int = (minimum, maximum) => ({ type: "integer", minimum, maximum });
const arr = (items, minItems, maxItems) => ({
  type: "array",
  items,
  minItems,
  maxItems,
});
const oneOf = (values) => ({ enum: [...values] });

export const CATASTROPHE_ENUMS = Object.freeze({
  silhouettes: Object.freeze([
    "humanoid",
    "quadruped",
    "serpentine",
    "swarm",
    "amorphous",
  ]),
  doors: Object.freeze(["break", "open", "blocked"]),
  spawns: Object.freeze(["single", "breeding", "waves"]),
  media: Object.freeze(["fire", "smoke", "water", "gas", "vacuum", "cold"]),
  triggers: Object.freeze([
    "sees-own-reflection",
    "makes-sound",
    "in-darkness",
    "looks-at-entity",
  ]),
  effects: Object.freeze(["damage", "instant-death"]),
  warnings: Object.freeze(["none", "whisper", "frost", "flicker", "ringing"]),
  collapseTargets: Object.freeze([
    "power",
    "doors",
    "structure",
    "life-support",
  ]),
  phases: Object.freeze(["omens", "onset", "spread", "peak"]),
  omenEffects: Object.freeze(["flicker", "alarm", "lockdown", "noise", "none"]),
});

const E = CATASTROPHE_ENUMS;

const hunter = obj({
  kind: { const: "hunter" },
  body: obj({
    color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
    scale: num(0.6, 2.2),
    silhouette: oneOf(E.silhouettes),
  }),
  count: int(1, 40),
  speed: num(0.4, 1.6),
  sightRange: num(2, 14),
  hearingWeight: num(0, 1),
  doors: oneOf(E.doors),
  damage: num(4, 60),
  spawn: oneOf(E.spawns),
});
const hazard = obj({
  kind: { const: "hazard" },
  medium: oneOf(E.media),
  spreadRate: num(0.02, 1.5),
  damagePerSecond: num(0.5, 40),
  blockedByClosedDoors: { type: "boolean" },
  obscures: num(0, 1),
});
const perception = obj(
  {
    kind: { const: "perception-rule" },
    trigger: oneOf(E.triggers),
    threshold: num(0, 10),
    effect: oneOf(E.effects),
    damagePerSecond: num(1, 60),
    warning: oneOf(E.warnings),
  },
  ["kind", "trigger", "effect", "warning"],
);
const collapse = obj({
  kind: { const: "collapse" },
  targets: arr(oneOf(E.collapseTargets), 1, 4),
  cadence: num(10, 600),
});

/** The reply schema for one `escape-catastrophe` payload. The requestId and
 * the area ids come from the payload, so the CLI rejects a wrong echo or an
 * unknown area before our validators run. */
export function catastropheReplySchema(payload) {
  const areaIds = Array.isArray(payload?.areaIds)
    ? payload.areaIds.filter((id) => typeof id === "string" && id)
    : [];
  const areaId = areaIds.length ? oneOf(areaIds) : str(80);
  const requestId =
    typeof payload?.requestId === "string"
      ? { const: payload.requestId }
      : str(200);
  return obj({
    requestId,
    spec: obj({
      id: str(48),
      title: str(80),
      premise: str(1200),
      origin: obj({ areaId, roomHint: str(80) }, ["areaId"]),
      behaviours: arr({ anyOf: [hunter, hazard, perception, collapse] }, 1, 3),
      timeline: obj({
        graceSeconds: num(240, 900),
        phases: arr(
          obj({
            name: oneOf(E.phases),
            at: { type: "number", minimum: 0 },
            behaviours: arr(int(0, 2), 0, 3),
            intensity: num(0, 1),
          }),
          2,
          6,
        ),
      }),
      omens: arr(
        obj(
          {
            id: str(48),
            text: str(280),
            at: { type: "number", minimum: 0 },
            areaId,
            roomHint: str(80),
            effect: oneOf(E.omenEffects),
          },
          ["id", "text", "at", "areaId"],
        ),
        5,
        10,
      ),
      publicStory: str(400),
    }),
  });
}
