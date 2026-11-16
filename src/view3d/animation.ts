export interface Motion {
  x: number;
  y: number;
  time: number;
  hp: number;
  speed: number;
  phase: number;
  flinchUntil: number;
  deathAt?: number;
  attackCooldown?: number;
  strikeAt?: number;
}

/** A real engine attack restarts its cooldown. Observe that edge once and
 * retain a short view-only strike even while the attacker is standing still. */
export function zombieStrike(motion: Motion, cooldown: number, time: number) {
  if (
    motion.attackCooldown !== undefined &&
    cooldown > motion.attackCooldown + 1e-6
  )
    motion.strikeAt = time;
  motion.attackCooldown = cooldown;
  if (motion.strikeAt === undefined || motion.hp <= 0) return 0;
  return Math.max(0, 1 - Math.max(0, time - motion.strikeAt) / 0.34);
}

export function createMotion(
  x: number,
  y: number,
  time: number,
  hp: number,
): Motion {
  return { x, y, time, hp, speed: 0, phase: 0, flinchUntil: 0 };
}

/** Advance feet by distance actually travelled, never by requested input. */
export function updateMotion(
  motion: Motion,
  x: number,
  y: number,
  time: number,
  hp: number,
) {
  const elapsed = time - motion.time;
  if (elapsed > 0) {
    const distance = Math.hypot(x - motion.x, y - motion.y);
    // A stair transfer or test teleport must not produce a huge stride/bob.
    const travelled = distance < 2 ? distance : 0;
    motion.speed = travelled / elapsed;
    motion.phase = (motion.phase + travelled * 7) % (Math.PI * 2);
    motion.x = x;
    motion.y = y;
    motion.time = time;
  }
  if (hp < motion.hp) motion.flinchUntil = time + 0.22;
  motion.hp = hp;
  if (hp <= 0 && motion.deathAt === undefined) motion.deathAt = time;
}

/** Only a few fixtures stutter; reduced flashing also makes Surge fixtures steady. */
export function panelIsLit(
  index: number,
  time: number,
  dark: number,
  surge: boolean,
  reducedFlash: boolean,
) {
  if (reducedFlash || (!surge && dark < 0.45) || index % 4 !== 1) return true;
  const step = Math.floor(time * (surge ? 6 : 4));
  return (
    (Math.imul(step + index * 17, 1103515245) >>> 16) % 17 > (surge ? 2 : 0)
  );
}

interface LimbPose {
  x: number;
  y: number;
  rotation: number;
}

/** Mutates reusable scratch space. The upper endpoint stays at its shoulder/hip
 * while the lower endpoint swings forward; collapse rotates the whole joint. */
export function setLimbPose(
  out: LimbPose,
  pivotY: number,
  length: number,
  swing: number,
  collapse = 0,
) {
  const half = length / 2,
    x = Math.sin(swing) * half,
    y = pivotY - Math.cos(swing) * half,
    c = Math.cos(collapse),
    s = Math.sin(collapse);
  out.x = x * c + (y - 0.18) * s;
  out.y = 0.18 + (y - 0.18) * c - x * s;
  out.rotation = swing - collapse;
  return out;
}
