import { browserSpecText } from "../scripts/browser-runner/spec.mjs";
import type { ExecutionReceipt, WorkspaceExecution } from "./execution";
import { finalRequirements } from "./final-requirements";
import { encounterKey } from "./learner";
import type { Artifact, StudyRecord, Roadmap } from "./model";
import { sha256 } from "./digest";
import { workspaceAt } from "./workspace-history";
export interface EnvironmentObservation {
  schema: 1;
  id: string;
  sourceHash: string;
  envId: string;
  sourceScope: string;
  capturedAt: string;
  profile: "development" | "live";
  status: "pending-review";
  independence: "unassessed";
  learnerStatement: string;
  fingerprint: string;
  suppliedOutput?: {
    name: string;
    text: string;
    sha256: string;
    provenance: "learner-supplied-unreviewed";
  };
  execution?: {
    encounter: string;
    jobId: string;
    executionSequence: number;
    revision: number;
    language: ExecutionReceipt["language"];
    environment?: "react";
    steps?: WorkspaceExecution["steps"];
    interactionProvenance?: string;
    code: string;
    receipt: ExecutionReceipt;
    humanArtifactReferences: number[];
    historyReferences: Pick<Artifact, "seq" | "author" | "kind" | "revision">[];
    /** New captures write the first form; observations captured by earlier
     * builds carry the second, and stored observations are never rewritten. */
    authorshipAndAssistance:
      | "unassessed; full attributed work and tutor history remain in the full backup"
      | "unassessed; full attributed work and tutor history remain in the game backup";
  };
}
interface EnvironmentObservationInput {
  envId: string;
  statement: string;
  executionKey?: string;
  suppliedOutput?: { name: string; text: string };
}
export function environmentExecutions(g: StudyRecord) {
  return [...Object.values(g.encounters), ...g.study.archives].flatMap((e) =>
    (e.executions ?? [])
      .filter(
        (job) =>
          job.status === "finished" &&
          job.receipt?.executed &&
          Array.isArray(job.artifactSequences) &&
          job.artifactSequences.length > 0 &&
          e.history.some(
            (h) =>
              h.kind === "execution" &&
              h.author === "runner" &&
              h.executionId === job.id &&
              h.revision === job.revision &&
              h.text === JSON.stringify(job.receipt),
          ) &&
          job.artifactSequences.every((seq) =>
            e.history.some(
              (h) =>
                h.seq === seq &&
                h.author === "human" &&
                h.kind === "edit" &&
                h.revision === job.revision,
            ),
          ),
      )
      .filter((job) => {
        try {
          const source = workspaceAt(
            e,
            job.artifactSequences.reduce(
              (latest, seq) => Math.max(latest, seq),
              0,
            ),
          );
          return (
            source.revision === job.revision && source.content === job.code
          );
        } catch {
          return false;
        }
      })
      .map((job) => ({ key: `${encounterKey(e)}/${job.id}`, e, job })),
  );
}
/** Capture raw evidence for later review. This cannot assign ENV status, academic
 * EV IDs, visits, gates or mastery. A report is never promoted to observation. */
export async function recordEnvironmentObservation(
  g: StudyRecord,
  r: Roadmap,
  input: EnvironmentObservationInput,
) {
  const definition = finalRequirements(r, "PE").find(
    (d) => d.kind === "environment" && d.id === input.envId,
  );
  if (!definition || g.study.learner?.sourceHash !== r.sourceHash)
    throw Error("Environment item or curriculum source is unavailable");
  if (
    typeof input.statement !== "string" ||
    !input.statement.trim() ||
    input.statement.length > 8000
  )
    throw Error(
      "Describe your own actions, environment, what ran and the observed result (up to 8000 characters)",
    );
  if (
    input.suppliedOutput &&
    (typeof input.suppliedOutput.name !== "string" ||
      !input.suppliedOutput.name.trim() ||
      input.suppliedOutput.name.length > 200 ||
      typeof input.suppliedOutput.text !== "string" ||
      !input.suppliedOutput.text.trim() ||
      new TextEncoder().encode(input.suppliedOutput.text).length > 262144)
  )
    throw Error("Supply a named nonempty text output up to 256 KiB");
  const study = g.study,
    profile = study.profile ?? "development";
  const value = {
    sourceHash: r.sourceHash,
    envId: definition.id,
    sourceScope: definition.scope,
    profile,
    learnerStatement: input.statement.trim(),
    ...(input.suppliedOutput
      ? { suppliedOutput: structuredClone(input.suppliedOutput) }
      : {}),
  };
  let execution: EnvironmentObservation["execution"];
  if (input.executionKey) {
    const found = environmentExecutions(g).find(
      (v) => v.key === input.executionKey,
    );
    if (!found)
      throw Error(
        "Choose a finished executed workspace with attributed human edits",
      );
    const e = found.e,
      job = structuredClone(found.job),
      receipt = structuredClone(job.receipt!),
      executionSequence = e.history.find(
        (h) => h.kind === "execution" && h.executionId === job.id,
      )!.seq,
      historyReferences = e.history
        .filter((h) => h.seq <= executionSequence && h.revision <= job.revision)
        .map(({ seq, author, kind, revision }) => ({
          seq,
          author,
          kind,
          revision,
        }));
    if (
      receipt.language !== job.language ||
      receipt.environment !== job.environment ||
      (job.environment === "react" &&
        receipt.specHash !==
          (await sha256(browserSpecText(job.code, job.steps)))) ||
      receipt.codeHash !== (await sha256(job.code)) ||
      !/^sha256:[a-f0-9]{64}$/.test(receipt.imageId ?? "") ||
      typeof receipt.stdout !== "string" ||
      typeof receipt.stderr !== "string"
    )
      throw Error("Runner receipt does not match this captured workspace");
    execution = {
      encounter: encounterKey(e),
      jobId: job.id,
      executionSequence,
      revision: job.revision,
      language: job.language,
      ...(job.environment === "react"
        ? {
            environment: "react" as const,
            steps: job.steps,
            interactionProvenance:
              "Automated issued task checks; not human-authored tests or manual browser interaction.",
          }
        : {}),
      code: job.code,
      receipt,
      humanArtifactReferences: [...job.artifactSequences],
      historyReferences,
      authorshipAndAssistance:
        "unassessed; full attributed work and tutor history remain in the full backup",
    };
  }
  const suppliedOutput = value.suppliedOutput
    ? {
        ...value.suppliedOutput,
        sha256: await sha256(value.suppliedOutput.text),
        provenance: "learner-supplied-unreviewed" as const,
      }
    : undefined;
  const body = { ...value, suppliedOutput, execution },
    fingerprint = await sha256(JSON.stringify(body));
  if (g.study !== study)
    throw Error(
      "Study profile changed while capturing; retry for the current profile",
    );
  const records = (study.environmentObservations ??= []),
    existing = records.find((o) => o.fingerprint === fingerprint);
  if (existing) return existing;
  const observation: EnvironmentObservation = {
    schema: 1,
    id: `environment-observation-${crypto.randomUUID()}`,
    ...body,
    capturedAt: new Date().toISOString(),
    status: "pending-review",
    independence: "unassessed",
    fingerprint,
  };
  records.push(observation);
  return observation;
}
