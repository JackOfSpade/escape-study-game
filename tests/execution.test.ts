import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { edit } from "../src/ai";
import { eligible, initialStudy } from "../src/curriculum";
import { canRunWorkspace, runWorkspace } from "../src/execution";
import { initialLearner, reconcileGates } from "../src/learner";
import { type Roadmap } from "../src/model";
import { decode, encode, recover } from "../src/persistence";
import { sha256 } from "../src/roadmap-export";
import { createRecord } from "./helpers/record";
const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
function fixture() {
  const g = createRecord(0, r);
  g.study = initialStudy(r, "live");
  // Synthetic gate history, confined to a test-mode ledger.
  const l = initialLearner(r, "test");
  for (const o of r.tracks.PY.objectives) l.cells[o.id].states[0] = "P";
  l.reviews = {};
  reconcileGates(r, l);
  g.study.learner = l;
  const contract = eligible(r, g.study);
  assert.equal(contract.depth, 2);
  const e = g.encounters["question-0"];
  e.problem = {
    title: "Synthetic executable task",
    prompt: "Transport fixture only",
    rubric: [],
    starter: "",
    provenance: "study-mode",
    contract,
    runtime: { language: "python" },
  };
  edit(g, e, "print(7)", 0);
  return { g, e, l };
}
test("runtime scope cannot raise the academic tier or make D1 implementation compulsory", async () => {
  const { g, e } = fixture();
  assert.equal(canRunWorkspace(g, e, r), true);
  e.problem!.contract.depth = 3;
  assert.equal(canRunWorkspace(g, e, r), false);
  await assert.rejects(runWorkspace(g, e, r), /eligible/);
  e.problem!.contract.depth = 1;
  assert.equal(canRunWorkspace(g, e, r), false);
  assert.equal(e.executions, undefined);
  assert.equal(g.study.learner!.evidence.length, 0);
});
test("mock transport: a running code snapshot stays exact while edits, survival and backups continue", async () => {
  const { g, e, l } = fixture(),
    originalFetch = globalThis.fetch;
  let reply!: (r: Response) => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  globalThis.fetch = async () =>
    new Promise<Response>((resolve) => {
      reply = resolve;
      entered();
    });
  try {
    const pending = runWorkspace(g, e, r);
    await ready;
    const snapshot = e.workspace,
      revision = e.revision;
    assert.equal(e.executions!.length, 1);
    await runWorkspace(g, e, r);
    assert.equal(e.executions!.length, 1);
    edit(g, e, "print(8)", e.revision);
    reply(
      new Response(
        JSON.stringify({
          id: "synthetic-receipt",
          language: "python",
          executed: true,
          status: "completed",
          codeHash: await sha256(snapshot),
          imageId: `sha256:${"0".repeat(64)}`,
          stdout: "7\n",
          stderr: "",
          exitCode: 0,
        }),
        { status: 200 },
      ),
    );
    await pending;
    const job = e.executions![0];
    assert.equal(job.code, snapshot);
    assert.equal(job.revision, revision);
    assert.equal(e.workspace, "print(8)");
    assert.equal(job.receipt!.stdout, "7\n");
    assert.equal(e.history.at(-1)!.revision, revision);
    assert.equal(e.history.at(-1)!.executionId, job.id);
    assert.deepEqual(
      e.history.at(-1)!.refs,
      job.artifactSequences.map((seq) => `artifact:${seq}`),
    );
    assert.deepEqual(
      decode(encode(g)).encounters[e.id].executions,
      e.executions,
    );
    assert.equal(e.state, "available");
    assert.equal(l.evidence.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("a receipt for different code is rejected without creating execution evidence", async () => {
  const { g, e } = fixture(),
    originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        id: "wrong-code",
        language: "python",
        executed: true,
        status: "completed",
        codeHash: "wrong",
        imageId: `sha256:${"0".repeat(64)}`,
        stdout: "forged",
        stderr: "",
      }),
    );
  try {
    await runWorkspace(g, e, r);
    assert.equal(e.executions![0].status, "error");
    assert.ok(!e.history.some((h) => h.kind === "execution"));
    assert.match(e.executions![0].error!, /captured code/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("restart retains interrupted code snapshots in current and archived encounters without rerunning them", () => {
  const { g, e } = fixture();
  e.executions = [
    {
      id: "interrupted",
      language: "python",
      revision: e.revision,
      code: e.workspace,
      artifactSequences: [],
      status: "pending",
    },
  ];
  const archive = structuredClone(e);
  archive.runId = "archived-fixture";
  g.study.archives.push(archive);
  const restored = recover(decode(encode(g)));
  for (const encounter of [
    restored.encounters[e.id],
    restored.study.archives[0],
  ]) {
    assert.equal(encounter.executions![0].status, "interrupted");
    assert.equal(encounter.executions![0].code, "print(7)");
    assert.equal(encounter.executions![0].receipt, undefined);
  }
});

test("React captures code and checks once, preserves its image on reload, and excludes image bytes from AI evidence", async () => {
  const { browserSpecText } =
    await import("../scripts/browser-runner/spec.mjs");
  const { executionEvidence } = await import("../src/execution");
  const { g, e, l } = fixture(),
    originalFetch = globalThis.fetch;
  const steps = [{ kind: "click" as const, selector: "button" }];
  e.problem!.runtime = { language: "typescript", environment: "react", steps };
  edit(g, e, "export default ()=> <button>captured</button>", e.revision);
  const captured = e.workspace,
    revision = e.revision;
  let respond!: (response: Response) => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => (entered = resolve));
  let packet: any;
  globalThis.fetch = async (_url, options) => {
    packet = JSON.parse(String(options?.body));
    entered();
    return new Promise<Response>((resolve) => (respond = resolve));
  };
  try {
    const pending = runWorkspace(g, e, r);
    await ready;
    steps[0].selector = "body";
    edit(g, e, "export default ()=>null", e.revision);
    assert.equal(packet.steps[0].selector, "button");
    // Tiny JPEG boundary fixture tests transport binding, not visual fidelity.
    const bytes = new Uint8Array([255, 216, 255, 217]);
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    )
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("");
    respond(
      new Response(
        JSON.stringify({
          id: "react-fixture",
          language: "typescript",
          environment: "react",
          status: "completed",
          executed: true,
          codeHash: await sha256(captured),
          specHash: await sha256(browserSpecText(captured, packet.steps)),
          imageId: `sha256:${"0".repeat(64)}`,
          stdout: '{"domText":"captured"}',
          stderr: "",
          exitCode: 0,
          preview: {
            dataUrl: "data:image/jpeg;base64,/9j/2Q==",
            width: 640,
            height: 400,
            sha256: digest,
          },
        }),
      ),
    );
    const job = (await pending)!;
    assert.equal(job.status, "finished", job.error);
    assert.equal(job.revision, revision);
    assert.equal(job.steps![0].selector, "button");
    assert.ok(job.preview);
    assert.equal((job.receipt as any).preview, undefined);
    assert.ok(!e.history.at(-1)!.text.includes("base64"));
    assert.deepEqual(
      decode(encode(g)).encounters[e.id].executions,
      e.executions,
    );
    const evidence = executionEvidence(job);
    assert.ok(!JSON.stringify(evidence).includes("base64"));
    assert.equal(evidence.preview!.sha256, digest);
    assert.match(evidence.interactionProvenance!, /not human-authored/);
    assert.equal(l.evidence.length, 0);
    assert.equal(e.state, "available");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("React rejects altered checks and image digests without creating execution evidence", async () => {
  for (const mismatch of ["steps", "preview"]) {
    const { browserSpecText } =
      await import("../scripts/browser-runner/spec.mjs");
    const { g, e } = fixture(),
      originalFetch = globalThis.fetch;
    e.problem!.runtime = {
      language: "typescript",
      environment: "react",
      steps: [],
    };
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          id: "mismatch",
          language: "typescript",
          environment: "react",
          status: "completed",
          executed: true,
          codeHash: await sha256(e.workspace),
          specHash: await sha256(
            browserSpecText(
              e.workspace,
              mismatch === "steps" ? [{ kind: "click", selector: "body" }] : [],
            ),
          ),
          imageId: `sha256:${"0".repeat(64)}`,
          stdout: "{}",
          stderr: "",
          preview: {
            dataUrl: "data:image/jpeg;base64,/9j/2Q==",
            width: 640,
            height: 400,
            sha256: "0".repeat(64),
          },
        }),
      );
    try {
      const job = await runWorkspace(g, e, r);
      assert.equal(job!.status, "error");
      assert.equal(job!.receipt, undefined);
      assert.equal(job!.preview, undefined);
      assert.equal(e.history.filter((h) => h.kind === "execution").length, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});
