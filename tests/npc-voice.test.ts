import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { DialogueReviewRequest } from "../scripts/lib/npc-dialogue-policy.mjs";
import type { SpeechPlayback } from "../src/audio";
import { checkBridge } from "../src/bridge-client";
import type { Game, Roadmap, Zombie } from "../src/model";
import {
  npcSpeechFactId,
  type NpcChatterReply,
  type NpcChatterRequest,
} from "../src/npc-chatter";
import {
  NpcVoiceDirector,
  NPC_VOICE_GROUPS,
  NPC_VOICE_LIMITS,
  NPC_VOICE_SLOTS,
  npcVoiceFor,
  npcVoiceTransport,
  type NpcVoiceTransport,
} from "../src/npc-voice";
import { npcSpeechBubble } from "../src/speech-bubbles";
import { actor, createGame } from "../src/world";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
const token = "/api/speech/" + "a".repeat(48);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++)
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  assert.ok(check(), "the expected asynchronous voice stage was reached");
}
function draft(
  payload: NpcChatterRequest,
  text: string,
  evidence = [payload.dialogue!.facts[0].id],
) {
  return {
    requestId: payload.requestId,
    actorId: payload.actorId,
    decision: "speak",
    text,
    delivery: "calm",
    purpose: "React to the current survivor situation.",
    evidence,
  };
}
function review(
  packet: DialogueReviewRequest<NpcChatterRequest>,
  verdict: "accept" | "revise" | "silence" = "accept",
) {
  return {
    requestId: packet.requestId,
    actorId: packet.actorId,
    candidateFingerprint: packet.candidateFingerprint,
    verdict,
    issues: verdict === "accept" ? [] : ["off-topic"],
    note:
      verdict === "accept"
        ? "Fits this captured moment."
        : "Use the immediate survivor situation.",
  };
}
function game() {
  const g = createGame(42, roadmap),
    f = g.floors[0],
    npc = Object.assign(actor("voice-npc", "Maya", 1), {
      x: 12.5,
      y: 10.5,
      activity: "exploring" as const,
    });
  g.status = "playing";
  g.time = 0;
  g.survivors = [g.survivors[0], npc];
  Object.assign(g.survivors[0], { x: 10.5, y: 10.5 });
  g.zombies = [];
  g.events = [];
  g.settings.npcVoices = true;
  g.settings.volume = 0.5;
  f.tiles = Array.from({ length: 34 }, () => Array(44).fill(0));
  f.furniture = [];
  f.stations = [];
  return g;
}
function buffer(duration = 2): AudioBuffer {
  const samples = new Float32Array(duration * 8000);
  return {
    duration,
    sampleRate: 8000,
    length: duration * 8000,
    numberOfChannels: 1,
    getChannelData: () => samples,
    copyFromChannel(destination, _channel, start = 0) {
      destination.set(samples.subarray(start, start + destination.length));
    },
    copyToChannel(source, _channel, start = 0) {
      samples.set(source, start);
    },
  };
}
function ticket(reply: NpcChatterReply) {
  return {
    ...reply,
    audio: { url: token, mime: "audio/wav", bytes: 128, duration: 2 },
  };
}
function fixture(random: () => number = () => 0) {
  const g = game(),
    requests: {
      payload: NpcChatterRequest;
      signal: AbortSignal;
      active: () => boolean;
      result: ReturnType<typeof deferred<unknown>>;
    }[] = [],
    calls = {
      available: 0,
      reviews: [] as {
        packet: DialogueReviewRequest<NpcChatterRequest>;
        signal: AbortSignal;
        active: () => boolean;
      }[],
      synthesize: 0,
      download: 0,
      decode: 0,
      play: [] as SpeechPlayback[],
      stop: [] as (string | undefined)[],
      discard: [] as string[],
    };
  let playing: SpeechPlayback | undefined,
    allowStart = true;
  const audio = {
    canSpeak: (_g: Game) => !playing,
    async decodeSpeech(_bytes: ArrayBuffer): Promise<AudioBuffer | undefined> {
      calls.decode++;
      return buffer();
    },
    speak(_g: Game, speech: SpeechPlayback) {
      if (!allowStart) return false;
      calls.play.push(speech);
      playing = speech;
      return true;
    },
    stopSpeech(id?: string) {
      calls.stop.push(id);
      if (playing && (!id || id === playing.id)) {
        const old = playing;
        playing = undefined;
        old.onEnded?.(false);
      }
    },
  };
  const transport: NpcVoiceTransport = {
    async available() {
      calls.available++;
      return true;
    },
    generate(payload, signal, active) {
      const result = deferred<unknown>();
      requests.push({ payload, signal, active, result });
      return result.promise;
    },
    async review(packet, signal, active) {
      calls.reviews.push({ packet, signal, active });
      return review(packet);
    },
    async synthesize(reply) {
      calls.synthesize++;
      return ticket(reply);
    },
    async download() {
      calls.download++;
      return new ArrayBuffer(128);
    },
    async discard(url) {
      calls.discard.push(url);
    },
  };
  const director = new NpcVoiceDirector(audio, transport, () => true, random);
  const end = (completed = true) => {
    const old = playing;
    playing = undefined;
    old?.onEnded?.(completed);
  };
  return {
    g,
    audio,
    transport,
    director,
    requests,
    calls,
    end,
    refuseStart: () => {
      allowStart = false;
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
async function dispatch(f: Fixture) {
  f.director.update(f.g);
  await flush();
  f.g.time = Math.max(f.g.time, 6);
  f.director.update(f.g);
  assert.ok(f.requests.length > 0);
  return f.requests.at(-1)!;
}
async function answer(
  f: Fixture,
  text = "Keep that doorway clear.",
  evidence?: string[],
) {
  const request = f.requests.at(-1)!,
    before = f.calls.reviews.length;
  request.result.resolve(draft(request.payload, text, evidence));
  await until(() => request.signal.aborted || f.calls.reviews.length > before);
  await flush();
  await flush();
}

function holdReview(f: Fixture) {
  const result = deferred<unknown>();
  f.transport.review = (packet, signal, active) => {
    f.calls.reviews.push({ packet, signal, active });
    return result.promise;
  };
  return result;
}
function noSpeech(f: Fixture) {
  assert.equal(f.calls.synthesize, 0);
  assert.equal(f.calls.download, 0);
  assert.equal(f.calls.decode, 0);
  assert.equal(f.calls.play.length, 0);
  assert.equal(npcSpeechBubble(f.g, f.g.survivors[1].id), undefined);
}

function conversants(f: Fixture, count = 1) {
  for (let i = 0; i < count; i++)
    f.g.survivors.push(
      Object.assign(actor(`listener-${i}`, i ? "Alex" : "Theo", i + 2), {
        x: 14.5 + i,
        y: 10.5,
        activity: "exploring" as const,
      }),
    );
}
function conversationDraft(
  payload: NpcChatterRequest,
  text: string,
  intent: "invite" | "continue" | "close",
) {
  const source = payload.conversation
    ? payload.recentLines.find(
        (line) => line.id === payload.conversation!.replyTo,
      )
    : undefined;
  if (payload.conversation)
    assert.ok(source, "reply cites actual heard speech");
  return {
    ...draft(payload, text, source ? [npcSpeechFactId(source)] : undefined),
    purpose: source
      ? "Respond naturally to the nearby survivor's actual words."
      : "Invite nearby survivors into a brief, relevant exchange.",
    conversation: {
      intent,
      ...(source ? { replyTo: source.id } : {}),
    },
  };
}
async function sayConversation(
  f: Fixture,
  text: string,
  intent: "invite" | "continue" | "close",
) {
  const request = f.requests.at(-1)!,
    before = f.calls.play.length;
  request.result.resolve(conversationDraft(request.payload, text, intent));
  await until(() => f.calls.play.length === before + 1);
  return request;
}
async function at(f: Fixture, time: number) {
  f.g.time = time;
  f.director.update(f.g);
  await flush();
}

test("a question naming the player is overheard by an NPC, not addressed to them", async () => {
  const f = fixture();
  conversants(f);
  f.g.survivors[0].name = "Jack Park";
  try {
    const opening = await dispatch(f);
    opening.result.resolve(
      draft(opening.payload, "Jack, is the stairwell clear?"),
    );
    await until(() => f.calls.play.length === 1);
    f.g.time = 8;
    f.end();
    await at(f, 11);
    assert.equal(f.requests.length, 2);
    const reply = f.requests[1].payload;
    assert.equal(reply.actorId, "listener-0");
    assert.deepEqual(reply.conversation?.heard, {
      addressed: "other",
      act: "question",
      distance: 2,
    });
  } finally {
    f.director.dispose();
  }
});

test("a spontaneous line that becomes irrelevant keeps its quiet interval measured from playback start", async () => {
  const f = fixture();
  conversants(f);
  try {
    const opening = await dispatch(f);
    assert.equal(opening.payload.conversation, undefined);
    opening.result.resolve(
      draft(opening.payload, "That corridor is finally quiet."),
    );
    await until(() => f.calls.play.length === 1);
    const startedAt = f.g.time;
    f.g.time = startedAt + 2;
    // Change relevance only at playback completion, without interrupting it.
    f.g.survivors[1].activity = "fleeing";
    f.end();
    f.g.survivors[1].activity = "exploring";
    // Keep checks at least one half-second apart so both are sampled.
    await at(f, startedAt + NPC_VOICE_LIMITS.globalSeconds - 0.5);
    assert.equal(f.requests.length, 1);
    await at(f, startedAt + NPC_VOICE_LIMITS.globalSeconds + 0.1);
    assert.equal(
      f.requests.length,
      2,
      "ending a spontaneous remark cannot add a conversation pause from playback end",
    );
    assert.equal(f.requests[1].payload.actorId, "listener-0");
    assert.equal(f.requests[1].payload.conversation, undefined);
  } finally {
    f.director.dispose();
  }
});

test("a named question uses the weighted listener order and describes direct or overheard hearing", async () => {
  for (const choice of [
    { draw: 0, id: "listener-1", addressed: "self", distance: 3 },
    { draw: 0.7, id: "listener-0", addressed: "other", distance: 2 },
  ]) {
    let draw = 0;
    const f = fixture(() => draw);
    conversants(f, 2);
    for (const a of f.g.survivors.slice(2)) a.social = 0.5;
    try {
      const opening = await dispatch(f);
      opening.result.resolve(
        draft(opening.payload, "Alex, is that corridor clear?"),
      );
      await until(() => f.calls.play.length === 1);
      draw = choice.draw;
      f.g.time = 8;
      f.end();
      draw = 0;
      await at(f, 11);
      assert.equal(f.requests.length, 2);
      const reply = f.requests[1];
      assert.equal(reply.payload.actorId, choice.id);
      assert.deepEqual(reply.payload.conversation?.heard, {
        addressed: choice.addressed,
        act: "question",
        distance: choice.distance,
      });
      assert.equal(
        reply.payload.recentLines.find(
          (line) => line.id === opening.payload.requestId,
        )?.delivery,
        "calm",
      );
      await sayConversation(f, "I'll keep an eye on it.", "close");
      assert.deepEqual(
        f.calls.reviews[1].packet.context.conversation?.heard,
        reply.payload.conversation?.heard,
      );
      assert.equal(
        f.calls.play.length,
        2,
        "hearing metadata survives generation and critic validation",
      );
    } finally {
      f.director.dispose();
    }
  }
});

test("completed speech uses delivery-specific hearing for receipts and reply selection", async () => {
  for (const choice of [
    { delivery: "whisper", x: 20.5, replies: false },
    { delivery: "calm", x: 20.5, replies: true },
    { delivery: "urgent", x: 0.5, replies: true },
  ] as const) {
    const f = fixture();
    conversants(f);
    f.g.survivors[2].x = choice.x;
    try {
      const opening = await dispatch(f);
      opening.result.resolve({
        ...draft(opening.payload, "That corridor is finally quiet."),
        delivery: choice.delivery,
      });
      await until(() => f.calls.play.length === 1);
      f.g.time = 8;
      f.end();
      await at(f, 11);
      assert.equal(f.requests.length, choice.replies ? 2 : 1, choice.delivery);
      if (choice.replies) {
        assert.equal(f.requests[1].payload.actorId, "listener-0");
        assert.deepEqual(f.requests[1].payload.conversation?.heard, {
          addressed: "none",
          act: choice.delivery === "urgent" ? "warning" : "statement",
          distance: Math.abs(choice.x - 12.5),
        });
      } else {
        await at(f, 60);
        assert.equal(f.requests.length, 2);
        assert.equal(f.requests[1].payload.conversation, undefined);
      }
      assert.equal(
        f.requests[1].payload.recentLines.find(
          (line) => line.id === opening.payload.requestId,
        )?.delivery,
        choice.delivery,
      );
    } finally {
      f.director.dispose();
    }
  }
});

test("conversation context validates optional heard metadata before building a reply", async () => {
  const { buildNpcChatterContext } = await import("../src/npc-chatter");
  const f = fixture();
  conversants(f);
  try {
    await dispatch(f);
    await sayConversation(f, "Anyone need a moment?", "invite");
    f.g.time = 8;
    f.end();
    await at(f, 11);
    assert.equal(f.requests.length, 2);
    const request = f.requests[1].payload;
    const listener = f.g.survivors.find((a) => a.id === request.actorId)!;
    const lines = request.recentLines.map((line) => ({
      ...line,
      heardBy: [listener.id],
    }));
    const build = (heard: unknown) =>
      buildNpcChatterContext(f.g, listener, "validated-hearing", lines, {
        ...request.conversation!,
        heard,
      } as NpcChatterRequest["conversation"]);
    assert.equal(build(undefined).conversation?.heard, undefined);
    for (const addressed of ["self", "other", "none"] as const)
      for (const act of [
        "question",
        "request",
        "warning",
        "statement",
      ] as const)
        for (const distance of [0, 2.3, 20]) {
          const heard = { addressed, act, distance };
          assert.deepEqual(build(heard).conversation?.heard, heard);
        }
    const valid = { addressed: "none", act: "statement", distance: 2 };
    for (const heard of [
      null,
      [],
      "nearby",
      {},
      { ...valid, addressed: "everyone" },
      { ...valid, act: "invitation" },
      { ...valid, distance: "2" },
      { ...valid, distance: -0.1 },
      { ...valid, distance: 20.1 },
      { ...valid, distance: NaN },
      { ...valid, distance: Infinity },
      { addressed: "none", act: "statement" },
      { act: "statement", distance: 2 },
      { addressed: "none", distance: 2 },
      { ...valid, extra: true },
    ])
      assert.throws(
        () => build(heard),
        /^Error: Conversation requires a current, actually heard source turn$/,
      );
  } finally {
    f.director.dispose();
  }
});

test("ordinary statements and questions can draw a reply without invitation metadata", async () => {
  for (const text of [
    "That corridor is finally quiet.",
    "Anyone got some water?",
  ]) {
    const f = fixture();
    conversants(f);
    try {
      const opening = await dispatch(f);
      opening.result.resolve(draft(opening.payload, text));
      await until(() => f.calls.play.length === 1);
      f.g.time = 8;
      f.end();
      await at(f, 11);
      assert.equal(
        f.requests.length,
        2,
        "a potential response follows the heard words, without requiring an invitation flag",
      );
      const reply = f.requests[1];
      assert.equal(reply.payload.actorId, "listener-0");
      assert.equal(reply.payload.self.id, "listener-0");
      assert.equal(reply.payload.location.floor, 0);
      assert.equal(
        reply.payload.conversation?.replyTo,
        opening.payload.requestId,
      );
      assert.ok(
        reply.payload.recentLines.some(
          (line) => line.id === opening.payload.requestId && line.text === text,
        ),
      );
      assert.ok(
        reply.payload.dialogue!.facts.some(
          (fact) => fact.id === `speech:${opening.payload.requestId}`,
        ),
      );
      assert.ok(
        reply.payload.dialogue!.facts.some(
          (fact) => fact.id === "environment.light",
        ),
      );
      assert.ok(
        reply.payload.dialogue!.facts.some(
          (fact) => fact.id === "self.inventory",
        ),
      );
      reply.result.resolve({
        requestId: reply.payload.requestId,
        actorId: reply.payload.actorId,
        decision: "silent",
        reason: "I have nothing useful to add.",
      });
      await flush();
      assert.equal(
        f.calls.play.length,
        1,
        "being selected still allows the AI listener to remain silent",
      );
    } finally {
      f.director.dispose();
    }
  }
});

test("a rejected random opportunity is sampled once and cannot reroll when listeners move", async () => {
  let draw = 0;
  const f = fixture(() => draw);
  conversants(f);
  try {
    const opening = await dispatch(f);
    opening.result.resolve(
      draft(opening.payload, "That corridor is finally quiet."),
    );
    await until(() => f.calls.play.length === 1);
    draw = 0.999;
    f.g.time = 8;
    f.end();
    draw = 0;
    await at(f, 11);
    await at(f, 14);
    conversants(f, 2);
    f.g.survivors.at(-1)!.id = "late-listener";
    await at(f, 17);
    assert.equal(
      f.requests.length,
      1,
      "later updates, lower random draws and newly arrived listeners cannot reroll the completed utterance",
    );
    assert.equal(f.calls.reviews.length, 1);
    assert.equal(
      f.calls.synthesize,
      1,
      "an ignored statement does not incur a response model or TTS job",
    );
  } finally {
    f.director.dispose();
  }
});

test("actual heard turns form A–B–A exchanges with a short gap and a four-turn limit", async () => {
  const f = fixture();
  conversants(f);
  try {
    const first = await dispatch(f);
    await sayConversation(f, "Anyone else need a minute?", "invite");
    await at(f, 7);
    assert.equal(
      f.requests.length,
      1,
      "a listener never talks over playing audio",
    );
    f.g.time = 8;
    f.end();
    await at(f, 9);
    assert.equal(
      f.requests.length,
      1,
      "allow a human pause after the completed line",
    );
    await at(f, 11);
    assert.equal(f.requests.length, 2);
    const second = f.requests[1];
    assert.equal(second.payload.actorId, "listener-0");
    assert.equal(second.payload.conversation?.replyTo, first.payload.requestId);
    assert.equal(second.payload.conversation?.sourceActorId, "voice-npc");
    assert.equal(second.payload.conversation?.turn, 2);
    assert.equal(second.payload.conversation?.maxTurns, 4);
    assert.ok(
      second.payload.recentLines.some(
        (line) => line.text === "Anyone else need a minute?",
      ),
    );
    assert.equal(
      f.calls.synthesize,
      1,
      "a response is not synthesised before its own review",
    );
    await sayConversation(f, "Yeah. I'll watch the corridor.", "continue");
    f.g.time = 13;
    f.end();
    await at(f, 16);
    assert.equal(f.requests.length, 3);
    const third = f.requests[2];
    assert.equal(
      third.payload.actorId,
      "voice-npc",
      "the first speaker can answer before their ambient cooldown",
    );
    assert.equal(
      third.payload.conversation?.id,
      second.payload.conversation?.id,
    );
    assert.equal(third.payload.conversation?.replyTo, second.payload.requestId);
    assert.equal(third.payload.conversation?.turn, 3);
    await sayConversation(f, "Thanks. Just catching my breath.", "continue");
    f.g.time = 18;
    f.end();
    await at(f, 21);
    assert.equal(f.requests.length, 4);
    assert.equal(f.requests[3].payload.actorId, "listener-0");
    assert.equal(f.requests[3].payload.conversation?.turn, 4);
    await sayConversation(f, "Take your time. I'm here.", "close");
    f.g.time = 23;
    f.end();
    await at(f, 26);
    assert.equal(
      f.requests.length,
      4,
      "the final closing turn cannot restart an endless conversation",
    );
    assert.equal(f.calls.reviews.length, 4);
    assert.equal(f.calls.play.length, 4);
    assert.equal(
      JSON.stringify(f.g).includes("Anyone else need a minute?"),
      false,
    );
  } finally {
    f.director.dispose();
  }
});

test("a listener may leave a request unanswered without a forced denial or self-answer", async () => {
  const f = fixture();
  conversants(f);
  const inventoryBefore = structuredClone(
    f.g.survivors.map((a) => a.inventory),
  );
  try {
    await dispatch(f);
    await sayConversation(f, "Anyone got some water?", "invite");
    f.g.time = 8;
    f.end();
    await at(f, 11);
    assert.equal(f.requests.length, 2);
    const listener = f.requests[1],
      before = f.calls.reviews.length;
    assert.equal(listener.payload.actorId, "listener-0");
    listener.result.resolve({
      requestId: listener.payload.requestId,
      actorId: listener.payload.actorId,
      decision: "silent",
      reason:
        "I have nothing useful to offer and need to keep watching the corridor.",
    });
    await flush();
    await at(f, 14);
    await at(f, 17);
    assert.equal(
      f.requests.length,
      2,
      "silence does not demand a replacement answer",
    );
    assert.equal(f.calls.reviews.length, before);
    assert.equal(f.calls.synthesize, 1);
    assert.equal(f.calls.play.length, 1);
    assert.equal(npcSpeechBubble(f.g, "listener-0"), undefined);
    assert.deepEqual(
      f.g.survivors.map((a) => a.inventory),
      inventoryBefore,
      "asking about water cannot manufacture or transfer supplies",
    );
  } finally {
    f.director.dispose();
  }
});

test("a completed late response gives the next speaker a fresh reply window", async () => {
  const f = fixture();
  conversants(f);
  try {
    await dispatch(f);
    await sayConversation(
      f,
      "Can you watch that corridor for a moment?",
      "invite",
    );
    f.g.time = 8;
    f.end();
    await at(f, 11);
    assert.equal(f.requests.length, 2);
    f.g.time = 35;
    await sayConversation(f, "Yeah. I'll keep watch.", "continue");
    f.g.time = 37;
    f.end();
    await at(f, 40);
    assert.equal(
      f.requests.length,
      3,
      "a completed answer renews the opportunity instead of inheriting the opening's expired window",
    );
    const next = f.requests[2];
    assert.equal(next.payload.actorId, "voice-npc");
    assert.equal(next.payload.conversation?.turn, 3);
    assert.equal(next.payload.conversation?.expiresAt, 67);
    assert.equal(next.active(), true);
    await sayConversation(f, "Thanks. I needed that.", "close");
    assert.equal(f.calls.play.length, 3);
  } finally {
    f.director.dispose();
  }
});

test("a reply that starts within its window can finish before the next turn begins", async () => {
  const f = fixture();
  conversants(f);
  try {
    await dispatch(f);
    await sayConversation(f, "Can you watch the corridor?", "invite");
    f.g.time = 8;
    f.end();
    await at(f, 11);
    f.g.time = 37;
    await sayConversation(f, "Yeah. I've got this side.", "continue");
    const response = f.calls.play[1];
    await at(f, 38.5);
    assert.equal(
      f.calls.stop.includes(response.id),
      false,
      "the generation deadline cannot truncate an already playing answer",
    );
    assert.equal(
      npcSpeechBubble(f.g, "listener-0")?.text,
      "Yeah. I've got this side.",
    );
    f.g.time = 39;
    f.end();
    await at(f, 42);
    assert.equal(f.requests.length, 3);
    assert.equal(f.requests[2].payload.conversation?.replyTo, response.id);
    assert.equal(f.requests[2].payload.conversation?.expiresAt, 69);
  } finally {
    f.director.dispose();
  }
});

test("a wall-clock delay expires an unanswered opportunity even while simulation time stays recent", async (t) => {
  const f = fixture();
  conversants(f);
  try {
    await dispatch(f);
    await sayConversation(f, "Anyone got some water?", "invite");
    f.g.time = 8;
    f.end();
    const staleWallTime = Date.now() + 31_000;
    t.mock.method(Date, "now", () => staleWallTime);
    await at(f, 11);
    assert.equal(
      f.requests.length,
      1,
      "an old real-time question cannot get a late response merely because few simulation ticks passed",
    );
    assert.equal(f.calls.play.length, 1);
  } finally {
    f.director.dispose();
  }
});

test("slow temporary-file cleanup cannot truncate an on-time reply or consume its next turn", async () => {
  const f = fixture();
  conversants(f);
  const cleanup = deferred<void>();
  try {
    await dispatch(f);
    await sayConversation(f, "Can you keep watch for a minute?", "invite");
    await until(() => f.calls.discard.length === 1);
    f.g.time = 8;
    f.end();
    await at(f, 11);
    f.transport.discard = async (url) => {
      f.calls.discard.push(url);
      await cleanup.promise;
    };
    f.g.time = 37;
    await sayConversation(f, "Yeah. I'll watch this side.", "continue");
    await until(() => f.calls.discard.length === 2);
    const response = f.calls.play[1];
    await at(f, 39);
    assert.equal(
      f.calls.stop.includes(response.id),
      false,
      "cleanup latency cannot keep an expired generation owner attached to playing audio",
    );
    f.end();
    await at(f, 40.5);
    assert.equal(
      f.requests.length,
      2,
      "the outstanding cleanup still owns the one background job slot",
    );
    cleanup.resolve();
    await flush();
    await at(f, 41);
    assert.equal(
      f.requests.length,
      3,
      "the completed reply's fresh turn remains available once cleanup finishes",
    );
    assert.equal(f.requests[2].payload.conversation?.replyTo, response.id);
    assert.equal(f.requests[2].payload.conversation?.expiresAt, 69);
  } finally {
    cleanup.resolve();
    f.director.dispose();
  }
});

test("leaving during an utterance cannot be repaired by returning before it ends", async () => {
  const f = fixture();
  conversants(f);
  try {
    await dispatch(f);
    await sayConversation(f, "Anyone need me to keep watch?", "invite");
    f.g.survivors[2].x = 32;
    await at(f, 7);
    f.g.survivors[2].x = 14.5;
    f.g.time = 8;
    f.end();
    await at(f, 11);
    await at(f, 14);
    assert.equal(
      f.requests.length,
      1,
      "reply eligibility requires hearing the complete utterance, not only its ending",
    );
    assert.equal(f.calls.play.length, 1);
  } finally {
    f.director.dispose();
  }
});

test("departure, a sealed source or new danger interrupt a playing reply without creating heard dialogue", async () => {
  for (const reason of ["departed", "sealed", "danger"] as const) {
    const f = fixture();
    conversants(f);
    try {
      await dispatch(f);
      await sayConversation(f, "Can you watch the corridor?", "invite");
      f.g.time = 8;
      f.end();
      await at(f, 11);
      await sayConversation(
        f,
        "I'll watch this side while you catch your breath.",
        "continue",
      );
      const replyId = f.calls.play[1].id;
      if (reason === "departed") f.g.survivors[1].x = 32;
      if (reason === "sealed")
        for (const row of f.g.floors[0].tiles) row[13] = 1;
      if (reason === "danger")
        f.g.zombies.push({
          id: "attacker-during-reply",
          x: 14.8,
          y: 10.5,
          floor: 0,
          hp: 60,
          path: [],
          repath: 0,
          cooldown: 0,
          memory: 0,
          stagger: 0,
          origin: "outside",
        });
      await at(f, 12);
      assert.ok(
        f.calls.stop.includes(replyId),
        `${reason}: actual playback is interrupted`,
      );
      assert.equal(npcSpeechBubble(f.g, "listener-0"), undefined, reason);
      f.g.survivors[1].x = 12.5;
      if (reason === "sealed")
        for (const row of f.g.floors[0].tiles) row[13] = 0;
      f.g.zombies = [];
      await at(f, 16);
      assert.equal(
        f.requests.length,
        2,
        `${reason}: a partial answer cannot open another turn`,
      );
      await at(f, 60);
      assert.equal(f.requests.length, 3, reason);
      assert.equal(f.requests[2].payload.conversation, undefined, reason);
      assert.equal(
        f.requests[2].payload.recentLines.some((line) => line.id === replyId),
        false,
        `${reason}: incomplete speech is never presented as heard conversation`,
      );
    } finally {
      f.director.dispose();
    }
  }
});

test("a conversation reply remains silent until its exact critic accepts it", async () => {
  const f = fixture();
  conversants(f);
  try {
    await dispatch(f);
    await sayConversation(f, "Can you keep an eye on that corridor?", "invite");
    f.g.time = 8;
    f.end();
    const held = holdReview(f);
    await at(f, 11);
    assert.equal(f.requests.length, 2);
    const listener = f.requests[1];
    listener.result.resolve(
      conversationDraft(listener.payload, "I've got it.", "close"),
    );
    await until(() => f.calls.reviews.length === 2);
    assert.equal(f.calls.synthesize, 1);
    assert.equal(f.calls.play.length, 1);
    assert.equal(npcSpeechBubble(f.g, "listener-0"), undefined);
    const packet = f.calls.reviews[1].packet;
    assert.equal(
      packet.candidate.conversation?.replyTo,
      listener.payload.conversation?.replyTo,
    );
    held.resolve(review(packet));
    await until(() => f.calls.play.length === 2);
    assert.equal(npcSpeechBubble(f.g, "listener-0")?.text, "I've got it.");
    f.g.time = 13;
    f.end();
    await at(f, 16);
    assert.equal(
      f.requests.length,
      2,
      "an accepted closing turn ends the exchange",
    );
  } finally {
    f.director.dispose();
  }
});

test("unheard, interrupted and failed opening lines never create reply opportunities", async () => {
  for (const reason of [
    "alone",
    "sealed",
    "interrupted",
    "failed-start",
  ] as const) {
    const f = fixture();
    if (reason !== "alone") conversants(f);
    if (reason === "sealed") for (const row of f.g.floors[0].tiles) row[13] = 1;
    if (reason === "failed-start") f.refuseStart();
    try {
      const request = await dispatch(f);
      request.result.resolve(
        conversationDraft(request.payload, "Anyone got some water?", "invite"),
      );
      await until(() =>
        reason === "failed-start"
          ? f.calls.discard.length === 1
          : f.calls.play.length === 1,
      );
      assert.equal(
        f.calls.play.length,
        reason === "failed-start" ? 0 : 1,
        reason,
      );
      f.g.time = reason === "interrupted" ? 7 : 8;
      f.end(reason !== "interrupted");
      await at(f, 11);
      await at(f, 14);
      assert.equal(
        f.requests.length,
        1,
        `${reason}: nobody answers words they did not hear completed`,
      );
      assert.equal(f.calls.synthesize, 1, reason);
    } finally {
      f.director.dispose();
    }
  }
});

test("reply opportunities end after at most two silent listeners rather than polling the crowd", async () => {
  const f = fixture();
  conversants(f, 3);
  try {
    await dispatch(f);
    await sayConversation(f, "Anyone got some water?", "invite");
    f.g.time = 8;
    f.end();
    const attempted = new Set<string>();
    for (let time = 11; time <= 23; time += 3) {
      await at(f, time);
      const request = f.requests.at(-1)!;
      if (
        !request.payload.conversation ||
        attempted.has(request.payload.actorId)
      )
        continue;
      assert.notEqual(request.payload.actorId, "voice-npc");
      attempted.add(request.payload.actorId);
      request.result.resolve({
        requestId: request.payload.requestId,
        actorId: request.payload.actorId,
        decision: "silent",
        reason: "I have no useful answer to add.",
      });
      await flush();
    }
    assert.equal(attempted.size, 2);
    assert.equal(
      f.requests.length,
      3,
      "one opening plus two optional listeners, never a crowd-wide roll call",
    );
    assert.equal(f.calls.reviews.length, 1);
    assert.equal(f.calls.play.length, 1);
  } finally {
    f.director.dispose();
  }
});

test("a pending reply is cancelled when its source, audience, urgency or reply window changes", async () => {
  for (const reason of [
    "departed",
    "dead",
    "sealed",
    "danger",
    "expired",
    "pause",
    "off",
    "new-run",
  ] as const) {
    const f = fixture();
    conversants(f);
    try {
      await dispatch(f);
      await sayConversation(f, "Can you watch the corridor?", "invite");
      f.g.time = 8;
      f.end();
      await at(f, 11);
      assert.equal(f.requests.length, 2, reason);
      const pending = f.requests[1];
      assert.equal(pending.active(), true, reason);
      if (reason === "departed") f.g.survivors[1].x = 32;
      if (reason === "dead") f.g.survivors[1].alive = false;
      if (reason === "sealed")
        for (const row of f.g.floors[0].tiles) row[13] = 1;
      if (reason === "danger")
        f.g.zombies.push({
          id: "new-immediate-attacker",
          x: 14.8,
          y: 10.5,
          floor: 0,
          hp: 60,
          path: [],
          repath: 0,
          cooldown: 0,
          memory: 0,
          stagger: 0,
          origin: "outside",
        });
      if (reason === "pause") f.g.paused = true;
      if (reason === "off") f.g.settings.npcVoices = false;
      if (reason === "new-run") f.g.id = "a-new-conversation-run";
      await at(f, reason === "expired" ? 39 : 11.5);
      assert.equal(pending.signal.aborted, true, reason);
      assert.equal(pending.active(), false, reason);
      pending.result.resolve(
        conversationDraft(pending.payload, "I've got it.", "close"),
      );
      await flush();
      assert.equal(f.calls.synthesize, 1, reason);
      assert.equal(f.calls.play.length, 1, reason);
      assert.equal(npcSpeechBubble(f.g, "listener-0"), undefined, reason);
    } finally {
      f.director.dispose();
    }
  }
});

test("AI abstention skips the critic, speech service and bubble entirely", async () => {
  const f = fixture(),
    request = await dispatch(f);
  request.result.resolve({
    requestId: request.payload.requestId,
    actorId: request.payload.actorId,
    decision: "silent",
    reason: "Another comment would only distract us.",
  });
  await flush();
  noSpeech(f);
  assert.equal(f.calls.reviews.length, 0);
  f.director.dispose();
});

test("validly grounded weather smalltalk stays silent until one repair passes its own exact critic", async () => {
  const f = fixture(),
    first = holdReview(f);
  await dispatch(f);
  await answer(f, "How's the weather today?");
  const rejected = f.calls.reviews[0].packet;
  assert.ok(
    rejected.candidate.evidence.every((id) =>
      rejected.context.dialogue!.facts.some((fact) => fact.id === id),
    ),
  );
  noSpeech(f);
  first.resolve(review(rejected, "revise"));
  await until(() => f.requests.length === 2);
  const repair = f.requests[1];
  assert.deepEqual(repair.payload.dialogue!.feedback, {
    previousText: "How's the weather today?",
    issues: ["off-topic"],
    note: "Use the immediate survivor situation.",
  });
  noSpeech(f);
  const second = holdReview(f);
  await answer(f, "I'd take bad weather over this.");
  noSpeech(f);
  assert.notEqual(
    f.calls.reviews[1].packet.candidateFingerprint,
    rejected.candidateFingerprint,
  );
  assert.equal(f.calls.reviews[1].packet.attempt, 1);
  second.resolve(review(f.calls.reviews[1].packet));
  await until(() => f.calls.play.length === 1);
  assert.equal(f.calls.synthesize, 1);
  assert.equal(f.calls.download, 1);
  assert.equal(
    npcSpeechBubble(f.g, f.g.survivors[1].id)?.text,
    "I'd take bad weather over this.",
  );
  assert.equal(
    npcSpeechBubble(f.g, f.g.survivors[1].id)?.id,
    repair.payload.requestId,
  );
  assert.equal(f.requests.length + f.calls.reviews.length, 4);
  f.director.dispose();
});

test("two rejected drafts exhaust the four-job budget without downloading or displaying speech", async () => {
  const f = fixture();
  f.transport.review = async (packet, signal, active) => {
    f.calls.reviews.push({ packet, signal, active });
    return review(packet, "revise");
  };
  await dispatch(f);
  await answer(f, "How's the weather today?");
  await until(() => f.requests.length === 2);
  await answer(f, "Lovely day for a picnic.");
  await flush();
  noSpeech(f);
  assert.equal(f.requests.length, 2);
  assert.equal(f.calls.reviews.length, 2);
  for (let i = 0; i < 20; i++) f.director.update(f.g);
  assert.equal(f.requests.length + f.calls.reviews.length, 4);
  f.director.dispose();
});

test("a critic's silence verdict and malformed or mismatched review receipts never reach TTS", async () => {
  for (const failure of [
    "silence",
    "fingerprint",
    "actor",
    "issues",
    "malformed",
  ] as const) {
    const f = fixture();
    f.transport.review = async (packet, signal, active) => {
      f.calls.reviews.push({ packet, signal, active });
      const value = review(packet);
      if (failure === "silence") return review(packet, "silence");
      if (failure === "fingerprint")
        return { ...value, candidateFingerprint: "0".repeat(64) };
      if (failure === "actor") return { ...value, actorId: "another-npc" };
      if (failure === "issues") return { ...value, issues: ["off-topic"] };
      return { verdict: "accept" };
    };
    await dispatch(f);
    await answer(f);
    noSpeech(f);
    assert.equal(f.requests.length, 1, failure);
    assert.equal(f.calls.reviews.length, 1, failure);
    f.director.dispose();
  }
});

test("cited attacker, injured ally and heard impact facts becoming stale cancel a pending critic", async () => {
  for (const change of ["attacker", "healed-ally", "expired-impact"] as const) {
    const f = fixture(),
      waiting = holdReview(f);
    if (change === "attacker")
      f.g.zombies = [
        {
          id: "attacker-a",
          x: 14,
          y: 10.5,
          floor: 0,
          hp: 60,
          path: [],
          repath: 0,
          cooldown: 0,
          memory: 0,
          stagger: 0,
          origin: "outside",
        } satisfies Zombie,
      ];
    if (change === "healed-ally")
      f.g.survivors.push(
        Object.assign(actor("sam", "Sam", 2), {
          x: 13.5,
          y: 10.5,
          hp: 20,
          activity: "exploring" as const,
        }),
      );
    if (change === "expired-impact")
      f.g.events.push({
        seq: 1,
        type: "barricade-hit",
        at: 5,
        floor: 0,
        text: "synthetic",
        position: { x: 13, y: 10.5 },
      });
    const request = await dispatch(f),
      factId =
        change === "attacker"
          ? "threat:attacker-a"
          : change === "healed-ally"
            ? "person:sam"
            : "event:1";
    assert.ok(
      request.payload.dialogue!.facts.some((fact) => fact.id === factId),
      change,
    );
    await answer(
      f,
      change === "attacker"
        ? "Stay back from that one."
        : change === "healed-ally"
          ? "Sam, keep pressure on that wound."
          : "That barricade's taking hits.",
      [factId],
    );
    const pending = f.calls.reviews[0];
    assert.equal(pending.active(), true, change);
    if (change === "attacker") f.g.zombies[0].id = "attacker-b";
    if (change === "healed-ally") f.g.survivors.at(-1)!.hp = 100;
    f.g.time += change === "expired-impact" ? 5 : 0.5;
    f.director.update(f.g);
    assert.equal(pending.signal.aborted, true, change);
    assert.equal(pending.active(), false, change);
    waiting.resolve(review(pending.packet));
    await flush();
    noSpeech(f);
    f.director.dispose();
  }
});

test("pause, voices off and a new run abort the in-flight critic request", async (t) => {
  for (const reason of ["pause", "off", "new-run"] as const) {
    const f = fixture(),
      aborted: boolean[] = [],
      submitted: unknown[] = [];
    t.mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/status")
          return Response.json({
            mode: "claude-cli",
            label: "Synthetic gateway",
            capabilities: ["npc-chatter", "npc-chatter-review"],
            detail: "Offline fixture",
          });
        if (url === "/api/bridge") {
          submitted.push(JSON.parse(String(init?.body)));
          // The reply never arrives; only the caller's signal can end it.
          return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            const end = () => {
              aborted.push(true);
              reject(signal?.reason ?? Error("aborted"));
            };
            if (signal?.aborted) end();
            else signal?.addEventListener("abort", end, { once: true });
          });
        }
        throw Error(`Unexpected synthetic transport request: ${url}`);
      },
    );
    await checkBridge();
    f.transport.review = (packet, signal, active) => {
      f.calls.reviews.push({ packet, signal, active });
      return npcVoiceTransport.review(packet, signal, active);
    };
    await dispatch(f);
    await answer(f);
    await until(() => submitted.length === 1);
    assert.equal(
      (submitted[0] as { operation: string }).operation,
      "npc-chatter-review",
    );
    assert.equal(aborted.length, 0, "the critic is still waiting");
    if (reason === "pause") f.g.paused = true;
    if (reason === "off") f.g.settings.npcVoices = false;
    f.director.update(reason === "new-run" ? game() : f.g);
    await until(() => aborted.length === 1);
    noSpeech(f);
    f.director.dispose();
    t.mock.restoreAll();
  }
});

test("one background request stays silent until generation, synthesis, decoding and actual playback start", async () => {
  const f = fixture(),
    synthesize = deferred<ReturnType<typeof ticket>>(),
    decode = deferred<AudioBuffer | undefined>();
  let reply: NpcChatterReply | undefined;
  f.transport.synthesize = async (value) => {
    f.calls.synthesize++;
    reply = value;
    return synthesize.promise;
  };
  f.audio.decodeSpeech = async () => {
    f.calls.decode++;
    return decode.promise;
  };
  const request = await dispatch(f),
    npc = f.g.survivors[1],
    learning = JSON.stringify(f.g.study),
    rng = f.g.rng,
    seq = f.g.seq;
  for (let i = 0; i < 100; i++) f.director.update(f.g);
  assert.equal(f.requests.length, 1);
  assert.equal(npcSpeechBubble(f.g, npc.id), undefined);
  assert.equal(f.calls.play.length, 0);
  await answer(f, "I can hear them beyond that door.");
  assert.ok(reply);
  assert.equal(f.calls.synthesize, 1);
  assert.equal(f.calls.decode, 0);
  assert.equal(npcSpeechBubble(f.g, npc.id), undefined);
  synthesize.resolve(ticket(reply!));
  await flush();
  assert.equal(f.calls.decode, 1);
  assert.equal(f.calls.play.length, 0);
  assert.equal(npcSpeechBubble(f.g, npc.id), undefined);
  decode.resolve(buffer(2));
  await flush();
  assert.equal(f.calls.play.length, 1);
  assert.equal(npcSpeechBubble(f.g, npc.id)?.text, reply!.text);
  assert.equal(npcSpeechBubble(f.g, npc.id)?.id, request.payload.requestId);
  assert.deepEqual(
    f.calls.discard,
    [token],
    "temporary server audio is discarded after decode/start",
  );
  for (let i = 0; i < 50; i++) f.director.update(f.g);
  assert.equal(
    f.requests.length,
    1,
    "no second voice request overlaps actual playback",
  );
  f.end();
  assert.equal(npcSpeechBubble(f.g, npc.id), undefined);
  assert.equal(JSON.stringify(f.g.study), learning);
  assert.equal(f.g.rng, rng);
  assert.equal(f.g.seq, seq);
  assert.equal(
    JSON.stringify(f.g).includes(reply!.text),
    false,
    "speech never enters saved world state",
  );
  f.director.dispose();
});

test("failed playback, decoding, downloads and malformed replies never display a spoken bubble", async () => {
  for (const failure of ["start", "decode", "download", "reply"] as const) {
    const f = fixture();
    if (failure === "start") f.refuseStart();
    if (failure === "decode") f.audio.decodeSpeech = async () => undefined;
    if (failure === "download")
      f.transport.download = async () => {
        throw Error("synthetic download failure");
      };
    const request = await dispatch(f);
    if (failure === "reply") {
      request.result.resolve({
        ...draft(request.payload, "Wrong speaker"),
        actorId: "someone-else",
      });
      await flush();
    } else await answer(f);
    assert.equal(f.calls.play.length, 0, failure);
    assert.equal(npcSpeechBubble(f.g, f.g.survivors[1].id), undefined, failure);
    assert.deepEqual(
      f.calls.discard,
      failure === "reply" ? [] : [token],
      failure,
    );
    f.director.dispose();
  }
});

test("pause, mute, disabled voices, stale actors, disposal and a new run reject late generation", async () => {
  for (const reason of [
    "pause",
    "mute",
    "off",
    "stale",
    "dispose",
    "new-run",
  ] as const) {
    const f = fixture(),
      request = await dispatch(f);
    if (reason === "pause") f.g.paused = true;
    if (reason === "mute") f.g.settings.volume = 0;
    if (reason === "off") f.g.settings.npcVoices = false;
    if (reason === "stale") {
      f.g.survivors[1].activity = "fleeing";
      f.g.time += 0.5; // The relevance sampler runs twice per simulated second.
    }
    if (reason === "dispose") f.director.dispose();
    else f.director.update(reason === "new-run" ? game() : f.g);
    assert.equal(request.signal.aborted, true, reason);
    assert.equal(request.active(), false, reason);
    await answer(f);
    assert.equal(f.calls.synthesize, 0, reason);
    assert.equal(f.calls.play.length, 0, reason);
    assert.equal(npcSpeechBubble(f.g, f.g.survivors[1].id), undefined, reason);
    f.director.dispose();
  }
});

test("active playback and its exact matching bubble stop on pause, disabled voices or a new run", async () => {
  for (const reason of ["pause", "off", "new-run", "dispose"] as const) {
    const f = fixture(),
      request = await dispatch(f);
    await answer(f);
    assert.ok(npcSpeechBubble(f.g, f.g.survivors[1].id));
    if (reason === "pause") f.g.paused = true;
    if (reason === "off") f.g.settings.npcVoices = false;
    if (reason === "dispose") f.director.dispose();
    else f.director.update(reason === "new-run" ? game() : f.g);
    assert.ok(f.calls.stop.includes(request.payload.requestId), reason);
    assert.equal(npcSpeechBubble(f.g, f.g.survivors[1].id), undefined, reason);
    f.director.dispose();
  }
});

test("a slow response is accepted and the next speaker waits from actual playback start", async () => {
  // The nearby listener declines to answer, isolating the ambient cooldown.
  let draw = 0;
  const f = fixture(() => draw);
  f.g.survivors.push(
    Object.assign(actor("second-voice-npc", "Theo", 2), {
      x: 14.5,
      y: 10.5,
      activity: "exploring" as const,
    }),
  );
  await dispatch(f);
  f.g.time += 100;
  f.director.update(f.g);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].signal.aborted, false);
  await answer(f, "We have a little room to breathe here.");
  assert.equal(f.calls.play.length, 1);
  assert.equal(
    npcSpeechBubble(f.g, f.g.survivors[1].id)?.text,
    "We have a little room to breathe here.",
  );
  draw = 0.999;
  f.end();
  draw = 0;
  f.g.time += NPC_VOICE_LIMITS.globalSeconds - 0.5;
  f.director.update(f.g);
  assert.equal(
    f.requests.length,
    1,
    "a slow generation cannot consume the quiet interval before speech actually starts",
  );
  f.g.time += 1;
  f.director.update(f.g);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].payload.actorId, "second-voice-npc");
  f.director.dispose();
  await answer(f, "Disposed second line.");
});

test("cooldowns prevent chatter flooding and recent transient memory stays bounded", async () => {
  const f = fixture();
  await dispatch(f);
  for (let i = 0; i < 14; i++) {
    await answer(f, `Distinct contextual line number ${i + 1}.`);
    f.end();
    f.g.time += NPC_VOICE_LIMITS.globalSeconds;
    f.director.update(f.g);
    assert.equal(
      f.requests.length,
      i + 1,
      "the same speaker still waits for their personal cooldown",
    );
    f.g.time += NPC_VOICE_LIMITS.actorSeconds - NPC_VOICE_LIMITS.globalSeconds;
    if (i < 13) {
      f.director.update(f.g);
      assert.equal(f.requests.length, i + 2);
    }
  }
  const recent = (f.director as unknown as { recent: unknown[] }).recent;
  assert.equal(recent.length, NPC_VOICE_LIMITS.recentLines);
  assert.ok(
    f.requests.every((request) => request.payload.recentLines.length <= 3),
  );
  assert.equal(
    f.requests.at(-1)!.payload.recentLines.at(-1)?.text,
    "Distinct contextual line number 13.",
  );
  f.director.dispose();
});

test("invalid or oversized synthesized metadata is discarded before downloading", async () => {
  for (const change of [
    { bytes: NPC_VOICE_LIMITS.audioBytes + 1 },
    { bytes: -1 },
    { duration: NPC_VOICE_LIMITS.durationSeconds + 0.01 },
    { duration: NaN },
    { mime: "text/html" },
  ]) {
    const f = fixture();
    f.transport.synthesize = async (reply) => {
      const value = ticket(reply);
      return { ...value, audio: { ...value.audio, ...change } };
    };
    await dispatch(f);
    await answer(f);
    assert.equal(f.calls.download, 0);
    assert.equal(f.calls.play.length, 0);
    assert.deepEqual(f.calls.discard, [token]);
    f.director.dispose();
  }
});

test("an oversized downloaded buffer is discarded before decoding or playback", async () => {
  const f = fixture();
  f.transport.download = async () =>
    new ArrayBuffer(NPC_VOICE_LIMITS.audioBytes + 1);
  await dispatch(f);
  await answer(f);
  assert.equal(f.calls.decode, 0);
  assert.equal(f.calls.play.length, 0);
  assert.deepEqual(f.calls.discard, [token]);
  assert.equal(npcSpeechBubble(f.g, f.g.survivors[1].id), undefined);
  f.director.dispose();
});

test("turning voices off during decode drops the temporary audio without a late bubble", async () => {
  const f = fixture(),
    decoded = deferred<AudioBuffer | undefined>();
  f.audio.decodeSpeech = async () => {
    f.calls.decode++;
    return decoded.promise;
  };
  const request = await dispatch(f);
  await answer(f);
  assert.equal(f.calls.decode, 1);
  f.g.settings.npcVoices = false;
  f.director.update(f.g);
  assert.equal(request.signal.aborted, true);
  decoded.resolve(buffer());
  await flush();
  assert.equal(f.calls.play.length, 0);
  assert.equal(npcSpeechBubble(f.g, f.g.survivors[1].id), undefined);
  assert.deepEqual(f.calls.discard, [token]);
  f.director.dispose();
});

test("temporary-file cleanup failures cannot reject the finished playback task", async () => {
  const f = fixture();
  f.transport.discard = async (url) => {
    f.calls.discard.push(url);
    throw Error("synthetic cleanup failure");
  };
  await dispatch(f);
  await answer(f);
  assert.equal(f.calls.play.length, 1);
  assert.ok(npcSpeechBubble(f.g, f.g.survivors[1].id));
  assert.deepEqual(f.calls.discard, [token]);
  f.end();
  f.director.dispose();
});

test("an old pending request cannot transfer its cooldown into a new run or restored clock", async () => {
  for (const reset of ["new-object", "new-id", "rewind"] as const) {
    const f = fixture(),
      old = await dispatch(f);
    f.g.time = 1000;
    let next = f.g;
    if (reset === "new-object") next = game();
    else {
      if (reset === "new-id") next.id = "new-run-on-the-same-object";
      next.time = 0;
    }
    f.director.update(next);
    assert.equal(old.signal.aborted, true, reset);
    old.result.resolve(draft(old.payload, "Obsolete old-run line."));
    await flush();
    assert.equal(f.calls.play.length, 0, reset);
    next.time = 0.5; // The fresh availability probe gets its own scheduling sample.
    f.director.update(next);
    await flush();
    next.time = 6.5;
    f.director.update(next);
    assert.equal(
      f.requests.length,
      2,
      `${reset}: an obsolete old clock must not delay a fresh run's first request`,
    );
    assert.equal(f.requests[1].payload.runId, next.id, reset);
    assert.equal(f.requests[1].payload.capturedAt, 6.5, reset);
    f.director.dispose();
    f.requests[1].result.resolve(
      draft(f.requests[1].payload, "Disposed fresh-run line."),
    );
    await flush();
  }
});

test("the real download transport rejects oversized streamed WAV data and incorrect media types", async (t) => {
  let mode: "declared" | "stream" | "type" = "declared";
  t.mock.method(globalThis, "fetch", async () => {
    if (mode === "declared")
      return new Response(new Uint8Array(10), {
        headers: {
          "Content-Type": "audio/wav",
          "Content-Length": String(NPC_VOICE_LIMITS.audioBytes + 1),
        },
      });
    if (mode === "type")
      return new Response("not audio", {
        headers: { "Content-Type": "text/html" },
      });
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(NPC_VOICE_LIMITS.audioBytes));
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      }),
      { headers: { "Content-Type": "audio/wav" } },
    );
  });
  const signal = new AbortController().signal;
  await assert.rejects(npcVoiceTransport.download(token, signal), /byte limit/);
  mode = "stream";
  await assert.rejects(npcVoiceTransport.download(token, signal), /byte limit/);
  mode = "type";
  await assert.rejects(
    npcVoiceTransport.download(token, signal),
    /download failed/,
  );
});

test("narrator voice groups split the fifteen slots into five male and ten female", () => {
  assert.equal(NPC_VOICE_SLOTS.length, 15);
  assert.deepEqual(
    [...NPC_VOICE_GROUPS.male],
    ["steady", "low", "gruff", "lively", "dry"],
  );
  assert.deepEqual(
    [...NPC_VOICE_GROUPS.female],
    [
      "bright",
      "warm",
      "crisp",
      "soft",
      "clear",
      "keen",
      "calm",
      "even",
      "quick",
      "poised",
    ],
  );
  assert.equal(
    new Set([...NPC_VOICE_GROUPS.male, ...NPC_VOICE_GROUPS.female]).size,
    15,
    "the male and female groups are disjoint",
  );
  assert.deepEqual(
    [...NPC_VOICE_GROUPS.male, ...NPC_VOICE_GROUPS.female].sort(),
    [...NPC_VOICE_SLOTS].sort(),
    "the two groups together cover exactly the narrator slots",
  );
  assert.ok(
    Object.isFrozen(NPC_VOICE_GROUPS) &&
      Object.isFrozen(NPC_VOICE_GROUPS.male) &&
      Object.isFrozen(NPC_VOICE_GROUPS.female),
  );
});

test("a run and actor pair always keeps the same narrator voice", () => {
  const picks = [
    ["run-a", "survivor-0"],
    ["run-a", "voice-npc"],
    ["run-a", "Maya"],
    ["run-a", "Zoë"],
    ["run-b", "survivor-0"],
    ["run-7", "npc-2"],
  ] as const;
  for (const [runId, actorId] of picks) {
    const first = npcVoiceFor(runId, actorId);
    assert.ok(
      NPC_VOICE_SLOTS.includes(first),
      `${runId}/${actorId} picked the known slot ${first}`,
    );
    for (let i = 0; i < 5; i++)
      assert.equal(
        npcVoiceFor(runId, actorId),
        first,
        `${runId}/${actorId} keeps its narrator voice within the run`,
      );
  }
});

test("a new run re-rolls the narrator voices", () => {
  let changed = 0;
  for (let i = 0; i < 40; i++)
    if (
      npcVoiceFor("run-a", `survivor-${i}`) !==
      npcVoiceFor("run-b", `survivor-${i}`)
    )
      changed++;
  assert.ok(
    changed >= 10,
    `${changed} of 40 actors got a different narrator voice in the new run`,
  );
});

test("narrator voices pick gender evenly, then a uniform slot in the group", () => {
  const picks = Array.from({ length: 4000 }, (_, i) =>
    npcVoiceFor(`run-${i % 40}`, `survivor-${Math.floor(i / 40)}`),
  );
  const male = picks.filter((slot) =>
    (NPC_VOICE_GROUPS.male as readonly string[]).includes(slot),
  );
  const female = picks.filter((slot) =>
    (NPC_VOICE_GROUPS.female as readonly string[]).includes(slot),
  );
  assert.equal(
    male.length + female.length,
    picks.length,
    "every pick belongs to exactly one gender group",
  );
  const share = male.length / picks.length;
  assert.ok(
    share >= 0.45 && share <= 0.55,
    `the male share ${share.toFixed(3)} stays near one half`,
  );
  for (const [name, group, members] of [
    ["male", NPC_VOICE_GROUPS.male, male],
    ["female", NPC_VOICE_GROUPS.female, female],
  ] as const) {
    const expected = members.length / group.length;
    for (const slot of group) {
      const count = members.filter((pick) => pick === slot).length;
      assert.ok(
        count >= expected * 0.75 && count <= expected * 1.25,
        `${slot} takes ${count} of the ${name} picks near ${expected.toFixed(1)}`,
      );
    }
  }
});
