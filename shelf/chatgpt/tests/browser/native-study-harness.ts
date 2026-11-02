import { startDesignedRun } from "./helpers/designed-run";
import { expect, type Page } from "@playwright/test";

/** Every API request stays inside this synthetic browser context. There is no
 * live connector, model, credential or real learner save in these fixtures. */
export async function mockNativeStudy(page: Page, capable = true) {
  const calls: any[] = [];
  const jobs = new Map<string, any>();
  const results = new Map<string, any>();
  let direct = capable;
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
        mode: "chatgpt-handoff",
        label: "Synthetic native study",
        detail: "Synthetic browser fixture; no live AI",
        capabilities: direct
          ? ["tutor", "direct-study", "topic-assessments"]
          : ["tutor"],
      });
    if (url.pathname === "/api/bridge" && request.method() === "POST") {
      const body = request.postDataJSON();
      calls.push(body);
      if (
        body.operation !== "tutor" ||
        body.payload?.mode !== "terminal-direct"
      )
        return json({ error: "Unexpected synthetic bridge operation" }, 400);
      const id = body.payload.requestId;
      jobs.set(id, body.payload);
      return json({ handoff: { id, hash: `synthetic-${id}` } }, 202);
    }
    if (url.pathname === "/api/bridge/result") {
      const id = url.searchParams.get("id")!;
      return results.has(id)
        ? json(results.get(id))
        : json({ handoff: { id, status: "working" } }, 202);
    }
    if (url.pathname === "/api/handoff/status")
      return json({
        enabled: true,
        queued: 0,
        working: jobs.size,
        done: results.size,
        public: { terminalRelay: { activeSessions: 1 } },
        recent: [...jobs.keys()].map((id) => ({
          id,
          status: results.has(id) ? "done" : "working",
        })),
      });
    return json({ error: `No synthetic route for ${url.pathname}` }, 404);
  });
  return {
    calls,
    jobs,
    setCapable(value: boolean) {
      direct = value;
    },
    finish(
      id: string,
      outcome: "solved" | "gap" = "solved",
      extra: object = {},
    ) {
      const payload = jobs.get(id);
      if (!payload) throw Error(`No synthetic question ${id}`);
      const facets = payload.probe.facets;
      if (!facets.length) throw Error("Question has no scoped facets");
      const text =
        outcome === "gap"
          ? "That gap is recorded for later study."
          : "The named parts are established.";
      results.set(id, {
        text,
        complete: true,
        outcome,
        questionFingerprint: payload.questionFingerprint,
        transcript: [
          { role: "assistant", text: payload.problem.prompt },
          {
            role: "user",
            text:
              outcome === "gap"
                ? "I do not know this part yet."
                : "Here is my complete reasoning for the scoped question.",
          },
          { role: "assistant", text },
        ],
        knowledge: {
          facets: (outcome === "gap" ? facets.slice(0, 1) : facets).map(
            (f: any) => ({
              id: f.id,
              status: outcome === "gap" ? "gap" : "demonstrated",
            }),
          ),
        },
        topicAssessments: (payload.topicAssessmentContext?.topicIds ?? []).map(
          (topicId: string) => ({
            topicId,
            text: `Synthetic assessment for ${topicId}: the learner has demonstrated the question's named skills.`,
          }),
        ),
        ...extra,
      });
    },
  };
}

export async function enterNativeGame(page: Page) {
  await page.goto("/");
  await startDesignedRun(page);
  await page.evaluate(() => {
    const g = (window as any).__deadAir.game;
    g.zombies = [];
    g.nextSpawn = Number.MAX_SAFE_INTEGER;
    g.surge.anchor = Number.MAX_SAFE_INTEGER;
    g.survivors = g.survivors.slice(0, 1);
  });
}

/** Existing saved work is a migration fixture, not a second answer UI. */
export async function seedLegacyDraft(page: Page, text: string) {
  return page.evaluate((draft) => {
    const g = (window as any).__deadAir.game;
    const e = g.encounters[g.floors[0].stations[0].encounter];
    e.workspace = draft;
    e.revision++;
    e.history.push({
      seq: ++g.seq,
      author: "human",
      kind: "edit",
      text: draft,
      at: g.time,
      revision: e.revision,
    });
    return e.id as string;
  }, text);
}

/** Open the real E interaction at an actual generated physical station. */
export async function openNativeQuestion(page: Page) {
  const id = await page.evaluate(async () => {
    const d = (window as any).__deadAir,
      g = d.game,
      root = "/src/";
    const { ensureProblem } = await import(/* @vite-ignore */ root + "ai.ts");
    const st = g.floors[0].stations[0],
      e = g.encounters[st.encounter];
    e.mode = "solo";
    e.owner = "human";
    Object.assign(g.survivors[0], { floor: 0, x: st.x, y: st.y });
    await ensureProblem(g, e, d.roadmap);
    await d.interact();
    return e.id as string;
  });
  await expect(page.locator("#terminal")).toBeHidden();
  await expect(page.locator("body")).not.toHaveClass(/terminal-open/);
  return id;
}

export const nativeState = (page: Page, id: string) =>
  page.evaluate((encounter) => {
    const g = (window as any).__deadAir.game,
      e = g.encounters[encounter],
      h = g.survivors[0];
    return {
      status: g.status,
      time: g.time,
      endedAt: g.endedAt,
      paused: !!g.paused,
      keys: h.keys ?? 0,
      alive: h.alive,
      x: h.x,
      y: h.y,
      station: h.station,
      session: e.directStudy,
      state: e.state,
      accepted: e.accepted,
      submissions: e.submissions.length,
      tutor: e.tutor,
      gaps: g.study.knowledgeGaps ?? [],
    };
  }, id);

export async function killHumanInStep(page: Page) {
  await page.evaluate(async () => {
    const g = (window as any).__deadAir.game,
      h = g.survivors[0],
      root = "/src/";
    const { step } = await import(/* @vite-ignore */ root + "engine.ts");
    h.hp = 1;
    g.zombies.push({
      id: "synthetic-combat-killer",
      floor: h.floor,
      x: h.x + 0.55,
      y: h.y,
      hp: 60,
      path: [],
      repath: 0,
      cooldown: 0,
      memory: 0,
      stagger: 0,
      origin: "outside",
    });
    step(g, 0.1);
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).__deadAir.game.status))
    .toBe("dead");
}

/** Flush the UI's already-requested persistence before testing page reload. */
export async function flushNativeSave(page: Page) {
  await page.evaluate(async () => {
    const root = "/src/";
    const { flushSaves } = await import(
      /* @vite-ignore */ root + "persistence.ts"
    );
    await flushSaves();
  });
}
