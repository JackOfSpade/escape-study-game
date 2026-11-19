import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkBridge, ensureProblem, send } from "../src/ai";
import { knowledgeGapContext, probeFacets } from "../src/knowledge-probe";
import type { Roadmap } from "../src/model";
import { createPlayableGame } from "./helpers/record";
import { preparePracticeRooms } from "./helpers/practice-questions";
// @ts-expect-error The gateway is intentionally plain JavaScript.
import { buildPrompt } from "../scripts/claude-gateway.mjs";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);

/** The tutor payloads the app really sends over one question's turns. */
async function conversation(replies: Record<string, unknown>[]) {
  const original = globalThis.fetch;
  const payloads: any[] = [];
  let connected = false;
  let reply: Record<string, unknown> = { text: "Go on.", complete: false };
  globalThis.fetch = async (url, init) => {
    if (String(url) === "/api/status")
      return Response.json({
        mode: connected ? "claude-cli" : "development",
        label: "Synthetic",
        detail: "No real AI",
        capabilities: connected ? ["tutor"] : [],
      });
    const body = JSON.parse(String(init?.body));
    if (body.operation === "tutor") payloads.push(body.payload);
    return Response.json(reply);
  };
  try {
    await checkBridge();
    const g: any = createPlayableGame(717, roadmap);
    preparePracticeRooms(g, roadmap);
    const e: any = g.encounters["question-0"];
    await ensureProblem(g, e, roadmap);
    e.mode = "solo";
    e.owner = "human";
    g.study.profile = "live";
    connected = true;
    await checkBridge();
    const facets = probeFacets(e.problem);
    for (const [turn, next] of replies.entries()) {
      reply = JSON.parse(
        JSON.stringify(next).replaceAll("$FACET", facets[0].id),
      );
      await send(g, e, `Synthetic answer ${turn + 1}`, roadmap);
      assert.equal(e.tutorRequests.at(-1).state, "applied");
    }
    return { payloads, g };
  } finally {
    connected = false;
    await checkBridge();
    globalThis.fetch = original;
  }
}

test("consecutive tutor turns of one question share a byte-identical system prompt that holds the bulk of the request", async () => {
  const { payloads, g } = await conversation([
    { text: "What leaves the window?", complete: false },
    // This reply establishes a facet, which the next request reports.
    {
      text: "And the boundary?",
      complete: false,
      knowledge: { facets: [{ id: "$FACET", status: "demonstrated" }] },
    },
    // This one declares a part the question did not list.
    {
      text: "Which part is unclear?",
      complete: false,
      knowledge: {
        facets: [
          {
            id: "synthetic-part",
            status: "gap",
            partOf: "$FACET",
            description: "A synthetic prerequisite part",
          },
        ],
      },
    },
    { text: "Go on.", complete: false },
    { text: "Go on.", complete: false },
  ]);
  assert.equal(payloads.length, 5);
  // The turns really did change the learner's record between requests.
  assert.equal(g.study.knowledgeEstablished.length, 1);
  assert.notEqual(
    payloads[2].progressContext,
    payloads[1].progressContext,
    "an established facet reaches the next request",
  );
  assert.notDeepEqual(
    payloads[4].probe.facets,
    payloads[0].probe.facets,
    "a declared part joins the probe's facets",
  );

  const prompts = payloads.map((payload) => buildPrompt("tutor", payload));
  for (const [turn, prompt] of prompts.entries()) {
    assert.equal(prompt.compact, undefined);
    assert.equal(
      prompt.system,
      prompts[0].system,
      `turn ${turn + 1} must reuse the first turn's cached system prompt`,
    );
    // What is left for the message is the small per-turn remainder.
    assert.ok(
      prompt.user.length < prompt.system.length / 10,
      `turn ${turn + 1} resends ${prompt.user.length} characters beside a ${prompt.system.length}-character system prompt`,
    );
  }

  // The stable material comes before anything a turn can change.
  const first = prompts[0];
  for (const text of [
    payloads[0].instruction,
    payloads[0].curriculum,
    payloads[0].problem.prompt,
    payloads[0].probe.stance,
  ]) {
    const quoted = JSON.stringify(text).slice(1, -1);
    assert.ok(first.system.includes(quoted));
    assert.ok(!first.user.includes(quoted));
  }

  // Nothing is lost: both halves together still carry every changing part.
  const last = JSON.parse(prompts[4].user);
  assert.deepEqual(last.probe.facets, payloads[4].probe.facets);
  assert.deepEqual(
    last.topicAssessmentContext.observations,
    payloads[4].topicAssessmentContext.observations,
  );
  assert.match(
    last.progressContext,
    /already established at earlier terminals/,
  );
  const reference = JSON.parse(
    first.system.slice(first.system.indexOf('\n{"instruction"') + 1),
  );
  assert.equal(
    reference.progressContext + last.progressContext,
    payloads[4].progressContext,
  );
  assert.deepEqual(
    { ...reference.topicAssessmentContext, ...last.topicAssessmentContext },
    payloads[4].topicAssessmentContext,
  );

  // Gap notes, open or closed, are written by the app with openings the
  // gateway must recognise, or they would rewrite the whole cached prompt.
  const track = payloads[0].problem.contract.track;
  const gap = (id: string, resolved?: boolean) => ({
    id,
    track,
    objectiveIds: payloads[0].problem.contract.objectiveIds,
    depth: payloads[0].problem.contract.depth,
    facet: { id, description: `Synthetic gap ${id}` },
    statement: "Synthetic statement",
    ...(resolved ? { resolved: { at: "2026-01-01T00:00:00.000Z" } } : {}),
  });
  const fixed = reference.progressContext;
  for (const gaps of [[gap("open")], [gap("closed", true)]]) {
    g.study.knowledgeEstablished = [];
    g.study.knowledgeGaps = gaps;
    const notes = knowledgeGapContext(g, track);
    assert.ok(notes.length > 0);
    const prompt = buildPrompt("tutor", {
      ...payloads[0],
      progressContext: `${fixed}\n\n${notes}`,
    });
    assert.equal(prompt.system, first.system);
    assert.equal(JSON.parse(prompt.user).progressContext, `\n\n${notes}`);
  }
});
