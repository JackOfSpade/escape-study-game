import { escapeHtml as escape } from "./html";
import type { Provider, Game, Roadmap } from "./model";
import { download } from "./persistence";
import { adoptReconciledRoadmap } from "./roadmap-adoption";
import type { RoadmapReconciliation } from "./roadmap-adoption-types";
import { presentRoadmapReview } from "./roadmap-exposure";
interface Options {
  provider?: Provider;
  getGame: () => Game;
  r: Roadmap;
  persist: () => Promise<unknown>;
  reconcile?: (
    candidate: string,
    retryId?: string,
    captured?: () => void,
  ) => Promise<void> | undefined;
  candidate?: string;
  onAdopted?: () => void;
}
const views = new WeakMap<HTMLElement, Options>();
function baselineReview(p: RoadmapReconciliation, r: Roadmap) {
  if (
    !Array.isArray(p.attemptUpdates) ||
    !p.attemptUpdates.some((u) => u?.correctionDecision) ||
    !Array.isArray(p.definitions) ||
    !Array.isArray(p.completeScopes)
  )
    return "";
  const scopes = p.definitions.filter(
    (d) =>
      d &&
      typeof d.id === "string" &&
      typeof d.objectiveId === "string" &&
      Number.isInteger(d.depth) &&
      p.completeScopes.includes(d.id) &&
      r.tracks[d.objectiveId.startsWith("PY:") ? "PY" : "PE"].objectives.some(
        (o) => o.id === d.objectiveId && o.cells[d.depth - 1] === "P",
      ),
  );
  return scopes.length
    ? `<p>Original checkpoint review: ${escape(scopes.map((d) => d.id).join(", "))}. Every historical observation is reviewed; unaffected knowledge and gaps remain. A withdrawn score does not count as a new learner failure.</p>`
    : "";
}
export function renderRoadmapAdoption(host: HTMLElement, options: Options) {
  views.set(host, options);
  const { getGame, r, persist, reconcile, candidate, onAdopted } = options,
    g = getGame(),
    jobs = g.study.roadmapReconciliations ?? [];
  const claude = options.provider === "claude-cli",
    label = `${claude ? "Claude CLI" : "Study bridge"} roadmap review`;
  const refresh = () => {
    const current = document.getElementById("roadmap-adoption-controls");
    const view = current && views.get(current);
    if (current && view) renderRoadmapAdoption(current, view);
  };
  host.innerHTML = `<p>Working file: revision ${g.study.roadmapExport?.revision ?? r.revision}. ${g.study.learner?.roadmapAdoptions?.length ?? 0} reviewed import(s). Original curriculum source is preserved.</p><p>${label} proposes a complete working roadmap for your review. Adoption preserves this run's code, transcripts and original curriculum. It starts no study session and records no new demonstration.</p>${claude ? "<p>Requesting review shares your complete local working roadmap and selected incoming file with Claude CLI. Review the proposal before adopting it.</p>" : ""}${candidate && reconcile ? `<button id="reconcile-roadmap" type="button">Request roadmap review</button>` : !reconcile ? "<p>Roadmap reconciliation is unavailable. File comparison remains available; current learning stays active.</p>" : ""}<p id="roadmap-adoption-status" role="status"></p>${[
    ...jobs,
  ]
    .reverse()
    .slice(0, 10)
    .map(
      (j) =>
        `<article><strong>${escape(j.id)} · ${escape(j.state)}</strong><p>${escape(j.error ?? j.proposal?.rationale ?? "Saved source-bound review request. No learning change is applied.")}</p>${
          j.proposal?.attemptUpdates?.length
            ? `<p>${j.proposal.attemptUpdates.length} reviewed attempt update(s). Both previous and updated dispositions are retained in the complete file's audit history; no new gameplay study visit is recorded.</p><p>Invalidating an attempt withdraws judgments supported only by it; it does not create a new failure. Other supported knowledge and gaps remain.</p>${
                j.proposal.attemptUpdates.some((u) => u.correctionDecision)
                  ? `<p>Closed assessment correction. Original task and observations remain in history; withdrawn evidence cannot certify current learning.</p><ul>${j.proposal.attemptUpdates
                      .filter((u) => u.correctionDecision)
                      .map(
                        (u) =>
                          `<li>${escape(u.track + ":" + u.attemptId)} · ${escape(u.correctionDecision!.id)}<p>${escape(u.correctionDecision!.excerpt)}</p></li>`,
                      )
                      .join("")}</ul>`
                  : ""
              }${baselineReview(j.proposal, r)}${j.proposal.attemptUpdates.some((u) => u.resolveCurrent) ? "<p>An explicitly resolved current attempt keeps its original puzzle and draft for gameplay, without another academic assessment or visit.</p>" : ""}`
            : ""
        }${j.proposal?.retentionUpdates?.length ? `<p>Reviewed retention correction for ${escape(j.proposal.retentionUpdates.map((u) => u.scopeId).join(", "))}. Dates and verification counts are recomputed from the remaining valid recorded reviews. Original review transactions remain in the complete file audit; this creates no new study visit or observation.</p>` : ""}${j.proposal?.branchConflicts?.length ? `<details><summary>${j.proposal.branchConflicts.length} unresolved source-qualified branch conflict(s)</summary><p>Both histories are preserved under their original IDs. Incoming conflicting records and dependent observations are retained in the complete file's portable audit and excluded from imported learning and practical proof. No IDs are renumbered.</p><p>${escape(j.proposal.branchRationale ?? "")}</p><pre>${escape(j.proposal.branchConflicts.map((c) => `${c.track}:${c.id}`).join("\n"))}</pre></details>` : ""}<p>Local ${escape(j.payload.localHash)} · incoming ${escape(j.payload.candidateHash)}</p>${
          j.review
            ? `<details data-review-diff="${escape(j.id)}"><summary>Proposed progress differences</summary><p>Complete proposed SHA-256: ${escape(j.review.candidateHash)}</p>${j.review.changes
                .filter((c) => c.local !== c.incoming)
                .map(
                  (c) =>
                    `<p><strong>${escape(c.key)}</strong></p><pre>${escape(`Local: ${c.local ?? "(absent)"}\nProposed: ${c.incoming ?? "(absent)"}`)}</pre>`,
                )
                .join("")}</details>`
            : ""
        }${j.state === "ready" ? `<p>Review the complete proposed file and differences before adopting. Current local work is checked again at adoption.</p><button data-adopt-roadmap="${escape(j.id)}">Adopt reviewed roadmap</button>` : ""}${j.proposal ? `<button data-download-roadmap="${escape(j.id)}" class="quiet">Download proposed roadmap</button>` : ""}${["error", "interrupted"].includes(j.state) && reconcile ? `<button data-retry-roadmap="${escape(j.id)}" class="quiet">Retry saved reconciliation</button>` : ""}</article>`,
    )
    .join("")}`;
  if (host.isConnected && !document.getElementById("inspector")?.hidden) {
    for (const j of jobs)
      if (j.proposal)
        presentRoadmapReview(
          g,
          `${j.id}/${j.proposalHash}/summary`,
          j.proposal.rationale,
        );
  }
  for (const detail of host.querySelectorAll<HTMLDetailsElement>(
    "details[data-review-diff]",
  ))
    detail.ontoggle = () => {
      if (detail.open) {
        const id = detail.dataset.reviewDiff,
          j = jobs.find((job) => job.id === id);
        if (j?.review)
          presentRoadmapReview(
            getGame(),
            `${j.id}/${j.proposalHash}/diff`,
            j.review.changes
              .filter((c) => c.local !== c.incoming)
              .map(
                (c) =>
                  `${c.key}\n${c.local ?? "(absent)"}\n${c.incoming ?? "(absent)"}`,
              )
              .join("\n"),
          );
      }
    };
  const status = (text: string) => {
    const current =
      document.getElementById("roadmap-adoption-controls") ?? host;
    const output = current.querySelector<HTMLElement>(
      "#roadmap-adoption-status",
    );
    if (output) output.textContent = text;
  };
  const review = async (text: string, id?: string) => {
    try {
      status("Reviewing the captured files. Survival continues.");
      const pending = reconcile?.(text, id, refresh);
      refresh();
      await pending;
      refresh();
      await persist();
      const job = getGame()
        .study.roadmapReconciliations?.filter((j) =>
          id ? j.id === id : j.payload.candidate === text,
        )
        .at(-1);
      status(
        job?.state === "ready"
          ? `${job.payload.provider === "claude-cli" ? "Claude CLI" : "Study bridge"} roadmap review ready. Inspect its complete proposal; nothing is adopted automatically.`
          : job?.error
            ? `Review needs attention; captured files retained. ${job.error}`
            : "No additional review was needed.",
      );
    } catch (error) {
      refresh();
      status(
        `Reconciliation unavailable; files and current progress retained. ${String(error)}`,
      );
    }
  };
  host
    .querySelector<HTMLButtonElement>("#reconcile-roadmap")
    ?.addEventListener("click", () => void review(candidate!));
  for (const b of host.querySelectorAll<HTMLButtonElement>(
    "[data-retry-roadmap]",
  ))
    b.onclick = () => {
      const j = jobs.find((j) => j.id === b.dataset.retryRoadmap)!;
      void review(j.payload.candidate, j.id);
    };
  for (const b of host.querySelectorAll<HTMLButtonElement>(
    "[data-download-roadmap]",
  ))
    b.onclick = () => {
      const j = jobs.find((j) => j.id === b.dataset.downloadRoadmap);
      if (j?.proposal)
        download(
          "interview_prep_roadmap.md",
          j.proposal.canonical,
          "text/markdown",
        );
    };
  for (const b of host.querySelectorAll<HTMLButtonElement>(
    "[data-adopt-roadmap]",
  ))
    b.onclick = async () => {
      b.disabled = true;
      try {
        const adopted = await adoptReconciledRoadmap(
          getGame(),
          r,
          b.dataset.adoptRoadmap!,
        );
        download(
          "interview_prep_roadmap.md",
          adopted.cache.content,
          "text/markdown",
        );
        refresh();
        try {
          await persist();
          onAdopted?.();
          status(
            "Reviewed working roadmap adopted and saved. No new study visit or observation was created.",
          );
        } catch (error) {
          status(
            `Roadmap adopted in this run, but local save failed. Export a full evidence/run backup before leaving. ${String(error)}`,
          );
        }
      } catch (error) {
        refresh();
        status(`Adoption not applied; current work retained. ${String(error)}`);
      }
    };
}
