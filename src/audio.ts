import { loadSfx, SFX, type SoundSample } from "./sfx";
import { type Game } from "./model";
import { npcSpeechHearingRange, type NpcSpeechDelivery } from "./npc-hearing";
import { surfacePoint } from "./furniture-geometry";
import {
  captureHordeAcoustics,
  hordeSound,
  soundEvents,
  surgeCaption,
  type HordeAcoustics,
} from "./soundscape";
import {
  actorSoundOrigin,
  createWorldPanner,
  distanceAttenuation,
  positionPanner,
  soundDistance,
  spatialMixer,
  updateListener,
  type ListenerLook,
  type SoundOrigin,
} from "./spatial-audio";

interface Voice {
  osc: AudioScheduledSourceNode;
  vol: GainNode;
  filter: BiquadFilterNode;
  panner?: PannerNode;
  channel: string;
  gain: number;
  transmission: number;
  cutoff: number;
  origin?: SoundOrigin;
  actorId?: string;
  id?: string;
  envelope?: GainNode;
  onEnded?: (completed?: boolean) => void;
  /** Speech only: the distance at which this delivery stops carrying. */
  range?: number;
}
export interface SpeechPlayback {
  id: string;
  actorId: string;
  buffer: AudioBuffer;
  /** How the line is spoken; sets its loudness and how far it carries. */
  delivery?: NpcSpeechDelivery;
  /** False when cancelled before the utterance finished. */
  onEnded?: (completed?: boolean) => void;
}
const MAX_SPEECH_SECONDS = 12;
const MAX_SPEECH_BYTES = 1_000_000;
const MIN_SPEECH_GAIN = 0.001;
/** Source level of each delivery before distance and walls. A whisper is far
 * quieter than ordinary speech and a raised, urgent voice louder, so what the
 * player hears matches what nearby survivors can hear. */
export const SPEECH_LEVEL: Readonly<Record<NpcSpeechDelivery, number>> =
  Object.freeze({ whisper: 0.12, calm: 0.45, relieved: 0.45, urgent: 0.65 });
/** Speech carries as far for the player as for survivors (npc-hearing.ts),
 * fading out over the last quarter of that range instead of cutting off. */
export function speechFade(distance: number, range: number) {
  if (!Number.isFinite(distance) || distance >= range) return 0;
  const start = range * 0.75;
  return distance <= start ? 1 : (range - distance) / (range - start);
}

export class AudioDirector {
  ctx?: AudioContext;
  master?: GainNode;
  horde?: GainNode;
  filter?: BiquadFilterNode;
  cursor = 0;
  next = 0;
  phase = "";
  caption = "";
  error = "";
  ready: Promise<void> = Promise.resolve();
  private samples = new Map<string, AudioBuffer>();
  private sampleCursor = 0;
  private nextGroan = 0;
  private footsteps = 0;
  private position?: SoundOrigin;
  private game?: Game;
  private lastTime = 0;
  private eventCaption = "";
  private mixCaption = "";
  private volume = -1;
  private eventCaptionUntil = 0;
  private voices = new Set<Voice>();
  private hordePanner?: PannerNode;
  private mixer?: ReturnType<typeof spatialMixer>;
  private nextSpatial = 0;
  private hordeAcoustics?: HordeAcoustics;

  constructor(
    private createContext: () => AudioContext = () =>
      new AudioContext({ latencyHint: "interactive" }),
    private loadSamples: (
      ctx: AudioContext,
    ) => Promise<Map<string, AudioBuffer>> = loadSfx,
  ) {}

  start() {
    if (this.ctx) {
      void this.ctx.resume().catch(() => {
        this.error = "Audio could not resume. Sound captions remain available.";
      });
      return true;
    }
    try {
      const c = this.createContext(),
        master = c.createGain();
      master.gain.value = 0;
      const limiter = c.createDynamicsCompressor();
      limiter.threshold.value = -12;
      limiter.knee.value = 6;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.15;
      master.connect(limiter);
      limiter.connect(c.destination);
      const buffer = c.createBuffer(1, c.sampleRate * 3, c.sampleRate),
        data = buffer.getChannelData(0);
      let last = 0;
      for (let i = 0; i < data.length; i++) {
        last = (last + Math.random() * 0.04 - 0.02) / 1.02;
        data[i] = last * 4;
      }
      const source = c.createBufferSource(),
        filter = c.createBiquadFilter(),
        horde = c.createGain();
      source.buffer = buffer;
      source.loop = true;
      filter.type = "lowpass";
      horde.gain.value = 0;
      this.hordePanner = createWorldPanner(c);
      source.connect(filter);
      filter.connect(horde);
      if (this.hordePanner) {
        horde.connect(this.hordePanner);
        this.hordePanner.connect(master);
      } else horde.connect(master);
      source.start();
      this.ready = this.loadSamples(c)
        .then((bank) => {
          this.samples = bank;
        })
        .catch(() => {});
      this.ctx = c;
      this.master = master;
      this.filter = filter;
      this.horde = horde;
      this.error = "";
      this.game = undefined;
      return true;
    } catch {
      this.error = "Audio is unavailable. Enable sound captions in Settings.";
      return false;
    }
  }

  canSpeak(g: Game) {
    return (
      !!this.ctx &&
      !!this.master &&
      this.ctx.state === "running" &&
      this.game === g &&
      !g.paused &&
      !g.studyWorkspace?.enabled &&
      g.status === "playing" &&
      g.settings.volume > 0 &&
      ![...this.voices].some((v) => v.channel === "speech") &&
      this.voices.size < 20
    );
  }

  async decodeSpeech(bytes: ArrayBuffer): Promise<AudioBuffer | undefined> {
    const c = this.ctx;
    if (
      !c ||
      typeof c.decodeAudioData !== "function" ||
      bytes.byteLength <= 0 ||
      bytes.byteLength > MAX_SPEECH_BYTES
    )
      return undefined;
    try {
      const buffer = await c.decodeAudioData(bytes.slice(0));
      if (!this.validSpeech(buffer)) return undefined;
      for (let channel = 0; channel < buffer.numberOfChannels; channel++)
        if (!buffer.getChannelData(channel).every(Number.isFinite))
          return undefined;
      return buffer;
    } catch {
      return undefined;
    }
  }

  private validSpeech(buffer: AudioBuffer) {
    return (
      Number.isFinite(buffer.duration) &&
      buffer.duration > 0 &&
      buffer.duration <= MAX_SPEECH_SECONDS &&
      Number.isFinite(buffer.sampleRate) &&
      buffer.sampleRate >= 8000 &&
      buffer.sampleRate <= 96000 &&
      Number.isSafeInteger(buffer.length) &&
      buffer.length > 0 &&
      buffer.length <= 96000 * MAX_SPEECH_SECONDS &&
      Math.abs(buffer.length / buffer.sampleRate - buffer.duration) <=
        1 / buffer.sampleRate &&
      Number.isSafeInteger(buffer.numberOfChannels) &&
      buffer.numberOfChannels >= 1 &&
      buffer.numberOfChannels <= 2
    );
  }

  speak(g: Game, speech: SpeechPlayback) {
    if (
      !this.canSpeak(g) ||
      !this.validSpeech(speech.buffer) ||
      !speech.id ||
      speech.id.length > 128
    )
      return false;
    const actor = g.survivors.find(
      (a) =>
        a.id === speech.actorId && a.id !== "human" && a.alive && !a.escaped,
    );
    if (!actor) return false;
    const origin = actorSoundOrigin(g, actor),
      mix = this.mix(origin),
      delivery = speech.delivery ?? "calm",
      level = SPEECH_LEVEL[delivery],
      range = npcSpeechHearingRange(delivery),
      fade = speechFade(mix.distance, range);
    if (fade <= 0 || mix.gain * level * fade < MIN_SPEECH_GAIN) return false;
    const c = this.ctx!,
      source = c.createBufferSource();
    source.buffer = speech.buffer;
    const voice = this.connectVoice(
      source,
      level * fade,
      6500,
      "speech",
      origin,
    );
    if (!voice) {
      source.disconnect();
      return false;
    }
    voice.gain = level;
    voice.range = range;
    voice.actorId = speech.actorId;
    voice.id = speech.id;
    voice.onEnded = speech.onEnded;
    try {
      source.start();
      source.stop(
        c.currentTime + Math.min(MAX_SPEECH_SECONDS, speech.buffer.duration),
      );
    } catch {
      this.finish(voice, true);
      return false;
    }
    return true;
  }

  stopSpeech(id?: string) {
    for (const voice of [...this.voices])
      if (voice.channel === "speech" && (!id || voice.id === id))
        this.finish(voice, true);
  }

  private mix(origin: SoundOrigin) {
    if (!this.game)
      return { gain: 1, transmission: 1, cutoff: 4800, distance: 0 };
    this.mixer ??= spatialMixer(this.game);
    return this.mixer(origin);
  }

  private connectVoice(
    osc: AudioScheduledSourceNode,
    gain: number,
    cutoff: number,
    channel: string,
    origin?: SoundOrigin,
    shaped = false,
  ) {
    const c = this.ctx;
    if (!c || !this.master || this.voices.size >= 20) return undefined;
    const vol = c.createGain(),
      filter = c.createBiquadFilter(),
      panner = createWorldPanner(c),
      envelope = shaped ? c.createGain() : undefined;
    const self = this.game
      ? actorSoundOrigin(this.game, this.game.survivors[0])
      : undefined;
    const source =
      origin ??
      (self ? { ...self, height: (self.height ?? 1.45) + 0.15 } : undefined);
    const mix = source
      ? this.mix(source)
      : { gain: 1, transmission: 1, cutoff };
    vol.gain.value = gain * mix.gain;
    filter.type = "lowpass";
    filter.frequency.value = Math.min(cutoff, mix.cutoff);
    const voice: Voice = {
      osc,
      vol,
      filter,
      panner,
      channel,
      gain,
      transmission: mix.transmission,
      cutoff,
      envelope,
      origin: source,
    };
    this.voices.add(voice);
    osc.connect(envelope ?? filter);
    envelope?.connect(filter);
    filter.connect(vol);
    if (panner) {
      vol.connect(panner);
      panner.connect(this.master);
      if (source) positionPanner(c, panner, source);
    } else vol.connect(this.master);
    osc.onended = () => this.finish(voice);
    return voice;
  }

  cue(
    frequency: number,
    duration: number,
    gain = 0.12,
    end?: number,
    channel = "effect",
    cutoff = 12000,
    origin?: SoundOrigin,
  ) {
    const c = this.ctx;
    if (!c || duration <= 0 || gain <= 0) return;
    const osc = c.createOscillator(),
      voice = this.connectVoice(osc, gain, cutoff, channel, origin, true);
    if (!voice) {
      osc.disconnect();
      return;
    }
    // Keep the source's attack/fade separate from its live distance gain, so
    // walking can change loudness without overwriting the scheduled envelope.
    const envelope = voice.envelope!;
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(frequency, c.currentTime);
    if (end)
      osc.frequency.exponentialRampToValueAtTime(end, c.currentTime + duration);
    const floorGain = Math.min(0.01, 0.001 / gain);
    envelope.gain.setValueAtTime(floorGain, c.currentTime);
    envelope.gain.linearRampToValueAtTime(
      1,
      c.currentTime + Math.min(0.06, duration / 3),
    );
    envelope.gain.exponentialRampToValueAtTime(
      Math.max(1e-8, floorGain),
      c.currentTime + duration,
    );
    osc.start();
    osc.stop(c.currentTime + duration);
  }

  private sample(
    kind: SoundSample,
    gain: number,
    cutoff = 4800,
    channel = "effect",
    origin?: SoundOrigin,
    actorId?: string,
  ) {
    const c = this.ctx;
    if (!c || !this.master || this.voices.size >= 20) return false;
    const options = SFX[kind],
      name = options[this.sampleCursor++ % options.length],
      buffer = this.samples.get(name);
    if (!buffer) return false;
    const source = c.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = 0.96 + (this.sampleCursor % 5) * 0.02;
    const voice = this.connectVoice(source, gain, cutoff, channel, origin);
    if (!voice) {
      source.disconnect();
      return false;
    }
    voice.actorId = actorId;
    source.start();
    return true;
  }

  private finish(voice: Voice, stop = false) {
    if (!this.voices.delete(voice)) return;
    if (stop)
      try {
        voice.osc.stop();
      } catch {}
    voice.osc.disconnect();
    voice.vol.disconnect();
    voice.filter.disconnect();
    voice.envelope?.disconnect();
    voice.panner?.disconnect();
    if (voice.channel === "speech" && "buffer" in voice.osc)
      (voice.osc as AudioBufferSourceNode).buffer = null;
    try {
      voice.onEnded?.(!stop);
    } catch {
      /* Cleanup must not interrupt the game loop. */
    }
  }

  private cancel(channel?: string) {
    for (const voice of [...this.voices])
      if (!channel || voice.channel === channel) this.finish(voice, true);
  }

  stop() {
    this.cancel();
    if (this.ctx && this.horde)
      this.horde.gain.setTargetAtTime(0, this.ctx.currentTime, 0.03);
    this.game = undefined;
    this.mixer = undefined;
    this.phase = "";
    this.caption = "";
  }

  private spatialVoices(g: Game, refresh: boolean) {
    const c = this.ctx;
    if (!c) return;
    for (const voice of [...this.voices]) {
      if (voice.channel === "speech") {
        const actor = g.survivors.find((a) => a.id === voice.actorId);
        if (
          c.state !== "running" ||
          !actor ||
          !actor.alive ||
          actor.escaped ||
          g.paused ||
          g.studyWorkspace?.enabled ||
          g.status !== "playing" ||
          g.settings.volume <= 0
        ) {
          this.finish(voice, true);
          continue;
        }
        voice.origin = actorSoundOrigin(g, actor);
        if (soundDistance(g, voice.origin) >= (voice.range ?? 18)) {
          this.finish(voice, true);
          continue;
        }
      }
      if (voice.channel === "ambience" && voice.actorId) {
        const zombie = g.zombies.find(
          (z) => z.id === voice.actorId && z.hp > 0,
        );
        if (!zombie) {
          this.finish(voice, true);
          continue;
        }
        voice.origin = {
          x: zombie.x,
          y: zombie.y,
          floor: zombie.floor,
          height: 1.4,
        };
      }
      if (!voice.origin) continue;
      positionPanner(c, voice.panner, voice.origin);
      if (refresh) {
        const mix = this.mix(voice.origin);
        voice.transmission = mix.transmission;
        voice.filter.frequency.setTargetAtTime(
          Math.min(voice.cutoff, mix.cutoff),
          c.currentTime,
          0.06,
        );
      }
      // Obstruction work stays bounded to the acoustic refresh. Distance is
      // cheap and follows the listener and emitter on every rendered frame.
      const distance = soundDistance(g, voice.origin),
        gain =
          voice.gain *
          voice.transmission *
          distanceAttenuation(distance) *
          (voice.range === undefined ? 1 : speechFade(distance, voice.range));
      if (voice.channel === "speech" && gain < MIN_SPEECH_GAIN) {
        this.finish(voice, true);
        continue;
      }
      voice.vol.gain.setTargetAtTime(gain, c.currentTime, 0.025);
    }
  }

  update(g: Game, look?: ListenerLook) {
    if (g !== this.game || g.time < this.lastTime) {
      this.cancel();
      this.game = g;
      this.cursor = g.seq;
      this.next = 0;
      this.phase = "";
      this.nextGroan = 0;
      this.nextSpatial = 0;
      this.hordeAcoustics = undefined;
      this.position = undefined;
      this.footsteps = 0;
      this.eventCaption = "";
      this.mixCaption = "";
      this.eventCaptionUntil = 0;
    }
    this.lastTime = g.time;
    this.mixer = undefined;
    const c = this.ctx;
    if (c) updateListener(c, g, look);
    if (c && this.master && this.volume !== g.settings.volume) {
      this.volume = g.settings.volume;
      this.master.gain.setTargetAtTime(
        Math.min(1, Math.max(0, g.settings.volume)),
        c.currentTime,
        0.03,
      );
    }
    if (g.paused) {
      this.cancel();
      this.cursor = g.seq;
      if (c && this.horde)
        this.horde.gain.setTargetAtTime(0, c.currentTime, 0.03);
      return;
    }
    const refreshSpatial =
      g.time >= this.nextSpatial ||
      this.hordeAcoustics?.floor !== g.survivors[0].floor;
    if (refreshSpatial) {
      this.nextSpatial = g.time + 0.25;
      this.hordeAcoustics = captureHordeAcoustics(g);
    }
    this.spatialVoices(g, refreshSpatial);
    const mix = hordeSound(g, this.hordeAcoustics);
    this.mixCaption = mix.caption;
    if (c && this.horde && this.filter) {
      // The bounded contributors retain cached obstruction but use current
      // listener/source distances every frame, just like individual voices.
      this.horde.gain.setTargetAtTime(
        this.samples.size ? mix.gain * 0.12 : mix.gain,
        c.currentTime,
        0.025,
      );
      this.filter.frequency.setTargetAtTime(mix.cutoff, c.currentTime, 0.06);
      if (mix.origin) positionPanner(c, this.hordePanner, mix.origin);
    }
    // Impacts dispatch within the current simulation tick, independently of ambience.
    const cues = g.seq !== this.cursor ? soundEvents(g, this.cursor) : [];
    this.cursor = g.seq;
    for (const cue of cues) {
      const gain = cue.sourceGain ?? cue.gain;
      if (
        !cue.sample ||
        !this.sample(cue.sample, gain, 4800, "effect", cue.origin)
      )
        this.cue(
          cue.frequency,
          cue.duration,
          gain,
          cue.end,
          "effect",
          4800,
          cue.origin,
        );
    }
    if (cues.length) {
      this.eventCaption = cues[0].caption;
      this.eventCaptionUntil = g.time + 1.5;
    }
    this.caption = [
      surgeCaption(g),
      g.time < this.eventCaptionUntil ? this.eventCaption : "",
      this.mixCaption,
    ]
      .filter(Boolean)
      .join(" · ");
    if (g.time < this.next) return;
    this.next = g.time + 0.25;
    if (mix.gain > 0.0004 && g.time >= this.nextGroan) {
      this.sample("groan", 0.35, 4800, "ambience", mix.origin, mix.actorId);
      this.nextGroan = g.time + 0.9 + (this.sampleCursor % 5) * 0.17;
    }
    const a = g.survivors[0],
      origin = actorSoundOrigin(g, a),
      foot = { ...origin, height: (origin.height ?? 1.45) - 1.4 };
    if (
      this.position &&
      this.position.floor === a.floor &&
      a.alive &&
      !a.escaped &&
      !a.vault &&
      (!a.stairTravel || a.stairTravel.walked !== undefined)
    ) {
      const distance = Math.hypot(
        a.x - this.position.x,
        a.y - this.position.y,
        (foot.height ?? 0.05) - (this.position.height ?? 0.05),
      );
      if (distance < 2) this.footsteps += distance;
      if (this.footsteps >= 0.7) {
        this.sample("footstep", 0.035, 4800, "effect", foot);
        const held = [a.grip?.object, a.handling]
          .map((id) =>
            g.floors[a.floor].furniture.find(
              (o) => o.id === id && !o.destroyed && o.floor === a.floor,
            ),
          )
          .find(Boolean);
        if (held) {
          const contact = surfacePoint(a, held),
            distance = Math.hypot(a.x - contact.x, a.y - contact.y);
          // Just outside the actual leaf/prop face, on the holder's side, so
          // its own solid footprint cannot acoustically bury the scrape.
          const origin = {
            x:
              contact.x +
              (distance ? ((a.x - contact.x) / distance) * 0.035 : 0),
            y:
              contact.y +
              (distance ? ((a.y - contact.y) / distance) * 0.035 : 0),
            floor: held.floor,
            height: 0.08,
          };
          this.sample("drag", 0.025, 4800, "effect", origin);
        }
        this.footsteps %= 0.7;
      }
    }
    this.position = foot;
    if (this.phase !== g.surge.state) {
      this.cancel("warning");
      this.phase = g.surge.state;
    }
  }
}
