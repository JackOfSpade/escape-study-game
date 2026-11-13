import assert from "node:assert/strict";
import { test } from "node:test";
import { fallbackCatastrophe } from "../src/catastrophe";
import { epiloguePacket, fallbackEpilogue } from "../src/escape-log";
import {
  endLoop,
  epilogueForNewGame,
  prepareCatastrophe,
  resetEscapeRequest,
  setEscapeRequest,
} from "../src/escape-prepare";
import type { EscapeEvent } from "../src/escape-types";
import type { Game } from "../src/model";

const VALID_TEXT =
  "The pump room flooded exactly as the premise said, and Dana got out alive.";

const stub = (id: string, name: string) => ({
  id,
  name,
  brief: `The ${name.toLowerCase()}.`,
  state: "ready" as const,
  seed: 1,
});

const makeGame = () => {
  const fallback = fallbackCatastrophe(7, "dorm");
  const game = {
    id: "game-1",
    time: 321,
    design: {
      design: {
        title: "The Quiet Colony",
        premise: "A research colony beside a frozen lake.",
        opening: "You wake in the dormitory.",
      },
    },
    escape: {
      version: 1,
      persona: {
        name: "Dana",
        role: "engineer",
        backstory: "Ten years on the colony.",
      },
      catastrophe: fallback,
      loop: 2,
      log: [] as EscapeEvent[],
      areas: {
        start: "dorm",
        current: "dorm",
        areas: { dorm: stub("dorm", "Dormitory"), pad: stub("pad", "Pad") },
        portals: [],
      },
      epilogue: undefined as
        { loop: number; text: string; writtenAt: number } | undefined,
    },
  };
  return { game: game as unknown as Game, live: game, fallback };
};

type Call = { operation: string; payload: unknown };

const fake = (answer: (operation: string) => unknown) => {
  const calls: Call[] = [];
  setEscapeRequest(async (operation, payload) => {
    calls.push({ operation, payload });
    return answer(operation);
  });
  return calls;
};

const validSpec = (areaId = "dorm") => fallbackCatastrophe(11, areaId);

test("prepareCatastrophe replaces the fallback with a valid spec", async () => {
  const { game, live, fallback } = makeGame();
  const spec = validSpec();
  const calls = fake(() => ({ requestId: "cat-game-1", spec }));
  await prepareCatastrophe(game);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.operation, "escape-catastrophe");
  assert.equal(live.escape.catastrophe, spec);
  assert.notEqual(live.escape.catastrophe, fallback);
  resetEscapeRequest();
});

test("prepareCatastrophe ignores an invalid spec", async () => {
  const { game, live, fallback } = makeGame();
  fake(() => ({ spec: { ...validSpec(), title: "x".repeat(81) } }));
  await prepareCatastrophe(game);
  assert.deepEqual(live.escape.catastrophe, fallback);
  resetEscapeRequest();
});

test("prepareCatastrophe keeps the fallback when the request rejects", async () => {
  const { game, live, fallback } = makeGame();
  fake(() => {
    throw Error("bridge offline");
  });
  await prepareCatastrophe(game);
  assert.deepEqual(live.escape.catastrophe, fallback);
  resetEscapeRequest();
});

test("prepareCatastrophe never sends the previous spec premise", async () => {
  const { game, fallback } = makeGame();
  const calls = fake(() => ({ spec: validSpec() }));
  await prepareCatastrophe(game);
  const sent = JSON.stringify(calls[0]!.payload);
  assert.equal(sent.includes(fallback.premise), false);
  assert.equal(sent.includes(fallback.omens[0]!.text), false);
  const payload = calls[0]!.payload as {
    requestId: string;
    areaIds: string[];
    setting: { title: string; premise: string; opening: string };
  };
  assert.equal(payload.requestId, "cat-game-1");
  assert.deepEqual(payload.areaIds, ["dorm", "pad"]);
  assert.deepEqual(payload.setting, {
    title: "The Quiet Colony",
    premise: "A research colony beside a frozen lake.",
    opening: "You wake in the dormitory.",
  });
  resetEscapeRequest();
});

test("endLoop logs the end once and the epilogue is written once", async () => {
  const { game, live } = makeGame();
  const calls = fake(() => ({ text: VALID_TEXT }));
  endLoop(game, "restarted");
  endLoop(game, "restarted");
  assert.equal(await epilogueForNewGame(game), VALID_TEXT);
  endLoop(game, "quit");
  assert.equal(
    calls.filter((c) => c.operation === "escape-epilogue").length,
    1,
  );
  const ends = live.escape.log.filter((e) => e.kind === "player-end");
  assert.equal(ends.length, 1);
  assert.deepEqual(ends[0], {
    at: 321,
    kind: "player-end",
    areaId: "dorm",
    text: "restarted",
  } as EscapeEvent);
  assert.deepEqual(live.escape.epilogue, {
    loop: 2,
    text: VALID_TEXT,
    writtenAt: 321,
  });
  const request = calls.find((c) => c.operation === "escape-epilogue")!;
  assert.equal(
    (request.payload as { requestId: string }).requestId,
    "epi-game-1-2",
  );
  resetEscapeRequest();
});

test("endLoop uses the deterministic epilogue when the answer is invalid", async () => {
  const { game, live } = makeGame();
  fake(() => ({ text: "too short" }));
  endLoop(game, "died");
  await epilogueForNewGame(game);
  const packet = epiloguePacket({
    spec: live.escape.catastrophe,
    log: live.escape.log,
    areas: live.escape.areas,
    persona: live.escape.persona,
    outcome: "died",
    endedAt: 321,
  });
  assert.equal(live.escape.epilogue!.text, fallbackEpilogue(packet));
  assert.equal(live.escape.epilogue!.loop, 2);
  resetEscapeRequest();
});

test("endLoop writes a quit epilogue for a restarted loop", async () => {
  const { game, live } = makeGame();
  fake(() => ({ text: "too short" }));
  endLoop(game, "restarted");
  await epilogueForNewGame(game);
  const packet = epiloguePacket({
    spec: live.escape.catastrophe,
    log: live.escape.log,
    areas: live.escape.areas,
    persona: live.escape.persona,
    outcome: "quit",
    endedAt: 321,
  });
  // the fallback prose reveals the mapped outcome through the player's fate
  assert.equal(live.escape.epilogue!.text, fallbackEpilogue(packet));
  assert.match(live.escape.epilogue!.text, /left the loop unfinished/);
  resetEscapeRequest();
});

test("epilogueForNewGame returns the stored text without a new request", async () => {
  const { game, live } = makeGame();
  live.escape.epilogue = { loop: 2, text: VALID_TEXT, writtenAt: 300 };
  const calls = fake(() => ({ text: "should not be used at all, ever." }));
  assert.equal(await epilogueForNewGame(game), VALID_TEXT);
  assert.equal(calls.length, 0);
  resetEscapeRequest();
});

test("epilogueForNewGame writes the epilogue now when none is pending", async () => {
  const { game, live } = makeGame();
  const calls = fake(() => ({ text: VALID_TEXT }));
  assert.equal(await epilogueForNewGame(game), VALID_TEXT);
  assert.equal(calls.length, 1);
  assert.equal(live.escape.epilogue!.loop, 2);
  // no player-end event is invented by an epilogue-only write
  assert.equal(live.escape.log.length, 0);
  resetEscapeRequest();
});

test("every prepare helper is a no-op without g.escape", async () => {
  const calls: Call[] = [];
  setEscapeRequest(async (operation, payload) => {
    calls.push({ operation, payload });
    return {};
  });
  const plain = {
    id: "game-2",
    time: 5,
    design: { design: {} },
  } as unknown as Game;
  await prepareCatastrophe(plain);
  endLoop(plain, "quit");
  assert.equal(await epilogueForNewGame(plain), undefined);
  assert.equal(calls.length, 0);
  resetEscapeRequest();
});
