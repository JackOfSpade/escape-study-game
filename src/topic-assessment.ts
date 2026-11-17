import {
  topicAssessmentTopics,
  TOPIC_ASSESSMENT_TEXT_LIMIT,
  validateTopicAssessments as validateTopicAssessmentValues,
} from "../scripts/lib/topic-assessment.mjs";
import { isRecord } from "./records";
import type { ScopeDefinition } from "./learning-model";
import type {
  Contract,
  Encounter,
  StudyRecord,
  Roadmap,
  StudyState,
  Track,
} from "./model";
import { inspectMergedDocument } from "./roadmap-structure";
import { studyTrackProgress } from "./study-progress";
import { CELL_SEPARATOR } from "./table-row";

/** AI-written knowledge commentary. This is never a curriculum proof. */
export interface TopicAssessmentRecord {
  topicId: string;
  depth: number;
  text: string;
  updatedAt: string;
  encounter: string;
  runId: string;
  questionFingerprint: string;
  requestId: string;
  sourceHash?: string;
  /** Original question creation time; a late old completion cannot replace newer insight. */
  startedAt?: number;
}
interface TopicAssessmentValue {
  topicId: string;
  text: string;
}
interface TopicAssessmentMetadata {
  updatedAt?: string;
  requestId?: string;
  questionFingerprint?: string;
  sourceHash?: string;
  startedAt?: number;
}

function validTopicAssessmentRecord(
  value: unknown,
): value is TopicAssessmentRecord {
  if (!isRecord(value)) return false;
  const row = value;
  return (
    typeof row.topicId === "string" &&
    /^(PY|PE):[TXI]\d{2}$/.test(row.topicId) &&
    Number.isInteger(row.depth) &&
    Number(row.depth) >= 1 &&
    Number(row.depth) <= 4 &&
    typeof row.text === "string" &&
    !!row.text.trim() &&
    row.text.length <= TOPIC_ASSESSMENT_TEXT_LIMIT &&
    typeof row.updatedAt === "string" &&
    Number.isFinite(Date.parse(row.updatedAt)) &&
    ["encounter", "runId", "requestId", "questionFingerprint"].every(
      (field) => typeof row[field] === "string" && !!row[field],
    ) &&
    (row.sourceHash === undefined ||
      (typeof row.sourceHash === "string" && !!row.sourceHash)) &&
    (row.startedAt === undefined ||
      (typeof row.startedAt === "number" && Number.isFinite(row.startedAt)))
  );
}

function savedTopicAssessmentRecords(s: StudyState): TopicAssessmentRecord[] {
  const cache: unknown = s.topicAssessments;
  if (!isRecord(cache)) return [];
  return Object.entries(cache).flatMap(([key, value]) =>
    validTopicAssessmentRecord(value) &&
    key === `${value.topicId}/D${value.depth}`
      ? [value]
      : [],
  );
}

/** The current view of a whole topic can come from a question at any depth. */
export function latestTopicAssessment(
  s: StudyState,
  topicId: string,
  sourceHash?: string,
): TopicAssessmentRecord | undefined {
  const cache = s.topicAssessments;
  if (!isRecord(cache)) return undefined;
  // Each topic has four possible depths. Reading those keys directly avoids
  // rescanning every topic's prose whenever an expanded panel is refreshed.
  let records = [1, 2, 3, 4].flatMap((depth) => {
    const record = cache[`${topicId}/D${depth}`];
    return validTopicAssessmentRecord(record) &&
      record.topicId === topicId &&
      record.depth === depth
      ? [record]
      : [];
  });
  if (sourceHash && records.some((record) => record.sourceHash === sourceHash))
    records = records.filter((record) => record.sourceHash === sourceHash);
  return records.sort(
    (a, b) =>
      (b.startedAt ?? Date.parse(b.updatedAt)) -
        (a.startedAt ?? Date.parse(a.updatedAt)) ||
      Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  )[0];
}

/** Validate the entire update before any caller applies completion effects. */
export function validateTopicAssessments(
  e: Encounter,
  values: unknown,
): TopicAssessmentValue[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw Error("Invalid topic assessment list");
  // Old persisted sessions predate topic commentary and remain completable.
  if (!values.length) return [];
  const topics = e.problem ? topicAssessmentTopics(e.problem.contract) : [];
  return validateTopicAssessmentValues(values, topics, true);
}

/** Called only after the enclosing question completion has been fully validated. */
export function recordTopicAssessments(
  g: StudyRecord,
  e: Encounter,
  values: unknown,
  metadata: TopicAssessmentMetadata = {},
): void {
  const updates = validateTopicAssessments(e, values);
  if (!updates.length || !e.problem) return;
  const session = e.directStudy;
  const requestId = metadata.requestId ?? session?.id;
  const questionFingerprint =
    metadata.questionFingerprint ?? session?.questionFingerprint;
  if (!requestId || !questionFingerprint)
    throw Error("Topic assessment requires its completed question identity");
  const startedAt = metadata.startedAt ?? session?.createdAt;
  if (startedAt !== undefined && !Number.isFinite(startedAt))
    throw Error("Invalid topic assessment question time");
  const updatedAt = metadata.updatedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(updatedAt)))
    throw Error("Invalid topic assessment update time");
  const sourceHash = metadata.sourceHash ?? g.study.learner?.sourceHash;
  const depth = e.problem.contract.depth;
  const staged = updates.flatMap(({ topicId, text }) => {
    const key = `${topicId}/D${depth}`;
    const saved = g.study.topicAssessments?.[key];
    const existing = validTopicAssessmentRecord(saved) ? saved : undefined;
    if (
      (existing?.requestId === requestId &&
        existing.questionFingerprint === questionFingerprint) ||
      (existing?.startedAt !== undefined &&
        startedAt !== undefined &&
        existing.startedAt > startedAt)
    )
      return [];
    const record: TopicAssessmentRecord = {
      topicId,
      depth,
      text,
      updatedAt,
      encounter: e.id,
      runId: e.runId ?? g.id,
      questionFingerprint,
      requestId,
      ...(sourceHash ? { sourceHash } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
    };
    return [{ key, record }];
  });
  if (!staged.length) return;
  if (
    !g.study.topicAssessments ||
    typeof g.study.topicAssessments !== "object" ||
    Array.isArray(g.study.topicAssessments)
  )
    g.study.topicAssessments = {};
  for (const { key, record } of staged) g.study.topicAssessments[key] = record;
}

/** Whole rows are retained or omitted, so an excerpt cannot silently change attribution. */
function boundedRows<T>(rows: T[], maxChars: number) {
  const items: T[] = [];
  let includedChars = 0;
  let totalChars = 0;
  for (const row of rows) {
    const chars = JSON.stringify(row).length;
    totalChars += chars;
    if (includedChars + chars > maxChars) continue;
    items.push(row);
    includedChars += chars;
  }
  return {
    items,
    coverage: {
      totalItems: rows.length,
      includedItems: items.length,
      omittedItems: rows.length - items.length,
      totalSerializedChars: totalChars,
      includedSerializedChars: includedChars,
      omittedSerializedChars: totalChars - includedChars,
      policy:
        "Whole rows only; relevant topics first, then most recent where dated.",
    },
  };
}

/** Exact source ranges make every omitted portion visible to the assessor. */
function boundedText(text: string, maxChars: number) {
  const take = Math.min(text.length, maxChars);
  const first = take === text.length ? take : Math.ceil(take / 2);
  const last = take - first;
  return {
    originalChars: text.length,
    includedChars: take,
    omittedChars: text.length - take,
    segments: [
      { start: 0, end: first, text: text.slice(0, first) },
      ...(last
        ? [
            {
              start: text.length - last,
              end: text.length,
              text: text.slice(-last),
            },
          ]
        : []),
    ],
  };
}

const topicOf = (id: string) => /^(PY|PE):[TXI]\d{2}/.exec(id)?.[0];
const onTopics = (ids: readonly string[], topics: readonly string[]) =>
  ids.some((id) => topics.includes(topicOf(id) ?? ""));
const encounterKey = (g: StudyRecord, e: Encounter) =>
  `${e.runId ?? g.id}/${e.id}`;

/** This is saved in the immutable request before the current native conversation begins. */
export function topicAssessmentContext(
  g: StudyRecord,
  r: Roadmap,
  contract: Contract,
) {
  const topicIds = topicAssessmentTopics(contract);
  const learner = g.study.learner;
  const adoption = learner?.roadmapAdoptions?.at(-1);
  // Reconciliation can correct an earlier attempt or gap without changing the
  // protected curriculum. Commentary must see that accepted source revision.
  const adopted = adoption
    ? inspectMergedDocument(adoption.proposal.canonical)
    : undefined;
  const prioritize = <T extends { objectiveIds: string[]; at?: string }>(
    rows: T[],
  ) =>
    [...rows].sort(
      (a, b) =>
        Number(onTopics(b.objectiveIds, topicIds)) -
          Number(onTopics(a.objectiveIds, topicIds)) ||
        (b.at ?? "").localeCompare(a.at ?? ""),
    );
  const progressByTrack = new Map<
    Track,
    ReturnType<typeof studyTrackProgress>
  >();
  const definitionsByObjective = new Map<string, ScopeDefinition[]>();
  for (const definition of Object.values(learner?.scopes ?? {})) {
    const definitions =
      definitionsByObjective.get(definition.objectiveId) ?? [];
    definitions.push(definition);
    definitionsByObjective.set(definition.objectiveId, definitions);
  }
  const topics = topicIds.map((topicId) => {
    const track = topicId.slice(0, 2) as Track;
    const shortId = topicId.slice(3);
    let progress = progressByTrack.get(track);
    if (!progress) {
      progress = studyTrackProgress(r, g.study, track, contract.depth);
      progressByTrack.set(track, progress);
    }
    const topic = progress.topics.find((entry) => entry.id === shortId);
    return {
      topicId,
      name: r.tracks[track].topics[shortId] ?? shortId,
      depth: contract.depth,
      passed: topic?.passed ?? 0,
      requiredCheckpoints: topic?.total ?? 0,
      checkpoints: topic?.checkpoints ?? [],
      curriculumScopes: r.tracks[track].objectives
        .filter((objective) => topicOf(objective.id) === topicId)
        .map((objective) => ({
          objectiveId: objective.id,
          scope: objective.scope,
          target: objective.target,
          importedStates: objective.cells,
          sourceRefs: objective.refs,
          currentCell: learner?.cells[objective.id],
          scopeDefinitions: definitionsByObjective.get(objective.id) ?? [],
        })),
    };
  });
  const priorAssessments = savedTopicAssessmentRecords(g.study)
    .sort(
      (a, b) =>
        Number(topicIds.includes(b.topicId)) -
          Number(topicIds.includes(a.topicId)) ||
        b.updatedAt.localeCompare(a.updatedAt),
    )
    .map((record) => ({
      ...record,
      matchesCurrentSource: record.sourceHash === r.sourceHash,
      note: "Prior AI interpretation, not new learner evidence or formal mastery.",
    }));

  // Source rows carry the hash and track; bare matching topic numbers are never proof.
  const importedRows = (["PY", "PE"] as const).flatMap((track) => {
    const seen = new Set<string>();
    const progress =
      adopted?.blocks[`${track}_PROGRESS`] ?? r.tracks[track].progress;
    return progress.split("\n").flatMap((row) => {
      if (!/^\| (?:S\d{4}-(?:EV\d+|A\d+)|G\d+) \|/.test(row) || seen.has(row))
        return [];
      seen.add(row);
      const columns = row.split(CELL_SEPARATOR).map((column) => column.trim());
      const gap = /^G\d+$/.test(columns[1]);
      const attempt = /^S\d{4}-A\d+$/.test(columns[1]);
      const scope = columns[gap ? 2 : attempt ? 3 : 4];
      const objectiveIds = [
        ...new Set(scope.match(/[TXI]\d{2}(?:\.\d+)?(?!\d)/g) ?? []),
      ].map((id) => `${track}:${id}`);
      return [
        {
          track,
          sourceHash: r.sourceHash,
          ...(adoption ? { canonicalHash: adoption.canonicalHash } : {}),
          kind: gap
            ? "imported-gap"
            : attempt
              ? "imported-attempt-disposition"
              : "imported-evidence",
          objectiveIds,
          row,
        },
      ];
    });
  });
  const encounters = new Map<string, Encounter>();
  for (const e of [...Object.values(g.encounters), ...g.study.archives]) {
    const key = encounterKey(g, e);
    if (!encounters.has(key)) encounters.set(key, e);
  }
  const conversations = [...encounters.values()]
    .filter((e) => {
      if (!e.problem || !onTopics(e.problem.contract.objectiveIds, topicIds))
        return false;
      const complete =
        e.directStudy?.state === "applied" ||
        e.probe?.turns.some((turn) => turn.complete) ||
        e.state === "consumed" ||
        e.submissions.some((submission) => submission.status === "complete");
      const humanEvidence =
        e.directStudy?.state === "applied" ||
        [...e.tutor, ...(e.group ?? [])].some(
          (message) => message.kind === "human",
        ) ||
        e.history.some((artifact) => artifact.author === "human");
      return complete && humanEvidence;
    })
    .sort(
      (a, b) =>
        (b.directStudy?.appliedAt ?? b.directStudy?.createdAt ?? 0) -
        (a.directStudy?.appliedAt ?? a.directStudy?.createdAt ?? 0),
    )
    .map((e) => ({
      encounter: e.id,
      runId: e.runId ?? g.id,
      source: g.encounters[e.id] === e ? "current-run" : "saved-archive",
      originalQuestion: {
        title: e.problem!.title,
        prompt: e.problem!.prompt,
        rubric: e.problem!.rubric,
        contract: e.problem!.contract,
        provenance: e.problem!.provenance,
      },
      messages: [
        ...e.tutor.map((message) => ({ ...message, channel: "private-tutor" })),
        ...(e.group ?? []).map((message) => ({ ...message, channel: "group" })),
      ].sort((a, b) => a.seq - b.seq),
      learnerArtifacts: e.history.filter(
        (artifact) => artifact.author === "human",
      ),
      learnerSubmissions: e.submissions.filter(
        (submission) => submission.author === "human",
      ),
      probeTurns: e.probe?.turns ?? [],
    }));
  const evidence = prioritize(
    (learner?.evidence ?? []).map((entry) => ({
      ...entry,
      objectiveIds: [entry.objectiveId],
    })),
  );
  const allProgress = (["PY", "PE"] as const).flatMap((track) =>
    r.tracks[track].objectives.map((objective) => ({
      objectiveId: objective.id,
      topicId: topicOf(objective.id),
      importedStates: objective.cells,
      currentStates: learner?.cells[objective.id]?.states,
    })),
  );
  return {
    topicIds,
    depth: contract.depth,
    sourceHash: r.sourceHash,
    frozenBeforeCurrentConversation: true,
    contextPolicy:
      "Use this supplied saved history plus the current native question conversation. No other chats or files are available from these references. Historical records and prior AI narratives can support cautious inference but are not current learner answers. Attribute tutor explanations as assistance. Unknown, observed gap, and predicted gap are different. Output topic assessments only for topicIds; cross-topic evidence is context, not authority to update other topics. Coverage below explicitly reports every omitted row or source character.",
    topics: boundedRows(topics, 20_000),
    priorAssessments: boundedRows(priorAssessments, 16_000),
    observations: {
      established: boundedRows(
        prioritize(g.study.knowledgeEstablished ?? []),
        12_000,
      ),
      gaps: boundedRows(prioritize(g.study.knowledgeGaps ?? []), 12_000),
    },
    learner: {
      sourceHash: learner?.sourceHash,
      matchesCurrentSource: learner?.sourceHash === r.sourceHash,
      profile: g.study.profile ?? "development",
      careerFocus: g.study.careerFocus ?? learner?.careerFocus,
      tracks: learner?.tracks,
      topicCatalog: boundedRows(
        (["PY", "PE"] as const).flatMap((track) =>
          Object.entries(r.tracks[track].topics).map(([id, name]) => ({
            topicId: `${track}:${id}`,
            name,
          })),
        ),
        8_000,
      ),
      checkpointProgress: boundedRows(allProgress, 30_000),
      evidence: boundedRows(evidence, 24_000),
      historicalReviews: boundedRows(learner?.historicalReviews ?? [], 8_000),
    },
    importedContext: {
      documentId: r.documentId,
      revision: adopted?.revision ?? r.revision,
      sourceHash: r.sourceHash,
      ...(adoption
        ? {
            canonicalHash: adoption.canonicalHash,
            adoptedAt: adoption.adoptedAt,
          }
        : {}),
      sharedProgress: boundedText(
        adopted?.blocks.SHARED_PROGRESS ?? r.sharedProgress,
        16_000,
      ),
      evidenceAndGapRows: boundedRows(prioritize(importedRows), 24_000),
      contractHistoricalScope: contract.historicalScope,
      note: "Imported source text is attributed historical context, never fresh learner evidence. Retained source dispositions can qualify earlier observations.",
    },
    completedConversations: boundedRows(conversations, 48_000),
  };
}
