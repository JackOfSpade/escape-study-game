import { sha256 } from "./lib/digest.mjs";
import { createServer, request } from "node:http";
import { open, readFile, realpath } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureBridge } from "./bridge-service.mjs";

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".woff2": "font/woff2",
  ".md": "text/markdown; charset=utf-8",
};

/** Serve only a built client, keeping the existing browser origin and saves.
 * The bridge retains ownership of its credentials, queue and API validation. */
export async function createAppServer({
  directory = fileURLToPath(new URL("../dist", import.meta.url)),
  bridgePort = 4318,
  restartBridge,
} = {}) {
  // A bridge that died after startup is relaunched on the next API call.
  let restarting = null;
  const reviveBridge = () => {
    if (!restartBridge) return;
    restarting ??= Promise.resolve()
      .then(restartBridge)
      .catch((error) =>
        console.error(`Study bridge restart failed: ${error.message}`),
      )
      .finally(() => (restarting = null));
  };
  const root = await realpath(directory);
  const build = sha256(await readFile(resolve(root, "index.html")));
  return createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    const fail = (code, text) => {
      if (res.destroyed) return;
      if (res.headersSent) return res.destroy();
      res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(text);
    };
    // Loopback binding plus Host validation prevents DNS-rebinding access.
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? ""))
      return fail(403, "Host denied");
    if (req.url?.startsWith("/api/")) {
      const proxy = request(
        {
          hostname: "127.0.0.1",
          port: bridgePort,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: `127.0.0.1:${bridgePort}` },
        },
        (upstream) => {
          res.writeHead(upstream.statusCode ?? 502, upstream.headers);
          upstream.on("error", () => res.destroy());
          upstream.pipe(res);
        },
      );
      // An AI task legitimately outlasts this; the gateway enforces its own limit.
      if (req.url !== "/api/bridge")
        proxy.setTimeout(65_000, () => proxy.destroy());
      proxy.on("error", () => {
        reviveBridge();
        if (res.destroyed) return;
        if (res.headersSent) return res.destroy();
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error:
              "Study bridge unavailable; it is restarting. Retry in a moment.",
          }),
        );
      });
      req.on("aborted", () => proxy.destroy());
      res.on("close", () => proxy.destroy());
      req.pipe(proxy);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      return fail(405, "Method not allowed");
    }
    if (req.url === "/_app-health") {
      res.setHeader("Content-Type", "application/json");
      return res.end(
        req.method === "HEAD"
          ? undefined
          : JSON.stringify({ service: "zombie-study-escape", build }),
      );
    }
    let file;
    try {
      const pathname = decodeURIComponent((req.url ?? "/").split("?")[0]);
      if (
        !pathname.startsWith("/") ||
        pathname.includes("\0") ||
        pathname.includes("\\") ||
        pathname.split("/").some((part) => part.startsWith("."))
      )
        return fail(404, "Not found");
      const path = await realpath(
        resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`),
      );
      if (!path.startsWith(root + sep)) return fail(404, "Not found");
      file = await open(path, "r");
      const stat = await file.stat();
      if (!stat.isFile()) {
        await file.close();
        return fail(404, "Not found");
      }
      res.setHeader(
        "Content-Type",
        mime[extname(path)] ?? "application/octet-stream",
      );
      res.setHeader("Content-Length", stat.size);
      // Hashed assets are safe to retain; HTML and curriculum always revalidate.
      if (/\/assets\/[^/]+-[\w-]{8,}\.[\w]+$/.test(pathname))
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      if (req.method === "HEAD") {
        await file.close();
        return res.end();
      }
      const stream = file.createReadStream();
      stream.on("error", () => res.destroy());
      res.on("close", () => stream.destroy());
      stream.pipe(res);
    } catch (error) {
      await file?.close().catch(() => {});
      fail(error instanceof URIError ? 400 : 404, "Not found");
    }
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const port = Number(process.env.PORT ?? 5173);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error("Invalid app port");
  // Validate the build before starting or reconnecting any background service.
  const server = await createAppServer({ restartBridge: () => ensureBridge() });
  await ensureBridge();
  server.listen(port, "127.0.0.1", () =>
    console.log(`Production game: http://127.0.0.1:${port}`),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      server.closeAllConnections();
      server.close();
    });
}
