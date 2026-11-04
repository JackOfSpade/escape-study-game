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
    delivered: string[] = [],
    pending = new Map<string, (design: object) => void>();
  let capable = true,
    holdAll = false,
    holdPhase = "concepts",
    failing = false;
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
        mode: capable ? "claude-cli" : "development",
        label: "Synthetic run designer",
        detail: "Offline browser fixture; no external model",
        capabilities: capable ? ["design-run"] : [],
      });
    if (url.pathname === "/api/bridge" && request.method() === "POST") {
      const body = request.postDataJSON();
      if (body.operation !== "design-run")
        return json({ error: "Unexpected synthetic operation" }, 400);
      calls.push(body);
      const id = body.payload.requestId;
      if (failing)
        return json({ error: "Synthetic design request interrupted" }, 502);
      // A held request stays in flight until the test finishes it.
      if (holdAll && body.payload.phase === holdPhase) {
        const design = await new Promise<object>((resolve) =>
          pending.set(id, resolve),
        );
        await json(reply(body, design)).catch(() => {});
        delivered.push(id);
        return;
      }
      return json(reply(body, answer(body)));
    }
    return json({ error: "No synthetic route" }, 404);
  });
  return {
    calls,
    delivered,
    setCapable(value: boolean) {
      capable = value;
    },
    /** Keep requests for one phase in flight until `finish`. */
    setHeld(value: boolean, phase = "concepts") {
      holdAll = value;
      holdPhase = phase;
    },
    setFailing(value: boolean) {
      failing = value;
    },
    setAnswer(value: (body: any) => any) {
      answer = value;
    },
    setReply(value: (body: any, response: any) => any) {
      editReply = value;
    },
    finish(call: any, design = harbor) {
      const waiting = pending.get(call.payload.requestId);
      if (!waiting) throw Error("No held request to finish");
      pending.delete(call.payload.requestId);
      waiting(design);
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

test("prepared runs wait for an explicit Start before gameplay and across reload", async ({
  page,
}) => {
  const relay = await designer(page);
  relay.setHeld(true);
  await open(page);
  await page.locator("#start").click();
  await expect.poll(() => relay.calls.length).toBe(1);
  await expect(page.locator("#run-design-dialog")).toBeVisible();
  await expect(page.locator("#run-design-dialog")).toHaveAttribute(
    "data-state",
    "working",
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
  relay.setHeld(false);
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
  expect(relay.calls[0].provider).toBe("claude-cli");
  expect(relay.calls[0].payload.designVersion).toBe(3);
  expect(relay.calls[0].payload.version).toBe(3);
  expect(relay.calls.map((c) => c.payload.phase)).toEqual(harborPhases);
  expect(before.design.design.version).toBe(3);
  expect(before.environments[0].entries.length).toBeGreaterThan(50);
  expect(before.scenes[0].props.length).toBeGreaterThan(0);
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

test("restart replays the saved level with no model call until a new level completes", async ({
  page,
}) => {
  const relay = await designer(page);
  await open(page);
  await page.locator("#start").click();
  await startPrepared(page);
  const before = await state(page);
  const calls = relay.calls.length;
  await pause(page);
  relay.setCapable(false);
  await page.locator("#restart-game").click();
  await expect.poll(async () => (await state(page)).id).not.toBe(before.id);
  await expect(page.locator("#run-design-dialog")).toHaveCount(0);
  const replay = await state(page);
  expect(relay.calls).toHaveLength(calls);
  expect({ ...replay, id: before.id, status: before.status }).toEqual(before);
  await flush(page);
  await page.reload();
  await expect(page.locator("#start")).toBeVisible();
  await page.locator("#start").click();
  await expect.poll(async () => (await state(page)).status).toBe("playing");
  await pause(page);

  // A cancelled generation changes nothing for later restarts.
  await page.locator("#generate-run").click();
  await expect(page.locator("#run-design-dialog")).toBeVisible();
  await page.locator("#run-design-cancel").click();
  await expect(page.locator("#run-design-dialog")).toHaveCount(0);
  expect((await state(page)).design).toEqual(before.design);
  await page.locator("#restart-game").click();
  await expect.poll(async () => (await state(page)).id).not.toBe(replay.id);
  expect((await state(page)).seed).toBe(before.seed);
  expect((await state(page)).design).toEqual(before.design);
  await page.locator("#start").click();
  await pause(page);

  // A completed generation replaces the level, and restarts then replay that.
  relay.setCapable(true);
  relay.setAnswer(() => orchard);
  await page.locator("#generate-run").click();
  await expect
    .poll(async () => (await state(page)).design?.design.title)
    .toBe(orchard.title);
  const generated = await state(page);
  expect(generated.tiles).not.toEqual(before.tiles);
  const afterGeneration = relay.calls.length;
  await page.locator("#start").click();
  await pause(page);
  await page.locator("#restart-game").click();
  await expect.poll(async () => (await state(page)).id).not.toBe(generated.id);
  const again = await state(page);
  expect(again.seed).toBe(generated.seed);
  expect(again.tiles).toEqual(generated.tiles);
  expect(again.design).toEqual(generated.design);
  expect(relay.calls).toHaveLength(afterGeneration);
});

test("an offline generation preserves the accepted run until the replacement passes review", async ({
  page,
}) => {
  const relay = await designer(page);
  await open(page);
  await page.locator("#start").click();
  await startPrepared(page);
  await pause(page);
  const before = await state(page);
  relay.setCapable(false);
  await page.locator("#generate-run").click();
  await expect(page.locator("#run-design-status")).toContainText("unavailable");
  await expect(page.locator("#run-design-procedural")).toHaveCount(0);
  expect(await state(page)).toEqual(before);
  await page.locator("#run-design-cancel").click();
  await expect(page.locator("#run-design-dialog")).toHaveCount(0);
  await expect(page.locator("#pause-menu")).toBeVisible();
  expect(await state(page)).toEqual(before);
  await page.locator("#generate-run").click();
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

test("reloading a pending design retries the same captured request rather than rerolling", async ({
  page,
}) => {
  const relay = await designer(page);
  relay.setHeld(true);
  await open(page);
  const originalId = (await state(page)).id;
  await page.locator("#start").click();
  await expect.poll(() => relay.calls.length).toBe(1);
  await flush(page);
  const first = structuredClone(relay.calls[0]);
  expect(first).not.toHaveProperty("chatCode");
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
  relay.setHeld(true, "content-batch");
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
  relay.setHeld(false);
  relay.finish(captured);
  await startPrepared(page);
  expect((await state(page)).design.design.environment).toEqual(
    harbor.environment,
  );
  expect(relay.calls).toHaveLength(harborPhases.length + 1);
});

test("generating a new level sends recent fictional designs and repairs a repeated design before replacing the run", async ({
  page,
}) => {
  const relay = await designer(page);
  relay.setAnswer((body) => (body.payload.repair ? orchard : harbor));
  await open(page);
  await page.locator("#start").click();
  await startPrepared(page);
  const before = await state(page);
  await pause(page);
  await page.locator("#generate-run").click();
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
  relay.setHeld(true, "content-review");
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
  relay.setHeld(false);
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
  relay.setHeld(true);
  await open(page);
  const before = await state(page);
  await page.locator("#start").click();
  await expect.poll(() => relay.calls.length).toBe(1);
  const cancelled = relay.calls[0];
  await page.locator("#run-design-cancel").click();
  await expect(page.locator("#run-design-dialog")).toHaveCount(0);
  relay.finish(cancelled, harbor);
  expect(await state(page)).toEqual(before);
  await page.locator("#start").click();
  await expect.poll(() => relay.calls.length).toBe(2);
  const current = relay.calls[1];
  expect(current.payload.requestId).not.toBe(cancelled.payload.requestId);
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
  relay.setHeld(true);
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

test("settled design failures keep the captured draft until Cancel or Escape without starting a run", async ({
  page,
}) => {
  const relay = await designer(page);
  relay.setFailing(true);
  await open(page);
  const before = await state(page);
  for (const dismissal of ["cancel", "escape"]) {
    await page.locator("#start").click();
    await expect(page.locator("#run-design-status")).toContainText(
      "Synthetic design request interrupted",
    );
    await expect(page.locator("#run-design-retry")).toBeEnabled();
    const call = relay.calls.at(-1)!;
    const draft = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("dead-air-run-design-draft-v1")!),
    );
    expect(draft.request.requestId).toBe(call.payload.requestId);
    expect(draft).not.toHaveProperty("chatCode");
    expect(draft).not.toHaveProperty("receipt");
    if (dismissal === "escape") await page.keyboard.press("Escape");
    else await page.locator(`#run-design-${dismissal}`).click();
    await expect(page.locator("#run-design-dialog")).toHaveCount(0);
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
  relay.setFailing(false);
  await page.locator("#run-design-retry").click();
  await startPrepared(page);
  const after = await state(page);
  expect(after.id).not.toBe(before.id);
  expect(after.design.design.title).toBe(harbor.title);
  expect(after.design.generationId).toBe(retry.payload.generationId);
  expect(relay.calls.at(-1).payload.phase).toBe("content-review");
});
