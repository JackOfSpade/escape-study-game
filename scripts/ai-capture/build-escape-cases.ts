/**
 * Build offline ladder cases for the seven escape-mode game AI calls.
 *
 * The script never talks to a model, gateway or network. It seeds real
 * playable games, installs a capturing (and refusing) requester on each of the
 * game's own payload builders, drives those builders through their real
 * schedules and writes the captured payloads as `<out>/<operation>.json` case
 * arrays for `scripts/ai-ladder.mjs`.
 *
 *   node --import tsx scripts/ai-capture/build-escape-cases.ts --out <dir> [--per-op N]
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prefetchArea, registerArea, setAreaRequest } from "../../src/areas";
import {
  escapeRead,
  resetDirectorRequest,
  setDirectorRequest,
} from "../../src/director";
import {
  conversationRequest,
  recordUtterance,
} from "../../src/escape-conversation";
import {
  endLoop,
  epilogueForNewGame,
  prepareCatastrophe,
  resetEscapeRequest,
  setEscapeRequest,
} from "../../src/escape-prepare";
import { escapeFrame, escapeInteract } from "../../src/escape-runtime";
import { createEscapeState, loopReset } from "../../src/escape-state";
import type { AreaStub, VoiceGender } from "../../src/escape-types";
import { commitFact, learn } from "../../src/fact-ledger";
import type { Game, Roadmap } from "../../src/model";
import { readableInFront } from "../../src/readables";
import { observableSceneDetails } from "../../src/scene-observations";
import { createPlayableGame } from "../../src/world";

export const OPERATIONS = [
  "escape-engage",
  "escape-converse",
  "escape-pa",
  "escape-intent",
  "escape-epilogue",
  "escape-area",
  "escape-catastrophe",
] as const;
export type Operation = (typeof OPERATIONS)[number];

export interface EscapeCaptureCase {
  id: string;
  operation: Operation;
  payload: Record<string, unknown>;
}
export type EscapeCaseBook = Record<Operation, EscapeCaptureCase[]>;

/** A case id tags conversation turns so the ladder can apply the reply rule. */
type TurnTag = "first" | "reply";
type Capture = (operation: Operation, payload: unknown, tag?: TurnTag) => void;

const roadmap: Roadmap = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../public/curriculum.json", import.meta.url)),
    "utf8",
  ),
);

const GENDERS: VoiceGender[] = ["female", "male"];

const AREA_NAMES = [
  "The flooded annex",
  "The service mezzanine",
  "The records basement",
  "The loading dock",
  "The maintenance tunnel",
  "The parking ramp",
];

const AREA_BRIEFS = [
  "A half-flooded sub-level office where the water hides the floor layout and old notices still hang on the walls.",
  "A narrow mezzanine above the plant room, crowded with spare parts and a locked observation window.",
  "A records basement of filing shelves, a dead photocopier and a door that only opens from the inside.",
  "A loading dock behind the building with a jammed roller shutter, pallets and a delivery clipboard.",
  "A maintenance tunnel running under the street, lit by emergency lamps and blocked halfway by collapsed shelving.",
  "A parking ramp with a few abandoned cars, a ticket machine and a stairwell back into the lobby.",
];

const FACT_TEXTS = [
  "The stair door on the east side needs a flight-crew badge to open.",
  "The PA console in the lobby can reach every floor but not the parking ramp.",
  "A fire axe hangs beside the stair door on the ground floor.",
  "The night guard keeps the badge in the desk drawer by the entrance.",
  "The service lift stops working once the emergency power drains.",
  "A handwritten notice says the loading dock shutter jams after the first alarm.",
  "The records basement key is on a hook behind the photocopier.",
  "The roof hatch is bolted from the inside and the bolts are rusted through.",
  "Someone dragged a mattress into the third-floor break room and slept there.",
  "The water in the annex is ankle deep and the power sockets are live.",
  "A radio on the mezzanine still receives the emergency broadcast loop.",
  "The fire escape ladder was cut away from the second landing.",
  "The maintenance tunnel floods when the sump pump loses power.",
  "A clipboard at the dock lists the delivery truck that never left.",
];

const JOURNAL_LINES = [
  "East stair door: flight-crew badge",
  "PA console reaches the upper floors",
  "Fire axe by the stair door",
  "The guard has the badge",
  "The lift dies with the emergency power",
  "Dock shutter jams after the alarm",
  "Basement key behind the photocopier",
  "Roof hatch bolts are rusted",
  "Someone slept in the break room",
  "The annex floor is live with water",
  "Mezzanine radio plays the loop",
  "Fire escape ladder cut at the landing",
  "Tunnel floods without the sump pump",
  "A delivery truck never left the dock",
];

const HUMAN_LINES = [
  "Did you hear that announcement just now?",
  "We need to get out before the next sweep.",
  "Do you know where the badge is kept?",
  "The stairs on the east side are locked.",
  "Have you seen the notice about the dock shutter?",
  "I think the power is about to go out.",
  "Can you cover the corridor while I try the hatch?",
  "Someone was sleeping in the break room.",
];

/** A payload fingerprint that ignores the random per-request id. */
export function payloadFingerprint(payload: unknown): string {
  const copy: Record<string, unknown> = {
    ...((payload as Record<string, unknown>) ?? {}),
  };
  delete copy.requestId;
  return createHash("sha256").update(JSON.stringify(copy)).digest("hex");
}

const refuse = (): Promise<never> =>
  Promise.reject(new Error("offline ladder capture"));

const settle = () => new Promise<void>((done) => setImmediate(done));

function seedLedger(g: Game, variant: number): void {
  const escape = g.escape;
  if (!escape) return;
  const count = 1 + (variant % 6);
  for (let i = 0; i < count; i++) {
    const index = (variant * 3 + i) % FACT_TEXTS.length;
    const at = 20 + variant * 7 + i;
    const fact = commitFact(
      escape.ledger,
      {
        text: FACT_TEXTS[index]!,
        subject: { kind: "area", id: "start" },
        source: "director",
        visibility: ["public"],
      },
      at,
    );
    learn(escape.ledger, fact.id, JOURNAL_LINES[index]!, "observation", at);
  }
}

function discoveredAreas(g: Game, variant: number, seed: number): AreaStub[] {
  const stubs: AreaStub[] = [];
  for (let i = 0; i < 1 + (variant % 5); i++) {
    const index = (variant + i) % AREA_NAMES.length;
    const stub: AreaStub = {
      id: `site-${variant + 1}-${i + 1}`,
      name: AREA_NAMES[index]!,
      brief: AREA_BRIEFS[(index + 1) % AREA_BRIEFS.length]!,
      state: "stub",
      seed: seed + i,
    };
    registerArea(g, stub);
    stubs.push(stub);
  }
  return stubs;
}

function freshGame(
  variant: number,
  seedBase: number,
): { g: Game; seed: number; stubs: AreaStub[] } {
  const seed = seedBase + variant * 37,
    g = createPlayableGame(seed, roadmap);
  let escape = createEscapeState(g, {
    gender: GENDERS[variant % GENDERS.length]!,
    seed,
  });
  if (variant % 3 === 2) escape = loopReset(escape);
  g.escape = escape;
  g.status = "playing";
  g.time = 10 + variant * 3;
  const stubs = discoveredAreas(g, variant, seed);
  seedLedger(g, variant);
  return { g, seed, stubs };
}

/** Drive the director's PA and intent schedules through one refusing request. */
async function captureDirector(g: Game): Promise<void> {
  escapeFrame(g, 0.1);
  for (let i = 0; i < 3; i++) {
    g.time += 130 + i * 17;
    escapeFrame(g, 0.1);
    await settle();
  }
}

/** Engage real furniture and a real readable page from the floor. */
async function captureEngage(g: Game, variant: number): Promise<void> {
  const human = g.survivors.find((actor) => actor.id === "human"),
    floor = g.floors[human?.floor ?? 0];
  if (!human || !floor) return;
  const objects = floor.furniture;
  if (objects.length > 0) {
    const object = objects[(variant * 5) % objects.length]!;
    escapeInteract(g, {
      kind: "attempt",
      subjectId: object.id,
      label: object.kind,
    });
    await settle();
  }
  const details = observableSceneDetails(g, human, 12);
  const detail = details[variant % Math.max(details.length, 1)];
  if (!detail) return;
  human.x = detail.x - 1;
  human.y = detail.y;
  const readable = readableInFront(g, 0, details);
  if (readable) {
    escapeRead(g, readable);
    await settle();
  }
}

/** First lines and replies from the game's own conversation payload builder. */
function captureConverse(g: Game, variant: number, capture: Capture): void {
  const npcs = g.survivors.filter((actor) => actor.id !== "human"),
    human = g.survivors.find((actor) => actor.id === "human"),
    npc = npcs[variant % npcs.length];
  if (!npc || !human) return;
  npc.floor = human.floor;
  npc.x = human.x + 0.5;
  npc.y = human.y;
  capture(
    "escape-converse",
    conversationRequest(g, npc.id, {
      reason: "greet the player in passing",
      addresseeId: "human",
    }),
    "first",
  );
  recordUtterance(g, {
    id: `human-${variant + 1}`,
    speakerId: "human",
    text: HUMAN_LINES[variant % HUMAN_LINES.length]!,
    at: g.time,
    floor: human.floor,
    x: human.x,
    y: human.y,
    addressee: npc.id,
    heardBy: [npc.id],
  });
  capture(
    "escape-converse",
    conversationRequest(g, npc.id, {
      reason: "reply",
      addresseeId: "human",
    }),
    "reply",
  );
}

export {};

async function captureVariant(
  variant: number,
  seedBase: number,
  capture: Capture,
): Promise<void> {
  const { g, stubs } = freshGame(variant, seedBase);
  // Half the variants are captured after the catastrophe strike has passed.
  if (variant % 2 === 1 && g.escape)
    g.escape.catastrophe.timeline.graceSeconds = 5;
  await captureEngage(g, variant);
  captureConverse(g, variant, capture);
  await captureDirector(g);
  for (const stub of stubs) prefetchArea(g, stub.id);
  await settle();
  await prepareCatastrophe(g);
  await settle();
  g.time = 160 + variant * 11;
  if (variant % 2 === 0) {
    const outcome = (["escaped", "died", "quit"] as const)[variant % 3];
    endLoop(g, outcome);
  } else await epilogueForNewGame(g);
  await settle();
}

/** Build every operation's cases without touching the network or a model. */
export async function buildEscapeCases({
  perOp = 12,
  seedBase = 101,
}: { perOp?: number; seedBase?: number } = {}): Promise<EscapeCaseBook> {
  if (!Number.isInteger(perOp) || perOp < 1)
    throw Error("perOp must be a positive integer");
  if (!Number.isInteger(seedBase)) throw Error("seedBase must be an integer");
  const found = Object.fromEntries(
      OPERATIONS.map((operation) => [
        operation,
        new Map<string, { payload: Record<string, unknown>; tag?: TurnTag }>(),
      ]),
    ) as Record<
      Operation,
      Map<string, { payload: Record<string, unknown>; tag?: TurnTag }>
    >,
    capture: Capture = (operation, payload, tag) => {
      if (!OPERATIONS.includes(operation)) return;
      if (!payload || typeof payload !== "object" || Array.isArray(payload))
        return;
      const key = `${tag ?? ""}:${payloadFingerprint(payload)}`;
      if (found[operation].has(key)) return;
      found[operation].set(key, {
        payload: payload as Record<string, unknown>,
        ...(tag ? { tag } : {}),
      });
    };
  setDirectorRequest((operation, payload) => {
    capture(operation as Operation, payload);
    return refuse();
  });
  setAreaRequest((operation, payload) => {
    capture(operation as Operation, payload);
    return refuse();
  });
  setEscapeRequest((operation, payload) => {
    capture(operation as Operation, payload);
    return refuse();
  });
  try {
    for (
      let variant = 0;
      variant < perOp * 4 &&
      OPERATIONS.some((operation) => found[operation].size < perOp);
      variant++
    )
      await captureVariant(variant, seedBase, capture);
  } finally {
    resetDirectorRequest();
    resetEscapeRequest();
    setAreaRequest(undefined);
  }
  const book = Object.fromEntries(
    OPERATIONS.map((operation) => {
      const all = [...found[operation].values()];
      if (all.length < perOp)
        console.warn(
          `Only captured ${all.length} distinct ${operation} cases; wanted ${perOp}.`,
        );
      const captured =
        operation === "escape-converse" && all.length > perOp
          ? interleaveTurns(all).slice(0, perOp)
          : all.slice(0, perOp);
      return [
        operation,
        captured.map(({ payload, tag }, index) => ({
          id: tag
            ? `${operation}-${index + 1}-${tag}`
            : `${operation}-${index + 1}`,
          operation,
          payload,
        })),
      ];
    }),
  ) as EscapeCaseBook;
  return book;
}

type CapturedEntry = { payload: Record<string, unknown>; tag?: TurnTag };

/** Keep first lines and replies balanced when trimming an over-full turn set. */
export function interleaveTurns(entries: CapturedEntry[]): CapturedEntry[] {
  const firsts = entries.filter((entry) => entry.tag === "first"),
    replies = entries.filter((entry) => entry.tag === "reply"),
    other = entries.filter((entry) => !entry.tag),
    mixed: CapturedEntry[] = [];
  for (let i = 0; i < Math.max(firsts.length, replies.length); i++) {
    if (firsts[i]) mixed.push(firsts[i]!);
    if (replies[i]) mixed.push(replies[i]!);
  }
  return [...mixed, ...other];
}

/** Write one JSON case array per operation (owner-only files and directory). */
export async function writeEscapeCases(
  out: string,
  perOp = 12,
): Promise<EscapeCaseBook> {
  const book = await buildEscapeCases({ perOp }),
    target = resolve(out);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  chmodSync(target, 0o700);
  for (const operation of OPERATIONS) {
    const file = join(target, `${operation}.json`);
    writeFileSync(file, `${JSON.stringify(book[operation], null, 2)}\n`, {
      mode: 0o600,
    });
    chmodSync(file, 0o600);
  }
  return book;
}

function argument(name: string, fallback?: string) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value) throw Error(`${name} needs a value`);
  return value;
}

const entry = process.argv[1] && resolve(process.argv[1]);
if (entry === fileURLToPath(import.meta.url)) {
  const out = argument("--out", ".local/ai-escape-cases")!,
    perOp = Number(argument("--per-op", "12"));
  writeEscapeCases(out, perOp).then(
    (book) => {
      const total = OPERATIONS.reduce(
        (sum, operation) => sum + book[operation].length,
        0,
      );
      console.log(
        `Wrote ${OPERATIONS.length} case files to ${resolve(out)} (${total} cases).`,
      );
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
