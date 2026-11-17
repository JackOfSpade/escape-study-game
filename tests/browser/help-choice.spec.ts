import { expect, test } from "@playwright/test";
import { mockClaudeStudy, openStudyQuestion } from "./study-harness";

const help = (over: Record<string, string[]> = {}) => ({
  nudges: [],
  hints: [],
  gives: [],
  offers: [],
  ...over,
});

test("hints ramp up freely, then wait for one warning before costing credit", async ({
  page,
}) => {
  const relay = await mockClaudeStudy(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openStudyQuestion(page);
  const choice = page.locator("#help-choice");
  const say = async (text: string) => {
    await page.locator("#chat-input").fill(text);
    await page.locator("#chat-input").press("Enter");
  };
  await expect(choice).toBeHidden();

  // A free nudge needs no warning and shows no buttons.
  relay.reply(() => ({
    help: help({ nudges: ["scope"] }),
    text: "FREE NUDGE: that part is incomplete.",
    complete: false,
  }));
  await say("A first attempt");
  await expect.poll(() => relay.tutorCalls().length).toBe(1);
  expect(relay.tutorCalls()[0].payload.helpPolicy).toEqual({ unlocked: [] });
  await expect(page.locator("#messages")).toContainText("FREE NUDGE");
  await expect(choice).toBeHidden();

  // A hint before the warning is withheld, never shown.
  relay.reply(() => ({
    help: help({ hints: ["scope"] }),
    text: "EARLY HINT",
    complete: false,
  }));
  await say("A second attempt");
  await expect.poll(() => relay.tutorCalls().length).toBe(2);
  await expect(page.locator("button[data-question-retry]")).toBeVisible();
  await expect(page.locator("#messages")).not.toContainText("EARLY HINT");

  // The retry gives the one warning, which shows the shortcuts.
  relay.reply(() => ({
    help: help({ offers: ["scope"] }),
    text: "The next hint will be recorded as a hint. Do you want it?",
    complete: false,
  }));
  await page.locator("button[data-question-retry]").click();
  await expect.poll(() => relay.tutorCalls().length).toBe(3);
  await expect(choice).toBeVisible();
  await page.locator("#help-retry").click();
  await expect(page.locator("#chat-input")).toBeFocused();

  // A typed yes is enough: the facet is unlocked for the hint and beyond.
  relay.reply(() => ({
    help: help({ hints: ["scope"] }),
    text: "CONCRETE HINT",
    complete: false,
  }));
  await say("yes please");
  await expect.poll(() => relay.tutorCalls().length).toBe(4);
  expect(relay.tutorCalls()[3].payload.helpPolicy).toEqual({
    unlocked: ["scope"],
  });
  await expect(page.locator("#messages")).toContainText("CONCRETE HINT");
  await expect(choice).toBeHidden();
  relay.reply(() => ({
    help: help({ gives: ["scope"] }),
    text: "GIVEN STEP",
    complete: false,
  }));
  await say("still stuck");
  await expect.poll(() => relay.tutorCalls().length).toBe(5);
  await expect(page.locator("#messages")).toContainText("GIVEN STEP");
  expect(errors).toEqual([]);
});
