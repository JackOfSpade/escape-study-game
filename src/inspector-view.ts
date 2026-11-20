import { curriculumReadiness } from "./final-requirements";
import { escapeHtml as escape } from "./html";
import type { Contract, StudyRecord, Roadmap, Track } from "./model";

/**
 * HTML for the curriculum inspector panel. Pure string builders over the study record
 * and roadmap; main.ts owns the DOM, the handlers and persistence.
 */
export function inspectorSummaryHtml(
  g: StudyRecord,
  roadmap: Roadmap,
  c: Contract | undefined,
  detail: string,
) {
  return `<p>PY: Tier ${g.study.profile === "live" ? g.study.learner?.tracks.PY.tier : 1} / ${escape(g.study.phases.PY)}. PE: Tier ${g.study.profile === "live" ? g.study.learner?.tracks.PE.tier : 1} / ${escape(g.study.phases.PE)}. The next formal visit is ${c?.track ?? "waiting at a curriculum gate"}${c?.review ? " · oldest due review" : ""}.</p><p>${escape(detail)}</p><p>${g.study.profile === "live" ? "Recorded academic visits" : "Development practice visits"}: ${g.study.visits.length}. Source: ${roadmap.sourceHash}. Original evidence is retained in full; development practice adds no passes.</p><button id="progress-export">Download updated merged roadmap</button><p id="progress-export-status" class="muted">Validated live study and reviewed practical evidence can update the roadmap. Downloading a save does not award learning credit.</p><button id="source-export" class="quiet">Download original merged roadmap</button><button id="evidence-export" class="quiet">Export evidence for review</button><h3>Assessment queue</h3>${g.study.assessments.map((a) => `<p>${escape(a.id)} · ${escape(a.status)}<br>${escape(a.provenance)} ${a.status === "review-required" ? `<button data-assessment="${escape(a.id)}" class="quiet">Retry assessment</button>` : ""}</p>`).join("") || "<p>No assessments yet.</p>"}<details><summary>Authoritative saved scheduler</summary><pre>${escape(roadmap.sharedProgress)}</pre></details>`;
}
export function readinessHtml(g: StudyRecord, roadmap: Roadmap, track: Track) {
  if (!g.study.learner) return "";
  const report = curriculumReadiness(roadmap, g.study.learner, track);
  const summary = (v: { passed: number; total: number }) =>
    `${v.passed}/${v.total}`;
  return `<section data-readiness="${track}"><h3>${track} readiness</h3><p>Checkpoint targets ${summary(report.checkpoints)} · topic transfers ${summary(report.transfers)} · selected integrations ${summary(report.integrations)}.</p><p>Curriculum targets: ${report.curriculumTargetsMet ? "met" : "not yet met"}. Interview practice: ${report.interviewPracticeVerified ? "verified" : "not yet verified"}. Delayed retention: ${report.retention.verified}/${report.retention.tracked} tracked scopes verified.</p>${report.environment.total ? `<p>Observed environment skills ${summary(report.environment)}. ENV observations are separate and never block a tier gate.</p>` : ""}<details><summary>Transfer, integration and environment records</summary><p>These records preserve the roadmap's selected scope. Only validated independent human evidence can complete a transfer or integration. Development questions and code execution alone add no credit.</p>${report.requirements.map((d) => `<p><strong>${escape(d.id)}</strong> · ${d.selected ? escape(d.status) : "not selected"}<br>${escape(d.remaining)}<br><small>${escape(d.sourceRefs)}</small></p>`).join("")}</details></section>`;
}
export function knowledgeHtml(g: StudyRecord) {
  const gaps = g.study.knowledgeGaps ?? [];
  const known = g.study.knowledgeEstablished ?? [];
  return `<section data-knowledge-established><h3>Established in questions (${known.length})</h3><p>Facets you answered, or that a correct answer necessarily implied. Later questions on the same scope skip them. These are observations from your conversations, not curriculum credit.</p>${
    known
      .slice()
      .reverse()
      .slice(0, 40)
      .map(
        (r) =>
          `<p><strong>${escape(r.objectiveIds.join(", "))} · D${r.depth}</strong> · ${escape(r.facet.description)}${r.partOf ? ` · part of ${escape(r.partOf.description)}` : ""}<br><small>${escape(r.at.slice(0, 10))} · ${escape(r.status)}${r.impliedBy ? ` · implied by ${escape(r.impliedBy)}` : ""}</small></p>`,
      )
      .join("") || "<p>None recorded.</p>"
  }</section><section data-knowledge-gaps><h3>Recorded knowledge gaps (${gaps.filter((r) => !r.resolved).length} open · ${gaps.filter((r) => r.resolved).length} closed)</h3><p>Facets you told your tutor you did not know. The question was still completed; these are study targets, never failures or mastery. The next question on the same track sees them, and a gap closes once you establish that facet in a later question.</p>${
    gaps
      .slice()
      .reverse()
      .map(
        (r) =>
          `<p><strong>${escape(r.objectiveIds.join(", "))} · D${r.depth}</strong> · ${escape(r.facet.description)}${r.partOf ? ` · part of ${escape(r.partOf.description)}` : ""}<br><small>${escape(r.at.slice(0, 10))} · you said: ${escape(r.statement.slice(0, 200))}${r.resolved ? ` · closed ${escape(r.resolved.at.slice(0, 10))} (${escape(r.resolved.status)})` : " · open"}</small></p>`,
      )
      .join("") || "<p>None recorded.</p>"
  }</section>`;
}
