import { expect, test, type Page } from "@playwright/test";
import {
  flushStudySave,
  mockClaudeStudy,
  openStudyQuestion,
  studyState,
} from "./study-harness";

async function inspect(page: Page) {
  await page.evaluate(() => (window as any).__studyApp.openAgentMenu());
  await page.locator("#curriculum-button").click();
  await expect(page.locator("#career-focus")).toBeVisible();
}

const sourceEvidence = (page: Page) =>
  page.evaluate(async () => {
    const d = (window as any).__studyApp;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(d.roadmap.raw),
    );
    return JSON.stringify({
      sourceHash: d.roadmap.sourceHash,
      rawHash: [...new Uint8Array(digest)]
        .map((n) => n.toString(16).padStart(2, "0"))
        .join(""),
      objectives: [
        d.roadmap.tracks.PY.objectives,
        d.roadmap.tracks.PE.objectives,
      ]
        .flat()
        .map((o: any) => ({ id: o.id, target: o.target, cells: o.cells })),
      cells: d.record.study.learner.cells,
      evidence: d.record.study.learner.evidence,
    });
  });

test("the role profile is explicit, reversible and persists without replacing issued study or original evidence", async ({
  page,
}) => {
  // Three full menu cycles and two page reloads in the first-person view.
  test.slow();
  const relay = await mockClaudeStudy(page);
  const id = await openStudyQuestion(page);
  await expect.poll(() => relay.calls.length).toBe(1);
  const pending = await studyState(page, id),
    before = await sourceEvidence(page);
  await inspect(page);
  await expect(page.locator("#career-focus")).toHaveValue(
    "product-feature-owner",
  );
  await expect(page.locator("#career-focus-summary")).toContainText(
    "51 core PE objectives",
  );
  await expect(page.locator("#career-focus-summary")).toContainText(
    "Python interview fundamentals stay unchanged",
  );
  await page.locator("#career-focus").selectOption("full");
  await expect(page.locator("#career-focus")).toHaveValue("full");
  expect((await studyState(page, id)).problem).toBe(pending.problem);
  expect(await sourceEvidence(page)).toBe(before);
  await flushStudySave(page);
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__studyApp);
  await inspect(page);
  await expect(page.locator("#career-focus")).toHaveValue("full");
  expect(await sourceEvidence(page)).toBe(before);
  await page.locator("#career-focus").selectOption("product-feature-owner");
  await expect(page.locator("#career-focus")).toHaveValue(
    "product-feature-owner",
  );
  expect((await studyState(page, id)).problem).toBe(pending.problem);
  expect(await sourceEvidence(page)).toBe(before);
  await flushStudySave(page);
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__studyApp);
  await inspect(page);
  await expect(page.locator("#career-focus")).toHaveValue(
    "product-feature-owner",
  );
});
