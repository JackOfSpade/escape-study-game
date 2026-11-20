/**
 * The learning-continuity inspector: readiness, recorded knowledge, topic
 * switches, environment observations, roadmap review and adoption, saved
 * assessments and the exports of the learner's record.
 */
import {
  assess,
  reconcileUploadedRoadmap,
  reviewEnvironmentObservation,
  status,
} from "./ai";
import { eligible } from "./curriculum";
import { $, setNodeText, setText } from "./dom";
import { renderEnvironmentObservations } from "./environment-ui";
import { historicalRecords } from "./historical-proof";
import { escapeHtml as escape } from "./html";
import {
  inspectorSummaryHtml,
  knowledgeHtml,
  readinessHtml,
} from "./inspector-view";
import { encounterKey } from "./learner";
import type { StudyRecord, Provider, Roadmap } from "./model";
import { download } from "./persistence";
import { renderRoadmapAdoption } from "./roadmap-adoption-ui";
import { prepareRoadmapExport } from "./roadmap-export";
import { presentRoadmapReview } from "./roadmap-exposure";
import { reviewRoadmap } from "./roadmap-review";

interface InspectorHost {
  /** The current record: an import replaces it. */
  studyRecord(): StudyRecord;
  roadmap: Roadmap;
  /** Saves the record; false when the save failed. */
  persist(): Promise<boolean>;
  /** Saves the record or throws with the reason. */
  persistOrThrow(context?: string): Promise<void>;
  /** The last save failure, or "" when the last save worked. */
  saveError(): string;
  renderCareerControls(): void;
}

/** Returns the function that rebuilds the inspector from the current record. */
export function createInspector(host: InspectorHost) {
  const { roadmap } = host;
  function eligibleNow() {
    try {
      return eligible(roadmap, host.studyRecord().study);
    } catch (err) {
      host.studyRecord().notice = `Curriculum gate: ${String(err)}`;
      return undefined;
    }
  }
  function render() {
    host.renderCareerControls();
    const c = eligibleNow();
    const readiness = (["PY", "PE"] as const)
      .map((track) => readinessHtml(host.studyRecord(), roadmap, track))
      .join("");
    // A full rebuild: the sections below are appended to this fresh summary.
    $("#inspector-content").innerHTML = inspectorSummaryHtml(
      host.studyRecord(),
      roadmap,
      c,
      status().detail,
    );
    $("#inspector-content").insertAdjacentHTML("beforeend", readiness);
    $("#inspector-content").insertAdjacentHTML(
      "beforeend",
      knowledgeHtml(host.studyRecord()),
    );
    renderEnvironmentObservations(
      $("#inspector-content"),
      host.studyRecord(),
      roadmap,
      host.persistOrThrow,
      host.studyRecord().study.profile === "live" &&
        status().capabilities.includes("review-environment")
        ? (id, retry) =>
            reviewEnvironmentObservation(host.studyRecord(), roadmap, id, retry)
        : undefined,
      () => {
        for (const track of ["PY", "PE"] as const) {
          const node = document.querySelector(`[data-readiness="${track}"]`);
          if (node)
            node.outerHTML = readinessHtml(host.studyRecord(), roadmap, track);
        }
      },
    );
    $("#inspector-content").insertAdjacentHTML(
      "beforeend",
      `<details><summary>Review an updated roadmap</summary><p>Compare a merged Markdown file with your saved progress. This preview checks ancestry and row conflicts. Request reconciliation through your connected provider, then review and explicitly adopt its complete proposal. Comparison alone leaves learning unchanged.</p><label class="file-label">Choose roadmap for review <input id="roadmap-review-file" type="file" accept=".md,text/markdown,text/plain"></label><div id="roadmap-review-result" role="status"></div></details>`,
    );
    $("#inspector-content").insertAdjacentHTML(
      "beforeend",
      '<div id="roadmap-adoption-controls"></div>',
    );
    const renderAdoption = (candidate?: string) =>
      renderRoadmapAdoption($("#roadmap-adoption-controls"), {
        getRecord: () => host.studyRecord(),
        r: roadmap,
        candidate,
        provider:
          status().mode === "development"
            ? "study-mode"
            : (status().mode as Provider),
        persist: host.persistOrThrow,
        reconcile:
          host.studyRecord().study.profile === "live" &&
          status().capabilities.includes("reconcile-roadmap")
            ? (text, id, captured) =>
                reconcileUploadedRoadmap(
                  host.studyRecord(),
                  roadmap,
                  text,
                  id,
                  async () => {
                    await host.persistOrThrow(
                      "Local save failed before roadmap reconciliation",
                    );
                    captured?.();
                  },
                )
            : undefined,
        onAdopted: () => {
          // The adopt button is rebuilt away, so focus a stable target.
          render();
          $("#inspector-title").focus();
        },
      });
    renderAdoption();
    $<HTMLInputElement>("#roadmap-review-file").onchange = async () => {
      const input = $<HTMLInputElement>("#roadmap-review-file");
      const file = input.files?.[0];
      if (!file) return;
      const output = $("#roadmap-review-result"),
        requestRecord = host.studyRecord();
      input.disabled = true;
      output.textContent = "Reviewing a snapshot of current saved progress…";
      try {
        if (file.size > 2_000_000)
          throw Error("Roadmap exceeds the 2 MB review limit");
        // Export preparation runs on a copy: review never allocates live IDs,
        // advances the export cache or changes an ongoing study session.
        const study = structuredClone(host.studyRecord().study);
        const local =
          study.profile === "live" && study.learner
            ? (
                await prepareRoadmapExport(
                  roadmap,
                  study.learner,
                  study.roadmapExport,
                )
              ).content
            : roadmap.raw;
        const candidate = await file.text();
        const report = await reviewRoadmap(roadmap, local, candidate);
        if (host.studyRecord() !== requestRecord)
          throw Error(
            "Run changed during review; reopen the inspector to review current progress",
          );
        renderAdoption(
          report.ancestry === "identical" ||
            report.issues.some((i) => i.severity === "invalid")
            ? undefined
            : candidate,
        );
        output.innerHTML = `<p><strong>${report.issues.some((i) => i.severity === "invalid") ? "Invalid roadmap" : "Review required"}</strong> · revision ${report.candidateRevision} · ${escape(report.ancestry)}</p><p>${report.changes.length} changed progress rows · ${report.changes.filter((c) => c.conflict).length} conflicts</p>${report.issues.map((i) => `<p>${escape(i.detail)}</p>`).join("")}<details><summary>Progress differences</summary>${report.changes.map((c) => `<p><strong>${escape(c.key)}${c.conflict ? " · CONFLICT" : ""}</strong></p><pre>${escape(`Source: ${c.before ?? "(absent)"}\nLocal: ${c.local ?? "(absent)"}\nIncoming: ${c.incoming ?? "(absent)"}`)}</pre>`).join("") || "<p>No progress row changes.</p>"}</details>${
          report.resume
            ? `<details><summary>Saved resume claims</summary><p>Ratio position: ${report.resume.ratioPosition === undefined ? "needs reconciliation" : `${report.resume.ratioPosition + 1} of PY → PE → PE`}. ${report.resume.retentionRecords} exact retention records; ${report.resume.suspendedQueues} suspended queues.</p>${(
                ["PY", "PE"] as const
              )
                .map((t) => {
                  const s = report.resume!.tracks[t];
                  return `<p>${t}: Tier ${s.tier} / ${escape(s.phase)} / lap ${s.lap}; cleared through ${s.cleared}. Remaining: ${escape(s.remaining.join(", ") || "none")}.</p>`;
                })
                .join(
                  "",
                )}<p>Parsed claims only. Semantic evidence reconciliation and adoption are still required before changing live study.</p></details>`
            : ""
        }<details><summary>File fingerprints</summary><pre>${escape(`Source: ${report.sourceHash}\nLocal snapshot: ${report.localHash}\nIncoming: ${report.candidateHash}`)}</pre></details><p>Comparison is a snapshot taken when review started. Recheck after further study before reconciling.</p>`;
        const differences = output.querySelector<HTMLDetailsElement>("details");
        if (differences)
          differences.ontoggle = () => {
            if (differences.open)
              presentRoadmapReview(
                host.studyRecord(),
                `${report.localHash}/${report.candidateHash}/upload-diff`,
                report.changes
                  .map(
                    (c) =>
                      `${c.key}\n${c.local ?? "(absent)"}\n${c.incoming ?? "(absent)"}`,
                  )
                  .join("\n"),
              );
          };
      } catch (err) {
        output.textContent = `Review rejected: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        input.disabled = false;
        input.value = "";
      }
    };
    const historical =
      host.studyRecord().study.learner?.historicalReviews ?? [];
    if (historical.length)
      $("#inspector-content").insertAdjacentHTML(
        "beforeend",
        `<details><summary>Historical facet reconciliations (${historical.length})</summary><p>Original observations retain their original IDs and dates. Reconciliation dates record review activity, not new human demonstrations. Earlier reviews remain in this audit.</p>${historical
          .map((m) => {
            const def = host.studyRecord().study.learner!.scopes[m.scopeId];
            const observed = def
              ? historicalRecords(roadmap, def.objectiveId, def.depth)
                  .filter((r) => m.evidenceIds.includes(r.id))
                  .map((r) => `${r.id} observed ${r.date}`)
                  .join("; ")
              : "Source scope unavailable";
            return `<p><strong>${escape(m.scopeId)} · ${escape(m.facet)}</strong> · ${escape(m.outcome)}<br>${escape(observed)}<br><small>Reviewed ${escape(m.reviewedAt)} · ${escape(m.assessmentId)}</small></p>`;
          })
          .join("")}</details>`,
      );
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      "[data-assessment]",
    ))
      button.onclick = () => {
        const a = host
          .studyRecord()
          .study.assessments.find((a) => a.id === button.dataset.assessment);
        if (!a) return;
        const e = [
          ...Object.values(host.studyRecord().encounters),
          ...host.studyRecord().study.archives,
        ].find((e) => a.id.startsWith(`assessment-${encounterKey(e)}-`));
        if (!e || button.disabled) return;
        button.disabled = true;
        const requestRecord = host.studyRecord(),
          pending = assess(
            host.studyRecord(),
            e,
            roadmap,
            a.evidenceCutoffSequence,
            true,
          );
        // Persist the captured request before its response, so closing/reloading
        // during a retry retains the same evidence and provider.
        void host.persist();
        void pending.finally(() => {
          void host.persist();
          button.disabled = false;
          setNodeText(
            button,
            requestRecord.study.assessments.find((item) => item.id === a.id)
              ?.status ?? "Saved",
          );
        });
      };
    $("#progress-export").onclick = async () => {
      const button = $<HTMLButtonElement>("#progress-export"),
        requestRecord = host.studyRecord();
      button.disabled = true;
      try {
        const prepared = await prepareRoadmapExport(
          roadmap,
          host.studyRecord().study.learner!,
          host.studyRecord().study.roadmapExport,
        );
        if (host.studyRecord() !== requestRecord)
          throw Error("Run changed during export; retry from the current run");
        host.studyRecord().study.roadmapExport = prepared;
        await host.persist();
        download(
          "interview_prep_roadmap.md",
          prepared.content,
          "text/markdown",
        );
        setText(
          "#progress-export-status",
          `Saved complete revision ${prepared.revision}. Original curriculum and historical evidence preserved. ${host.saveError() || ""}`,
        );
      } catch (err) {
        setText(
          "#progress-export-status",
          `Export needs review: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        button.disabled = false;
      }
    };
    $("#source-export").onclick = () =>
      download("interview_prep_roadmap.md", roadmap.raw, "text/markdown");
    $("#evidence-export").onclick = () =>
      download(
        "learning-workspace-evidence.json",
        JSON.stringify(
          {
            study: host.studyRecord().study,
            encounters: host.studyRecord().encounters,
          },
          null,
          2,
        ),
      );
  }
  return render;
}
