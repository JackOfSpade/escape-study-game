import { PROVIDERS } from "./model";
import { sha256 } from "./digest";
import type { LearnerLedger, LearningAttempt } from "./learning-model";
import type { Encounter, Game } from "./model";
import type {
  ActiveAttemptSnapshot,
  RoadmapReconciliationJob,
} from "./roadmap-adoption-types";
import { receiptRows } from "./roadmap-structure";
const key = (e: Encounter) => `${e.runId ?? "legacy"}/${e.id}`;
const encounter = (g: Game, id: string) =>
  [...Object.values(g.encounters), ...g.study.archives].find(
    (e) => key(e) === id,
  );
// Physical time, NPC thoughts and roadmap presentation do not change the
// captured human task. Actual edits, reasoning and tutoring do.
const workText = (e: Encounter) =>
  JSON.stringify({
    problem: e.problem,
    workspace: e.workspace,
    revision: e.revision,
    history: e.history.filter(
      (h) =>
        h.author === "human" &&
        ["edit", "reasoning", "test", "execution"].includes(h.kind),
    ),
    tutor: e.tutor,
    group: e.group.filter((m) => m.author === "human"),
    executions: (e.executions ?? []).filter((j) => j.author === "human"),
  });
async function workHash(e: Encounter) {
  const text = workText(e),
    hash = await sha256(text);
  if (workText(e) !== text)
    throw Error(
      "Current question or human work changed while capturing its reconciliation context",
    );
  return hash;
}
export async function captureActiveAttempts(
  g: Game,
): Promise<ActiveAttemptSnapshot[]> {
  const result: ActiveAttemptSnapshot[] = [];
  for (const a of g.study.learner?.attempts ?? []) {
    if (["served", "externally-resolved"].includes(a.status)) continue;
    const e = encounter(g, a.encounter);
    if (e?.problem)
      result.push({
        attemptId: a.id,
        encounter: a.encounter,
        workHash: await workHash(e),
        humanCutoff: e.history.reduce(
          (latest, h) => Math.max(latest, h.seq),
          Math.max(g.seq, 0),
        ),
        humanSequences: e.history
          .filter(
            (h) =>
              h.author === "human" &&
              ["edit", "reasoning", "test", "execution"].includes(h.kind),
          )
          .map((h) => h.seq),
      });
  }
  return result;
}
export const activeContextIdentity = (items: ActiveAttemptSnapshot[] = []) =>
  JSON.stringify(
    items
      .map((a) => [a.attemptId, a.encounter, a.workHash])
      .sort((a, b) => a[0].localeCompare(b[0])),
  );
export async function validateActiveAttemptWork(
  g: Game,
  job: RoadmapReconciliationJob,
) {
  for (const update of job.proposal?.attemptUpdates ?? []) {
    if (!update.resolveCurrent) continue;
    const captured = job.payload.context.activeAttempts?.find(
        (a) => a.attemptId === update.attemptId,
      ),
      e = captured && encounter(g, captured.encounter);
    if (
      !captured ||
      !e ||
      captured.encounter !== update.resolveCurrent.encounter ||
      captured.workHash !== update.resolveCurrent.workHash ||
      (await workHash(e)) !== captured.workHash
    )
      throw Error(
        "Current question or human work changed; reconcile a fresh snapshot before resolving this attempt",
      );
  }
}
/** Synchronous final check after async compilation, immediately before publication. */
export function activeWorkSnapshot(g: Game, job: RoadmapReconciliationJob) {
  return JSON.stringify(
    (job.proposal?.attemptUpdates ?? [])
      .filter((u) => u.resolveCurrent)
      .map((u) => {
        const e = encounter(g, u.resolveCurrent!.encounter);
        return e ? [u.attemptId, workText(e)] : [u.attemptId, null];
      }),
  );
}
export function externalResolutionRow(l: LearnerLedger, a: LearningAttempt) {
  const v = a.externalResolution;
  if (a.status !== "externally-resolved" || !v)
    throw Error("Unsupported external attempt resolution");
  const receipt = l.roadmapAdoptions?.find((r) => r.id === v.adoptionId),
    declaration = receipt?.proposal.attemptUpdates?.find(
      (u) =>
        u.attemptId === a.id && u.resolveCurrent?.encounter === a.encounter,
    ),
    row =
      receipt &&
      [...receiptRows(receipt)].find(
        ([key]) =>
          key.startsWith(
            `${a.contract.track}_PROGRESS/0.5.1 Attempt status register/`,
          ) && key.endsWith(`/${a.id}`),
      )?.[1];
  if (
    !receipt ||
    !declaration ||
    receipt.sourceHash !== l.sourceHash ||
    !PROVIDERS.includes(receipt.provenance) ||
    receipt.id !== receipt.proposal.requestId ||
    !Number.isFinite(Date.parse(v.at)) ||
    !Number.isInteger(v.humanCutoff) ||
    v.humanCutoff < 0 ||
    v.humanCutoff !== declaration.resolveCurrent?.humanCutoff ||
    !Array.isArray(v.assessedHumanSequences) ||
    JSON.stringify(v.assessedHumanSequences) !==
      JSON.stringify(declaration.resolveCurrent?.assessedHumanSequences) ||
    !/^(COMPLETED|SERVED|DECLINED|SUPERSEDED|INVALIDATED)\b/.test(
      v.disposition,
    ) ||
    receipt.canonicalHash !== v.canonicalHash ||
    row !== v.sourceRow ||
    row
      .split("|")
      .slice(1, -1)
      .map((s) => s.trim())[3] !== v.disposition
  )
    throw Error(
      "External attempt resolution has no matching reviewed source disposition",
    );
  return row;
}
