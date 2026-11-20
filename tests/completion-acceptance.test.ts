import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkBridge, edit, send } from "../src/ai";
import { eligible } from "../src/curriculum";
import type { Roadmap } from "../src/model";
import { createRecord } from "./helpers/record";
const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
function fixture() {
  const g = createRecord(71, roadmap),
    e = g.encounters["question-0"];
  g.study.profile = "live";
  e.problem = {
    title: "Controlled retry",
    prompt: "Synthetic transport fixture",
    starter: "",
    rubric: [],
    provenance: "chatgpt-handoff",
    contract: eligible(roadmap, g.study),
  };
  e.workspace = "Original captured work";
  return { g, e };
}
async function connection(handler: typeof fetch) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    String(url) === "/api/status"
      ? Response.json({
          mode: "claude-cli",
          label: "Controlled handoff",
          detail: "Synthetic test transport only",
          capabilities: ["tutor", "assess"],
        })
      : handler(url, init);
  await checkBridge();
  return async () => {
    globalThis.fetch = async () =>
      Response.json({
        mode: "development",
        label: "Development fallback",
        detail: "Fixture restored",
        capabilities: [],
      });
    await checkBridge();
    globalThis.fetch = original;
  };
}
test("D02/D03/D09 a late useful fix is accepted immediately despite extensive help and a pending individual assessment", async () => {
  const { g, e } = fixture();
  g.study.learner!.mode = "test";
  g.time = 600;
  for (let i = 0; i < 12; i++)
    e.tutor.push({
      id: `help-${i}`,
      author: "Terminal AI",
      kind: "tutor",
      text: "Synthetic extensive assistance",
      seq: ++g.seq,
      worldTime: 599,
      provenance: "live-ai",
    });
  edit(g, e, "return count + 1", e.revision, roadmap);
  const fixedAt = g.time,
    learning = JSON.stringify(g.study.learner!.evidence);
  let release!: (r: Response) => void,
    assessStarted = false;
  const restore = await connection(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.operation === "tutor")
      return Response.json({
        text: "Synthetic useful fix accepted; not a real semantic grade",
        complete: true,
      });
    assert.equal(request.operation, "assess");
    assessStarted = true;
    return new Promise<Response>((resolve) => (release = resolve));
  });
  try {
    await send(g, e, "My fix is in the saved work.", roadmap);
    assert.equal(g.time, fixedAt, "no elapsed participation quota");
    assert.equal(e.state, "consumed");
    assert.ok(assessStarted);
    assert.equal(g.study.assessments.at(-1)!.status, "pending");
    assert.equal(JSON.stringify(g.study.learner!.evidence), learning);
    assert.match(e.workspace, /return count \+ 1/);
    assert.equal(e.tutor.length, 14, "the answer and its accepting reply");
    release(
      Response.json(
        { error: "Synthetic reviewer unavailable" },
        { status: 503 },
      ),
    );
    // Let the separately scheduled review settle before restoring shared transport.
    for (
      let i = 0;
      i < 20 && g.study.assessments.at(-1)!.status === "pending";
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(g.study.assessments.at(-1)!.status, "review-required");
    assert.equal(e.state, "consumed");
  } finally {
    if (release)
      release(Response.json({ error: "Fixture ended" }, { status: 503 }));
    await restore();
  }
});
