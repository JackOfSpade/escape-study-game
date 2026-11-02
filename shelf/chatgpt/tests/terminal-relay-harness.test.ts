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
// @ts-expect-error Real transport modules are JavaScript.
import { createTerminalRelayApp } from "../scripts/terminal-relay-app.mjs";
const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
const owner = { linkId: "synthetic-relay-owner" };

test("real game client, relay and embedded terminal app: host turns replace the polling worker with the same once-only reward", async () => {
  const original = globalThis.fetch;
  const queue = createHandoffQueue();
  const server = createStudyBridgeServer({
    handoff: createHandoffRoutes(queue, { token: "synthetic-relay-harness" }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  let app = createTerminalRelayApp({ queue });
  const call = (name: string, args: Record<string, unknown>) =>
    app.call(name, args, owner).structuredContent;
  let relay = call("open_study_terminal", {});
  async function claimTurn() {
    for (let i = 0; i < 200; i++) {
      relay = call("claim_study_terminal_turn", {
        relayId: relay.relayId,
        revision: relay.revision,
      });
      if (relay.turn?.status === "claimed") return relay.turn;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw Error("The game's terminal turn never reached the embedded app");
  }
  const reply = (
    turnId: string,
    text: string,
    complete: boolean,
    extra: Record<string, unknown> = {},
  ) =>
    call("reply_study_terminal_job", {
      relayId: relay.relayId,
      turnId,
      text,
      complete,
      ...extra,
    });
  const flights: Promise<void>[] = [];
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
        id: "terminal-relay-harness",
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
    await ensureProblem(g, e, roadmap);
    e.owner = "human";
    const ledger = JSON.stringify(g.study.learner);
    globalThis.fetch = (url, options) =>
      original(new URL(String(url), base), {
        ...options,
        headers: { ...options?.headers, Origin: "http://127.0.0.1:5173" },
      });
    // Nothing is claimable before the player releases sharing in Settings.
    relay = call("claim_study_terminal_turn", {
      relayId: relay.relayId,
      revision: relay.revision,
    });
    assert.equal(relay.turn, null);
    assert.equal(relay.released, false);
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
    const one = await claimTurn();
    assert.match(one.prompt, /^@study\n/);
    const packet = JSON.parse(one.prompt.split("\n").slice(2).join("\n"));
    assert.deepEqual(packet.question.rubric, e.problem!.rubric);
    assert.equal(packet.question.prompt, e.problem!.prompt);
    assert.deepEqual(packet.learning, e.problem!.contract);
    assert.match(packet.instruction, /^@study/);
    assert.equal(packet.messages.length, 1);
    assert.equal(packet.messages[0].text, one.messages[0].text);
    assert.match(packet.messages[0].text, /Synthetic prediction/);
    assert.throws(() =>
      reply(one.turnId, "Forgot the decision", "yes" as never),
    );
    reply(one.turnId, "Which reading leaves, and which enters?", false);
    await first;
    assert.equal(e.tutorRequests![0].state, "applied");
    assert.equal(
      e.tutor.at(-1)!.text,
      "Which reading leaves, and which enters?",
    );
    assert.equal(e.submissions.length, 0);
    assert.equal(g.survivors[0].keys, 0);

    // Stopping sharing mid-turn requeues the claim; no late reward can leak.
    const interrupted = send(
      g,
      e,
      "tutor",
      "Synthetic explanation: subtract outgoing and add incoming; check final full window",
      roadmap,
    );
    flights.push(interrupted);
    const two = await claimTurn();
    assert.equal(two.messages.length, 3);
    assert.equal(two.messages[1].role, "tutor");
    queue.enable(false);
    assert.throws(() => reply(two.turnId, "Solved", true), /disabled/);
    await interrupted;
    app.release();
    assert.equal(e.tutorRequests!.at(-1)!.state, "interrupted");
    assert.equal(g.survivors[0].keys, 0);
    assert.equal(queue.snapshot().queued, 1);

    // Save/reload the game and restart the relay app: the exact saved request
    // is retried and recovered as a fresh turn for the same job.
    g = recover(decode(encode(g)));
    e = g.encounters[e.id];
    queue.enable(true);
    await checkBridge();
    app = createTerminalRelayApp({ queue });
    relay = call("open_study_terminal", {});
    const resumed = retryTutorRequest(
      g,
      e,
      e.tutorRequests!.at(-1)!.id,
      roadmap,
    );
    flights.push(resumed);
    const retry = await claimTurn();
    assert.equal(retry.requestId, two.requestId);
    assert.notEqual(retry.turnId, two.turnId);
    assert.equal(retry.messages.length, 3);
    const retryPacket = JSON.parse(
      retry.prompt.split("\n").slice(2).join("\n"),
    );
    assert.match(retryPacket.probe.stance, /Assume the learner already has/);
    const facetIds = retryPacket.probe.facets.map((f: { id: string }) => f.id);
    assert.ok(facetIds.length >= 2);
    const concession = {
      outcome: "gap",
      knowledge: {
        facets: [
          { id: facetIds[0], status: "demonstrated" },
          { id: facetIds[1], status: "gap", note: "learner declared it" },
        ],
        signal: { fluency: "declared-gap" },
      },
    };
    reply(
      retry.turnId,
      "Solved: the accumulated explanation covers it.",
      true,
      concession,
    );
    await resumed;
    assert.equal(e.state, "consumed");
    assert.equal(g.survivors[0].keys, 1);
    assert.ok(g.survivors[0].access.includes(e.floor));
    assert.equal(e.submissions.length, 1);
    assert.match(
      e.submissions[0].feedback,
      /Key conceded on a declared knowledge gap/,
    );
    assert.equal(g.study.knowledgeGaps?.length, 1);
    assert.equal(g.study.knowledgeGaps![0].facet.id, facetIds[1]);
    assert.match(g.study.knowledgeGaps![0].statement, /Synthetic explanation/);
    assert.equal(e.probe!.turns.length, 2);
    assert.equal(e.probe!.turns[1].signal?.fluency, "declared-gap");
    assert.match(e.submissions[0].content, /Synthetic prediction/);
    assert.match(e.submissions[0].content, /Synthetic explanation/);
    assert.doesNotMatch(e.submissions[0].content, /Which reading leaves/);
    assert.equal(
      JSON.stringify(g.study.learner),
      ledger,
      "development gameplay must not award mastery",
    );
    // Duplicate replies and retries never award a second key.
    assert.deepEqual(
      reply(
        retry.turnId,
        "Solved: the accumulated explanation covers it.",
        true,
        concession,
      ).answered,
      1,
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
