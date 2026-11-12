import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AudioDirector } from "../src/audio";
import { type Floor, type Furniture, type Roadmap, event } from "../src/model";
import { SFX } from "../src/sfx";
import { soundEvents } from "../src/soundscape";
import { listenerPose, soundPose, spatialMixer } from "../src/spatial-audio";
import { buildStairRoute, sampleStairRoute } from "../src/stair-route";
import { createGame } from "../src/world";
import { createCityPlan } from "../src/city-layout";
import { hordeSound } from "../src/soundscape";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
function fixture() {
  const g = createGame(7, roadmap);
  g.status = "playing";
  g.time = 100;
  g.nextSpawn = Number.MAX_SAFE_INTEGER;
  g.zombies = [];
  g.survivors = g.survivors.slice(0, 2);
  Object.assign(g.survivors[0], { x: 10.5, y: 15.5, floor: 0 });
  Object.assign(g.survivors[1], {
    x: 13.5,
    y: 15.5,
    floor: 0,
    alive: true,
    escaped: false,
  });
  g.floors[0] = {
    index: 0,
    tiles: Array.from({ length: 34 }, (_, y) =>
      Array.from({ length: 44 }, (_, x) =>
        x === 0 || y === 0 || x === 43 || y === 33 ? 1 : 0,
      ),
    ),
    stations: [],
    furniture: [],
    dark: 0,
    name: "Spatial audio fixture",
    doors: [],
    stairs: { x: 40, y: 2 },
    entry: { x: 20, y: 30 },
  } as Floor;
  return g;
}
class Param {
  value = 0;
  setValueAtTime(value: number, _time: number) {
    this.value = value;
  }
  setTargetAtTime(value: number, _time: number, _constant: number) {
    this.value = value;
  }
  linearRampToValueAtTime(value: number, _time: number) {
    this.value = value;
  }
  exponentialRampToValueAtTime(value: number, _time: number) {
    this.value = value;
  }
}
class Node {
  gain = new Param();
  frequency = new Param();
  playbackRate = new Param();
  positionX = new Param();
  positionY = new Param();
  positionZ = new Param();
  connections: Node[] = [];
  disconnects = 0;
  starts = 0;
  stops: (number | undefined)[] = [];
  onended?: () => void;
  buffer: AudioBuffer | null = null;
  panningModel = "";
  distanceModel = "";
  channelCount = 2;
  channelCountMode = "";
  constructor(readonly kind: string) {}
  connect(node: Node) {
    this.connections.push(node);
  }
  disconnect() {
    this.disconnects++;
  }
  start() {
    this.starts++;
  }
  stop(at?: number) {
    this.stops.push(at);
  }
}
function buffer(seconds = 2) {
  const data = new Float32Array(Math.round(48000 * seconds));
  return {
    duration: seconds,
    length: data.length,
    sampleRate: 48000,
    numberOfChannels: 1,
    getChannelData: () => data,
  } as unknown as AudioBuffer;
}
function graph() {
  const sources: Node[] = [],
    oscillators: Node[] = [],
    panners: Node[] = [];
  const listener = Object.fromEntries(
    [
      "positionX",
      "positionY",
      "positionZ",
      "forwardX",
      "forwardY",
      "forwardZ",
      "upX",
      "upY",
      "upZ",
    ].map((name) => [name, new Param()]),
  );
  let decoded = buffer(),
    decodeCalls = 0;
  const ctx = {
    state: "running",
    currentTime: 0,
    sampleRate: 48000,
    listener,
    destination: new Node("destination"),
    resume: async () => {},
    createGain: () => new Node("gain"),
    createBiquadFilter: () => new Node("filter"),
    createDynamicsCompressor: () =>
      Object.assign(new Node("compressor"), {
        threshold: new Param(),
        knee: new Param(),
        ratio: new Param(),
        attack: new Param(),
        release: new Param(),
      }),
    createBuffer: (_channels: number, frames: number) => ({
      getChannelData: () => new Float32Array(frames),
    }),
    createBufferSource: () => {
      const n = new Node("source");
      sources.push(n);
      return n;
    },
    createOscillator: () => {
      const n = new Node("oscillator");
      oscillators.push(n);
      return n;
    },
    createPanner: () => {
      const n = new Node("panner");
      panners.push(n);
      return n;
    },
    decodeAudioData: async (_bytes: ArrayBuffer) => {
      decodeCalls++;
      return decoded;
    },
  };
  const bank = new Map(
    Object.values(SFX)
      .flat()
      .map((name) => [name, Object.assign(buffer(0.2), { name })]),
  );
  const director = new AudioDirector(
    () => ctx as unknown as AudioContext,
    async () => bank,
  );
  return {
    director,
    ctx,
    listener,
    sources,
    oscillators,
    panners,
    bank,
    get decodeCalls() {
      return decodeCalls;
    },
    set decoded(value: AudioBuffer) {
      decoded = value;
    },
  };
}
function path(source: Node) {
  const nodes = [source];
  while (nodes.at(-1)!.connections.length)
    nodes.push(nodes.at(-1)!.connections[0]);
  return nodes;
}
function value(listener: Record<string, Param>, key: string) {
  return listener[key].value;
}

test("sampled impacts and synthesized fallbacks use the actual world emitter through an HRTF graph", async () => {
  for (const sampled of [true, false]) {
    const audio = graph(),
      g = fixture();
    audio.director.start();
    if (sampled) await audio.director.ready;
    audio.director.update(g, { yaw: 0, pitch: 0 });
    const before = g.seq;
    event(g, "barricade-hit", "Synthetic physical impact", 0).position = {
      x: 10.5,
      y: 12.5,
    };
    const cue = soundEvents(g, before)[0];
    assert.deepEqual(cue.origin, { x: 10.5, y: 12.5, floor: 0, height: 1.2 });
    audio.director.update(g, { yaw: 0, pitch: 0 });
    const source = sampled ? audio.sources.at(-1)! : audio.oscillators.at(-1)!;
    const chain = path(source);
    assert.deepEqual(
      chain.map((n) => n.kind),
      [
        sampled ? "source" : "oscillator",
        ...(!sampled ? ["gain"] : []),
        "filter",
        "gain",
        "panner",
        "gain",
        "compressor",
        "destination",
      ],
    );
    const panner = chain.find((n) => n.kind === "panner")!;
    assert.equal(panner.panningModel, "HRTF");
    assert.equal(
      panner.channelCount,
      1,
      "stereo files are downmixed before spatialization",
    );
    assert.equal(panner.positionX.value, 10.5);
    assert.equal(panner.positionZ.value, 12.5);
    assert.equal(panner.positionY.value, 1.2);
    const leftWhenFacingEast =
      (panner.positionZ.value - value(audio.listener, "positionZ")) *
      value(audio.listener, "forwardX");
    assert.ok(leftWhenFacingEast < 0);
    audio.director.update(g, { yaw: Math.PI, pitch: 0 });
    const rightWhenFacingWest =
      (panner.positionZ.value - value(audio.listener, "positionZ")) *
      value(audio.listener, "forwardX");
    assert.ok(
      rightWhenFacingWest > 0,
      "turning around reverses the same emitter's headphone side",
    );
    assert.equal(
      panner.positionZ.value,
      12.5,
      "turning the head never moves the world emitter",
    );
  }
});

test("listener height and pitch track a freely moving elevated body instead of the old stair rail", () => {
  const g = fixture(),
    audio = graph(),
    a = g.survivors[0];
  a.stairTravel = {
    fromFloor: 0,
    toFloor: 1,
    origin: { ...g.floors[0].stairs },
    destination: { ...g.floors[1].entry },
    until: 0,
    walked: 0,
  };
  a.stairTravel.walked = buildStairRoute(g, a.stairTravel).length - 0.5;
  const stair = sampleStairRoute(g, a.stairTravel),
    original = { x: a.x, y: a.y };
  // A lateral step and jump must reach the listener even though saved route
  // progress still identifies the same gallery segment.
  a.x = stair.x + 0.35;
  a.y = stair.z - 0.2;
  a.elevated = {
    feet: stair.y + 0.65,
    vx: 0.8,
    vy: 0,
    vz: -1,
    peak: stair.y + 1.1,
    grounded: false,
  };
  audio.director.start();
  audio.director.update(g, { yaw: 0.7, pitch: 0.4 });
  const pose = listenerPose(g, { yaw: 0.7, pitch: 0.4 });
  assert.ok(
    Math.abs(value(audio.listener, "positionY") - (a.elevated.feet + 1.6)) <
      1e-10,
  );
  assert.equal(value(audio.listener, "positionX"), a.x);
  assert.equal(value(audio.listener, "positionZ"), a.y);
  assert.ok(
    Math.abs(
      pose.forward.x * pose.up.x +
        pose.forward.y * pose.up.y +
        pose.forward.z * pose.up.z,
    ) < 1e-10,
  );
  delete a.elevated;
  const legacy = listenerPose(g);
  assert.equal(
    legacy.y,
    stair.y + 1.6,
    "old walking saves retain their height until upgraded",
  );
  assert.equal(legacy.x, stair.x);
  assert.equal(legacy.z, stair.z);
  delete a.stairTravel;
  Object.assign(a, original);
  const mix = spatialMixer(g),
    near = mix({ x: 13.5, y: 15.5, floor: 0, height: 1.45 }),
    far = mix({ x: 22.5, y: 15.5, floor: 0, height: 1.45 }),
    above = mix({ x: 13.5, y: 15.5, floor: 1, height: 1.45 });
  assert.ok(near.gain > far.gain && far.distance > near.distance);
  assert.ok(
    above.gain < near.gain / 10,
    "a closed intervening floor muffles the source",
  );
  assert.equal(above.cutoff, 120);
  assert.deepEqual(soundPose({ x: 2, y: 3, floor: 2, height: 1.4 }), {
    x: 2,
    y: 8.6,
    z: 3,
  });
});

test("outdoor city voices and horde sounds are muffled around actual masonry corners", () => {
  const g = fixture(),
    floor = g.floors[0];
  floor.boundary = {
    version: 1,
    shape: "rectangle",
    width: 36,
    depth: 24,
    top: 4,
    bottom: 28,
    rows: Array.from({ length: 34 }, (_, y) =>
      y >= 4 && y < 28 ? { left: 4, right: 40 } : { left: 22, right: 22 },
    ),
  };
  floor.tiles = floor.tiles.map((row, y) =>
    row.map((_, x) => (x >= 4 && x < 40 && y >= 4 && y < 28 ? 0 : 1)),
  );
  floor.city = createCityPlan(floor, 42, 297);
  Object.assign(g.survivors[0], { x: 8, y: 1 });
  const clear = spatialMixer(g)({ x: 10, y: 1, floor: 0 }),
    blocked = spatialMixer(g)({ x: 1, y: 8, floor: 0 });
  assert.equal(clear.transmission, 1);
  assert.equal(clear.cutoff, 4800);
  assert.equal(blocked.transmission, 0.15);
  assert.equal(blocked.cutoff, 120);
  g.zombies = [
    {
      id: "city-corner",
      x: 1,
      y: 8,
      floor: 0,
      hp: 60,
      path: [],
      repath: 0,
      cooldown: 0,
      memory: 0,
      stagger: 0,
      origin: "outside",
    },
  ];
  assert.equal(hordeSound(g).cutoff, 120);
});

test("speech distinguishes a naturally completed line from an interruption exactly once", () => {
  const audio = graph(),
    g = fixture(),
    outcomes: (boolean | undefined)[] = [];
  audio.director.start();
  audio.director.update(g);
  const start = (id: string) =>
    assert.equal(
      audio.director.speak(g, {
        id,
        actorId: g.survivors[1].id,
        buffer: buffer(),
        onEnded: (completed) => outcomes.push(completed),
      }),
      true,
    );
  start("natural-completion");
  const completed = audio.sources.at(-1)!;
  completed.onended?.();
  completed.onended?.();
  assert.deepEqual(outcomes, [true]);
  assert.equal(completed.buffer, null);
  start("interrupted-line");
  const interrupted = audio.sources.at(-1)!;
  audio.director.stopSpeech("interrupted-line");
  interrupted.onended?.();
  assert.deepEqual(outcomes, [true, false]);
  assert.equal(interrupted.buffer, null);
  audio.director.stop();
});

test("speech tracks the speaking NPC every frame, uses one voice, and releases its buffer and bubble callback once", () => {
  const audio = graph(),
    g = fixture(),
    actor = g.survivors[1];
  let ended = 0;
  assert.equal(audio.director.canSpeak(g), false);
  audio.director.start();
  audio.director.update(g, { yaw: 0 });
  assert.equal(audio.director.canSpeak(g), true);
  assert.equal(
    audio.director.speak(g, {
      id: "sentence-one",
      actorId: actor.id,
      buffer: buffer(),
      onEnded: () => ended++,
    }),
    true,
  );
  const source = audio.sources.at(-1)!,
    chain = path(source),
    panner = chain[3];
  assert.equal(audio.director.canSpeak(g), false);
  assert.equal(
    audio.director.speak(g, {
      id: "overlapping-sentence",
      actorId: actor.id,
      buffer: buffer(),
    }),
    false,
  );
  assert.equal(panner.positionX.value, actor.x);
  const initialGain = chain[2].gain.value;
  actor.x += 1;
  g.time += 1 / 30;
  audio.director.update(g, { yaw: 0 });
  assert.equal(
    panner.positionX.value,
    actor.x,
    "position is not held until the 250ms acoustic refresh",
  );
  actor.x += 4;
  g.time += 0.3;
  audio.director.update(g, { yaw: 0 });
  assert.ok(
    chain[2].gain.value < initialGain,
    "walking away reduces the still-playing voice",
  );
  actor.alive = false;
  audio.director.update(g, { yaw: 0 });
  assert.equal(ended, 1);
  assert.equal(source.buffer, null);
  assert.ok(source.stops.includes(undefined));
  assert.ok(panner.disconnects > 0);
  source.onended?.();
  audio.director.stopSpeech();
  assert.equal(ended, 1);
});

test("ongoing speech and synthesized effects follow listener distance on every frame without restarting their envelope", () => {
  for (const kind of ["speech", "cue"] as const) {
    const audio = graph(),
      g = fixture(),
      actor = g.survivors[1];
    audio.director.start();
    audio.director.update(g, { yaw: 0 });
    if (kind === "speech")
      assert.ok(
        audio.director.speak(g, {
          id: "moving-listener",
          actorId: actor.id,
          buffer: buffer(8),
        }),
      );
    else
      audio.director.cue(180, 8, 0.12, undefined, "effect", 4800, {
        x: actor.x,
        y: actor.y,
        floor: actor.floor,
        height: 1.45,
      });
    const source =
        kind === "speech" ? audio.sources.at(-1)! : audio.oscillators.at(-1)!,
      chain = path(source),
      volume = chain[chain.findIndex((n) => n.kind === "filter") + 1],
      nearGain = volume.gain.value;
    g.survivors[0].x -= 3;
    g.time += 1 / 60;
    audio.director.update(g, { yaw: Math.PI / 2 });
    assert.ok(
      volume.gain.value < nearGain,
      `${kind} becomes quieter on the very next frame, before the obstruction refresh`,
    );
    const farGain = volume.gain.value;
    g.survivors[0].x = actor.x - 1;
    g.time += 1 / 60;
    audio.director.update(g, { yaw: Math.PI });
    assert.ok(
      volume.gain.value > farGain && volume.gain.value > nearGain,
      `${kind} becomes louder again as the player approaches`,
    );
    assert.equal(source.starts, 1, "movement keeps the same source playing");
    assert.ok(Math.abs(value(audio.listener, "forwardX") + 1) < 1e-8);
    if (kind === "cue") {
      assert.equal(chain[1].kind, "gain", "the envelope has its own node");
      assert.ok(
        chain[1].gain.value < 0.01,
        "updating distance does not overwrite the scheduled fade-out",
      );
    }
  }
});

test("speech cancellation covers pause, mute, escape, distant actors, explicit stop and replaced runs", () => {
  for (const reason of [
    "pause",
    "study",
    "mute",
    "escape",
    "distance",
    "explicit",
    "run",
  ]) {
    const audio = graph(),
      g = fixture();
    let ended = 0;
    audio.director.start();
    audio.director.update(g);
    assert.equal(
      audio.director.speak(g, {
        id: reason,
        actorId: g.survivors[1].id,
        buffer: buffer(),
        onEnded: () => ended++,
      }),
      true,
    );
    if (reason === "pause") g.paused = true;
    if (reason === "study")
      g.studyWorkspace = { enabled: true, wasPaused: false };
    if (reason === "mute") g.settings.volume = 0;
    if (reason === "escape") g.survivors[1].escaped = true;
    if (reason === "distance") g.survivors[1].x += 30;
    if (reason === "explicit") audio.director.stopSpeech(reason);
    audio.director.update(reason === "run" ? fixture() : g);
    assert.equal(ended, 1, reason);
    audio.sources.at(-1)!.onended?.();
    assert.equal(ended, 1, `${reason} callback cannot be repeated by onended`);
  }
});

test("temporary speech decoding rejects oversized, long, malformed and nonfinite audio without caching it", async () => {
  const audio = graph();
  audio.director.start();
  assert.equal(
    await audio.director.decodeSpeech(new ArrayBuffer(0)),
    undefined,
  );
  assert.equal(
    await audio.director.decodeSpeech(new ArrayBuffer(1_000_001)),
    undefined,
  );
  assert.equal(audio.decodeCalls, 0);
  assert.ok(await audio.director.decodeSpeech(new ArrayBuffer(16)));
  audio.decoded = buffer(13);
  assert.equal(
    await audio.director.decodeSpeech(new ArrayBuffer(16)),
    undefined,
  );
  audio.decoded = Object.assign(buffer(), { sampleRate: Number.NaN });
  assert.equal(
    await audio.director.decodeSpeech(new ArrayBuffer(16)),
    undefined,
  );
  const invalid = buffer();
  invalid.getChannelData(0)[1] = Number.NaN;
  audio.decoded = invalid;
  assert.equal(
    await audio.director.decodeSpeech(new ArrayBuffer(16)),
    undefined,
  );
  const g = fixture();
  audio.director.update(g);
  assert.equal(
    audio.director.speak(g, {
      id: "too-long",
      actorId: g.survivors[1].id,
      buffer: buffer(13),
    }),
    false,
  );
  assert.equal(
    audio.director.speak(g, {
      id: "no-human-monologue",
      actorId: "human",
      buffer: buffer(),
    }),
    false,
  );
});

test("study-only work cannot start a background sentence even with running audio and an otherwise active run", () => {
  const audio = graph(),
    g = fixture();
  audio.director.start();
  audio.director.update(g);
  assert.equal(audio.director.canSpeak(g), true);
  g.studyWorkspace = { enabled: true, wasPaused: false };
  assert.equal(audio.director.canSpeak(g), false);
  assert.equal(
    audio.director.speak(g, {
      id: "study-silence",
      actorId: g.survivors[1].id,
      buffer: buffer(),
    }),
    false,
  );
  delete g.studyWorkspace;
  assert.equal(audio.director.canSpeak(g), true);
});

test("a playing sentence muffles behind a newly sealed doorway, recovers when reopened and ends beyond an intervening floor", () => {
  const audio = graph(),
    g = fixture(),
    floor = g.floors[0];
  for (let y = 1; y < 33; y++) floor.tiles[y][12] = 1;
  floor.tiles[15][12] = 0;
  audio.director.start();
  audio.director.update(g);
  let ended = 0;
  assert.equal(
    audio.director.speak(g, {
      id: "barrier-sentence",
      actorId: g.survivors[1].id,
      buffer: buffer(8),
      onEnded: () => ended++,
    }),
    true,
  );
  const chain = path(audio.sources.at(-1)!),
    initialGain = chain[2].gain.value;
  const barrier = {
    id: "new-barricade",
    kind: "fridge",
    x: 12.5,
    y: 15.5,
    floor: 0,
    w: 1,
    h: 1,
    hp: 100,
    maxHp: 100,
    destroyed: false,
    turning: 0,
  } as Furniture;
  floor.furniture.push(barrier);
  g.time += 0.3;
  audio.director.update(g);
  assert.equal(chain[1].frequency.value, 120);
  assert.ok(chain[2].gain.value < initialGain / 10);
  assert.equal(
    ended,
    0,
    "a faint but audible sentence keeps playing through the same bounded source",
  );
  barrier.destroyed = true;
  g.time += 0.3;
  audio.director.update(g);
  assert.equal(chain[1].frequency.value, 4800);
  assert.ok(chain[2].gain.value > initialGain * 0.9);
  g.survivors[1].floor = 1;
  g.time += 0.3;
  audio.director.update(g);
  assert.equal(
    ended,
    1,
    "moving behind an inaudible floor closes the matching playback bubble",
  );
});

test("horde, footsteps, drag and the bounded oscillator fallback all retain real panner graphs", async () => {
  const audio = graph(),
    g = fixture();
  audio.director.start();
  await audio.director.ready;
  audio.director.update(g);
  g.zombies = [
    {
      id: "near-groan",
      x: 12.5,
      y: 15.5,
      floor: 0,
      hp: 60,
      path: [],
      repath: 0,
      cooldown: 0,
      memory: 0,
      stagger: 0,
      origin: "outside",
    },
  ];
  g.time += 0.3;
  g.survivors[0].x += 0.8;
  g.survivors[0].grip = {
    object: "synthetic-drag",
    local: { x: 0, y: 0 },
    length: 1,
  };
  g.floors[0].furniture.push({
    id: "synthetic-drag",
    kind: "table",
    x: 12.4,
    y: 15.5,
    floor: 0,
    w: 1,
    h: 1,
    hp: 100,
    maxHp: 100,
    destroyed: false,
    turning: 0,
  } as Furniture);
  audio.director.update(g);
  for (const source of audio.sources)
    assert.deepEqual(
      path(source).map((n) => n.kind),
      [
        "source",
        "filter",
        "gain",
        "panner",
        "gain",
        "compressor",
        "destination",
      ],
    );
  const groan = audio.sources.find((s) =>
    (s.buffer as unknown as { name?: string })?.name?.startsWith("groan"),
  )!;
  assert.equal(path(groan)[3].positionX.value, 12.5);
  const foot = audio.sources.find((s) =>
    (s.buffer as unknown as { name?: string })?.name?.startsWith("step"),
  )!;
  assert.ok(foot);
  assert.ok(Math.abs(path(foot)[3].positionY.value - 0.05) < 1e-8);
  assert.ok(
    audio.sources.some(
      (s) => (s.buffer as unknown as { name?: string })?.name === "drag",
    ),
  );
  const scrape = audio.sources.find(
    (s) => (s.buffer as unknown as { name?: string })?.name === "drag",
  )!;
  assert.ok(
    Math.abs(path(scrape)[3].positionX.value - 11.865) < 1e-8,
    "scrape originates at the real prop's nearest contact surface, not the player's feet",
  );
  assert.equal(path(scrape)[3].positionY.value, 0.08);
  assert.equal(path(scrape)[3].positionZ.value, 15.5);
  g.zombies[0].x += 0.8;
  g.time += 1 / 30;
  audio.director.update(g);
  assert.equal(
    path(groan)[3].positionX.value,
    g.zombies[0].x,
    "a playing groan stays attached to its moving zombie",
  );
  assert.equal(
    path(audio.sources[0])[3].positionX.value,
    g.zombies[0].x,
    "the bounded horde loop also follows its actual strongest source",
  );
  for (let i = 0; i < 30; i++) audio.director.cue(100, 1);
  assert.ok(
    audio.oscillators.filter((s) => s.starts > 0).length <= 20,
    "all sources share the same hard voice limit",
  );
  audio.director.stop();
  assert.ok(
    audio.oscillators
      .filter((s) => s.starts > 0)
      .every((s) => s.stops.includes(undefined)),
  );
});

test("speech loudness and range follow the delivery, matching what survivors can hear", () => {
  // Quieter at the same spot for a whisper, louder for an urgent warning.
  const gainAt = (delivery: "whisper" | "calm" | "urgent", dx: number) => {
    const audio = graph(),
      g = fixture(),
      actor = g.survivors[1];
    actor.escaped = false;
    Object.assign(actor, {
      x: g.survivors[0].x + dx,
      y: g.survivors[0].y,
      floor: 0,
    });
    audio.director.start();
    audio.director.update(g, { yaw: 0 });
    const started = audio.director.speak(g, {
      id: `${delivery}-${dx}`,
      actorId: actor.id,
      delivery,
      buffer: buffer(),
    });
    const gain = started ? path(audio.sources.at(-1)!)[2].gain.value : 0;
    audio.director.stop();
    return { started, gain };
  };
  const whisper = gainAt("whisper", 1),
    calm = gainAt("calm", 1),
    urgent = gainAt("urgent", 1);
  assert.ok(whisper.started && calm.started && urgent.started);
  assert.ok(whisper.gain < calm.gain / 3, "a whisper is far quieter");
  assert.ok(urgent.gain > calm.gain, "an urgent voice is louder");
  // Survivors hear a whisper within 4 m and calm speech within 10 m; the
  // player's audio stops at the same distances instead of at 18 m.
  assert.equal(gainAt("whisper", 5).started, false);
  assert.equal(gainAt("calm", 11).started, false);
  assert.equal(gainAt("urgent", 11).started, true);
  // Near the edge of its range a line fades rather than cutting off.
  assert.ok(gainAt("calm", 9).gain < gainAt("calm", 7).gain / 2);
});
