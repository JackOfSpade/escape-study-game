import { expect, test, type Page } from "@playwright/test";
import {
  flushNativeSave,
  mockNativeStudy,
  nativeState,
} from "./native-study-harness";

const topicNode = (page: Page, key: string) =>
  page.locator(`.study-map-topic[data-topic-key="${key}"]`);
const topicToggle = (page: Page, key: string) =>
  topicNode(page, key).locator(".study-topic-toggle");
const topicBody = (page: Page, key: string) =>
  topicNode(page, key).locator(".study-topic-assessment-body");

async function enterStudy(page: Page) {
  await page.goto("/");
  await page.locator("#study-only-toggle").click();
  await expect(page.locator("#study-workspace")).toBeVisible();
}

test("inline topic assessments are read-only, refresh in place and survive reload", async ({
  page,
}) => {
  const relay = await mockNativeStudy(page);
  await enterStudy(page);
  const root = page.locator(".study-map-root");
  const progressBefore = await root.innerText();
  const nextBefore = await page
    .locator(".study-skill-map")
    .getAttribute("data-current-marker");
  const first = page.locator(".study-map-topic").first();
  const firstToggle = first.locator(".study-topic-toggle");
  await expect(firstToggle).toHaveAttribute("aria-expanded", "false");
  await firstToggle.click();
  await expect(firstToggle).toHaveAttribute("aria-expanded", "true");
  const firstPanel = first.locator(".study-topic-assessment-panel");
  await expect(firstPanel).toBeVisible();
  await expect(firstPanel).toContainText("No AI assessment saved yet");
  await expect(firstPanel).toContainText(
    /question.*(?:finish|complet)|(?:finish|complet).*question/i,
  );
  await expect(page.locator("dialog[open], [role=dialog]")).toHaveCount(0);
  expect(relay.calls).toHaveLength(0);
  await expect(root).toHaveText(progressBefore, { useInnerText: true });
  await expect(page.locator(".study-skill-map")).toHaveAttribute(
    "data-current-marker",
    nextBefore ?? "",
  );
  await firstToggle.click();
  await expect(firstToggle).toHaveAttribute("aria-expanded", "false");
  await expect(firstPanel).toBeHidden();

  await page.locator("#study-next").click();
  await expect.poll(() => relay.calls.length).toBe(1);
  const payload = relay.calls[0].payload;
  const topicIds: string[] = payload.topicAssessmentContext.topicIds;
  expect(topicIds.length).toBeGreaterThan(0);
  const target = topicNode(page, topicIds[0]);
  const toggle = topicToggle(page, topicIds[0]);
  const body = topicBody(page, topicIds[0]);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(body).toContainText("No AI assessment saved yet");

  // Deliberately speculative, unconstrained prose must remain literal text.
  const narrative =
    "🧭 A working hypothesis\nThe learner probably has a knowledge gap around edge cases, although their core explanation is strong.\n\n<img src=x onerror=window.__assessmentExecuted=true>\nI would probe one boundary case next.";
  relay.finish(payload.requestId, "solved", {
    topicAssessments: topicIds.map((topicId) => ({ topicId, text: narrative })),
  });
  await expect(page.locator("#study-save-status")).toContainText(
    "Learning result received and saved",
  );
  // Completion rerenders the map, retaining the open node and updating its body.
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(body).toBeVisible();
  await expect(body).toHaveText(narrative);
  await expect(target.locator(".study-topic-assessment-meta")).not.toBeEmpty();
  expect(await body.locator("img, script").count()).toBe(0);
  expect(
    await page.evaluate(() => (window as any).__assessmentExecuted),
  ).toBeUndefined();
  expect(await body.evaluate((node) => getComputedStyle(node).whiteSpace)).toBe(
    "pre-wrap",
  );
  await body.click();
  await body.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(relay.calls).toHaveLength(1);
  const saved = await page.evaluate(() =>
    structuredClone((window as any).__deadAir.game.study.topicAssessments),
  );
  expect(Object.keys(saved).sort()).toEqual(
    topicIds.map((id) => `${id}/D${payload.problem.contract.depth}`).sort(),
  );

  const unrelatedKey = await page
    .locator(".study-map-topic")
    .evaluateAll(
      (nodes, scoped) =>
        nodes
          .map((node) => (node as HTMLElement).dataset.topicKey!)
          .find((key) => !scoped.includes(key))!,
      topicIds,
    );
  await topicToggle(page, unrelatedKey).click();
  await expect(topicBody(page, unrelatedKey)).toContainText(
    "No AI assessment saved yet",
  );
  await expect(topicBody(page, unrelatedKey)).not.toContainText(
    "working hypothesis",
  );
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(body).toBeVisible();

  await flushNativeSave(page);
  await page.reload();
  await expect(page.locator("#study-workspace")).toBeVisible();
  await topicToggle(page, topicIds[0]).click();
  await expect(body).toHaveText(narrative);
  expect(
    await page.evaluate(() =>
      structuredClone((window as any).__deadAir.game.study.topicAssessments),
    ),
  ).toEqual(saved);

  // Finishing the next breadth-first topic preserves the earlier saved view.
  await page.locator("#study-next").click();
  await expect.poll(() => relay.calls.length).toBe(2);
  const second = relay.calls[1].payload;
  const secondIds: string[] = second.topicAssessmentContext.topicIds;
  expect(secondIds.every((id) => !topicIds.includes(id))).toBe(true);
  relay.finish(second.requestId, "gap", {
    topicAssessments: secondIds.map((topicId) => ({
      topicId,
      text: "The learner says this is unfamiliar; the specific cause remains uncertain.",
    })),
  });
  await expect(page.locator("#study-save-status")).toContainText(
    "Learning result received and saved",
  );
  const updated = await page.evaluate(() =>
    structuredClone((window as any).__deadAir.game.study.topicAssessments),
  );
  for (const [key, record] of Object.entries(saved))
    expect(updated[key]).toEqual(record);
  await expect(body).toBeVisible();
  await expect(body).toHaveText(narrative);
  await topicToggle(page, secondIds[0]).click();
  await expect(topicBody(page, secondIds[0])).toHaveText(
    "The learner says this is unfamiliar; the specific cause remains uncertain.",
  );
});

test("an old completion tool without topic assessments fails honestly and can retry without partial credit", async ({
  page,
}) => {
  const relay = await mockNativeStudy(page);
  await enterStudy(page);
  await page.locator("#study-next").click();
  await expect.poll(() => relay.calls.length).toBe(1);
  const payload = relay.calls[0].payload;
  const topicIds: string[] = payload.topicAssessmentContext.topicIds;
  await topicToggle(page, topicIds[0]).click();
  const body = topicBody(page, topicIds[0]);
  await expect(topicToggle(page, topicIds[0])).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  const before = await nativeState(page, payload.encounterId);
  const progressBefore = await page.locator(".study-map-root").innerText();

  relay.finish(payload.requestId, "solved", { topicAssessments: undefined });
  await expect(page.locator("#native-study-status")).toContainText(
    "topicAssessments",
  );
  await expect(body).toContainText("No AI assessment saved yet");
  await expect(page.locator("#study-save-status")).not.toContainText(
    "Learning result received and saved",
  );
  await expect(page.locator(".study-map-root")).toHaveText(progressBefore, {
    useInnerText: true,
  });
  const rejected = await nativeState(page, payload.encounterId);
  expect(rejected.session.state).toBe("interrupted");
  expect(rejected.keys).toBe(before.keys);
  expect(rejected.submissions).toBe(before.submissions);
  expect(
    await page.evaluate(
      () => (window as any).__deadAir.game.study.topicAssessments,
    ),
  ).toBeUndefined();

  relay.finish(payload.requestId);
  await page.locator("#native-study-retry").click();
  await expect(page.locator("#study-save-status")).toContainText(
    "Learning result received and saved",
  );
  const recovered = await nativeState(page, payload.encounterId);
  expect(recovered.session.state).toBe("applied");
  expect(recovered.submissions).toBe(before.submissions + 1);
  await expect(body).toBeVisible();
  await expect(body).toContainText(`Synthetic assessment for ${topicIds[0]}`);
});

test("the skill map has one tab stop, arrow navigation and keyboard disclosures", async ({
  page,
}) => {
  const relay = await mockNativeStudy(page);
  await enterStudy(page);
  const toggles = page.locator(".study-topic-toggle");
  const first = toggles.first();
  const last = toggles.last();
  await expect(page.locator('.study-topic-toggle[tabindex="0"]')).toHaveCount(
    1,
  );
  await page.locator("#study-only-exit").focus();
  await page.keyboard.press("Tab");
  await expect(page.locator('.study-topic-toggle[tabindex="0"]')).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#study-next")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Home");
  await expect(first).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(first).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Space");
  await expect(first).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ArrowDown");
  await expect(toggles.nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(last).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(first).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(last).toBeFocused();
  await expect(page.locator('.study-topic-toggle[tabindex="0"]')).toHaveCount(
    1,
  );
  expect(relay.calls).toHaveLength(0);

  // A real map update retains the keyboard position and disclosure state.
  await page.keyboard.press("Space");
  await expect(last).toHaveAttribute("aria-expanded", "true");
  await page.evaluate(() => {
    const r = (window as any).__deadAir.roadmap;
    r.tracks.PY.objectives.find((o: any) => o.cells[0] !== "P").cells[0] = "P";
  });
  await expect(page.locator(".study-map-root")).toContainText("8 of 131");
  await expect(last).toBeFocused();
  await expect(last).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Tab");
  await expect(page.locator("#study-next")).toBeFocused();
});

for (const width of [700, 390]) {
  test(`inline topic assessment grows the node at ${width}px and toggles by pointer`, async ({
    page,
  }) => {
    const relay = await mockNativeStudy(page);
    await page.setViewportSize({ width, height: 900 });
    await enterStudy(page);
    await page.locator("#study-next").click();
    await expect.poll(() => relay.calls.length).toBe(1);
    const payload = relay.calls[0].payload;
    const topicIds: string[] = payload.topicAssessmentContext.topicIds;
    const narrative = `One connected explanation\n${"The learner probably understands the core idea, with uncertainty around practical edge cases. ".repeat(32)}\n${"long-evidence-reference-".repeat(20)}`;
    relay.finish(payload.requestId, "solved", {
      topicAssessments: topicIds.map((topicId) => ({
        topicId,
        text: narrative,
      })),
    });
    await expect(page.locator("#study-save-status")).toContainText(
      "Learning result received and saved",
    );
    const node = topicNode(page, topicIds[0]);
    const toggle = topicToggle(page, topicIds[0]);
    const panel = node.locator(".study-topic-assessment-panel");
    const body = topicBody(page, topicIds[0]);
    const measure = () =>
      node.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const next = el.nextElementSibling?.getBoundingClientRect();
        const header = el
          .querySelector(".study-topic-toggle")!
          .getBoundingClientRect();
        return {
          height: box.height,
          nextOffset: next ? next.top - box.top : null,
          headerHeight: header.height,
          connectorTop: parseFloat(getComputedStyle(el, "::before").top),
        };
      });
    const closed = await measure();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(panel).toBeVisible();
    await expect(body).toHaveText(narrative);
    await expect(page.locator("dialog[open], [role=dialog]")).toHaveCount(0);
    const expanded = await measure();
    expect(expanded.height).toBeGreaterThan(closed.height + 500);
    expect(closed.nextOffset).not.toBeNull();
    expect(expanded.nextOffset).toBeGreaterThan(closed.nextOffset! + 500);
    expect(
      Math.abs(expanded.connectorTop - expanded.headerHeight / 2),
    ).toBeLessThan(2);
    expect(Math.abs(expanded.connectorTop - closed.connectorTop)).toBeLessThan(
      2,
    );
    expect(await panel.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
      false,
    );
    expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(
      false,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await toggle.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `.artifacts/study-topic-assessment-${width}.png`,
    });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(panel).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(body).toBeVisible();
    await expect(body).toHaveText(narrative);
  });
}
