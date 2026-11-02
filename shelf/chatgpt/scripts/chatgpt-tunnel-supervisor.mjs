import { fork, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import {
  loadGameTunnelConfig,
  tunnelRunArguments,
} from "./chatgpt-tunnel-config.mjs";
const self = fileURLToPath(import.meta.url);
const cleanEnv = () => ({
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: homedir(),
  TMPDIR: process.env.TMPDIR ?? "",
});

/** Own only this project's child. IPC disconnect also stops it after parent crash. */
export function createTunnelSupervisor(
  config,
  {
    probe = async () => {
      const response = await fetch(
        `https://${config.hostname}/.well-known/oauth-protected-resource/mcp`,
        { redirect: "error", signal: AbortSignal.timeout(10_000) },
      );
      const body = await response.json();
      return response.ok && body.resource === `https://${config.hostname}/mcp`;
    },
  } = {},
) {
  let child = null,
    state = "off",
    error = null,
    verified = false;
  const status = () => ({ state, verified, error });
  return {
    status,
    start() {
      if (child) return status();
      loadGameTunnelConfig(dirname(config.configPath));
      state = "starting";
      error = null;
      verified = false;
      child = fork(self, ["--watchdog"], {
        execArgv: [],
        env: cleanEnv(),
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      child.on("message", (message) => {
        if (message?.kind === "connected") {
          state = "connected";
          const owned = child;
          void (async () => {
            try {
              if (!(await probe())) throw Error();
              if (child === owned && state === "connected") {
                verified = true;
                error = null;
              }
            } catch {
              if (child === owned)
                error =
                  "Tunnel connected, but public connector discovery has not yet verified. Retry after DNS propagation.";
            }
          })();
        } else if (message?.kind === "error") {
          state = "error";
          error =
            "The game tunnel failed. Its credentials, binary pin and network connection need checking.";
        }
      });
      child.on("error", () => {
        state = "error";
        error = "The tunnel watchdog could not start.";
      });
      child.on("exit", () => {
        child = null;
        if (state !== "error") state = "off";
        verified = false;
      });
      child.send({ command: "start", directory: dirname(config.configPath) });
      return status();
    },
    async stop() {
      const owned = child;
      if (!owned) {
        state = "off";
        verified = false;
        return status();
      }
      const stopped = new Promise((resolve) => owned.once("exit", resolve));
      if (owned.connected) owned.send({ command: "stop" });
      await stopped;
      state = "off";
      verified = false;
      return status();
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href &&
  process.argv.includes("--watchdog")
) {
  let tunnel = null,
    stopping = false,
    killTimer = null;
  const report = (kind) => {
    if (process.connected) process.send({ kind });
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (!tunnel) {
      process.exit(0);
      return;
    }
    tunnel.kill("SIGTERM");
    killTimer = setTimeout(() => tunnel?.kill("SIGKILL"), 2400);
  };
  process.on("disconnect", stop);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("message", (message) => {
    if (message?.command === "stop") {
      stop();
      return;
    }
    if (message?.command !== "start" || tunnel || stopping) return;
    try {
      const config = loadGameTunnelConfig(message.directory);
      tunnel = spawn(config.binary.path, tunnelRunArguments(config), {
        env: cleanEnv(),
        shell: false,
        cwd: message.directory,
        stdio: ["ignore", "ignore", "pipe"],
      });
      tunnel.stderr.on("data", (part) => {
        // Never forward raw request URLs, headers, tokens or credential paths.
        const text = part.toString("utf8");
        if (text.includes("Registered tunnel connection")) report("connected");
        if (text.includes(" ERR ") || text.includes('"level":"error"'))
          report("error");
      });
      tunnel.on("error", () => {
        report("error");
        stop();
      });
      tunnel.on("close", () => {
        if (killTimer) clearTimeout(killTimer);
        if (!stopping) report("error");
        tunnel = null;
        process.exit(stopping ? 0 : 1);
      });
    } catch {
      report("error");
      process.exit(1);
    }
  });
}
