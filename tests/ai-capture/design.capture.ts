/**
 * Manual capture: REAL new-level designs through the normal start UI. There is
 * no design-run mock here, so each design is a full multi-stage Claude run that
 * can take most of an hour and a lot of usage.
 */
import { expect, test, type Page } from "@playwright/test";
import { countBridgeCalls } from "./support";

const ENABLED = process.env.CAPTURE_DESIGN === "1";
const DESIGNS = Math.max(1, Number(process.env.CAPTURE_DESIGNS ?? "1"));
const MINUTES = Math.max(1, Number(process.env.CAPTURE_TIMEOUT_MIN ?? "120"));
const DESIGN_TIMEOUT_MS = MINUTES * 60_000;

test.skip(
  !ENABLED,
  "Set CAPTURE_DESIGN=1 to run real level designs (an hour and real Claude usage per design)",
);

async function runId(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).__deadAir.game.id as string);
}

/** Wait for the ready title card of a freshly designed level. */
async function waitForDesignedLevel(page: Page, previous: string) {
  await page.waitForFunction(
    (before) => {
      const game = (window as any).__deadAir?.game,
        card = document.querySelector<HTMLElement>("#start-card");
      return (
        game &&
        game.id !== before &&
        game.status === "ready" &&
        !game.preparingRun &&
        !!card &&
        !card.hidden &&
        document.querySelector("#run-design-dialog") === null
      );
    },
    previous,
    { timeout: DESIGN_TIMEOUT_MS },
  );
  return page.evaluate(() => {
    const game = (window as any).__deadAir.game;
    return {
      id: game.id as string,
      title: game.design?.design.title ?? "unknown",
    };
  });
}

test("real new-level designs reach the relay with no mock", async ({
  page,
}) => {
  test.setTimeout(DESIGN_TIMEOUT_MS + 5 * 60_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const counter = countBridgeCalls(page);
  await page.goto("/");
  await page.waitForFunction(
    () =>
      !!(window as any).__deadAir &&
      (window as any).__deadAir.game.status === "ready",
  );
  for (let design = 0; design < DESIGNS; design++) {
    const previous = await runId(page);
    if (design === 0) {
      // First launch: Start asks the relay for a reviewed design.
      await page.locator("#start").click();
    } else {
      await page.keyboard.press("Escape");
      await page.locator("#generate-run").click();
    }
    await page
      .locator("#run-design-dialog")
      .waitFor({ state: "visible", timeout: 5 * 60_000 });
    const level = await waitForDesignedLevel(page, previous);
    console.log(
      `[design] ${design + 1}/${DESIGNS} designed id=${level.id} title=${level.title}`,
    );
    await page.locator("#start").click();
    await page.waitForFunction(
      () => (window as any).__deadAir.game.status === "playing",
    );
  }
  const counts = counter.counts();
  counter.stop();
  console.log(`[design] bridge calls ${JSON.stringify(counts)}`);
  expect(counts["design-run"] ?? 0).toBeGreaterThanOrEqual(DESIGNS);
  expect(pageErrors).toEqual([]);
});
