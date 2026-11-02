import { isRecord as object } from "./is-record.mjs";

/** Narrative topic reflections are separate from facet findings and mastery. */
export const TOPIC_ASSESSMENT_TEXT_LIMIT = 16000;
export const TOPIC_ASSESSMENT_INSTRUCTION =
  "When topicAssessmentContext is present, refresh the learner's current topic assessments at this question's completion. In the reply that sets complete:true, include topicAssessments:[{topicId,text}], exactly once for each topicAssessmentContext.topicIds entry and no other topics; replies with complete:false omit topicAssessments. Read the complete topicAssessmentContext, including its omitted context part if necessary, and use the relevant saved history, prior assessments and this actual conversation to form a current, holistic assessment. Write freely in your own words, with no fixed template or required headings. You may infer likely strengths or probable knowledge gaps when the available evidence supports them; make uncertainty and the basis for a prediction clear, and distinguish demonstrated knowledge, tentative inference and material that has not been assessed. Do not invent learner statements, evidence or observations. Reconsider earlier impressions in light of new evidence. These narratives do not grant or withdraw checkpoint credit, change facet findings or certify mastery: predictions belong only in the narrative, while knowledge.facets retains its stricter evidence rules. Refresh only the topics actually assessed by this question, never unrelated topics. Each narrative must be nonempty and at most 16000 characters. ";

const TOPIC_ID = /^(PY|PE):[TXI]\d{2}$/;
const OBJECTIVE_ID = /^(PY|PE):([TXI]\d{2})(?:\.\d+)?$/;

/** Stable namespaced topics tested by a checkpoint, transfer or final contract. */
export function topicAssessmentTopics(contract) {
  if (!object(contract) || !Array.isArray(contract.objectiveIds)) return [];
  return [
    ...new Set(
      contract.objectiveIds.flatMap((id) => {
        const match = typeof id === "string" && id.match(OBJECTIVE_ID);
        return match ? [`${match[1]}:${match[2]}`] : [];
      }),
    ),
  ];
}

/** Validate correlation and bounds without constraining the AI's prose. */
export function validateTopicAssessments(value, topics, required = false) {
  if (value === undefined && !required) return [];
  if (
    !Array.isArray(topics) ||
    topics.length > 64 ||
    topics.some(
      (topic) => typeof topic !== "string" || !TOPIC_ID.test(topic),
    ) ||
    new Set(topics).size !== topics.length
  )
    throw Error("Topic assessments require the exact captured topic IDs");
  if (!Array.isArray(value) || value.length !== topics.length)
    throw Error("Return topicAssessments exactly once for each assessed topic");
  const seen = new Set();
  for (const item of value) {
    if (
      !object(item) ||
      Object.keys(item).some((key) => key !== "topicId" && key !== "text") ||
      !topics.includes(item.topicId) ||
      seen.has(item.topicId) ||
      typeof item.text !== "string" ||
      !item.text.trim() ||
      item.text.length > TOPIC_ASSESSMENT_TEXT_LIMIT
    )
      throw Error(
        "Topic assessments need distinct captured topicId values and nonempty text of at most 16000 characters",
      );
    seen.add(item.topicId);
  }
  return value.map(({ topicId, text }) => ({ topicId, text }));
}
