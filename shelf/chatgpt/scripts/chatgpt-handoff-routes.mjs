import { HttpInputError, readJsonBody } from "./http-json.mjs";
import { randomBytes } from "node:crypto";
import { writeFileSync, renameSync } from "node:fs";
import { safeEqual } from "./lib/safe-equal.mjs";
import {
  HANDOFF_OPERATIONS,
  legacyWorkerJob,
} from "./chatgpt-handoff-queue.mjs";

export function createHandoffRoutes(
  queue,
  {
    tokenFile,
    token = randomBytes(32).toString("hex"),
    publicBridge,
    supervisor,
  } = {},
) {
  if (tokenFile) {
    const tmp = tokenFile + "." + randomBytes(8).toString("hex") + ".tmp";
    writeFileSync(tmp, token, { mode: 0o600, flag: "wx" });
    renameSync(tmp, tokenFile);
  }
  const sameToken = (req) =>
    safeEqual(String(req.headers.authorization ?? ""), `Bearer ${token}`);
  const send = (res, code, value) => {
    res.writeHead(code);
    res.end(JSON.stringify(value));
  };
  return {
    status() {
      return {
        mode: "chatgpt-handoff",
        label: "ChatGPT handoff",
        capabilities: [
          ...HANDOFF_OPERATIONS,
          "retrospective-group",
          // Native ChatGPT conversation for a tutor question (mode
          // terminal-direct) finished once via finish_study_question.
          "direct-study",
          "topic-assessments",
          ...(queue.snapshot().autonomousWork ? ["autonomous-work"] : []),
        ],
        detail:
          "Local ChatGPT handoff is enabled. Live study actions you release include observed team notes and group catch-up. Unattended NPC drafts, code runs and submissions require a separate local opt-in. Replies are validated locally. Native ChatGPT Study Mode is not verified; no OpenAI API calls are made by this bridge.",
      };
    },
    enabled: () => queue.snapshot().enabled,
    async route(req, res) {
      const url = new URL(req.url, "http://127.0.0.1");
      if (
        ![
          "/api/handoff/status",
          "/api/handoff/control",
          "/api/handoff/worker",
          "/api/bridge/result",
        ].includes(url.pathname)
      )
        return false;
      try {
        if (url.pathname === "/api/handoff/status" && req.method === "GET") {
          send(res, 200, {
            ...queue.snapshot(),
            capabilities: ["direct-study"],
            public: publicBridge?.status() ?? { configured: false },
            tunnel: supervisor?.status() ?? { state: "off", verified: false },
          });
          return true;
        }
        if (url.pathname === "/api/handoff/control" && req.method === "POST") {
          // The game UI may release private learning packets. A random website,
          // an untrusted sibling localhost app and a worker cannot authorize it.
          if (
            !/^http:\/\/(127\.0\.0\.1|localhost):5173$/.test(
              req.headers.origin ?? "",
            )
          ) {
            send(res, 403, {
              error: "Use the game's settings to release handoffs",
            });
            return true;
          }
          const body = await readJsonBody(req);
          if (body.action === "enable")
            send(res, 200, queue.enable(body.enabled));
          else if (body.action === "autonomous")
            send(res, 200, queue.setAutonomous(body.enabled));
          else if (body.action === "reopen")
            send(res, 200, queue.reopen(body.jobId));
          else if (body.action === "requeue")
            send(res, 200, queue.requeueWorking());
          else if (body.action === "pair" && publicBridge)
            send(res, 200, publicBridge.openPairing());
          else if (body.action === "close-pair" && publicBridge)
            send(res, 200, publicBridge.closePairing());
          else if (body.action === "worker" && publicBridge)
            send(res, 200, publicBridge.newWorker(body.requestPrefix));
          else if (body.action === "stop-worker" && publicBridge)
            send(res, 200, publicBridge.stopWorker());
          else if (body.action === "revoke" && publicBridge)
            send(res, 200, publicBridge.revoke());
          else if (body.action === "start-public" && supervisor) {
            if (!publicBridge?.server.listening)
              throw Error(
                "The protected game connector socket is unavailable; restart the local server",
              );
            send(res, 200, supervisor.start());
          } else if (body.action === "stop-public" && supervisor) {
            queue.enable(false);
            send(res, 200, await supervisor.stop());
          } else throw Error("Unknown or unconfigured handoff control");
          return true;
        }
        if (url.pathname === "/api/handoff/worker" && req.method === "POST") {
          if (!sameToken(req) || req.headers.origin) {
            send(res, 403, { error: "Worker authorization required" });
            return true;
          }
          const body = await readJsonBody(req);
          if (body.action === "get") {
            let result = queue.get(body.worker, undefined, legacyWorkerJob);
            // Keep an idle worker waiting without spinning through model calls.
            // The bounded wait does not hold the game simulation or other routes.
            const end =
              Date.now() +
              Math.min(25_000, Math.max(0, Number(body.waitMs) || 0));
            while (
              result.status === "waiting" &&
              Date.now() < end &&
              !res.destroyed
            ) {
              await new Promise((resolve) => setTimeout(resolve, 250));
              result = queue.get(body.worker, undefined, legacyWorkerJob);
            }
            if (!res.destroyed) send(res, 200, result);
          } else if (body.action === "part")
            send(
              res,
              200,
              queue.part(body.worker, body.jobId, body.claim, body.index),
            );
          else if (body.action === "submit")
            send(
              res,
              200,
              queue.submit(body.worker, body.jobId, body.claim, body.answer),
            );
          else throw Error("Unknown worker action");
          return true;
        }
        if (url.pathname === "/api/bridge/result" && req.method === "GET") {
          const result = queue.result(
            url.searchParams.get("id"),
            url.searchParams.get("hash"),
          );
          send(
            res,
            result.status === "done" ? 200 : 202,
            result.status === "done"
              ? result.answer
              : {
                  status: "pending",
                  handoff: queue.progress(
                    url.searchParams.get("id"),
                    url.searchParams.get("hash"),
                  ),
                },
          );
          return true;
        }
        if (url.pathname === "/api/bridge/result" && req.method === "DELETE") {
          if (
            !/^http:\/\/(127\.0\.0\.1|localhost):5173$/.test(
              req.headers.origin ?? "",
            )
          ) {
            send(res, 403, {
              error: "Cancel optional game requests from the game UI",
            });
            return true;
          }
          send(
            res,
            200,
            (url.searchParams.get("operation") === "design-run"
              ? queue.discardDesign
              : queue.discardChatter)(
              url.searchParams.get("id"),
              url.searchParams.get("hash"),
            ),
          );
          return true;
        }
        send(res, 405, { error: "Method not allowed" });
      } catch (error) {
        send(res, error instanceof HttpInputError ? error.status : 409, {
          error: error.message,
        });
      }
      return true;
    },
    enqueue(req, res, operation, payload, nativeScope, chatCode) {
      const handoff = queue.enqueue(operation, payload, nativeScope, chatCode);
      send(res, 202, { status: "pending", handoff });
    },
  };
}
