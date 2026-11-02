// Scoped local-process lifecycle fixtures. No real Cloudflare credentials or network calls.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
// @ts-expect-error Direct local .mjs lifecycle integration.
import { createTunnelSupervisor } from "../scripts/chatgpt-tunnel-supervisor.mjs";
// @ts-expect-error Direct local .mjs configuration integration.
import * as tunnelConfig from "../scripts/chatgpt-tunnel-config.mjs";
const {
  renderGameTunnelConfig,
  loadGameTunnelConfig,
  validateConnectorRanges,
  tunnelRunArguments,
} = tunnelConfig;
const digest = (text: string | Buffer) =>
  createHash("sha256").update(text).digest("hex");
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "da-tunnel-")),
    binary = join(dir, "fake-cloudflared"),
    pidFile = join(dir, "owned-child.pid"),
    tunnelId = "11111111-2222-4333-8444-555555555555";
  // exec keeps the owned PID stable; only this fixture process is ever signaled.
  const script = `#!/bin/sh\nif [ -n "$OPENAI_API_KEY$TUNNEL_TOKEN$TUNNEL_CRED_CONTENTS$NODE_OPTIONS" ]; then exit 7; fi\necho $$ > ${quote(pidFile)}\necho 'Registered tunnel connection' >&2\nexec /bin/sleep 600\n`;
  writeFileSync(binary, script, { mode: 0o700 });
  const ranges = JSON.stringify({
      creationTime: "2026-10-16T12:00:00Z",
      prefixes: [{ ipv4Prefix: "203.0.113.0/24" }],
    }),
    config = {
      schema: 1,
      name: "synthetic-test",
      hostname: "synthetic-game.lullascape.com",
      tunnelId,
      credentialsPath: join(dir, tunnelId + ".json"),
      socketPath: join(dir, "b.sock"),
      configPath: join(dir, "tunnel.yml"),
      binary: { path: binary, sha256: digest(script) },
      connectorRangesSha256: digest(ranges),
    };
  writeFileSync(
    config.credentialsPath,
    JSON.stringify({
      TunnelID: tunnelId,
      TunnelSecret: "SYNTHETIC_NOT_REAL",
      AccountTag: "synthetic",
    }),
    { mode: 0o600 },
  );
  writeFileSync(config.configPath, renderGameTunnelConfig(config), {
    mode: 0o600,
  });
  writeFileSync(join(dir, "connector-ranges.json"), ranges, { mode: 0o600 });
  writeFileSync(join(dir, "setup.json"), JSON.stringify(config), {
    mode: 0o600,
  });
  return { dir, config, binary, pidFile };
}
// Owned processes normally settle well under a second (the watchdog escalates
// to SIGKILL after 2.4 s). The fake tunnel otherwise sleeps for 600 s, so this
// deadline only absorbs scheduling delay on a loaded CI runner.
async function until(predicate: () => boolean, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end)
      throw Error("Owned fixture did not reach expected state");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
const exists = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("game tunnel configuration pins binary, credentials, exact private ingress and current connector ranges", () => {
  const f = fixture();
  try {
    const loaded = loadGameTunnelConfig(f.dir);
    assert.equal(loaded.tunnelId, f.config.tunnelId);
    const args = tunnelRunArguments(loaded);
    assert.ok(args.includes("--no-autoupdate"));
    assert.ok(args.includes("--management-diagnostics=false"));
    assert.ok(args.includes("127.0.0.1:0"));
    assert.equal(args.at(-1), f.config.tunnelId);
    assert.ok(!args.some((v: string) => v.includes("SYNTHETIC_NOT_REAL")));
    assert.throws(
      () =>
        validateConnectorRanges({
          creationTime: "2026-10-16",
          prefixes: [{ ipv4Prefix: "0.0.0.0/0" }],
        }),
      /overbroad/,
    );
    assert.throws(
      () =>
        renderGameTunnelConfig({ ...f.config, hostname: "unrelated.example" }),
      /Invalid isolated/,
    );
    writeFileSync(f.config.configPath, "ingress: []\n");
    assert.throws(
      () => loadGameTunnelConfig(f.dir),
      /ingress configuration changed/,
    );
    writeFileSync(f.config.configPath, renderGameTunnelConfig(f.config));
    writeFileSync(f.binary, "#!/bin/sh\nexit 0\n");
    assert.throws(() => loadGameTunnelConfig(f.dir), /cloudflared changed/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("game tunnel starts its exact owned child with a stripped environment and stops it without touching other tunnels", async () => {
  const f = fixture(),
    supervisor = createTunnelSupervisor(f.config, { probe: async () => true });
  let pid: number | undefined;
  try {
    assert.equal(supervisor.start().state, "starting");
    await until(() => supervisor.status().verified);
    pid = Number(readFileSync(f.pidFile, "utf8"));
    assert.ok(exists(pid));
    assert.equal(
      supervisor.start().state,
      "connected",
      "repeat start cannot launch another process",
    );
    await supervisor.stop();
    assert.equal(supervisor.status().state, "off");
    await until(() => !exists(pid!));
  } finally {
    await supervisor.stop();
    if (pid && exists(pid)) process.kill(pid, "SIGKILL");
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("an abrupt owning-app crash disconnects the watchdog and terminates only its owned tunnel", async () => {
  const f = fixture(),
    driver = join(f.dir, "driver.mjs"),
    moduleUrl = pathToFileURL(
      resolve("scripts/chatgpt-tunnel-supervisor.mjs"),
    ).href;
  writeFileSync(
    driver,
    `import {createTunnelSupervisor} from ${JSON.stringify(moduleUrl)};const supervisor=createTunnelSupervisor(${JSON.stringify(f.config)},{probe:async()=>true});supervisor.start();setInterval(()=>{},1000);`,
    { mode: 0o600 },
  );
  const parent = fork(driver, [], {
    execArgv: [],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let pid: number | undefined;
  try {
    await until(() => {
      try {
        pid = Number(readFileSync(f.pidFile, "utf8"));
        return Number.isInteger(pid) && pid! > 1;
      } catch {
        return false;
      }
    });
    assert.ok(exists(pid!));
    parent.kill("SIGKILL");
    await until(() => !exists(pid!));
  } finally {
    parent.kill("SIGKILL");
    if (pid && exists(pid)) process.kill(pid, "SIGKILL");
    rmSync(f.dir, { recursive: true, force: true });
  }
});
