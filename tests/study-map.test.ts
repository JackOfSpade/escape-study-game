import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { activateCareerFocus } from "../src/career-profile";
import { initialStudy } from "../src/curriculum";
import type { Contract, Roadmap } from "../src/model";
import { studyMapHtml } from "../src/study-map";
import { createRecord } from "./helpers/record";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
function setup() {
  const r = structuredClone(roadmap);
  const s = initialStudy(r, "live");
  activateCareerFocus(r, s);
  return { r, g: createRecord(125, r, s) };
}
const issued: Contract = {
  id: "issued-synthetic",
  track: "PE",
  objectiveIds: ["PE:T10.2"],
  scopes: ["Synthetic scope"],
  depth: 1,
  phase: "DIAGNOSE_ALL",
  review: false,
  ledgerVersion: 0,
  priorEvidence: [],
};

test("issued topic is the highlighted node, with real topic and tier counts", () => {
  const { r, g } = setup();
  const html = studyMapHtml(g, r, issued);
  assert.match(html, /7<small> of 131/);
  assert.match(
    html,
    /study-map-topic is-current" data-topic-key="PE:T10"[^>]*aria-current="step"/,
  );
  assert.doesNotMatch(html, /study-checkpoint|<details/);
  assert.match(html, /Probing now/);
  assert.match(html, /study-topic-count">1 of 2/);
  assert.doesNotMatch(html, /study-current-topic|study-review-notes/);
  assert.match(
    html,
    /<button type="button" class="study-topic-toggle quiet" tabindex="-1" data-study-topic-toggle/,
  );
  assert.doesNotMatch(html, /<div[^>]*role="button"/);
});

test("rendering an issued question does not initialize or reschedule the learner ledger", () => {
  const { r, g } = setup();
  delete g.study.learner;
  const before = structuredClone(g.study);
  studyMapHtml(g, r, issued);
  assert.deepEqual(g.study, before);
});

test("carried question outside active requirements never highlights a different required checkpoint", () => {
  const { r, g } = setup();
  // T01 remains required, but this particular objective is reference material.
  const html = studyMapHtml(g, r, { ...issued, objectiveIds: ["PE:T01.2"] });
  assert.doesNotMatch(html, /class="study-map-topic is-current"/);
  assert.doesNotMatch(html, /study-current-topic|data-study-locate/);
});

test("lower-tier review keeps active map totals without adding a summary card", () => {
  const { r, g } = setup();
  g.study.learner!.tracks.PE.tier = 2;
  const html = studyMapHtml(g, r, { ...issued, review: true });
  assert.match(html, /Tier 2/);
  assert.match(html, /0<small> of 51/);
  assert.match(html, /data-current-marker="issued:issued-synthetic"/);
  assert.match(html, /Reviewing Tier 1/);
  assert.match(html, /study-map-topic is-current" data-topic-key="PE:T10"/);
  assert.doesNotMatch(html, /study-current-topic/);
});

test("final transfer requirements are separate from ordinary checkpoint totals", () => {
  const { r, g } = setup();
  g.study.learner!.tracks.PE.tier = 4;
  const html = studyMapHtml(g, r, {
    ...issued,
    kind: "transfer",
    depth: 4,
    objectiveIds: ["PE:T01"],
  });
  assert.doesNotMatch(html, /class="study-map-topic is-current"/);
  assert.doesNotMatch(html, /study-current-topic/);
});

test("topic names are escaped and the diagram contains no deeper checkpoint expansion", () => {
  const { r, g } = setup();
  r.tracks.PE.topics.T10 = '<img src=x onerror="unsafe">';
  r.tracks.PE.objectives.find((o) => o.id === "PE:T10.2")!.scope =
    "<script>unsafe</script>";
  g.study.knowledgeGaps = [
    {
      id: "synthetic-gap",
      encounter: "synthetic",
      runId: "synthetic",
      track: "PE",
      objectiveIds: ["PE:T10.2"],
      depth: 1,
      facet: { id: "request", description: "<b>Observed gap</b>" },
      statement: "Synthetic gap declaration",
      requestId: "synthetic",
      provider: "synthetic",
      at: "2026-10-25T12:00:00Z",
    },
  ];
  const html = studyMapHtml(g, r, issued);
  assert.doesNotMatch(html, /<script|<img|<b>/i);
  assert.match(html, /&lt;img src=x onerror=&quot;unsafe&quot;&gt;/);
  assert.doesNotMatch(
    html,
    /<details|study-checkpoint|Observed gap|Saved learning notes/,
  );
  assert.doesNotMatch(html, /Assessment evidence/);
});
