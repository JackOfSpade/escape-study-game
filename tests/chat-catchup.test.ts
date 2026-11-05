import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { devProblem } from "./helpers/practice-questions";
import {
  checkBridge,
  closeChat,
  edit,
  openChat,
  presentWorkLog,
} from "../src/ai";
import { generateCatchup, type CatchupAdapter } from "../src/chat-catchup";
import { evidencePacket } from "../src/curriculum";
import { complete, step } from "../src/engine";
import type { Message, Roadmap } from "../src/model";
import { event } from "../src/model";
import { recordNpcWork } from "../src/npc-cognition";
import { decode, encode, recover } from "../src/persistence";
import { createGame } from "../src/world";

const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
async function fixture() {
  const g = createGame(7, r),
    e = g.encounters["f0-room0"],
    a = g.survivors[1];
  e.problem = devProblem(g, r);
  e.workspace = e.problem.starter;
  g.zombies = [];
  g.nextSpawn = Number.MAX_SAFE_INTEGER;
  a.milestone = 1;
  recordNpcWork(g, e, a, false);
  return { g, e, a };
}
function answer(payload: any) {
  return {
    requestId: payload.requestId,
    sourceRevision: payload.sourceRevision,
    messages: [
      {
        author: payload.speakers[0].id,
        kind: "observation",
        text: "Recorded work was tentative and included a contract review; no test execution is claimed.",
        refs: [payload.range.refs[0]],
      },
    ],
  };
}
function adapter(
  f: Awaited<ReturnType<typeof fixture>>,
  request: CatchupAdapter["request"],
): CatchupAdapter {
  return {
    request,
    append(author, kind, text, provenance, refs) {
      const ev = event(f.g, "message", text, f.e.floor, author, f.e.id);
      const m: Message = {
        id: `message-${ev.seq}`,
        author,
        kind,
        text,
        provenance,
        sourceRefs: refs,
        seq: ev.seq,
        worldTime: f.g.time,
      };
      f.e.group.push(m);
      return m;
    },
  };
}

test("catch-up freezes its range, coalesces pending opens and leaves simulation/newer code untouched", async () => {
  const f = await fixture();
  let calls = 0,
    captured: any,
    ready!: () => void,
    finish!: () => void;
  const entered = new Promise<void>((resolve) => {
      ready = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
  const transport = adapter(f, async (payload) => {
    calls++;
    captured = structuredClone(payload);
    ready();
    await gate;
    return answer(payload);
  });
  const first = generateCatchup(f.g, f.e, transport);
  await entered;
  assert.equal(generateCatchup(f.g, f.e, transport), first);
  assert.equal(f.e.group.length, 0);
  assert.equal(f.e.chatCursor, 0);
  f.g.status = "playing";
  for (const a of f.g.survivors.slice(1)) a.escaped = true;
  for (let i = 0; i < 10; i++) step(f.g, 1 / 30);
  edit(f.g, f.e, "Newer draft while the summary is pending", f.e.revision);
  assert.ok(f.g.time > 0.3);
  finish();
  await first;
  assert.equal(calls, 1);
  assert.equal(f.e.chatCursor, captured.range.to);
  assert.equal(f.e.workspace, "Newer draft while the summary is pending");
  assert.match(f.e.group[0].text, /through draft v0/);
  const messages = JSON.stringify(f.e.group),
    progress = f.e.npcProgress;
  await generateCatchup(f.g, f.e, transport);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(f.e.group), messages);
  assert.equal(f.e.npcProgress, progress);
  assert.equal(
    f.e.catchups![0].snapshot,
    undefined,
    "Applied jobs retain metadata, not another context/workspace copy",
  );
});

test("failed catch-up retains its cursor and retries the identical captured payload after reload and later work", async () => {
  const f = await fixture();
  const earlier = adapter(f, async () => undefined).append(
    "npc-0",
    "npc",
    "Which boundary should we examine?",
    "synthetic-prior-message",
    [],
  );
  edit(f.g, f.e, "Captured shared code", f.e.revision);
  let originalPayload = "";
  await generateCatchup(
    f.g,
    f.e,
    adapter(f, async (payload) => {
      originalPayload = JSON.stringify(payload);
      throw Error("Synthetic outage");
    }),
  );
  assert.equal(f.e.catchups![0].state, "unavailable");
  assert.equal(f.e.chatCursor, 0);
  assert.equal(f.e.group.length, 1);
  f.a.technical!.topics["PY:T05"] = 0.97;
  earlier.presented = event(
    f.g,
    "message-presented",
    "Prior message shown",
    0,
  ).seq;
  const restored = recover(decode(encode(f.g))),
    e = restored.encounters[f.e.id],
    a = restored.survivors[1];
  a.milestone++;
  recordNpcWork(restored, e, a, false);
  const continued = { g: restored, e, a };
  await generateCatchup(
    restored,
    e,
    adapter(continued, async (payload) => {
      assert.equal(JSON.stringify(payload), originalPayload);
      return answer(payload);
    }),
  );
  assert.equal(e.catchups![0].state, "applied");
  assert.ok(
    e.history.some((h) => h.kind === "npc-thought" && h.seq > e.chatCursor),
    "Work after the captured interval stays unconsumed",
  );
});

test("an interrupted saved request has its own coordinator after restore while the old object is still pending", async () => {
  const f = await fixture();
  let ready!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
      ready = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  const first = generateCatchup(
    f.g,
    f.e,
    adapter(f, async (payload) => {
      ready();
      await gate;
      return answer(payload);
    }),
  );
  await entered;
  const g = recover(decode(encode(f.g))),
    restored = { g, e: g.encounters[f.e.id], a: g.survivors[1] };
  assert.equal(restored.e.catchups![0].state, "interrupted");
  let retried = false;
  await generateCatchup(
    g,
    restored.e,
    adapter(restored, async (payload) => {
      retried = true;
      return answer(payload);
    }),
  );
  assert.equal(retried, true);
  assert.equal(restored.e.catchups![0].state, "applied");
  const transcript = JSON.stringify(restored.e.group);
  release();
  await first;
  assert.equal(JSON.stringify(restored.e.group), transcript);
});

test("accepted older revisions can be retried without substituting later edit history", async () => {
  const f = await fixture(),
    content = f.e.workspace;
  const submission = event(
    f.g,
    "submission",
    "Synthetic captured submission",
    0,
    "human",
    f.e.id,
  );
  f.e.submissions.push({
    id: "accepted",
    revision: 0,
    author: "human",
    content,
    status: "complete",
    feedback: "Synthetic fixture",
    seq: submission.seq,
  });
  edit(f.g, f.e, "Later unaccepted draft", 0);
  complete(f.g, f.e.id, "accepted", ["human"], "Synthetic fixture only");
  f.e.workspace = content;
  f.e.revision = 0;
  let first = "";
  await generateCatchup(
    f.g,
    f.e,
    adapter(f, async (payload) => {
      first = JSON.stringify(payload);
      throw Error("Offline");
    }),
  );
  await generateCatchup(
    f.g,
    f.e,
    adapter(f, async (payload: any) => {
      assert.equal(payload.workspace, content);
      assert.equal(JSON.stringify(payload), first);
      return answer(payload);
    }),
  );
  assert.equal(f.e.catchups![0].state, "applied");
});

test("invalid or prospective catch-up output cannot partially append messages or consume work", async () => {
  const f = await fixture();
  for (const invalid of ["identity", "proposal", "empty"]) {
    await generateCatchup(
      f.g,
      f.e,
      adapter(f, async (payload) => {
        const result = answer(payload);
        if (invalid === "identity") result.requestId = "wrong";
        if (invalid === "proposal") result.messages[0].kind = "proposal";
        if (invalid === "empty") result.messages = [];
        return result;
      }),
    );
    assert.equal(f.e.catchups!.length, 1);
    assert.equal(f.e.group.length, 0);
    assert.equal(f.e.chatCursor, 0);
    assert.equal(f.e.catchups![0].state, "unavailable");
  }
  await generateCatchup(
    f.g,
    f.e,
    adapter(f, async (payload) => answer(payload)),
  );
  assert.equal(f.e.catchups![0].state, "applied");
});

test("work log visibility creates assistance exposure without autonomous dialogue or retroactive taint", async () => {
  const f = await fixture();
  edit(f.g, f.e, "Independent reasoning before opening the log", f.e.revision);
  const before = f.g.seq;
  assert.equal(
    evidencePacket(f.e, r).assistanceSources.some(
      (m) => m.provenance === "visible-work-log",
    ),
    false,
  );
  presentWorkLog(f.g, f.e);
  const shown = f.g.seq;
  assert.ok(shown > before);
  assert.equal(f.e.group.length, 0);
  assert.equal(
    evidencePacket(f.e, r, before).assistanceSources.some(
      (m) => m.provenance === "visible-work-log",
    ),
    false,
  );
  assert.equal(
    evidencePacket(f.e, r).assistanceSources.filter(
      (m) => m.provenance === "visible-work-log",
    ).length,
    1,
  );
  presentWorkLog(f.g, f.e);
  assert.equal(f.g.seq, shown);
});

test("recorded fallback supersedes a pending native range and late output cannot reroll its displayed work", async () => {
  const f = await fixture();
  let ready!: () => void,
    release!: () => void,
    calls = 0;
  const entered = new Promise<void>((resolve) => {
      ready = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  const transport = adapter(f, async (payload) => {
    calls++;
    ready();
    await gate;
    return answer(payload);
  });
  const waiting = generateCatchup(f.g, f.e, transport);
  await entered;
  // The bridge became unavailable; opening now uses the explicit recorded log.
  openChat(f.g, f.e);
  assert.equal(f.e.catchups![0].state, "superseded");
  const shown = JSON.stringify(f.e.group);
  release();
  await waiting;
  assert.equal(JSON.stringify(f.e.group), shown);
  await generateCatchup(f.g, f.e, transport);
  assert.equal(calls, 1);
  assert.equal(f.e.catchups![0].snapshot, undefined);
});

test("native catch-up is capability gated and a pending range is materialized only once on reopen", async () => {
  const f = await fixture(),
    original = globalThis.fetch;
  let calls = 0,
    release!: () => void,
    entered!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
  globalThis.fetch = async (input, init) => {
    if (String(input) === "/api/status")
      return new Response(
        JSON.stringify({
          mode: "claude-cli",
          capabilities: ["retrospective-group"],
          label: "Synthetic catch-up",
          detail: "Not native-service validation",
        }),
      );
    const request = JSON.parse(String(init?.body));
    calls++;
    entered();
    await gate;
    assert.equal(request.operation, "group");
    assert.equal(request.payload.mode, "catch-up");
    return new Response(JSON.stringify(answer(request.payload)));
  };
  try {
    await checkBridge();
    f.g.study.profile = "live";
    const first = openChat(f.g, f.e);
    await ready;
    closeChat(f.g, f.e);
    const again = openChat(f.g, f.e);
    assert.equal(first, again);
    assert.equal(calls, 1);
    release();
    await first;
    const prior = JSON.stringify(f.e.group);
    closeChat(f.g, f.e);
    await openChat(f.g, f.e);
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(f.e.group), prior);
    assert.equal(f.g.study.learner!.evidence.length, 0);
  } finally {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          mode: "development",
          capabilities: [],
          label: "Fixture ended",
          detail: "Development fallback",
        }),
      );
    await checkBridge();
    globalThis.fetch = original;
  }
});

test("malformed capability metadata cannot enable native retrospective requests", async () => {
  const f = await fixture(),
    original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (input) => {
    if (String(input) === "/api/status")
      return new Response(
        JSON.stringify({
          mode: "claude-cli",
          capabilities: "retrospective-group",
          label: "Malformed",
          detail: "Not valid capability metadata",
        }),
      );
    requests++;
    throw Error("Must not dispatch");
  };
  try {
    const status = await checkBridge();
    assert.equal(status.mode, "development");
    f.g.study.profile = "live";
    await openChat(f.g, f.e);
    assert.equal(requests, 0);
    assert.match(f.e.catchupNotice!, /bridge catch-up unavailable/);
  } finally {
    globalThis.fetch = original;
  }
});

test("saved catch-up retains its provider and exact public packet across reload without forwarding a native retry", async () => {
  const f = await fixture();
  let body = "";
  await generateCatchup(f.g, f.e, {
    ...adapter(f, async (p) => {
      body = JSON.stringify(p);
      throw Error("offline");
    }),
    provider: "claude-cli",
  });
  const restored = recover(decode(encode(f.g))),
    next = {
      g: restored,
      e: restored.encounters[f.e.id],
      a: restored.survivors[1],
    };
  let calls = 0;
  await generateCatchup(
    next.g,
    next.e,
    adapter(next, async () => {
      calls++;
    }),
  );
  assert.equal(calls, 0);
  assert.match(next.e.catchupNotice!, /original.*provider/);
  await generateCatchup(next.g, next.e, {
    ...adapter(next, async (p) => {
      calls++;
      assert.equal(JSON.stringify(p), body);
      return answer(p);
    }),
    provider: "claude-cli",
  });
  assert.equal(calls, 1);
  assert.equal(next.e.catchups![0].state, "applied");
  assert.equal(next.e.group[0].provenance, "claude-cli-catch-up");
});
