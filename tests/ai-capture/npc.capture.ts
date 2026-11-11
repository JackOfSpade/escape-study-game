/**
 * Manual capture: run the real game against the real local relay so the relay
 * records realistic AI payloads for npc-chatter, npc-chatter-review, group,
 * materialize-work and materialize-outcome.
 *
 * Rather than guessing at keyboard/UI interactions, this driver calls the
 * game's own request entry points inside the page (`materializeObservedWork`,
 * `inspectCompletedNpcWork`, `send`) on state seeded exactly like the unit
 * suites seed it. Those functions go through the bridge client, whose requests
 * hit Vite's /api proxy and therefore the relay. NPC voice is left to the real
 * controller in main.ts: its cast is parked at study stations next to the human
 * once, and then never moved, so its relevance checks keep passing.
 *
 * Nothing under /api is mocked here (startDesignedRun's temporary design mock is
 * the one exception and restores itself). One failing step never ends the run.
 */
import { expect, test, type Page } from "@playwright/test";
import { startDesignedRun } from "../browser/helpers/designed-run";
import {
  countBridgeCalls,
  waitForBridgeIdle,
  type BridgeCounter,
} from "./support";

const MINUTES = Math.max(1, Number(process.env.CAPTURE_NPC_MINUTES ?? "15"));
const CYCLE_MS = 75_000;
const SETTLE_MS = 180_000;
const OPERATIONS = [
  "npc-chatter",
  "npc-chatter-review",
  "group",
  "materialize-work",
  "materialize-outcome",
] as const;

const GROUP_MESSAGES = [
  "The stairwell is chained from the other side and the relay queue is backing up. I can hold the corridor while someone reads the breaker panel — who has the tower key?",
  "I moved the terminal off the low shelf but the prompt still counts duplicates. Can one of you walk the plan with me and say where the boundary should sit?",
  "Two of the south doors are still latched and the generator can only take one more load. Which room do we clear first?",
  "The evaluator keeps flagging the starter I edited. If someone reads the rubric out loud I will rewrite the input handling while you watch the hall.",
  "There is a spare cable in the office behind us. I need a second pair of eyes on the recursion depth before we submit this attempt.",
];

const log = (message: string) => console.log(`[npc] ${message}`);
const reason = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 240);

/** Keep the whole cast and the human alive; remove only zombies and spawns. */
async function enterLivingRun(page: Page) {
  await page.goto("/");
  await startDesignedRun(page);
  const state = await page.evaluate(async () => {
    const d = (window as any).__deadAir,
      g = d.game,
      root = "/src/";
    const { initialStudy } = await import(
      /* @vite-ignore */ root + "curriculum.ts"
    );
    const roadmap =
      d.roadmap ?? (await (await fetch("/curriculum.json")).json());
    g.zombies = [];
    g.nextSpawn = Number.MAX_SAFE_INTEGER;
    if (g.surge) g.surge.anchor = Number.MAX_SAFE_INTEGER;
    // A live profile is what gates the relay-backed study operations.
    g.study.profile = "live";
    if (!g.study.learner) g.study = initialStudy(roadmap, "live");
    for (const actor of g.survivors) {
      actor.alive = true;
      actor.escaped = false;
      actor.vault = undefined;
      actor.path = [];
      if (actor.id === "human") {
        actor.hp = Math.max(60, actor.hp);
        continue;
      }
      actor.hp = Math.max(60, actor.hp);
      actor.stairTravel = undefined;
      actor.fleeTarget = undefined;
      if (actor.activity === "fleeing") actor.activity = "idle";
    }
    g.settings.npcVoices = true;
    g.settings.volume = Math.max(0.4, g.settings.volume ?? 0);
    g.paused = false;
    if (g.status !== "playing") g.status = "playing";
    (window as any).__npcCapture = {
      venue: undefined,
      voiceCast: [],
      workers: [],
      errors: [],
      jobs: [],
    };
    return {
      survivors: g.survivors.length,
      learner: !!g.study.learner,
      profile: g.study.profile,
    };
  });
  log(
    `run ready: ${state.survivors} survivors, live=${state.profile}, learner=${state.learner}`,
  );
}

/**
 * Pick one shared encounter near the human and park a fixed voice cast on its
 * stations, the way tests/browser/npc-voice.spec.ts parks walking NPCs in view.
 * The human stands on the first station (needed by materialize-work) and the
 * cast is never moved again, so npcChatterStillRelevant keeps holding.
 */
async function stageVoice(page: Page, cycle: number) {
  return page.evaluate(async (round) => {
    const d = (window as any).__deadAir,
      g = d.game,
      root = "/src/";
    const { eligible, initialStudy } = await import(
      /* @vite-ignore */ root + "curriculum.ts"
    );
    const { recordNpcWork } = await import(
      /* @vite-ignore */ root + "npc-cognition.ts"
    );
    const r = d.roadmap ?? (await (await fetch("/curriculum.json")).json());
    if (!g.study.learner) g.study = initialStudy(r, "live");
    g.study.profile = "live";
    const cap = ((window as any).__npcCapture ??= {
      errors: [],
      jobs: [],
      voiceCast: [],
      workers: [],
    });
    const human = g.survivors.find((a: any) => a.id === "human");
    const stationsOf = (e: any) =>
      (g.floors[e.floor]?.stations ?? []).filter(
        (s: any) => s.encounter === e.id,
      );
    const near = (p: any) => Math.hypot(p.x - human.x, p.y - human.y);
    const venues = Object.values(g.encounters)
      .filter(
        (e: any) =>
          e.state !== "consumed" &&
          e.mode === "shared" &&
          stationsOf(e).length >= 2,
      )
      .map((e: any) => ({ e, station: stationsOf(e)[0] }))
      .sort((a: any, b: any) => near(a.station) - near(b.station));
    const venue = venues.find((v: any) => v.e.id === cap.venue) ?? venues[0];
    if (!venue) return { ok: false, reason: "no shared station with 2 slots" };
    const e = venue.e,
      stations = stationsOf(e);
    e.mode = "shared";
    e.owner = undefined;
    if (e.state === "consumed") e.state = "in-progress";
    if (!e.problem) {
      const contract = eligible(r, g.study);
      const python = contract.track === "PY";
      e.problem = {
        id: `capture-${e.id}`,
        title: "Drain the relay queue without starving the plan",
        prompt:
          "The floor plan drains a shared job queue while survivors move between rooms. Write the handler that removes one job at a time and only submits a batch once every visitor has been served.",
        starter: python
          ? "def drain(queue):\n    raise NotImplementedError\n"
          : "export function drain(queue) {\n  throw new Error('not implemented');\n}\n",
        rubric: [
          "Removes exactly one job per call",
          "Never submits a partial batch",
          "Handles an empty queue",
        ],
        provenance: "study-mode",
        contract,
      };
    }
    if (!e.workspace) e.workspace = e.problem.starter || "abc";
    e.workspaceBase = e.workspace;
    e.revision = (e.revision ?? 0) + (cap.venue === e.id ? 0 : 1);
    const humanStation = stations[0];
    Object.assign(human, {
      alive: true,
      escaped: false,
      floor: e.floor,
      x: humanStation.x,
      y: humanStation.y,
      station: humanStation.id,
      hp: Math.max(60, human.hp),
    });
    const others = g.survivors.filter((a: any) => a.id !== "human");
    if (!cap.venue || cap.venue !== e.id || !cap.voiceCast.length) {
      const cast = others.slice(0, 3);
      cap.voiceCast = cast.map((a: any) => a.id);
      cap.workers = others.slice(3).map((a: any) => a.id);
      if (!cap.workers.length) cap.workers = [others[0].id];
      cast.forEach((a: any, i: number) => {
        const s = stations[Math.min(stations.length - 1, i)] ?? humanStation;
        Object.assign(a, {
          alive: true,
          escaped: false,
          floor: e.floor,
          x: s.x,
          y: s.y,
          station: s.id,
          intent: e.id,
          activity: "studying",
          thought: 12,
          milestone: 1,
        });
        a.path = [];
        a.target = undefined;
        a.navTarget = undefined;
        a.studyLoop = undefined;
        a.fleeTarget = undefined;
        delete a.stairTravel;
      });
    }
    cap.venue = e.id;
    cap.venueStation = humanStation.id;
    const worker = g.survivors.find((a: any) => a.id === cap.workers[0]);
    e.npcWork = [];
    delete e.materializations;
    let work = 0;
    if (worker) {
      Object.assign(worker, {
        alive: true,
        escaped: false,
        floor: e.floor,
        x: stations[1].x,
        y: stations[1].y,
        station: stations[1].id,
        intent: e.id,
        activity: "studying",
        thought: 12,
        milestone: 2,
      });
      worker.path = [];
      worker.target = undefined;
      worker.navTarget = undefined;
      for (let n = 0; n < 5 && !work; n++)
        work = recordNpcWork(g, e, worker, false);
    }
    g.paused = false;
    if (g.status !== "playing") g.status = "playing";
    if (g.studyWorkspace) g.studyWorkspace.enabled = false;
    g.settings.npcVoices = true;
    g.settings.volume = Math.max(0.4, g.settings.volume ?? 0);
    return {
      ok: true,
      venue: e.id as string,
      station: humanStation.id as string,
      cast: cap.voiceCast as string[],
      workers: cap.workers as string[],
      work,
      round,
    };
  }, cycle);
}

/** Seed unconsumed recorded NPC work exactly like tests/npc-materialization. */
async function seedWork(page: Page, cycle: number) {
  return page.evaluate(async (round) => {
    const d = (window as any).__deadAir,
      g = d.game,
      root = "/src/";
    const { recordNpcWork } = await import(
      /* @vite-ignore */ root + "npc-cognition.ts"
    );
    const cap = (window as any).__npcCapture,
      e = g.encounters[cap.venue];
    if (!e) return { ok: false, reason: "venue missing" };
    if (e.state === "consumed") return { ok: false, reason: "venue consumed" };
    const stations = g.floors[e.floor].stations.filter(
      (s: any) => s.encounter === e.id,
    );
    if (stations.length < 2) return { ok: false, reason: "one station only" };
    const human = g.survivors.find((a: any) => a.id === "human");
    Object.assign(human, {
      alive: true,
      escaped: false,
      floor: e.floor,
      x: stations[0].x,
      y: stations[0].y,
      station: stations[0].id,
      hp: Math.max(60, human.hp),
    });
    const id = cap.workers[round % cap.workers.length],
      a = g.survivors.find((n: any) => n.id === id),
      station = stations[1 + (round % (stations.length - 1))];
    if (!a) return { ok: false, reason: `worker ${id} missing` };
    Object.assign(a, {
      alive: true,
      escaped: false,
      floor: e.floor,
      x: station.x,
      y: station.y,
      station: station.id,
      intent: e.id,
      activity: "studying",
      thought: 12,
      milestone: 1 + (round % 4),
    });
    a.path = [];
    a.target = undefined;
    a.navTarget = undefined;
    a.studyLoop = undefined;
    a.fleeTarget = undefined;
    e.mode = "shared";
    e.npcWork = [];
    delete e.materializations;
    delete e.materializationNotice;
    delete e.problemPresentedSequence;
    let work = 0;
    for (let n = 0; n < 5 && !work; n++) work = recordNpcWork(g, e, a, false);
    return {
      ok: work > 0,
      encounter: e.id as string,
      station: station.id as string,
      actor: a.id as string,
      work,
      reason: work ? "" : "no fresh recorded work",
    };
  }, cycle);
}

/** Seed an NPC-only completion exactly like tests/npc-outcome. */
async function seedOutcome(page: Page, cycle: number) {
  return page.evaluate(async (round) => {
    const d = (window as any).__deadAir,
      g = d.game,
      root = "/src/";
    const { recordNpcWork } = await import(
      /* @vite-ignore */ root + "npc-cognition.ts"
    );
    const { complete } = await import(/* @vite-ignore */ root + "engine.ts");
    const cap = (window as any).__npcCapture;
    const ids = Object.keys(g.encounters).filter((id) => id !== cap.venue);
    const e = g.encounters[ids[(round + 1) % ids.length]] as any;
    if (!e) return { ok: false, reason: "no outcome encounter" };
    e.mode = "shared";
    e.owner = undefined;
    e.state = "in-progress";
    e.workspace = "";
    e.workspaceBase = "";
    e.humanEngaged = false;
    e.history = [];
    e.tutor = [];
    e.group = [];
    e.submissions = [];
    delete e.generation;
    delete e.problemPresentedSequence;
    delete e.simulatedOutcome;
    delete e.outcomeInspection;
    delete e.outcomeNotice;
    delete e.problem;
    e.accepted = false;
    const id = cap.workers[round % cap.workers.length],
      a = g.survivors.find((n: any) => n.id === id);
    if (!a) return { ok: false, reason: `worker ${id} missing` };
    a.alive = true;
    a.escaped = false;
    a.milestone = 1 + (round % 4);
    let work = 0;
    for (let n = 0; n < 5 && !work; n++) work = recordNpcWork(g, e, a, false);
    e.contributors = [a.id];
    if (!work) return { ok: false, reason: "no recorded work to complete" };
    complete(
      g,
      e.id,
      `npc-capture-${e.id}-${round}`,
      e.contributors,
      "Capture fixture: survivor solved this while the player was away",
    );
    return {
      ok: !!e.simulatedOutcome,
      encounter: e.id as string,
      actor: a.id as string,
      reason: e.simulatedOutcome ? "" : "no simulated outcome recorded",
    };
  }, cycle);
}

/** Kick off a real shared group exchange like tests/group-retry. */
async function seedGroup(page: Page, cycle: number) {
  return page.evaluate(async (round) => {
    const d = (window as any).__deadAir,
      g = d.game,
      root = "/src/";
    const { eligible } = await import(
      /* @vite-ignore */ root + "curriculum.ts"
    );
    const r = d.roadmap ?? (await (await fetch("/curriculum.json")).json());
    const cap = (window as any).__npcCapture;
    const ids = Object.keys(g.encounters).filter((id) => id !== cap.venue);
    const e = g.encounters[ids[(round + 2) % ids.length]] as any;
    if (!e) return { ok: false, reason: "no group encounter" };
    e.mode = "shared";
    e.owner = undefined;
    if (e.state === "consumed") e.state = "in-progress";
    if (!e.problem) {
      const contract = eligible(r, g.study);
      e.problem = {
        id: `capture-group-${e.id}`,
        title: "Split the search across two rooms",
        prompt:
          "Two survivors must clear two rooms before the door closes. Describe how the work should be divided and what each survivor reports back.",
        starter: "def split(rooms, survivors) {\n  return [];\n}\n",
        rubric: ["Both rooms covered", "Reports are actionable"],
        provenance: "study-mode",
        contract,
      };
    }
    if (!e.workspace) e.workspace = e.problem.starter || "abc";
    const participants = cap.workers
      .slice(0, 2)
      .map((id: string, i: number) => {
        const a = g.survivors.find((n: any) => n.id === id);
        if (!a) return undefined;
        Object.assign(a, {
          alive: true,
          escaped: false,
          floor: e.floor,
          intent: e.id,
          thought: 12,
          activity: "studying",
        });
        const s = (g.floors[e.floor]?.stations ?? []).find(
          (s: any) => s.encounter === e.id,
        );
        if (s) Object.assign(a, { x: s.x, y: s.y, station: s.id });
        return i;
      })
      .filter((x: any) => x !== undefined);
    if (!participants.length) return { ok: false, reason: "no responders" };
    const texts = r ? undefined : undefined;
    void texts;
    return { ok: true, encounter: e.id as string };
  }, cycle);
}

/** Real `send` on the seeded shared encounter: one group bridge request. */
async function startGroup(page: Page, cycle: number) {
  return page.evaluate(async (round) => {
    const d = (window as any).__deadAir,
      g = d.game,
      root = "/src/";
    const { send } = await import(/* @vite-ignore */ root + "ai.ts");
    const r = d.roadmap ?? (await (await fetch("/curriculum.json")).json());
    const cap = (window as any).__npcCapture;
    const ids = Object.keys(g.encounters).filter((id) => id !== cap.venue);
    const e = g.encounters[ids[(round + 2) % ids.length]] as any;
    const line =
      (window as any).__npcGroupLines?.[0] ??
      "Who takes the ledger while I read the panel?";
    const job = send(g, e, "group", line, r);
    if (!job) return { ok: false, reason: "send() declined the message" };
    cap.jobs.push(
      Promise.resolve(job).catch((error: unknown) =>
        cap.errors.push(`group: ${String(error)}`),
      ),
    );
    return { ok: true, encounter: e.id as string };
  }, cycle);
}

async function startOperation(
  page: Page,
  kind: "work" | "outcome",
  cycle: number,
) {
  return page.evaluate(
    async ({ kind, round }) => {
      const d = (window as any).__deadAir,
        g = d.game,
        root = "/src/";
      const ai = await import(/* @vite-ignore */ root + "ai.ts");
      const r = d.roadmap ?? (await (await fetch("/curriculum.json")).json());
      const cap = (window as any).__npcCapture;
      const ids = Object.keys(g.encounters).filter((id) => id !== cap.venue);
      const e =
        kind === "work"
          ? g.encounters[cap.venue]
          : g.encounters[ids[(round + 1) % ids.length]];
      if (!e) return { ok: false, reason: `${kind} encounter missing` };
      const job =
        kind === "work"
          ? ai.materializeObservedWork(g, e)
          : ai.inspectCompletedNpcWork(g, e, r);
      if (!job)
        return {
          ok: false,
          reason:
            e.materializationNotice ??
            e.outcomeNotice ??
            `${kind} guard blocked the request`,
        };
      cap.jobs.push(
        Promise.resolve(job).catch((error: unknown) =>
          cap.errors.push(`${kind}: ${String(error)}`),
        ),
      );
      return { ok: true, encounter: e.id as string };
    },
    { kind, round: cycle },
  );
}

/** Re-assert the voice gates without moving anybody (moving cancels lines). */
async function stokeVoice(page: Page) {
  return page.evaluate(() => {
    const g = (window as any).__deadAir.game;
    g.paused = false;
    if (g.status !== "playing") g.status = "playing";
    if (g.studyWorkspace) g.studyWorkspace.enabled = false;
    g.settings.npcVoices = true;
    g.settings.volume = Math.max(0.4, g.settings.volume ?? 0);
    const human = g.survivors.find((a: any) => a.id === "human");
    return {
      ok: !!human?.alive && !human?.escaped && g.study.profile === "live",
    };
  });
}

function readCounts(counter: BridgeCounter) {
  return counter.counts();
}

test("NPC chatter, group chat and NPC work reach the real relay", async ({
  page,
}) => {
  test.setTimeout(MINUTES * 60_000 + 20 * 60_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const counter = countBridgeCalls(page);
  const counts = () => readCounts(counter);
  const waitForCall = async (operation: string, before: number, ms: number) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if ((counts()[operation] ?? 0) > before) return true;
      await page.waitForTimeout(250);
    }
    return false;
  };
  const settle = async (label: string) => {
    try {
      await waitForBridgeIdle(page, counter, Math.max(15_000, SETTLE_MS));
    } catch (error) {
      log(`${label}: bridge still busy (${reason(error)})`);
    }
  };
  const runStep = async (
    name: string,
    operation: string | undefined,
    action: () => Promise<{ ok: boolean; reason?: string }>,
  ) => {
    const before = operation ? (counts()[operation] ?? 0) : 0;
    try {
      const result = await action();
      if (!result.ok) {
        log(`${name} skipped: ${result.reason ?? "guard blocked"}`);
        return;
      }
      if (operation) {
        if (!(await waitForCall(operation, before, 20_000))) {
          log(`${name}: no ${operation} request surfaced within 20s`);
          return;
        }
        log(`${name}: ${operation} +${(counts()[operation] ?? 0) - before}`);
      }
      await settle(name);
    } catch (error) {
      log(`${name} failed: ${reason(error)}`);
    }
  };

  await enterLivingRun(page);
  await page.evaluate((lines: string[]) => {
    (window as any).__npcGroupLines = lines;
  }, GROUP_MESSAGES);
  let cycle = 0;
  try {
    const staged = await stageVoice(page, cycle);
    log(
      staged.ok
        ? `voice cast parked at ${staged.station} on ${staged.venue}`
        : `voice stage skipped: ${staged.reason}`,
    );
  } catch (error) {
    log(`voice stage failed: ${reason(error)}`);
  }
  const deadline = Date.now() + MINUTES * 60_000;
  while (Date.now() < deadline) {
    const started = Date.now();
    try {
      await stokeVoice(page);
    } catch (error) {
      log(`voice gates skipped: ${reason(error)}`);
    }
    await runStep("materialize-work", "materialize-work", async () => {
      const seeded = await seedWork(page, cycle);
      return seeded.ok ? startOperation(page, "work", cycle) : seeded;
    });
    await runStep("materialize-outcome", "materialize-outcome", async () => {
      const seeded = await seedOutcome(page, cycle);
      return seeded.ok ? startOperation(page, "outcome", cycle) : seeded;
    });
    await runStep("group", "group", async () => {
      const seeded = await seedGroup(page, cycle);
      return seeded.ok ? startGroup(page, cycle) : seeded;
    });
    const voiceBefore =
      (counts()["npc-chatter"] ?? 0) + (counts()["npc-chatter-review"] ?? 0);
    const dwell = Math.min(
      CYCLE_MS - (Date.now() - started),
      deadline - Date.now(),
    );
    if (dwell > 0) await page.waitForTimeout(dwell);
    const voiceAfter =
      (counts()["npc-chatter"] ?? 0) + (counts()["npc-chatter-review"] ?? 0);
    log(
      voiceAfter > voiceBefore
        ? `cycle ${cycle}: voice lines +${voiceAfter - voiceBefore}`
        : `cycle ${cycle}: no new voice lines while dwelling`,
    );
    log(`cycle ${cycle}: per-operation counts ${JSON.stringify(counts())}`);
    cycle++;
  }
  counter.stop();
  const final = counts();
  console.log(`[npc] bridge calls ${JSON.stringify(final)}`);
  for (const operation of OPERATIONS) {
    console.log(`[npc] ${operation}: ${final[operation] ?? 0}`);
    if (!final[operation])
      log(`warning: no ${operation} call reached the relay this run`);
  }
  const errors = await page
    .evaluate(() => (window as any).__npcCapture?.errors ?? [])
    .catch(() => []);
  if (errors.length) log(`in-page job errors ${JSON.stringify(errors)}`);
  expect(pageErrors).toEqual([]);
});
