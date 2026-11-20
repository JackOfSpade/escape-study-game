import { safeEqual } from "./lib/safe-equal.mjs";
import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createClaudeGateway } from "./claude-gateway.mjs";
import { createStudyBridgeServer } from "./study-bridge-server.mjs";
import { privateDirectory, writePrivate } from "./lib/private-fs.mjs";
import { createBugReports } from "./bug-report-route.mjs";
import { stampConsole } from "./lib/stamp-console.mjs";

/** This process owns AI calls and code execution. Launchers may disconnect
 * without ending it. */
export async function startBridgeService(boot, options = {}) {
  if (
    boot.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(boot.token) ||
    !/^[a-f0-9]{64}$/.test(boot.root) ||
    !Number.isInteger(boot.port) ||
    boot.port < 1 ||
    boot.port > 65535
  )
    throw Error("Invalid bridge bootstrap");
  privateDirectory(boot.directory);
  const identity = {
    version: 1,
    running: true,
    pid: process.pid,
    root: boot.root,
    instance: boot.instance,
  };
  let closing = false;
  const usageLog = join(boot.directory, "claude-usage.jsonl");
  const claude =
    options.claude ??
    createClaudeGateway({
      usageLog,
      // Opt-in only: a study install keeps no copies of prompts or replies.
      // ZOMBIE_AI_REPLAY_SAMPLES is the pre-rename name, still honoured.
      ...((process.env.STUDY_AI_REPLAY_SAMPLES ??
        process.env.ZOMBIE_AI_REPLAY_SAMPLES) === "1"
        ? { replaySamples: join(boot.directory, "ai-replay-samples") }
        : {}),
    });
  // Reports sit beside the service folders (.local/bug-reports in a checkout).
  const local = dirname(boot.directory);
  const server = createStudyBridgeServer({
    claude,
    reports: createBugReports({
      directory: join(local, "bug-reports"),
      usageLog,
      logs: [
        {
          title: "Study bridge log",
          path: join(boot.directory, "service.log"),
        },
        {
          title: "App server log",
          path: join(local, "production", "service.log"),
        },
      ],
      status: async () =>
        !claude?.enabled()
          ? "gateway-off"
          : ((await claude.connection?.()) ?? "connected"),
    }),
    control: {
      route(req, res) {
        if (req.url !== "/_bridge-service") return false;
        const token = req.headers["x-bridge-control"];
        if (req.headers.origin || !safeEqual(token, boot.token)) {
          res.writeHead(403);
          res.end(
            JSON.stringify({ error: "Bridge owner authorization required" }),
          );
          return true;
        }
        if (!["GET", "POST"].includes(req.method)) {
          res.writeHead(405);
          res.end("{}");
          return true;
        }
        res.writeHead(200);
        res.end(JSON.stringify(identity));
        if (req.method === "POST")
          setImmediate(() => {
            void close();
          });
        return true;
      },
    },
  });
  async function close() {
    if (closing) return;
    closing = true;
    server.closeAllConnections();
    server.close(() => process.exit(0));
  }
  // Publish ownership before binding, so concurrent starters can authenticate
  // immediately when the port becomes reachable.
  writePrivate(
    join(boot.directory, "service.json"),
    JSON.stringify({
      ...identity,
      token: boot.token,
      port: boot.port,
      // The project's real path, so a later start can recognise this record after the project
      // folder is moved or renamed (see bridge-service.mjs movedRecord). Owner-only file.
      ...(typeof boot.rootPath === "string" ? { rootPath: boot.rootPath } : {}),
    }),
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(boot.port, "127.0.0.1", resolve);
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      void close();
    });
  console.log(
    `Persistent study bridge: http://127.0.0.1:${boot.port} (loopback only)`,
  );
  return { status: identity, server };
}
export function bootstrapBridge(options = {}) {
  if (!process.send)
    throw Error("Start the bridge through npm run bridge:start");
  stampConsole();
  process.once("message", async (boot) => {
    try {
      const service = await startBridgeService(boot, options);
      process.send?.({ kind: "ready", status: service.status });
      // Deliberately no disconnect shutdown: dev launchers are clients.
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  bootstrapBridge();
