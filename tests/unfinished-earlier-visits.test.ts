import { preparePracticeRooms } from "./helpers/practice-questions";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Encounter, Message, Roadmap } from "../src/model";
import { unfinishedEarlierVisits } from "../src/room-questions";
import { createPlayableGame } from "../src/world";
const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));

function human(text: string, seq: number): Message {
  return {
    id: `m-${seq}`,
    author: "human",
    kind: "human",
    text,
    seq,
    worldTime: seq,
    provenance: "live-human",
  };
}
/** An archived copy of `e` from an earlier run, started by the human. */
function archived(
  e: Encounter,
  runId: string,
  patch: Partial<Encounter> = {},
): Encounter {
  const a = structuredClone(e);
  a.runId = runId;
  a.tutor = [human("my first answer", 3)];
  return Object.assign(a, patch);
}

test("a scheduled question the human started in earlier runs but never finished is reported with its carried facets", () => {
  const g = createPlayableGame(44, r);
  preparePracticeRooms(g, r);
  const formal = Object.values(g.encounters).find(
    (e) => e.problem && !e.problem.contract.practice,
  )!;
  const practice = Object.values(g.encounters).find(
    (e) => e.problem?.contract.practice,
  )!;
  assert.deepEqual(unfinishedEarlierVisits(g, formal), {
    runs: 0,
    established: 0,
  });
  // The same run's own archive, a consumed earlier visit, a practice terminal,
  // an untouched earlier terminal and another objective are not "unfinished".
  g.study.archives.push(
    archived(formal, g.id),
    archived(formal, "run-done", { state: "consumed" }),
    archived(practice, "run-practice"),
    archived(formal, "run-untouched", { tutor: [] }),
    archived(formal, "run-other", {
      problem: {
        ...formal.problem!,
        contract: { ...formal.problem!.contract, objectiveIds: ["PY:T99.1"] },
      },
    }),
  );
  assert.deepEqual(unfinishedEarlierVisits(g, formal), {
    runs: 0,
    established: 0,
  });
  g.study.archives.push(
    archived(formal, "run-a"),
    archived(formal, "run-a", { id: `${formal.id}-solo1` }),
    archived(formal, "run-b"),
  );
  g.study.knowledgeEstablished = [
    {
      id: "known-1",
      encounter: `run-a/${formal.id}`,
      runId: "run-a",
      track: formal.problem!.contract.track,
      objectiveIds: formal.problem!.contract.objectiveIds,
      depth: 1,
      facet: { id: "total", description: "Correct predicted total" },
      status: "demonstrated",
      requestId: "tutor-1",
      provider: "chatgpt-handoff",
      at: "2026-10-18T00:00:00.000Z",
    },
    {
      id: "known-2",
      encounter: `run-done/${formal.id}`,
      runId: "run-done",
      track: formal.problem!.contract.track,
      objectiveIds: formal.problem!.contract.objectiveIds,
      depth: 1,
      facet: { id: "boundary", description: "A boundary" },
      status: "implied",
      requestId: "tutor-2",
      provider: "chatgpt-handoff",
      at: "2026-10-18T00:00:00.000Z",
    },
  ];
  assert.deepEqual(unfinishedEarlierVisits(g, formal), {
    runs: 2,
    established: 1,
  });
  // A practice terminal and a consumed terminal never report earlier runs.
  assert.deepEqual(unfinishedEarlierVisits(g, practice), {
    runs: 0,
    established: 0,
  });
  formal.state = "consumed";
  assert.deepEqual(unfinishedEarlierVisits(g, formal), {
    runs: 0,
    established: 0,
  });
});
