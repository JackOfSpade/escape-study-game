import { expect, test } from "@playwright/test";

// Every furniture kind gets its own recognisable sprite, floors are textured,
// and the cached art keeps the per-frame render cost low.
test("office art: every furniture kind, textured floors and bounded render cost", async ({
  page,
}) => {
  await page.goto("/lab.html");
  const result = await page.evaluate(async () => {
    const { render } = await import("/src/render.ts" as string),
      { TestRunner } = await import("/src/gametest/runner.ts" as string),
      { emptyScenario } = await import("/src/gametest/schema.ts" as string),
      { FURNITURE } = await import("/src/model.ts" as string);
    const roadmap = await (await fetch("/curriculum.json")).json();
    const s = emptyScenario();
    const kinds = Object.keys(FURNITURE).filter(
      (k) => k !== "door" && k !== "gate",
    );
    s.entities = [
      { id: "human", kind: "player", x: 13, y: 12 },
      ...kinds.map((kind, i) => ({
        id: `art-${kind}`,
        kind,
        x: 3 + (i % 8) * 2.6,
        y: 7 + Math.floor(i / 8) * 3,
      })),
    ];
    const runner = new TestRunner(s, roadmap),
      g = runner.game;
    g.settings.view = "top-down";
    g.floors[0].dark = 0;
    const c = document.createElement("canvas");
    c.id = "art";
    c.style.width = "1000px";
    c.style.height = "800px";
    document.body.replaceChildren(c);
    render(c, g);
    const times: number[] = [];
    for (let i = 0; i < 30; i++) {
      const t = performance.now();
      render(c, g);
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const ctx = c.getContext("2d")!,
      rect = c.getBoundingClientRect(),
      dpr = c.width / rect.width,
      scale = Math.min(rect.width, rect.height) / 24,
      ox = rect.width / 2 - 13 * scale,
      oy = rect.height / 2 - 12 * scale;
    const sample = (x: number, y: number) =>
      Array.from(
        ctx.getImageData(
          Math.floor((ox + x * scale) * dpr),
          Math.floor((oy + y * scale) * dpr),
          1,
          1,
        ).data,
      ).join(",");
    // Floor texture varies between neighbouring carpet tiles.
    const floor = new Set(
      [0, 0.3, 0.6, 0.9].map((d) => sample(4.1 + d, 15.1 + d)),
    );
    const sprites = new Set(
      kinds.map((_, i) => {
        const x = 3 + (i % 8) * 2.6,
          y = 7 + Math.floor(i / 8) * 3;
        return [-0.2, 0, 0.2].map((d) => sample(x + d, y + d * 0.5)).join("|");
      }),
    );
    return {
      kinds: kinds.length,
      distinctSprites: sprites.size,
      floorShades: floor.size,
      median: times[15],
    };
  });
  await page
    .locator("#art")
    .screenshot({ path: "test-results/office-art.png" });
  expect(result.distinctSprites).toBe(result.kinds);
  expect(result.floorShades).toBeGreaterThan(1);
  // Diagnostic bound only; a real frame budget is checked in frame-performance.spec.
  expect(result.median).toBeLessThan(12);
});

test("office art: a fresh floor is furnished as an office with typed rooms", async ({
  page,
}) => {
  await page.goto("/lab.html");
  const result = await page.evaluate(async () => {
    const { render } = await import("/src/render.ts" as string),
      { createPlayableGame } = await import("/src/world.ts" as string);
    const roadmap = await (await fetch("/curriculum.json")).json();
    const g = createPlayableGame(42, roadmap);
    g.settings.view = "top-down";
    g.status = "playing";
    const f = g.floors[1];
    f.dark = 0;
    // The break room on this seed and floor sits between y 11 and 14.
    Object.assign(g.survivors[0], { floor: 1, x: 21, y: 12.5 });
    const c = document.createElement("canvas");
    c.id = "art";
    c.style.width = "1300px";
    c.style.height = "560px";
    document.body.replaceChildren(c);
    // Widen sight for the screenshot only; gameplay sight is unchanged.
    const { VISION } = await import("/src/visibility.ts" as string);
    const lit = VISION.lit;
    VISION.lit = 40;
    render(c, g);
    VISION.lit = lit;
    return {
      types: f.office.map((z: { type: string }) => z.type),
      kinds: f.furniture
        .filter((o: { field?: unknown }) => !o.field)
        .map((o: { kind: string }) => o.kind),
    };
  });
  await page
    .locator("#art")
    .screenshot({ path: "test-results/office-floor.png" });
  expect(result.types).toContain("cubicles");
  expect(result.kinds.length).toBeGreaterThan(30);
  for (const kind of ["partition", "coffeeMaker", "cafeTable", "chair"])
    expect(result.kinds).toContain(kind);
});
