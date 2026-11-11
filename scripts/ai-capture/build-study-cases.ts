#!/usr/bin/env node
/**
 * Build realistic ladder cases for the study calls `generate`, `tutor` and
 * `assess` without network access. The game's real payload builders run
 * against a stub bridge that records each `(operation, payload)` and answers
 * just enough for the flow to proceed.
 *
 * tsx scripts/ai-capture/build-study-cases.ts --out <dir> [--per-op N]
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assess, checkBridge, edit, ensureProblem, send } from "../../src/ai";
import { eligible, initialStudy } from "../../src/curriculum";
import { scopeKey, type ScopeDefinition } from "../../src/learning-model";
import type { Contract, Game, Problem, Roadmap, Track } from "../../src/model";
import { createPlayableGame } from "../../src/world";

export type StudyOperation = "generate" | "tutor" | "assess";
export type StudyCase = {
  id: string;
  operation: StudyOperation;
  payload: Record<string, unknown>;
};
export type StudyCaseBook = Record<StudyOperation, StudyCase[]>;
export const STUDY_OPERATIONS: StudyOperation[] = [
  "generate",
  "tutor",
  "assess",
];

type Scenario = {
  track: Track;
  topic: string;
  title: string;
  prompt: string;
  starter: string;
  rubric: string[];
  facets: [string, string];
  focus: string;
  misconception: string;
  correct: string;
};

const SCENARIOS: Scenario[] = [
  {
    track: "PY",
    topic: "T05",
    title: "Window totals in a solar inverter feed",
    prompt:
      "An inverter reports one integer of watts each second: [412, 418, 399, 421, 430, 405, 398]. Write `window_totals(readings, size)` returning the total for every consecutive window of `size` readings. Report a total only once the window is full, and do not recompute a window from scratch when one reading enters and one leaves.",
    starter:
      "def window_totals(readings: list[int], size: int) -> list[int]:\n    totals = []\n    running = 0\n    # update running as the window slides\n    return totals\n",
    rubric: [
      "States the window invariant: running total of the last `size` readings.",
      "Updates the total by adding the entering reading and removing the leaving one.",
      "Reports only after the first full window; handles an empty or oversized input.",
    ],
    facets: [
      "Window state and the moment a total is eligible to be reported.",
      "Boundary: size one, size equal to the input length, and a zero-size window.",
    ],
    focus:
      "keep one running total and add the entering reading while removing the leaving one",
    misconception:
      "A window total has to be recomputed from the slice each time, so the inner loop is unavoidable. As long as it is readable, O(n * size) is fine.",
    correct:
      "The running total holds sum(readings[i-size:i]). On each step I add readings[i] and subtract readings[i-size]; the reported total is valid only when i >= size - 1.",
  },
  {
    track: "PY",
    topic: "T11",
    title: "Five busiest endpoints from a live request log",
    prompt:
      "A request log arrives one `(endpoint, count)` pair at a time and may contain thousands of endpoints. Write `top_endpoints(log, k)` returning the `k` busiest endpoints in descending order. Keep only what retention requires; sorting the full set at every update is not acceptable.",
    starter:
      "def top_endpoints(log: list[tuple[str, int]], k: int) -> list[tuple[str, int]]:\n    # e.g. a min-heap of size k, keyed by count\n    return []\n",
    rubric: [
      "Uses a bounded priority structure of size k rather than sorting the full log per update.",
      "Explains when an incoming count can displace the current worst kept endpoint.",
      "Handles k larger than the number of endpoints and duplicate endpoints.",
    ],
    facets: [
      "Which incremental priority operation justifies a heap rather than one final sort.",
      "Cost boundary: k much smaller than n, k close to n, and ties at the cutoff.",
    ],
    focus:
      "keep a min-heap of at most k endpoints so the weakest kept entry is immediately replaceable",
    misconception:
      "A heap is only useful when inserting everything. Here I can just append each endpoint and call sorted() at the end; that is simpler and always O(n log n).",
    correct:
      "Maintaining a size-k min-heap means each new endpoint costs O(log k) and the root is exactly the entry to evict. A final sort of k entries gives descending output, so total work stays O(n log k + k log k).",
  },
  {
    track: "PY",
    topic: "T02",
    title: "Longest clean run in a machine log",
    prompt:
      'A status log is a list of strings such as ["ok", "ok", "fault", "ok", "warn", "ok", "ok", "ok"]. Write `longest_clean_run(log)` returning the length of the longest run of "ok" entries. A single pass is enough; explain what state you keep and when it resets.',
    starter:
      "def longest_clean_run(log: list[str]) -> int:\n    best = 0\n    current = 0\n    return best\n",
    rubric: [
      "Keeps only the current run length and the best seen so far.",
      "Resets the current run on any non-ok entry without losing the best value.",
      "Handles an all-fault log, an all-ok log, and an empty log.",
    ],
    facets: [
      "Minimal state for a one-pass traversal: current run and best run.",
      "Reset boundary: the entry that breaks a run and the end of the input.",
    ],
    focus:
      "track the current clean run and reset it whenever a non-ok entry appears",
    misconception:
      "Splitting the log on every fault and taking the longest piece is cleaner, and the extra list copies do not matter.",
    correct:
      "One pass keeps `current` and `best`. An ok entry increments current and updates best, anything else sets current back to zero, so memory is constant and every entry is read once.",
  },
  {
    track: "PY",
    topic: "T14",
    title: "Meeting-room allocation with a greedy invariant",
    prompt:
      "Given meeting intervals `(start, end)` for one room and a room capacity, write `assign_rooms(intervals)` returning the room number for each meeting. Meetings that overlap must not share a room. State the greedy choice and the invariant that proves the assignment stays valid.",
    starter:
      "def assign_rooms(intervals: list[tuple[int, int]]) -> list[int]:\n    # sort by start; free the rooms whose meetings have ended\n    return []\n",
    rubric: [
      "Names the greedy choice (earliest start, free any finished room).",
      "States the invariant that each occupied room's end time is after the next start.",
      "Shows why reusing a random free room cannot invalidate the assignment.",
    ],
    facets: [
      "The candidate greedy choice and the invariant it preserves.",
      "Exchange boundary: an interval that touches the previous end time.",
    ],
    focus:
      "sort by start time and reuse a room only after its previous meeting has ended",
    misconception:
      "Greedy allocation is unsafe here, so the only correct approach is to search all room permutations and take the first valid one.",
    correct:
      "Sorting by start means every already-assigned meeting starts no later than the current one, so any room whose end is <= current start is genuinely free. The invariant is that each room's stored end is the latest end assigned to it.",
  },
  {
    track: "PY",
    topic: "T08",
    title: "Ranking submissions without sorting the whole set",
    prompt:
      "You receive 100k submissions with a numeric score. Write `median_score(submissions)` without sorting the full list, then explain what structure makes the median cheap to maintain. Include how you would handle an even-length input.",
    starter:
      "def median_score(scores: list[int]) -> float:\n    # two heaps: lower half and upper half\n    return 0.0\n",
    rubric: [
      "Chooses a structure that exposes the middle value without a full sort.",
      "Keeps the two halves balanced and the lower half as a max-heap.",
      "Handles even length as the average of the two middle values.",
    ],
    facets: [
      "When partial ordering exposes enough structure to avoid a full sort.",
      "Balance boundary: odd and even counts, duplicate scores, one element.",
    ],
    focus:
      "keep the lower half in a max-heap and the upper half in a min-heap and rebalance after every insert",
    misconception:
      "Sorting is the only way to find a median, so I would sort all 100k scores and index the middle; any other approach is premature optimisation.",
    correct:
      "Two heaps keep the lower half and upper half separated; the median is one root or the average of both roots. Rebalancing keeps their sizes within one, so insertion is O(log n) and lookup O(1).",
  },
  {
    track: "PY",
    topic: "T01",
    title: "Inventory ledger representation",
    prompt:
      'A warehouse needs to record stock changes as `(sku, delta)` events and answer "how many of this SKU are on hand?" thousands of times per minute. Choose a Python representation for the ledger and justify the access, update, ordering and memory properties you rely on.',
    starter:
      "class Inventory:\n    def __init__(self) -> None:\n        self._stock: dict[str, int] = {}\n\n    def apply(self, sku: str, delta: int) -> None:\n        ...\n",
    rubric: [
      "Chooses a representation whose lookup and update costs fit the access pattern.",
      "Justifies ordering or explicitly states that ordering is not required.",
      "Names the memory trade-off of the chosen structure.",
    ],
    facets: [
      "Representation choice tied to required access, update, ordering and memory.",
      "Boundary: unknown SKU, negative resulting stock, and many small updates.",
    ],
    focus:
      "use a dict keyed by SKU so each update and on-hand lookup is average O(1)",
    misconception:
      "A list of (sku, delta) events is always better because it preserves history and Python lists are faster than dicts.",
    correct:
      "A dict of SKU to on-hand count gives average O(1) update and lookup and keeps one integer per SKU. Ordering is not part of the query, so a list of events would add O(n) scans and unbounded memory.",
  },
  {
    track: "PE",
    topic: "T01",
    title: "Turn a vague onboarding request into a testable outcome",
    prompt:
      'A stakeholder writes: "Make onboarding faster; new users keep dropping off." Restate the request as a user outcome, constraints, explicit assumptions and one success condition that engineering could verify.',
    starter: "Outcome:\nConstraints:\nAssumptions:\nSuccess condition:\n",
    rubric: [
      "States the user outcome without prescribing a solution.",
      "Separates constraints from assumptions and names the metric owner.",
      "Gives a verifiable success condition with a baseline and target.",
    ],
    facets: [
      "Restating an ambiguous request as outcome, constraints, assumptions and success.",
      "Boundary: an untestable success condition and an unstated constraint.",
    ],
    focus:
      "write down the user outcome, the constraints, the assumptions and one verifiable success condition",
    misconception:
      "The fastest path is to rebuild the signup form with fewer fields, because fewer fields always mean less drop-off.",
    correct:
      "The outcome is that a new user reaches first value without avoidable delay. The success condition is verified by measuring completion of the first-value step within seven days, against the current baseline, while keeping the completion rate as a guardrail.",
  },
  {
    track: "PE",
    topic: "T11",
    title: "A shared invoice link returns 403",
    prompt:
      "A support agent reports that a customer cannot open a shared invoice link and sees 403. Using the feature flow, distinguish authentication, session state, authorization, tenant membership and commercial entitlement, and say what evidence you would gather first.",
    starter: "Symptom:\nLikely layer:\nEvidence to collect:\nNext check:\n",
    rubric: [
      "Separates identity, session, permission, tenant and entitlement concerns.",
      "Names the first diagnostic evidence for each layer.",
      "Avoids treating a 403 as proof of a missing session.",
    ],
    facets: [
      "Distinguishing authn, session, authz, tenant membership and entitlement.",
      "Boundary: a valid session that belongs to another tenant but has an entitled plan.",
    ],
    focus:
      "check identity and session first, then authorization, tenant membership and the invoice entitlement in that order",
    misconception:
      "A 403 always means the user's session expired, so the first fix is to make them sign in again.",
    correct:
      "Authentication asks who they are, the session is their current authenticated context, authorization is whether this role may open an invoice, tenant membership decides which organization's data is in scope, and entitlement decides whether the plan includes shared links.",
  },
  {
    track: "PE",
    topic: "T08",
    title: "Replace a div-based dialog with semantic markup",
    prompt:
      'A settings drawer is currently `<div role="dialog"><div class="title">Plan</div><button>Close</button><input placeholder="Seat count"></div>`. Choose semantic HTML, accessible names and relationships before adding ARIA, and say what changes for keyboard and screen-reader users.',
    starter: "<!-- markup sketch -->\n<dialog>\n  ...\n</dialog>\n",
    rubric: [
      "Uses native elements for the dialog, title and close control.",
      "Gives every control an accessible name and associates the title.",
      "Keeps keyboard focus and return-focus behaviour explicit.",
    ],
    facets: [
      "Semantic element and accessible-name choices before ARIA.",
      "Boundary: a dialog with no visible title and a disabled primary action.",
    ],
    focus:
      "use the native dialog element, a labelled title and a button with an accessible name before reaching for ARIA",
    misconception:
      "Adding role=dialog and aria-modal=true to the existing div is enough; native elements do not change screen-reader behaviour.",
    correct:
      "Using `<dialog>` gives modal semantics and focus management for free. A labelled heading names it, a `<button>` gets its name from its text, and the seat input needs a `<label>` so the control is announced with its purpose.",
  },
  {
    track: "PE",
    topic: "T05",
    title: "Split a settings page into owned components",
    prompt:
      "A settings page contains plan details, seat management, an invoice list and a danger zone. Decompose it into components whose ownership follows behaviour and data responsibilities rather than visual nesting, and name the data each component owns.",
    starter: "Page\n  PlanCard\n  SeatManager\n  InvoiceList\n  DangerZone\n",
    rubric: [
      "Assigns ownership by behaviour and data responsibility.",
      "Prevents two components from owning the same mutable state.",
      "Names the interface between the page and each child.",
    ],
    facets: [
      "Ownership boundaries following behaviour and data responsibilities.",
      "Boundary: seat count shared by plan display and billing summary.",
    ],
    focus:
      "give each component one data responsibility and keep shared seat state in a single owner",
    misconception:
      "Components should mirror the visual boxes: one component per card, each fetching everything it displays.",
    correct:
      "PlanCard owns plan presentation, SeatManager owns seat mutations and the current seat count, InvoiceList owns invoice fetching, and DangerZone owns destructive action state. The page owns the shared seat count and passes it down, so no two children fetch or mutate it.",
  },
  {
    track: "PE",
    topic: "T14",
    title: "Map an unfamiliar feature before changing it",
    prompt:
      "You are asked to change how exports are named in an unfamiliar repository. Describe a minimal map of the feature: entry points, data flow, tests and relevant boundaries. Explain what you would read first and what you would deliberately skip.",
    starter: "Entry point:\nData flow:\nTests:\nBoundaries:\n",
    rubric: [
      "Finds entry points through routes, handlers or call sites rather than file order.",
      "Follows the export data flow to the naming decision.",
      "Names the tests that would detect a naming regression.",
    ],
    facets: [
      "Locating entry points, data flow, tests and boundaries without linear reading.",
      "Boundary: a path that bypasses the main export handler.",
    ],
    focus:
      "locate the export entry point, follow the filename through the data flow and find the tests that pin the current name",
    misconception:
      "The reliable way to understand an unfamiliar repo is to read files alphabetically until the export code appears.",
    correct:
      "I would search for the export route or command, follow the filename argument to where it is composed, then read the export tests and any scheduled-job or API callers that bypass the handler. I would skip unrelated UI components.",
  },
  {
    track: "PE",
    topic: "T02",
    title: "Choose an outcome and guardrail metric",
    prompt:
      "A team wants to speed up the checkout review step. Define one outcome metric and appropriate guardrail metrics in operational terms, including the population, window and failure modes each metric detects.",
    starter:
      "Outcome metric:\nPopulation and window:\nGuardrail metrics:\nFailure modes:\n",
    rubric: [
      "Defines one outcome metric with population and measurement window.",
      "Adds guardrails for correctness, support load and abandonment.",
      "Explains what a movement in each metric would actually mean.",
    ],
    facets: [
      "One outcome metric and guardrails stated operationally.",
      "Boundary: a faster step that also raises order errors.",
    ],
    focus:
      "pick one outcome metric with a population and window, then guardrails for errors and abandonment",
    misconception:
      "The only metric that matters is average time on the review step; if it drops, the change worked.",
    correct:
      "The outcome is review completion within 30 seconds for sessions that reached review in a seven-day window. Guardrails are order-error rate, support contacts about checkout and abandonment after review; a faster step with more errors has not succeeded.",
  },
];
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const roadmap = (): Roadmap =>
  JSON.parse(readFileSync(join(ROOT, "public/curriculum.json"), "utf8"));
const topicOf = (id: string) => id.split(":")[1]?.split(".")[0] ?? "";
const HASH = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

type Reply = Record<string, unknown>;
type Handler = (operation: string, payload: any) => Reply;

function response(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** The bridge is the only transport: every other fetch fails, so no network. */
async function withBridge(handler: Handler, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input?.url ?? input);
    if (url.endsWith("/api/status"))
      return response({
        mode: "claude-cli",
        label: "Claude CLI (local capture)",
        detail: "Captured locally; no network is used.",
        capabilities: ["study"],
      });
    if (url.endsWith("/api/bridge")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return response(handler(body.operation, body.payload));
    }
    throw Error(`build-study-cases refuses network access to ${url}`);
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

function gameFor(seed: number, r: Roadmap) {
  const g = createPlayableGame(seed, r, initialStudy(r, "live"));
  g.status = "playing";
  return g;
}

function encounterFor(g: Game, index: number) {
  const ids = Object.keys(g.encounters);
  const e = g.encounters[ids[index % ids.length]];
  delete e.questionRoom;
  e.mode = "solo";
  e.state = "in-progress";
  return e;
}

/** Seed the live learner the way the unit tests do, then let the game schedule. */
function contractFor(
  g: Game,
  r: Roadmap,
  scenario: Scenario,
  depth: number,
  variant: number,
) {
  const learner = g.study.learner!;
  learner.reviews = {};
  learner.studyTurnPosition = scenario.track === "PY" ? 0 : 1;
  learner.version = variant + 1;
  learner.tracks[scenario.track].tier = depth;
  learner.tracks[scenario.track].queue = [scenario.topic];
  return eligible(r, g.study);
}

function problemFor(
  scenario: Scenario,
  contract: Contract,
  depth: number,
): Problem {
  const objectiveId = contract.objectiveIds[0];
  return {
    title: `${scenario.title}${depth > 1 ? ` — depth ${depth}` : ""}`,
    prompt: `${scenario.prompt}\n\n${
      depth > 1
        ? `This is a depth ${depth} response: explain the invariant you rely on and name one boundary that would break a weaker version.`
        : "Show the smallest complete solution and state why it handles the boundary case."
    }`,
    starter: scenario.starter,
    rubric: scenario.rubric,
    provenance: "claude-cli",
    contract,
    scopeDefinitions: [
      {
        id: scopeKey(objectiveId, contract.depth),
        objectiveId,
        depth: contract.depth,
        sourceScope: scenario.facets[0],
        facets: [
          { id: "core", description: scenario.facets[0] },
          { id: "boundary", description: scenario.facets[1] },
        ],
      } satisfies ScopeDefinition,
    ],
  };
}

function scenarioFor(_r: Roadmap, contract: Contract, variant: number) {
  const topic = topicOf(contract.objectiveIds[0] ?? "");
  return (
    SCENARIOS.find((s) => s.track === contract.track && s.topic === topic) ??
    SCENARIOS[variant % SCENARIOS.length]
  );
}

function seedProbes(g: Game, contract: Contract, variant: number) {
  const base = {
    encounter: "f0-room0",
    runId: g.id,
    track: contract.track,
    objectiveIds: contract.objectiveIds,
    objectiveId: contract.objectiveIds[0],
    depth: contract.depth,
    provider: "claude-cli" as const,
    at: new Date(Date.UTC(2026, 8, 1 + variant)).toISOString(),
    requestId: `probe-${variant}`,
  };
  g.study.knowledgeEstablished = [
    {
      ...base,
      id: `established-${variant}`,
      facet: {
        id: "core",
        description:
          "The learner named the invariant in an earlier terminal conversation.",
      },
      status: "demonstrated",
    },
  ];
  if (variant % 3 === 2)
    g.study.knowledgeGaps = [
      {
        ...base,
        id: `gap-${variant}`,
        facet: {
          id: "boundary",
          description:
            "Where the window ends and a new total becomes eligible.",
        },
        statement:
          "The learner could not explain what happens at the boundary after the window moves.",
      },
    ];
}

async function buildGenerate(
  r: Roadmap,
  variant: number,
): Promise<Record<string, unknown>> {
  const track: Track = variant % 2 === 0 ? "PY" : "PE";
  const topics: Record<Track, string[]> = {
    PY: ["T05", "T11", "T02", "T14", "T08", "T01"],
    PE: ["T01", "T11", "T08", "T05", "T14", "T02"],
  };
  const topic = topics[track][Math.floor(variant / 2) % 6];
  const scenario =
    SCENARIOS.find((s) => s.track === track && s.topic === topic) ??
    SCENARIOS[0];
  const depth = track === "PY" ? [1, 2, 3][Math.floor(variant / 2) % 3] : 1;
  const g = gameFor(20260900 + variant, r);
  const e = encounterFor(g, 0);
  const contract = contractFor(g, r, scenario, depth, variant);
  seedProbes(g, contract, variant);
  let captured: Record<string, unknown> | undefined;
  await withBridge(
    (operation, payload) => {
      if (operation !== "generate") return { text: "unused", complete: false };
      captured = payload;
      const c = payload.contract as Contract;
      const sc = scenarioFor(r, c, variant);
      return {
        title: `${sc.title} (D${depth})`,
        prompt: `${sc.prompt}\n\nDepth ${depth}: defend the invariant you use.`,
        starter: sc.starter,
        rubric: sc.rubric,
        provenance: "claude-cli",
        contract: c,
        estimatedSolveSeconds: 240 + depth * 120,
      };
    },
    () => ensureProblem(g, e, r),
  );
  if (!captured) throw Error("generate flow did not call the bridge");
  return captured;
}

type Stage = {
  learner: (s: Scenario) => string[];
  replies: (s: Scenario) => string[];
};

const STAGES: Stage[] = [
  {
    learner: (s) => [
      `For "${s.title}" I think I should ${s.focus}. I would keep that state and update it once per step. Is that the right starting point?`,
    ],
    replies: (s) => [
      `That names the right state. Before coding: what has to be true about ${s.facets[0].toLowerCase()} for that update to stay correct?`,
    ],
  },
  {
    learner: (s) => [
      `I would ${s.focus}. My first attempt updates everything at each step and then recomputes the answer.`,
      `I tried the smaller update you hinted at, but I cannot tell whether the boundary is included or excluded when the state changes.`,
    ],
    replies: (s) => [
      `You are close. Which value in your loop tells you that a new answer is eligible, before you touch the boundary?`,
      `Good question to isolate. Take the smallest input where the boundary matters and trace your update by hand: what does ${s.correct.split(".")[0]} imply there?`,
    ],
  },
  {
    learner: (s) => [
      `I do not really understand how to ${s.focus}. I can follow an example but I would not know where to start on my own, so this is a real gap for me.`,
    ],
    replies: (s) => [
      `Thanks for naming that. The missing piece is the invariant, not the syntax. In one sentence, what stays true about ${s.facets[0].toLowerCase()} after every step?`,
    ],
  },
  {
    learner: () => [
      `Can you just give me the full answer? I am short on time and I need the finished code that passes the checks.`,
    ],
    replies: (s) => [
      `I will not hand you the finished answer, because the point is the reasoning. I can narrow it: what is the one piece of state in "${s.title}" that must survive between steps?`,
    ],
  },
  {
    learner: (s) => [s.misconception],
    replies: (s) => [
      `That is a confident claim, so let us test it. What would a counterexample look like for ${s.facets[1].toLowerCase()}?`,
    ],
  },
  {
    learner: (s) => [s.correct],
    replies: (s) => [
      `That reasoning holds. One boundary left: ${s.facets[1]} How would your answer change if that case were the only input?`,
    ],
  },
];

async function buildTutor(
  r: Roadmap,
  variant: number,
): Promise<Record<string, unknown>> {
  const stageIndex = variant % STAGES.length;
  const stage = STAGES[stageIndex];
  const scenario =
    SCENARIOS[
      (variant + Math.floor(variant / STAGES.length)) % SCENARIOS.length
    ];
  const depth = scenario.track === "PY" ? 1 + (variant % 2) : 1;
  const g = gameFor(20261000 + variant, r);
  const e = encounterFor(g, variant);
  const contract = contractFor(g, r, scenario, depth, variant);
  e.problem = problemFor(scenario, contract, depth);
  const learnerTexts = stage.learner(scenario);
  const replies = stage.replies(scenario);
  let captured: Record<string, unknown> | undefined;
  let step = 0;
  await withBridge(
    (operation, payload) => {
      if (operation !== "tutor") return { text: "unused", complete: false };
      captured = payload;
      return {
        text: replies[Math.min(step, replies.length - 1)],
        complete: false,
      };
    },
    async () => {
      for (const text of learnerTexts) {
        await send(g, e, "tutor", text, r);
        step++;
      }
    },
  );
  if (!captured) throw Error("tutor flow did not call the bridge");
  return captured;
}

const EVIDENCE_KINDS = [
  "independent",
  "assisted",
  "partial",
  "corrected",
] as const;

async function buildAssess(
  r: Roadmap,
  variant: number,
): Promise<Record<string, unknown>> {
  const scenario = SCENARIOS[variant % SCENARIOS.length];
  const kind = EVIDENCE_KINDS[Math.floor(variant / SCENARIOS.length) % 4];
  const depth = scenario.track === "PY" ? 1 + (variant % 2) : 1;
  const g = gameFor(20261100 + variant, r);
  const e = encounterFor(g, variant);
  const contract = contractFor(g, r, scenario, depth, variant);
  e.problem = problemFor(scenario, contract, depth);
  e.workspace = `${scenario.starter}\n# attempt\n`;
  if (kind === "assisted") {
    const seq = ++g.seq;
    e.tutor.push({
      id: `help-${variant}`,
      author: "Terminal AI",
      kind: "tutor",
      text: `You asked about the boundary. What must hold about ${scenario.facets[0].toLowerCase()} before you report an answer?`,
      seq,
      worldTime: 0,
      presented: seq,
      provenance: "claude-cli",
    });
  }
  if (kind === "corrected") {
    edit(
      g,
      e,
      `My first pass ignored the boundary and returned a wrong total.`,
      e.revision,
      r,
    );
  }
  edit(g, e, scenario.correct, e.revision, r);
  const lastArtifact = [...e.history].reverse().find((h) => h.kind === "edit")!;
  const accepted =
    kind === "independent" || kind === "assisted" || kind === "corrected";
  const submission = {
    id: `submission-${variant}`,
    revision: e.revision,
    author: "human",
    content:
      kind === "partial"
        ? `${scenario.correct}\n\nI have not checked the boundary yet.`
        : scenario.correct,
    status: (kind === "partial" ? "needs-work" : "complete") as
      "needs-work" | "complete",
    feedback: "",
    seq: ++g.seq,
  };
  e.submissions.push(submission);
  if (accepted) e.accepted = submission.id;
  let captured: Record<string, unknown> | undefined;
  await withBridge(
    (operation, payload) => {
      if (operation === "assess") captured = payload;
      return { findings: [], visitOutcome: "unresolved" };
    },
    async () => {
      await assess(g, e, r, accepted ? submission.seq : lastArtifact.seq);
    },
  );
  if (!captured) throw Error("assess flow did not call the bridge");
  return captured;
}

const BUILDERS: Record<
  StudyOperation,
  (r: Roadmap, variant: number) => Promise<Record<string, unknown>>
> = { generate: buildGenerate, tutor: buildTutor, assess: buildAssess };

export async function buildStudyCases({
  perOp = 16,
}: { perOp?: number } = {}): Promise<StudyCaseBook> {
  const r = roadmap();
  await withBridge(
    () => ({ text: "unused", complete: false }),
    async () => {
      await checkBridge();
    },
  );
  const found = {
    generate: new Map<string, Record<string, unknown>>(),
    tutor: new Map<string, Record<string, unknown>>(),
    assess: new Map<string, Record<string, unknown>>(),
  } satisfies Record<StudyOperation, Map<string, Record<string, unknown>>>;
  for (
    let variant = 0;
    variant < perOp * 6 &&
    STUDY_OPERATIONS.some((op) => found[op].size < perOp);
    variant++
  )
    for (const operation of STUDY_OPERATIONS) {
      if (found[operation].size >= perOp) continue;
      const payload = await BUILDERS[operation](r, variant);
      const hash = HASH(payload);
      if (!found[operation].has(hash)) found[operation].set(hash, payload);
    }
  return Object.fromEntries(
    STUDY_OPERATIONS.map((operation) => {
      const payloads = [...found[operation].values()];
      if (payloads.length < perOp)
        throw Error(
          `Only captured ${payloads.length} distinct ${operation} cases; wanted ${perOp}`,
        );
      return [
        operation,
        payloads.slice(0, perOp).map((payload, index) => ({
          id: `${operation}-${index + 1}`,
          operation,
          payload,
        })),
      ];
    }),
  ) as StudyCaseBook;
}

/** Write one case file per operation and merge counts into index.json. */
export async function writeStudyCases(out: string, perOp = 16) {
  const book = await buildStudyCases({ perOp });
  const target = resolve(out);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  chmodSync(target, 0o700);
  for (const operation of STUDY_OPERATIONS) {
    const file = join(target, `${operation}.json`);
    writeFileSync(file, `${JSON.stringify(book[operation], null, 2)}\n`, {
      mode: 0o600,
    });
    chmodSync(file, 0o600);
  }
  const indexFile = join(target, "index.json");
  const prior =
    existsSync(indexFile) &&
    (JSON.parse(readFileSync(indexFile, "utf8")) as Record<string, unknown>);
  const index = {
    ...(prior && typeof prior === "object" ? prior : {}),
    ...Object.fromEntries(
      STUDY_OPERATIONS.map((operation) => [operation, book[operation].length]),
    ),
  };
  writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(indexFile, 0o600);
  return { book, index };
}

function argument(name: string, fallback?: string) {
  const at = process.argv.indexOf(name);
  if (at === -1) return fallback;
  const value = process.argv[at + 1];
  if (!value) throw Error(`${name} needs a value`);
  return value;
}

const entry = process.argv[1] && resolve(process.argv[1]);
if (entry === fileURLToPath(import.meta.url)) {
  const out = argument("--out", ".local/ai-cases")!;
  const perOp = Number(argument("--per-op", "16"));
  writeStudyCases(out, perOp).then(
    ({ index }) =>
      console.log(
        `Wrote ${Object.values(index).reduce((n: number, v) => n + Number(v), 0)} study cases to ${resolve(out)}.`,
      ),
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
