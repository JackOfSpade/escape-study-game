import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Roadmap } from "../src/model";
import { decode, encode, recover } from "../src/persistence";
import { createGame } from "./helpers/record";

const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
test("recovery interrupts every archived request while retaining captured work and request identity", () => {
  const g = createGame(727, r),
    archive = structuredClone(g.encounters["question-0"]);
  archive.runId = "synthetic-previous-run";
  archive.workspace = "Synthetic archived human draft";
  archive.state = "submitted";
  archive.chatOpen = true;
  archive.generation = "synthetic-generation";
  archive.tutorRequests = [
    {
      id: "synthetic-tutor",
      provider: "study-mode",
      payloadJson: '{"requestId":"synthetic-tutor"}',
      questionSequence: 1,
      state: "pending",
    },
  ];
  archive.submissions = [
    {
      id: "synthetic-submission",
      author: "human",
      revision: 0,
      content: archive.workspace,
      status: "pending",
      seq: 1,
      feedback: "Synthetic pending review",
    },
  ];
  g.study.archives.push(archive);
  const restored = recover(decode(encode(g))).study.archives[0];
  assert.equal(restored.tutorRequests![0].state, "interrupted");
  assert.equal(restored.submissions[0].status, "error");
  assert.equal(restored.state, "in-progress");
  assert.equal(restored.chatOpen, false);
  assert.equal(restored.generation, undefined);
  assert.equal(restored.runId, archive.runId);
  assert.equal(restored.workspace, archive.workspace);
  assert.equal(restored.submissions[0].content, archive.workspace);
  assert.equal(
    restored.tutorRequests![0].payloadJson,
    archive.tutorRequests[0].payloadJson,
  );
});
