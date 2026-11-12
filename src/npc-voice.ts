import type { AudioDirector } from "./audio";
import { bridgeRequest, status } from "./bridge-client";
import { distance, type Actor, type Game } from "./model";
import { npcCanHearSpeech } from "./npc-hearing";
import {
  classifyNpcSpeechAct,
  npcAddressedListener,
  pickNpcResponders,
} from "./npc-reply-chance";
import { generateNpcDialogue, type NpcDialogueTransport } from "./npc-dialogue";
import {
  buildNpcChatterContext,
  npcChatterCandidates,
  npcChatterStillRelevant,
  npcDialogueFactsStillRelevant,
  type NpcChatterRequest,
  type NpcChatterReply,
  type NpcChatterRecentLine,
  type NpcChatterConversation,
  type NpcChatterDelivery,
} from "./npc-chatter";
import { isRecord } from "./records";
import {
  clearNpcSpeechBubble,
  clearNpcSpeechBubbles,
  showNpcSpeechBubble,
} from "./speech-bubbles";
import { canSee } from "./visibility";
import {
  conversationRequest,
  fallbackConverseLine,
  handleConverseAnswer,
  nextResponder,
  recordUtterance,
  resolveAddressee,
  utteranceById,
  type ConversePayload,
} from "./escape-conversation";
import { npcVoiceKey } from "./voice-key";

/** Lazy to keep voice-identity's module-level slot table out of a cycle. */
async function escapeVoiceSlot(
  identity: import("./escape-types").VoiceIdentity,
  actorId: string,
  seed: number,
) {
  const { npcVoiceSlot } = await import("./voice-identity");
  return npcVoiceSlot(identity, actorId, seed);
}

export const NPC_VOICE_LIMITS = Object.freeze({
  requestMs: 120_000,
  audioBytes: 1_000_000,
  durationSeconds: 12,
  globalSeconds: 20,
  actorSeconds: 45,
  recentLines: 12,
  conversationTurns: 4,
  replyAttempts: 2,
  replySeconds: 30,
  replyGapSeconds: 1.2,
});
interface SpeechTicket {
  requestId: string;
  actorId: string;
  text: string;
  audio: { url: string; mime: string; bytes: number; duration: number };
}
export interface NpcVoiceTransport extends NpcDialogueTransport {
  available(signal: AbortSignal): Promise<boolean>;
  generate(
    request: NpcChatterRequest,
    signal: AbortSignal,
    isActive: () => boolean,
  ): Promise<unknown>;
  /** Escape games only: one open-conversation answer. */
  converse?(
    payload: ConversePayload,
    signal: AbortSignal,
    isActive: () => boolean,
  ): Promise<unknown>;
  synthesize(
    reply: NpcChatterReply,
    voice: string,
    signal: AbortSignal,
  ): Promise<SpeechTicket>;
  download(url: string, signal: AbortSignal): Promise<ArrayBuffer>;
  discard(url: string): Promise<void>;
}
function validTicket(
  value: unknown,
  reply: NpcChatterReply,
): value is SpeechTicket {
  return (
    isRecord(value) &&
    value.requestId === reply.requestId &&
    value.actorId === reply.actorId &&
    value.text === reply.text &&
    isRecord(value.audio) &&
    typeof value.audio.url === "string" &&
    /^\/api\/speech\/[a-f0-9]{48}$/.test(value.audio.url) &&
    value.audio.mime === "audio/wav" &&
    typeof value.audio.bytes === "number" &&
    value.audio.bytes > 0 &&
    value.audio.bytes <= NPC_VOICE_LIMITS.audioBytes &&
    typeof value.audio.duration === "number" &&
    Number.isFinite(value.audio.duration) &&
    value.audio.duration > 0 &&
    value.audio.duration <= NPC_VOICE_LIMITS.durationSeconds
  );
}
async function boundedAudio(response: Response) {
  if (
    !response.ok ||
    response.headers.get("Content-Type")?.split(";")[0] !== "audio/wav"
  )
    throw Error("NPC voice download failed");
  if (
    Number(response.headers.get("Content-Length")) > NPC_VOICE_LIMITS.audioBytes
  ) {
    await response.body?.cancel();
    throw Error("NPC voice exceeded its byte limit");
  }
  if (!response.body) throw Error("Missing NPC voice audio");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > NPC_VOICE_LIMITS.audioBytes) {
        await reader.cancel();
        throw Error("NPC voice exceeded its byte limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes.buffer;
}
export const npcVoiceTransport: NpcVoiceTransport = {
  async available(signal) {
    const response = await fetch("/api/speech/status", {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    if (!response.ok) return false;
    const value: unknown = await response.json();
    return (
      isRecord(value) &&
      value.available === true &&
      value.provider === "local-speech"
    );
  },
  generate: (request, signal, isActive) =>
    bridgeRequest("npc-chatter", request, {
      signal,
      isActive,
      timeoutMs: NPC_VOICE_LIMITS.requestMs,
    }),
  review: (request, signal, isActive) =>
    bridgeRequest("npc-chatter-review", request, {
      signal,
      isActive,
      timeoutMs: NPC_VOICE_LIMITS.requestMs,
    }),
  converse: (payload, signal, isActive) =>
    bridgeRequest("escape-converse", payload, {
      signal,
      isActive,
      timeoutMs: NPC_VOICE_LIMITS.requestMs,
    }),
  async synthesize(reply, voice, signal) {
    const response = await fetch("/api/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: reply.requestId,
        actorId: reply.actorId,
        text: reply.text,
        voice,
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    const ticket: unknown = await response.json();
    if (!response.ok || !validTicket(ticket, reply))
      throw Error("NPC voice synthesis failed");
    return ticket;
  },
  async download(url, signal) {
    return boundedAudio(await fetch(url, { signal }));
  },
  async discard(url) {
    await fetch(url, {
      method: "DELETE",
      signal: AbortSignal.timeout(1500),
    }).catch(() => {});
  },
};
/** The fifteen narrator slots, in the same order as the speech service's map. */
export const NPC_VOICE_SLOTS = Object.freeze([
  "steady",
  "bright",
  "warm",
  "low",
  "crisp",
  "gruff",
  "soft",
  "lively",
  "clear",
  "keen",
  "calm",
  "even",
  "quick",
  "poised",
  "dry",
] as const);
/**
 * The same fifteen slots, split by the gender of their mapped Kokoro voice.
 * A run picks a group with even odds, then a slot inside it uniformly.
 */
export const NPC_VOICE_GROUPS = Object.freeze({
  male: Object.freeze(["steady", "low", "gruff", "lively", "dry"] as const),
  female: Object.freeze([
    "bright",
    "warm",
    "crisp",
    "soft",
    "clear",
    "keen",
    "calm",
    "even",
    "quick",
    "poised",
  ] as const),
});
export type NpcVoiceSlot = (typeof NPC_VOICE_SLOTS)[number];
export type NpcVoiceGender = keyof typeof NPC_VOICE_GROUPS;
/** 32-bit FNV-1a over the run/actor seed, independent of locale and host. */
function npcVoiceSeed(runId: string, actorId: string) {
  let hash = 0x811c9dc5;
  for (const char of `${runId}\u0000${actorId}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
/** mulberry32, returning successive floats in [0, 1). */
function npcVoiceRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** One narrator slot per run and actor: stable within a run, fresh next run. */
export function npcVoiceFor(runId: string, actorId: string): NpcVoiceSlot {
  const random = npcVoiceRandom(npcVoiceSeed(runId, actorId));
  const group =
    random() < 0.5 ? NPC_VOICE_GROUPS.male : NPC_VOICE_GROUPS.female;
  return group[Math.floor(random() * group.length)]!;
}
type VoiceAudio = Pick<
  AudioDirector,
  "canSpeak" | "decodeSpeech" | "speak" | "stopSpeech"
>;
interface ConversationTurn {
  id: string;
  last: NpcChatterRecentLine;
  anchor: NpcChatterRequest;
  nextAt: number;
  expiresAt: number;
  expiresWallAt: number;
  attempted: Set<string>;
  participants: Set<string>;
  responders: string[];
}
interface PlayingSpeech {
  id: string;
  actorId: string;
  delivery?: NpcChatterDelivery;
  heardBy: Set<string>;
  request: NpcChatterRequest;
}

/** One background request/temporary buffer at a time. It never blocks step(). */
export class NpcVoiceDirector {
  message = "NPC voices wait for the study connection.";
  private game?: Game;
  private runId = "";
  private lastTime = 0;
  private epoch = 0;
  private controller?: AbortController;
  private pending?: Promise<void>;
  private request?: NpcChatterRequest;
  private evidence?: { request: NpcChatterRequest; ids: string[] };
  private playing?: PlayingSpeech;
  private conversation?: ConversationTurn;
  private nextAt = 0;
  private nextCheck = 0;
  private nextAvailability = 0;
  private available: boolean | undefined;
  private recent: NpcChatterRecentLine[] = [];
  private spoken = new Map<string, number>();
  private active = false;
  private escapeLoop = "";
  private greeted = new Set<string>();
  private paSeen = new Set<string>();
  private escapeReply?: { utteranceId: string; at: number };
  private escapePlaying?: {
    actorId: string;
    id: string;
    addresseeId?: string;
    until: number;
  };
  constructor(
    private audio: VoiceAudio,
    private transport: NpcVoiceTransport = npcVoiceTransport,
    private bridgeReady = () =>
      status().mode !== "development" &&
      status().capabilities.includes("npc-chatter") &&
      status().capabilities.includes("npc-chatter-review"),
    private random = Math.random,
  ) {
    playerVoiceDirector = this;
  }

  update(game: Game) {
    if (
      this.game !== game ||
      this.runId !== game.id ||
      game.time < this.lastTime
    ) {
      this.cancel();
      this.game = game;
      this.runId = game.id;
      this.recent = [];
      this.spoken.clear();
      this.nextAt = game.time + 6;
      this.nextCheck = 0;
      this.available = undefined;
      this.nextAvailability = 0;
      this.escapeLoop = "";
      this.greeted.clear();
      this.paSeen.clear();
      this.escapeReply = undefined;
      this.escapePlaying = undefined;
    }
    this.lastTime = game.time;
    const enabled =
      game.settings.npcVoices !== false &&
      game.settings.volume > 0 &&
      game.status === "playing" &&
      !game.paused &&
      !game.studyWorkspace?.enabled &&
      this.bridgeReady();
    if (!enabled) {
      if (this.active) this.cancel();
      this.active = false;
      this.message =
        game.settings.npcVoices === false
          ? "NPC voices are off."
          : "NPC voices wait for the study connection.";
      return;
    }
    this.active = true;
    if (game.escape) {
      this.updateEscape(game);
      return;
    }
    if (game.time < this.nextCheck) return;
    this.nextCheck = game.time + 0.5;
    if (
      this.playing &&
      !npcChatterStillRelevant(game, this.playing.request, true)
    )
      this.cancel();
    if (this.playing) {
      const hearing = new Set(
        this.heardBy(game, this.playing.actorId, this.playing.delivery),
      );
      this.playing.heardBy = new Set(
        [...this.playing.heardBy].filter((id) => hearing.has(id)),
      );
    }
    if (
      this.conversation &&
      !this.conversationCurrent(game, this.conversation, !!this.playing)
    ) {
      if (this.request?.conversation || this.playing) this.cancel();
      else this.finishConversation(game);
    }
    if (
      this.request &&
      (!npcChatterStillRelevant(game, this.request) ||
        (this.evidence &&
          !npcDialogueFactsStillRelevant(
            game,
            this.evidence.request,
            this.evidence.ids,
          )))
    )
      this.cancel();
    if (this.pending || this.playing || !this.audio.canSpeak(game)) return;
    if (
      this.available === undefined ||
      (!this.available && Date.now() >= this.nextAvailability)
    ) {
      this.checkAvailability(game);
      return;
    }
    if (!this.available) return;
    const turn = this.conversation;
    if (game.time < (turn?.nextAt ?? this.nextAt)) return;
    const nearby = npcChatterCandidates(game);
    let actor: (typeof nearby)[number] | undefined;
    let conversation: NpcChatterConversation | undefined;
    if (turn) {
      const source = game.survivors.find((a) => a.id === turn.last.actorId);
      const hearing = new Set(
        this.heardBy(game, turn.last.actorId, turn.last.delivery),
      );
      actor = turn.responders
        .map((id) => nearby.find((a) => a.id === id))
        .find((a) => a && hearing.has(a.id) && !turn.attempted.has(a.id));
      if (
        !source ||
        turn.attempted.size >= NPC_VOICE_LIMITS.replyAttempts ||
        !actor
      ) {
        this.finishConversation(game);
        return;
      }
      turn.attempted.add(actor.id);
      conversation = {
        id: turn.id,
        replyTo: turn.last.id!,
        sourceActorId: turn.last.actorId,
        turn: turn.last.turn! + 1,
        maxTurns: NPC_VOICE_LIMITS.conversationTurns,
        expiresAt: turn.expiresAt,
        heard: {
          addressed: npcAddressedListener(
            turn.last.text,
            actor,
            game.survivors.filter(
              (a) => a.id !== source.id && turn.last.heardBy?.includes(a.id),
            ),
          ),
          act: classifyNpcSpeechAct(turn.last.text, turn.last.delivery),
          distance: Math.round(distance(actor, source) * 10) / 10,
        },
      };
    } else {
      const candidates = nearby.filter(
        (a) =>
          game.time - (this.spoken.get(a.id) ?? -Infinity) >=
          NPC_VOICE_LIMITS.actorSeconds,
      );
      if (!candidates.length) return;
      actor =
        candidates[
          Math.min(
            candidates.length - 1,
            Math.floor(this.random() * candidates.length),
          )
        ];
    }
    let request: NpcChatterRequest;
    try {
      request = buildNpcChatterContext(
        game,
        actor,
        `voice-${crypto.randomUUID()}`,
        this.recent,
        conversation,
      );
    } catch {
      this.finishConversation(game);
      return;
    }
    this.request = request;
    this.evidence = undefined;
    this.nextAt =
      game.time + NPC_VOICE_LIMITS.globalSeconds + this.random() * 10;
    this.spoken.set(actor.id, game.time);
    const epoch = this.epoch,
      controller = new AbortController();
    this.controller = controller;
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(
        conversation
          ? Math.max(
              1,
              Math.min(
                NPC_VOICE_LIMITS.replySeconds * 1000,
                turn!.expiresWallAt - Date.now(),
              ),
            )
          : NPC_VOICE_LIMITS.requestMs,
      ),
    ]);
    const live = () =>
      !signal.aborted &&
      this.epoch === epoch &&
      this.game === game &&
      this.active &&
      game.settings.npcVoices !== false &&
      this.bridgeReady() &&
      (!turn ||
        (this.conversation === turn && this.conversationCurrent(game, turn))) &&
      npcChatterStillRelevant(game, request) &&
      (!this.evidence ||
        npcDialogueFactsStillRelevant(
          game,
          this.evidence.request,
          this.evidence.ids,
        ));
    this.message = conversation
      ? "A nearby survivor may respond; gameplay continues."
      : "Waiting for a contextual NPC line; gameplay continues.";
    const work = this.produce(game, request, signal, live);
    this.pending = work;
    void work.finally(() => {
      if (this.pending === work) this.pending = undefined;
      if (this.controller === controller) this.controller = undefined;
      if (this.request === request) {
        this.request = undefined;
        this.evidence = undefined;
      }
      if (turn && this.conversation === turn && !this.playing) {
        turn.nextAt = game.time + this.replyGap();
      }
    });
  }

  private checkAvailability(game: Game) {
    const epoch = this.epoch,
      controller = new AbortController();
    this.controller = controller;
    const work = (async () => {
      try {
        const ready = await this.transport.available(controller.signal);
        if (this.epoch === epoch && this.game === game) {
          this.available = ready;
          this.nextAvailability = Date.now() + 30_000;
          this.message = ready
            ? "Computer-generated NPC voices are ready."
            : "Local computer voices are unavailable.";
        }
      } catch {
        if (this.epoch === epoch) {
          this.available = false;
          this.nextAvailability = Date.now() + 30_000;
        }
      }
    })();
    this.pending = work;
    void work.finally(() => {
      if (this.pending === work) this.pending = undefined;
      if (this.controller === controller) this.controller = undefined;
    });
  }

  private async produce(
    game: Game,
    request: NpcChatterRequest,
    signal: AbortSignal,
    live: () => boolean,
  ) {
    let ticket: SpeechTicket | undefined;
    try {
      const reply = await generateNpcDialogue(request, this.transport, {
        signal,
        isActive: live,
        onEvidence: (context, ids) => {
          if (this.request === request)
            this.evidence = { request: context, ids: [...ids] };
        },
        isEvidenceCurrent: (context, ids) =>
          npcDialogueFactsStillRelevant(game, context, ids),
      });
      if (!reply || !live()) {
        if (live())
          this.message =
            "NPCs stay quiet when there is nothing fitting to say.";
        return;
      }
      const contextKey = JSON.stringify(
        this.evidence?.ids
          .slice()
          .sort()
          .map((id) => [
            id,
            this.evidence?.request.dialogue?.facts.find((f) => f.id === id)
              ?.key,
          ]),
      );
      const wording = (text: string) =>
        text
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, " ")
          .trim();
      if (
        this.recent.some(
          (line) =>
            line.actorId === reply.actorId &&
            wording(line.text) === wording(reply.text) &&
            line.contextKey === contextKey,
        )
      )
        return;
      ticket = await this.transport.synthesize(
        reply,
        npcVoiceFor(this.runId || game.id, reply.actorId),
        signal,
      );
      if (!validTicket(ticket, reply) || !live()) return;
      const bytes = await this.transport.download(ticket.audio.url, signal);
      if (
        !live() ||
        bytes.byteLength <= 0 ||
        bytes.byteLength > NPC_VOICE_LIMITS.audioBytes
      )
        return;
      const buffer = await this.audio.decodeSpeech(bytes);
      if (
        !buffer ||
        !live() ||
        !Number.isFinite(buffer.duration) ||
        buffer.duration <= 0 ||
        buffer.duration > NPC_VOICE_LIMITS.durationSeconds
      )
        return;
      const epoch = this.epoch;
      const participants = new Set(this.conversation?.participants);
      participants.add(reply.actorId);
      const heardBy = new Set(
        this.heardBy(game, reply.actorId, reply.delivery),
      );
      const at = game.time;
      const conversationId = request.conversation?.id ?? reply.requestId;
      const turnNumber = request.conversation?.turn ?? 1;
      const onEnded = (completed = true) => {
        clearNpcSpeechBubble(game, reply.actorId, reply.requestId);
        if (this.playing?.id === reply.requestId) {
          const heardThroughout = this.playing.heardBy;
          this.playing = undefined;
          this.message = "Computer-generated NPC voices are ready.";
          if (
            !completed ||
            this.epoch !== epoch ||
            this.game !== game ||
            !this.active ||
            game.paused ||
            game.settings.npcVoices === false ||
            game.settings.volume <= 0
          ) {
            this.finishConversation(game);
            return;
          }
          const currentHearing = new Set(
            this.heardBy(game, reply.actorId, reply.delivery),
          );
          const line: NpcChatterRecentLine = {
            id: reply.requestId,
            actorId: reply.actorId,
            speakerName: game.survivors.find((a) => a.id === reply.actorId)
              ?.name,
            text: reply.text,
            at,
            contextKey,
            heardBy: [...heardThroughout].filter((id) =>
              currentHearing.has(id),
            ),
            ...(reply.delivery === undefined
              ? {}
              : { delivery: reply.delivery }),
            conversationId,
            turn: turnNumber,
          };
          this.recent = [...this.recent, line].slice(
            -NPC_VOICE_LIMITS.recentLines,
          );
          if (
            reply.conversation?.intent !== "close" &&
            turnNumber < NPC_VOICE_LIMITS.conversationTurns &&
            npcChatterStillRelevant(game, request, true) &&
            this.bridgeReady()
          ) {
            const speaker = game.survivors.find((a) => a.id === reply.actorId)!;
            const nameCandidates = game.survivors.filter(
              (a) => a !== speaker && line.heardBy?.includes(a.id),
            );
            const listeners = nameCandidates.filter(
              (a) => a !== game.survivors[0] && a.id !== "human",
            );
            const responders = pickNpcResponders(
              game,
              speaker,
              line,
              listeners,
              {
                intent: reply.conversation?.intent,
                participants,
                nameCandidates,
              },
              this.random(),
            );
            if (!responders.length) {
              // An unanswered remark keeps the quiet interval measured from
              // its playback start; only a lapsed exchange adds a pause.
              if (request.conversation) this.finishConversation(game);
              else this.conversation = undefined;
              return;
            }
            // A completed turn starts a fresh opportunity. Its baseline must
            // not retain the deadline of the earlier line it answered.
            const anchor = { ...request };
            delete anchor.conversation;
            this.conversation = {
              id: conversationId,
              last: line,
              anchor,
              nextAt: game.time + this.replyGap(),
              expiresAt: game.time + NPC_VOICE_LIMITS.replySeconds,
              expiresWallAt: Date.now() + NPC_VOICE_LIMITS.replySeconds * 1000,
              attempted: new Set(),
              participants,
              responders: responders.map((a) => a.id),
            };
          } else if (request.conversation) this.finishConversation(game);
          else this.conversation = undefined;
        }
      };
      if (
        !this.audio.speak(game, {
          id: reply.requestId,
          actorId: reply.actorId,
          ...(reply.delivery === undefined ? {} : { delivery: reply.delivery }),
          buffer,
          onEnded,
        })
      )
        return;
      this.playing = {
        id: reply.requestId,
        actorId: reply.actorId,
        ...(reply.delivery === undefined ? {} : { delivery: reply.delivery }),
        heardBy,
        request,
      };
      // Playback now owns freshness. Ticket disposal may still be pending;
      // its older generation deadline must not cancel an on-time utterance
      // or the next opportunity created when that utterance finishes.
      if (this.request === request) {
        this.request = undefined;
        this.evidence = undefined;
      }
      this.nextAt = Math.max(
        this.nextAt,
        game.time + NPC_VOICE_LIMITS.globalSeconds + this.random() * 10,
      );
      showNpcSpeechBubble(game, {
        id: reply.requestId,
        actorId: reply.actorId,
        text: reply.text,
        until: game.time + buffer.duration,
      });
      this.spoken.set(reply.actorId, game.time);
      this.message = "Computer-generated NPC speech is playing.";
    } catch {
      if (live())
        this.message = "NPC voice request was unavailable; gameplay continues.";
    } finally {
      if (this.game === game && this.runId === request.runId)
        this.nextAt = Math.max(this.nextAt, game.time + 5);
      if (
        ticket &&
        /^\/api\/speech\/[a-f0-9]{48}$/.test(ticket.audio?.url ?? "")
      )
        await this.transport.discard(ticket.audio.url).catch(() => {});
    }
  }

  private cancel() {
    this.epoch++;
    this.controller?.abort();
    this.request = undefined;
    this.evidence = undefined;
    const playing = this.playing;
    this.playing = undefined;
    if (this.game && this.conversation) this.finishConversation(this.game);
    this.conversation = undefined;
    if (playing) this.audio.stopSpeech(playing.id);
    if (this.game) clearNpcSpeechBubbles(this.game);
  }
  private heardBy(game: Game, actorId: string, delivery?: NpcChatterDelivery) {
    const speaker = game.survivors.find((a) => a.id === actorId);
    if (!speaker) return [];
    return game.survivors
      .filter((a) => npcCanHearSpeech(game, a, speaker, delivery))
      .map((a) => a.id);
  }
  private replyGap() {
    return NPC_VOICE_LIMITS.replyGapSeconds + this.random() * 1.8;
  }
  private conversationCurrent(
    game: Game,
    turn: ConversationTurn,
    completingPlayback = false,
  ) {
    return (
      (completingPlayback ||
        (game.time < turn.expiresAt && Date.now() < turn.expiresWallAt)) &&
      npcChatterStillRelevant(game, turn.anchor)
    );
  }
  private finishConversation(game: Game) {
    this.conversation = undefined;
    this.nextAt = Math.max(
      this.nextAt,
      game.time + NPC_VOICE_LIMITS.globalSeconds + this.random() * 10,
    );
  }
  /**
   * Escape games replace ambient chatter with scripted prompts, first-meeting
   * greetings and open-conversation replies, one speaker at a time.
   */
  private updateEscape(game: Game) {
    const escape = game.escape!;
    const loopKey = `${game.id}:${escape.loop}`;
    if (this.escapeLoop !== loopKey) {
      this.escapeLoop = loopKey;
      this.greeted.clear();
      this.paSeen.clear();
      this.escapeReply = undefined;
      this.escapePlaying = undefined;
    }
    this.announce(game);
    if (this.escapePlaying) {
      if (game.time < this.escapePlaying.until) return;
      clearNpcSpeechBubble(
        game,
        this.escapePlaying.actorId,
        this.escapePlaying.id,
      );
      this.escapePlaying = undefined;
    }
    if (this.pending || this.playing || !this.audio.canSpeak(game)) return;
    if (game.time < this.nextAt) return;
    if (
      this.available === undefined ||
      (!this.available && Date.now() >= this.nextAvailability)
    ) {
      this.checkAvailability(game);
      return;
    }
    if (!this.available) return;
    const cue = this.escapeCue(game);
    if (!cue) return;
    const payload = conversationRequest(game, cue.speakerId, {
      reason: cue.reason,
      addresseeId: cue.addresseeId,
    });
    const epoch = this.epoch,
      controller = new AbortController();
    this.controller = controller;
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(NPC_VOICE_LIMITS.requestMs),
    ]);
    const live = () =>
      !signal.aborted &&
      this.epoch === epoch &&
      this.game === game &&
      this.active &&
      game.settings.npcVoices !== false &&
      game.status === "playing" &&
      !game.paused;
    this.message = "A nearby survivor may respond; gameplay continues.";
    const work = this.speakEscapeLine(game, cue, payload, signal, live);
    this.pending = work;
    void work.finally(() => {
      if (this.pending === work) this.pending = undefined;
      if (this.controller === controller) this.controller = undefined;
    });
  }

  private escapeCue(game: Game) {
    const now = game.time;
    const reply = this.escapeReply;
    if (reply) {
      if (now >= reply.at) {
        this.escapeReply = undefined;
        const utterance = utteranceById(game, reply.utteranceId);
        const responder = utterance
          ? nextResponder(game, utterance, now, this.random)
          : undefined;
        if (utterance && responder)
          return {
            speakerId: responder,
            reason: "reply",
            addresseeId: utterance.speakerId,
          };
      }
    }
    const prompts = game.escape!.prompts;
    while (prompts.length && now - prompts[0]!.at > 30) prompts.shift();
    const prompt = prompts.shift();
    if (prompt) return { speakerId: prompt.npcId, reason: prompt.reason };
    const human = game.survivors.find((a) => a.id === "human");
    if (!human) return undefined;
    const floor = game.floors[human.floor];
    if (!floor) return undefined;
    const nearby = game.survivors.find(
      (a) =>
        a.id !== "human" &&
        a.alive &&
        !a.escaped &&
        !this.greeted.has(a.id) &&
        a.floor === human.floor &&
        distance(a, human) <= 4 &&
        canSee(floor, a, human, 6),
    );
    if (!nearby) return undefined;
    this.greeted.add(nearby.id);
    return {
      speakerId: nearby.id,
      reason: "greet the player in passing",
      addresseeId: "human",
    };
  }

  private async speakEscapeLine(
    game: Game,
    cue: { speakerId: string; reason: string; addresseeId?: string },
    payload: ConversePayload,
    signal: AbortSignal,
    live: () => boolean,
  ): Promise<void> {
    let raw: unknown;
    try {
      raw = this.transport.converse
        ? await this.transport.converse(payload, signal, live)
        : undefined;
    } catch {
      raw = undefined;
    }
    if (!live()) return;
    const npc = game.survivors.find((a) => a.id === cue.speakerId);
    if (!npc || npc.id === "human") return;
    const usable =
      isRecord(raw) &&
      raw.speakerId === cue.speakerId &&
      typeof raw.text === "string" &&
      raw.text.trim().length > 0;
    const result = handleConverseAnswer(
      game,
      usable
        ? (raw as { speakerId: string; text: string; outcome?: unknown })
        : {
            speakerId: cue.speakerId,
            ...fallbackConverseLine(game, cue.speakerId),
          },
    );
    if (!result || !live()) return;
    // NPCs of a generated area reuse generator ids (npc-1...), so their voice
    // is keyed by area: a different person keeps a voice of their own.
    const voice = await escapeVoiceSlot(
      game.escape!.voices,
      npcVoiceKey(game.escape!, game.escape!.areas?.current, npc.id),
      game.seed,
    );
    const id = payload.requestId;
    const buffer = await this.synthesizeBuffer(
      id,
      npc.id,
      result.text,
      voice,
      signal,
    );
    if (!buffer || !live()) return;
    const target = cue.addresseeId
      ? game.survivors.find((a) => a.id === cue.addresseeId)
      : undefined;
    const until = game.time + buffer.duration;
    if (target) npc.lookAt = { x: target.x, y: target.y, until };
    const noise = npc as typeof npc & {
      noiseLevel?: number;
      noiseUntil?: number;
    };
    noise.noiseLevel = 5;
    noise.noiseUntil = until;
    if (
      !this.audio.speak(game, {
        id,
        actorId: npc.id,
        delivery: "calm",
        buffer,
        onEnded: () => {
          clearNpcSpeechBubble(game, npc.id, id);
          if (this.escapePlaying?.id === id) this.escapePlaying = undefined;
        },
      })
    )
      return;
    recordUtterance(game, {
      id,
      speakerId: npc.id,
      text: result.text,
      at: game.time,
      floor: npc.floor,
      x: npc.x,
      y: npc.y,
      ...(target ? { addressee: target.id } : {}),
    } as Parameters<typeof recordUtterance>[1]);
    showNpcSpeechBubble(game, {
      id,
      actorId: npc.id,
      text: result.text,
      until,
    });
    this.escapePlaying = {
      actorId: npc.id,
      id,
      ...(target ? { addresseeId: target.id } : {}),
      until,
    };
    this.nextAt = game.time + 1.2 + this.random() * 1.8;
    this.message = "Computer-generated NPC speech is playing.";
  }

  /** Text-to-speech for a single line, reusing the speech service limits. */
  private async synthesizeBuffer(
    requestId: string,
    actorId: string,
    text: string,
    voice: string,
    signal: AbortSignal,
  ) {
    const reply = { requestId, actorId, text } as unknown as NpcChatterReply;
    let ticket: SpeechTicket;
    try {
      ticket = await this.transport.synthesize(reply, voice, signal);
    } catch {
      return undefined;
    }
    if (!validTicket(ticket, reply)) return undefined;
    const bytes = await this.transport
      .download(ticket.audio.url, signal)
      .catch(() => undefined);
    if (!bytes || bytes.byteLength <= 0) return undefined;
    const buffer = await this.audio.decodeSpeech(bytes).catch(() => undefined);
    if (
      !buffer ||
      !Number.isFinite(buffer.duration) ||
      buffer.duration <= 0 ||
      buffer.duration > NPC_VOICE_LIMITS.durationSeconds
    )
      return undefined;
    return buffer;
  }

  /**
   * Speak as the player. The human's voice is the escape identity's player
   * slot; the line is recorded for replies and given the same noise footprint
   * as NPC speech.
   */
  async speakAsPlayer(game: Game, text: string, yaw: number): Promise<boolean> {
    const trimmed = text.trim();
    if (
      !game.escape ||
      this.game !== game ||
      trimmed.length === 0 ||
      trimmed.length > 200
    )
      return false;
    const human = game.survivors.find((a) => a.id === "human");
    if (!human || !human.alive || human.escaped) return false;
    const listeners = game.survivors.filter(
      (a) => a.id !== human.id && npcCanHearSpeech(game, a, human),
    );
    const addressee = resolveAddressee(
      { x: human.x, y: human.y, yaw },
      trimmed,
      listeners,
    );
    const id = `say-${crypto.randomUUID()}`;
    const heardBy = recordUtterance(game, {
      id,
      speakerId: human.id,
      text: trimmed,
      at: game.time,
      floor: human.floor,
      x: human.x,
      y: human.y,
      ...(addressee ? { addressee } : {}),
    } as Parameters<typeof recordUtterance>[1]);
    this.escapeReply = {
      utteranceId: id,
      at: game.time + 1.2 + this.random() * 1.8,
    };
    const voice = game.escape.voices.player;
    const signal = AbortSignal.timeout(NPC_VOICE_LIMITS.requestMs);
    const buffer = await this.synthesizeBuffer(
      id,
      human.id,
      trimmed,
      voice,
      signal,
    );
    void heardBy;
    if (
      !buffer ||
      !this.audio.speak(game, {
        id,
        actorId: human.id,
        delivery: "calm",
        buffer,
        onEnded: () => clearNpcSpeechBubble(game, human.id, id),
      })
    )
      return false;
    const noise = human as typeof human & {
      noiseLevel?: number;
      noiseUntil?: number;
    };
    noise.noiseLevel = 5;
    noise.noiseUntil = game.time + buffer.duration;
    if (addressee) {
      const target = game.survivors.find((a) => a.id === addressee);
      if (target)
        human.lookAt = {
          x: target.x,
          y: target.y,
          until: game.time + buffer.duration,
        };
    }
    showNpcSpeechBubble(game, {
      id,
      actorId: human.id,
      text: trimmed,
      until: game.time + buffer.duration,
    });
    return true;
  }

  /** New PA announcements: chime, then the announcement, non-spatially. */
  private announce(game: Game) {
    const escape = game.escape!;
    const human = game.survivors.find((a) => a.id === "human");
    if (!human) return;
    for (const announcement of escape.announcements) {
      if (this.paSeen.has(announcement.id)) continue;
      this.paSeen.add(announcement.id);
      if (!this.paAudible(game, announcement.areaId, human)) continue;
      void this.playAnnouncement(game, announcement.id, announcement.text);
    }
  }

  private paAudible(game: Game, areaId: string | undefined, human: Actor) {
    const escape = game.escape;
    if (!escape) return false;
    if (areaId && escape.areas.current !== areaId) return false;
    const floor = game.floors[human.floor] as
      { rooms?: { x: number; y: number; w: number; h: number }[] } | undefined;
    const rooms = floor?.rooms ?? [];
    return (
      rooms.length > 0 &&
      rooms.some(
        (room) =>
          human.x >= room.x &&
          human.x < room.x + room.w &&
          human.y >= room.y &&
          human.y < room.y + room.h,
      )
    );
  }

  private async playAnnouncement(
    game: Game,
    announcementId: string,
    text: string,
  ): Promise<void> {
    const audio = this.audio as VoiceAudio &
      Partial<Pick<AudioDirector, "canAnnounce" | "speakAnnouncement">>;
    const escape = game.escape;
    if (!escape || !audio.canAnnounce?.(game)) return;
    const id = `pa-${announcementId}`;
    const line = text.trim().slice(0, 300);
    if (!line) return;
    const buffer = await this.synthesizeBuffer(
      id,
      "pa",
      line,
      escape.voices.pa,
      AbortSignal.timeout(NPC_VOICE_LIMITS.requestMs),
    );
    if (!buffer || this.game !== game) return;
    audio.speakAnnouncement?.(game, { id, text: line, buffer });
  }

  dispose() {
    this.cancel();
    this.active = false;
    if (playerVoiceDirector === this) playerVoiceDirector = undefined;
  }
}

let playerVoiceDirector: NpcVoiceDirector | undefined;
/** The most recent director; main.ts keeps its instance for the player chat. */
export function setPlayerVoiceDirector(director: NpcVoiceDirector | undefined) {
  playerVoiceDirector = director;
}
/** Speak a player line through the live director (escape games only). */
export function speakAsPlayer(game: Game, text: string, yaw: number) {
  return playerVoiceDirector?.speakAsPlayer(game, text, yaw) ?? false;
}
