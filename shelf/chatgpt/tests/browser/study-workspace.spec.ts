import { expect, test } from "@playwright/test";
import {
  mockNativeStudy,
  openNativeQuestion,
  enterNativeGame,
  flushNativeSave,
  nativeState,
} from "./native-study-harness";

test("study-only view starts from the home screen, saves native results and keeps gameplay frozen across reload", async ({
  page,
}) => {
  const relay = await mockNativeStudy(page);
  await page.goto("/");
  await page.locator("#study-only-toggle").click();
  await expect(page.locator("#study-workspace")).toBeVisible();
  await expect(page).toHaveTitle("Learning workspace");
  await expect(page.locator(".study-map-root")).toContainText("7 of 131");
  await expect(
    page.locator('.study-map-track[data-track="PY"] > .study-map-track-node'),
  ).toContainText("2 of 80");
  await expect(
    page.locator('.study-map-track[data-track="PE"] > .study-map-track-node'),
  ).toContainText("5 of 51");
  await expect(page.locator("#world")).toBeHidden();
  await expect(page.locator(".game-layout")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.locator("#pause-menu")).not.toBeVisible();
  await page.locator("#study-next").click();
  await expect.poll(() => relay.calls.length).toBe(1);
  const payload = relay.calls[0].payload;
  const currentTopicKey =
    payload.problem.contract.objectiveIds[0].split(".")[0];
  const currentTopic = page.locator(
    `.study-map-topic[data-topic-key="${currentTopicKey}"]`,
  );
  await expect(page.locator(".study-map-topic.is-current")).toHaveCount(1);
  await expect(currentTopic).toHaveClass(/is-current/);
  await expect(currentTopic).toHaveAttribute("aria-current", "step");
  await expect(currentTopic).toContainText(
    payload.problem.contract.review ? "Reviewing Tier 1" : "Probing now",
  );
  const id = payload.encounterId;
  const original = await nativeState(page, id);
  expect(id).toMatch(/^study-/);
  await expect(page.locator("#study-next")).toHaveText("Stop question");
  const before = await page.evaluate(() => {
    const g = (window as any).__deadAir.game;
    return {
      time: g.time,
      rng: g.rng,
      actors: g.survivors,
      zombies: g.zombies,
    };
  });
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as any).__copiedStudyRequest = text;
        },
      },
    });
  });
  await page.locator("#native-study-copy").click();
  const request = await page.evaluate(
    () => (window as any).__copiedStudyRequest,
  );
  expect(request).toContain("get_current_study_question");
  expect(request).toContain(`chat: "${relay.calls[0].chatCode}"`);
  await expect(page.locator("#study-message")).toContainText("Copied");
  await flushNativeSave(page);
  await page.reload();
  await expect(page.locator("#study-workspace")).toBeVisible();
  await expect.poll(() => relay.calls.length).toBe(2);
  expect(relay.calls[1]).toEqual(relay.calls[0]);
  await page.keyboard.press("e");
  await page.keyboard.press("Space");
  relay.finish(payload.requestId);
  await expect(page.locator("#study-save-status")).toContainText(
    "Learning result received and saved",
  );
  const completed = await nativeState(page, id);
  expect(completed.keys).toBe(original.keys);
  expect(completed.submissions).toBe(1);
  await expect(page.locator("#study-next")).toBeEnabled();
  const after = await page.evaluate(() => {
    const g = (window as any).__deadAir.game;
    return {
      time: g.time,
      rng: g.rng,
      actors: g.survivors,
      zombies: g.zombies,
    };
  });
  // Reload intentionally releases physical station handles; positions/health
  // and the rest of the unstarted world's state remain unchanged.
  expect(after.time).toBe(before.time);
  expect(after.rng).toBe(before.rng);
  expect(after.zombies).toEqual(before.zombies);
  expect(after.actors.map((a: any) => [a.x, a.y, a.hp])).toEqual(
    before.actors.map((a: any) => [a.x, a.y, a.hp]),
  );
  await page.screenshot({
    path: ".artifacts/study-workspace-desktop.png",
    fullPage: true,
  });
  await page.locator("#study-next").click();
  await expect.poll(() => relay.calls.length).toBe(3);
  expect(relay.calls[2].payload.encounterId).not.toBe(id);
  expect(relay.calls[2].payload.problem.contract.track).not.toBe(
    payload.problem.contract.track,
  );
  expect(relay.calls[2].chatCode).not.toBe(relay.calls[0].chatCode);
});

test("switching an active game to study view reuses the current chat and restores the saved run", async ({
  page,
}) => {
  const relay = await mockNativeStudy(page);
  await enterNativeGame(page);
  const id = await openNativeQuestion(page);
  await expect.poll(() => relay.calls.length).toBe(1);
  await page.locator("#study-only-toggle").click();
  const time = await page.evaluate(() => (window as any).__deadAir.game.time);
  await expect(page.locator("#native-study-status")).toContainText("ChatGPT");
  await expect(page.locator("#study-next")).toHaveText("Stop question");
  await page.keyboard.press("Escape");
  await expect(page.locator("#world")).toBeHidden();
  expect(relay.calls).toHaveLength(1);
  expect((await nativeState(page, id)).session.id).toBe(
    relay.calls[0].payload.requestId,
  );
  expect(await page.evaluate(() => (window as any).__deadAir.game.time)).toBe(
    time,
  );
  await page.locator("#study-only-exit").click();
  await expect(page.locator("#world")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as any).__deadAir.game.time))
    .toBeGreaterThan(time);
  expect(relay.calls).toHaveLength(1);
  await page.locator("#pause-toggle").click();
  await page.locator("#study-only-menu").click();
  await expect(page.locator("#world")).toBeHidden();
  await page.locator("#study-only-exit").click();
  await expect(page.locator("#pause-menu")).toBeVisible();
  expect(await page.evaluate(() => (window as any).__deadAir.game.paused)).toBe(
    true,
  );
});

test("an unsaved ChatGPT result shows a failure and can be saved again without duplicate delivery", async ({
  page,
}) => {
  const relay = await mockNativeStudy(page);
  await page.goto("/");
  await page.locator("#study-only-toggle").click();
  await page.locator("#study-next").click();
  await expect.poll(() => relay.calls.length).toBe(1);
  await flushNativeSave(page);
  await page.evaluate(() => {
    const transaction = IDBDatabase.prototype.transaction;
    const setItem = Storage.prototype.setItem;
    (window as any).__restoreStudyStorage = () => {
      IDBDatabase.prototype.transaction = transaction;
      Storage.prototype.setItem = setItem;
    };
    IDBDatabase.prototype.transaction = function (...args: any[]) {
      if (args[1] === "readwrite") throw Error("Synthetic disk full");
      return (transaction as any).apply(this, args);
    };
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("dead-air-save")) throw Error("Synthetic disk full");
      return setItem.call(this, key, value);
    };
  });
  relay.finish(relay.calls[0].payload.requestId);
  await expect(page.locator("#native-study-status")).toContainText(
    "result received",
  );
  await expect(page.locator("#study-save-status")).toContainText("Save failed");
  await expect(page.locator("#study-save-status")).not.toContainText(
    "received and saved",
  );
  await expect(page.locator("#study-save-retry")).toBeVisible();
  await expect(page.locator("#study-next")).toBeDisabled();
  await page.evaluate(() => (window as any).__restoreStudyStorage());
  await page.locator("#study-save-retry").click();
  await expect(page.locator("#study-save-status")).toContainText(
    "Learning result received and saved",
  );
  await expect(page.locator("#study-next")).toBeEnabled();
  expect(relay.calls).toHaveLength(1);
});

test("study dashboard fits a narrow screen and offers clipboard fallback without gameplay controls", async ({
  page,
}) => {
  await mockNativeStudy(page, false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.locator("#study-only-toggle").click();
  await page.locator("#study-next").click();
  await expect(page.locator("#native-study-connect")).toBeVisible();
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw Error("Synthetic clipboard denial");
        },
      },
    }),
  );
  await page.locator("#native-study-copy").click();
  await expect(page.locator("#native-study-request")).toBeVisible();
  await expect(page.locator("#native-study-request")).toHaveValue(
    /chat: "[A-Z0-9]+"/,
  );
  await expect(page.locator("#world")).toBeHidden();
  const map = page.locator(".study-skill-map");
  const python = map.locator('.study-map-track[data-track="PY"]');
  const product = map.locator('.study-map-track[data-track="PE"]');
  const topic = product.locator('.study-map-topic[data-topic-key="PE:T10"]');
  await expect(map.locator("details, .study-checkpoint")).toHaveCount(0);
  await expect(topic).toContainText("1 of 2");
  const pythonBox = await python.boundingBox();
  const productBox = await product.boundingBox();
  expect(pythonBox).not.toBeNull();
  expect(productBox).not.toBeNull();
  expect(productBox!.y).toBeGreaterThanOrEqual(
    pythonBox!.y + pythonBox!.height,
  );
  await expect(map.locator(".study-map-topic.is-current")).toHaveCount(1);
  await expect(map.locator(".study-map-topic.is-current")).toHaveAttribute(
    "aria-current",
    "step",
  );
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  expect(overflow).toBe(false);
  await page.screenshot({
    path: ".artifacts/study-workspace-mobile.png",
    fullPage: true,
  });
});

test("missing clipboard support exposes both study prompts without an unhandled error", async ({
  page,
}) => {
  const relay = await mockNativeStudy(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.locator("#study-only-toggle").click();
  await page.locator("#study-next").click();
  await expect.poll(() => relay.calls.length).toBe(1);
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    }),
  );
  await page.locator("#native-study-copy").click();
  const request = page.locator("#native-study-request");
  await expect(request).toBeVisible();
  await expect(request).toHaveValue(/get_current_study_question/);
  await expect(request).toBeFocused();
  await expect(page.locator("#native-study-finish")).toBeVisible();
  await page.locator("#native-study-finish").click();
  await expect(request).toBeVisible();
  await expect(request).toHaveValue(
    new RegExp(relay.calls[0].payload.questionFingerprint),
  );
  await expect(request).toHaveValue(/finish_study_question/);
  await expect(request).toBeFocused();
  expect(errors).toEqual([]);
  expect(relay.calls).toHaveLength(1);
  relay.finish(relay.calls[0].payload.requestId);
  await expect(page.locator("#study-save-status")).toContainText(
    "Learning result received and saved",
  );
  await expect(request).toBeHidden();
  await expect(request).toHaveValue("");
  await page.locator("#study-next").click();
  await expect.poll(() => relay.calls.length).toBe(2);
  await expect(request).toBeHidden();
  await page.locator("#native-study-copy").click();
  await expect(request).toHaveValue(
    new RegExp(`chat: "${relay.calls[1].chatCode}"`),
  );
  await expect(request).not.toHaveValue(
    new RegExp(`chat: "${relay.calls[0].chatCode}"`),
  );
});

test("a late clipboard failure cannot replace the newer completion recovery prompt", async ({
  page,
}) => {
  await mockNativeStudy(page);
  await page.goto("/");
  await page.locator("#study-only-toggle").click();
  await page.locator("#study-next").click();
  await expect(page.locator("#native-study-finish")).toBeVisible();
  await page.evaluate(() => {
    const pending: Array<() => void> = [];
    (window as any).__rejectClipboard = (index: number) => pending[index]();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () =>
          new Promise((_resolve, reject) => {
            pending.push(() => reject(Error("Synthetic delayed denial")));
          }),
      },
    });
  });
  await page.locator("#native-study-copy").click();
  await page.locator("#native-study-finish").click();
  await page.evaluate(() => (window as any).__rejectClipboard(1));
  const request = page.locator("#native-study-request");
  await expect(request).toHaveValue(/finish_study_question/);
  const newer = await request.inputValue();
  await page.evaluate(() => (window as any).__rejectClipboard(0));
  await expect(request).toHaveValue(newer);
  await expect(page.locator("#study-message")).toContainText(
    "existing ChatGPT chat",
  );
});

test("tier skill map shows connected topic nodes vertically and marks the current topic in a split pane", async ({
  page,
}) => {
  await mockNativeStudy(page);
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

test("one session button stops, preserves across reload and resumes the same question in a new chat", async ({
  page,
}) => {
  const relay = await mockNativeStudy(page);
  await page.goto("/");
  await page.locator("#study-only-toggle").click();
  const action = page.locator("#study-next");
  await action.click();
  await expect.poll(() => relay.calls.length).toBe(1);
  const first = relay.calls[0];
  await expect(action).toHaveText("Stop question");
  await action.click();
  await expect(action).toHaveText("Resume in new chat");
  await expect(page.locator("#native-study-status")).toContainText(
    "Question stopped and saved",
  );
  await expect(page.locator("#native-study-copy")).toBeHidden();
  await expect(page.locator("#native-study-finish")).toBeHidden();
  await flushNativeSave(page);
  relay.finish(first.payload.requestId);
  await page.reload();
  await expect(action).toHaveText("Resume in new chat");
  await expect(action).toBeEnabled();
  expect(relay.calls).toHaveLength(1);
  expect((await nativeState(page, first.payload.encounterId)).submissions).toBe(
    0,
  );
  await action.click();
  await expect.poll(() => relay.calls.length).toBe(2);
  const second = relay.calls[1];
  expect(second.chatCode).not.toBe(first.chatCode);
  expect(second.payload.requestId).not.toBe(first.payload.requestId);
  expect(second.payload.questionFingerprint).toBe(
    first.payload.questionFingerprint,
  );
  expect(second.payload.problem).toEqual(first.payload.problem);
  await expect(action).toHaveText("Stop question");
  await expect(page.locator("#native-study-copy")).toBeVisible();
  await expect(page.locator("#study-message")).toContainText(
    "new ChatGPT chat",
  );
  relay.finish(second.payload.requestId);
  await expect(action).toHaveText("Start next question");
  await expect(action).toBeEnabled();
  await expect(page.locator("#study-message")).toBeEmpty();
  expect((await nativeState(page, first.payload.encounterId)).submissions).toBe(
    1,
  );
});
