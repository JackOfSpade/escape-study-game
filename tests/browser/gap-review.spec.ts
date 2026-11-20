import { expect, test } from "@playwright/test";
import { mockClaudeStudy } from "./study-harness";

test("a gap answered after the question finished shows as closed in chat and in the status line", async ({
  page,
}) => {
  const study = await mockClaudeStudy(page);
  await page.route("**/api/bridge", async (route) => {
    const body = route.request().postDataJSON();
    if (body?.operation !== "assess") return route.fallback();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ visitOutcome: "unresolved", findings: [] }),
    });
  });
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__studyApp);
  await page.evaluate(() => {
    (window as any).__studyApp.record.study.profile = "live";
  });
  await page.locator("#study-next").click();
  await expect(page.locator("#study-terminal-slot #problem")).not.toBeEmpty();
  // The learner concedes: the question finishes with every facet a gap.
  study.reply((body) => ({
    help: { nudges: [], hints: [], gives: [], offers: [] },
    text: "Recorded as a study target.",
    complete: true,
    outcome: "gap",
    knowledge: {
      facets: body.payload.probe.facets.map((f: any) => ({
        id: f.id,
        status: "gap",
      })),
      signal: { fluency: "declared-gap" },
    },
    topicAssessments: (body.payload.topicAssessmentContext?.topicIds ?? []).map(
      (topicId: string) => ({ topicId, text: "Conceded." }),
    ),
  }));
  await page.locator("#chat-input").fill("No idea.");
  await page.locator("#chat-input").press("Enter");
  await expect(page.locator("#messages .message-complete")).toContainText(
    "Question complete",
  );
  await expect(page.locator("#dialogue-status")).toContainText(
    "Solved with a recorded gap",
  );
  // A reply that only claims the change leaves the record as it was.
  let sent: any;
  study.reply((body) => {
    sent = body.payload;
    return { text: "Yes, cleared." };
  });
  await page.locator("#chat-input").fill("Can you clear it?");
  await page.locator("#chat-input").press("Enter");
  await expect(page.locator("#messages .message.tutor")).toHaveCount(2);
  expect(sent.mode).toBe("terminal-review");
  expect(sent.review.openGaps.length).toBeGreaterThan(0);
  await expect(page.locator("#messages .gap-closed")).toHaveCount(0);
  await expect(page.locator("#dialogue-status")).toContainText(
    "Solved with a recorded gap",
  );
  // A finding for the open gaps closes them, under the reply that did it.
  study.reply((body) => ({
    text: "That is the reason.",
    knowledge: {
      facets: body.payload.review.openGaps.map((f: any) => ({
        id: f.id,
        status: "demonstrated",
      })),
    },
  }));
  await page.locator("#chat-input").fill("Because it shows the cost.");
  await page.locator("#chat-input").press("Enter");
  const badge = page.locator("#messages .gap-closed");
  await expect(badge).toHaveCount(1);
  await expect(badge).toContainText("Gap closed");
  await expect(page.locator("#messages > :last-child")).toHaveClass(
    /gap-closed/,
  );
  await expect(page.locator("#dialogue-status")).toContainText(/closed later/);
  await expect(page.locator("#dialogue-status")).not.toContainText(
    "Solved with a recorded gap",
  );
  // The saved record holds the gap as closed.
  await page.waitForFunction(
    () =>
      !(window as any).__studyApp.record.study.knowledgeGaps.some(
        (x: any) => !x.resolved,
      ),
  );
});
