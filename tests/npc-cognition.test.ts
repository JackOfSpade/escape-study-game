import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  checkBridge,
  closeChat,
  edit,
  openChat,
  presentMessages,
  responders,
  send,
} from "../src/ai";
import { eligible, evidencePacket } from "../src/curriculum";
import {
  groupSnapshot,
  validateGroupReply,
  type GroupSnapshot,
} from "../src/group-grounding";
import type { Artifact, Roadmap } from "../src/model";
import { npcProfile, recordNpcWork, taskSkill } from "../src/npc-cognition";
import { decode, encode } from "../src/persistence";
import { createGame } from "../src/world";
import { devProblem } from "./helpers/practice-questions";
import { fnv1a } from "../src/hash";

const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
async function fixture(seed = 7) {
  const g = createGame(seed, r),
    e = g.encounters["f0-room0"];
  g.zombies = [];
  g.nextSpawn = Number.MAX_SAFE_INTEGER;
  // The game has no local questions: hand the terminal the synthetic fixture.
  e.problem = devProblem(
    { ...g, rng: fnv1a(e.id, g.seed) },
    r,
    eligible(r, g.study),
  );
  e.workspace = e.problem.starter;
  e.state = "in-progress";
  for (const a of g.survivors.slice(1)) {
    a.intent = e.id;
    a.thought = 30;
    a.x = 10;
    a.y = 6;
    a.floor = 0;
  }
  return { g, e, a: g.survivors[1] };
}
const response = (body: unknown) => new Response(JSON.stringify(body));
async function liveFixture(handler: (payload: any) => Promise<Response>) {
  const f = await fixture();
  f.g.study.profile = "live";
  f.g.study.learner!.mode = "test";
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) =>
    String(input) === "/api/status"
      ? response({
          mode: "claude-cli",
          label: "Synthetic group boundary",
          capabilities: [],
          detail: "Not native Study Mode",
        })
      : handler(JSON.parse(String(init?.body)).payload);
  await checkBridge();
  return {
    ...f,
    async restore() {
      globalThis.fetch = async () =>
        response({
          mode: "development",
          label: "Development fallback",
          capabilities: [],
          detail: "Fixture ended",
        });
      await checkBridge();
      globalThis.fetch = original;
    },
  };
}
function reply(payload: any, text = "An unvalidated candidate explanation.") {
  return {
    requestId: payload.requestId,
    sourceRevision: payload.sourceRevision,
    messages: [
      {
        author: payload.speakers[0].id,
        kind: "proposal",
        text,
        refs: [payload.events.at(-1).seq],
      },
    ],
  };
}

test("NPC profiles persist differentiated topic and technical strengths with deterministic legacy fallback", () => {
  const first = createGame(11, r),
    second = createGame(11, r),
    a = first.survivors[1];
  assert.deepEqual(a.technical, second.survivors[1].technical);
  assert.notEqual(a.technical!.topics["PY:T01"], a.technical!.topics["PE:T01"]);
  assert.ok(new Set(Object.values(a.technical!.topics)).size > 20);
  const saved = structuredClone(a.technical);
  delete a.technical;
  assert.deepEqual(npcProfile(a), saved);
  a.technical = saved;
  assert.deepEqual(decode(encode(first)).survivors[1].technical, saved);
  assert.equal(first.rng, second.rng);
});

test("NPC conceptual work has stable source scope, revision and provenance, no fabricated execution or human progress", async () => {
  const { g, e, a } = await fixture();
  const cells = JSON.stringify(g.study.learner!.cells),
    workspace = e.workspace,
    rng = g.rng;
  a.technical!.topics["PY:T05"] = 0.91;
  assert.equal(taskSkill(a, e), 0.91);
  a.technical!.strengths = {
    reasoning: 0.4,
    testing: 0.3,
    debugging: 0.2,
    implementation: 0.97,
  };
  a.milestone = 1;
  recordNpcWork(g, e, a, false);
  const work = e.npcWork![0];
  assert.notEqual(
    work.focus,
    "implementation",
    "D1 must not require implementation",
  );
  assert.equal(work.validated, false);
  assert.equal(work.execution, "not-run");
  assert.deepEqual(work.scopeIds, e.problem!.contract.objectiveIds);
  assert.equal(e.workspace, workspace);
  assert.equal(g.rng, rng);
  assert.equal(JSON.stringify(g.study.learner!.cells), cells);
  assert.equal(e.executions, undefined);
  assert.equal(
    JSON.stringify(decode(encode(g)).encounters[e.id].npcWork),
    JSON.stringify(e.npcWork),
  );
});

test("redundant group thought has diminishing contribution rather than linear multiplication", async () => {
  const { g, e, a } = await fixture(),
    b = g.survivors[2];
  delete e.problem;
  b.technical = structuredClone(a.technical);
  a.milestone = b.milestone = 1;
  const first = recordNpcWork(g, e, a, false),
    second = recordNpcWork(g, e, b, false);
  assert.ok(second < first && second > 0);
  assert.equal(e.npcWork!.length, 2);
  assert.deepEqual(
    e.npcWork![0].scopeIds,
    [],
    "An unseen lock cannot acquire an invented academic topic",
  );
});

test("work while chat is open stays silent, then reopens as an append-only work summary exactly once", async () => {
  const { g, e, a } = await fixture();
  a.milestone = 1;
  recordNpcWork(g, e, a, false);
  openChat(g, e);
  presentMessages(g, e, "group");
  const first = structuredClone(e.group),
    count = e.group.length;
  a.milestone = 2;
  recordNpcWork(g, e, a, false);
  const later = e.npcWork!.at(-1)!.seq;
  assert.equal(e.group.length, count);
  closeChat(g, e);
  openChat(g, e);
  assert.deepEqual(e.group.slice(0, count), first);
  assert.ok(e.group.at(-1)!.sourceRefs?.includes(later));
  assert.match(e.group.at(-1)!.text, /Saved work summary/);
  const after = JSON.stringify(e.group);
  closeChat(g, e);
  openChat(g, e);
  assert.equal(JSON.stringify(e.group), after);
});

test("long catch-up bounds messages without losing original work or fabricating a dead speaker's live reply", async () => {
  const { g, e, a } = await fixture();
  for (let n = 1; n <= 12; n++) {
    edit(g, e, `Real shared revision ${n}`, e.revision);
    a.milestone = n;
    recordNpcWork(g, e, a, false);
  }
  a.alive = false;
  const progress = e.npcProgress;
  openChat(g, e);
  assert.equal(e.group.length, 4);
  assert.equal(e.npcWork!.length, 12);
  assert.match(e.group[0].text, /9 earlier work\/activity events/);
  assert.match(e.group.at(-1)!.text, /who has since left/);
  assert.equal(new Set(e.group.flatMap((m) => m.sourceRefs ?? [])).size, 12);
  assert.equal(e.npcProgress, progress);
  assert.ok(!responders(g, e, "Maya?").some((actor) => actor.id === a.id));
});

test("topic competence biases routing while bounded randomness includes weaker speakers and never the whole group", async () => {
  let specialist = 0,
    novice = 0;
  for (let seed = 1; seed <= 180; seed++) {
    const { g, e } = await fixture(seed);
    g.survivors = g.survivors.slice(0, 4);
    for (const [i, a] of g.survivors.slice(1).entries()) {
      a.social = 0.5;
      a.technical!.topics["PY:T05"] = [0.95, 0.2, 0.55][i];
      a.technical!.strengths.testing = 0.5;
    }
    const selected = responders(g, e, "Which boundary case should we test?");
    assert.ok(selected.length < 3);
    specialist += Number(selected.some((a) => a.id === g.survivors[1].id));
    novice += Number(selected.some((a) => a.id === g.survivors[2].id));
  }
  assert.ok(specialist > novice && specialist < 180);
  assert.ok(novice > 0);
});

test("hidden tutor text is not group knowledge or premature assistance; first actual presentation has its own sequence", async () => {
  const f = await liveFixture(async () =>
    response({ text: "Synthetic private tutor reply", complete: false }),
  );
  const { g, e } = f;
  try {
    await send(g, e, "tutor", "PRIVATE_TUTOR_QUESTION", r);
    const answer = e.tutor.at(-1)!;
    assert.equal(answer.presented, undefined);
    edit(g, e, "Independent work before seeing the delayed reply", e.revision);
    const cutoff = g.seq,
      before = evidencePacket(e, r, cutoff);
    assert.equal(
      before.tutor.length,
      1,
      "Only the authored human private question was already presented",
    );
    assert.ok(!before.assistanceSources.some((m) => m.id === answer.id));
    const snapshot = groupSnapshot(e, "group-private-boundary", g.seq);
    assert.ok(
      !snapshot.events.some(
        (h) => h.text.includes("PRIVATE_TUTOR_QUESTION") || h.kind === "tutor",
      ),
    );
    presentMessages(g, e, "tutor");
    assert.ok(answer.presented! > cutoff);
    assert.ok(
      !evidencePacket(e, r, cutoff).assistanceSources.some(
        (m) => m.id === answer.id,
      ),
    );
    assert.ok(
      evidencePacket(e, r).assistanceSources.some((m) => m.id === answer.id),
    );
    const seq = g.seq;
    presentMessages(g, e, "tutor");
    assert.equal(g.seq, seq);
    assert.equal(e.group.length, 0);
  } finally {
    await f.restore();
  }
});

test("structured group claims require captured attributed edits/runtime and reject duplicate or unknown speakers", () => {
  const history: Artifact[] = [
    {
      seq: 10,
      author: "human",
      kind: "execution",
      executionId: "job",
      text: "Actual fixture receipt",
      at: 1,
      revision: 2,
    },
  ];
  const snapshot: GroupSnapshot = {
    requestId: "request",
    sourceRevision: 2,
    cutoff: 10,
    events: history,
    executions: [
      {
        id: "job",
        revision: 2,
        status: "finished",
        receipt: {
          id: "job",
          language: "python",
          status: "completed",
          executed: true,
          exitCode: 1,
        },
      },
    ],
  };
  const message = {
    author: "npc-0",
    kind: "observation",
    text: "The human's captured process exited with 1.",
    refs: [10],
    claims: [
      {
        kind: "execution",
        ref: 10,
        by: "human",
        revision: 2,
        executionId: "job",
        exitCode: 1,
      },
    ],
  };
  const valid = {
    requestId: "request",
    sourceRevision: 2,
    messages: [message],
  };
  assert.equal(validateGroupReply(valid, snapshot, ["npc-0"]).length, 1);
  for (const invalid of [
    { ...valid, requestId: "old" },
    { ...valid, messages: [message, message] },
    { ...valid, messages: [{ ...message, author: "unselected" }] },
    { ...valid, messages: [{ ...message, refs: [11] }] },
    {
      ...valid,
      messages: [
        { ...message, claims: [{ ...message.claims[0], by: "npc-0" }] },
      ],
    },
    {
      ...valid,
      messages: [
        { ...message, claims: [{ ...message.claims[0], exitCode: 0 }] },
      ],
    },
  ])
    assert.throws(() => validateGroupReply(invalid, snapshot, ["npc-0"]));
  snapshot.executions[0].receipt!.executed = false;
  assert.throws(
    () => validateGroupReply(valid, snapshot, ["npc-0"]),
    /runtime receipt/,
  );
});

test("a live group candidate is persisted as NPC-authored unvalidated content, never a workspace edit or human proof", async () => {
  const f = await liveFixture(async (payload) => response(reply(payload)));
  try {
    const workspace = f.e.workspace,
      revision = f.e.revision;
    await send(
      f.g,
      f.e,
      "group",
      "Could someone propose a boundary explanation?",
      r,
    );
    const proposal = f.e.history.find((h) => h.kind === "npc-proposal")!;
    assert.ok(proposal && proposal.author !== "human");
    assert.equal(f.e.workspace, workspace);
    assert.equal(f.e.revision, revision);
    assert.equal(f.g.study.learner!.evidence.length, 0);
    assert.equal(f.e.group.at(-1)!.presented, undefined);
    assert.match(f.e.group.at(-1)!.text, /not executed or validated/);
    presentMessages(f.g, f.e, "group");
    assert.ok(proposal.presented);
    assert.ok(evidencePacket(f.e, r).group.some((m) => m.kind === "npc"));
    assert.equal(
      JSON.stringify(decode(encode(f.g)).encounters[f.e.id].group),
      JSON.stringify(f.e.group),
    );
  } finally {
    await f.restore();
  }
});

test("superseded or stale group replies cannot append a candidate to a newer conversation or revision", async () => {
  const pending: { payload: any; resolve: (r: Response) => void }[] = [];
  const f = await liveFixture(
    async (payload) =>
      new Promise<Response>((resolve) => pending.push({ payload, resolve })),
  );
  try {
    const first = send(f.g, f.e, "group", "First question", r),
      second = send(f.g, f.e, "group", "Newer question", r);
    assert.equal(pending.length, 2);
    pending[0].resolve(response(reply(pending[0].payload, "OLD_REPLY")));
    await first;
    assert.ok(!f.e.group.some((m) => m.text.includes("OLD_REPLY")));
    assert.equal(f.e.groupRequests![0].state, "superseded");
    assert.equal(
      JSON.parse(f.e.groupRequests![0].payloadJson).requestId,
      pending[0].payload.requestId,
    );
    pending[1].resolve(response(reply(pending[1].payload, "CURRENT_REPLY")));
    await second;
    assert.ok(f.e.group.some((m) => m.text.includes("CURRENT_REPLY")));
    const stale = send(f.g, f.e, "group", "Reply to this workspace", r);
    f.e.revision++;
    f.e.workspace = "Newer workspace";
    pending[2].resolve(response(reply(pending[2].payload, "STALE_REVISION")));
    await stale;
    assert.ok(!f.e.group.some((m) => m.text.includes("STALE_REVISION")));
    assert.match(f.e.error!, /Workspace changed/);
  } finally {
    await f.restore();
  }
});

for (const changed of ["provider", "profile", "encounter"] as const)
  test(`a pending group reply cannot apply after its ${changed} changes`, async () => {
    let finish!: (response: Response) => void, packet: any;
    const f = await liveFixture(async (payload) => {
      packet = payload;
      return new Promise<Response>((resolve) => (finish = resolve));
    });
    try {
      const pending = send(f.g, f.e, "group", "Synthetic group question", r);
      if (changed === "provider") {
        const transport = globalThis.fetch;
        globalThis.fetch = async () =>
          response({
            mode: "development",
            label: "Synthetic disconnect",
            detail: "Fixture only",
            capabilities: [],
          });
        await checkBridge();
        globalThis.fetch = transport;
      } else if (changed === "profile") f.g.study.profile = "development";
      else f.g.encounters[f.e.id] = structuredClone(f.e);
      finish(response(reply(packet, "STALE_CONNECTION_REPLY")));
      await pending;
      assert.equal(f.e.groupRequests![0].state, "interrupted");
      assert.ok(
        !f.e.group.some((m) => m.text.includes("STALE_CONNECTION_REPLY")),
      );
      assert.ok(!f.e.history.some((h) => h.kind === "npc-proposal"));
    } finally {
      await f.restore();
    }
  });

test("E12 identical replies from different selected survivors are rejected atomically; distinct complementary replies remain allowed", () => {
  const snapshot: GroupSnapshot = {
    requestId: "complementary-reply",
    sourceRevision: 0,
    cutoff: 0,
    events: [],
    executions: [],
  };
  const first = {
    author: "npc-a",
    kind: "question",
    text: "Which input violates the boundary?\nCan we trace it?",
    refs: [],
  };
  const duplicate = {
    ...first,
    author: "npc-b",
    text: "  Which input violates the boundary?\r\nCan we trace it?  ",
  };
  const packet = {
    requestId: snapshot.requestId,
    sourceRevision: 0,
    messages: [first, duplicate],
  };
  assert.throws(
    () => validateGroupReply(packet, snapshot, ["npc-a", "npc-b"]),
    /duplicate.*text|distinct contribution/i,
  );
  packet.messages[1] = {
    ...duplicate,
    text: "I am unsure about the empty case; does the contract define it?",
  };
  assert.equal(
    validateGroupReply(packet, snapshot, ["npc-a", "npc-b"]).length,
    2,
  );
  assert.equal(snapshot.events.length, 0);
});
test("E20 unavailable survivors add no fake response or filler bubble and cause no model request", async () => {
  let calls = 0;
  const f = await liveFixture(async () => {
    calls++;
    throw Error("No request should be sent");
  });
  try {
    for (const a of f.g.survivors.slice(1)) a.activity = "fleeing";
    const prior = f.e.group.length;
    await send(f.g, f.e, "group", "Which boundary remains unresolved?", r);
    assert.equal(calls, 0);
    assert.equal(f.e.group.length, prior + 1);
    assert.equal(f.e.group.at(-1)!.author, "human");
    assert.deepEqual(f.e.recentSpeakers, []);
    assert.equal(f.e.groupRequests?.length ?? 0, 0);
  } finally {
    await f.restore();
  }
});
