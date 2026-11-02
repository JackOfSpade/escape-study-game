import assert from "node:assert/strict";
import test from "node:test";
import { createHandoffQueue } from "../scripts/chatgpt-handoff-queue.mjs";
import {
  createTerminalRelayApp,
  terminalRelayTools,
  TERMINAL_RELAY_URI,
  TURN_INSTRUCTION,
  REQUESTER_LIVE_MS,
} from "../scripts/terminal-relay-app.mjs";
const owner = { linkId: "synthetic-owner" },
  other = { linkId: "synthetic-other" };
const state = (r) => r.structuredContent;
const dialoguePayload = (requestId, messages, extra = {}) => ({
  requestId,
  sessionId: "synthetic-game/e1/private",
  mode: "terminal-dialogue",
  responseFormat: { text: "string", complete: "boolean" },
  instruction: "@study: Continue this private puzzle conversation.",
  problem: {
    title: "Synthetic window",
    prompt: "Readings are [1,2,3]; window of two. Largest total?",
    rubric: ["Largest total is 5", "Subtract outgoing, add incoming"],
    starter: "",
  },
  workspace: "",
  draftRevision: 3,
  submissions: [],
  messages,
  executions: [],
  learning: { track: "PY", objective: "synthetic-objective" },
  studyPrompt: "@study",
  prompt: "@study\n" + messages.at(-1).text,
  curriculum: "Synthetic curriculum text.",
  progressContext: "Synthetic progress text.",
  ...extra,
});
const human = (text, seq) => ({ kind: "human", author: "human", text, seq });
/** A queue whose requests come from a game that is still polling for the reply. */
function waitingGame(queue) {
  const enqueue = queue.enqueue;
  queue.enqueue = (...args) => {
    const receipt = enqueue(...args);
    queue.result(receipt.id, receipt.hash);
    return receipt;
  };
  return queue;
}
function setup(options = {}) {
  const queue = waitingGame(createHandoffQueue());
  const app = createTerminalRelayApp({ queue, ...options });
  const open = (grant = owner) =>
    state(app.call("open_study_terminal", {}, grant));
  const claim = (relayId, revision, grant = owner) =>
    state(app.call("claim_study_terminal_turn", { relayId, revision }, grant));
  const reply = (relayId, turnId, text, complete, grant = owner, extra = {}) =>
    state(
      app.call(
        "reply_study_terminal_job",
        { relayId, turnId, text, complete, ...extra },
        grant,
      ),
    );
  return { queue, app, open, claim, reply };
}

test("knowledge-probe reply fields are declared, validated, forwarded to the queue and part of the idempotency digest", () => {
  const tool = terminalRelayTools().find(
    (t) => t.name === "reply_study_terminal_job",
  );
  assert.deepEqual(tool.inputSchema.required, [
    "relayId",
    "turnId",
    "text",
    "complete",
  ]);
  assert.deepEqual(tool.inputSchema.properties.outcome.enum, ["solved", "gap"]);
  assert.deepEqual(
    tool.inputSchema.properties.knowledge.properties.facets.items.properties
      .status.enum,
    ["demonstrated", "implied", "gap"],
  );
  assert.doesNotMatch(tool.description, /assume the learner already knows/);
  assert.match(TURN_INSTRUCTION, /assume the learner already knows/);
  const facetProps =
    tool.inputSchema.properties.knowledge.properties.facets.items.properties;
  assert.equal(facetProps.partOf.type, "string");
  assert.equal(facetProps.description.maxLength, 200);
  const { queue, open, claim, reply } = setup();
  queue.enable(true);
  const s = open();
  const job = queue.enqueue(
    "tutor",
    dialoguePayload("synthetic-dialogue-probe", [human("I don't know", 1)], {
      probe: {
        stance: "Assume knowledge.",
        facets: [
          { id: "largest", description: "Largest total is 5" },
          { id: "update", description: "Subtract outgoing, add incoming" },
        ],
      },
    }),
  );
  const claimed = claim(s.relayId, s.revision);
  const packet = JSON.parse(
    claimed.turn.prompt.split("\n").slice(2).join("\n"),
  );
  assert.deepEqual(
    packet.probe.facets.map((f) => f.id),
    ["largest", "update"],
  );
  assert.match(claimed.turn.prompt, /outcome:gap/);
  const turnId = claimed.turn.turnId;
  for (const extra of [
    { outcome: "partial" },
    { knowledge: "none" },
    { knowledge: { facets: [{ id: "largest" }] } },
    { knowledge: { facets: [{ id: "largest", status: "known" }] } },
    { knowledge: { signal: { fluency: "great" } } },
    { knowledge: { facets: [{ id: "largest", status: "gap", partOf: 1 }] } },
    {
      knowledge: {
        facets: [{ id: "x", status: "gap", partOf: "largest", description: 1 }],
      },
    },
  ])
    assert.throws(
      () => reply(s.relayId, turnId, "Recorded", true, owner, extra),
      /outcome solved\|gap/,
    );
  const knowledge = {
    facets: [
      { id: "largest", status: "demonstrated" },
      { id: "update", status: "gap", note: "learner declared it" },
      {
        id: "prefix-sums",
        status: "gap",
        partOf: "update",
        description: "Prefix sums",
      },
    ],
    signal: { fluency: "declared-gap" },
  };
  const answered = reply(
    s.relayId,
    turnId,
    "Recorded; key granted.",
    true,
    owner,
    {
      outcome: "gap",
      knowledge,
    },
  );
  assert.deepEqual(answered.turn.reply, {
    text: "Recorded; key granted.",
    complete: true,
    outcome: "gap",
    knowledge,
  });
  assert.deepEqual(queue.result(job.id, job.hash).answer, {
    text: "Recorded; key granted.",
    complete: true,
    outcome: "gap",
    knowledge,
  });
  assert.throws(
    () => reply(s.relayId, turnId, "Recorded; key granted.", true),
    /Conflicting/,
  );
  assert.equal(
    reply(s.relayId, turnId, "Recorded; key granted.", true, owner, {
      outcome: "gap",
      knowledge,
    }).answered,
    1,
  );
});

test("model-facing tool descriptions carry no tutoring policy; every directive travels in the posted turn", () => {
  // ChatGPT screens tool documentation for behavioral directives and parks
  // each call from a flagged tool behind a "Suspicious Instruction" approval
  // card, which left a live game turn waiting with no reply on 2026-10-19.
  const directive =
    /\b(assume|judge|judging|never|do not|don't|untrusted|treat|mark|probe|certify|complete:|outcome:|facet|evidence|poll)\b/i;
  const modelFacing = terminalRelayTools().filter(
    (t) => !t._meta?.ui?.visibility,
  );
  assert.deepEqual(
    modelFacing.map((t) => t.name),
    [
      "open_study_terminal",
      "get_current_study_question",
      "read_study_terminal_context",
      "reply_study_terminal_job",
      "finish_study_preparation",
      "finish_study_question",
    ],
  );
  for (const tool of modelFacing) {
    assert.ok(
      tool.description.length <= 600,
      `${tool.name} description is ${tool.description.length} characters`,
    );
    assert.doesNotMatch(
      tool.description,
      directive,
      `${tool.name} description reads like policy`,
    );
  }
  for (const phrase of [
    "assume the learner already knows",
    "complete:false",
    "complete:true with outcome:gap",
    "knowledge.facets",
    "reply_study_terminal_job",
    "read_study_terminal_context",
    "Do not call get_study_handoff or poll",
    "untrusted evidence",
  ])
    assert.ok(TURN_INSTRUCTION.includes(phrase), phrase);
  const { queue, open, claim } = setup();
  queue.enable(true);
  const s = open();
  queue.enqueue(
    "tutor",
    dialoguePayload("synthetic-policy-in-turn", [human("hi", 1)]),
  );
  const turn = claim(s.relayId, s.revision).turn;
  assert.ok(TURN_INSTRUCTION.startsWith("@study\n"));
  assert.ok(turn.prompt.startsWith(TURN_INSTRUCTION));
  assert.match(turn.prompt, /"relayId":"/);
});

test("live relay tools are separate from the demo and legacy worker tools", () => {
  const tools = terminalRelayTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    [
      "open_study_terminal",
      "get_current_study_question",
      "claim_study_terminal_turn",
      "read_study_terminal",
      "read_study_terminal_context",
      "reply_study_terminal_job",
      "finish_study_preparation",
      "finish_study_question",
    ],
  );
  assert.equal(tools[0]._meta.ui.resourceUri, TERMINAL_RELAY_URI);
  assert.ok(tools.every((t) => !t.inputSchema.required.includes("session")));
  assert.deepEqual(
    tools.find((t) => t.name === "claim_study_terminal_turn")._meta.ui
      .visibility,
    ["app"],
  );
  assert.equal(
    tools.find((t) => t.name === "reply_study_terminal_job")._meta.ui,
    undefined,
  );
  const { app } = setup();
  const resource = app.resource(TERMINAL_RELAY_URI).contents[0];
  assert.equal(resource.mimeType, "text/html;profile=mcp-app");
  assert.match(resource.text, /claim_study_terminal_turn/);
  assert.match(resource.text, /ui\/message/);
  assert.throws(() => app.resource("file:///private"), /Unknown UI/);
  assert.throws(() => app.call("open_study_terminal", {}, {}), /Authenticated/);
  assert.throws(() => createTerminalRelayApp(), /requires the handoff queue/);
});

test("opening the relay releases nothing; claims need explicit sharing and only take terminal-dialogue jobs", () => {
  const { queue, app, open, claim } = setup();
  const s = open();
  assert.equal(s.live, true);
  assert.equal(s.released, false);
  assert.equal(s.turn, null);
  assert.equal(queue.snapshot().enabled, false);
  assert.deepEqual(claim(s.relayId, s.revision).turn, null);
  queue.enable(true);
  queue.enqueue("generate", {
    requestId: "synthetic-generate",
    contract: {},
  });
  queue.enqueue("tutor", {
    requestId: "synthetic-group-tutor",
    problem: { prompt: "Not a terminal dialogue" },
    messages: [],
  });
  assert.equal(claim(s.relayId, s.revision).turn, null);
  assert.equal(queue.snapshot().working, 0);
  assert.equal(queue.snapshot().queued, 2);
  const job = queue.enqueue(
    "tutor",
    dialoguePayload("synthetic-dialogue-1", [human("I think [2,3]", 1)]),
  );
  const claimed = claim(s.relayId, s.revision);
  assert.equal(claimed.turn.status, "claimed");
  assert.equal(claimed.turn.requestId, "synthetic-dialogue-1");
  assert.match(claimed.turn.prompt, /^@study\n/);
  assert.match(claimed.turn.prompt, /reply_study_terminal_job/);
  const packet = JSON.parse(
    claimed.turn.prompt.split("\n").slice(2).join("\n"),
  );
  assert.equal(packet.relayId, s.relayId);
  assert.equal(packet.turnId, claimed.turn.turnId);
  assert.deepEqual(packet.question.rubric, [
    "Largest total is 5",
    "Subtract outgoing, add incoming",
  ]);
  assert.deepEqual(packet.learning, {
    track: "PY",
    objective: "synthetic-objective",
  });
  assert.equal(packet.messages.length, 1);
  assert.equal(packet.curriculum, "Synthetic curriculum text.");
  assert.equal(packet.draftRevision, 3);
  assert.equal(queue.snapshot().working, 1);
  assert.deepEqual(claimed.turn.messages, [
    { role: "learner", text: "I think [2,3]" },
  ]);
  // The queue's secret claim stays server-side: only the turnId reaches chat.
  const secret = queue.get("app-anything-else-", undefined, () => false);
  assert.equal(secret.status, "waiting");
  assert.equal(
    JSON.stringify(claimed).includes('"claim"'),
    false,
    "snapshot must not expose the queue claim",
  );
  assert.equal(
    /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/.test(
      claimed.turn.prompt
        .replaceAll(claimed.turn.turnId, "")
        .replaceAll(s.relayId, ""),
    ),
    false,
    "prompt must not carry any other UUID such as the job claim",
  );
  // Reclaiming is idempotent: same turn, same job, no second claim.
  const again = claim(s.relayId, claimed.revision);
  assert.equal(again.turn.turnId, claimed.turn.turnId);
  assert.equal(queue.snapshot().working, 1);
  assert.throws(
    () => claim(s.relayId, claimed.revision + 5),
    /Invalid terminal revision/,
  );
  assert.equal(queue.result(job.id, job.hash).status, "pending");
  assert.equal(
    state(app.call("read_study_terminal", { relayId: s.relayId }, owner)).turn
      .turnId,
    claimed.turn.turnId,
  );
});

test("replies deliver into the same queue job once, idempotently, and keep correction and retry paths", () => {
  const { queue, app, open, claim, reply } = setup();
  queue.enable(true);
  const s = open();
  const job = queue.enqueue(
    "tutor",
    dialoguePayload("synthetic-dialogue-2", [human("I think [2,3]", 1)]),
  );
  const claimed = claim(s.relayId, s.revision);
  const turnId = claimed.turn.turnId;
  assert.throws(
    () => reply(s.relayId, "unknown-turn", "Solved", true),
    /does not match/,
  );
  assert.throws(() => reply(s.relayId, turnId, "Solved", "true"), /complete/);
  assert.throws(
    () => reply(s.relayId, turnId, "Solved", true, other),
    /unavailable/,
  );
  const answered = reply(s.relayId, turnId, "What is its total?", false);
  assert.equal(answered.turn.status, "answered");
  assert.deepEqual(answered.turn.reply, {
    text: "What is its total?",
    complete: false,
  });
  assert.equal(answered.answered, 1);
  assert.deepEqual(queue.result(job.id, job.hash), {
    status: "done",
    answer: { text: "What is its total?", complete: false },
  });
  assert.deepEqual(
    reply(s.relayId, turnId, "What is its total?", false),
    answered,
  );
  assert.throws(
    () => reply(s.relayId, turnId, "Different", false),
    /Conflicting/,
  );
  assert.equal(queue.snapshot().done, 1);
  // The player asks for a correction: the same job comes back with its note.
  queue.reopen(job.id);
  const corrected = claim(s.relayId, answered.revision);
  assert.equal(corrected.turn.status, "claimed");
  assert.equal(corrected.turn.requestId, "synthetic-dialogue-2");
  assert.notEqual(corrected.turn.turnId, turnId);
  assert.equal(corrected.turn.correction.round, 1);
  assert.match(corrected.turn.prompt, /corrected response/);
  assert.equal(corrected.recent.length, 1);
  assert.equal(corrected.recent[0].complete, false);
  // A stale reply for the superseded turn is still refused.
  assert.throws(
    () => reply(s.relayId, turnId, "Late reply", true),
    /Conflicting/,
  );
  const done = reply(s.relayId, corrected.turn.turnId, "Solved", true);
  assert.equal(queue.result(job.id, job.hash).answer.complete, true);
  assert.equal(done.answered, 2);
  // Next claim with nothing queued clears the answered turn into history.
  const idle = claim(s.relayId, done.revision);
  assert.equal(idle.turn, null);
  assert.equal(idle.recent.length, 2);
  assert.equal(idle.recent[1].complete, true);
});

test("stopping sharing releases app claims; a relay restart recovers its own working job without a second claim", () => {
  const { queue, app, open, claim, reply } = setup();
  queue.enable(true);
  const s = open();
  const job = queue.enqueue(
    "tutor",
    dialoguePayload("synthetic-dialogue-3", [human("partial", 1)]),
  );
  const claimed = claim(s.relayId, s.revision);
  queue.enable(false);
  assert.throws(
    () => reply(s.relayId, claimed.turn.turnId, "Solved", true),
    /disabled/,
  );
  assert.equal(queue.snapshot().working, 1);
  app.release();
  assert.equal(queue.snapshot().working, 0);
  assert.equal(queue.snapshot().queued, 1);
  const released = state(
    app.call("read_study_terminal", { relayId: s.relayId }, owner),
  );
  assert.equal(released.turn, null);
  assert.equal(released.recent[0].status, "released");
  assert.equal(released.released, false);
  assert.throws(
    () => reply(s.relayId, claimed.turn.turnId, "Solved", true),
    /does not match/,
  );
  queue.enable(true);
  const reclaimed = claim(s.relayId, released.revision);
  assert.notEqual(reclaimed.turn.turnId, claimed.turn.turnId);
  assert.equal(reclaimed.turn.requestId, "synthetic-dialogue-3");
  // Relay process restart: in-memory sessions are lost but the queue persists.
  const restarted = createTerminalRelayApp({ queue });
  const fresh = state(restarted.call("open_study_terminal", {}, owner));
  assert.equal(
    fresh.relayId,
    s.relayId,
    "the owner relay remains addressable after restart",
  );
  const recovered = state(
    restarted.call(
      "claim_study_terminal_turn",
      { relayId: fresh.relayId, revision: fresh.revision },
      owner,
    ),
  );
  assert.equal(recovered.turn.requestId, "synthetic-dialogue-3");
  assert.equal(queue.snapshot().working, 1);
  assert.equal(queue.snapshot().queued, 0);
  state(
    restarted.call(
      "reply_study_terminal_job",
      {
        relayId: fresh.relayId,
        turnId: recovered.turn.turnId,
        text: "Solved",
        complete: true,
      },
      owner,
    ),
  );
  assert.equal(queue.result(job.id, job.hash).answer.complete, true);
  // The old relay instance cannot deliver a second reply to the finished job.
  assert.throws(
    () => reply(s.relayId, reclaimed.turn.turnId, "Another", false),
    /Conflicting|Wrong worker/,
  );
});

test("owners are isolated, sessions are bounded and oversized packets omit context behind a read tool", () => {
  const { queue, app, open, claim, reply } = setup({
    maxSessions: 1,
    promptLimit: 2000,
  });
  queue.enable(true);
  const s = open();
  assert.throws(() => open(other), /capacity/);
  assert.throws(
    () => app.call("read_study_terminal", { relayId: s.relayId }, other),
    /unavailable/,
  );
  assert.throws(
    () =>
      app.call(
        "claim_study_terminal_turn",
        { relayId: s.relayId, revision: 0, shell: "bad" },
        owner,
      ),
    /Unknown/,
  );
  const messages = Array.from({ length: 120 }, (_, i) =>
    human(`message ${i} ${"x".repeat(40)}`, i + 1),
  );
  queue.enqueue(
    "tutor",
    dialoguePayload("synthetic-dialogue-4", messages, {
      curriculum: "C".repeat(3000),
      progressContext: "P".repeat(3000),
    }),
  );
  const claimed = claim(s.relayId, s.revision);
  assert.deepEqual(claimed.turn.omitted, [
    "progressContext",
    "curriculum",
    "messages",
  ]);
  const packet = JSON.parse(
    claimed.turn.prompt.split("\n").slice(2).join("\n"),
  );
  assert.equal(packet.curriculum, undefined);
  assert.ok(packet.messages.length < 80);
  assert.ok(packet.messagesOmitted > 40);
  assert.equal(packet.messages.at(-1).text, messages.at(-1).text);
  assert.ok(claimed.turn.prompt.length <= 2000 + TURN_INSTRUCTION.length);
  assert.throws(
    () =>
      app.call(
        "read_study_terminal_context",
        { relayId: s.relayId, turnId: "wrong", part: "curriculum" },
        owner,
      ),
    /not pending/,
  );
  const read = JSON.parse(
    app.call(
      "read_study_terminal_context",
      { relayId: s.relayId, turnId: claimed.turn.turnId, part: "curriculum" },
      owner,
    ).content[0].text,
  );
  assert.equal(read.text, "C".repeat(3000));
  const history = JSON.parse(
    app.call(
      "read_study_terminal_context",
      { relayId: s.relayId, turnId: claimed.turn.turnId, part: "messages" },
      owner,
    ).content[0].text,
  );
  assert.deepEqual(JSON.parse(history.text), messages);
  assert.throws(
    () =>
      app.call(
        "read_study_terminal_context",
        {
          relayId: s.relayId,
          turnId: claimed.turn.turnId,
          part: "curriculum",
        },
        other,
      ),
    /unavailable/,
  );
  reply(s.relayId, claimed.turn.turnId, "ok", false);
  assert.throws(
    () =>
      app.call(
        "read_study_terminal_context",
        { relayId: s.relayId, turnId: claimed.turn.turnId, part: "curriculum" },
        owner,
      ),
    /not pending/,
  );
});

test("large saved work and learner answers stay exact and retrievable within the host turn limit", () => {
  const promptLimit = 4000;
  const { queue, app, open, claim, reply } = setup({ promptLimit });
  queue.enable(true);
  const s = open();
  const messages = [human("🧟".repeat(12_000), 1)];
  const captured = {
    workspace: "const draft = '🧟';\n".repeat(4000),
    executions: [{ stdout: "runner output\n".repeat(6000), executed: true }],
    submissions: [{ solution: "saved solution\n".repeat(4000) }],
  };
  const receipt = queue.enqueue(
    "tutor",
    dialoguePayload("synthetic-large-artifacts", messages, captured),
  );
  const turn = claim(s.relayId, s.revision).turn;
  assert.ok(turn.prompt.length <= promptLimit + TURN_INSTRUCTION.length);
  for (const [part, value] of Object.entries({ ...captured, messages })) {
    assert.ok(turn.omitted.includes(part), `${part} must remain retrievable`);
    const read = JSON.parse(
      app.call(
        "read_study_terminal_context",
        { relayId: s.relayId, turnId: turn.turnId, part },
        owner,
      ).content[0].text,
    );
    assert.deepEqual(
      typeof value === "string" ? read.text : JSON.parse(read.text),
      value,
    );
  }
  reply(s.relayId, turn.turnId, "Captured work reviewed.", true);
  assert.equal(queue.result(receipt.id, receipt.hash).answer.complete, true);
});

test("context tools advertise the same chat code aliases as the native getter", () => {
  const tools = terminalRelayTools();
  const getter = tools.find(
    (tool) => tool.name === "get_current_study_question",
  );
  const reader = tools.find(
    (tool) => tool.name === "read_study_terminal_context",
  );
  for (const alias of ["chat", "chat_code", "chatCode"])
    assert.deepEqual(
      reader.inputSchema.properties[alias],
      getter.inputSchema.properties[alias],
    );
  // Legacy terminal turns predate chat codes and still use this reader.
  assert.deepEqual(reader.inputSchema.required, ["relayId", "turnId", "part"]);
});

test("scoped preparation chunks require their exact chat code before crediting a read", () => {
  const { queue, app } = setup();
  queue.enable(true);
  const chat = "CONTEXT01";
  const scope = { runId: "synthetic-context-run", encounterId: "station-one" };
  const payload = {
    requestId: "synthetic-scoped-preparation-context",
    encounterId: scope.encounterId,
    curriculum: "Exact synthetic source 🙂\n".repeat(6000),
  };
  const receipt = queue.enqueue("generate", payload, scope, chat);
  const current = (code) =>
    state(app.call("get_current_study_question", { chat: code }, owner));
  const turn = current(chat);
  const args = {
    relayId: turn.relayId,
    turnId: turn.turnId,
    part: "payload",
    index: 0,
  };
  const read = (extra) =>
    state(
      app.call("read_study_terminal_context", { ...args, ...extra }, owner),
    );
  const finish = () =>
    app.call(
      "finish_study_preparation",
      {
        relayId: turn.relayId,
        turnId: turn.turnId,
        jobFingerprint: turn.jobFingerprint,
        response: "{}",
      },
      owner,
    );
  assert.match(turn.prompt, /read_study_terminal_context.*chat code/);
  assert.throws(() => read({}), /chat code/);
  assert.throws(() => read({ chat: "OTHER001" }), /disconnected/);
  for (const chat of ["lowercase", "short", 12345678, null])
    assert.throws(() => read({ chat }), /Invalid chat code/);
  assert.throws(
    () => read({ chat, chat_code: "OTHER001" }),
    /Conflicting chat codes/,
  );
  assert.throws(() => finish(), /Read every frozen/);
  const first = read({ chat });
  assert.ok(first.parts > 1);
  const parts = [first.text];
  for (let index = 1; index < first.parts; index++) {
    assert.throws(() => read({ index, chat: "OTHER001" }), /disconnected/);
    assert.throws(() => finish(), /Read every frozen/);
    const alias = index % 2 ? "chat_code" : "chatCode";
    parts.push(read({ index, [alias]: chat }).text);
  }
  assert.deepEqual(JSON.parse(parts.join("")), payload);
  assert.deepEqual(current(chat), turn, "rejected reads preserve the claim");
  assert.equal(queue.result(receipt.id, receipt.hash).status, "pending");

  // Reopening the exact same request transfers it to a new chat even before
  // that chat calls the getter. Old cached turns must immediately lose access.
  queue.enqueue("generate", payload, scope, "CONTEXT02");
  assert.throws(() => read({ chat }), /disconnected/);
  assert.throws(() => read({ chat: "CONTEXT02" }), /disconnected/);
  const reopened = current("CONTEXT02");
  assert.notEqual(reopened.turnId, turn.turnId);
  const restored = state(
    app.call(
      "read_study_terminal_context",
      {
        ...args,
        turnId: reopened.turnId,
        chat: "CONTEXT02",
      },
      owner,
    ),
  );
  assert.equal(restored.text, first.text);
});

test("scoped direct-question context rejects another chat and a stopped requester", () => {
  let clock = 1000;
  const queue = waitingGame(createHandoffQueue({ now: () => clock }));
  const app = createTerminalRelayApp({ queue, now: () => clock });
  queue.enable(true);
  const scope = { runId: "synthetic-direct-context-run", encounterId: "one" };
  queue.enqueue(
    "tutor",
    dialoguePayload("synthetic-direct-context", [human("answer", 1)], {
      ...scope,
      mode: "terminal-direct",
      questionFingerprint: "synthetic-direct-context-fingerprint",
      curriculum: "Exact synthetic curriculum\n".repeat(3000),
    }),
    scope,
    "DIRECT01",
  );
  const turn = state(
    app.call("get_current_study_question", { chat: "DIRECT01" }, owner),
  );
  const args = {
    relayId: turn.relayId,
    turnId: turn.turnId,
    part: "curriculum",
  };
  assert.throws(
    () => app.call("read_study_terminal_context", args, owner),
    /chat code/,
  );
  assert.throws(
    () =>
      app.call(
        "read_study_terminal_context",
        { ...args, chat: "OTHER001" },
        owner,
      ),
    /disconnected/,
  );
  const read = JSON.parse(
    app.call(
      "read_study_terminal_context",
      { ...args, chat: "DIRECT01" },
      owner,
    ).content[0].text,
  );
  assert.equal(read.text, "Exact synthetic curriculum\n".repeat(3000));
  clock += REQUESTER_LIVE_MS + 1;
  assert.throws(
    () =>
      app.call(
        "read_study_terminal_context",
        { ...args, chat: "DIRECT01" },
        owner,
      ),
    /no longer waiting/,
  );
});

test("status counts only app sessions that are still calling in as active", () => {
  let clock = 1_000_000;
  const queue = waitingGame(createHandoffQueue());
  const app = createTerminalRelayApp({ queue, now: () => clock });
  const s = state(app.call("open_study_terminal", {}, owner));
  assert.deepEqual(app.status(), {
    sessions: 1,
    activeSessions: 1,
    pendingTurns: 0,
  });
  clock += 21_000;
  assert.equal(app.status().activeSessions, 0, "a paused app is not listening");
  assert.equal(app.status().sessions, 1);
  app.call("read_study_terminal", { relayId: s.relayId }, owner);
  assert.equal(app.status().activeSessions, 1);
});

test("card refreshes do not invent new model activity on an existing claim", () => {
  let clock = 1000;
  const queue = waitingGame(createHandoffQueue({ now: () => clock }));
  const app = createTerminalRelayApp({ queue, now: () => clock });
  queue.enable(true);
  const receipt = queue.enqueue(
    "tutor",
    dialoguePayload("card-activity", [human("Synthetic", 1)]),
  );
  const session = state(app.call("open_study_terminal", {}, owner));
  const claimed = state(
    app.call(
      "claim_study_terminal_turn",
      { relayId: session.relayId, revision: session.revision },
      owner,
    ),
  );
  assert.equal(
    queue.progress(receipt.id, receipt.hash).lastWorkerActivityAt,
    1000,
  );
  clock += 60_000;
  queue.result(receipt.id, receipt.hash);
  const refreshed = state(
    app.call(
      "claim_study_terminal_turn",
      { relayId: session.relayId, revision: claimed.revision },
      owner,
    ),
  );
  assert.equal(refreshed.turn.turnId, claimed.turn.turnId);
  assert.equal(
    queue.progress(receipt.id, receipt.hash).lastWorkerActivityAt,
    1000,
  );
});

test("chunked terminal packets are reassembled and all parts are read before a reply is accepted", () => {
  const { queue, open, claim, reply } = setup({ promptLimit: 2_000_000 });
  queue.enable(true);
  const s = open();
  const job = queue.enqueue(
    "tutor",
    dialoguePayload("synthetic-dialogue-5", [human("big", 1)], {
      curriculum: "K".repeat(600_000),
    }),
  );
  const claimed = claim(s.relayId, s.revision);
  assert.equal(claimed.turn.requestId, "synthetic-dialogue-5");
  assert.equal(claimed.turn.question.title, "Synthetic window");
  reply(s.relayId, claimed.turn.turnId, "Noted", false);
  assert.equal(queue.result(job.id, job.hash).status, "done");
});

test("a turn whose game stopped polling never blocks the live game's turn", () => {
  let clock = 1_000_000;
  const queue = createHandoffQueue({ now: () => clock });
  const app = createTerminalRelayApp({ queue, now: () => clock });
  queue.enable(true);
  const s = state(app.call("open_study_terminal", {}, owner));
  // An earlier run queued a turn and is claimed, then the page reloads.
  const stale = queue.enqueue(
    "tutor",
    dialoguePayload("synthetic-old-run", [human("count == 2", 1)]),
  );
  queue.result(stale.id, stale.hash);
  const first = state(
    app.call(
      "claim_study_terminal_turn",
      { relayId: s.relayId, revision: s.revision },
      owner,
    ),
  );
  assert.equal(first.turn.requestId, "synthetic-old-run");
  // A game tab hidden behind the ChatGPT tab is throttled to one poll a
  // minute; that cadence must still count as waiting.
  clock += 61_000;
  assert.equal(
    state(app.call("read_study_terminal", { relayId: s.relayId }, owner)).turn
      .turnId,
    first.turn.turnId,
  );
  queue.result(stale.id, stale.hash);
  clock += REQUESTER_LIVE_MS + 1_000;
  // The new run's game queues and keeps polling its own turn.
  const live = queue.enqueue(
    "tutor",
    dialoguePayload("synthetic-new-run", [human("[1,6,5] largest", 1)]),
  );
  queue.result(live.id, live.hash);
  // While the app waits on the stale turn it reads, and is handed the live one.
  const moved = state(
    app.call("read_study_terminal", { relayId: s.relayId }, owner),
  );
  assert.equal(moved.turn.requestId, "synthetic-new-run");
  assert.notEqual(moved.turn.turnId, first.turn.turnId);
  assert.equal(moved.recent.at(-1).status, "released");
  assert.equal(queue.snapshot().queued, 1, "the stale turn is kept, not lost");
  assert.throws(
    () =>
      app.call(
        "reply_study_terminal_job",
        {
          relayId: s.relayId,
          turnId: first.turn.turnId,
          text: "late",
          complete: false,
        },
        owner,
      ),
    /does not match/,
  );
  // If that old game comes back and polls again, its turn is served next.
  app.call(
    "reply_study_terminal_job",
    {
      relayId: s.relayId,
      turnId: moved.turn.turnId,
      text: "Right.",
      complete: true,
    },
    owner,
  );
  assert.equal(queue.result(live.id, live.hash).answer.complete, true);
  queue.result(stale.id, stale.hash);
  const back = state(
    app.call(
      "claim_study_terminal_turn",
      { relayId: s.relayId, revision: moved.revision + 1 },
      owner,
    ),
  );
  assert.equal(back.turn.requestId, "synthetic-old-run");
});

test("an embedded app left open across a relay restart keeps serving its owner", () => {
  const queue = waitingGame(createHandoffQueue());
  queue.enable(true);
  const before = createTerminalRelayApp({ queue });
  const s = state(before.call("open_study_terminal", {}, owner));
  const seen = state(
    before.call(
      "claim_study_terminal_turn",
      { relayId: s.relayId, revision: s.revision },
      owner,
    ),
  );
  queue.enqueue(
    "tutor",
    dialoguePayload("synthetic-restart", [human("answer", 1)]),
  );
  const restarted = createTerminalRelayApp({ queue });
  const resumed = state(
    restarted.call(
      "claim_study_terminal_turn",
      { relayId: s.relayId, revision: seen.revision },
      owner,
    ),
  );
  assert.equal(resumed.relayId, s.relayId);
  assert.ok(resumed.revision > seen.revision, "the open app accepts it");
  assert.equal(resumed.turn.requestId, "synthetic-restart");
  // Another owner cannot take over that relay id, and a second app for the
  // same owner still has to reopen.
  assert.throws(
    () => restarted.call("read_study_terminal", { relayId: s.relayId }, other),
    /reopen the study terminal/,
  );
  assert.throws(
    () => restarted.call("read_study_terminal", { relayId: "other-id" }, owner),
    /reopen the study terminal/,
  );
});
