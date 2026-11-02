// Isolated real loopback transport with a fake gateway; never the user's bridge.
// The gateway's answers run through the real operation validators, so a test
// still proves what the game would accept from the Claude CLI.
import assert from "node:assert/strict";
// @ts-expect-error Actual validators are intentionally plain JavaScript.
import { validateAnswer } from "../../scripts/lib/ai-contracts.mjs";
// @ts-expect-error Actual relay module is intentionally plain JavaScript.
import { createStudyBridgeServer } from "../../scripts/study-bridge-server.mjs";

type Job = { operation: string; payload: any };
type Reply = { valid: unknown; invalid?: unknown[] };

export async function localHandoff() {
  let completed = 0;
  let answer: ((job: Job) => Reply) | undefined;
  const rejected: string[] = [];
  const server = createStudyBridgeServer({
    claude: {
      enabled: () => true,
      async run(operation: string, payload: unknown) {
        assert.ok(answer, "No answer is registered for this gateway call");
        const job: Job = {
          operation,
          payload: JSON.parse(JSON.stringify(payload)),
        };
        const reply = answer(job);
        for (const invalid of reply.invalid ?? []) {
          assert.throws(
            () => validateAnswer(job, invalid),
            Error,
            "The gateway must reject this answer",
          );
          rejected.push(operation);
        }
        validateAnswer(job, reply.valid);
        completed++;
        return reply.valid;
      },
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  return {
    base,
    /** Gateway calls that returned a validated answer, and answers it rejected. */
    get completed() {
      return completed;
    },
    get rejected() {
      return rejected.length;
    },
    /** Register the gateway's answer for requests sent by the game client. */
    answerWith(reply: (job: Job) => Reply) {
      answer = reply;
    },
    async request(
      operation: string,
      payload: unknown,
      reply: (job: Job) => Reply,
    ) {
      answer = reply;
      const response = await fetch(base + "/api/bridge", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://127.0.0.1:5173",
        },
        body: JSON.stringify({ operation, payload }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(resolve));
    },
  };
}
