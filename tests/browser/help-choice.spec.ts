import { expect, test } from "@playwright/test";
import { mockClaudeStudy, openStudyQuestion } from "./study-harness";

test("help that costs credit waits for the learner's explicit choice", async ({
  page,
}) => {
  const relay = await mockClaudeStudy(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openStudyQuestion(page);
  const choice = page.locator("#help-choice");
  await expect(choice).toBeHidden();

  // A typed message confirms nothing; the tutor can only offer.
  relay.reply(() => ({
    help: { supplies: [], offers: ["scope"] },
    text: "Answering that counts as help on this part. Do you want it?",
    complete: false,
  }));
  await page.locator("#chat-input").fill("Does the loop run once?");
  await page.locator("#chat-input").press("Enter");
  await expect.poll(() => relay.tutorCalls().length).toBe(1);
  expect(relay.tutorCalls()[0].payload.helpPolicy).toEqual({ confirmed: [] });
  await expect(choice).toBeVisible();

  // Trying again only returns to the message box.
  await page.locator("#help-retry").click();
  await expect(page.locator("#chat-input")).toBeFocused();
  expect(relay.tutorCalls()).toHaveLength(1);

  // A reply that supplies unconfirmed help is withheld, never shown.
  relay.reply(() => ({
    help: { supplies: ["scope"], offers: [] },
    text: "LEAKED ANSWER",
    complete: false,
  }));
  await page.locator("#chat-input").fill("Just a guess then");
  await page.locator("#chat-input").press("Enter");
  await expect.poll(() => relay.tutorCalls().length).toBe(2);
  await expect(page.locator("button[data-question-retry]")).toBeVisible();
  await expect(page.locator("#messages")).not.toContainText("LEAKED ANSWER");
  await expect(choice).toBeHidden();

  // The retry offers again; the button is the confirmation the tutor needs.
  relay.reply(() => ({
    help: { supplies: [], offers: ["scope"] },
    text: "That would count as help. Do you want it?",
    complete: false,
  }));
  await page.locator("button[data-question-retry]").click();
  await expect.poll(() => relay.tutorCalls().length).toBe(3);
  await expect(choice).toBeVisible();
  relay.reply(() => ({
    help: { supplies: ["scope"], offers: [] },
    text: "CONFIRMED HELP",
    complete: false,
  }));
  await page.locator("#help-accept").click();
  await expect.poll(() => relay.tutorCalls().length).toBe(4);
  expect(relay.tutorCalls()[3].payload.helpPolicy).toEqual({
    confirmed: ["scope"],
  });
  await expect(page.locator("#messages")).toContainText("CONFIRMED HELP");
  await expect(choice).toBeHidden();
  expect(errors).toEqual([]);
});
