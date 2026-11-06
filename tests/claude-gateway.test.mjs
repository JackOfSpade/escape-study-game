import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  buildPrompt,
  claudeArgs,
  claudeChildEnv,
  createClaudeGateway,
  firstJsonObject,
  textFieldReader,
  taskProfile,
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

test("topicAssessmentContext stays in the tutor message, not the cached system text", () => {
  const prompt = buildPrompt("tutor", {
    mode: "terminal-dialogue",
    topicAssessmentContext: { topicIds: ["PY:T01"], marker: "volatile-marker" },
  });
  assert.ok(!prompt.system.includes("volatile-marker"));
  assert.ok(prompt.user.includes("volatile-marker"));
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
        "complete",
        "assess",
        "generate",
        "npc-chatter",
        "design-run",
      ].map((op) => {
        const p = taskProfile(op, {});
        return [op, `${p.model}/${p.effort}`];
      }),
    ),
    {
      tutor: "sonnet/medium",
      complete: "sonnet/medium",
      assess: "sonnet/medium",
      generate: "opus/xhigh",
      "npc-chatter": "haiku/high",
      "design-run": "opus/medium",
    },
  );
  assert.equal(
    taskProfile("design-run", { phase: "content-batch" }).effort,
    "high",
  );
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
  assert.deepEqual(await g.run("complete", {}), { ok: 1 });
  assert.equal(seen, 2);
  assert.ok(calls[1].input.includes("wrong shape"));
  const failing = gateway(['{"bad":1}', '{"bad":2}'], [], {
    validate: () => {
      throw Error("still wrong");
    },
  });
  await assert.rejects(failing.run("complete", {}), {
    code: "CLAUDE_INVALID_ANSWER",
  });
});

test("a repeated request id joins the same call and never pays twice", async () => {
  const calls = [];
  const g = gateway(['{"ok":1}'], calls);
  const payload = { requestId: "same" };
  const [a, b] = await Promise.all([
    g.run("complete", payload),
    g.run("complete", payload),
  ]);
  assert.deepEqual(a, b);
  assert.deepEqual(await g.run("complete", payload), a);
  assert.equal(calls.length, 1);
});

test("run design stages share one conversation", async () => {
  const calls = [];
  const g = gateway(['{"ok":1}', '{"ok":2}'], calls);
  await g.run("design-run", { requestId: "a", generationId: "design-g" });
  await g.run("design-run", { requestId: "b", generationId: "design-g" });
  assert.ok(calls[0].args.includes("--session-id"));
  assert.ok(calls[1].args.includes("--resume"));
  assert.equal(
    calls[0].args[calls[0].args.indexOf("--session-id") + 1],
    calls[1].args[calls[1].args.indexOf("--resume") + 1],
  );
});

test("failures say what to do: usage limit, sign-in, wrong model", async () => {
  const fail = (result) => ({
    result: { type: "result", subtype: "error", is_error: true, result },
  });
  await assert.rejects(
    gateway([fail("You hit your limit")], []).run("complete", {}),
    {
      code: "CLAUDE_USAGE_LIMIT",
    },
  );
  await assert.rejects(
    gateway([fail("Not logged in")], []).run("complete", {}),
    {
      code: "CLAUDE_NOT_SIGNED_IN",
    },
  );
  await assert.rejects(
    gateway(
      [
        {
          model: "claude-haiku-5-5",
          result: { type: "result", subtype: "success", result: "{}" },
        },
      ],
      [],
    ).run("complete", {}),
    { code: "CLAUDE_WRONG_MODEL" },
  );
});

test("cancelling stops the running process", async () => {
  const cancel = new AbortController();
  const g = gateway(["hang"], []);
  const running = g.run("complete", {}, { signal: cancel.signal });
  setImmediate(() => cancel.abort());
  await assert.rejects(running, { code: "CLAUDE_CANCELLED" });
});

test("the limit on running calls lets a player's request pass queued chatter", async () => {
  const order = [];
  const replies = ["hang", '{"chatter":1}', '{"player":1}'];
  const base = fakeSpawn(replies);
  let first;
  const g = createClaudeGateway({
    env,
    cwd: dir,
    maxRunning: 1,
    validate: () => {},
    spawn: (...args) => {
      const child = base(...args);
      first ??= child;
      return child;
    },
  });
  const blocker = g.run("complete", {}, {}).catch(() => {});
  const chatter = g.run("npc-chatter", {}).then(() => order.push("chatter"));
  const player = g.run("tutor", {}).then(() => order.push("player"));
  await new Promise((r) => setImmediate(r));
  first.kill();
  await Promise.all([blocker, chatter, player]);
  assert.equal(order[0], "player");
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
  const blocker = g.run("complete", {}).catch(() => {});
  const queued = g.run("complete", {}, { signal: cancel.signal });
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
  const first = g.run("complete", payload, { signal: a.signal });
  const second = g.run("complete", payload, { signal: b.signal });
  await new Promise((r) => setImmediate(r));
  a.abort();
  await new Promise((r) => setImmediate(r));
  assert.ok(!child.killed, "the other caller is still waiting");
  b.abort();
  await assert.rejects(first, { code: "CLAUDE_CANCELLED" });
  await assert.rejects(second, { code: "CLAUDE_CANCELLED" });
  assert.equal(calls.length, 1);
});

test("a design conversation recovers after a restart or a lost session", async () => {
  const fail = (result) => ({
    result: { type: "result", subtype: "error", is_error: true, result },
  });
  const restarted = [];
  const afterRestart = gateway(
    [fail("Session ID x is already in use."), '{"ok":1}'],
    restarted,
  );
  assert.deepEqual(
    await afterRestart.run("design-run", { generationId: "design-a" }),
    { ok: 1 },
  );
  assert.ok(restarted[0].args.includes("--session-id"));
  assert.ok(restarted[1].args.includes("--resume"));
  const lost = [];
  const afterLoss = gateway(
    ['{"ok":1}', fail("No conversation found"), '{"ok":2}'],
    lost,
  );
  await afterLoss.run("design-run", {
    requestId: "a",
    generationId: "design-b",
  });
  assert.deepEqual(
    await afterLoss.run("design-run", {
      requestId: "b",
      generationId: "design-b",
    }),
    { ok: 2 },
  );
  assert.ok(lost[2].args.includes("--session-id"));
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

test("quality design stages require schema-validated structured output", async () => {
  const calls = [];
  const g = gateway(
    [
      {
        result: {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "",
          structured_output: {
            requestId: "s1",
            selectedId: "a",
            rationale: "r",
          },
        },
      },
      '{"ok":1}',
      '{"ok":2}',
    ],
    calls,
  );
  const reply = await g.run("design-run", {
    version: 3,
    phase: "selection",
    requestId: "s1",
    generationId: "design-schema",
  });
  assert.deepEqual(reply, { requestId: "s1", selectedId: "a", rationale: "r" });
  const schema = JSON.parse(
    calls[0].args[calls[0].args.indexOf("--json-schema") + 1],
  );
  assert.deepEqual(schema.properties.requestId, { const: "s1" });
  assert.deepEqual(schema.required, ["requestId", "selectedId", "rationale"]);
  // Retained legacy design requests and live tasks keep free-form replies.
  await g.run("design-run", { version: 1, requestId: "old" });
  await g.run("complete", {});
  assert.equal(calls[1].args.includes("--json-schema"), false);
  assert.equal(calls[2].args.includes("--json-schema"), false);
});

test("a reply the CLI cannot fit to the schema gets one correction turn", async () => {
  const calls = [];
  const g = gateway(
    [
      {
        result: {
          type: "result",
          subtype: "error_max_structured_output_retries",
          is_error: true,
          errors: ["concepts: must have 3 items"],
        },
      },
      {
        result: {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "",
          structured_output: {
            requestId: "c1",
            selectedId: "b",
            rationale: "r",
          },
        },
      },
    ],
    calls,
  );
  const payload = { version: 3, phase: "selection", requestId: "c1" };
  assert.deepEqual(await g.run("design-run", payload), {
    requestId: "c1",
    selectedId: "b",
    rationale: "r",
  });
  assert.equal(calls.length, 2);
  assert.match(calls[1].input, /previous answer was rejected/);
  assert.match(calls[1].input, /must have 3 items/);
  // Schema-backed stages ask for the StructuredOutput tool, not free text.
  const { system } = buildPrompt("design-run", payload);
  assert.match(system, /StructuredOutput tool/);
  assert.doesNotMatch(system, /no markdown fence/);
  assert.match(buildPrompt("complete", {}).system, /no markdown fence/);
});
