import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Furniture, Game, Problem, Roadmap, Zombie } from "../src/model";
import {
  buildNpcChatterContext,
  npcChatterCandidates,
  npcChatterStillRelevant,
  npcDialogueFactsStillRelevant,
  npcSpeechFactId,
  parseNpcChatterReply,
  NPC_CHATTER_CONTEXT_SECONDS,
  type NpcChatterConversation,
  type NpcChatterRecentLine,
} from "../src/npc-chatter";
import { actor, createGame, createPlayableGame } from "../src/world";
import { canSee } from "../src/visibility";
import { isNpcDialogueContext } from "../scripts/lib/npc-dialogue-policy.mjs";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
function fixture() {
  const g = createGame(42, roadmap),
    f = g.floors[0],
    npc = Object.assign(actor("survivor-one", "Maya", 1), {
      x: 12,
      y: 10,
      activity: "exploring" as const,
    });
  g.status = "playing";
  g.time = 10;
  g.survivors = [g.survivors[0], npc];
  Object.assign(g.survivors[0], { x: 10, y: 10 });
  g.zombies = [];
  g.events = [];
  f.tiles = Array.from({ length: 34 }, () => Array(44).fill(0));
  f.furniture = [];
  f.stations = [];
  return { g, f, npc };
}
function zombie(id: string, x: number, y: number): Zombie {
  return {
    id,
    x,
    y,
    floor: 0,
    hp: 60,
    path: [],
    repath: 0,
    cooldown: 0,
    memory: 0,
    stagger: 0,
    origin: "outside",
  };
}
function ownTask(g: Game) {
  const npc = g.survivors[1],
    f = g.floors[0],
    e = g.encounters["f0-room0"];
  const problem: Problem = {
    title: "Check an empty input",
    prompt:
      "Explain how the function handles an empty sequence before changing it.",
    starter: "def count_items(items):\n    return len(items)",
    rubric: ["Explain the empty-input boundary"],
    provenance: "development",
    contract: {
      id: "npc-owned-question",
      track: "PY",
      objectiveIds: ["PY:T01"],
      scopes: ["empty-input"],
      depth: 1,
      phase: "practice",
      review: false,
      ledgerVersion: 1,
      priorEvidence: [],
    },
  };
  Object.assign(e, {
    owner: npc.id,
    mode: "solo",
    floor: 0,
    runId: g.id,
    state: "in-progress",
    problem,
    workspace: "npc-owned-public-workspace",
    revision: 3,
    history: [],
    group: [],
    tutor: [],
  });
  const station = {
    id: "npc-owned-station",
    encounter: e.id,
    x: npc.x + 0.8,
    y: npc.y,
  };
  f.stations = [station];
  Object.assign(npc, {
    station: station.id,
    intent: e.id,
    activity: "studying",
    milestone: 2,
  });
  return { e, station };
}

test("NPC chatter captures its own current solo task and perceived world without private learner context or writes", () => {
  const { g, f, npc } = fixture(),
    { e } = ownTask(g);
  npc.keys = 2;
  npc.access = [0];
  npc.hp = 52;
  npc.target = { x: 13, y: 10 };
  g.zombies = [zombie("visible-attacker", 14, 10)];
  e.tutor.push({
    id: "private",
    author: "human",
    kind: "human",
    text: "PRIVATE-TUTOR-SECRET",
    seq: 70,
    worldTime: 9,
    provenance: "synthetic",
  });
  e.history.push(
    {
      seq: 70,
      author: npc.id,
      kind: "npc-thought",
      text: "PRIVATE-TUTOR-SECRET",
      at: 9,
      revision: 3,
    },
    {
      seq: 71,
      author: npc.id,
      kind: "source-view",
      text: "PRIVATE-SOURCE-VIEW",
      at: 9,
      revision: 3,
    },
    {
      seq: 72,
      author: npc.id,
      kind: "npc-thought",
      text: "I should check the empty boundary first.",
      at: 9,
      revision: 3,
    },
  );
  e.group.push({
    id: "not-solo-public",
    author: "human",
    kind: "human",
    text: "OTHER-LEARNER-MESSAGE",
    seq: 73,
    worldTime: 9,
    provenance: "synthetic",
  });
  (g.study as unknown as Record<string, unknown>).privateTestMarker =
    "PRIVATE-LEARNER-LEDGER";
  g.survivors[0].intent = "OTHER-ACTOR-PRIVATE-INTENT";
  g.notice = "GLOBAL-NOTICE-SECRET";
  g.events.push({
    seq: 80,
    at: 9,
    type: "completion",
    floor: 0,
    text: "UNHEARD-PRIVATE-EVENT",
  });
  const before = JSON.stringify(g),
    context = buildNpcChatterContext(g, npc, "chatter-1", [
      { actorId: npc.id, text: "Keep the doorway clear.", at: 8 },
      { actorId: "someone-hidden", text: "UNHEARD-CHATTER", at: 8 },
      { actorId: npc.id, text: "FUTURE-CHATTER", at: 11 },
    ]);
  assert.equal(JSON.stringify(g), before);
  assert.equal(context.actorId, npc.id);
  assert.equal(context.self.healthBand, "hurt");
  assert.equal(context.self.keys, 2);
  assert.equal(context.self.personalStairAccess, true);
  assert.deepEqual(
    context.self.personality.strengths,
    npc.technical!.strengths,
  );
  assert.equal(context.task?.encounterId, e.id);
  assert.equal(context.task?.problem?.title, e.problem!.title);
  assert.equal(context.task?.workspace, e.workspace);
  assert.deepEqual(
    context.task?.ownPublicNotes.map((n) => n.text),
    ["I should check the empty boundary first."],
  );
  assert.deepEqual(
    context.perception.visibleThreats.map((z) => z.id),
    ["visible-attacker"],
  );
  assert.equal(context.perception.threatBand, "immediate");
  assert.deepEqual(
    context.recentLines.map((l) => l.text),
    ["Keep the doorway clear."],
  );
  for (const secret of [
    "PRIVATE-TUTOR-SECRET",
    "PRIVATE-SOURCE-VIEW",
    "OTHER-LEARNER-MESSAGE",
    "PRIVATE-LEARNER-LEDGER",
    "OTHER-ACTOR-PRIVATE-INTENT",
    "GLOBAL-NOTICE-SECRET",
    "UNHEARD-PRIVATE-EVENT",
    "UNHEARD-CHATTER",
    "FUTURE-CHATTER",
  ])
    assert.equal(JSON.stringify(context).includes(secret), false, secret);
  context.self.personality.strengths.reasoning = 0;
  assert.notEqual(npc.technical!.strengths.reasoning, 0);
  e.workspace = "newer-work";
  f.stations[0].x++;
  assert.equal(context.task!.workspace, "npc-owned-public-workspace");
});

test("hidden enemy movement and unseen deaths cannot change an NPC's captured knowledge", () => {
  const { g, f, npc } = fixture();
  for (let y = 0; y < 34; y++) f.tiles[y][15] = 1;
  const hidden = zombie("hidden-attacker", 18, 10);
  g.zombies = [hidden, { ...zombie("other-floor", 12, 10), floor: 1 }];
  npc.threatMemory = {
    floor: 0,
    nextSample: 10.1,
    observations: [{ id: hidden.id, x: 14, y: 10, at: 9.8 }],
  };
  const first = buildNpcChatterContext(g, npc, "same-request");
  hidden.x = 30;
  hidden.hp = 0;
  g.zombies.push(zombie("new-unseen-attacker", 17, 11));
  const after = buildNpcChatterContext(g, npc, "same-request");
  assert.deepEqual(after, first);
  assert.deepEqual(after.perception.visibleThreats, []);
  assert.equal(after.perception.rememberedThreats[0].position.dx, 2);
  assert.equal(after.perception.threatBand, "watchful");
  assert.equal(npcChatterStillRelevant(g, first), true);
});

test("candidate selection requires a nearby live same-floor person with real sight or an open acoustic path", () => {
  const { g, f, npc } = fixture();
  const aroundCorner = Object.assign(actor("around-corner", "Theo", 2), {
    x: 14.5,
    y: 12.5,
  });
  const far = Object.assign(actor("far", "Far", 3), { x: 30, y: 10 });
  const dead = Object.assign(actor("dead", "Dead", 4), {
    x: 11,
    y: 10,
    alive: false,
  });
  const elsewhere = Object.assign(actor("elsewhere", "Elsewhere", 5), {
    x: 11,
    y: 10,
    floor: 1,
  });
  g.survivors.push(aroundCorner, far, dead, elsewhere);
  for (let y = 0; y < 34; y++) if (y !== 9 && y !== 10) f.tiles[y][13] = 1;
  assert.deepEqual(
    npcChatterCandidates(g).map((a) => a.id),
    [npc.id, aroundCorner.id],
  );
  f.tiles[10][13] = 1;
  f.tiles[9][13] = 1;
  assert.deepEqual(
    npcChatterCandidates(g).map((a) => a.id),
    [npc.id],
  );
  g.paused = true;
  assert.deepEqual(npcChatterCandidates(g), []);
  g.paused = false;
  g.studyWorkspace = { enabled: true, wasPaused: false };
  assert.deepEqual(npcChatterCandidates(g), []);
  delete g.studyWorkspace;
  g.status = "dead";
  assert.deepEqual(npcChatterCandidates(g), []);
});

test("task text is readable only at an actually reached shared or personally owned solo station", () => {
  const { g, npc } = fixture(),
    { e } = ownTask(g);
  assert.ok(buildNpcChatterContext(g, npc, "own").task);
  e.owner = "human";
  e.workspace = "HUMAN-SOLO-PRIVATE-WORK";
  e.problem!.prompt = "HUMAN-SOLO-PRIVATE-PROMPT";
  const denied = buildNpcChatterContext(g, npc, "denied");
  assert.equal(denied.task, undefined);
  assert.equal(JSON.stringify(denied).includes("HUMAN-SOLO-PRIVATE"), false);
  e.mode = "shared";
  e.workspace = "Explicitly shared team work";
  assert.equal(
    buildNpcChatterContext(g, npc, "shared").task?.workspace,
    e.workspace,
  );
  npc.x -= 4;
  assert.equal(
    buildNpcChatterContext(g, npc, "not-yet-arrived").task,
    undefined,
  );
  npc.x += 4;
  npc.activity = "exploring";
  assert.equal(buildNpcChatterContext(g, npc, "walking").task, undefined);
});

test("ambient reply parsing binds identity and accepts only one bounded plain spoken line", () => {
  const { g, npc } = fixture(),
    request = buildNpcChatterContext(g, npc, "reply-1"),
    valid = {
      requestId: request.requestId,
      actorId: npc.id,
      text: "  Keep that exit clear.  ",
      delivery: "urgent",
    };
  assert.deepEqual(parseNpcChatterReply(request, valid), {
    ...valid,
    text: "Keep that exit clear.",
  });
  for (const change of [
    { requestId: "other-request" },
    { actorId: "human" },
    { text: " " },
    { text: "x".repeat(181) },
    { text: "first\nsecond" },
    { text: "<tool>act</tool>" },
    { text: "```execute```" },
    { delivery: "shouting" },
    { delivery: ["calm"] },
    { actions: [] },
  ])
    assert.throws(
      () => parseNpcChatterReply(request, { ...valid, ...change }),
      /Malformed/,
    );
});

test("delayed chatter remains usable for a stable situation but rejects meaningful changes", () => {
  const { g, npc } = fixture(),
    request = buildNpcChatterContext(g, npc, "delayed");
  g.time += 100;
  assert.equal(
    npcChatterStillRelevant(g, request),
    true,
    "a slow background response is acceptable when the situation still applies",
  );
  g.time = request.capturedAt + NPC_CHATTER_CONTEXT_SECONDS;
  assert.equal(npcChatterStillRelevant(g, request), true);
  g.time += 0.01;
  assert.equal(npcChatterStillRelevant(g, request), false);

  const changes: ((world: Game) => void)[] = [
    (world) => {
      world.id = "different-run";
    },
    (world) => {
      world.time = 0;
    },
    (world) => {
      world.paused = true;
    },
    (world) => {
      world.survivors[1].alive = false;
    },
    (world) => {
      world.survivors[1].floor = 1;
    },
    (world) => {
      world.survivors[1].x = 30;
    },
    (world) => {
      world.survivors[1].activity = "fleeing";
    },
    (world) => {
      world.survivors[1].intent = "new-task";
    },
    (world) => {
      world.survivors[1].station = "new-station";
    },
    (world) => {
      world.survivors[1].hp = 20;
    },
    (world) => {
      world.zombies = [zombie("sudden-visible-threat", 13, 10)];
    },
  ];
  for (const change of changes) {
    const next = fixture(),
      captured = buildNpcChatterContext(next.g, next.npc, "identity");
    change(next.g);
    assert.equal(
      npcChatterStillRelevant(next.g, captured),
      false,
      change.toString(),
    );
  }
  const study = fixture(),
    { e } = ownTask(study.g),
    captured = buildNpcChatterContext(study.g, study.npc, "task-identity");
  e.problem!.contract.id = "different-question";
  assert.equal(npcChatterStillRelevant(study.g, captured), false);
});

function visibleField(): Furniture {
  return {
    id: "visible-quota-field",
    floor: 0,
    x: 14.5,
    y: 10.5,
    w: 1,
    h: 3,
    kind: "door",
    hp: 100,
    maxHp: 100,
    speed: 0,
    rotation: 0,
    destroyed: false,
    movers: [],
    moved: 0,
    credited: [],
    turning: 0,
    field: {
      authorized: [],
      crossing: [],
      sides: {},
      used: 0,
      limit: 1,
      exit: false,
    },
  };
}

test("a delayed reception line is stale after walking through the real generated doorway into the study hall", () => {
  const g = createPlayableGame(42, roadmap),
    f = g.floors[0],
    npc = Object.assign(actor("context-mover", "Maya", 1), {
      x: 12.5,
      y: 23.5,
      activity: "exploring" as const,
    });
  g.status = "playing";
  g.time = 10;
  g.zombies = [];
  g.events = [];
  g.survivors = [g.survivors[0], npc];
  Object.assign(g.survivors[0], { x: 11.5, y: 24 });
  const goal = f.stations.find(
    (s) => s.id.includes("room2") && canSee(f, npc, s),
  );
  assert.ok(
    goal,
    "the NPC's chosen study-hall terminal is actually seen from reception",
  );
  npc.intent = goal.encounter;
  npc.seen = [goal.id];
  const captured = buildNpcChatterContext(g, npc, "reception-context");
  assert.equal(captured.location.sector, "entry");
  assert.equal(npcChatterStillRelevant(g, captured), true);
  npc.y = 21.5;
  assert.equal(f.tiles[Math.floor(npc.y)][Math.floor(npc.x)], 0);
  assert.equal(
    buildNpcChatterContext(g, npc, "inside-context").location.sector,
    "room2",
  );
  assert.ok(
    npcChatterCandidates(g).includes(npc),
    "the NPC remains in the player's sight/hearing on the other side of the doorway",
  );
  assert.equal(
    npcChatterStillRelevant(g, captured),
    false,
    "activity, target encounter and floor remain unchanged, but the room-specific observation no longer applies",
  );
});

test("own keys, stair credentials and carried charges invalidate a delayed claim when they change", () => {
  const changes = [
    (npc: ReturnType<typeof actor>) => {
      npc.keys = 0;
    },
    (npc: ReturnType<typeof actor>) => {
      npc.access.push(0);
    },
    (npc: ReturnType<typeof actor>) => {
      npc.inventory[0].charges = 0;
    },
    (npc: ReturnType<typeof actor>) => {
      npc.inventory = [];
    },
  ];
  for (const change of changes) {
    const { g, npc } = fixture();
    npc.keys = 1;
    npc.inventory = [
      { id: "own-carried-item", kind: "flare", weight: 1, charges: 1 },
    ];
    const captured = buildNpcChatterContext(g, npc, "own-resources");
    assert.equal(npcChatterStillRelevant(g, captured), true);
    change(npc);
    assert.equal(
      npcChatterStillRelevant(g, captured),
      false,
      change.toString(),
    );
  }
});

test("a visible field exhausting its free quota or taking damage invalidates the captured field claim", () => {
  for (const state of ["quota", "damage"] as const) {
    const { g, f, npc } = fixture(),
      field = visibleField();
    f.furniture = [field];
    const captured = buildNpcChatterContext(g, npc, "visible-field");
    assert.equal(
      captured.perception.objects.find((o) => o.id === field.id)
        ?.personalFieldAccess,
      true,
    );
    assert.equal(npcChatterStillRelevant(g, captured), true);
    if (state === "quota") field.field!.used = 1;
    else field.hp = 20;
    assert.equal(npcChatterStillRelevant(g, captured), false, state);
  }
});

test("freshness checks do not inspect a captured prop's later hidden health or authorization", () => {
  const { g, f, npc } = fixture(),
    field = visibleField();
  f.furniture = [field];
  const visible = buildNpcChatterContext(g, npc, "last-seen-field");
  for (let y = 0; y < 34; y++) f.tiles[y][13] = 1;
  assert.equal(canSee(f, npc, field, 11, field.id), false);
  const hidden = buildNpcChatterContext(g, npc, "hidden-field");
  assert.equal(
    hidden.perception.objects.some((o) => o.id === field.id),
    false,
  );
  const relevantBefore = npcChatterStillRelevant(g, visible);
  field.field!.used = 1;
  field.hp = 1;
  field.destroyed = true;
  assert.deepEqual(buildNpcChatterContext(g, npc, "hidden-field"), hidden);
  assert.equal(npcChatterStillRelevant(g, visible), relevantBefore);
});

test("dialogue support is a bounded detached set of actual observations, not global catastrophe knowledge", () => {
  const { g, f, npc } = fixture();
  ownTask(g);
  g.zombies = Array.from({ length: 6 }, (_, i) =>
    zombie(`seen-${i}`, 13 + i * 0.1, 10),
  );
  npc.threatMemory = {
    floor: 0,
    nextSample: 11,
    observations: Array.from({ length: 8 }, (_, i) => ({
      id: `remembered-${i}`,
      x: 14,
      y: 10,
      at: 9.9,
    })),
  };
  g.survivors.push(
    ...Array.from({ length: 12 }, (_, i) =>
      Object.assign(actor(`near-${i}`, `Nearby ${i}`, i + 2), {
        x: 11 + i * 0.1,
        y: 11,
        hp: i < 3 ? 0 : 100,
        alive: i >= 3,
      }),
    ),
  );
  f.furniture = Array.from(
    { length: 8 },
    (_, i) =>
      ({
        ...visibleField(),
        id: `seen-object-${i}`,
        kind: "table",
        field: undefined,
        x: 15 + i * 0.1,
        y: 12,
      }) as Furniture,
  );
  g.events = Array.from({ length: 4 }, (_, i) => ({
    seq: i + 1,
    type: "breach",
    at: 9.9,
    floor: 0,
    position: { x: 10, y: 10 },
    text: "DO NOT COPY EVENT NARRATION",
  }));
  const history = Array.from({ length: 3 }, (_, i) => ({
      actorId: `near-${i + 3}`,
      text: "A nearby spoken observation.",
      at: 9,
      heardBy: [npc.id],
    })),
    before = JSON.stringify(g),
    context = buildNpcChatterContext(g, npc, "bounded-facts", history),
    facts = context.dialogue!.facts;
  assert.equal(JSON.stringify(g), before);
  assert.equal(facts.length, 40);
  assert.equal(new Set(facts.map((fact) => fact.id)).size, facts.length);
  assert.ok(
    facts.every((fact) => fact.text.length <= 180 && fact.key.length <= 512),
  );
  assert.ok(facts.some((fact) => fact.id === "task.current"));
  assert.ok(facts.some((fact) => fact.id === "setting.outbreak"));
  assert.ok(facts.some((fact) => fact.id === "environment.light"));
  assert.ok(
    facts.some(
      (fact) => fact.id === "person:near-0" && fact.text.includes("dead"),
    ),
  );
  assert.equal(
    JSON.stringify(facts).includes("DO NOT COPY EVENT NARRATION"),
    false,
  );
  assert.equal(isNpcDialogueContext(context), true);
  facts[0].key = "modified local result";
  assert.notEqual(
    buildNpcChatterContext(g, npc, "bounded-facts", history).dialogue!.facts[0]
      .key,
    facts[0].key,
  );
});

test("dialogue history includes only own words and actual recorded hearing receipts", () => {
  const { g, npc } = fixture(),
    history = [
      {
        actorId: npc.id,
        text: "Own first",
        at: 6,
        contextKey: "PRIVATE-DIRECTOR-KEY",
      },
      { actorId: npc.id, text: "Own second", at: 7 },
      { actorId: npc.id, text: "Own third", at: 8 },
      { actorId: npc.id, text: "Own fourth", at: 9 },
      {
        actorId: "heard-speaker",
        text: "Keep it down.",
        at: 9.5,
        heardBy: [npc.id, "another-recipient"],
      },
      {
        actorId: "unheard-speaker",
        text: "UNHEARD-LINE",
        at: 9.6,
        heardBy: ["another-recipient"],
      },
      {
        actorId: "future-speaker",
        text: "FUTURE-LINE",
        at: 11,
        heardBy: [npc.id],
      },
    ],
    captured = buildNpcChatterContext(g, npc, "heard-context", history);
  assert.deepEqual(
    captured.recentLines.map((line) => line.text),
    ["Own second", "Own third", "Own fourth", "Keep it down."],
  );
  for (const privateValue of [
    "PRIVATE-DIRECTOR-KEY",
    "another-recipient",
    "UNHEARD-LINE",
    "FUTURE-LINE",
  ])
    assert.equal(JSON.stringify(captured).includes(privateValue), false);
  assert.ok(
    captured.recentLines.every(
      (line) => line.contextKey === undefined && line.heardBy === undefined,
    ),
  );
  const speech = captured.dialogue!.facts.find((fact) =>
    fact.id.startsWith("speech:"),
  )!;
  assert.ok(speech);
  g.time += 5;
  assert.equal(
    npcDialogueFactsStillRelevant(g, captured, [speech.id]),
    true,
    "a remembered hearing receipt does not require the speaker to remain present",
  );
  g.time = 100;
  assert.equal(npcDialogueFactsStillRelevant(g, captured, [speech.id]), false);
});

function conversationFixture() {
  const base = fixture(),
    speaker = Object.assign(actor("survivor-two", "Theo", 2), {
      x: 14,
      y: 10,
      activity: "exploring" as const,
    });
  base.g.survivors.push(speaker);
  const line: NpcChatterRecentLine = {
      id: "utterance-water",
      actorId: speaker.id,
      speakerName: speaker.name,
      text: "Anyone got some water?",
      at: 9,
      conversationId: "exchange-water",
      turn: 1,
      heardBy: [base.npc.id, "private-other-recipient"],
      contextKey: "PRIVATE-CONVERSATION-DIRECTOR-KEY",
    },
    conversation: NpcChatterConversation = {
      id: "exchange-water",
      replyTo: line.id!,
      sourceActorId: speaker.id,
      turn: 2,
      maxTurns: 4,
      expiresAt: 39,
    };
  return { ...base, speaker, line, conversation };
}

test("a conversational opportunity contains the exact heard words, speaker and turn without exposing recipients or forcing an answer", () => {
  const { g, npc, line, conversation } = conversationFixture(),
    before = JSON.stringify(g),
    captured = buildNpcChatterContext(
      g,
      npc,
      "answer-water",
      [line],
      conversation,
    );
  assert.equal(JSON.stringify(g), before);
  assert.deepEqual(captured.conversation, conversation);
  assert.deepEqual(captured.recentLines, [
    {
      id: line.id,
      actorId: line.actorId,
      speakerName: line.speakerName,
      text: line.text,
      at: line.at,
      conversationId: line.conversationId,
      turn: line.turn,
    },
  ]);
  const fact = captured.dialogue!.facts.find(
    (fact) => fact.id === npcSpeechFactId(line),
  );
  assert.ok(fact);
  assert.equal(fact.id, "speech:utterance-water");
  assert.match(fact.text, /Theo.*Anyone got some water\?/);
  assert.equal(fact.expiresAt, 99);
  assert.equal(npcChatterStillRelevant(g, captured), true);
  assert.equal(npcDialogueFactsStillRelevant(g, captured, [fact.id]), true);
  assert.equal(
    JSON.stringify(captured).includes("private-other-recipient"),
    false,
  );
  assert.equal(
    JSON.stringify(captured).includes("PRIVATE-CONVERSATION-DIRECTOR-KEY"),
    false,
  );
  assert.equal(
    npcSpeechFactId({ actorId: "legacy-speaker", text: "Old words", at: 1.5 }),
    "speech:legacy-speaker:45",
  );
  const ordinary = buildNpcChatterContext(g, npc, "ordinary-with-question", [
    line,
  ]);
  assert.equal(
    ordinary.conversation,
    undefined,
    "a question in history does not create a compulsory answer turn",
  );
  captured.conversation!.replyTo = "changed-locally";
  captured.recentLines[0].text = "changed-locally";
  assert.equal(conversation.replyTo, "utterance-water");
  assert.equal(line.text, "Anyone got some water?");
});

test("a reply cannot be requested without the correct actual hearing receipt and bounded thread identity", () => {
  for (const invalid of [
    "unheard",
    "other-recipient",
    "wrong-source",
    "self-source",
    "human-source",
    "wrong-utterance",
    "wrong-thread",
    "wrong-turn",
    "future-source",
    "expired",
    "too-many-turns",
    "unbounded-thread",
  ]) {
    const { g, npc, line, conversation } = conversationFixture();
    if (invalid === "unheard") delete line.heardBy;
    else if (invalid === "other-recipient") line.heardBy = ["other-recipient"];
    else if (invalid === "wrong-source")
      conversation.sourceActorId = "someone-else";
    else if (invalid === "self-source") conversation.sourceActorId = npc.id;
    else if (invalid === "human-source") {
      line.actorId = "human";
      conversation.sourceActorId = "human";
    } else if (invalid === "wrong-utterance")
      conversation.replyTo = "unheard-utterance";
    else if (invalid === "wrong-thread") line.conversationId = "other-exchange";
    else if (invalid === "wrong-turn") line.turn = 2;
    else if (invalid === "future-source") line.at = g.time + 1;
    else if (invalid === "expired") conversation.expiresAt = g.time;
    else if (invalid === "too-many-turns") conversation.turn = 5;
    else conversation.maxTurns = 100;
    assert.throws(
      () => buildNpcChatterContext(g, npc, invalid, [line], conversation),
      /actually heard source turn/,
      invalid,
    );
  }
});

test("the actual reply source stays in a bounded context even after newer unrelated heard lines", () => {
  const { g, npc, line, conversation } = conversationFixture(),
    newer = Array.from({ length: 5 }, (_, i): NpcChatterRecentLine => ({
      id: `unrelated-${i}`,
      actorId: `other-${i}`,
      text: `Unrelated words ${i}`,
      at: 9.1 + i * 0.1,
      heardBy: [npc.id],
    })),
    captured = buildNpcChatterContext(
      g,
      npc,
      "pinned-source",
      [line, ...newer],
      conversation,
    );
  assert.equal(captured.recentLines.length, 4);
  assert.ok(captured.recentLines.some((recent) => recent.id === line.id));
  assert.ok(
    captured.dialogue!.facts.some((fact) => fact.id === npcSpeechFactId(line)),
  );
  assert.equal(
    npcDialogueFactsStillRelevant(g, captured, [npcSpeechFactId(line)]),
    true,
  );
});

test("a pending conversational reply expires when the speaker leaves, dies, starts stairs or becomes acoustically sealed", () => {
  for (const change of [
    "dead",
    "escaped",
    "away",
    "floor",
    "stairs",
    "sealed",
    "expired",
    "missing-source",
  ] as const) {
    const { g, f, npc, speaker, line, conversation } = conversationFixture(),
      captured = buildNpcChatterContext(
        g,
        npc,
        `reply-${change}`,
        [line],
        conversation,
      ),
      heardMemory = buildNpcChatterContext(g, npc, `memory-${change}`, [line]);
    assert.equal(npcChatterStillRelevant(g, captured), true, change);
    if (change === "dead") {
      speaker.alive = false;
      speaker.hp = 0;
    } else if (change === "escaped") speaker.escaped = true;
    else if (change === "away") speaker.x = 30;
    else if (change === "floor") speaker.floor = 1;
    else if (change === "stairs")
      speaker.stairTravel = {
        fromFloor: 0,
        toFloor: 1,
        origin: { x: 14, y: 10 },
        destination: { x: 14, y: 10 },
        until: 20,
      };
    else if (change === "sealed")
      for (let y = 0; y < 34; y++) f.tiles[y][13] = 1;
    else if (change === "expired") g.time = conversation.expiresAt;
    else captured.recentLines = [];
    assert.equal(npcChatterStillRelevant(g, captured), false, change);
    assert.equal(
      npcDialogueFactsStillRelevant(g, captured, ["setting.outbreak"]),
      false,
      `even unrelated evidence cannot keep a departed conversation alive: ${change}`,
    );
    assert.equal(
      npcDialogueFactsStillRelevant(g, heardMemory, [npcSpeechFactId(line)]),
      true,
      `the same past words remain a hearing memory, not a demand to answer: ${change}`,
    );
  }
});

test("moving next to a speaker later cannot turn an unheard question into a reply opportunity", () => {
  const { g, npc, speaker, line, conversation } = conversationFixture();
  line.heardBy = ["someone-else"];
  speaker.x = npc.x + 0.5;
  assert.throws(
    () =>
      buildNpcChatterContext(g, npc, "later-neighbour", [line], conversation),
    /actually heard source turn/,
  );
  const context = buildNpcChatterContext(g, npc, "no-false-hearing", [line]);
  assert.equal(context.recentLines.length, 0);
  assert.equal(
    context.dialogue!.facts.some((fact) => fact.id === npcSpeechFactId(line)),
    false,
  );
});

test("a reply uses the heard delivery radius and preserves delivery as evidence without private recipients", () => {
  const { g, npc, speaker, line, conversation } = conversationFixture();
  line.delivery = "whisper";
  const captured = buildNpcChatterContext(
    g,
    npc,
    "whisper-reply",
    [line],
    conversation,
  );
  assert.equal(captured.recentLines[0].delivery, "whisper");
  assert.equal(captured.recentLines[0].heardBy, undefined);
  const fact = captured.dialogue!.facts.find(
    (f) => f.id === npcSpeechFactId(line),
  )!;
  assert.match(fact.text, /Theo whisper/);
  assert.equal(npcDialogueFactsStillRelevant(g, captured, [fact.id]), true);
  speaker.x = npc.x + 4.01;
  assert.equal(
    npcChatterStillRelevant(g, captured),
    false,
    "a whisper cannot become a ten-metre reply source",
  );
  speaker.x = npc.x + 2;
  captured.recentLines[0].delivery = "urgent";
  assert.equal(
    npcDialogueFactsStillRelevant(g, captured, [fact.id]),
    false,
    "changing the captured delivery invalidates its original evidence key",
  );
});

test("urgent speech can sustain a reply beyond ordinary speech range without bypassing the original receipt", () => {
  const { g, npc, speaker, line, conversation } = conversationFixture();
  speaker.x = npc.x + 12;
  assert.throws(
    () =>
      buildNpcChatterContext(g, npc, "ordinary-too-far", [line], conversation),
    /actually heard source turn/,
  );
  line.delivery = "urgent";
  const captured = buildNpcChatterContext(
    g,
    npc,
    "heard-call",
    [line],
    conversation,
  );
  assert.equal(npcChatterStillRelevant(g, captured), true);
  assert.match(
    captured.dialogue!.facts.find((f) => f.id === npcSpeechFactId(line))!.text,
    /Theo call out/,
  );
  speaker.x = npc.x + 14.01;
  assert.equal(npcChatterStillRelevant(g, captured), false);
  speaker.x = npc.x + 2;
  line.heardBy = [];
  assert.throws(
    () =>
      buildNpcChatterContext(
        g,
        npc,
        "not-actually-heard-call",
        [line],
        conversation,
      ),
    /actually heard source turn/,
  );
});

test("a line about a particular injured ally expires when that visible person's condition changes", () => {
  const { g, npc } = fixture(),
    ally = Object.assign(actor("sam", "Sam", 2), {
      x: 13,
      y: 10,
      hp: 20,
      activity: "exploring" as const,
    });
  g.survivors.push(ally);
  const captured = buildNpcChatterContext(g, npc, "hurt-ally");
  assert.equal(
    npcDialogueFactsStillRelevant(g, captured, ["person:sam"]),
    true,
  );
  ally.hp = 100;
  assert.equal(
    npcChatterStillRelevant(g, captured),
    true,
    "the old coarse checks alone would accept the line",
  );
  assert.equal(
    npcDialogueFactsStillRelevant(g, captured, ["person:sam"]),
    false,
  );
  assert.equal(
    npcDialogueFactsStillRelevant(g, captured, ["setting.outbreak"]),
    true,
    "an uncited ally change does not invalidate an unrelated supported observation",
  );
  ally.hp = 0;
  ally.alive = false;
  const death = buildNpcChatterContext(g, npc, "seen-body");
  assert.ok(
    death
      .dialogue!.facts.find((fact) => fact.id === "person:sam")
      ?.text.includes("dead"),
  );
  assert.equal(
    npcDialogueFactsStillRelevant(g, captured, ["person:sam"]),
    false,
  );
});

test("remote deaths and private information do not enter visible-body dialogue support", () => {
  const { g, f, npc } = fixture(),
    hidden = Object.assign(actor("hidden-person", "PRIVATE-HIDDEN-NAME", 2), {
      x: 20,
      y: 10,
    });
  for (let y = 0; y < 34; y++) f.tiles[y][15] = 1;
  g.survivors.push(hidden);
  const captured = buildNpcChatterContext(g, npc, "unseen-body");
  hidden.alive = false;
  hidden.hp = 0;
  assert.deepEqual(buildNpcChatterContext(g, npc, "unseen-body"), captured);
  assert.equal(JSON.stringify(captured).includes("PRIVATE-HIDDEN-NAME"), false);
  assert.equal(
    npcDialogueFactsStillRelevant(g, captured, ["setting.outbreak"]),
    true,
  );
});

test("replacing a visible attacker invalidates its support even while the coarse threat band stays immediate", () => {
  const { g, npc } = fixture();
  g.zombies = [zombie("attacker-a", 14, 10)];
  const captured = buildNpcChatterContext(g, npc, "attacker-change");
  assert.equal(captured.perception.threatBand, "immediate");
  assert.equal(
    npcDialogueFactsStillRelevant(g, captured, ["threat:attacker-a"]),
    true,
  );
  g.zombies = [zombie("attacker-b", 14, 10)];
  assert.equal(npcChatterStillRelevant(g, captured), true);
  assert.equal(
    npcDialogueFactsStillRelevant(g, captured, ["threat:attacker-a"]),
    false,
  );
});

test("live directional support follows the NPC's facing and rejects a threat switching sides without treating micro-drift as a new situation", () => {
  const { g, npc } = fixture();
  npc.heading = { x: 0, y: -1 };
  const threat = zombie("moving-threat", 14.5, 10);
  g.zombies = [threat];
  const captured = buildNpcChatterContext(g, npc, "bearing-change"),
    fact = captured.dialogue!.facts.find(
      (fact) => fact.id === "threat:moving-threat",
    )!;
  assert.deepEqual(captured.self.facing, { x: 0, y: -1 });
  assert.ok(fact.text.includes("to your right (east)"));
  threat.x += 0.02;
  threat.y += 0.01;
  assert.equal(npcDialogueFactsStillRelevant(g, captured, [fact.id]), true);
  threat.x = 9.5;
  threat.y = 10;
  assert.equal(npcChatterStillRelevant(g, captured), true);
  assert.equal(npcDialogueFactsStillRelevant(g, captured, [fact.id]), false);
  assert.equal(
    npcDialogueFactsStillRelevant(g, captured, ["self.health"]),
    true,
  );
});

test("turning changes only directional dependencies for visible people, props and own facing", () => {
  const { g, f, npc } = fixture();
  npc.heading = { x: 0, y: -1 };
  g.survivors.push(
    Object.assign(actor("nearby-sam", "Sam", 2), { x: 13.5, y: 10 }),
  );
  f.furniture = [
    {
      ...visibleField(),
      id: "nearby-table",
      kind: "table",
      field: undefined,
      x: 14.5,
      y: 12,
    },
  ];
  const captured = buildNpcChatterContext(g, npc, "head-turn");
  for (const id of ["person:nearby-sam", "object:nearby-table", "self.facing"])
    assert.equal(npcDialogueFactsStillRelevant(g, captured, [id]), true, id);
  npc.heading = { x: 0, y: 1 };
  for (const id of ["person:nearby-sam", "object:nearby-table", "self.facing"])
    assert.equal(npcDialogueFactsStillRelevant(g, captured, [id]), false, id);
  assert.equal(
    npcDialogueFactsStillRelevant(g, captured, ["setting.outbreak"]),
    true,
  );
  assert.equal(
    npcDialogueFactsStillRelevant(g, captured, ["self.health"]),
    true,
  );
});

test("heard impacts expire individually and expired evidence never invalidates a whole generation packet", () => {
  const { g, npc } = fixture();
  g.events = [
    {
      seq: 1,
      type: "barricade-hit",
      at: 9,
      floor: 0,
      text: "synthetic",
      position: { x: 13, y: 10 },
    },
  ];
  const captured = buildNpcChatterContext(g, npc, "impact-expiry");
  assert.equal(npcDialogueFactsStillRelevant(g, captured, ["event:1"]), true);
  g.time = 14;
  assert.equal(npcChatterStillRelevant(g, captured), true);
  assert.equal(npcDialogueFactsStillRelevant(g, captured, ["event:1"]), false);
  g.time = 15;
  const old = buildNpcChatterContext(g, npc, "old-impact", [
    {
      actorId: "old-speaker",
      text: "Old heard words",
      at: -80,
      heardBy: [npc.id],
    },
  ]);
  assert.equal(
    old.perception.recentEvents.length,
    1,
    "older reported observations may remain context",
  );
  assert.equal(
    old.dialogue!.facts.some((fact) => fact.id === "event:1"),
    false,
  );
  assert.equal(
    old.dialogue!.facts.some((fact) => fact.id.startsWith("speech:")),
    false,
  );
  assert.equal(isNpcDialogueContext(old), true);
  assert.equal(npcDialogueFactsStillRelevant(g, old, ["event:1"]), false);
});

test("task-dependent dialogue checks the current owned revision, milestone and completion state", () => {
  for (const change of ["revision", "milestone", "completed"] as const) {
    const { g, npc } = fixture(),
      { e } = ownTask(g),
      captured = buildNpcChatterContext(g, npc, "task-freshness");
    assert.equal(
      npcDialogueFactsStillRelevant(g, captured, ["task.current"]),
      true,
    );
    if (change === "revision") {
      e.revision++;
      e.workspace = "a newer tentative workspace";
    }
    if (change === "milestone") npc.milestone++;
    if (change === "completed") e.state = "consumed";
    assert.equal(npcChatterStillRelevant(g, captured), true);
    assert.equal(
      npcDialogueFactsStillRelevant(g, captured, ["task.current"]),
      false,
      change,
    );
  }
});

test("local light evidence follows actual room circuits without inventing weather or changing game state", () => {
  const g = createPlayableGame(42, roadmap),
    f = g.floors[0],
    npc = g.survivors[1];
  g.status = "playing";
  g.zombies = [];
  g.events = [];
  const before = JSON.stringify(g),
    captured = buildNpcChatterContext(g, npc, "light-evidence"),
    light = captured.dialogue!.facts.find(
      (fact) => fact.id === "environment.light",
    );
  assert.ok(light && /ceiling|outside/.test(light.text));
  assert.equal(JSON.stringify(g), before);
  assert.equal(
    JSON.stringify(captured.dialogue!.facts).includes("weather"),
    false,
  );
  assert.ok(f.boundary);
  const legacy = fixture(),
    old = buildNpcChatterContext(legacy.g, legacy.npc, "circuit-change");
  legacy.f.dark = 1;
  assert.equal(
    npcDialogueFactsStillRelevant(legacy.g, old, ["environment.light"]),
    false,
  );
});

test("frozen last-seen support does not follow hidden enemies or expire because of harmless micro-movement", () => {
  const { g, f, npc } = fixture(),
    hidden = zombie("last-seen", 20, 10);
  for (let y = 0; y < 34; y++) f.tiles[y][15] = 1;
  g.zombies = [hidden];
  npc.threatMemory = {
    floor: 0,
    nextSample: 11,
    observations: [{ id: hidden.id, x: 14, y: 10, at: 9.5 }],
  };
  const captured = buildNpcChatterContext(g, npc, "frozen-support");
  assert.equal(
    npcDialogueFactsStillRelevant(g, captured, ["memory:last-seen"]),
    true,
  );
  npc.x += 0.03;
  hidden.x = 30;
  hidden.hp = 0;
  assert.equal(
    npcDialogueFactsStillRelevant(g, captured, ["memory:last-seen"]),
    true,
  );
  g.time = 15.5;
  assert.equal(
    npcDialogueFactsStillRelevant(g, captured, ["memory:last-seen"]),
    false,
  );
});

test("unsupported and duplicate references fail closed while a stable captured fact remains usable", () => {
  const { g, npc } = fixture(),
    captured = buildNpcChatterContext(g, npc, "invalid-support");
  assert.equal(
    npcDialogueFactsStillRelevant(g, captured, ["invented.fact"]),
    false,
  );
  assert.equal(
    npcDialogueFactsStillRelevant(g, captured, ["self.health", "self.health"]),
    false,
  );
  assert.equal(
    npcDialogueFactsStillRelevant(g, captured, ["self.health"]),
    true,
  );
  g.time += 100;
  assert.equal(
    npcDialogueFactsStillRelevant(g, captured, ["setting.outbreak"]),
    true,
  );
});

test("accepted run-design backstory becomes grounded premise, relationship and opening facts in a bounded context", () => {
  const premise = "A hospital laundry crew works through the outbreak.",
    opening = "The lights failed at 3am and the crew kept folding.",
    { g, npc } = fixture(),
    plain = buildNpcChatterContext(g, npc, "no-backstory", []);
  g.design = {
    version: 1,
    source: "fixture",
    requestId: "r",
    generationId: "g",
    fingerprint: "f",
    design: {
      title: "Night Shift",
      premise,
      opening,
      relationships: [
        {
          from: "Maya",
          to: "Ravi",
          kind: "rival",
          detail: "they compete for the night supervisor job",
        },
        { from: "Ann", to: "Bo", kind: "friend", detail: "unrelated" },
      ],
    },
  } as unknown as Game["design"];
  const captured = buildNpcChatterContext(g, npc, "backstory", []),
    facts = captured.dialogue!.facts,
    fact = (id: string) => facts.find((candidate) => candidate.id === id);
  assert.deepEqual(
    facts.slice(0, 3).map((candidate) => candidate.id),
    ["setting.outbreak", "setting.premise", "relationship:0"],
    "shared backstory follows the outbreak setting and precedes situational facts",
  );
  const premiseFact = fact("setting.premise")!;
  assert.equal(premiseFact.kind, "setting");
  assert.equal(premiseFact.text, `This escape, "Night Shift": ${premise}`);
  const relationship = fact("relationship:0")!;
  assert.equal(relationship.kind, "person");
  assert.equal(
    relationship.text,
    "Ravi is your rival: they compete for the night supervisor job",
  );
  assert.equal(fact("relationship:1"), undefined);
  const openingFact = fact("setting.opening")!;
  assert.equal(openingFact.text, opening);
  assert.equal(
    facts[facts.length - 1].id,
    "setting.opening",
    "the opening is the last fact so a full budget never displaces the situation",
  );
  assert.equal(isNpcDialogueContext(captured), true);
  assert.ok(
    plain.dialogue!.facts.every(
      (candidate) =>
        !candidate.id.startsWith("setting.premise") &&
        !candidate.id.startsWith("relationship:") &&
        candidate.id !== "setting.opening",
    ),
    "a game without a run design gains no backstory facts",
  );
  assert.equal(isNpcDialogueContext(plain), true);
});
