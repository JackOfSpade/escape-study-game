import { startDesignedRun } from "./helpers/designed-run";
import { expect, type Page } from "@playwright/test";

/** Every API request stays inside this synthetic browser context. There is no
 * Claude CLI, model, credential or real learner save in these fixtures. The
 * fake gateway answers `generate` and `tutor` synchronously, as the real one
 * does, so a held reply is the only way a request stays in flight. */
export async function mockClaudeStudy(
  page: Page,
  available = true,
  reason:
    | "relay-unreachable"
    | "gateway-off"
    | "cli-missing"
    | "signed-out" = "gateway-off",
) {
  const calls: any[] = [];
  const held: (() => void)[] = [];
  let up = available,
    why = reason,
    holding = false;
  const forced: any[] = [];
  let respond: (body: any) => object | Promise<object> = () => ({
    text: "What would the planner do then?",
    complete: false,
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
      return json(
        up
          ? {
              mode: "claude-cli",
              label: "Claude CLI",
              detail: "Synthetic browser fixture; no live AI",
              capabilities: [
                "generate",
                "tutor",
                "complete",
                "assess",
                "group",
              ],
            }
          : {
              mode: "development",
              label: "Claude not connected",
              reason: why,
              detail: "Synthetic browser fixture; gateway is down",
              capabilities: [],
            },
      );
    if (url.pathname !== "/api/bridge" || request.method() !== "POST")
      return json({ error: `No synthetic route for ${url.pathname}` }, 404);
    if (!up) return json({ error: "Synthetic gateway is down" }, 503);
    const body = request.postDataJSON();
    calls.push(body);
    if (body.operation === "generate") {
      const c = forced.shift() ?? body.payload.contract;
      return json({
        title: "Synthetic question",
        prompt: "Why does the leading index column matter?",
        starter: "",
        rubric: ["fixture"],
        contract: c,
        estimatedSolveSeconds: 120,
        scopeDefinitions: c.objectiveIds.map((id: string, i: number) => ({
          id: `${id}/D${c.depth}`,
          objectiveId: id,
          depth: c.depth,
          sourceScope: c.scopes[i],
          facets: [{ id: "scope", description: "Synthetic scope" }],
        })),
      });
    }
    if (body.operation === "tutor") {
      if (holding) await new Promise<void>((resolve) => held.push(resolve));
      return json(await respond(body));
    }
    return json({ error: "Unexpected synthetic operation" }, 400);
  });
  return {
    /** Every bridge request body, in the order the game sent it. */
    calls,
    tutorCalls: () => calls.filter((call) => call.operation === "tutor"),
    setAvailable(value: boolean) {
      up = value;
    },
    /** Why Claude is unavailable while the status says so. */
    setReason(value: typeof reason) {
      why = value;
    },
    /** Answer the next generate call with this contract instead of the requested one. */
    forceNextContract(contract: unknown) {
      forced.push(contract);
    },
    /** Keep tutor requests in flight until `release`. */
    hold() {
      holding = true;
    },
    release() {
      holding = false;
      for (const resolve of held.splice(0)) resolve();
    },
    /** Choose the tutor's next replies. */
    reply(fn: (body: any) => object | Promise<object>) {
      respond = fn;
    },
    /** The learner declares a gap: the first part stands, the rest are recorded. */
    gap() {
      respond = (body) => ({
        text: "Recorded: you do not know the rest. Here is your key.",
        complete: true,
        outcome: "gap",
        knowledge: {
          facets: body.payload.probe.facets.map((f: any, i: number) => ({
            id: f.id,
            status:
              body.payload.probe.facets.length > 1 && i === 0
                ? "demonstrated"
                : "gap",
          })),
          signal: { fluency: "declared-gap", note: "learner said so" },
        },
      });
    },
    /** The tutor accepts the learner's explanation and finishes the question. */
    solve(text = "Solved: the explanation covers the rubric.") {
      respond = () => ({ text, complete: true });
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
export async function openNativeQuestion(
  page: Page,
  profile: "live" | "development" = "live",
) {
  const id = await page.evaluate(async (profile) => {
    const d = (window as any).__deadAir,
      g = d.game,
      root = "/src/";
    const { ensureProblem } = await import(/* @vite-ignore */ root + "ai.ts");
    if (profile === "live") {
      // A live run starts with no pre-made practice questions.
      g.study.profile = "live";
      for (const each of Object.values<any>(g.encounters)) delete each.problem;
    } else {
      // The game has no local questions; the development world is a test fixture.
      const fixtures = "/tests/helpers/practice-questions.ts";
      const { preparePracticeRooms } = await import(
        /* @vite-ignore */ fixtures
      );
      preparePracticeRooms(g, d.roadmap);
    }
    const st = g.floors[0].stations[0],
      e = g.encounters[st.encounter];
    e.mode = "solo";
    e.owner = "human";
    Object.assign(g.survivors[0], { floor: 0, x: st.x, y: st.y });
    await ensureProblem(g, e, d.roadmap);
    await d.interact();
    return e.id as string;
  }, profile);
  await expect(page.locator("#terminal")).toBeVisible();
  await expect(page.locator("body")).toHaveClass(/terminal-open/);
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
      state: e.state,
      workspace: e.workspace,
      problem: e.problem ? JSON.stringify(e.problem) : undefined,
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
