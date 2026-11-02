import { expect, test } from "@playwright/test";
import {
  enterNativeGame,
  flushNativeSave,
  mockNativeStudy,
  nativeState,
  openNativeQuestion,
} from "./native-study-harness";

test("native ChatGPT completion grants one key and survives reload without duplicate delivery", async ({
  page,
}) => {
  const relay = await mockNativeStudy(page);
  await enterNativeGame(page);
  const id = await openNativeQuestion(page);
  await expect.poll(() => relay.calls.length).toBe(1);
  const pending = await nativeState(page, id),
    payload = relay.calls[0].payload;
  expect(pending.session.state).toBe("pending");
  expect(payload.mode).toBe("terminal-direct");
  expect(payload.questionFingerprint).toBe(pending.session.questionFingerprint);
  expect(payload).not.toHaveProperty("curriculum");
  expect(payload).not.toHaveProperty("progressContext");
  expect(pending.tutor.filter((m: any) => m.kind === "human")).toHaveLength(0);
  await expect(page.locator("#native-study-status")).toContainText("ChatGPT");
  await expect(page.locator("#chat-input")).toBeHidden();
  // A second E click joins the same question; there is no second startup turn.
  await page.evaluate(() => (window as any).__deadAir.interact());
  expect(relay.calls).toHaveLength(1);
  relay.finish(payload.requestId);
  await expect
    .poll(async () => (await nativeState(page, id)).session.state)
    .toBe("applied");
  const after = await nativeState(page, id);
  expect(after.keys).toBe(pending.keys + 1);
  expect(after.state).toBe("consumed");
  expect(after.submissions).toBe(1);
  expect(after.tutor.filter((m: any) => m.kind === "human")).toHaveLength(1);
  expect(
    after.tutor.every(
      (m: any) => m.provenance === "chatgpt-host-model-transcript",
    ),
  ).toBe(true);
  await flushNativeSave(page);
  await page.reload();
  await expect
    .poll(async () => (await nativeState(page, id)).session.state)
    .toBe("applied");
  const loaded = await nativeState(page, id);
  expect(loaded.keys).toBe(after.keys);
  expect(loaded.submissions).toBe(1);
  expect(loaded.accepted).toBe(after.accepted);
  expect(relay.calls).toHaveLength(1);
  await expect(page.locator("#terminal")).toBeHidden();
});

test("reloading a pending terminal preserves its chat binding and an explicit new opening rotates it", async ({
  page,
}) => {
  const relay = await mockNativeStudy(page);
  await enterNativeGame(page);
  const id = await openNativeQuestion(page);
  await expect.poll(() => relay.calls.length).toBe(1);
  const original = relay.calls[0];
  expect(original.chatCode).toMatch(/^[A-Z0-9]{6,16}$/);
  await flushNativeSave(page);
  await page.reload();
  await expect.poll(() => relay.calls.length).toBe(2);
  expect(relay.calls[1]).toEqual(original);
  const next = await page.evaluate(async () => {
    const root = "/src/";
    const { newStudyChat, studyChatCode } = await import(
      /* @vite-ignore */ root + "bridge-client.ts"
    );
    const before = studyChatCode();
    const after = newStudyChat();
    return {
      before,
      after,
      stored: sessionStorage.getItem("zombie-study-chat-v1"),
    };
  });
  expect(next.before).toBe(original.chatCode);
  expect(next.after).not.toBe(original.chatCode);
  expect(next.stored).toBe(next.after);
  expect((await nativeState(page, id)).keys).toBe(0);
});

test("missing direct-study capability offers connection help without an in-game fallback", async ({
  page,
}) => {
  const relay = await mockNativeStudy(page, false);
  await enterNativeGame(page);
  const id = await openNativeQuestion(page);
  await expect(page.locator("#native-study-connect")).toBeVisible();
  await expect(page.locator("#native-study-status")).toContainText(
    "direct study support",
  );
  const state = await nativeState(page, id);
  expect(state.session).toBeUndefined();
  expect(state.keys).toBe(0);
  expect(state.submissions).toBe(0);
  expect(relay.calls).toHaveLength(0);
});

test("a picked-up question offers completion recovery in the same chat without replacing it", async ({
  page,
}) => {
  const relay = await mockNativeStudy(page);
  await enterNativeGame(page);
  const id = await openNativeQuestion(page);
  await expect(page.locator("#native-study-status")).toContainText(
    "existing ChatGPT chat",
  );
  await expect(page.locator("#native-study-status")).toContainText(
    "no key received yet",
  );
  await expect(page.locator("#native-study-finish")).toBeVisible();
  const before = await nativeState(page, id);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as any).__completionRetry = text;
        },
      },
    });
  });
  await page.locator("#native-study-finish").click();
  const prompt = await page.evaluate(() => (window as any).__completionRetry);
  expect(prompt).toContain(before.session.questionFingerprint);
  expect(prompt).toContain("verbatim learner answers");
  expect(prompt).toContain("same relayId, turnId");
  expect(prompt).toMatch(/chat: "[A-Z0-9]{6,16}"/);
  expect(relay.calls).toHaveLength(1);
  expect((await nativeState(page, id)).session.id).toBe(before.session.id);
  expect((await nativeState(page, id)).keys).toBe(0);
  await page.screenshot({ path: ".artifacts/study-completion-recovery.png" });
  relay.finish(relay.calls[0].payload.requestId);
  await expect
    .poll(async () => (await nativeState(page, id)).session.state)
    .toBe("applied");
  expect((await nativeState(page, id)).keys).toBe(1);
  await expect(page.locator("#native-study-finish")).toBeHidden();
});

test("a mismatched completion is retained as an interruption and exact retry can complete once", async ({
  page,
}) => {
  const relay = await mockNativeStudy(page);
  await enterNativeGame(page);
  const id = await openNativeQuestion(page);
  await expect.poll(() => relay.calls.length).toBe(1);
  const payload = relay.calls[0].payload;
  relay.finish(payload.requestId, "solved", {
    questionFingerprint: "wrong-question",
  });
  await expect(page.locator("#native-study-retry")).toBeVisible();
  const failed = await nativeState(page, id);
  expect(failed.keys).toBe(0);
  expect(failed.submissions).toBe(0);
  expect(failed.tutor).toHaveLength(0);
  relay.finish(payload.requestId);
  await page.locator("#native-study-retry").click();
  await expect
    .poll(async () => (await nativeState(page, id)).session.state)
    .toBe("applied");
  expect(relay.calls).toHaveLength(2);
  expect(relay.calls[1].payload).toEqual(payload);
  expect((await nativeState(page, id)).keys).toBe(1);
});
