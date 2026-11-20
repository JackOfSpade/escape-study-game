import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAppServer } from "../scripts/serve.mjs";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "study-production-"));
  const root = join(directory, "dist");
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), "<title>Synthetic app</title>");
  await writeFile(
    join(root, "assets/main-abcdefgh.js"),
    "export const main = 1;",
  );
  await writeFile(join(root, "curriculum.json"), '{"synthetic":true}');
  await writeFile(join(directory, "secret"), "outside the build");
  await symlink(join(directory, "secret"), join(root, "escape.txt"));
  const bridge = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        path: req.url,
        origin: req.headers.origin,
        method: req.method,
        body: Buffer.concat(chunks).toString(),
      }),
    );
  });
  const bridgePort = await listen(bridge);
  let restarts = 0;
  const server = await createAppServer({
    directory: root,
    bridgePort,
    restartBridge: async () => {
      restarts++;
    },
  });
  const port = await listen(server);
  t.after(async () => {
    await close(server);
    await close(bridge);
    await rm(directory, { recursive: true, force: true });
  });
  return {
    server,
    bridge,
    port,
    url: `http://127.0.0.1:${port}`,
    restarts: () => restarts,
  };
}

test("production serves the built app with fresh HTML and immutable hashed assets", async (t) => {
  const { url } = await fixture(t);
  for (const path of ["/", "/index.html"]) {
    const response = await fetch(url + path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(await response.text(), /Synthetic/);
  }
  const asset = await fetch(url + "/assets/main-abcdefgh.js?v=1");
  assert.match(asset.headers.get("content-type"), /javascript/);
  assert.match(asset.headers.get("cache-control"), /immutable/);
  assert.equal(
    (await fetch(url + "/curriculum.json")).headers.get("cache-control"),
    "no-store",
  );
  const head = await fetch(url + "/", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const health = await (await fetch(url + "/_app-health")).json();
  assert.equal(health.service, "study-app");
  assert.match(health.build, /^[a-f0-9]{64}$/);
});

test("production refuses traversal, build symlinks, unknown hosts and static writes", async (t) => {
  const { url, port } = await fixture(t);
  for (const path of [
    "/missing",
    "/escape.txt",
    "/.env",
    "/%2e%2e%2fsecret",
    "/%5c..%5csecret",
    "/assets/",
  ]) {
    assert.equal((await fetch(url + path)).status, 404, path);
  }
  assert.equal((await fetch(url + "/%zz")).status, 400);
  const denied = await new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/status",
        headers: { Host: "attacker.invalid" },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(denied, 403);
  assert.equal((await fetch(url + "/", { method: "POST" })).status, 405);
});

test("production forwards exact API bodies/origins and reports relay outages", async (t) => {
  const { url, bridge, restarts } = await fixture(t);
  const body = JSON.stringify({ text: "Synthetic 🧟 evidence" });
  const response = await fetch(url + "/api/bridge?request=one", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: url },
    body,
  });
  assert.deepEqual(await response.json(), {
    path: "/api/bridge?request=one",
    origin: url,
    method: "POST",
    body,
  });
  await close(bridge);
  const down = await fetch(url + "/api/status");
  assert.equal(down.status, 502);
  // The client reads a JSON reason, and a dead bridge is relaunched.
  assert.match((await down.json()).error, /restarting/);
  assert.equal(restarts(), 1);
});

test("production refuses startup without a built entry point", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "study-no-build-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(createAppServer({ directory }), { code: "ENOENT" });
});
