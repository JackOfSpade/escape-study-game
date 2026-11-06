import { expect, test, type Page } from "@playwright/test";
import { enterNativeGame } from "./study-harness";

/** Fake Claude CLI gateway whose question generation the test releases.
 * No model, connector or real save is involved. */
async function mockSlowClaude(page: Page) {
  const waiting: (() => void)[] = [];
  const held = {
    get release() {
      return waiting.length
        ? () => waiting.splice(0).forEach((resolve) => resolve())
        : undefined;
    },
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (url.pathname === "/api/status")
      return json({
        mode: "claude-cli",
        label: "Claude CLI",
        detail: "Synthetic gateway",
        capabilities: ["generate", "tutor", "complete", "assess", "group"],
      });
    if (url.pathname !== "/api/bridge")
      return json({ error: `No route for ${url.pathname}` }, 404);
    const body = request.postDataJSON();
    if (body.operation !== "generate")
      return json({ error: "Unexpected operation" }, 400);
    // Every question, including the one prepared in the background that the
    // terminal adopts, stays in flight until the test releases it.
    await new Promise<void>((resolve) => waiting.push(resolve));
    const c = body.payload.contract;
    return json({
      title: "Revealed question",
      prompt: "Why does the leading index column matter?",
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
  });
  return held;
}
const openTerminal = (page: Page) =>
  page.evaluate(async () => {
    const d = (window as any).__deadAir,
      g = d.game;
    g.study.profile = "live";
    for (const each of Object.values<any>(g.encounters)) delete each.problem;
    const st = g.floors[0].stations[0],
      e = g.encounters[st.encounter];
    e.mode = "solo";
    e.owner = "human";
    Object.assign(g.survivors[0], { floor: 0, x: st.x, y: st.y });
    // Opening waits on the question, which the test holds, so do not await it.
    void d.interact();
    return e.id as string;
  });
const gameTime = (page: Page) =>
  page.evaluate(() => (window as any).__deadAir.game.time as number);
const presented = (page: Page, id: string) =>
  page.evaluate(
    (id) =>
      (window as any).__deadAir.game.encounters[id].problemPresentedSequence,
    id,
  );

test("a question that took a while stays covered, with the game paused, until the player reveals it", async ({
  page,
}) => {
  const held = await mockSlowClaude(page);
  await enterNativeGame(page);
  const id = await openTerminal(page);
  await expect.poll(() => held.release !== undefined).toBe(true);
  await expect(page.locator("#reply-pause")).toBeVisible();
  const frozen = await gameTime(page);
  // Long enough that the player may have stepped away.
  await page.waitForTimeout(3300);
  held.release!();

  const reveal = page.locator("#reveal-question");
  await expect(reveal).toBeVisible();
  await expect(page.locator("#problem-title")).toHaveText(
    "Your question is ready",
  );
  await expect(page.locator("#problem")).not.toContainText("leading index");
  await expect(page.locator("#reply-pause-detail")).toContainText(
    "until you reveal it",
  );
  await expect(page.locator("#chat-input")).toBeDisabled();
  await page.waitForTimeout(500);
  expect(await gameTime(page)).toBe(frozen);
  // Not issued yet: the presentation time is when the player sees it.
  expect(await presented(page, id)).toBeUndefined();
  await page.screenshot({
    path: ".artifacts/handoff/question-reveal/ready.png",
  });

  await reveal.click();
  await expect(page.locator("#problem-title")).toHaveText("Revealed question");
  await expect(page.locator("#problem")).toContainText("leading index");
  await expect(page.locator("#reply-pause")).toBeHidden();
  await expect(page.locator("#chat-input")).toBeEnabled();
  await expect(page.locator("#chat-input")).toBeFocused();
  expect(await presented(page, id)).toBeDefined();
  await expect.poll(() => gameTime(page)).toBeGreaterThan(frozen);
});

test("a question that arrives quickly opens directly", async ({ page }) => {
  const held = await mockSlowClaude(page);
  await enterNativeGame(page);
  await openTerminal(page);
  await expect.poll(() => held.release !== undefined).toBe(true);
  held.release!();
  await expect(page.locator("#problem-title")).toHaveText("Revealed question");
  await expect(page.locator("#reveal-question")).toHaveCount(0);
  await expect(page.locator("#reply-pause")).toBeHidden();
});

test("leaving the terminal while the question waits drops the hold", async ({
  page,
}) => {
  const held = await mockSlowClaude(page);
  await enterNativeGame(page);
  const id = await openTerminal(page);
  await expect.poll(() => held.release !== undefined).toBe(true);
  await page.waitForTimeout(3300);
  held.release!();
  await expect(page.locator("#reveal-question")).toBeVisible();
  const frozen = await gameTime(page);
  await page.locator("#leave").click();
  await expect(page.locator("#terminal")).toBeHidden();
  await expect.poll(() => gameTime(page)).toBeGreaterThan(frozen);
  // Returning by choice shows the question straight away.
  await page.evaluate(async (id) => {
    const d = (window as any).__deadAir,
      g = d.game,
      st = g.floors[0].stations.find((s: any) => s.encounter === id);
    Object.assign(g.survivors[0], { floor: 0, x: st.x, y: st.y });
    void d.interact();
  }, id);
  await expect(page.locator("#problem-title")).toHaveText("Revealed question");
  await expect(page.locator("#reveal-question")).toHaveCount(0);
});
