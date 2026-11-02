import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkBridge, edit, retryGroupRequest, send } from "../src/ai";
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
  e.mode = "shared";
  e.problem = {
    title: "Controlled group retry",
    prompt: "Synthetic transport fixture",
    starter: "",
    rubric: [],
    provenance: "chatgpt-handoff",
    contract: eligible(roadmap, g.study),
  };
  e.workspace = "Captured group work";
  for (const z of g.zombies) z.hp = 0;
  for (const a of g.survivors.slice(1)) {
    a.floor = e.floor;
    a.intent = e.id;
    a.thought = 12;
  }
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
          capabilities: ["group"],
        })
      : handler(url, init);
  await checkBridge();
  return async () => {
    globalThis.fetch = async () =>
      Response.json({
        mode: "development",
        label: "Development",
        detail: "Fixture restored",
        capabilities: [],
      });
    await checkBridge();
    globalThis.fetch = original;
  };
}
test("interrupted group delivery resumes the same question and speakers after reload without private leakage or duplicate replies", async () => {
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
    e.tutor.push({
      id: "private",
      seq: ++g.seq,
      author: "human",
      kind: "human",
      text: "PRIVATE_SENTINEL",
      worldTime: g.time,
      provenance: "live-human",
    });
    await send(g, e, "group", "What boundary should we trace?", roadmap);
    const job = e.groupRequests![0];
    assert.equal(job.state, "interrupted");
    job.state = "pending"; // save while the transport is unresolved
    const loaded = recover(decode(encode(g))),
      resumed = loaded.encounters[e.id];
    assert.equal(resumed.groupRequests![0].state, "interrupted");
    loaded.rng = 91234;
    for (const a of loaded.survivors.slice(1)) a.skill = 0.99;
    const first = retryGroupRequest(loaded, resumed, job.id),
      second = retryGroupRequest(loaded, resumed, job.id);
    assert.equal(first, second);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0], bodies[1]);
    assert.ok(!bodies[1].includes("PRIVATE_SENTINEL"));
    const payload = JSON.parse(bodies[1]).payload;
    finish!(
      Response.json({
        requestId: payload.requestId,
        sourceRevision: payload.sourceRevision,
        messages: [
          {
            author: payload.speakers[0].id,
            kind: "question",
            text: "What happens at the empty boundary?",
            refs: [],
          },
        ],
      }),
    );
    await first;
    assert.equal(resumed.groupRequests![0].state, "applied");
    assert.equal(resumed.group.filter((m) => m.requestId === job.id).length, 1);
    assert.equal(resumed.group.filter((m) => m.kind === "human").length, 1);
    await retryGroupRequest(loaded, resumed, job.id);
    assert.equal(bodies.length, 2);
  } finally {
    await restore();
  }
});
test("saved group request refuses provider changes and stale work before transport, and rechecks revision before delivery", async () => {
  const { g, e } = fixture();
  let calls = 0,
    finish: ((r: Response) => void) | undefined;
  const restore = await connection(async () => {
    calls++;
    if (calls === 1)
      return Response.json({ error: "Controlled outage" }, { status: 503 });
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  });
  try {
    await send(g, e, "group", "Trace the boundary?", roadmap);
    const job = e.groupRequests![0];
    job.provider = "study-mode";
    await retryGroupRequest(g, e, job.id);
    assert.equal(calls, 1);
    assert.match(job.error!, /original group connection/);
    job.provider = "claude-cli";
    edit(g, e, "New public revision", e.revision, roadmap);
    await retryGroupRequest(g, e, job.id);
    assert.equal(calls, 1);
    assert.match(job.error!, /Workspace changed/);
    assert.equal(e.group.filter((m) => m.kind === "npc").length, 0);
    // A new human question captures this revision; changing it while waiting
    // must also prevent stale proposals from entering the shared workspace.
    const pending = send(g, e, "group", "Trace the new revision?", roadmap);
    const payload = JSON.parse(e.groupRequests!.at(-1)!.payloadJson);
    edit(g, e, "Changed during response", e.revision, roadmap);
    finish!(
      Response.json({
        requestId: payload.requestId,
        sourceRevision: payload.sourceRevision,
        messages: [
          {
            author: payload.speakers[0].id,
            kind: "question",
            text: "Stale reply",
            refs: [],
          },
        ],
      }),
    );
    await pending;
    assert.equal(e.groupRequests!.at(-1)!.state, "interrupted");
    assert.equal(e.group.filter((m) => m.kind === "npc").length, 0);
    assert.equal(e.workspace, "Changed during response");
  } finally {
    await restore();
  }
});

test("a group answer interrupted by a speaker retreat is retained and delivered once after that speaker returns", async () => {
  const { g, e } = fixture();
  let payload: any,
    finish: ((r: Response) => void) | undefined,
    calls = 0;
  const restore = await connection(async (_url, init) => {
    calls++;
    payload = JSON.parse(String(init?.body)).payload;
    if (calls === 1)
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    return Response.json({
      requestId: payload.requestId,
      sourceRevision: payload.sourceRevision,
      messages: [
        {
          author: payload.speakers[0].id,
          kind: "question",
          text: "Which boundary should we trace?",
          refs: [],
        },
      ],
    });
  });
  try {
    const pending = send(g, e, "group", "Which boundary?", roadmap);
    const speaker = g.survivors.find((a) => a.id === payload.speakers[0].id)!;
    speaker.escaped = true;
    finish!(
      Response.json({
        requestId: payload.requestId,
        sourceRevision: payload.sourceRevision,
        messages: [
          {
            author: speaker.id,
            kind: "question",
            text: "Which boundary should we trace?",
            refs: [],
          },
        ],
      }),
    );
    await pending;
    const job = e.groupRequests![0],
      original = job.payloadJson;
    assert.equal(job.state, "interrupted");
    assert.equal(e.group.filter((m) => m.kind === "npc").length, 0);
    await retryGroupRequest(g, e, job.id);
    assert.equal(calls, 1);
    speaker.escaped = false;
    await retryGroupRequest(g, e, job.id);
    assert.equal(calls, 2);
    assert.equal(job.state, "applied");
    assert.equal(job.payloadJson, original);
    assert.equal(e.group.filter((m) => m.requestId === job.id).length, 1);
  } finally {
    await restore();
  }
});
