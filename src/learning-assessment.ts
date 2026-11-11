import { PROVIDERS } from "./model";
import { bridgeRequest, status } from "./bridge-client";
import { evidencePacket, syncLearningView } from "./curriculum";
import { applyLearningAssessment, encounterKey } from "./learner";
import type { Assessment, Encounter, Game, Roadmap } from "./model";
import { assessmentDeferred, assessmentSegment } from "./question-thread";

const connected = (g: Game) =>
  g.study.profile === "live" && status().mode !== "development";
const latestHumanSequence = (e: Encounter) =>
  e.history.reduce(
    (latest, h) =>
      h.author === "human" &&
      ["edit", "reasoning", "test", "defense", "execution"].includes(h.kind)
        ? Math.max(latest, h.seq)
        : latest,
    0,
  );

/** An assessment reviews one immutable cutoff, even across reloads and retries. */
export async function assess(
  g: Game,
  e: Encounter,
  r: Roadmap,
  cutoff = e.submissions.find((s) => s.id === e.accepted)?.seq ??
    latestHumanSequence(e),
  retry = false,
) {
  const acceptedCutoff = cutoff;
  cutoff = e.history.reduce(
    (latest, h) => (h.seq <= cutoff ? Math.max(latest, h.seq) : latest),
    0,
  );
  if (e.problem?.contract.practice) return;
  // A segmented question is assessed once it is finished, visit by visit.
  if (assessmentDeferred(g, e)) return;
  const study = g.study,
    id = `assessment-${encounterKey(e)}-${cutoff}`,
    prior = study.assessments.find((a) => a.id === id);
  if (
    prior &&
    (prior.status === "applied" || !retry || prior.status === "pending")
  )
    return;
  const a: Assessment = prior ?? {
    id,
    encounter: e.id,
    sourceVersion:
      study.profile === "live" ? (study.learner?.version ?? 0) : study.version,
    evidenceCutoffSequence: cutoff,
    findings: [],
    status: "pending",
    provenance: status().mode,
  };
  if (!prior) study.assessments.push(a);
  else a.status = "pending";
  const external = study.learner?.attempts.find(
    (v) =>
      v.encounter === encounterKey(e) && v.status === "externally-resolved",
  );
  if (
    external &&
    !e.history.some(
      (h) =>
        h.author === "human" &&
        ["edit", "reasoning", "test", "execution"].includes(h.kind) &&
        !external.externalResolution!.assessedHumanSequences.includes(h.seq) &&
        h.seq <= cutoff,
    ) &&
    !e.executions?.some(
      (j) =>
        j.author === "human" && j.status === "finished" && j.receipt?.executed,
    )
  ) {
    a.status = "review-required";
    a.provenance =
      "Attempt resolved in the imported roadmap. Local work is retained; world completion adds no duplicate academic assessment or visit.";
    return;
  }
  if (!e.problem) {
    a.status = "review-required";
    a.provenance =
      "Physical contribution retained; no persisted human learning task was issued. No academic credit.";
    return;
  }
  if (!PROVIDERS.includes(e.problem.provenance) || study.profile !== "live") {
    a.status = "review-required";
    a.provenance = "Development simulation cannot award academic credit.";
    return;
  }
  try {
    const learner = study.learner;
    if (!learner)
      throw Error("Live learner ledger is missing; refusing to reset progress");
    a.request ??= {
      provider: ((mode) =>
        mode === "chatgpt-handoff" || mode === "claude-cli"
          ? mode
          : "study-mode")(connected(g) ? status().mode : e.problem.provenance),
      payloadJson: JSON.stringify({
        requestId: id,
        packet: ((segment) => ({
          ...evidencePacket(e, r, cutoff, learner, acceptedCutoff),
          ...(segment ? { segment } : {}),
        }))(assessmentSegment(g, e)),
      }),
    };
    const saved = a.request,
      payload = JSON.parse(saved.payloadJson);
    // Capture the original evidence even when no provider is reachable. A
    // later retry must not replace a partial answer with work done afterward.
    if (!connected(g)) {
      a.status = "review-required";
      a.provenance =
        "Live assessment connection unavailable; work and request identity retained for retry.";
      return;
    }
    const checkSnapshot = () => {
      if (
        g.study !== study ||
        study.learner !== learner ||
        !study.assessments.includes(a) ||
        !connected(g) ||
        status().mode !== saved.provider ||
        (g.encounters[e.id] !== e && !study.archives.includes(e))
      )
        throw Error(
          "Assessment provider or learning state changed during review",
        );
      if (
        payload.requestId !== id ||
        payload.packet?.encounter !== e.id ||
        payload.packet?.evidenceCutoffSequence !== cutoff ||
        payload.packet?.sourceHash !== r.sourceHash ||
        JSON.stringify(payload.packet?.problem) !== JSON.stringify(e.problem)
      )
        throw Error(
          "Saved assessment no longer matches its captured task and cutoff",
        );
    };
    checkSnapshot();
    const response = await bridgeRequest<
      Pick<
        Assessment,
        | "findings"
        | "historicalMappings"
        | "visitOutcome"
        | "scopeReviews"
        | "helpAttributions"
      >
    >("assess", payload);
    checkSnapshot();
    a.findings = response.findings;
    a.historicalMappings = response.historicalMappings;
    a.visitOutcome = response.visitOutcome;
    a.scopeReviews = response.scopeReviews;
    a.helpAttributions = response.helpAttributions;
    a.provenance = saved.provider;
    applyLearningAssessment(r, learner, e, a, undefined, saved.provider);
    syncLearningView(study);
    // The applied receipt and existing encounter keep the evidence; release
    // duplicate curriculum/context copies once this request cannot be retried.
    delete a.request;
  } catch (err) {
    a.status = "review-required";
    a.provenance = `Assessment unresolved: ${String(err)}`;
  }
}
