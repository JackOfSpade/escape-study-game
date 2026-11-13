import { type SoundSample } from "./sfx";
import { type Game, type WorldEvent, type Zombie, distance } from "./model";
import { extractionFloor, primaryExtraction } from "./engine";
import {
  distanceAttenuation,
  listenerPose,
  soundPose,
  spatialMixer,
  type SoundOrigin,
} from "./spatial-audio";

/** Per-source level of one zombie's vocalisation in the horde loop, before the
 * shared distance falloff. Chosen so a zombie a few metres away sounds about
 * as loud as it did under the old separate 1 / (1 + d) curve. */
const HORDE_SOURCE_LEVEL = 0.1;
/** Sources beyond the shared mixer's audible range are never captured. */
const HORDE_RANGE = 24;
export interface SoundCue {
  frequency: number;
  duration: number;
  gain: number;
  end?: number;
  caption: string;
  sample?: SoundSample;
  cutoff?: number;
  /** Physical emitter retained for headphone direction and live attenuation. */
  origin?: SoundOrigin;
  sourceGain?: number;
}
export interface HordeAcoustics {
  floor: number;
  sources: { actor: Zombie; transmission: number }[];
}
/** Expensive propagation is captured at the acoustic refresh cadence. Keeping
 * at most twelve live actors lets the continuous loop track movement cheaply. */
export function captureHordeAcoustics(g: Game): HordeAcoustics {
  const a = g.survivors[0];
  // The same mixer as voices and impacts: walls, doors, other floors and the
  // open city all propagate a zombie the way they propagate anything else.
  const mix = spatialMixer(g);
  // Bound acoustic path work and favor nearby sources, rather than arbitrary
  // spawn-array order. Captions describe sound only, never counts or locations.
  const sources = g.zombies
    .filter(
      (z) => z.hp > 0 && g.floors[z.floor] && distance(a, z) < HORDE_RANGE,
    )
    .sort((x, y) => distance(a, x) - distance(a, y) || x.id.localeCompare(y.id))
    .slice(0, 24)
    .map((z) => {
      const heard = mix(hordeOrigin(z));
      return {
        transmission: heard.transmission,
        gain: heard.gain * HORDE_SOURCE_LEVEL,
        actor: z,
      };
    })
    .sort((x, y) => y.gain - x.gain || x.actor.id.localeCompare(y.actor.id))
    .slice(0, 12);
  return {
    floor: a.floor,
    sources: sources.map(({ actor, transmission }) => ({
      actor,
      transmission,
    })),
  };
}
/** Distance, direction and liveness follow every rendered frame; a cached
 * snapshot deliberately retains only the bounded propagation calculation. */
export function hordeSound(g: Game, acoustics = captureHordeAcoustics(g)) {
  const a = g.survivors[0],
    listener = listenerPose(g),
    sources =
      acoustics.floor !== a.floor
        ? []
        : acoustics.sources
            .filter(({ actor }) => actor.hp > 0 && g.zombies.includes(actor))
            .map(({ actor, transmission }) => {
              const origin = hordeOrigin(actor),
                pose = soundPose(origin),
                d = Math.hypot(
                  listener.x - pose.x,
                  listener.y - pose.y,
                  listener.z - pose.z,
                );
              return {
                transmission,
                origin,
                id: actor.id,
                gain:
                  transmission * distanceAttenuation(d) * HORDE_SOURCE_LEVEL,
              };
            })
            .filter((s) => s.gain > 0)
            .sort((x, y) => y.gain - x.gain || x.id.localeCompare(y.id));
  const gain = Math.min(
    0.45,
    sources.reduce((n, s) => n + s.gain, 0),
  );
  const clear = Math.max(0, ...sources.map((s) => s.transmission));
  return {
    gain,
    cutoff: clear > 0.2 ? 4800 : 120,
    origin: sources[0]?.origin,
    actorId: sources[0]?.id,
    caption:
      gain < 0.002
        ? ""
        : clear > 0.2
          ? "[Nearby horde vocalizations]"
          : "[Muffled horde behind defenses]",
  };
}
function soundPosition(g: Game, e: WorldEvent) {
  // Impacts originate on a solid prop's surface; use the attacking side for
  // propagation, so a partial barricade cannot hide all of its impact sounds.
  return (
    g.zombies.find((z) => z.id === e.actor && z.floor === e.floor) ??
    e.position!
  );
}
function hordeOrigin(z: Zombie): SoundOrigin {
  return { x: z.x, y: z.y, floor: z.floor, height: 1.4 };
}
function eventOrigin(g: Game, e: WorldEvent): SoundOrigin {
  const p = soundPosition(g, e);
  return { x: p.x, y: p.y, floor: e.floor, height: 1.2 };
}
/** The cue's audible level is what the shared mixer will actually play, so a
 * caption never names a sound that is too faint to hear, and an impact one
 * floor away is faint rather than silent. */
function audible(g: Game, e: WorldEvent, base: number, mix: Mixer) {
  if (!e.position)
    // Legacy non-positional saves keep their flat same-floor level.
    return e.floor === g.survivors[0].floor ? base * 0.25 : 0;
  return base * mix(eventOrigin(g, e)).gain;
}
type Mixer = ReturnType<typeof spatialMixer>;
export function soundEvents(g: Game, after: number): SoundCue[] {
  const out: SoundCue[] = [];
  // Non-audio world events must not rebuild acoustic geometry on each frame.
  const events = g.events.filter(
    (e) =>
      e.seq > after &&
      g.time - e.at >= 0 &&
      g.time - e.at < 0.8 &&
      [
        "breach",
        "barricade-hit",
        "survivor-hit",
        "entrance-close",
        "helicopter",
        "board",
        "completion",
      ].includes(e.type),
  );
  if (!events.length) return out;
  const mix = spatialMixer(g);
  for (const source of events) {
    const e =
      source.type === "entrance-close" && !source.position
        ? { ...source, position: g.floors[source.floor]?.entry }
        : source;
    let cue: SoundCue | undefined;
    if (e.type === "breach")
      cue = {
        frequency: 60,
        duration: 0.9,
        gain: audible(g, e, 0.5, mix),
        end: 450,
        caption: "[Barricade breaks · crashing debris]",
      };
    if (e.type === "barricade-hit")
      cue = {
        frequency: 90,
        duration: 0.18,
        gain: audible(g, e, 0.18, mix),
        end: 35,
        caption: "[Impacts against a barricade]",
      };
    if (e.type === "survivor-hit")
      cue = {
        frequency: 135,
        duration: 0.2,
        gain: audible(g, e, 0.18, mix),
        end: 55,
        caption: "[Nearby attack]",
      };
    if (e.type === "entrance-close" && e.floor === g.survivors[0].floor)
      cue = {
        frequency: 95,
        duration: 0.5,
        gain: audible(g, e, 0.3, mix),
        end: 35,
        caption: "[Main entrance slams shut]",
      };
    if (e.type === "helicopter" && g.survivors[0].floor === extractionFloor(g))
      cue = {
        frequency: 130,
        duration: 2,
        gain: 0.1,
        end: 100,
        caption: "[Helicopter approaching]",
      };
    // The player's own terminal unlocking: the only completion that grants
    // them a key, so NPC terminals elsewhere stay silent.
    if (
      e.type === "completion" &&
      e.floor === g.survivors[0].floor &&
      e.encounter &&
      g.encounters[e.encounter]?.submissions.some(
        (s) =>
          s.id === g.encounters[e.encounter!].accepted && s.author === "human",
      )
    )
      cue = {
        frequency: 660,
        duration: 0.25,
        gain: 0.28,
        end: 990,
        caption: "[Lock releases · key granted]",
        sample: "latch",
      };
    if (e.type === "board" && e.actor === "human")
      cue = {
        frequency: 400,
        duration: 1,
        gain: 0.15,
        end: 800,
        caption: "[Helicopter extraction]",
      };
    if (cue) {
      const position = e.position
        ? soundPosition(g, e)
        : e.type === "completion"
          ? g.floors[e.floor]?.stations.find((s) => s.encounter === e.encounter)
          : e.type === "helicopter"
            ? primaryExtraction(g)
            : g.survivors[0];
      if (position)
        cue.origin = {
          x: position.x,
          y: position.y,
          floor: e.floor,
          height: e.type === "helicopter" ? 6 : 1.2,
        };
      cue.sourceGain =
        e.type === "breach"
          ? 0.5
          : e.type === "entrance-close"
            ? 0.3
            : e.type === "completion"
              ? 0.28
              : e.type === "helicopter"
                ? 0.1
                : e.type === "board"
                  ? 0.15
                  : 0.18;
      cue.sample ??=
        e.type === "breach"
          ? "breach"
          : e.type === "survivor-hit"
            ? "hit"
            : e.type === "entrance-close"
              ? "metal"
              : e.type === "barricade-hit"
                ? "wood"
                : undefined;
      cue.cutoff =
        !e.position || mix(eventOrigin(g, e)).transmission > 0.2 ? 4800 : 120;
    }
    if (cue && cue.gain >= 0.0004) out.push(cue);
  }
  // Bound simultaneous impacts while retaining the loudest meaningful cues.
  return out.sort((a, b) => b.gain - a.gain).slice(0, 4);
}
export function surgeCaption(g: Game) {
  return g.surge.state === "warning"
    ? "[An escalating biological pulse]"
    : g.surge.state === "active"
      ? "[The Surge · horde intensified]"
      : "";
}
