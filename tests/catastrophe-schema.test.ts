import assert from "node:assert/strict";
import test from "node:test";
import {
  CATASTROPHE_LIMITS,
  fallbackCatastrophe,
  validateCatastrophe,
} from "../src/catastrophe";
import { catastropheReplySchema } from "../src/catastrophe-schema.mjs";
import { schemaErrors } from "./helpers/json-schema";

const payload = { requestId: "cat-game-1", areaIds: ["dorm", "pad"] };
const reply = (spec: unknown) => ({ requestId: "cat-game-1", spec });

test("the catastrophe schema accepts a valid spec the validator also accepts", () => {
  const spec = fallbackCatastrophe(11, "dorm");
  assert.deepEqual(validateCatastrophe(spec, payload.areaIds), []);
  assert.deepEqual(
    schemaErrors(catastropheReplySchema(payload), reply(spec)),
    [],
  );
});

test("the catastrophe schema rejects a missing field, a wrong echo and an unknown area", () => {
  const schema = catastropheReplySchema(payload);
  const { premise: _premise, ...noPremise } = fallbackCatastrophe(11, "dorm");
  assert.ok(
    schemaErrors(schema, reply(noPremise)).includes(
      "$.spec.premise is required",
    ),
  );
  assert.ok(
    schemaErrors(schema, {
      ...reply(fallbackCatastrophe(11, "dorm")),
      requestId: "cat-game-2",
    }).length,
  );
  assert.ok(
    schemaErrors(schema, reply(fallbackCatastrophe(11, "tunnels"))).length,
  );
  const spec = fallbackCatastrophe(11, "dorm");
  assert.ok(
    schemaErrors(schema, reply({ ...spec, extra: 1 })).includes(
      "$.spec.extra is not allowed",
    ),
  );
});

test("schema bounds mirror the validator's limits", () => {
  const spec = catastropheReplySchema(payload).properties.spec as any;
  const L = CATASTROPHE_LIMITS;
  const p = spec.properties;
  assert.equal(p.title.maxLength, L.titleMaxChars);
  assert.equal(p.premise.maxLength, L.premiseMaxChars);
  assert.equal(p.publicStory.maxLength, L.publicStoryMaxChars);
  assert.equal(p.behaviours.minItems, L.behaviourMin);
  assert.equal(p.behaviours.maxItems, L.behaviourMax);
  assert.equal(p.timeline.properties.phases.minItems, L.phaseMin);
  assert.equal(p.timeline.properties.phases.maxItems, L.phaseMax);
  assert.equal(p.timeline.properties.graceSeconds.minimum, L.graceSecondsMin);
  assert.equal(p.timeline.properties.graceSeconds.maximum, L.graceSecondsMax);
  assert.equal(p.omens.minItems, L.omenMin);
  assert.equal(p.omens.maxItems, L.omenMax);
  assert.equal(p.omens.items.properties.text.maxLength, L.omenTextMaxChars);
  const [hunter, hazard, perception, collapse] = p.behaviours.items.anyOf;
  assert.equal(hunter.properties.count.maximum, L.hunterCountMax);
  assert.equal(
    hunter.properties.body.properties.scale.minimum,
    L.hunterScaleMin,
  );
  assert.equal(hunter.properties.damage.maximum, L.hunterDamageMax);
  assert.equal(hazard.properties.spreadRate.maximum, L.hazardSpreadRateMax);
  assert.equal(
    perception.properties.damagePerSecond.maximum,
    L.perceptionDamagePerSecondMax,
  );
  assert.equal(collapse.properties.cadence.minimum, L.collapseCadenceMin);
});
