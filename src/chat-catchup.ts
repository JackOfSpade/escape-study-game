import {
  groupSnapshot,
  validateGroupReply,
  type GroupSnapshot,
} from "./group-grounding";
import type { Provider, Encounter, Game, Message } from "./model";
import { npcProfile } from "./npc-cognition";
import { sha256 } from "./digest";
import { workspaceAt } from "./workspace-history";

export interface CatchupBatch {
  id: string;
  /** Missing only on legacy native batches. */
  provider?: Provider;
  from: number;
  to: number;
  sourceRevision: number;
  refs: number[];
  state: "pending" | "unavailable" | "interrupted" | "applied" | "superseded";
  messageIds: string[];
  error?: string;
  payloadHash?: string;
  snapshot?: GroupSnapshot;
  speakers?: {
    id: string;
    name: string;
    role: string;
    profile?: ReturnType<typeof npcProfile>;
    historical: true;
  }[];
  contextIds?: string[];
  contextPresentation?: Record<string, number | null>;
  problemKnown?: boolean;
  acceptedSubmission?: string;
}
export interface CatchupAdapter {
  provider?: Provider;
  request(payload: unknown): Promise<unknown>;
  append(
    author: string,
    kind: Message["kind"],
    text: string,
    provenance: string,
    refs: number[],
  ): Message;
}
const pending = new WeakMap<Encounter, Map<string, Promise<void>>>();
const terminal = (job: CatchupBatch) =>
  job.state === "applied" || job.state === "superseded";
function releaseSnapshot(job: CatchupBatch) {
  delete job.snapshot;
  delete job.contextIds;
  delete job.contextPresentation;
  delete job.speakers;
}
export function coverCatchupsWithRecordedLog(e: Encounter) {
  for (const job of e.catchups ?? [])
    if (!terminal(job) && job.to <= e.chatCursor) {
      job.state = "superseded";
      job.error =
        "Recorded work summaries covered this interval while bridge catch-up was unavailable.";
      job.messageIds = e.group
        .filter((m) => m.sourceRefs?.some((ref) => job.refs.includes(ref)))
        .map((m) => m.id);
      releaseSnapshot(job);
    }
}
export const workKinds = new Set([
  "workspace-view",
  "validation",
  "npc-thought",
  "activity",
  "defense",
  "completion",
  "npc-proposal",
]);
export function unseenWork(e: Encounter, cutoff: number) {
  const represented = new Set(e.group.flatMap((m) => m.sourceRefs ?? []));
  return e.history.filter(
    (h) =>
      h.seq > e.chatCursor &&
      h.seq <= cutoff &&
      workKinds.has(h.kind) &&
      !represented.has(h.seq),
  );
}
function transcript(
  e: Encounter,
  ids: string[],
  presented: Record<string, number | null>,
) {
  return ids.map((id) => {
    const m = e.group.find((m) => m.id === id);
    if (!m)
      throw Error(
        "Saved catch-up context is missing; original work remains available",
      );
    return {
      id: m.id,
      author: m.author,
      kind: m.kind,
      text: m.text,
      seq: m.seq,
      worldTime: m.worldTime,
      presented: presented[m.id] ?? null,
    };
  });
}
function payload(g: Game, e: Encounter, job: CatchupBatch, workspace: string) {
  if (!job.snapshot || !job.speakers || !job.contextIds)
    throw Error("Saved catch-up snapshot is unavailable");
  if (job.problemKnown && !e.problem)
    throw Error("Saved catch-up question is unavailable");
  return {
    ...job.snapshot,
    mode: "catch-up",
    ...(job.provider ? { provider: job.provider } : {}),
    sessionId: `${g.id}/${e.id}/public`,
    range: { from: job.from, to: job.to, refs: job.refs },
    speakers: job.speakers,
    problem: job.problemKnown ? e.problem : undefined,
    workspace,
    messages: transcript(e, job.contextIds, job.contextPresentation ?? {}),
    workRecords: (e.npcWork ?? []).filter((w) => w.seq <= job.to).slice(-16),
    policy:
      "Summarize only recorded work in this event range. This is retrospective work materialized now, not unseen past dialogue. No new work, execution or validated correctness may be invented. Return observations only.",
  };
}
function restoredWorkspace(e: Encounter, job: CatchupBatch) {
  if (!job.problemKnown) return "";
  if (job.acceptedSubmission) {
    const accepted = e.submissions.find((s) => s.id === job.acceptedSubmission);
    if (!accepted || accepted.revision !== job.sourceRevision)
      throw Error("Saved accepted catch-up revision is missing");
    return accepted.content;
  }
  const reconstructed = workspaceAt(e, job.to);
  if (reconstructed.revision !== job.sourceRevision)
    throw Error("Saved catch-up workspace cannot be reconstructed exactly");
  return reconstructed.content;
}
function startJob(
  g: Game,
  e: Encounter,
  provider: Provider,
): CatchupBatch | undefined {
  const existing = e.catchups?.find(
    (job) => !terminal(job) && job.from === e.chatCursor,
  );
  if (existing) return existing;
  const cutoff = g.seq,
    fresh = unseenWork(e, cutoff);
  if (!fresh.length) return;
  const authors = [
    ...new Set(
      [...fresh]
        .reverse()
        .filter((h) => h.kind === "npc-thought" || h.kind === "npc-proposal")
        .map((h) => h.author),
    ),
  ].slice(0, 2);
  const speakers: NonNullable<CatchupBatch["speakers"]> = authors.length
    ? authors.map((id) => {
        const a = g.survivors.find((a) => a.id === id);
        return {
          id,
          name: a?.name ?? id,
          role: a?.role ?? "recorded contributor",
          ...(a ? { profile: npcProfile(a) } : {}),
          historical: true,
        };
      })
    : [
        {
          id: "Room log",
          name: "Room log",
          role: "recorded room activity",
          historical: true,
        },
      ];
  const id = `catchup-${g.id}-${e.id}-${e.chatCursor}-${cutoff}`;
  const snapshot = groupSnapshot(e, id, cutoff);
  // Store a bounded immutable context, not another full workspace per reopening.
  snapshot.events = snapshot.events.map(({ delta: _delta, ...h }) => ({
    ...h,
    text: h.text.slice(0, 8000),
  }));
  const job: CatchupBatch = {
    id,
    provider,
    from: e.chatCursor,
    to: cutoff,
    sourceRevision: e.revision,
    refs: fresh.map((h) => h.seq),
    state: "pending",
    messageIds: [],
    snapshot,
    speakers: structuredClone(speakers),
    contextIds: e.group.slice(-20).map((m) => m.id),
    contextPresentation: Object.fromEntries(
      e.group.slice(-20).map((m) => [m.id, m.presented ?? null]),
    ),
    problemKnown: !!e.problem,
    acceptedSubmission: e.submissions.find(
      (s) =>
        s.id === e.accepted &&
        s.revision === e.revision &&
        s.content === e.workspace,
    )?.id,
  };
  (e.catchups ??= []).push(job);
  return job;
}

export function generateCatchup(
  g: Game,
  e: Encounter,
  adapter: CatchupAdapter,
): Promise<void> {
  const existing = e.catchups?.some(
    (j) => !terminal(j) && j.from === e.chatCursor,
  );
  const provider = adapter.provider ?? "study-mode";
  const job = startJob(g, e, provider);
  if (!job) return Promise.resolve();
  if ((job.provider ?? "study-mode") !== provider) {
    e.catchupNotice =
      "Reconnect the original catch-up provider; its exact recorded interval remains saved.";
    return Promise.resolve();
  }
  const requests = pending.get(e) ?? new Map<string, Promise<void>>();
  pending.set(e, requests);
  const active = requests.get(job.id);
  if (active) return active;
  const initialWorkspace = existing ? undefined : e.workspace;
  job.state = "pending";
  delete job.error;
  e.catchupNotice =
    "Preparing a summary of recorded group work… Survival continues.";
  const run = Promise.resolve().then(async () => {
    try {
      const request = payload(
        g,
        e,
        job,
        initialWorkspace ?? restoredWorkspace(e, job),
      );
      const digest = await sha256(JSON.stringify(request));
      if (job.payloadHash && job.payloadHash !== digest)
        throw Error(
          "Saved catch-up context changed; refusing to reinterpret its recorded interval",
        );
      job.payloadHash = digest;
      const response = await adapter.request(request);
      if (terminal(job)) return;
      if (e.chatCursor !== job.from) {
        job.state = "superseded";
        releaseSnapshot(job);
        return;
      }
      const messages = validateGroupReply(
        response,
        job.snapshot!,
        job.speakers!.map((s) => s.id),
      );
      if (
        !messages.length ||
        messages.some(
          (m) =>
            m.kind !== "observation" ||
            !m.refs.some((ref) => job.refs.includes(ref)),
        )
      )
        throw Error("Catch-up must summarize the actual unshown work range");
      const represented = new Set(e.group.flatMap((m) => m.sourceRefs ?? []));
      for (const m of messages) {
        if (
          m.refs
            .filter((ref) => job.refs.includes(ref))
            .every((ref) => represented.has(ref))
        )
          continue;
        const speaker = job.speakers!.find((s) => s.id === m.author)!;
        const delivered = adapter.append(
          m.author,
          "npc",
          `Recorded work by ${speaker.name}, through draft v${job.sourceRevision} (summary shown now, not prior dialogue):\n${m.text}`,
          `${job.provider ?? "study-mode"}-catch-up`,
          m.refs,
        );
        delivered.requestId = job.id;
        job.messageIds.push(delivered.id);
        m.refs.forEach((ref) => represented.add(ref));
      }
      const remaining = job.refs.filter((ref) => !represented.has(ref));
      if (remaining.length) {
        const summary = adapter.append(
          "Room log",
          "system",
          `${remaining.length} additional recorded work/activity events remain in the work log. This summary does not claim executed tests or validated reasoning.`,
          "grounded-event-range-summary",
          remaining,
        );
        job.messageIds.push(summary.id);
      }
      e.chatCursor = job.to;
      job.state = "applied";
      e.catchupNotice =
        "Summary of recorded group work · original work remains in the log.";
      releaseSnapshot(job);
    } catch (err) {
      if (terminal(job)) return;
      job.state = "unavailable";
      job.error = String(err);
      e.catchupNotice =
        "Group catch-up is unavailable. Recorded work and this request are retained for retry.";
    } finally {
      requests.delete(job.id);
    }
  });
  requests.set(job.id, run);
  return run;
}
