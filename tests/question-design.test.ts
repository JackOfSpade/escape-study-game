import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-expect-error Direct .mjs contract test.
import { taskInstructions } from "../scripts/lib/ai-contracts.mjs";
import { checkBridge, ensureProblem } from "../src/ai";
import { eligible, initialStudy } from "../src/curriculum";
import {
  PROBE_STANCE,
  TERMINAL_DIALOGUE_INSTRUCTION,
} from "../src/knowledge-probe";
import type { Roadmap } from "../src/model";
import { createPlayableGame } from "../src/world";
import {
  QUESTION_DESIGN_GUIDANCE,
  QUESTION_ADAPTATION_GUIDANCE,
} from "../scripts/lib/study-question-policy.mjs";

const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));

const minimalPolicy = [
  /smallest self-contained diagnostic that exercises the objective/,
  /one main problem and at most one or two directly connected follow-ups/,
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
        capabilities: ["generate", "tutor", "group", "complete", "assess"],
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
    const g = createPlayableGame(41, r, initialStudy(r, "live"));
    g.status = "playing";
    const e = g.encounters[g.floors[0].stations[0].encounter];
    await ensureProblem(g, e, r);
    assert.equal(sent.length, 1);
    assert.equal(e.problem?.provenance, "claude-cli");
    const policy: string = sent[0].generationPolicy;
    assert.ok(policy.includes(QUESTION_DESIGN_GUIDANCE));
    for (const requirement of minimalPolicy) assert.match(policy, requirement);
    // Earlier policy remains intact; refinements are appended.
    assert.match(policy, /prompt alone must supply.*without using the chat/);
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
    const g = createPlayableGame(42, r, initialStudy(r, "live"));
    g.status = "playing";
    const e = g.encounters[g.floors[0].stations[0].encounter];
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
  assert.match(job.instructions, /prompt must stand on its own/);
  assert.doesNotMatch(job.instructions, /establishes the most at once/);
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

test("the terminal helper line asks focused questions without most-at-once pressure", () => {
  const source = readFileSync("src/main.ts", "utf8");
  assert.match(
    source,
    /Terminal AI assumes you already know this and asks one focused question at a time/,
  );
  assert.doesNotMatch(source, /establishes the most at once/);
});
