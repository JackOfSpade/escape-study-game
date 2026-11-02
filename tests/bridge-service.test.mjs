// These tests cover the shelved ChatGPT relay, which needs its provider chosen.
process.env.STUDY_AI_PROVIDER = "chatgpt";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  bridgeStatus,
  ensureBridge,
  stopBridge,
} from "../scripts/bridge-service.mjs";
import { sha256 } from "../scripts/lib/digest.mjs";
const manager = new URL("../scripts/bridge-service.mjs", import.meta.url).href;
const serverModule = new URL("../scripts/bridge-server.mjs", import.meta.url)
  .href;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bridge-life-"));
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const entry = join(root, "relay.mjs");
  writeFileSync(
    entry,
    `import {bootstrapBridge} from ${JSON.stringify(serverModule)};bootstrapBridge({handoffDirectory:${JSON.stringify(join(root, "handoff"))},publicDirectory:${JSON.stringify(join(root, "public"))},publicConfig:{hostname:'synthetic-life.lullascape.com',connectorRanges:['203.0.113.0/24']}});`,
  );
  const options = { root, port, entry, directory: join(root, "runtime") };
  const api = async (path, body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(path === "/api/bridge" ? { Origin: "http://127.0.0.1:5173" } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  const control = (body) =>
    api("/api/handoff/control", body, { Origin: "http://127.0.0.1:5173" });
  return {
    root,
    options,
    api,
    control,
    async close() {
      await stopBridge(options);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function launcher(options) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {ensureBridge} from ${JSON.stringify(manager)};console.log(JSON.stringify(await ensureBridge(${JSON.stringify(options)})));`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "",
    errors = "";
  child.stdout.on("data", (part) => (output += part));
  child.stderr.on("data", (part) => (errors += part));
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 0, errors);
  return JSON.parse(output.trim());
}

test("a relay that needs over ten seconds to load its queue still starts", async () => {
  const f = await fixture();
  try {
    // A synchronous delay matches a large queue being validated at startup.
    writeFileSync(
      f.options.entry,
      `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10500);\n` +
        readFileSync(f.options.entry, "utf8"),
    );
    const [one, two] = await Promise.all([
      launcher(f.options),
      launcher(f.options),
    ]);
    assert.equal(one.pid, two.pid);
    assert.equal((await bridgeStatus(f.options)).pid, one.pid);
  } finally {
    await f.close();
  }
});

async function controlledService(handler) {
  const f = await fixture();
  const owner = {
    version: 1,
    root: sha256(realpathSync(f.root)),
    port: f.options.port,
    pid: process.pid,
    instance: "synthetic-shutdown",
    token: "a".repeat(64),
    running: true,
  };
  mkdirSync(f.options.directory, { mode: 0o700 });
  writeFileSync(
    join(f.options.directory, "service.json"),
    JSON.stringify(owner),
    { mode: 0o600 },
  );
  const server = createServer((req, res) => {
    assert.equal(req.headers["x-bridge-control"], owner.token);
    handler(req, res, () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(owner));
    });
  });
  await new Promise((resolve) =>
    server.listen(f.options.port, "127.0.0.1", resolve),
  );
  const close = async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  };
  return {
    ...f,
    close,
    cleanup: async () => {
      await close();
      rmSync(f.root, { recursive: true, force: true });
    },
  };
}

test("acknowledged shutdown tolerates temporary unresponsive health checks until its socket closes", async () => {
  let stopping = false,
    posts = 0,
    timer;
  const f = await controlledService((req, _res, answer) => {
    if (req.method === "POST") {
      posts++;
      stopping = true;
      answer();
      timer = setTimeout(() => void f.close(), 1600);
    } else if (!stopping) answer();
  });
  try {
    assert.deepEqual(await stopBridge(f.options), { running: false });
    assert.equal(
      posts,
      1,
      "shutdown is requested once, never signalled or repeated",
    );
  } finally {
    clearTimeout(timer);
    await f.cleanup();
  }
});

test("a shutdown request with no acknowledgement reports that its outcome is uncertain", async () => {
  let posts = 0;
  const f = await controlledService((req, _res, answer) => {
    if (req.method === "POST") posts++;
    else answer();
  });
  try {
    await assert.rejects(
      stopBridge(f.options),
      /not acknowledged.*may still be in progress/,
    );
    assert.equal(posts, 1);
  } finally {
    await f.cleanup();
  }
});

test("shutdown waiting never adopts an unverified listener after its acknowledged request", async () => {
  let stopping = false,
    posts = 0;
  const f = await controlledService((req, res, answer) => {
    if (req.method === "POST") {
      posts++;
      stopping = true;
      answer();
    } else if (stopping) {
      res.writeHead(403);
      res.end("{}");
    } else answer();
  });
  try {
    await assert.rejects(stopBridge(f.options), /unverified listener/);
    assert.equal(posts, 1);
  } finally {
    await f.cleanup();
  }
});

test(
  "acknowledged shutdown waiting has a bounded deadline and reports pending exit accurately",
  { timeout: 15000 },
  async () => {
    let posts = 0;
    const f = await controlledService((req, _res, answer) => {
      if (req.method === "POST") posts++;
      answer();
    });
    try {
      await assert.rejects(
        stopBridge(f.options),
        /shutdown was acknowledged but exit is still pending/,
      );
      assert.equal(posts, 1);
    } finally {
      await f.cleanup();
    }
  },
);

test("unresponsive startup and pre-shutdown checks remain conservative", async () => {
  let posts = 0;
  const f = await controlledService((req) => {
    if (req.method === "POST") posts++;
  });
  try {
    await assert.rejects(ensureBridge(f.options), /did not respond/);
    await assert.rejects(stopBridge(f.options), /did not respond/);
    assert.equal(posts, 0, "an unverified listener never receives shutdown");
    assert.throws(
      () => readFileSync(join(f.options.directory, "start.lock")),
      /ENOENT/,
    );
    assert.throws(
      () => readFileSync(join(f.options.directory, "service.log")),
      /ENOENT/,
    );
  } finally {
    await f.cleanup();
  }
});

test("game launcher exits and restarts without rotating the worker or losing a pending claim", async () => {
  const f = await fixture();
  try {
    const first = await launcher(f.options);
    assert.equal(first.reused, false);
    await f.control({ action: "enable", enabled: true });
    const worker = await f.control({ action: "worker" });
    assert.equal(worker.status, 200);
    assert.ok(worker.data.session);
    const token = readFileSync(join(f.root, "handoff/worker-token"), "utf8");
    const queued = await f.api("/api/bridge", {
      provider: "chatgpt-handoff",
      operation: "tutor",
      payload: {
        requestId: "synthetic-lifecycle-tutor",
        problem: { prompt: "Synthetic question only" },
        message: "Synthetic answer context only",
      },
    });
    assert.equal(queued.status, 202);
    const claimed = await f.api(
      "/api/handoff/worker",
      { action: "get", worker: "synthetic-claim" },
      { Authorization: `Bearer ${token}` },
    );
    assert.equal(claimed.data.operation, "tutor");
    const again = await launcher(f.options);
    assert.equal(again.pid, first.pid);
    assert.equal(again.instance, first.instance);
    assert.equal(again.reused, true);
    const status = (await f.api("/api/handoff/status")).data;
    assert.equal(status.enabled, true);
    assert.equal(status.autonomousWork, false);
    assert.equal(status.public.workerActive, true);
    assert.equal(
      readFileSync(join(f.root, "handoff/worker-token"), "utf8"),
      token,
    );
    const retained = await f.api(
      "/api/handoff/worker",
      { action: "get", worker: "synthetic-claim" },
      { Authorization: `Bearer ${token}` },
    );
    assert.deepEqual(retained.data, claimed.data);
    await f.control({ action: "enable", enabled: false });
    await launcher(f.options);
    assert.equal(
      (await f.api("/api/handoff/status")).data.enabled,
      false,
      "a game restart must not undo revoked sharing",
    );
  } finally {
    await f.close();
  }
});

test("concurrent starters reuse one bridge; management rejects browser origins and missing tokens", async () => {
  const f = await fixture();
  try {
    const starts = await Promise.all(
      Array.from({ length: 6 }, () => ensureBridge(f.options)),
    );
    assert.equal(new Set(starts.map((s) => s.pid)).size, 1);
    assert.equal(starts.filter((s) => !s.reused).length, 1);
    assert.equal((await f.api("/_bridge-service", {})).status, 403);
    const owner = JSON.parse(
      readFileSync(join(f.options.directory, "service.json"), "utf8"),
    );
    assert.equal(
      (
        await f.api(
          "/_bridge-service",
          {},
          { "X-Bridge-Control": owner.token, Origin: "http://127.0.0.1:5173" },
        )
      ).status,
      403,
    );
    assert.equal((await bridgeStatus(f.options)).running, true);
    await assert.rejects(
      ensureBridge({ ...f.options, root: tmpdir() }),
      /another service/,
    );
    assert.equal((await bridgeStatus(f.options)).running, true);
  } finally {
    await f.close();
  }
});

test("an actual relay crash creates a fresh disabled worker session while retaining captured work", async () => {
  const f = await fixture();
  try {
    const before = await ensureBridge(f.options);
    await f.control({ action: "enable", enabled: true });
    await f.control({ action: "worker" });
    const receipt = await f.api("/api/bridge", {
      provider: "chatgpt-handoff",
      operation: "tutor",
      payload: {
        requestId: "synthetic-crash",
        message: "Preserved fictional context",
      },
    });
    assert.equal(receipt.status, 202);
    process.kill(before.pid, "SIGKILL"); // This test's isolated, authenticated synthetic child only.
    for (let i = 0; i < 100; i++) {
      await wait(10);
      if (!(await bridgeStatus(f.options)).running) break;
    }
    const after = await ensureBridge(f.options);
    assert.notEqual(after.instance, before.instance);
    const status = (await f.api("/api/handoff/status")).data;
    assert.equal(status.enabled, false);
    assert.equal(status.autonomousWork, false);
    assert.equal(status.public.workerActive, false);
    assert.equal(status.queued, 1);
    await f.control({ action: "enable", enabled: true }); // Explicit synthetic reauthorization, never automatic restart restoration.
    assert.equal(
      (
        await f.api(
          `/api/bridge/result?id=${receipt.data.handoff.id}&hash=${receipt.data.handoff.hash}`,
        )
      ).status,
      202,
    );
  } finally {
    await f.close();
  }
});

test("an unrelated listener is neither adopted nor stopped", async () => {
  const f = await fixture();
  const unrelated = createServer((_req, res) => {
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise((resolve) =>
    unrelated.listen(f.options.port, "127.0.0.1", resolve),
  );
  try {
    await assert.rejects(ensureBridge(f.options), /unverified listener/);
    await assert.rejects(stopBridge(f.options), /unverified listener/);
    assert.equal(unrelated.listening, true);
  } finally {
    await new Promise((resolve) => unrelated.close(resolve));
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("the actual dev-launcher shutdown stops its game child and leaves the bridge reusable", async () => {
  const f = await fixture();
  const client = join(f.root, "client.mjs");
  writeFileSync(
    client,
    "console.log('SYNTHETIC_CLIENT_READY');setInterval(()=>{},1000);",
  );
  const dev = new URL("../scripts/dev.mjs", import.meta.url).href;
  let current;
  async function start() {
    current = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {startDev} from ${JSON.stringify(dev)};await startDev({bridgeOptions:${JSON.stringify(f.options)},clientEntry:${JSON.stringify(client)},clientArgs:[]});`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await new Promise((resolve, reject) => {
      let text = "";
      const timer = setTimeout(
        () => reject(Error("Synthetic game did not start")),
        10000,
      );
      current.stdout.on("data", (part) => {
        text += part;
        if (text.includes("SYNTHETIC_CLIENT_READY")) {
          clearTimeout(timer);
          resolve();
        }
      });
      current.once("exit", (code) => {
        clearTimeout(timer);
        reject(Error(`Game launcher exited early (${code})`));
      });
    });
  }
  async function stop() {
    const child = current;
    current = undefined;
    if (!child) return;
    const exit = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    assert.equal(await exit, 0);
  }
  try {
    await start();
    const first = await bridgeStatus(f.options);
    await f.control({ action: "enable", enabled: true });
    await f.control({ action: "worker" });
    await stop();
    assert.equal((await bridgeStatus(f.options)).pid, first.pid);
    await start();
    assert.equal((await bridgeStatus(f.options)).pid, first.pid);
    assert.equal(
      (await f.api("/api/handoff/status")).data.public.workerActive,
      true,
    );
    await stop();
  } finally {
    await stop();
    await f.close();
  }
});

test("failed and interrupted startup leave the next launcher able to recover", async () => {
  const f = await fixture();
  try {
    const bad = join(f.root, "bad-relay.mjs");
    writeFileSync(bad, "process.exit(3);");
    await assert.rejects(
      ensureBridge({ ...f.options, entry: bad }),
      /failed to start/,
    );
    const lock = join(f.options.directory, "start.lock");
    writeFileSync(lock, "", { mode: 0o600 });
    const old = new Date(Date.now() - 10000);
    utimesSync(lock, old, old);
    assert.equal((await ensureBridge(f.options)).running, true);
  } finally {
    await f.close();
  }
});
