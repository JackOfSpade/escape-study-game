import { startDesignedRun } from "./helpers/designed-run";
import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "./helpers/offline-test";
import { openPlayerMenu } from "./helpers/game-menu";

const line = "Keep that doorway clear.";
const token = "/api/speech/" + "b".repeat(48);
function wav(seconds = 3) {
  const rate = 8000,
    frames = rate * seconds,
    bytes = Buffer.alloc(44 + frames * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++)
    bytes.writeInt16LE(Math.round(Math.sin(i * 0.16) * 12), 44 + i * 2);
  return bytes;
}
async function mockSpeech(
  page: Page,
  options: {
    texts?: string[];
    verdicts?: ("accept" | "revise" | "silence")[];
    heldReview?: boolean;
    conversation?: "reply" | "silent";
  } = {},
) {
  let release!: () => void, releaseReview!: () => void;
  const generated = new Promise<void>((resolve) => {
      release = resolve;
    }),
    reviewGate = new Promise<void>((resolve) => {
      releaseReview = resolve;
    }),
    requests: any[] = [],
    reviews: any[] = [],
    synthesis: any[] = [],
    downloads: string[] = [],
    discards: string[] = [],
    bytes = wav();
  await page.route("**/api/speech/status", (route) =>
    route.fulfill({ json: { available: true, provider: "local-speech" } }),
  );
  await page.route("**/api/status", (route) =>
    route.fulfill({
      json: {
        mode: "claude-cli",
        label: "Synthetic offline relay",
        capabilities: ["npc-chatter", "npc-chatter-review"],
        detail: "No model is called.",
      },
    }),
  );
  await page.route("**/api/bridge", async (route) => {
    const body = route.request().postDataJSON();
    if (body.operation === "npc-chatter") {
      requests.push(body);
      const replyTo = body.payload.conversation?.replyTo;
      const text = options.conversation
        ? replyTo
          ? "Not here. Keep moving."
          : "Anyone got some water?"
        : (options.texts?.[
            Math.min(requests.length - 1, options.texts.length - 1)
          ] ?? line);
      await generated;
      if (replyTo && options.conversation === "silent") {
        await route
          .fulfill({
            json: {
              requestId: body.payload.requestId,
              actorId: body.payload.actorId,
              decision: "silent",
              reason: "I have nothing useful to offer right now.",
            },
          })
          .catch(() => {});
        return;
      }
      await route
        .fulfill({
          json: {
            requestId: body.payload.requestId,
            actorId: body.payload.actorId,
            decision: "speak",
            text,
            delivery: "calm",
            purpose: "React to the current survivor situation.",
            evidence: [
              replyTo ? `speech:${replyTo}` : body.payload.dialogue.facts[0].id,
            ],
            ...(options.conversation
              ? {
                  conversation: {
                    intent: replyTo ? "close" : "invite",
                    ...(replyTo ? { replyTo } : {}),
                  },
                }
              : {}),
          },
        })
        .catch(() => {});
    } else if (body.operation === "npc-chatter-review") {
      reviews.push(body);
      // The critic stays in flight until the test lets its verdict through.
      if (options.heldReview) await reviewGate;
      const verdict =
        options.verdicts?.[
          Math.min(reviews.length - 1, options.verdicts.length - 1)
        ] ?? "accept";
      await route
        .fulfill({
          json: {
            requestId: body.payload.requestId,
            actorId: body.payload.actorId,
            candidateFingerprint: body.payload.candidateFingerprint,
            verdict,
            issues: verdict === "accept" ? [] : ["off-topic"],
            note:
              verdict === "accept"
                ? "Fits the captured situation."
                : "This smalltalk ignores the ongoing catastrophe.",
          },
        })
        .catch(() => {});
    } else throw Error(`Unexpected synthetic operation: ${body.operation}`);
  });
  await page.route("**/api/speech", async (route) => {
    const body = route.request().postDataJSON();
    synthesis.push(body);
    await route.fulfill({
      json: {
        requestId: body.requestId,
        actorId: body.actorId,
        text: body.text,
        audio: {
          url: token,
          mime: "audio/wav",
          bytes: bytes.length,
          duration: 3,
        },
      },
    });
  });
  await page.route("**/api/speech/" + "b".repeat(48), async (route) => {
    if (route.request().method() === "DELETE") {
      discards.push(route.request().url());
      await route.fulfill({ status: 204 });
    } else {
      downloads.push(route.request().url());
      await route.fulfill({
        body: bytes,
        contentType: "audio/wav",
        headers: { "Content-Length": String(bytes.length) },
      });
    }
  });
  return {
    release,
    releaseReview,
    requests,
    reviews,
    synthesis,
    downloads,
    discards,
  };
}

async function setupVoice(page: Page, conversation = false) {
  await page.goto("/lab.html");
  await page.evaluate(async (conversation) => {
    const [
        { AudioDirector },
        { NpcVoiceDirector },
        { FirstPersonView },
        { render },
        { actor, createGame },
        speech,
        { checkBridge },
      ] = await Promise.all([
        import("/src/audio.ts" as string),
        import("/src/npc-voice.ts" as string),
        import("/src/view3d/scene.ts" as string),
        import("/src/render.ts" as string),
        import("/src/world.ts" as string),
        import("/src/speech-bubbles.ts" as string),
        import("/src/bridge-client.ts" as string),
      ]),
      roadmap = await (await fetch("/curriculum.json")).json(),
      game = createGame(42, roadmap),
      npc = Object.assign(actor("voice-npc", "Maya", 1), {
        x: 13,
        y: 10.5,
        activity: "exploring",
      }),
      f = game.floors[0],
      overlay = document.createElement("div"),
      canvas = document.createElement("canvas"),
      classic = document.createElement("canvas"),
      start = document.createElement("button");
    game.survivors = [game.survivors[0], npc];
    if (conversation)
      game.survivors.push(
        Object.assign(actor("listener", "Theo", 2), {
          x: 14.5,
          y: 10.5,
          activity: "exploring",
        }),
      );
    Object.assign(game.survivors[0], { x: 10.5, y: 10.5 });
    game.status = "playing";
    game.time = 0;
    game.zombies = [];
    game.events = [];
    game.settings.npcVoices = true;
    game.settings.volume = 0.2;
    game.settings.reducedFlash = true;
    f.tiles = Array.from({ length: 34 }, (_, y) =>
      Array.from({ length: 44 }, (_, x) =>
        x === 0 || x === 43 || y === 0 || y === 33 ? 1 : 0,
      ),
    );
    f.furniture = [];
    f.stations = [];
    f.stairs = { x: 35, y: 25 };
    overlay.id = "voice-preview";
    Object.assign(overlay.style, {
      position: "fixed",
      left: "0",
      top: "0",
      zIndex: "100000",
      display: "flex",
      flexWrap: "wrap",
      background: "#101b20",
      width: "1180px",
    });
    canvas.id = "voice-first-person";
    classic.id = "voice-classic";
    Object.assign(canvas.style, { width: "640px", height: "420px" });
    Object.assign(classic.style, { width: "540px", height: "420px" });
    start.id = "start-voice-audio";
    start.textContent = "Start synthetic voice audio";
    overlay.append(canvas, classic, start);
    document.body.append(overlay);
    await checkBridge();
    const audio = new AudioDirector(
        () => new AudioContext(),
        async () => new Map(),
      ),
      director = new NpcVoiceDirector(
        audio,
        undefined,
        () => true,
        () => 0,
      ),
      view = new FirstPersonView(canvas),
      ctx = classic.getContext("2d")!,
      originalFill = ctx.fillText.bind(ctx),
      state = {
        game,
        npc,
        audio,
        director,
        view,
        speech,
        classicLines: [] as string[],
        timer: 0,
        playing: false,
        maxSpeechVoices: 0,
        played: [] as { id: string; actorId: string; at: number }[],
      };
    const speak = audio.speak.bind(audio);
    audio.speak = (g: any, speech: any) => {
      const started = speak(g, speech);
      if (started)
        state.played.push({
          id: speech.id,
          actorId: speech.actorId,
          at: game.time,
        });
      return started;
    };
    ctx.fillText = (text: string, x: number, y: number, maxWidth?: number) => {
      state.classicLines.push(text);
      if (maxWidth === undefined) originalFill(text, x, y);
      else originalFill(text, x, y, maxWidth);
    };
    start.onclick = () => {
      audio.start();
      void audio.ctx?.resume();
    };
    let lastWall = performance.now();
    const draw = () => {
      const now = performance.now();
      if (conversation) game.time += Math.min(0.25, (now - lastWall) / 1000);
      lastWall = now;
      audio.update(game, { yaw: 0, pitch: 0 });
      director.update(game);
      state.classicLines = [];
      game.settings.view = "top-down";
      render(classic, game);
      game.settings.view = "first-person";
      view.render(game, 0, 0.05, 1 / 30);
      state.maxSpeechVoices = Math.max(
        state.maxSpeechVoices,
        [...(audio as any).voices].filter(
          (voice: any) => voice.channel === "speech",
        ).length,
      );
    };
    draw();
    state.timer = window.setInterval(draw, 80);
    (window as any).__voiceTest = state;
  }, conversation);
  await page.locator("#start-voice-audio").click();
  await page.waitForFunction(
    () => (window as any).__voiceTest.audio.ctx?.state === "running",
  );
  await page.evaluate(() => {
    const s = (window as any).__voiceTest;
    s.game.time = 6;
    s.audio.update(s.game, { yaw: 0, pitch: 0 });
    s.director.update(s.game);
  });
  await page.waitForFunction(
    () => (window as any).__voiceTest.director.available === true,
  );
  await page.evaluate(() => {
    const s = (window as any).__voiceTest;
    s.game.time = 6.5; // Cross the next half-second scheduling sample.
    s.audio.update(s.game, { yaw: 0, pitch: 0 });
    s.director.update(s.game);
  });
}
async function voiceState(page: Page) {
  return page.evaluate(() => {
    const { game, npc, audio, view, speech, classicLines } = (window as any)
        .__voiceTest,
      voices = [...audio.voices] as any[],
      playing = voices.find((voice) => voice.channel === "speech"),
      sprite = view.scene.getObjectByName("npc-speech-bubble");
    return {
      bubble: speech.npcSpeechBubble(game, npc.id)?.text ?? null,
      sprite: sprite?.userData.text ?? null,
      classic: classicLines.includes("Keep that doorway clear."),
      playing: !!playing,
      bufferDuration: playing?.osc.buffer?.duration ?? 0,
      spatial: !!playing?.panner,
      textInSave: JSON.stringify(game).includes("Keep that doorway clear."),
    };
  });
}
async function disposeVoice(page: Page) {
  await page.evaluate(async () => {
    const s = (window as any).__voiceTest;
    if (!s) return;
    clearInterval(s.timer);
    s.director.dispose();
    s.audio.stop();
    s.view.dispose();
    await s.audio.ctx?.close();
  });
}

test("generated contextual text becomes matching 3D and 2D bubbles only during real decoded WAV playback", async ({
  page,
}) => {
  const relay = await mockSpeech(page);
  try {
    await setupVoice(page);
    await expect.poll(() => relay.requests.length).toBe(1);
    expect(relay.requests[0].operation).toBe("npc-chatter");
    expect(relay.requests[0].payload.self.name).toBe("Maya");
    expect((await voiceState(page)).playing).toBe(false);
    expect((await voiceState(page)).bubble).toBeNull();
    expect(relay.synthesis).toHaveLength(0);
    relay.release();
    await expect.poll(async () => (await voiceState(page)).sprite).toBe(line);
    const playing = await voiceState(page);
    expect(playing).toEqual({
      bubble: line,
      sprite: line,
      classic: true,
      playing: true,
      bufferDuration: 3,
      spatial: true,
      textInSave: false,
    });
    expect(relay.reviews).toHaveLength(1);
    expect(relay.reviews[0].payload.candidate.text).toBe(line);
    expect(relay.synthesis).toHaveLength(1);
    expect(relay.synthesis[0].text).toBe(line);
    expect(relay.downloads).toHaveLength(1);
    await expect.poll(() => relay.discards.length).toBe(1);
    await mkdir(".artifacts", { recursive: true });
    await page
      .locator("#voice-preview")
      .screenshot({ path: ".artifacts/npc-voice-bubbles.png" });
    await expect
      .poll(async () => (await voiceState(page)).playing, { timeout: 8000 })
      .toBe(false);
    await expect
      .poll(async () => ({
        bubble: (await voiceState(page)).bubble,
        sprite: (await voiceState(page)).sprite,
        classic: (await voiceState(page)).classic,
      }))
      .toEqual({ bubble: null, sprite: null, classic: false });
  } finally {
    relay.release();
    await disposeVoice(page);
  }
});

test("two semantically rejected grounded drafts never become WAV audio or either bubble", async ({
  page,
}) => {
  const relay = await mockSpeech(page, {
    texts: ["How's the weather today?", "Lovely day for a picnic."],
    verdicts: ["revise", "revise"],
  });
  try {
    await setupVoice(page);
    await expect.poll(() => relay.requests.length).toBe(1);
    relay.release();
    await expect.poll(() => relay.reviews.length).toBe(2);
    await page.waitForFunction(
      () => !(window as any).__voiceTest.director.pending,
    );
    expect(relay.requests).toHaveLength(2);
    expect(relay.reviews[0].payload.candidate.evidence).toEqual([
      "setting.outbreak",
    ]);
    expect(relay.requests[1].payload.dialogue.feedback.previousText).toBe(
      "How's the weather today?",
    );
    expect(relay.synthesis).toHaveLength(0);
    expect(relay.downloads).toHaveLength(0);
    expect(await voiceState(page)).toEqual({
      bubble: null,
      sprite: null,
      classic: false,
      playing: false,
      bufferDuration: 0,
      spatial: false,
      textInSave: false,
    });
  } finally {
    relay.release();
    await disposeVoice(page);
  }
});

test("only the individually approved repaired wording reaches actual decoded speech", async ({
  page,
}) => {
  const relay = await mockSpeech(page, {
    texts: ["How's the weather today?", line],
    verdicts: ["revise", "accept"],
  });
  try {
    await setupVoice(page);
    relay.release();
    await expect.poll(async () => (await voiceState(page)).sprite).toBe(line);
    expect(relay.requests).toHaveLength(2);
    expect(relay.reviews).toHaveLength(2);
    expect(relay.reviews[0].payload.candidateFingerprint).not.toBe(
      relay.reviews[1].payload.candidateFingerprint,
    );
    expect(relay.synthesis.map((item) => item.text)).toEqual([line]);
    expect(relay.synthesis[0].requestId).toBe(
      relay.requests[1].payload.requestId,
    );
    expect(relay.downloads).toHaveLength(1);
    expect((await voiceState(page)).bufferDuration).toBe(3);
  } finally {
    relay.release();
    await disposeVoice(page);
  }
});

test("a completed audible question gets a separately reviewed nearby answer with real non-overlapping WAV playback", async ({
  page,
}) => {
  const relay = await mockSpeech(page, { conversation: "reply" });
  try {
    await setupVoice(page, true);
    await expect.poll(() => relay.requests.length).toBe(1);
    relay.release();
    await expect
      .poll(async () => (await voiceState(page)).bubble)
      .toBe("Anyone got some water?");
    expect(relay.synthesis).toHaveLength(1);
    await expect.poll(() => relay.requests.length, { timeout: 12_000 }).toBe(2);
    const opening = relay.requests[0].payload,
      response = relay.requests[1].payload;
    expect(response.actorId).toBe("listener");
    expect(response.conversation.replyTo).toBe(opening.requestId);
    expect(response.conversation.sourceActorId).toBe("voice-npc");
    expect(response.conversation.turn).toBe(2);
    expect(
      response.recentLines.find((heard: any) => heard.id === opening.requestId)
        ?.text,
    ).toBe("Anyone got some water?");
    expect(
      response.dialogue.facts.some(
        (fact: any) => fact.id === `speech:${opening.requestId}`,
      ),
    ).toBe(true);
    await page.waitForFunction(
      () => (window as any).__voiceTest.played.length === 2,
    );
    const playback = await page.evaluate(() => {
      const s = (window as any).__voiceTest;
      const speechVoices = [...s.audio.voices].filter(
        (v: any) => v.channel === "speech",
      ) as any[];
      return {
        played: s.played,
        maxSpeechVoices: s.maxSpeechVoices,
        openingBubble:
          s.speech.npcSpeechBubble(s.game, "voice-npc")?.text ?? null,
        answerBubble:
          s.speech.npcSpeechBubble(s.game, "listener")?.text ?? null,
        duration: speechVoices[0]?.osc.buffer?.duration,
        saved:
          JSON.stringify(s.game).includes("Anyone got some water?") ||
          JSON.stringify(s.game).includes("Not here. Keep moving."),
      };
    });
    expect(playback.played.map((item: any) => item.actorId)).toEqual([
      "voice-npc",
      "listener",
    ]);
    expect(playback.played[1].at - playback.played[0].at).toBeGreaterThan(3);
    expect(playback.maxSpeechVoices).toBe(1);
    expect(playback.openingBubble).toBeNull();
    expect(playback.answerBubble).toBe("Not here. Keep moving.");
    expect(playback.duration).toBe(3);
    expect(playback.saved).toBe(false);
    expect(relay.reviews).toHaveLength(2);
    expect(relay.reviews[1].payload.candidate.conversation.replyTo).toBe(
      opening.requestId,
    );
    expect(relay.synthesis.map((item) => item.text)).toEqual([
      "Anyone got some water?",
      "Not here. Keep moving.",
    ]);
    expect(relay.downloads).toHaveLength(2);
    await expect.poll(() => relay.discards.length).toBe(2);
  } finally {
    relay.release();
    await disposeVoice(page);
  }
});

test("a heard water request can remain unanswered without fabricating a reply or supplies", async ({
  page,
}) => {
  const relay = await mockSpeech(page, { conversation: "silent" });
  try {
    await setupVoice(page, true);
    const before = await page.evaluate(() =>
      (window as any).__voiceTest.game.survivors.map((a: any) => a.inventory),
    );
    relay.release();
    await expect.poll(() => relay.requests.length, { timeout: 12_000 }).toBe(2);
    await page.waitForFunction(
      () => !(window as any).__voiceTest.director.pending,
    );
    await page.evaluate(() => {
      const s = (window as any).__voiceTest;
      s.game.time += 4;
      s.director.update(s.game);
    });
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => {
      const s = (window as any).__voiceTest;
      return {
        inventory: s.game.survivors.map((a: any) => a.inventory),
        played: s.played,
        bubble: s.speech.npcSpeechBubble(s.game, "listener")?.text ?? null,
        active: [...s.audio.voices].filter((v: any) => v.channel === "speech")
          .length,
      };
    });
    expect(relay.requests[1].payload.conversation.replyTo).toBe(
      relay.requests[0].payload.requestId,
    );
    expect(relay.requests).toHaveLength(2);
    expect(relay.reviews).toHaveLength(1);
    expect(relay.synthesis).toHaveLength(1);
    expect(relay.downloads).toHaveLength(1);
    expect(after.played).toHaveLength(1);
    expect(after.bubble).toBeNull();
    expect(after.active).toBe(0);
    expect(after.inventory).toEqual(before);
  } finally {
    relay.release();
    await disposeVoice(page);
  }
});

for (const interrupted of ["pause", "off", "new-run"] as const) {
  test(`a ${interrupted} while the critic is in flight cannot start audio from its late verdict`, async ({
    page,
  }) => {
    const relay = await mockSpeech(page, { heldReview: true });
    try {
      await setupVoice(page);
      relay.release();
      await expect.poll(() => relay.reviews.length).toBe(1);
      await page.evaluate((interrupted) => {
        const s = (window as any).__voiceTest;
        if (interrupted === "pause") s.game.paused = true;
        else if (interrupted === "off") s.game.settings.npcVoices = false;
        else s.game.id = "synthetic-new-run";
        s.director.update(s.game);
      }, interrupted);
      // An accepting verdict that arrives afterwards must change nothing.
      relay.releaseReview();
      await page.waitForTimeout(300);
      expect(relay.synthesis).toHaveLength(0);
      expect(relay.downloads).toHaveLength(0);
      expect((await voiceState(page)).bubble).toBeNull();
      expect((await voiceState(page)).playing).toBe(false);
    } finally {
      relay.release();
      relay.releaseReview();
      await disposeVoice(page);
    }
  });
}

for (const interrupted of ["pause", "off"] as const) {
  test(`a ${interrupted} while a contextual line is pending prevents late audio and bubbles`, async ({
    page,
  }) => {
    const relay = await mockSpeech(page);
    try {
      await setupVoice(page);
      await expect.poll(() => relay.requests.length).toBe(1);
      await page.evaluate((interrupted) => {
        const s = (window as any).__voiceTest;
        if (interrupted === "pause") s.game.paused = true;
        else s.game.settings.npcVoices = false;
        s.director.update(s.game);
      }, interrupted);
      relay.release();
      await page.waitForTimeout(300);
      expect(await voiceState(page)).toEqual({
        bubble: null,
        sprite: null,
        classic: false,
        playing: false,
        bufferDuration: 0,
        spatial: false,
        textInSave: false,
      });
      expect(relay.synthesis).toHaveLength(0);
      expect(relay.downloads).toHaveLength(0);
    } finally {
      relay.release();
      await disposeVoice(page);
    }
  });
}

test("the player can turn contextual NPC voices off in Settings", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__deadAir);
  // This case covers the Settings control. The synthetic preview cases above
  // exercise 3D rendering; avoid compiling the entire city for this UI check.
  await page.evaluate(() => {
    (window as any).__deadAir.game.settings.view = "top-down";
  });
  await startDesignedRun(page);
  await openPlayerMenu(page);
  await page.locator("#settings-toggle").click();
  await expect(page.locator("#npc-voices")).toBeChecked();
  await page.locator("#npc-voices").uncheck();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__deadAir.game.settings.npcVoices),
    )
    .toBe(false);
  await expect(page.locator("#npc-voice-status")).toContainText("off");
});

test("a full 180-character spoken bubble stays above the head and below the office ceiling", async ({
  page,
}) => {
  const sentence =
    "Keep the doorway clear while I check this terminal. I can hear the barricade taking hits, so stay near, watch the corridor, and give me one moment to finish checking this boundary.";
  expect(sentence.length).toBe(180);
  await page.goto("/lab.html");
  const layout = await page.evaluate(async (text) => {
    const [
        { FirstPersonView },
        { actor, createGame },
        { showNpcSpeechBubble, speechLines },
      ] = await Promise.all([
        import("/src/view3d/scene.ts" as string),
        import("/src/world.ts" as string),
        import("/src/speech-bubbles.ts" as string),
      ]),
      game = createGame(42, await (await fetch("/curriculum.json")).json()),
      npc = Object.assign(actor("long-voice-npc", "Maya", 1), {
        x: 13,
        y: 10.5,
      }),
      canvas = document.createElement("canvas");
    game.survivors = [game.survivors[0], npc];
    Object.assign(game.survivors[0], { x: 10.5, y: 10.5 });
    game.status = "playing";
    game.time = 0;
    game.zombies = [];
    game.events = [];
    game.settings.reducedFlash = true;
    game.floors[0].furniture = [];
    game.floors[0].stations = [];
    game.floors[0].tiles = Array.from({ length: 34 }, (_, y) =>
      Array.from({ length: 44 }, (_, x) =>
        x === 0 || x === 43 || y === 0 || y === 33 ? 1 : 0,
      ),
    );
    canvas.id = "long-voice-preview";
    Object.assign(canvas.style, {
      position: "fixed",
      top: "0",
      left: "0",
      zIndex: "100000",
      width: "960px",
      height: "640px",
    });
    document.body.append(canvas);
    const view = new FirstPersonView(canvas);
    view.render(game, 0, 0.12, 1 / 60);
    const original = CanvasRenderingContext2D.prototype.fillText,
      drawn = new Map<HTMLCanvasElement, string[]>();
    CanvasRenderingContext2D.prototype.fillText = function (
      text,
      x,
      y,
      maxWidth?,
    ) {
      const lines = drawn.get(this.canvas) ?? [];
      lines.push(text);
      drawn.set(this.canvas, lines);
      if (maxWidth === undefined) original.call(this, text, x, y);
      else original.call(this, text, x, y, maxWidth);
    };
    try {
      showNpcSpeechBubble(game, {
        id: "long-spoken-line",
        actorId: npc.id,
        text,
        until: 12,
      });
      view.render(game, 0, 0.12, 1 / 60);
    } finally {
      CanvasRenderingContext2D.prototype.fillText = original;
    }
    const sprite = (view as any).scene.getObjectByName("npc-speech-bubble"),
      visual = (view as any).visuals.get(npc),
      height = sprite.scale.y,
      bottom = sprite.position.y - sprite.center.y * height;
    (window as any).__longVoicePreview = view;
    return {
      text: sprite.userData.text as string,
      bottom,
      top: bottom + height,
      nameVisible: visual.label.visible as boolean,
      drawnLines: drawn.get(sprite.material.map.image) ?? [],
      expectedLines: speechLines(text, 36) as string[],
      longTokenLines: speechLines("Z".repeat(180), 36) as string[],
    };
  }, sentence);
  expect(layout.text).toBe(sentence);
  expect(layout.bottom).toBeGreaterThanOrEqual(1.75);
  expect(layout.top).toBeLessThanOrEqual(2.74);
  expect(layout.nameVisible).toBe(false);
  expect(layout.drawnLines).toEqual(layout.expectedLines);
  expect(layout.drawnLines.join(" ")).toBe(sentence);
  expect(layout.longTokenLines.every((part) => part.length <= 36)).toBe(true);
  expect(layout.longTokenLines.join("")).toBe("Z".repeat(180));
  await mkdir(".artifacts", { recursive: true });
  await page
    .locator("#long-voice-preview")
    .screenshot({ path: ".artifacts/npc-voice-long-bubble.png" });
  await page.evaluate(() => (window as any).__longVoicePreview.dispose());
});
