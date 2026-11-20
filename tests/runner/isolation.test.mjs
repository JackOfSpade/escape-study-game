import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { executeCode } from "../../scripts/code-runner.mjs";

test("real Python and TypeScript execute in disposable containers with exact source hashes", async () => {
  for (const [language, code, output] of [
    ["python", "assert sum([2,3]) == 5\nprint('verified')", "verified\n"],
    [
      "typescript",
      "const xs: number[] = [2,3]; if(xs.reduce((a,b)=>a+b)!==5)throw Error('sum');console.log('verified')",
      "verified\n",
    ],
  ]) {
    const result = await executeCode({ language, code });
    assert.equal(result.executed, true, JSON.stringify(result));
    assert.equal(result.status, "completed");
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, output);
    assert.equal(
      result.codeHash,
      createHash("sha256").update(code).digest("hex"),
    );
    assert.match(result.imageId, /^sha256:[a-f0-9]{64}$/);
  }
});

test("filesystem, daemon socket, credentials, privilege and external network boundaries hold", async () => {
  mkdirSync(".local", { recursive: true });
  const sentinel = resolve(`.local/runner-host-${randomUUID()}`);
  writeFileSync(sentinel, "host-only-fixture");
  try {
    const result = await executeCode({
      language: "python",
      code: `
import os, socket
assert os.getuid() == 65534
assert not os.path.exists(${JSON.stringify(sentinel)})
assert not os.path.exists('/var/run/docker.sock')
assert 'STUDY_MODE_BRIDGE_TOKEN' not in os.environ
status = open('/proc/self/status').read()
assert 'NoNewPrivs:\\t1' in status
assert 'CapEff:\\t0000000000000000' in status
try:
    open('/etc/runner-write', 'w').write('forbidden')
    raise AssertionError('root filesystem writable')
except (PermissionError, OSError): pass
open('/work/scratch', 'w').write('allowed')
assert open('/work/scratch').read() == 'allowed'
s=socket.socket();s.settimeout(.2)
try:
    s.connect(('1.1.1.1', 80))
    raise AssertionError('external network connected')
except OSError: pass
print('boundaries verified')
`,
    });
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(result.stdout, "boundaries verified\n");
    const next = await executeCode({
      language: "python",
      code: "import os;assert not os.path.exists('/work/scratch');print('fresh')",
    });
    assert.equal(next.stdout, "fresh\n");
  } finally {
    unlinkSync(sentinel);
  }
});

test("infinite code, memory exhaustion and output flooding are bounded and release the runner", async () => {
  for (const code of [
    "while True: pass",
    "a=bytearray(512*1024*1024)",
    "while True: print('x'*8192)",
    "import os\nwhile True: os.write(1, bytes([255])*8192)",
  ]) {
    const start = performance.now();
    const result = await executeCode({ language: "python", code });
    assert.equal(result.executed, true, JSON.stringify(result));
    assert.ok(
      ["timeout", "output-limit", "resource-limit"].includes(result.status),
      JSON.stringify(result),
    );
    assert.ok(performance.now() - start < 10000);
    assert.ok(Buffer.byteLength(result.stdout + result.stderr) <= 65536);
  }
  const result = await executeCode({
    language: "python",
    code: "print('recovered')",
  });
  assert.equal(result.stdout, "recovered\n");
});

test("fork attempts hit the process limit and a concurrent request cannot start another container", async () => {
  const first = executeCode({
    language: "python",
    code: `
import os,time
count=0
for i in range(100):
    try: pid=os.fork()
    except OSError: break
    if pid == 0:
        time.sleep(60);os._exit(0)
    count+=1
assert count < 32
print('bounded forks', count)
`,
  });
  await assert.rejects(
    executeCode({ language: "python", code: "print('parallel')" }),
    /Runner busy/,
  );
  const result = await first;
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.match(result.stdout, /bounded forks \d+/);
});

test("oversized and unsupported requests are rejected before container creation", async () => {
  await assert.rejects(
    executeCode({ language: "bash", code: "echo forbidden" }),
    /Expected/,
  );
  await assert.rejects(
    executeCode({ language: "python", code: "x".repeat(65537) }),
    /64 KiB/,
  );
  const result = await executeCode({
    language: "python",
    code: "raise ValueError('actual failure')",
  });
  assert.equal(result.executed, true);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /ValueError: actual failure/);
});

test("a missing configured image stays unavailable and never executes on the host", async () => {
  const script =
    "import {executeCode} from './scripts/code-runner.mjs'; console.log(JSON.stringify(await executeCode({language:'typescript',code:'console.log(1)'})))";
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      env: {
        ...process.env,
        CODE_RUNNER_NODE_IMAGE: `study-nonexistent-${randomUUID()}:fixture`,
      },
      timeout: 10000,
    },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.status, "unavailable");
  assert.equal(result.executed, false);
  assert.equal(result.codeHash, undefined);
});

test("framed CLI input preserves Unicode and presents EOF to Python, TypeScript and JavaScript programs", async () => {
  const cases = [
    ["python", 'import sys\nprint("🧟 café")\nprint(len(sys.stdin.read()))'],
    [
      "typescript",
      'import {readFileSync} from "node:fs"; const text:string="🧟 café"; console.log(text); console.log(readFileSync(0,"utf8").length);',
    ],
    [
      "javascript",
      'import {readFileSync} from "node:fs"; console.log("🧟 café"); console.log(readFileSync(0,"utf8").length);',
    ],
  ];
  for (const [language, code] of cases) {
    const receipt = await executeCode({ language, code });
    assert.equal(receipt.executed, true, JSON.stringify(receipt));
    assert.equal(receipt.exitCode, 0, receipt.stderr);
    assert.equal(receipt.stdout, "🧟 café\n0\n");
  }
});
