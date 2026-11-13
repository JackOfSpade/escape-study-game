import assert from "node:assert/strict";
import test from "node:test";
import type { AwarenessEvent, NpcSocial } from "../src/escape-types";
import {
  advanceLead,
  alarmAt,
  AUTHORITY_ROLE,
  AWARENESS_WEIGHTS,
  actionPlausibility,
  chooseNextSpeaker,
  createSocial,
  noticeSuspicion,
  observe,
  RADIO_ROLE,
  recordInteraction,
  resolveAddressee,
  socialPromptSummary,
  SUSPICIOUS_ACTIONS,
  validateOutcome,
} from "../src/npc-social";

function closeTo(actual: number, expected: number, message?: string): void {
  assert.ok(
    Math.abs(actual - expected) < 1e-12,
    message ?? `${actual} is not within 1e-12 of ${expected}`,
  );
}

function make(
  role = "Teacher",
  relationship: NpcSocial["player"]["relationship"] = "stranger",
): NpcSocial {
  return createSocial({ role, risk: 0.5, social: 0.5 }, relationship);
}

test("AUTHORITY_ROLE matches security-ish roles case-insensitively, as whole words", () => {
  for (const role of [
    "security",
    "Guard",
    "POLICE",
    "officer",
    "Marshal",
    "warden",
    "Sheriff",
    "soldier",
    "Commander",
    "Chief of Security",
    "security guard",
  ]) {
    assert.equal(AUTHORITY_ROLE.test(role), true, role);
  }
  assert.equal(AUTHORITY_ROLE.test("teacher"), false);
  assert.equal(AUTHORITY_ROLE.test("guardian"), false);
  assert.equal(AUTHORITY_ROLE.test("security analyst"), true);
  assert.equal(AUTHORITY_ROLE.ignoreCase, true);
  assert.equal(AUTHORITY_ROLE.global, false);
});

test("RADIO_ROLE adds flight, dispatch and site roles to the authority words", () => {
  for (const role of [
    "Pilot",
    "dispatcher",
    "controller",
    "Captain",
    "foreman",
    "ranger",
    "security guard",
    "Chief of Security",
  ]) {
    assert.equal(RADIO_ROLE.test(role), true, role);
  }
  assert.equal(RADIO_ROLE.test("teacher"), false);
  assert.equal(RADIO_ROLE.test("pilotfish"), false);
});

test("createSocial: authority holds a 4 s check-back, everyone else follows risk and social", () => {
  assert.deepEqual(
    createSocial(
      { role: "Security Guard", risk: 0.5, social: 0.5 },
      "stranger",
    ),
    {
      alarm: 0,
      awareness: [],
      player: { relationship: "stranger", suspicion: 0, history: [] },
      canDetain: true,
      hasRadio: true,
      checkBackSeconds: 4,
    },
  );
  const teacher = createSocial(
    { role: "Teacher", risk: 0.8, social: 0.2 },
    "friend",
  );
  assert.equal(teacher.canDetain, false);
  assert.equal(teacher.hasRadio, false);
  assert.equal(teacher.checkBackSeconds, 15); // 4 + 8 + 3.2 rounds to 15
  const slow = createSocial({ role: "Clerk", risk: 1, social: 0 }, "colleague");
  assert.equal(slow.checkBackSeconds, 18);
  const prompt = createSocial(
    { role: "Clerk", risk: 0, social: 1 },
    "colleague",
  );
  assert.equal(prompt.checkBackSeconds, 4);
  const pilot = createSocial({ role: "Pilot", risk: 1, social: 0 }, "superior");
  assert.equal(pilot.canDetain, false);
  assert.equal(pilot.hasRadio, true);
  assert.equal(pilot.checkBackSeconds, 18);
  const chief = createSocial(
    { role: "Chief of Security", risk: 1, social: 0 },
    "subordinate",
  );
  assert.equal(chief.canDetain, true);
  assert.equal(chief.checkBackSeconds, 4);
});

test("AWARENESS_WEIGHTS is the exact alarm table", () => {
  assert.deepEqual(AWARENESS_WEIGHTS, {
    pa: 0.1,
    scream: 0.45,
    running: 0.3,
    body: 0.6,
    "threat-seen": 0.9,
    "hazard-seen": 0.7,
    told: 0.25,
    "suspicious-act": 0.05,
    alarm: 0.5,
  });
});

test("alarmAt: half-life decay, ignored future events, product and clamp", () => {
  const s = make();
  s.awareness = [
    { kind: "body", at: 0, text: "body", weight: AWARENESS_WEIGHTS.body },
  ];
  closeTo(alarmAt(s, 0), 0.6);
  closeTo(alarmAt(s, 300), 0.3);
  closeTo(alarmAt(s, 600), 0.15);
  const future: AwarenessEvent[] = [
    { kind: "threat-seen", at: 100, text: "future", weight: 0.9 },
  ];
  s.awareness = future;
  assert.equal(alarmAt(s, 0), 0);
  s.awareness = [
    { kind: "told", at: 0, text: "one", weight: 0.5 },
    { kind: "pa", at: 0, text: "two", weight: 0.5 },
  ];
  closeTo(alarmAt(s, 0), 0.75);
  s.awareness = [{ kind: "alarm", at: 0, text: "odd", weight: -0.25 }];
  assert.equal(alarmAt(s, 0), 0);
  assert.equal(alarmAt(s, -50), 0);
});

test("observe appends, keeps the newest 24 and recomputes alarm", () => {
  const s = make();
  for (let i = 0; i < 26; i++) {
    observe(
      s,
      {
        kind: "told",
        at: i,
        text: `told ${i}`,
        weight: AWARENESS_WEIGHTS.told,
      },
      100,
    );
  }
  assert.equal(s.awareness.length, 24);
  assert.deepEqual(
    s.awareness.slice(0, 2).map((event) => event.text),
    ["told 2", "told 3"],
  );
  assert.equal(s.awareness[23]?.text, "told 25");
  assert.equal(s.alarm, alarmAt(s, 100));
  assert.ok(s.alarm > 0 && s.alarm < 1);
});

test("recordInteraction keeps the newest 32 interactions", () => {
  const s = make();
  for (let i = 0; i < 33; i++) {
    recordInteraction(s, {
      at: i,
      kind: "asked",
      text: `asked ${i}`,
    });
  }
  assert.equal(s.player.history.length, 32);
  assert.deepEqual(s.player.history[0], {
    at: 1,
    kind: "asked",
    text: "asked 1",
  });
  assert.deepEqual(s.player.history[31], {
    at: 32,
    kind: "asked",
    text: "asked 32",
  });
  const boss = make();
  recordInteraction(boss, { at: 5, kind: "lied", text: "claim" });
  assert.deepEqual(boss.player.history, [
    { at: 5, kind: "lied", text: "claim" },
  ]);
});

test("SUSPICIOUS_ACTIONS lists exactly the nine suspicious actions", () => {
  assert.deepEqual(SUSPICIOUS_ACTIONS, [
    "repair",
    "hotwire",
    "force-door",
    "tamper",
    "enter-restricted",
    "read-restricted",
    "take",
    "launch",
    "unlock",
  ]);
});

test("actionPlausibility: role keyword tables and the other-role fallback", () => {
  for (const role of ["Engineer", "technician", "Aircraft Mechanic"]) {
    assert.equal(actionPlausibility(role, "repair"), 0.9, role);
    assert.equal(actionPlausibility(role, "tamper"), 0.9, role);
    assert.equal(actionPlausibility(role, "hotwire"), 0.5, role);
    assert.equal(actionPlausibility(role, "force-door"), 0.1, role);
  }
  for (const role of ["Security Guard", "police officer", "Commander"]) {
    assert.equal(actionPlausibility(role, "force-door"), 0.9, role);
    assert.equal(actionPlausibility(role, "enter-restricted"), 0.9, role);
    assert.equal(actionPlausibility(role, "unlock"), 0.9, role);
    assert.equal(actionPlausibility(role, "repair"), 0.1, role);
  }
  assert.equal(
    actionPlausibility("Research Scientist", "read-restricted"),
    0.8,
  );
  assert.equal(actionPlausibility("doctor", "read-restricted"), 0.8);
  assert.equal(actionPlausibility("Pilot", "launch"), 0.7);
  assert.equal(actionPlausibility("Astronaut", "launch"), 0.7);
  assert.equal(actionPlausibility("Teacher", "repair"), 0.1);
  assert.equal(actionPlausibility("clerk", "unlock"), 0.1);
  assert.equal(actionPlausibility("Teacher", "take"), 0.3);
  assert.equal(actionPlausibility("clerk", "take"), 0.3);
  assert.equal(actionPlausibility("Teacher", "dance"), 0);
  assert.equal(actionPlausibility("Engineer", ""), 0);
});

test("noticeSuspicion: seen acts raise twice the suspicion of heard ones and record history", () => {
  const seen = make();
  const response = noticeSuspicion(seen, {
    plausibility: 0.2,
    witnessed: "seen",
    now: 7,
  });
  assert.equal(response, "watch");
  assert.equal(seen.player.suspicion, 0.4);
  assert.deepEqual(seen.player.history, [
    { at: 7, kind: "suspicious", text: "Suspicious act seen." },
  ]);
  const heard = make();
  assert.equal(
    noticeSuspicion(heard, {
      plausibility: 0.2,
      witnessed: "heard",
      now: 7,
    }),
    "question",
  );
  assert.equal(heard.player.suspicion, 0.2);
  assert.equal(heard.player.history.length, 1);
  const easy = make();
  assert.equal(
    noticeSuspicion(easy, {
      plausibility: 0.9,
      witnessed: "seen",
      now: 1,
    }),
    "ignore",
  );
  closeTo(easy.player.suspicion, 0.05);
  const obvious = make();
  assert.equal(
    noticeSuspicion(obvious, {
      plausibility: 0,
      witnessed: "heard",
      now: 1,
    }),
    "question",
  );
  assert.equal(obvious.player.suspicion, 0.25);
});

test("noticeSuspicion: alarm dampens the gain but the ladder ignores it below 0.7", () => {
  const s = make();
  s.alarm = 0.5;
  const response = noticeSuspicion(s, {
    plausibility: 0,
    witnessed: "seen",
    now: 2,
  });
  assert.equal(response, "question");
  closeTo(s.player.suspicion, 0.3);
});

test("noticeSuspicion: detain and intervene both need authority, otherwise report", () => {
  const guard = make("Security Guard");
  guard.player.suspicion = 0.2;
  assert.equal(
    noticeSuspicion(guard, {
      plausibility: 0,
      witnessed: "seen",
      now: 3,
    }),
    "intervene",
  );
  closeTo(guard.player.suspicion, 0.7);
  const teacher = make();
  teacher.player.suspicion = 0.2;
  assert.equal(
    noticeSuspicion(teacher, {
      plausibility: 0,
      witnessed: "seen",
      now: 3,
    }),
    "report",
  );
  const detaining = make("Warden");
  detaining.player.suspicion = 0.35;
  assert.equal(
    noticeSuspicion(detaining, {
      plausibility: 0,
      witnessed: "seen",
      now: 4,
    }),
    "detain",
  );
  closeTo(detaining.player.suspicion, 0.85);
  const reporting = make("Teacher");
  reporting.player.suspicion = 0.35;
  assert.equal(
    noticeSuspicion(reporting, {
      plausibility: 0,
      witnessed: "seen",
      now: 4,
    }),
    "report",
  );
});

test("noticeSuspicion caps suspicion at 1", () => {
  const guard = make("Officer");
  guard.player.suspicion = 0.9;
  assert.equal(
    noticeSuspicion(guard, {
      plausibility: 0,
      witnessed: "seen",
      now: 5,
    }),
    "detain",
  );
  assert.equal(guard.player.suspicion, 1);
});

test("noticeSuspicion: panicking NPCs or alarm >= 0.7 ignore and do not raise suspicion", () => {
  const alarmed = make();
  alarmed.alarm = 0.7;
  assert.equal(
    noticeSuspicion(alarmed, {
      plausibility: 0,
      witnessed: "seen",
      now: 6,
    }),
    "ignore",
  );
  assert.equal(alarmed.player.suspicion, 0);
  assert.deepEqual(alarmed.player.history, []);
  const panicking = make();
  assert.equal(
    noticeSuspicion(panicking, {
      plausibility: 0,
      witnessed: "seen",
      now: 6,
      panicking: true,
    }),
    "ignore",
  );
  assert.equal(panicking.player.suspicion, 0);
  assert.deepEqual(panicking.player.history, []);
  const nearly = make();
  nearly.alarm = 0.69;
  assert.equal(
    noticeSuspicion(nearly, {
      plausibility: 0.9,
      witnessed: "seen",
      now: 6,
    }),
    "ignore",
  );
  assert.ok(nearly.player.suspicion > 0);
});

test("validateOutcome: every kind passes through normalised, with unknown keys stripped", () => {
  const ctx = {
    canDetain: true,
    atDoorIds: ["door-1"],
    knownFactIds: ["fact-1"],
    leadTargets: ["lift"],
  };
  for (const kind of [
    "none",
    "follow",
    "stop-following",
    "refuse",
    "ask-for-proof",
    "report",
    "watch",
  ]) {
    assert.deepEqual(validateOutcome({ kind, extra: 1 }, ctx), {
      outcome: { kind },
    });
  }
  assert.deepEqual(
    validateOutcome({ kind: "share-fact", factId: "fact-1", text: "x" }, ctx),
    { outcome: { kind: "share-fact", factId: "fact-1" } },
  );
  assert.deepEqual(validateOutcome({ kind: "lead", targetId: "lift" }, ctx), {
    outcome: { kind: "lead", targetId: "lift" },
  });
  assert.deepEqual(validateOutcome({ kind: "detain", text: "x" }, ctx), {
    outcome: { kind: "detain" },
  });
  assert.deepEqual(validateOutcome({ kind: "intervene" }, ctx), {
    outcome: { kind: "intervene" },
  });
  assert.deepEqual(
    validateOutcome({ kind: "unlock", doorId: "door-1", text: "x" }, ctx),
    { outcome: { kind: "unlock", doorId: "door-1" } },
  );
  assert.deepEqual(validateOutcome({ kind: "alarm", delta: 0.3 }, ctx), {
    outcome: { kind: "alarm", delta: 0.3 },
  });
  assert.deepEqual(validateOutcome({ kind: "alarm", delta: -0.3 }, ctx), {
    outcome: { kind: "alarm", delta: -0.3 },
  });
});

test("validateOutcome: authority gates detain and intervene", () => {
  const weak = {
    canDetain: false,
    atDoorIds: [],
    knownFactIds: [],
    leadTargets: [],
  };
  assert.deepEqual(validateOutcome({ kind: "detain" }, weak), {
    outcome: { kind: "none" },
    rejected: "no authority to detain",
  });
  assert.deepEqual(validateOutcome({ kind: "intervene" }, weak), {
    outcome: { kind: "none" },
    rejected: "no authority to intervene",
  });
});

test("validateOutcome rejects malformed, unknown, unavailable and out-of-range outcomes", () => {
  const ctx = {
    canDetain: false,
    atDoorIds: ["door-1"],
    knownFactIds: ["fact-1"],
    leadTargets: ["lift"],
  };
  const rejectedWith = (input: unknown, reason: string) => {
    assert.deepEqual(validateOutcome(input, ctx), {
      outcome: { kind: "none" },
      rejected: reason,
    });
  };
  rejectedWith(null, "outcome is not an object");
  rejectedWith([], "outcome is not an object");
  rejectedWith({ kind: 5 }, "outcome kind is missing");
  rejectedWith({}, "outcome kind is missing");
  rejectedWith({ kind: "dance" }, "unknown outcome kind: dance");
  rejectedWith({ kind: "share-fact" }, "share-fact needs a factId");
  rejectedWith(
    { kind: "share-fact", factId: "fact-2" },
    "unknown fact: fact-2",
  );
  rejectedWith({ kind: "lead" }, "lead needs a targetId");
  rejectedWith(
    { kind: "lead", targetId: "stairs" },
    "unknown lead target: stairs",
  );
  rejectedWith({ kind: "unlock", doorId: "door-2" }, "not at door: door-2");
  rejectedWith({ kind: "unlock" }, "unlock needs a doorId");
  rejectedWith(
    { kind: "alarm", delta: Number.NaN },
    "alarm delta is not a finite number",
  );
  rejectedWith(
    { kind: "alarm", delta: Number.POSITIVE_INFINITY },
    "alarm delta is not a finite number",
  );
  rejectedWith(
    { kind: "alarm", delta: "0.1" },
    "alarm delta is not a finite number",
  );
  rejectedWith(
    { kind: "alarm", delta: -0.31 },
    "alarm delta out of range: -0.31",
  );
  rejectedWith(
    { kind: "alarm", delta: 0.31 },
    "alarm delta out of range: 0.31",
  );
  rejectedWith(
    { kind: "agree-with-conditions", condition: "" },
    "condition is empty",
  );
  rejectedWith(
    { kind: "agree-with-conditions", condition: "   " },
    "condition is empty",
  );
  rejectedWith(
    { kind: "agree-with-conditions", condition: "x".repeat(161) },
    "condition is longer than 160 characters",
  );
  rejectedWith(
    { kind: "agree-with-conditions" },
    "agree-with-conditions needs a condition",
  );
});

test("validateOutcome accepts a 160-character condition and keeps it verbatim", () => {
  const ctx = {
    canDetain: true,
    atDoorIds: [],
    knownFactIds: [],
    leadTargets: [],
  };
  const full = "c".repeat(160);
  assert.deepEqual(
    validateOutcome({ kind: "agree-with-conditions", condition: full }, ctx),
    { outcome: { kind: "agree-with-conditions", condition: full } },
  );
  assert.deepEqual(
    validateOutcome(
      { kind: "agree-with-conditions", condition: "  bring a badge  " },
      ctx,
    ),
    {
      outcome: {
        kind: "agree-with-conditions",
        condition: "  bring a badge  ",
      },
    },
  );
});

const speaker = { x: 0, y: 0, yaw: 0 };
const deg = Math.PI / 180;

test("resolveAddressee: a spoken first name overrides facing and location", () => {
  const listeners = [
    {
      id: "ada",
      name: "Ada Lovelace",
      x: 0,
      y: -5,
      canHear: true,
    },
  ];
  assert.equal(resolveAddressee(speaker, "hello Ada", listeners), "ada");
  assert.equal(resolveAddressee(speaker, "ADA, wait", listeners), "ada");
  assert.equal(
    resolveAddressee(speaker, "you cannot hear me", listeners),
    undefined,
  );
  assert.equal(
    resolveAddressee(speaker, "hello Ada", [
      { ...listeners[0], canHear: false },
    ]),
    undefined,
  );
});

test("resolveAddressee: the earliest name mention wins", () => {
  const listeners = [
    { id: "ada", name: "Ada", x: 0, y: -5, canHear: true },
    { id: "bob", name: "Bob", x: 0, y: 5, canHear: true },
  ];
  assert.equal(
    resolveAddressee(speaker, "Bob, have you seen Ada?", listeners),
    "bob",
  );
  assert.equal(
    resolveAddressee(speaker, "Ada says Bob is late", listeners),
    "ada",
  );
  assert.equal(
    resolveAddressee(speaker, "adamant is not a name", listeners),
    undefined,
  );
});

test("resolveAddressee: facing cone edge at 30 degrees is inside, 31 is outside", () => {
  const inside = [
    {
      id: "edge",
      name: "Edge Case",
      x: 9.5 * Math.cos(30 * deg),
      y: 9.5 * Math.sin(30 * deg),
      canHear: true,
    },
  ];
  assert.equal(resolveAddressee(speaker, "anyone?", inside), "edge");
  const outside = [
    {
      id: "edge",
      name: "Edge Case",
      x: 9.5 * Math.cos(31 * deg),
      y: 9.5 * Math.sin(31 * deg),
      canHear: true,
    },
  ];
  assert.equal(resolveAddressee(speaker, "anyone?", outside), undefined);
  const behind = [{ id: "back", name: "Back", x: -5, y: 0, canHear: true }];
  assert.equal(resolveAddressee(speaker, "anyone?", behind), undefined);
});

test("resolveAddressee: 10-tile earshot, smallest angle then nearer", () => {
  const far = [{ id: "far", name: "Far", x: 10.5, y: 0, canHear: true }];
  assert.equal(resolveAddressee(speaker, "anyone?", far), undefined);
  const angled = [
    {
      id: "twenty",
      name: "Twenty",
      x: 10 * Math.cos(20 * deg),
      y: 10 * Math.sin(20 * deg),
      canHear: true,
    },
    {
      id: "ten",
      name: "Ten",
      x: 10 * Math.cos(-10 * deg),
      y: 10 * Math.sin(-10 * deg),
      canHear: true,
    },
  ];
  assert.equal(resolveAddressee(speaker, "anyone?", angled), "ten");
  const tied = [
    {
      id: "farther",
      name: "Farther",
      x: 8 * Math.cos(10 * deg),
      y: 8 * Math.sin(10 * deg),
      canHear: true,
    },
    {
      id: "nearer",
      name: "Nearer",
      x: 4 * Math.cos(10 * deg),
      y: 4 * Math.sin(10 * deg),
      canHear: true,
    },
  ];
  assert.equal(resolveAddressee(speaker, "anyone?", tied), "nearer");
  const deaf = [{ id: "near", name: "Near", x: 2, y: 0, canHear: false }];
  assert.equal(resolveAddressee(speaker, "anyone?", deaf), undefined);
  assert.equal(resolveAddressee(speaker, "anyone?", []), undefined);
});

test("chooseNextSpeaker: a 2 second speak cooldown excludes recent speakers", () => {
  const candidates = [
    {
      id: "recent",
      addressed: false,
      relevance: 1,
      social: 1,
      spokeAt: 8.5,
    },
    { id: "quiet", addressed: false, relevance: 0.5, social: 0.5 },
  ];
  assert.equal(
    chooseNextSpeaker(candidates, 10, () => 0),
    "quiet",
  );
  const onCooldownEdge = [{ ...candidates[0], spokeAt: 8 }, candidates[1]];
  assert.equal(
    chooseNextSpeaker(onCooldownEdge, 10, () => 0),
    "recent",
  );
  assert.equal(
    chooseNextSpeaker(
      [{ id: "recent", addressed: false, relevance: 1, social: 1, spokeAt: 9 }],
      10,
      () => 0,
    ),
    undefined,
  );
});

test("chooseNextSpeaker: the first addressed listener always wins", () => {
  let draws = 0;
  const candidates = [
    { id: "loud", addressed: false, relevance: 1, social: 1 },
    { id: "boss", addressed: true, relevance: 0, social: 0 },
    { id: "other", addressed: true, relevance: 1, social: 1 },
  ];
  assert.equal(
    chooseNextSpeaker(candidates, 10, () => {
      draws++;
      return 0;
    }),
    "boss",
  );
  assert.equal(draws, 0);
  const muted = [
    {
      id: "boss",
      addressed: true,
      relevance: 0,
      social: 0,
      spokeAt: 9.5,
    },
    { id: "quiet", addressed: false, relevance: 0.5, social: 0.5 },
  ];
  assert.equal(
    chooseNextSpeaker(muted, 10, () => 0),
    "quiet",
  );
});

test("chooseNextSpeaker: relevance + personality + one rng draw per candidate, threshold 0.45", () => {
  assert.equal(
    chooseNextSpeaker(
      [{ id: "meh", addressed: false, relevance: 0.5, social: 0 }],
      10,
      () => 0,
    ),
    undefined,
  );
  assert.equal(
    chooseNextSpeaker(
      [{ id: "lift", addressed: false, relevance: 0.5, social: 0 }],
      10,
      () => 0.75,
    ),
    "lift",
  );
  assert.equal(
    chooseNextSpeaker(
      [{ id: "lift", addressed: false, relevance: 0.5, social: 0 }],
      10,
      () => 0.74,
    ),
    undefined,
  );
  const draws: number[] = [0, 0.99];
  let index = 0;
  const candidates = [
    { id: "steady", addressed: false, relevance: 0.8, social: 0.2 },
    { id: "nosy", addressed: false, relevance: 0.2, social: 1 },
  ];
  assert.equal(
    chooseNextSpeaker(candidates, 10, () => draws[index++] ?? 0),
    "nosy",
  );
  assert.equal(index, 2);
  assert.equal(
    chooseNextSpeaker(
      [
        { id: "first", addressed: false, relevance: 0.5, social: 0.5 },
        { id: "second", addressed: false, relevance: 0.5, social: 0.5 },
      ],
      10,
      () => 0,
    ),
    "first",
  );
  assert.equal(
    chooseNextSpeaker([], 10, () => 0),
    undefined,
  );
});

type LeadGoal = Parameters<typeof advanceLead>[0];
type LeadInput = Parameters<typeof advanceLead>[1];

const leadGoal: LeadGoal = {
  kind: "lead",
  target: { floor: 0, x: 5, y: 5 },
  label: "stairs",
  nextCheck: 10,
  stage: "leading",
};

function away(now: number): LeadInput {
  return {
    now,
    playerDistance: 30,
    playerVisible: false,
    checkBackSeconds: 5,
  };
}

test("advanceLead: before nextCheck nothing is checked and the input is untouched", () => {
  const snapshot = structuredClone(leadGoal);
  const result = advanceLead(leadGoal, {
    now: 9.9,
    playerDistance: 50,
    playerVisible: false,
    checkBackSeconds: 5,
  });
  assert.deepEqual(result, { goal: leadGoal });
  assert.notEqual(result.goal, leadGoal);
  assert.deepEqual(leadGoal, snapshot);
});

test("advanceLead: a short stop within 6 tiles does not count as lost", () => {
  const six = advanceLead(leadGoal, {
    now: 10,
    playerDistance: 6,
    playerVisible: false,
    checkBackSeconds: 5,
  });
  assert.deepEqual(six, { goal: { ...leadGoal, nextCheck: 15 } });
  assert.equal(six.event, undefined);
  const visibleTwelve = advanceLead(leadGoal, {
    now: 10,
    playerDistance: 12,
    playerVisible: true,
    checkBackSeconds: 5,
  });
  assert.deepEqual(visibleTwelve, {
    goal: { ...leadGoal, nextCheck: 15 },
  });
  const unseenTwelve = advanceLead(leadGoal, {
    now: 10,
    playerDistance: 12,
    playerVisible: false,
    checkBackSeconds: 5,
  });
  assert.equal(unseenTwelve.event, "lost-player");
  assert.equal(unseenTwelve.goal.stage, "looking");
});

test("advanceLead: a failed check at the door schedules looking and lost-player", () => {
  const snapshot = structuredClone(leadGoal);
  const result = advanceLead(leadGoal, {
    now: 10,
    playerDistance: 6.5,
    playerVisible: false,
    checkBackSeconds: 5,
  });
  assert.deepEqual(result, {
    goal: {
      ...leadGoal,
      stage: "looking",
      missingSince: 10,
      nextCheck: 12,
    },
    event: "lost-player",
  });
  assert.deepEqual(leadGoal, snapshot);
});

test("advanceLead: calling at +4, returning at +8, gave-up exactly once at +20", () => {
  const expectedStage: Record<number, LeadGoal["stage"]> = {
    12: "looking",
    14: "calling",
    16: "calling",
    18: "returning",
    20: "returning",
    22: "returning",
    24: "returning",
    26: "returning",
    28: "returning",
    30: "returning",
    32: "returning",
  };
  let current: LeadGoal = {
    ...leadGoal,
    stage: "looking",
    missingSince: 10,
    nextCheck: 12,
  };
  for (let now = 12; now <= 32; now += 2) {
    const step = advanceLead(current, away(now));
    assert.equal(step.goal.stage, expectedStage[now], `stage at ${now}`);
    assert.equal(step.goal.missingSince, 10, `missingSince at ${now}`);
    assert.equal(step.goal.nextCheck, now + 2, `nextCheck at ${now}`);
    if (now === 30) assert.equal(step.event, "gave-up");
    else assert.equal(step.event, undefined, `event at ${now}`);
    current = step.goal;
  }
});

test("advanceLead: found-player resets to leading and the personality check-back", () => {
  const returning: LeadGoal = {
    ...leadGoal,
    stage: "returning",
    missingSince: 0,
    nextCheck: 24,
  };
  const found = advanceLead(returning, {
    now: 24,
    playerDistance: 5,
    playerVisible: false,
    checkBackSeconds: 4,
  });
  assert.deepEqual(found, {
    goal: {
      ...returning,
      stage: "leading",
      missingSince: undefined,
      nextCheck: 28,
    },
    event: "found-player",
  });
  const calling: LeadGoal = {
    ...leadGoal,
    stage: "calling",
    missingSince: 0,
    nextCheck: 20,
  };
  const seen = advanceLead(calling, {
    now: 20,
    playerDistance: 12,
    playerVisible: true,
    checkBackSeconds: 7,
  });
  assert.deepEqual(seen, {
    goal: {
      ...calling,
      stage: "leading",
      missingSince: undefined,
      nextCheck: 27,
    },
    event: "found-player",
  });
  const early = advanceLead(returning, away(23));
  assert.deepEqual(early, { goal: returning });
  assert.notEqual(early.goal, returning);
});

test("socialPromptSummary: alarm bands, recent 6 and the newest 8 interactions", () => {
  const s = make("Clerk", "superior");
  s.alarm = 0.5;
  s.awareness = Array.from({ length: 8 }, (_, i) => ({
    kind: "told" as const,
    at: i,
    text: `a${i}`,
    weight: AWARENESS_WEIGHTS.told,
  }));
  s.player.suspicion = 0.42;
  s.player.history = Array.from({ length: 10 }, (_, i) => ({
    at: i,
    kind: "asked" as const,
    text: `h${i}`,
  }));
  assert.deepEqual(socialPromptSummary(s, 999), {
    alarm: "alarmed",
    recent: ["a2", "a3", "a4", "a5", "a6", "a7"],
    history: [
      "asked: h2",
      "asked: h3",
      "asked: h4",
      "asked: h5",
      "asked: h6",
      "asked: h7",
      "asked: h8",
      "asked: h9",
    ],
    relationship: "superior",
    suspicion: 0.42,
  });
  for (const [alarm, band] of [
    [0, "calm"],
    [0.19, "calm"],
    [0.2, "uneasy"],
    [0.44, "uneasy"],
    [0.45, "alarmed"],
    [0.69, "alarmed"],
    [0.7, "panicking"],
    [1, "panicking"],
  ] as const) {
    s.alarm = alarm;
    assert.equal(socialPromptSummary(s, 0).alarm, band, `alarm ${alarm}`);
  }
  const empty = socialPromptSummary(make(), 12);
  assert.deepEqual(empty, {
    alarm: "calm",
    recent: [],
    history: [],
    relationship: "stranger",
    suspicion: 0,
  });
  assert.deepEqual(Object.keys(empty).sort(), [
    "alarm",
    "history",
    "recent",
    "relationship",
    "suspicion",
  ]);
});
