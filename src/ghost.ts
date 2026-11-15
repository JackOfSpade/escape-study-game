import { jumpElevated, stepElevated } from "./elevated-physics";
import type { Input } from "./engine";
import type { Actor, Game } from "./model";
import { physicsElevated } from "./physics";
import { move } from "./spatial";
import {
  advanceStairs,
  ensureWalkingBody,
  enterCityStairBase,
  enterStairs,
  settleElevated,
} from "./stair-travel";

/** The human after its run ended walks the world as a ghost. */
export function isGhost(a: Actor): boolean {
  return !!a.ghost;
}

/**
 * Turns the human into a ghost once its run ended. Idempotent: the death
 * position is captured exactly once, on the first tick after the status
 * changed, and the run's outcome (alive, escaped, hp, downAt) is untouched.
 */
export function beginGhost(g: Game): void {
  if (g.status !== "dead" && g.status !== "escaped") return;
  const a = g.survivors[0];
  if (!a || a.ghost) return;
  a.ghost =
    g.status === "dead" ? { body: { x: a.x, y: a.y, floor: a.floor } } : {};
  delete a.grip;
  delete a.handling;
  delete a.vault;
  delete a.target;
  a.path = [];
}

/** One tick of ghost movement: walking, stairs, jumping and falling, but no
 * escort, vault, furniture handling, noise or damage. */
export function ghostStep(g: Game, a: Actor, input: Input, dt: number): void {
  if (!isGhost(a)) return;
  // A ghost never drags or pushes anything; its hands pass through the world.
  delete a.grip;
  delete a.handling;
  if (input.stairWalk) enterCityStairBase(g, a, input);
  if (!a.elevated || a.elevated.grounded)
    enterStairs(g, a, !!input.stairWalk || !!a.elevated, input);
  if (
    (input.stairWalk || input.jump) &&
    a.stairTravel &&
    a.stairTravel.walked === undefined
  )
    a.stairTravel.walked = 0;
  ensureWalkingBody(g, a);
  if (input.jump) jumpElevated(g, a);
  const walking = a.stairTravel?.walked !== undefined,
    // Walking out of the staircase cancels a flight; walking inside it does not.
    landed = !walking && !a.elevated && advanceStairs(g, a) && !a.stairTravel;
  if (a.elevated) {
    const magnitude = Math.hypot(input.x, input.y);
    // Falling still moves the ghost, but it never lands on anyone's head with
    // damage: fall damage is reserved for the living.
    if (magnitude)
      a.heading = { x: input.x / magnitude, y: input.y / magnitude };
    physicsElevated(g, (elapsed) => {
      if (!a.elevated || !isGhost(a)) return;
      const result = stepElevated(g, a, input, elapsed);
      settleElevated(g, a, result.surface);
    });
  } else if (landed) {
    /* Settle on the new floor's landing before taking input again. */
  } else if (input.x || input.y) {
    const n = Math.hypot(input.x, input.y);
    a.heading = { x: input.x / n, y: input.y / n };
    // Plain collision movement: walls, furniture and door leaves stop the
    // ghost, and nothing it walks into is ever moved.
    move(
      g.floors[a.floor],
      a,
      (input.x / n) * a.speed * dt,
      (input.y / n) * a.speed * dt,
    );
  }
}
