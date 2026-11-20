import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-expect-error Direct .mjs contract test.
import { taskInstructions, validateAnswer } from "../scripts/lib/ai-contracts.mjs"; // prettier-ignore
import {
  closesPart,
  composePrompt,
  partReplyProblem,
  compoundPartProblem,
  partRequests,
  partsProblem,
  stagedParts,
} from "../scripts/lib/question-parts.mjs";
import {
  checkBridge,
  ensureProblem,
  regenerateQuestion,
  send,
} from "../src/ai";
import { initialStudy } from "../src/curriculum";
import { probeFacets } from "../src/knowledge-probe";
import type { Encounter, Roadmap } from "../src/model";
import {
  advancePart,
  openPartSince,
  nextPartOffer,
  openPart,
  partMarkers,
  questionHtml,
  requestStage,
} from "../src/question-parts";
import { localHandoff } from "./helpers/local-handoff";
import { preparePracticeRooms } from "./helpers/practice-questions";
import { createGame } from "./helpers/record";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
const noHelp = { nudges: [], hints: [], gives: [], offers: [] };
const staged = (
  partsDone?: number[],
  state: Encounter["state"] = "in-progress",
) =>
  ({
    state,
    partsDone,
    problem: {
      prompt: "ignored when staged",
      staged: { shared: "SHARED facts", parts: ["FIRST ask", "SECOND ask"] },
    },
  }) as unknown as Encounter;

test("generated parts are validated and composed into one whole prompt", () => {
  assert.equal(partsProblem(undefined), undefined);
  assert.equal(partsProblem(["One ask"]), undefined);
  for (const bad of [[], "one", [""], ["a", 2]])
    assert.match(partsProblem(bad) ?? "", /parts must be an array/);
  // The number of parts has no limit.
  assert.equal(partsProblem(Array(12).fill("ask")), undefined);
  assert.equal(composePrompt("Scenario.", ["Why?"]), "Scenario.\n\nWhy?");
  assert.equal(
    composePrompt("Scenario.", ["Why?", "What next?"]),
    "Scenario.\n\n**Part 1 of 2**\n\nWhy?\n\n**Part 2 of 2**\n\nWhat next?",
  );
  // One ask, or none recorded, is a question shown whole.
  assert.equal(
    stagedParts({ staged: { shared: "s", parts: ["only"] } }),
    undefined,
  );
  assert.equal(stagedParts({ prompt: "plain" }), undefined);
  assert.deepEqual(stagedParts({ staged: { shared: "s", parts: ["a", "b"] } }), ["a", "b"]); // prettier-ignore
});

test("the tutor contract and validators enforce one part at a time", () => {
  assert.match(taskInstructions("generate", {}), /One part at a time/);
  assert.match(taskInstructions("tutor", {}), /payload\.stage is present/);
  const first = { stage: { part: 1, of: 2, question: "FIRST ask" } };
  const last = { stage: { part: 2, of: 2, question: "SECOND ask" } };
  assert.equal(partReplyProblem({}, { complete: true }), undefined);
  assert.equal(partReplyProblem(last, { complete: true }), undefined);
  assert.match(
    partReplyProblem(first, { complete: true }) ?? "",
    /only seen part 1 of 2/,
  );
  assert.match(
    partReplyProblem(first, { complete: false, partComplete: "yes" }) ?? "",
    /partComplete must be true or false/,
  );
  assert.equal(
    closesPart(first, { complete: false, partComplete: true }),
    true,
  );
  assert.equal(closesPart(first, { complete: false }), false);
  // The last part is closed by finishing the question, never by partComplete.
  assert.equal(
    closesPart(last, { complete: false, partComplete: true }),
    false,
  );
  assert.equal(closesPart({}, { complete: false, partComplete: true }), false);
  const job = (payload: object) => ({
    operation: "tutor",
    payload: { mode: "terminal-dialogue", helpPolicy: { unlocked: [] }, ...payload }, // prettier-ignore
  });
  assert.throws(
    () => validateAnswer(job(first), { help: noHelp, text: "Done", complete: true }), // prettier-ignore
    /cannot be complete yet/,
  );
  validateAnswer(job(first), { help: noHelp, text: "Accepted.", complete: false, partComplete: true }); // prettier-ignore
  validateAnswer(job(last), { help: noHelp, text: "Done", complete: true });
});

test("the question pane shows the shared material with the open part only", () => {
  assert.deepEqual(openPart(staged()), { part: 1, of: 2, question: "FIRST ask" }); // prettier-ignore
  assert.equal(openPart(staged([7]))?.part, 2);
  assert.equal(openPart({ problem: { prompt: "plain" } } as Encounter), undefined); // prettier-ignore
  const one = questionHtml(staged());
  assert.match(one, /SHARED facts/);
  assert.match(one, /class="question-part" data-part="1"/);
  assert.match(one, /Part 1 of 2/);
  assert.doesNotMatch(one, /SECOND ask|earlier-parts/);
  const two = questionHtml(staged([7]));
  assert.match(two, /class="question-part" data-part="2"[^]*SECOND ask/);
  assert.match(two, /<details class="earlier-parts">[^]*FIRST ask/);
  // A finished question shows every part, with nothing left to fade.
  const done = questionHtml(staged([7], "consumed"));
  assert.match(done, /FIRST ask[^]*SECOND ask/);
  assert.doesNotMatch(done, /class="question-part"|earlier-parts/);
  assert.equal(
    questionHtml({ state: "in-progress", problem: { prompt: "**Plain**" } } as Encounter), // prettier-ignore
    "<p><strong>Plain</strong></p>",
  );
  assert.match(partMarkers(staged([7])).get(7) ?? "", /Part 1 of 2 answered[^]*Part 2 follows/); // prettier-ignore
  assert.equal(partMarkers(staged()).size, 0);
});

test("a confirmed part waits for the learner, then the next one opens", () => {
  const e = staged();
  e.tutor = [{ seq: 4 }, { seq: 5 }] as Encounter["tutor"];
  // Nothing is offered until the tutor confirms the part.
  assert.equal(nextPartOffer(e), "");
  assert.equal(advancePart(e), false);
  e.partReady = 5;
  assert.match(nextPartOffer(e), /Part 1 of 2 answered[^]*data-next-part/);
  assert.doesNotMatch(nextPartOffer(e), /clears/);
  assert.deepEqual(requestStage(e), { part: 1, of: 2, question: "FIRST ask", confirmed: true }); // prettier-ignore
  assert.equal(openPartSince(e), undefined);
  // A follow-up on the confirmed part belongs to that part.
  e.tutor.push(...([{ seq: 6 }, { seq: 7 }] as Encounter["tutor"]));
  assert.equal(advancePart(e), true);
  assert.deepEqual(e.partsDone, [7]);
  assert.equal(e.partReady, undefined);
  assert.equal(openPartSince(e), 7);
  assert.equal(nextPartOffer(e), "");
  // The tutor is told which messages belong to the part now open.
  assert.deepEqual(requestStage(e), { part: 2, of: 2, question: "SECOND ask", since: 7 }); // prettier-ignore
  // The last part has nothing after it.
  e.partReady = 9;
  assert.equal(nextPartOffer(e), "");
  assert.equal(advancePart(e), false);
  assert.equal(requestStage({ problem: { prompt: "plain" } } as Encounter), undefined); // prettier-ignore
});

test("real bridge: a generated question is staged, worked part by part, and finished once", async () => {
  const original = globalThis.fetch;
  const relay = await localHandoff();
  const status = (mode: string) => async () =>
    Response.json({ mode, label: "Synthetic", detail: "No real AI", capabilities: [] }); // prettier-ignore
  try {
    globalThis.fetch = status("development");
    await checkBridge();
    const g = createGame(1, roadmap);
    preparePracticeRooms(g, roadmap);
    const e = g.encounters["question-0"];
    e.owner = "human";
    e.problem!.staged = { shared: "SHARED", parts: ["FIRST ask", "SECOND ask"] }; // prettier-ignore
    const facets = probeFacets(e.problem!);
    globalThis.fetch = (url, options) =>
      original(new URL(String(url), relay.base), {
        ...options,
        headers: { ...options?.headers, Origin: "http://127.0.0.1:5173" },
      });
    await checkBridge();
    const jobs: any[] = [];
    const accepted = {
      help: noHelp,
      text: "Accepted: that covers this part. You left one point open.",
      complete: false,
      partComplete: true,
      knowledge: { facets: [{ id: facets[0].id, status: "gap" }] },
    };
    relay.answerWith((job) => {
      jobs.push(job);
      return {
        valid: accepted,
        // Finishing while part 2 is still hidden is refused by the relay.
        invalid: [{ help: noHelp, text: "All done.", complete: true }],
      };
    });
    await send(g, e, "My answer to the first part; I do not know the rest", roadmap); // prettier-ignore
    assert.deepEqual(jobs[0].payload.stage, { part: 1, of: 2, question: "FIRST ask" }); // prettier-ignore
    assert.equal(relay.rejected, 1);
    assert.equal(e.state === "consumed", false);
    // The part is confirmed but stays open until the learner moves on.
    assert.equal(e.partReady, e.tutor.at(-1)!.seq);
    assert.deepEqual(e.partsDone ?? [], []);
    assert.equal(openPart(e)?.part, 1);
    assert.deepEqual(
      (g.study.knowledgeGaps ?? []).map((gap) => gap.facet.id),
      [facets[0].id],
      "a point given up when leaving a part is recorded as a gap",
    );

    // A follow-up before moving on is still about the confirmed part.
    relay.answerWith((job) => {
      jobs.push(job);
      return { valid: { help: noHelp, text: "Because of the fixed facts.", complete: false, partComplete: true } }; // prettier-ignore
    });
    await send(g, e, "Why was that accepted?", roadmap);
    assert.deepEqual(jobs[1].payload.stage, { part: 1, of: 2, question: "FIRST ask", confirmed: true }); // prettier-ignore
    const left = e.tutor.at(-1)!.seq;
    assert.equal(advancePart(e), true);
    assert.deepEqual(e.partsDone, [left]);
    assert.equal(openPart(e)?.part, 2);

    relay.answerWith((job) => {
      jobs.push(job);
      return { valid: { help: noHelp, text: "Solved.", complete: true, partComplete: true } }; // prettier-ignore
    });
    // The learner answers the new part without restating it: the request
    // names the part and where its messages start.
    await send(g, e, "It is the second one", roadmap);
    assert.deepEqual(jobs.at(-1).payload.stage, { part: 2, of: 2, question: "SECOND ask", since: left }); // prettier-ignore
    assert.equal(jobs.at(-1).payload.messages.length, e.tutor.length - 1, "the tutor still receives the earlier parts' conversation"); // prettier-ignore
    assert.equal(e.state, "consumed");
    assert.equal(e.partsDone!.length, 1);
    assert.equal(e.submissions.length, 1);
    // Chat after the question is finished carries no stage.
    relay.answerWith((job) => {
      jobs.push(job);
      return { valid: { text: "Happy to discuss." } };
    });
    await send(g, e, "One more thought", roadmap);
    assert.equal(jobs.at(-1).payload.stage, undefined);
  } finally {
    globalThis.fetch = status("development");
    await checkBridge();
    globalThis.fetch = original;
    await relay.close();
  }
});

test("a generated reply's parts become the stored staged question", async () => {
  const original = globalThis.fetch;
  let parts: unknown = ["FIRST ask", " SECOND ask "];
  try {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (String(input) === "/api/status")
        return Response.json({ mode: "claude-cli", label: "Fixture", capabilities: ["generate", "tutor", "assess"], detail: "Test fixture" }); // prettier-ignore
      const c = JSON.parse(String(init?.body)).payload.contract;
      return Response.json({
        title: "Fixture",
        prompt: "SHARED facts.",
        parts,
        // A reply cannot supply the staged form itself.
        staged: { shared: "forged", parts: ["x", "y"] },
        starter: "",
        rubric: ["fixture"],
        contract: c,
        estimatedSolveSeconds: 120,
        scopeDefinitions: c.objectiveIds.map((id: string, i: number) => ({
          id: `${id}/D${c.depth}`,
          objectiveId: id,
          depth: c.depth,
          sourceScope: c.scopes[i],
          facets: [{ id: "scope", description: "Synthetic scope" }],
        })),
      });
    }) as typeof fetch;
    await checkBridge();
    const g = createGame(1, roadmap, initialStudy(roadmap, "live"));
    const e = g.encounters["question-0"];
    e.studyOnly = true;
    await ensureProblem(g, e, roadmap);
    assert.equal(e.error, undefined);
    assert.deepEqual(e.problem!.staged, { shared: "SHARED facts.", parts: ["FIRST ask", "SECOND ask"] }); // prettier-ignore
    assert.match(e.problem!.prompt, /^SHARED facts\.\n\n\*\*Part 1 of 2\*\*\n\nFIRST ask/); // prettier-ignore
    assert.equal("parts" in e.problem!, false);
    // A discarded question starts its replacement at the first part.
    e.partsDone = [3];
    e.partReady = 9;
    assert.equal(regenerateQuestion(g, e, roadmap), true);
    assert.equal(e.partsDone, undefined);
    parts = ["Only ask"];
    await ensureProblem(g, e, roadmap);
    assert.equal(e.problem!.staged, undefined);
    assert.equal(e.problem!.prompt, "SHARED facts.\n\nOnly ask");
    regenerateQuestion(g, e, roadmap);
    parts = ["ok", ""];
    await ensureProblem(g, e, roadmap);
    assert.equal(e.problem, undefined);
    assert.match(e.error ?? "", /parts must be an array/);
  } finally {
    globalThis.fetch = async () =>
      Response.json({ mode: "development", label: "Cleanup", detail: "", capabilities: [] }); // prettier-ignore
    await checkBridge();
    globalThis.fetch = original;
  }
});

test("a part that asks for more than one thing is sent back, a single ask is not", () => {
  const single = [
    "For `TimerQueueA`, give the worst-case cost of one `schedule` in terms of the current size `k`.",
    "State is kept in Redis. Which key expires first, and why?",
    "Which would you use? Why?",
    "Implement `largest_group(latencies, k)` in Python.",
    "A teammate proposes removing the check. Is this a good design, and why?",
  ];
  for (const part of single) assert.equal(partRequests(part).length, 1, part);
  assert.equal(compoundPartProblem(single), undefined);
  assert.equal(compoundPartProblem(undefined), undefined);
  const compound = [
    "Which approach would you use, and why? Give its total time cost.",
    "For A, give the cost of one `schedule`. Do the same for B.",
    "Propose one guardrail metric. Say what harm it would catch.",
  ];
  for (const part of compound)
    assert.match(
      compoundPartProblem(["Which is faster, and why?", part]) ?? "",
      /^parts\[1\] asks for more than one thing/,
      part,
    );
  // Code is material, never a request.
  assert.equal(
    partRequests("```py\n# Give x? List y.\n```\nWhat does it print?").length,
    1,
  );
});
