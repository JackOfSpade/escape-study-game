/**
 * Recent catastrophes this player has met (docs/ESCAPE_REDESIGN.md section 3).
 *
 * Kept like the environment history in src/run-designer.ts: a small bounded
 * list in localStorage, newest first, read defensively. Each entry records
 * only the mechanism (title, behaviour kinds, hunter silhouette and spawn
 * mode, hazard media, perception triggers) and never the premise, omens or
 * public story, so the sealed truth of an old game is not kept around.
 */
import { CATASTROPHE_ENUMS } from "./catastrophe-schema.mjs";
import type { BehaviourKind, CatastropheSpec } from "./escape-types";
import { isRecord } from "./records";

export const CATASTROPHE_HISTORY_KEY = "dead-air-catastrophe-history-v1";
/** How many catastrophes are kept and sent as `recent`. */
export const CATASTROPHE_HISTORY_LIMIT = 8;
/** A new answer whose signature matches one of this many is asked for again. */
export const CATASTROPHE_REPEAT_WINDOW = 3;

export interface CatastropheSummary {
  title: string;
  /** Behaviour kinds, sorted; a kind appears once per behaviour. */
  kinds: BehaviourKind[];
  /** One per hunter behaviour, sorted by silhouette then spawn. */
  hunters: { silhouette: string; spawn: string }[];
  /** Hazard media, sorted. */
  media: string[];
  /** Perception-rule triggers, sorted. */
  triggers: string[];
}

const KINDS: readonly string[] = [
  "hunter",
  "hazard",
  "perception-rule",
  "collapse",
];
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const hunterKey = (h: { silhouette: string; spawn: string }) =>
  `${h.silhouette}/${h.spawn}`;

/** The mechanism of a valid spec, without any of its prose but the title. */
export function summarizeCatastrophe(
  spec: CatastropheSpec,
): CatastropheSummary {
  const kinds: BehaviourKind[] = [],
    hunters: CatastropheSummary["hunters"] = [],
    media: string[] = [],
    triggers: string[] = [];
  for (const behaviour of spec.behaviours) {
    kinds.push(behaviour.kind);
    if (behaviour.kind === "hunter")
      hunters.push({
        silhouette: behaviour.body.silhouette,
        spawn: behaviour.spawn,
      });
    else if (behaviour.kind === "hazard") media.push(behaviour.medium);
    else if (behaviour.kind === "perception-rule")
      triggers.push(behaviour.trigger);
  }
  return {
    title: spec.title.trim().slice(0, 80),
    kinds: kinds.sort(compare),
    hunters: hunters.sort((a, b) => compare(hunterKey(a), hunterKey(b))),
    media: media.sort(compare),
    triggers: triggers.sort(compare),
  };
}

/** Sorted behaviour kinds, plus silhouette and spawn for each hunter. Two
 * catastrophes with the same signature are the same threat renamed. */
export function catastropheSignature(summary: CatastropheSummary): string {
  return [summary.kinds.join("+"), ...summary.hunters.map(hunterKey)].join("|");
}

/** True when the summary repeats one of the newest catastrophes in `recent`. */
export function repeatsRecent(
  summary: CatastropheSummary,
  recent: readonly CatastropheSummary[],
): boolean {
  const signature = catastropheSignature(summary);
  return recent
    .slice(0, CATASTROPHE_REPEAT_WINDOW)
    .some((entry) => catastropheSignature(entry) === signature);
}

const stringsFrom = (value: unknown, allowed: readonly string[]) =>
  Array.isArray(value) &&
  value.length <= 3 &&
  value.every((item) => typeof item === "string" && allowed.includes(item))
    ? (value as string[])
    : undefined;

/** One stored entry, or undefined when it is malformed. Unknown fields (and
 * so any prose an old or edited entry might carry) are dropped. */
function parseSummary(value: unknown): CatastropheSummary | undefined {
  if (!isRecord(value)) return undefined;
  const { title } = value;
  if (typeof title !== "string" || !title.trim() || title.length > 80)
    return undefined;
  const kinds = stringsFrom(value.kinds, KINDS),
    media = stringsFrom(value.media, CATASTROPHE_ENUMS.media),
    triggers = stringsFrom(value.triggers, CATASTROPHE_ENUMS.triggers);
  if (!kinds?.length || !media || !triggers) return undefined;
  if (!Array.isArray(value.hunters) || value.hunters.length > 3)
    return undefined;
  const hunters: CatastropheSummary["hunters"] = [];
  for (const hunter of value.hunters) {
    if (
      !isRecord(hunter) ||
      typeof hunter.silhouette !== "string" ||
      !CATASTROPHE_ENUMS.silhouettes.includes(hunter.silhouette) ||
      typeof hunter.spawn !== "string" ||
      !CATASTROPHE_ENUMS.spawns.includes(hunter.spawn)
    )
      return undefined;
    hunters.push({ silhouette: hunter.silhouette, spawn: hunter.spawn });
  }
  return {
    title: title.trim(),
    kinds: [...kinds].sort(compare) as BehaviourKind[],
    hunters: hunters.sort((a, b) => compare(hunterKey(a), hunterKey(b))),
    media: [...media].sort(compare),
    triggers: [...triggers].sort(compare),
  };
}

/** Malformed entries are dropped; the list is never longer than the limit. */
export function parseCatastropheHistory(value: unknown): CatastropheSummary[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(parseSummary)
    .filter((entry): entry is CatastropheSummary => !!entry)
    .slice(0, CATASTROPHE_HISTORY_LIMIT);
}

/** The newest catastrophes first. Empty without storage (tests, Node tools). */
export function recentCatastrophes(): CatastropheSummary[] {
  try {
    return parseCatastropheHistory(
      JSON.parse(localStorage.getItem(CATASTROPHE_HISTORY_KEY) ?? "[]"),
    );
  } catch {
    return [];
  }
}

/** Put an accepted catastrophe at the front, keeping the newest eight. */
export function rememberCatastrophe(spec: CatastropheSpec): void {
  try {
    const next = summarizeCatastrophe(spec);
    localStorage.setItem(
      CATASTROPHE_HISTORY_KEY,
      JSON.stringify(
        [next, ...recentCatastrophes()].slice(0, CATASTROPHE_HISTORY_LIMIT),
      ),
    );
  } catch {
    // History is a hint for the next game; a full or missing store loses nothing else.
  }
}
