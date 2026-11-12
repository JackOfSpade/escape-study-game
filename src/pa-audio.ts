/**
 * Loudspeaker (PA) audio chain for the escape redesign (section 9).
 *
 * The chain is built with plain Web Audio nodes: a cabinet impulse response
 * (the real `/audio/pa-ir.wav` when the deployment has one, otherwise a
 * deterministic synthesised one), a ~300 Hz..3400 Hz band limit and gentle
 * saturation. `paChime` is the two-tone attention chime played before an
 * announcement.
 */

const PA_BAND = Object.freeze({ highpass: 300, lowpass: 3400 });

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A deterministic loudspeaker impulse response: a band-limited cabinet at
 * 300..3400 Hz, a handful of metallic early reflections and a short
 * exponentially decaying tail. Same length and samples for a given rate.
 */
export function synthesizePaImpulse(sampleRate: number): Float32Array {
  const rate =
    Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
  const seconds = 0.42;
  const length = Math.max(1, Math.round(rate * seconds));
  const impulse = new Float32Array(length);
  const random = mulberry32(0x50414952); // "PAIR"
  // Two cascaded one-pole band limits, applied forward and backward so the
  // noise is shaped without a phase-y one-sided smearing.
  const lowAlpha = 1 - Math.exp((-2 * Math.PI * PA_BAND.lowpass) / rate);
  const highAlpha = 1 - Math.exp((-2 * Math.PI * PA_BAND.highpass) / rate);
  const noise = new Float32Array(length);
  for (let i = 0; i < length; i++) noise[i] = random() * 2 - 1;
  const low = new Float32Array(length);
  let lowState = 0;
  for (let i = 0; i < length; i++) {
    lowState += lowAlpha * (noise[i]! - lowState);
    low[i] = lowState;
  }
  let highState = 0;
  for (let i = 0; i < length; i++) {
    highState += highAlpha * (low[i]! - highState);
    impulse[i] = low[i]! - highState;
  }
  // Metallic early reflections: a few discrete taps in the first 30 ms.
  const taps = [0.0061, 0.0113, 0.0179, 0.0241, 0.0293];
  taps.forEach((time, index) => {
    const at = Math.round(time * rate);
    if (at < length) impulse[at] = impulse[at]! + (0.55 - index * 0.08);
  });
  // Short decaying tail so the reverberation stays cabinet-sized.
  for (let i = 0; i < length; i++) {
    const t = i / rate;
    impulse[i] = impulse[i]! * Math.exp(-t * 11);
  }
  // Normalise to unit energy so the convolver has a predictable gain.
  let energy = 0;
  for (const sample of impulse) energy += sample * sample;
  const scale = energy > 0 ? 1 / Math.sqrt(energy) : 0;
  for (let i = 0; i < length; i++) impulse[i] = impulse[i]! * scale;
  return impulse;
}

/** Load `/audio/pa-ir.wav` when the deployment ships one; errors are ignored. */
export async function loadPaImpulse(
  ctx: BaseAudioContext,
  fetcher: typeof fetch = fetch,
): Promise<AudioBuffer | undefined> {
  try {
    const response = await fetcher("/audio/pa-ir.wav");
    if (!response.ok) return undefined;
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength <= 0) return undefined;
    const decoded = await new Promise<AudioBuffer>((resolve, reject) =>
      ctx.decodeAudioData(bytes, resolve, reject),
    );
    return decoded.numberOfChannels === 1 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function saturationCurve(amount = 1.6) {
  const size = 1024;
  const curve = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  return curve;
}

/**
 * Build the PA chain. Everything plugged into `input` leaves through
 * `output` sounding like a small high-mounted cabinet; the impulse response
 * is swapped in asynchronously when the real file loads.
 */
export function createPaChain(ctx: BaseAudioContext): {
  input: AudioNode;
  output: AudioNode;
} {
  const input = ctx.createGain();
  const highpass = ctx.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = PA_BAND.highpass;
  highpass.Q.value = 0.7;
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = PA_BAND.lowpass;
  lowpass.Q.value = 0.8;
  const presence = ctx.createBiquadFilter();
  presence.type = "peaking";
  presence.frequency.value = 1800;
  presence.Q.value = 1.1;
  presence.gain.value = 3;
  const shaper = ctx.createWaveShaper();
  shaper.curve = saturationCurve();
  shaper.oversample = "2x";
  const convolver = ctx.createConvolver();
  convolver.normalize = true;
  let fallback: AudioBuffer | undefined;
  try {
    fallback = ctx.createBuffer(
      1,
      Math.max(1, Math.round(ctx.sampleRate * 0.42)),
      ctx.sampleRate,
    );
    fallback.copyToChannel(
      new Float32Array(synthesizePaImpulse(ctx.sampleRate)),
      0,
    );
  } catch {
    fallback = undefined;
  }
  if (fallback) convolver.buffer = fallback;
  const output = ctx.createGain();
  output.gain.value = 1;
  input.connect(highpass);
  highpass.connect(lowpass);
  lowpass.connect(presence);
  presence.connect(shaper);
  shaper.connect(convolver);
  convolver.connect(output);
  void loadPaImpulse(ctx).then((loaded) => {
    if (loaded) convolver.buffer = loaded;
  });
  return { input, output };
}

/**
 * The two-tone attention chime (`at` in context seconds). The returned node
 * is already started; connect it to a destination to hear it.
 */
export function paChime(ctx: BaseAudioContext, at: number): AudioNode {
  const start = Number.isFinite(at)
    ? Math.max(at, ctx.currentTime)
    : ctx.currentTime;
  const output = ctx.createGain();
  output.gain.value = 0.0001;
  const tones = [
    { frequency: 660, from: 0, length: 0.26 },
    { frequency: 990, from: 0.24, length: 0.34 },
  ];
  for (const tone of tones) {
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(tone.frequency, start + tone.from);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start + tone.from);
    gain.gain.exponentialRampToValueAtTime(0.32, start + tone.from + 0.02);
    gain.gain.exponentialRampToValueAtTime(
      0.0001,
      start + tone.from + tone.length,
    );
    osc.connect(gain);
    gain.connect(output);
    osc.start(start + tone.from);
    osc.stop(start + tone.from + tone.length + 0.02);
  }
  return output;
}
