/**
 * Readable documents, signs and screens in front of the player
 * (docs/ESCAPE_REDESIGN.md section 4, the `read` engagement).
 *
 * `observableSceneDetails` is the authored source of truth for what a nearby
 * actor can actually see; this module narrows that list to the single thing
 * the player is looking at, so pressing read never guesses.
 */
import type { Game } from "./model";
import {
  observableSceneDetails,
  type SceneObservation,
} from "./scene-observations";

/** A read engagement's own description of what is on the page. */
export interface Readable {
  /** Stable id of the observation (surface/prop id, or a position hash). */
  id: string;
  /** Short name or caption title of the thing; 'writing' when unnamed. */
  label: string;
  /** The readable text, trimmed to 600 characters. */
  text: string;
}

/** Half-angle of the read cone, in radians. */
const CONE_HALF_ANGLE = (35 * Math.PI) / 180;

/** Furthest point that still counts as "in front of you", in tiles. */
const READ_RANGE = 2.5;

/** Longest text a single read engagement carries. */
const MAX_READ_TEXT = 600;

/** Absorbable difference between two cone angles (radians). */
const ANGLE_EPSILON = 1e-9;

/** An angle folded into (-pi, pi]. */
function normalized(angle: number): number {
  let value = angle % (Math.PI * 2);
  if (value > Math.PI) value -= Math.PI * 2;
  if (value <= -Math.PI) value += Math.PI * 2;
  return value;
}

/** Stable id: the observation's own id when authored, else its position. */
function readingId(detail: SceneObservation, floor: number): string {
  const own = typeof detail.id === "string" ? detail.id.trim() : "";
  if (own.length > 0) return own;
  return `${floor}:${Math.round(detail.x * 10)}:${Math.round(detail.y * 10)}`;
}

/** Short label of the observation; 'writing' when it has no title. */
function readingLabel(detail: SceneObservation): string {
  const title =
    typeof detail.title === "string" ? detail.title.trim().slice(0, 80) : "";
  return title.length > 0 ? title : "writing";
}

/** The readable text, trimmed and capped at 600 characters. */
function readingText(detail: SceneObservation): string {
  const text = typeof detail.text === "string" ? detail.text.trim() : "";
  return text.length > MAX_READ_TEXT ? text.slice(0, MAX_READ_TEXT) : text;
}

/**
 * The nearest-angle readable the human is facing: within 2.5 tiles and inside
 * a 35-degree half-angle cone around `yaw` (0 = +x, atan2 convention).
 * Equal angles prefer the nearer detail. Pass `details` to override the scene
 * observations (tests and callers that already collected them).
 */
export function readableInFront(
  g: Game,
  yaw: number,
  details?: readonly SceneObservation[],
): Readable | undefined {
  const human = g.survivors[0];
  if (!human || !Number.isFinite(yaw)) return undefined;
  const candidates = details ?? observableSceneDetails(g, human, 12);
  let best: { readable: Readable; angle: number; distance: number } | undefined;
  for (const detail of candidates) {
    if (!detail || !Number.isFinite(detail.x) || !Number.isFinite(detail.y))
      continue;
    const dx = detail.x - human.x;
    const dy = detail.y - human.y;
    const distance = Math.hypot(dx, dy);
    if (distance > READ_RANGE) continue;
    const angle = Math.abs(normalized(Math.atan2(dy, dx) - yaw));
    if (angle > CONE_HALF_ANGLE) continue;
    const text = readingText(detail);
    if (text.length === 0) continue;
    const readable: Readable = {
      id: readingId(detail, human.floor),
      label: readingLabel(detail),
      text,
    };
    if (
      !best ||
      angle < best.angle - ANGLE_EPSILON ||
      (Math.abs(angle - best.angle) <= ANGLE_EPSILON &&
        distance < best.distance)
    )
      best = { readable, angle, distance };
  }
  return best?.readable;
}
