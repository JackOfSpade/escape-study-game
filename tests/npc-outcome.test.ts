import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { initialStudy } from "../src/curriculum";
import { complete } from "../src/engine";
import { type Problem, type Roadmap } from "../src/model";
import { recordNpcWork } from "../src/npc-cognition";
import {
  inspectNpcOutcome,
  outcomeIsVisible,
  presentNpcOutcome,
  type OutcomeCandidate,
  type OutcomePayload,
} from "../src/npc-outcome";
import { decode, encode, recover } from "../src/persistence";
import { createGame } from "../src/world";
const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
function fixture() {
  const g = createGame(72, r, initialStudy(r, "live")),
    e = g.encounters["f0-room0"],
    a = g.survivors[1];
  g.study.learner!.reviews = {};
  a.milestone = 1;
  recordNpcWork(g, e, a, false);
  e.contributors = [a.id];
  complete(
    g,
    e.id,
    `npc-sim-${e.id}`,
    e.contributors,
    "Simulated NPC-only success; no runtime execution",
  );
  assert.ok(e.simulatedOutcome);
  const calls: { operation: string; payload: any }[] = [];
  const candidate = (p: OutcomePayload): OutcomeCandidate => ({
    requestId: p.requestId,
    problem: p.commitment.problem ?? {
      title: "Synthetic reconstructed problem",
      prompt: "Synthetic compatible question",
      starter: "",
      rubric: [],
      provenance: "study-mode",
      contract: p.contract,
      scopeDefinitions: p.contract.objectiveIds.map((id, i) => ({
        id: `${id}/D${p.contract.depth}`,
        objectiveId: id,
        depth: p.contract.depth,
        sourceScope: p.contract.scopes[i],
        facets: [{ id: "scope", description: "Synthetic scope" }],
      })),
    },
    solution: "Synthetic candidate reasoning",
    authors: [a.id],
    refs: [p.commitment.work[0].seq],
    execution: "not-run",
  });
  const adapter = {
    validate(p: Problem, c: Problem["contract"]) {
      assert.equal(JSON.stringify(p.contract), JSON.stringify(c));
    },
    async request(
      operation: "materialize-outcome" | "complete",
      payload: any,
    ): Promise<unknown> {
      calls.push({ operation, payload: structuredClone(payload) });
      return operation === "materialize-outcome"
        ? structuredClone(candidate(payload))
        : {
            requestId: payload.requestId,
            complete: true,
            feedback: "Synthetic semantic validation only",
            execution: "not-run",
          };
    },
  };
  return { g, e, a, calls, candidate, adapter };
}
test("NPC-only completion freezes semantic provenance; on-demand validation retains an exact solution without rewriting world or learner history", async () => {
  const { g, e, a, calls, adapter } = fixture(),
    learning = JSON.stringify(g.study),
    old = JSON.stringify({
      workspace: e.workspace,
      problem: e.problem,
      revision: e.revision,
      accepted: e.accepted,
      access: a.access,
      history: e.history,
    });
  assert.equal(calls.length, 0);
  await inspectNpcOutcome(g, e, r, adapter);
  assert.equal(e.outcomeInspection!.state, "applied");
  assert.equal(calls.length, 2);
  assert.equal(JSON.stringify(g.study), learning);
  assert.equal(
    JSON.stringify({
      workspace: e.workspace,
      problem: e.problem,
      revision: e.revision,
      accepted: e.accepted,
      access: a.access,
      history: e.history,
    }),
    old,
  );
  assert.equal(outcomeIsVisible(g, e, r), true);
  presentNpcOutcome(g, e, r);
  const exposed = e.history.at(-1)!;
  assert.equal(exposed.kind, "workspace-view");
  assert.equal(exposed.author, a.id);
  assert.ok(exposed.presented! > e.simulatedOutcome!.cutoff);
  assert.equal(e.history.filter((h) => h.kind === "edit").length, 0);
  const history = JSON.stringify(e.history);
  presentNpcOutcome(g, e, r);
  await inspectNpcOutcome(g, e, r, adapter);
  assert.equal(JSON.stringify(e.history), history);
  assert.equal(calls.length, 2);
  const restored = recover(decode(encode(g)));
  await inspectNpcOutcome(restored, restored.encounters[e.id], r, adapter);
  assert.equal(calls.length, 2);
  assert.equal(JSON.stringify(restored.study), learning);
});
test("failed validation defers exact artifacts and explicit retry uses the identical saved candidate", async () => {
  const f = fixture();
  let fail = true;
  const request = async (
    op: "materialize-outcome" | "complete",
    payload: any,
  ) =>
    op === "complete" && fail
      ? (f.calls.push({ operation: op, payload: structuredClone(payload) }),
        {
          requestId: payload.requestId,
          complete: false,
          feedback: "Synthetic mismatch",
          execution: "not-run",
        })
      : f.adapter.request(op, payload);
  await inspectNpcOutcome(f.g, f.e, r, { ...f.adapter, request });
  assert.equal(f.e.outcomeInspection!.state, "failed");
  assert.equal(outcomeIsVisible(f.g, f.e, r), false);
  assert.equal(f.e.accepted, `npc-sim-${f.e.id}`);
  assert.equal(f.e.state, "consumed");
  await inspectNpcOutcome(f.g, f.e, r, { ...f.adapter, request });
  assert.equal(f.calls.length, 2);
  fail = false;
  await inspectNpcOutcome(f.g, f.e, r, { ...f.adapter, request }, true);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls[1].payload, f.calls[2].payload);
  assert.equal(f.e.outcomeInspection!.state, "applied");
});
test("interrupted outcome generation resumes its exact frozen request after reload, even if the NPC has since died", async () => {
  const f = fixture();
  let release!: (value: unknown) => void, captured!: OutcomePayload;
  const pending = inspectNpcOutcome(f.g, f.e, r, {
    ...f.adapter,
    request: async (op, payload) => {
      assert.equal(op, "materialize-outcome");
      captured = structuredClone(payload as OutcomePayload);
      return new Promise((resolve) => (release = resolve));
    },
  });
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
  const restored = recover(decode(encode(f.g))),
    e = restored.encounters[f.e.id];
  assert.equal(e.outcomeInspection!.state, "interrupted");
  restored.survivors[1].alive = false;
  await inspectNpcOutcome(restored, e, r, f.adapter, true);
  assert.equal(JSON.stringify(f.calls[0].payload), JSON.stringify(captured));
  assert.equal(e.outcomeInspection!.state, "applied");
  release(f.candidate(captured));
  await pending;
});
test("committed question is immutable and private human data never enters the outcome context", async () => {
  const f = fixture();
  // A pre-generated but unobserved question remains exact when later reconstructed.
  // Use a genuine scheduled captured contract from the first request instead.
  await inspectNpcOutcome(f.g, f.e, r, f.adapter);
  const exact = structuredClone(f.e.outcomeInspection!.candidate!.problem);
  delete f.e.outcomeInspection;
  f.calls.length = 0;
  f.e.problem = exact;
  f.e.simulatedOutcome!.problem = structuredClone(exact);
  f.e.tutor.push({
    id: "private",
    author: "human",
    kind: "human",
    text: "PRIVATE_TUTOR_SECRET",
    seq: ++f.g.seq,
    worldTime: 0,
    provenance: "private",
  });
  const adapter = {
    ...f.adapter,
    request: async (op: "materialize-outcome" | "complete", payload: any) => {
      const result: any = await f.adapter.request(op, payload);
      if (op === "materialize-outcome")
        result.problem.prompt = "Changed question";
      return result;
    },
  };
  await inspectNpcOutcome(f.g, f.e, r, adapter);
  assert.equal(f.e.outcomeInspection!.state, "failed");
  assert.match(f.e.outcomeInspection!.error!, /committed question/);
  assert.ok(!JSON.stringify(f.calls).includes("PRIVATE_TUTOR_SECRET"));
  assert.deepEqual(f.e.problem, exact);
});
for (const mutation of [
  "commitment",
  "workspace",
  "candidate",
  "payload",
  "ceiling",
] as const)
  test(`held outcome validation rejects changed ${mutation} without changing world rewards`, async () => {
    const f = fixture();
    let release!: (v: unknown) => void, payload: any;
    const adapter = {
      ...f.adapter,
      request: async (op: "materialize-outcome" | "complete", p: any) => {
        if (op === "materialize-outcome") return f.adapter.request(op, p);
        payload = p;
        return new Promise((resolve) => (release = resolve));
      },
    };
    const pending = inspectNpcOutcome(f.g, f.e, r, adapter);
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    if (mutation === "commitment") f.e.simulatedOutcome!.cutoff++;
    if (mutation === "workspace") f.e.workspace = "Changed source";
    if (mutation === "candidate")
      f.e.outcomeInspection!.candidate!.solution = "Changed candidate";
    if (mutation === "payload")
      f.e.outcomeInspection!.payload.instruction = "Changed request";
    if (mutation === "ceiling")
      f.g.study.learner!.tracks[
        f.e.outcomeInspection!.payload.contract.track
      ].tier = 0;
    const access = JSON.stringify(f.a.access);
    release({
      requestId: payload.requestId,
      complete: true,
      feedback: "Held synthetic check",
      execution: "not-run",
    });
    await pending;
    assert.equal(f.e.outcomeInspection!.state, "failed");
    assert.equal(JSON.stringify(f.a.access), access);
    assert.equal(f.e.state, "consumed");
  });
test("malformed authors, refs, runtime claims and stale request IDs never reach validation or presentation", async () => {
  for (const kind of ["author", "refs", "execution", "identity"] as const) {
    const f = fixture();
    await inspectNpcOutcome(f.g, f.e, r, {
      ...f.adapter,
      request: async (op, payload) => {
        assert.equal(op, "materialize-outcome");
        const result: any = f.candidate(payload as OutcomePayload);
        if (kind === "author") result.authors = ["human"];
        if (kind === "refs") result.refs = [999999];
        if (kind === "execution") result.execution = "executed";
        if (kind === "identity") result.requestId = "another-job";
        return result;
      },
    });
    assert.equal(f.e.outcomeInspection!.state, "failed");
    assert.equal(f.e.outcomeInspection!.candidate, undefined);
    assert.equal(outcomeIsVisible(f.g, f.e, r), false);
  }
});
test("ceiling changes hide a saved reconstruction and pending archived requests recover as interrupted", async () => {
  const f = fixture();
  await inspectNpcOutcome(f.g, f.e, r, f.adapter);
  const track = f.e.outcomeInspection!.payload.contract.track,
    tier = f.g.study.learner!.tracks[track].tier;
  f.g.study.learner!.tracks[track].tier = 0;
  assert.equal(outcomeIsVisible(f.g, f.e, r), false);
  const before = f.e.history.length;
  presentNpcOutcome(f.g, f.e, r);
  assert.equal(f.e.history.length, before);
  f.g.study.learner!.tracks[track].tier = tier;
  assert.equal(outcomeIsVisible(f.g, f.e, r), true);
  const solution = f.e.outcomeInspection!.candidate!.solution;
  f.e.outcomeInspection!.candidate!.solution = "Changed after validation";
  assert.equal(outcomeIsVisible(f.g, f.e, r), false);
  f.e.outcomeInspection!.candidate!.solution = solution;
  f.e.outcomeInspection!.state = "pending";
  f.g.study.archives.push(f.e);
  delete f.g.encounters[f.e.id];
  const restored = recover(decode(encode(f.g)));
  assert.equal(
    restored.study.archives[0].outcomeInspection!.state,
    "interrupted",
  );
});

test("ChatGPT reconstruction keeps provider through retry and separate validation without changing simulated rewards or human evidence", async () => {
  const f = fixture(),
    before = JSON.stringify(f.g.study),
    outcome = JSON.stringify(f.e.simulatedOutcome);
  let original = "";
  await inspectNpcOutcome(f.g, f.e, r, {
    ...f.adapter,
    provider: "chatgpt-handoff",
    request: async (_op, p) => {
      original = JSON.stringify(p);
      throw Error("offline");
    },
  });
  const next = recover(decode(encode(f.g))),
    e = next.encounters[f.e.id];
  let calls = 0;
  assert.equal(
    inspectNpcOutcome(
      next,
      e,
      r,
      {
        ...f.adapter,
        request: async () => {
          calls++;
        },
      },
      true,
    ),
    undefined,
  );
  assert.equal(calls, 0);
  assert.match(e.outcomeNotice!, /original.*provider/);
  await inspectNpcOutcome(
    next,
    e,
    r,
    {
      ...f.adapter,
      provider: "chatgpt-handoff",
      request: async (op, p: any) => {
        calls++;
        if (op === "materialize-outcome") {
          assert.equal(JSON.stringify(p), original);
          const result = f.candidate(p);
          result.problem.provenance = "chatgpt-handoff";
          return result;
        }
        assert.equal(p.provider, "chatgpt-handoff");
        return {
          requestId: p.requestId,
          complete: true,
          feedback: "Synthetic compatible task",
          execution: "not-run",
        };
      },
    },
    true,
  );
  assert.equal(
    e.outcomeInspection!.state,
    "applied",
    e.outcomeInspection!.error,
  );
  assert.equal(calls, 2);
  assert.equal(e.outcomeInspection!.payload.provider, "chatgpt-handoff");
  assert.equal(JSON.stringify(e.simulatedOutcome), outcome);
  assert.equal(JSON.stringify(next.study), before);
  presentNpcOutcome(next, e, r);
  assert.match(
    e.history.at(-1)!.text,
    /Reconstructed now through ChatGPT handoff/,
  );
  assert.equal(next.study.learner!.evidence.length, 0);
});

test("new reconstructed questions cannot falsely claim another provider, while committed questions retain their exact original provenance", async () => {
  const f = fixture();
  await inspectNpcOutcome(f.g, f.e, r, {
    ...f.adapter,
    provider: "chatgpt-handoff",
  });
  assert.equal(f.e.outcomeInspection!.state, "failed");
  assert.match(f.e.outcomeInspection!.error!, /provenance/);
  assert.equal(
    f.calls.length,
    1,
    "Wrong authoring provenance never reaches separate completion validation",
  );
  const committed = fixture();
  const problem = f.candidate(f.e.outcomeInspection!.payload).problem;
  committed.e.problem = structuredClone(problem);
  committed.e.simulatedOutcome!.problem = structuredClone(problem);
  await inspectNpcOutcome(committed.g, committed.e, r, {
    ...committed.adapter,
    provider: "chatgpt-handoff",
  });
  assert.equal(
    committed.e.outcomeInspection!.state,
    "applied",
    committed.e.outcomeInspection!.error,
  );
  assert.deepEqual(committed.e.outcomeInspection!.candidate!.problem, problem);
  assert.equal(
    committed.e.outcomeInspection!.candidate!.problem.provenance,
    "study-mode",
  );
  assert.equal(
    committed.e.outcomeInspection!.payload.provider,
    "chatgpt-handoff",
  );
});

import { localHandoff } from "./helpers/local-handoff";
test("actual HTTP reconstruction requires a separate correlated semantic validation before publication, without execution or new rewards", async () => {
  const f = fixture(),
    relay = await localHandoff(),
    before = JSON.stringify(f.g.study),
    accepted = f.e.accepted;
  try {
    await inspectNpcOutcome(f.g, f.e, r, {
      ...f.adapter,
      provider: "claude-cli",
      request: (op, p: any) =>
        relay.request(op, p, () => {
          if (op === "materialize-outcome") {
            const valid = f.candidate(p);
            valid.problem.provenance = "claude-cli";
            return {
              valid,
              invalid: [
                { ...valid, execution: "executed" },
                { ...valid, authors: ["human"] },
                { ...valid, refs: [-1] },
                {
                  ...valid,
                  problem: { ...valid.problem, provenance: "study-mode" },
                },
              ],
            };
          }
          assert.equal(f.e.outcomeInspection!.state, "pending");
          assert.equal(outcomeIsVisible(f.g, f.e, r), false);
          const valid = {
            requestId: p.requestId,
            complete: true,
            feedback: "Synthetic semantic validation only",
            execution: "not-run",
          };
          return {
            valid,
            invalid: [
              { ...valid, requestId: "other" },
              { ...valid, execution: "executed" },
            ],
          };
        }),
    });
    assert.equal(
      f.e.outcomeInspection!.state,
      "applied",
      f.e.outcomeInspection!.error,
    );
    assert.equal(outcomeIsVisible(f.g, f.e, r), true);
    assert.equal(f.e.accepted, accepted);
    assert.equal(JSON.stringify(f.g.study), before);
    assert.equal(relay.completed, 2);
    assert.equal(f.e.executions?.length ?? 0, 0);
  } finally {
    await relay.close();
  }
});
