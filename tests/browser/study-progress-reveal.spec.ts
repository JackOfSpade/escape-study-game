import { expect, test, type Page } from "@playwright/test";
import { enterNativeGame, mockClaudeStudy } from "./study-harness";

async function openStudyQuestion(page: Page) {
  await mockClaudeStudy(page);
  await enterNativeGame(page);
  await page.evaluate(() => {
    (window as any).__deadAir.game.study.profile = "live";
  });
  await page.locator("#study-only-toggle").click();
  await expect(page.locator("#study-workspace")).toBeVisible();
  await page.locator("#study-next").click();
  await expect(page.locator("#study-terminal-slot #terminal")).toBeVisible();
  await expect(page.locator("#study-terminal-slot #problem")).not.toBeEmpty();
  // The terminal scrolls onto its own screen once the question is ready.
  await expect
    .poll(() =>
      page.evaluate(() =>
        Math.abs(
          document
            .querySelector("#study-terminal-slot")!
            .getBoundingClientRect().top,
        ),
      ),
    )
    .toBeLessThanOrEqual(2);
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

test("the question terminal gets its own screen below the map", async ({
  page,
}) => {
  await openStudyQuestion(page);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Math.abs(
          document
            .querySelector("#study-terminal-slot")!
            .getBoundingClientRect().top,
        ),
      ),
    )
    .toBeLessThanOrEqual(2);
  const map = await page.evaluate(
    () =>
      document.querySelector(".study-skill-map")!.getBoundingClientRect()
        .bottom,
  );
  expect(map).toBeLessThanOrEqual(0);
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

test("finishing a question scrolls back to the map and plays the reveal once", async ({
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
  await enterNativeGame(page);
  await page.evaluate(() => {
    (window as any).__deadAir.game.study.profile = "live";
  });
  await page.locator("#study-only-toggle").click();
  await page.locator("#study-next").click();
  await expect(page.locator("#study-terminal-slot #problem")).not.toBeEmpty();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Math.abs(
          document
            .querySelector("#study-terminal-slot")!
            .getBoundingClientRect().top,
        ),
      ),
    )
    .toBeLessThanOrEqual(2);
  study.solve();
  await page.locator("#chat-input").fill("It decides what the index can seek.");
  await page.locator("#chat-input").press("Enter");
  await expect(page.locator(".study-reveal-banner")).toHaveCount(1, {
    timeout: 15000,
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.querySelector("#study-progress")!.getBoundingClientRect()
            .top,
      ),
    )
    .toBeGreaterThanOrEqual(-2);
  await expect(page.locator("#study-next")).toBeEnabled();
  await expect(page.locator("#study-next")).toHaveText("Start next question");
  // The banner fades out on its own and the reveal does not repeat.
  await expect(page.locator(".study-reveal-banner")).toHaveCount(0, {
    timeout: 8000,
  });
  await page.waitForTimeout(1500);
  await expect(page.locator(".study-reveal-banner")).toHaveCount(0);
});
