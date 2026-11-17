import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { edit } from "../src/ai";
import {
  environmentExecutions,
  recordEnvironmentObservation,
} from "../src/environment-observations";
import { curriculumReadiness } from "../src/final-requirements";
import type { Roadmap } from "../src/model";
import { decode, encode, recover } from "../src/persistence";
import { prepareRoadmapExport, sha256 } from "../src/roadmap-export";
import { createGame } from "./helpers/record";
const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
async function fixture() {
  const g = createGame(7, r),
    e = g.encounters["question-0"];
  edit(g, e, "assert 2 + 2 == 4", 0);
  const receipt = {
    id: "synthetic-container-receipt",
    language: "python" as const,
    status: "completed" as const,
    executed: true,
    codeHash: await sha256(e.workspace),
    imageId: `sha256:${"0".repeat(64)}`,
    stdout: "",
    stderr: "",
    exitCode: 0,
  };
  const seq = e.history.at(-1)!.seq;
  e.executions = [
    {
      id: "job-fixture",
      revision: e.revision,
      language: "python",
      code: e.workspace,
      artifactSequences: [seq],
      status: "finished",
      receipt,
    },
  ];
  const ev = { seq: ++g.seq };
  e.history.push({
    seq: ev.seq,
    author: "runner",
    kind: "execution",
    executionId: "job-fixture",
    revision: e.revision,
    text: JSON.stringify(receipt),
    at: g.time,
  });
  return { g, e, key: environmentExecutions(g)[0].key };
}
test("report-only ENV packets preserve reported provenance and do not certify environment or academic progress", async () => {
  const g = createGame(0, r),
    learner = JSON.stringify(g.study.learner),
    visits = JSON.stringify(g.study.visits),
    ready = curriculumReadiness(r, g.study.learner!, "PE");
  const packet = await recordEnvironmentObservation(g, r, {
    envId: "PE:ENV01",
    statement:
      "I used the keyboard in my own browser and have not supplied the result.",
  });
  assert.equal(packet.status, "pending-review");
  assert.equal(packet.independence, "unassessed");
  assert.equal(packet.execution, undefined);
  assert.equal(packet.suppliedOutput, undefined);
  assert.equal(JSON.stringify(g.study.learner), learner);
  assert.equal(JSON.stringify(g.study.visits), visits);
  assert.deepEqual(curriculumReadiness(r, g.study.learner!, "PE"), ready);
  assert.equal(
    (await prepareRoadmapExport(r, g.study.learner!)).content,
    r.raw,
  );
});
test("capture binds exact runner code, human edit references and output while later editing cannot rewrite the packet", async () => {
  const { g, e, key } = await fixture(),
    code = e.workspace,
    revision = e.revision;
  edit(g, e, "newer workspace", e.revision);
  const packet = await recordEnvironmentObservation(g, r, {
    envId: "PE:ENV06",
    statement:
      "I wrote and ran this small assertion; end-to-end coverage remains unobserved.",
    executionKey: key,
  });
  assert.equal(packet.execution?.code, code);
  assert.equal(packet.execution?.revision, revision);
  assert.equal(packet.execution?.receipt.codeHash, await sha256(code));
  assert.ok(packet.execution!.humanArtifactReferences.length);
  assert.ok(
    !packet.execution!.historyReferences.some((h) => h.revision > revision),
  );
  e.executions![0].receipt!.stdout = "mutated later";
  assert.equal(packet.execution?.receipt.stdout, "");
  assert.equal(g.study.learner!.evidence.length, 0);
});
test("identical capture coalesces concurrently and after reload, even when unrelated events accrue", async () => {
  const { g, e, key } = await fixture(),
    input = {
      envId: "PE:ENV06",
      statement: "An assertion run, pending review.",
      executionKey: key,
    };
  const [a, b] = await Promise.all([
    recordEnvironmentObservation(g, r, input),
    recordEnvironmentObservation(g, r, input),
  ]);
  assert.equal(a.id, b.id);
  const ev = { seq: ++g.seq };
  e.history.push({
    seq: ev.seq,
    author: "someone-else",
    kind: "activity",
    text: "Unrelated later work",
    revision: e.revision,
    at: g.time,
  });
  const restored = recover(decode(encode(g)));
  const c = await recordEnvironmentObservation(restored, r, input);
  assert.equal(c.id, a.id);
  assert.equal(restored.study.environmentObservations?.length, 1);
});
test("caller-supplied output is retained byte-for-byte as unreviewed material with its digest", async () => {
  const g = createGame(0, r),
    text = "<script>not executed</script>\nActual output supplied by learner\n";
  const packet = await recordEnvironmentObservation(g, r, {
    envId: "PE:ENV03",
    statement: "I reproduced the reported bug; this file still needs review.",
    suppliedOutput: { name: "reproduction.log", text },
  });
  assert.equal(packet.suppliedOutput?.text, text);
  assert.equal(packet.suppliedOutput?.sha256, await sha256(text));
  assert.equal(
    packet.suppliedOutput?.provenance,
    "learner-supplied-unreviewed",
  );
  assert.equal(packet.status, "pending-review");
});
test("missing execution journal, NPC-only authorship and altered receipt/code cannot be attached as human-run evidence", async () => {
  for (const bad of ["journal", "author", "code", "receipt", "pending"]) {
    const { g, e, key } = await fixture();
    if (bad === "journal")
      e.history = e.history.filter((h) => h.kind !== "execution");
    if (bad === "author")
      e.history.find((h) => h.kind === "edit")!.author = "npc-0";
    if (bad === "code") e.executions![0].code = "different code";
    if (bad === "receipt") e.executions![0].receipt!.codeHash = "wrong";
    if (bad === "pending") e.executions![0].status = "pending";
    const before = JSON.stringify(g.study);
    await assert.rejects(
      recordEnvironmentObservation(g, r, {
        envId: "PE:ENV06",
        statement: "Should not attach.",
        executionKey: key,
      }),
    );
    assert.equal(JSON.stringify(g.study), before, bad);
  }
});
test("archives and a fresh run retain self-contained pending packets without borrowing a new encounter identity", async () => {
  const { g, e, key } = await fixture(),
    packet = await recordEnvironmentObservation(g, r, {
      envId: "PE:ENV06",
      statement: "Archived assertion run.",
      executionKey: key,
    });
  g.study.archives.push(e);
  const next = createGame(42, r, g.study);
  assert.equal(next.study.environmentObservations?.[0].id, packet.id);
  assert.equal(environmentExecutions(next)[0].key, key);
  assert.notEqual(next.encounters[e.id].runId, e.runId);
  assert.equal(
    (
      await recordEnvironmentObservation(next, r, {
        envId: "PE:ENV06",
        statement: "Archived assertion run.",
        executionKey: key,
      })
    ).id,
    packet.id,
  );
});
test("invalid scope, mismatched source, empty reports and oversized supplied output reject atomically", async () => {
  for (const input of [
    { envId: "PE:T01", statement: "not an ENV" },
    { envId: "PE:ENV01", statement: "" },
    {
      envId: "PE:ENV01",
      statement: "too large",
      suppliedOutput: { name: "log", text: "a".repeat(262145) },
    },
  ]) {
    const g = createGame(0, r),
      before = JSON.stringify(g.study);
    await assert.rejects(recordEnvironmentObservation(g, r, input));
    assert.equal(JSON.stringify(g.study), before);
  }
  const g = createGame(0, r);
  g.study.learner!.sourceHash = "wrong";
  await assert.rejects(
    recordEnvironmentObservation(g, r, {
      envId: "PE:ENV01",
      statement: "wrong source",
    }),
  );
});

test("React practical observations bind issued checks and retain automated provenance without screenshot bytes", async () => {
  const { browserSpecText } =
    await import("../scripts/browser-runner/spec.mjs");
  const { g, e } = await fixture(),
    job = e.executions![0];
  job.language = "typescript";
  job.environment = "react";
  job.steps = [{ kind: "expect-count", selector: "button", count: 1 }];
  job.receipt = {
    ...job.receipt!,
    language: "typescript",
    environment: "react",
    specHash: await sha256(browserSpecText(job.code, job.steps)),
  };
  e.history.find((h) => h.kind === "execution")!.text = JSON.stringify(
    job.receipt,
  );
  const key = environmentExecutions(g)[0].key;
  const packet = await recordEnvironmentObservation(g, r, {
    envId: "PE:ENV06",
    statement:
      "Task checks were automated; independent test design is unassessed.",
    executionKey: key,
  });
  assert.equal(packet.execution!.environment, "react");
  assert.deepEqual(packet.execution!.steps, job.steps);
  assert.match(packet.execution!.interactionProvenance!, /not human-authored/);
  assert.ok(!JSON.stringify(packet).includes("data:image"));
  job.steps[0] = { kind: "expect-count", selector: "button", count: 2 };
  await assert.rejects(
    recordEnvironmentObservation(g, r, {
      envId: "PE:ENV06",
      statement: "Changed issued check must not reuse its receipt.",
      executionKey: key,
    }),
    /captured workspace/,
  );
});
