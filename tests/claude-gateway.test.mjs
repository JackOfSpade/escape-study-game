import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  buildPrompt,
  claudeArgs,
  claudeChildEnv,
  correctionPrompt,
  createClaudeGateway,
  firstJsonObject,
  textFieldReader,
  taskProfile,
  replySkeleton,
  trimmedKeys,
  replyShape,
} from "../scripts/claude-gateway.mjs";
import { validateAnswer } from "../scripts/lib/ai-contracts.mjs";

const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
writeFileSync(join(dir, "claude"), "#!/bin/sh\n", { mode: 0o755 });
const env = { PATH: dir, ANTHROPIC_API_KEY: "must-not-pass", KEEP: "1" };

function fakeSpawn(replies, calls = []) {
  return (binary, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {
      child.killed = true;
      child.emit("close", null);
    };
    const reply = replies.shift();
    const call = { binary, args, options, input: "" };
    calls.push(call);
    child.stdin.on("data", (d) => (call.input += d));
    if (reply !== "hang")
      setImmediate(() => {
        const model = args[args.indexOf("--model") + 1];
        child.stdout.write(
          `${JSON.stringify({ type: "system", subtype: "init", model: reply?.model ?? `claude-${model}-5-5` })}\n`,
        );
        child.stdout.write(
          `${JSON.stringify(reply?.result ?? { type: "result", subtype: "success", is_error: false, result: reply })}\n`,
        );
        child.stdout.end();
        child.emit("close", 0);
      });
    return child;
  };
}
const gateway = (replies, calls, extra = {}) =>
  createClaudeGateway({
    env,
    cwd: dir,
    spawn: fakeSpawn(replies, calls),
    validate: () => {},
    ...extra,
  });

test("stable material goes in the system prompt, varying fields in the message", () => {
  const a = buildPrompt("generate", {
    requestId: "one",
    curriculum: { big: true },
    probeRecords: ["a"],
  });
  const b = buildPrompt("generate", {
    requestId: "two",
    curriculum: { big: true },
    probeRecords: ["b"],
  });
  assert.equal(a.system, b.system, "identical system text can hit the cache");
  assert.ok(a.system.includes('"curriculum":{"big":true}'));
  assert.ok(!a.user.includes("curriculum"));
  assert.ok(a.user.includes("probeRecords"));
  // The earlier-question summary changes per request, so it must stay out of
  // the cached system text.
  const c = buildPrompt("generate", {
    requestId: "three",
    curriculum: { big: true },
    earlierQuestions: [{ title: "x", opening: "y", asks: [] }],
  });
  assert.equal(c.system, a.system);
  assert.ok(c.user.includes("earlierQuestions"));
});

test("tutor instructions request topic assessments only on completion, without ChatGPT wording", () => {
  const { system } = buildPrompt("tutor", {
    mode: "terminal-dialogue",
    topicAssessmentContext: { topicIds: ["PY:T01"] },
  });
  assert.ok(
    system.includes(
      "In the reply that sets complete:true, include topicAssessments:[{topicId,text}]",
    ),
  );
  assert.ok(
    system.includes("replies with complete:false omit topicAssessments"),
  );
  assert.ok(!system.includes("finish_study_question"));
  assert.ok(!/chatgpt/i.test(system));
});

test("only the observations of topicAssessmentContext stay in the tutor message", () => {
  const prompt = buildPrompt("tutor", {
    mode: "terminal-dialogue",
    topicAssessmentContext: {
      topicIds: ["PY:T01"],
      marker: "fixed-marker",
      observations: { established: ["changing-marker"] },
    },
  });
  assert.ok(prompt.system.includes("fixed-marker"));
  assert.ok(!prompt.user.includes("fixed-marker"));
  assert.ok(!prompt.system.includes("changing-marker"));
  assert.deepEqual(JSON.parse(prompt.user).topicAssessmentContext, {
    observations: { established: ["changing-marker"] },
  });
});

test("a tutor request's changing parts never alter its system prompt", () => {
  const turn = (requestId, notes, facets, observed) =>
    buildPrompt("tutor", {
      requestId,
      mode: "terminal-dialogue",
      instruction: "Synthetic instruction",
      probe: { stance: "Synthetic stance", facets },
      topicAssessmentContext: {
        topicIds: ["PY:T01"],
        observations: { established: observed },
      },
      problem: { title: "Synthetic question" },
      messages: [requestId],
      curriculum: "Synthetic curriculum",
      progressContext: `Synthetic roadmap progress${notes}`,
    });
  const first = turn("one", "", [{ id: "a" }], []);
  for (const later of [
    turn(
      "two",
      "\n\nFacets already established at earlier terminals (answered): a",
      [{ id: "a" }, { id: "a-part" }],
      ["a"],
    ),
    turn(
      "three",
      "\n\nLearner-declared knowledge gaps recorded at earlier terminals: b",
      [{ id: "a" }],
      [],
    ),
    turn("four", "\n\nGaps since closed: c", [{ id: "a" }], []),
  ])
    assert.equal(later.system, first.system);
  for (const text of [
    "Synthetic curriculum",
    "Synthetic roadmap progress",
    "Synthetic stance",
    "Synthetic question",
  ]) {
    assert.ok(first.system.includes(text), `${text} is cached`);
    assert.ok(!first.user.includes(text), `${text} is not sent twice`);
  }
  const second = JSON.parse(
    turn(
      "two",
      "\n\nFacets already established at earlier terminals (answered): a",
      [{ id: "a" }, { id: "a-part" }],
      ["a"],
    ).user,
  );
  assert.equal(
    second.progressContext,
    "\n\nFacets already established at earlier terminals (answered): a",
  );
  assert.deepEqual(second.probe, { facets: [{ id: "a" }, { id: "a-part" }] });
  // Notes with no roadmap progress before them still leave the system text alone.
  const bare = (progressContext) =>
    buildPrompt("tutor", { requestId: "x", progressContext });
  assert.equal(
    bare("Gaps since closed: c").system,
    bare("Learner-declared knowledge gaps recorded at earlier terminals: d")
      .system,
  );
});

test("a tutor request too large for one argument falls back to the small system prompt", () => {
  const payload = {
    requestId: "one",
    instruction: "Synthetic instruction",
    probe: { stance: "Synthetic stance", facets: [] },
    curriculum: "c".repeat(5000),
    progressContext: "Synthetic roadmap progress",
  };
  assert.equal(buildPrompt("tutor", payload).compact, undefined);
  const small = buildPrompt("tutor", payload, { maxSystemBytes: 4000 });
  assert.equal(small.compact, true);
  assert.ok(small.system.includes("Synthetic instruction"));
  assert.ok(!small.system.includes("ccccc"));
  const sent = JSON.parse(small.user);
  assert.equal(sent.curriculum, payload.curriculum);
  assert.equal(sent.progressContext, payload.progressContext);
  assert.deepEqual(sent.probe, payload.probe);
});

test("a correction turn reuses the first attempt's system prompt and message", async () => {
  const calls = [];
  let checked = 0;
  await gateway(['{"text":"bad"}', '{"text":"good","complete":false}'], calls, {
    validate: () => {
      if (!checked++) throw Error("Synthetic rejection");
    },
  }).run("tutor", {
    requestId: "one",
    mode: "terminal-dialogue",
    curriculum: "Synthetic curriculum",
  });
  assert.equal(calls.length, 2);
  const system = (call) => call.args[call.args.indexOf("--system-prompt") + 1];
  const sent = (call) => JSON.parse(call.input).message.content[0].text;
  assert.equal(system(calls[1]), system(calls[0]));
  assert.ok(system(calls[0]).includes("Synthetic curriculum"));
  assert.ok(sent(calls[1]).startsWith(sent(calls[0])));
  assert.ok(sent(calls[1]).includes("Synthetic rejection"));
});

test("discussion after completion returns text and, at most, facet findings", () => {
  const job = { operation: "tutor", payload: { mode: "terminal-review" } };
  assert.doesNotThrow(() => validateAnswer(job, { text: "Still final." }));
  assert.doesNotThrow(() =>
    validateAnswer(job, {
      text: "Closed.",
      knowledge: { facets: [{ id: "f1", status: "demonstrated" }] },
    }),
  );
  assert.throws(
    () => validateAnswer(job, { text: "Closed.", knowledge: { facets: "f1" } }),
    /Terminal review/,
  );
  assert.match(
    buildPrompt("tutor", { requestId: "x", mode: "terminal-review" }).system,
    /For mode terminal-review the question is already complete/,
  );
});

test("terminal dialogue validation enforces topicAssessments on completion", () => {
  const job = {
    operation: "tutor",
    payload: {
      mode: "terminal-dialogue",
      topicAssessmentContext: { topicIds: ["PY:T01", "PE:T02"] },
    },
  };
  const base = { text: "Done.", complete: true, outcome: "solved" };
  const good = [
    { topicId: "PY:T01", text: "Solid." },
    { topicId: "PE:T02", text: "Tentative." },
  ];
  assert.doesNotThrow(() =>
    validateAnswer(job, { ...base, topicAssessments: good }),
  );
  assert.throws(() => validateAnswer(job, base), /topicAssessments/);
  assert.throws(() =>
    validateAnswer(job, {
      ...base,
      topicAssessments: [good[0], { topicId: "PY:T09", text: "Unknown." }],
    }),
  );
  assert.throws(() =>
    validateAnswer(job, { ...base, topicAssessments: [good[0]] }),
  );
  assert.doesNotThrow(() =>
    validateAnswer(job, { text: "Next question?", complete: false }),
  );
  assert.throws(() =>
    validateAnswer(job, {
      text: "Next question?",
      complete: false,
      topicAssessments: [{ topicId: "PY:T09", text: "Unknown." }],
    }),
  );
});

test("each task runs its chosen model and effort, latest aliases only", () => {
  assert.deepEqual(
    Object.fromEntries(
      [
        "tutor",
        "assess",
        "generate",
        "review-environment",
        "reconcile-roadmap",
        "lesson",
        "lesson-chat",
      ].map((op) => {
        const p = taskProfile(op, {});
        return [op, `${p.model}/${p.effort}`];
      }),
    ),
    {
      tutor: "sonnet/low",
      assess: "haiku/high",
      generate: "opus/medium",
      "review-environment": "haiku/medium",
      "reconcile-roadmap": "opus/high",
      lesson: "opus/high",
      "lesson-chat": "haiku/high",
    },
  );
  assert.deepEqual(taskProfile("lesson").stableKeys, [
    "curriculum",
    "lessonPolicy",
  ]);
  assert.equal(taskProfile("lesson").timeoutMs, 30 * 60_000);
  assert.deepEqual(taskProfile("lesson-chat").stableKeys, [
    "instruction",
    "responseFormat",
    "lesson",
    "gap",
    "sectionIds",
  ]);
  assert.equal(taskProfile("lesson-chat").timeoutMs, 120_000);
  assert.throws(() => taskProfile("complete"), /Unknown AI task/);
});

test("calls are locked down and cannot bill an API key", () => {
  const args = claudeArgs({ model: "sonnet", effort: "medium", system: "s" });
  for (const flag of [
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
  ])
    assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args[args.indexOf("--setting-sources") + 1], "");
  const child = claudeChildEnv(env, join(dir, "claude"));
  assert.equal(child.ANTHROPIC_API_KEY, undefined);
  assert.equal(child.KEEP, "1");
});

test("a reply with stray text still yields its JSON object", () => {
  assert.deepEqual(firstJsonObject('Sure! {"a":{"b":"}"}} done'), {
    a: { b: "}" },
  });
  assert.equal(firstJsonObject("no object"), undefined);
  assert.deepEqual(firstJsonObject('Set {x} then {"a":1} ok'), { a: 1 });
});

test("a malformed answer is never mistaken for one of its own fields", async () => {
  const broken =
    '{"help":{"nudges":["f"],"hints":[],"gives":[],"offers":[]},"text":"no \\"Done\\" button"),"complete":false,"knowledge":{"facets":[{"id":"f","status":"gap"}],"signal":{"fluency":"partial"}}}';
  assert.equal(firstJsonObject(broken), undefined);
  const calls = [];
  const g = gateway(
    [
      broken,
      '{"help":{"nudges":[],"hints":[],"gives":[],"offers":[]},"text":"ok","complete":false}',
    ],
    calls,
    { validate: validateAnswer },
  );
  const answer = await g.run("tutor", {
    mode: "terminal-dialogue",
    helpPolicy: { unlocked: [] },
  });
  assert.equal(answer.complete, false);
  assert.match(calls[1].input, /not one valid JSON object/);
});

test("a field name written with stray spaces is still that field", async () => {
  assert.deepEqual(
    trimmedKeys({ " complete": false, a: [{ "id ": "x" }], b: 1, " b": 2 }),
    { complete: false, a: [{ id: "x" }], b: 1 },
  );
  const calls = [];
  const g = gateway(
    [
      '{"help":{"nudges":[],"hints":[],"gives":[],"offers":[]},"text":"Try again."," complete":false}',
    ],
    calls,
    { validate: validateAnswer },
  );
  const answer = await g.run("tutor", {
    mode: "terminal-dialogue",
    helpPolicy: { unlocked: [] },
  });
  assert.equal(answer.complete, false);
  assert.equal(calls.length, 1);
});

test("a tutor follow-up that omits complete continues the conversation", async () => {
  const help = '"help":{"nudges":["f"],"hints":[],"gives":[],"offers":[]}';
  const payload = { mode: "terminal-dialogue", helpPolicy: { unlocked: [] } };
  const calls = [];
  const g = gateway([`{${help},"text":"Look again at part 2."}`], calls, {
    validate: validateAnswer,
  });
  assert.equal((await g.run("tutor", payload)).complete, false);
  assert.equal(calls.length, 1);
  // A verdict without complete is still rejected: nothing is assumed solved.
  const claimed = `{${help},"text":"Done.","outcome":"solved"}`;
  await assert.rejects(
    gateway([claimed, claimed], [], { validate: validateAnswer }).run(
      "tutor",
      payload,
    ),
    { code: "CLAUDE_INVALID_ANSWER" },
  );
});

test("a rejected reply's logged skeleton keeps structure and drops long text", () => {
  assert.equal(
    replySkeleton(
      '{"text":"a learner sentence that is longer than the limit"),"complete":false}',
    ),
    '{"text":"<48>"),"complete":false}',
  );
});

test("a rejected answer gets one correction, then fails plainly", async () => {
  const calls = [];
  let seen = 0;
  const g = gateway(['{"bad":1}', '{"ok":1}'], calls, {
    validate: (_job, answer) => {
      seen++;
      if (answer.bad) throw Error("wrong shape");
    },
  });
  assert.deepEqual(await g.run("review-environment", {}), { ok: 1 });
  assert.equal(seen, 2);
  assert.ok(calls[1].input.includes("wrong shape"));
  const failing = gateway(['{"bad":1}', '{"bad":2}'], [], {
    validate: () => {
      throw Error("still wrong");
    },
  });
  await assert.rejects(failing.run("review-environment", {}), {
    code: "CLAUDE_INVALID_ANSWER",
  });
});

test("a repeated request id joins the same call and never pays twice", async () => {
  const calls = [];
  const g = gateway(['{"ok":1}'], calls);
  const payload = { requestId: "same" };
  const [a, b] = await Promise.all([
    g.run("review-environment", payload),
    g.run("review-environment", payload),
  ]);
  assert.deepEqual(a, b);
  assert.deepEqual(await g.run("review-environment", payload), a);
  assert.equal(calls.length, 1);
});

test("failures say what to do: usage limit, sign-in, wrong model", async () => {
  const fail = (result) => ({
    result: { type: "result", subtype: "error", is_error: true, result },
  });
  await assert.rejects(
    gateway([fail("You hit your limit")], []).run("review-environment", {}),
    {
      code: "CLAUDE_USAGE_LIMIT",
    },
  );
  await assert.rejects(
    gateway([fail("Not logged in")], []).run("review-environment", {}),
    {
      code: "CLAUDE_NOT_SIGNED_IN",
    },
  );
  await assert.rejects(
    gateway(
      [
        {
          model: "claude-sonnet-5-5",
          result: { type: "result", subtype: "success", result: "{}" },
        },
      ],
      [],
    ).run("review-environment", {}),
    { code: "CLAUDE_WRONG_MODEL" },
  );
});

test("cancelling stops the running process", async () => {
  const cancel = new AbortController();
  const g = gateway(["hang"], []);
  const running = g.run("review-environment", {}, { signal: cancel.signal });
  setImmediate(() => cancel.abort());
  await assert.rejects(running, { code: "CLAUDE_CANCELLED" });
});

test("a request cancelled while queued never starts a process", async () => {
  const calls = [];
  const cancel = new AbortController();
  let first;
  const base = fakeSpawn(["hang"], calls);
  const g = createClaudeGateway({
    env,
    cwd: dir,
    maxRunning: 1,
    validate: () => {},
    spawn: (...args) => (first = base(...args)),
  });
  const blocker = g.run("review-environment", {}).catch(() => {});
  const queued = g.run("review-environment", {}, { signal: cancel.signal });
  await new Promise((r) => setImmediate(r));
  cancel.abort();
  first.kill();
  await blocker;
  await assert.rejects(queued, { code: "CLAUDE_CANCELLED" });
  assert.equal(calls.length, 1);
});

test("a joined call survives one caller leaving and stops when all have", async () => {
  const calls = [];
  let child;
  const base = fakeSpawn(["hang"], calls);
  const g = createClaudeGateway({
    env,
    cwd: dir,
    validate: () => {},
    spawn: (...args) => (child = base(...args)),
  });
  const a = new AbortController();
  const b = new AbortController();
  const payload = { requestId: "shared" };
  const first = g.run("review-environment", payload, { signal: a.signal });
  const second = g.run("review-environment", payload, { signal: b.signal });
  await new Promise((r) => setImmediate(r));
  a.abort();
  await new Promise((r) => setImmediate(r));
  assert.ok(!child.killed, "the other caller is still waiting");
  b.abort();
  await assert.rejects(first, { code: "CLAUDE_CANCELLED" });
  await assert.rejects(second, { code: "CLAUDE_CANCELLED" });
  assert.equal(calls.length, 1);
});

test("a retry of a request whose every caller left starts afresh instead of inheriting the cancellation", async () => {
  // The stopped process takes a moment to exit, as a real one does.
  const children = [];
  const spawn = (binary, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {
      if (child.killed) return;
      child.killed = true;
      setTimeout(() => child.emit("close", null), 20);
    };
    if (children.push(child) > 1)
      setImmediate(() => {
        const model = args[args.indexOf("--model") + 1];
        child.stdout.write(
          `${JSON.stringify({ type: "system", subtype: "init", model: `claude-${model}-5-5` })}\n`,
        );
        child.stdout.write(
          `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: '{"ok":2}' })}\n`,
        );
        child.stdout.end();
        child.emit("close", 0);
      });
    return child;
  };
  const g = createClaudeGateway({ env, cwd: dir, validate: () => {}, spawn });
  const payload = { requestId: "reloaded" };
  const left = new AbortController();
  const first = g.run("review-environment", payload, { signal: left.signal });
  await new Promise((r) => setImmediate(r));
  left.abort();
  // The page reloads and asks again before the first process has exited.
  const retry = g.run("review-environment", payload);
  await assert.rejects(first, { code: "CLAUDE_CANCELLED" });
  assert.deepEqual(await retry, { ok: 2 });
  assert.equal(children.length, 2);
  // The stopped call's cleanup left the finished answer reachable by its id.
  assert.deepEqual(await g.run("review-environment", payload), { ok: 2 });
  assert.equal(children.length, 2);
});

test("the reply's text can be read as it is written", () => {
  const read = textFieldReader();
  assert.equal(read('{"te'), "");
  assert.equal(read('xt":"Why'), "Why");
  assert.equal(read(' \\"so\\"\\n\\u00'), 'Why "so"\n');
  assert.equal(read('e9?","complete":false,"text":"no"}'), 'Why "so"\n\u00e9?');
  const nested = textFieldReader();
  assert.equal(
    nested('{"knowledge":{"text":"hidden"},"note":"text","text":"shown"}'),
    "shown",
  );
  const valueNamedText = textFieldReader();
  assert.equal(valueNamedText('{"a":"text","b":"nope"}'), "");
});

test("streamed text arrives before the answer, and a correction clears it", async () => {
  const seen = [];
  const deltas = ['{"text":"Hel', 'lo","complete":false}'];
  const spawn = (binary, args) => {
    assert.ok(args.includes("--include-partial-messages"));
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.write(
        `${JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet-5-5" })}\n`,
      );
      for (const text of deltas)
        child.stdout.write(
          `${JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text } } })}\n`,
        );
      child.stdout.write(
        `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: deltas.join("") })}\n`,
      );
      child.stdout.end();
      child.emit("close", 0);
    });
    return child;
  };
  let rejected = false;
  const g = createClaudeGateway({
    env,
    cwd: dir,
    spawn,
    validate: () => {
      if (!rejected) {
        rejected = true;
        throw Error("again");
      }
    },
  });
  const answer = await g.run("tutor", {}, { onText: (t) => seen.push(t) });
  assert.equal(answer.text, "Hello");
  assert.deepEqual(seen, ["Hel", "Hello", "", "Hel", "Hello"]);
});

test("a lesson-chat reply streams its text, an invalid section is corrected, and a lesson never streams", async () => {
  const payload = {
    requestId: "chat-1",
    sectionIds: ["idea", "worked"],
    lesson: "## idea: The idea",
  };
  const replies = [
    ['{"text":"Look he', 're","section":"nowhere"}'],
    ['{"text":"Look he', 're","section":"worked"}'],
  ];
  const spawn = (binary, args) => {
    assert.ok(args.includes("--include-partial-messages"));
    const deltas = replies.shift();
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    setImmediate(() => {
      const model = args[args.indexOf("--model") + 1];
      child.stdout.write(
        `${JSON.stringify({ type: "system", subtype: "init", model: `claude-${model}-5-5` })}\n`,
      );
      for (const text of deltas)
        child.stdout.write(
          `${JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text } } })}\n`,
        );
      child.stdout.write(
        `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: deltas.join("") })}\n`,
      );
      child.stdout.end();
      child.emit("close", 0);
    });
    return child;
  };
  const g = createClaudeGateway({
    env,
    cwd: dir,
    spawn,
    validate: validateAnswer,
  });
  const seen = [];
  const answer = await g.run("lesson-chat", payload, {
    onText: (t) => seen.push(t),
  });
  assert.deepEqual(answer, { text: "Look here", section: "worked" });
  // Text streams as written, with no gate; the rejected reply's text is
  // cleared and the correction streams afresh.
  assert.deepEqual(seen, ["Look he", "Look here", "", "Look he", "Look here"]);
  // A lesson's top-level object has no text field, so nothing streams.
  const lessonSeen = [];
  const lessonReply = [
    '{"requestId":"l-1","gapId":"g","lesson":{"sections":[{"blocks":[{"text":"deep"}]}]}}',
  ];
  replies.push(lessonReply, lessonReply);
  await g
    .run(
      "lesson",
      { requestId: "l-1", gapId: "g" },
      { onText: (t) => lessonSeen.push(t) },
    )
    .catch(() => {});
  assert.deepEqual(lessonSeen.filter(Boolean), []);
});

const usageRows = () => {
  const rows = [];
  return { rows, log: (row) => rows.push(row) };
};
const resultEvent = (extra = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: '{"ok":1}',
  total_cost_usd: 0.0123,
  usage: {
    input_tokens: 120,
    output_tokens: 45,
    cache_read_input_tokens: 90,
    cache_creation_input_tokens: 30,
  },
  duration_ms: 1200,
  duration_api_ms: 900,
  num_turns: 2,
  ...extra,
});
const fullReply = (extra = {}) => ({
  model: "claude-haiku-5-5",
  result: resultEvent(extra),
});

test("a successful call logs exactly one measured row", async () => {
  const { rows, log } = usageRows();
  const g = gateway([fullReply()], [], { usageLog: log });
  assert.deepEqual(await g.run("review-environment", {}), { ok: 1 });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.v, 1);
  assert.equal(row.at, new Date(row.at).toISOString());
  assert.equal(row.operation, "review-environment");
  assert.equal(row.attempt, 0);
  assert.equal(row.alias, "haiku");
  assert.equal(row.effort, "medium");
  assert.equal(row.model, "claude-haiku-5-5");
  assert.equal(row.costUsd, 0.0123);
  assert.equal(row.inputTokens, 120);
  assert.equal(row.outputTokens, 45);
  assert.equal(row.cacheReadTokens, 90);
  assert.equal(row.cacheWriteTokens, 30);
  assert.equal(row.numTurns, 2);
  assert.equal(row.apiDurationMs, 900);
  assert.equal(row.firstTextMs, null);
  assert.equal(row.outcome, "accepted");
  assert.ok(Number.isInteger(row.durationMs) && row.durationMs >= 0);
});

test("a rejected reply then a valid correction logs both attempts", async () => {
  const { rows, log } = usageRows();
  const g = gateway(['{"bad":1}', '{"ok":1}'], [], {
    usageLog: log,
    validate: (_job, answer) => {
      if (answer.bad) throw Error("wrong shape");
    },
  });
  assert.deepEqual(await g.run("review-environment", {}), { ok: 1 });
  assert.deepEqual(
    rows.map((row) => [row.attempt, row.outcome]),
    [
      [0, "rejected"],
      [1, "accepted"],
    ],
  );
});

test("a failed call logs its failure outcome and null measurements", async () => {
  const { rows, log } = usageRows();
  const g = gateway(
    [
      {
        result: {
          type: "result",
          subtype: "error",
          is_error: true,
          result: "You hit your limit",
        },
      },
    ],
    [],
    { usageLog: log },
  );
  await assert.rejects(g.run("review-environment", {}), {
    code: "CLAUDE_USAGE_LIMIT",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "usage-limit");
  assert.equal(rows[0].costUsd, null);
  assert.equal(rows[0].inputTokens, null);
  assert.equal(rows[0].apiDurationMs, null);
});

test("usage rows carry no prompt, reply or request id content", async () => {
  const { rows, log } = usageRows();
  const marker = "SECRET-PROMPT-MARKER-42";
  const g = gateway(
    [
      {
        model: "claude-haiku-5-5",
        result: resultEvent({
          result: `{"text":"REPLY-${marker}"}`,
          stderr: `STDERR-${marker}`,
        }),
      },
    ],
    [],
    { usageLog: log },
  );
  const requestId = "REQ-SECRET-7";
  assert.deepEqual(
    await g.run("review-environment", { requestId, note: marker }),
    {
      text: `REPLY-${marker}`,
    },
  );
  assert.equal(rows.length, 1);
  const line = JSON.stringify(rows[0]);
  for (const secret of [marker, requestId]) assert.ok(!line.includes(secret));
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    "alias",
    "apiDurationMs",
    "at",
    "attempt",
    "cacheReadTokens",
    "cacheWriteTokens",
    "costUsd",
    "durationMs",
    "effort",
    "firstTextMs",
    "inputTokens",
    "model",
    "numTurns",
    "operation",
    "outcome",
    "outputTokens",
    "v",
  ]);
});

test("a throwing usage sink never fails the call", async () => {
  const warn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    const g = gateway([fullReply()], [], {
      usageLog: () => {
        throw Error("disk full");
      },
    });
    assert.deepEqual(await g.run("review-environment", {}), { ok: 1 });
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /usage log failed/);
});

test("the path sink appends private JSONL and rotates above the limit", async () => {
  const logs = mkdtempSync(join(tmpdir(), "claude-usage-"));
  const file = join(logs, "claude-usage.jsonl");
  const g = gateway([fullReply(), fullReply(), fullReply()], [], {
    usageLog: file,
    usageLogMaxBytes: 1,
  });
  await g.run("review-environment", {});
  const firstLines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(firstLines.length, 1);
  assert.equal(JSON.parse(firstLines[0]).operation, "review-environment");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  await g.run("review-environment", {});
  assert.equal(readFileSync(`${file}.1`, "utf8").trim().split("\n").length, 1);
  assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 1);
  await g.run("review-environment", {});
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readFileSync(`${file}.1`, "utf8").trim().split("\n").length, 1);
  assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 1);
});

test("a streamed call records the time to its first text", async () => {
  const { rows, log } = usageRows();
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.write(
        `${JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet-5-5" })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: '{"text":"Hi"' } } })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify(resultEvent({ result: '{"text":"Hi"}' }))}\n`,
      );
      child.stdout.end();
      child.emit("close", 0);
    });
    return child;
  };
  const g = createClaudeGateway({
    env,
    cwd: dir,
    spawn,
    validate: () => {},
    usageLog: log,
  });
  assert.deepEqual(await g.run("tutor", {}, { onText: () => {} }), {
    text: "Hi",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "accepted");
  assert.ok(
    Number.isInteger(rows[0].firstTextMs) && rows[0].firstTextMs >= 0,
    String(rows[0].firstTextMs),
  );
});

const sampleNames = (store, operation = "review-environment") =>
  readdirSync(join(store, operation)).sort();
const readSample = (store, operation = "review-environment") => {
  const names = sampleNames(store, operation);
  return JSON.parse(
    readFileSync(join(store, operation, names[names.length - 1]), "utf8"),
  );
};

test("a profile override changes the model and effort the CLI runs with", async () => {
  const calls = [];
  const { rows, log } = usageRows();
  const g = gateway(
    [{ model: "claude-opus-5-5", result: resultEvent() }],
    calls,
    {
      usageLog: log,
      profileFor: (operation, payload) => ({
        ...taskProfile(operation, payload),
        model: "opus",
        effort: "xhigh",
      }),
    },
  );
  assert.deepEqual(await g.run("review-environment", {}), { ok: 1 });
  assert.equal(calls[0].args[calls[0].args.indexOf("--model") + 1], "opus");
  assert.equal(calls[0].args[calls[0].args.indexOf("--effort") + 1], "xhigh");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].alias, "opus");
  assert.equal(rows[0].effort, "xhigh");
  assert.equal(rows[0].model, "claude-opus-5-5");
});

test("replay samples capture one private JSON per finished call", async () => {
  const store = mkdtempSync(join(tmpdir(), "claude-replay-"));
  const g = gateway([fullReply()], [], { replaySamples: store });
  const payload = { requestId: "req-1", note: "value" };
  assert.deepEqual(await g.run("review-environment", payload), { ok: 1 });
  const names = sampleNames(store);
  assert.equal(names.length, 1);
  assert.match(
    names[0],
    /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[a-f0-9]{8}\.json$/,
  );
  const file = join(store, "review-environment", names[0]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const sample = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(sample.v, 1);
  assert.equal(sample.at, new Date(sample.at).toISOString());
  assert.equal(sample.operation, "review-environment");
  assert.deepEqual(sample.payload, payload);
  assert.deepEqual(sample.answer, { ok: 1 });
  assert.equal(sample.outcome, "accepted");
  assert.equal(sample.alias, "haiku");
  assert.equal(sample.effort, "medium");
  assert.equal(sample.model, "claude-haiku-5-5");
  assert.equal(sample.costUsd, 0.0123);
  assert.equal(typeof sample.durationMs, "number");
  assert.equal(sample.attempts, 1);
});

test("replay capture records a rejected answer as invalid", async () => {
  const store = mkdtempSync(join(tmpdir(), "claude-replay-"));
  const g = gateway(
    [
      {
        model: "claude-haiku-5-5",
        result: resultEvent({ result: '{"bad":1}' }),
      },
      {
        model: "claude-haiku-5-5",
        result: resultEvent({ result: '{"bad":2}' }),
      },
    ],
    [],
    {
      replaySamples: store,
      validate: () => {
        throw Error("still wrong");
      },
    },
  );
  await assert.rejects(g.run("review-environment", {}), {
    code: "CLAUDE_INVALID_ANSWER",
  });
  const sample = readSample(store);
  assert.equal(sample.outcome, "invalid");
  assert.equal(sample.answer, null);
  assert.equal(sample.attempts, 2);
  assert.equal(sample.costUsd, 0.0123 + 0.0123);
});

test("a broken replay store never fails a call", async () => {
  const blocker = join(dir, "not-a-directory");
  writeFileSync(blocker, "");
  const warn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    const g = gateway([fullReply()], [], {
      replaySamples: join(blocker, "samples"),
    });
    assert.deepEqual(await g.run("review-environment", {}), { ok: 1 });
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /replay sample failed/i);
});

test("a correction shows the model its own rejected reply, bounded", async () => {
  const calls = [];
  const g = gateway(['{"bad":1,"note":"REJECTED-MARKER"}', '{"ok":1}'], calls, {
    validate: (_job, answer) => {
      if (answer.bad) throw Error("wrong shape");
    },
  });
  assert.deepEqual(await g.run("review-environment", {}), { ok: 1 });
  assert.ok(!calls[0].input.includes("REJECTED-MARKER"));
  assert.ok(calls[1].input.includes("REJECTED-MARKER"));
  assert.ok(calls[1].input.includes("wrong shape"));
  assert.ok(calls[1].input.includes("Your own previous answer"));
  const out = correctionPrompt("U", "why", "y".repeat(50), 10);
  assert.ok(out.startsWith("U\n\nYour previous answer was rejected: why\n"));
  assert.ok(out.includes("y".repeat(10)) && !out.includes("y".repeat(11)));
  assert.match(out, /40 more characters not shown/);
  assert.ok(out.endsWith("Return the complete corrected JSON object."));
  assert.doesNotMatch(correctionPrompt("U", "why", ""), /Your own previous/);
});

test("a fresh request id is never answered from an earlier answer", async () => {
  const calls = [];
  const g = gateway(['{"n":1}', '{"n":2}'], calls);
  assert.deepEqual(await g.run("review-environment", { requestId: "one" }), { n: 1 }); // prettier-ignore
  assert.deepEqual(await g.run("review-environment", { requestId: "two" }), { n: 2 }); // prettier-ignore
  assert.equal(calls.length, 2);
});

test("an accepted reply's shape is logged as counts, never text", () => {
  const generate = { operation: "generate", payload: {} };
  assert.deepEqual(
    replyShape(generate, { prompt: "abc", parts: ["de", "f"] }),
    { parts: 2, questionChars: 6 },
  );
  assert.deepEqual(replyShape(generate, { prompt: "abc" }), {
    parts: null,
    questionChars: 3,
  });
  const tutor = { operation: "tutor", payload: { stage: { part: 1, of: 3 } } };
  assert.deepEqual(replyShape(tutor, { partComplete: true }), {
    part: 1,
    ofParts: 3,
    partComplete: true,
  });
  assert.deepEqual(replyShape({ operation: "tutor", payload: {} }, {}), {});
  assert.deepEqual(replyShape({ operation: "assess", payload: {} }, {}), {});
});

test("a tutor reply logs its mode, turn, outcome and help as counts", () => {
  const dialogue = {
    operation: "tutor",
    payload: {
      mode: "terminal-dialogue",
      messages: [{ text: "secret one" }, { text: "secret two" }],
      stage: { part: 3, of: 3 },
    },
  };
  const shape = replyShape(dialogue, {
    text: "secret reply",
    complete: true,
    outcome: "solved",
    help: { nudges: ["a"], hints: [], gives: ["b", "c"], offers: [] },
    knowledge: {
      facets: [
        { id: "a", status: "demonstrated", note: "secret note" },
        { id: "b", status: "gap" },
      ],
    },
  });
  assert.deepEqual(shape, {
    mode: "terminal-dialogue",
    turn: 2,
    complete: true,
    verdict: "solved",
    help: { nudges: 1, hints: 0, gives: 2, offers: 0 },
    facets: { demonstrated: 1, implied: 0, gap: 1 },
    part: 3,
    ofParts: 3,
    partComplete: false,
  });
  assert.doesNotMatch(JSON.stringify(shape), /secret|"a"|"b"/);
  const review = {
    operation: "tutor",
    payload: {
      mode: "terminal-review",
      messages: [{}],
      review: { openGaps: [] },
    },
  };
  assert.deepEqual(replyShape(review, { text: "secret" }), {
    mode: "terminal-review",
    turn: 1,
    openGaps: 0,
  });
  assert.deepEqual(
    replyShape({ operation: "tutor", payload: { mode: "other" } }, {}),
    {},
  );
});
