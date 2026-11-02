import { safeEqual } from "./lib/safe-equal.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { createStudyBridgeServer } from "./study-bridge-server.mjs";
import { createHandoffQueue } from "./chatgpt-handoff-queue.mjs";
import { createHandoffRoutes } from "./chatgpt-handoff-routes.mjs";
import { createPublicHandoffBridge } from "./chatgpt-public-bridge.mjs";
import { createTunnelSupervisor } from "./chatgpt-tunnel-supervisor.mjs";
import { createNpcSpeechService } from "./npc-speech-service.mjs";
import { createClaudeGateway } from "./claude-gateway.mjs";
import {
  loadGameTunnelConfig,
  tunnelDirectory,
  privateDirectory,
  writePrivate,
} from "./chatgpt-tunnel-config.mjs";
const defaultHandoff = fileURLToPath(
  new URL("../.local/chatgpt-handoff/", import.meta.url),
);

/** This process owns the relay, worker session and tunnel. Game launchers may
 * disconnect without ending it; its own exit still ends the tunnel watchdog. */
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
  const handoffDirectory = options.handoffDirectory ?? defaultHandoff;
  const queue = createHandoffQueue({
    file: join(handoffDirectory, "jobs.json"),
  });
  let publicBridge, supervisor;
  try {
    const config =
      options.publicConfig === null
        ? null
        : (options.publicConfig ?? loadGameTunnelConfig());
    if (config) {
      publicBridge = createPublicHandoffBridge({
        hostname: config.hostname,
        queue,
        directory: options.publicDirectory ?? tunnelDirectory,
        connectorRanges: config.connectorRanges,
      });
      supervisor = createTunnelSupervisor(config);
    }
  } catch (error) {
    if (error.code !== "ENOENT")
      console.error(
        "Public connector configuration needs repair. Local play remains available.",
      );
  }
  const handoff = createHandoffRoutes(queue, {
    tokenFile: join(handoffDirectory, "worker-token"),
    publicBridge,
    supervisor,
  });
  const identity = {
    version: 1,
    running: true,
    pid: process.pid,
    root: boot.root,
    instance: boot.instance,
  };
  let closing = false;
  const speech = createNpcSpeechService();
  const server = createStudyBridgeServer({
    speech,
    claude:
      (options.aiProvider ?? process.env.STUDY_AI_PROVIDER) === "chatgpt"
        ? undefined
        : createClaudeGateway(),
    endpoint: process.env.STUDY_MODE_BRIDGE_URL,
    key: process.env.STUDY_MODE_BRIDGE_TOKEN,
    handoff: {
      ...handoff,
      async route(req, res) {
        if (req.url !== "/_bridge-service") return handoff.route(req, res);
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
    // Temporary audio must be aborted/deleted even if releasing the durable
    // study queue or stopping an external connector subsequently fails.
    await speech.close();
    queue.enable(false);
    await supervisor?.stop();
    await publicBridge?.close();
    server.closeAllConnections();
    server.close(() => process.exit(0));
  }
  // Publish ownership before binding, so concurrent starters can authenticate
  // immediately when the port becomes reachable.
  writePrivate(
    join(boot.directory, "service.json"),
    JSON.stringify({ ...identity, token: boot.token, port: boot.port }),
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(boot.port, "127.0.0.1", resolve);
  });
  if (publicBridge)
    try {
      await publicBridge.listen();
    } catch {
      console.error(
        "Public game connector socket could not open. Tunnel remains stopped.",
      );
      supervisor = undefined;
    }
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      void close();
    });
  console.log(
    `Persistent study bridge: http://127.0.0.1:${boot.port} (loopback only)`,
  );
  return { status: identity, queue, publicBridge, server };
}
export function bootstrapBridge(options = {}) {
  if (!process.send)
    throw Error("Start the bridge through npm run bridge:start");
  process.once("message", async (boot) => {
    try {
      const service = await startBridgeService(boot, options);
      process.send?.({ kind: "ready", status: service.status });
      // Deliberately no disconnect shutdown: game/dev launchers are clients.
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
