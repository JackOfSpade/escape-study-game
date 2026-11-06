import { eligible } from "./curriculum";
import { escapeHtml as esc } from "./html";
import type { Contract, Game, Roadmap } from "./model";
import { studyTrackProgress } from "./study-progress";

type TopicProgress = ReturnType<typeof studyTrackProgress>["topics"][number];
const trackName = (track: string) =>
  track === "PY" ? "Python" : "Product engineering";
const tierName = (tier: number) =>
  `Tier ${tier}${tier === 1 ? " foundations" : ""}`;
const topicStatus = (topic: TopicProgress) => {
  if (topic.passed === topic.total) return "complete";
  if (topic.checkpoints.some((c) => c.status === "recheck")) return "recheck";
  if (topic.checkpoints.some((c) => c.status === "gap")) return "gap";
  if (topic.passed || topic.checkpoints.some((c) => c.status === "partial"))
    return "partial";
  return "unassessed";
};
export const STATUS_ICONS = {
  complete: "✓",
  recheck: "↻",
  gap: "!",
  partial: "◐",
  unassessed: "○",
};
const statusLabels = {
  complete: "Complete",
  recheck: "Needs recheck",
  gap: "Gap to practise",
  partial: "In progress",
  unassessed: "Not yet assessed",
};

/** A topic-only diagram. Connectors show curriculum grouping, never prerequisites. */
export function studyMapHtml(g: Game, r: Roadmap, issued?: Contract) {
  let current = issued;
  if (!current) {
    try {
      current = eligible(r, g.study);
    } catch {
      /* Gates are a valid state. */
    }
  }
  const currentTopic = current?.objectiveIds[0]?.split(":")[1]?.split(".")[0];
  const currentKey =
    current && currentTopic ? `${current.track}:${currentTopic}` : undefined;
  const tracks = (["PY", "PE"] as const).map((track) => ({
    track,
    ...studyTrackProgress(r, g.study, track),
  }));
  const tiers = [...new Set(tracks.map((t) => t.tier))];

  const topicNode = (topic: TopicProgress, track: string, tier: number) => {
    const key = `${track}:${topic.id}`;
    const here =
      key === currentKey &&
      topic.checkpoints.some((checkpoint) =>
        current?.objectiveIds.includes(checkpoint.id),
      );
    const status = topicStatus(topic);
    const location = issued
      ? current?.review
        ? `Reviewing Tier ${current.depth}`
        : "Probing now"
      : "Up next";
    const panelId = `study-assessment-${track}-${topic.id}-D${tier}`;
    return `<li class="study-map-topic${here ? " is-current" : ""}${status === "complete" ? " is-complete" : ""}" data-topic-key="${esc(key)}" data-status="${status}" data-tier="${tier}" data-passed="${topic.passed}" data-total="${topic.total}"${here ? ' aria-current="step"' : ""}><button type="button" class="study-topic-toggle quiet" tabindex="-1" data-study-topic-toggle aria-expanded="false" aria-controls="${esc(panelId)}" aria-label="${esc(topic.name)}: ${topic.passed} of ${topic.total} verified. ${statusLabels[status]}${here ? `. ${location}` : ""}"><span class="study-node-status" aria-hidden="true" title="${statusLabels[status]}">${STATUS_ICONS[status]}</span><span class="study-topic-label"><span class="study-topic-name">${esc(topic.name)}</span>${here ? `<small class="study-here">${location}</small>` : ""}</span><span class="study-topic-count">${topic.passed} of ${topic.total}${status === "complete" ? "<small>Complete</small>" : ""}</span></button><section id="${esc(panelId)}" class="study-topic-assessment-panel" aria-label="AI assessment of ${esc(topic.name)}" hidden><span class="study-label">AI KNOWLEDGE ASSESSMENT</span><p class="study-topic-assessment-meta study-topic-meta"></p><p class="study-topic-assessment-status study-topic-meta"></p><div class="study-topic-assessment-body study-topic-prose"></div><p class="study-topic-footnote">AI notes may be tentative; checkpoint counts are verified separately.</p></section></li>`;
  };
  const diagrams = tiers
    .map((tier) => {
      const members = tracks.filter((track) => track.tier === tier);
      const total = members.reduce((n, track) => n + track.total, 0);
      const passed = members.reduce((n, track) => n + track.passed, 0);
      const branches = members
        .map(
          (track) =>
            `<section class="study-map-track" data-track="${track.track}" aria-label="${trackName(track.track)} topics"><header class="study-map-track-node"><h3>${trackName(track.track)}</h3><strong>${track.passed} of ${track.total}</strong></header><ul class="study-map-topics">${track.topics.map((topic) => topicNode(topic, track.track, tier)).join("")}</ul>${!track.topics.length ? '<p class="study-map-empty">No ordinary checkpoints required at this tier.</p>' : ""}</section>`,
        )
        .join("");
      return `<div class="study-map-tier" data-tier="${tier}" data-passed="${passed}" data-total="${total}"><div class="study-map-root"><div><span class="study-label">YOUR SKILL MAP</span><h2>${tierName(tier)}</h2></div><div class="study-map-total"><strong>${passed}<small> of ${total}</small></strong><span>checkpoints verified</span></div><progress value="${passed}" max="${Math.max(1, total)}" aria-label="${tierName(tier)} verified checkpoints"></progress></div><div class="study-map-scroll" data-tier="${tier}" role="region" tabindex="-1" aria-label="${tierName(tier)} topic tree"><span class="study-map-root-stem" aria-hidden="true"></span><div class="study-map-columns${members.length === 1 ? " is-single-track" : ""}">${branches}</div></div></div>`;
    })
    .join("");
  return `<section class="study-skill-map" data-current-marker="${esc(current ? `${issued ? "issued" : "next"}:${current.id}` : "")}" aria-label="Curriculum skill map">${diagrams}<div class="study-map-legend" aria-label="Topic states"><span>✓ Complete</span><span>◐ In progress</span><span>! Gap to practise</span><span>○ Unassessed</span><span>↻ Recheck</span></div></section>`;
}
