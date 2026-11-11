/**
 * Build offline ladder cases for the NPC-side game AI calls.
 *
 * The script never talks to a model, gateway or network. It seeds games the
 * way the unit tests do, hands each real payload builder a capturing requester
 * and writes the captured payloads as `<out>/<operation>.json` case arrays for
 * `scripts/ai-ladder.mjs`.
 *
 *   node --import tsx scripts/ai-capture/build-cases.ts --out <dir> [--per-op N]
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { edit } from "../../src/ai";
import { generateCatchup } from "../../src/chat-catchup";
import { eligible, initialStudy } from "../../src/curriculum";
import { recordEnvironmentObservation } from "../../src/environment-observations";
import { reviewEnvironment } from "../../src/environment-review";
import {
  type EnvironmentJudgment,
  type EnvironmentReviewPayload,
} from "../../src/environment-status";
import { complete } from "../../src/engine";
import type { Actor, Game, Problem, Roadmap } from "../../src/model";
import { buildNpcChatterContext } from "../../src/npc-chatter";
import type {
  NpcChatterConversation,
  NpcChatterRecentLine,
} from "../../src/npc-chatter";
import { recordNpcWork } from "../../src/npc-cognition";
import {
  materializeNpcWork,
  type WorkPayload,
} from "../../src/npc-materialization";
import { inspectNpcOutcome, type OutcomePayload } from "../../src/npc-outcome";
import { createGame } from "../../src/world";
import {
  buildNpcDialogueReview,
  type DialogueSpeech,
} from "../../scripts/lib/npc-dialogue-policy.mjs";

export const OPERATIONS = [
  "materialize-work",
  "materialize-outcome",
  "complete",
  "group",
  "npc-chatter",
  "npc-chatter-review",
  "review-environment",
] as const;
export type Operation = (typeof OPERATIONS)[number];
export interface CaptureCase {
  id: string;
  operation: Operation;
  payload: Record<string, unknown>;
}
export type CaseBook = Record<Operation, CaptureCase[]>;
type Capture = (operation: string, payload: unknown) => void;

const roadmap: Roadmap = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../public/curriculum.json", import.meta.url)),
    "utf8",
  ),
);

const NPC_NAMES = [
  ["Maya", "field medic"],
  ["Theo", "former electrician"],
  ["Priya", "night-shift nurse"],
  ["Jonah", "warehouse foreman"],
  ["Iris", "radio operator"],
  ["Sam", "line cook"],
  ["Nadia", "civil engineer"],
  ["Walt", "school caretaker"],
] as const;

const WORKSPACES = [
  "abc",
  "def count_items(items):\n    return len(items)\n",
  "if (!session) redirect('/login');\nreturn loadProfile(session.userId);\n",
  "const total = rows.reduce((sum, row) => sum + row.amount, 0);\n",
  "def retry(job):\n    return queue.put(job) if job.attempts < 3 else drop(job)\n",
  "export function clampPage(page, total) {\n  return Math.min(page, total);\n}\n",
] as const;

const WORK_NOTE_TEXTS = [
  "Tentative boundary: an empty sequence should return zero before the loop updates anything.",
  "The guard belongs before the write; otherwise a failed quota check still leaves a draft behind.",
  "Clamp the page after filtering, or the current item can disappear and leave a blank screen.",
  "Retries need a cap that resets on success, otherwise a flaky queue keeps growing.",
  "This branch is only safe if the session is checked before the profile lookup.",
  "The total should start at zero for an empty row set, not at a literal first row.",
] as const;

const PROBLEM_PROMPTS = [
  "Explain how the function handles an empty sequence before changing it.",
  "Find the ordering bug in the upload path and describe the smallest safe fix.",
  "Describe what happens to the page index when the last row is filtered out.",
  "Walk through the retry loop and say where the attempt counter resets.",
  "Make the checkout total correct when the cart is empty.",
  "Explain why the redirect runs with a missing session and how to guard it.",
] as const;

const PLAYER_LINES = [
  "Anyone got some water?",
  "The east door is jammed; I need a hand with it.",
  "How many rounds do we have left?",
  "I can hear them moving above the ceiling.",
  "Take the stairwell, not the lift.",
  "Did anyone check the back office?",
  "Hold the light steady for a second.",
  "We should mark this corridor before we split up.",
] as const;

const REPLIES = [
  "Keep the stairwell clear; I will take the rear.",
  "There is water in the blue pack by the desk.",
  "I counted six rounds, and the spare box is still sealed.",
  "Give me a minute and I will check the office with you.",
  "Stay low and keep the light away from the window.",
] as const;

const ENV_IDS = [
  "PE:ENV01",
  "PE:ENV02",
  "PE:ENV03",
  "PE:ENV04",
  "PE:ENV05",
  "PE:ENV06",
] as const;

const ENV_WORK: Record<string, { statement: string; output?: string }> = {
  "PE:ENV01": {
    statement:
      "I ran keyboard-only and screen-reader checks on the checkout page in Chrome and Firefox, then inspected the rendered focus order.",
    output: "focus order: cart -> address -> payment; no keyboard trap found",
  },
  "PE:ENV02": {
    statement:
      "I recorded Chrome performance profiles for the dashboard under a 6x CPU slowdown and compared the LCP and INP field metrics.",
    output: "LCP 2.8s, INP 180ms, long task 410ms in the profile",
  },
  "PE:ENV03": {
    statement:
      "I cloned the service repository, reproduced the stale-cache bug on a branch, and traced it to the retry path.",
    output: "branch fix/stale-cache: failing test reproduces the stale read",
  },
  "PE:ENV04": {
    statement:
      "I built and ran the timer component with the API on localhost, including the empty and slow-response states.",
    output:
      "timer rendered 00:00 on empty state; slow response showed a spinner",
  },
  "PE:ENV05": {
    statement:
      "I steered the AI coding tool through the repository, reviewed its diff, and verified the output against the failing test.",
    output: "reviewed diff: guard added before write; test suite green",
  },
  "PE:ENV06": {
    statement:
      "I wrote and executed unit and end-to-end tests in my repository, including the checkout failure path.",
    output: "results.log: 14 unit tests and 3 end-to-end tests passed",
  },
};

const MISALIGNED_WORK = [
  "I did not actually run this myself; I only read a blog post about the workflow.",
  "I did not actually open the project; I watched a video walkthrough of the tool.",
  "I did not actually test the page; a colleague showed me their results over lunch.",
] as const;

function named(actor: Actor, index: number, activity: Actor["activity"]) {
  const [name] = NPC_NAMES[index % NPC_NAMES.length];
  actor.name = name;
  actor.activity = activity;
  return actor;
}

function materializationFixture(seed: number, variant: number) {
  const g = createGame(seed, roadmap),
    e = g.encounters["f0-room0"],
    stations = g.floors[0].stations.filter((s) => s.encounter === e.id),
    a = named(g.survivors[1], variant, "studying"),
    workspace = WORKSPACES[variant % WORKSPACES.length],
    station = stations[1] ?? stations[0];
  g.status = "playing";
  g.zombies = [];
  g.nextSpawn = Number.MAX_SAFE_INTEGER;
  for (const b of g.survivors.slice(3)) b.escaped = true;
  Object.assign(g.survivors[0], {
    x: stations[0].x,
    y: stations[0].y,
    station: stations[0].id,
  });
  Object.assign(a, {
    x: station.x,
    y: station.y,
    station: station.id,
    intent: e.id,
    milestone: 1 + (variant % 4),
  });
  e.state = "in-progress";
  e.humanEngaged = true;
  e.workspace = e.workspaceBase = workspace;
  e.problem = {
    title: `Recorded notes: ${PROBLEM_PROMPTS[variant % PROBLEM_PROMPTS.length].slice(0, 42)}`,
    prompt: PROBLEM_PROMPTS[variant % PROBLEM_PROMPTS.length],
    rubric: ["State the boundary case", "Explain the smallest safe change"],
    starter: workspace,
    provenance: "study-mode",
    contract: eligible(roadmap, g.study),
  };
  recordNpcWork(g, e, a, variant % 3 === 2);
  if (variant % 4 === 1 && g.survivors[2]) {
    const b = named(g.survivors[2], variant + 2, "studying");
    Object.assign(b, {
      x: station.x + 0.5,
      y: station.y,
      station: station.id,
      intent: e.id,
      milestone: 1 + (variant % 3),
    });
    recordNpcWork(g, e, b, false);
  }
  return { g, e, a, workspace };
}

function workReply(payload: WorkPayload, salt: number) {
  return {
    requestId: payload.requestId,
    sourceRevision: payload.sourceRevision,
    notes: payload.work.map((work, index) => ({
      workId: work.id,
      author: work.actor,
      text: WORK_NOTE_TEXTS[(salt + index) % WORK_NOTE_TEXTS.length],
      refs: [work.seq],
    })),
  };
}

function outcomeFixture(seed: number, variant: number) {
  const g = createGame(seed, roadmap, initialStudy(roadmap, "live")),
    e = g.encounters["f0-room0"],
    first = named(g.survivors[1], variant, "studying"),
    contributors = variant % 3 === 0 && g.survivors[2] ? 2 : 1;
  g.study.learner!.reviews = {};
  for (let index = 0; index < contributors; index++) {
    const a =
      index === 0 ? first : named(g.survivors[2], variant + 1, "studying");
    a.milestone = 1 + ((variant + index) % 3);
    recordNpcWork(g, e, a, variant % 2 === 1 && index === 0);
  }
  e.contributors = g.survivors.slice(1, 1 + contributors).map((a) => a.id);
  complete(
    g,
    e.id,
    `npc-sim-${e.id}`,
    e.contributors,
    "Simulated NPC-only success; no runtime execution",
  );
  return { g, e, first };
}

function outcomeCandidate(payload: OutcomePayload, authors: string[]) {
  return {
    requestId: payload.requestId,
    problem: payload.commitment.problem ?? {
      title: "Reconstructed puzzle",
      prompt: "Reconstructed prompt for the same contract",
      starter: "",
      rubric: [],
      provenance: "study-mode",
      contract: payload.contract,
      scopeDefinitions: payload.contract.objectiveIds.map((id, index) => ({
        id: `${id}/D${payload.contract.depth}`,
        objectiveId: id,
        depth: payload.contract.depth,
        sourceScope: payload.contract.scopes[index],
        facets: [{ id: "scope", description: "Captured scope facet" }],
      })),
    },
    solution:
      "Guard the empty input before the update, then clamp the page after filtering.",
    authors,
    refs: [payload.commitment.work[0].seq],
    execution: "not-run",
  };
}

function groupFixture(seed: number, events: number) {
  const g = createGame(seed, roadmap),
    e = g.encounters["f0-room0"],
    a = named(g.survivors[1], seed % NPC_NAMES.length, "studying"),
    b = named(g.survivors[2], (seed + 3) % NPC_NAMES.length, "studying");
  g.status = "playing";
  g.zombies = [];
  g.events = [];
  e.state = "in-progress";
  e.mode = "shared";
  e.revision = 0;
  e.chatCursor = 0;
  e.workspace = WORKSPACES[(seed + events) % WORKSPACES.length];
  e.group = [];
  e.catchups = [];
  e.history = [];
  e.contributors = [a.id, b.id];
  for (let index = 0; index < events; index++) {
    const worker = index % 2 === 0 ? a : b;
    worker.milestone = 1 + (index % 5);
    recordNpcWork(g, e, worker, index % 4 === 3);
  }
  return { g, e, a, b };
}

function chatterFixture(seed: number, variant: number) {
  const g = createGame(seed, roadmap),
    f = g.floors[0],
    npc = named(g.survivors[1], variant, "exploring"),
    speaker = named(g.survivors[2] ?? g.survivors[0], variant + 2, "exploring");
  g.status = "playing";
  g.time = 10;
  g.zombies = [];
  g.events = [];
  f.tiles = Array.from({ length: 34 }, () => Array(44).fill(0));
  f.furniture = [];
  f.stations = [];
  Object.assign(npc, { x: 12, y: 10, station: undefined, intent: undefined });
  Object.assign(g.survivors[0], { x: 10, y: 10 });
  Object.assign(speaker, { x: 14, y: 10 });
  g.survivors = [g.survivors[0], npc, speaker];
  return { g, f, npc, speaker };
}

function conversationFor(g: Game, npc: Actor, speaker: Actor, variant: number) {
  const turn = 2 + ((variant + 1) % 3),
    line: NpcChatterRecentLine = {
      id: `utterance-${variant}`,
      actorId: speaker.id,
      speakerName: speaker.name,
      text: PLAYER_LINES[variant % PLAYER_LINES.length],
      at: g.time - 1,
      conversationId: `exchange-${variant}`,
      turn: turn - 1,
      heardBy: [npc.id],
    },
    conversation: NpcChatterConversation = {
      id: line.conversationId!,
      replyTo: line.id!,
      sourceActorId: speaker.id,
      turn,
      maxTurns: 4,
      expiresAt: g.time + 29,
    };
  return { line, conversation };
}

async function captureWork(variant: number, capture: Capture) {
  const { g, e, workspace } = materializationFixture(7 + variant * 17, variant),
    requester = async (payload: WorkPayload) => {
      capture("materialize-work", payload);
      return workReply(payload, variant);
    };
  if (variant % 4 === 1) {
    await materializeNpcWork(g, e, async () => {
      throw Error("offline during the first materialization attempt");
    });
    edit(g, e, `${workspace}// reviewed after the failed request`, e.revision);
    await materializeNpcWork(g, e, requester, true);
  } else {
    await materializeNpcWork(g, e, requester);
  }
}

const DEFECTS = [
  "The pharmacy on Delancey still has insulin, so we should head there before dark.",
  "There is a shambler behind the shelf by the door; it has not seen us yet.",
  "We have plenty of water in the packs, so drink up and refill before we move.",
  "I keep thinking about the break room with the broken vending machine and how we argued about the coffee pot before all this started.",
] as const;

async function captureOutcome(variant: number, capture: Capture) {
  const { g, e, first } = outcomeFixture(72 + variant * 19, variant),
    authors = e.contributors ?? [first.id],
    adapter = {
      validate(_problem: Problem, _contract: Problem["contract"]) {},
      async request(operation: string, payload: any) {
        capture(operation, payload);
        return operation === "materialize-outcome"
          ? outcomeCandidate(payload as OutcomePayload, authors)
          : {
              requestId: payload.requestId,
              complete: true,
              feedback:
                "Captured semantic validation only; no runtime execution",
              execution: "not-run",
            };
      },
    };
  await inspectNpcOutcome(g, e, roadmap, adapter);
}

async function captureGroup(variant: number, capture: Capture) {
  const events = variant % 4 === 0 ? 1 : 2 + (variant % 5),
    { g, e, a } = groupFixture(30 + variant * 11, events);
  await generateCatchup(g, e, {
    provider: "study-mode",
    request: async (payload: any) => {
      capture("group", payload);
      const refs = (payload.range?.refs ?? []).slice(0, 1),
        source = payload.events?.find((item: any) => item.seq === refs[0]);
      return {
        requestId: payload.requestId,
        sourceRevision: payload.sourceRevision,
        messages: [
          {
            author: payload.speakers[0].id,
            kind: "observation",
            text: `${a.name} recorded ${events} work event${events === 1 ? "" : "s"}; the cited note says: ${String(source?.text ?? "the visible task changed").slice(0, 120)}`,
            refs,
          },
        ],
      };
    },
    append: (author, kind, text, provenance, refs) => ({
      id: `captured-group-${g.seq}-${refs[0] ?? 0}`,
      author,
      kind,
      text,
      worldTime: g.time,
      provenance,
      sourceRefs: refs,
      seq: ++g.seq,
    }),
  });
}

function chatterContext(variant: number) {
  const { g, npc, speaker } = chatterFixture(42 + variant * 7, variant),
    conversational = variant % 2 === 0,
    { line, conversation } = conversationFor(g, npc, speaker, variant),
    context = buildNpcChatterContext(
      g,
      npc,
      `chatter-${variant + 1}`,
      conversational ? [line] : [],
      conversational ? conversation : undefined,
    );
  return { g, npc, context, conversational };
}

async function captureChatter(variant: number, capture: Capture) {
  const { context } = chatterContext(variant);
  capture("npc-chatter", context);
}

function chatterDraft(
  context: ReturnType<typeof chatterContext>["context"],
  variant: number,
): DialogueSpeech {
  const facts = context.dialogue!.facts,
    speech = facts.find((fact) => fact.id.startsWith("speech:")),
    defect = variant % 2 === 1,
    evidence = context.conversation
      ? [speech!.id]
      : [facts[variant % facts.length].id],
    conversation = context.conversation
      ? {
          intent:
            context.conversation.turn >= context.conversation.maxTurns
              ? ("close" as const)
              : ("continue" as const),
          replyTo: context.conversation.replyTo,
        }
      : undefined;
  return {
    requestId: context.requestId,
    actorId: context.actorId,
    decision: "speak",
    text: defect
      ? DEFECTS[(variant >> 1) % DEFECTS.length]
      : REPLIES[variant % REPLIES.length],
    purpose: context.conversation
      ? "Answer the heard line with something this survivor could actually use"
      : "Coordinate the next practical step without inventing anything",
    evidence,
    ...(conversation ? { conversation } : {}),
  };
}

async function captureChatterReview(variant: number, capture: Capture) {
  const { context } = chatterContext(variant),
    review = await buildNpcDialogueReview(
      context,
      chatterDraft(context, variant),
      variant % 3 === 0 ? 1 : 0,
    );
  capture("npc-chatter-review", review);
}

function environmentJudgment(
  payload: EnvironmentReviewPayload,
  misaligned: boolean,
): EnvironmentJudgment {
  const scope = payload.definition.scope.split(";")[0],
    output = payload.observation.suppliedOutput;
  return {
    requestId: payload.requestId,
    sourceHash: payload.sourceHash,
    observationId: payload.observation.id,
    observationFingerprint: payload.observation.fingerprint,
    envId: payload.definition.id,
    classification: output ? "observed" : "reported-exposure",
    learnerWork: !!output && !misaligned,
    learnerWorkQuote: payload.observation.learnerStatement.slice(0, 60),
    reviewedOutputs: output
      ? [{ kind: "supplied-output", excerpt: output.text.slice(0, 60) }]
      : [],
    covered: output && !misaligned ? [scope] : [],
    remaining: output && !misaligned ? [] : [scope],
    completeScope: !!output && !misaligned,
    rationale: misaligned
      ? "The statement describes adjacent reading rather than learner-owned work in this environment."
      : output
        ? "The supplied output was inspected against the stated scope."
        : "Only a statement was supplied; no practical output could be reviewed.",
  };
}

async function captureEnvironment(variant: number, capture: Capture) {
  const g = createGame(5 + variant * 13, roadmap),
    envId = ENV_IDS[variant % ENV_IDS.length],
    misaligned = variant % 4 === 3,
    work = ENV_WORK[envId],
    statement = misaligned
      ? MISALIGNED_WORK[variant % MISALIGNED_WORK.length]
      : work.statement;
  g.study.profile = "live";
  const observation = await recordEnvironmentObservation(g, roadmap, {
    envId,
    statement,
    ...(work.output && !misaligned
      ? {
          suppliedOutput: {
            name: `learner-evidence-${variant + 1}.log`,
            text: work.output,
          },
        }
      : {}),
  });
  await reviewEnvironment(g, roadmap, observation.id, async (payload) => {
    capture("review-environment", payload);
    return environmentJudgment(payload, misaligned);
  });
}

const BUILDERS: Record<
  Operation,
  (variant: number, capture: Capture) => Promise<void>
> = {
  "materialize-work": captureWork,
  "materialize-outcome": captureOutcome,
  complete: async () => {},
  group: captureGroup,
  "npc-chatter": captureChatter,
  "npc-chatter-review": captureChatterReview,
  "review-environment": captureEnvironment,
};

/** Build every operation's cases without touching the network. */
export async function buildCases({
  perOp = 12,
}: { perOp?: number } = {}): Promise<CaseBook> {
  if (!Number.isInteger(perOp) || perOp < 1)
    throw Error("perOp must be a positive integer");
  const found = Object.fromEntries(
      OPERATIONS.map((operation) => [operation, new Map<string, unknown>()]),
    ) as Record<Operation, Map<string, unknown>>,
    capture: Capture = (operation, payload) => {
      if (!OPERATIONS.includes(operation as Operation)) return;
      const op = operation as Operation,
        json = JSON.stringify(payload),
        hash = createHash("sha256").update(json).digest("hex");
      if (!found[op].has(hash)) found[op].set(hash, payload);
    };
  for (
    let variant = 0;
    variant < perOp * 3 && OPERATIONS.some((op) => found[op].size < perOp);
    variant++
  )
    for (const operation of OPERATIONS) {
      if (found[operation].size >= perOp) continue;
      await BUILDERS[operation](variant, capture);
    }
  const book = Object.fromEntries(
    OPERATIONS.map((operation) => {
      const payloads = [...found[operation].values()];
      if (payloads.length < perOp)
        throw Error(
          `Only captured ${payloads.length} distinct ${operation} cases; wanted ${perOp}`,
        );
      return [
        operation,
        payloads.slice(0, perOp).map((payload, index) => ({
          id: `${operation}-${index + 1}`,
          operation,
          payload: payload as Record<string, unknown>,
        })),
      ];
    }),
  ) as CaseBook;
  return book;
}

/** Write one JSON case array per operation plus the count index. */
export async function writeCases(out: string, perOp = 12) {
  const book = await buildCases({ perOp }),
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
  const index = Object.fromEntries(
    OPERATIONS.map((operation) => [operation, book[operation].length]),
  );
  const indexFile = join(target, "index.json");
  writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(indexFile, 0o600);
  return { book, index };
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
  const out = argument("--out", ".local/ai-cases")!,
    perOp = Number(argument("--per-op", "12"));
  writeCases(out, perOp).then(
    ({ index }) => {
      console.log(
        `Wrote ${OPERATIONS.length} case files to ${resolve(out)} (${Object.values(index).reduce((sum, count) => sum + count, 0)} cases).`,
      );
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
