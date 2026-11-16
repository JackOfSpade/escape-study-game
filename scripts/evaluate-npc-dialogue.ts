import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sha256 } from "./lib/digest.mjs";
import { isRecord as record } from "./lib/is-record.mjs";
import {
  buildNpcDialogueReview,
  NPC_DIALOGUE_ISSUES,
  parseNpcDialogueDraft,
  parseNpcDialogueReview,
  type DialogueContext,
  type DialogueIssue,
  type DialogueReviewRequest,
} from "./lib/npc-dialogue-policy.mjs";

const CORPUS = fileURLToPath(
  new URL("../tests/fixtures/npc-dialogue-realism/cases.json", import.meta.url),
);
const LIMITS = { bytes: 2_000_000, cases: 64, examples: 256, rows: 256 };

interface RealismExample {
  id: string;
  decision: "speak" | "silence";
  text: string;
  realistic: boolean;
  refs: string[];
  issues: DialogueIssue[];
  conversation?: {
    intent: "invite" | "continue" | "close";
    replyTo?: string;
  };
}
interface RealismCase {
  id: string;
  title: string;
  situation: string;
  speaker?: {
    id: string;
    name: string;
    role: string;
    personality?: { risk: number; social: number; confidence: number };
  };
  facts: { id: string; text: string }[];
  unknowns: string[];
  rubric: string[];
  examples: RealismExample[];
  recentLines?: {
    id: string;
    actorId: string;
    text: string;
    at: number;
    speakerName?: string;
    conversationId?: string;
    turn?: number;
  }[];
  conversation?: {
    id: string;
    replyTo: string;
    sourceActorId: string;
    turn: number;
    maxTurns: number;
    expiresAt: number;
  };
}
export interface RealismCorpus {
  version: 1;
  purpose: string;
  cases: RealismCase[];
}
export interface RealismTask {
  version: 1;
  caseId: string;
  exampleId: string;
  task: "review-npc-dialogue-realism";
  packet: DialogueReviewRequest;
  rubric: string[];
  unknowns: string[];
}
interface ResultProvenance {
  kind: "scripted" | "human" | "model";
  name: string;
  runId?: string;
  capturedAt?: string;
}
export interface SuppliedRealismResult {
  version: 1;
  caseId: string;
  exampleId: string;
  response: unknown;
  provenance: ResultProvenance;
}

function text(value: unknown, limit: number): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= limit;
}
function id(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,95}$/.test(value);
}
function factId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(value);
}
function strings(
  value: unknown,
  limit: number,
  count: number,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= count &&
    value.every((v) => text(v, limit))
  );
}
function fail(message: string): never {
  throw Error(message);
}

export async function loadNpcDialogueCorpus(
  path = CORPUS,
): Promise<RealismCorpus> {
  const info = await stat(path);
  if (!info.isFile() || info.size > LIMITS.bytes)
    fail("Realism corpus must be a bounded JSON file");
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (
    !record(value) ||
    value.version !== 1 ||
    !text(value.purpose, 1000) ||
    !Array.isArray(value.cases) ||
    !value.cases.length ||
    value.cases.length > LIMITS.cases
  )
    fail("Malformed realism corpus");
  const cases = new Set<string>();
  let examples = 0;
  for (const entry of value.cases) {
    if (
      !record(entry) ||
      !id(entry.id) ||
      cases.has(entry.id) ||
      !text(entry.title, 180) ||
      !text(entry.situation, 1200) ||
      !strings(entry.unknowns, 240, 12) ||
      !strings(entry.rubric, 400, 12) ||
      !entry.rubric.length ||
      !Array.isArray(entry.facts) ||
      !entry.facts.length ||
      entry.facts.length > 40 ||
      !Array.isArray(entry.examples) ||
      !entry.examples.length
    )
      fail("Malformed, duplicate or incomplete realism case");
    cases.add(entry.id);
    if (entry.speaker !== undefined) {
      const speaker = entry.speaker,
        personality = record(speaker) ? speaker.personality : undefined;
      if (
        !record(speaker) ||
        !factId(speaker.id) ||
        speaker.id === "human" ||
        !text(speaker.name, 80) ||
        !text(speaker.role, 80) ||
        (personality !== undefined &&
          (!record(personality) ||
            ["risk", "social", "confidence"].some((field) => {
              const value = personality[field];
              return (
                typeof value !== "number" ||
                !Number.isFinite(value) ||
                value < 0 ||
                value > 1
              );
            })))
      )
        fail("Malformed realism speaker identity");
    }
    if (
      entry.recentLines !== undefined &&
      (!Array.isArray(entry.recentLines) ||
        entry.recentLines.length > 6 ||
        entry.recentLines.some(
          (line) =>
            !record(line) ||
            !factId(line.id) ||
            !factId(line.actorId) ||
            !text(line.text, 180) ||
            !Number.isFinite(line.at) ||
            (line.speakerName !== undefined && !text(line.speakerName, 80)) ||
            (line.conversationId !== undefined &&
              !factId(line.conversationId)) ||
            (line.turn !== undefined &&
              (!Number.isInteger(line.turn) ||
                Number(line.turn) < 1 ||
                Number(line.turn) > 4)),
        ))
    )
      fail("Malformed realism heard conversation");
    if (entry.conversation !== undefined) {
      const conversation = entry.conversation;
      if (
        !record(conversation) ||
        !factId(conversation.id) ||
        !factId(conversation.replyTo) ||
        !factId(conversation.sourceActorId) ||
        !Number.isInteger(conversation.turn) ||
        Number(conversation.turn) < 2 ||
        Number(conversation.turn) > 4 ||
        conversation.maxTurns !== 4 ||
        !Number.isFinite(conversation.expiresAt) ||
        Number(conversation.expiresAt) <= 100
      )
        fail("Malformed realism conversation opportunity");
    }
    const facts = new Set<string>();
    for (const fact of entry.facts) {
      if (
        !record(fact) ||
        !factId(fact.id) ||
        facts.has(fact.id) ||
        !text(fact.text, 180)
      )
        fail("Malformed or duplicate realism fact");
      facts.add(fact.id);
    }
    const candidates = new Set<string>();
    for (const example of entry.examples) {
      if (
        !record(example) ||
        !id(example.id) ||
        candidates.has(example.id) ||
        !["speak", "silence"].includes(String(example.decision)) ||
        typeof example.realistic !== "boolean" ||
        typeof example.text !== "string" ||
        example.text.length > 180 ||
        !strings(example.refs, 160, 4) ||
        !Array.isArray(example.issues) ||
        example.issues.length > 8 ||
        example.issues.some(
          (issue) =>
            typeof issue !== "string" ||
            !NPC_DIALOGUE_ISSUES.includes(issue as DialogueIssue),
        ) ||
        example.refs.some((ref) => !facts.has(ref)) ||
        (example.decision === "speak" &&
          (!example.text.trim() || !example.refs.length)) ||
        (example.decision === "silence" &&
          (example.text !== "" || !example.realistic)) ||
        (example.realistic && example.issues.length !== 0) ||
        (!example.realistic && example.issues.length === 0)
      )
        fail("Malformed or ungrounded realism example");
      if (example.conversation !== undefined) {
        const conversation = example.conversation;
        if (
          !record(conversation) ||
          !["invite", "continue", "close"].includes(
            String(conversation.intent),
          ) ||
          (conversation.replyTo !== undefined && !factId(conversation.replyTo))
        )
          fail("Malformed realism candidate conversation");
      }
      candidates.add(example.id);
      if (++examples > LIMITS.examples) fail("Too many realism examples");
    }
  }
  return value as unknown as RealismCorpus;
}

function fixtureContext(
  entry: RealismCase,
  example: RealismExample,
): DialogueContext {
  const speaker = entry.speaker ?? {
      id: "npc-realism-fixture",
      name: "Survivor",
      role: "survivor",
    },
    source = sha256(
      JSON.stringify([
        entry.situation,
        entry.facts,
        entry.unknowns,
        entry.rubric,
        example.decision,
        example.text,
        example.refs,
        ...(entry.speaker ? [entry.speaker] : []),
        ...(entry.conversation || entry.recentLines || example.conversation
          ? [entry.conversation, entry.recentLines, example.conversation]
          : []),
      ]),
    ).slice(0, 16);
  return {
    requestId: `realism-${entry.id}-${source}`,
    actorId: speaker.id,
    runId: "synthetic-dialogue-realism-run",
    capturedAt: 100,
    ...{
      setting:
        "An ongoing zombie catastrophe; survivors are trying to reach rooftop extraction.",
      self: structuredClone(speaker),
      situation: entry.situation,
      unknowns: [...entry.unknowns],
      recentLines: structuredClone(entry.recentLines ?? []),
    },
    ...(entry.conversation
      ? { conversation: structuredClone(entry.conversation) }
      : {}),
    dialogue: {
      version: 1,
      facts: entry.facts.map((fact) => ({
        id: fact.id,
        kind: "observation",
        text: fact.text,
        key: `${entry.id}/${fact.id}`,
      })),
    },
  };
}

/** These packets withhold agent-authored reference verdicts. The candidate wording is a critic
 * challenge, never a response bank used by the running game's generator. */
export async function buildNpcDialogueRealismTasks(corpus: RealismCorpus) {
  const tasks: RealismTask[] = [];
  let silenceExamples = 0;
  for (const entry of corpus.cases)
    for (const example of entry.examples) {
      const context = fixtureContext(entry, example),
        draft = parseNpcDialogueDraft(
          context,
          example.decision === "silence"
            ? {
                requestId: context.requestId,
                actorId: context.actorId,
                decision: "silent",
                reason: "Another line would add nothing to this moment.",
              }
            : {
                requestId: context.requestId,
                actorId: context.actorId,
                decision: "speak",
                text: example.text,
                purpose: "React naturally to this captured survivor situation.",
                evidence: [...example.refs],
                delivery: entry.id === "immediate-attack" ? "urgent" : "calm",
                ...(example.conversation
                  ? { conversation: structuredClone(example.conversation) }
                  : {}),
              },
        );
      if (draft.decision === "silent") {
        silenceExamples++;
        continue;
      }
      tasks.push({
        version: 1,
        caseId: entry.id,
        exampleId: `sample-${context.requestId.split("-").at(-1)}`,
        task: "review-npc-dialogue-realism",
        packet: await buildNpcDialogueReview(context, draft, 0),
        rubric: [...entry.rubric],
        unknowns: [...entry.unknowns],
      });
    }
  return { tasks, silenceExamples };
}

function validProvenance(value: unknown): value is ResultProvenance {
  return (
    record(value) &&
    ["scripted", "human", "model"].includes(String(value.kind)) &&
    text(value.name, 120) &&
    (value.runId === undefined || text(value.runId, 120)) &&
    (value.capturedAt === undefined ||
      (typeof value.capturedAt === "string" &&
        value.capturedAt.length <= 80 &&
        Number.isFinite(Date.parse(value.capturedAt))))
  );
}

export async function readNpcDialogueRealismResults(path: string) {
  const info = await stat(path);
  if (!info.isFile() || info.size > LIMITS.bytes)
    fail("Supplied realism results must be bounded JSONL");
  const lines = (await readFile(path, "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.trim());
  if (lines.length > LIMITS.rows) fail("Too many supplied realism results");
  return lines.map((line) => JSON.parse(line) as unknown);
}

/** Scores supplied critic decisions against curated agent-authored reference labels. Even a
 * perfect scripted score establishes no live generation or semantic quality. */
export async function evaluateNpcDialogueRealism(
  corpus: RealismCorpus,
  supplied: unknown[],
) {
  const { tasks, silenceExamples } = await buildNpcDialogueRealismTasks(corpus),
    expected = new Map(
      tasks.map((task) => [`${task.caseId}/${task.exampleId}`, task]),
    ),
    seen = new Set<string>(),
    results: {
      caseId?: string;
      exampleId?: string;
      status: string;
      reason?: string;
      verdict?: string;
      issues?: string[];
      provenance?: ResultProvenance;
    }[] = [];
  if (supplied.length > LIMITS.rows) fail("Too many supplied realism results");
  let agreement = 0,
    valid = 0,
    reportedModelSamples = 0,
    scriptedSamples = 0,
    reportedHumanSamples = 0;
  for (const row of supplied) {
    if (
      !record(row) ||
      row.version !== 1 ||
      !id(row.caseId) ||
      !id(row.exampleId) ||
      !validProvenance(row.provenance)
    ) {
      results.push({
        status: "invalid",
        reason: "malformed-result-or-missing-provenance",
      });
      continue;
    }
    const key = `${row.caseId}/${row.exampleId}`,
      task = expected.get(key);
    if (!task || seen.has(key)) {
      results.push({
        caseId: row.caseId,
        exampleId: row.exampleId,
        status: "invalid",
        reason: task ? "duplicate-result" : "unknown-case-or-example",
      });
      continue;
    }
    seen.add(key);
    let review;
    try {
      review = parseNpcDialogueReview(task.packet, row.response);
    } catch {
      results.push({
        caseId: row.caseId,
        exampleId: row.exampleId,
        status: "invalid",
        reason: "mismatched-or-malformed-review",
      });
      continue;
    }
    valid++;
    if (row.provenance.kind === "model") reportedModelSamples++;
    if (row.provenance.kind === "scripted") scriptedSamples++;
    if (row.provenance.kind === "human") reportedHumanSamples++;
    const reference = corpus.cases
        .find((entry) => entry.id === row.caseId)!
        .examples.find(
          (example) =>
            fixtureContext(
              corpus.cases.find((entry) => entry.id === row.caseId)!,
              example,
            ).requestId === task.packet.context.requestId,
        )!,
      expectedIssues = new Set(reference.issues),
      agrees = reference.realistic
        ? review.verdict === "accept"
        : review.verdict !== "accept" &&
          review.issues.some((issue) => expectedIssues.has(issue));
    if (agrees) agreement++;
    results.push({
      caseId: row.caseId,
      exampleId: row.exampleId,
      status: agrees ? "agrees" : "disagrees",
      verdict: review.verdict,
      issues: [...review.issues],
      provenance: row.provenance,
    });
  }
  for (const task of tasks)
    if (!seen.has(`${task.caseId}/${task.exampleId}`))
      results.push({
        caseId: task.caseId,
        exampleId: task.exampleId,
        status: "missing",
      });
  const invalid = results.filter((r) => r.status === "invalid").length,
    missing = results.filter((r) => r.status === "missing").length,
    passed = agreement === tasks.length && invalid === 0 && missing === 0;
  return {
    version: 1,
    status: passed ? "passed" : "incomplete-or-failed",
    scope:
      "Supplied critic decisions on curated candidates; no live dialogue generation or game audio.",
    referenceLabels: "Agent-authored; not human-rated.",
    liveModelEvaluated: false,
    semanticQualityEstablished: false,
    provenanceVerified: false,
    summary: {
      cases: corpus.cases.length,
      expectedReviews: tasks.length,
      silenceExamples,
      provided: supplied.length,
      valid,
      agreement,
      invalid,
      missing,
      criticAgreement: tasks.length ? agreement / tasks.length : 0,
      reportedModelSamples,
      scriptedSamples,
      reportedHumanSamples,
    },
    results,
  };
}

async function runNpcDialogueRealismCli(args: string[]) {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (
      !["--export", "--responses", "--json"].includes(name) ||
      options.has(name) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--")
    )
      fail(
        "Usage: evaluate-npc-dialogue.ts [--export tasks.jsonl | --responses results.jsonl] [--json report.json]",
      );
    options.set(name, args[++i]);
  }
  if (options.has("--export") && options.has("--responses"))
    fail("Choose packet export or supplied-result evaluation");
  if (options.get("--export") === "-" && options.get("--json") === "-")
    fail("Packet JSONL and report JSON cannot share stdout");
  const corpus = await loadNpcDialogueCorpus(),
    { tasks, silenceExamples } = await buildNpcDialogueRealismTasks(corpus);
  let report: unknown;
  if (options.has("--responses"))
    report = await evaluateNpcDialogueRealism(
      corpus,
      await readNpcDialogueRealismResults(options.get("--responses")!),
    );
  else {
    report = {
      version: 1,
      status: options.has("--export") ? "exported" : "mechanical-only",
      cases: corpus.cases.length,
      criticPackets: tasks.length,
      silenceExamples,
      referenceLabels: "Agent-authored; not human-rated.",
      liveModelEvaluated: false,
      semanticQualityEstablished: false,
      note: "Corpus and production contracts verified. Candidate labels require an independent semantic critic; no model was called.",
    };
    if (options.has("--export")) {
      const output =
          tasks.map((task) => JSON.stringify(task)).join("\n") + "\n",
        path = options.get("--export")!;
      if (path === "-") process.stdout.write(output);
      else {
        await mkdir(dirname(resolve(path)), { recursive: true });
        await writeFile(path, output);
      }
    }
  }
  const output = JSON.stringify(report, null, 2) + "\n",
    destination = options.get("--json");
  if (destination && destination !== "-") {
    await mkdir(dirname(resolve(destination)), { recursive: true });
    await writeFile(destination, output);
  } else if (options.get("--export") !== "-") process.stdout.write(output);
  return (report as { status: string }).status === "incomplete-or-failed"
    ? 1
    : 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  runNpcDialogueRealismCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(
        error instanceof Error ? error.message : "Realism evaluation failed",
      );
      process.exitCode = 1;
    });
