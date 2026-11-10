import {
  NPC_KOKORO_VOICES,
  pcmWaveFromFloat,
  renderMacSpeech,
} from "./npc-speech-service.mjs";

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

/** Load the quantized local model; a dynamic import keeps ONNX out of startup. */
async function defaultLoadTts() {
  const { KokoroTTS } = await import("kokoro-js");
  return KokoroTTS.from_pretrained(MODEL, { dtype: "q8", device: "cpu" });
}

function abortError() {
  const error = new Error("Speech synthesis interrupted");
  error.status = 504;
  return error;
}

/**
 * Local Kokoro-82M narrator. The model warms up as soon as the renderer exists,
 * so the first lines use `say` instead of waiting for a ~20 s download/load.
 * `render` returns PCM WAV bytes, or whatever the fallback returns.
 */
export function createKokoroRenderer({ fallback, loadTts, onStatus } = {}) {
  const delegate = fallback ?? renderMacSpeech;
  const report = (value) => {
    try {
      onStatus?.(value);
    } catch {
      // A status listener cannot break narration.
    }
  };
  let tts,
    failed = false,
    ready = false;
  const loading = (async () => {
    try {
      tts = await (loadTts ?? defaultLoadTts)();
      ready = !!tts;
      report(ready ? "ready" : "failed");
    } catch {
      failed = true;
      tts = undefined;
      report("failed");
    }
    return tts;
  })();
  async function render({ text, voice, voiceName, path, signal } = {}) {
    if (signal?.aborted) throw abortError();
    if (!ready || failed || !tts)
      return delegate({ text, voice, voiceName, path, signal });
    if (signal?.aborted) throw abortError();
    let audio;
    try {
      audio = await tts.generate(text, {
        voice: NPC_KOKORO_VOICES[voice] ?? NPC_KOKORO_VOICES.steady,
      });
    } catch {
      // Generation is best effort: the system voice still speaks this line.
      return delegate({ text, voice, voiceName, path, signal });
    }
    if (signal?.aborted) throw abortError();
    if (!audio?.audio?.length || !(audio.sampling_rate > 0))
      return delegate({ text, voice, voiceName, path, signal });
    return pcmWaveFromFloat(audio.audio, audio.sampling_rate);
  }
  render.ready = () => ready;
  render.loaded = loading;
  return render;
}
