import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createHandoffQueue,
  HANDOFF_REQUESTER_LIVE_MS,
  legacyWorkerJob,
} from "../scripts/chatgpt-handoff-queue.mjs";
import {
  createTerminalRelayApp,
  terminalRelayTools,
} from "../scripts/terminal-relay-app.mjs";
const owner = { linkId: "native-preparation-owner" },
  other = { linkId: "native-preparation-other" };
const scope = {
  runId: "run-synthetic-modern",
  encounterId: "station-one",
  questionRoom: "room-one",
};
const contract = {
  track: "PY",
  objectiveIds: ["PY:synthetic"],
  scopes: ["Exact source scope"],
  depth: 1,
  practice: false,
};
const gen = (requestId = "modern-generation", s = scope, extra = {}) => ({
  requestId,
  encounterId: s.encounterId,
  contract,
  generationPolicy: "Ask one bounded conceptual question.",
  careerScopeGuidance: "Keep Python interview fundamentals.",
  curriculum: "FULL ORIGINAL SOURCE ROWS",
  progressContext: "SOURCE PROGRESS ROWS",
  existingScopeDefinitions: {},
  probeRecords: { openGaps: [] },
  runtimeSupport: { scripts: ["python"] },
  ...extra,
});
const generated = {
  title: "Synthetic generated question",
  prompt: "Explain the bounded source scope.",
  starter: "",
  rubric: ["Explain source scope"],
  contract,
  scopeDefinitions: [
    {
      id: "PY:synthetic/D1",
      objectiveId: "PY:synthetic",
      depth: 1,
      sourceScope: "Exact source scope",
      facets: [{ id: "scope", description: "Explain source scope" }],
    },
  ],
};
const direct = (requestId = "modern-direct", s = scope, extra = {}) => ({
  requestId,
  sessionId: `${s.runId}/${s.encounterId}/private`,
  runId: s.runId,
  encounterId: s.encounterId,
  mode: "terminal-direct",
  profile: "live",
  questionFingerprint: `${requestId}-fingerprint`,
  problem: generated,
  messages: [],
  probe: { facets: [{ id: "scope", description: "Explain source scope" }] },
  ...extra,
});
const assessment = (
  requestId = "modern-assessment",
  s = scope,
  extra = {},
) => ({
  requestId,
  packet: {
    encounter: s.encounterId,
    problem: generated,
    assessmentCriteria: "FULL ORIGINAL SOURCE CRITERIA",
    sourceHash: "exact-source-hash",
    history: [
      {
        seq: 1,
        author: "human",
        kind: "reasoning",
        text: "Actual synthetic answer",
      },
    ],
    assistanceSources: [
      { id: "help-1", text: "Visible synthetic help", presented: 1 },
    ],
    scopePolicy: "Attribute every visible source.",
    assessmentPolicy: "Only authored work establishes knowledge.",
    ...extra,
  },
});
const assessed = {
  findings: [
    {
      objectiveId: "PY:synthetic",
      depth: 1,
      facet: "scope",
      outcome: "assisted",
      evidence: [1],
      completeCheckpointScope: false,
      execution: "not-run",
      rationale: "Synthetic attributed answer",
    },
  ],
  visitOutcome: "usable",
  scopeReviews: [
    {
      id: "PY:synthetic/D1",
      completeCoverage: true,
      rationale: "Exact source scope",
    },
  ],
  helpAttributions: [
    { messageId: "help-1", facets: ["scope"], rationale: "Visible help used" },
  ],
};
function setup({ waitMs = 10 } = {}) {
  let clock = 1000;
  const queue = createHandoffQueue({ now: () => clock });
  const app = createTerminalRelayApp({
    queue,
    now: () => clock,
    continuationWaitMs: waitMs,
  });
  queue.enable(true);
  const call = (name, args = {}, grant = owner) => app.call(name, args, grant);
  const value = (name, args = {}, grant = owner) =>
    call(name, args, grant).structuredContent;
  const enqueue = (operation, payload, nativeScope = scope) => {
    const receipt = queue.enqueue(operation, payload, nativeScope);
    queue.result(receipt.id, receipt.hash);
    return receipt;
  };
  const finish = (turn, response = generated, grant = owner) =>
    value(
      "finish_study_preparation",
      {
        relayId: turn.relayId,
        turnId: turn.turnId,
        jobFingerprint: turn.jobFingerprint,
        response: JSON.stringify(response),
      },
      grant,
    );
  return {
    queue,
    app,
    call,
    value,
    enqueue,
    finish,
    tick: (n) => {
      clock += n;
    },
  };
}
const finishDirect = (f, turn) =>
  f.value("finish_study_question", {
    relayId: turn.relayId,
    turnId: turn.turnId,
    questionFingerprint: turn.questionFingerprint,
    text: "Native answer sent for validation.",
    outcome: "solved",
    transcript: [
      { role: "assistant", text: "Explain source scope." },
      { role: "user", text: "Synthetic complete answer." },
    ],
    knowledge: { facets: [{ id: "scope", status: "demonstrated" }] },
  });

test("game polling does not keep a silent preparation worker active or refresh its work timestamp", () => {
  const f = setup();
  const receipt = f.enqueue(
    "generate",
    gen("worker-activity", scope, {
      curriculum: "Synthetic source ".repeat(5000),
    }),
  );
  const turn = f.value("get_current_study_question");
  assert.equal(f.app.status().activeSessions, 1);
  const claimedAt = 1000;
  f.tick(6 * 60_000);
  f.queue.result(receipt.id, receipt.hash);
  assert.equal(f.app.status().activeSessions, 0);
  assert.equal(
    f.app.status().pendingTurns,
    1,
    "silence retains the exact claim",
  );
  assert.equal(
    f.queue.progress(receipt.id, receipt.hash).lastWorkerActivityAt,
    claimedAt,
  );
  f.value("read_study_terminal_context", {
    relayId: turn.relayId,
    turnId: turn.turnId,
    part: "payload",
    index: 0,
  });
  assert.equal(f.app.status().activeSessions, 1);
  assert.equal(
    f.queue.progress(receipt.id, receipt.hash).lastWorkerActivityAt,
    claimedAt + 6 * 60_000,
  );
  assert.equal(f.value("get_current_study_question").turnId, turn.turnId);
});

test("rejected exact native completion records contact while unrelated identities cannot fake activity", () => {
  const f = setup();
  const receipt = f.enqueue("generate", gen("rejected-native-activity"));
  const turn = f.value("get_current_study_question");
  const args = {
    relayId: turn.relayId,
    turnId: turn.turnId,
    jobFingerprint: turn.jobFingerprint,
    response: "{}",
  };
  f.tick(6 * 60_000);
  f.queue.result(receipt.id, receipt.hash);
  for (const [changes, grant] of [
    [{ turnId: "wrong-turn" }, owner],
    [{ jobFingerprint: "a".repeat(64) }, owner],
    [{}, other],
  ]) {
    assert.throws(() =>
      f.value("finish_study_preparation", { ...args, ...changes }, grant),
    );
    assert.equal(
      f.queue.progress(receipt.id, receipt.hash).lastWorkerActivityAt,
      1000,
    );
  }
  let expectedActivity = 361000;
  for (const response of ["not JSON", "{}"]) {
    f.tick(1000);
    expectedActivity += 1000;
    assert.throws(() =>
      f.value("finish_study_preparation", { ...args, response }),
    );
    assert.equal(
      f.queue.progress(receipt.id, receipt.hash).lastWorkerActivityAt,
      expectedActivity,
    );
    assert.equal(f.queue.result(receipt.id, receipt.hash).status, "pending");
  }
  assert.equal(f.value("get_current_study_question").turnId, turn.turnId);
  f.finish(turn);
  assert.equal(f.queue.result(receipt.id, receipt.hash).status, "done");
});

test("modern preparation schema uses explicit native claim identity and frozen payload, never legacy worker sessions", () => {
  const f = setup();
  const receipt = f.enqueue("generate", gen());
  const turn = f.value("get_current_study_question");
  assert.equal(turn.status, "prepare");
  assert.equal(turn.phase, "prepare");
  assert.equal(turn.jobFingerprint, receipt.hash);
  assert.deepEqual(turn.nativeScope, scope);
  assert.match(turn.prompt, /finish_study_preparation/);
  assert.match(turn.prompt, /FULL ORIGINAL SOURCE ROWS/);
  assert.doesNotMatch(turn.prompt, /Worker session:/);
  assert.deepEqual(f.value("get_current_study_question"), turn);
  const schema = terminalRelayTools().find(
    (t) => t.name === "finish_study_preparation",
  ).inputSchema;
  assert.deepEqual(schema.required, [
    "relayId",
    "turnId",
    "jobFingerprint",
    "response",
  ]);
  assert.equal(schema.additionalProperties, false);
  const done = f.finish(turn);
  assert.equal(done.completion.status, "sent");
  assert.equal(done.completion.operation, "generate");
  assert.deepEqual(f.queue.result(receipt.id, receipt.hash).answer, generated);
  assert.equal(f.finish(turn).completion.duplicate, true);
  assert.throws(
    () => f.finish(turn, { ...generated, prompt: "changed" }),
    /Conflicting/,
  );
});

test("validated native enqueue is immediately live, exact retry renews it, and restored abandoned work stays inactive", () => {
  for (const [operation, payload, expected] of [
    ["generate", gen(), "prepare"],
    ["assess", assessment(), "assess"],
    ["tutor", direct(), "question"],
  ]) {
    let clock = 1000;
    const queue = createHandoffQueue({ now: () => clock });
    queue.enable(true);
    const receipt = queue.enqueue(operation, payload, scope);
    const app = createTerminalRelayApp({ queue, now: () => clock });
    assert.equal(queue.snapshot().recent[0].firstPolledAt, undefined);
    assert.equal(
      app.call("get_current_study_question", {}, owner).structuredContent
        .status,
      expected,
    );
    clock += HANDOFF_REQUESTER_LIVE_MS + 1;
    assert.equal(
      app.call("get_current_study_question", {}, owner).structuredContent
        .status,
      "waiting",
    );
    assert.deepEqual(queue.enqueue(operation, payload, scope), receipt);
    assert.equal(
      app.call("get_current_study_question", {}, owner).structuredContent
        .status,
      expected,
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "native-enqueue-liveness-"));
  try {
    const file = join(dir, "queue.json"),
      payload = gen();
    let queue = createHandoffQueue({ file });
    queue.enable(true);
    const receipt = queue.enqueue("generate", payload, scope);
    queue = createHandoffQueue({ file });
    queue.enable(true);
    const app = createTerminalRelayApp({ queue });
    assert.equal(
      app.call("get_current_study_question", {}, owner).structuredContent
        .status,
      "waiting",
    );
    assert.deepEqual(queue.enqueue("generate", payload, scope), receipt);
    assert.equal(
      app.call("get_current_study_question", {}, owner).structuredContent
        .status,
      "prepare",
    );
    const oldPayload = gen("old-unscoped-queued");
    queue.enqueue("generate", oldPayload);
    const second = createTerminalRelayApp({ queue });
    // A first explicit scope binding is also a new validated local request.
    queue.enqueue("generate", oldPayload, scope);
    assert.equal(
      second.call("get_current_study_question", {}, other).structuredContent
        .requestId,
      oldPayload.requestId,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preparation checks owner, current claim, fingerprint, mode, JSON and operation before accepting", () => {
  const f = setup();
  const receipt = f.enqueue("generate", gen());
  const turn = f.value("get_current_study_question");
  const args = {
    relayId: turn.relayId,
    turnId: turn.turnId,
    jobFingerprint: turn.jobFingerprint,
    response: JSON.stringify(generated),
  };
  for (const extra of [
    { turnId: "foreign" },
    { jobFingerprint: "f".repeat(64) },
    { response: "[1,2]" },
    { response: "{" },
    {
      response: JSON.stringify({
        ...generated,
        contract: { ...contract, depth: 2 },
      }),
    },
    { response: JSON.stringify({ ...generated, rubric: [{}] }) },
    { session: "fabricated-legacy-session" },
  ])
    assert.throws(() =>
      f.value("finish_study_preparation", { ...args, ...extra }),
    );
  assert.throws(
    () => f.value("finish_study_preparation", args, other),
    /unavailable/,
  );
  assert.equal(f.queue.result(receipt.id, receipt.hash).status, "pending");
  assert.throws(() =>
    finishDirect(f, { ...turn, questionFingerprint: "not-a-direct-question" }),
  );
  assert.throws(
    () =>
      f.value("reply_study_terminal_job", {
        relayId: turn.relayId,
        turnId: turn.turnId,
        text: "old reply",
        complete: true,
      }),
    /finish_study_preparation/,
  );
  f.finish(turn);
  f.enqueue("tutor", direct());
  const question = f.value("get_current_study_question");
  assert.throws(() => f.finish(question), /finish_study_question/);
});

test("large preparation requires all exact source chunks, preserving policies, history and assistance", () => {
  const f = setup();
  const payload = gen("large-preparation", scope, {
    curriculum: "SOURCE ROW 🙂\n".repeat(15000),
    progressContext: "EXACT PROGRESS",
    customCapturedContext: { original: true },
  });
  f.enqueue("generate", payload);
  const turn = f.value("get_current_study_question");
  assert.ok(turn.prompt.length < 45_000);
  assert.throws(() => f.finish(turn), /Read every/);
  const first = f.value("read_study_terminal_context", {
    relayId: turn.relayId,
    turnId: turn.turnId,
    part: "payload",
    index: 0,
  });
  assert.ok(first.parts > 1);
  assert.ok(first.text.length <= 128_000);
  assert.throws(() => f.finish(turn), /Read every/);
  const parts = [first.text];
  for (let index = 1; index < first.parts; index++)
    parts.push(
      f.value("read_study_terminal_context", {
        relayId: turn.relayId,
        turnId: turn.turnId,
        part: "payload",
        index,
      }).text,
    );
  assert.deepEqual(JSON.parse(parts.join("")), payload);
  assert.throws(
    () =>
      f.value("read_study_terminal_context", {
        relayId: turn.relayId,
        turnId: turn.turnId,
        part: "payload",
        index: first.parts,
      }),
    /Unknown/,
  );
  assert.equal(f.finish(turn).completion.status, "sent");
  const a = setup();
  const exact = assessment("large-assess", scope, {
    assessmentCriteria: "FULL CRITERIA\n".repeat(8000),
    tutor: [{ id: "help-1", text: "Exact prior help", presented: 1 }],
    importedSourceContext: {
      canonicalHash: "source",
      progress: "original rows",
    },
  });
  a.enqueue("assess", exact);
  const review = a.value("get_current_study_question");
  assert.equal(review.status, "assess");
  const chunk = a.value("read_study_terminal_context", {
    relayId: review.relayId,
    turnId: review.turnId,
    part: "payload",
  });
  const restored = [chunk.text];
  for (let index = 1; index < chunk.parts; index++)
    restored.push(
      a.value("read_study_terminal_context", {
        relayId: review.relayId,
        turnId: review.turnId,
        part: "payload",
        index,
      }).text,
    );
  assert.deepEqual(JSON.parse(restored.join("")), exact);
  assert.throws(
    () =>
      a.finish(review, { ...assessed, findings: [{ execution: "passed" }] }),
    /execution/,
  );
  assert.equal(a.finish(review, assessed).completion.status, "sent");
});

test("optional card keeps tool-delivered preparation and its required chunk reads intact", () => {
  const f = setup();
  f.enqueue(
    "generate",
    gen("card-native-preparation", scope, { curriculum: "x".repeat(70000) }),
  );
  const native = f.value("get_current_study_question");
  const opened = f.value("open_study_terminal");
  f.value("read_study_terminal_context", {
    relayId: native.relayId,
    turnId: native.turnId,
    part: "payload",
    index: 0,
  });
  const unrelated = f.queue.enqueue("tutor", {
    requestId: "legacy-card-neighbor",
    mode: "terminal-dialogue",
  });
  f.queue.result(unrelated.id, unrelated.hash);
  const preserved = f.value("claim_study_terminal_turn", {
    relayId: opened.relayId,
    revision: opened.revision,
  });
  assert.equal(preserved.turn.turnId, native.turnId);
  assert.equal(preserved.turn.deliveredVia, "tool");
  assert.equal(
    f.queue.snapshot().queued,
    1,
    "card cannot replace native preparation with a legacy neighbor",
  );
  assert.throws(() => f.finish(native), /every frozen/);
  f.value("read_study_terminal_context", {
    relayId: native.relayId,
    turnId: native.turnId,
    part: "payload",
    index: 1,
  });
  f.value("claim_study_terminal_turn", {
    relayId: opened.relayId,
    revision: preserved.revision,
  });
  assert.equal(
    f.finish(native).completion.status,
    "sent",
    "status reads retain all required chunk receipts",
  );
});

test("bound continuation waits once for same room generation, then exact encounter assessment without unrelated work", async () => {
  const f = setup({ waitMs: 250 });
  f.enqueue("generate", gen());
  const first = f.value("get_current_study_question");
  const prepReceipt = f.finish(first).completion;
  const stationTwo = { ...scope, encounterId: "station-two" };
  f.enqueue(
    "generate",
    gen("unrelated-gen", {
      ...scope,
      runId: "another-run",
      encounterId: "unrelated",
    }),
    { ...scope, runId: "another-run", encounterId: "unrelated" },
  );
  setTimeout(
    () => f.enqueue("tutor", direct("next-direct", stationTwo), stationTwo),
    5,
  );
  const waiting = f.call("get_current_study_question", {
    after: prepReceipt.continuation.after,
  });
  assert.equal(typeof waiting.then, "function");
  const question = (await waiting).structuredContent;
  assert.equal(question.status, "question");
  assert.equal(question.nativeScope.encounterId, "station-two");
  const nativeReceipt = finishDirect(f, question).completion;
  assert.equal(nativeReceipt.continuation.expected, "assessment");
  f.enqueue("assess", assessment("wrong-station-assess", scope), scope);
  setTimeout(
    () =>
      f.enqueue(
        "assess",
        assessment("right-station-assess", stationTwo),
        stationTwo,
      ),
    5,
  );
  const review = (
    await f.call("get_current_study_question", {
      after: nativeReceipt.continuation.after,
    })
  ).structuredContent;
  assert.equal(review.phase, "assess");
  assert.equal(review.requestId, "right-station-assess");
  const done = f.finish(review, assessed).completion;
  assert.equal(done.continuation, undefined);
  assert.equal(
    (
      await f.call("get_current_study_question", {
        after: {
          relayId: review.relayId,
          turnId: review.turnId,
          jobFingerprint: review.jobFingerprint,
        },
      })
    ).structuredContent.status,
    "complete",
  );
  assert.equal(
    f.queue.snapshot().queued,
    2,
    "unrelated run and sibling assessment were never disclosed or claimed",
  );
  await assert.rejects(
    () =>
      f.call("get_current_study_question", {
        after: {
          ...prepReceipt.continuation.after,
          jobFingerprint: "f".repeat(64),
        },
      }),
    /completed native receipt/,
  );
});

test("continuation is owner bound and timeout returns once without claiming unrelated data", async () => {
  const f = setup({ waitMs: 5 });
  f.enqueue("generate", gen());
  const turn = f.value("get_current_study_question"),
    after = f.finish(turn).completion.continuation.after;
  assert.throws(
    () => f.call("get_current_study_question", { after }, other),
    /owner/,
  );
  f.enqueue("tutor", direct("wrong-run", { ...scope, runId: "wrong-run" }), {
    ...scope,
    runId: "wrong-run",
  });
  const start = Date.now();
  const result = (await f.call("get_current_study_question", { after }))
    .structuredContent;
  assert.equal(result.status, "waiting");
  assert.match(result.note, /no further polling/);
  assert.ok(Date.now() - start < 1000);
  assert.equal(f.queue.snapshot().queued, 1);
});

test("a stale legacy card turn releases only its exact claim and no longer blocks live native preparation", () => {
  const f = setup();
  const old = f.queue.enqueue("tutor", {
    requestId: "abandoned-legacy",
    mode: "terminal-dialogue",
    problem: { title: "Old", prompt: "Old", rubric: [] },
    messages: [],
  });
  f.queue.result(old.id, old.hash);
  const opened = f.value("open_study_terminal");
  const legacy = f.value("claim_study_terminal_turn", {
    relayId: opened.relayId,
    revision: opened.revision,
  });
  const next = f.enqueue("generate", gen());
  assert.equal(
    f.value("get_current_study_question").status,
    "waiting",
    "active legacy claim is preserved",
  );
  f.tick(HANDOFF_REQUESTER_LIVE_MS + 1);
  f.queue.result(next.id, next.hash);
  const moved = f.value("get_current_study_question");
  assert.equal(moved.status, "prepare");
  assert.equal(f.queue.snapshot().queued, 1);
  assert.throws(
    () =>
      f.value("reply_study_terminal_job", {
        relayId: opened.relayId,
        turnId: legacy.turn.turnId,
        text: "late",
        complete: true,
      }),
    /current pending/,
  );
});

test("first scope bind preserves frozen legacy hash, migrates only untouched restored claims, and rejects rebinding", () => {
  const dir = mkdtempSync(join(tmpdir(), "native-scope-migration-"));
  try {
    const file = join(dir, "queue.json"),
      payload = gen();
    let q = createHandoffQueue({ file });
    q.enable(true);
    const receipt = q.enqueue("generate", payload);
    const old = q.get("legacy-restored-worker");
    q = createHandoffQueue({ file });
    q.enable(true);
    assert.deepEqual(q.enqueue("generate", payload, scope), receipt);
    q.result(receipt.id, receipt.hash);
    const app = createTerminalRelayApp({ queue: q });
    const native = app.call(
      "get_current_study_question",
      {},
      owner,
    ).structuredContent;
    assert.equal(native.status, "prepare");
    assert.equal(native.jobFingerprint, receipt.hash);
    assert.throws(
      () => q.submit("legacy-restored-worker", old.jobId, old.claim, generated),
      /Wrong/,
    );
    assert.throws(
      () =>
        q.enqueue("generate", payload, { ...scope, questionRoom: "different" }),
      /Conflicting native/,
    );
    for (const touch of ["get", "part", "invalid-submit"]) {
      const secondFile = join(dir, `${touch}-touched.json`);
      let active = createHandoffQueue({ file: secondFile });
      active.enable(true);
      active.enqueue("generate", payload);
      const held = active.get("active-legacy-worker");
      active = createHandoffQueue({ file: secondFile });
      active.enable(true);
      if (touch === "get")
        assert.equal(active.get("active-legacy-worker").claim, held.claim);
      else if (touch === "part")
        assert.equal(
          active.part("active-legacy-worker", held.jobId, held.claim, 0).index,
          0,
        );
      else
        assert.throws(
          () =>
            active.submit("active-legacy-worker", held.jobId, held.claim, {
              ...generated,
              rubric: [1],
            }),
          /rubric/,
        );
      active.enqueue("generate", payload, scope);
      assert.equal(
        active.snapshot().working,
        1,
        `active ${touch} claim is preserved`,
      );
      assert.equal(
        active.get("other-legacy-worker", undefined, legacyWorkerJob).status,
        "waiting",
      );
      assert.equal(
        active.submit("active-legacy-worker", held.jobId, held.claim, generated)
          .status,
        "accepted",
      );
    }
    let failedBind = createHandoffQueue({
      file: join(dir, "failed-bind.json"),
    });
    failedBind.enable(true);
    const failedReceipt = failedBind.enqueue("generate", payload);
    failedBind.get("restored-failed-bind-worker");
    failedBind = createHandoffQueue({ file: join(dir, "failed-bind.json") });
    failedBind.enable(true);
    renameSync(dir, dir + "-moved");
    try {
      assert.throws(() => failedBind.enqueue("generate", payload, scope));
    } finally {
      renameSync(dir + "-moved", dir);
    }
    assert.deepEqual(
      failedBind.enqueue("generate", payload, scope),
      failedReceipt,
    );
    assert.equal(
      failedBind.snapshot().working,
      0,
      "a failed scope save must not consume the untouched migration marker",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generation pacing estimates cross the preparation boundary only as bounded optional metadata", () => {
  for (const estimate of ["600", -1, 0, 29, 901, Infinity, NaN]) {
    const f = setup();
    const receipt = f.enqueue("generate", gen());
    const turn = f.value("get_current_study_question");
    assert.throws(
      () => f.finish(turn, { ...generated, estimatedSolveSeconds: estimate }),
      /estimatedSolveSeconds/,
    );
    assert.equal(f.queue.result(receipt.id, receipt.hash).status, "pending");
    f.finish(turn, { ...generated, estimatedSolveSeconds: 600 });
    assert.equal(
      f.queue.result(receipt.id, receipt.hash).answer.estimatedSolveSeconds,
      600,
    );
  }
  const f = setup();
  const receipt = f.enqueue("generate", gen());
  f.finish(f.value("get_current_study_question"), generated);
  assert.equal(
    f.queue.result(receipt.id, receipt.hash).answer.estimatedSolveSeconds,
    undefined,
  );
});
