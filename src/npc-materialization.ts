import { providerLabel } from "./provider-label";
import { PROVIDERS } from "./model";
import { canReachStation, human } from "./engine";
import {
  groupSnapshot,
  validateGroupReply,
  type GroupSnapshot,
} from "./group-grounding";
import { type Provider, event, type Encounter, type Game } from "./model";
import {
  hasHumanStudyContext,
  npcProfile,
  type NpcWork,
} from "./npc-cognition";
import { npcAtWorkstation } from "./npc-work-access";
import { sha256 } from "./digest";
import { proposalText } from "./workspace-proposals";
export interface WorkPayload {
  provider?: Provider;
  background?: boolean;
  autonomyAllowed?: boolean;
  runId: string;
  encounterId: string;
  requestId: string;
  sourceRevision: number;
  cutoff: number;
  problem: NonNullable<Encounter["problem"]>;
  workspace: string;
  snapshot: GroupSnapshot;
  work: NpcWork[];
  speakers: {
    id: string;
    name: string;
    profile: ReturnType<typeof npcProfile>;
  }[];
  instruction: string;
}
export interface Materialization {
  provider?: Provider;
  autonomyAllowed?: boolean;
  id: string;
  workIds: string[];
  state: "pending" | "failed" | "interrupted" | "applied" | "superseded";
  payload?: WorkPayload;
  hash: string;
  artifactSequences: number[];
  error?: string;
}
const running = new WeakMap<Encounter, Promise<void>>();
export function observedSharedWork(g: Game, e: Encounter) {
  const a = human(g),
    station = g.floors[a.floor].stations.find(
      (s) => s.id === a.station && s.encounter === e.id,
    );
  return (
    g.encounters[e.id] === e &&
    g.status === "playing" &&
    a.floor === e.floor &&
    !!station &&
    canReachStation(g, a, station) &&
    e.mode === "shared" &&
    !!e.problem &&
    e.state !== "consumed"
  );
}
const allowed = (g: Game, e: Encounter, background = false) =>
  observedSharedWork(g, e) ||
  (background &&
    hasHumanStudyContext(e) &&
    PROVIDERS.includes(e.problem?.provenance ?? "") &&
    g.survivors.some((a) => npcAtWorkstation(g, e, a.id)));
/** One coordinated request for fresh recorded work, never a periodic chat loop.
 * Failed/interrupted calls require explicit retry of the same saved payload. */
export function materializeNpcWork(
  g: Game,
  e: Encounter,
  request: (payload: WorkPayload) => Promise<unknown>,
  retry = false,
  options: {
    background?: boolean;
    allowAutonomous?: boolean;
    provider?: Provider;
  } = {},
): Promise<void> | undefined {
  const provider = options.provider ?? "study-mode";
  const existing = e.materializations?.find((j) =>
    ["pending", "failed", "interrupted"].includes(j.state),
  );
  if (
    existing &&
    (existing.provider ?? existing.payload?.provider ?? "study-mode") !==
      provider
  ) {
    e.materializationNotice =
      "Reconnect the original team-work provider; its exact public packet remains saved.";
    return;
  }
  const active = running.get(e);
  if (active) return active;
  if (!allowed(g, e, options.background)) return;
  const jobs = (e.materializations ??= []);
  let job: Materialization | undefined = existing;
  if (job && !retry) return;
  const fresh = !job;
  if (!job) {
    const covered = new Set(jobs.flatMap((j) => j.workIds)),
      authors = new Set<string>();
    const work = (e.npcWork ?? [])
      .filter(
        (w) =>
          !covered.has(w.id) &&
          w.scopeIds.length &&
          w.sourceRevision === e.revision &&
          e.history.some(
            (h) =>
              h.seq === w.seq &&
              h.author === w.actor &&
              h.kind === "npc-thought",
          ) &&
          npcAtWorkstation(g, e, w.actor),
      )
      .reverse()
      .filter((w) => {
        if (authors.has(w.actor) || authors.size >= 2) return false;
        authors.add(w.actor);
        return true;
      })
      .reverse();
    if (!work.length) return;
    if (e.workspace.length > 64000) {
      e.materializationNotice =
        "Team notes deferred: workspace exceeds the materialization context limit. Recorded work remains saved.";
      return;
    }
    const id = `work-${g.id}-${e.id}-${work.map((w) => w.seq).join("-")}`,
      snapshot = groupSnapshot(e, id, g.seq);
    for (const w of work)
      if (!snapshot.events.some((h) => h.seq === w.seq))
        snapshot.events.push(
          structuredClone(e.history.find((h) => h.seq === w.seq)!),
        );
    snapshot.events.sort((a, b) => a.seq - b.seq);
    snapshot.events = snapshot.events.map(({ delta: _delta, ...h }) => ({
      ...h,
      text: h.text.slice(0, 8000),
    }));
    const payload: WorkPayload = structuredClone({
      provider,
      ...(options.background ? { background: true } : {}),
      ...(options.allowAutonomous ? { autonomyAllowed: true } : {}),
      runId: g.id,
      encounterId: e.id,
      requestId: id,
      sourceRevision: e.revision,
      cutoff: g.seq,
      problem: e.problem!,
      workspace: e.workspace,
      snapshot,
      work,
      speakers: [...authors].map((id) => {
        const a = g.survivors.find((a) => a.id === id)!;
        return { id, name: a.name, profile: npcProfile(a) };
      }),
      instruction:
        "Materialize the recorded conceptual work now as concrete, tentative reasoning, a test plan or an optional single-range candidate patch. Return {requestId,sourceRevision,notes:[{workId,author,text,refs,patch?}]}; one note per recorded work, referencing its milestone sequence. No dialogue, invented past edits, execution, tests-passed or validated correctness. Respect the exact question/depth and actual public workspace; private tutoring is absent. Patches are tentative proposals, never applied by this request.",
    });
    if (options.allowAutonomous)
      payload.instruction +=
        " You may mark readyToSubmit:true on a concrete patch you intend to enact and submit while the human is away. It remains unvalidated until the separate completion check. No execution claims without receipts.";
    if (JSON.stringify(payload).length > 1_000_000) {
      e.materializationNotice =
        "Team notes deferred: public context exceeds the materialization limit. Recorded work remains saved.";
      return;
    }
    job = {
      id,
      provider,
      workIds: (e.npcWork ?? [])
        .filter(
          (w) =>
            w.sourceRevision === e.revision &&
            work.some(
              (chosen) => chosen.actor === w.actor && w.seq <= chosen.seq,
            ),
        )
        .map((w) => w.id),
      state: "pending",
      payload,
      hash: "",
      artifactSequences: [],
      ...(options.allowAutonomous ? { autonomyAllowed: true } : {}),
    };
    jobs.push(job);
  }
  const batch = job!;
  const promise = (async () => {
    try {
      const payload = batch.payload;
      if (payload && fresh) batch.hash = await sha256(JSON.stringify(payload));
      if (!payload || (await sha256(JSON.stringify(payload))) !== batch.hash)
        throw Error("Saved team-work context is missing or changed");
      if (
        (payload.provider ?? "study-mode") !== provider ||
        (batch.provider ?? "study-mode") !== provider
      )
        throw Error("Team-work provider does not match its captured packet");
      if (payload.runId !== g.id || payload.encounterId !== e.id)
        throw Error("Team-work context belongs to another run or terminal");
      if (
        e.revision !== payload.sourceRevision ||
        e.workspace !== payload.workspace ||
        JSON.stringify(e.problem) !== JSON.stringify(payload.problem)
      ) {
        batch.state = "superseded";
        delete batch.payload;
        e.materializationNotice =
          "Team notes skipped because the workspace changed. Recorded milestones remain saved.";
        return;
      }
      if (!payload.work.every((w) => npcAtWorkstation(g, e, w.actor)))
        throw Error(
          "Recorded contributor must return to a terminal before this materialization can continue",
        );
      batch.state = "pending";
      delete batch.error;
      e.materializationNotice =
        "Materializing recorded team work… Survival continues.";
      const result = (await request(structuredClone(payload))) as {
        requestId?: string;
        sourceRevision?: number;
        notes?: {
          workId: string;
          author: string;
          text: string;
          refs: number[];
          patch?: import("./workspace-proposals").WorkspacePatch;
          readyToSubmit?: boolean;
        }[];
      };
      if (
        !allowed(g, e, payload.background) ||
        e.revision !== payload.sourceRevision ||
        e.workspace !== payload.workspace ||
        JSON.stringify(e.problem) !== JSON.stringify(payload.problem) ||
        !payload.work.every((w) => npcAtWorkstation(g, e, w.actor))
      ) {
        batch.state = "superseded";
        delete batch.payload;
        e.materializationNotice =
          "Team-work response superseded by a changed workspace, terminal or participant. Original work is saved.";
        return;
      }
      if (
        !result ||
        !Array.isArray(result.notes) ||
        result.notes.length > payload.work.length ||
        new Set(result.notes.map((n) => n.workId)).size !== result.notes.length
      )
        throw Error("Invalid team-work result");
      for (const n of result.notes) {
        if (
          n.readyToSubmit !== undefined &&
          (typeof n.readyToSubmit !== "boolean" ||
            (n.readyToSubmit && (!payload.autonomyAllowed || !n.patch)))
        )
          throw Error("Unsupported autonomous readiness claim");
        const w = payload.work.find((w) => w.id === n.workId);
        if (
          !w ||
          w.actor !== n.author ||
          !Array.isArray(n.refs) ||
          !n.refs.includes(w.seq)
        )
          throw Error("Team-work result has unsupported milestone attribution");
      }
      const notes = validateGroupReply(
        {
          requestId: result.requestId,
          sourceRevision: result.sourceRevision,
          messages: result.notes.map((n) => ({ ...n, kind: "proposal" })),
        },
        payload.snapshot,
        payload.speakers.map((s) => s.id),
        payload.workspace,
      );
      for (const [i, n] of notes.entries()) {
        const w = payload.work.find((w) => w.id === result.notes![i].workId)!,
          text = `Materialized now through ${providerLabel(provider)} from ${w.stage} work at ${w.at.toFixed(2)}s; unvalidated and not executed.\n${n.patch ? proposalText(n.text, n.patch) : n.text}`;
        const ev = event(
          g,
          "npc-proposal",
          `${n.author} materialized a tentative work artifact.`,
          e.floor,
          n.author,
          e.id,
        );
        e.history.push({
          seq: ev.seq,
          author: n.author,
          kind: "npc-proposal",
          text,
          at: g.time,
          revision: e.revision,
          refs: n.refs.map(String),
          ...(n.patch ? { delta: structuredClone(n.patch) } : {}),
        });
        batch.artifactSequences.push(ev.seq);
        if (n.patch)
          (e.proposals ??= []).push({
            id: `${batch.id}/${w.id}`,
            provider,
            author: n.author,
            sourceRevision: e.revision,
            sourceSequence: payload.cutoff,
            artifactSequence: ev.seq,
            patch: structuredClone(n.patch),
            state: "pending",
            ...(payload.autonomyAllowed && result.notes![i].readyToSubmit
              ? {
                  autonomous: true,
                  sourceProblem: JSON.stringify(payload.problem),
                }
              : {}),
          });
      }
      batch.state = "applied";
      delete batch.payload;
      e.materializationNotice = notes.length
        ? payload.autonomyAllowed
          ? "Recorded team notes are available. Explicitly prepared NPC candidates may be enacted and submitted by their seated author while the human is away; other candidates require review."
          : "Recorded team notes are available. Candidate edits require review before they change the workspace."
        : "No concrete artifact was supported by this recorded work.";
    } catch (error) {
      batch.state = "failed";
      batch.error = String(error);
      e.materializationNotice = `Team notes unavailable; original work remains saved. ${String(error)}`;
    }
  })();
  running.set(e, promise);
  void promise.finally(() => running.delete(e));
  return promise;
}
