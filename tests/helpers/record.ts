import { initialStudy } from "../../src/curriculum";
import type {
  Encounter,
  StudyRecord,
  Roadmap,
  StudyState,
} from "../../src/model";
import { emptyRecord } from "../../src/record";

/** An open study question with an empty workspace and conversation. */
export function question(g: Pick<StudyRecord, "id">, id: string): Encounter {
  return {
    id,
    runId: g.id,
    mode: "solo",
    state: "available",
    workspace: "",
    revision: 0,
    history: [],
    tutor: [],
    submissions: [],
    contributors: [],
    chatOpen: false,
    scroll: 0,
    selection: [0, 0],
  };
}

/** A fresh saved record holding twelve unasked questions, `question-0` to
 * `question-11`, for tests that work one of them. */
export function createRecord(
  _seed: number,
  r: Roadmap,
  study?: StudyState,
): StudyRecord {
  const g = emptyRecord(study ?? initialStudy(r));
  for (let i = 0; i < 12; i++)
    g.encounters[`question-${i}`] = question(g, `question-${i}`);
  return g;
}
