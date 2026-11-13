import assert from "node:assert/strict";
import test from "node:test";
import type { VoiceIdentity } from "../src/escape-types";
import { NPC_VOICE_GROUPS, NPC_VOICE_SLOTS } from "../src/npc-voice";
import {
  drawVoiceIdentity,
  genderOfSlot,
  isVoiceIdentity,
  keepVoicesOnRestart,
  npcVoiceSlot,
} from "../src/voice-identity";

const ALL: readonly string[] = [...NPC_VOICE_SLOTS];
const male: readonly string[] = [...NPC_VOICE_GROUPS.male];
const female: readonly string[] = [...NPC_VOICE_GROUPS.female];

function identity(overrides: Partial<VoiceIdentity> = {}): VoiceIdentity {
  return {
    playerGender: "female",
    player: "bright",
    pa: "steady",
    npcs: {},
    ...overrides,
  };
}

test("drawVoiceIdentity is deterministic for a seed", () => {
  for (const gender of ["male", "female"] as const) {
    const group = gender === "male" ? male : female;
    for (let seed = 0; seed < 20; seed++) {
      const drawn = drawVoiceIdentity(gender, seed);
      assert.deepEqual(drawVoiceIdentity(gender, seed), drawn);
      assert.equal(drawn.playerGender, gender);
      assert.deepEqual(drawn.npcs, {});
      assert.ok(
        group.includes(drawn.player),
        `player ${drawn.player} belongs to the ${gender} group`,
      );
      assert.ok(ALL.includes(drawn.pa), `pa ${drawn.pa} is a real slot`);
      assert.notEqual(drawn.pa, drawn.player);
      assert.equal(genderOfSlot(drawn.player), gender);
    }
  }
});

test("drawVoiceIdentity varies across seeds", () => {
  for (const gender of ["male", "female"] as const) {
    const players = new Set<string>();
    const pas = new Set<string>();
    for (let seed = 0; seed < 40; seed++) {
      const drawn = drawVoiceIdentity(gender, seed);
      players.add(drawn.player);
      pas.add(drawn.pa);
    }
    assert.ok(players.size > 1, `${gender} players vary`);
    assert.ok(pas.size > 1, `${gender} PA voices vary`);
  }
});

test("npcVoiceSlot is deterministic and then frozen", () => {
  for (const gender of [undefined, "male", "female"] as const) {
    const first = identity();
    const second = identity();
    const slot = npcVoiceSlot(first, "npc-ortiz", 99, gender);
    assert.ok(ALL.includes(slot), `${slot} is a real slot`);
    assert.equal(npcVoiceSlot(second, "npc-ortiz", 99, gender), slot);
    assert.equal(first.npcs["npc-ortiz"], slot);
    if (gender) assert.equal(genderOfSlot(slot), gender);
  }
});

test("an assigned NPC voice never changes, whatever the seed", () => {
  const voices = identity();
  const original = npcVoiceSlot(voices, "npc-ortiz", 1, "female");
  assert.equal(npcVoiceSlot(voices, "npc-ortiz", 2, "female"), original);
  assert.equal(npcVoiceSlot(voices, "npc-ortiz", 777777, "male"), original);
  assert.equal(npcVoiceSlot(voices, "npc-ortiz", 0), original);
  assert.equal(voices.npcs["npc-ortiz"], original);
  assert.equal(voices.player, "bright");
  assert.equal(Object.keys(voices.npcs).length, 1);
});

test("NPC slots avoid the player and other NPCs while the group allows", () => {
  const voices = identity();
  const assigned = new Set<string>();
  for (let index = 0; index < female.length - 1; index++)
    assigned.add(npcVoiceSlot(voices, `npc-${index}`, index, "female"));
  assert.equal(assigned.size, female.length - 1);
  assert.equal(assigned.has(voices.player), false);
  for (const slot of assigned) assert.equal(genderOfSlot(slot), "female");
  assert.deepEqual(
    [...assigned].sort(),
    female.filter((slot) => slot !== voices.player).sort(),
    "every other slot in the group is used before any reuse",
  );
  const crowded = npcVoiceSlot(voices, "npc-latecomer", 3, "female");
  assert.equal(crowded, voices.player);
  assert.equal(voices.npcs["npc-latecomer"], crowded);
});

test("a full group falls back to reusing a slot", () => {
  const voices = identity();
  const assigned = new Set<string>();
  for (let index = 0; index < male.length; index++)
    assigned.add(npcVoiceSlot(voices, `npc-${index}`, index * 13, "male"));
  assert.deepEqual([...assigned].sort(), [...male].sort());
  const reused = npcVoiceSlot(voices, "npc-latecomer", 31, "male");
  assert.ok(male.includes(reused));
  assert.equal(assigned.has(reused), true);
  assert.equal(voices.npcs["npc-latecomer"], reused);
});

test("genderOfSlot names the gender of every slot", () => {
  for (const slot of male) assert.equal(genderOfSlot(slot), "male", slot);
  for (const slot of female) assert.equal(genderOfSlot(slot), "female", slot);
  for (const slot of ["", "alex", "STEADY", "steady ", "unknown"])
    assert.equal(genderOfSlot(slot), undefined, slot);
});

test("keepVoicesOnRestart copies every voice unchanged", () => {
  const voices = identity({
    playerGender: "male",
    player: "low",
    pa: "soft",
    npcs: { "npc-ortiz": "gruff", "npc-maya": "warm" },
  });
  const kept = keepVoicesOnRestart(voices);
  assert.deepEqual(kept, voices);
  assert.notEqual(kept, voices);
  assert.notEqual(kept.npcs, voices.npcs);
  kept.npcs["npc-ortiz"] = "dry";
  assert.equal(voices.npcs["npc-ortiz"], "gruff");
  assert.equal(npcVoiceSlot(kept, "npc-ortiz", 5, "male"), "dry");
});

test("isVoiceIdentity accepts real identities and rejects broken shapes", () => {
  assert.equal(isVoiceIdentity(drawVoiceIdentity("female", 3)), true);
  assert.equal(isVoiceIdentity(identity()), true);
  assert.equal(
    isVoiceIdentity(identity({ npcs: { "npc-ortiz": "gruff", pa: "soft" } })),
    true,
  );
  const bad: unknown[] = [
    undefined,
    null,
    0,
    "",
    "voice",
    [],
    {},
    { ...identity(), playerGender: "other" },
    { ...identity(), player: "" },
    { ...identity(), player: "alex" },
    { ...identity(), pa: "unknown" },
    { ...identity(), npcs: { "npc-ortiz": "alex" } },
    { ...identity(), npcs: { "npc-ortiz": 7 } },
    { ...identity(), npcs: [] },
    { ...identity(), npcs: null },
    { playerGender: "male", player: "steady", pa: "low" },
  ];
  for (const value of bad)
    assert.equal(isVoiceIdentity(value), false, JSON.stringify(value));
});
