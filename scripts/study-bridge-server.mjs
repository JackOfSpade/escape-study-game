import { HttpInputError, readJsonBody } from "./http-json.mjs";
import { createServer } from "node:http";
import { executionRoute } from "./execution-route.mjs";
import {
  autonomousHandoff,
  HANDOFF_OPERATIONS,
} from "./chatgpt-handoff-queue.mjs";

/** Construct the actual loopback relay without launching Vite, for isolated transport verification. */
export function createStudyBridgeServer({
  endpoint,
  key,
  handoff,
  speech,
  claude,
} = {}) {
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
      if (speech && (await speech.route(req, res))) return;
      if (handoff && (await handoff.route(req, res))) return;
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
              capabilities: HANDOFF_OPERATIONS,
              detail:
                "AI tasks run through the signed-in Claude CLI on this computer.",
            }),
          );
          return;
        }
        let status = {
          mode: "development",
          label: "Development fallback",
          capabilities: [],
          detail:
            "No direct ChatGPT Study Mode bridge configured. No real academic credit.",
        };
        if (handoff?.enabled()) {
          status = handoff.status();
        } else if (endpoint) {
          try {
            const reply = await fetch(
              new URL(
                "capabilities",
                endpoint.endsWith("/") ? endpoint : endpoint + "/",
              ),
              {
                headers: key ? { Authorization: `Bearer ${key}` } : {},
                signal: AbortSignal.timeout(5000),
              },
            );
            if (!reply.ok) throw Error(`HTTP ${reply.status}`);
            const c = await reply.json();
            if (
              c.mode !== "study-mode" ||
              !["generate", "tutor", "complete", "assess", "group"].every((x) =>
                c.capabilities?.includes(x),
              )
            )
              throw Error(
                "Bridge must explicitly attest Study Mode and all required capabilities",
              );
            status = {
              mode: "study-mode",
              label: "Configured Study Mode bridge",
              capabilities: c.capabilities,
              detail:
                "Bridge capability handshake succeeded. Provider identity must be verified by the integration owner.",
            };
          } catch (err) {
            status.detail = `Configured bridge unavailable: ${String(err)}. Reconnect required; local development mode only.`;
          }
        }
        res.end(JSON.stringify(status));
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
          !HANDOFF_OPERATIONS.includes(parsed.operation)
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
        try {
          const answer = await claude.run(parsed.operation, parsed.payload, {
            signal: cancel.signal,
          });
          res.end(JSON.stringify(answer));
        } catch (error) {
          if (res.destroyed) return;
          res.writeHead(error.status ?? 502);
          res.end(JSON.stringify({ error: error.message, code: error.code }));
        }
        return;
      }
      if (req.url === "/api/bridge" && req.method === "POST") {
        if (!endpoint && !handoff?.enabled()) {
          res.writeHead(503);
          res.end(
            JSON.stringify({
              error: "Native Study Mode bridge not configured",
            }),
          );
          return;
        }
        const parsed = await readJsonBody(req);
        if (
          !parsed ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          !HANDOFF_OPERATIONS.includes(parsed.operation)
        )
          throw new HttpInputError(400, "Unknown operation");
        // Bind captured packets at the actual forwarding boundary as well as in
        // the client. A stale status snapshot must never disclose a saved job
        // to the other provider. Legacy optional jobs were native-only.
        const optional =
          autonomousHandoff(parsed.operation, parsed.payload) ||
          [
            "materialize-work",
            "materialize-outcome",
            "review-environment",
          ].includes(parsed.operation) ||
          (parsed.operation === "group" &&
            parsed.payload?.mode === "catch-up") ||
          (parsed.operation === "complete" &&
            parsed.payload?.mode === "retrospective-npc-outcome");
        const provider =
          parsed.payload?.provider ?? (optional ? "study-mode" : undefined);
        const actualProvider = handoff?.enabled()
          ? "chatgpt-handoff"
          : "study-mode";
        if (
          parsed.operation === "design-run" &&
          actualProvider !== "chatgpt-handoff"
        ) {
          res.writeHead(409);
          res.end(
            JSON.stringify({
              error: "Run designs require the ChatGPT handoff",
            }),
          );
          return;
        }
        if (
          (provider !== undefined && provider !== actualProvider) ||
          (parsed.provider !== undefined && parsed.provider !== actualProvider)
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
        if (handoff?.enabled()) {
          if (
            !/^http:\/\/(127\.0\.0\.1|localhost):5173$/.test(
              req.headers.origin ?? "",
            )
          ) {
            res.writeHead(403);
            res.end(
              JSON.stringify({
                error: "Release game handoffs from the game UI",
              }),
            );
            return;
          }
          handoff.enqueue(
            req,
            res,
            parsed.operation,
            parsed.payload,
            parsed.nativeScope,
            parsed.chatCode,
          );
          return;
        }
        const response = await fetch(
          new URL(
            parsed.operation,
            endpoint.endsWith("/") ? endpoint : endpoint + "/",
          ),
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(key ? { Authorization: `Bearer ${key}` } : {}),
            },
            body: JSON.stringify(parsed.payload),
            signal: AbortSignal.timeout(40000),
          },
        );
        const text = await response.text();
        JSON.parse(text);
        res.writeHead(response.status);
        res.end(text);
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
