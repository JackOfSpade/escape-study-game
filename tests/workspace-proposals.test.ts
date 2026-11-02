import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkBridge, edit, presentMessages, send } from "../src/ai";
import { eligible } from "../src/curriculum";
import { groupSnapshot, validateGroupReply } from "../src/group-grounding";
import { assistanceSources } from "../src/learner";
import { type Encounter, event, type Game, type Roadmap } from "../src/model";
import { decode, encode, recover } from "../src/persistence";
import { workspaceAt } from "../src/workspace-history";
import {
  presentWorkspaceProposal,
  proposalPreview,
  proposalText,
  reviewWorkspaceProposal,
  type WorkspacePatch,
} from "../src/workspace-proposals";
import { createGame } from "../src/world";
const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
function fixture() {
  const g = createGame(7, r),
    e = g.encounters["f0-room0"],
    station = g.floors[0].stations.find((s) => s.encounter === e.id)!;
  g.status = "playing";
  g.zombies = [];
  g.nextSpawn = Number.MAX_SAFE_INTEGER;
  Object.assign(g.survivors[0], {
    floor: 0,
    x: station.x,
    y: station.y,
    station: station.id,
  });
  e.problem = {
    title: "Synthetic candidate task",
    prompt: "Fixture, not actual human learning",
    starter: "abc",
    rubric: ["fixture"],
    provenance: "study-mode",
    contract: eligible(r, g.study),
  };
  e.workspace = e.workspaceBase = "abc";
  e.state = "in-progress";
  return { g, e };
}
function stage(
  g: Game,
  e: Encounter,
  patch: WorkspacePatch = { prefix: 1, removed: "b", inserted: "BOUNDARY" },
) {
  const sourceSequence = g.seq,
    seq = event(g, "npc-proposal", "fixture candidate", 0, "npc-0", e.id).seq;
  const p = {
    id: `candidate-${seq}`,
    author: "npc-0",
    sourceRevision: e.revision,
    sourceSequence,
    artifactSequence: seq,
    patch,
    state: "pending" as const,
  };
  e.history.push({
    seq,
    author: p.author,
    kind: "npc-proposal",
    text: proposalText("Consider this candidate", patch),
    delta: { ...patch },
    revision: e.revision,
    at: g.time,
  });
  (e.proposals ??= []).push(p);
  return p;
}
test("workspace proposal review preserves NPC authorship, reconstructs revisions and grants no human evidence", () => {
  const { g, e } = fixture(),
    before = JSON.stringify(g.study),
    p = stage(g, e);
  assert.equal(proposalPreview(e, p), "aBOUNDARYc");
  assert.equal(e.workspace, "abc");
  assert.equal(assistanceSources(e).length, 0);
  presentWorkspaceProposal(g, e, p.id);
  const shown = e.history.find((h) => h.seq === p.artifactSequence)!.presented;
  assert.ok(shown);
  assert.ok(
    assistanceSources(e).some(
      (m) => m.text.includes("BOUNDARY") && m.presented === shown,
    ),
  );
  reviewWorkspaceProposal(g, e, p.id, "apply");
  assert.equal(p.state, "applied");
  assert.equal(e.workspace, "aBOUNDARYc");
  assert.equal(e.revision, 1);
  const npcEdit = e.history.find((h) => h.kind === "edit")!;
  assert.equal(npcEdit.author, "npc-0");
  assert.ok(npcEdit.refs?.includes(String(p.artifactSequence)));
  assert.equal(
    e.history.filter(
      (h) =>
        h.author === "human" && ["edit", "reasoning", "test"].includes(h.kind),
    ).length,
    0,
  );
  assert.equal(JSON.stringify(g.study), before);
  const appliedSequence = npcEdit.seq;
  edit(g, e, "aBOUNDARYc human addition", e.revision);
  assert.equal(workspaceAt(e, p.sourceSequence).content, "abc");
  assert.equal(workspaceAt(e, appliedSequence).content, "aBOUNDARYc");
  assert.equal(workspaceAt(e).content, e.workspace);
  assert.equal(e.history.at(-1)?.author, "human");
  assert.equal(e.history.at(-1)?.delta?.inserted, " human addition");
  assert.throws(
    () => reviewWorkspaceProposal(g, e, p.id, "apply"),
    /already reviewed/,
  );
});
test("workspace proposals reject stale edits atomically and allow dismissal without technical credit", () => {
  const { g, e } = fixture(),
    p = stage(g, e);
  edit(g, e, "newer human draft", e.revision);
  const saved = JSON.stringify(e),
    seq = g.seq;
  assert.throws(() => reviewWorkspaceProposal(g, e, p.id, "apply"), /stale/);
  assert.equal(JSON.stringify(e), saved);
  assert.equal(g.seq, seq);
  reviewWorkspaceProposal(g, e, p.id, "dismiss");
  assert.equal(p.state, "dismissed");
  assert.equal(e.workspace, "newer human draft");
  assert.equal(e.history.at(-1)?.kind, "activity");
  assert.equal(e.history.filter((h) => h.kind === "edit").length, 1);
});
test("workspace proposal survives save/reload and cannot apply from an old run, through walls or after completion", () => {
  const { g, e } = fixture(),
    p = stage(g, e);
  const restored = recover(decode(encode(g))),
    current = restored.encounters[e.id];
  assert.throws(
    () => reviewWorkspaceProposal(restored, current, p.id, "apply"),
    /Return to/,
  );
  restored.survivors[0].station = g.survivors[0].station;
  reviewWorkspaceProposal(restored, current, p.id, "apply");
  assert.equal(current.workspace, "aBOUNDARYc");
  assert.equal(current.proposals?.[0].state, "applied");
  assert.throws(
    () => reviewWorkspaceProposal(restored, e, p.id, "apply"),
    /Return to/,
  );
  const second = fixture(),
    q = stage(second.g, second.e);
  const a = second.g.survivors[0];
  a.x += 5;
  assert.throws(
    () => reviewWorkspaceProposal(second.g, second.e, q.id, "apply"),
    /Return to/,
  );
  const st = second.g.floors[0].stations.find((s) => s.id === a.station)!;
  a.x = st.x;
  a.y = st.y;
  a.x = st.x - 0.9;
  second.g.floors[0].furniture.push({
    id: "opaque-review-door",
    floor: 0,
    kind: "door",
    x: st.x - 0.45,
    y: st.y,
    w: 0.15,
    h: 2,
    hp: 100,
    maxHp: 100,
    speed: 0,
    rotation: 0,
    destroyed: false,
    movers: [],
    moved: 0,
    credited: [],
    turning: 0,
    open: false,
  });
  assert.throws(
    () => reviewWorkspaceProposal(second.g, second.e, q.id, "apply"),
    /Return to/,
  );
  a.x = st.x;
  second.e.state = "consumed";
  assert.throws(
    () => reviewWorkspaceProposal(second.g, second.e, q.id, "apply"),
    /Return to/,
  );
});
test("workspace proposals from the same revision do not overwrite each other; broken journals cannot commit", () => {
  const { g, e } = fixture(),
    first = stage(g, e),
    second = stage(g, e, { prefix: 0, removed: "a", inserted: "other" });
  reviewWorkspaceProposal(g, e, first.id, "apply");
  assert.throws(
    () => reviewWorkspaceProposal(g, e, second.id, "apply"),
    /stale/,
  );
  const f = fixture(),
    p = stage(f.g, f.e);
  f.e.workspace = "changed without revision";
  const before = JSON.stringify(f.e);
  assert.throws(
    () => reviewWorkspaceProposal(f.g, f.e, p.id, "apply"),
    /differs/,
  );
  assert.equal(JSON.stringify(f.e), before);
});
test("structured group patch validation binds exact source and rejects malformed or retrospective edits atomically", () => {
  const { e } = fixture(),
    snapshot = groupSnapshot(e, "request", 0);
  const message = {
    author: "npc-0",
    kind: "proposal",
    text: "Candidate",
    refs: [1],
    patch: { prefix: 1, removed: "b", inserted: "X" },
  };
  snapshot.events = [
    {
      seq: 1,
      author: "npc-0",
      kind: "npc-thought",
      text: "fixture",
      at: 0,
      revision: 0,
    },
  ];
  const reply = (m: any) => ({
    requestId: "request",
    sourceRevision: 0,
    messages: [m],
  });
  assert.equal(
    validateGroupReply(reply(message), snapshot, ["npc-0"], "abc").length,
    1,
  );
  for (const patch of [
    { prefix: -1, removed: "b", inserted: "X" },
    { prefix: 4, removed: "", inserted: "X" },
    { prefix: 1, removed: "wrong", inserted: "X" },
    { prefix: 1.5, removed: "", inserted: "X" },
    { prefix: 1, removed: "b", inserted: "b" },
    { prefix: 1, removed: "b", inserted: "X".repeat(32001) },
    null,
  ])
    assert.throws(() =>
      validateGroupReply(
        reply({ ...message, patch }),
        snapshot,
        ["npc-0"],
        "abc",
      ),
    );
  assert.throws(() => validateGroupReply(reply(message), snapshot, ["npc-0"]));
  assert.throws(() =>
    validateGroupReply(
      reply({ ...message, kind: "observation" }),
      snapshot,
      ["npc-0"],
      "abc",
    ),
  );
});
test("native group candidates materialize edits only after human review with faithful code exposure", async () => {
  const { g, e } = fixture(),
    original = globalThis.fetch;
  g.study.profile = "live";
  for (const a of g.survivors.slice(1))
    Object.assign(a, {
      intent: e.id,
      floor: 0,
      activity: "studying",
      thought: 10,
      x: 10,
      y: 6,
    });
  globalThis.fetch = async (input, init) => {
    if (String(input) === "/api/status")
      return Response.json({
        mode: "claude-cli",
        label: "Synthetic patch fixture",
        detail: "Not native service proof",
        capabilities: [],
      });
    const { payload } = JSON.parse(String(init?.body));
    return Response.json({
      requestId: payload.requestId,
      sourceRevision: payload.sourceRevision,
      messages: [
        {
          author: payload.speakers[0].id,
          kind: "proposal",
          text: "Try this boundary",
          refs: [payload.events.at(-1).seq],
          patch: { prefix: 1, removed: "b", inserted: "REVIEWED_CODE" },
        },
      ],
    });
  };
  try {
    await checkBridge();
    await send(g, e, "group", "Could someone suggest a concrete edit?", r);
    assert.equal(e.workspace, "abc");
    assert.equal(e.proposals?.length, 1);
    assert.ok(e.group.at(-1)?.text.includes("REVIEWED_CODE"));
    assert.equal(
      e.history.find((h) => h.kind === "npc-proposal")?.presented,
      undefined,
    );
    presentMessages(g, e, "group");
    assert.ok(
      assistanceSources(e).some(
        (m) => m.text.includes("REVIEWED_CODE") && m.presented !== undefined,
      ),
    );
    reviewWorkspaceProposal(g, e, e.proposals![0].id, "apply");
    assert.equal(e.workspace, "aREVIEWED_CODEc");
    assert.equal(g.study.learner?.evidence.length, 0);
  } finally {
    globalThis.fetch = async () =>
      Response.json({
        mode: "development",
        label: "Fallback",
        detail: "Fixture ended",
        capabilities: [],
      });
    await checkBridge();
    globalThis.fetch = original;
  }
});
