import { soundConnectivity } from "./acoustics";
import { type Actor, type Game, type Point } from "./model";
import { line } from "./spatial";
import { FLOOR_HEIGHT, sampleStairRoute } from "./stair-route";
import { outsideBuilding } from "./view3d/exterior-layout";

/** Simulation X/Y plus metres above the named floor, never screen coordinates. */
export interface SoundOrigin extends Point {
  floor: number;
  height?: number;
}
export interface ListenerLook {
  yaw: number;
  pitch?: number;
}
interface AudioPose {
  x: number;
  y: number;
  z: number;
}
export function actorSoundOrigin(g: Game, actor: Actor): SoundOrigin {
  const route =
    actor.elevated || actor.stairTravel?.walked === undefined
      ? undefined
      : sampleStairRoute(g, actor.stairTravel);
  return {
    x: route?.x ?? actor.x,
    y: route?.z ?? actor.y,
    floor: actor.floor,
    height:
      (actor.elevated?.feet ?? route?.y ?? actor.floor * FLOOR_HEIGHT) -
      actor.floor * FLOOR_HEIGHT +
      1.45,
  };
}
export function soundPose(origin: SoundOrigin): AudioPose {
  return {
    x: origin.x,
    y: origin.floor * FLOOR_HEIGHT + (origin.height ?? 1.2),
    z: origin.y,
  };
}
export function listenerPose(g: Game, look?: ListenerLook) {
  const a = g.survivors[0],
    p = soundPose(actorSoundOrigin(g, a)),
    yaw = look?.yaw ?? Math.atan2(a.heading.y, a.heading.x),
    pitch = Math.max(
      -Math.PI / 2 + 0.01,
      Math.min(Math.PI / 2 - 0.01, look?.pitch ?? 0),
    ),
    horizontal = Math.cos(pitch);
  // Match the first-person camera exactly, including the continuously walked
  // stair elevation. The up vector remains orthogonal while looking up/down.
  p.y += 0.15;
  return {
    ...p,
    forward: {
      x: horizontal * Math.cos(yaw),
      y: Math.sin(pitch),
      z: horizontal * Math.sin(yaw),
    },
    up: {
      x: -Math.sin(pitch) * Math.cos(yaw),
      y: horizontal,
      z: -Math.sin(pitch) * Math.sin(yaw),
    },
  };
}
export function soundDistance(g: Game, origin: SoundOrigin) {
  const a = listenerPose(g),
    b = soundPose(origin);
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** One distance falloff shared by initial mixing and live source updates. */
export function distanceAttenuation(distance: number) {
  return Number.isFinite(distance) && distance < 24
    ? 1 / (1 + distance * 0.2)
    : 0;
}

/** Batch acoustic work once per mix, then reuse topology for every voice. The
 * panner handles direction; this gain is the single distance falloff stage. */
export function spatialMixer(g: Game) {
  const a = g.survivors[0],
    listener = listenerPose(g),
    floor = g.floors[a.floor];
  let connected: ReturnType<typeof soundConnectivity> | undefined;
  return (origin: SoundOrigin) => {
    const source = soundPose(origin),
      distance = Math.hypot(
        source.x - listener.x,
        source.y - listener.y,
        source.z - listener.z,
      );
    if (!Number.isFinite(distance) || !g.floors[origin.floor])
      return { gain: 0, transmission: 0, cutoff: 120, distance };
    const outsideListener = outsideBuilding(floor, listener.x, listener.z),
      outsideSource = outsideBuilding(
        g.floors[origin.floor],
        origin.x,
        origin.y,
      ),
      elevation = Math.abs(listener.y - 1.6 - origin.floor * FLOOR_HEIGHT);
    let transmission: number;
    if (outsideListener && outsideSource) {
      // Raised emergency galleries are open to the city. Height changes
      // distance/direction, without pretending the ground is another sealed room.
      transmission =
        floor.city && origin.floor === a.floor && !line(floor, a, origin, true)
          ? 0.15
          : 1;
    } else if (origin.floor !== a.floor) transmission = 0.035;
    else {
      connected ??= soundConnectivity(floor);
      transmission = connected(a, origin)
        ? line(floor, a, origin, true)
          ? 1
          : 0.55
        : 0.025;
    }
    if (!(outsideListener && outsideSource))
      transmission *= Math.exp(-elevation * 0.9);
    return {
      gain: transmission * distanceAttenuation(distance),
      transmission,
      cutoff: transmission > 0.2 ? 4800 : 120,
      distance,
    };
  };
}

function param(value: AudioParam | undefined, next: number, time: number) {
  value?.setTargetAtTime(next, time, 0.025);
}
export function updateListener(
  ctx: AudioContext,
  g: Game,
  look?: ListenerLook,
) {
  const listener = ctx.listener;
  if (!listener) return;
  const pose = listenerPose(g, look),
    time = ctx.currentTime;
  if (listener.positionX) {
    param(listener.positionX, pose.x, time);
    param(listener.positionY, pose.y, time);
    param(listener.positionZ, pose.z, time);
    param(listener.forwardX, pose.forward.x, time);
    param(listener.forwardY, pose.forward.y, time);
    param(listener.forwardZ, pose.forward.z, time);
    param(listener.upX, pose.up.x, time);
    param(listener.upY, pose.up.y, time);
    param(listener.upZ, pose.up.z, time);
  } else {
    listener.setPosition(pose.x, pose.y, pose.z);
    listener.setOrientation(
      pose.forward.x,
      pose.forward.y,
      pose.forward.z,
      pose.up.x,
      pose.up.y,
      pose.up.z,
    );
  }
}
export function createWorldPanner(ctx: AudioContext) {
  // Older unsupported audio implementations retain captions and mono fallback.
  if (typeof ctx.createPanner !== "function") return undefined;
  const panner = ctx.createPanner();
  panner.panningModel = "HRTF";
  panner.distanceModel = "inverse";
  panner.refDistance = 1;
  panner.maxDistance = 24;
  panner.rolloffFactor = 0;
  panner.channelCount = 1;
  panner.channelCountMode = "explicit";
  return panner;
}
export function positionPanner(
  ctx: AudioContext,
  panner: PannerNode | undefined,
  origin: SoundOrigin,
) {
  if (!panner) return;
  const pose = soundPose(origin);
  if (panner.positionX) {
    param(panner.positionX, pose.x, ctx.currentTime);
    param(panner.positionY, pose.y, ctx.currentTime);
    param(panner.positionZ, pose.z, ctx.currentTime);
  } else panner.setPosition(pose.x, pose.y, pose.z);
}
