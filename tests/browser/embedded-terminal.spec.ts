import { expect, test, type Page } from "@playwright/test";
import { enterNativeGame } from "./native-study-harness";

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
  await expect(page.locator("#native-study")).toBeHidden();
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
