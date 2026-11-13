import type { VoiceGender, VoiceIdentity } from "./escape-types";
import { NPC_VOICE_GROUPS } from "./npc-voice";

/**
 * Who speaks with which voice (docs/ESCAPE_REDESIGN.md sections 9 and 11).
 *
 * The player picks a gender at New game; the player and PA voices are drawn
 * then. Every NPC voice is fixed when the NPC is first created and stored on
 * the identity, so restarts keep it. Nothing here uses Math.random: the same
 * seed and actor always give the same slot.
 */

type Slot =
  | (typeof NPC_VOICE_GROUPS)["male"][number]
  | (typeof NPC_VOICE_GROUPS)["female"][number];

/** All fifteen narrator slots, in the speech service's order. */
const ALL_SLOTS: readonly Slot[] = [
  ...NPC_VOICE_GROUPS.male,
  ...NPC_VOICE_GROUPS.female,
];

const KNOWN_SLOTS = new Set<string>(ALL_SLOTS);

/** 32-bit FNV-1a over the given parts, locale independent. */
function voiceSeed(...parts: (string | number)[]): number {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    for (const char of `${part}\u0000`) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return hash >>> 0;
}

/** mulberry32, returning successive floats in [0, 1). */
function voiceRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<const T>(slots: readonly T[], random: () => number): T {
  return slots[Math.floor(random() * slots.length)]!;
}

function groupOf(gender: VoiceGender): readonly Slot[] {
  return gender === "male" ? NPC_VOICE_GROUPS.male : NPC_VOICE_GROUPS.female;
}

/** Draw the player and PA voices for a new game. */
export function drawVoiceIdentity(
  gender: VoiceGender,
  seed: number,
): VoiceIdentity {
  const random = voiceRandom(voiceSeed("identity", gender, seed));
  const player = pick(groupOf(gender), random);
  const others = ALL_SLOTS.filter((slot) => slot !== player);
  const pa = pick(others, random);
  return { playerGender: gender, player, pa, npcs: {} };
}

/**
 * The NPC's voice: fixed on first use and returned unchanged ever after, even
 * with a different seed. A fresh slot avoids the player and other NPCs when
 * the chosen group still has one; the PA slot may be shared.
 */
export function npcVoiceSlot(
  identity: VoiceIdentity,
  actorId: string,
  seed: number,
  gender?: VoiceGender,
): string {
  const fixed = identity.npcs[actorId];
  if (typeof fixed === "string" && fixed) return fixed;
  const random = voiceRandom(voiceSeed("npc", seed, actorId));
  const group: readonly Slot[] = gender
    ? groupOf(gender)
    : random() < 0.5
      ? NPC_VOICE_GROUPS.male
      : NPC_VOICE_GROUPS.female;
  const used = new Set(Object.values(identity.npcs));
  const spare = group.filter(
    (slot) => slot !== identity.player && !used.has(slot),
  );
  const unused = group.filter((slot) => !used.has(slot));
  const slot = pick(
    spare.length ? spare : unused.length ? unused : group,
    random,
  );
  identity.npcs[actorId] = slot;
  return slot;
}

/** The gender of the voice mapped to a slot, if the slot is one of the 15. */
export function genderOfSlot(slot: string): VoiceGender | undefined {
  if (NPC_VOICE_GROUPS.male.some((known) => known === slot)) return "male";
  if (NPC_VOICE_GROUPS.female.some((known) => known === slot)) return "female";
  return undefined;
}

/** Restart keeps every voice: the returned identity is an equal deep copy. */
export function keepVoicesOnRestart(identity: VoiceIdentity): VoiceIdentity {
  return {
    playerGender: identity.playerGender,
    player: identity.player,
    pa: identity.pa,
    npcs: { ...identity.npcs },
  };
}

function validSlot(value: unknown): value is Slot {
  return typeof value === "string" && KNOWN_SLOTS.has(value);
}

/** Shape guard for saved or untrusted voice data. */
export function isVoiceIdentity(x: unknown): x is VoiceIdentity {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const identity = x as Record<string, unknown>;
  if (identity.playerGender !== "male" && identity.playerGender !== "female")
    return false;
  if (!validSlot(identity.player) || !validSlot(identity.pa)) return false;
  const npcs = identity.npcs;
  if (!npcs || typeof npcs !== "object" || Array.isArray(npcs)) return false;
  return Object.values(npcs as Record<string, unknown>).every(validSlot);
}
