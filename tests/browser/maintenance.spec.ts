import { test, expect } from "@playwright/test";

test("real IndexedDB recovers after a synchronous open failure and commits the next save", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const root = "/src/",
      { createDurableStorage } = await import(root + "storage.ts");
    let calls = 0;
    const storage = createDurableStorage(() => ({
      open(name: string, version?: number) {
        if (calls++ === 0)
          throw new DOMException("Synthetic temporary denial", "SecurityError");
        return indexedDB.open(name, version);
      },
    }));
    let failed = false;
    try {
      await storage.read("maintenance-probe");
    } catch {
      failed = true;
    }
    await storage.write("maintenance-probe", "durable retry");
    return { failed, calls, value: await storage.read("maintenance-probe") };
  });
  expect(result).toEqual({ failed: true, calls: 2, value: "durable retry" });
});
