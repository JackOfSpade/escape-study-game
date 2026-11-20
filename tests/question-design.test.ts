import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-expect-error Direct .mjs contract test.
import { taskInstructions, validateAnswer } from "../scripts/lib/ai-contracts.mjs"; // prettier-ignore
import { checkBridge, ensureProblem, regenerateQuestion } from "../src/ai";
import { eligible, initialStudy } from "../src/curriculum";
import {
  PROBE_STANCE,
  TERMINAL_DIALOGUE_INSTRUCTION,
} from "../src/knowledge-probe";
import type { Roadmap } from "../src/model";
import { createRecord } from "./helpers/record";
import {
  MINIMUM_EVIDENCE_GUIDANCE,
  QUESTION_DESIGN_GUIDANCE,
  QUESTION_SHAPE_GUIDANCE,
  QUESTION_ADAPTATION_GUIDANCE,
  ASSESSMENT_HELP_GUIDANCE,
} from "../scripts/lib/study-question-policy.mjs";

const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));

const minimalPolicy = [
  /smallest self-contained diagnostic that exercises the objective/,
  /one main problem, and a follow-up only when it tests something the main problem does not/,
  /actual code under review, including any required helper and its authorization semantics/,
  /prose proposal supports design review only/,
  /short snippets, traces or evidence/,
  /never turn (an objective's )?scope verbs into a D1 implementation task/,
  /visible task and rubric must match,? without leaking the solution/,
  /honestly integrative objective may stay integrative on a small feature/,
  /narrow example never establishes unrelated facets or mastery/,
];

// Synthetic transport fixture: proves the policy reaches the provider, not AI quality.
function fixtureFetch(sent: any[]) {
  return (async (input: unknown, init?: RequestInit) => {
    if (String(input) === "/api/status")
      return Response.json({
        mode: "claude-cli",
        label: "Isolated question design fixture",
        capabilities: ["generate", "tutor", "assess"],
        detail: "Test fixture only; not a native Study Mode verification.",
      });
    const body = JSON.parse(String(init?.body));
    assert.equal(body.operation, "generate");
    sent.push(structuredClone(body.payload));
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
          facets: [{ id: "scope", description: "Complete scope fixture" }],
        },
      ],
    });
  }) as typeof fetch;
}

test("live generation payload carries the minimal concrete problem policy and keeps prior policy", async () => {
  const original = globalThis.fetch;
  const sent: any[] = [];
  globalThis.fetch = fixtureFetch(sent);
  try {
    await checkBridge();
    const g = createRecord(41, r, initialStudy(r, "live"));
    const e = g.encounters["question-0"];
    await ensureProblem(g, e, r);
    assert.equal(sent.length, 1);
    assert.equal(e.problem?.provenance, "claude-cli");
    const policy: string = sent[0].generationPolicy;
    // Each rule travels once: the design guidance is in the instructions only.
    assert.ok(!policy.includes(QUESTION_DESIGN_GUIDANCE));
    for (const requirement of minimalPolicy) assert.match(policy, requirement);
    // Earlier policy remains intact; refinements are appended.
    assert.match(
      policy,
      /prompt and the part on screen together must supply.*without using the chat/,
    );
    assert.match(
      policy,
      /existing stable scope definitions are copied exactly/,
    );
    assert.match(policy, /Use probeRecords/);
    assert.match(
      policy,
      /Do not interpret an objective's implementation verb as a D1 implementation requirement/,
    );
    assert.equal(sent[0].contract.track, eligible(r, g.study).track);
    assert.deepEqual(
      e.problem?.contract.objectiveIds,
      sent[0].contract.objectiveIds,
    );
  } finally {
    globalThis.fetch = original;
    await checkBridge();
  }
});

test("a saved generation retries with its exact captured payload and request identity", async () => {
  const original = globalThis.fetch;
  const sent: any[] = [];
  globalThis.fetch = fixtureFetch(sent);
  try {
    await checkBridge();
    const g = createRecord(42, r, initialStudy(r, "live"));
    const e = g.encounters["question-0"];
    const captured = {
      requestId: "gen-synthetic-saved",
      encounterId: e.id,
      // JSON round trip: the transport drops undefined optional fields.
      contract: JSON.parse(JSON.stringify(eligible(r, g.study))),
      generationPolicy: "Synthetic earlier captured policy text.",
    };
    e.pendingGeneration = {
      provider: "claude-cli",
      requestId: "gen-synthetic-saved",
      payload: structuredClone(captured),
    };
    await ensureProblem(g, e, r);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], captured);
    // The old captured policy is resent verbatim, never upgraded.
    assert.doesNotMatch(sent[0].generationPolicy, /smallest self-contained/);
    assert.equal(e.pendingGeneration, undefined);
    assert.equal(e.problem?.title, "Fixture question");
  } finally {
    globalThis.fetch = original;
    await checkBridge();
  }
});

test("generate instructions require minimal concrete problems with unchanged contracts", () => {
  const contract = {
    id: "synthetic-review",
    objectiveIds: ["SYNTHETIC:REVIEW"],
    scopes: ["Review an authorization change."],
    depth: 2,
  };
  const job = {
    instructions: taskInstructions("generate", {
      requestId: "synthetic-minimal",
      contract,
    }) as string,
  };
  assert.ok(job.instructions.includes(QUESTION_DESIGN_GUIDANCE));
  for (const requirement of minimalPolicy)
    assert.match(job.instructions, requirement);
  assert.match(job.instructions, /Copy the exact eligible contract/);
  assert.match(
    job.instructions,
    /existing stable scope definitions are copied exactly, never rewritten/,
  );
  assert.match(
    job.instructions,
    /prompt together with the part on screen, must stand on its own/,
  );
  assert.doesNotMatch(job.instructions, /establishes the most at once/);
});

test("every generated question fits one sitting", () => {
  const contract = { id: "synthetic-sitting", depth: 2 };
  const job = { operation: "generate", payload: { contract } };
  const answer = (estimatedSolveSeconds: number) => ({
    title: "Late deliveries report",
    prompt: "Explain the bug.",
    starter: "",
    rubric: ["Names the race."],
    contract,
    scopeDefinitions: [{ id: "s" }],
    estimatedSolveSeconds,
  });
  assert.doesNotThrow(() => validateAnswer(job, answer(900)));
  assert.throws(() => validateAnswer(job, answer(901)), /30 to 900/);
  // The number of parts has no limit.
  const parts = (n: number) => ({ ...answer(60), parts: Array(n).fill("ask") });
  assert.doesNotThrow(() => validateAnswer(job, parts(12)));
  assert.throws(() => validateAnswer(job, parts(0)), /one or more nonempty/);
  // A part with two requests is sent back once, never refused on the last try.
  const two = { ...answer(60), parts: ["Which would you use? Give its cost."] };
  assert.throws(() => validateAnswer(job, two), /more than one thing/);
  assert.doesNotThrow(() => validateAnswer(job, two, { final: true }));
  const instructions = taskInstructions("generate", { contract }) as string;
  assert.match(instructions, /one sitting of at most 15 minutes/);
  for (const op of ["generate", "tutor", "assess"])
    assert.doesNotMatch(
      taskInstructions(op, { contract }) as string,
      /segment/i,
      `${op} still mentions segments`,
    );
});

test("tutor instructions use focused questioning without breadth inflation", () => {
  const job = {
    instructions: taskInstructions("tutor", {
      requestId: "synthetic-tutor",
      problem: { prompt: "Synthetic task; never real learner proof" },
      messages: [{ text: "PRIVATE_SYNTHETIC_TUTOR_CONTEXT" }],
    }) as string,
  };
  assert.ok(job.instructions.includes(QUESTION_ADAPTATION_GUIDANCE));
  assert.match(job.instructions, /one rung per miss on the same point/);
  assert.match(job.instructions, /never give one before that warning/);
  assert.match(
    job.instructions,
    /Never ask again for something the learner has already answered correctly/,
  );
  assert.match(
    job.instructions,
    /do not ask them to restate, complete or re-derive it/,
  );
  const assess = taskInstructions("assess", {}) as string;
  assert.ok(assess.includes(ASSESSMENT_HELP_GUIDANCE));
  assert.match(
    ASSESSMENT_HELP_GUIDANCE,
    /only repeats or rewords a part of the issued question/,
  );
  assert.match(
    job.instructions,
    /one focused question whose reasoning genuinely entails its prerequisites/,
  );
  assert.match(job.instructions, /never breadth inflation/);
  assert.match(job.instructions, /unasked unrelated facets marked established/);
  assert.match(job.instructions, /hidden full-project follow-up/);
  assert.match(job.instructions, /probe its parts next, one level down/);
  assert.match(job.instructions, /known parts never imply it/);
  assert.match(job.instructions, /optionally probe/);
  assert.match(job.instructions, /or wants to move on/);
  assert.doesNotMatch(job.instructions, /nothing lower is left to probe/);
  assert.doesNotMatch(job.instructions, /establishes the most at once/);
});

test("probe stance keeps bounded reasoning, one-level clarification and explicit gaps", () => {
  assert.ok(TERMINAL_DIALOGUE_INSTRUCTION.includes(PROBE_STANCE));
  assert.ok(PROBE_STANCE.includes(QUESTION_ADAPTATION_GUIDANCE));
  assert.match(PROBE_STANCE, /highest-leverage question/);
  assert.match(
    PROBE_STANCE,
    /focused reasoning whose correct answer necessarily entails other facets already in the issued task/,
  );
  assert.match(PROBE_STANCE, /leave all unasked siblings unknown/);
  assert.match(
    PROBE_STANCE,
    /Do not widen the question or add hidden project demands/,
  );
  assert.match(PROBE_STANCE, /mark Y and Z implied by X/);
  assert.match(
    PROBE_STANCE,
    /at most one directly relevant prerequisite question, one level down/,
  );
  assert.match(PROBE_STANCE, /known parts never imply the apex/);
  assert.match(
    PROBE_STANCE,
    /Requesting clarification alone is not evidence of partial knowledge, guessing or a gap/,
  );
});

test("study prompts carry no game framing and ask for interview-realistic questions", () => {
  for (const operation of ["generate", "tutor"]) {
    const text = taskInstructions(operation, {});
    assert.doesNotMatch(text, /zombie-escape|gameplay|the game\b/i, operation);
  }
  const generate = taskInstructions("generate", {});
  assert.match(generate, /real software engineering interview/);
  assert.match(generate, /Never set the question in a game, story/);
  assert.match(generate, /payload\.replaces/);
});

/** A question already issued on the contract a fresh record schedules first. */
function issue(
  g: any,
  id: string,
  seq: number,
  over: Record<string, unknown> = {},
  objectiveIds?: string[],
) {
  const e = g.encounters[id];
  const c = structuredClone(eligible(r, g.study));
  if (objectiveIds) c.objectiveIds = objectiveIds;
  e.problem = {
    title: `Title ${id}`,
    prompt: `Scenario ${id}. `.repeat(40),
    rubric: [],
    starter: "",
    provenance: "claude-cli",
    contract: c,
    ...over,
  };
  e.problemPresentedSequence = seq;
  e.state = "consumed";
  return e;
}

test("a generation request carries a short summary of the newest earlier questions on its objectives", async () => {
  const original = globalThis.fetch;
  const sent: any[] = [];
  globalThis.fetch = fixtureFetch(sent);
  try {
    await checkBridge();
    const g: any = createRecord(43, r, initialStudy(r, "live"));
    const e = g.encounters["question-0"];
    for (let i = 1; i <= 7; i++) issue(g, `question-${i}`, 9 + i);
    issue(g, "question-6", 15, { prompt: "Facts.\n\nWhat is the cause?" });
    issue(g, "question-3", 12, {
      staged: {
        shared: "S".repeat(400),
        parts: ["A".repeat(400), "short ask"],
      },
    });
    g.encounters["question-4"].tutor.push({
      id: "m",
      author: "You",
      kind: "human",
      text: "PRIVATE LEARNER ANSWER",
      seq: 1,
      worldTime: 0,
      provenance: "human",
    });
    issue(g, "question-8", 99, {}, ["OTHER:X"]);
    issue(g, "question-9", 98, { provenance: "development" });
    await ensureProblem(g, e, r);
    assert.equal(sent.length, 1);
    const earlier = sent[0].earlierQuestions;
    // Newest first, five at most; another objective and stand-ins are left out.
    assert.deepEqual(
      earlier.map((x: any) => x.title),
      [7, 6, 5, 4, 3].map((i) => `Title question-${i}`),
    );
    for (const x of earlier) {
      assert.ok(x.opening.length <= 160);
      assert.deepEqual(Object.keys(x).sort(), ["asks", "opening", "title"]);
    }
    // A question shown whole has one ask: the last block of its prompt.
    assert.deepEqual(earlier[0].asks, []);
    assert.deepEqual(earlier[1].asks, ["What is the cause?"]);
    assert.equal(earlier[4].opening.length, 160);
    assert.equal(earlier[4].asks.length, 2);
    assert.ok(earlier[4].asks[0].length <= 160);
    assert.equal(earlier[4].asks[1], "short ask");
    assert.doesNotMatch(JSON.stringify(sent[0]), /PRIVATE LEARNER ANSWER/);
  } finally {
    globalThis.fetch = original;
    await checkBridge();
  }
});

test("a first question's request has no earlier-question summary", async () => {
  const original = globalThis.fetch;
  const sent: any[] = [];
  globalThis.fetch = fixtureFetch(sent);
  try {
    await checkBridge();
    const g = createRecord(45, r, initialStudy(r, "live"));
    await ensureProblem(g, g.encounters["question-0"], r);
    assert.equal("earlierQuestions" in sent[0], false);
  } finally {
    globalThis.fetch = original;
    await checkBridge();
  }
});

test("regenerate carries the replaced question's asks and keeps it out of the history", async () => {
  const original = globalThis.fetch;
  const sent: any[] = [];
  globalThis.fetch = fixtureFetch(sent);
  try {
    await checkBridge();
    const g: any = createRecord(44, r, initialStudy(r, "live"));
    const e = g.encounters["question-0"];
    e.studyOnly = true;
    issue(g, "question-0", 5, {
      staged: {
        shared: "Shared facts",
        parts: ["First ask text", "Second ask text"],
      },
    });
    e.state = "in-progress";
    issue(g, "question-1", 4);
    assert.equal(regenerateQuestion(g, e, r), true);
    const payload: any = e.pendingGeneration!.payload;
    assert.deepEqual(payload.replaces.asks, [
      "First ask text",
      "Second ask text",
    ]);
    assert.equal(payload.replaces.title, "Title question-0");
    assert.deepEqual(
      payload.earlierQuestions.map((x: any) => x.title),
      ["Title question-1"],
    );
    await ensureProblem(g, e, r);
    // JSON round trip: the transport drops undefined optional fields.
    assert.deepEqual(sent[0], JSON.parse(JSON.stringify(payload)));
    assert.equal(e.pendingGeneration, undefined);
  } finally {
    globalThis.fetch = original;
    await checkBridge();
  }
});

/** Like fixtureFetch, but each generate reply is chosen by its call number. */
function scriptedFetch(sent: any[], reply: (call: number, c: any) => Response) {
  return (async (input: unknown, init?: RequestInit) => {
    if (String(input) === "/api/status")
      return Response.json({
        mode: "claude-cli",
        label: "Isolated question design fixture",
        capabilities: ["generate", "tutor", "assess"],
        detail: "Test fixture only; not a native Study Mode verification.",
      });
    const body = JSON.parse(String(init?.body));
    sent.push(structuredClone(body.payload));
    return reply(sent.length - 1, body.payload.contract);
  }) as typeof fetch;
}
const fixtureProblem = (c: any, contract = c) => ({
  title: "Fixture question",
  prompt: "Isolated pipeline fixture.",
  starter: "",
  rubric: ["scope"],
  contract,
  scopeDefinitions: [
    {
      id: `${c.objectiveIds[0]}/D${c.depth}`,
      objectiveId: c.objectiveIds[0],
      depth: c.depth,
      sourceScope: c.scopes[0],
      facets: [{ id: "scope", description: "Complete scope fixture" }],
    },
  ],
});

test("a reply the app refuses is retried under a fresh request identity", async () => {
  const original = globalThis.fetch;
  const sent: any[] = [];
  globalThis.fetch = scriptedFetch(sent, (call, c) =>
    Response.json(fixtureProblem(c, call ? c : { ...c, depth: c.depth + 1 })),
  );
  try {
    await checkBridge();
    const g: any = createRecord(46, r, initialStudy(r, "live"));
    const e = g.encounters["question-0"];
    await ensureProblem(g, e, r);
    assert.equal(e.problem, undefined);
    assert.ok(e.error);
    const first = sent[0];
    assert.notEqual(e.pendingGeneration.requestId, first.requestId);
    assert.equal(
      e.pendingGeneration.payload.requestId,
      e.pendingGeneration.requestId,
    );
    // Only the identity changes; the captured request is otherwise the same.
    assert.deepEqual(
      JSON.parse(
        JSON.stringify({
          ...e.pendingGeneration.payload,
          requestId: first.requestId,
        }),
      ),
      first,
    );
    await ensureProblem(g, e, r);
    assert.equal(sent.length, 2);
    assert.notEqual(sent[1].requestId, first.requestId);
    assert.deepEqual(sent[1].contract, first.contract);
    assert.equal(e.problem?.title, "Fixture question");
    assert.equal(e.pendingGeneration, undefined);
  } finally {
    globalThis.fetch = original;
    await checkBridge();
  }
});

test("a transport failure keeps the saved request identity", async () => {
  const original = globalThis.fetch;
  const sent: any[] = [];
  globalThis.fetch = scriptedFetch(sent, () =>
    Response.json({ error: "Synthetic outage" }, { status: 503 }),
  );
  try {
    await checkBridge();
    const g: any = createRecord(47, r, initialStudy(r, "live"));
    const e = g.encounters["question-0"];
    await ensureProblem(g, e, r);
    const saved = structuredClone(e.pendingGeneration);
    await ensureProblem(g, e, r);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1], sent[0]);
    assert.equal(e.pendingGeneration.requestId, saved.requestId);
  } finally {
    globalThis.fetch = original;
    await checkBridge();
  }
});

test("minimum evidence leads generation and tutoring, and the shape rules come last", () => {
  const generate: string = taskInstructions("generate", {});
  const tutor: string = taskInstructions("tutor", {});
  const assess: string = taskInstructions("assess", {});
  for (const text of [generate, tutor])
    assert.ok(text.includes(MINIMUM_EVIDENCE_GUIDANCE));
  assert.doesNotMatch(generate, /patient study tutor approach/);
  assert.match(tutor, /patient study tutor approach/);
  // The shape block is the last thing the generator reads, and is sent once.
  assert.ok(generate.endsWith(QUESTION_SHAPE_GUIDANCE));
  assert.equal(generate.split(QUESTION_DESIGN_GUIDANCE).length, 2);
  assert.match(
    generate,
    /never drop a fact a correct answer needs; beyond that, cut/,
  );
  assert.match(
    generate,
    /one facet per distinct understanding, never one per list member/,
  );
  assert.match(generate, /ask for one of each kind and no more/);
  assert.match(
    generate,
    /Add an ask only when it tests something the first does not/,
  );
  // Each part asks for one thing, so a compound ask is split or cut.
  assert.match(
    generate,
    /a part asks for exactly one answer about one subject/,
  );
  assert.match(generate, /never merge asks to lower the part count/);
  assert.match(generate, /if it requests more than one answer/);
  assert.match(generate, /pick a real project of their own/);
  assert.match(generate, /at most four one-line facts/);
  assert.match(generate, /a learner who already has this skill needs/);
  assert.match(
    generate,
    /payload\.earlierQuestions[^.]*:[^.]*different scenario and a different shape of ask/,
  );
  assert.match(
    generate,
    /a fact only one part needs goes in that part's own text/,
  );
  assert.match(
    tutor,
    /A complete correct answer ends the question, or the part, at once/,
  );
  assert.match(tutor, /a reason that was not asked for is not required/);
  assert.match(
    PROBE_STANCE,
    /Facets of the same kind[^.]*are one facet repeated/,
  );
  assert.match(
    TERMINAL_DIALOGUE_INSTRUCTION,
    /as soon as the learner's messages and saved work supply a correct and complete answer/,
  );
  assert.match(
    assess,
    /never lower an outcome because a correct answer was short/,
  );
});
