import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createKokoroRenderer } from "../scripts/npc-kokoro-renderer.mjs";
import {
  createNpcSpeechService,
  NPC_KOKORO_VOICES,
  NPC_SPEECH_VOICES,
  pcmWaveFromFloat,
} from "../scripts/npc-speech-service.mjs";

const origin = "http://127.0.0.1:5173";
const slots = [
  "steady",
  "bright",
  "warm",
  "low",
  "crisp",
  "gruff",
  "soft",
  "lively",
  "clear",
  "keen",
  "calm",
  "even",
  "quick",
  "poised",
  "dry",
];
function sine(seconds, rate, amplitude = 0.5) {
  const samples = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < samples.length; i++)
    samples[i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / rate);
  return samples;
}
/** Drive the real service route in-process: identical validation, no sockets. */
async function call(service, { method = "GET", path, body }) {
  const req = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
  );
  req.method = method;
  req.url = path;
  req.headers = {
    origin,
    host: "127.0.0.1:5173",
    "content-type": "application/json",
  };
  const result = { status: 0, headers: {}, body: Buffer.alloc(0) };
  const res = {
    destroyed: false,
    headersSent: false,
    writeHead(value, headers = {}) {
      result.status = value;
      result.headers = headers;
      this.headersSent = true;
    },
    end(value) {
      if (value !== undefined) result.body = Buffer.from(value);
    },
    once() {},
    off() {},
  };
  await service.route(req, res);
  return {
    ...result,
    json: () => (result.body.length ? JSON.parse(result.body.toString()) : {}),
  };
}
const speak = (service, body) =>
  call(service, { method: "POST", path: "/api/speech", body });
const fetchAudio = (service, path) => call(service, { method: "GET", path });
async function fixture(t, options = {}) {
  const tempRoot = await mkdtemp(join(tmpdir(), "npc-kokoro-test-")),
    service = createNpcSpeechService({ tempRoot, ...options });
  t.after(async () => {
    await service.close();
    await rm(tempRoot, { recursive: true, force: true });
  });
  return service;
}
const line = {
  requestId: "ambient-1",
  actorId: "npc-2",
  text: "Stay away from the windows.",
  voice: "warm",
};

test("pcmWaveFromFloat writes the 16-bit mono 22050 Hz WAV the service accepts", () => {
  const wav = pcmWaveFromFloat(sine(0.5, 24_000), 24_000);
  const expectedFrames = Math.round(0.5 * 22_050);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.toString("ascii", 8, 16), "WAVEfmt ");
  assert.equal(wav.readUInt32LE(16), 16);
  assert.equal(wav.readUInt16LE(20), 1, "PCM encoding");
  assert.equal(wav.readUInt16LE(22), 1, "mono");
  assert.equal(wav.readUInt32LE(24), 22_050);
  assert.equal(wav.readUInt32LE(28), 44_100);
  assert.equal(wav.readUInt16LE(32), 2);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString("ascii", 36, 40), "data");
  assert.equal(wav.readUInt32LE(40), expectedFrames * 2);
  assert.equal(wav.length, 44 + expectedFrames * 2);
  const clamped = pcmWaveFromFloat(Float32Array.from([1.5, -1.5, 0]), 22_050);
  assert.equal(clamped.readInt16LE(44), 32_767, "1.5 is clamped, not wrapped");
  assert.equal(clamped.readInt16LE(46), -32_767);
  assert.equal(clamped.readInt16LE(48), 0);
  assert.equal(clamped.readUInt32LE(4), clamped.length - 8);
});

test("a rendered Kokoro-shaped WAV becomes a downloadable speech ticket", async (t) => {
  const expectedBytes = 44 + Math.round(0.5 * 22_050) * 2,
    service = await fixture(t, {
      render: async () => pcmWaveFromFloat(sine(0.5, 24_000), 24_000),
    });
  const response = await speak(service, line),
    receipt = response.json();
  assert.equal(response.status, 200);
  assert.equal(receipt.audio.mime, "audio/wav");
  assert.equal(receipt.audio.duration, 0.5);
  assert.equal(receipt.audio.bytes, expectedBytes);
  const audio = await fetchAudio(service, receipt.audio.url);
  assert.equal(audio.status, 200);
  assert.equal(audio.headers["Content-Type"], "audio/wav");
  assert.equal(audio.body.length, expectedBytes);
  assert.equal(audio.body.toString("ascii", 0, 4), "RIFF");
  assert.equal(audio.body.readUInt32LE(40), expectedBytes - 44);
  assert.equal(service.status().available, true);
});
function fakeTts(seen, samples = sine(0.25, 24_000, 0.25)) {
  return {
    generate: async (text, options) => {
      seen.push({ text, options });
      return { audio: samples, sampling_rate: 24_000 };
    },
  };
}
const request = (extra = {}) => ({
  text: "Keep that doorway clear.",
  voice: "crisp",
  voiceName: "Daniel",
  path: "/tmp/synthetic-npc-line.wav",
  signal: new AbortController().signal,
  ...extra,
});

test("the renderer speaks with Kokoro once the model is ready", async () => {
  const seen = [],
    fallbacks = [],
    render = createKokoroRenderer({
      loadTts: async () => fakeTts(seen),
      fallback: async (value) => {
        fallbacks.push(value);
        throw Error("the fallback must not run for a ready model");
      },
    });
  await render.loaded;
  assert.equal(render.ready(), true);
  const wav = await render(request());
  assert.deepEqual(fallbacks, [], "Kokoro handled the line itself");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, "Keep that doorway clear.");
  assert.equal(seen[0].options.voice, "bf_emma", "crisp maps to bf_emma");
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt32LE(24), 22_050);
  await render(request({ voice: "not-a-slot" }));
  assert.equal(
    seen[1].options.voice,
    "am_michael",
    "unknown slots stay audible",
  );
});

test("a line is never delayed by the model load and a load failure stays quiet", async () => {
  const received = [];
  let settle;
  const loading = createKokoroRenderer({
    loadTts: () => new Promise((resolve) => (settle = resolve)),
    fallback: async (value) => {
      received.push(value);
      return Buffer.from("fallback-while-loading");
    },
  });
  const pending = request({ voiceName: "Rishi", voice: "low" });
  assert.equal(loading.ready(), false);
  const bytes = await loading(pending);
  assert.equal(bytes.toString(), "fallback-while-loading");
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], pending, "the fallback sees the original args");
  assert.equal(loading.ready(), false, "the first line beats the model load");
  settle(fakeTts([]));
  await loading.loaded;
  assert.equal(
    loading.ready(),
    true,
    "the warm-up settles when the model does",
  );

  let fallbacks = 0;
  const broken = createKokoroRenderer({
    loadTts: async () => {
      throw Error("model files are unavailable");
    },
    fallback: async () => {
      fallbacks++;
      return Buffer.from("fallback-after-failure");
    },
  });
  assert.equal(await broken.loaded, undefined, "a failed load is contained");
  assert.equal(
    broken.ready(),
    false,
    "a failed load never advertises a ready model",
  );
  assert.equal((await broken(request())).toString(), "fallback-after-failure");
  assert.equal(fallbacks, 1);
});

test("generation errors and aborts fall back instead of returning audio", async () => {
  let fallbacks = 0;
  const render = createKokoroRenderer({
    loadTts: async () => ({
      generate: async () => {
        throw Error("onnx runtime crashed");
      },
    }),
    fallback: async () => {
      fallbacks++;
      return Buffer.from("fallback-after-generate-error");
    },
  });
  await render.loaded;
  assert.equal(
    (await render(request())).toString(),
    "fallback-after-generate-error",
  );
  assert.equal(fallbacks, 1);

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(render(request({ signal: aborted.signal })), Error);
  assert.equal(fallbacks, 1, "an aborted line never reaches the fallback");

  const duringStart = new AbortController();
  let release;
  const slow = createKokoroRenderer({
    loadTts: async () => ({
      generate: () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ audio: sine(0.25, 24_000), sampling_rate: 24_000 });
        }),
    }),
    fallback: async () => {
      fallbacks++;
      return Buffer.from("unreachable");
    },
  });
  await slow.loaded;
  const midFlight = slow(request({ signal: duringStart.signal }));
  duringStart.abort();
  release();
  await assert.rejects(midFlight, Error);
  assert.equal(fallbacks, 1, "an aborted generation returns no audio");
});
test("both voice maps define the same fifteen slots and the service accepts every one", async (t) => {
  assert.deepEqual(Object.keys(NPC_SPEECH_VOICES), slots);
  assert.deepEqual(Object.keys(NPC_KOKORO_VOICES), slots);
  assert.ok(Object.isFrozen(NPC_SPEECH_VOICES));
  assert.ok(Object.isFrozen(NPC_KOKORO_VOICES));
  const kokoroIds = Object.values(NPC_KOKORO_VOICES);
  assert.equal(
    new Set(kokoroIds).size,
    slots.length,
    `the ${slots.length} slots map to distinct Kokoro voice ids`,
  );
  for (const rejected of ["am_santa", "af_sky", "am_adam"])
    assert.equal(
      kokoroIds.includes(rejected),
      false,
      `${rejected} is below C grade and stays out of the palette`,
    );
  const seen = [],
    service = await fixture(t, {
      render: async (value) => {
        seen.push(value);
        return pcmWaveFromFloat(sine(0.1, 24_000), 24_000);
      },
    });
  assert.deepEqual(service.status().voices, slots);
  for (const voice of slots) {
    const response = await speak(service, { ...line, voice });
    assert.equal(response.status, 200, `the service accepts voice ${voice}`);
    const receipt = response.json();
    assert.equal(receipt.audio.mime, "audio/wav");
    assert.equal((await fetchAudio(service, receipt.audio.url)).status, 200);
  }
  assert.deepEqual(
    seen.map((value) => value.voice),
    slots,
  );
  assert.deepEqual(
    seen.map((value) => value.voiceName),
    slots.map((voice) => NPC_SPEECH_VOICES[voice]),
  );
  assert.equal(
    (await speak(service, { ...line, voice: "robotic" })).status,
    400,
  );
});

test("the renderer warms the model up at creation and imports kokoro-js lazily", async () => {
  let loads = 0,
    resolveLoad;
  const render = createKokoroRenderer({
    loadTts: () => {
      loads++;
      return new Promise((resolve) => {
        resolveLoad = resolve;
      });
    },
    fallback: async () => Buffer.alloc(0),
  });
  assert.equal(loads, 1, "loading starts at creation, not on the first line");
  assert.equal(render.ready(), false);
  resolveLoad(fakeTts([]));
  await render.loaded;
  assert.equal(render.ready(), true);
  const source = readFileSync(
    new URL("../scripts/npc-kokoro-renderer.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(
    /^(?:import|export)[^;\n]*["']kokoro-js["']/m.test(source),
    false,
    "a static import would pull ONNX into every bridge start",
  );
  assert.match(source, /await import\(["']kokoro-js["']\)/);
});
