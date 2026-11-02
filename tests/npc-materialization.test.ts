import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { edit, presentWorkLog } from "../src/ai";
import { eligible } from "../src/curriculum";
import { claimStation } from "../src/engine";
import { assistanceSources } from "../src/learner";
import type { Roadmap } from "../src/model";
import { recordNpcWork } from "../src/npc-cognition";
import {
  materializeNpcWork,
  type WorkPayload,
} from "../src/npc-materialization";
import { decode, encode, recover } from "../src/persistence";
import { reviewWorkspaceProposal } from "../src/workspace-proposals";
import { createGame } from "../src/world";
const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
function fixture() {
  const g = createGame(7, r),
    e = g.encounters["f0-room0"],
    stations = g.floors[0].stations.filter((s) => s.encounter === e.id),
    a = g.survivors[1];
  g.status = "playing";
  g.zombies = [];
  g.nextSpawn = Number.MAX_SAFE_INTEGER;
  for (const b of g.survivors.slice(2)) b.escaped = true;
  Object.assign(g.survivors[0], {
    x: stations[0].x,
    y: stations[0].y,
    station: stations[0].id,
  });
  Object.assign(a, {
    x: stations[1].x,
    y: stations[1].y,
    station: stations[1].id,
    intent: e.id,
    activity: "studying",
    milestone: 1,
  });
  e.state = "in-progress";
  e.humanEngaged = true;
  e.workspace = e.workspaceBase = "abc";
  e.problem = {
    title: "Synthetic notes fixture",
    prompt: "Examine the boundary",
    rubric: ["fixture"],
    starter: "abc",
    provenance: "study-mode",
    contract: eligible(r, g.study),
  };
  recordNpcWork(g, e, a, false);
  return { g, e, a };
}
function reply(p: WorkPayload) {
  return {
    requestId: p.requestId,
    sourceRevision: p.sourceRevision,
    notes: p.work.map((w) => ({
      workId: w.id,
      author: w.actor,
      text: "Tentative boundary: consider empty input before the first update.",
      refs: [w.seq],
      patch: { prefix: 1, removed: "b", inserted: "BOUNDARY" },
    })),
  };
}
test("observed NPC work creates concrete attributed notes and reviewable edits without dialogue, execution or human credit", async () => {
  const { g, e, a } = fixture(),
    study = JSON.stringify(g.study);
  let calls = 0;
  const run = async (p: WorkPayload) => {
    calls++;
    return reply(p);
  };
  await materializeNpcWork(g, e, run);
  assert.equal(e.materializations?.[0].state, "applied");
  assert.equal(e.workspace, "abc");
  assert.equal(e.group.length, 0);
  assert.equal(e.proposals?.length, 1);
  assert.equal(e.history.at(-1)?.author, a.id);
  assert.equal(assistanceSources(e).length, 0);
  assert.equal(materializeNpcWork(g, e, run), undefined);
  assert.equal(calls, 1);
  presentWorkLog(g, e);
  assert.ok(assistanceSources(e).some((s) => s.text.includes("empty input")));
  reviewWorkspaceProposal(g, e, e.proposals![0].id, "apply");
  assert.equal(e.workspace, "aBOUNDARYc");
  assert.equal(e.history.at(-1)?.author, a.id);
  assert.equal(JSON.stringify(g.study), study);
  assert.equal(e.executions?.length ?? 0, 0);
});
test("failure/reload retry retains the exact public snapshot and does not expose private tutor exchanges", async () => {
  const { g, e } = fixture();
  e.tutor.push({
    id: "private",
    author: "human",
    kind: "human",
    text: "PRIVATE_QUESTION",
    seq: ++g.seq,
    worldTime: g.time,
    provenance: "live-human",
  });
  e.history.push({
    seq: g.seq,
    author: "human",
    kind: "chat",
    text: "PRIVATE_QUESTION",
    at: g.time,
    revision: 0,
  });
  let captured = "";
  await materializeNpcWork(g, e, async (p) => {
    captured = JSON.stringify(p);
    throw Error("offline");
  });
  assert.ok(!captured.includes("PRIVATE_QUESTION"));
  assert.equal(e.materializations![0].state, "failed");
  assert.equal(
    materializeNpcWork(g, e, async () => {
      throw Error("must not auto retry");
    }),
    undefined,
  );
  const restored = recover(decode(encode(g))),
    current = restored.encounters[e.id];
  restored.survivors[0].station = g.survivors[0].station;
  await materializeNpcWork(
    restored,
    current,
    async (p) => {
      assert.equal(JSON.stringify(p), captured);
      return reply(p);
    },
    true,
  );
  assert.equal(current.materializations![0].state, "applied");
  assert.equal(current.proposals?.length, 1);
});
test("concurrent observation coalesces while simulation and human edits supersede a late result", async () => {
  const { g, e } = fixture();
  let finish!: (v: unknown) => void,
    payload!: WorkPayload,
    calls = 0;
  const adapter = (p: WorkPayload) => {
    calls++;
    payload = p;
    return new Promise((resolve) => (finish = resolve));
  };
  const pending = materializeNpcWork(g, e, adapter);
  assert.equal(materializeNpcWork(g, e, adapter), pending);
  while (!finish) await new Promise((resolve) => setTimeout(resolve, 1));
  edit(g, e, "new human work", e.revision);
  finish(reply(payload));
  await pending;
  assert.equal(calls, 1);
  assert.equal(e.materializations![0].state, "superseded");
  assert.equal(e.workspace, "new human work");
  assert.equal(e.proposals?.length ?? 0, 0);
});
test("invalid attribution or stale patch rejects a whole result without partial artifacts", async () => {
  for (const bad of ["author", "work", "patch", "revision", "ref"]) {
    const { g, e } = fixture(),
      before = e.history.length;
    await materializeNpcWork(g, e, async (p) => {
      const q = reply(p);
      if (bad === "author") q.notes[0].author = "human";
      if (bad === "work") q.notes[0].workId = "unknown";
      if (bad === "patch") q.notes[0].patch.removed = "wrong";
      if (bad === "revision") q.sourceRevision++;
      if (bad === "ref") q.notes[0].refs = [999999];
      return q;
    });
    assert.equal(e.materializations![0].state, "failed", bad);
    assert.equal(e.history.length, before);
    assert.equal(e.proposals?.length ?? 0, 0);
    assert.equal(e.workspace, "abc");
  }
});
test("departed contributors, unobserved terminals and consumed locks cannot materialize new work", async () => {
  const { g, e, a } = fixture();
  let calls = 0;
  const adapter = async (p: WorkPayload) => {
    calls++;
    return reply(p);
  };
  a.activity = "fleeing";
  await materializeNpcWork(g, e, adapter);
  assert.equal(calls, 0);
  a.activity = "studying";
  delete g.survivors[0].station;
  await materializeNpcWork(g, e, adapter);
  assert.equal(calls, 0);
  g.survivors[0].station = g.floors[0].stations.find(
    (s) => s.encounter === e.id,
  )!.id;
  e.state = "consumed";
  await materializeNpcWork(g, e, adapter);
  assert.equal(calls, 0);
});

test("older same-revision milestones coalesce into the latest note instead of draining a model-call backlog", async () => {
  const { g, e, a } = fixture();
  for (let i = 0; i < 24; i++) {
    a.milestone++;
    recordNpcWork(g, e, a, false);
  }
  let calls = 0;
  await materializeNpcWork(g, e, async (p) => {
    calls++;
    assert.equal(p.work.length, 1);
    assert.equal(p.work[0].id, e.npcWork!.at(-1)!.id);
    return reply(p);
  });
  assert.equal(
    e.npcWork!.length,
    4,
    "unchanged scoped cycles must not fabricate a backlog",
  );
  assert.equal(e.materializations![0].workIds.length, 4);
  assert.equal(
    materializeNpcWork(g, e, async () => {
      calls++;
      return {};
    }),
    undefined,
  );
  assert.equal(calls, 1);
});
test("interrupted in-flight work retries exactly after recovery and corrupt context cannot dispatch", async () => {
  const { g, e } = fixture();
  let finish!: (v: unknown) => void, captured!: WorkPayload;
  const first = materializeNpcWork(g, e, (p) => {
    captured = p;
    return new Promise((resolve) => (finish = resolve));
  });
  while (!finish) await new Promise((resolve) => setTimeout(resolve, 1));
  const restored = recover(decode(encode(g))),
    current = restored.encounters[e.id];
  restored.survivors[0].station = g.survivors[0].station;
  assert.equal(current.materializations![0].state, "interrupted");
  await materializeNpcWork(
    restored,
    current,
    async (p) => {
      assert.equal(JSON.stringify(p), JSON.stringify(captured));
      return reply(p);
    },
    true,
  );
  assert.equal(current.materializations![0].state, "applied");
  const bad = recover(decode(encode(g))),
    badEncounter = bad.encounters[e.id];
  bad.survivors[0].station = g.survivors[0].station;
  badEncounter.materializations![0].payload!.workspace = "tampered";
  let calls = 0;
  await materializeNpcWork(
    bad,
    badEncounter,
    async () => {
      calls++;
      return {};
    },
    true,
  );
  assert.equal(calls, 0);
  assert.equal(badEncounter.materializations![0].state, "failed");
  edit(g, e, "superseding old instance", e.revision);
  finish(reply(captured));
  await first;
  assert.equal(e.materializations![0].state, "superseded");
  assert.equal(current.workspace, "abc");
});
test("a malformed second contributor is rejected atomically and no partial first artifact is committed", async () => {
  const { g, e } = fixture(),
    a = g.survivors[2],
    st = g.floors[0].stations.filter((s) => s.encounter === e.id)[2];
  Object.assign(a, {
    escaped: false,
    x: st.x,
    y: st.y,
    station: st.id,
    intent: e.id,
    activity: "studying",
    milestone: 1,
  });
  recordNpcWork(g, e, a, false);
  const before = e.history.length;
  await materializeNpcWork(g, e, async (p) => {
    const q = reply(p);
    assert.equal(q.notes.length, 2);
    q.notes[1].patch.removed = "invalid";
    return q;
  });
  assert.equal(e.materializations![0].state, "failed");
  assert.equal(e.history.length, before);
  assert.equal(e.proposals?.length ?? 0, 0);
});

test("saved work cannot cross runs and a contributor leaving during generation invalidates the result", async () => {
  const { g, e } = fixture();
  await materializeNpcWork(g, e, async () => {
    throw Error("offline");
  });
  g.id += "-different-run";
  let calls = 0;
  await materializeNpcWork(
    g,
    e,
    async (p) => {
      calls++;
      return reply(p);
    },
    true,
  );
  assert.equal(calls, 0);
  assert.match(e.materializations![0].error!, /another run or terminal/);
  const f = fixture();
  let finish!: (v: unknown) => void, payload!: WorkPayload;
  const pending = materializeNpcWork(f.g, f.e, (p) => {
    payload = p;
    return new Promise((resolve) => (finish = resolve));
  });
  while (!finish) await new Promise((resolve) => setTimeout(resolve, 1));
  f.a.escaped = true;
  finish(reply(payload));
  await pending;
  assert.equal(f.e.materializations![0].state, "superseded");
  assert.equal(f.e.proposals?.length ?? 0, 0);
});

test("ChatGPT team notes retain provider through failure/reload and cannot be retried as native work", async () => {
  const { g, e } = fixture();
  let original = "";
  await materializeNpcWork(
    g,
    e,
    async (p) => {
      original = JSON.stringify(p);
      throw Error("offline");
    },
    false,
    { provider: "chatgpt-handoff" },
  );
  const next = recover(decode(encode(g))),
    saved = next.encounters[e.id];
  assert.ok(claimStation(next, next.survivors[0], g.survivors[0].station!));
  let calls = 0;
  assert.equal(
    materializeNpcWork(
      next,
      saved,
      async () => {
        calls++;
      },
      true,
    ),
    undefined,
  );
  assert.match(saved.materializationNotice!, /original.*provider/);
  assert.equal(calls, 0);
  await materializeNpcWork(
    next,
    saved,
    async (p) => {
      calls++;
      assert.equal(JSON.stringify(p), original);
      assert.equal(p.autonomyAllowed, undefined);
      return reply(p);
    },
    true,
    { provider: "chatgpt-handoff" },
  );
  assert.equal(
    saved.materializations![0].state,
    "applied",
    saved.materializations![0].error,
  );
  assert.equal(saved.materializations![0].provider, "chatgpt-handoff");
  assert.equal(saved.materializations![0].payload, undefined);
  assert.match(saved.history.at(-1)!.text, /through ChatGPT handoff/);
  assert.equal(saved.workspace, "abc");
  assert.equal(saved.proposals![0].autonomous, undefined);
});

import { localHandoff } from "./helpers/local-handoff";
test("actual HTTP team-work handoff corrects malformed notes without applying NPC code or awarding human credit", async () => {
  const { g, e } = fixture(),
    relay = await localHandoff(),
    before = JSON.stringify(g.study);
  try {
    await materializeNpcWork(
      g,
      e,
      (p) =>
        relay.request("materialize-work", p, (job) => {
          assert.equal(job.payload.autonomyAllowed, undefined);
          const valid = reply(p);
          return {
            valid,
            invalid: [
              { ...valid, sourceRevision: 999 },
              { ...valid, notes: [{ ...valid.notes[0], author: "human" }] },
              { ...valid, notes: [{ ...valid.notes[0], refs: [-1] }] },
              {
                ...valid,
                notes: [
                  {
                    ...valid.notes[0],
                    patch: { prefix: 1, removed: "wrong", inserted: "changed" },
                  },
                ],
              },
              { ...valid, notes: [{ ...valid.notes[0], readyToSubmit: true }] },
            ],
          };
        }),
      false,
      { provider: "claude-cli" },
    );
    assert.equal(
      e.materializations![0].state,
      "applied",
      e.materializations![0].error,
    );
    assert.equal(e.workspace, "abc");
    assert.equal(e.group.length, 0);
    assert.equal(e.proposals![0].autonomous, undefined);
    assert.equal(JSON.stringify(g.study), before);
    assert.equal(relay.completed, 1);
  } finally {
    await relay.close();
  }
});
