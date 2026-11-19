import { expect, test } from "@playwright/test";
import {
  flushStudySave,
  mockClaudeStudy,
  openStudyQuestion,
  studyState,
} from "./study-harness";

const help = { nudges: [], hints: [], gives: [], offers: [] };

test("a question with several asks is shown and answered one part at a time", async ({
  page,
}) => {
  const relay = await mockClaudeStudy(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  relay.question({
    prompt: "SHARED scenario with the fixed facts.",
    parts: ["FIRST ask about the scenario.", "SECOND ask about the scenario."],
  });
  const id = await openStudyQuestion(page);
  const problem = page.locator("#problem");
  const open = problem.locator(".question-part");
  const say = async (text: string) => {
    await page.locator("#chat-input").fill(text);
    await page.locator("#chat-input").press("Enter");
  };

  // Only the shared material and the first part are on screen.
  await expect(problem).toContainText("SHARED scenario");
  await expect(open).toContainText("Part 1 of 2");
  await expect(open).toContainText("FIRST ask");
  await expect(problem).not.toContainText("SECOND ask");

  // An unfinished part stays; the tutor is told which part is open.
  relay.reply(() => ({
    help,
    text: "Still missing the reason.",
    complete: false,
    partComplete: false,
  }));
  await say("A first attempt");
  await expect(page.locator("#messages")).toContainText("Still missing");
  expect(relay.tutorCalls()[0].payload.stage).toEqual({
    part: 1,
    of: 2,
    question: "FIRST ask about the scenario.",
  });
  await expect(open).toContainText("FIRST ask");

  // A reply that finishes the question while a part is hidden is withheld.
  relay.reply(() => ({ help, text: "EARLY FINISH", complete: true }));
  await say("A second attempt");
  await expect(page.locator("button[data-question-retry]")).toBeVisible();
  await expect(page.locator("#messages")).not.toContainText("EARLY FINISH");
  expect((await studyState(page, id)).state).not.toBe("consumed");

  // The tutor confirms the part: the next one takes its place.
  relay.reply(() => ({
    help,
    text: "Accepted: that covers the first part.",
    complete: false,
    partComplete: true,
  }));
  await page.locator("button[data-question-retry]").click();
  await expect(open).toContainText("Part 2 of 2");
  await expect(open).toContainText("SECOND ask");
  await expect(open).not.toContainText("FIRST ask");
  await expect(problem).toContainText("SHARED scenario");
  await expect(page.locator("#messages .message-part")).toContainText(
    "Part 1 of 2 answered",
  );
  // The finished part is kept out of the way, one click from view.
  const earlier = problem.locator("details.earlier-parts");
  await expect(earlier).not.toHaveAttribute("open", "");
  await earlier.locator("summary").click();
  await expect(earlier).toContainText("FIRST ask");

  // The open part survives a reload.
  await flushStudySave(page);
  await page.reload();
  await expect(open).toContainText("Part 2 of 2");

  // The last part finishes the whole question, which then shows every part.
  relay.solve("Solved: both parts are covered.");
  await say("My answer to the second part");
  await expect(
    page.locator("#messages .message-complete").last(),
  ).toContainText("Question complete");
  expect(relay.tutorCalls().at(-1).payload.stage.part).toBe(2);
  expect((await studyState(page, id)).state).toBe("consumed");
  await expect(problem.locator(".question-part-done")).toHaveCount(2);
  await expect(problem).toContainText("FIRST ask");
  await expect(problem).toContainText("SECOND ask");
  expect(errors).toEqual([]);
});

test("a question with one ask is shown whole", async ({ page }) => {
  const relay = await mockClaudeStudy(page);
  relay.question({ prompt: "SHARED scenario.", parts: ["The ONLY ask."] });
  await openStudyQuestion(page);
  const problem = page.locator("#problem");
  await expect(problem).toContainText("SHARED scenario.");
  await expect(problem).toContainText("The ONLY ask.");
  await expect(problem.locator(".question-part")).toHaveCount(0);
  relay.reply(() => ({ help, text: "Go on.", complete: false }));
  await page.locator("#chat-input").fill("An attempt");
  await page.locator("#chat-input").press("Enter");
  await expect(page.locator("#messages")).toContainText("Go on.");
  expect(relay.tutorCalls()[0].payload.stage).toBeUndefined();
});
