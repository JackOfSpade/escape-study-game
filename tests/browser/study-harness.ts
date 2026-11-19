import { expect, type Page } from "@playwright/test";

const HOSTILE = [
  '<img src=x onerror="window.__pwned=1">',
  "<script>window.__pwned=1</script>",
];
/** For fields too short to hold the longer ones. */
const HOSTILE_SHORT = "<svg onload=window.__pwned=1>";

/** A lesson that uses every block kind. With `hostile`, every free-text field
 * is markup that would run if anything drew it as HTML. */
export function lessonFixture(hostile = false) {
  let at = 0;
  const t = (plain: string) => (hostile ? HOSTILE[at++ % 2] : plain);
  const short = (plain: string) => (hostile ? HOSTILE_SHORT : plain);
  const code = hostile
    ? `${HOSTILE[0]}\n${HOSTILE[1]}\n${HOSTILE[0]}`
    : "total = 0\nfor n in nums:\n    total += n";
  return {
    v: 1,
    title: hostile ? HOSTILE[0] : "How a running total works",
    summary: t("A short tour of one idea."),
    minutes: 5,
    sections: [
      {
        id: "idea",
        title: t("The core idea"),
        blocks: [
          { kind: "prose", text: t("Add each number to a **running total**.") },
          {
            kind: "callout",
            tone: "key-idea",
            text: t("The total starts at zero."),
          },
          {
            kind: "code",
            language: "python",
            code,
            caption: t("A loop that sums a list."),
            highlight: [1],
          },
        ],
      },
      {
        id: "picture",
        title: t("A picture"),
        blocks: [
          {
            kind: "diagram",
            alt: t("Three boxes in a row joined by arrows."),
            caption: t("Data flows left to right."),
            nodes: [
              { id: "input", label: t("Numbers"), col: 0, row: 0 },
              { id: "loop", label: t("Loop"), col: 1, row: 0, tone: "accent" },
              { id: "total", label: t("Total"), col: 2, row: 0, tone: "good" },
            ],
            edges: [
              { from: "input", to: "loop", label: short("each") },
              { from: "loop", to: "total" },
            ],
          },
          {
            kind: "table",
            caption: t("Inputs and totals."),
            columns: [t("Input"), t("Total")],
            rows: [
              [t("1, 2"), t("3")],
              [t("4, 5"), t("9")],
            ],
          },
        ],
      },
      {
        id: "walkthrough",
        title: t("Walk through it"),
        blocks: [
          {
            kind: "steps",
            alt: t("The loop adds three numbers one by one."),
            caption: t("Stepping through the loop."),
            code,
            frames: [
              {
                caption: t("Start with the total at zero."),
                line: 1,
                vars: [{ name: "total", value: "0" }],
                cells: ["1", "2", "3"],
              },
              {
                caption: t("Add the first number."),
                line: 3,
                vars: [{ name: "total", value: "1" }],
                cells: ["1", "2", "3"],
                pointers: [{ name: "n", index: 0 }],
                marked: [0],
              },
              {
                caption: t("Add the second number."),
                line: 3,
                vars: [{ name: "total", value: "3" }],
                cells: ["1", "2", "3"],
                pointers: [{ name: "n", index: 1 }],
                marked: [0, 1],
              },
            ],
          },
        ],
      },
      {
        id: "check",
        title: t("Check yourself"),
        blocks: [
          {
            kind: "predict",
            prompt: t("What is the total after two numbers?"),
            options: [
              { id: "one", text: t("1") },
              { id: "three", text: t("3") },
              { id: "six", text: t("6") },
            ],
            correctId: "three",
            explanation: t("One plus two is three."),
          },
          {
            kind: "recall",
            prompt: t("Explain a running total in your own words."),
            exemplar: t("It is a value that grows as each item is added."),
          },
        ],
      },
    ],
  };
}

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
    holding = false,
    holdingLessons = false,
    capabilities = ["generate", "tutor", "assess", "lesson", "lesson-chat"];
  const heldLessons: (() => void)[] = [];
  const failures = { lesson: [] as string[], "lesson-chat": [] as string[] };
  let lessonReply: (body: any) => object | Promise<object> = (body) => ({
    requestId: body.payload.requestId,
    gapId: body.payload.gapId,
    lesson: lessonFixture(),
  });
  let chatReply: (body: any) => object | Promise<object> = () => ({
    text: "Think of it as a **counter** that only goes up.",
    section: "idea",
  });
  const forced: any[] = [];
  let questionFields: object = {};
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
              capabilities,
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
        ...questionFields,
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
    if (body.operation === "lesson") {
      if (holdingLessons)
        await new Promise<void>((resolve) => heldLessons.push(resolve));
      const failure = failures.lesson.shift();
      if (failure !== undefined) return json({ error: failure }, 500);
      return json(await lessonReply(body));
    }
    if (body.operation === "lesson-chat") {
      const failure = failures["lesson-chat"].shift();
      if (failure !== undefined) return json({ error: failure }, 500);
      const answer = await chatReply(body);
      // Streamed as the bridge does: the text so far, then the answer.
      if (body.stream)
        return route.fulfill({
          status: 200,
          contentType: "application/x-ndjson",
          body: `${JSON.stringify({ text: String((answer as any).text ?? "").slice(0, 12) })}\n${JSON.stringify({ answer })}\n`,
        });
      return json(answer);
    }
    return json({ error: "Unexpected synthetic operation" }, 400);
  });
  return {
    /** Every bridge request body, in the order the game sent it. */
    calls,
    tutorCalls: () => calls.filter((call) => call.operation === "tutor"),
    /** The question requests, in order: a practice question is the one whose
     * payload contract has `practice`. */
    generateCalls: () => calls.filter((call) => call.operation === "generate"),
    lessonCalls: () => calls.filter((call) => call.operation === "lesson"),
    chatCalls: () => calls.filter((call) => call.operation === "lesson-chat"),
    /** What /api/status lists. The default includes the lesson operations; an
     * older bridge lists only generate, tutor and assess. */
    setCapabilities(list: string[]) {
      capabilities = list;
    },
    /** Choose the lesson the next lesson requests are answered with. */
    replyLesson(fn: (body: any) => object | Promise<object>) {
      lessonReply = fn;
    },
    /** Choose the lesson tutor's next replies: {text, section?}. */
    replyChat(fn: (body: any) => object | Promise<object>) {
      chatReply = fn;
    },
    /** Fail the next lesson or lesson-chat requests with this message. */
    fail(operation: "lesson" | "lesson-chat", message: string, times = 1) {
      for (let i = 0; i < times; i++) failures[operation].push(message);
    },
    /** Keep lesson requests in flight until `releaseLessons`. */
    holdLessons() {
      holdingLessons = true;
    },
    releaseLessons() {
      holdingLessons = false;
      for (const resolve of heldLessons.splice(0)) resolve();
    },
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
    /** Fields the next generated questions carry, over the fixture's own. */
    question(fields: object) {
      questionFields = fields;
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

/** Open the app and ask for the next question through the workspace's own
 * button. With the synthetic relay the question arrives at once; the returned
 * id is the encounter the learner now has open. */
export async function openStudyQuestion(page: Page) {
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__deadAir);
  await page.locator("#study-next").click();
  await expect(page.locator("#terminal")).toBeVisible();
  await expect(page.locator("#problem-title")).not.toHaveText("Connecting…");
  return page.evaluate(
    () => (window as any).__deadAir.game.lastStudyEncounter as string,
  );
}

/** The saved facts about one question that specs assert on. */
export const studyState = (page: Page, id: string) =>
  page.evaluate((encounter) => {
    const g = (window as any).__deadAir.game,
      e = g.encounters[encounter];
    return {
      state: e.state,
      workspace: e.workspace,
      problem: e.problem ? JSON.stringify(e.problem) : undefined,
      accepted: e.accepted,
      submissions: e.submissions.length,
      tutor: e.tutor,
      gaps: g.study.knowledgeGaps ?? [],
    };
  }, id);

/** Flush the UI's already-requested persistence before testing page reload. */
export async function flushStudySave(page: Page) {
  await page.evaluate(async () => {
    const root = "/src/";
    const { flushSaves } = await import(
      /* @vite-ignore */ root + "persistence.ts"
    );
    await flushSaves();
  });
}

/** Finish the open question with every facet declared a gap, so the question
 * records a knowledge gap that a lesson can teach. */
export async function finishWithGap(
  page: Page,
  study: Awaited<ReturnType<typeof mockClaudeStudy>>,
) {
  await page.route("**/api/bridge", async (route) => {
    if (route.request().postDataJSON()?.operation !== "assess")
      return route.fallback();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ visitOutcome: "unresolved", findings: [] }),
    });
  });
  const id = await openStudyQuestion(page);
  study.reply((body) => ({
    help: { nudges: [], hints: [], gives: [], offers: [] },
    text: "Recorded as a study target.",
    complete: true,
    outcome: "gap",
    knowledge: {
      facets: body.payload.probe.facets.map((f: any) => ({
        id: f.id,
        status: "gap",
      })),
      signal: { fluency: "declared-gap" },
    },
    topicAssessments: (body.payload.topicAssessmentContext?.topicIds ?? []).map(
      (topicId: string) => ({ topicId, text: "Conceded." }),
    ),
  }));
  await page.locator("#chat-input").fill("No idea.");
  await page.locator("#chat-input").press("Enter");
  await expect(page.locator("#messages .message-complete")).toContainText(
    "Question complete",
  );
  return id;
}
