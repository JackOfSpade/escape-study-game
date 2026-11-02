import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createNpcSpeechService,
  NPC_SPEECH_LIMITS,
  NPC_SPEECH_TEMP_PREFIX,
  NPC_SPEECH_VOICES,
} from "../scripts/npc-speech-service.mjs";

const origin = "http://127.0.0.1:5173";
const input = {
  requestId: "ambient-1",
  actorId: "npc-2",
  text: "Stay away from the windows.",
  voice: "warm",
};
function wave(seconds = 0.5) {
  const size = Math.round(seconds * 22_050) * 2,
    bytes = Buffer.alloc(44 + size);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(22_050, 24);
  bytes.writeUInt32LE(44_100, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(size, 40);
  return bytes;
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "npc-speech-test-")),
    service = createNpcSpeechService({
      render: async () => wave(),
      tempRoot: root,
      ...options,
    }),
    server = createServer(async (req, res) => {
      if (!(await service.route(req, res))) {
        res.writeHead(404);
        res.end();
      }
    });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await service.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    service,
    get: (path) => fetch(base + path),
    post: (body = input, headers = {}) =>
      fetch(base + "/api/speech", {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
      }),
    remove: (path) =>
      fetch(base + path, { method: "DELETE", headers: { Origin: origin } }),
    base,
  };
}
async function files(f) {
  const directories = await readdir(f.root);
  return (
    await Promise.all(directories.map((d) => readdir(join(f.root, d))))
  ).flat();
}

test("NPC speech uses private temporary WAVs with exact line binding and one-use downloads", async (t) => {
  let rendered;
  const f = await fixture(t, {
    render: async (request) => {
      rendered = request;
      return wave();
    },
  });
  assert.deepEqual(
    await readdir(f.root),
    [],
    "status does not create a persistent speech directory",
  );
  assert.equal(f.service.status().provider, "local-speech");
  assert.equal(f.service.status().available, true);
  assert.deepEqual(f.service.status().voices, Object.keys(NPC_SPEECH_VOICES));
  const response = await f.post(),
    receipt = await response.json();
  assert.equal(response.status, 200);
  assert.equal(receipt.requestId, input.requestId);
  assert.equal(receipt.actorId, input.actorId);
  assert.equal(receipt.text, input.text);
  assert.equal(receipt.audio.mime, "audio/wav");
  assert.equal(receipt.audio.duration, 0.5);
  assert.equal(receipt.audio.bytes, wave().length);
  assert.match(receipt.audio.url, /^\/api\/speech\/[a-f0-9]{48}$/);
  assert.equal(rendered.voiceName, "Moira");
  assert.equal(rendered.text, input.text);
  assert.ok(rendered.signal instanceof AbortSignal);
  const directory = join(f.root, (await readdir(f.root))[0]);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal(
    (await stat(join(directory, (await readdir(directory))[0]))).mode & 0o777,
    0o600,
  );
  const downloads = await Promise.all([
    f.get(receipt.audio.url),
    f.get(receipt.audio.url),
  ]);
  assert.deepEqual(downloads.map((r) => r.status).sort(), [200, 410]);
  const audio = downloads.find((r) => r.status === 200);
  assert.equal(audio.headers.get("content-type"), "audio/wav");
  assert.equal(audio.headers.get("cache-control"), "no-store");
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), wave());
  assert.equal(f.service.status().pending, 0);
  assert.deepEqual(await files(f), []);
});

test("speech rejects untrusted origins, malformed IDs, markup, URLs and oversized requests before rendering", async (t) => {
  let renders = 0;
  const f = await fixture(t, {
    render: async () => {
      renders++;
      return wave();
    },
  });
  for (const body of [
    { ...input, requestId: 123 },
    { ...input, actorId: "../private" },
    { ...input, actorId: null },
    { ...input, text: " " },
    { ...input, text: "a".repeat(NPC_SPEECH_LIMITS.textChars + 1) },
    { ...input, text: "[[slnc 999999]]" },
    { ...input, text: "https://example.com" },
    { ...input, text: "hello\0world" },
    { ...input, voice: "../../voice" },
    { ...input, path: "/tmp/elsewhere" },
  ])
    assert.equal((await f.post(body)).status, 400);
  assert.equal(
    (await f.post(input, { Origin: "https://untrusted.example" })).status,
    403,
  );
  assert.equal(
    (await f.post(input, { Origin: "http://localhost:9999" })).status,
    403,
  );
  assert.equal(
    (
      await fetch(f.base + "/api/speech", {
        method: "POST",
        body: JSON.stringify(input),
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.post({ ...input, text: "x".repeat(3000) })).status,
    413,
  );
  assert.equal(renders, 0);
  assert.deepEqual(await readdir(f.root), []);
  assert.equal((await f.get("/unrelated")).status, 404);
});

test("pending audio is bounded and DELETE frees a ticket immediately", async (t) => {
  let renders = 0;
  const f = await fixture(t, {
      render: async () => {
        renders++;
        return wave();
      },
    }),
    receipts = [];
  for (let i = 0; i < NPC_SPEECH_LIMITS.pendingTickets; i++) {
    const response = await f.post({ ...input, requestId: `ambient-${i}` });
    assert.equal(response.status, 200);
    receipts.push(await response.json());
  }
  assert.equal((await f.post()).status, 429);
  assert.equal(renders, 4);
  assert.equal((await files(f)).length, 4);
  assert.equal((await f.remove(receipts[0].audio.url)).status, 204);
  assert.equal((await f.get(receipts[0].audio.url)).status, 410);
  assert.equal((await f.post()).status, 200);
  assert.equal(f.service.status().pending, 4);
});

test("synthesis has one slot and does not block status while busy", async (t) => {
  let finish, started;
  const began = new Promise((resolve) => {
      started = resolve;
    }),
    f = await fixture(t, {
      render: async () => {
        started();
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    }),
    first = f.post();
  await began;
  assert.equal((await f.post()).status, 429);
  const status = await (await f.get("/api/speech/status")).json();
  assert.equal(status.synthesizing, true);
  finish(wave());
  assert.equal((await first).status, 200);
});

test("speech validates bytes and actual duration and removes failed files", async (t) => {
  let audio;
  const f = await fixture(t, { render: async () => audio });
  for (const bad of [
    Buffer.from("not-wave"),
    wave(13),
    Buffer.alloc(NPC_SPEECH_LIMITS.fileBytes + 1),
  ]) {
    audio = bad;
    assert.equal((await f.post()).status, 502);
    assert.equal(f.service.status().pending, 0);
    assert.deepEqual(await files(f), []);
  }
  audio = wave();
  audio.writeUInt32LE(1, 28);
  assert.equal(
    (await f.post()).status,
    502,
    "a false byte rate cannot evade the duration check",
  );
});

test("tickets expire on access and timer cleanup removes unconsumed WAV files", async (t) => {
  let clock = 100;
  const f = await fixture(t, { now: () => clock });
  const receipt = await (await f.post()).json();
  clock += NPC_SPEECH_LIMITS.ttlMs;
  assert.equal((await f.get(receipt.audio.url)).status, 410);
  assert.deepEqual(await files(f), []);
  const timed = await fixture(t, { ttlMs: 10 });
  await timed.post();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(timed.service.status().pending, 0);
  assert.deepEqual(await files(timed), []);
});

test("timeouts and service close abort synthesis and remove temporary state", async (t) => {
  let aborted = false;
  const f = await fixture(t, {
    synthesisMs: 250,
    render: ({ signal }) => {
      if (signal.aborted) aborted = true;
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
        },
        { once: true },
      );
      return new Promise(() => {});
    },
  });
  assert.equal((await f.post()).status, 504);
  assert.ok(aborted);
  assert.equal(f.service.status().synthesizing, false);
  assert.deepEqual(await files(f), []);
  await f.service.close();
  assert.equal(f.service.status().available, false);
  assert.deepEqual(await readdir(f.root), []);
  assert.equal((await f.post()).status, 503);
});

test("unsupported hosts advertise speech unavailable without invoking a provider", async (t) => {
  const f = await fixture(t, { render: undefined, platform: "linux" });
  const response = await f.get("/api/speech/status"),
    value = await response.json();
  assert.equal(value.available, false);
  assert.equal((await f.post()).status, 503);
  assert.deepEqual(await readdir(f.root), []);
});

test("closing interrupts an active renderer and hides internal filesystem errors", async (t) => {
  let began,
    aborted = false;
  const started = new Promise((resolve) => {
      began = resolve;
    }),
    f = await fixture(t, {
      render: ({ signal }) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
          },
          { once: true },
        );
        began();
        return new Promise(() => {});
      },
    }),
    pending = f.post();
  await started;
  const firstClose = f.service.close();
  assert.equal(
    f.service.close(),
    firstClose,
    "all close callers await the same cleanup",
  );
  await firstClose;
  assert.ok(aborted);
  assert.equal((await pending).status, 504);
  assert.deepEqual(await readdir(f.root), []);
  const errors = await fixture(t, {
    render: async () => {
      throw Error("ENOENT at /private/example/credentials");
    },
  });
  const response = await errors.post();
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "Local speech failed" });
});

test("restart janitor removes private dead-owner WAVs and empty directories without touching foreign or linked contents", async (t) => {
  const f = await fixture(t, { isProcessAlive: (pid) => pid === process.pid }),
    wavName = `${"a".repeat(48)}.wav`,
    directory = async (pid, suffix) => {
      const path = join(f.root, `${NPC_SPEECH_TEMP_PREFIX}${pid}-${suffix}`);
      await mkdir(path, { mode: 0o700 });
      return path;
    },
    expired = await directory(999991, "oldwav"),
    empty = await directory(999992, "empty1"),
    mixed = await directory(999993, "mixed1"),
    nonprivate = await directory(999994, "shared"),
    fileLinkDirectory = await directory(999995, "linked"),
    foreign = join(f.root, "unrelated-synthetic-audio"),
    foreignFile = join(foreign, wavName),
    directoryLink = join(f.root, `${NPC_SPEECH_TEMP_PREFIX}999996-dirlnk`);
  await mkdir(foreign, { mode: 0o700 });
  await writeFile(foreignFile, "foreign fixture", { mode: 0o600 });
  await writeFile(join(expired, wavName), wave(), { mode: 0o600 });
  await utimes(join(expired, wavName), new Date(0), new Date(0));
  await writeFile(join(mixed, wavName), wave(), { mode: 0o600 });
  await writeFile(
    join(mixed, "unrecognized-note.txt"),
    "foreign note fixture",
    { mode: 0o600 },
  );
  await writeFile(join(nonprivate, wavName), wave(), { mode: 0o600 });
  await chmod(nonprivate, 0o755);
  await symlink(foreign, directoryLink, "dir");
  await symlink(foreignFile, join(fileLinkDirectory, wavName));
  const legacy = join(f.root, "zombie-npc-speech-legacy");
  await mkdir(legacy, { mode: 0o700 });
  await writeFile(join(legacy, wavName), wave(), { mode: 0o600 });
  assert.equal(
    (await f.post()).status,
    200,
    "first synthesis runs the scoped janitor",
  );
  await assert.rejects(lstat(expired), { code: "ENOENT" });
  await assert.rejects(lstat(empty), { code: "ENOENT" });
  assert.deepEqual(await readdir(mixed), ["unrecognized-note.txt"]);
  assert.deepEqual(await readdir(nonprivate), [wavName]);
  assert.ok((await lstat(directoryLink)).isSymbolicLink());
  assert.ok((await lstat(join(fileLinkDirectory, wavName))).isSymbolicLink());
  assert.deepEqual(await readdir(foreign), [wavName]);
  assert.deepEqual(
    await readdir(legacy),
    [wavName],
    "unversioned directories have no provable owner PID",
  );
});

test("a second live service preserves another service's ticket even when the file mtime is old", async (t) => {
  const first = await fixture(t),
    receipt = await (await first.post()).json(),
    firstDirectoryName = (await readdir(first.root))[0],
    firstDirectory = join(first.root, firstDirectoryName),
    firstFile = join(firstDirectory, (await readdir(firstDirectory))[0]);
  assert.match(
    firstDirectoryName,
    new RegExp(`^${NPC_SPEECH_TEMP_PREFIX}${process.pid}-[A-Za-z0-9]{6}$`),
  );
  await utimes(firstFile, new Date(0), new Date(0));
  const second = await fixture(t, { tempRoot: first.root });
  assert.equal((await second.post()).status, 200);
  assert.ok(
    (await stat(firstFile)).isFile(),
    "a live PID owns its own TTL cleanup",
  );
  await second.service.close();
  assert.deepEqual(await readdir(first.root), [firstDirectoryName]);
  assert.equal(
    (await first.get(receipt.audio.url)).status,
    200,
    "the original one-use ticket still works after another service starts",
  );
});

test("dialogue policy accepts bounded heard metadata and rejects malformed hearing descriptions", async () => {
  const { isNpcDialogueContext } =
    await import("../scripts/lib/npc-dialogue-policy.mjs");
  const context = {
    requestId: "reply-2",
    actorId: "listener",
    runId: "overheard-run",
    capturedAt: 10,
    conversation: {
      id: "opening",
      replyTo: "line-1",
      sourceActorId: "speaker",
      turn: 2,
      maxTurns: 4,
      expiresAt: 38,
    },
    recentLines: [
      {
        id: "line-1",
        actorId: "speaker",
        text: "That corridor is quiet.",
        at: 8,
        conversationId: "opening",
        turn: 1,
      },
    ],
    dialogue: {
      version: 1,
      facts: [
        {
          id: "speech:line-1",
          kind: "person",
          text: "The speaker said that corridor is quiet.",
          key: "line-1",
        },
      ],
    },
  };
  assert.equal(isNpcDialogueContext(context), true, "heard remains optional");
  const withHeard = (heard) => ({
    ...context,
    conversation: { ...context.conversation, heard },
  });
  for (const addressed of ["self", "other", "none"])
    for (const act of ["question", "request", "warning", "statement"])
      for (const distance of [0, 6.3, 20])
        assert.equal(
          isNpcDialogueContext(withHeard({ addressed, act, distance })),
          true,
        );
  const valid = { addressed: "none", act: "statement", distance: 6.3 };
  for (const heard of [
    null,
    [],
    "nearby",
    {},
    { ...valid, addressed: "everyone" },
    { ...valid, act: "invitation" },
    { ...valid, distance: "6.3" },
    { ...valid, distance: -0.1 },
    { ...valid, distance: 20.1 },
    { ...valid, distance: Infinity },
    { ...valid, distance: NaN },
    { addressed: "none", act: "statement" },
    { act: "statement", distance: 1 },
    { addressed: "none", distance: 1 },
    { ...valid, extra: true },
  ])
    assert.equal(isNpcDialogueContext(withHeard(heard)), false);
});
