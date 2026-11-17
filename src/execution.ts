import {
  browserSpecText,
  browserSteps,
  type BrowserStep,
} from "../scripts/browser-runner/spec.mjs";
import { eligible } from "./curriculum";
import {
  nextSeq,
  type Encounter,
  type StudyRecord,
  type Roadmap,
} from "./model";
import { sha256 } from "./digest";

export interface ExecutionReceipt {
  id: string;
  language: "python" | "typescript";
  environment?: "react";
  specHash?: string;
  status:
    "completed" | "timeout" | "output-limit" | "resource-limit" | "unavailable";
  executed: boolean;
  codeHash?: string;
  imageId?: string;
  startedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  detail?: string;
}
interface ExecutionPreview {
  dataUrl: string;
  width: number;
  height: number;
  sha256: string;
}
async function validatePreview(value: unknown): Promise<ExecutionPreview> {
  const p = value as ExecutionPreview;
  if (
    !p ||
    typeof p.dataUrl !== "string" ||
    p.dataUrl.length > 180025 ||
    !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(p.dataUrl) ||
    p.width !== 640 ||
    p.height !== 400 ||
    !/^[a-f0-9]{64}$/.test(p.sha256)
  )
    throw Error("Invalid browser preview");
  const bytes = Uint8Array.from(
    atob(p.dataUrl.slice("data:image/jpeg;base64,".length)),
    (c) => c.charCodeAt(0),
  );
  const digest = await sha256(bytes);
  if (
    bytes[0] !== 255 ||
    bytes[1] !== 216 ||
    bytes.at(-2) !== 255 ||
    bytes.at(-1) !== 217 ||
    digest !== p.sha256
  )
    throw Error("Browser preview does not match its captured image");
  return {
    dataUrl: p.dataUrl,
    width: p.width,
    height: p.height,
    sha256: p.sha256,
  };
}
export interface WorkspaceExecution {
  id: string;
  author?: string;
  revision: number;
  language: ExecutionReceipt["language"];
  environment?: "react";
  steps?: BrowserStep[];
  preview?: ExecutionPreview;
  code: string;
  artifactSequences: number[];
  status: "pending" | "finished" | "interrupted" | "error";
  receipt?: ExecutionReceipt;
  error?: string;
}

/** JSON evidence contains observations, not screenshot bytes or a visual review. */
export function executionEvidence(job: WorkspaceExecution) {
  const { preview, ...captured } = job;
  return {
    ...captured,
    ...(job.environment === "react"
      ? {
          interactionProvenance:
            "Automated actions from issued task checks; not human-authored tests or manual browser interaction.",
        }
      : {}),
    ...(preview
      ? {
          preview: {
            width: preview.width,
            height: preview.height,
            sha256: preview.sha256,
            observation:
              "Saved image available in game; image pixels are not included in this evidence packet.",
          },
        }
      : {}),
  };
}

export function canRunWorkspace(g: StudyRecord, e: Encounter, r: Roadmap) {
  if (
    !e.problem?.runtime ||
    e.state === "consumed" ||
    g.study.profile !== "live"
  )
    return false;
  const issued = e.problem.contract;
  if (issued.practice) return issued.depth >= 2;
  const c = eligible(r, g.study);
  return (
    issued.depth >= 2 &&
    issued.depth === c.depth &&
    issued.track === c.track &&
    JSON.stringify(issued.objectiveIds) === JSON.stringify(c.objectiveIds)
  );
}

export async function runWorkspace(g: StudyRecord, e: Encounter, r: Roadmap) {
  const author = "human";
  if (!canRunWorkspace(g, e, r))
    throw Error("This task has no eligible executable workspace");
  if (e.executions?.some((a) => a.status === "pending")) return;
  const runtime = e.problem!.runtime!;
  if (
    runtime.environment !== undefined &&
    (runtime.environment !== "react" || runtime.language !== "typescript")
  )
    throw Error("Unsupported executable workspace environment");
  const job: WorkspaceExecution = {
    author,
    id: crypto.randomUUID(),
    revision: e.revision,
    language: runtime.language,
    ...(runtime.environment === "react"
      ? { environment: "react" as const, steps: browserSteps(runtime.steps) }
      : {}),
    code: e.workspace,
    status: "pending",
    artifactSequences: e.history
      .filter(
        (h) =>
          h.author === author && h.kind === "edit" && h.revision === e.revision,
      )
      .map((h) => h.seq),
  };
  e.executions ??= [];
  e.executions.push(job);
  try {
    const codeHash = await sha256(job.code),
      specHash =
        job.environment === "react"
          ? await sha256(browserSpecText(job.code, job.steps))
          : undefined;
    const response = await fetch("/api/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        language: job.language,
        code: job.code,
        ...(job.environment === "react"
          ? { environment: "react", steps: job.steps }
          : {}),
      }),
      signal: AbortSignal.timeout(job.environment === "react" ? 35000 : 20000),
    });
    const raw = await response.text();
    let packet: ExecutionReceipt & { error?: string; preview?: unknown };
    try {
      packet = JSON.parse(raw);
    } catch {
      throw Error(`Runner unavailable (HTTP ${response.status})`);
    }
    const { preview, ...receipt } = packet;
    if (!response.ok && receipt.status !== "unavailable")
      throw Error(receipt.error ?? "Runner request failed");
    if (
      !receipt ||
      typeof receipt.id !== "string" ||
      receipt.language !== job.language ||
      receipt.environment !== job.environment ||
      (job.environment === "react" &&
        (receipt.specHash !== specHash || receipt.codeHash !== codeHash)) ||
      typeof receipt.executed !== "boolean" ||
      ![
        "completed",
        "timeout",
        "output-limit",
        "resource-limit",
        "unavailable",
      ].includes(receipt.status) ||
      (receipt.executed &&
        (receipt.codeHash !== codeHash ||
          !/^sha256:[a-f0-9]{64}$/.test(receipt.imageId ?? "") ||
          typeof receipt.stdout !== "string" ||
          typeof receipt.stderr !== "string"))
    )
      throw Error("Runner receipt does not match the captured code");
    if (preview !== undefined) {
      if (job.environment !== "react" || !receipt.executed)
        throw Error("Unexpected browser preview");
      job.preview = await validatePreview(preview);
    }
    job.receipt = receipt;
    job.status = "finished";
    if (receipt.executed) {
      e.history.push({
        seq: nextSeq(g),
        author: "runner",
        kind: "execution",
        executionId: job.id,
        text: JSON.stringify(receipt),
        at: g.time,
        wallTime: new Date().toISOString(),
        revision: job.revision,
        refs: job.artifactSequences.map((seq) => `artifact:${seq}`),
      });
    }
  } catch (error) {
    job.status = "error";
    job.error = String(error);
  }
  return job;
}
