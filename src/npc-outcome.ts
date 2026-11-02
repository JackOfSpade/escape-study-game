import { providerLabel } from "./provider-label";
import { eligible } from "./curriculum";
import {
  type Provider,
  type Contract,
  type Encounter,
  type Game,
  type Problem,
  type Roadmap,
  event,
} from "./model";
import type { NpcWork } from "./npc-cognition";
import { npcProfile } from "./npc-cognition";
import { sha256 } from "./digest";

export interface SimulatedOutcome {
  id: string;
  runId: string;
  revision: number;
  workspace: string;
  at: number;
  cutoff: number;
  contributors: string[];
  problem?: Problem;
  work: NpcWork[];
}
export interface OutcomeCandidate {
  requestId: string;
  problem: Problem;
  solution: string;
  authors: string[];
  refs: number[];
  execution: "not-run";
}
export interface OutcomePayload {
  provider?: Provider;
  requestId: string;
  runId: string;
  encounterId: string;
  sourceHash: string;
  commitment: SimulatedOutcome;
  contract: Contract;
  curriculum: string;
  speakers: {
    id: string;
    name: string;
    profile: ReturnType<typeof npcProfile>;
  }[];
  instruction: string;
}
export interface OutcomeInspection {
  id: string;
  state: "pending" | "failed" | "interrupted" | "applied";
  payload: OutcomePayload;
  hash: string;
  candidate?: OutcomeCandidate;
  candidateHash?: string;
  validatedContent?: string;
  validation?: {
    requestId: string;
    complete: true;
    feedback: string;
    execution: "not-run";
  };
  error?: string;
  presented?: number;
}
interface Adapter {
  provider?: Provider;
  request(
    operation: "materialize-outcome" | "complete",
    payload: unknown,
  ): Promise<unknown>;
  validate(problem: Problem, contract: Contract): void;
}
const running = new WeakMap<Encounter, Promise<void>>();
const snapshot = (value: unknown) => JSON.stringify(value);
function guard(g: Game, e: Encounter, r: Roadmap, job: OutcomeInspection) {
  if (
    g.encounters[e.id] !== e ||
    e.state !== "consumed" ||
    e.accepted !== job.payload.commitment.id ||
    g.id !== job.payload.runId ||
    job.payload.commitment.runId !== g.id ||
    e.runId !== g.id ||
    r.sourceHash !== job.payload.sourceHash ||
    snapshot(e.simulatedOutcome) !== snapshot(job.payload.commitment) ||
    snapshot(e.problem) !== snapshot(job.payload.commitment.problem) ||
    e.workspace !== job.payload.commitment.workspace ||
    e.revision !== job.payload.commitment.revision
  )
    throw Error(
      "Committed NPC outcome changed; retain the original outcome and defer exact artifacts",
    );
  if (
    g.study.profile !== "live" ||
    !g.study.learner ||
    job.payload.contract.depth >
      g.study.learner.tracks[job.payload.contract.track].tier
  )
    throw Error(
      "Retrospective solution is outside the current learning ceiling; defer inspection",
    );
}
/** Explicit on-demand reconstruction of a committed simulation, never an unseen chat loop. */
export function inspectNpcOutcome(
  g: Game,
  e: Encounter,
  r: Roadmap,
  adapter: Adapter,
  retry = false,
): Promise<void> | undefined {
  const provider = adapter.provider ?? "study-mode";
  if (
    e.outcomeInspection &&
    (e.outcomeInspection.payload.provider ?? "study-mode") !== provider
  ) {
    e.outcomeNotice =
      "Reconnect the original solution-inspection provider; its exact captured outcome remains saved.";
    return;
  }
  const active = running.get(e);
  if (active) return active;
  if (e.outcomeInspection?.state === "applied") return;
  if (e.outcomeInspection && !retry) return;
  if (
    !e.simulatedOutcome ||
    e.state !== "consumed" ||
    g.study.profile !== "live"
  )
    return;
  if (!e.outcomeInspection) {
    const commitment = structuredClone(e.simulatedOutcome),
      contract = structuredClone(
        commitment.problem?.contract ?? eligible(r, g.study),
      );
    const speakers = commitment.contributors
      .filter((id) => id !== "human")
      .map((id) => g.survivors.find((a) => a.id === id))
      .filter((a) => !!a)
      .map((a) => ({ id: a.id, name: a.name, profile: npcProfile(a) }));
    if (!speakers.length || !commitment.work.length) {
      e.outcomeNotice =
        "Exact survivor solution deferred: saved contributor milestones are unavailable. The simulated world result is preserved.";
      return;
    }
    const id = `outcome-${g.id}-${e.id}-${commitment.cutoff}`;
    const payload: OutcomePayload = structuredClone({
      provider,
      requestId: id,
      runId: g.id,
      encounterId: e.id,
      sourceHash: r.sourceHash,
      commitment,
      contract,
      curriculum: r.tracks[contract.track].curriculum,
      speakers,
      instruction:
        "Materialize a concrete solution compatible with this committed simulated NPC-only success and saved semantic milestones. This reconstruction is authored now, not historical edits, conversation or execution. Return {requestId,problem,solution,authors,refs,execution:'not-run'}. Reuse the exact committed problem if present; otherwise author a question within the supplied exact contract and curriculum, with provenance equal to the captured provider (legacy missing provider means study-mode). Reference actual saved work sequences and contributing NPC authors. Do not invent historical human work, tests-passed or execution claims. Respect D1 reasoning versus later implementation depth. No dialogue. A separate completion reviewer must validate this candidate before it can be shown; mismatch defers presentation without changing the world outcome.",
    });
    if (snapshot(payload).length > 1_000_000) {
      e.outcomeNotice =
        "Saved outcome exceeds the inspection context limit. Its world result remains retained.";
      return;
    }
    e.outcomeInspection = { id, state: "pending", payload, hash: "" };
  }
  const job = e.outcomeInspection;
  const payloadText = snapshot(job.payload);
  const promise = (async () => {
    try {
      if (!job.hash) job.hash = await sha256(payloadText);
      else if ((await sha256(payloadText)) !== job.hash)
        throw Error("Saved NPC outcome request changed");
      if (snapshot(job.payload) !== payloadText)
        throw Error("Saved NPC outcome request changed");
      guard(g, e, r, job);
      job.state = "pending";
      delete job.error;
      if (!job.candidate) {
        const response = (await adapter.request(
          "materialize-outcome",
          job.payload,
        )) as OutcomeCandidate;
        guard(g, e, r, job);
        if ((await sha256(snapshot(job.payload))) !== job.hash)
          throw Error("Saved NPC outcome request changed");
        if (
          !response ||
          response.requestId !== job.id ||
          typeof response.solution !== "string" ||
          !response.solution.trim() ||
          response.solution.length > 64000 ||
          response.execution !== "not-run" ||
          !Array.isArray(response.authors) ||
          !response.authors.length ||
          new Set(response.authors).size !== response.authors.length ||
          response.authors.some(
            (id) => !job.payload.speakers.some((a) => a.id === id),
          ) ||
          !Array.isArray(response.refs) ||
          !response.refs.length ||
          new Set(response.refs).size !== response.refs.length ||
          response.refs.some(
            (seq) =>
              !job.payload.commitment.work.some(
                (w) => w.seq === seq && response.authors.includes(w.actor),
              ),
          )
        )
          throw Error("Malformed or ungrounded NPC outcome reconstruction");
        if (
          job.payload.commitment.problem &&
          snapshot(response.problem) !==
            snapshot(job.payload.commitment.problem)
        )
          throw Error("Reconstruction changed the committed question");
        if (
          !job.payload.commitment.problem &&
          response.problem?.provenance !==
            (job.payload.provider ?? "study-mode")
        )
          throw Error(
            "Reconstructed question provenance does not match its authoring provider",
          );
        adapter.validate(response.problem, job.payload.contract);
        job.candidate = structuredClone(response);
        job.candidateHash = await sha256(snapshot(job.candidate));
      }
      if ((await sha256(snapshot(job.candidate))) !== job.candidateHash)
        throw Error("Saved reconstructed candidate changed");
      const candidateText = snapshot(job.candidate);
      const validation = (await adapter.request("complete", {
        requestId: `${job.id}/validate`,
        mode: "retrospective-npc-outcome",
        ...(job.payload.provider ? { provider: job.payload.provider } : {}),
        candidateHash: job.candidateHash,
        commitment: job.payload.commitment,
        problem: job.candidate.problem,
        solution: job.candidate.solution,
        authors: job.candidate.authors,
        refs: job.candidate.refs,
        instruction:
          "Review this exact reconstructed solution against the exact question and committed simulated success. Return {requestId,complete,feedback,execution:'not-run'}. complete:true only if this concrete solution satisfies the full task at the supplied depth. Never infer correctness from the committed world success. This is semantic validation now, not past execution. No rewards, player qualification or human mastery are requested.",
      })) as OutcomeInspection["validation"];
      guard(g, e, r, job);
      if ((await sha256(snapshot(job.payload))) !== job.hash)
        throw Error("Saved NPC outcome request changed");
      if ((await sha256(snapshot(job.candidate))) !== job.candidateHash)
        throw Error("Reconstructed candidate changed during validation");
      if (
        !validation ||
        validation.requestId !== `${job.id}/validate` ||
        validation.complete !== true ||
        validation.execution !== "not-run" ||
        typeof validation.feedback !== "string" ||
        !validation.feedback.trim() ||
        validation.feedback.length > 8000
      )
        throw Error(
          "Reconstructed solution does not have a compatible validation; exact artifacts deferred",
        );
      guard(g, e, r, job);
      if (
        snapshot(job.payload) !== payloadText ||
        snapshot(job.candidate) !== candidateText
      )
        throw Error("Saved NPC outcome context changed before publication");
      job.validation = structuredClone(validation);
      job.validatedContent = candidateText;
      job.state = "applied";
      delete e.outcomeNotice;
    } catch (err) {
      job.state = "failed";
      job.error = String(err);
      e.outcomeNotice = `Exact survivor solution deferred: ${String(err)}`;
    }
  })();
  running.set(e, promise);
  void promise.finally(() => {
    if (running.get(e) === promise) running.delete(e);
  });
  return promise;
}
/** Exposure occurs now; the reconstruction is never a retroactive NPC edit or human proof. */
export function outcomeIsVisible(g: Game, e: Encounter, r: Roadmap) {
  const job = e.outcomeInspection;
  if (job?.state !== "applied" || !job.candidate || !job.validation)
    return false;
  if (
    snapshot(job.candidate) !== job.validatedContent ||
    job.validation.requestId !== `${job.id}/validate` ||
    job.validation.complete !== true ||
    job.validation.execution !== "not-run"
  )
    return false;
  try {
    guard(g, e, r, job);
    return true;
  } catch {
    return false;
  }
}
export function presentNpcOutcome(g: Game, e: Encounter, r: Roadmap) {
  const job = e.outcomeInspection;
  if (
    !outcomeIsVisible(g, e, r) ||
    !job ||
    !job.candidate ||
    job.presented !== undefined
  )
    return;
  const ev = event(
    g,
    "npc-outcome-presented",
    "Validated reconstruction of simulated NPC-only work became visible.",
    e.floor,
    job.candidate.authors[0],
    e.id,
  );
  job.presented = ev.seq;
  e.history.push({
    seq: ev.seq,
    author: job.candidate.authors[0],
    kind: "workspace-view",
    text: `Reconstructed now through ${providerLabel(job.payload.provider)} from simulated NPC-only work; no historical execution.\n${job.candidate.problem.prompt}\n${job.candidate.solution}`,
    at: g.time,
    revision: e.revision,
    presented: ev.seq,
    refs: job.candidate.refs.map(String),
  });
}
