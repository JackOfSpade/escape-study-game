import { readFileSync } from "node:fs";
import { expect as baseExpect, test, type Page } from "./helpers/offline-test";
import { qualityFixtureReply } from "../helpers/quality-design";
import { qualityContentBatches } from "../../src/run-quality-contract.mjs";

// Synthetic preparation now exercises thirty captured stages rather than two.
const expect = baseExpect.configure({ timeout: 30_000 });
test.describe.configure({ timeout: 90_000 });

const harbor = JSON.parse(
  readFileSync("tests/fixtures/run-designs/harbor-inscriptions.json", "utf8"),
);
const orchard = JSON.parse(
  readFileSync(
    "tests/fixtures/run-designs/observatory-inscriptions.json",
    "utf8",
  ),
);
const harborPhases = [
  "concepts",
  "selection",
  "structure",
  "structure-review",
  "content-plan",
  ...qualityContentBatches(harbor.environment.surfaces).map(
    () => "content-batch",
  ),
  "content-review",
];

async function designer(page: Page) {
  const calls: any[] = [],
    cancelled: string[] = [],
    delivered: string[] = [],
    results = new Map<string, object>(),
    pending = new Map<string, (design: object) => void>();
  let capable = true,
    queued = false,
    queuedPhase = "concepts",
    delayed = false,
    failedPoll = false,
    outage = false,
    working = false,
    workerActivityAt: number | undefined,
    unrelatedWorker = false;
  let answer = (_body: any) => harbor;
  let editReply = (_body: any, response: any) => response;
  const reply = (body: any, proposed: any) => {
    if (body.payload.version === 3)
      return editReply(
        body,
        qualityFixtureReply(body.payload, proposed, [harbor, orchard]),
      );
    const requestId = body.payload.requestId;
    if (body.payload.phase === "structure") {
      const { environment: _environment, ...structure } = proposed;
      return { requestId, structure };
    }
    const design = [proposed, harbor, orchard].find(
      (d) => d.title === body.payload.structure.title,
    );
    if (!design)
      throw Error("No captured synthetic content for this structure");
    const { surfaces: _surfaces, ...content } = design.environment;
    return { requestId, content };
  };
  await page.addInitScript(() => {
    const random = crypto.getRandomValues.bind(crypto);
    Object.defineProperty(crypto, "getRandomValues", {
      value(array: any) {
        if (array instanceof Uint32Array && array.length === 1) {
          array[0] = 42;
          return array;
        }
        return random(array);
      },
    });
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (url.pathname === "/api/status")
      return json({
        mode: capable ? "chatgpt-handoff" : "development",
        label: "Synthetic run designer",
        detail: "Offline browser fixture; no external model",
        capabilities: capable ? ["design-run"] : [],
      });
    if (url.pathname === "/api/handoff/status")
      return json({
        enabled: capable,
        queued: calls.length,
        working: working || unrelatedWorker ? 1 : 0,
        done: results.size,
        public: {
          configured: false,
          workerActive: working || unrelatedWorker,
          terminalRelay: { activeSessions: working || unrelatedWorker ? 1 : 0 },
        },
        recent: [
          ...(unrelatedWorker
            ? [{ id: "another-chat-request", status: "working" }]
            : []),
          ...calls.map((c) => ({
            id: c.payload.requestId,
            status: results.has(c.payload.requestId)
              ? "done"
              : working
                ? "working"
                : "queued",
            ...(workerActivityAt === undefined
              ? {}
              : {
                  claimedAt: workerActivityAt,
                  lastWorkerActivityAt: workerActivityAt,
                }),
          })),
        ],
      });
    if (url.pathname === "/api/bridge" && request.method() === "POST") {
      const body = request.postDataJSON();
      if (body.operation !== "design-run")
        return json({ error: "Unexpected synthetic operation" }, 400);
      calls.push(body);
      const id = body.payload.requestId;
      if (delayed && body.payload.phase === "concepts") {
        const design = await new Promise<object>((resolve) =>
          pending.set(id, resolve),
        );
        await json(reply(body, design));
        delivered.push(id);
        return;
      }
      return queued && body.payload.phase === queuedPhase
        ? json({ handoff: { id, hash: `synthetic-${id}` } }, 202)
        : json(reply(body, answer(body)));
    }
    if (url.pathname === "/api/bridge/result") {
      const id = url.searchParams.get("id")!;
      if (request.method() === "DELETE") {
        cancelled.push(id);
        return json({ cancelled: true });
      }
      if (outage)
        return route.fulfill({
          status: 503,
          contentType: "text/html",
          body: "Synthetic proxy unavailable",
        });
      if (failedPoll)
        return json({ error: "Synthetic design request interrupted" }, 409);
      return results.has(id)
        ? json(results.get(id))
        : json(
            {
              handoff: {
                id,
                status: working ? "working" : "queued",
                ...(workerActivityAt === undefined
                  ? {}
                  : {
                      claimedAt: workerActivityAt,
                      lastWorkerActivityAt: workerActivityAt,
                    }),
              },
            },
            202,
          );
    }
    return json({ error: "No synthetic route" }, 404);
  });
  return {
    calls,
    cancelled,
    delivered,
    setCapable(value: boolean) {
      capable = value;
    },
    setQueued(value: boolean, phase = "concepts") {
      queued = value;
      queuedPhase = phase;
    },
    setDelayed(value: boolean) {
      delayed = value;
    },
    setFailedPoll(value: boolean) {
      failedPoll = value;
    },
    setOutage(value: boolean) {
      outage = value;
    },
    setWorking(value: boolean) {
      working = value;
    },
    setWorkerActivityAt(value: number) {
      workerActivityAt = value;
    },
    setUnrelatedWorker(value: boolean) {
      unrelatedWorker = value;
    },
    setAnswer(value: (body: any) => any) {
      answer = value;
    },
    setReply(value: (body: any, response: any) => any) {
      editReply = value;
    },
    finish(call: any, design = harbor) {
      const waiting = pending.get(call.payload.requestId);
      if (waiting) {
        pending.delete(call.payload.requestId);
        waiting(design);
        return;
      }
      results.set(call.payload.requestId, reply(call, design));
    },
  };
}

async function open(page: Page) {
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__deadAir);
  await page.evaluate(() => {
    const g = (window as any).__deadAir.game;
    g.settings.view = "top-down";
    g.settings.volume = 0;
  });
}
async function state(page: Page) {
  return page.evaluate(() => {
    const g = (window as any).__deadAir.game;
    return {
      id: g.id,
      seed: g.seed,
      status: g.status,
      preparing: !!g.preparingRun,
      design: g.design,
      floorNames: g.floors.map((f: any) => f.name),
      tiles: g.floors.map((f: any) => f.tiles),
      scenes: g.floors.map((f: any) => f.scene),
      environments: g.floors.map((f: any) => f.environment),
      names: g.survivors.slice(1).map((a: any) => a.name),
    };
  });
}
async function gameplayState(page: Page) {
  return page.evaluate(() => {
    const g = (window as any).__deadAir.game;
    return {
      time: g.time,
      tick: g.tick ?? 0,
      survivors: g.survivors.map((a: any) => ({
        id: a.id,
        x: a.x,
        y: a.y,
        floor: a.floor,
        hp: a.hp,
      })),
      zombies: g.zombies.map((a: any) => ({
        id: a.id,
        x: a.x,
        y: a.y,
        floor: a.floor,
        hp: a.hp,
      })),
    };
  });
}
async function expectFrozen(page: Page) {
  const before = await gameplayState(page);
  // Let actual application frames run while the player has stepped away.
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        const until = performance.now() + 1000;
        const frame = () => {
          if (performance.now() >= until) done();
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
  );
  expect(await gameplayState(page)).toEqual(before);
  return before;
}
async function prepared(page: Page) {
  await expect.poll(async () => (await state(page)).preparing).toBe(false);
  expect((await state(page)).status).toBe("ready");
  await expect(page.locator("#run-design-dialog")).toHaveCount(0);
  await expect(page.locator("#start-card")).toBeVisible();
  await expect(page.locator("#start")).toHaveText("Start game ↗");
}
async function startPrepared(page: Page) {
  await prepared(page);
  await page.locator("#start").click();
  await expect.poll(async () => (await state(page)).status).toBe("playing");
}
async function flush(page: Page) {
  await page.evaluate(async () => {
    const { flushSaves } = await import("/src/persistence.ts" as string);
    await flushSaves();
  });
}
async function pause(page: Page) {
  await page.locator("#pause-toggle").click();
  await expect(page.locator("#pause-menu")).toBeVisible();
  await flush(page);
}

for (const { clipboardDenied, popupBlocked } of [
  { clipboardDenied: false, popupBlocked: false },
  { clipboardDenied: true, popupBlocked: false },
  { clipboardDenied: true, popupBlocked: true },
]) {
  test(`designer Connect prefills an unsent ChatGPT draft without showing the prompt, clipboard ${clipboardDenied ? "denied" : "available"}, popup ${popupBlocked ? "blocked" : "available"}`, async ({
    page,
    context,
  }) => {
    const relay = await designer(page);
    relay.setQueued(true);
    await context.route("https://chatgpt.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<title>Synthetic ChatGPT draft</title>",
      }),
    );
    await page.addInitScript(
      ({ clipboardDenied, popupBlocked }) => {
        const nativeOpen = window.open.bind(window);
        (window as any).__designerChatUrls = [];
        window.open = (...args: Parameters<typeof window.open>) => {
          (window as any).__designerChatUrls.push(String(args[0]));
          return popupBlocked ? null : nativeOpen(...args);
        };
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async () => {
              if (clipboardDenied)
                throw new DOMException("Denied", "NotAllowedError");
            },
          },
        });
      },
      { clipboardDenied, popupBlocked },
    );
    await open(page);
    const before = await state(page);
    await page.locator("#start").click();
    await expect.poll(() => relay.calls.length).toBe(1);
    const request = relay.calls[0];
    const expectedPrompt = await page.evaluate(async () => {
      const { readDesignDraft, designChatPrompt } = await import(
        "/src/run-designer.ts" as string
      );
      const draft = readDesignDraft((window as any).__deadAir.game.id);
      if (!draft) throw Error("Missing synthetic designer draft");
      return designChatPrompt(draft);
    });
    const popup = popupBlocked ? undefined : page.waitForEvent("popup");
    await page.locator("#run-design-connect").click();
    const openedUrls = await page.evaluate(
      () => (window as any).__designerChatUrls as string[],
    );
    expect(openedUrls).toHaveLength(1);
    const url = new URL(openedUrls[0]);
    expect(url.origin).toBe("https://chatgpt.com");
    expect(url.searchParams.get("q")).toBe(expectedPrompt);
    expect(url.searchParams.get("submit")).toBe("false");
    if (popup) {
      const chat = await popup;
      await chat.waitForURL(openedUrls[0]);
      await expect(chat).toHaveTitle("Synthetic ChatGPT draft");
      await chat.close();
    }
    const dialog = page.locator("#run-design-dialog");
    await expect(dialog).toHaveAttribute("data-state", "waiting");
    await expect(page.locator("#run-design-loading")).toBeHidden();
    await expect(page.locator("#run-design-status")).toContainText(
      "Waiting for ChatGPT",
    );
    await expect(
      page.locator('#run-design-steps [data-step="connect"]'),
    ).toHaveAttribute("data-state", "active");
    await expect(
      page.locator('#run-design-steps [data-state="complete"]'),
    ).toHaveCount(0);
    await expect(dialog.locator("textarea, details")).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "Copy request" }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole("link", { name: /^Open ChatGPT/ }),
    ).toHaveAttribute("href", openedUrls[0]);
    if (!clipboardDenied && !popupBlocked)
      await dialog.screenshot({
        path: ".artifacts/handoff/design/chatgpt-prefill-dialog.png",
      });
    expect(relay.calls).toHaveLength(1);
    expect(await state(page)).toEqual(before);
    await page.locator("#run-design-cancel").click();
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(() => relay.cancelled)
      .toContain(request.payload.requestId);
    expect(relay.calls).toHaveLength(1);
    expect(await state(page)).toEqual(before);
  });
}

test("the fallback ChatGPT link retries failed connector setup without advancing the pending design", async ({
  page,
  context,
}) => {
  const relay = await designer(page);
  relay.setQueued(true);
  await context.route("https://chatgpt.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<title>Synthetic recovery chat</title>",
    }),
  );
  await page.addInitScript(() => {
    // The initial click must retain a usable fallback when a popup is blocked.
    window.open = () => null;
  });
  await open(page);
  const before = await state(page);
  await page.evaluate(async () => {
    const { chooseRunDesign } = await import("/src/run-design-ui.ts" as string),
      app = (window as any).__deadAir;
    (window as any).__designRecoveryConnectCalls = 0;
    void chooseRunDesign(app.game, app.roadmap, async () => {
      const call = ++(window as any).__designRecoveryConnectCalls;
      if (call === 1) throw Error("Synthetic connector startup failed");
    });
  });
  await expect.poll(() => relay.calls.length).toBe(1);
  await page.locator("#run-design-connect").click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__designRecoveryConnectCalls),
    )
    .toBe(1);
  const fallback = page.locator("#run-design-open"),
    url = await fallback.getAttribute("href");
  await expect(fallback).toBeVisible();
  const popup = page.waitForEvent("popup");
  await fallback.click();
  const chat = await popup;
  await chat.waitForURL(url!);
  await expect(chat).toHaveTitle("Synthetic recovery chat");
  await chat.close();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__designRecoveryConnectCalls),
    )
    .toBe(2);
  await expect(page.locator("#run-design-dialog")).toHaveAttribute(
    "data-state",
    "waiting",
  );
  await expect(page.locator("#run-design-loading")).toBeHidden();
  await expect(
    page.locator('#run-design-steps [data-state="complete"]'),
  ).toHaveCount(0);
  expect(relay.calls).toHaveLength(1);
  expect(await state(page)).toEqual(before);
  await page.locator("#run-design-cancel").click();
  await expect(page.locator("#run-design-dialog")).toHaveCount(0);
  await expect
    .poll(() => relay.cancelled)
    .toContain(relay.calls[0].payload.requestId);
  expect(await state(page)).toEqual(before);
});

test("setup progress follows this chat's claimed job and completed stages, stopping during a bridge outage", async ({
  page,
}) => {
  const relay = await designer(page);
  relay.setQueued(true);
  relay.setUnrelatedWorker(true);
  await open(page);
  const original = await state(page);
  await page.locator("#start").click();
  await expect.poll(() => relay.calls.length).toBe(1);
  const dialog = page.locator("#run-design-dialog"),
    loading = page.locator("#run-design-loading"),
    step = (name: string) =>
      page.locator(`#run-design-steps [data-step="${name}"]`);
  await expect(dialog).toHaveAttribute("data-state", "waiting");
  await expect(loading).toBeHidden();
  await expect(page.getByRole("progressbar")).not.toBeVisible();
  await expect(page.locator("#run-design-retry")).toBeHidden();
  await expect(step("connect")).toHaveAttribute("data-state", "active");
  await expect(step("connect")).toHaveAttribute("aria-current", "step");
  await expect(step("design")).toHaveAttribute("data-state", "pending");
  // An active worker in another chat is not evidence this request was claimed.
  await expectFrozen(page);
  await expect(loading).toBeHidden();
  await dialog.screenshot({
    path: ".artifacts/handoff/design/reactive-setup-waiting.png",
  });

  relay.setWorking(true);
  await expect(dialog).toHaveAttribute("data-state", "working");
  await expect(loading).toBeVisible();
  await expect(page.getByRole("progressbar")).toBeVisible();
  await expect(step("connect")).toHaveAttribute("data-state", "complete");
  await expect(step("design")).toHaveAttribute("data-state", "active");
  await expect(step("design")).toHaveAttribute("aria-current", "step");
  await expect(step("details")).toHaveAttribute("data-state", "pending");
  await expect(step("review")).toHaveAttribute("data-state", "pending");
  await dialog.screenshot({
    path: ".artifacts/handoff/design/reactive-setup-working.png",
  });

  relay.setOutage(true);
  await expect(dialog).toHaveAttribute("data-state", "reconnecting");
  await expect(loading).toBeHidden();
  await expect(step("design")).toHaveAttribute("data-state", "active");
  await expect(step("details")).toHaveAttribute("data-state", "pending");
  expect(await state(page)).toEqual(original);

  relay.setWorking(false);
  relay.setOutage(false);
  relay.setQueued(true, "content-batch");
  relay.finish(relay.calls[0]);
  await expect
    .poll(() => relay.calls.at(-1)?.payload.phase)
    .toBe("content-batch");
  await expect(dialog).toHaveAttribute("data-state", "waiting");
  await expect(loading).toBeHidden();
  await expect(step("connect")).toHaveAttribute("data-state", "complete");
  await expect(step("design")).toHaveAttribute("data-state", "complete");
  await expect(step("details")).toHaveAttribute("data-state", "active");
  await expect(step("review")).toHaveAttribute("data-state", "pending");
  expect(await state(page)).toEqual(original);

  relay.setWorking(true);
  await expect(dialog).toHaveAttribute("data-state", "working");
  await expect(loading).toBeVisible();
  await expect(page.locator("#run-design-status")).toContainText(/group 1 of/);
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await expect
    .poll(() =>
      dialog.evaluate((element) => element.scrollWidth <= element.clientWidth),
    )
    .toBe(true);
  await dialog.screenshot({
    path: ".artifacts/handoff/design/reactive-setup-working-narrow.png",
  });

  relay.setQueued(true, "content-review");
  relay.finish(relay.calls.at(-1));
  await expect
    .poll(() => relay.calls.at(-1)?.payload.phase)
    .toBe("content-review");
  await expect(step("details")).toHaveAttribute("data-state", "complete");
  await expect(step("review")).toHaveAttribute("data-state", "active");
  await expect(step("review")).not.toHaveAttribute("data-state", "complete");
  relay.setQueued(false);
  relay.finish(relay.calls.at(-1));
  await prepared(page);
  expect((await state(page)).status).toBe("ready");
  expect((await gameplayState(page)).time).toBe(0);
});

test("a silent design worker exposes recovery, preserves its saved batch on reload and accepts a late reply", async ({
  page,
}) => {
  const relay = await designer(page);
  relay.setQueued(true, "content-batch");
  relay.setWorking(true);
  relay.setWorkerActivityAt(Date.now());
  await open(page);
  const original = await state(page);
  await page.locator("#start").click();
  await expect
    .poll(() => relay.calls.at(-1)?.payload.phase)
    .toBe("content-batch");
  const batch = relay.calls.at(-1),
    dialog = page.locator("#run-design-dialog");
  await expect(dialog).toHaveAttribute("data-state", "working");
  relay.setWorkerActivityAt(Date.now() - 6 * 60_000);
  await expect(dialog).toHaveAttribute("data-state", "stalled");
  await expect(page.locator("#run-design-loading")).toBeHidden();
  await expect(page.locator("#run-design-title")).toHaveText("Check ChatGPT");
  await expect(page.locator("#run-design-status")).toContainText(
    "if it stopped, ask it to continue",
  );
  await expect(
    page.getByRole("button", { name: "Resume in ChatGPT" }),
  ).toBeVisible();
  await expect(
    page.locator('#run-design-steps [data-step="details"]'),
  ).toHaveAttribute("data-state", "active");
  expect(await state(page)).toEqual(original);
  expect(relay.cancelled).toEqual([]);
  await dialog.screenshot({
    path: ".artifacts/handoff/design/stalled-worker-recovery.png",
  });

  await page.reload();
  await page.getByRole("button", { name: "Prepare game" }).click();
  await expect(page.locator("#run-design-dialog")).toHaveAttribute(
    "data-state",
    "stalled",
  );
  expect(relay.calls.at(-1)).toEqual(batch);
  expect(relay.cancelled).toEqual([]);
  relay.setWorkerActivityAt(Date.now());
  await expect(page.locator("#run-design-dialog")).toHaveAttribute(
    "data-state",
    "working",
  );
  relay.setQueued(false);
  relay.finish(batch);
  await prepared(page);
  expect((await state(page)).status).toBe("ready");
  expect((await gameplayState(page)).time).toBe(0);
  await page.locator("#start").click();
  await expect.poll(async () => (await state(page)).status).toBe("playing");
  await expect
    .poll(async () => (await gameplayState(page)).time)
    .toBeGreaterThan(0);
});

test("prepared runs wait for an explicit Start before gameplay and across reload", async ({
  page,
}) => {
  const relay = await designer(page);
  relay.setQueued(true);
  await open(page);
  await page.locator("#start").click();
  await expect.poll(() => relay.calls.length).toBe(1);
  await expect(page.locator("#run-design-dialog")).toBeVisible();
  await expect(page.getByRole("progressbar")).not.toBeVisible();
  await expect(page.locator("#run-design-dialog")).toHaveAttribute(
    "data-state",
    "waiting",
  );
  const loading = await expectFrozen(page);
  expect(loading.time).toBe(0);
  const viewport = page.viewportSize()!;
  await page.screenshot({
    path: ".artifacts/handoff/design/ai-design-loading.png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: ".artifacts/handoff/design/ai-design-loading-narrow.png",
  });
  await page.setViewportSize(viewport);
  relay.setQueued(false);
  relay.finish(relay.calls[0]);
  await prepared(page);
  await expect(page.locator("#start-card")).toContainText(
    "Your escape is ready",
  );
  const ready = await expectFrozen(page);
  expect(ready.time).toBe(0);
  const completed = await state(page);
  const requests = relay.calls.length;
  await flush(page);
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__deadAir);
  await prepared(page);
  expect(await state(page)).toEqual(completed);
  expect(await expectFrozen(page)).toEqual(ready);
  expect(relay.calls).toHaveLength(requests);
  await page.locator("#start-card").screenshot({
    path: ".artifacts/handoff/design/ai-design-ready.png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: ".artifacts/handoff/design/ai-design-ready-narrow.png",
  });
  await page.setViewportSize(viewport);
  await page.locator("#start").click();
  await expect.poll(async () => (await state(page)).status).toBe("playing");
  await expect
    .poll(async () => (await gameplayState(page)).time)
    .toBeGreaterThan(ready.time);
});

test("new-game AI design reaches the full app and a saved reload keeps the exact authored world", async ({
  page,
}) => {
  const relay = await designer(page);
  await open(page);
  expect((await state(page)).preparing).toBe(true);
  await page.locator("#start").click();
  await startPrepared(page);
  await pause(page);
  const before = await state(page);
  expect(relay.calls).toHaveLength(harborPhases.length);
  expect(relay.calls[0].provider).toBe("chatgpt-handoff");
  expect(relay.calls[0].payload.designVersion).toBe(3);
  expect(relay.calls[0].payload.version).toBe(3);
  expect(relay.calls.map((c) => c.payload.phase)).toEqual(harborPhases);
  expect(before.design.design.version).toBe(3);
  expect(before.environments[0].entries.length).toBeGreaterThan(50);
  expect(before.scenes[0].props.length).toBeGreaterThan(0);
  expect(relay.calls[0].nativeScope.encounterId).toBe("run-design");
  expect(before.design.design.title).toBe(harbor.title);
  expect(before.floorNames).toEqual([
    ...harbor.floors.map((f: any) => f.name),
    harbor.roofName,
  ]);
  expect(before.names).toEqual(harbor.roster.map((a: any) => a.name));
  expect(before.preparing).toBe(false);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("dead-air-run-design-draft-v1"),
    ),
  ).toBeNull();
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__deadAir);
  const restored = await state(page);
  expect(restored.id).toBe(before.id);
  expect(restored.design).toEqual(before.design);
  expect(restored.tiles).toEqual(before.tiles);
  expect(restored.floorNames).toEqual(before.floorNames);
  expect(restored.names).toEqual(before.names);
  expect(restored.environments).toEqual(before.environments);
  expect(relay.calls).toHaveLength(harborPhases.length);
  await expect(page.locator("#run-design-dialog")).toHaveCount(0);
});

test("an offline first launch can only retry or cancel until a reviewed design is ready", async ({
  page,
}) => {
  const relay = await designer(page);
  relay.setCapable(false);
  await open(page);
  const before = await state(page);
  await page.locator("#start").click();
  await expect(page.locator("#run-design-status")).toContainText("unavailable");
  await expect(page.locator("#run-design-procedural")).toHaveCount(0);
  expect(await state(page)).toEqual(before);
  expect(before.status).toBe("ready");
  expect(before.preparing).toBe(true);
  await page.locator("#run-design-retry").click();
  await expect(page.locator("#run-design-retry")).toBeEnabled();
  expect(await state(page)).toEqual(before);
  expect(relay.calls).toHaveLength(0);
  await page.locator("#run-design-cancel").click();
  await expect(page.locator("#run-design-dialog")).toHaveCount(0);
  expect(await state(page)).toEqual(before);
  await page.locator("#start").click();
  await expect(page.locator("#run-design-status")).toContainText("unavailable");
  relay.setCapable(true);
  await page.locator("#run-design-retry").click();
  await startPrepared(page);
  const after = await state(page);
  expect(after.id).not.toBe(before.id);
  expect(after.preparing).toBe(false);
  expect(after.design.design.title).toBe(harbor.title);
  expect(relay.calls.map((c) => c.payload.phase)).toEqual(harborPhases);
});

test("an offline restart preserves the accepted run until the replacement passes review", async ({
  page,
}) => {
  const relay = await designer(page);
  await open(page);
  await page.locator("#start").click();
  await startPrepared(page);
  await pause(page);
  const before = await state(page);
  relay.setCapable(false);
  await page.locator("#restart-game").click();
  await expect(page.locator("#run-design-status")).toContainText("unavailable");
  await expect(page.locator("#run-design-procedural")).toHaveCount(0);
  expect(await state(page)).toEqual(before);
  await page.locator("#run-design-cancel").click();
  await expect(page.locator("#run-design-dialog")).toHaveCount(0);
  await expect(page.locator("#pause-menu")).toBeVisible();
  expect(await state(page)).toEqual(before);
  await page.locator("#restart-game").click();
  await expect(page.locator("#run-design-status")).toContainText("unavailable");
  expect(await state(page)).toEqual(before);
  relay.setAnswer(() => orchard);
  relay.setCapable(true);
  await page.locator("#run-design-retry").click();
  await expect
    .poll(async () => (await state(page)).design?.design.title)
    .toBe(orchard.title);
  const after = await state(page);
  expect(after.id).not.toBe(before.id);
  expect(after.preparing).toBe(false);
  const replacement = relay.calls.filter(
    (call) => call.payload.generationId === after.design.generationId,
  );
  expect(replacement[0].payload.phase).toBe("concepts");
  expect(replacement.at(-1).payload.phase).toBe("content-review");
  await prepared(page);
  await expect(page.locator("#pause-menu")).not.toBeVisible();
  await expectFrozen(page);
  await flush(page);
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__deadAir);
  await prepared(page);
  expect(await state(page)).toEqual(after);
  await expectFrozen(page);
  await startPrepared(page);
});

test("reloading a pending design retries the same captured request and chat rather than rerolling", async ({
  page,
}) => {
  const relay = await designer(page);
  relay.setQueued(true);
  await open(page);
  const originalId = (await state(page)).id;
  await page.locator("#start").click();
  await expect.poll(() => relay.calls.length).toBe(1);
  await expect(page.locator("#run-design-status")).toContainText(
    "Waiting for ChatGPT",
  );
  await page.screenshot({
    path: ".artifacts/handoff/design/ai-design-waiting.png",
  });
  await flush(page);
  const first = structuredClone(relay.calls[0]);
  expect(first.chatCode).toMatch(/^[A-Z0-9]{8}$/);
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__deadAir);
  expect((await state(page)).id).toBe(originalId);
  await page.locator("#start").click();
  await expect.poll(() => relay.calls.length).toBe(2);
  expect(relay.calls[1]).toEqual(first);
  relay.finish(first);
  await expect
    .poll(async () => (await state(page)).design?.design.title)
    .toBe(harbor.title);
  expect(relay.calls).toHaveLength(harborPhases.length + 1);
});

test("reloading while individual writing is pending retains the exact object inventory and content request", async ({
  page,
}) => {
  const relay = await designer(page);
  relay.setQueued(true, "content-batch");
  await open(page);
  const original = await state(page);
  await page.locator("#start").click();
  await expect
    .poll(() => relay.calls.at(-1)?.payload.phase)
    .toBe("content-batch");
  const index = relay.calls.length - 1;
  const captured = structuredClone(relay.calls[index]);
  expect(captured.payload.phase).toBe("content-batch");
  expect(captured.payload.surfaces).toEqual(harbor.environment.surfaces);
  expect((await state(page)).id).toBe(original.id);
  await flush(page);
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__deadAir);
  await page.locator("#start").click();
  await expect.poll(() => relay.calls.length).toBe(index + 2);
  expect(relay.calls[index + 1]).toEqual(captured);
  expect((await state(page)).id).toBe(original.id);
  relay.setQueued(false);
  relay.finish(captured);
  await startPrepared(page);
  expect((await state(page)).design.design.environment).toEqual(
    harbor.environment,
  );
  expect(relay.calls).toHaveLength(harborPhases.length + 1);
});

test("restart sends recent fictional designs and repairs a repeated design before replacing the run", async ({
  page,
}) => {
  const relay = await designer(page);
  relay.setAnswer((body) => (body.payload.repair ? orchard : harbor));
  await open(page);
  await page.locator("#start").click();
  await startPrepared(page);
  const before = await state(page);
  await pause(page);
  await page.locator("#restart-game").click();
  await expect
    .poll(async () => (await state(page)).design?.design.title)
    .toBe(orchard.title);
  const after = await state(page);
  expect(after.id).not.toBe(before.id);
  expect(after.tiles).not.toEqual(before.tiles);
  expect(
    relay.calls.filter((c) => c.payload.phase === "content-review"),
  ).toHaveLength(2);
  const structureCalls = relay.calls.filter(
    (c) => c.payload.phase === "structure",
  );
  const repeat = structureCalls[1],
    repair = structureCalls[2];
  expect(repeat.payload.recent[0].title).toBe(harbor.title);
  expect(repair.payload.repair.candidate.title).toBe(harbor.title);
  expect(repair.payload.repair.errors.length).toBeGreaterThan(0);
  expect(repair.payload.generationId).toBe(repeat.payload.generationId);
  expect(repair.payload.requestId).not.toBe(repeat.payload.requestId);
  expect(repair.chatCode).toBe(repeat.chatCode);
  expect(Object.keys(repeat.payload).sort()).toEqual([
    "concept",
    "designVersion",
    "generationId",
    "phase",
    "rationale",
    "recent",
    "recentContent",
    "requestId",
    "seed",
    "version",
  ]);
});

test("editorial review resumes exactly after reload and revises only its identified object before play", async ({
  page,
}) => {
  const relay = await designer(page);
  const slot = harbor.environment.surfaces.find(
    (s: any) => s.floor === 0 && s.role === "wall-poster" && s.maxBody >= 100,
  );
  const entry = harbor.environment.entries.find(
    (e: any) => e.surfaceId === slot.id,
  );
  const revisedBody = `${harbor.roster[0].name} kept Wednesday's ferry sketches beside the brass visitor ledger. The last page is unfinished.`;
  let reviews = 0;
  relay.setReply((body, response) => {
    if (body.payload.phase === "content-review" && ++reviews === 1)
      return {
        requestId: body.payload.requestId,
        findings: [
          {
            id: "specific-occupant-evidence",
            priority: "major",
            target: `surface:${slot.id}`,
            problem:
              "The poster gives little evidence of the room's previous occupant.",
            evidence: `The current title is ${entry.title.map((p: any) => p.text ?? "").join("")}.`,
            recommendation:
              "Add a concrete ordinary workplace trace tied to the room's artifacts.",
          },
        ],
      };
    if (body.payload.phase === "content-revision")
      return {
        ...response,
        entries: response.entries.map((e: any) => ({
          ...e,
          body: [{ text: revisedBody }],
          layout: e.drawing ? "mixed" : "text",
        })),
      };
    return response;
  });
  relay.setQueued(true, "content-review");
  await open(page);
  const original = await state(page);
  await page.locator("#start").click();
  await expect
    .poll(() => relay.calls.at(-1)?.payload.phase)
    .toBe("content-review");
  const reviewIndex = relay.calls.length - 1;
  const captured = structuredClone(relay.calls[reviewIndex]);
  expect(captured.payload.content.entries).toHaveLength(
    harbor.environment.entries.length,
  );
  expect((await state(page)).id).toBe(original.id);
  await flush(page);
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__deadAir);
  await page.locator("#start").click();
  await expect.poll(() => relay.calls.length).toBe(reviewIndex + 2);
  expect(relay.calls.at(-1)).toEqual(captured);
  expect((await state(page)).id).toBe(original.id);
  relay.setQueued(false);
  relay.finish(captured);
  await startPrepared(page);
  const after = await state(page);
  const entries = after.design.design.environment.entries;
  expect(entries.find((e: any) => e.surfaceId === slot.id).body).toEqual([
    { text: revisedBody },
  ]);
  expect(entries.filter((e: any) => e.surfaceId !== slot.id)).toEqual(
    harbor.environment.entries.filter((e: any) => e.surfaceId !== slot.id),
  );
  expect(
    relay.calls.slice(reviewIndex + 2).map((c) => c.payload.phase),
  ).toEqual(["content-revision", "content-review"]);
  await pause(page);
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__deadAir);
  expect((await state(page)).design).toEqual(after.design);
});

test("a late result from a cancelled design cannot replace the current run or the next design", async ({
  page,
}) => {
  const relay = await designer(page);
  relay.setQueued(true);
  await open(page);
  const before = await state(page);
  await page.locator("#start").click();
  await expect.poll(() => relay.calls.length).toBe(1);
  const cancelled = relay.calls[0];
  await page.locator("#run-design-cancel").click();
  await expect(page.locator("#run-design-dialog")).toHaveCount(0);
  await expect
    .poll(() => relay.cancelled)
    .toContain(cancelled.payload.requestId);
  relay.finish(cancelled, harbor);
  expect(await state(page)).toEqual(before);
  await page.locator("#start").click();
  await expect.poll(() => relay.calls.length).toBe(2);
  const current = relay.calls[1];
  expect(current.payload.requestId).not.toBe(cancelled.payload.requestId);
  expect(current.chatCode).not.toBe(cancelled.chatCode);
  relay.finish(current, orchard);
  await expect
    .poll(async () => (await state(page)).design?.design.title)
    .toBe(orchard.title);
  const content = relay.calls.find(
    (call) =>
      call.payload.phase === "content-review" &&
      call.payload.generationId === current.payload.generationId,
  );
  expect(content).toBeDefined();
  expect((await state(page)).design.requestId).toBe(content.payload.requestId);
  expect((await state(page)).design.generationId).toBe(
    current.payload.generationId,
  );
});

test("cancelling before the bridge replies ignores that delayed reply while another design is pending", async ({
  page,
}) => {
  const relay = await designer(page);
  relay.setDelayed(true);
  await open(page);
  const before = await state(page);
  await page.locator("#start").click();
  await expect.poll(() => relay.calls.length).toBe(1);
  const cancelled = relay.calls[0];
  await page.locator("#run-design-cancel").click();
  await expect(page.locator("#run-design-dialog")).toHaveCount(0);
  expect(await state(page)).toEqual(before);
  await page.locator("#start").click();
  await expect.poll(() => relay.calls.length).toBe(2);
  const current = relay.calls[1];
  relay.finish(cancelled, harbor);
  await expect
    .poll(() => relay.delivered)
    .toContain(cancelled.payload.requestId);
  await expect(page.locator("#run-design-dialog")).toBeVisible();
  expect(await state(page)).toEqual(before);
  relay.finish(current, orchard);
  await expect
    .poll(async () => (await state(page)).design?.design.title)
    .toBe(orchard.title);
  const content = relay.calls.find(
    (call) =>
      call.payload.phase === "content-review" &&
      call.payload.generationId === current.payload.generationId,
  );
  expect(content).toBeDefined();
  expect((await state(page)).design.requestId).toBe(content.payload.requestId);
  expect((await state(page)).design.generationId).toBe(
    current.payload.generationId,
  );
});

test("settled design failures retain receipts until Cancel or Escape without starting a run", async ({
  page,
}) => {
  const relay = await designer(page);
  relay.setQueued(true);
  relay.setFailedPoll(true);
  await open(page);
  const before = await state(page);
  for (const dismissal of ["cancel", "escape"]) {
    await page.locator("#start").click();
    await expect(page.locator("#run-design-status")).toContainText(
      "Synthetic design request interrupted",
    );
    await expect(page.locator("#run-design-retry")).toBeEnabled();
    const call = relay.calls.at(-1)!;
    expect(relay.cancelled).not.toContain(call.payload.requestId);
    const receipt = await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("dead-air-run-design-draft-v1")!)
          .receipt,
    );
    expect(receipt.requestId).toBe(call.payload.requestId);
    if (dismissal === "escape") await page.keyboard.press("Escape");
    else await page.locator(`#run-design-${dismissal}`).click();
    await expect(page.locator("#run-design-dialog")).toHaveCount(0);
    await expect.poll(() => relay.cancelled).toContain(call.payload.requestId);
    expect(
      await page.evaluate(() =>
        localStorage.getItem("dead-air-run-design-draft-v1"),
      ),
    ).toBeNull();
    expect(await state(page)).toEqual(before);
  }
  expect((await state(page)).status).toBe("ready");
  expect((await state(page)).preparing).toBe(true);
  await page.locator("#start").click();
  await expect(page.locator("#run-design-status")).toContainText(
    "Synthetic design request interrupted",
  );
  await expect(page.locator("#run-design-procedural")).toHaveCount(0);
  const retry = relay.calls.at(-1)!;
  relay.setFailedPoll(false);
  relay.setQueued(false);
  relay.finish(retry);
  await page.locator("#run-design-retry").click();
  await startPrepared(page);
  const after = await state(page);
  expect(after.id).not.toBe(before.id);
  expect(after.design.design.title).toBe(harbor.title);
  expect(after.design.generationId).toBe(retry.payload.generationId);
  expect(relay.calls.at(-1).payload.phase).toBe("content-review");
});

test("looking at an authored object reveals its readable caption without replacing furniture controls", async ({
  page,
}) => {
  // The full first-person scene compiles on software WebGL in hosted CI.
  test.setTimeout(120_000);
  await designer(page);
  await open(page);
  await page.locator("#start").click();
  await startPrepared(page);
  await page.evaluate(() => {
    const g = (window as any).__deadAir.game;
    g.settings.view = "first-person";
    g.survivors = [g.survivors[0]];
    g.zombies = [];
    g.nextSpawn = Number.MAX_SAFE_INTEGER;
  });
  await expect(page.locator("#view3d")).toBeVisible();
  const target = await page.evaluate(async () => {
    const { surfaceWorldPose } = await import(
        "/src/environment-surfaces.ts" as string
      ),
      { expandContentText } = await import(
        "/src/environment-contract.mjs" as string
      ),
      { sceneLookDescription } = await import(
        "/src/scene-observations.ts" as string
      ),
      { solid } = await import("/src/spatial.ts" as string),
      app = (window as any).__deadAir,
      g = app.game,
      f = g.floors[0],
      a = g.survivors[0];
    for (const slot of f.environment.surfaces.filter(
      (s: any) => s.role === "prop-face",
    )) {
      const pose = surfaceWorldPose(f, slot);
      if (!pose?.parent) continue;
      const entry = f.environment.entries.find(
          (e: any) => e.surfaceId === slot.id,
        ),
        title = expandContentText(entry.title, f.environment.fragments),
        text =
          expandContentText(entry.body, f.environment.fragments) ||
          entry.description;
      if (!title || !text) continue;
      for (let i = 0; i < 16; i++) {
        const angle = (i * Math.PI) / 8,
          point = {
            x: pose.parent.x + Math.cos(angle) * 1.15,
            y: pose.parent.y + Math.sin(angle) * 1.15,
          };
        if (solid(f, point, 0.3)) continue;
        Object.assign(a, point, { floor: 0 });
        const yaw = Math.atan2(pose.y - a.y, pose.x - a.x),
          pitch = Math.atan2(
            pose.z - 1.6,
            Math.hypot(pose.x - a.x, pose.y - a.y),
          );
        if (!sceneLookDescription(g, yaw, pitch).includes(text)) continue;
        app.setLook(yaw, pitch);
        return { parent: pose.parent.id, title, text };
      }
    }
    throw Error("No reachable authored object to read");
  });
  await expect(page.locator("#scene-description")).toContainText(target.title);
  await expect(page.locator("#scene-description")).toContainText(target.text);
  await expect(page.locator("#interaction-prompt")).toContainText("Grip");
  await page.evaluate((id) => {
    const g = (window as any).__deadAir.game;
    g.floors[0].furniture.find((o: any) => o.id === id).destroyed = true;
  }, target.parent);
  await expect(page.locator("#scene-description")).toBeHidden();
});
