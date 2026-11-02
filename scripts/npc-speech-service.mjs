import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  lstat,
  opendir,
  readFile,
  rmdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpInputError, readJsonBody } from "./http-json.mjs";

export const NPC_SPEECH_TEMP_PREFIX = "zombie-npc-speech-v1-";

export const NPC_SPEECH_VOICES = Object.freeze({
  steady: "Daniel",
  bright: "Karen",
  warm: "Moira",
  low: "Rishi",
});
export const NPC_SPEECH_LIMITS = Object.freeze({
  textChars: 180,
  bodyBytes: 2048,
  fileBytes: 1_000_000,
  totalBytes: 4_000_000,
  pendingTickets: 4,
  durationSeconds: 12,
  ttlMs: 90_000,
  synthesisMs: 15_000,
  concurrency: 1,
});

class SpeechError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Only short public NPC lines enter this service; no URLs or say commands. */
function speechInput(body) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some(
      (key) => !["requestId", "actorId", "text", "voice"].includes(key),
    ) ||
    typeof body.requestId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,100}$/.test(body.requestId) ||
    typeof body.actorId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,80}$/.test(body.actorId) ||
    typeof body.text !== "string" ||
    body.text.length > NPC_SPEECH_LIMITS.textChars ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(body.text) ||
    /\[\[|\]\]|https?:\/\/|file:|data:|www\./i.test(body.text)
  )
    throw new HttpInputError(400, "Invalid NPC speech request");
  const text = body.text.normalize("NFC").replace(/\s+/g, " ").trim(),
    voice = body.voice ?? "steady";
  if (
    !text ||
    text.length > NPC_SPEECH_LIMITS.textChars ||
    typeof voice !== "string" ||
    !Object.hasOwn(NPC_SPEECH_VOICES, voice)
  )
    throw new HttpInputError(400, "Invalid NPC speech text or voice");
  return { requestId: body.requestId, actorId: body.actorId, text, voice };
}

/** Validate actual PCM bytes before issuing a ticket, not a claimed duration. */
function waveInfo(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array))
    throw new SpeechError(502, "Speech renderer returned no audio");
  if (value.byteLength > NPC_SPEECH_LIMITS.fileBytes)
    throw new SpeechError(502, "Speech renderer exceeded the file limit");
  const bytes = Buffer.from(value);
  if (
    bytes.length < 44 ||
    bytes.length > NPC_SPEECH_LIMITS.fileBytes ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE" ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  )
    throw new SpeechError(502, "Speech renderer returned invalid audio");
  let format,
    dataBytes = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = bytes.toString("ascii", offset, offset + 4),
      size = bytes.readUInt32LE(offset + 4),
      start = offset + 8,
      end = start + size;
    if (end > bytes.length)
      throw new SpeechError(502, "Speech renderer returned truncated audio");
    if (kind === "fmt ") {
      if (size < 16 || format)
        throw new SpeechError(502, "Speech renderer returned invalid format");
      format = {
        encoding: bytes.readUInt16LE(start),
        channels: bytes.readUInt16LE(start + 2),
        sampleRate: bytes.readUInt32LE(start + 4),
        byteRate: bytes.readUInt32LE(start + 8),
        blockAlign: bytes.readUInt16LE(start + 12),
        bits: bytes.readUInt16LE(start + 14),
      };
    }
    if (kind === "data") dataBytes += size;
    offset = end + (size % 2);
  }
  if (
    !format ||
    format.encoding !== 1 ||
    format.channels !== 1 ||
    format.sampleRate !== 22_050 ||
    format.byteRate !== 44_100 ||
    format.blockAlign !== 2 ||
    format.bits !== 16 ||
    !dataBytes ||
    dataBytes % 2
  )
    throw new SpeechError(502, "Speech renderer returned unsupported audio");
  const duration = dataBytes / format.byteRate;
  if (duration > NPC_SPEECH_LIMITS.durationSeconds)
    throw new SpeechError(502, "Speech renderer exceeded the duration limit");
  return { bytes, duration: Math.round(duration * 1000) / 1000 };
}

/** The system synthesizer only writes a file. It never uses speakers or a shell. */
function renderMacSpeech({ text, voiceName, path, signal }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(
      "/usr/bin/say",
      [
        "-v",
        voiceName,
        "-r",
        "180",
        "-o",
        path,
        "--file-format=WAVE",
        "--data-format=LEI16@22050",
        "--channels=1",
        "-f",
        "-",
      ],
      { stdio: ["pipe", "ignore", "ignore"], shell: false },
    );
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearInterval(monitor);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      child.kill("SIGKILL");
      finish(new SpeechError(504, "Speech synthesis interrupted"));
    };
    // A misbehaving synthesizer cannot grow a file without a running bound.
    const monitor = setInterval(() => {
      void stat(path)
        .then((info) => {
          if (info.size > NPC_SPEECH_LIMITS.fileBytes) {
            child.kill("SIGKILL");
            finish(
              new SpeechError(502, "Speech synthesis exceeded the file limit"),
            );
          }
        })
        .catch(() => {});
    }, 100);
    monitor.unref();
    child.once("error", () =>
      finish(new SpeechError(503, "Local speech unavailable")),
    );
    child.once("close", (code) =>
      finish(
        code === 0
          ? undefined
          : new SpeechError(502, "Local speech synthesis failed"),
      ),
    );
    child.stdin.on("error", () => {});
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else child.stdin.end(text);
  });
}

/** A signal-zero probe checks ownership liveness without stopping anything. */
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM and unknown probe failures are treated as live: do not guess that
    // another service is dead simply because this process cannot inspect it.
    return error.code !== "ESRCH";
  }
}

/** Reclaim only our versioned, private, dead-owner speech directories. Live
 * instances retain their files even when old; their own TTL timer owns expiry.
 * No recursive deletion follows an unknown file or a directory/file symlink.
 */
async function cleanOrphanSpeech(tempRoot, alive) {
  let root;
  try {
    root = await opendir(tempRoot);
  } catch {
    return;
  }
  let inspected = 0;
  for await (const entry of root) {
    if (!entry.name.startsWith(NPC_SPEECH_TEMP_PREFIX)) continue;
    const match = /^([1-9][0-9]{0,9})-[A-Za-z0-9]{6}$/.exec(
      entry.name.slice(NPC_SPEECH_TEMP_PREFIX.length),
    );
    if (!match) continue;
    if (++inspected > 128) break;
    const pid = Number(match[1]),
      path = join(tempRoot, entry.name);
    if (!Number.isSafeInteger(pid) || pid > 2_147_483_647) continue;
    try {
      const owner = await lstat(path);
      if (
        !owner.isDirectory() ||
        owner.isSymbolicLink() ||
        owner.uid !== process.getuid?.() ||
        (owner.mode & 0o777) !== 0o700 ||
        alive(pid)
      )
        continue;
      const directory = await opendir(path);
      let files = 0;
      for await (const child of directory) {
        if (++files > 32) break;
        if (!/^[a-f0-9]{48}\.wav$/.test(child.name)) continue;
        const file = join(path, child.name),
          metadata = await lstat(file);
        if (
          !metadata.isFile() ||
          metadata.isSymbolicLink() ||
          metadata.uid !== process.getuid?.() ||
          (metadata.mode & 0o777) !== 0o600
        )
          continue;
        // The owner may have become live through PID reuse since enumeration.
        if (alive(pid)) break;
        await rm(file);
      }
      // rmdir refuses nonempty directories, preserving unfamiliar contents.
      if (!alive(pid)) await rmdir(path).catch(() => {});
    } catch {
      // Races, inaccessible folders and uncertain ownership are left untouched.
    }
  }
}

/**
 * Isolated loopback speech transport. A renderer injection is for deterministic
 * tests: async ({text,voice,voiceName,path,signal}) => PCM WAV bytes (or writes
 * `path`). Nothing enters the Claude gateway or durable game/learner storage.
 */
export function createNpcSpeechService(options = {}) {
  const render = options.render ?? renderMacSpeech,
    available =
      !!options.render ||
      ((options.platform ?? process.platform) === "darwin" &&
        existsSync("/usr/bin/say")),
    allowedOrigins = new Set(
      options.allowedOrigins ?? [
        "http://127.0.0.1:5173",
        "http://localhost:5173",
      ],
    ),
    now = options.now ?? Date.now,
    ttlMs = Math.max(
      1,
      Math.min(
        options.ttlMs ?? NPC_SPEECH_LIMITS.ttlMs,
        NPC_SPEECH_LIMITS.ttlMs,
      ),
    ),
    synthesisMs = Math.max(
      1,
      Math.min(
        options.synthesisMs ?? NPC_SPEECH_LIMITS.synthesisMs,
        NPC_SPEECH_LIMITS.synthesisMs,
      ),
    ),
    tickets = new Map();
  let directory,
    active,
    closing = false,
    closePromise,
    residentBytes = 0;
  const ensureDirectory = () =>
    (directory ??= (async () => {
      const root = options.tempRoot ?? tmpdir();
      await cleanOrphanSpeech(root, options.isProcessAlive ?? processAlive);
      let path;
      try {
        path = await mkdtemp(
          join(root, `${NPC_SPEECH_TEMP_PREFIX}${process.pid}-`),
        );
        await chmod(path, 0o700);
      } catch (error) {
        if (path)
          await rm(path, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      return path;
    })().catch((error) => {
      directory = undefined;
      throw error;
    }));
  const drop = (ticket) => {
    const record = tickets.get(ticket);
    if (!record) return;
    tickets.delete(ticket);
    residentBytes -= record.bytes;
    return record;
  };
  const sweep = async () => {
    const expired = [];
    for (const [ticket, record] of tickets)
      if (record.expiresAt <= now()) expired.push(drop(ticket));
    await Promise.all(
      expired.map((record) => rm(record.path, { force: true })),
    );
  };
  const timer = setInterval(
    () => {
      void sweep().catch(() => {});
    },
    Math.min(1000, ttlMs),
  );
  timer.unref();
  const send = (res, status, body) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(JSON.stringify(body));
  };
  const status = () => ({
    available: available && !closing,
    provider: "local-speech",
    voices: Object.keys(NPC_SPEECH_VOICES),
    pending: tickets.size,
    synthesizing: !!active,
    limits: NPC_SPEECH_LIMITS,
  });
  return {
    status,
    async route(req, res) {
      const url = new URL(req.url, "http://127.0.0.1"),
        ticketMatch = /^\/api\/speech\/([a-f0-9]{48})$/.exec(url.pathname);
      if (
        !["/api/speech", "/api/speech/status"].includes(url.pathname) &&
        !ticketMatch
      )
        return false;
      try {
        const origin = req.headers.origin;
        if (
          (origin !== undefined && !allowedOrigins.has(origin)) ||
          (!origin && ["POST", "DELETE"].includes(req.method)) ||
          !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? "")
        )
          throw new HttpInputError(403, "Game origin required for speech");
        if (closing) throw new SpeechError(503, "Speech service closed");
        await sweep();
        if (url.pathname === "/api/speech/status" && req.method === "GET") {
          send(res, 200, status());
          return true;
        }
        if (ticketMatch && ["GET", "DELETE"].includes(req.method)) {
          const record = drop(ticketMatch[1]);
          if (!record)
            throw new SpeechError(410, "Speech audio expired or consumed");
          let bytes;
          try {
            if (req.method === "GET") bytes = await readFile(record.path);
          } finally {
            // Deletion completes before acknowledging consumption to the game.
            await rm(record.path, { force: true });
          }
          if (req.method === "DELETE") {
            res.writeHead(204);
            res.end();
          } else {
            res.writeHead(200, {
              "Content-Type": "audio/wav",
              "Content-Length": bytes.length,
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            });
            res.end(bytes);
          }
          return true;
        }
        if (url.pathname === "/api/speech" && req.method === "POST") {
          const input = speechInput(
            await readJsonBody(req, NPC_SPEECH_LIMITS.bodyBytes),
          );
          if (closing) throw new SpeechError(503, "Speech service closed");
          if (!available)
            throw new SpeechError(
              503,
              "Local speech unavailable on this computer",
            );
          if (active) throw new SpeechError(429, "Speech synthesis is busy");
          if (
            tickets.size >= NPC_SPEECH_LIMITS.pendingTickets ||
            residentBytes >= NPC_SPEECH_LIMITS.totalBytes
          )
            throw new SpeechError(
              429,
              "Consume pending speech audio before requesting more",
            );
          const controller = new AbortController(),
            session = { controller },
            abort = () => controller.abort(),
            disconnected = () => {
              if (!res.writableEnded) abort();
            };
          active = session;
          req.once("aborted", abort);
          res.once("close", disconnected);
          const timeout = setTimeout(abort, synthesisMs);
          timeout.unref();
          let path;
          try {
            const base = await ensureDirectory();
            if (controller.signal.aborted || closing)
              throw new SpeechError(504, "Speech synthesis interrupted");
            path = join(base, `${randomBytes(24).toString("hex")}.wav`);
            await writeFile(path, Buffer.alloc(0), { mode: 0o600, flag: "wx" });
            if (controller.signal.aborted || closing)
              throw new SpeechError(504, "Speech synthesis interrupted");
            const interrupted = new Promise((_, reject) => {
              const fail = () =>
                reject(new SpeechError(504, "Speech synthesis interrupted"));
              if (controller.signal.aborted) fail();
              else
                controller.signal.addEventListener("abort", fail, {
                  once: true,
                });
            });
            const rendered = await Promise.race([
              render({
                ...input,
                voiceName: NPC_SPEECH_VOICES[input.voice],
                path,
                signal: controller.signal,
              }),
              interrupted,
            ]);
            if (controller.signal.aborted || closing)
              throw new SpeechError(504, "Speech synthesis interrupted");
            if (
              rendered === undefined &&
              (await stat(path)).size > NPC_SPEECH_LIMITS.fileBytes
            )
              throw new SpeechError(
                502,
                "Speech renderer exceeded the file limit",
              );
            const info = waveInfo(rendered ?? (await readFile(path)));
            if (
              residentBytes + info.bytes.length >
              NPC_SPEECH_LIMITS.totalBytes
            )
              throw new SpeechError(429, "Speech audio storage limit reached");
            await writeFile(path, info.bytes, { mode: 0o600 });
            if (controller.signal.aborted || closing)
              throw new SpeechError(504, "Speech synthesis interrupted");
            const ticket = randomBytes(24).toString("hex");
            tickets.set(ticket, {
              path,
              bytes: info.bytes.length,
              expiresAt: now() + ttlMs,
            });
            residentBytes += info.bytes.length;
            path = undefined;
            send(res, 200, {
              requestId: input.requestId,
              actorId: input.actorId,
              text: input.text,
              audio: {
                url: `/api/speech/${ticket}`,
                mime: "audio/wav",
                bytes: info.bytes.length,
                duration: info.duration,
              },
            });
          } finally {
            clearTimeout(timeout);
            req.off("aborted", abort);
            res.off("close", disconnected);
            if (path) await rm(path, { force: true });
            if (active === session) active = undefined;
          }
          return true;
        }
        res.setHeader(
          "Allow",
          ticketMatch
            ? "GET, DELETE"
            : url.pathname.endsWith("/status")
              ? "GET"
              : "POST",
        );
        send(res, 405, { error: "Method not allowed" });
      } catch (error) {
        if (!res.destroyed && !res.headersSent)
          send(
            res,
            error instanceof SpeechError || error instanceof HttpInputError
              ? error.status
              : 502,
            {
              error:
                error instanceof SpeechError || error instanceof HttpInputError
                  ? error.message
                  : "Local speech failed",
            },
          );
      }
      return true;
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      clearInterval(timer);
      active?.controller.abort();
      tickets.clear();
      residentBytes = 0;
      closePromise = (async () => {
        if (directory) {
          const path = await directory.catch(() => undefined);
          if (path) await rm(path, { recursive: true, force: true });
        }
      })();
      return closePromise;
    },
  };
}
