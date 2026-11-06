import { detachAuthoredScene } from "./helpers/synthetic-world";
import { startDesignedRun } from "./helpers/designed-run";
import { expect, test, type Page } from "./helpers/offline-test";
import { flushNativeSave, mockClaudeStudy } from "./study-harness";
import { openGameMenu, openPlayerMenu } from "./helpers/game-menu";

async function startFirstPerson(
  page: Page,
  lock: "refused" | "synthetic" = "refused",
) {
  // Headless Chromium refuses native capture with WrongDocumentError. Model
  // grants/loss events for integration coverage; keep refusal cases explicit.
  await page.addInitScript((lock) => {
    (window as any).__lookLockRequests = 0;
    (window as any).__lookLockExits = 0;
    let owner: Element | null = null;
    if (lock === "synthetic") {
      Object.defineProperty(document, "pointerLockElement", {
        configurable: true,
        get: () => owner,
      });
      document.exitPointerLock = () => {
        (window as any).__lookLockExits++;
        owner = null;
        document.dispatchEvent(new Event("pointerlockchange"));
      };
    }
    HTMLCanvasElement.prototype.requestPointerLock = function () {
      (window as any).__lookLockRequests++;
      if (lock === "synthetic") {
        owner = this;
        queueMicrotask(() =>
          document.dispatchEvent(new Event("pointerlockchange")),
        );
        return Promise.resolve();
      }
      return Promise.reject(
        new DOMException("Synthetic lock refusal", "SecurityError"),
      );
    };
  }, lock);
  await page.goto("/");
  await startDesignedRun(page);
  await detachAuthoredScene(page);
  await page.evaluate(() => {
    const g = (window as any).__deadAir.game,
      a = g.survivors[0],
      f = g.floors[0];
    g.survivors = [a];
    g.zombies = [];
    g.nextSpawn = Number.MAX_SAFE_INTEGER;
    g.surge.anchor = Number.MAX_SAFE_INTEGER;
    f.tiles = Array.from({ length: 34 }, (_, y) =>
      Array.from({ length: 44 }, (_, x) =>
        x === 0 || x === 43 || y === 0 || y === 33 ? 1 : 0,
      ),
    );
    f.furniture = [];
    f.stations = [];
    f.stairs = { x: 35, y: 25 };
    Object.assign(a, { x: 10, y: 10 });
  });
  await expect(page.locator("#view3d")).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).__deadAir.game.settings.view),
  ).not.toBe("top-down");
}

async function pose(page: Page) {
  return page.evaluate(() => {
    const a = (window as any).__deadAir.game.survivors[0];
    return { x: a.x, y: a.y, heading: { ...a.heading } };
  });
}

async function look(page: Page) {
  return page.evaluate(
    () => (window as any).__deadAir.look() as { yaw: number; pitch: number },
  );
}

test("entering and resuming capture the mouse for button-free look until Esc pauses", async ({
  page,
}) => {
  await startFirstPerson(page, "synthetic");
  const lockedCanvas = () =>
    page.evaluate(() => document.pointerLockElement?.id ?? null);
  await expect.poll(lockedCanvas).toBe("view3d");
  expect(await page.evaluate(() => (window as any).__lookLockRequests)).toBe(1);
  for (const key of ["Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    await expect(page.locator("#view3d")).toBeFocused();
    expect(await lockedCanvas()).toBe("view3d");
    expect(await page.evaluate(() => (window as any).__lookLockExits)).toBe(0);
  }

  await page.evaluate(() => {
    (window as any).__deadAir.setLook(0.3, 0.1);
    document.addEventListener("mousemove", (event) => {
      (window as any).__lookMouseButtons = event.buttons;
    });
  });
  const stationary = await pose(page);
  await page.mouse.move(720, 550);
  const beforeMove = await look(page);
  await page.mouse.move(840, 510, { steps: 4 });
  const afterMove = await look(page);
  expect(afterMove.yaw).toBeCloseTo(beforeMove.yaw + 120 * 0.0022, 5);
  expect(afterMove.pitch).toBeCloseTo(beforeMove.pitch + 40 * 0.0022, 5);
  expect(await pose(page)).toEqual(stationary);
  expect(await page.evaluate(() => (window as any).__lookMouseButtons)).toBe(0);
  await page.mouse.down();
  await page.mouse.up();
  expect(await lockedCanvas()).toBe("view3d");
  expect(await page.evaluate(() => (window as any).__lookLockRequests)).toBe(1);

  await page.keyboard.press("Escape");
  await expect(page.locator("#pause-menu")).toBeVisible();
  await expect.poll(lockedCanvas).toBeNull();
  await expect(page.locator("#resume-game")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#study-only-menu")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("#resume-game")).toBeFocused();
  const pausedLook = await look(page),
    pausedTime = await page.evaluate(() => (window as any).__deadAir.game.time);
  await page.mouse.move(500, 400);
  await page.waitForTimeout(200);
  expect(await look(page)).toEqual(pausedLook);
  expect(await page.evaluate(() => (window as any).__deadAir.game.time)).toBe(
    pausedTime,
  );

  await page.locator("#resume-game").click();
  await expect(page.locator("#pause-menu")).toBeHidden();
  await expect.poll(lockedCanvas).toBe("view3d");
  await page.mouse.move(500, 400);
  const resumedLook = await look(page);
  await page.mouse.move(560, 400);
  expect((await look(page)).yaw).toBeCloseTo(resumedLook.yaw + 60 * 0.0022, 5);

  await page.keyboard.press("Escape");
  await expect(page.locator("#pause-menu")).toBeVisible();
  await expect.poll(lockedCanvas).toBeNull();
  // Wait past the lock-loss duplicate-key guard before the next real Esc.
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape");
  await expect(page.locator("#pause-menu")).toBeHidden();
  await expect.poll(lockedCanvas).toBe("view3d");
});

test("reloading a first-person save without view state restores yaw from the survivor heading", async ({
  page,
}) => {
  await startFirstPerson(page);
  await openGameMenu(page);
  await page.evaluate(() => {
    const d = (window as any).__deadAir;
    d.game.survivors[0].heading = { x: 0, y: -1 };
    d.setLook(0.4, 0.2);
  });
  await page.getByRole("button", { name: "Save run", exact: true }).click();
  await flushNativeSave(page);
  // Historical saves have no separate camera state. Clear it in the new
  // document after pagehide has persisted the previous view.
  await page.addInitScript(() =>
    sessionStorage.removeItem("dead-air-first-person-look"),
  );
  await page.reload();
  await expect(page.locator("#view3d")).toBeVisible();
  await expect
    .poll(async () => (await look(page)).yaw)
    .toBeCloseTo(-Math.PI / 2, 5);
  expect((await look(page)).pitch).toBe(0);
});

test("camera yaw and pitch survive view re-entry and reload independently of movement heading", async ({
  page,
}) => {
  await startFirstPerson(page);
  await page.evaluate(() => {
    const d = (window as any).__deadAir;
    d.game.survivors[0].heading = { x: 0, y: -1 };
    d.setLook(0.4, 0.2);
    d.game.settings.view = "top-down";
  });
  await expect(page.locator("#view3d")).toBeHidden();
  await page.evaluate(() => {
    const d = (window as any).__deadAir;
    d.game.survivors[0].heading = { x: -1, y: 0 };
    d.game.settings.view = "first-person";
  });
  await expect(page.locator("#view3d")).toBeVisible();
  expect((await look(page)).yaw).toBeCloseTo(0.4, 5);
  expect((await look(page)).pitch).toBeCloseTo(0.2, 5);
  await openGameMenu(page);
  await page.getByRole("button", { name: "Save run", exact: true }).click();
  await flushNativeSave(page);
  await page.reload();
  await expect(page.locator("#view3d")).toBeVisible();
  expect((await look(page)).yaw).toBeCloseTo(0.4, 5);
  expect((await look(page)).pitch).toBeCloseTo(0.2, 5);
  expect((await pose(page)).heading).toEqual({ x: -1, y: 0 });
});

test("first-person WebGL draws, keyboard look turns on capture refusal, relative WASD moves and lock loss pauses", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    (window as any).__firstPersonDraws = 0;
    const prototype = (window as any).WebGL2RenderingContext?.prototype;
    if (!prototype) return;
    for (const name of ["drawElements", "drawArrays"]) {
      const draw = prototype[name];
      prototype[name] = function (
        this: WebGL2RenderingContext,
        ...args: any[]
      ) {
        const result = draw.apply(this, args);
        if (
          this.canvas instanceof HTMLCanvasElement &&
          this.canvas.id === "view3d"
        )
          (window as any).__firstPersonDraws++;
        return result;
      };
    }
  });
  await startFirstPerson(page);
  await expect
    .poll(() => page.evaluate(() => (window as any).__firstPersonDraws))
    .toBeGreaterThan(0);
  const webgl = await page.locator("#view3d").evaluate((element) => {
    const canvas = element as HTMLCanvasElement,
      gl = canvas.getContext("webgl2")!;
    return {
      width: gl.drawingBufferWidth,
      height: gl.drawingBufferHeight,
      lost: gl.isContextLost(),
      pixelRatio: canvas.width / canvas.clientWidth,
    };
  });
  expect(webgl.width).toBeGreaterThan(300);
  expect(webgl.height).toBeGreaterThan(200);
  expect(webgl.lost).toBe(false);
  expect(webgl.pixelRatio).toBeLessThanOrEqual(1.51);

  await expect
    .poll(() => page.evaluate(() => (window as any).__lookLockRequests))
    .toBe(1);
  await page.locator("#view3d").click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__lookLockRequests))
    .toBe(2);
  await expect
    .poll(() => page.evaluate(() => (window as any).__deadAir.game.notice))
    .toContain("Click to capture");
  expect(await page.evaluate(() => document.pointerLockElement)).toBeNull();
  await page.evaluate(() => (window as any).__deadAir.setLook(0.3, 0.1));
  expect(await look(page)).toEqual({ yaw: 0.3, pitch: 0.1 });
  const stationary = await pose(page);
  await page.mouse.move(840, 510, { steps: 4 });
  expect(await look(page)).toEqual({ yaw: 0.3, pitch: 0.1 });
  await page.keyboard.down("ArrowRight");
  await expect
    .poll(async () => (await look(page)).yaw - 0.3)
    .toBeGreaterThan(0.25);
  await page.keyboard.up("ArrowRight");
  expect(await pose(page)).toEqual(stationary);

  await page.evaluate(() => (window as any).__deadAir.setLook(0.65, -0.08));
  const before = await pose(page),
    yaw = (await look(page)).yaw,
    facing = { x: Math.cos(yaw), y: Math.sin(yaw) };
  await page.keyboard.down("w");
  await expect
    .poll(async () => {
      const a = await pose(page);
      return (a.x - before.x) * facing.x + (a.y - before.y) * facing.y;
    })
    .toBeGreaterThan(0.4);
  await page.keyboard.up("w");
  const forward = await pose(page);
  expect(
    Math.abs(
      (forward.x - before.x) * -facing.y + (forward.y - before.y) * facing.x,
    ),
  ).toBeLessThan(0.12);
  await page.keyboard.down("d");
  await expect
    .poll(async () => {
      const a = await pose(page);
      return (a.x - forward.x) * -facing.y + (a.y - forward.y) * facing.x;
    })
    .toBeGreaterThan(0.4);
  await page.keyboard.up("d");
  const afterStrafe = await pose(page);
  expect(afterStrafe.heading.x).toBeCloseTo(-facing.y, 5);
  expect(afterStrafe.heading.y).toBeCloseTo(facing.x, 5);
  expect(await look(page)).toEqual({ yaw: 0.65, pitch: -0.08 });

  // Native lock grants are unavailable here; this drives the same unexpected
  // loss handler used by pointerlockchange and verifies its actual pause effect.
  await page.evaluate(() => (window as any).__deadAir.unlockLook());
  await expect(page.locator("#pause-menu")).toBeVisible();
  const time = await page.evaluate(() => (window as any).__deadAir.game.time);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => (window as any).__deadAir.game.time)).toBe(
    time,
  );
  expect(errors).toEqual([]);
});

test("crosshair E selects the aimed furniture over a nearer off-axis object and falls back on a miss", async ({
  page,
}) => {
  await startFirstPerson(page);
  await page.evaluate(async () => {
    const d = (window as any).__deadAir,
      g = d.game;
    const { FURNITURE } = await import("/src/model.ts" as string);
    const prop = (id: string, kind: string, x: number, y: number) => ({
      ...FURNITURE[kind],
      id,
      kind,
      floor: 0,
      x,
      y,
      maxHp: FURNITURE[kind].hp,
      rotation: 0,
      destroyed: false,
      movers: [],
      moved: 0,
      credited: [],
      turning: 0,
    });
    g.floors[0].furniture = [
      prop("near-chair", "chair", 10, 10.85),
      prop("aimed-chair", "officeChair", 11.3, 10),
    ];
    d.setLook(0, 0);
  });
  await page.locator("#view3d").focus();
  await expect(page.locator("#interaction-prompt")).toHaveText(
    "E · Grip office chair",
  );
  await page.keyboard.press("e");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__deadAir.game.survivors[0].grip?.object,
      ),
    )
    .toBe("aimed-chair");
  expect((await pose(page)).heading.x).toBeCloseTo(1, 5);
  expect((await pose(page)).heading.y).toBeCloseTo(0, 5);
  await page.keyboard.press("e");
  await page.evaluate(() => (window as any).__deadAir.setLook(Math.PI, 0));
  // Names appear only for the object under the crosshair; E still reaches
  // the nearest object on a miss.
  await expect(page.locator("#interaction-prompt")).toHaveText("");
  await page.keyboard.press("e");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__deadAir.game.survivors[0].grip?.object,
      ),
    )
    .toBe("near-chair");
  expect((await pose(page)).heading.x).toBeCloseTo(-1, 5);
  expect((await pose(page)).heading.y).toBeCloseTo(0, 5);
});

test("E reports a full pack without consuming crosshair-targeted loot", async ({
  page,
}) => {
  await startFirstPerson(page);
  const encounter = await page.evaluate(async () => {
    const d = (window as any).__deadAir,
      g = d.game,
      a = g.survivors[0],
      e = Object.values(g.encounters).find((e: any) => e.floor === 0) as any,
      { CONFIG } = await import("/src/model.ts" as string),
      { lootSlot } = await import("/src/view3d/targeting.ts" as string);
    a.inventory = [
      {
        id: "full-pack-kit",
        kind: "medkit",
        weight: CONFIG.capacity,
        charges: 1,
      },
    ];
    Object.assign(e, {
      state: "consumed",
      reward: "loot",
      contributors: [a.id],
      loot: [{ id: "aimed-loot", kind: "medkit", weight: 1, charges: 1 }],
    });
    const station = {
      id: "full-pack-terminal",
      encounter: e.id,
      x: a.x + 1.4,
      y: a.y,
    };
    g.floors[0].stations = [station];
    const slot = lootSlot(station, 0, { x: 0, y: 0 });
    d.setLook(Math.atan2(slot.y - a.y, slot.x - a.x), 0);
    return e.id as string;
  });
  await page.locator("#view3d").focus();
  await expect(page.locator("#interaction-prompt")).toHaveText(
    "E · Take medkit",
  );
  await page.keyboard.press("e");
  await expect
    .poll(() => page.evaluate(() => (window as any).__deadAir.game.notice))
    .toContain("Pack full");
  const remaining = await page.evaluate((id) => {
    const g = (window as any).__deadAir.game;
    return {
      loot: g.encounters[id].loot.map((i: any) => i.id),
      inventory: g.survivors[0].inventory.map((i: any) => i.id),
    };
  }, encounter);
  expect(remaining).toEqual({
    loot: ["aimed-loot"],
    inventory: ["full-pack-kit"],
  });
});

test("Space snapshots camera facing only when the real vault handler runs", async ({
  page,
}) => {
  await startFirstPerson(page);
  await page.evaluate(async () => {
    const d = (window as any).__deadAir,
      g = d.game,
      { FURNITURE } = await import("/src/model.ts" as string);
    g.rules = undefined;
    Object.assign(g.survivors[0], { x: 10.1, y: 12, heading: { x: 0, y: -1 } });
    g.floors[0].furniture = [
      {
        ...FURNITURE.shelf,
        id: "camera-vault-shelf",
        kind: "shelf",
        floor: 0,
        x: 12,
        y: 12,
        maxHp: FURNITURE.shelf.hp,
        rotation: 0,
        destroyed: false,
        movers: [],
        moved: 0,
        credited: [],
        turning: 0,
      },
    ];
    d.setLook(0, 0);
  });
  await page.locator("#view3d").focus();
  // Look without movement must leave the simulation's traffic heading alone.
  await page.waitForTimeout(100);
  expect((await pose(page)).heading).toEqual({ x: 0, y: -1 });
  await page.keyboard.press("Space");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__deadAir.game.survivors[0].vault?.obstacle,
      ),
    )
    .toBe("camera-vault-shelf");
  expect((await pose(page)).heading.x).toBeCloseTo(1, 5);
  expect((await pose(page)).heading.y).toBeCloseTo(0, 5);
});

test("the embedded terminal releases mouse capture once for text entry and completed questions leave look and E available", async ({
  page,
}) => {
  const relay = await mockClaudeStudy(page);
  await startFirstPerson(page, "synthetic");
  await page.evaluate(async () => {
    const d = (window as any).__deadAir,
      g = d.game,
      a = g.survivors[0],
      e = Object.values(g.encounters).find((e: any) => e.floor === 0) as any;
    const { ensureProblem } = await import("/src/ai.ts" as string);
    e.owner = "human";
    // A live run starts with no pre-made practice questions.
    g.study.profile = "live";
    for (const each of Object.values<any>(g.encounters)) delete each.problem;
    await ensureProblem(g, e, d.roadmap);
    g.floors[0].stations = [
      { id: "first-person-terminal", encounter: e.id, x: a.x + 0.8, y: a.y },
    ];
    d.setLook(0, 0);
  });
  const canvas = page.locator("#view3d");
  await expect(page.locator("#interaction-prompt")).toHaveText(
    "E · Open terminal",
  );
  expect(await page.evaluate(() => document.pointerLockElement?.id)).toBe(
    "view3d",
  );
  await page.keyboard.press("e");
  await expect(page.locator("#terminal")).toBeVisible();
  expect(relay.calls.length).toBeGreaterThan(0);
  expect(relay.tutorCalls()).toHaveLength(0);
  // The terminal is a panel with text fields, so it releases mouse capture
  // exactly once; the run keeps going and typing never moves the survivor.
  expect(await page.evaluate(() => document.pointerLockElement)).toBeNull();
  expect(await page.evaluate(() => (window as any).__lookLockExits)).toBe(1);
  expect(
    await page.evaluate(() => !!(window as any).__deadAir.game.paused),
  ).toBe(false);
  const time = await page.evaluate(() => (window as any).__deadAir.game.time);
  await expect
    .poll(() => page.evaluate(() => (window as any).__deadAir.game.time))
    .toBeGreaterThan(time);

  const before = await pose(page),
    fixedLook = await look(page),
    field = page.locator("#chat-input");
  await expect(field).toBeVisible();
  await field.focus();
  await page.keyboard.type("wasd e ");
  await expect(field).toBeFocused();
  expect(await page.evaluate(() => document.pointerLockElement)).toBeNull();
  expect(await pose(page)).toEqual(before);
  expect(await look(page)).toEqual(fixedLook);
  await expect(page.locator("#pause-menu")).toBeHidden();

  relay.solve();
  await field.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.values<any>((window as any).__deadAir.game.encounters).some(
          (e) => e.state === "consumed",
        ),
      ),
    )
    .toBe(true);
  await page.locator("#leave").click();
  await expect(page.locator("#terminal")).toBeHidden();
  await page.evaluate(async () => {
    const d = (window as any).__deadAir,
      a = d.game.survivors[0],
      { FURNITURE } = await import("/src/model.ts" as string);
    d.game.floors[0].stations = [];
    d.game.floors[0].furniture = [
      {
        ...FURNITURE.chair,
        id: "post-study-chair",
        kind: "chair",
        floor: 0,
        x: a.x + 0.8,
        y: a.y,
        maxHp: FURNITURE.chair.hp,
        rotation: 0,
        destroyed: false,
        movers: [],
        moved: 0,
        credited: [],
        turning: 0,
      },
    ];
    d.setLook(0, 0);
  });
  await canvas.focus();
  await expect(page.locator("#interaction-prompt")).toHaveText(
    "E · Grip chair",
  );
  const completedLook = await look(page);
  await page.keyboard.down("ArrowRight");
  await expect
    .poll(async () => (await look(page)).yaw - completedLook.yaw)
    .toBeGreaterThan(0.25);
  await page.keyboard.up("ArrowRight");
  await page.keyboard.down("ArrowLeft");
  await expect
    .poll(async () => (await look(page)).yaw)
    .toBeLessThan(completedLook.yaw + 0.1);
  await page.keyboard.up("ArrowLeft");
  await canvas.click();
  await expect
    .poll(() => page.evaluate(() => document.pointerLockElement?.id))
    .toBe("view3d");
  const box = (await canvas.boundingBox())!,
    x = box.x + box.width * 0.5,
    y = box.y + box.height * 0.65;
  await page.mouse.move(x, y);
  const beforeMove = await look(page);
  await page.mouse.move(x + 120, y - 40, { steps: 4 });
  expect((await look(page)).yaw).toBeCloseTo(beforeMove.yaw + 120 * 0.0022, 5);
  expect((await look(page)).pitch).toBeCloseTo(
    beforeMove.pitch + 40 * 0.0022,
    5,
  );
  expect(await page.evaluate(() => document.pointerLockElement?.id)).toBe(
    "view3d",
  );
  await expect(page.locator("#pause-menu")).toBeHidden();
});

test("the Game view setting switches and persists Classic, then first person still yields to the top-down spectator", async ({
  page,
}) => {
  await startFirstPerson(page);
  await openPlayerMenu(page);
  await page.locator("#settings-toggle").click();
  const setting = page.getByLabel("Game view", { exact: true });
  await expect(setting).toHaveValue("first-person");
  await setting.selectOption("top-down");
  await expect(page.locator("#view3d")).toBeHidden();
  await expect(page.locator("#world")).not.toHaveClass(/minimap/);
  expect(
    await page
      .locator("#world")
      .evaluate((canvas) => !!(canvas as HTMLCanvasElement).getContext("2d")),
  ).toBe(true);
  await page.locator("#settings-close").click();
  await flushNativeSave(page);
  await page.reload();
  await expect(page.locator("#pause-menu")).toBeVisible();
  await page.locator("#settings-toggle").click();
  await expect(setting).toHaveValue("top-down");
  await setting.selectOption("first-person");
  await expect(page.locator("#view3d")).toBeVisible();
  await expect(page.locator("#world")).toHaveClass(/minimap/);
  await page.locator("#settings-close").click();
  await page.locator("#resume-game").click();
  await page.evaluate(() => {
    const g = (window as any).__deadAir.game;
    g.survivors[0].alive = false;
    g.survivors[0].hp = 0;
    g.status = "dead";
  });
  await page.getByRole("button", { name: "Watch the building" }).click();
  await expect(page.locator("#spectator")).toBeVisible();
  await expect(page.locator("#view3d")).toBeHidden();
  await expect(page.locator("#world")).toBeVisible();
  await expect(page.locator("#world")).not.toHaveClass(/minimap/);
});
