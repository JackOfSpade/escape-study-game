import { expect, test, type Page } from "@playwright/test";
import {
  finishWithGap,
  flushStudySave,
  lessonFixture,
  mockClaudeStudy,
} from "./study-harness";

type Study = Awaited<ReturnType<typeof mockClaudeStudy>>;

const NOTICE =
  "Written by AI and may contain errors. Reading it gives no credit: this gap stays open until a question shows you have it.";

/** A finished question with a recorded gap, then its lesson opened. */
async function openLesson(page: Page, study: Study) {
  await finishWithGap(page, study);
  await page.locator("#lesson-offers button").click();
}

async function readyLesson(page: Page, study: Study) {
  await openLesson(page, study);
  await expect(page.locator("#lesson-body .lesson-section")).not.toHaveCount(0);
}

/** The saved record's three parts that a lesson must never change. */
const savedRecord = (page: Page) =>
  page.evaluate(async () => {
    const root = "/src/";
    const { readDurable } = await import(
      /* @vite-ignore */ root + "storage.ts"
    );
    const { decode } = await import(/* @vite-ignore */ root + "persistence.ts");
    const stored = JSON.parse(await readDurable("dead-air-save-v1"));
    const g = decode(stored.data);
    return JSON.stringify([
      g.study.knowledgeGaps,
      g.study.learner,
      g.encounters,
    ]);
  });

/** Every row stored in the lesson database. */
const lessonRows = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open("dead-air-lessons");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const all = db.transaction("lessons").objectStore("lessons").getAll();
          all.onerror = () => reject(all.error);
          all.onsuccess = () => {
            db.close();
            resolve(all.result as string[]);
          };
        };
      }),
  );

test("a recorded gap offers a lesson, which is written and shown with its notice and every block kind", async ({
  page,
}) => {
  const study = await mockClaudeStudy(page);
  await finishWithGap(page, study);
  const offer = page.locator("#lesson-offers");
  await expect(offer).toBeVisible();
  await expect(offer.locator("button")).toHaveText("Learn this");
  study.holdLessons();
  await offer.locator("button").click();
  await expect(page.locator("#study-lesson-slot")).toBeVisible();
  await expect(page.locator("#terminal")).toBeHidden();
  await expect(page.locator("#lesson-title")).toBeFocused();
  await expect(page.locator("#lesson-status")).toContainText(
    "Claude is writing your lesson. This can take a few minutes.",
  );
  await expect(page.locator("#lesson-status .lesson-elapsed")).toHaveText(
    /^\d+:\d\d$/,
  );
  await expect(page.locator("#lesson-notice")).toHaveText(NOTICE);
  study.releaseLessons();
  await expect(page.locator("#lesson-title")).toHaveText(
    "How a running total works",
  );
  const body = page.locator("#lesson-body");
  await expect(body.locator(".lesson-prose").first()).toBeVisible();
  for (const kind of [
    ".lesson-callout",
    ".lesson-code-figure",
    ".lesson-diagram",
    ".lesson-table",
    "figure.lesson-steps",
    ".lesson-predict",
    ".lesson-recall",
  ])
    await expect(body.locator(kind).first()).toBeAttached();
  await expect(body.locator(".lesson-section")).toHaveCount(4);
  await expect(page.locator("#lesson-status")).toBeHidden();
  await expect(page.locator("#lesson-footer-note")).toContainText(
    "This gap stays open until a question shows you have it.",
  );
  expect(study.lessonCalls()).toHaveLength(1);
  const sent = study.lessonCalls()[0].payload;
  expect(sent.requestId).toMatch(/^lesson-/);
  expect(typeof sent.gapId).toBe("string");
});

test("the step-through figure advances with its buttons and with the arrow keys", async ({
  page,
}) => {
  const study = await mockClaudeStudy(page);
  await readyLesson(page, study);
  const figure = page.locator("figure.lesson-steps");
  const count = figure.locator(".lesson-steps-count");
  await expect(count).toHaveText("Step 1 of 3");
  await figure.getByRole("button", { name: "Next" }).click();
  await expect(count).toHaveText("Step 2 of 3");
  await expect(figure.locator(".lesson-steps-caption")).toHaveText(
    "Add the first number.",
  );
  await figure.focus();
  await page.keyboard.press("ArrowRight");
  await expect(count).toHaveText("Step 3 of 3");
  await page.keyboard.press("ArrowLeft");
  await expect(count).toHaveText("Step 2 of 3");
  await figure.getByRole("button", { name: "Restart" }).click();
  await expect(count).toHaveText("Step 1 of 3");
});

test("choosing a prediction reveals a neutral explanation that survives closing the lesson", async ({
  page,
}) => {
  const study = await mockClaudeStudy(page);
  await readyLesson(page, study);
  const predict = page.locator(".lesson-predict");
  await expect(predict.locator(".lesson-explanation")).toBeHidden();
  await predict.getByRole("button", { name: "6", exact: true }).click();
  await expect(predict.locator(".lesson-predict-result")).toHaveText(
    "The lesson's answer is: 3.",
  );
  await expect(predict.locator(".lesson-explanation")).toBeVisible();
  await expect(predict.locator(".lesson-explanation")).toContainText(
    "One plus two is three.",
  );
  await page.locator("#lesson-close").click();
  await expect(page.locator("#study-lesson-slot")).toBeHidden();
  await expect(page.locator("#lesson-offers button")).toHaveText("Open lesson");
  await page.locator("#lesson-offers button").click();
  await expect(
    page.locator(".lesson-predict .lesson-predict-result"),
  ).toHaveText("The lesson's answer is: 3.");
  await expect(
    page.locator(".lesson-predict .lesson-explanation"),
  ).toBeVisible();
  // Reading and answering are only a lesson's own state.
  expect(study.lessonCalls()).toHaveLength(1);
});

test("the recall reveal unlocks after twenty characters", async ({ page }) => {
  const study = await mockClaudeStudy(page);
  await readyLesson(page, study);
  const recall = page.locator(".lesson-recall");
  const reveal = recall.locator(".lesson-recall-reveal");
  await expect(reveal).toBeDisabled();
  await recall.locator("textarea").fill("a".repeat(19));
  await expect(reveal).toBeDisabled();
  await recall.locator("textarea").fill("a".repeat(20));
  await expect(reveal).toBeEnabled();
  await reveal.click();
  await expect(recall.locator(".lesson-recall-compare")).toBeVisible();
  await expect(recall.locator(".lesson-recall-compare")).toContainText(
    "It is a value that grows as each item is added.",
  );
});

test("the tutor chat answers, points at a section, and a failed reply retries", async ({
  page,
}) => {
  const study = await mockClaudeStudy(page);
  await readyLesson(page, study);
  // Three quiet suggestions start the chat.
  await expect(
    page.locator("#lesson-messages [data-lesson-suggest]"),
  ).toHaveCount(3);
  study.replyChat(() => ({
    text: "Look at the **last** check.",
    section: "check",
  }));
  const input = page.locator("#lesson-chat-input");
  await input.fill("Where do I practise this?");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  const human = page.locator("#lesson-messages .message.human");
  await expect(human).toContainText("Where do I practise this?");
  const tutor = page.locator("#lesson-messages .message.tutor");
  await expect(tutor).toContainText("Look at the last check.");
  expect(study.chatCalls()).toHaveLength(1);
  const request = study.chatCalls()[0].payload;
  expect(request.sectionIds).toEqual([
    "idea",
    "picture",
    "walkthrough",
    "check",
  ]);
  expect(request.message).toBe("Where do I practise this?");
  const pane = page.locator("#lesson .lesson-pane");
  expect(await pane.evaluate((el) => el.scrollTop)).toBe(0);
  await page.getByRole("button", { name: "Show: Check yourself" }).click();
  await expect(
    page.locator("#lesson-section-check .lesson-section-title"),
  ).toBeFocused();
  await expect
    .poll(() => pane.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  // Shift+Enter writes a newline instead of sending.
  await input.fill("first");
  await input.press("Shift+Enter");
  await input.pressSequentially("second");
  await expect(input).toHaveValue("first\nsecond");
  expect(study.chatCalls()).toHaveLength(1);
  await input.fill("");
  // A reply that fails shows its reason and a retry.
  study.fail("lesson-chat", "Synthetic reply failure");
  study.replyChat(() => ({ text: "Second try worked." }));
  await input.fill("Try this one");
  await input.press("Enter");
  const status = page.locator("#lesson-chat-status");
  await expect(status).toContainText("Synthetic reply failure");
  await status.getByRole("button", { name: "Try again" }).click();
  await expect(tutor.last()).toContainText("Second try worked.");
  await expect(status).toBeHidden();
  expect(study.chatCalls()).toHaveLength(3);
  expect(study.chatCalls()[2].payload.requestId).not.toBe(
    study.chatCalls()[1].payload.requestId,
  );
});

test("a hostile lesson and a hostile reply are drawn as text and run nothing", async ({
  page,
}) => {
  const study = await mockClaudeStudy(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => void dialog.dismiss());
  study.replyLesson((body) => ({
    requestId: body.payload.requestId,
    gapId: body.payload.gapId,
    lesson: lessonFixture(true),
  }));
  await readyLesson(page, study);
  study.replyChat(() => ({
    text: '<img src=x onerror="window.__pwned=1"> <script>window.__pwned=1</script>',
  }));
  await page.locator("#lesson-chat-input").fill("Hello");
  await page.locator("#lesson-chat-input").press("Enter");
  await expect(page.locator("#lesson-messages .message.tutor")).toContainText(
    "<img src=x",
  );
  // The learner's own recall text is text too.
  await page
    .locator(".lesson-recall textarea")
    .fill('<img src=x onerror="window.__pwned=1"> and more');
  // The answer is saved with the lesson once its pause has passed.
  await expect
    .poll(async () => (await lessonRows(page)).join("\n"))
    .toContain("and more");
  const lesson = page.locator("#study-lesson-slot");
  // Every block was drawn: none was dropped for its text.
  await expect(page.locator("#lesson-status")).not.toContainText("left out");
  expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
  await expect(lesson.locator("#lesson-body img")).toHaveCount(0);
  await expect(lesson.locator("script")).toHaveCount(0);
  await expect(lesson.locator("#lesson-messages img")).toHaveCount(0);
  await expect(page.locator("#lesson-body")).toContainText("<img src=x");
  await expect(page.locator("#lesson-body")).toContainText(
    "<script>window.__pwned=1</script>",
  );
  expect(
    await lesson.evaluate(
      (root) =>
        [...root.querySelectorAll("*")].filter((el) =>
          [...el.attributes].some((a) => /^on/i.test(a.name)),
        ).length,
    ),
  ).toBe(0);
  expect(errors).toEqual([]);
});

test("reading, answering and chatting leave the saved record untouched and live in their own database", async ({
  page,
}) => {
  const study = await mockClaudeStudy(page);
  await finishWithGap(page, study);
  await flushStudySave(page);
  await expect.poll(() => savedRecord(page)).toContain("knowledge");
  const before = await savedRecord(page);
  await page.locator("#lesson-offers button").click();
  await expect(page.locator("#lesson-body .lesson-section")).not.toHaveCount(0);
  await page.locator("#lesson-read").click();
  await expect(page.locator("#lesson-read")).toHaveText("Read");
  await page.getByRole("button", { name: "3", exact: true }).click();
  await page.locator(".lesson-recall textarea").fill("a running total grows");
  await page.locator("#lesson-chat-input").fill("Why?");
  await page.locator("#lesson-chat-input").press("Enter");
  await expect(page.locator("#lesson-messages .message.tutor")).toHaveCount(1);
  await page.locator("#lesson-close").click();
  await flushStudySave(page);
  await expect
    .poll(async () => (await lessonRows(page)).join("\n"))
    .toContain("a running total grows");
  const rows = await lessonRows(page);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toContain("How a running total works");
  expect(rows[0]).toContain("readAt");
  expect(await savedRecord(page)).toBe(before);
  // The gap is still open: nothing here closes it.
  const open = await page.evaluate(() =>
    (window as any).__deadAir.game.study.knowledgeGaps.filter(
      (g: any) => !g.resolved,
    ),
  );
  expect(open.length).toBeGreaterThan(0);
  // None of it went into a question's requests.
  for (const call of study.tutorCalls())
    expect(JSON.stringify(call)).not.toContain("running total");
});

test("an older bridge without the lesson operations says so, and checking again finds a newer one", async ({
  page,
}) => {
  const study = await mockClaudeStudy(page);
  study.setCapabilities(["generate", "tutor", "assess"]);
  await finishWithGap(page, study);
  await page.locator("#lesson-offers button").click();
  const status = page.locator("#lesson-status");
  await expect(status).toContainText(
    "Lessons need a newer study bridge. Restart the bridge, then try again.",
  );
  expect(study.lessonCalls()).toHaveLength(0);
  study.setCapabilities([
    "generate",
    "tutor",
    "assess",
    "lesson",
    "lesson-chat",
  ]);
  await status.getByRole("button", { name: "Check again" }).click();
  await expect(page.locator("#lesson-body .lesson-section")).not.toHaveCount(0);
  expect(study.lessonCalls()).toHaveLength(1);
});

test("a failed lesson shows its reason and Try again writes it", async ({
  page,
}) => {
  const study = await mockClaudeStudy(page);
  study.fail("lesson", "Synthetic lesson failure");
  await openLesson(page, study);
  const status = page.locator("#lesson-status");
  await expect(status).toContainText("Synthetic lesson failure");
  await status.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator("#lesson-body .lesson-section")).not.toHaveCount(0);
  await expect(status).toBeHidden();
  expect(study.lessonCalls()).toHaveLength(2);
});

test("no horizontal overflow at 390 pixels wide, and the composer can be reached", async ({
  page,
}) => {
  const study = await mockClaudeStudy(page);
  await page.setViewportSize({ width: 390, height: 800 });
  await readyLesson(page, study);
  const widths = () =>
    page.evaluate(() => ({
      page: document.documentElement.scrollWidth - innerWidth,
      layout:
        document.querySelector("#lesson .terminal-layout")!.scrollWidth -
        document.querySelector("#lesson .terminal-layout")!.clientWidth,
    }));
  expect(await widths()).toEqual({ page: 0, layout: 0 });
  for (const step of [
    "#lesson-notice",
    "figure.lesson-steps",
    ".lesson-recall",
  ])
    await page.locator(step).first().scrollIntoViewIfNeeded();
  expect(await widths()).toEqual({ page: 0, layout: 0 });
  await page.locator("#lesson-chat-input").scrollIntoViewIfNeeded();
  await expect(page.locator("#lesson-chat-input")).toBeInViewport();
  expect(await widths()).toEqual({ page: 0, layout: 0 });
});

test("at desktop width the document never scrolls and both panes scroll alone", async ({
  page,
}) => {
  const study = await mockClaudeStudy(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await readyLesson(page, study);
  const metrics = await page.evaluate(() => {
    const pane = document.querySelector("#lesson .lesson-pane")!;
    const root = document.documentElement;
    return {
      pageX: root.scrollWidth - innerWidth,
      pageY: root.scrollHeight - innerHeight,
      paneScrolls: pane.scrollHeight > pane.clientHeight,
    };
  });
  expect(metrics).toEqual({ pageX: 0, pageY: 0, paneScrolls: true });
  await expect(page.locator("#lesson-chat-input")).toBeInViewport();
});

test("Escape and Back close the lesson and return to the question", async ({
  page,
}) => {
  const study = await mockClaudeStudy(page);
  await readyLesson(page, study);
  await expect(page.locator("#terminal")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.locator("#study-lesson-slot")).toBeHidden();
  await expect(page.locator("#terminal")).toBeVisible();
  // The menu did not open in its place.
  await expect(page.locator("#pause-menu")).not.toHaveAttribute("open", "");
  await expect(page.locator("#lesson-offers button")).toBeFocused();
  await page.locator("#lesson-offers button").click();
  await expect(page.locator("#study-lesson-slot")).toBeVisible();
  await page.locator("#lesson-close").click();
  await expect(page.locator("#study-lesson-slot")).toBeHidden();
  await expect(page.locator("#terminal")).toBeVisible();
  // With no lesson open, Escape opens the menu as before.
  await page.keyboard.press("Escape");
  await expect(page.locator("#pause-menu")).toHaveAttribute("open", "");
});

test("after a reload the lesson is still there, read from its own database", async ({
  page,
}) => {
  const study = await mockClaudeStudy(page);
  await readyLesson(page, study);
  await page.locator(".lesson-recall textarea").fill("a running total grows");
  await page.locator("#lesson-chat-input").fill("Why?");
  await page.locator("#lesson-chat-input").press("Enter");
  await expect(page.locator("#lesson-messages .message.tutor")).toHaveCount(1);
  await expect
    .poll(async () => (await lessonRows(page)).join("\n"))
    .toContain("a running total grows");
  await page.locator("#lesson-close").click();
  await flushStudySave(page);
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__deadAir);
  const list = page.locator("#study-gaps");
  await expect(list).toBeVisible();
  await expect(list.locator("summary")).toContainText("Gaps to study (1)");
  await list.locator("summary").click();
  await list.locator("button").click();
  await expect(page.locator("#lesson-title")).toHaveText(
    "How a running total works",
  );
  await expect(page.locator("#lesson-body .lesson-section")).toHaveCount(4);
  await expect(page.locator(".lesson-recall textarea")).toHaveValue(
    "a running total grows",
  );
  await expect(page.locator("#lesson-messages .message")).toHaveCount(2);
  expect(study.lessonCalls()).toHaveLength(1);
  // The chat of this lesson is the only lesson traffic.
  expect(study.chatCalls()).toHaveLength(1);
});

/** Reads a value from the live record in the page. */
const gameState = <T>(page: Page, fn: (game: any) => T) =>
  page.evaluate(`(${fn.toString()})(window.__deadAir.game)`) as Promise<T>;

/** Ask the app to look at the bridge now instead of at its next poll. */
const recheckBridge = (page: Page) =>
  page.evaluate(async () => {
    const root = "/src/";
    const { checkBridge } = await import(/* @vite-ignore */ root + "ai.ts");
    await checkBridge();
  });

test("Test me on this closes the lesson and opens a practice question on the gap's contract", async ({
  page,
}) => {
  const study = await mockClaudeStudy(page);
  const first = await finishWithGap(page, study);
  await page.locator("#lesson-offers button").click();
  await expect(page.locator("#lesson-body .lesson-section")).not.toHaveCount(0);
  const issued = study.generateCalls()[0].payload.contract;
  await page.locator("#lesson-test").click();
  await expect(page.locator("#study-lesson-slot")).toBeHidden();
  await expect(page.locator("#terminal")).toBeVisible();
  const practice = await gameState(
    page,
    (game) => game.lastStudyEncounter as string,
  );
  expect(practice).not.toBe(first);
  await expect.poll(() => study.generateCalls().length).toBe(2);
  const sent = study.generateCalls()[1].payload.contract;
  expect(sent.practice).toBe(true);
  expect(sent.review).toBe(false);
  expect(sent.objectiveIds).toEqual(issued.objectiveIds);
  await expect(page.locator("#terminal-provenance")).toContainText(
    "Practice question",
  );
  // No lesson text went into the question's request.
  expect(JSON.stringify(study.generateCalls()[1])).not.toContain(
    "running total",
  );
});

test("a practice question survives a reload as the open question", async ({
  page,
}) => {
  const study = await mockClaudeStudy(page);
  await finishWithGap(page, study);
  await page.locator("#lesson-offers button").click();
  await expect(page.locator("#lesson-body .lesson-section")).not.toHaveCount(0);
  await page.locator("#lesson-test").click();
  const practice = await gameState(
    page,
    (game) => game.lastStudyEncounter as string,
  );
  // Generated, then saved.
  await expect
    .poll(() =>
      page.evaluate(
        (id) => !!(window as any).__deadAir.game.encounters[id].problem,
        practice,
      ),
    )
    .toBe(true);
  await expect(page.locator("#terminal-provenance")).toContainText(
    "Practice question",
  );
  await expect
    .poll(async () => {
      await flushStudySave(page);
      return page.evaluate(async () => {
        const root = "/src/";
        const { readDurable } = await import(
          /* @vite-ignore */ root + "storage.ts"
        );
        const { decode } = await import(
          /* @vite-ignore */ root + "persistence.ts"
        );
        const stored = JSON.parse(await readDurable("dead-air-save-v1"));
        const g = decode(stored.data);
        return Object.values(g.encounters).some(
          (e: any) => e.problem?.contract?.practice === true,
        );
      });
    })
    .toBe(true);
  const generated = study.generateCalls().length;
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__deadAir);
  await expect(page.locator("#terminal")).toBeVisible();
  await expect(page.locator("#terminal-provenance")).toContainText(
    "Practice question",
  );
  expect(
    await gameState(page, (game) => game.lastStudyEncounter as string),
  ).toBe(practice);
  expect(study.generateCalls()).toHaveLength(generated);
});

test("with the bridge down the test is not offered, says why, and the lesson stays readable", async ({
  page,
}) => {
  const study = await mockClaudeStudy(page);
  await readyLesson(page, study);
  await expect(page.locator("#lesson-test")).toBeVisible();
  study.setAvailable(false);
  await recheckBridge(page);
  await expect(page.locator("#lesson-test")).toBeHidden();
  await expect(page.locator("#lesson-footer-note")).toContainText(
    "Claude is not connected",
  );
  await expect(page.locator("#study-lesson-slot")).toBeVisible();
  await expect(page.locator("#lesson-body .lesson-section")).toHaveCount(4);
  await expect(page.locator("#lesson-footer-note")).toHaveAttribute(
    "role",
    "status",
  );
  // Back again: the button returns.
  study.setAvailable(true);
  await recheckBridge(page);
  await expect(page.locator("#lesson-test")).toBeVisible();
});

test("a lesson on a topic with an unfinished question is blocked and asks for nothing", async ({
  page,
}) => {
  const study = await mockClaudeStudy(page);
  await finishWithGap(page, study);
  await flushStudySave(page);
  // A second, unfinished question on the same objectives, added to the live
  // record the way a learner would have one after another visit began.
  await page.evaluate(() => {
    const game = (window as any).__deadAir.game;
    const done = Object.values<any>(game.encounters).find(
      (e) => e.state === "consumed",
    );
    const other = structuredClone(done);
    other.id = "study-unfinished";
    other.state = "in-progress";
    game.encounters[other.id] = other;
  });
  const before = study.lessonCalls().length;
  await page.locator("#study-map-peek").click();
  const list = page.locator("#study-gaps");
  await expect(list).toBeVisible();
  await list.locator("summary").click();
  await list.locator("button").click();
  await expect(page.locator("#lesson-status")).toContainText(
    "Finish the open question on this topic first",
  );
  await expect(page.locator("#lesson-body .lesson-section")).toHaveCount(0);
  expect(study.lessonCalls()).toHaveLength(before);
});

test("save and recovery status stay visible while a lesson is open", async ({
  page,
}) => {
  const study = await mockClaudeStudy(page);
  await readyLesson(page, study);
  const shown = await page.evaluate(() => {
    const visible = (selector: string, text: string) => {
      const el = document.querySelector<HTMLElement>(selector)!;
      const before = el.textContent;
      const wasHidden = el.hidden;
      // Written and read in one step, so no repaint can undo it.
      el.textContent = text;
      el.hidden = false;
      const out =
        getComputedStyle(el).display !== "none" &&
        el.getClientRects().length > 0;
      el.textContent = before;
      el.hidden = wasHidden;
      return out;
    };
    return {
      save: visible("#study-save-status", "Saved."),
      message: visible("#study-message", "A note."),
      next: getComputedStyle(document.querySelector("#study-next")!).display,
      heading: getComputedStyle(document.querySelector("#study-session-title")!)
        .display,
    };
  });
  expect(shown).toEqual({
    save: true,
    message: true,
    next: "none",
    heading: "none",
  });
  await expect(page.locator("#study-lesson-slot")).toBeVisible();
});

test("the chat draft belongs to its gap", async ({ page }) => {
  const study = await mockClaudeStudy(page);
  await finishWithGap(page, study);
  // A second gap recorded by the same question.
  await page.evaluate(() => {
    const game = (window as any).__deadAir.game;
    const first = game.study.knowledgeGaps[0];
    game.study.knowledgeGaps.push({
      ...structuredClone(first),
      id: `${first.id}-second`,
      facet: { id: "other", description: "A second idea" },
    });
  });
  const offers = page.locator("#lesson-offers button");
  await expect(offers).toHaveCount(2);
  const input = page.locator("#lesson-chat-input");
  await offers.nth(0).click();
  await expect(page.locator("#lesson-body .lesson-section")).not.toHaveCount(0);
  await input.fill("About the first gap");
  await page.locator("#lesson-close").click();
  await offers.nth(1).click();
  await expect(page.locator("#lesson-body .lesson-section")).not.toHaveCount(0);
  await expect(input).toHaveValue("");
  await input.fill("About the second gap");
  await page.locator("#lesson-close").click();
  await offers.nth(0).click();
  await expect(input).toHaveValue("About the first gap");
  await page.locator("#lesson-close").click();
  await offers.nth(1).click();
  await expect(input).toHaveValue("About the second gap");
});

test("a lesson opened while lessons were unavailable is written when they come back", async ({
  page,
}) => {
  const study = await mockClaudeStudy(page);
  study.setCapabilities(["generate", "tutor", "assess"]);
  await finishWithGap(page, study);
  await page.locator("#lesson-offers button").click();
  await expect(page.locator("#lesson-status")).toContainText(
    "Lessons need a newer study bridge",
  );
  study.setCapabilities([
    "generate",
    "tutor",
    "assess",
    "lesson",
    "lesson-chat",
  ]);
  // No "Check again": the bridge simply answers differently at its next poll.
  await recheckBridge(page);
  await expect(page.locator("#lesson-body .lesson-section")).not.toHaveCount(0);
  expect(study.lessonCalls()).toHaveLength(1);
});

test("closing a lesson opened from the map's list returns focus to that gap's button", async ({
  page,
}) => {
  const study = await mockClaudeStudy(page);
  await readyLesson(page, study);
  await page.locator("#lesson-close").click();
  await flushStudySave(page);
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__deadAir);
  const list = page.locator("#study-gaps");
  await list.locator("summary").click();
  await list.locator("button").click();
  await expect(page.locator("#lesson-title")).toBeFocused();
  await page.locator("#lesson-close").click();
  await expect(list.locator("button")).toBeFocused();
});
