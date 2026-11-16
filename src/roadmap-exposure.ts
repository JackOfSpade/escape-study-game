import { nextSeq, type StudyRecord } from "./model";
/** Record provided source material for retained human questions, never a visit.
 * This private review material stays out of every exported snapshot. */
export function presentRoadmapReview(g: StudyRecord, id: string, text: string) {
  const retained = Object.values(g.encounters).filter(
    (e) =>
      e.problem &&
      e.state !== "consumed" &&
      e.problemPresentedSequence !== undefined,
  );
  for (const e of retained) {
    if (e.history.some((a) => a.kind === "source-view" && a.refs?.includes(id)))
      continue;
    e.history.push({
      seq: nextSeq(g),
      author: "roadmap",
      kind: "source-view",
      text,
      at: g.time,
      wallTime: new Date().toISOString(),
      revision: e.revision,
      refs: [id],
      presented: g.seq,
    });
  }
}
