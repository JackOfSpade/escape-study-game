import { HttpInputError, readJsonBody } from "./http-json.mjs";
import { createServer } from "node:http";
import { executionRoute } from "./execution-route.mjs";
import { AI_OPERATIONS } from "./lib/ai-contracts.mjs";

/** Construct the actual loopback relay without launching Vite, for isolated transport verification. */
export function createStudyBridgeServer({ speech, claude, control } = {}) {
  return createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    // Local relay is deliberately loopback-only and rejects cross-origin mutation.
    const origin = req.headers.origin;
    if (
      origin &&
      !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin) &&
      !/^http:\/\/localhost:\d+$/.test(origin)
    ) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: "Origin denied" }));
      return;
    }
    try {
      if (control?.route(req, res)) return;
      if (speech && (await speech.route(req, res))) return;
      if (req.url === "/api/execute") {
        await executionRoute(req, res);
        return;
      }
      if (req.url === "/api/status" && req.method === "GET") {
        if (claude?.enabled()) {
          res.end(
            JSON.stringify({
              mode: "claude-cli",
              label: "Claude CLI",
              capabilities: AI_OPERATIONS,
              detail:
                "AI tasks run through the signed-in Claude CLI on this computer.",
            }),
          );
          return;
        }
        res.end(
          JSON.stringify({
            mode: "development",
            label: "Development fallback",
            capabilities: [],
            detail:
              "No AI gateway is running. Start the Claude CLI gateway; until then no real academic credit.",
          }),
        );
        return;
      }
      if (
        req.url === "/api/bridge" &&
        req.method === "POST" &&
        claude?.enabled()
      ) {
        const parsed = await readJsonBody(req);
        if (
          !parsed ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          !AI_OPERATIONS.includes(parsed.operation)
        )
          throw new HttpInputError(400, "Unknown operation");
        // A saved request belongs to the provider that captured it.
        if (
          [parsed.provider, parsed.payload?.provider].some(
            (p) => p !== undefined && p !== "claude-cli",
          )
        ) {
          res.writeHead(409);
          res.end(
            JSON.stringify({
              error:
                "Reconnect the captured request's original provider; nothing was forwarded",
            }),
          );
          return;
        }
        const cancel = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) cancel.abort();
        });
        const streaming = parsed.stream === true;
        if (streaming)
          res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        const line = (value) => res.write(`${JSON.stringify(value)}\n`);
        try {
          const answer = await claude.run(parsed.operation, parsed.payload, {
            signal: cancel.signal,
            ...(streaming ? { onText: (text) => line({ text }) } : {}),
          });
          if (streaming) {
            line({ answer });
            res.end();
          } else res.end(JSON.stringify(answer));
        } catch (error) {
          if (res.destroyed) return;
          if (streaming) {
            line({ error: error.message, code: error.code });
            res.end();
            return;
          }
          res.writeHead(error.status ?? 502);
          res.end(JSON.stringify({ error: error.message, code: error.code }));
        }
        return;
      }
      if (req.url === "/api/bridge" && req.method === "POST") {
        res.writeHead(503);
        res.end(JSON.stringify({ error: "AI gateway not configured" }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (err) {
      res.writeHead(err instanceof HttpInputError ? err.status : 502);
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
}
