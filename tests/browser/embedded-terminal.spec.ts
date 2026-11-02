import { expect, test, type Page } from "@playwright/test";
import { enterNativeGame } from "./study-harness";

/** Fake Claude CLI gateway: no model, connector or real save is involved. */
async function mockClaude(page: Page) {
  const calls: any[] = [];
  const held: { release?: () => void } = {};
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
    calls.push(body);
    if (body.operation === "generate") {
      const c = body.payload.contract;
      return json({
        title: "Embedded question",
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
    }
    if (body.operation === "tutor") {
      await new Promise<void>((resolve) => (held.release = resolve));
      return json({ text: "What would the planner do then?", complete: false });
    }
    return json({ error: "Unexpected operation" }, 400);
  });
  return { calls, held };
}
const openTerminal = (page: Page) =>
  page.evaluate(async () => {
    const d = (window as any).__deadAir,
      g = d.game;
    g.study.profile = "live";
    // A live run starts with no pre-made practice questions.
    for (const each of Object.values<any>(g.encounters)) delete each.problem;
    const st = g.floors[0].stations[0],
      e = g.encounters[st.encounter];
    e.mode = "solo";
    e.owner = "human";
    Object.assign(g.survivors[0], { floor: 0, x: st.x, y: st.y });
    await d.interact();
    return e.id as string;
  });
const gameTime = (page: Page) =>
  page.evaluate(() => (window as any).__deadAir.game.time as number);

test("Claude CLI serves a question and conversation inside the game, pausing only during a reply", async ({
  page,
}) => {
  const claude = await mockClaude(page);
  await enterNativeGame(page);
  await openTerminal(page);
  await expect(page.locator("#terminal")).toBeVisible();
  await expect(page.locator("body")).toHaveClass(/terminal-open/);
  await expect(page.locator("#problem-title")).toHaveText("Embedded question");
  const generated = claude.calls.filter((c) => c.operation === "generate");
  expect(generated).toHaveLength(1);
  expect(generated[0]).not.toHaveProperty("chatCode");

  await page.locator("#chat-input").fill("It decides what the index can seek.");
  await page.locator("#chat-input").press("Enter");
  await expect.poll(() => claude.held.release !== undefined).toBe(true);
  const frozen = await gameTime(page);
  await page.waitForTimeout(400);
  expect(await gameTime(page)).toBe(frozen);

  claude.held.release!();
  await expect(page.locator("#messages")).toContainText(
    "What would the planner do then?",
  );
  await expect.poll(() => gameTime(page)).toBeGreaterThan(frozen);
});

test("the study view shows the embedded terminal and returns it to the game layout", async ({
  page,
}) => {
  const claude = await mockClaude(page);
  await enterNativeGame(page);
  await page.evaluate(() => {
    (window as any).__deadAir.game.study.profile = "live";
  });
  await page.locator("#study-only-toggle").click();
  await expect(page.locator("#study-workspace")).toBeVisible();
  await expect(page.locator("#terminal")).toBeHidden();

  await page.locator("#study-next").click();
  const terminal = page.locator("#study-terminal-slot #terminal");
  await expect(terminal).toBeVisible();
  await expect(terminal.locator("#problem")).toContainText(
    "Why does the leading index column matter?",
  );
  // The background preparation may also have run; the study question is its own.
  expect(
    claude.calls.filter(
      (c) => c.operation === "generate" && c.payload.encounterId !== "prepared",
    ),
  ).toHaveLength(1);
  // No horizontal scroll while the terminal is in the study view.
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);

  // The station reach check must not close a terminal that has no station.
  await page.waitForTimeout(400);
  await expect(terminal).toBeVisible();

  await page.locator("#chat-input").fill("It decides what the index can seek.");
  await page.locator("#chat-input").press("Enter");
  await expect.poll(() => claude.held.release !== undefined).toBe(true);
  claude.held.release!();
  await expect(page.locator("#messages")).toContainText(
    "What would the planner do then?",
  );

  await page.locator("#leave").click();
  await expect(page.locator("#terminal")).toBeHidden();
  await expect(page.locator("#study-workspace")).toBeVisible();

  await page.locator("#study-only-exit").click();
  await expect(page.locator("#study-workspace")).toBeHidden();
  await expect(page.locator(".game-layout #terminal")).toHaveCount(1);
  await expect(page.locator("#study-terminal-slot #terminal")).toHaveCount(0);
  await expect(page.locator("#terminal")).toBeHidden();
});
