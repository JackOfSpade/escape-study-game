import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sha256 } from "./lib/digest.mjs";
import { assertOwnerOnly, privateDirectory } from "./lib/private-fs.mjs";
const project = fileURLToPath(new URL("../", import.meta.url));
export const defaults = {
  directory: join(project, ".local/bridge-service"),
  root: project,
  port: 4318,
  entry: fileURLToPath(new URL("./bridge-server.mjs", import.meta.url)),
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The relay validates its whole durable queue before it can report ready; that
// takes seconds near the queue's byte cap, and killing it would never let it
// finish compacting the queue that made it slow.
const STARTUP_TIMEOUT_MS = 60_000;
class BridgeTransportError extends Error {}
const unavailable = (method) =>
  new BridgeTransportError(
    method === "POST"
      ? "Bridge shutdown request was not acknowledged; shutdown may still be in progress. No unrelated process was signalled"
      : "Bridge service did not respond; no process was stopped or replaced",
  );
function readPrivate(path) {
  const s = lstatSync(path);
  assertOwnerOnly(s, {
    kind: "file",
    maxBytes: 8192,
    message: "Unsafe bridge service ownership record",
  });
  return JSON.parse(readFileSync(path, "utf8"));
}
function record(options) {
  try {
    return readPrivate(join(options.directory, "service.json"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
}
function optionsFor(options) {
  const o = { ...defaults, ...options };
  o.root = sha256(realpathSync(o.root));
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535)
    throw Error("Invalid bridge port");
  return o;
}
async function request(o, owner, method = "GET", retry = true) {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${o.port}/_bridge-service`, {
      method,
      headers: owner ? { "X-Bridge-Control": owner.token } : {},
      signal: AbortSignal.timeout(1000),
    });
  } catch (error) {
    if (error.cause?.code === "ECONNREFUSED") return;
    if (
      method === "GET" &&
      retry &&
      ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(error.cause?.code)
    ) {
      await pause(25);
      return request(o, owner, method, false);
    }
    throw unavailable(method);
  }
  if (!owner || !response.ok)
    throw Error(
      "Bridge port belongs to an unverified listener; refusing to replace it",
    );
  let data;
  try {
    data = await response.json();
  } catch (error) {
    // A timeout or disconnected socket can also interrupt the response body.
    // Malformed JSON is an identity failure, never transient silence.
    if (!(error instanceof SyntaxError)) throw unavailable(method);
    throw error;
  }
  if (
    data.root !== o.root ||
    data.instance !== owner.instance ||
    data.pid !== owner.pid ||
    data.version !== 1
  )
    throw Error(
      "Bridge ownership does not match this project; refusing to replace it",
    );
  return data;
}
function verifyRecord(o, owner) {
  if (
    owner &&
    (owner.root !== o.root ||
      owner.port !== o.port ||
      !Number.isInteger(owner.pid) ||
      typeof owner.token !== "string" ||
      !/^[a-f0-9]{64}$/.test(owner.token))
  )
    throw Error("Bridge ownership record belongs to another service");
}
/** Start once, or reconnect to this project's already-authenticated service.
 * No sharing, OAuth or worker-session setting is changed by this operation. */
export async function ensureBridge(options = {}) {
  const o = optionsFor(options);
  privateDirectory(o.directory);
  const lock = join(o.directory, "start.lock");
  let descriptor;
  // A concurrent caller waits out the lock holder's whole startup allowance.
  const lockDeadline = Date.now() + STARTUP_TIMEOUT_MS + 5000;
  while (Date.now() < lockDeadline) {
    const owner = record(o);
    verifyRecord(o, owner);
    const live = await request(o, owner);
    if (live) return { ...live, reused: true };
    try {
      descriptor = openSync(lock, "wx", 0o600);
      writeSync(descriptor, JSON.stringify({ pid: process.pid }));
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let stat;
      try {
        stat = lstatSync(lock);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      let abandoned = false;
      try {
        const pending = readPrivate(lock);
        if (!Number.isInteger(pending.pid))
          throw Error("Invalid bridge start lock");
        try {
          process.kill(pending.pid, 0);
        } catch (error) {
          if (error.code === "ESRCH") abandoned = true;
          else throw error;
        }
      } catch (error) {
        // An interrupted exclusive-create may leave an empty, owned lock.
        if (error.code === "ENOENT") continue;
        if (error instanceof SyntaxError && stat.size === 0)
          abandoned = Date.now() - stat.mtimeMs > 5000;
        else throw error;
      }
      if (abandoned && lstatSync(lock).ino === stat.ino) unlinkSync(lock);
      await pause(50);
    }
  }
  if (descriptor === undefined)
    throw Error("Timed out waiting for bridge startup");
  try {
    const owner = record(o);
    verifyRecord(o, owner);
    const live = await request(o, owner);
    if (live) return { ...live, reused: true };
    const log = join(o.directory, "service.log");
    try {
      const stat = lstatSync(log);
      assertOwnerOnly(stat, {
        kind: "file",
        message: "Unsafe bridge log",
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const output = openSync(log, "a", 0o600);
    const child = fork(o.entry, [], {
      detached: true,
      execArgv: [],
      stdio: ["ignore", output, output, "ipc"],
    });
    closeSync(output);
    let timer;
    const ready = new Promise((resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            Error("Bridge startup timed out; inspect its private service log"),
          ),
        STARTUP_TIMEOUT_MS,
      );
      child.once("error", reject);
      child.once("exit", (code) =>
        reject(
          Error(
            `Bridge failed to start (${code}); inspect its private service log`,
          ),
        ),
      );
      child.once("message", (message) => {
        if (message?.kind === "ready") resolve(message.status);
        else reject(Error("Bridge returned an invalid startup response"));
      });
    });
    child.send({
      version: 1,
      directory: o.directory,
      root: o.root,
      port: o.port,
      token: randomBytes(32).toString("hex"),
      instance: randomBytes(16).toString("hex"),
    });
    try {
      await ready;
      const started = record(o);
      verifyRecord(o, started);
      const status = await request(o, started);
      if (!status) throw Error("Bridge exited during startup");
      return { ...status, reused: false };
    } catch (error) {
      child.kill("SIGTERM");
      throw error;
    } finally {
      clearTimeout(timer);
      if (child.connected) child.disconnect();
      child.unref();
    }
  } finally {
    closeSync(descriptor);
    unlinkSync(lock);
  }
}
export async function bridgeStatus(options = {}) {
  const o = optionsFor(options),
    owner = record(o);
  verifyRecord(o, owner);
  return (await request(o, owner)) ?? { version: 1, running: false };
}
export async function stopBridge(options = {}) {
  const o = optionsFor(options),
    owner = record(o);
  verifyRecord(o, owner);
  const live = await request(o, owner);
  if (!live) return { running: false };
  if (!(await request(o, owner, "POST"))) return { running: false };
  // Shutdown can synchronously persist a large queue before closing sockets.
  // Once acknowledged, temporary silence is expected; it is not permission
  // to kill or replace a listener. Keep all ownership checks on every reply.
  // One in-flight status request can add at most its one-second timeout.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await pause(Math.min(50, deadline - Date.now()));
    if (Date.now() >= deadline) break;
    try {
      // The outer loop owns retries, so this read cannot add a second timeout.
      if (!(await request(o, owner, "GET", false))) return { running: false };
    } catch (error) {
      if (!(error instanceof BridgeTransportError)) throw error;
    }
  }
  throw Error(
    "Bridge shutdown was acknowledged but exit is still pending; no unrelated process was signalled",
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const command = process.argv[2] ?? "start";
    if (!["start", "status", "stop"].includes(command))
      throw Error("Use bridge-service.mjs start|status|stop");
    const result = await {
      start: ensureBridge,
      status: bridgeStatus,
      stop: stopBridge,
    }[command]();
    // Management secrets stay in the owner-only runtime record.
    console.log(
      JSON.stringify(
        {
          running: result.running ?? true,
          pid: result.pid,
          reused: result.reused,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
