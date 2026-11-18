import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkBridge, edit, ensureProblem, send } from "../src/ai";
import { completionVerdict } from "../src/completion-verdict";
import type { Roadmap } from "../src/model";
import { createGame } from "./helpers/record";
import { devProblem } from "./helpers/practice-questions";
import { eligible } from "../src/curriculum";
import type { Encounter, StudyRecord } from "../src/model";

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
          capabilities: connected ? ["tutor"] : [],
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
/** Old development path: the encounter's private synthetic question, assigned explicitly. */
function issueDev(g: StudyRecord, e: Encounter, roadmap: Roadmap) {
  const contract = eligible(roadmap, g.study);
  e.problem = devProblem(g, roadmap, contract);
  e.workspace = e.problem.starter;
  e.state = "in-progress";
}
async function fixture() {
  const g = createGame(701, roadmap);
  const e = g.encounters["question-0"];
  issueDev(g, e, roadmap);
  await ensureProblem(g, e, roadmap);
  assert.equal(e.problem!.provenance, "development");
  return { g, e };
}
test("the tutor receives the saved draft and a follow-up reply records no submission", async () =>
  transport(async (set) => {
    const { g, e } = await fixture();
    edit(g, e, "Current unsubmitted draft", e.revision, roadmap);
    const calls: any[] = [];
    await set(true, async (request) => {
      calls.push(request);
      const p = request.payload;
      assert.equal(request.operation, "tutor");
      assert.equal(p.workspace, "Current unsubmitted draft");
      assert.equal(p.draftRevision, e.revision);
      return Response.json({
        text: "PRIVATE_TUTOR_SENTINEL",
        complete: false,
      });
    });
    await send(g, e, "Help with current draft", roadmap);
    assert.equal(e.tutor.at(-1)!.text, "PRIVATE_TUTOR_SENTINEL");
    assert.equal(calls.length, 1);
    assert.equal(e.submissions.length, 0);
    assert.notEqual(e.state, "consumed");
  }));
test("a saved shared question with an unchecked submission is answered and finished in the conversation", async () =>
  transport(async (set) => {
    const { g, e } = await fixture();
    e.mode = "shared";
    e.submissions.push({
      id: "saved-check",
      revision: e.revision,
      author: "human",
      content: "Saved earlier answer",
      seq: ++g.seq,
      status: "error",
      feedback: "Evaluation unavailable; snapshot retained.",
      completionRequest: { provider: "claude-cli", payloadJson: "{}" },
    });
    const saved = structuredClone(e.submissions[0]);
    await set(true, async (request) => {
      assert.equal(request.operation, "tutor");
      assert.equal(request.payload.mode, "terminal-dialogue");
      return Response.json({ text: "That settles it.", complete: true });
    });
    await send(g, e, "My final answer", roadmap);
    assert.equal(e.state, "consumed");
    assert.deepEqual(e.submissions[0], saved);
    assert.equal(e.submissions.length, 2);
    assert.equal(e.accepted, e.submissions[1].id);
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
