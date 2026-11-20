import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  checkBridge,
  ensureProblem,
  presentProblem,
  regenerateQuestion,
  seedGapPractice,
  send,
} from "../src/ai";
import { initialStudy } from "../src/curriculum";
import {
  openGaps,
  parseProbeReply,
  probeFacets,
  recordProbeTurn,
} from "../src/knowledge-probe";
import type { Assessment, Roadmap, StudyRecord } from "../src/model";
import { decode, encode, recover } from "../src/persistence";
import {
  enterStudyWorkspace,
  gapPracticeQuestion,
  workspaceQuestion,
} from "../src/study-workspace";
import { createRecord } from "./helpers/record";
const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));

/** A fake gateway that writes a question on whatever contract it is sent. */
async function withGateway(run: (payloads: any[]) => Promise<void>) {
  const original = globalThis.fetch;
  const payloads: any[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input) === "/api/status")
      return Response.json({
        mode: "claude-cli",
        label: "Isolated transport fixture",
        capabilities: ["generate", "tutor", "assess"],
        detail: "Test fixture only.",
      });
    const body = JSON.parse(String(init?.body));
    assert.equal(body.operation, "generate");
    payloads.push(body.payload);
    const c = body.payload.contract;
    return Response.json({
      title: "Fixture question",
      prompt: "Isolated pipeline fixture.",
      starter: "",
      rubric: ["scope"],
      contract: c,
      scopeDefinitions: [
        {
          id: `${c.objectiveIds[0]}/D${c.depth}`,
          objectiveId: c.objectiveIds[0],
          depth: c.depth,
          sourceScope: c.scopes[0],
          facets: [
            { id: "apex", description: "The apex idea" },
            { id: "support", description: "A supporting idea" },
          ],
        },
      ],
    });
  };
  try {
    await checkBridge();
    await run(payloads);
  } finally {
    globalThis.fetch = async () =>
      Response.json({
        mode: "development",
        label: "Synthetic cleanup",
        detail: "No real AI",
        capabilities: [],
      });
    await checkBridge();
    globalThis.fetch = original;
  }
}

test("a gap practice question reuses the gap's contract as practice, leaves the ledger alone and can close the gap", async () => {
  await withGateway(async (payloads) => {
    const g = createRecord(41, r, initialStudy(r, "live"));
    enterStudyWorkspace(g);
    const first = g.encounters["question-0"];
    await ensureProblem(g, first, r);
    presentProblem(g, first, r);
    recordProbeTurn(
      g,
      first,
      parseProbeReply(
        {
          text: "Recorded as a gap.",
          complete: true,
          outcome: "gap",
          knowledge: {
            facets: [
              { id: "support", status: "demonstrated" },
              { id: "apex", status: "gap" },
            ],
          },
        },
        probeFacets(first.problem!),
      ),
      {
        requestId: "first-concede",
        questionSequence: 1,
        provider: "claude-cli",
        statement: "I do not know the apex idea",
        at: "2026-11-18T10:00:00.000Z",
      },
    );
    const [gap] = openGaps(g);
    assert.equal(gap.facet.id, "apex");
    // While the first question is unfinished no practice question is offered.
    if (workspaceQuestion(g))
      assert.throws(() => gapPracticeQuestion(g), /Finish your open question/);
    first.state = "consumed";
    for (const other of Object.values(g.encounters))
      if (other !== first) other.state = "consumed";

    const ledgerBefore = JSON.stringify(g.study.learner);
    const practice = gapPracticeQuestion(g);
    seedGapPractice(g, r, practice, gap);
    await ensureProblem(g, practice, r);
    assert.equal(practice.error, undefined);
    const sent = payloads.at(-1);
    assert.equal(sent.contract.practice, true);
    assert.equal(sent.contract.review, false);
    assert.deepEqual(
      sent.contract.objectiveIds,
      first.problem!.contract.objectiveIds,
    );
    assert.equal(sent.contract.depth, first.problem!.contract.depth);
    assert.deepEqual(
      sent.probeRecords.openGaps.map((x: any) => x.facetId),
      ["apex"],
    );
    assert.equal(practice.problem?.contract.practice, true);

    // Showing and answering it is never a scheduled visit.
    presentProblem(g, practice, r);
    assert.equal(practice.error, undefined);
    assert.equal(
      JSON.stringify(g.study.learner),
      ledgerBefore,
      "the learner ledger is untouched by a practice question",
    );

    recordProbeTurn(
      g,
      practice,
      parseProbeReply(
        {
          text: "That is the apex idea.",
          complete: true,
          outcome: "solved",
          knowledge: { facets: [{ id: "apex", status: "demonstrated" }] },
        },
        probeFacets(practice.problem!),
      ),
      {
        requestId: "practice-turn",
        questionSequence: 1,
        provider: "claude-cli",
        statement: "the apex idea works like this",
        at: "2026-11-19T10:00:00.000Z",
      },
    );
    assert.deepEqual(openGaps(g), []);
    assert.equal(
      g.study.knowledgeGaps!.find((x) => x.id === gap.id)!.resolved?.status,
      "demonstrated",
    );
    assert.equal(JSON.stringify(g.study.learner), ledgerBefore);
  });
});

test("a gap whose question is no longer saved cannot seed a practice question", async () => {
  await withGateway(async () => {
    const g = createRecord(42, r, initialStudy(r, "live"));
    enterStudyWorkspace(g);
    const e = g.encounters["question-0"];
    assert.throws(
      () => seedGapPractice(g, r, e, { encounter: "gone/missing" }),
      /no longer saved/,
    );
    assert.equal(e.pendingGeneration, undefined);
  });
});

/** A fake gateway for the whole practice path. It counts every operation it is
 * sent, writes questions as above, and answers a tutor turn with `tutor()`. */
async function withTutorGateway(
  tutor: (payload: any) => Record<string, unknown>,
  run: (ctx: {
    ops: string[];
    setConnected(on: boolean): Promise<void>;
  }) => Promise<void>,
) {
  const original = globalThis.fetch;
  const ops: string[] = [];
  let connected = true;
  globalThis.fetch = async (input, init) => {
    if (String(input) === "/api/status")
      return Response.json({
        mode: connected ? "claude-cli" : "development",
        label: "Isolated transport fixture",
        capabilities: connected ? ["generate", "tutor", "assess"] : [],
        detail: "Test fixture only.",
      });
    const body = JSON.parse(String(init?.body));
    ops.push(body.operation);
    if (body.operation === "tutor") return Response.json(tutor(body.payload));
    if (body.operation !== "generate")
      return Response.json({ error: "unexpected" }, { status: 500 });
    const c = body.payload.contract;
    return Response.json({
      title: "Fixture question",
      prompt: "Isolated pipeline fixture.",
      starter: "",
      rubric: ["scope"],
      contract: c,
      scopeDefinitions: [
        {
          id: `${c.objectiveIds[0]}/D${c.depth}`,
          objectiveId: c.objectiveIds[0],
          depth: c.depth,
          sourceScope: c.scopes[0],
          facets: [
            { id: "apex", description: "The apex idea" },
            { id: "support", description: "A supporting idea" },
          ],
        },
      ],
    });
  };
  const setConnected = async (on: boolean) => {
    connected = on;
    await checkBridge();
  };
  try {
    await checkBridge();
    await run({ ops, setConnected });
  } finally {
    await setConnected(false);
    globalThis.fetch = original;
  }
}

/** A finished first question that recorded an open gap on "apex". */
async function recordedGap(seed: number) {
  const g = createRecord(seed, r, initialStudy(r, "live"));
  enterStudyWorkspace(g);
  const first = g.encounters["question-0"];
  await ensureProblem(g, first, r);
  presentProblem(g, first, r);
  recordProbeTurn(
    g,
    first,
    parseProbeReply(
      {
        text: "Recorded as a gap.",
        complete: true,
        outcome: "gap",
        knowledge: {
          facets: [
            { id: "support", status: "demonstrated" },
            { id: "apex", status: "gap" },
          ],
        },
      },
      probeFacets(first.problem!),
    ),
    {
      requestId: `first-${seed}`,
      questionSequence: 1,
      provider: "claude-cli",
      statement: "I do not know the apex idea",
      at: "2026-11-18T10:00:00.000Z",
    },
  );
  first.state = "consumed";
  for (const other of Object.values(g.encounters))
    if (other !== first) other.state = "consumed";
  const [gap] = openGaps(g);
  assert.equal(gap.facet.id, "apex");
  return { g, first, gap };
}
const apexDemonstrated = (
  practice: any,
  requestId: string,
  complete: boolean,
) =>
  recordProbeTurn(
    practice.g,
    practice.e,
    parseProbeReply(
      {
        text: "That is the apex idea.",
        complete,
        ...(complete ? { outcome: "solved" } : {}),
        knowledge: { facets: [{ id: "apex", status: "demonstrated" }] },
      },
      probeFacets(practice.e.problem!),
    ),
    {
      requestId,
      questionSequence: 1,
      provider: "claude-cli",
      statement: "the apex idea works like this",
      at: "2026-11-19T10:00:00.000Z",
    },
  );

test("regenerating a practice question opens again a gap it had closed", async () => {
  await withTutorGateway(
    () => ({}),
    async () => {
      const { g, gap } = await recordedGap(45);
      const practice = gapPracticeQuestion(g);
      seedGapPractice(g, r, practice, gap);
      await ensureProblem(g, practice, r);
      presentProblem(g, practice, r);
      apexDemonstrated({ g, e: practice }, "practice-turn", false);
      assert.deepEqual(openGaps(g), []);
      assert.equal(
        g.study.knowledgeGaps!.find((x) => x.id === gap.id)!.resolved?.status,
        "demonstrated",
      );
      assert.equal(practice.state !== "consumed", true);

      assert.equal(regenerateQuestion(g, practice, r), true);
      assert.equal(
        g.study.knowledgeGaps!.find((x) => x.id === gap.id)!.resolved,
        undefined,
      );
      assert.deepEqual(
        openGaps(g).map((x) => x.id),
        [gap.id],
      );
    },
  );
});

test("a practice question finishing through the real completion path is never assessed and leaves the ledger alone", async () => {
  await withTutorGateway(
    () => ({
      text: "That is the apex idea.",
      complete: true,
      outcome: "solved",
      knowledge: { facets: [{ id: "apex", status: "demonstrated" }] },
    }),
    async ({ ops }) => {
      const { g, gap } = await recordedGap(46);
      const practice = gapPracticeQuestion(g);
      seedGapPractice(g, r, practice, gap);
      await ensureProblem(g, practice, r);
      presentProblem(g, practice, r);
      assert.equal(practice.problem?.contract.practice, true);
      const learner = () => JSON.stringify(g.study.learner);
      const parts = () =>
        JSON.stringify({
          attempts: g.study.learner!.attempts,
          cells: g.study.learner!.cells,
          reviews: g.study.learner!.reviews,
          studyTurnPosition: g.study.learner!.studyTurnPosition,
        });
      const ledgerBefore = learner(),
        partsBefore = parts(),
        assessmentsBefore = JSON.stringify(g.study.assessments);
      const opsBefore = ops.length;

      await send(g, practice, "the apex idea works like this", r);
      // An assessment would be started without being awaited.
      await new Promise((res) => setTimeout(res, 30));

      assert.deepEqual(ops.slice(opsBefore), ["tutor"]);
      assert.equal(ops.includes("assess"), false);
      assert.equal(practice.error, undefined);
      assert.equal(practice.tutorRequests!.at(-1)!.state, "applied");
      assert.equal(practice.state, "consumed");
      assert.equal(practice.submissions.at(-1)!.status, "complete");
      assert.equal(JSON.stringify(g.study.assessments), assessmentsBefore);
      assert.equal(parts(), partsBefore);
      assert.equal(learner(), ledgerBefore);
      assert.deepEqual(openGaps(g), []);
      assert.equal(
        g.study.knowledgeGaps!.find((x) => x.id === gap.id)!.resolved?.status,
        "demonstrated",
      );
    },
  );
});

test("seeding a practice question while the bridge is down says so and leaves no pending generation", async () => {
  await withTutorGateway(
    () => ({}),
    async ({ setConnected }) => {
      const { g, gap } = await recordedGap(47);
      const e = g.encounters["question-1"];
      await setConnected(false);
      assert.throws(
        () => seedGapPractice(g, r, e, gap),
        /Claude is not connected/,
      );
      assert.equal(e.pendingGeneration, undefined);
    },
  );
});

test("gapPracticeQuestion refuses before the workspace is open, while a question is open and while a result is under review", () => {
  const g = createRecord(48, r, initialStudy(r, "live"));
  assert.throws(
    () => gapPracticeQuestion(g),
    /^Error: Open the study workspace first\.$/,
  );
  assert.equal(Object.keys(g.encounters).length, 12);

  enterStudyWorkspace(g);
  const q = g.encounters["question-0"];
  q.studyOnly = true;
  assert.ok(workspaceQuestion(g));
  assert.throws(
    () => gapPracticeQuestion(g),
    /^Error: Finish your open question before testing this gap\.$/,
  );

  for (const other of Object.values(g.encounters)) other.state = "consumed";
  g.studyWorkspace!.encounter = `${g.id}/${q.id}`;
  const assessment: Assessment = {
    id: `assessment-${g.id}/${q.id}-1`,
    encounter: q.id,
    sourceVersion: 0,
    findings: [],
    status: "review-required",
    provenance: "fixture",
  };
  g.study.assessments.push(assessment);
  for (const status of ["review-required", "pending"] as const) {
    assessment.status = status;
    assert.throws(
      () => gapPracticeQuestion(g),
      /Finish reviewing your previous learning result/,
    );
  }
  const before = Object.keys(g.encounters).length;
  assessment.status = "applied";
  const fresh = gapPracticeQuestion(g);
  assert.equal(Object.keys(g.encounters).length, before + 1);
  assert.equal(fresh.studyOnly, true);
});

test("a saved pending practice generation survives a reload with its practice contract", async () => {
  await withTutorGateway(
    () => ({}),
    async () => {
      const { g, gap } = await recordedGap(49);
      const practice = gapPracticeQuestion(g);
      seedGapPractice(g, r, practice, gap);
      // Saving drops keys that hold undefined.
      const before = JSON.parse(JSON.stringify(practice.pendingGeneration!));
      assert.equal((before.payload.contract as any).practice, true);

      const loaded: StudyRecord = recover(decode(encode(g)));
      const kept = loaded.encounters[practice.id];
      assert.ok(kept);
      assert.equal(kept.state, "available");
      assert.equal(kept.studyOnly, true);
      assert.deepEqual(kept.pendingGeneration, before);
      assert.equal(
        (kept.pendingGeneration!.payload.contract as any).practice,
        true,
      );
      assert.equal(workspaceQuestion(loaded), kept);
      // The gap is still open: nothing was resolved by saving.
      assert.deepEqual(
        openGaps(loaded).map((x) => x.id),
        [gap.id],
      );
    },
  );
});
