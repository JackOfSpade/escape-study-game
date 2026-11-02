import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createHandoffQueue,
  legacyWorkerJob,
} from "../scripts/chatgpt-handoff-queue.mjs";
import { createHandoffRoutes } from "../scripts/chatgpt-handoff-routes.mjs";
import { createStudyBridgeServer } from "../scripts/study-bridge-server.mjs";
import {
  createTerminalRelayApp,
  PROMPT_LIMIT,
} from "../scripts/terminal-relay-app.mjs";
import {
  RUN_DESIGN_GUIDANCE,
  summarizeRunDesign,
  parseRunStructure,
  runStructureFingerprint,
  environmentSurfaceFingerprint,
} from "../src/run-design-contract.mjs";

const design = JSON.parse(
  readFileSync(
    new URL("./fixtures/run-designs/harbor-archive.json", import.meta.url),
    "utf8",
  ),
);
const sceneDesign = JSON.parse(
  readFileSync(
    new URL("./fixtures/run-designs/botanical-office.json", import.meta.url),
    "utf8",
  ),
);
const owner = { linkId: "synthetic-design-owner" };
const chat = "DESIGN01";
const request = (requestId = "design-request-one") => ({
  version: 1,
  requestId,
  generationId: "design-generation-one",
  seed: 42,
  recent: [],
});
const scope = { runId: "design-generation-one", encounterId: "run-design" };
const answer = (p) => ({
  requestId: p.requestId,
  design: structuredClone(design),
});
const get = (app, code = chat) =>
  app.call("get_current_study_question", { chat: code }, owner)
    .structuredContent;
const finish = (app, turn, response) =>
  app.call(
    "finish_study_preparation",
    {
      relayId: turn.relayId,
      turnId: turn.turnId,
      jobFingerprint: turn.jobFingerprint,
      response: JSON.stringify(response),
    },
    owner,
  ).structuredContent;

test("run design releases only bounded fictional context with exact generation and chat binding", () => {
  const queue = createHandoffQueue(),
    p = request();
  assert.throws(() => queue.enqueue("design-run", p, scope, chat), /disabled/);
  queue.enable(true);
  for (const field of [
    "study",
    "curriculum",
    "messages",
    "credentials",
    "provider",
  ])
    assert.throws(
      () =>
        queue.enqueue("design-run", { ...p, [field]: "private" }, scope, chat),
      /unknown field/,
    );
  assert.throws(() => queue.enqueue("design-run", p), /chat code/);
  assert.throws(
    () => queue.enqueue("design-run", p, undefined, chat),
    /generation scope/,
  );
  for (const bad of [
    { ...scope, runId: "wrong-generation" },
    { ...scope, encounterId: "study-terminal" },
    { ...scope, questionRoom: "room-one" },
  ])
    assert.throws(() => queue.enqueue("design-run", p, bad, chat), /scope/);
  const receipt = queue.enqueue("design-run", p, scope, chat);
  assert.deepEqual(queue.enqueue("design-run", p, scope, chat), receipt);
  assert.throws(
    () => queue.enqueue("design-run", { ...p, seed: 43 }, scope, chat),
    /Conflicting reuse/,
  );
  assert.equal(
    queue.get("synthetic-worker", undefined, legacyWorkerJob).status,
    "waiting",
  );
});

test("native ChatGPT follows only a correlated design repair and stops after a bounded wait", async () => {
  const queue = createHandoffQueue(),
    app = createTerminalRelayApp({ queue, continuationWaitMs: 5 });
  queue.enable(true);
  const p = request(),
    receipt = queue.enqueue("design-run", p, scope, chat);
  const turn = get(app);
  assert.equal(turn.status, "prepare");
  assert.equal(turn.jobFingerprint, receipt.hash);
  assert.deepEqual(turn.nativeScope, scope);
  assert.match(turn.prompt, /"operation":"design-run"/);
  assert.match(turn.prompt, /fictional game-run design/);
  assert.doesNotMatch(turn.prompt, /@study|assume the learner already knows/);
  assert.deepEqual(get(app), turn);
  assert.equal(get(app, "WRONG001").status, "disconnected");
  for (const bad of [
    { ...answer(p), requestId: "design-other" },
    { ...answer(p), learner: "invented" },
    { requestId: p.requestId, design: { ...design, floors: [] } },
  ]) {
    assert.throws(() => finish(app, turn, bad), /Run design:/);
    assert.equal(queue.result(receipt.id, receipt.hash).status, "pending");
  }
  const done = finish(app, turn, answer(p));
  assert.equal(done.completion.status, "sent");
  assert.equal(done.completion.operation, "design-run");
  assert.doesNotMatch(done.completion.note, /key|learning|mastery/);
  assert.equal(done.completion.next, "design-run");
  assert.equal(
    done.completion.continuation.expected,
    "next run design phase or repair",
  );
  assert.deepEqual(queue.result(receipt.id, receipt.hash).answer, answer(p));
  assert.equal(finish(app, turn, answer(p)).completion.duplicate, true);
  assert.throws(
    () =>
      finish(app, turn, {
        ...answer(p),
        design: { ...design, title: "Changed" },
      }),
    /Conflicting completion/,
  );
  const restartedApp = createTerminalRelayApp({ queue });
  assert.equal(
    finish(restartedApp, turn, answer(p)).completion.duplicate,
    true,
  );
  const repair = {
    ...request("design-repair-one"),
    repair: { candidate: design, errors: ["Synthetic geometry rejection"] },
  };
  const unrelated = {
    ...request("design-unrelated"),
    generationId: "design-generation-other",
  };
  const unrelatedReceipt = queue.enqueue(
    "design-run",
    unrelated,
    { runId: unrelated.generationId, encounterId: "run-design" },
    chat,
  );
  const studyReceipt = queue.enqueue(
    "generate",
    { requestId: "study-generation", encounterId: "run-design" },
    scope,
    chat,
  );
  queue.enqueue("design-run", repair, scope, chat);
  const repairing = (
    await app.call(
      "get_current_study_question",
      {
        chat,
        after: done.completion.continuation.after,
      },
      owner,
    )
  ).structuredContent;
  assert.notEqual(repairing.jobFingerprint, turn.jobFingerprint);
  assert.equal(repairing.requestId, repair.requestId);
  assert.match(repairing.prompt, /Synthetic geometry rejection/);
  const repaired = finish(app, repairing, answer(repair));
  const waiting = (
    await app.call(
      "get_current_study_question",
      {
        chat,
        after: repaired.completion.continuation.after,
      },
      owner,
    )
  ).structuredContent;
  assert.equal(waiting.status, "waiting");
  assert.match(waiting.note, /stop; no further polling/);
  assert.equal(
    queue.result(unrelatedReceipt.id, unrelatedReceipt.hash).status,
    "pending",
  );
  assert.equal(
    queue.result(studyReceipt.id, studyReceipt.hash).status,
    "pending",
  );
});

test("large Unicode design repairs preserve every recent design through required native context chunks", () => {
  // Exercise both ordinary multi-byte text and the largest JSON expansion that
  // the printable-text contract permits: escaped lone UTF-16 surrogates.
  for (const character of ["界", "\ud800"]) {
    const queue = createHandoffQueue(),
      app = createTerminalRelayApp({ queue });
    queue.enable(true);
    const summary = {
      title: character.repeat(64),
      premise: character.repeat(240),
      spatial: character.repeat(3500),
      atmosphere: character.repeat(3500),
      cast: character.repeat(3500),
      tempo: character.repeat(3500),
    };
    const p = {
      ...request(`design-${"r".repeat(121)}`),
      generationId: `design-${"g".repeat(121)}`,
      seed: 4294967295,
      recent: Array.from({ length: 5 }, () => ({ ...summary })),
      repair: {
        candidate: structuredClone(design),
        errors: Array.from({ length: 20 }, () => character.repeat(400)),
      },
    };
    const serialized = JSON.stringify(p);
    assert.ok(Buffer.byteLength(serialized) > 240_000);
    const receipt = queue.enqueue(
      "design-run",
      p,
      { runId: p.generationId, encounterId: "run-design" },
      chat,
    );
    const turn = get(app);
    assert.equal(turn.status, "prepare");
    assert.ok(turn.prompt.length < 40_000);
    assert.match(turn.prompt, /fictional game-run design/);
    assert.throws(() => finish(app, turn, answer(p)), /Read every/);
    const read = (index) =>
      app.call(
        "read_study_terminal_context",
        {
          chat,
          relayId: turn.relayId,
          turnId: turn.turnId,
          part: "payload",
          index,
        },
        owner,
      ).structuredContent;
    const first = read(0);
    assert.ok(first.parts > 1);
    assert.throws(() => finish(app, turn, answer(p)), /Read every/);
    const parts = [first.text];
    for (let index = 1; index < first.parts; index++)
      parts.push(read(index).text);
    const restored = parts.join("");
    assert.equal(restored, serialized);
    assert.deepEqual(JSON.parse(restored), p);
    assert.equal(
      first.sha256,
      createHash("sha256").update(restored).digest("hex"),
    );
    assert.throws(() => read(first.parts), /Unknown preparation context/);
    assert.equal(finish(app, turn, answer(p)).completion.status, "sent");
    assert.deepEqual(queue.result(receipt.id, receipt.hash).answer, answer(p));
  }
});

test("native design handoffs enforce version 2 scenes and retain the same claim for corrections", () => {
  const queue = createHandoffQueue(),
    app = createTerminalRelayApp({ queue });
  queue.enable(true);
  const p = { ...request("design-scene-request"), designVersion: 2 };
  const receipt = queue.enqueue("design-run", p, scope, chat),
    turn = get(app);
  assert.equal(turn.status, "prepare");
  assert.match(turn.prompt, /SceneFurniture/);
  assert.match(turn.prompt, /Small props are attached cosmetic details/);
  assert.throws(() => finish(app, turn, answer(p)), /requested design version/);
  const missing = structuredClone(sceneDesign);
  delete missing.floors[2].scene;
  assert.throws(
    () => finish(app, turn, { requestId: p.requestId, design: missing }),
    /missing a field/,
  );
  const injected = structuredClone(sceneDesign);
  injected.floors[0].scene.rooms[0].furniture[0].props[0].script = "run()";
  assert.throws(
    () => finish(app, turn, { requestId: p.requestId, design: injected }),
    /unknown field/,
  );
  assert.equal(queue.result(receipt.id, receipt.hash).status, "pending");
  const response = { requestId: p.requestId, design: sceneDesign };
  assert.equal(finish(app, turn, response).completion.status, "sent");
  assert.deepEqual(queue.result(receipt.id, receipt.hash).answer, response);
});

test("a large version 2 repair carries complete object scenes through exact native chunks", () => {
  const character = "\ud800",
    candidate = structuredClone(sceneDesign);
  for (const floor of candidate.floors)
    for (const room of floor.scene.rooms) {
      room.title = character.repeat(40);
      room.description = character.repeat(160);
      for (const item of room.furniture) {
        item.label = character.repeat(40);
        for (const prop of item.props) {
          prop.label = character.repeat(32);
          prop.text = character.repeat(160);
        }
      }
    }
  assert.ok(Buffer.byteLength(JSON.stringify(candidate)) > 80_000);
  assert.ok(Buffer.byteLength(JSON.stringify(candidate)) <= 100_000);
  const summary = {
    title: character.repeat(64),
    premise: character.repeat(240),
    spatial: character.repeat(3500),
    atmosphere: character.repeat(3500),
    cast: character.repeat(3500),
    tempo: character.repeat(3500),
  };
  const p = {
    ...request("design-large-scene"),
    designVersion: 2,
    recent: Array.from({ length: 5 }, () => ({ ...summary })),
    repair: {
      candidate,
      errors: Array.from({ length: 20 }, () => character.repeat(400)),
    },
  };
  const serialized = JSON.stringify(p);
  assert.ok(Buffer.byteLength(serialized) > 512_000);
  assert.ok(Buffer.byteLength(serialized) <= 640_000);
  const queue = createHandoffQueue(),
    app = createTerminalRelayApp({ queue });
  queue.enable(true);
  const receipt = queue.enqueue("design-run", p, scope, chat),
    turn = get(app);
  assert.equal(turn.status, "prepare");
  assert.ok(turn.prompt.length < 40_000);
  const response = { requestId: p.requestId, design: candidate };
  assert.throws(() => finish(app, turn, response), /Read every/);
  const read = (index) =>
    app.call(
      "read_study_terminal_context",
      {
        chat,
        relayId: turn.relayId,
        turnId: turn.turnId,
        part: "payload",
        index,
      },
      owner,
    ).structuredContent;
  const first = read(0),
    parts = [first.text];
  assert.ok(first.parts > 1);
  for (let index = 1; index < first.parts; index++)
    parts.push(read(index).text);
  assert.equal(parts.join(""), serialized);
  assert.equal(
    first.sha256,
    createHash("sha256").update(serialized).digest("hex"),
  );
  assert.equal(finish(app, turn, response).completion.status, "sent");
  assert.deepEqual(queue.result(receipt.id, receipt.hash).answer, response);
});

test("a near-limit scene repair chunks the payload when its complete instruction would exceed the prompt budget", () => {
  const p = {
    ...request("design-scene-near-limit"),
    designVersion: 2,
    recent: Array.from({ length: 3 }, () => summarizeRunDesign(sceneDesign)),
    repair: { candidate: sceneDesign, errors: ["Move the crowded desk"] },
  };
  const serialized = JSON.stringify(p);
  assert.ok(serialized.length < PROMPT_LIMIT, "the payload alone fits inline");
  assert.ok(
    serialized.length + RUN_DESIGN_GUIDANCE.length > PROMPT_LIMIT,
    "the complete design instruction does not fit beside the payload",
  );
  const queue = createHandoffQueue(),
    app = createTerminalRelayApp({ queue });
  queue.enable(true);
  const receipt = queue.enqueue("design-run", p, scope, chat),
    turn = get(app);
  assert.equal(turn.status, "prepare");
  assert.ok(turn.prompt.length <= PROMPT_LIMIT);
  assert.match(turn.prompt, /"omitted":\["payload"\]/);
  const response = { requestId: p.requestId, design: sceneDesign };
  assert.throws(() => finish(app, turn, response), /Read every/);
  const part = app.call(
    "read_study_terminal_context",
    {
      chat,
      relayId: turn.relayId,
      turnId: turn.turnId,
      part: "payload",
      index: 0,
    },
    owner,
  ).structuredContent;
  assert.equal(part.parts, 1);
  assert.equal(part.text, serialized);
  assert.equal(
    part.sha256,
    createHash("sha256").update(serialized).digest("hex"),
  );
  assert.equal(finish(app, turn, response).completion.status, "sent");
  assert.deepEqual(queue.result(receipt.id, receipt.hash).answer, response);
});

test("version 3 follows an exact structure-to-content continuation and requires all frozen content chunks", async () => {
  const { streetLabels: _, ...exterior } = sceneDesign.exterior;
  const structure = parseRunStructure({
    ...sceneDesign,
    version: 3,
    exterior,
    relationships: [
      {
        from: sceneDesign.roster[0].name,
        to: sceneDesign.roster[1].name,
        kind: "colleague",
        detail: "They label the overnight archive together.",
      },
    ],
    floors: sceneDesign.floors.map(({ stories: _, scene, ...f }) => ({
      ...f,
      scene: {
        version: 2,
        rooms: scene.rooms.map((r) => ({
          ...r,
          furniture: r.furniture.map(({ label: _, props, ...o }) => ({
            ...o,
            props: props.map(({ label: _, text: __, ...p }) => p),
          })),
        })),
      },
    })),
  });
  const p = {
    ...request("design-structure-native"),
    version: 2,
    designVersion: 3,
    phase: "structure",
  };
  const queue = createHandoffQueue(),
    app = createTerminalRelayApp({ queue, continuationWaitMs: 5 });
  queue.enable(true);
  queue.enqueue("design-run", p, scope, chat);
  const turn = get(app);
  assert.throws(() => finish(app, turn, answer(p)), /unknown field|missing/);
  const done = finish(app, turn, { requestId: p.requestId, structure });
  const surfaces = Array.from({ length: 160 }, (_, i) => ({
    id: `floor0/wall-${i}/poster`,
    floor: 0,
    scope: "interior",
    role: "wall-poster",
    room: i % 4,
    owner: null,
    binding: {
      kind: "fixed",
      x: i,
      y: 2,
      z: 1.6,
      yaw: 0,
      pitch: 0,
      width: 0.62,
      height: 0.86,
    },
    context: 'Synthetic frozen poster "context" \\ ' + "界".repeat(150),
    maxTitle: 48,
    maxBody: 160,
    allowsArt: true,
  }));
  const contentRequest = {
    version: 2,
    designVersion: 3,
    phase: "content",
    requestId: "design-content-native",
    generationId: p.generationId,
    seed: p.seed,
    structure,
    structureFingerprint: runStructureFingerprint(structure),
    builderVersion: "environment-v1",
    surfaces,
    surfaceFingerprint: environmentSurfaceFingerprint(surfaces),
    recentContent: [],
  };
  const receipt = queue.enqueue("design-run", contentRequest, scope, chat);
  const next = (
    await app.call(
      "get_current_study_question",
      { chat, after: done.completion.continuation.after },
      owner,
    )
  ).structuredContent;
  assert.equal(next.jobFingerprint, receipt.hash);
  assert.match(next.prompt, /"omitted":\["payload"\]/);
  assert.ok(next.prompt.length <= PROMPT_LIMIT);
  const content = {
    version: 1,
    surfaceFingerprint: contentRequest.surfaceFingerprint,
    fragments: [],
    entries: surfaces.map((s, i) => ({
      surfaceId: s.id,
      layout: "text",
      title: [{ text: `Synthetic panel ${i}` }],
      body: [],
      description: "",
      drawing: null,
    })),
  };
  const response = { requestId: contentRequest.requestId, content };
  assert.throws(() => finish(app, next, response), /Read every/);
  const read = (index) =>
    app.call(
      "read_study_terminal_context",
      {
        chat,
        relayId: next.relayId,
        turnId: next.turnId,
        part: "payload",
        index,
      },
      owner,
    ).structuredContent;
  const first = read(0),
    parts = [first.text];
  assert.ok(first.parts > 1);
  for (let i = 1; i < first.parts; i++) parts.push(read(i).text);
  assert.equal(parts.join(""), JSON.stringify(contentRequest));
  assert.equal(
    first.sha256,
    createHash("sha256").update(parts.join("")).digest("hex"),
  );
  assert.throws(
    () => finish(app, next, { ...response, structure }),
    /unknown field/,
  );
  assert.throws(
    () =>
      finish(app, next, {
        ...response,
        content: { ...content, entries: content.entries.slice(1) },
      }),
    /entries/,
  );
  assert.equal(queue.result(receipt.id, receipt.hash).status, "pending");
  assert.equal(finish(app, next, response).completion.status, "sent");
  assert.deepEqual(queue.result(receipt.id, receipt.hash).answer, response);
});

test("design cancellation persists and rejects late answers without discarding study requests", () => {
  const directory = mkdtempSync(join(tmpdir(), "run-design-queue-"));
  try {
    const file = join(directory, "queue.json"),
      queue = createHandoffQueue({ file });
    queue.enable(true);
    const p = request(),
      receipt = queue.enqueue("design-run", p, scope, chat);
    const app = createTerminalRelayApp({ queue }),
      turn = get(app);
    assert.throws(
      () => queue.discardChatter(receipt.id, receipt.hash),
      /Only temporary/,
    );
    queue.discardDesign(receipt.id, "incorrect-hash");
    assert.equal(queue.result(receipt.id, receipt.hash).status, "pending");
    const study = queue.enqueue("tutor", {
      requestId: "study-request",
      messages: [],
    });
    assert.throws(
      () => queue.discardDesign(study.id, study.hash),
      /Only a run design/,
    );
    assert.equal(
      queue.discardDesign(receipt.id, receipt.hash).status,
      "discarded",
    );
    assert.throws(() => finish(app, turn, answer(p)), /chat was disconnected/);
    assert.equal(queue.result(study.id, study.hash).status, "pending");
    const restored = createHandoffQueue({ file });
    restored.enable(true);
    assert.throws(
      () => restored.result(receipt.id, receipt.hash),
      /Unknown exact/,
    );
    assert.equal(restored.result(study.id, study.hash).status, "pending");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("actual local HTTP routes advertise design-run and enforce exact cancellation origin and operation", async () => {
  const queue = createHandoffQueue();
  queue.enable(true);
  const server = createStudyBridgeServer({
    handoff: createHandoffRoutes(queue),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const origin = "http://127.0.0.1:5173";
  try {
    const status = await (await fetch(`${base}/api/status`)).json();
    assert.ok(status.capabilities.includes("design-run"));
    const result = await fetch(`${base}/api/bridge`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({
        operation: "design-run",
        provider: "chatgpt-handoff",
        payload: request(),
        nativeScope: scope,
        chatCode: chat,
      }),
    });
    assert.equal(result.status, 202);
    const { handoff: receipt } = await result.json();
    const path = `${base}/api/bridge/result?id=${receipt.id}&hash=${receipt.hash}`;
    assert.equal(
      (await fetch(`${path}&operation=design-run`, { method: "DELETE" }))
        .status,
      403,
    );
    assert.equal(
      (await fetch(path, { method: "DELETE", headers: { Origin: origin } }))
        .status,
      409,
    );
    assert.equal(
      (
        await fetch(`${path}&operation=design-run`, {
          method: "DELETE",
          headers: { Origin: origin },
        })
      ).status,
      200,
    );
    assert.equal((await fetch(path)).status, 409);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("the chat's default wait outlasts the game's validation between design stages", async () => {
  const queue = createHandoffQueue(),
    app = createTerminalRelayApp({ queue });
  queue.enable(true);
  const first = request("design-slow-validation-one"),
    receipt = queue.enqueue("design-run", first, scope, chat);
  const turn = get(app);
  const sent = finish(app, turn, answer(first));
  queue.result(receipt.id, receipt.hash);
  const second = request("design-slow-validation-two");
  // A complete candidate took the live game 11 s to validate before this stage.
  const released = new Promise((done) =>
    setTimeout(() => {
      queue.enqueue("design-run", second, scope, chat);
      done();
    }, 5300),
  );
  const next = (
    await app.call(
      "get_current_study_question",
      { chat, after: sent.completion.continuation.after },
      owner,
    )
  ).structuredContent;
  await released;
  assert.equal(next.status, "prepare");
  assert.equal(next.requestId, second.requestId);
});

test("superseded design stages shed their packets but keep exact receipts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "design-compact-"));
  const file = join(dir, "jobs.json");
  try {
    const queue = createHandoffQueue({ file }),
      app = createTerminalRelayApp({ queue, continuationWaitMs: 5 });
    queue.enable(true);
    const first = request("design-compact-one"),
      receipt = queue.enqueue("design-run", first, scope, chat);
    const turn = get(app);
    const delivered = answer(first);
    finish(app, turn, delivered);
    const sizeBefore = statSync(file).size;

    // An unread answer must keep its packet even when a later stage exists.
    const unread = request("design-compact-two");
    queue.enqueue("design-run", unread, scope, chat);
    assert.ok(statSync(file).size > sizeBefore);
    const stored = () =>
      JSON.parse(readFileSync(file, "utf8")).jobs.find(
        (j) => j.requestId === first.requestId,
      );
    assert.equal(stored().compacted, undefined);

    assert.equal(queue.result(receipt.id, receipt.hash).status, "done");
    const third = request("design-compact-three");
    queue.enqueue("design-run", third, scope, chat);
    assert.equal(stored().compacted, true);
    assert.deepEqual(Object.keys(stored().payload).sort(), [
      "generationId",
      "requestId",
    ]);

    // An exact retry after a lost acknowledgement still reaches the same answer.
    assert.deepEqual(queue.enqueue("design-run", first, scope, chat), receipt);
    assert.deepEqual(queue.result(receipt.id, receipt.hash), {
      status: "done",
      answer: delivered,
    });
    assert.throws(() => queue.reopen(receipt.id), /superseded/);

    // A bridge restart accepts the compact form and keeps the newest packet.
    const restored = createHandoffQueue({ file });
    restored.enable(true);
    assert.deepEqual(restored.result(receipt.id, receipt.hash), {
      status: "done",
      answer: delivered,
    });
    const jobs = JSON.parse(readFileSync(file, "utf8")).jobs;
    assert.ok(jobs.at(-1).payload.structure ?? jobs.at(-1).payload.recent);
    assert.equal(jobs.at(-1).compacted, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loading an old queue saves its compaction so the next start is cheap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "design-compact-"));
  const file = join(dir, "jobs.json");
  try {
    const queue = createHandoffQueue({ file }),
      app = createTerminalRelayApp({ queue, continuationWaitMs: 5 });
    queue.enable(true);
    const first = request("design-load-one"),
      receipt = queue.enqueue("design-run", first, scope, chat);
    const delivered = answer(first);
    finish(app, get(app), delivered);
    assert.equal(queue.result(receipt.id, receipt.hash).status, "done");
    // Reproduce a file written before compaction: a superseded, fully read
    // stage that still holds its packet on disk.
    const later = request("design-load-two");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    const old = saved.jobs[0];
    old.resultReadAt = old.completedAt;
    saved.jobs.push({
      ...old,
      id: "later-stage",
      requestId: later.requestId,
      payload: later,
      hash: createHash("sha256")
        .update(JSON.stringify({ operation: old.operation, payload: later }))
        .digest("hex"),
      status: "queued",
      answer: undefined,
      answerHash: undefined,
      resultReadAt: undefined,
    });
    writeFileSync(file, JSON.stringify(saved));
    const before = statSync(file).size;

    const restored = createHandoffQueue({ file });
    const stored = JSON.parse(readFileSync(file, "utf8")).jobs;
    assert.equal(stored[0].compacted, true);
    assert.equal(stored[1].compacted, undefined);
    assert.ok(statSync(file).size < before);
    restored.enable(true);
    assert.deepEqual(restored.result(receipt.id, receipt.hash), {
      status: "done",
      answer: delivered,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a compact marker cannot disguise an unanswered or tampered design job", () => {
  const dir = mkdtempSync(join(tmpdir(), "design-compact-"));
  const file = join(dir, "jobs.json");
  try {
    const queue = createHandoffQueue({ file });
    queue.enable(true);
    const p = request("design-compact-queued");
    queue.enqueue("design-run", p, scope, chat);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.jobs[0].compacted = true;
    saved.jobs[0].payload = {
      requestId: p.requestId,
      generationId: p.generationId,
    };
    writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
    assert.throws(() => createHandoffQueue({ file }), /Corrupt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
