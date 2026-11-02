import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  checkBridge,
  edit,
  ensureProblem,
  retrySubmission,
  send,
  submit,
} from "../src/ai";
import { completionVerdict } from "../src/completion-verdict";
import { submissionView, terminalChannel } from "../src/terminal-view";
import type { Roadmap } from "../src/model";
import { createGame } from "../src/world";
const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
async function transport(
  run: (
    set: (
      connected: boolean,
      reply?: (p: any) => Promise<Response>,
    ) => Promise<void>,
  ) => Promise<void>,
) {
  const original = globalThis.fetch;
  let connected = false;
  let reply = async (_p: any) =>
    Response.json({ error: "No synthetic handler" }, { status: 503 });
  globalThis.fetch = async (url, init) =>
    String(url) === "/api/status"
      ? Response.json({
          mode: connected ? "claude-cli" : "development",
          label: "Synthetic transport",
          detail: "No external AI",
          capabilities: connected ? ["complete", "tutor", "group"] : [],
        })
      : reply(JSON.parse(String(init?.body)));
  const set = async (value: boolean, handler?: typeof reply) => {
    connected = value;
    if (handler) reply = handler;
    await checkBridge();
  };
  try {
    await set(false);
    await run(set);
  } finally {
    await set(false);
    globalThis.fetch = original;
  }
}
async function fixture() {
  const g = createGame(701, roadmap),
    e = g.encounters["f0-room0"];
  await ensureProblem(g, e, roadmap);
  assert.equal(e.problem!.provenance, "development");
  return { g, e };
}
test("offline answers never pass heuristics; captured content retries independently of later edits", async () =>
  transport(async (set) => {
    const { g, e } = await fixture();
    const learning = JSON.stringify(g.study.learner!.evidence);
    edit(
      g,
      e,
      "Prediction: 999. Reasoning: " + "long answer with headings ".repeat(30),
      e.revision,
      roadmap,
    );
    await submit(g, e, roadmap);
    const s = e.submissions[0];
    assert.equal(s.status, "error");
    assert.equal(submissionView(e).label, "Unable to check");
    assert.notEqual(e.state, "consumed");
    assert.deepEqual(g.survivors[0].access, []);
    const captured = s.content;
    edit(g, e, "Later unsent draft", e.revision, roadmap);
    await set(true, async (request) => {
      assert.equal(request.operation, "complete");
      assert.equal(request.payload.submission.content, captured);
      assert.equal(request.payload.requestId, s.id);
      assert.equal(request.payload.responseFormat.complete, "boolean");
      return Response.json({
        complete: false,
        feedback: "Synthetic rejection",
        qualified: [],
      });
    });
    await retrySubmission(g, e, roadmap, s.id);
    assert.equal(s.status, "needs-work");
    assert.equal(submissionView(e).label, "Not accepted");
    assert.equal(e.workspace, "Later unsent draft");
    assert.equal(JSON.stringify(g.study.learner!.evidence), learning);
  }));
test("only structured AI acceptance consumes development practice, without granting academic credit", async () =>
  transport(async (set) => {
    const { g, e } = await fixture();
    const evidence = JSON.stringify(g.study.learner!.evidence);
    let release!: (r: Response) => void;
    await set(
      true,
      async () => new Promise<Response>((resolve) => (release = resolve)),
    );
    edit(g, e, "Fictional answer", e.revision, roadmap);
    const pending = submit(g, e, roadmap);
    assert.equal(submissionView(e).label, "Checking answer…");
    assert.notEqual(e.state, "consumed");
    release(
      Response.json({
        complete: true,
        feedback: "Synthetic acceptance only",
        qualified: ["human"],
      }),
    );
    await pending;
    assert.equal(submissionView(e).label, "Accepted");
    assert.equal(e.state, "consumed");
    assert.equal(JSON.stringify(g.study.learner!.evidence), evidence);
    assert.equal(g.study.profile, "development");
  }));
for (const change of ["malformed", "disconnected", "changed question"] as const)
  test(`${change} completion cannot solve a puzzle`, async () =>
    transport(async (set) => {
      const { g, e } = await fixture();
      let release!: (r: Response) => void;
      await set(
        true,
        async () => new Promise<Response>((resolve) => (release = resolve)),
      );
      edit(g, e, "Fictional answer", e.revision, roadmap);
      const pending = submit(g, e, roadmap);
      if (change === "disconnected") await set(false);
      if (change === "changed question") e.problem!.prompt += " changed";
      release(
        Response.json(
          change === "malformed"
            ? { complete: "true", feedback: "yes", qualified: ["human"] }
            : {
                complete: true,
                feedback: "Synthetic acceptance",
                qualified: ["human"],
              },
        ),
      );
      await pending;
      assert.equal(e.submissions[0].status, "error");
      assert.notEqual(e.state, "consumed");
      assert.deepEqual(g.survivors[0].access, []);
    }));
test("tutor and group receive current draft JSON; private tutoring stays out of group and chat cannot submit", async () =>
  transport(async (set) => {
    const { g, e } = await fixture();
    edit(g, e, "Current unsubmitted draft", e.revision, roadmap);
    e.mode = "solo";
    const npc = g.survivors[1];
    Object.assign(npc, {
      intent: e.id,
      thought: 10,
      floor: e.floor,
      activity: "working",
    });
    g.zombies = [];
    const calls: any[] = [];
    await set(true, async (request) => {
      calls.push(request);
      const p = request.payload;
      assert.equal(p.workspace, "Current unsubmitted draft");
      assert.equal(p.draftRevision, e.revision);
      if (request.operation === "tutor")
        return Response.json({
          text: "PRIVATE_TUTOR_SENTINEL",
          complete: false,
        });
      assert.equal(request.operation, "group");
      assert.ok(!JSON.stringify(p).includes("PRIVATE_TUTOR_SENTINEL"));
      return Response.json({
        requestId: p.requestId,
        sourceRevision: p.sourceRevision,
        messages: [
          {
            author: p.speakers[0].id,
            kind: "question",
            text: "Which assumption should we test?",
            refs: [],
          },
        ],
      });
    });
    assert.equal(terminalChannel(e), "tutor");
    await send(g, e, "tutor", "Help with current draft", roadmap);
    assert.equal(e.tutor.at(-1)!.text, "PRIVATE_TUTOR_SENTINEL");
    e.mode = "shared";
    assert.equal(terminalChannel(e), "group");
    await send(g, e, "group", "Help with the assumption", roadmap);
    assert.equal(calls.length, 2);
    assert.equal(e.group.at(-1)!.text, "Which assumption should we test?");
    assert.equal(e.submissions.length, 0);
    assert.notEqual(e.state, "consumed");
  }));
test("offline capture also binds the original question before any reconnect", async () =>
  transport(async (set) => {
    const { g, e } = await fixture();
    edit(g, e, "Saved answer", e.revision, roadmap);
    await submit(g, e, roadmap);
    assert.ok(e.submissions[0].completionRequest);
    e.problem!.prompt += " changed later";
    let calls = 0;
    await set(true, async () => {
      calls++;
      return Response.json({
        complete: true,
        feedback: "Synthetic",
        qualified: ["human"],
      });
    });
    await retrySubmission(g, e, roadmap, e.submissions[0].id);
    assert.equal(calls, 0);
    assert.equal(e.submissions[0].status, "error");
    assert.match(e.submissions[0].feedback, /captured question/);
    assert.notEqual(e.state, "consumed");
  }));
test("completion JSON rejects truthy values, missing fields, blank explanations and malformed qualification lists", () => {
  for (const v of [
    null,
    [],
    { complete: 1 },
    { complete: "true", feedback: "ok", qualified: [] },
    { complete: true, feedback: "", qualified: [] },
    { complete: true, feedback: "ok", qualified: [42] },
  ])
    assert.throws(() => completionVerdict(v), /Malformed/);
  assert.deepEqual(
    completionVerdict({
      complete: false,
      feedback: "Revise",
      qualified: ["human", "human"],
    }),
    { complete: false, feedback: "Revise", qualified: ["human"] },
  );
});
