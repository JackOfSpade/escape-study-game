import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ESCAPE_CONTRACTS,
  ESCAPE_OPERATIONS,
  validateEscapeAnswer,
} from "../scripts/lib/escape-contracts.mjs";

/**
 * Every field its validator requires to be a JSON array, mapped to a regex
 * that pins the exact contract wording for that field. An operation with an
 * empty entry is one whose validator requires no array at all.
 */
const ARRAY_FIELDS = {
  "escape-engage": {
    facts:
      /facts is a JSON array of 0 to 4 entries, each one \{text,subject:\{kind,id\},visibility\}/,
    visibility:
      /visibility is a JSON array of 1 to 8 strings, for example \["public"\] or \["npc:<id>","role:<role>"\], never a bare string/,
  },
  "escape-converse": {},
  "escape-pa": {},
  "escape-intent": {
    goals: /goals is a JSON array of 0 to 5 entries/,
  },
  "escape-epilogue": {},
  "escape-area": {
    rooms: /rooms is a JSON array of 3 to 12 entries/,
    people: /people is a JSON array of 0 to 12 entries/,
  },
  // Its reply is structured output: the schema, not the prose, declares the
  // behaviours, phases and omens arrays (tests/catastrophe-schema.test.ts).
  "escape-catastrophe": {},
};

const describedArrays = (contract) =>
  [...contract.matchAll(/\b(\w+) is a JSON array\b/g)].map((match) => match[1]);

test("the array-wording table covers every escape operation", () => {
  assert.deepEqual(
    Object.keys(ARRAY_FIELDS).sort(),
    [...ESCAPE_OPERATIONS].sort(),
  );
});

test("each contract calls every validator-required array a JSON array", () => {
  for (const [operation, fields] of Object.entries(ARRAY_FIELDS)) {
    const contract = ESCAPE_CONTRACTS[operation];
    assert.equal(
      typeof contract,
      "string",
      `${operation} contract must be one string`,
    );
    for (const [field, pattern] of Object.entries(fields)) {
      assert.match(
        contract,
        pattern,
        `${operation} contract must describe ${field} as a JSON array`,
      );
    }
  }
});

test("the table and the array wording in each contract agree exactly", () => {
  for (const operation of ESCAPE_OPERATIONS) {
    assert.deepEqual(
      describedArrays(ESCAPE_CONTRACTS[operation]).sort(),
      Object.keys(ARRAY_FIELDS[operation]).sort(),
      `${operation} contract array wording must match the table`,
    );
  }
});

test("no contract hides a required array behind list-count wording", () => {
  const listWording =
    /\b(?:facts|visibility|goals|rooms|people|behaviours|phases|omens) lists \d+ to \d+ (?:entries|phases|rooms|people)\b/;
  for (const [operation, contract] of Object.entries(ESCAPE_CONTRACTS)) {
    assert.doesNotMatch(
      contract,
      listWording,
      `${operation} contract must not describe an array field as a list count`,
    );
  }
});

test("escape-engage spells out visibility with a concrete JSON example", () => {
  const contract = ESCAPE_CONTRACTS["escape-engage"];
  assert.match(contract, /for example \["public"\]/);
  assert.match(
    contract,
    /for example \["public"\] or \["npc:<id>","role:<role>"\]/,
  );
  assert.match(contract, /never a bare string/);
});

const engagePayload = { requestId: "engage-visibility-1" };

const engageAnswer = (visibility) => ({
  requestId: "engage-visibility-1",
  facts: [
    {
      text: "The hatch bolts are frozen shut.",
      subject: { kind: "object", id: "rocket-hatch" },
      visibility,
    },
  ],
});

test("escape-engage accepts visibility as a one-entry array", () => {
  const result = validateEscapeAnswer(
    "escape-engage",
    engagePayload,
    engageAnswer(["public"]),
  );
  assert.deepEqual(result.facts[0].visibility, ["public"]);
});

test("escape-engage rejects visibility as a bare string", () => {
  assert.throws(
    () =>
      validateEscapeAnswer(
        "escape-engage",
        engagePayload,
        engageAnswer("public"),
      ),
    {
      name: "Error",
      message:
        /escape-engage facts\[0\]\.visibility must list 1 to 8 FactVisibility entries/,
    },
  );
});
