import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkBridge, ensureProblem, retryTutorRequest, send } from "../src/ai";
import { TestRunner } from "../src/gametest/runner";
import { emptyScenario } from "../src/gametest/schema";
import type { Roadmap } from "../src/model";
import { decode, encode, recover } from "../src/persistence";
import { localHandoff } from "./helpers/local-handoff";
const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);

test("real bridge and gateway: chat follow-up, malformed correction, interrupted reply, reload retry and once-only key reward", async () => {
  const original = globalThis.fetch;
  const relay = await localHandoff();
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
      original(new URL(String(url), relay.base), {
        ...options,
        headers: { ...options?.headers, Origin: "http://127.0.0.1:5173" },
      });
    await checkBridge();
    const jobs: any[] = [];
    const followup = {
      text: "Which reading leaves, and which enters?",
      complete: false,
    };
    relay.answerWith((job) => {
      jobs.push(job);
      return {
        valid: followup,
        invalid: [{ text: "Forgot the decision" }],
      };
    });
    await send(
      g,
      e,
      "tutor",
      "Synthetic prediction: the first window is largest",
      roadmap,
    );
    const one = jobs[0];
    assert.equal(one.operation, "tutor");
    assert.equal(one.payload.mode, "terminal-dialogue");
    assert.equal(
      one.payload.prompt.startsWith("@study"),
      false,
      "the prompt is plain text with no retired chat prefix",
    );
    assert.deepEqual(one.payload.problem, e.problem);
    assert.equal(relay.rejected, 1, "the malformed answer was refused");
    assert.equal(e.tutorRequests![0].state, "applied");
    assert.equal(e.submissions.length, 0);
    assert.equal(g.survivors[0].keys, 0);

    // A failed gateway call must not leak a reward and keeps the exact request.
    relay.answerWith((job) => {
      jobs.push(job);
      throw Error("Synthetic gateway outage");
    });
    await send(
      g,
      e,
      "tutor",
      "Synthetic explanation: subtract outgoing and add incoming; check final full window",
      roadmap,
    );
    const two = jobs[1];
    assert.equal(two.payload.messages.length, 3);
    assert.equal(two.payload.messages[1].text, followup.text);
    const context = JSON.stringify(two.payload);
    assert.notEqual(e.tutorRequests!.at(-1)!.state, "applied");
    assert.equal(e.state === "consumed", false);
    assert.equal(g.survivors[0].keys, 0);

    // The held request is reused byte-for-byte after an in-memory save/reload.
    g = recover(decode(encode(g)));
    e = g.encounters[e.id];
    await checkBridge();
    const solved = {
      text: "Solved: the accumulated explanation covers the rubric.",
      complete: true,
    };
    relay.answerWith((job) => {
      jobs.push(job);
      return { valid: solved };
    });
    await retryTutorRequest(g, e, e.tutorRequests!.at(-1)!.id, roadmap);
    const retry = jobs[2];
    assert.equal(JSON.stringify(retry.payload), context);
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
    await retryTutorRequest(g, e, e.tutorRequests!.at(-1)!.id, roadmap);
    assert.equal(g.survivors[0].keys, 1);
    assert.equal(e.submissions.length, 1);
    assert.equal(jobs.length, 3, "an applied reply is never requested again");
  } finally {
    globalThis.fetch = async () =>
      Response.json({
        mode: "development",
        label: "Synthetic cleanup",
        detail: "No real AI",
        capabilities: [],
      });
    await checkBridge();
    globalThis.fetch = original;
    await relay.close();
  }
});
