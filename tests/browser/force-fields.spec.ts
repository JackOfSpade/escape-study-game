import { startDesignedRun } from "./helpers/designed-run";
import { expect, test } from "@playwright/test";
import { selectTopDown } from "./helpers/view-mode";
import { mockClaudeStudy } from "./study-harness";
test("fresh run uses force fields, personal keys and the embedded Claude terminal", async ({
  page,
}) => {
  const errors: string[] = [];
  const relay = await mockClaudeStudy(page);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await startDesignedRun(page);
  await selectTopDown(page);
  const state = await page.evaluate(async () => {
    const g = (window as any).__deadAir.game;
    const r = await (await fetch("/curriculum.json")).json();
    const root = "/src/";
    const { ensureProblem } = await import(/* @vite-ignore */ root + "ai.ts");
    const { ROOM_CATALOG } = await import(
      /* @vite-ignore */ root + "office-layout.ts"
    );
    const officeKinds = new Set(Object.values(ROOM_CATALOG).flat());
    const st = g.floors[0].stations[0],
      e = g.encounters[st.encounter];
    for (const a of g.survivors.slice(1)) a.escaped = true;
    g.zombies = [];
    g.nextSpawn = Number.MAX_SAFE_INTEGER;
    Object.assign(g.survivors[0], { x: st.x, y: st.y });
    // A live run starts with no pre-made practice questions.
    g.study.profile = "live";
    for (const each of Object.values<any>(g.encounters)) delete each.problem;
    await ensureProblem(g, e, r);
    return {
      rules: g.rules,
      solo: Object.values(g.encounters).every((x: any) => x.mode === "solo"),
      // Fields have no door leaves; everything else is movable office furniture.
      fields: g.floors.every((f: any) =>
        f.furniture.every((o: any) =>
          o.field
            ? !o.door
            : !o.door &&
              officeKinds.has(o.kind) &&
              o.floor === f.index &&
              o.speed > 0,
        ),
      ),
      inventory: g.survivors[0].inventory.length,
      startingKeys: g.survivors.every((a: any) => a.keys === 0),
      sameRoomQuestion: g.floors[0].stations
        .filter(
          (s: any) => g.encounters[s.encounter].questionRoom === e.questionRoom,
        )
        .every(
          (s: any) =>
            JSON.stringify(g.encounters[s.encounter].problem) ===
            JSON.stringify(e.problem),
        ),
    };
  });
  expect(state).toEqual({
    rules: "force-fields",
    solo: true,
    fields: true,
    inventory: 0,
    startingKeys: true,
    sameRoomQuestion: true,
  });
  await page.locator("#world").focus();
  await page.keyboard.press("e");
  // The generated question opens in the embedded terminal.
  await expect(page.locator("#terminal")).toBeVisible();
  await expect(page.locator("#problem-title")).toHaveText("Synthetic question");
  expect(relay.calls.length).toBeGreaterThan(0);
  expect(relay.calls.every((call) => call.provider === "claude-cli")).toBe(
    true,
  );
  await expect(page.locator("#chat-input")).toBeVisible();
  await expect(page.locator("#hud-keys")).toHaveText("0 keys");
  await expect(page.locator(".dashboard")).toBeHidden();
  const world = (await page.locator(".world").boundingBox())!;
  // The world shares the screen with the embedded terminal.
  expect(world.width).toBeGreaterThan(200);
  await page.screenshot({
    path: ".artifacts/force-fields-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#terminal")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: ".artifacts/force-fields-mobile.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
