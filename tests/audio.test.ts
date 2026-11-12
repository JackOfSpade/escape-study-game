import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { AudioDirector } from "../src/audio";
import { step } from "../src/engine";
import { type Floor, type Furniture, type Roadmap, event } from "../src/model";
import {
  captureHordeAcoustics,
  hordeSound,
  soundEvents,
} from "../src/soundscape";
import { createGame } from "../src/world";
const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
function floor(): Floor {
  return {
    index: 0,
    tiles: Array.from({ length: 34 }, (_, y) =>
      Array.from({ length: 44 }, (_, x) =>
        x === 0 || y === 0 || x === 43 || y === 33 ? 1 : 0,
      ),
    ),
    stations: [],
    furniture: [],
    dark: 0,
    name: "Audio fixture",
    doors: [],
    stairs: { x: 40, y: 2 },
    entry: { x: 20, y: 30 },
  };
}
function barrier(id: string, x: number): Furniture {
  return {
    id,
    floor: 0,
    x,
    y: 15.5,
    w: 1,
    h: 1,
    kind: "fridge",
    hp: 100,
    maxHp: 100,
    speed: 1,
    rotation: 0,
    destroyed: false,
    movers: [],
    moved: 0,
    credited: [],
    turning: 0,
  };
}
function fixture() {
  const g = createGame(7, r);
  g.status = "playing";
  g.time = 100;
  g.nextSpawn = Number.MAX_SAFE_INTEGER;
  g.zombies = [];
  g.floors[0] = floor();
  Object.assign(g.survivors[0], { x: 10.5, y: 15.5, floor: 0 });
  for (const a of g.survivors.slice(1)) a.escaped = true;
  return g;
}
class Param {
  value = 0;
  calls: { kind: string; value: number; time: number }[] = [];
  setValueAtTime(value: number, time: number) {
    this.calls.push({ kind: "set", value, time });
  }
  setTargetAtTime(value: number, time: number, _constant: number) {
    this.calls.push({ kind: "target", value, time });
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.calls.push({ kind: "linear", value, time });
  }
  exponentialRampToValueAtTime(value: number, time: number) {
    this.calls.push({ kind: "exponential", value, time });
  }
}
class Node {
  gain = new Param();
  frequency = new Param();
  type = "";
  disconnects = 0;
  stops: (number | undefined)[] = [];
  onended?: () => void;
  connect(_node: unknown) {}
  disconnect() {
    this.disconnects++;
  }
  start() {}
  stop(at?: number) {
    this.stops.push(at);
  }
}
function context() {
  const oscillators: Node[] = [];
  const ctx = {
    currentTime: 0,
    sampleRate: 1000,
    destination: {},
    resume: async () => {},
    createGain: () => new Node(),
    createDynamicsCompressor: () => ({
      ...new Node(),
      threshold: new Param(),
      knee: new Param(),
      ratio: new Param(),
      attack: new Param(),
      release: new Param(),
      connect() {},
    }),
    createBiquadFilter: () => new Node(),
    createBufferSource: () => new Node(),
    createBuffer: (_channels: number, frames: number, _rate: number) => ({
      getChannelData: () => new Float32Array(frames),
    }),
    createOscillator: () => {
      const n = new Node();
      oscillators.push(n);
      return n;
    },
  };
  return { ctx: ctx as unknown as AudioContext, oscillators };
}
test("audio timing resets on a new run/restored object and cancels old impact voices without wall timers", () => {
  const { ctx, oscillators } = context(),
    d = new AudioDirector(() => ctx),
    g = fixture();
  assert.equal(d.start(), true);
  g.seq = 4000;
  g.time = 202;
  g.surge.state = "warning";
  g.surge.started = 200;
  d.update(g);
  assert.equal(oscillators.length, 0);
  event(g, "barricade-hit", "impact", 0).position = { x: 11, y: 15.5 };
  d.update(g);
  assert.equal(oscillators.length, 1);
  assert.ok(oscillators.every((n) => n.stops[0]! <= 0.7));
  const old = [...oscillators];
  const next = fixture();
  next.time = 0;
  next.seq = 1;
  d.update(next);
  assert.ok(old.every((n) => n.stops.includes(undefined) && n.disconnects > 0));
  assert.equal(d.cursor, 1);
  assert.equal(d.next, 0.25);
  next.time = 0.3;
  event(next, "barricade-hit", "impact", 0).position = { x: 11, y: 15.5 };
  d.update(next);
  assert.equal(oscillators.length, 2);
  const resumed = structuredClone(next);
  d.update(resumed);
  assert.equal(oscillators.length, 2); // No historical attack replay after load.
  d.stop();
  assert.equal(d.caption, "");
  assert.ok(oscillators.at(-1)?.stops.includes(undefined));
});
test("surge warnings and activation remain silent while captions track the phase", () => {
  const { ctx, oscillators } = context(),
    d = new AudioDirector(() => ctx),
    g = fixture();
  d.start();
  g.surge.state = "warning";
  g.surge.started = 92;
  d.update(g);
  assert.equal(oscillators.length, 0);
  assert.match(d.caption, /escalating biological pulse/);
  d.update(g);
  assert.equal(oscillators.length, 0);
  g.time += 0.3;
  d.update(g);
  assert.equal(oscillators.length, 0);
  // Missed warning intervals do not replay tones when the tab resumes.
  g.time += 10;
  d.update(g);
  assert.equal(oscillators.length, 0);
  g.surge.state = "active";
  g.time += 0.3;
  d.update(g);
  assert.equal(oscillators.length, 0);
  assert.match(d.caption, /Surge/);
});
test("ambient and actual impact/breach sound follow distance, floors and successive physical barriers", () => {
  const g = fixture(),
    f = g.floors[0];
  for (let y = 1; y < 33; y++) {
    f.tiles[y][15] = 1;
    f.tiles[y][20] = 1;
  }
  f.tiles[15][15] = f.tiles[15][20] = 0;
  const first = barrier("first", 15.5),
    second = barrier("second", 20.5);
  f.furniture = [first, second];
  g.zombies = Array.from({ length: 12 }, (_, i) => ({
    id: `z${i}`,
    x: 25.5,
    y: 15.5,
    floor: 0,
    hp: 100,
    path: [],
    repath: 0,
    cooldown: 0,
    memory: 0,
    stagger: 0,
    origin: "outside",
  }));
  const closed = hordeSound(g);
  assert.equal(closed.cutoff, 120);
  assert.match(closed.caption, /Muffled/);
  const seq = g.seq;
  event(g, "barricade-hit", "hit", 0).position = { x: 25.5, y: 15.5 };
  const quiet = soundEvents(g, seq).reduce((v, c) => v + c.gain, 0);
  first.destroyed = true;
  assert.equal(hordeSound(g).cutoff, 120);
  second.destroyed = true;
  const open = hordeSound(g);
  assert.ok(open.gain > closed.gain * 10);
  assert.equal(open.cutoff, 4800);
  const loud = soundEvents(g, seq).reduce((v, c) => v + c.gain, 0);
  assert.ok(loud > quiet * 10);
  const before = g.seq;
  event(g, "breach", "debris", 0).position = { x: 20.5, y: 15.5 };
  assert.match(soundEvents(g, before)[0].caption, /crashing debris/);
  g.survivors[0].floor = 1;
  // Another floor is faint through the slab, not silent, and far quieter
  // than the same horde heard through an open barricade on its own floor.
  const upstairs = hordeSound(g).gain;
  assert.ok(upstairs > 0, "a horde one floor below is still faintly audible");
  assert.ok(upstairs < open.gain / 100);
  assert.equal(soundEvents(g, seq).length, 0);
  g.survivors[0].floor = 0;
  g.time += 1;
  assert.equal(soundEvents(g, seq).length, 0);
});
test("ambient selection favors nearby audible sources and captions expose no hidden counts/positions", () => {
  const g = fixture();
  g.zombies = Array.from({ length: 30 }, (_, i) => ({
    id: `hidden-${i}`,
    x: i === 29 ? 11 : 25,
    y: 15.5,
    floor: 0,
    hp: 100,
    path: [],
    repath: 0,
    cooldown: 0,
    memory: 0,
    stagger: 0,
    origin: "outside",
  }));
  const before = hordeSound(g);
  g.zombies.reverse();
  assert.deepEqual(hordeSound(g), before);
  assert.ok(before.gain > 0.1);
  assert.doesNotMatch(before.caption, /hidden|\d|north|east|west|south/i);
});
test("cached horde propagation remixes live listener and source distances without advancing time", () => {
  const g = fixture(),
    a = g.survivors[0];
  g.zombies = [
    {
      id: "moving-voice",
      x: 13.5,
      y: 15.5,
      floor: 0,
      hp: 100,
      path: [],
      repath: 0,
      cooldown: 0,
      memory: 0,
      stagger: 0,
      origin: "outside",
    },
  ];
  const zombie = g.zombies[0],
    cache = captureHordeAcoustics(g),
    before = hordeSound(g, cache);
  a.x = 7.5;
  const far = hordeSound(g, cache);
  assert.ok(
    far.gain < before.gain,
    "walking away reduces an existing emitter immediately",
  );
  a.x = 12.5;
  assert.ok(
    hordeSound(g, cache).gain > before.gain,
    "walking closer increases it immediately",
  );
  zombie.x = 20.5;
  assert.ok(
    hordeSound(g, cache).gain < far.gain,
    "a moving emitter also changes its live distance",
  );
  assert.equal(hordeSound(g, cache).origin?.x, zombie.x);
  // The shared mixer's range is 24 m; 25 m away is out of hearing.
  a.x = 1.5;
  zombie.x = 26.5;
  assert.equal(
    hordeSound(g, cache).gain,
    0,
    "a cached actor outside hearing range is silent",
  );
  a.x = 10.5;
  zombie.hp = 0;
  assert.equal(
    hordeSound(g, cache).gain,
    0,
    "a dead emitter disappears before the next propagation refresh",
  );
  zombie.hp = 100;
  a.floor = 1;
  assert.equal(
    hordeSound(g, cache).gain,
    0,
    "a previous floor's cache is not reused on another floor",
  );
  assert.equal(g.time, 100);
});
test("horde propagation caches at most twelve deterministically selected source references", () => {
  const g = fixture();
  g.zombies = Array.from({ length: 40 }, (_, i) => ({
    id: `cached-${i.toString().padStart(2, "0")}`,
    x: i === 39 ? 11 : 20,
    y: 15.5,
    floor: 0,
    hp: 100,
    path: [],
    repath: 0,
    cooldown: 0,
    memory: 0,
    stagger: 0,
    origin: "outside" as const,
  }));
  const originalOrder = g.zombies.map((z) => z.id),
    first = captureHordeAcoustics(g);
  assert.equal(first.sources.length, 12);
  assert.equal(first.sources[0].actor.id, "cached-39");
  assert.ok(first.sources.every((s) => g.zombies.includes(s.actor)));
  assert.deepEqual(
    g.zombies.map((z) => z.id),
    originalOrder,
    "capturing audio never sorts the world array",
  );
  g.zombies.reverse();
  assert.deepEqual(
    captureHordeAcoustics(g).sources.map((s) => s.actor.id),
    first.sources.map((s) => s.actor.id),
  );
});
test("removed or replaced living zombies cannot remain audible through a cached horde emitter", () => {
  const g = fixture();
  g.zombies = [
    {
      id: "replaced-emitter",
      x: 13.5,
      y: 15.5,
      floor: 0,
      hp: 100,
      path: [],
      repath: 0,
      cooldown: 0,
      memory: 0,
      stagger: 0,
      origin: "outside",
    },
  ];
  const original = g.zombies[0],
    cache = captureHordeAcoustics(g);
  assert.ok(hordeSound(g, cache).gain > 0);
  g.zombies = [];
  assert.equal(original.hp, 100, "removal did not kill the detached object");
  assert.equal(hordeSound(g, cache).gain, 0);
  assert.equal(hordeSound(g, cache).origin, undefined);
  g.zombies = [{ ...original, x: 17.5 }];
  assert.equal(g.zombies[0].id, original.id);
  assert.equal(
    hordeSound(g, cache).gain,
    0,
    "reusing an ID cannot revive the detached emitter's cached position",
  );
  const refreshed = hordeSound(g);
  assert.ok(refreshed.gain > 0);
  assert.equal(refreshed.origin?.x, 17.5);
  assert.equal(g.time, 100);
});
test("the already-playing horde loop attenuates every update as the player approaches or leaves", () => {
  const { ctx } = context(),
    d = new AudioDirector(
      () => ctx,
      async () => new Map(),
    ),
    g = fixture(),
    a = g.survivors[0];
  g.zombies = [
    {
      id: "continuous-horde",
      x: 13.5,
      y: 15.5,
      floor: 0,
      hp: 100,
      path: [],
      repath: 0,
      cooldown: 0,
      memory: 0,
      stagger: 0,
      origin: "outside",
    },
  ];
  d.start();
  d.update(g, { yaw: 0 });
  const gain = d.horde!.gain as unknown as Param,
    initial = gain.calls.at(-1)!.value;
  assert.ok(initial > 0);
  a.x = 7.5;
  d.update(g, { yaw: Math.PI });
  const far = gain.calls.at(-1)!.value;
  assert.ok(
    far < initial,
    "gain follows movement between acoustic refresh ticks",
  );
  a.x = 12.5;
  d.update(g, { yaw: 0 });
  assert.ok(gain.calls.at(-1)!.value > initial);
  const living = g.zombies[0];
  g.zombies = [];
  d.update(g, { yaw: 0 });
  assert.equal(
    gain.calls.at(-1)!.value,
    0,
    "detached living emitters stop immediately",
  );
  g.zombies = [living];
  g.zombies[0].hp = 0;
  d.update(g, { yaw: 0 });
  assert.equal(gain.calls.at(-1)!.value, 0);
  assert.equal(
    g.time,
    100,
    "no simulation tick or new loop playback was needed",
  );
  d.stop();
});
test("audio failure and mute retain simulation-driven captions without fabricating default banners", () => {
  const g = fixture(),
    d = new AudioDirector(() => {
      throw Error("No audio device");
    });
  assert.equal(d.start(), false);
  assert.match(d.error, /unavailable/);
  g.surge.state = "warning";
  g.surge.started = g.time;
  d.update(g);
  assert.match(d.caption, /biological pulse/);
  const fake = context(),
    muted = new AudioDirector(() => fake.ctx);
  muted.start();
  g.settings.volume = 0;
  muted.update(g);
  assert.equal((muted.master!.gain as unknown as Param).calls.at(-1)?.value, 0);
  assert.match(muted.caption, /biological pulse/);
  g.time += 0.3;
  g.surge.state = "active";
  muted.update(g);
  assert.match(muted.caption, /Surge/);
});
test("physical zombie damage emits positioned impact events exactly when an attack lands", () => {
  const g = fixture(),
    a = g.survivors[0];
  g.zombies = [
    {
      id: "attacker",
      x: a.x + 0.4,
      y: a.y,
      floor: 0,
      hp: 100,
      path: [],
      repath: 0,
      cooldown: 0,
      memory: 0,
      stagger: 0,
      origin: "outside",
    },
  ];
  const hp = a.hp;
  step(g, 1 / 30, { x: 0, y: 0, grab: false });
  assert.equal(a.hp, hp - 14);
  const hit = g.events.filter((e) => e.type === "survivor-hit");
  assert.equal(hit.length, 1);
  assert.equal(hit[0].actor, "attacker");
  assert.ok(hit[0].position);
  step(g, 1 / 30, { x: 0, y: 0, grab: false });
  assert.equal(g.events.filter((e) => e.type === "survivor-hit").length, 1);
});

test("barricade impact and positioned breach are emitted by actual furniture damage", () => {
  const g = fixture(),
    f = g.floors[0];
  for (let y = 1; y < 33; y++) f.tiles[y][15] = 1;
  f.tiles[15][15] = 0;
  const ob = barrier("breakable", 15.5);
  ob.hp = 4;
  f.furniture = [ob];
  Object.assign(g.survivors[0], { x: 17.5, y: 15.5 });
  g.zombies = [
    {
      id: "breaker",
      x: 14.7,
      y: 15.5,
      floor: 0,
      hp: 100,
      path: [
        { x: 15.5, y: 15.5 },
        { x: 16.5, y: 15.5 },
      ],
      target: { x: 17.5, y: 15.5 },
      repath: 10,
      cooldown: 0,
      memory: g.time + 20,
      stagger: 0,
      origin: "outside",
    },
  ];
  step(g, 1 / 30, { x: 0, y: 0, grab: false });
  assert.equal(ob.destroyed, true);
  const hits = g.events.filter((e) => e.type === "barricade-hit"),
    breaches = g.events.filter((e) => e.type === "breach");
  assert.equal(hits.length, 1);
  assert.equal(breaches.length, 1);
  assert.deepEqual(hits[0].position, breaches[0].position);
  assert.equal(hits[0].actor, "breaker");
  assert.ok(
    soundEvents(g, hits[0].seq - 1).some((c) =>
      c.caption.includes("crashing debris"),
    ),
  );
});

test("G02 actual NPC death during calm resets eligibility without causing an immediate warning", () => {
  const g = fixture(),
    victim = g.survivors[1];
  Object.assign(victim, {
    escaped: false,
    alive: true,
    hp: 1,
    floor: 0,
    x: 10.5,
    y: 15.5,
    path: [],
  });
  Object.assign(g.survivors[0], { x: 30.5, y: 25.5 });
  g.surge.anchor = 90.1;
  g.surge.quietDelay = 10;
  g.surge.lastEnd = 90;
  g.zombies = [
    {
      id: "lethal",
      x: 10.9,
      y: 15.5,
      floor: 0,
      hp: 100,
      path: [],
      repath: 0,
      cooldown: 0,
      memory: 0,
      stagger: 0,
      origin: "outside",
    },
  ];
  step(g, 1 / 30, { x: 0, y: 0, grab: false });
  assert.equal(victim.alive, false);
  assert.equal(g.status, "playing");
  assert.equal(g.surge.lastDeath, g.time);
  assert.equal(g.surge.anchor, g.time);
  assert.equal(g.surge.state, "calm");
  assert.ok(g.surge.quietDelay > 10);
  const anchor = g.surge.anchor,
    delay = g.surge.quietDelay;
  step(g, 1 / 30, { x: 0, y: 0, grab: false });
  assert.equal(g.surge.state, "calm");
  assert.equal(g.surge.anchor, anchor);
  assert.equal(g.surge.quietDelay, delay);
});

test("downloaded voices get per-event muffling, bounded playback and immediate pause cancellation", async () => {
  const { ctx, oscillators } = context(),
    sources: Node[] = [],
    filters: Node[] = [];
  const c = ctx as unknown as {
    createBufferSource: () => Node;
    createBiquadFilter: () => Node;
  };
  c.createBufferSource = () => {
    const n = Object.assign(new Node(), { playbackRate: { value: 1 } });
    sources.push(n);
    return n;
  };
  c.createBiquadFilter = () => {
    const n = new Node();
    filters.push(n);
    return n;
  };
  const { SFX } = await import("../src/sfx");
  const bank = new Map(
    Object.values(SFX)
      .flat()
      .map((name) => [name, {} as AudioBuffer]),
  );
  const d = new AudioDirector(
      () => ctx,
      async () => bank,
    ),
    g = fixture();
  d.start();
  await d.ready;
  d.update(g);
  g.time += 0.3;
  event(g, "breach", "crash", 0).position = { x: 11, y: 15.5 };
  d.update(g);
  assert.ok(
    sources.length > 1,
    "a decoded source is used rather than only an oscillator",
  );
  assert.equal(oscillators.length, 0);
  assert.equal(filters.at(-1)?.frequency.value, 4800);
  d.stop();
  assert.ok(sources.at(-1)?.stops.includes(undefined));
  assert.ok(filters.at(-1)!.disconnects > 0);
});

test("impact audio is dispatched within a simulation tick instead of waiting for the ambient mix", () => {
  const { ctx, oscillators } = context(),
    d = new AudioDirector(() => ctx),
    g = fixture();
  d.start();
  d.update(g);
  const count = oscillators.length;
  g.time += 1 / 30;
  event(g, "survivor-hit", "attack", 0).position = { x: 11, y: 15.5 };
  d.update(g);
  assert.equal(oscillators.length, count + 1);
  assert.match(d.caption, /Nearby attack/);
  d.update(g);
  assert.equal(oscillators.length, count + 1, "same event must not replay");
});
test("the player's own terminal unlocking plays a latch cue; an NPC completion elsewhere stays silent", () => {
  const g = fixture();
  const [mine, theirs] = Object.values(g.encounters).filter(
    (e) => e.floor === 0,
  );
  const accepted = (author: string, id: string) => ({
    id,
    revision: 0,
    author,
    content: "",
    status: "complete" as const,
    feedback: "",
    seq: 1,
  });
  mine.submissions.push(accepted("human", "mine"));
  mine.accepted = "mine";
  let before = g.seq;
  event(
    g,
    "completion",
    "Solo stair credential unlocked.",
    0,
    undefined,
    mine.id,
  );
  const cue = soundEvents(g, before);
  assert.equal(cue.length, 1);
  assert.equal(cue[0].sample, "latch");
  assert.match(cue[0].caption, /key granted/);
  assert.ok(cue[0].gain > 0);
  theirs.submissions.push(accepted("npc-1", "theirs"));
  theirs.accepted = "theirs";
  before = g.seq;
  event(g, "completion", "Solo cache unlocked.", 0, undefined, theirs.id);
  assert.equal(soundEvents(g, before).length, 0);
  // The same completion on another floor is out of earshot.
  before = g.seq;
  event(
    g,
    "completion",
    "Solo stair credential unlocked.",
    1,
    undefined,
    mine.id,
  );
  assert.equal(soundEvents(g, before).length, 0);
});
