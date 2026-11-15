import { isGhost } from "./ghost";
import { human } from "./engine";
import type { Game } from "./model";

/** Page-side facts about the human's ghost. Pure: no DOM, no page state. */

/** True once the human's run ended and its ghost walks the world. */
export function ghostActive(g: Game): boolean {
  return isGhost(human(g));
}

/** Where the dead body lies, when it lies on the given floor. An escaped human
 * leaves no body behind, so it has none on any floor. */
export function ghostBody(
  g: Game,
  floor: number,
): { x: number; y: number } | undefined {
  const body = human(g).ghost?.body;
  if (!body || body.floor !== floor) return undefined;
  return { x: body.x, y: body.y };
}

/** The end-of-run card text that explains being a ghost. */
export function ghostNotice(): { title: string; description: string } {
  return {
    title: "You are a ghost.",
    description:
      "Nobody can see or hear you, and you cannot touch anything. Walk where you like.",
  };
}
