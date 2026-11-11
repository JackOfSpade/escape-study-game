/**
 * Manual capture: play real live questions and let a simulated learner talk to
 * the real tutor. Every generate/tutor/complete/assess call goes to the real
 * local relay; nothing under /api is mocked here.
 */
import { expect, test, type Page } from "@playwright/test";
import { enterNativeGame, openNativeQuestion } from "../browser/study-harness";
import {
  PERSONAS,
  askLearner,
  type CaptureQuestion,
  type TranscriptTurn,
} from "./learner";
import {
  countBridgeCalls,
  questionAccepted,
  readQuestion,
  sendChat,
  tutorTurnCount,
  waitForBridgeIdle,
  waitForTutorReply,
  type BridgeCounter,
} from "./support";

const QUESTIONS = Math.max(1, Number(process.env.CAPTURE_QUESTIONS ?? "8"));
const MAX_TURNS = 4;
const REPLY_TIMEOUT_MS = 5 * 60_000;

/**
 * Move the next unused station to the front (the harness opens stations[0])
 * and reset its encounter so the real relay is asked for a fresh question
 * instead of replaying the previous cycle.
 */
async function prepareStation(page: Page, index: number) {
  await page.evaluate((offset) => {
    const g = (window as any).__deadAir.game;
    // The harness always opens floor 0's first station, so rotate within it.
    const list = g.floors[0].stations as any[];
    const target = list[offset % list.length];
    list.splice(list.indexOf(target), 1);
    list.unshift(target as any);
    const e = g.encounters[target.encounter];
    delete e.problem;
    delete e.probe;
    e.state = "open";
    e.accepted = false;
    e.workspace = "";
    e.tutor = [];
    e.submissions = [];
    e.tutorRequests = [];
    e.groupRequests = [];
    e.mode = "solo";
    e.owner = "human";
    Object.assign(g.survivors[0], { floor: 0, x: target.x, y: target.y });
  }, index);
}

/** One full question: real generate, up to 4 tutor turns, then complete. */
async function runQuestion(
  page: Page,
  index: number,
  counter: BridgeCounter,
): Promise<{ persona: string; turns: number; completed: boolean }> {
  await prepareStation(page, index);
  const id = await openNativeQuestion(page, "live");
  const question: CaptureQuestion = await readQuestion(page, id);
  const persona = PERSONAS[index % PERSONAS.length];
  const transcript: TranscriptTurn[] = [];
  let lastLearner = "";
  let turns = 0;
  for (; turns < MAX_TURNS; turns++) {
    lastLearner = await askLearner(persona, question, transcript);
    transcript.push({ role: "learner", text: lastLearner });
    const before = await tutorTurnCount(page, id);
    await sendChat(page, lastLearner);
    const reply = await waitForTutorReply(page, id, before, REPLY_TIMEOUT_MS);
    if (reply) transcript.push({ role: "tutor", text: reply });
    // The tutor may finish the question itself; then stop early.
    if (await questionAccepted(page, id)) {
      turns++;
      break;
    }
  }
  // The native terminal has no separate submit step: the tutor's own
  // `complete` decision finishes the question. Unfinished questions are kept
  // as they are; their tutor turns are still useful samples.
  const completed = await questionAccepted(page, id);
  // Assessment of a finished question runs after it; give it time to land.
  await waitForBridgeIdle(page, counter, REPLY_TIMEOUT_MS);
  return { persona: persona.id, turns, completed };
}

test("live questions capture generate, tutor, complete and assess samples", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const counter = countBridgeCalls(page);
  let captured = 0;
  try {
    for (let index = 0; index < QUESTIONS; index++) {
      // A fresh page (and a fresh real generate call) per question. One
      // question that never loads must not cost the rest of the run.
      try {
        await enterNativeGame(page);
        const summary = await runQuestion(page, index, counter);
        captured++;
        console.log(
          `[study] question ${index + 1}/${QUESTIONS} persona=${summary.persona} turns=${summary.turns} completed=${summary.completed}`,
        );
      } catch (error) {
        console.log(
          `[study] question ${index + 1}/${QUESTIONS} skipped: ${String(error).slice(0, 200)}`,
        );
      }
    }
  } finally {
    console.log(`[study] bridge calls ${JSON.stringify(counter.counts())}`);
    counter.stop();
  }
  expect(captured).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
});
