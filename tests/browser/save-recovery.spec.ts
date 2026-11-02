import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { startDesignedRun } from "./helpers/designed-run";
import { openGameMenu } from "./helpers/game-menu";
import { flushNativeSave, mockClaudeStudy } from "./study-harness";

async function rawDurableSave(page: Page) {
  return page.evaluate(async () => {
    const root = "/src/";
    const { readDurable } = await import(
      /* @vite-ignore */ root + "storage.ts"
    );
    return readDurable("dead-air-save-v1");
  });
}

test("a failed full-run import stays open with a clear unsaved warning", async ({
  page,
}) => {
  await page.goto("/");
  await startDesignedRun(page);
  await openGameMenu(page);
  await page.locator("#settings-toggle").click();
  const { candidate, originalTick, originalLocal } = await page.evaluate(
    async () => {
      const root = "/src/",
        { decode, encode, flushSaves } = await import(root + "persistence.ts");
      await flushSaves();
      const current = (window as any).__deadAir.game,
        copy = decode(encode(current));
      copy.tick = current.tick + 321;
      return {
        candidate: encode(copy),
        originalTick: current.tick,
        originalLocal: localStorage.getItem("dead-air-save-v1"),
      };
    },
  );
  await page.evaluate(() => {
    const originalSetItem = Storage.prototype.setItem,
      originalTransaction = IDBDatabase.prototype.transaction;
    Storage.prototype.setItem = function (key, value) {
      if (key === "dead-air-save-v1")
        throw new DOMException(
          "Synthetic local save denial",
          "QuotaExceededError",
        );
      return originalSetItem.call(this, key, value);
    };
    IDBDatabase.prototype.transaction = function (
      this: IDBDatabase,
      ...args: Parameters<IDBDatabase["transaction"]>
    ) {
      if (args[1] === "readwrite")
        throw new DOMException(
          "Synthetic durable save denial",
          "SecurityError",
        );
      return originalTransaction.apply(this, args);
    } as typeof IDBDatabase.prototype.transaction;
  });
  await page.locator("#import").setInputFiles({
    name: "synthetic-unsaved-import.json",
    mimeType: "application/json",
    buffer: Buffer.from(candidate),
  });
  await expect(page.locator("#import-status")).toContainText(
    "Import opened in this tab but could not be saved",
  );
  await expect(page.locator("#settings")).toBeVisible();
  await expect(page.locator("#export")).toBeVisible();
  expect(
    await page.evaluate(() => ({
      tick: (window as any).__deadAir.game.tick,
      paused: (window as any).__deadAir.game.paused,
      local: localStorage.getItem("dead-air-save-v1"),
    })),
  ).toEqual({ tick: originalTick + 321, paused: true, local: originalLocal });
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__deadAir?.game);
  expect(await page.evaluate(() => (window as any).__deadAir.game.tick)).toBe(
    originalTick,
  );
});

test("hiding a paused study tab synchronously checkpoints incomplete local work", async ({
  page,
}) => {
  await mockClaudeStudy(page);
  await page.goto("/");
  await page.locator("#study-only-toggle").click();
  await flushNativeSave(page);
  const checkpoint = await page.evaluate(async () => {
    const root = "/src/";
    const { decode } = await import(/* @vite-ignore */ root + "persistence.ts");
    const g = (window as any).__deadAir.game;
    g.encounters["f0-room0"].chatDraft = "Synthetic unfinished local reasoning";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    const raw = JSON.parse(localStorage.getItem("dead-air-save-v1")!);
    return decode(raw.data).encounters["f0-room0"].chatDraft;
  });
  expect(checkpoint).toBe("Synthetic unfinished local reasoning");
  await page.reload();
  await expect(page.locator("#study-workspace")).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as any).__deadAir.game.encounters["f0-room0"].chatDraft,
    ),
  ).toBe("Synthetic unfinished local reasoning");
});

test("an unreadable checkpoint stays protected through lifecycle saves until a valid backup is restored", async ({
  page,
}) => {
  await mockClaudeStudy(page);
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("synthetic-corrupt-save-seeded")) {
      localStorage.setItem("dead-air-save-v1", "synthetic damaged checkpoint");
      sessionStorage.setItem("synthetic-corrupt-save-seeded", "1");
    }
  });
  await page.goto("/");
  await expect(page.locator("#save-recovery-status")).toContainText(
    "Existing checkpoints have been protected",
  );
  await expect(page.locator("#start")).toHaveCount(0);
  expect(await rawDurableSave(page)).toBeNull();
  await page.evaluate(() => {
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("pagehide"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(
    await page.evaluate(() => localStorage.getItem("dead-air-save-v1")),
  ).toBe("synthetic damaged checkpoint");
  expect(await rawDurableSave(page)).toBeNull();
  await page.locator("#study-only-toggle").click();
  await expect(page.locator("#study-workspace")).toBeHidden();

  const downloading = page.waitForEvent("download");
  await page.locator("#save-recovery-export").click();
  const downloaded = await downloading;
  expect(downloaded.suggestedFilename()).toBe(
    "zombie-escape-study-game-recovery.json",
  );
  const recoveredBytes = JSON.parse(
    await readFile((await downloaded.path())!, "utf8"),
  );
  expect(recoveredBytes.local).toBe("synthetic damaged checkpoint");
  await page.locator("#save-recovery-import").setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from("{}"),
  });
  await expect(page.locator("#save-recovery-status")).toContainText(
    "Import rejected",
  );
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  expect(
    await page.evaluate(() => localStorage.getItem("dead-air-save-v1")),
  ).toBe("synthetic damaged checkpoint");
  expect(await rawDurableSave(page)).toBeNull();

  const backup = await page.evaluate(async () => {
    const root = "/src/";
    const { encode } = await import(/* @vite-ignore */ root + "persistence.ts");
    const { createGame } = await import(/* @vite-ignore */ root + "world.ts");
    const g = createGame(123, (window as any).__deadAir.roadmap);
    g.encounters["f0-room0"].chatDraft =
      "Synthetic unfinished answer restored from backup";
    return encode(g);
  });
  await page.locator("#save-recovery-import").setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(backup),
  });
  await expect(page.locator("#save-recovery-status")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start game" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Start game" })).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as any).__deadAir.game.encounters["f0-room0"].chatDraft,
    ),
  ).toBe("Synthetic unfinished answer restored from backup");
});
