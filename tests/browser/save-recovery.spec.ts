import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { openAgentMenu } from "./helpers/agent-menu";
import {
  flushStudySave,
  mockClaudeStudy,
  openStudyQuestion,
} from "./study-harness";

async function rawDurableSave(page: Page) {
  return page.evaluate(async () => {
    const root = "/src/";
    const { readDurable } = await import(
      /* @vite-ignore */ root + "storage.ts"
    );
    return readDurable("dead-air-save-v1");
  });
}

test("a failed full-record import reports a clear unsaved warning", async ({
  page,
}) => {
  await mockClaudeStudy(page);
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__deadAir?.game);
  await page.evaluate(() => (window as any).__deadAir.openAgentMenu());
  await page.locator("#settings-toggle").click();
  const { candidate, originalSeq, originalLocal } = await page.evaluate(
    async () => {
      const root = "/src/",
        { decode, encode, flushSaves } = await import(root + "persistence.ts");
      await flushSaves();
      const current = (window as any).__deadAir.game,
        copy = decode(encode(current));
      copy.seq = current.seq + 321;
      return {
        candidate: encode(copy),
        originalSeq: current.seq,
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
  expect(
    await page.evaluate(() => ({
      seq: (window as any).__deadAir.game.seq,
      local: localStorage.getItem("dead-air-save-v1"),
    })),
  ).toEqual({ seq: originalSeq + 321, local: originalLocal });
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__deadAir?.game);
  expect(await page.evaluate(() => (window as any).__deadAir.game.seq)).toBe(
    originalSeq,
  );
});

test("hiding the study tab synchronously checkpoints incomplete local work", async ({
  page,
}) => {
  await mockClaudeStudy(page);
  const id = await openStudyQuestion(page);
  await flushStudySave(page);
  const checkpoint = await page.evaluate(async (id) => {
    const root = "/src/";
    const { decode } = await import(/* @vite-ignore */ root + "persistence.ts");
    const g = (window as any).__deadAir.game;
    g.encounters[id].chatDraft = "Synthetic unfinished local reasoning";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    const raw = JSON.parse(localStorage.getItem("dead-air-save-v1")!);
    return decode(raw.data).encounters[id].chatDraft;
  }, id);
  expect(checkpoint).toBe("Synthetic unfinished local reasoning");
  await page.reload();
  await expect(page.locator("#study-workspace")).toBeVisible();
  expect(
    await page.evaluate(
      (id) => (window as any).__deadAir.game.encounters[id].chatDraft,
      id,
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
  await expect(page.locator("#study-workspace")).toBeHidden();
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

  const downloading = page.waitForEvent("download");
  await page.locator("#save-recovery-export").click();
  const downloaded = await downloading;
  expect(downloaded.suggestedFilename()).toBe(
    "learning-workspace-recovery.json",
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
    const helpers = "/tests/helpers/record.ts";
    const { createGame } = await import(/* @vite-ignore */ helpers);
    const g = createGame(123, (window as any).__deadAir.roadmap);
    g.encounters["question-0"].chatDraft =
      "Synthetic unfinished answer restored from backup";
    return encode(g);
  });
  await page.locator("#save-recovery-import").setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(backup),
  });
  await expect(page.locator("#save-recovery")).toBeHidden();
  await expect(page.locator("#study-workspace")).toBeVisible();
  await page.reload();
  await expect(page.locator("#study-workspace")).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as any).__deadAir.game.encounters["question-0"].chatDraft,
    ),
  ).toBe("Synthetic unfinished answer restored from backup");
});

test("a damaged copy beside a valid one is offered for download before a save replaces it", async ({
  page,
}) => {
  await mockClaudeStudy(page);
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__deadAir?.game);
  const noticeHidden = () =>
    page.evaluate(
      () => document.querySelector<HTMLElement>("#study-load-notice")!.hidden,
    );
  expect(await noticeHidden()).toBe(true);
  // A full save writes both copies; the durable one stays valid below.
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await flushStudySave(page);
  expect(await rawDurableSave(page)).not.toBeNull();
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("synthetic-damaged-copy-seeded")) {
      localStorage.setItem("dead-air-save-v1", "synthetic damaged local copy");
      sessionStorage.setItem("synthetic-damaged-copy-seeded", "1");
    }
  });
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__deadAir?.game);
  expect(await noticeHidden()).toBe(false);
  // Saving goes on as usual and replaces the damaged bytes in storage...
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await flushStudySave(page);
  expect(
    await page.evaluate(() => localStorage.getItem("dead-air-save-v1")),
  ).not.toBe("synthetic damaged local copy");
  // ...but the page still holds them for the learner to keep.
  const downloading = page.waitForEvent("download");
  await page.locator("#study-load-notice-save").dispatchEvent("click");
  const kept = JSON.parse(
    await readFile((await (await downloading).path())!, "utf8"),
  );
  expect(kept.store).toBe("local");
  expect(kept.raw).toBe("synthetic damaged local copy");
  await page.locator("#study-load-notice-dismiss").dispatchEvent("click");
  expect(await noticeHidden()).toBe(true);
});

test("durable saves retain a large draft beyond localStorage capacity", async ({
  page,
}) => {
  await mockClaudeStudy(page);
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__deadAir?.game);
  const size = 8_000_000;
  await page.evaluate(async (size) => {
    const { question } = await import(
      /* @vite-ignore */ "/tests/helpers/" + "record.ts"
    );
    const g = (window as any).__deadAir.game,
      e = (g.encounters["question-0"] = question(g, "question-0"));
    // A controlled large-history fixture exercises the actual IndexedDB save path.
    e.workspace = "x".repeat(size);
  }, size);
  await openAgentMenu(page);
  await page.getByRole("button", { name: "Save run", exact: true }).click();
  await expect(page.locator("#pause-save-status")).toContainText(
    "Run saved locally",
    { timeout: 15000 },
  );
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__deadAir);
  expect(
    await page.evaluate(
      () =>
        (window as any).__deadAir.game.encounters["question-0"].workspace
          .length,
    ),
  ).toBe(size);
});
