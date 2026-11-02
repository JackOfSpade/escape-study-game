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
  taskProfile,
} from "../scripts/claude-gateway.mjs";

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
