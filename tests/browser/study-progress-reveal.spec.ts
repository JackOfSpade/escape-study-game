import { expect, test, type Page } from "@playwright/test";
import { mockClaudeStudy } from "./study-harness";

async function openStudyQuestion(page: Page) {
  await mockClaudeStudy(page);
  await page.goto("/");
  // The hook appears only after the saved record has loaded.
  await page.waitForFunction(() => !!(window as any).__deadAir);
  await page.evaluate(() => {
    (window as any).__deadAir.game.study.profile = "live";
  });
  await expect(page.locator("#study-workspace")).toBeVisible();
  await page.locator("#study-next").click();
  await expect(page.locator("#study-terminal-slot #terminal")).toBeVisible();
  await expect(page.locator("#study-terminal-slot #problem")).not.toBeEmpty();
  // The open question takes the place of the skill map.
  await expect(page.locator("#study-workspace")).toHaveAttribute(
    "data-view",
    "question",
  );
}

/** Replays the reveal on the live map from a hand-made earlier snapshot in
 * which the first topic (and its tier) had one checkpoint fewer. */
function playReveal(page: Page, reducedMotion: boolean) {
  return page.evaluate(async (reduced) => {
    const root = "/src/";
    const { readMapSnapshot, playProgressReveal } = await import(
      /* @vite-ignore */ root + "study-progress-reveal.ts"
    );
    const progress = document.querySelector<HTMLElement>("#study-progress")!;
    const before = readMapSnapshot(progress);
    const topicKey = Object.keys(before.topics)[0];
    const topic = document.querySelector<HTMLElement>(
      `.study-map-topic[data-topic-key="${topicKey.split("/D")[0]}"]`,
    )!;
    const tier = topicKey.split("/D")[1];
    // The live map is the "after" state; pretend one checkpoint was missing.
    before.topics[topicKey].passed -= 1;
    before.tiers[tier].passed -= 1;
    const finalText = topic.querySelector(".study-topic-count")!.textContent;
    const oldText = `${before.topics[topicKey].passed} of ${before.topics[topicKey].total}`;
    window.scrollTo(0, document.documentElement.scrollHeight);
    let done = 0;
    playProgressReveal(progress, before, {
      reducedMotion: reduced,
      onDone: () => done++,
    });
    (window as any).__revealProbe = {
      topicKey,
      finalText,
      oldText,
      doneCount: () => done,
    };
    return {
      finalText,
      oldText,
      shownNow: topic.querySelector(".study-topic-count")!.textContent,
    };
  }, reducedMotion);
}

test("an open question replaces the skill map, and the toolbar switches between them", async ({
  page,
}) => {
  await openStudyQuestion(page);
  await expect(page.locator(".study-skill-map")).toBeHidden();
  await expect(page.locator("#study-next")).toBeHidden();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  const top = await page.evaluate(
    () =>
      document
        .querySelector("#study-terminal-slot #terminal")!
        .getBoundingClientRect().top,
  );
  expect(top).toBeLessThan(200);
  // The map is one click away and the question one click back.
  await page.locator("#study-map-peek").click();
  await expect(page.locator(".study-skill-map")).toBeVisible();
  await expect(page.locator("#study-terminal-slot #terminal")).toBeHidden();
  await page.locator("#study-map-peek").click();
  await expect(page.locator("#study-terminal-slot #terminal")).toBeVisible();
  await expect(page.locator(".study-skill-map")).toBeHidden();
});

test("the map levels up from its previous state", async ({ page }) => {
  await openStudyQuestion(page);
  const result = await playReveal(page, false);
  expect(result.shownNow).toBe(result.oldText);
  expect(result.oldText).not.toBe(result.finalText);
  await expect(page.locator(".study-reveal-banner")).toContainText(
    "+1 checkpoint verified",
  );
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            document.querySelector(
              `.study-map-topic[data-topic-key="${(window as any).__revealProbe.topicKey.split("/D")[0]}"] .study-topic-count`,
            )!.textContent,
        ),
      { timeout: 3000 },
    )
    .toBe(result.finalText);
  await expect
    .poll(() => page.evaluate(() => (window as any).__revealProbe.doneCount()))
    .toBe(1);
  await expect(page.locator(".study-reveal-particle")).toHaveCount(0);
  await expect(page.locator(".study-reveal-layer")).toHaveCount(0);
  await expect(page.locator(".is-leveling, .is-rising")).toHaveCount(0);
  const top = await page.evaluate(
    () =>
      document.querySelector("#study-progress")!.getBoundingClientRect().top,
  );
  expect(top).toBeGreaterThanOrEqual(-2);
  expect(top).toBeLessThan(200);
});

test("reduced motion shows the final state immediately with a banner", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openStudyQuestion(page);
  const result = await playReveal(page, true);
  expect(result.shownNow).toBe(result.finalText);
  await expect(page.locator(".study-reveal-banner")).toContainText(
    "+1 checkpoint verified",
  );
  await expect(page.locator(".study-reveal-particle")).toHaveCount(0);
});

test("a finished question stays open with a marker in chat, and the map reveal waits", async ({
  page,
}) => {
  const study = await mockClaudeStudy(page);
  // Later routes win: answer the progress assessment, pass the rest through.
  await page.route("**/api/bridge", async (route) => {
    const body = route.request().postDataJSON();
    if (body?.operation !== "assess") return route.fallback();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ visitOutcome: "unresolved", findings: [] }),
    });
  });
  await page.goto("/");
  // The hook appears only after the saved record has loaded.
  await page.waitForFunction(() => !!(window as any).__deadAir);
  await page.evaluate(() => {
    (window as any).__deadAir.game.study.profile = "live";
  });
  await page.locator("#study-next").click();
  await expect(page.locator("#study-terminal-slot #problem")).not.toBeEmpty();
  await expect(page.locator("#study-workspace")).toHaveAttribute(
    "data-view",
    "question",
  );
  study.solve();
  await page.locator("#chat-input").fill("It decides what the index can seek.");
  await page.locator("#chat-input").press("Enter");
  // The conversation says the question is done, after the final reply.
  const marker = page.locator("#messages .message-complete");
  await expect(marker).toContainText("Question complete");
  await expect(page.locator("#messages > :last-child")).toHaveClass(
    "message-complete",
  );
  await expect(
    page.locator("#messages .message-complete ~ .message"),
  ).toHaveCount(0);
  await expect(page.locator("#study-save-status")).toContainText(
    "Progress assessment validated and saved.",
    { timeout: 15000 },
  );
  // The learner stays on the question; nothing plays on the hidden map.
  await expect(page.locator("#study-workspace")).toHaveAttribute(
    "data-view",
    "question",
  );
  await expect(page.locator("#study-terminal-slot #terminal")).toBeVisible();
  await expect(page.locator(".study-reveal-banner")).toHaveCount(0);
  // Later discussion follows the marker instead of moving it.
  study.reply(() => ({ text: "Glad to go deeper." }));
  await page.locator("#chat-input").fill("One more thing?");
  await page.locator("#chat-input").press("Enter");
  await expect(
    page.locator("#messages .message-complete ~ .message"),
  ).toHaveCount(2);
  await expect(page.locator("#study-workspace")).toHaveAttribute(
    "data-view",
    "question",
  );
  // The map is the learner's choice, and the reveal plays when it shows.
  await page.locator("#study-map-peek").click();
  await expect(page.locator(".study-reveal-banner")).toHaveCount(1);
  await expect(page.locator("#study-progress")).toBeVisible();
  await expect(page.locator("#study-next")).toBeEnabled();
  await expect(page.locator("#study-next")).toHaveText("Start next question");
  await expect(page.locator("#study-map-peek")).toHaveText(
    "Review the last question",
  );
  // The banner fades out on its own and the reveal does not repeat.
  await expect(page.locator(".study-reveal-banner")).toHaveCount(0, {
    timeout: 8000,
  });
  await page.locator("#study-map-peek").click();
  await page.locator("#study-map-peek").click();
  await page.waitForTimeout(1500);
  await expect(page.locator(".study-reveal-banner")).toHaveCount(0);
});
