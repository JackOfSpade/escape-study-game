import { expect, test } from "@playwright/test";
import { mockClaudeStudy } from "./study-harness";

test("tier skill map shows connected topic nodes vertically and marks the current topic in a split pane", async ({
  page,
}) => {
  await mockClaudeStudy(page);
  await page.setViewportSize({ width: 700, height: 900 });
  await page.goto("/");
  await page.locator("#study-only-toggle").click();
  const map = page.locator(".study-skill-map");
  const root = map.locator(".study-map-root");
  const columns = map.locator(".study-map-columns");
  const python = map.locator('.study-map-track[data-track="PY"]');
  const product = map.locator('.study-map-track[data-track="PE"]');
  const api = product.locator('.study-map-topic[data-topic-key="PE:T10"]');
  const scroll = map.locator(".study-map-scroll");
  await scroll.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(root).toContainText("7 of 131");
  await expect(map.locator("details, .study-checkpoint")).toHaveCount(0);
  await expect(api).toContainText("1 of 2");

  // Every required topic is present without opening a branch. The diagram's
  // nodes are curriculum topics, rather than individual checkpoint leaves.
  const requiredTopicKeys = await page.evaluate(async () => {
    const source = "/src/study-progress.ts";
    const { studyTrackProgress } = await import(/* @vite-ignore */ source);
    const d = (window as any).__deadAir;
    return (["PY", "PE"] as const).flatMap((track) =>
      studyTrackProgress(d.roadmap, d.game.study, track).topics.map(
        (topic: { id: string }) => `${track}:${topic.id}`,
      ),
    );
  });
  await expect(map.locator(".study-map-topic")).toHaveCount(
    requiredTopicKeys.length,
  );
  expect(
    await map
      .locator(".study-map-topic")
      .evaluateAll((nodes) =>
        nodes.map((node) => (node as HTMLElement).dataset.topicKey),
      ),
  ).toEqual(requiredTopicKeys);

  const rootBox = await root.boundingBox();
  const pythonBox = await python.boundingBox();
  const productBox = await product.boundingBox();
  expect(rootBox).not.toBeNull();
  expect(pythonBox).not.toBeNull();
  expect(productBox).not.toBeNull();
  expect(pythonBox!.y).toBeGreaterThan(rootBox!.y + rootBox!.height);
  expect(productBox!.y).toBe(pythonBox!.y);
  expect(productBox!.x).toBeGreaterThan(pythonBox!.x + pythonBox!.width);
  for (const track of [python, product]) {
    const headerBox = await track
      .locator(".study-map-track-node")
      .boundingBox();
    const topicBoxes = await track
      .locator(".study-map-topic")
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const rect = node.getBoundingClientRect();
          return { x: rect.x, y: rect.y, height: rect.height };
        }),
      );
    expect(headerBox).not.toBeNull();
    expect(topicBoxes[0].y).toBeGreaterThan(headerBox!.y + headerBox!.height);
    for (let i = 1; i < topicBoxes.length; i++) {
      expect(topicBoxes[i].y).toBeGreaterThanOrEqual(
        topicBoxes[i - 1].y + topicBoxes[i - 1].height,
      );
      expect(topicBoxes[i].x).toBe(topicBoxes[0].x);
    }
  }
  const connector = await columns.evaluate((node) => {
    const style = getComputedStyle(node, "::before");
    return {
      content: style.content,
      display: style.display,
      height: parseFloat(style.height),
      width: parseFloat(style.width),
    };
  });
  expect(connector.content).not.toBe("none");
  expect(connector.display).not.toBe("none");
  expect(connector.height).toBeGreaterThan(0);
  expect(connector.width).toBeGreaterThan(0);
  for (const track of [python, product]) {
    for (const node of [
      track.locator(".study-map-topics"),
      track.locator(".study-map-topic").first(),
    ]) {
      const line = await node.evaluate((element) => {
        const style = getComputedStyle(element, "::before");
        return {
          content: style.content,
          display: style.display,
          width: parseFloat(style.width),
          height: parseFloat(style.height),
        };
      });
      expect(line.content).not.toBe("none");
      expect(line.display).not.toBe("none");
      expect(line.width).toBeGreaterThan(0);
      expect(line.height).toBeGreaterThan(0);
    }
  }

  // The root connector belongs to the scrolling diagram: it is visible at
  // the top, scrolls out with the branches, and returns with the diagram.
  const rootStem = scroll.locator(".study-map-root-stem");
  await expect(rootStem).toHaveCount(1);
  const stemWithinMap = () =>
    rootStem.evaluate((node) => {
      const scroller = node.closest(".study-map-scroll")!;
      const stemBox = node.getBoundingClientRect();
      const scrollBox = scroller.getBoundingClientRect();
      return (
        stemBox.width > 0 &&
        stemBox.height > 0 &&
        stemBox.top >= scrollBox.top &&
        stemBox.bottom <= scrollBox.bottom
      );
    });
  expect(await stemWithinMap()).toBe(true);
  expect(
    await root.evaluate((node) => getComputedStyle(node, "::after").content),
  ).toBe("none");
  await scroll.evaluate((el) => {
    el.scrollTop = 120;
  });
  const stemAboveMap = await rootStem.evaluate((node) => {
    const scroller = node.closest(".study-map-scroll")!;
    return (
      node.getBoundingClientRect().bottom <=
      scroller.getBoundingClientRect().top
    );
  });
  expect(stemAboveMap).toBe(true);
  await scroll.evaluate((el) => {
    el.scrollTop = 0;
  });
  expect(await stemWithinMap()).toBe(true);

  await map.screenshot({ path: ".artifacts/study-topic-tree.png" });
  await scroll.evaluate((el) => {
    el.scrollTop = 120;
  });
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBe(120);

  // Force an actual progress-content update in this synthetic context. This is
  // imported practice credit, not an assessment or a real learner save.
  await page.evaluate(() => {
    const objective = (
      window as any
    ).__deadAir.roadmap.tracks.PY.objectives.find(
      (o: any) => o.cells[0] !== "P",
    );
    objective.cells[0] = "P";
  });
  await expect(root).toContainText("8 of 131");
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBe(120);

  const currentKey = await map
    .locator(".study-map-topic.is-current")
    .getAttribute("data-topic-key");
  expect(currentKey).toMatch(/^(PY|PE):/);
  const current = map.locator(
    `.study-map-topic[data-topic-key="${currentKey}"]`,
  );
  await expect(current).toHaveAttribute("aria-current", "step");
  await expect(map.locator(".study-map-topic.is-current")).toHaveCount(1);
  await expect(python.locator(".study-map-track-node")).toContainText(
    "3 of 80",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  const dimensions = await scroll.evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  expect(dimensions.height).toBeLessThan(630);
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
  await page.screenshot({
    path: ".artifacts/study-skill-map-split-pane.png",
    fullPage: true,
  });
});
