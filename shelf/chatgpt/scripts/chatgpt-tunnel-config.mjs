import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  lstatSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sha256 as sha } from "./lib/digest.mjs";
import { assertOwnerOnly } from "./lib/private-fs.mjs";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const tunnelDirectory = fileURLToPath(
  new URL("../.local/chatgpt-public/", import.meta.url),
);
export function privateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const s = lstatSync(directory);
  assertOwnerOnly(s, {
    kind: "directory",
    message: "Bridge directory must be private, owner-owned and not a symlink",
  });
}
export function writePrivate(file, data) {
  privateDirectory(dirname(file));
  const tmp = file + "." + randomBytes(8).toString("hex") + ".tmp";
  writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
  renameSync(tmp, file);
}
function readPrivate(file, max = 500_000) {
  const s = lstatSync(file);
  assertOwnerOnly(s, {
    kind: "file",
    maxBytes: max,
    message: "Unsafe bridge configuration file",
  });
  return readFileSync(file, "utf8");
}
function binaryIdentity(binary) {
  const path = realpathSync(binary),
    s = lstatSync(path);
  if (!s.isFile() || ![0, process.getuid?.()].includes(s.uid) || s.mode & 0o022)
    throw Error("cloudflared must be an owner-controlled executable");
  return { path, sha256: sha(readFileSync(path)) };
}
export function renderGameTunnelConfig({
  tunnelId,
  credentialsPath,
  hostname,
  socketPath,
}) {
  if (
    !uuid.test(tunnelId) ||
    !/^[a-z0-9][a-z0-9-]*\.lullascape\.com$/.test(hostname) ||
    ![credentialsPath, socketPath].every(
      (p) =>
        typeof p === "string" &&
        p.startsWith("/") &&
        !/[\x00-\x1f\x7f]/.test(p),
    )
  )
    throw Error("Invalid isolated game tunnel configuration");
  return `tunnel: ${tunnelId}\ncredentials-file: ${JSON.stringify(credentialsPath)}\ningress:\n  - hostname: ${hostname}\n    service: ${JSON.stringify(`unix:${socketPath}`)}\n    originRequest:\n      httpHostHeader: ${hostname}\n      connectTimeout: 5s\n      keepAliveConnections: 8\n      keepAliveTimeout: 30s\n  - service: http_status:404\n`;
}
export function validateConnectorRanges(document) {
  if (
    typeof document?.creationTime !== "string" ||
    !Number.isFinite(Date.parse(document.creationTime)) ||
    !Array.isArray(document.prefixes) ||
    !document.prefixes.length ||
    document.prefixes.length > 4096
  )
    throw Error("Invalid published connector ranges");
  return document.prefixes.map((row) => {
    const prefix = row.ipv4Prefix ?? row.ipv6Prefix;
    if (typeof prefix !== "string") throw Error("Invalid connector prefix");
    const [address, bitsText, ...extra] = prefix.split("/"),
      family = isIP(address),
      bits = Number(bitsText);
    if (
      extra.length ||
      !family ||
      !/^\d+$/.test(bitsText ?? "") ||
      !Number.isInteger(bits) ||
      bits < (family === 4 ? 8 : 16) ||
      bits > (family === 4 ? 32 : 128)
    )
      throw Error("Invalid or overbroad connector range");
    return prefix;
  });
}
export function loadGameTunnelConfig(directory = tunnelDirectory) {
  privateDirectory(directory);
  const setup = JSON.parse(readPrivate(join(directory, "setup.json")));
  const identity = binaryIdentity(setup.binary?.path);
  if (identity.sha256 !== setup.binary?.sha256)
    throw Error(
      "cloudflared changed; explicitly approve the updated binary before starting",
    );
  if (
    !uuid.test(setup.tunnelId) ||
    !setup.credentialsPath?.endsWith(setup.tunnelId + ".json")
  )
    throw Error("Invalid game tunnel identity");
  const credentials = JSON.parse(readPrivate(setup.credentialsPath));
  if (
    credentials.TunnelID !== setup.tunnelId ||
    typeof credentials.TunnelSecret !== "string" ||
    !credentials.TunnelSecret ||
    typeof credentials.AccountTag !== "string"
  )
    throw Error("Game tunnel credentials do not match the selected tunnel");
  if (
    setup.socketPath !== join(directory, "b.sock") ||
    setup.configPath !== join(directory, "tunnel.yml")
  )
    throw Error("Tunnel must route only to its own private socket");
  if (readPrivate(setup.configPath) !== renderGameTunnelConfig(setup))
    throw Error("Game tunnel ingress configuration changed");
  const rangeText = readPrivate(join(directory, "connector-ranges.json"));
  if (sha(rangeText) !== setup.connectorRangesSha256)
    throw Error("Published connector-range snapshot changed");
  return {
    ...setup,
    connectorRanges: validateConnectorRanges(JSON.parse(rangeText)),
  };
}
export function tunnelRunArguments(config) {
  return [
    "tunnel",
    "--config",
    config.configPath,
    "--no-autoupdate",
    "--loglevel",
    "info",
    "--metrics",
    "127.0.0.1:0",
    "--grace-period",
    "2s",
    "--label",
    "dead-air-study",
    "--management-diagnostics=false",
    "run",
    config.tunnelId,
  ];
}
export async function provisionGameTunnel({
  directory = tunnelDirectory,
  binary = "/opt/homebrew/bin/cloudflared",
} = {}) {
  privateDirectory(directory);
  const setupPath = join(directory, "setup.json");
  try {
    lstatSync(setupPath);
    return loadGameTunnelConfig(directory);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const identity = binaryIdentity(binary),
    bootstrap = join(directory, "bootstrap.yml");
  writePrivate(bootstrap, "{}\n");
  const env = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: homedir(),
    TMPDIR: process.env.TMPDIR ?? "",
  };
  const run = (args) => {
    const reply = spawnSync(identity.path, args, {
      encoding: "utf8",
      shell: false,
      env,
      timeout: 30_000,
      maxBuffer: 1_000_000,
    });
    writePrivate(
      join(directory, "provision-last-command.log"),
      String(reply.stdout ?? "") + String(reply.stderr ?? ""),
    );
    if (reply.error || reply.status !== 0)
      throw Error(
        "cloudflared configuration command failed; its diagnostic is retained in the private bridge directory",
      );
    return args.includes("--output") && args.includes("json")
      ? String(reply.stdout ?? "")
      : String(reply.stdout ?? "") + String(reply.stderr ?? "");
  };
  const intentPath = join(directory, "provision-intent.json");
  let intent;
  try {
    intent = JSON.parse(readPrivate(intentPath));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    intent = {
      name: `dead-air-study-${randomBytes(4).toString("hex")}`,
      hostname: `study-${randomBytes(10).toString("hex")}.lullascape.com`,
    };
    writePrivate(intentPath, JSON.stringify(intent));
  }
  if (
    !/^dead-air-study-[a-f0-9]{8}$/.test(intent.name) ||
    !/^study-[a-f0-9]{20}\.lullascape\.com$/.test(intent.hostname)
  )
    throw Error("Unexpected game tunnel provisioning intent");
  const common = ["tunnel", "--config", bootstrap];
  let tunnels = JSON.parse(run([...common, "list", "--output", "json"])),
    existing = tunnels.filter((t) => t.name === intent.name);
  if (existing.length > 1) throw Error("Ambiguous game tunnel identity");
  if (!existing.length) {
    run([...common, "create", intent.name]);
    tunnels = JSON.parse(run([...common, "list", "--output", "json"]));
    existing = tunnels.filter((t) => t.name === intent.name);
  }
  if (existing.length !== 1 || !uuid.test(existing[0].id))
    throw Error("Created tunnel could not be identified exactly");
  const tunnelId = existing[0].id,
    credentialsPath = join(homedir(), ".cloudflared", tunnelId + ".json");
  const credentialStat = lstatSync(credentialsPath);
  if (
    credentialStat.isSymbolicLink() ||
    credentialStat.uid !== process.getuid?.()
  )
    throw Error("Unsafe newly created tunnel credential file");
  chmodSync(credentialsPath, 0o600);
  // Fetch only the fixed official public allowlist, never a URL from learning content.
  const response = await fetch("https://openai.com/chatgpt-connectors.json", {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw Error("Current published connector ranges are unavailable");
  const text = await response.text();
  if (Buffer.byteLength(text) > 500_000)
    throw Error("Published range response too large");
  validateConnectorRanges(JSON.parse(text));
  writePrivate(join(directory, "connector-ranges.json"), text);
  const setup = {
    schema: 1,
    name: intent.name,
    hostname: intent.hostname,
    tunnelId,
    credentialsPath,
    socketPath: join(directory, "b.sock"),
    configPath: join(directory, "tunnel.yml"),
    binary: identity,
    connectorRangesSha256: sha(text),
  };
  writePrivate(setup.configPath, renderGameTunnelConfig(setup));
  const dry = [
    "tunnel",
    "--config",
    setup.configPath,
    "--no-autoupdate",
    "--grace-period",
    "2s",
    "--management-diagnostics=false",
    "ingress",
  ];
  if (!run([...dry, "validate"]).includes("OK"))
    throw Error("Game ingress did not validate");
  const match = run([...dry, "rule", `https://${setup.hostname}/mcp`]),
    fallback = run([...dry, "rule", "https://not-the-game.invalid/"]);
  if (
    !match.includes("Matched rule #0") ||
    !match.includes(`unix:${setup.socketPath}`) ||
    !fallback.includes("Matched rule #1") ||
    !fallback.includes("http_status:404")
  )
    throw Error(
      "Game tunnel ingress did not select exact private origin and catch-all 404",
    );
  const route = run([...common, "route", "dns", tunnelId, setup.hostname]);
  if (!route.includes(tunnelId))
    throw Error(
      "DNS route acknowledgement did not identify the exact game tunnel",
    );
  writePrivate(setupPath, JSON.stringify(setup, null, 2) + "\n");
  return loadGameTunnelConfig(directory);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const config = await provisionGameTunnel();
    console.log(
      JSON.stringify({
        configured: true,
        hostname: config.hostname,
        mcpUrl: `https://${config.hostname}/mcp`,
        name: config.name,
        running: false,
      }),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
