import { CONFIG, type Game } from "./model";
import { SWARM } from "./force-fields";
import { FIELD_PACING, initializeFieldPacing } from "./field-pacing";

/** Fresh playable runs give the learner a calm opening, bounded field durability
 * and slower world tempo. Movement and combat speeds stay responsive. */
interface PacingProfile {
  zombieGraceSeconds: number;
  swarmInterval: number;
  swarmBatch: number;
  swarmCap: number;
  npcThinkingScale: number;
  firstHelicopter: number;
  helicopterInterval: number;
}

export const STUDY_PACING: Readonly<PacingProfile> = Object.freeze({
  zombieGraceSeconds: FIELD_PACING.spawnGraceSeconds,
  swarmInterval: 3,
  swarmBatch: 1,
  swarmCap: 180,
  npcThinkingScale: 0.25,
  firstHelicopter: 480,
  helicopterInterval: 180,
});

/** Historical timing. Evaluated lazily so module import cycles through
 * force-fields/engine never observe an uninitialised SWARM binding. */
function legacyPacing(): PacingProfile {
  return {
    zombieGraceSeconds: CONFIG.spawnGraceSeconds,
    swarmInterval: SWARM.interval,
    swarmBatch: SWARM.batch,
    swarmCap: SWARM.cap,
    npcThinkingScale: 1,
    firstHelicopter: 240,
    helicopterInterval: CONFIG.helicopterInterval,
  };
}

/** `pacing` undefined (all historical saves/fixtures) keeps legacy timing. */
export function pacingProfile(
  g: Pick<Game, "pacing" | "design">,
): PacingProfile {
  return g.pacing === "study"
    ? g.design
      ? { ...STUDY_PACING, ...g.design.design.pacing }
      : STUDY_PACING
    : legacyPacing();
}
export function spawnGrace(g: Pick<Game, "pacing">) {
  return g.pacing === "study"
    ? STUDY_PACING.zombieGraceSeconds
    : CONFIG.spawnGraceSeconds;
}
/** Multiplier applied at every engine NPC thought increment. It scales world
 * progress only; `npcThinkingRate` remains the unscaled per-survivor rate. */
export function npcThinkingScale(g: Pick<Game, "pacing" | "design">) {
  return g.pacing === "study" ? pacingProfile(g).npcThinkingScale : 1;
}
export function helicopterInterval(g: Pick<Game, "pacing" | "design">) {
  return g.pacing === "study"
    ? pacingProfile(g).helicopterInterval
    : CONFIG.helicopterInterval;
}
/** Swarm cadence for force-field runs. */
export function swarmPacing(g: Pick<Game, "pacing" | "design">) {
  const p = pacingProfile(g);
  return { interval: p.swarmInterval, batch: p.swarmBatch, cap: p.swarmCap };
}

/** Convert a freshly created game to the study profile, rewriting the spawn
 * and first-pickup schedules consistently. Intended for time-0 games. */
export function applyStudyPacing(
  g: Game,
  depth = 1,
  blueprintPacing?: Partial<PacingProfile>,
) {
  g.pacing = "study";
  g.nextSpawn = Math.max(g.time, STUDY_PACING.zombieGraceSeconds);
  g.helicopter.next = Math.max(
    g.time,
    blueprintPacing?.firstHelicopter ?? pacingProfile(g).firstHelicopter,
  );
  initializeFieldPacing(g, depth);
  g.notice =
    "Three minutes before zombies arrive. Enter the building and find a study terminal.";
  return g;
}
