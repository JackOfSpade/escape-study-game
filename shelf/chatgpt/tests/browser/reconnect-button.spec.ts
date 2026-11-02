import { expect, test, type Page } from "@playwright/test";
import {
  enterNativeGame,
  mockNativeStudy,
  nativeState,
  openNativeQuestion,
} from "./native-study-harness";

async function noOptionalWidget(page: Page) {
  await page.route("**/api/handoff/status", (route) =>
    route.fulfill({
      json: {
        enabled: true,
        queued: 0,
        working: 0,
        done: 0,
        recent: [],
        public: {
          configured: true,
          linked: true,
          workerActive: false,
          terminalRelay: { sessions: 0, activeSessions: 0, pendingTurns: 0 },
          diagnostics: [],
        },
        tunnel: { state: "connected", verified: true, error: null },
      },
    }),
  );
  await page.context().route("https://chatgpt.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<title>Synthetic ChatGPT stub</title>",
    }),
  );
}

for (const clipboardBlocked of [false, true]) {
  test(`unsent question connects directly once without a widget, clipboard ${clipboardBlocked ? "blocked" : "available"}`, async ({
    page,
  }) => {
    const relay = await mockNativeStudy(page, false);
    await noOptionalWidget(page);
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
    if (clipboardBlocked)
      await page.addInitScript(() => {
        Object.defineProperty(navigator.clipboard, "writeText", {
          configurable: true,
          value: async () => {
            throw new DOMException("Denied", "NotAllowedError");
          },
        });
      });
    await enterNativeGame(page);
    const id = await openNativeQuestion(page);
    const original = await page.evaluate((id) => {
      const e = (window as any).__deadAir.game.encounters[id];
      e.chatDraft = "Preserved unsent clarification";
      return JSON.stringify(e.problem);
    }, id);
    expect(relay.calls).toHaveLength(0);
    expect((await nativeState(page, id)).session).toBeUndefined();
    await expect(page.locator("#native-study-connect")).toBeVisible();
    await page.locator("#native-study-copy").click();
    if (clipboardBlocked) {
      await expect
        .poll(() => page.evaluate(() => (window as any).__deadAir.game.notice))
        .toContain("including its chat code");
      await expect(page.getByLabel("ChatGPT request to copy")).toBeVisible();
      await expect(page.getByLabel("ChatGPT request to copy")).toHaveValue(
        /chat code [A-Z0-9]{6,16}/,
      );
      await page.evaluate(() => {
        delete (navigator.clipboard as any).writeText;
      });
      await page.locator("#native-study-copy").click();
    }
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
      "get_current_study_question",
    );
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
      "finish_study_question",
    );
    relay.setCapable(true);
    await page.locator("#native-study-connect").click();
    await expect(page.locator("#settings")).toBeHidden();
    await expect(page.locator("#terminal")).toBeHidden();
    await expect.poll(() => relay.calls.length).toBe(1);
    expect(relay.calls).toHaveLength(1);
    const payload = relay.calls[0].payload;
    expect(JSON.stringify(payload.problem)).toBe(original);
    expect(payload.unsentDraft).toEqual({
      text: "Preserved unsent clarification",
      learnerEvidence: false,
    });
    expect(payload.mode).toBe("terminal-direct");
    expect((await nativeState(page, id)).keys).toBe(0);
    relay.finish(payload.requestId);
    await expect
      .poll(async () => (await nativeState(page, id)).session.state)
      .toBe("applied");
    expect((await nativeState(page, id)).keys).toBe(1);
    expect(relay.calls).toHaveLength(1);
    expect(page.context().pages()).toHaveLength(1);
  });
}

test("rechecking an unavailable native capability preserves the issued question and unsent work", async ({
  page,
}) => {
  const relay = await mockNativeStudy(page, false);
  await noOptionalWidget(page);
  await enterNativeGame(page);
  const id = await openNativeQuestion(page);
  const before = await page.evaluate((id) => {
    const e = (window as any).__deadAir.game.encounters[id];
    e.chatDraft = "Unsent idea remains local";
    return { problem: e.problem, workspace: e.workspace, revision: e.revision };
  }, id);
  await page.locator("#native-study-connect").click();
  await expect(page.locator("#settings")).toBeHidden();
  await expect(page.locator("#native-study-status")).toContainText(
    "Connected and released",
  );
  expect(relay.calls).toHaveLength(0);
  expect(
    await page.evaluate((id) => {
      const e = (window as any).__deadAir.game.encounters[id];
      return {
        problem: e.problem,
        workspace: e.workspace,
        revision: e.revision,
      };
    }, id),
  ).toEqual(before);
  expect((await nativeState(page, id)).session).toBeUndefined();
  expect((await nativeState(page, id)).keys).toBe(0);
  expect(
    await page.evaluate(
      (id) => (window as any).__deadAir.game.encounters[id].chatDraft,
      id,
    ),
  ).toBe("Unsent idea remains local");
});

test("rechecking a pending native conversation needs no active widget and never replaces its request", async ({
  page,
}) => {
  const relay = await mockNativeStudy(page);
  await noOptionalWidget(page);
  await enterNativeGame(page);
  const id = await openNativeQuestion(page);
  await expect.poll(() => relay.calls.length).toBe(1);
  const payload = relay.calls[0].payload,
    before = await nativeState(page, id);
  await page.keyboard.press("Escape");
  await page.locator("#settings-toggle").click();
  await expect(page.locator("#settings")).toBeVisible();
  await page.getByText("ChatGPT handoff connection", { exact: true }).click();
  await page.locator("#reconnect").click();
  await page.locator("#reconnect").click();
  const after = await nativeState(page, id);
  expect(after.session.id).toBe(before.session.id);
  expect(after.session.questionFingerprint).toBe(
    before.session.questionFingerprint,
  );
  expect(after.session.state).toBe("pending");
  expect(relay.calls).toHaveLength(1);
  await page.locator("#settings-close").click();
  relay.finish(payload.requestId);
  await expect
    .poll(async () => (await nativeState(page, id)).session.state)
    .toBe("applied");
  expect((await nativeState(page, id)).keys).toBe(1);
  expect(page.context().pages()).toHaveLength(1);
});
