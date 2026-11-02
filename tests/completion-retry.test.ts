import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkBridge, edit, retrySubmission, submit } from "../src/ai";
import { eligible } from "../src/curriculum";
import type { Roadmap } from "../src/model";
import { decode, encode, recover } from "../src/persistence";
import { createGame } from "../src/world";
const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
function fixture() {
  const g = createGame(71, roadmap),
    e = g.encounters["f0-room0"];
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
          capabilities: ["complete", "assess"],
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
test("saved completion retries the identical payload after edits and reload, coalesces calls and does not capture another submission", async () => {
  const { g, e } = fixture(),
    bodies: string[] = [];
  let finish: ((r: Response) => void) | undefined;
  const restore = await connection(async (_url, init) => {
    bodies.push(String(init?.body));
    if (bodies.length === 1)
      return Response.json({ error: "Controlled outage" }, { status: 503 });
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  });
  try {
    await submit(g, e, roadmap);
    const id = e.submissions[0].id;
    assert.equal(e.submissions[0].status, "error");
    edit(g, e, "Later unsent edits", e.revision, roadmap);
    const loaded = recover(decode(encode(g))),
      resumed = loaded.encounters[e.id];
    const first = retrySubmission(loaded, resumed, roadmap, id),
      second = retrySubmission(loaded, resumed, roadmap, id);
    assert.equal(first, second);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[1], bodies[0]);
    assert.equal(resumed.submissions.length, 1);
    assert.equal(resumed.workspace, "Later unsent edits");
    finish!(
      Response.json({
        complete: false,
        feedback: "Controlled needs-work result",
        qualified: [],
      }),
    );
    await first;
    assert.equal(resumed.submissions[0].status, "needs-work");
    assert.equal(resumed.workspace, "Later unsent edits");
    await retrySubmission(loaded, resumed, roadmap, id);
    assert.equal(bodies.length, 2);
  } finally {
    await restore();
  }
});
test("saved completion refuses a changed provider or captured revision before sending another request", async () => {
  const { g, e } = fixture();
  let calls = 0;
  const restore = await connection(async () => {
    calls++;
    return Response.json({ error: "Controlled outage" }, { status: 503 });
  });
  try {
    await submit(g, e, roadmap);
    const s = e.submissions[0],
      saved = s.completionRequest!;
    saved.provider = "study-mode";
    await retrySubmission(g, e, roadmap, s.id);
    assert.equal(calls, 1);
    assert.match(s.feedback, /original completion provider/);
    saved.provider = "chatgpt-handoff";
    g.study.profile = "development";
    await retrySubmission(g, e, roadmap, s.id);
    assert.equal(calls, 1);
    assert.equal(e.state, "in-progress");
    assert.match(s.feedback, /original completion provider/);
    g.study.profile = "live";
    saved.provider = "claude-cli";
    const payload = JSON.parse(saved.payloadJson);
    payload.submission.content = "Changed after capture";
    saved.payloadJson = JSON.stringify(payload);
    await retrySubmission(g, e, roadmap, s.id);
    assert.equal(calls, 1);
    assert.match(s.feedback, /captured question and revision/);
    assert.equal(e.state, "in-progress");
    assert.equal(e.submissions.length, 1);
  } finally {
    await restore();
  }
});

test("D02/D03/D09 a late useful fix qualifies immediately despite extensive help, unfinished teammate handling and a pending individual assessment", async () => {
  const { g, e } = fixture(),
    h = g.survivors[0],
    builder = g.survivors[1],
    observer = g.survivors[2];
  g.study.learner!.mode = "test";
  g.status = "playing";
  g.time = 600;
  // Controlled ongoing work state; this case does not measure physical preparation.
  builder.activity = "defending";
  builder.handling = g.floors[0].furniture.find((o) => o.kind === "shelf")!.id;
  e.humanEngaged = true;
  e.history.push({
    seq: ++g.seq,
    author: builder.id,
    kind: "defense",
    text: "Controlled prior useful defense",
    at: 599,
    revision: 0,
  });
  e.contributors = [builder.id];
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
    learning = JSON.stringify(g.study.learner!.evidence),
    inventory = structuredClone(h.inventory);
  let release!: (r: Response) => void,
    assessStarted = false;
  const restore = await connection(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.operation === "complete")
      return Response.json({
        complete: true,
        feedback: "Synthetic useful fix accepted; not a real semantic grade",
        qualified: [h.id, observer.id],
      });
    assert.equal(request.operation, "assess");
    assessStarted = true;
    return new Promise<Response>((resolve) => (release = resolve));
  });
  try {
    await submit(g, e, roadmap);
    assert.equal(g.time, fixedAt, "no elapsed participation quota");
    assert.equal(e.state, "consumed");
    assert.ok(h.access.includes(0));
    assert.ok(builder.access.includes(0));
    assert.deepEqual(
      observer.access,
      [],
      "mere presence cannot qualify even when the provider nominates it",
    );
    assert.equal(
      builder.handling,
      g.floors[0].furniture.find((o) => o.kind === "shelf")!.id,
      "unfinished teammate work is not a world-completion prerequisite",
    );
    assert.deepEqual(h.inventory, inventory);
    assert.ok(assessStarted);
    assert.equal(g.study.assessments.at(-1)!.status, "pending");
    assert.equal(JSON.stringify(g.study.learner!.evidence), learning);
    assert.equal(e.workspace, "return count + 1");
    assert.equal(e.tutor.length, 12);
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
    assert.ok(h.access.includes(0));
  } finally {
    if (release)
      release(Response.json({ error: "Fixture ended" }, { status: 503 }));
    await restore();
  }
});
