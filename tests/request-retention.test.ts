import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { preparePracticeRooms } from "./helpers/practice-questions";
import { checkBridge, retryTutorRequest, send } from "../src/ai";
import type { Roadmap, TutorRequest } from "../src/model";
import { decode, encode, recover } from "../src/persistence";
import { retainRunLearning } from "../src/run-learning";
import { createPlayableGame } from "../src/world";
const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
async function fixture(
  run: (
    g: any,
    e: any,
    calls: any[],
    reply: (fn: (p: any) => Promise<Response>) => void,
  ) => Promise<void>,
) {
  const original = globalThis.fetch;
  const calls: any[] = [];
  let connected = false;
  let respond = async (_p: any) =>
    Response.json({ text: "What changes?", complete: false });
  globalThis.fetch = async (url, init) => {
    if (String(url) === "/api/status")
      return Response.json({
        mode: connected ? "claude-cli" : "development",
        label: "Synthetic",
        detail: "No real AI",
        capabilities: connected ? ["tutor"] : [],
      });
    const p = JSON.parse(String(init?.body));
    calls.push(p);
    return respond(p);
  };
  try {
    await checkBridge();
    const g = createPlayableGame(717, r);
    preparePracticeRooms(g, r);
    const e = g.encounters[g.floors[0].stations[0].encounter];
    e.mode = "solo";
    e.owner = "human";
    connected = true;
    await checkBridge();
    await run(g, e, calls, (fn) => {
      respond = fn;
    });
  } finally {
    connected = false;
    await checkBridge();
    globalThis.fetch = original;
  }
}
const parsed = (job: { payloadJson: string }) => JSON.parse(job.payloadJson);
const hasContext = (job: { payloadJson: string }) => {
  const p = parsed(job);
  return (
    Object.hasOwn(p, "curriculum") &&
    Object.hasOwn(p, "progressContext") &&
    typeof p.curriculum === "string" &&
    typeof p.progressContext === "string"
  );
};
const released = (job: { payloadJson: string }) => {
  const p = parsed(job);
  return (
    !Object.hasOwn(p, "curriculum") && !Object.hasOwn(p, "progressContext")
  );
};

test("an applied tutor job releases curriculum and progressContext but keeps its identity", async () =>
  fixture(async (_g, e, calls, reply) => {
    reply(async () => Response.json({ text: "Go on", complete: false }));
    await send(_g, e, "tutor", "My first answer", r);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].payload.curriculum.length > 100);
    assert.ok(calls[0].payload.progressContext.length > 100);
    const job = e.tutorRequests[0];
    assert.equal(job.state, "applied");
    assert.ok(released(job));
    const p = parsed(job);
    assert.equal(p.requestId, job.id);
    assert.equal(p.sessionId, `${e.runId}/${e.id}/private`);
    assert.equal(p.mode, "terminal-dialogue");
    assert.ok(Array.isArray(p.messages));
    assert.deepEqual(p.messages, calls[0].payload.messages);
    assert.deepEqual(p.problem, calls[0].payload.problem);
    assert.ok(
      JSON.stringify(calls[0].payload).length - job.payloadJson.length >=
        100_000,
    );
  }));

test("an interrupted live job keeps its full payload through reload and retries identically", async () =>
  fixture(async (g, e, calls, reply) => {
    reply(async () => Response.json({ error: "outage" }, { status: 503 }));
    await send(g, e, "tutor", "Captured answer", r);
    const job = e.tutorRequests[0];
    assert.equal(job.state, "interrupted");
    assert.ok(hasContext(job));
    const loaded = recover(decode(encode(g)));
    const resumed = loaded.encounters[e.id];
    const saved = resumed.tutorRequests![0];
    assert.equal(saved.state, "interrupted");
    assert.ok(hasContext(saved));
    assert.equal(saved.payloadJson, job.payloadJson);
    reply(async () => Response.json({ error: "outage" }, { status: 503 }));
    await retryTutorRequest(loaded, resumed, saved.id, r);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].payload, calls[0].payload);
    assert.ok(hasContext(saved));
  }));

test("a newer message supersedes an interrupted job and releases its context", async () =>
  fixture(async (g, e, _calls, reply) => {
    reply(async () => Response.json({ error: "outage" }, { status: 503 }));
    await send(g, e, "tutor", "First answer", r);
    const old = e.tutorRequests[0];
    assert.equal(old.state, "interrupted");
    assert.ok(hasContext(old));
    reply(async () => Response.json({ text: "Keep going", complete: false }));
    await send(g, e, "tutor", "Revised answer", r);
    assert.equal(old.state, "superseded");
    assert.ok(released(old));
    assert.equal(parsed(old).requestId, old.id);
  }));

test("archiving a run releases context from every tutor job, including interrupted ones", async () =>
  fixture(async (g, e, _calls, reply) => {
    reply(async () => Response.json({ error: "outage" }, { status: 503 }));
    await send(g, e, "tutor", "Unanswered answer", r);
    assert.equal(e.tutorRequests[0].state, "interrupted");
    assert.ok(hasContext(e.tutorRequests[0]));
    retainRunLearning(g, true);
    const archived = g.study.archives.find((a: any) => a.id === e.id);
    assert.ok(archived);
    assert.equal(g.study.archives[0].id, e.id);
    const job = g.study.archives[0].tutorRequests[0];
    assert.equal(job.state, "interrupted");
    assert.ok(released(job));
    assert.equal(parsed(job).requestId, job.id);
  }));

test("recover migrates existing saves: settled live jobs and all archived jobs shrink", () => {
  const g = createPlayableGame(717, r);
  const ids = Object.keys(g.encounters);
  const e = g.encounters[ids[0]];
  const other = g.encounters[ids[1]];
  const big = (id: string) =>
    JSON.stringify({
      requestId: id,
      sessionId: `${g.id}/${e.id}/private`,
      mode: "terminal-dialogue",
      messages: [],
      curriculum: "c".repeat(50_000),
      progressContext: "p".repeat(50_000),
    });
  const applied: TutorRequest = {
    id: "applied-job",
    provider: "claude-cli",
    payloadJson: big("applied-job"),
    questionSequence: 1,
    state: "applied",
  };
  (e.tutorRequests ??= []).push(applied);
  const archivedEncounter = structuredClone(e);
  archivedEncounter.tutorRequests = [
    { ...applied, id: "archived-job", payloadJson: big("archived-job") },
  ];
  archivedEncounter.tutorRequests[0].state = "interrupted";
  g.study.archives.push(archivedEncounter);
  (other.tutorRequests ??= []).push({
    id: "pending-job",
    provider: "claude-cli",
    payloadJson: big("pending-job"),
    questionSequence: 1,
    state: "pending",
  });
  const before = encode(g).length;
  const loaded = recover(decode(encode(g)));
  const liveJob = loaded.encounters[e.id].tutorRequests![0];
  assert.equal(liveJob.state, "applied");
  assert.ok(released(liveJob));
  assert.equal(parsed(liveJob).requestId, "applied-job");
  assert.equal(parsed(liveJob).mode, "terminal-dialogue");
  const archJob = loaded.study.archives[0].tutorRequests![0];
  assert.equal(archJob.state, "interrupted");
  assert.ok(released(archJob));
  assert.equal(parsed(archJob).requestId, "archived-job");
  const pendingJob = loaded.encounters[other.id].tutorRequests!.find(
    (j) => j.id === "pending-job",
  )!;
  assert.equal(pendingJob.state, "interrupted");
  assert.ok(hasContext(pendingJob));
  assert.equal(parsed(pendingJob).curriculum.length, 50_000);
  assert.ok(before - encode(loaded).length >= 150_000);
});
