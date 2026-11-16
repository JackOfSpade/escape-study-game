import type { StudyRecord, StudyState } from "./model";

/** A first visit starts from an empty record: no questions asked yet, the
 * given learning state, default settings. */
export function emptyRecord(study: StudyState): StudyRecord {
  return {
    schema: 1,
    id: `run-${crypto.randomUUID()}`,
    seq: 0,
    time: 0,
    encounters: {},
    study,
    settings: { displayScale: 1 },
    notice: "",
  };
}
