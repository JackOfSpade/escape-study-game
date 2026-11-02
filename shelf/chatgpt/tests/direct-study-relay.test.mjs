import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createHandoffQueue,
  validDirectTranscript,
  validDirectKnowledge,
  HANDOFF_REQUESTER_LIVE_MS,
} from "../scripts/chatgpt-handoff-queue.mjs";
import {
  createTerminalRelayApp,
  terminalRelayTools,
  DIRECT_TURN_INSTRUCTION,
} from "../scripts/terminal-relay-app.mjs";
import {
  TOPIC_ASSESSMENT_TEXT_LIMIT,
  topicAssessmentTopics,
  validateTopicAssessments,
} from "../scripts/lib/topic-assessment.mjs";
const owner = { linkId: "synthetic-native-owner" };
const other = { linkId: "synthetic-native-other-owner" };
const payload = (requestId = "native-synthetic-one", extra = {}) => ({
  requestId,
  sessionId: `${requestId}/session`,
  questionFingerprint: `${requestId}/fingerprint`,
  mode: "terminal-direct",
  problem: {
    title: "Synthetic async UI",
    prompt:
      "Two searches resolve out of order. How do you prevent stale results?",
    rubric: ["Latest requested result stays visible"],
    starter: "",
  },
  workspace: "",
  draftRevision: 1,
  messages: [],
  probe: {
    stance: "One directly relevant prerequisite level at most.",
    facets: [{ id: "stale-results", description: "Prevent stale UI updates" }],
  },
  instruction: "Stay in this focused feature scenario.",
  ...extra,
});
const answer = (turn, extra = {}) => ({
  relayId: turn.relayId,
  turnId: turn.turnId,
  questionFingerprint: turn.questionFingerprint,
  text: "Conversation finished; completion sent for local validation.",
  outcome: "solved",
  transcript: [
    { role: "assistant", text: "How do you prevent stale results?" },
    {
      role: "user",
      text: "Track the current request and ignore older responses.",
    },
  ],
  knowledge: { facets: [{ id: "stale-results", status: "demonstrated" }] },
  ...extra,
});
function setup() {
  let clock = 1000;
  const queue = createHandoffQueue({ now: () => clock });
  let app = createTerminalRelayApp({ queue, now: () => clock });
  const call = (name, args = {}, grant = owner) =>
    app.call(name, args, grant).structuredContent;
  const enqueue = (p = payload(), operation = "tutor") => {
    const receipt = queue.enqueue(operation, p);
    queue.result(receipt.id, receipt.hash);
    return receipt;
  };
  return {
    queue,
    call,
    rawCall: (name, args = {}, grant = owner) => app.call(name, args, grant),
    enqueue,
    tick: (ms) => {
      clock += ms;
    },
    restart: () => {
      app = createTerminalRelayApp({ queue, now: () => clock });
    },
    status: () => app.status(),
  };
}

test("topic reflections use exact contract topics and freely written bounded prose", () => {
  assert.deepEqual(
    topicAssessmentTopics({
      objectiveIds: [
        "PY:T05.2",
        "PY:T05.3",
        "PE:X08",
        "PE:I01",
        "unrelated",
        null,
      ],
    }),
    ["PY:T05", "PE:X08", "PE:I01"],
  );
  assert.deepEqual(topicAssessmentTopics(undefined), []);
  assert.deepEqual(validateTopicAssessments(undefined, ["PE:X08"]), []);
  const reflection = {
    topicId: "PE:X08",
    text: "Your latest answer makes stale-result handling look solid. I suspect cancellation is still a gap, because you omitted it; that is a prediction, not something we have tested.",
  };
  assert.deepEqual(validateTopicAssessments([reflection], ["PE:X08"], true), [
    reflection,
  ]);
  for (const invalid of [
    undefined,
    [],
    [{ ...reflection, topicId: "PE:X09" }],
    [{ ...reflection, text: "   " }],
    [{ ...reflection, text: "x".repeat(TOPIC_ASSESSMENT_TEXT_LIMIT + 1) }],
    [{ ...reflection, mastery: true }],
  ])
    assert.throws(() => validateTopicAssessments(invalid, ["PE:X08"], true));
  assert.throws(() =>
    validateTopicAssessments(
      [reflection, reflection],
      ["PE:X08", "PE:X09"],
      true,
    ),
  );
});

test("new native completions refresh only captured topic narratives and preserve exact-once delivery", () => {
  const { queue, call, enqueue } = setup();
  queue.enable(true);
  const topicAssessmentContext = {
    topicIds: ["PE:X08"],
    topics: [{ topicId: "PE:X08", name: "Async interactions" }],
    priorAssessments: [],
  };
  const job = enqueue(
    payload("native-topic-reflection", { topicAssessmentContext }),
  );
  const turn = call("get_current_study_question");
  const packet = JSON.parse(turn.prompt.slice(DIRECT_TURN_INSTRUCTION.length));
  assert.deepEqual(packet.topicAssessmentContext, topicAssessmentContext);
  assert.match(turn.prompt, /probable knowledge gaps/);
  assert.match(turn.prompt, /no fixed template/);
  const a = answer(turn);
  for (const topicAssessments of [
    undefined,
    [],
    [{ topicId: "PE:X09", text: "Unrelated topic" }],
    [{ topicId: "PE:X08", text: "" }],
  ]) {
    assert.throws(() =>
      call("finish_study_question", { ...a, topicAssessments }),
    );
    assert.equal(queue.result(job.id, job.hash).status, "pending");
    assert.equal(call("get_current_study_question").turnId, turn.turnId);
  }
  const topicAssessments = [
    {
      topicId: "PE:X08",
      text: "You explain stale results clearly. You probably still need practice choosing when cancellation is useful; we have not directly assessed that yet.",
    },
  ];
  const complete = { ...a, topicAssessments };
  assert.equal(
    call("finish_study_question", complete).completion.status,
    "sent",
  );
  const forwarded = queue.result(job.id, job.hash).answer;
  assert.deepEqual(forwarded.topicAssessments, topicAssessments);
  assert.deepEqual(forwarded.knowledge, a.knowledge);
  assert.equal(
    call("finish_study_question", complete).completion.duplicate,
    true,
  );
  assert.throws(
    () =>
      call("finish_study_question", {
        ...complete,
        topicAssessments: [{ topicId: "PE:X08", text: "Changed narrative" }],
      }),
    /Conflicting/,
  );
});

test("large topic history stays available in full and must be read before narrative completion", () => {
  const { queue, call, rawCall, enqueue } = setup();
  queue.enable(true);
  const topicAssessmentContext = {
    topicIds: ["PE:X08"],
    history: "Exact synthetic learner history. ".repeat(2000),
  };
  enqueue(payload("native-large-topic-context", { topicAssessmentContext }));
  const turn = call("get_current_study_question");
  const packet = JSON.parse(turn.prompt.slice(DIRECT_TURN_INSTRUCTION.length));
  assert.ok(packet.omitted.includes("topicAssessmentContext"));
  assert.equal(packet.topicAssessmentContext, undefined);
  assert.ok(turn.prompt.length < 50_000);
  const complete = answer(turn, {
    topicAssessments: [
      { topicId: "PE:X08", text: "A tentative current assessment." },
    ],
  });
  assert.throws(
    () => call("finish_study_question", complete),
    /Read the complete omitted topicAssessmentContext/,
  );
  const read = rawCall("read_study_terminal_context", {
    relayId: turn.relayId,
    turnId: turn.turnId,
    part: "topicAssessmentContext",
  });
  const returned = JSON.parse(read.content[0].text);
  assert.deepEqual(JSON.parse(returned.text), topicAssessmentContext);
  assert.equal(
    call("finish_study_question", complete).completion.status,
    "sent",
  );
});

test("native question is available as normal tool output with no widget and no artificial user answer", () => {
  const { queue, call, enqueue } = setup();
  const tool = terminalRelayTools().find(
    (t) => t.name === "get_current_study_question",
  );
  assert.deepEqual(tool.inputSchema.required, []);
  assert.equal(tool._meta.ui, undefined);
  assert.equal(tool._meta["openai/outputTemplate"], undefined);
  assert.equal(call("get_current_study_question").status, "waiting");
  assert.equal(queue.snapshot().enabled, false);
  queue.enable(true);
  enqueue(payload("not-a-native-turn", { mode: "terminal-dialogue" }));
  const job = enqueue();
  const one = call("get_current_study_question");
  assert.equal(one.status, "question");
  assert.equal(one.requestId, "native-synthetic-one");
  assert.match(one.prompt, /^@study\n/);
  assert.match(one.prompt, /ordinary ChatGPT composer/);
  assert.match(one.prompt, /at most one directly relevant prerequisite level/);
  assert.match(one.prompt, /leave unasked facets unknown/);
  const packet = JSON.parse(one.prompt.slice(DIRECT_TURN_INSTRUCTION.length));
  assert.deepEqual(packet.messages, []);
  assert.equal(packet.question.prompt, payload().problem.prompt);
  assert.equal(packet.questionFingerprint, one.questionFingerprint);
  assert.deepEqual(call("get_current_study_question"), one);
  assert.equal(queue.result(job.id, job.hash).status, "pending");
  assert.equal(queue.snapshot().queued, 1, "legacy turn is untouched");
});

test("native completion crosses the exact queue once, attributes both roles, and confirms delivery only", () => {
  const { queue, call, enqueue, tick } = setup();
  queue.enable(true);
  const job = enqueue();
  tick(12);
  const turn = call("get_current_study_question");
  tick(2000);
  const a = answer(turn);
  const done = call("finish_study_question", a);
  assert.equal(done.completion.status, "sent");
  assert.equal(done.completion.duplicate, false);
  assert.match(done.completion.note, /no key has been confirmed as awarded/);
  assert.equal(queue.snapshot().recent[0].resultReadAt, undefined);
  tick(500);
  const forwarded = queue.result(job.id, job.hash).answer;
  assert.equal(forwarded.complete, true);
  assert.deepEqual(forwarded.transcript, a.transcript);
  assert.equal(forwarded.questionFingerprint, turn.questionFingerprint);
  assert.equal(
    done.turn.reply.transcript,
    undefined,
    "status omits private transcript",
  );
  assert.equal(done.turn.reply.transcriptEntries, 2);
  assert.equal(call("finish_study_question", a).completion.duplicate, true);
  assert.equal(queue.snapshot().done, 1);
  assert.throws(
    () => call("finish_study_question", { ...a, text: "changed" }),
    /Conflicting/,
  );
  const timings = queue.snapshot().recent[0];
  assert.equal(timings.firstPolledAt, 1000);
  assert.equal(timings.claimedAt, 1012);
  assert.equal(timings.completedAt, 3012);
  assert.equal(timings.resultReadAt, 3512);
  tick(500);
  queue.result(job.id, job.hash);
  assert.equal(
    queue.snapshot().recent[0].resultReadAt,
    3512,
    "only the first completed read is stamped",
  );
  assert.doesNotMatch(
    JSON.stringify(queue.snapshot()),
    /Track the current request|stale UI/,
  );
});

test("owner, mode, current turn and fingerprint are checked before any response reaches the game", () => {
  const { queue, call, enqueue } = setup();
  queue.enable(true);
  const job = enqueue();
  const turn = call("get_current_study_question");
  const a = answer(turn);
  assert.throws(() => call("finish_study_question", a, other), /unavailable/);
  assert.throws(
    () => call("finish_study_question", { ...a, turnId: "foreign" }),
    /current pending/,
  );
  assert.throws(
    () => call("finish_study_question", { ...a, questionFingerprint: "wrong" }),
    /different study question/,
  );
  assert.throws(
    () =>
      call("reply_study_terminal_job", {
        relayId: turn.relayId,
        turnId: turn.turnId,
        text: "x",
        complete: true,
      }),
    /direct study question/,
  );
  assert.equal(queue.result(job.id, job.hash).status, "pending");
  assert.equal(queue.snapshot().done, 0);
  const second = setup();
  second.queue.enable(true);
  second.enqueue(payload("legacy", { mode: "terminal-dialogue" }));
  const relay = second.call("open_study_terminal");
  const legacy = second.call("claim_study_terminal_turn", {
    relayId: relay.relayId,
    revision: relay.revision,
  });
  assert.equal(second.call("get_current_study_question").status, "waiting");
  assert.throws(
    () =>
      second.call(
        "finish_study_question",
        answer({
          relayId: relay.relayId,
          turnId: legacy.turn.turnId,
          questionFingerprint: "fake",
        }),
      ),
    /terminal dialogue/,
  );
});

test("malformed full native transcripts and metadata retain the same pending claim", () => {
  const { queue, call, enqueue } = setup();
  queue.enable(true);
  const job = enqueue();
  const turn = call("get_current_study_question");
  const a = answer(turn);
  const bad = [
    { transcript: [] },
    { transcript: [{ role: "assistant", text: "No learner message" }] },
    { transcript: [{ role: "user", text: " " }] },
    { transcript: [{ role: "human", text: "unsupported role" }] },
    { transcript: [{ role: "user", text: "x", author: "human" }] },
    { transcript: [{ role: "user", text: "x".repeat(8001) }] },
    {
      transcript: Array.from({ length: 101 }, () => ({
        role: "user",
        text: "x",
      })),
    },
    {
      transcript: Array.from({ length: 14 }, () => ({
        role: "user",
        text: "x".repeat(8000),
      })),
    },
    { questionFingerprint: "x".repeat(501) },
    { knowledge: { arbitrary: true } },
    { knowledge: { facets: [{ id: "x", status: "gap" }] } },
    { knowledge: { facets: [{ id: "", status: "demonstrated" }] } },
    {
      knowledge: {
        facets: [{ id: "x", status: "demonstrated", note: "x".repeat(401) }],
      },
    },
    {
      knowledge: {
        facets: [{ id: "x", status: "demonstrated", unexpected: true }],
      },
    },
    {
      knowledge: {
        facets: [
          { id: "x", status: "demonstrated" },
          { id: "x", status: "demonstrated" },
        ],
      },
    },
    {
      knowledge: {
        facets: [{ id: "part", status: "demonstrated", partOf: "known" }],
      },
    },
    { outcome: "gap", knowledge: undefined },
    { text: "x".repeat(8001) },
    { complete: true },
  ];
  for (const extra of bad) {
    assert.throws(() => call("finish_study_question", { ...a, ...extra }));
    assert.equal(queue.result(job.id, job.hash).status, "pending");
    assert.equal(call("get_current_study_question").turnId, turn.turnId);
  }
  const gap = answer(turn, {
    outcome: "gap",
    transcript: [
      { role: "user", text: "I don't know how to avoid stale results." },
    ],
    knowledge: { facets: [{ id: "stale-results", status: "gap" }] },
  });
  call("finish_study_question", gap);
  assert.equal(queue.result(job.id, job.hash).answer.outcome, "gap");
});

test("native sessions remain stable and active beyond thirty minutes without per-answer tool polling", () => {
  const { queue, call, enqueue, tick, status } = setup();
  queue.enable(true);
  const job = enqueue();
  const turn = call("get_current_study_question");
  for (let minute = 0; minute < 90; minute++) {
    tick(60_000);
    queue.result(job.id, job.hash);
  }
  assert.equal(
    status().activeSessions,
    1,
    "the waiting game keeps a native conversation active without UI tool polling",
  );
  assert.equal(call("get_current_study_question").turnId, turn.turnId);
  assert.equal(
    call("finish_study_question", answer(turn)).completion.status,
    "sent",
  );
});

test("role scope, exact facet definitions, prior probe context and an unsubmitted draft reach native chat", () => {
  const { queue, call, enqueue } = setup();
  queue.enable(true);
  const extra = {
    guidance:
      "Frontend feature ownership; transport internals are reference only.",
    scopeDefinitions: [
      {
        id: "scope",
        objectiveId: "PE:synthetic",
        depth: 1,
        sourceScope: "Exact source criteria",
        facets: [
          { id: "stale-results", description: "Prevent stale UI updates" },
        ],
      },
    ],
    knowledgeContext: "Previously declared gap: race conditions.",
    probeHistory: [
      {
        requestId: "prior",
        findings: [{ id: "stale-results", status: "gap" }],
      },
    ],
    unsentDraft: { text: "An unfinished idea", learnerEvidence: false },
  };
  enqueue(payload("native-context", extra));
  const turn = call("get_current_study_question");
  const packet = JSON.parse(turn.prompt.slice(DIRECT_TURN_INSTRUCTION.length));
  for (const [part, value] of Object.entries(extra))
    assert.deepEqual(packet[part], value);
  const large = setup();
  large.queue.enable(true);
  const largeScope = [
    {
      ...extra.scopeDefinitions[0],
      sourceScope: "Exact source criteria. ".repeat(5000),
    },
  ];
  large.enqueue(
    payload("native-context-large", { scopeDefinitions: largeScope }),
  );
  const largeTurn = large.call("get_current_study_question");
  const largePacket = JSON.parse(
    largeTurn.prompt.slice(DIRECT_TURN_INSTRUCTION.length),
  );
  assert.ok(largePacket.omitted.includes("scopeDefinitions"));
  const restored = large.rawCall("read_study_terminal_context", {
    relayId: largeTurn.relayId,
    turnId: largeTurn.turnId,
    part: "scopeDefinitions",
  });
  assert.deepEqual(
    JSON.parse(JSON.parse(restored.content[0].text).text),
    largeScope,
  );
});

test("stale native requester cannot complete and cannot block a live new question", () => {
  const { queue, call, enqueue, tick } = setup();
  queue.enable(true);
  const old = enqueue();
  const first = call("get_current_study_question");
  tick(HANDOFF_REQUESTER_LIVE_MS + 1);
  assert.throws(
    () => call("finish_study_question", answer(first)),
    /no longer waiting/,
  );
  const fresh = enqueue(payload("native-synthetic-new-run"));
  const next = call("get_current_study_question");
  assert.equal(next.requestId, "native-synthetic-new-run");
  assert.notEqual(next.turnId, first.turnId);
  assert.throws(
    () => call("finish_study_question", answer(first)),
    /current pending/,
  );
  assert.equal(queue.result(fresh.id, fresh.hash).status, "pending");
  assert.equal(queue.result(old.id, old.hash).status, "pending");
});

test("native claim identities and duplicate receipts survive relay and durable queue restarts", () => {
  const directory = mkdtempSync(join(tmpdir(), "native-relay-fixture-"));
  const file = join(directory, "queue.json");
  try {
    let queue = createHandoffQueue({ file });
    queue.enable(true);
    const job = queue.enqueue("tutor", payload());
    queue.result(job.id, job.hash);
    let app = createTerminalRelayApp({ queue });
    const one = app.call(
      "get_current_study_question",
      {},
      owner,
    ).structuredContent;
    queue = createHandoffQueue({ file });
    assert.equal(
      queue.snapshot().enabled,
      false,
      "restart does not restore sharing authorization",
    );
    queue.enable(true);
    queue.result(job.id, job.hash);
    app = createTerminalRelayApp({ queue });
    const resumed = app.call(
      "get_current_study_question",
      {},
      owner,
    ).structuredContent;
    assert.equal(resumed.relayId, one.relayId);
    assert.equal(resumed.turnId, one.turnId);
    assert.equal(resumed.questionFingerprint, one.questionFingerprint);
    const a = answer(one);
    app.call("finish_study_question", a, owner);
    queue = createHandoffQueue({ file });
    queue.enable(true);
    app = createTerminalRelayApp({ queue });
    const duplicate = app.call(
      "finish_study_question",
      a,
      owner,
    ).structuredContent;
    assert.equal(duplicate.completion.duplicate, true);
    assert.equal(queue.snapshot().done, 1);
    assert.throws(
      () => app.call("finish_study_question", { ...a, text: "changed" }, owner),
      /Conflicting/,
    );
    assert.throws(
      () => app.call("finish_study_question", a, other),
      /unavailable/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("queue independently rejects malformed native completions and invalid bindings", () => {
  const q = createHandoffQueue();
  q.enable(true);
  assert.throws(
    () => q.enqueue("tutor", payload("missing", { questionFingerprint: "" })),
    /questionFingerprint/,
  );
  assert.throws(
    () => q.enqueue("tutor", payload("missing", { sessionId: " " })),
    /sessionId/,
  );
  const job = q.enqueue("tutor", payload());
  const served = q.get("synthetic-native-worker");
  const complete = {
    ...answer({ questionFingerprint: payload().questionFingerprint }),
    complete: true,
  };
  delete complete.relayId;
  delete complete.turnId;
  for (const bad of [
    { ...complete, complete: false },
    { ...complete, questionFingerprint: "wrong" },
    {
      ...complete,
      transcript: [{ role: "assistant", text: "Only tutor work" }],
    },
    { ...complete, outcome: "gap", knowledge: { facets: [] } },
    { ...complete, arbitrary: "untrusted" },
  ])
    assert.throws(() =>
      q.submit("synthetic-native-worker", served.jobId, served.claim, bad),
    );
  assert.equal(q.result(job.id, job.hash).status, "pending");
  assert.equal(
    q.submit("synthetic-native-worker", served.jobId, served.claim, complete)
      .status,
    "accepted",
  );
});

test("shared direct bounds reject ambiguous transcript roles and metadata", () => {
  assert.equal(
    validDirectTranscript([{ role: "user", text: "actual answer" }]),
    true,
  );
  assert.equal(
    validDirectTranscript([{ role: "assistant", text: "explanation" }]),
    false,
  );
  assert.equal(validDirectKnowledge({ outcome: "gap" }), false);
  assert.equal(validDirectKnowledge({ outcome: "solved" }), false);
});

test("optional live card has no answer composer and keeps question delivery responsive after idle", () => {
  const html = readFileSync(
    new URL("../public/terminal-mcp-app.html", import.meta.url),
    "utf8",
  );
  assert.match(html, /\$\("form"\)\.hidden = live/);
  assert.match(html, /\$\("question"\)\.hidden = live/);
  assert.match(html, /\$\("messages"\)\.hidden = live/);
  assert.match(html, /return schedule\(liveLoop, 500\)/);
  assert.doesNotMatch(html, /idle \? 10000 : 2500/);
  assert.doesNotMatch(html, /Type in the game's terminal/);
});

test("native ordinary-chat callback reaches the real game client once, including learning after death", async (t) => {
  const { createStudyBridgeServer } =
    await import("../scripts/study-bridge-server.mjs");
  const { createHandoffRoutes } =
    await import("../scripts/chatgpt-handoff-routes.mjs");
  const { checkBridge, ensureProblem } = await import("../src/ai.ts");
  const { beginDirectStudy, retryDirectStudy, NATIVE_TRANSCRIPT_PROVENANCE } =
    await import("../src/direct-study.ts");
  const { probeFacets } = await import("../src/knowledge-probe.ts");
  const { studyChatCode } = await import("../src/bridge-client.ts");
  const { createPlayableGame } = await import("../src/world.ts");
  const roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
  for (const dies of [false, true])
    await t.test(
      dies ? "postdeath learning only" : "live once-only key",
      async () => {
        const original = globalThis.fetch;
        const queue = createHandoffQueue();
        const server = createStudyBridgeServer({
          handoff: createHandoffRoutes(queue, {
            token: "synthetic-native-client-token",
          }),
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        const app = createTerminalRelayApp({ queue });
        let g, e;
        try {
          globalThis.fetch = async () =>
            Response.json({
              mode: "development",
              label: "Synthetic",
              detail: "No model",
              capabilities: [],
            });
          await checkBridge();
          g = createPlayableGame(dies ? 718 : 717, roadmap);
          e = g.encounters[g.floors[0].stations[0].encounter];
          await ensureProblem(g, e, roadmap);
          e.mode = "solo";
          e.owner = "human";
          const beforeKeys = g.survivors[0].keys;
          const beforeLedger = JSON.stringify(g.study.learner);
          queue.enable(true);
          globalThis.fetch = (url, init) =>
            original(new URL(String(url), base), {
              ...init,
              headers: { ...init?.headers, Origin: "http://127.0.0.1:5173" },
            });
          await checkBridge();
          await beginDirectStudy(g, e, roadmap);
          let turn;
          for (let n = 0; n < 200; n++) {
            const value = app.call(
              "get_current_study_question",
              { chat: studyChatCode() },
              owner,
            ).structuredContent;
            if (value.status === "question") {
              turn = value;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          assert.ok(
            turn,
            "the actual game request reaches the normal native getter",
          );
          assert.equal(e.tutor.filter((m) => m.kind === "human").length, 0);
          assert.equal(e.submissions.length, 0);
          const packet = JSON.parse(
            turn.prompt.slice(DIRECT_TURN_INSTRUCTION.length),
          );
          assert.equal(packet.question.prompt, e.problem.prompt);
          assert.equal(packet.curriculum, undefined);
          assert.equal(packet.progressContext, undefined);
          assert.ok(
            turn.prompt.length < 60_000,
            "native packet excludes whole curriculum/history",
          );
          if (dies) {
            g.survivors[0].alive = false;
            g.status = "dead";
          }
          const learnerText =
            "SYNTHETIC native answer recorded as model-transcribed learner text.";
          let topicContext = packet.topicAssessmentContext;
          if (packet.omitted?.includes("topicAssessmentContext")) {
            const read = app.call(
              "read_study_terminal_context",
              {
                chat: studyChatCode(),
                relayId: turn.relayId,
                turnId: turn.turnId,
                part: "topicAssessmentContext",
              },
              owner,
            );
            topicContext = JSON.parse(JSON.parse(read.content[0].text).text);
          }
          const completion = answer(turn, {
            ...(topicContext
              ? {
                  topicAssessments: topicContext.topicIds.map((topicId) => ({
                    topicId,
                    text: "The synthetic answer demonstrates the question's tested reasoning; other topic skills remain uncertain.",
                  })),
                }
              : {}),
            transcript: [
              {
                role: "assistant",
                text: "Synthetic tutor explanation stays assistance.",
              },
              { role: "user", text: learnerText },
            ],
            knowledge: {
              facets: probeFacets(e.problem).map((f) => ({
                id: f.id,
                status: "demonstrated",
              })),
            },
          });
          app.call("finish_study_question", completion, owner);
          await retryDirectStudy(g, e, roadmap);
          assert.equal(e.directStudy.state, "applied", e.directStudy.error);
          assert.equal(e.submissions.length, 1);
          assert.equal(g.survivors[0].keys, beforeKeys + (dies ? 0 : 1));
          assert.equal(e.submissions[0].content, learnerText);
          assert.equal(
            e.tutor.find((m) => m.text === learnerText).provenance,
            NATIVE_TRANSCRIPT_PROVENANCE,
          );
          assert.equal(
            JSON.stringify(g.study.learner),
            beforeLedger,
            "gameplay callback never certifies mastery",
          );
          assert.equal(
            app.call("finish_study_question", completion, owner)
              .structuredContent.completion.duplicate,
            true,
          );
          await retryDirectStudy(g, e, roadmap);
          assert.equal(e.submissions.length, 1);
          assert.equal(g.survivors[0].keys, beforeKeys + (dies ? 0 : 1));
          assert.equal(
            typeof queue.snapshot().recent[0].resultReadAt,
            "number",
          );
        } finally {
          queue.enable(false);
          if (e?.directStudy) await retryDirectStudy(g, e, roadmap);
          globalThis.fetch = async () =>
            Response.json({
              mode: "development",
              label: "Cleanup",
              detail: "Synthetic cleanup",
              capabilities: [],
            });
          await checkBridge();
          globalThis.fetch = original;
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
        }
      },
    );
});

test("native final knowledge is required and rejected coverage stays correctable on the same claim", () => {
  const tool = terminalRelayTools().find(
    (t) => t.name === "finish_study_question",
  );
  assert.ok(tool.inputSchema.required.includes("knowledge"));
  assert.deepEqual(tool.inputSchema.properties.knowledge.required, ["facets"]);
  assert.equal(
    tool.inputSchema.properties.knowledge.properties.facets.minItems,
    1,
  );
  const { queue, call, enqueue } = setup();
  queue.enable(true);
  enqueue(
    payload("coverage", {
      probe: {
        facets: [
          { id: "stale-results", description: "Ignore stale responses" },
          { id: "request-id", description: "Track latest request identity" },
        ],
      },
    }),
  );
  const turn = call("get_current_study_question");
  const a = answer(turn);
  for (const knowledge of [
    undefined,
    { facets: [] },
    a.knowledge,
    { facets: [{ id: "foreign", status: "demonstrated" }] },
    {
      facets: [
        { id: "stale-results", status: "implied", impliedBy: "request-id" },
        { id: "request-id", status: "implied", impliedBy: "stale-results" },
      ],
    },
    {
      facets: [
        {
          id: "stale-results",
          status: "demonstrated",
          impliedBy: "request-id",
        },
        { id: "request-id", status: "demonstrated" },
      ],
    },
    {
      facets: [
        {
          id: "part",
          status: "gap",
          partOf: "request-id",
          description: "A direct part",
        },
        { id: "deep", status: "gap", partOf: "part", description: "Too deep" },
      ],
    },
  ]) {
    assert.throws(() => call("finish_study_question", { ...a, knowledge }));
    assert.equal(call("get_current_study_question").turnId, turn.turnId);
  }
  const complete = {
    facets: [
      { id: "stale-results", status: "demonstrated" },
      { id: "request-id", status: "implied", impliedBy: "stale-results" },
    ],
  };
  assert.equal(
    call("finish_study_question", { ...a, knowledge: complete }).completion
      .status,
    "sent",
  );
  const gap = setup();
  gap.queue.enable(true);
  gap.enqueue();
  const gapTurn = gap.call("get_current_study_question");
  assert.equal(
    gap.call(
      "finish_study_question",
      answer(gapTurn, {
        outcome: "gap",
        knowledge: {
          facets: [
            {
              id: "direct-part",
              status: "gap",
              partOf: "stale-results",
              description: "A missing direct prerequisite",
            },
          ],
        },
      }),
    ).completion.status,
    "sent",
  );
});

test("each terminal opening serves only the chat holding its code and disconnects older chats", () => {
  const { queue, call } = setup();
  queue.enable(true);
  const p = payload("native-chat-bound", { runId: "run-a", encounterId: "e1" });
  const scope = { runId: "run-a", encounterId: "e1" };
  const open = (code) => {
    const receipt = queue.enqueue("tutor", p, scope, code);
    queue.result(receipt.id, receipt.hash);
    return receipt;
  };
  const job = open("FIRSTCHAT");
  assert.equal(call("get_current_study_question").status, "chat_required");
  assert.equal(
    call("get_current_study_question", { chat: "OTHERCHAT" }).status,
    "disconnected",
  );
  const first = call("get_current_study_question", { chat: "FIRSTCHAT" });
  assert.equal(first.status, "question");
  // The player reopens the terminal: same exact request, new chat code.
  open("SECONDCHAT");
  assert.throws(
    () => call("finish_study_question", answer(first)),
    /disconnected/,
  );
  assert.equal(
    call("get_current_study_question", { chat: "FIRSTCHAT" }).status,
    "disconnected",
  );
  const second = call("get_current_study_question", { chat: "SECONDCHAT" });
  assert.equal(second.status, "question");
  assert.notEqual(second.turnId, first.turnId);
  // The old chat cannot disturb the new chat's claim.
  call("get_current_study_question", { chat: "FIRSTCHAT" });
  assert.deepEqual(
    call("get_current_study_question", { chat: "SECONDCHAT" }),
    second,
  );
  assert.throws(
    () => call("finish_study_question", answer(first)),
    /does not match|disconnected/,
  );
  assert.equal(
    call("finish_study_question", answer(second)).completion.status,
    "sent",
  );
  assert.equal(queue.result(job.id, job.hash).status, "done");
  assert.throws(
    () => queue.enqueue("tutor", payload("x"), undefined, "NOSCOPE1"),
    /chat code/,
  );
});

test("missing chat code explains stale tools without claiming or disturbing scoped work", () => {
  const { queue, call, tick } = setup();
  queue.enable(true);
  const p = payload("native-missing-chat", {
    runId: "run-a",
    encounterId: "e1",
  });
  const receipt = queue.enqueue(
    "tutor",
    p,
    { runId: "run-a", encounterId: "e1" },
    "CHATCODE1",
  );
  queue.result(receipt.id, receipt.hash);
  const missing = call("get_current_study_question");
  assert.equal(missing.status, "chat_required");
  assert.match(missing.note, /Refresh tools/);
  assert.match(missing.note, /not mean no question/);
  assert.doesNotMatch(JSON.stringify(missing), /CHATCODE1/);
  assert.equal(queue.snapshot().working, 0);
  const turn = call("get_current_study_question", { chat: "CHATCODE1" });
  assert.equal(turn.status, "question");
  for (const alias of ["chat_code", "chatCode"]) {
    assert.deepEqual(
      call("get_current_study_question", { [alias]: "CHATCODE1" }),
      turn,
    );
  }
  assert.equal(call("get_current_study_question").status, "chat_required");
  assert.deepEqual(
    call("get_current_study_question", { chat: "CHATCODE1" }),
    turn,
  );
  tick(HANDOFF_REQUESTER_LIVE_MS + 1);
  assert.equal(call("get_current_study_question").status, "disconnected");
});
