import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assess, checkBridge, edit } from "../src/ai";
import { eligible, evidencePacket, initialStudy } from "../src/curriculum";
import type { Roadmap } from "../src/model";
import { decode, encode, recover } from "../src/persistence";
import { createGame } from "../src/world";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
function fixture() {
  const r = structuredClone(roadmap),
    g = createGame(725, r);
  g.study = initialStudy(r, "live");
  const e = g.encounters["f0-room0"],
    contract = eligible(r, g.study);
  e.problem = {
    title: "Synthetic assessment lifecycle",
    prompt: "Transport fixture only",
    starter: "",
    rubric: [],
    provenance: "claude-cli",
    contract,
    scopeDefinitions: [
      {
        id: `${contract.objectiveIds[0]}/D${contract.depth}`,
        objectiveId: contract.objectiveIds[0],
        depth: contract.depth,
        sourceScope: contract.scopes[0],
        facets: [{ id: "scope", description: "Synthetic complete scope" }],
      },
    ],
  };
  edit(g, e, "Synthetic human reasoning", e.revision, r);
  return { g, e, r };
}
async function connection(handler: typeof fetch) {
  const original = globalThis.fetch;
  let mode = "claude-cli";
  globalThis.fetch = async (url, init) =>
    String(url) === "/api/status"
      ? Response.json({
          mode,
          capabilities: ["assess"],
          label: "Synthetic",
          detail: "Isolated transport fixture",
        })
      : handler(url, init);
  await checkBridge();
  return {
    async reconnect() {
      mode = "claude-cli";
      await checkBridge();
    },
    async disconnect() {
      mode = "development";
      await checkBridge();
    },
    async restore() {
      mode = "development";
      await checkBridge();
      globalThis.fetch = original;
    },
  };
}
const unresolved = () =>
  Response.json({ findings: [], visitOutcome: "unresolved" });

test("an offline assessment freezes the original partial work before reconnect and reload", async () => {
  const { g, e, r } = fixture(),
    bodies: string[] = [];
  const bridge = await connection(async (_url, init) => {
    bodies.push(String(init?.body));
    return unresolved();
  });
  try {
    await bridge.disconnect();
    await assess(g, e, r);
    const assessment = g.study.assessments[0],
      captured = assessment.request;
    assert.equal(assessment.status, "review-required");
    assert.equal(captured?.provider, "claude-cli");
    assert.ok(captured, "An offline attempt lost its frozen assessment packet");
    assert.equal(bodies.length, 0);
    const ledger = JSON.stringify(g.study.learner),
      restored = recover(decode(encode(g))),
      saved = restored.encounters[e.id];
    r.tracks[e.problem!.contract.track].progress += "\nLater source context";
    edit(
      restored,
      saved,
      "Later human answer outside this review",
      saved.revision,
      r,
    );
    await bridge.reconnect();
    await assess(restored, saved, r, assessment.evidenceCutoffSequence, true);
    assert.equal(bodies.length, 1);
    assert.equal(
      JSON.stringify(JSON.parse(bodies[0]).payload),
      captured.payloadJson,
    );
    assert.ok(!bodies[0].includes("Later human answer outside this review"));
    assert.ok(!bodies[0].includes("Later source context"));
    assert.equal(restored.study.assessments[0].status, "applied");
    assert.deepEqual(restored.study.learner!.evidence, []);
    assert.equal(g.study.learner && JSON.stringify(g.study.learner), ledger);
  } finally {
    await bridge.restore();
  }
});

test("a partial assessment packet cannot expose a later accepted answer beyond its cutoff", () => {
  const { e, g, r } = fixture(),
    cutoff = g.seq;
  edit(
    g,
    e,
    "Later answer that was not yet written at the cutoff",
    e.revision,
    r,
  );
  e.submissions.push({
    id: "synthetic-later-accepted",
    author: "human",
    revision: e.revision,
    content: e.workspace,
    seq: ++g.seq,
    status: "complete",
    feedback: "Synthetic completion only",
  });
  e.accepted = "synthetic-later-accepted";
  const packet = evidencePacket(e, r, cutoff, g.study.learner);
  assert.equal(packet.accepted, undefined);
  assert.ok(
    !JSON.stringify(packet).includes("Later answer that was not yet written"),
  );
  assert.equal(evidencePacket(e, r).accepted?.id, e.accepted);
});

test("an ordinary completed assessment retains the accepted submission event after its last artifact", async () => {
  const { e, g, r } = fixture(),
    artifactCutoff = g.seq,
    packets: ReturnType<typeof evidencePacket>[] = [];
  e.submissions.push({
    id: "synthetic-ordinary-accepted",
    author: "human",
    revision: e.revision,
    content: e.workspace,
    seq: ++g.seq,
    status: "complete",
    feedback: "Synthetic completion only",
  });
  e.accepted = "synthetic-ordinary-accepted";
  const bridge = await connection(async (_url, init) => {
    packets.push(JSON.parse(String(init?.body)).payload.packet);
    return unresolved();
  });
  try {
    await assess(g, e, r);
    assert.equal(packets.length, 1);
    assert.equal(packets[0].accepted?.id, e.accepted);
    assert.equal(packets[0].evidenceCutoffSequence, artifactCutoff);
    assert.equal(
      g.study.assessments[0].id,
      `assessment-${g.id}/${e.id}-${artifactCutoff}`,
      "Existing artifact-based assessment IDs must remain stable",
    );
  } finally {
    await bridge.restore();
  }
});

test("assessment retries after reload reuse their exact captured packet despite later source context", async () => {
  const { g, e, r } = fixture(),
    bodies: string[] = [];
  const bridge = await connection(async (_url, init) => {
    bodies.push(String(init?.body));
    return bodies.length === 1
      ? Response.json({ error: "Synthetic outage" }, { status: 503 })
      : unresolved();
  });
  try {
    await assess(g, e, r);
    assert.equal(g.study.assessments[0].status, "review-required");
    const restored = recover(decode(encode(g))),
      saved = restored.encounters[e.id];
    r.tracks[e.problem!.contract.track].progress +=
      "\nSynthetic source context changed after capture";
    edit(restored, saved, "Later unsent human reasoning", saved.revision, r);
    await assess(
      restored,
      saved,
      r,
      restored.study.assessments[0].evidenceCutoffSequence,
      true,
    );
    assert.equal(bodies.length, 2);
    assert.ok(bodies[1] === bodies[0], "Retry changed the captured packet");
    assert.equal(
      restored.study.assessments[0].status,
      "applied",
      restored.study.assessments[0].provenance,
    );
  } finally {
    await bridge.restore();
  }
});

test("a late assessment cannot apply after the original provider disconnects", async () => {
  const { g, e, r } = fixture();
  let finish!: (response: Response) => void;
  const bridge = await connection(
    async () => new Promise<Response>((resolve) => (finish = resolve)),
  );
  try {
    const before = JSON.stringify(g.study.learner),
      pending = assess(g, e, r);
    await bridge.disconnect();
    finish(unresolved());
    await pending;
    assert.equal(g.study.assessments[0].status, "review-required");
    assert.match(g.study.assessments[0].provenance, /provider.*changed/i);
    assert.equal(JSON.stringify(g.study.learner), before);
  } finally {
    await bridge.restore();
  }
});

test("a late assessment cannot mutate a replacement learner ledger", async () => {
  const { g, e, r } = fixture();
  let finish!: (response: Response) => void;
  const bridge = await connection(
    async () => new Promise<Response>((resolve) => (finish = resolve)),
  );
  try {
    const pending = assess(g, e, r);
    g.study.learner = structuredClone(g.study.learner!);
    const replacement = JSON.stringify(g.study.learner);
    finish(unresolved());
    await pending;
    assert.equal(g.study.assessments[0].status, "review-required");
    assert.equal(JSON.stringify(g.study.learner), replacement);
  } finally {
    await bridge.restore();
  }
});

test("late archived assessment still applies to the retained shared study state", async () => {
  const { g, e, r } = fixture();
  let finish!: (response: Response) => void;
  const bridge = await connection(
    async () => new Promise<Response>((resolve) => (finish = resolve)),
  );
  try {
    const pending = assess(g, e, r);
    g.study.archives.push(e);
    const next = createGame(726, r, g.study);
    finish(unresolved());
    await pending;
    assert.equal(next.study, g.study);
    assert.equal(next.study.assessments[0].status, "applied");
    assert.ok(next.study.learner!.receipts[next.study.assessments[0].id]);
  } finally {
    await bridge.restore();
  }
});

test("a changed task cannot receive the late assessment of its previous question", async () => {
  const { g, e, r } = fixture();
  let finish!: (response: Response) => void;
  const bridge = await connection(
    async () => new Promise<Response>((resolve) => (finish = resolve)),
  );
  try {
    const before = JSON.stringify(g.study.learner),
      pending = assess(g, e, r);
    e.problem!.prompt = "A different synthetic question";
    finish(unresolved());
    await pending;
    assert.equal(g.study.assessments[0].status, "review-required");
    assert.match(g.study.assessments[0].provenance, /captured task/);
    assert.equal(JSON.stringify(g.study.learner), before);
  } finally {
    await bridge.restore();
  }
});

test("long retained histories can capture their cutoff without overflowing the argument stack", async () => {
  const { g, e, r } = fixture();
  const bridge = await connection(async () => unresolved());
  try {
    await bridge.disconnect();
    e.history = Array.from({ length: 150_000 }, (_, i) => ({
      seq: i + 1,
      author: "human",
      kind: "defense" as const,
      text: "Synthetic retained defense observation",
      at: i,
      revision: 0,
    }));
    await assess(g, e, r);
    assert.equal(g.study.assessments[0].evidenceCutoffSequence, 150_000);
    assert.equal(g.study.assessments[0].status, "review-required");
  } finally {
    await bridge.restore();
  }
});
