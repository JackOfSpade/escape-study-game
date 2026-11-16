import type { Game } from "./model";

interface NpcSpeechBubble {
  id: string;
  actorId: string;
  text: string;
  until: number;
}
// Presentation only. Audio, transient text and request contexts never enter saves.
const bubbles = new WeakMap<Game, Map<string, NpcSpeechBubble>>();
export function showNpcSpeechBubble(game: Game, bubble: NpcSpeechBubble) {
  let active = bubbles.get(game);
  if (!active) {
    active = new Map();
    bubbles.set(game, active);
  }
  active.set(bubble.actorId, { ...bubble });
}
export function npcSpeechBubble(game: Game, actorId: string) {
  const active = bubbles.get(game),
    bubble = active?.get(actorId);
  if (bubble && bubble.until > game.time) return bubble;
  active?.delete(actorId);
  return undefined;
}
export function clearNpcSpeechBubble(game: Game, actorId: string, id?: string) {
  const active = bubbles.get(game);
  if (!id || active?.get(actorId)?.id === id) active?.delete(actorId);
}
export function clearNpcSpeechBubbles(game: Game) {
  bubbles.delete(game);
}

export function speechLines(text: string, maxChars = 34) {
  const lines: string[] = [];
  let line = "";
  for (let word of text.split(/\s+/)) {
    if (word.length > maxChars && line) {
      lines.push(line);
      line = "";
    }
    while (word.length > maxChars) {
      lines.push(word.slice(0, maxChars));
      word = word.slice(maxChars);
    }
    if (line && line.length + word.length + 1 > maxChars) {
      lines.push(line);
      line = "";
    }
    line += (line ? " " : "") + word;
  }
  if (line) lines.push(line);
  return lines;
}
