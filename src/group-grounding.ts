import type { WorkspaceExecution } from "./execution";
import type { Artifact, Encounter } from "./model";
import {
  validateWorkspacePatch,
  type WorkspacePatch,
} from "./workspace-proposals";
export interface GroupSnapshot {
  requestId: string;
  sourceRevision: number;
  cutoff: number;
  events: Artifact[];
  executions: Pick<
    WorkspaceExecution,
    "id" | "revision" | "status" | "receipt" | "environment" | "steps"
  >[];
}
interface GroupReply {
  patch?: WorkspacePatch;
  author: string;
  kind: "question" | "proposal" | "observation";
  text: string;
  refs: number[];
  claims?: {
    kind: "execution" | "workspace-edit";
    ref: number;
    by: string;
    revision: number;
    executionId?: string;
    exitCode?: number | null;
  }[];
}
export function groupSnapshot(
  e: Encounter,
  requestId: string,
  cutoff: number,
): GroupSnapshot {
  const privateSequences = new Set(e.tutor.map((m) => m.seq));
  const wanted = new Set(
    (e.npcWork ?? [])
      .filter((w) => w.seq <= cutoff)
      .slice(-16)
      .map((w) => w.seq),
  );
  const publicHistory = e.history.filter(
    (h) =>
      !privateSequences.has(h.seq) &&
      h.kind !== "tutor" &&
      h.kind !== "source-view",
  );
  const recent = publicHistory.filter((h) => h.seq <= cutoff).slice(-80);
  for (const h of recent) wanted.add(h.seq);
  return structuredClone({
    requestId,
    sourceRevision: e.revision,
    cutoff,
    events: publicHistory.filter((h) => wanted.has(h.seq) && h.seq <= cutoff),
    executions: (e.executions ?? [])
      .slice(-4)
      .map(({ id, revision, status, receipt, environment, steps }) => ({
        id,
        revision,
        status,
        receipt,
        ...(environment ? { environment, steps } : {}),
      })),
  });
}

/** Prose remains untrusted AI content. Structured factual claims need actual
 * captured evidence; exit zero is never silently described as semantic success. */
export function validateGroupReply(
  reply: unknown,
  snapshot: GroupSnapshot,
  speakers: string[],
  workspace?: string,
): GroupReply[] {
  const result = reply as {
    requestId?: string;
    sourceRevision?: number;
    messages?: GroupReply[];
  };
  if (
    !result ||
    result.requestId !== snapshot.requestId ||
    result.sourceRevision !== snapshot.sourceRevision ||
    !Array.isArray(result.messages) ||
    result.messages.length > speakers.length ||
    new Set(result.messages.map((m) => m.author)).size !==
      result.messages.length
  )
    throw Error("Invalid group response identity or duplicate speakers");
  const bodies = new Set<string>();
  for (const m of result.messages) {
    if (
      !speakers.includes(m.author) ||
      !["question", "proposal", "observation"].includes(m.kind) ||
      typeof m.text !== "string" ||
      !m.text.trim() ||
      m.text.length > 8000 ||
      !Array.isArray(m.refs) ||
      m.refs.length > 20 ||
      new Set(m.refs).size !== m.refs.length ||
      m.refs.some(
        (ref) =>
          !Number.isInteger(ref) || !snapshot.events.some((h) => h.seq === ref),
      ) ||
      (m.kind !== "question" && !m.refs.length) ||
      (m.claims?.length ?? 0) > 8
    )
      throw Error("Ungrounded or malformed group message");
    const body = m.text.replace(/\r\n/g, "\n").trim();
    if (bodies.has(body))
      throw Error(
        "Duplicate group reply text; each responding survivor must add a distinct contribution",
      );
    bodies.add(body);
    if (m.patch !== undefined) {
      if (m.kind !== "proposal" || workspace === undefined)
        throw Error("Only current workspace proposals may contain an edit");
      validateWorkspacePatch(m.patch, workspace);
    }
    for (const claim of m.claims ?? []) {
      const h = snapshot.events.find((h) => h.seq === claim.ref);
      if (
        !h ||
        !m.refs.includes(claim.ref) ||
        claim.by !== h.author ||
        claim.revision !== h.revision
      )
        throw Error("Group claim attribution does not match its source");
      if (claim.kind === "workspace-edit") {
        if (h.kind !== "edit")
          throw Error("No actual workspace edit supports this claim");
      } else if (claim.kind === "execution") {
        const job = snapshot.executions.find(
          (job) => job.id === claim.executionId,
        );
        if (
          h.kind !== "execution" ||
          h.executionId !== claim.executionId ||
          job?.status !== "finished" ||
          !job.receipt?.executed ||
          job.revision !== claim.revision ||
          job.receipt.exitCode !== claim.exitCode
        )
          throw Error(
            "No matching captured runtime receipt supports this group claim",
          );
      } else throw Error("Unsupported group claim");
    }
  }
  return result.messages;
}
