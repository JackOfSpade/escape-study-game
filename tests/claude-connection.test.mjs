import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createClaudeGateway } from "../scripts/claude-gateway.mjs";
import { createStudyBridgeServer } from "../scripts/study-bridge-server.mjs";

const dir = mkdtempSync(join(tmpdir(), "fake-claude-connection-"));
writeFileSync(join(dir, "claude"), "#!/bin/sh\n", { mode: 0o755 });

function authStatus(output, calls = []) {
  return (binary, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.kill = () => {};
    if (output !== "hang")
      setImmediate(() => {
        child.stdout.write(output);
        child.stdout.end();
        child.emit("close", 0);
      });
    return child;
  };
}
const gateway = (output, extra = {}) =>
  createClaudeGateway({
    env: { PATH: dir },
    cwd: dir,
    spawn: authStatus(output, extra.calls),
    now: extra.now,
  });

test("the gateway reports a signed-out CLI", async () => {
  assert.equal(
    await gateway(JSON.stringify({ loggedIn: false })).connection(),
    "signed-out",
  );
});
test("the gateway reports a signed-in CLI as connected", async () => {
  assert.equal(
    await gateway(JSON.stringify({ loggedIn: true })).connection(),
    "connected",
  );
});
test("an inconclusive check does not lock the terminals", async () => {
  assert.equal(await gateway("not json").connection(), "connected");
});
test("a CLI that vanished after it was found reads as missing", async () => {
  const g = createClaudeGateway({
    env: { PATH: dir },
    cwd: dir,
    spawn: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.kill = () => {};
      setImmediate(() =>
        child.emit("error", Object.assign(Error("gone"), { code: "ENOENT" })),
      );
      return child;
    },
  });
  assert.equal(await g.connection(), "cli-missing");
});
test("repeated checks share one CLI call until the result expires", async () => {
  const calls = [];
  let time = 1000;
  const g = gateway(JSON.stringify({ loggedIn: true }), {
    calls,
    now: () => time,
  });
  await Promise.all([g.connection(), g.connection()]);
  await g.connection();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["auth", "status", "--json"]);
  time += 5000;
  await g.connection();
  assert.equal(calls.length, 2);
});
for (const [state, mode] of [
  ["connected", "claude-cli"],
  ["signed-out", "development"],
  ["cli-missing", "development"],
])
  test(`/api/status reports ${state} as ${mode}`, async (t) => {
    const server = createStudyBridgeServer({
      claude: {
        enabled: () => true,
        connection: async () => state,
        run: async () => ({}),
      },
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const body = await (
      await fetch(`http://127.0.0.1:${server.address().port}/api/status`)
    ).json();
    assert.equal(body.mode, mode);
    assert.equal(body.reason, state === "connected" ? undefined : state);
  });
