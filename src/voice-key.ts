import type { EscapeState } from "./escape-types";

/**
 * Key of an NPC's voice in `EscapeState.voices.npcs`. NPCs of the start area
 * use their actor id; NPCs of a generated area reuse generator ids (npc-1…),
 * so their key is prefixed with the area to give each person their own voice.
 */
export function npcVoiceKey(
  escape: Pick<EscapeState, "areas">,
  areaId: string | undefined,
  actorId: string,
): string {
  const start = escape.areas?.start ?? "start";
  const area = areaId ?? start;
  return area === start ? actorId : `${area}:${actorId}`;
}
