import { expect, test, type Page } from "@playwright/test";

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
        capabilities: ["generate", "tutor", "assess"],
      });
    if (url.pathname !== "/api/bridge")
      return json({ error: `No route for ${url.pathname}` }, 404);
    const body = request.postDataJSON();
    calls.push(body);
    if (body.operation === "generate") {
      const c = body.payload.contract;
      return json({
        title: "Embedded question",
        prompt:
          "Why does the leading index column matter?\n\n```python\nprint('" +
          "x".repeat(600) +
          "')\n```",
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
      return json({
        text: "What would the planner do then?\n\n```sql\nSELECT 1;\n```",
        complete: false,
      });
    }
    return json({ error: "Unexpected operation" }, 400);
  });
  return { calls, held };
}
const openQuestion = async (page: Page) => {
  await page.goto("/");
  await page.locator("#study-next").click();
};

test("Claude CLI serves a question and conversation inside the study workspace", async ({
  page,
}) => {
  const claude = await mockClaude(page);
  await openQuestion(page);
  await expect(page.locator("#terminal")).toBeVisible();
  await expect(page.locator("#problem-title")).toHaveText("Embedded question");
  // The fenced block renders as code, with no literal fence and no page growth.
  await expect(page.locator("#problem pre code")).toHaveCount(1);
  await expect(page.locator("#problem")).not.toContainText("```");
  const problemPre = page.locator("#problem pre");
  expect(
    await problemPre.evaluate(
      (el) =>
        el.scrollWidth > el.clientWidth &&
        getComputedStyle(el).overflowX === "auto",
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  const generated = claude.calls.filter((c) => c.operation === "generate");
  expect(generated).toHaveLength(1);
  expect(generated[0]).not.toHaveProperty("chatCode");

  // There is no send button: Enter sends, while Shift+Enter only adds a line.
  await expect(page.locator("#chat-form button")).toHaveCount(0);
  await page.locator("#chat-input").fill("It decides what the index can seek.");
  await page.locator("#chat-input").press("Shift+Enter");
  await expect(page.locator("#chat-input")).toHaveValue(
    "It decides what the index can seek.\n",
  );
  expect(claude.held.release).toBeUndefined();
  await page.locator("#chat-input").fill("It decides what the index can seek.");
  await page.locator("#chat-input").press("Enter");
  await expect.poll(() => claude.held.release !== undefined).toBe(true);
  claude.held.release!();
  await expect(page.locator("#messages")).toContainText(
    "What would the planner do then?",
  );
  await expect(page.locator("#messages pre code")).toHaveText("SELECT 1;");
  await expect(page.locator("#messages")).not.toContainText("```");
});

test("the study view shows the question panel and keeps it open", async ({
  page,
}) => {
  const claude = await mockClaude(page);
  await page.goto("/");
  await expect(page.locator("#study-workspace")).toBeVisible();
  await expect(page.locator("#terminal")).toBeHidden();

  await page.locator("#study-next").click();
  const terminal = page.locator("#study-terminal-slot #terminal");
  await expect(terminal).toBeVisible();
  await expect(terminal.locator("#problem")).toContainText(
    "Why does the leading index column matter?",
  );
  expect(claude.calls.filter((c) => c.operation === "generate")).toHaveLength(
    1,
  );
  // No horizontal scroll while the question is open.
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.waitForTimeout(400);
  await expect(terminal).toBeVisible();

  await page.locator("#chat-input").fill("It decides what the index can seek.");
  await page.locator("#chat-input").press("Enter");
  await expect.poll(() => claude.held.release !== undefined).toBe(true);
  claude.held.release!();
  await expect(page.locator("#messages")).toContainText(
    "What would the planner do then?",
  );

  // The workspace offers no way to walk away from the open question.
  const next = page.locator("#study-next");
  await expect(next).toHaveText("Question in progress");
  await expect(next).toBeDisabled();
});
