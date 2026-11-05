import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { ensureProblem } from "../src/ai";
import { checkBridge } from "../src/bridge-client";
import { connectionSteps } from "../src/connection-steps";
import { initialStudy } from "../src/curriculum";
import { moveToLiveStudy } from "../src/live-study";
import type { Roadmap } from "../src/model";
import { npcThinkingRate } from "../src/npc-cognition";
import { createPlayableGame } from "../src/world";
import { devProblem, preparePracticeRooms } from "./helpers/practice-questions";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
const statusReply = (body: unknown) => async () => Response.json(body);
const roomEncounters = (g: ReturnType<typeof createPlayableGame>) =>
  Object.values(g.encounters).filter((e) => e.questionRoom);

test("game source has no local questions to fall back on", () => {
  for (const file of readdirSync("src"))
    if (file.endsWith(".ts"))
      assert.doesNotMatch(
        readFileSync(`src/${file}`, "utf8"),
        /devProblem|practice-problem|product-practice|preparePracticeRooms/,
        file,
      );
});

test("a new live run gives no room a question until Claude writes one", () => {
  const g = createPlayableGame(42, roadmap, initialStudy(roadmap, "live"));
  assert.ok(roomEncounters(g).length > 0);
  for (const e of roomEncounters(g)) assert.equal(e.problem, undefined);
});

test("without Claude, opening a terminal asks nothing and invents no question", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = statusReply({
    mode: "development",
    label: "Claude not connected",
    reason: "signed-out",
    capabilities: [],
    detail: "Claude CLI is not signed in.",
  }) as typeof fetch;
  await checkBridge();
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    throw Error("no request expected");
  }) as typeof fetch;
  const g = createPlayableGame(42, roadmap, initialStudy(roadmap, "live"));
  const e = roomEncounters(g)[0];
  await ensureProblem(g, e, roadmap);
  assert.equal(e.problem, undefined);
  assert.ok(e.error);
  assert.equal(requests, 0);
});

test("NPCs keep working in a room nobody has opened", () => {
  const g = createPlayableGame(42, roadmap, initialStudy(roadmap, "live"));
  const e = roomEncounters(g)[0];
  const npc = g.survivors[1];
  assert.equal(e.problem, undefined);
  assert.ok(npcThinkingRate(npc, e) > 0);
});

test("a saved practice run moves to live and keeps its learning", () => {
  const g = createPlayableGame(42, roadmap);
  preparePracticeRooms(g, roadmap);
  const learner = g.study.learner;
  const assessments = g.study.assessments;
  const [open, solved] = roomEncounters(g);
  open.owner = "human";
  open.workspace = "practice answer";
  open.revision = 3;
  open.problemPresentedSequence = 5;
  solved.state = "consumed";
  const solvedProblem = solved.problem;

  assert.equal(moveToLiveStudy(g, roadmap), true);

  assert.equal(g.study.profile, "live");
  assert.equal(g.study.learner, learner);
  assert.equal(g.study.assessments, assessments);
  assert.equal(open.problem, undefined);
  assert.equal(open.state, "available");
  assert.equal(open.owner, undefined);
  assert.equal(open.workspace, "");
  assert.equal(open.revision, 0);
  assert.equal(open.problemPresentedSequence, undefined);
  assert.equal(solved.state, "consumed");
  assert.equal(solved.problem, solvedProblem);
  assert.equal(moveToLiveStudy(g, roadmap), false);
});

test("moving to live keeps knowledge records and never spreads an old practice question", async (t) => {
  const g = createPlayableGame(42, roadmap);
  preparePracticeRooms(g, roadmap);
  g.study.version = 9;
  g.study.knowledgeGaps = [{ id: "gap" } as never];
  g.study.knowledgeEstablished = [{ id: "known" } as never];
  const room = roomEncounters(g)[0].questionRoom;
  const peers = roomEncounters(g).filter((e) => e.questionRoom === room);
  assert.ok(peers.length > 1);
  const [solved, open] = peers;
  solved.state = "consumed";
  open.npcProgress = 0.9;
  moveToLiveStudy(g, roadmap);
  assert.equal(g.study.version, 9);
  assert.equal(g.study.knowledgeGaps?.length, 1);
  assert.equal(g.study.knowledgeEstablished?.length, 1);
  assert.equal(open.npcProgress, 0);

  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = statusReply({
    mode: "development",
    label: "",
    reason: "signed-out",
    capabilities: [],
    detail: "",
  }) as typeof fetch;
  await checkBridge();
  await ensureProblem(g, open, roadmap);
  assert.equal(open.problem, undefined);
});

test("moving to live leaves questions Claude already wrote alone", () => {
  const g = createPlayableGame(42, roadmap);
  const e = roomEncounters(g)[0];
  e.problem = { ...devProblem(g, roadmap), provenance: "claude-cli" };
  e.state = "in-progress";
  moveToLiveStudy(g, roadmap);
  assert.equal(e.problem?.provenance, "claude-cli");
  assert.equal(e.state, "in-progress");
});

test("each cause of a lost connection gets its own steps", () => {
  const commands = (reason?: "cli-missing" | "signed-out" | "gateway-off") =>
    connectionSteps({
      mode: "development",
      label: "",
      capabilities: [],
      detail: "",
      reason,
    }).steps.flatMap((s) => (s.command ? [s.command] : []));
  assert.deepEqual(commands("signed-out"), ["claude auth login"]);
  assert.deepEqual(commands("cli-missing"), [
    "curl -fsSL https://claude.ai/install.sh | bash",
    "claude auth login",
  ]);
  assert.deepEqual(commands("gateway-off"), ["npm run bridge:start"]);
  assert.deepEqual(commands(), ["npm run bridge:start"]);
});
