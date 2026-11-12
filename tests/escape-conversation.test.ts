import assert from "node:assert/strict";
import test from "node:test";
import type { Actor, Game } from "../src/model";
import type {
  EscapeState,
  Fact,
  NpcSocial,
  Utterance,
  VoiceIdentity,
} from "../src/escape-types";
import {
  conversationRequest,
  fallbackConverseLine,
  handleConverseAnswer,
  nextResponder,
  recordUtterance,
  resolveAddressee,
  utterancesFor,
  visibleFactsFor,
} from "../src/escape-conversation";
import { npcVoiceSlot } from "../src/voice-identity";

const SECRET_TITLE = "Project Halcyon containment failure";
const SECRET_PREMISE =
  "The basement reactor was venting for six hours before anyone noticed.";
const SECRET_OMEN = "A smell of hot copper drifts through the loading bay.";

function fact(
  id: string,
  text: string,
  visibility: Fact["visibility"] = ["public"],
): Fact {
  return {
    id,
    text,
    subject: { kind: "object", id: "hatch" },
    source: "design",
    visibility,
    at: 0,
    durable: true,
  };
}

function social(canDetain: boolean): NpcSocial {
  return {
    alarm: 0.2,
    awareness: [],
    player: { relationship: "colleague", suspicion: 0.3, history: [] },
    canDetain,
    hasRadio: false,
    checkBackSeconds: 120,
  } as NpcSocial;
}

function npc(
  id: string,
  name: string,
  x: number,
  y: number,
  canDetain = false,
  socialValue = 0.6,
): Actor {
  return {
    id,
    name,
    role: id === "npc-guard" ? "security guard" : "janitor",
    x,
    y,
    floor: 0,
    yaw: 0,
    alive: true,
    escaped: false,
    survivor: true,
    risk: 0.4,
    social: socialValue,
    skill: 3,
    socialState: social(canDetain),
  } as unknown as Actor;
}

function makeGame(): Game {
  const survivors: Actor[] = [
    npc("npc-guard", "Guard Ramos", 2, 2, true),
    npc("npc-jan", "Ana Silva", 4, 2),
  ];
  const escape = {
    version: 1,
    persona: { name: "Alex", role: "night auditor", backstory: "" },
    catastrophe: {
      id: "halcyon",
      title: SECRET_TITLE,
      premise: SECRET_PREMISE,
      origin: { areaId: "office" },
      behaviours: [],
      timeline: { graceSeconds: 60, phases: [] },
      omens: [{ at: 0, text: SECRET_OMEN, kind: "smell" }],
      publicStory: SECRET_PREMISE,
    },
    ledger: {
      facts: [
        fact("fact-hatch", "The rocket hatch needs a flight-crew badge."),
        fact("fact-vault", "The vault code is 41-12.", ["npc:npc-guard"]),
        fact("fact-secret", "Hidden: the sample is infectious.", ["hidden"]),
      ] satisfies Fact[],
      journal: [],
      seq: 3,
    },
    tasks: [],
    areas: { start: "office", current: "office", areas: {}, portals: [] },
    voices: {
      playerGender: "female",
      player: "bright-f",
      pa: "announcer",
      npcs: {},
    } as VoiceIdentity,
    announcements: [],
    loop: 0,
    log: [],
    areaStore: {},
    prompts: [],
    roomPower: {},
  } as unknown as EscapeState;
  return {
    id: "game-escape-test",
    seed: 42,
    time: 12,
    status: "playing",
    paused: false,
    settings: { volume: 0.8, npcVoices: true },
    survivors,
    floors: [{ id: 0, rooms: [{ x: 0, y: 0, w: 20, h: 20 }] }],
    escape,
  } as unknown as Game;
}

function human(): Actor {
  return {
    id: "human",
    name: "Alex",
    x: 2,
    y: 3,
    floor: 0,
    yaw: 0,
    alive: true,
    escaped: false,
    survivor: true,
  } as unknown as Actor;
}

function utterance(
  id: string,
  speakerId: string,
  text: string,
  extra: Partial<Utterance> = {},
): Utterance {
  return {
    id,
    speakerId,
    text,
    at: 10,
    floor: 0,
    x: 2,
    y: 2,
    heardBy: [],
    ...extra,
  };
}

test("conversation payload never carries catastrophe text", () => {
  const g = makeGame();
  recordUtterance(
    g,
    utterance("u-1", "pa", "Attention: the north stairwell is closed.", {
      heardBy: ["npc-guard"],
    }),
  );
  const payload = conversationRequest(g, "npc-guard", {
    reason: "greet the player in passing",
    addresseeId: "human",
  });
  const serialized = JSON.stringify(payload);
  for (const secret of [SECRET_TITLE, SECRET_PREMISE, SECRET_OMEN])
    assert.equal(serialized.includes(secret), false);
  assert.equal(payload.reason, "greet the player in passing");
  assert.equal(payload.speaker.id, "npc-guard");
  assert.equal(payload.heard.length, 1);
  assert.equal(
    payload.heard[0]!.text,
    "Attention: the north stairwell is closed.",
  );
});

test("visible facts are filtered to what this NPC can see", () => {
  const g = makeGame();
  const guard = visibleFactsFor(g, g.survivors[0]!);
  const janitor = visibleFactsFor(g, g.survivors[1]!);
  assert.deepEqual(
    guard.map((line) => line.split(":")[0]),
    ["fact-hatch", "fact-vault"],
  );
  assert.deepEqual(
    janitor.map((line) => line.split(":")[0]),
    ["fact-hatch"],
  );
  const payload = conversationRequest(g, "npc-jan");
  assert.equal(payload.visibleFacts.length, 1);
  assert.equal(payload.reason, "reply");
  assert.equal(payload.addressee, null);
});

test("handleConverseAnswer rejects detain without authority and applies a valid one", () => {
  const g = makeGame();
  const janitor = g.survivors[1]!;
  const rejected = handleConverseAnswer(g, {
    speakerId: "npc-jan",
    text: "I am not detaining anyone.",
    outcome: { kind: "detain" },
  });
  assert.ok(rejected);
  assert.equal(rejected.outcome.kind, "none");
  assert.equal(typeof rejected.rejected, "string");
  assert.deepEqual(
    janitor.socialState!.player.history.map((record) => record.kind),
    ["refused"],
  );

  const guard = g.survivors[0]!;
  const accepted = handleConverseAnswer(g, {
    speakerId: "npc-guard",
    text: "Stay where you are.",
    outcome: { kind: "detain" },
  });
  assert.ok(accepted);
  assert.equal(accepted.outcome.kind, "detain");
  assert.equal(accepted.rejected, undefined);
  assert.deepEqual(
    guard.socialState!.player.history.map((record) => record.kind),
    ["asked"],
  );
  assert.equal(
    handleConverseAnswer(g, {
      speakerId: "human",
      text: "I detain myself.",
      outcome: { kind: "detain" },
    }),
    undefined,
  );
});

test("resolveAddressee uses facing, then a name", () => {
  const east = npc("npc-jan", "Ana Silva", 6, 2);
  const west = npc("npc-guard", "Guard Ramos", -3, 2);
  const facingEast = resolveAddressee({ x: 2, y: 2, yaw: 0 }, "Quiet down.", [
    east,
    west,
  ]);
  assert.equal(facingEast, "npc-jan");
  const facingWest = resolveAddressee(
    { x: 2, y: 2, yaw: Math.PI },
    "Quiet down.",
    [east, west],
  );
  assert.equal(facingWest, "npc-guard");
  assert.equal(
    resolveAddressee({ x: 2, y: 2, yaw: 0 }, "Ramos, a word?", [east, west]),
    "npc-guard",
  );
});

test("nextResponder prefers the addressee", () => {
  const g = makeGame();
  g.escape!.loop = 0;
  const line = recordUtterance(
    g,
    utterance("u-2", "human", "Ana, can you read the hatch plate?", {
      addressee: "npc-jan",
      heardBy: ["npc-guard", "npc-jan"],
    }),
  );
  assert.deepEqual(line.sort(), ["npc-guard", "npc-jan"]);
  g.survivors.push(human());
  const chosen = nextResponder(g, utterancesFor(g)[0]!, 12, () => 0.99);
  assert.equal(chosen, "npc-jan");
});

test("utterance bookkeeping keeps only the newest forty", () => {
  const g = makeGame();
  for (let index = 0; index < 45; index++)
    recordUtterance(
      g,
      utterance(`u-${index}`, "pa", `Announcement ${index}`, {
        heardBy: ["npc-guard"],
      }),
    );
  const kept = utterancesFor(g);
  assert.equal(kept.length, 40);
  assert.equal(kept[0]!.text, "Announcement 5");
  assert.equal(kept[39]!.text, "Announcement 44");
});

test("voices are stable across calls and across a restart", () => {
  const identity: VoiceIdentity = {
    playerGender: "female",
    player: "warm-m",
    pa: "announcer",
    npcs: {},
  };
  const first = npcVoiceSlot(identity, "npc-guard", 7);
  const second = npcVoiceSlot(identity, "npc-guard", 7);
  assert.equal(first, second);
  const restarted = structuredClone(identity);
  assert.equal(npcVoiceSlot(restarted, "npc-guard", 999), first);
});

test("fallback lines are deterministic and carry no outcome", () => {
  const g = makeGame();
  const a = fallbackConverseLine(g, "npc-jan", 12);
  const b = fallbackConverseLine(g, "npc-jan", 12);
  assert.deepEqual(a, b);
  assert.equal(a.outcome.kind, "none");
  assert.ok(a.text.length > 0);
  assert.notDeepEqual(fallbackConverseLine(g, "npc-jan", 13), a);
});
