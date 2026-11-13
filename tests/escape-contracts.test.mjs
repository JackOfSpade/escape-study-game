import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AI_OPERATIONS,
  taskInstructions,
  validateAnswer,
} from "../scripts/lib/ai-contracts.mjs";
import { TASK_PROFILES } from "../scripts/claude-gateway.mjs";
import {
  ESCAPE_CONTRACTS,
  ESCAPE_OPERATIONS,
  validateEscapeAnswer,
} from "../scripts/lib/escape-contracts.mjs";

const rejects = (operation, payload, answer, pattern) =>
  assert.throws(() => validateEscapeAnswer(operation, payload, answer), {
    name: "Error",
    message: pattern,
  });

const engagePayload = {
  requestId: "engage-1",
  setting: {
    name: "Mars colony",
    summary: "A working colony beside a launch pad.",
  },
  persona: {
    name: "Dana",
    role: "engineer",
    backstory: "Ten years on the colony.",
  },
  engagement: {
    kind: "attempt",
    subject: { kind: "object", id: "rocket-hatch", name: "Rocket hatch" },
    text: "Dana tries the hatch handle.",
  },
  knownFacts: ["The hatch is locked."],
  area: { id: "pad", name: "Landing pad" },
  objects: [{ id: "rocket-hatch", name: "Rocket hatch" }],
};

const engageAnswer = {
  requestId: "engage-1",
  facts: [
    {
      text: "  The hatch bolts are frozen shut.  ",
      subject: { kind: "object", id: "rocket-hatch" },
      visibility: ["public", "role:flight-crew"],
    },
  ],
  task: {
    title: "Loosen the hatch bolts",
    unit: "bolts",
    steps: 4,
    objectId: "rocket-hatch",
  },
  reply: "It will not budge. The bolts are frozen.",
};

test("escape-engage accepts a bounded answer and normalises it", () => {
  const result = validateEscapeAnswer(
    "escape-engage",
    engagePayload,
    engageAnswer,
  );
  assert.deepEqual(result, {
    requestId: "engage-1",
    facts: [
      {
        text: "The hatch bolts are frozen shut.",
        subject: { kind: "object", id: "rocket-hatch" },
        visibility: ["public", "role:flight-crew"],
      },
    ],
    task: {
      title: "Loosen the hatch bolts",
      unit: "bolts",
      steps: 4,
      objectId: "rocket-hatch",
    },
    reply: "It will not budge. The bolts are frozen.",
  });
  assert.equal(
    validateEscapeAnswer("escape-engage", engagePayload, {
      requestId: "engage-1",
      facts: [],
    }).facts.length,
    0,
  );
});

test("escape-engage rejects a wrong requestId and bad fields", () => {
  rejects(
    "escape-engage",
    engagePayload,
    { ...engageAnswer, requestId: "engage-2" },
    /escape-engage answer must echo the exact payload requestId/,
  );
  rejects(
    "escape-engage",
    engagePayload,
    { ...engageAnswer, facts: Array(5).fill(engageAnswer.facts[0]) },
    /escape-engage facts must be an array of 0 to 4 entries/,
  );
  rejects(
    "escape-engage",
    engagePayload,
    { ...engageAnswer, task: { ...engageAnswer.task, steps: 9 } },
    /escape-engage task.steps must be an integer from 1 to 8/,
  );
  rejects(
    "escape-engage",
    engagePayload,
    { ...engageAnswer, facts: Array(9).fill(engageAnswer.facts[0]) },
    /escape-engage facts must be an array of 0 to 4 entries/,
  );
});

test("escape-engage rejects hidden visibility", () => {
  rejects(
    "escape-engage",
    engagePayload,
    {
      ...engageAnswer,
      facts: [
        {
          text: "The hatch bolts are frozen shut.",
          subject: { kind: "object", id: "rocket-hatch" },
          visibility: ["public", "hidden"],
        },
      ],
    },
    /visibility\[1\] may not be hidden/,
  );
  rejects(
    "escape-engage",
    engagePayload,
    {
      ...engageAnswer,
      facts: [
        {
          text: "The hatch bolts are frozen shut.",
          subject: { kind: "object", id: "rocket-hatch" },
          visibility: ["classified"],
        },
      ],
    },
    /must be public, npc:<id>, role:<role>, document:<id> or area:<id>/,
  );
});

const conversePayload = {
  requestId: "converse-1",
  speaker: {
    id: "npc-ortiz",
    name: "Ortiz",
    role: "flight crew",
    personality: "blunt",
  },
  social: { alarm: 0.1, relationship: "colleague" },
  visibleFacts: ["The hatch is locked."],
  heard: [{ speakerId: "human", text: "Do you have a flight badge?" }],
  addressee: "npc-ortiz",
};

const converseAnswer = {
  requestId: "converse-1",
  speakerId: "npc-ortiz",
  text: "I might. Why do you want it?",
  outcome: { kind: "share-fact", factId: "fact-hatch-badge" },
};

test("escape-converse accepts one line with a structured outcome", () => {
  assert.deepEqual(
    validateEscapeAnswer("escape-converse", conversePayload, converseAnswer),
    converseAnswer,
  );
  assert.deepEqual(
    validateEscapeAnswer("escape-converse", conversePayload, {
      ...converseAnswer,
      outcome: { kind: "none" },
    }).outcome,
    { kind: "none" },
  );
});

test("escape-converse rejects a wrong requestId and a bad field", () => {
  rejects(
    "escape-converse",
    conversePayload,
    { ...converseAnswer, requestId: "converse-2" },
    /escape-converse answer must echo the exact payload requestId/,
  );
  rejects(
    "escape-converse",
    conversePayload,
    { ...converseAnswer, text: "" },
    /escape-converse text must be a nonempty string/,
  );
  rejects(
    "escape-converse",
    conversePayload,
    { ...converseAnswer, text: "See https://example.test for the plan." },
    /escape-converse text must be plain speech/,
  );
  rejects(
    "escape-converse",
    conversePayload,
    { ...converseAnswer, outcome: { kind: "share-fact" } },
    /escape-converse outcome\.factId must be a nonempty string/,
  );
});

test("escape-converse rejects a speakerId mismatch", () => {
  rejects(
    "escape-converse",
    conversePayload,
    { ...converseAnswer, speakerId: "npc-other" },
    /escape-converse speakerId must equal payload\.speaker\.id/,
  );
});

test("escape-converse rejects an unknown outcome kind", () => {
  rejects(
    "escape-converse",
    conversePayload,
    { ...converseAnswer, outcome: { kind: "arrest" } },
    /must be an NpcOutcome with a kind from src\/escape-types\.ts/,
  );
});

const paPayload = {
  requestId: "pa-1",
  kind: "routine",
  phase: { name: "omens" },
  rooms: [{ id: "canteen" }, { id: "bay" }],
};

const paAnswer = {
  requestId: "pa-1",
  kind: "routine",
  text: "Attention: the canteen closes in ten minutes.",
  effect: { kind: "power", roomId: "canteen", power: "dim" },
};

test("escape-pa accepts an announcement with an effect", () => {
  assert.deepEqual(
    validateEscapeAnswer("escape-pa", paPayload, paAnswer),
    paAnswer,
  );
  assert.deepEqual(
    validateEscapeAnswer("escape-pa", paPayload, {
      ...paAnswer,
      effect: { kind: "evacuate" },
    }).effect,
    { kind: "evacuate" },
  );
});

test("escape-pa rejects a wrong requestId and a bad field", () => {
  rejects(
    "escape-pa",
    paPayload,
    { ...paAnswer, requestId: "pa-2" },
    /escape-pa answer must echo the exact payload requestId/,
  );
  rejects(
    "escape-pa",
    paPayload,
    { ...paAnswer, kind: "escalation" },
    /escape-pa kind must equal payload\.kind when it is supplied/,
  );
  rejects(
    "escape-pa",
    paPayload,
    { ...paAnswer, text: "<b>Evacuate</b>" },
    /escape-pa text must be plain speech/,
  );
});

test("escape-pa rejects an effect roomId that is not in payload.rooms", () => {
  rejects(
    "escape-pa",
    paPayload,
    { ...paAnswer, effect: { kind: "lockdown", roomId: "reactor" } },
    /escape-pa effect\.roomId must be one of payload\.rooms ids/,
  );
  rejects(
    "escape-pa",
    { ...paPayload, kind: undefined },
    { ...paAnswer, kind: "rumour" },
    /escape-pa kind must be routine, incident, borderline or escalation/,
  );
});

const intentPayload = {
  requestId: "intent-1",
  areaIds: ["colony", "rocket", "beacon"],
  journal: ["The hatch needs a flight badge."],
  recent: ["Dana asked Ortiz about a badge."],
};

const intentAnswer = {
  requestId: "intent-1",
  goals: [
    {
      areaId: "rocket",
      goal: "Reach the rocket and open the hatch.",
      confidence: 0.8,
    },
    {
      areaId: "beacon",
      goal: "Find the flight crew to borrow a badge.",
      confidence: 0.4,
    },
  ],
};

test("escape-intent accepts ranked goals", () => {
  assert.deepEqual(
    validateEscapeAnswer("escape-intent", intentPayload, intentAnswer),
    intentAnswer,
  );
  assert.deepEqual(
    validateEscapeAnswer("escape-intent", intentPayload, {
      requestId: "intent-1",
      goals: [],
    }).goals,
    [],
  );
});

test("escape-intent rejects a wrong requestId and a bad field", () => {
  rejects(
    "escape-intent",
    intentPayload,
    { ...intentAnswer, requestId: "intent-2" },
    /escape-intent answer must echo the exact payload requestId/,
  );
  rejects(
    "escape-intent",
    intentPayload,
    {
      ...intentAnswer,
      goals: [{ areaId: "rocket", goal: "Open the hatch.", confidence: 1.4 }],
    },
    /escape-intent goals\[0\]\.confidence must be a number from 0 to 1/,
  );
  rejects(
    "escape-intent",
    intentPayload,
    {
      ...intentAnswer,
      goals: [{ areaId: "orbital", goal: "Open the hatch.", confidence: 0.5 }],
    },
    /escape-intent goals\[0\]\.areaId must be one of payload\.areaIds/,
  );
});

test("escape-intent rejects goals that are not sorted by confidence", () => {
  rejects(
    "escape-intent",
    intentPayload,
    {
      ...intentAnswer,
      goals: [
        { areaId: "beacon", goal: "Find the flight crew.", confidence: 0.3 },
        { areaId: "rocket", goal: "Open the hatch.", confidence: 0.9 },
      ],
    },
    /escape-intent goals must be sorted by confidence from highest to lowest/,
  );
});

const epiloguePayload = {
  requestId: "epilogue-1",
  premise: "A buried excavation device wakes beneath the colony.",
  timeline: [{ area: "colony", phase: "onset", text: "The lights failed." }],
};

const epilogueText =
  "The lights failed before anyone understood the alarm. Dana reached the landing pad, but the hatch stayed shut, and the colony went quiet behind her.";

test("escape-epilogue accepts plain retrospective prose", () => {
  const result = validateEscapeAnswer("escape-epilogue", epiloguePayload, {
    requestId: "epilogue-1",
    text: `  ${epilogueText}  `,
  });
  assert.deepEqual(result, { requestId: "epilogue-1", text: epilogueText });
});

test("escape-epilogue rejects a wrong requestId and bad fields", () => {
  rejects(
    "escape-epilogue",
    epiloguePayload,
    { requestId: "epilogue-2", text: epilogueText },
    /escape-epilogue answer must echo the exact payload requestId/,
  );
  rejects(
    "escape-epilogue",
    epiloguePayload,
    { requestId: "epilogue-1", text: "It ended." },
    /escape-epilogue text must be 40 to 4000 characters of plain prose/,
  );
});

test("escape-epilogue rejects markup", () => {
  rejects(
    "escape-epilogue",
    epiloguePayload,
    {
      requestId: "epilogue-1",
      text: `${epilogueText} <b>Everyone died.</b>`,
    },
    /escape-epilogue text must be plain prose without markup/,
  );
  rejects(
    "escape-epilogue",
    epiloguePayload,
    { requestId: "epilogue-1", text: `${epilogueText} **Fin.**` },
    /escape-epilogue text must be plain prose without markup/,
  );
});

const areaPayload = {
  requestId: "area-1",
  areaId: "rocket",
  stub: { id: "rocket", name: "Rocket", brief: "A colony launch vehicle." },
  knownFacts: ["The colony is beside a launch pad."],
};

const areaAnswer = {
  requestId: "area-1",
  areaId: "rocket",
  name: "Colony launch vehicle",
  premise:
    "A three-stage rocket standing on the pad, kept ready for an emergency return to orbit.",
  rooms: [
    { name: "Cabin", purpose: "Seats four crew for launch." },
    { name: "Cargo hold", purpose: "Stores supplies for the colony." },
    { name: "Engine bay", purpose: "Houses the main drive." },
  ],
  people: [
    {
      name: "Ortiz",
      role: "flight crew",
      activity: "Running the pre-launch checklist.",
    },
  ],
};

test("escape-area accepts a bounded building brief", () => {
  assert.deepEqual(
    validateEscapeAnswer("escape-area", areaPayload, areaAnswer),
    areaAnswer,
  );
});

test("escape-area rejects a wrong requestId and bad fields", () => {
  rejects(
    "escape-area",
    areaPayload,
    { ...areaAnswer, requestId: "area-2" },
    /escape-area answer must echo the exact payload requestId/,
  );
  rejects(
    "escape-area",
    areaPayload,
    { ...areaAnswer, areaId: "beacon" },
    /escape-area areaId must equal payload\.areaId/,
  );
  rejects(
    "escape-area",
    areaPayload,
    { ...areaAnswer, rooms: areaAnswer.rooms.slice(0, 2) },
    /escape-area rooms must list 3 to 12 rooms/,
  );
  rejects(
    "escape-area",
    areaPayload,
    { ...areaAnswer, name: "x".repeat(61) },
    /escape-area name must be at most 60 characters/,
  );
});

test("every escape operation is registered in AI_OPERATIONS with a TASK_PROFILES entry", () => {
  assert.deepEqual(
    [...ESCAPE_OPERATIONS],
    [
      "escape-engage",
      "escape-converse",
      "escape-pa",
      "escape-intent",
      "escape-epilogue",
      "escape-area",
      "escape-catastrophe",
    ],
  );
  assert.ok(Object.isFrozen(ESCAPE_OPERATIONS));
  assert.ok(Object.isFrozen(ESCAPE_CONTRACTS));
  // Measured knees, docs/AI_MODEL_SELECTION.md "Escape calls (2026-11-12)".
  const profiles = {
    "escape-engage": { model: "haiku", effort: "medium", timeoutMs: 120_000 },
    "escape-converse": { model: "sonnet", effort: "low", timeoutMs: 45_000 },
    "escape-pa": { model: "haiku", effort: "high", timeoutMs: 45_000 },
    "escape-intent": { model: "haiku", effort: "medium", timeoutMs: 120_000 },
    "escape-epilogue": { model: "haiku", effort: "high", timeoutMs: 180_000 },
    "escape-area": { model: "opus", effort: "medium", timeoutMs: 180_000 },
    "escape-catastrophe": {
      model: "sonnet",
      effort: "medium",
      timeoutMs: 180_000,
    },
  };
  for (const operation of ESCAPE_OPERATIONS) {
    assert.ok(
      AI_OPERATIONS.includes(operation),
      `${operation} is registered in AI_OPERATIONS`,
    );
    assert.ok(
      Object.keys(ESCAPE_CONTRACTS).includes(operation),
      `${operation} has contract prose`,
    );
    const profile = TASK_PROFILES[operation];
    assert.ok(profile, `${operation} has a TASK_PROFILES entry`);
    assert.deepEqual(
      {
        model: profile.model,
        effort: profile.effort,
        timeoutMs: profile.timeoutMs,
        stableKeys: profile.stableKeys,
      },
      { ...profiles[operation], stableKeys: ["instruction"] },
    );
  }
});

test("contract prose keeps the catastrophe sealed except for the epilogue", () => {
  for (const operation of ESCAPE_OPERATIONS) {
    const prose = ESCAPE_CONTRACTS[operation];
    assert.match(prose, /Return exactly one JSON object/, operation);
    assert.match(prose, /requestId/, operation);
    assert.match(prose, /not tutoring/, operation);
    assert.match(
      prose,
      /never teach, grade, reward or claim learning/,
      operation,
    );
    if (operation === "escape-epilogue") {
      assert.match(
        prose,
        /the only operation that receives the catastrophe premise/,
        operation,
      );
      assert.doesNotMatch(prose, /catastrophe is unknown/i, operation);
    } else {
      assert.match(prose, /catastrophe is unknown to everyone/i, operation);
      assert.match(prose, /(never invent|do not know or reveal)/i, operation);
      assert.doesNotMatch(
        prose,
        /only operation that receives the catastrophe premise/i,
        operation,
      );
    }
  }
});

test("validateAnswer delegates escape operations to validateEscapeAnswer", () => {
  assert.doesNotThrow(() =>
    validateAnswer({ operation: "escape-pa", payload: paPayload }, paAnswer),
  );
  assert.throws(
    () =>
      validateAnswer(
        { operation: "escape-pa", payload: paPayload },
        { ...paAnswer, requestId: "pa-9" },
      ),
    /escape-pa answer must echo the exact payload requestId/,
  );
});

test("taskInstructions frames escape operations as fictional simulation", () => {
  const instruction = taskInstructions("escape-converse", conversePayload);
  assert.match(instruction, /fictional game-simulation request/);
  assert.match(instruction, /never tutor/i);
  assert.match(instruction, /catastrophe .* unknown to everyone/i);
  assert.ok(instruction.includes(ESCAPE_CONTRACTS["escape-converse"]));
});

test("validateEscapeAnswer rejects unknown operations and non-object answers", () => {
  assert.throws(
    () => validateEscapeAnswer("escape-teleport", paPayload, paAnswer),
    /Unsupported escape operation: escape-teleport/,
  );
  assert.throws(
    () => validateEscapeAnswer("escape-pa", paPayload, "not json"),
    /escape-pa answer must be a JSON object/,
  );
  assert.throws(
    () => validateEscapeAnswer("escape-pa", { rooms: [] }, paAnswer),
    /escape-pa payload must carry a requestId/,
  );
});

const catastrophePayload = {
  requestId: "cat-game-1",
  setting: {
    title: "The Quiet Colony",
    premise: "A research colony beside a frozen lake.",
    opening: "You wake in the dormitory.",
  },
  persona: {
    name: "Dana",
    role: "engineer",
    backstory: "Ten years on the colony.",
  },
  areaIds: ["dorm", "pad", "tunnels"],
};

const catastropheAnswer = {
  requestId: "cat-game-1",
  spec: {
    id: "cat-1",
    title: "Something under the ice",
    premise: "A hunter woke beneath the lake and followed the colony's noise.",
    origin: { areaId: "pad", roomHint: "Pump room" },
    behaviours: [
      {
        kind: "hunter",
        body: {
          color: "#223344",
          scale: 1.4,
          silhouette: "quadruped",
        },
        count: 2,
        speed: 1.1,
        sightRange: 8,
        hearingWeight: 0.8,
        doors: "break",
        damage: 18,
        spawn: "single",
      },
    ],
    timeline: {
      graceSeconds: 300,
      phases: [
        { name: "omens", at: 0, behaviours: [], intensity: 0.2 },
        { name: "onset", at: 300, behaviours: [0], intensity: 0.6 },
      ],
    },
    omens: [
      {
        id: "omen-1",
        text: "The pump room pipes tick out of rhythm.",
        at: 60,
        areaId: "pad",
      },
    ],
    publicStory: "A coolant line is failing; stay in your quarters.",
  },
};

test("escape-catastrophe accepts a structural spec and echoes the requestId", () => {
  assert.deepEqual(
    validateEscapeAnswer(
      "escape-catastrophe",
      catastrophePayload,
      catastropheAnswer,
    ),
    { requestId: "cat-game-1", spec: catastropheAnswer.spec },
  );
});

test("escape-catastrophe rejects a missing spec key and a wrong requestId", () => {
  const incomplete = { ...catastropheAnswer.spec };
  delete incomplete.premise;
  rejects(
    "escape-catastrophe",
    catastrophePayload,
    { requestId: "cat-game-1", spec: incomplete },
    /escape-catastrophe spec must contain premise/,
  );
  rejects(
    "escape-catastrophe",
    catastrophePayload,
    { ...catastropheAnswer, requestId: "cat-game-2" },
    /escape-catastrophe answer must echo the exact payload requestId/,
  );
  rejects(
    "escape-catastrophe",
    catastrophePayload,
    { requestId: "cat-game-1", spec: "not a spec" },
    /escape-catastrophe spec must be a JSON object/,
  );
});

test("escape-engage accepts and normalises an optional area", () => {
  const result = validateEscapeAnswer("escape-engage", engagePayload, {
    ...engageAnswer,
    area: {
      name: "  Landing pad airlock  ",
      brief: "A frost-caked airlock beside the pad.",
      transition: "airlock",
      objectId: "rocket-hatch",
    },
  });
  assert.deepEqual(result.area, {
    name: "Landing pad airlock",
    brief: "A frost-caked airlock beside the pad.",
    transition: "airlock",
    objectId: "rocket-hatch",
    // An answer without a distance is a near place: a building next door.
    distance: "near",
  });
  // A far place needs travel, so it is a separate region.
  assert.equal(
    validateEscapeAnswer("escape-engage", engagePayload, {
      ...engageAnswer,
      area: {
        name: "Frost ridge",
        brief: "A ridge two days out across the ice.",
        transition: "vehicle",
        objectId: "rocket-hatch",
        distance: "far",
      },
    }).area.distance,
    "far",
  );
  rejects(
    "escape-engage",
    engagePayload,
    {
      ...engageAnswer,
      area: {
        name: "Frost ridge",
        brief: "A ridge two days out across the ice.",
        transition: "vehicle",
        objectId: "rocket-hatch",
        distance: "eventually",
      },
    },
    /escape-engage area\.distance must be near or far when present/,
  );
  assert.deepEqual(
    validateEscapeAnswer("escape-engage", engagePayload, engageAnswer).area,
    undefined,
  );
  for (const transition of ["hatch", "lift", "vehicle", "door", "walk"]) {
    assert.equal(
      validateEscapeAnswer("escape-engage", engagePayload, {
        ...engageAnswer,
        area: {
          name: "Door",
          brief: "A plain door.",
          transition,
          objectId: "rocket-hatch",
        },
      }).area.transition,
      transition,
    );
  }
});

test("escape-engage rejects an area with a bad transition or field", () => {
  rejects(
    "escape-engage",
    engagePayload,
    {
      ...engageAnswer,
      area: {
        name: "Door",
        brief: "A plain door.",
        transition: "teleport",
        objectId: "rocket-hatch",
      },
    },
    /escape-engage area\.transition must be airlock, hatch, lift, vehicle, door or walk/,
  );
  rejects(
    "escape-engage",
    engagePayload,
    {
      ...engageAnswer,
      area: {
        name: "Door",
        brief: "A plain door.",
        transition: "door",
        objectId: "",
      },
    },
    /escape-engage area\.objectId must be a nonempty string/,
  );
  rejects(
    "escape-engage",
    engagePayload,
    {
      ...engageAnswer,
      area: {
        name: "Door",
        brief: "A plain door.",
        transition: "door",
        objectId: "rocket-hatch",
        extra: true,
      },
    },
    /escape-engage area may not contain extra/,
  );
});

test("escape-engage accepts an area that takes the player away", () => {
  const result = validateEscapeAnswer("escape-engage", engagePayload, {
    ...engageAnswer,
    area: {
      name: "Launch gantry",
      brief: "A fuelled launch gantry above the pad.",
      transition: "vehicle",
      objectId: "rocket-hatch",
      exit: true,
    },
  });
  assert.equal(result.area.exit, true);
});

test("escape-engage rejects a non-boolean exit flag", () => {
  rejects(
    "escape-engage",
    engagePayload,
    {
      ...engageAnswer,
      area: {
        name: "Launch gantry",
        brief: "A fuelled launch gantry above the pad.",
        transition: "vehicle",
        objectId: "rocket-hatch",
        exit: "yes",
      },
    },
    /escape-engage area\.exit must be a boolean when present/,
  );
  rejects(
    "escape-engage",
    engagePayload,
    {
      ...engageAnswer,
      area: {
        name: "Launch gantry",
        brief: "A fuelled launch gantry above the pad.",
        transition: "vehicle",
        objectId: "rocket-hatch",
        exit: 1,
      },
    },
    /escape-engage area\.exit must be a boolean when present/,
  );
});

test("escape-catastrophe prose leaves shape to the schema and asks for a new mechanism that fits the place", () => {
  const prose = ESCAPE_CONTRACTS["escape-catastrophe"];
  assert.match(prose, /reply schema fixes every field name/);
  assert.doesNotMatch(prose, /is a JSON array of/);
  assert.doesNotMatch(prose, /0\.6 to 2\.2|1 to 40|240 to 900/);
  assert.doesNotMatch(prose, /never reuse or mention any earlier catastrophe/);
  assert.match(prose, /payload\.setting gives the venue, site form/);
  assert.match(prose, /payload\.recent lists the last catastrophes/);
  assert.match(prose, /different threat mechanism, not a renamed/);
  assert.match(prose, /payload\.repeated/);
  // Cross-field rules the schema cannot express stay in prose.
  assert.match(prose, /onset starts at or after it/);
  assert.match(prose, /makes-sound rule needs threshold/);
});

test("escape-catastrophe accepts a payload carrying the physical setting and recent history", () => {
  const payload = {
    ...catastrophePayload,
    setting: {
      ...catastrophePayload.setting,
      venue: "lighthouse",
      outdoors: { enclosure: "open-sky", backdrop: "sea" },
    },
    recent: [
      {
        title: "The Hollow Men",
        kinds: ["hunter"],
        hunters: [{ silhouette: "humanoid", spawn: "waves" }],
        media: [],
        triggers: [],
      },
    ],
  };
  assert.deepEqual(
    validateEscapeAnswer("escape-catastrophe", payload, catastropheAnswer),
    { requestId: "cat-game-1", spec: catastropheAnswer.spec },
  );
});

test("escape-catastrophe answers reach the escape validator", () => {
  let error;
  try {
    validateAnswer(
      { operation: "escape-catastrophe", payload: { requestId: "r1" } },
      { requestId: "r1", spec: {} },
    );
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(
    error instanceof Error,
    "an empty catastrophe spec must be rejected, not accepted",
  );
  assert.equal(
    error.message,
    "escape-catastrophe spec must contain id, title, premise, origin, behaviours, timeline, omens, publicStory",
  );
  assert.doesNotMatch(error.message, /Unsupported operation/);
});
