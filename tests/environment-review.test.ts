// Isolated synthetic reviewer fixtures; no real learner progress is written.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkBridge, edit, reviewEnvironmentObservation } from "../src/ai";
import { beginVisit, eligible } from "../src/curriculum";
import {
  environmentExecutions,
  recordEnvironmentObservation,
} from "../src/environment-observations";
import { reviewEnvironment } from "../src/environment-review";
import type {
  EnvironmentJudgment,
  EnvironmentReviewPayload,
} from "../src/environment-status";
import { curriculumReadiness } from "../src/final-requirements";
import type { Roadmap } from "../src/model";
import { event } from "../src/model";
import { decode, encode, recover } from "../src/persistence";
import {
  adoptReconciledRoadmap,
  reconcileRoadmap,
} from "../src/roadmap-adoption";
import { prepareRoadmapExport, sha256 } from "../src/roadmap-export";
import { reviewRoadmap } from "../src/roadmap-review";
import { createGame } from "../src/world";

async function waitUntil(
  ready: () => boolean,
  label: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
async function fixture(output = true) {
  const g = createGame(7, r);
  g.study.profile = "live";
  const o = await recordEnvironmentObservation(g, r, {
    envId: "PE:ENV06",
    statement: "I wrote and executed tests in my repository.",
    ...(output
      ? {
          suppliedOutput: {
            name: "results.log",
            text: "SYNTHETIC_OUTPUT_SECRET: unit and browser tests passed",
          },
        }
      : {}),
  });
  return { g, o, l: g.study.learner! };
}
function judgment(
  p: EnvironmentReviewPayload,
  classification: EnvironmentJudgment["classification"] = "observed",
): EnvironmentJudgment {
  return {
    requestId: p.requestId,
    sourceHash: p.sourceHash,
    observationId: p.observation.id,
    observationFingerprint: p.observation.fingerprint,
    envId: p.definition.id,
    classification,
    learnerWork: true,
    learnerWorkQuote: "I wrote and executed tests",
    reviewedOutputs: p.observation.suppliedOutput
      ? [{ kind: "supplied-output", excerpt: "unit and browser tests passed" }]
      : [],
    covered:
      classification === "reported-exposure"
        ? []
        : ["Synthetic reviewed tests"],
    remaining: classification === "observed" ? [] : ["Remaining coverage"],
    completeScope: classification === "observed",
    rationale:
      "SYNTHETIC_REVIEW_SECRET; fixture only, not real learner certification",
  };
}
const block = (text: string, name: string) =>
  text.split(`<!-- BEGIN ${name} -->`)[1].split(`<!-- END ${name} -->`)[0];
for (const transport of ["study-mode", "chatgpt-handoff"] as const)
  test(`an imported ENV pass through ${transport} keeps its source references after a later partial local review and reload`, async () => {
    const external = await fixture();
    await reviewEnvironment(external.g, r, external.o.id, async (p) =>
      judgment(p),
    );
    const source = await prepareRoadmapExport(r, external.l);
    const g = createGame(7, r);
    g.study.profile = "live";
    const originalCells = structuredClone(g.study.learner!.cells);
    const priorRef = external.l.environmentEvidence![0].id;
    await reconcileRoadmap(
      g,
      r,
      source.content,
      async (p) => ({
        requestId: p.requestId,
        localHash: p.localHash,
        candidateHash: p.candidateHash,
        canonical: source.content,
        definitions: [],
        mappings: [],
        completeScopes: [],
        decisions: [],
        environment: [
          {
            envId: external.o.envId,
            status: "P",
            evidenceIds: [priorRef],
            rationale:
              "Synthetic correspondence to the exact prior practical review",
          },
        ],
        rationale: "Synthetic import only; no actual certification",
      }),
      undefined,
      transport,
    );
    const job = g.study.roadmapReconciliations![0];
    assert.equal(job.state, "ready", job.error);
    await adoptReconciledRoadmap(g, r, job.id);
    const o = await recordEnvironmentObservation(g, r, {
      envId: external.o.envId,
      statement: "I wrote and executed tests for a later partial check",
      suppliedOutput: {
        name: "partial.log",
        text: "unit and browser tests passed",
      },
    });
    await reviewEnvironment(g, r, o.id, async (p) =>
      judgment(p, "partially-observed"),
    );
    const l = g.study.learner!;
    const currentRef = l.environmentEvidence![0].id;
    const req = curriculumReadiness(r, l, "PE").requirements.find(
      (d) => d.id === o.envId,
    )!;
    assert.equal(req.status, "P");
    assert.ok(req.sourceRefs.includes(priorRef));
    assert.ok(req.sourceRefs.includes(currentRef));
    const exported = await prepareRoadmapExport(r, l, g.study.roadmapExport);
    const row = block(exported.content, "PE_PROGRESS")
      .split("\n")
      .find((line) => line.startsWith("| ENV06 |"))!;
    assert.ok(row.includes(priorRef));
    assert.ok(row.includes(currentRef));
    assert.match(row, /observed/);
    assert.match(row, /partially-observed/);
    const restored = recover(decode(encode(g)));
    assert.equal(
      (
        await prepareRoadmapExport(
          r,
          restored.study.learner!,
          restored.study.roadmapExport,
        )
      ).content,
      exported.content,
    );
    assert.deepEqual(l.cells, originalCells);
    assert.equal(l.cycle, 0);
    assert.equal(l.evidence.length, 0);
  });
test("explicit native ENV review changes only separate practical status, never academic cells, visits, gates or ratio", async () => {
  const { g, o, l } = await fixture(),
    before = structuredClone(l),
    ready = curriculumReadiness(r, l, "PE");
  await reviewEnvironment(g, r, o.id, async (p) => judgment(p));
  assert.equal(g.study.environmentReviews![0].state, "applied");
  assert.equal(curriculumReadiness(r, l, "PE").environment.passed, 1);
  assert.deepEqual(l.cells, before.cells);
  assert.deepEqual(l.attempts, before.attempts);
  assert.deepEqual(l.evidence, before.evidence);
  assert.deepEqual(l.sessions, before.sessions);
  assert.deepEqual(l.tracks, before.tracks);
  assert.equal(l.cycle, before.cycle);
  assert.equal(g.study.visits.length, 0);
  assert.equal(
    curriculumReadiness(r, l, "PE").tier4RequirementsMet,
    ready.tier4RequirementsMet,
  );
  assert.match(
    curriculumReadiness(r, l, "PE").requirements.find((d) => d.id === o.envId)!
      .remaining,
    /not independent academic/,
  );
});
test("report only stays U, partial output review becomes G, and separate partial observations do not infer full P", async () => {
  const { g, o, l } = await fixture(false);
  await reviewEnvironment(g, r, o.id, async (p) =>
    judgment(p, "reported-exposure"),
  );
  assert.equal(curriculumReadiness(r, l, "PE").environment.passed, 0);
  assert.equal(
    curriculumReadiness(r, l, "PE").requirements.find((d) => d.id === o.envId)!
      .status,
    "U",
  );
  for (const n of [1, 2]) {
    const packet = await recordEnvironmentObservation(g, r, {
      envId: o.envId,
      statement: `I wrote and executed tests ${n}`,
      suppliedOutput: { name: "result", text: "unit and browser tests passed" },
    });
    await reviewEnvironment(g, r, packet.id, async (p) =>
      judgment(p, "partially-observed"),
    );
  }
  assert.equal(
    curriculumReadiness(r, l, "PE").requirements.find((d) => d.id === o.envId)!
      .status,
    "G",
  );
  assert.equal(l.environmentEvidence!.length, 3);
});
test("unsupported full observation, ownership, output references and identity are rejected without a ledger mutation", async () => {
  for (const bad of [
    "report",
    "owner",
    "quote",
    "output",
    "scope",
    "identity",
    "source",
  ]) {
    const { g, o, l } = await fixture(bad !== "report"),
      before = JSON.stringify(l);
    await reviewEnvironment(g, r, o.id, async (p) => {
      const j = judgment(p);
      if (bad === "owner") j.learnerWork = false;
      if (bad === "quote") j.learnerWorkQuote = "invented";
      if (bad === "output") j.reviewedOutputs[0].excerpt = "never supplied";
      if (bad === "scope") j.remaining = ["not checked"];
      if (bad === "identity") j.observationId = "other";
      if (bad === "source") j.sourceHash = "other";
      return j;
    });
    assert.equal(g.study.environmentReviews![0].state, "error", bad);
    assert.equal(JSON.stringify(l), before, bad);
  }
});
test("packet mutation is detected before calling the reviewer and an unavailable native capability never creates a review", async () => {
  const { g, o } = await fixture();
  o.suppliedOutput!.text += "tampered";
  let calls = 0;
  await reviewEnvironment(g, r, o.id, async (p) => {
    calls++;
    return judgment(p);
  });
  assert.equal(calls, 0);
  assert.match(g.study.environmentReviews![0].error!, /integrity/);
  const f = await fixture();
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      mode: "development",
      label: "fixture",
      detail: "fixture",
      capabilities: [],
    });
  try {
    await checkBridge();
    assert.throws(
      () => reviewEnvironmentObservation(f.g, r, f.o.id),
      /unavailable/,
    );
    assert.equal(f.g.study.environmentReviews, undefined);
  } finally {
    globalThis.fetch = original;
  }
});
test("failed and interrupted requests retry their exact captured identity/context and applied reviews are idempotent", async () => {
  const { g, o } = await fixture();
  let first: any;
  await reviewEnvironment(g, r, o.id, async (p) => {
    first = p;
    throw Error("offline");
  });
  assert.equal(g.study.environmentReviews![0].state, "error");
  assert.equal(
    reviewEnvironment(g, r, o.id, async () => {
      throw Error("must not auto retry");
    }),
    undefined,
  );
  g.study.environmentReviews![0].state = "pending";
  const restored = recover(decode(encode(g)));
  assert.equal(restored.study.environmentReviews![0].state, "interrupted");
  let count = 0;
  await reviewEnvironment(
    restored,
    r,
    o.id,
    async (p) => {
      assert.deepEqual(p, first);
      count++;
      return judgment(p);
    },
    true,
  );
  assert.equal(count, 1);
  assert.equal(restored.study.learner!.environmentEvidence!.length, 1);
  assert.equal(
    reviewEnvironment(restored, r, o.id, async (p) => judgment(p), true),
    undefined,
  );
});
test("concurrent identical review coalesces, different packets wait explicitly and changed profiles cannot apply late results", async () => {
  const { g, o, l } = await fixture();
  let finish!: (v: unknown) => void;
  const pending = reviewEnvironment(
    g,
    r,
    o.id,
    async (p) =>
      new Promise((resolve) => {
        finish = () => resolve(judgment(p));
      }),
  );
  assert.equal(
    reviewEnvironment(g, r, o.id, async () => {}),
    pending,
  );
  const other = await recordEnvironmentObservation(g, r, {
    envId: "PE:ENV01",
    statement: "Different packet",
  });
  assert.throws(
    () => reviewEnvironment(g, r, other.id, async () => {}),
    /already running/,
  );
  await waitUntil(() => finish !== undefined, "finish callback");
  g.study.profile = "development";
  finish(undefined);
  await pending;
  assert.equal(l.environmentEvidence, undefined);
  assert.match(g.study.environmentReviews![0].error!, /profile changed/);
});
test("ENV-only export preserves protected bytes, academic sections and scheduler, uses exact parents, and redownloads identically", async () => {
  const { g, o, l } = await fixture();
  await reviewEnvironment(g, r, o.id, async (p) => judgment(p));
  const out = await prepareRoadmapExport(r, l);
  assert.equal(out.revision, 10);
  assert.equal(out.parentHash, r.sourceHash);
  assert.ok(out.content.includes(l.environmentEvidence![0].judgmentHash));
  assert.deepEqual(
    (await reviewRoadmap(r, r.raw, out.content)).issues.filter(
      (i) => i.severity === "invalid",
    ),
    [],
  );
  for (const name of ["MERGE_RULES", "PY_CURRICULUM", "PE_CURRICULUM"])
    assert.equal(block(out.content, name), block(r.raw, name));
  const pe = block(out.content, "PE_PROGRESS");
  for (const heading of [
    "0.4 Objective checkpoint ledger",
    "0.5 Assessment evidence register",
    "0.5.1 Attempt status register",
    "0.2 Breadth scheduler and resume packet",
  ]) {
    const part = (s: string) =>
      s.split(`### ${heading}\n`)[1].split("\n### ")[0];
    assert.equal(
      part(pe).replace(/^\| Save anchor \|.*$/m, ""),
      part(block(r.raw, "PE_PROGRESS")).replace(/^\| Save anchor \|.*$/m, ""),
    );
  }
  assert.match(pe, /\| ENV06 \|[^\n]+\| P \|/);
  assert.ok(!out.content.includes("SYNTHETIC_OUTPUT_SECRET"));
  assert.ok(!out.content.includes("SYNTHETIC_REVIEW_SECRET"));
  assert.equal((await prepareRoadmapExport(r, l, out)).content, out.content);
  const o2 = await recordEnvironmentObservation(g, r, {
    envId: o.envId,
    statement: "I wrote and executed tests again",
    suppliedOutput: { name: "next.log", text: "unit and browser tests passed" },
  });
  await reviewEnvironment(g, r, o2.id, async (p) =>
    judgment(p, "partially-observed"),
  );
  const next = await prepareRoadmapExport(r, l, out);
  assert.equal(next.revision, 11);
  assert.equal(next.parentHash, await sha256(out.content));
  assert.equal(curriculumReadiness(r, l, "PE").environment.passed, 1);
  const broken = structuredClone(l);
  broken.environmentEvidence![0].payload.observation.suppliedOutput!.text +=
    "tamper";
  await assert.rejects(prepareRoadmapExport(r, broken, next), /integrity/);
  const changedJudgment = structuredClone(l);
  changedJudgment.environmentEvidence![0].judgment.rationale =
    "tampered reviewer result";
  await assert.rejects(
    prepareRoadmapExport(r, changedJudgment, next),
    /integrity/,
  );
});
test("mixed academic-attempt exports also include ENV receipts without conflating evidence types", async () => {
  const { g, o, l } = await fixture();
  await reviewEnvironment(g, r, o.id, async (p) => judgment(p));
  const e = g.encounters["f0-room0"];
  e.problem = {
    title: "Fixture question",
    prompt: "Fixture",
    rubric: [],
    starter: "",
    provenance: "study-mode",
    contract: eligible(r, g.study),
  };
  beginVisit(r, g.study, e);
  assert.equal(l.attempts.length, 1);
  const out = await prepareRoadmapExport(r, l);
  assert.match(out.content, /\| ENV06 \|[^\n]+\| P \|/);
  assert.equal(l.evidence.length, 0);
  assert.ok(out.content.includes("Practical environment review receipts"));
});
test("a packet captured under development remains raw evidence that a later live native reviewer can inspect", async () => {
  const g = createGame(7, r);
  const o = await recordEnvironmentObservation(g, r, {
    envId: "PE:ENV06",
    statement: "I wrote and executed tests in my repository.",
    suppliedOutput: {
      name: "results.log",
      text: "unit and browser tests passed",
    },
  });
  assert.equal(o.profile, "development");
  g.study.profile = "live";
  await reviewEnvironment(g, r, o.id, async (p) => judgment(p));
  assert.equal(g.study.environmentReviews![0].state, "applied");
  assert.equal(
    g.study.learner!.environmentEvidence![0].payload.observation.profile,
    "development",
  );
  assert.equal(g.study.learner!.environmentEvidence![0].reviewProfile, "live");
});
test("runner-backed practical review uses the captured human source and cutoff assistance, including after archive", async () => {
  const g = createGame(7, r),
    e = g.encounters["f0-room0"];
  g.study.profile = "live";
  const help = event(g, "tutor", "Private guided fixture", 0, "tutor", e.id);
  e.tutor.push({
    id: "private-before",
    author: "tutor",
    kind: "tutor",
    text: "PRIVATE_BEFORE_EXECUTION",
    seq: help.seq,
    worldTime: 0,
    provenance: "study-mode",
  });
  e.history.push({
    seq: help.seq,
    author: "tutor",
    kind: "tutor",
    text: "PRIVATE_BEFORE_EXECUTION",
    at: 0,
    revision: 0,
  });
  edit(g, e, "assert 2 + 2 == 4", 0);
  const editSeq = e.history.at(-1)!.seq;
  const receipt = {
    id: "synthetic",
    language: "python" as const,
    status: "completed" as const,
    executed: true,
    codeHash: await sha256(e.workspace),
    imageId: `sha256:${"0".repeat(64)}`,
    stdout: "",
    stderr: "",
    exitCode: 0,
  };
  e.executions = [
    {
      id: "synthetic-job",
      author: "human",
      revision: e.revision,
      language: "python",
      code: e.workspace,
      artifactSequences: [editSeq],
      status: "finished",
      receipt,
    },
  ];
  const ran = event(g, "execution", "Fixture execution", 0, "runner", e.id);
  e.history.push({
    seq: ran.seq,
    author: "runner",
    kind: "execution",
    executionId: "synthetic-job",
    revision: e.revision,
    text: JSON.stringify(receipt),
    at: 0,
  });
  const o = await recordEnvironmentObservation(g, r, {
    envId: "PE:ENV06",
    statement: "I wrote and executed tests in my repository.",
    executionKey: environmentExecutions(g)[0].key,
  });
  e.tutor.push({
    id: "private-after",
    author: "tutor",
    kind: "tutor",
    text: "PRIVATE_AFTER_EXECUTION",
    seq: ++g.seq,
    worldTime: 0,
    provenance: "study-mode",
  });
  edit(g, e, "later source", e.revision);
  g.study.archives.push(e);
  delete g.encounters[e.id];
  await reviewEnvironment(g, r, o.id, async (p) => {
    assert.ok(p.attribution);
    assert.ok(
      JSON.stringify(p.attribution).includes("PRIVATE_BEFORE_EXECUTION"),
    );
    assert.ok(
      !JSON.stringify(p.attribution).includes("PRIVATE_AFTER_EXECUTION"),
    );
    assert.ok(!JSON.stringify(p.attribution).includes("later source"));
    assert.equal(p.observation.execution!.code, "assert 2 + 2 == 4");
    const j = judgment(p, "partially-observed");
    j.reviewedOutputs = [
      { kind: "runner-receipt", excerpt: '"executed":true' },
    ];
    return j;
  });
  assert.equal(g.study.environmentReviews![0].state, "applied");
  assert.equal(
    curriculumReadiness(r, g.study.learner!, "PE").requirements.find(
      (d) => d.id === o.envId,
    )!.status,
    "G",
  );
  assert.equal(g.study.learner!.evidence.length, 0);
});
test("replacing the canonical packet during a pending review cannot apply its late judgment", async () => {
  const { g, o, l } = await fixture();
  let finish!: () => void;
  const pending = reviewEnvironment(
    g,
    r,
    o.id,
    async (p) =>
      new Promise((resolve) => {
        finish = () => resolve(judgment(p));
      }),
  );
  await waitUntil(() => finish !== undefined, "finish callback");
  g.study.environmentObservations = [{ ...o, learnerStatement: "Replacement" }];
  finish();
  await pending;
  assert.equal(l.environmentEvidence, undefined);
  assert.match(g.study.environmentReviews![0].error!, /changed/);
});

test("Claude practical review preserves exact provider/packet on retry and reload, rejects relabeling, and stays separate from academic proof", async () => {
  const { g, o, l } = await fixture();
  const before = structuredClone(l);
  let first!: EnvironmentReviewPayload;
  await reviewEnvironment(
    g,
    r,
    o.id,
    async (p) => {
      first = structuredClone(p);
      throw Error("Synthetic handoff outage");
    },
    false,
    "claude-cli",
  );
  assert.equal(first.provider, "claude-cli");
  const restored = recover(decode(encode(g)));
  let wrongCalls = 0;
  assert.throws(
    () =>
      reviewEnvironment(
        restored,
        r,
        o.id,
        async (p) => {
          wrongCalls++;
          return judgment(p);
        },
        true,
        "chatgpt-handoff",
      ),
    /original.*provider/,
  );
  assert.equal(wrongCalls, 0);
  await reviewEnvironment(
    restored,
    r,
    o.id,
    async (p) => {
      assert.deepEqual(p, first);
      return judgment(p, "partially-observed");
    },
    true,
    "claude-cli",
  );
  const ledger = restored.study.learner!;
  assert.equal(restored.study.environmentReviews![0].state, "applied");
  assert.equal(ledger.environmentEvidence![0].provenance, "claude-cli");
  assert.equal(
    curriculumReadiness(r, ledger, "PE").requirements.find(
      (d) => d.id === o.envId,
    )!.status,
    "G",
  );
  for (const key of [
    "cells",
    "attempts",
    "evidence",
    "sessions",
    "tracks",
    "cycle",
  ] as const)
    assert.deepEqual(ledger[key], before[key]);
  await prepareRoadmapExport(r, ledger);
  const tampered = structuredClone(ledger);
  tampered.environmentEvidence![0].provenance = "study-mode";
  await assert.rejects(prepareRoadmapExport(r, tampered), /provenance/);
});

test("legacy native practical review retries its original provider-less body and digest", async () => {
  const { g, o } = await fixture();
  await reviewEnvironment(g, r, o.id, async () => {
    throw Error("offline");
  });
  const j = g.study.environmentReviews![0];
  delete j.payload.provider;
  j.requestHash = await sha256(JSON.stringify(j.payload));
  const body = structuredClone(j.payload),
    hash = j.requestHash;
  await reviewEnvironment(
    g,
    r,
    o.id,
    async (p) => {
      assert.deepEqual(p, body);
      assert.equal(p.provider, undefined);
      return judgment(p);
    },
    true,
  );
  assert.equal(j.state, "applied", j.error);
  assert.equal(j.requestHash, hash);
  assert.equal(
    g.study.learner!.environmentEvidence![0].provenance,
    "study-mode",
  );
});

test("provider change while an ENV response is pending cannot apply it or retry it through another provider", async () => {
  const { g, o, l } = await fixture();
  const original = globalThis.fetch;
  let mode = "claude-cli",
    finish!: () => void;
  globalThis.fetch = async (url) => {
    if (url === "/api/status")
      return Response.json({
        mode,
        label: "Synthetic reviewer",
        detail: "No real review",
        capabilities: ["review-environment"],
      });
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    const p = g.study.environmentReviews![0].payload;
    return Response.json(judgment(p));
  };
  try {
    await checkBridge();
    const pending = reviewEnvironmentObservation(g, r, o.id);
    await waitUntil(() => finish !== undefined, "finish callback");
    mode = "development";
    await checkBridge();
    finish();
    await pending;
    assert.equal(l.environmentEvidence, undefined);
    assert.match(g.study.environmentReviews![0].error!, /provider changed/);
    assert.throws(
      () => reviewEnvironmentObservation(g, r, o.id, true),
      /Environment review is unavailable/,
    );
  } finally {
    globalThis.fetch = original;
    // Reset module status; do not leave a connected synthetic provider behind.
    const f = globalThis.fetch;
    globalThis.fetch = async () =>
      Response.json({
        mode: "development",
        label: "fixture",
        detail: "fixture",
        capabilities: [],
      });
    await checkBridge();
    globalThis.fetch = f;
  }
});

import { localHandoff } from "./helpers/local-handoff";

test("the Claude gateway ENV review rejects invalid claims, applies only separate practical evidence and keeps the request frozen", async () => {
  const { g, o, l } = await fixture(),
    before = structuredClone(l);
  const relay = await localHandoff(),
    original = globalThis.fetch;
  // Route actual client requests into this isolated gateway; never the public bridge.
  globalThis.fetch = (url, options) =>
    original(new URL(String(url), relay.base), {
      ...options,
      headers: { ...options?.headers, Origin: "http://127.0.0.1:5173" },
    });
  let release!: EnvironmentReviewPayload;
  await reviewEnvironment(
    g,
    r,
    o.id,
    async (p) => {
      release = p;
      throw Error("capture only");
    },
    false,
    "claude-cli",
  );
  try {
    await checkBridge();
    const status = await (await original(relay.base + "/api/status")).json();
    assert.equal(status.mode, "claude-cli");
    assert.ok(status.capabilities.includes("review-environment"));
    let sent: any;
    relay.answerWith((job) => {
      sent = job;
      const good = judgment(job.payload, "partially-observed");
      return {
        valid: good,
        invalid: [
          { ...good, observationFingerprint: "other" },
          {
            ...good,
            reviewedOutputs: [
              { kind: "supplied-output", excerpt: "invented output" },
            ],
          },
          { ...good, classification: "observed" },
        ],
      };
    });
    await reviewEnvironmentObservation(g, r, o.id, true);
    assert.equal(sent.operation, "review-environment");
    assert.deepEqual(sent.payload, release);
    assert.equal(relay.rejected, 3);
    assert.equal(relay.completed, 1);
    assert.equal(
      g.study.environmentReviews![0].state,
      "applied",
      g.study.environmentReviews![0].error,
    );
    assert.equal(l.environmentEvidence![0].provenance, "claude-cli");
    for (const key of [
      "cells",
      "attempts",
      "evidence",
      "sessions",
      "tracks",
      "cycle",
    ] as const)
      assert.deepEqual(l[key], before[key]);
    const restored = recover(decode(encode(g)));
    assert.deepEqual(
      restored.study.learner!.environmentEvidence,
      l.environmentEvidence,
    );
    const exported = await prepareRoadmapExport(r, restored.study.learner!);
    assert.ok(exported.content.includes(l.environmentEvidence![0].id));
  } finally {
    globalThis.fetch = async () =>
      Response.json({
        mode: "development",
        label: "fixture",
        detail: "fixture",
        capabilities: [],
      });
    await checkBridge();
    globalThis.fetch = original;
    await relay.close();
  }
});
