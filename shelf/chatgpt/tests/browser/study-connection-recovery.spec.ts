import { expect, test } from "@playwright/test";
import { mockNativeStudy, nativeState } from "./native-study-harness";

test("connectivity recovery resumes the exact interrupted question and applies its result once", async ({
  page,
}) => {
  const relay = await mockNativeStudy(page);
  let disconnected = true;
  // Advance only the outage clock so the real UI/transport exercises the
  // sixty-second grace without holding a browser test open for a minute.
  await page.addInitScript(() => {
    const now = Date.now.bind(Date);
    Date.now = () => now() + ((window as any).__syntheticOutageMs ?? 0);
  });
  await page.route("**/api/bridge/result?**", async (route) => {
    if (!disconnected) return route.fallback();
    await page.evaluate(() => {
      (window as any).__syntheticOutageMs =
        ((window as any).__syntheticOutageMs ?? 0) + 31_000;
    });
    await route.abort("internetdisconnected");
  });
  await page.goto("/");
  await page.locator("#study-only-toggle").click();
  await page.locator("#study-next").click();
  await expect.poll(() => relay.calls.length).toBe(1);
  const first = relay.calls[0];
  await expect
    .poll(
      async () =>
        (await nativeState(page, first.payload.encounterId)).session?.state,
    )
    .toBe("interrupted");
  expect((await nativeState(page, first.payload.encounterId)).submissions).toBe(
    0,
  );

  disconnected = false;
  relay.finish(first.payload.requestId);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => relay.calls.length).toBe(2);
  expect(relay.calls[1]).toEqual(first);
  await expect(page.locator("#study-save-status")).toContainText(
    "Learning result received and saved",
  );
  expect((await nativeState(page, first.payload.encounterId)).submissions).toBe(
    1,
  );
  const rechecked = page.waitForResponse("**/api/status");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await rechecked;
  expect(relay.calls).toHaveLength(2);
  expect((await nativeState(page, first.payload.encounterId)).submissions).toBe(
    1,
  );
});

test("connectivity recovery leaves a stopped question paused", async ({
  page,
}) => {
  const relay = await mockNativeStudy(page);
  await page.goto("/");
  await page.locator("#study-only-toggle").click();
  await page.locator("#study-next").click();
  await expect.poll(() => relay.calls.length).toBe(1);
  await page.locator("#study-next").click();
  await expect(page.locator("#study-next")).toHaveText("Resume in new chat");
  const rechecked = page.waitForResponse("**/api/status");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await rechecked;
  expect(relay.calls).toHaveLength(1);
  expect(
    (await nativeState(page, relay.calls[0].payload.encounterId)).session
      ?.state,
  ).toBe("paused");
});
