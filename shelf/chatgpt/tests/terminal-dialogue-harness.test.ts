import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkBridge, ensureProblem, retryTutorRequest, send } from "../src/ai";
import { TestRunner } from "../src/gametest/runner";
import { emptyScenario } from "../src/gametest/schema";
import type { Roadmap } from "../src/model";
import { decode, encode, recover } from "../src/persistence";
// @ts-expect-error Real transport modules are JavaScript.
import { createHandoffQueue } from "../scripts/chatgpt-handoff-queue.mjs";
// @ts-expect-error Real transport modules are JavaScript.
import { createHandoffRoutes } from "../scripts/chatgpt-handoff-routes.mjs";
// @ts-expect-error Real transport modules are JavaScript.
import { createStudyBridgeServer } from "../scripts/study-bridge-server.mjs";
const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);

test("real relay and worker: chat follow-up, malformed correction, held sharing, reload retry and once-only key reward", async () => {
  const original = globalThis.fetch;
  const queue = createHandoffQueue();
  const server = createStudyBridgeServer({
    handoff: createHandoffRoutes(queue, {
      token: "synthetic-dialogue-harness",
    }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const post = async (body: unknown) =>
    original(base + "/api/handoff/worker", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer synthetic-dialogue-harness",
      },
      body: JSON.stringify(body),
    });
  const flights: Promise<void>[] = [];
  async function get() {
    for (let i = 0; i < 100; i++) {
      const response = await post({
        action: "get",
        worker: "synthetic-dialogue-consumer",
      });
      assert.equal(response.status, 200);
      const job = await response.json();
      if (job.status === "served") return job;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw Error("Synthetic request never reached the real worker route");
  }
  const submit = (job: any, answer: unknown) =>
    post({
      action: "submit",
      worker: "synthetic-dialogue-consumer",
      jobId: job.jobId,
      claim: job.claim,
      answer,
    });
  try {
    globalThis.fetch = async () =>
      Response.json({
        mode: "development",
        label: "Synthetic",
        detail: "No real AI",
        capabilities: [],
      });
    await checkBridge();
    const lab = new TestRunner(
      {
        ...emptyScenario(),
        id: "terminal-dialogue-harness",
        template: "building",
        layout: "forward",
        rules: "force-fields",
        simulation: "game",
        maxTicks: 1,
        checks: [
          {
            name: "Synthetic survivor remains alive",
            mode: "always",
            query: { type: "property", id: "human", field: "alive" },
            op: "eq",
            expected: true,
          },
        ],
      },
      roadmap,
    );
    let g = lab.game,
      e = g.encounters[g.floors[0].stations[0].encounter];
    assert.equal(
      e.runId,
      g.id,
      "GameTest encounter sessions must use the scenario run ID",
    );
    await ensureProblem(g, e, roadmap);
    e.owner = "human";
    const ledger = JSON.stringify(g.study.learner);
    globalThis.fetch = (url, options) =>
      original(new URL(String(url), base), {
        ...options,
        headers: { ...options?.headers, Origin: "http://127.0.0.1:5173" },
      });
    queue.enable(true);
    await checkBridge();
    const first = send(
      g,
      e,
      "tutor",
      "Synthetic prediction: the first window is largest",
      roadmap,
    );
    flights.push(first);
    const one = await get();
    assert.equal(one.operation, "tutor");
    assert.equal(one.payload.mode, "terminal-dialogue");
    assert.match(one.instructions, /^@study/);
    assert.match(one.instructions, /complete:boolean/);
    assert.match(one.payload.prompt, /^@study\n/);
    assert.deepEqual(one.payload.problem, e.problem);
    assert.equal(
      (await submit(one, { text: "Forgot the decision" })).status,
      409,
    );
    assert.equal(
      (await get()).claim,
      one.claim,
      "rejected schema must retain the correction claim",
    );
    const followup = {
      text: "Which reading leaves, and which enters?",
      complete: false,
    };
    assert.equal((await submit(one, followup)).status, 200);
    await first;
    assert.equal(e.tutorRequests![0].state, "applied");
    assert.equal(e.submissions.length, 0);
    assert.equal(g.survivors[0].keys, 0);
    assert.equal(
      (await (await submit(one, followup)).json()).status,
      "duplicate",
    );

    // Revoking sharing during a real claimed request must not leak a late reward.
    const interrupted = send(
      g,
      e,
      "tutor",
      "Synthetic explanation: subtract outgoing and add incoming; check final full window",
      roadmap,
    );
    flights.push(interrupted);
    const two = await get();
    assert.equal(two.payload.messages.length, 3);
    assert.equal(two.payload.messages[1].text, followup.text);
    const context = JSON.stringify(two.payload);
    queue.enable(false);
    assert.equal(
      (await submit(two, { text: "Solved", complete: true })).status,
      409,
    );
    await interrupted;
    queue.releaseWorker("synthetic-dialogue-consumer");
    assert.equal(e.tutorRequests!.at(-1)!.state, "interrupted");
    assert.equal(e.state === "consumed", false);
    assert.equal(g.survivors[0].keys, 0);

    // The held job is reused byte-for-byte after an in-memory save/reload.
    g = recover(decode(encode(g)));
    e = g.encounters[e.id];
    queue.enable(true);
    await checkBridge();
    const resumed = retryTutorRequest(
      g,
      e,
      e.tutorRequests!.at(-1)!.id,
      roadmap,
    );
    flights.push(resumed);
    const retry = await get();
    assert.equal(retry.jobId, two.jobId);
    assert.equal(JSON.stringify(retry.payload), context);
    assert.notEqual(retry.claim, two.claim);
    const solved = {
      text: "Solved: the accumulated explanation covers the rubric.",
      complete: true,
    };
    assert.equal((await submit(retry, solved)).status, 200);
    await resumed;
    assert.equal(e.state, "consumed");
    assert.equal(g.survivors[0].keys, 1);
    assert.ok(g.survivors[0].access.includes(e.floor));
    assert.equal(e.submissions.length, 1);
    assert.match(e.submissions[0].content, /Synthetic prediction/);
    assert.match(e.submissions[0].content, /Synthetic explanation/);
    assert.doesNotMatch(e.submissions[0].content, /Which reading leaves/);
    assert.equal(
      JSON.stringify(g.study.learner),
      ledger,
      "development gameplay must not award mastery",
    );
    assert.equal(
      (await (await submit(retry, solved)).json()).status,
      "duplicate",
    );
    await retryTutorRequest(g, e, e.tutorRequests!.at(-1)!.id, roadmap);
    assert.equal(g.survivors[0].keys, 1);
    assert.equal(e.submissions.length, 1);
    assert.equal(queue.snapshot().queued, 0);
    assert.equal(queue.snapshot().working, 0);
    assert.equal(queue.snapshot().done, 2);
  } finally {
    queue.enable(false);
    await Promise.allSettled(flights);
    globalThis.fetch = async () =>
      Response.json({
        mode: "development",
        label: "Synthetic cleanup",
        detail: "No real AI",
        capabilities: [],
      });
    await checkBridge();
    globalThis.fetch = original;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(resolve));
  }
});
