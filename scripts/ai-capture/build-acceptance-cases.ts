#!/usr/bin/env node
/**
 * Tutor cases with a verdict written down before any reply exists, so a
 * change to how answers are accepted can be read against both failures:
 * holding a correct answer open over wording the question never asked for,
 * and accepting an answer that is wrong or overclaims.
 *
 * Every case is one question whose rubric line is deliberately more specific
 * than its ask, and one learner answer. The case id starts with the expected
 * verdict: `accept-` (the reply must finish the question as solved) or
 * `open-` (the reply must keep it open). All text here is synthetic.
 *
 * tsx scripts/ai-capture/build-acceptance-cases.ts --out <file>
 * tsx scripts/ai-capture/build-acceptance-cases.ts --score <results.jsonl>
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBridge, send } from "../../src/ai";
import { scopeKey } from "../../src/learning-model";
import type { Message, Problem, Track } from "../../src/model";
import {
  contractFor,
  encounterFor,
  gameFor,
  roadmap,
  withBridge,
  type StudyCase,
} from "./build-study-cases";

type Verdict = "accept" | "open";
type Question = {
  track: Track;
  topic: string;
  title: string;
  prompt: string;
  rubric: string[];
  facets: { id: string; description: string }[];
};
type Turn = {
  /** `<verdict>-<what the answer does>`. */
  id: `${Verdict}-${string}`;
  question: Question;
  /** An earlier tutor reply and the facet it nudged, for a disputed rejection. */
  earlier?: { learner: string; tutor: string; nudged: string };
  learner: string;
};

const NARRATIVE: Question = {
  track: "PE",
  topic: "T15",
  title: "Search rebuild interview answer",
  prompt: [
    "You are preparing for a project deep dive. These facts about a past project are true:",
    "- A team of five rebuilt a product search results page. You built the filter panel. A teammate built the ranking service, and a tech lead set the plan.",
    "- The share of searches that ended in an add-to-cart was 42% in the 3 weeks before launch and 49% in the 3 weeks after.",
    "- In the same month as the launch, the company started offering free shipping.",
    "- No A/B test was run, and no one calculated the revenue impact.",
    "",
    'Your draft answer to "What did you do and what was the impact?":',
    "",
    '"I led the search rebuild and built the ranking, which lifted conversion by 7% and added about $1M in revenue."',
    "",
    "Rewrite the draft as one or two sentences an interviewer could probe without catching an overclaim. Use only the true facts above, and qualify the outcome so that it is honest about what was and was not measured.",
  ].join("\n"),
  // More specific than the ask on purpose: the ask names neither both rates
  // nor both windows.
  rubric: [
    "Qualified restatement: the rewrite credits only the filter panel to the speaker, reports 42% to 49% as a before/after comparison of 3-week windows, names the free-shipping launch or the lack of a controlled test as a limit on attributing the change, and adds no revenue figure or other number not in the facts.",
  ],
  facets: [
    {
      id: "ownership-accuracy",
      description:
        "Distinguish the narrator's personal contribution from teammates' work",
    },
    {
      id: "qualified-restatement",
      description:
        "Restate an outcome claim using only real figures with an explicit qualification of uncertainty or confounders",
    },
  ],
};

const WINDOWS: Question = {
  track: "PY",
  topic: "T05",
  title: "Window totals in a sensor feed",
  prompt:
    "A sensor reports one integer each second: [412, 418, 399, 421, 430, 405, 398]. Write `window_totals(readings, size)` returning the total for every consecutive window of `size` readings. Do not recompute a window from scratch when one reading enters and one leaves, and say why your version avoids that.",
  rubric: [
    "Keeps one running total, adding the entering reading and subtracting the leaving one, written as `running += readings[i] - readings[i - size]` inside a single loop, and states that each step is O(1).",
  ],
  facets: [
    {
      id: "running-total",
      description:
        "Maintain a window total incrementally instead of recomputing it",
    },
  ],
};

const OWN =
  "My team rebuilt the search results page, and I built the filter panel.";

export const TURNS: Turn[] = [
  {
    id: "accept-change-as-one-figure",
    question: NARRATIVE,
    learner: `${OWN} Add-to-cart from search went up by 7%, and I think the rebuild helped, although free shipping started the same month.`,
  },
  {
    id: "accept-both-rates",
    question: NARRATIVE,
    learner: `${OWN} Add-to-cart from search went from 42% in the three weeks before launch to 49% in the three weeks after, but free shipping started that month and we ran no A/B test, so I can't isolate the rebuild.`,
  },
  {
    id: "accept-disputed-wording",
    question: NARRATIVE,
    earlier: {
      learner: `${OWN} Add-to-cart from search went up by 7%, though free shipping started the same month, so I can't say how much was the rebuild.`,
      tutor:
        'Your first sentence is accepted. Not accepted yet: "went up by 7%" is not a figure from the facts, which give 42% and 49%. Rewrite the outcome sentence.',
      nudged: "qualified-restatement",
    },
    learner:
      "42% to 49% is a rise of 7, so that figure does come from the facts. The question does not ask me to quote both rates, and I can give them if the interviewer asks.",
  },
  {
    id: "open-no-limit-named",
    question: NARRATIVE,
    learner: `${OWN} Add-to-cart from search rose by 7%, which I believe our rebuild played a part in.`,
  },
  {
    id: "open-unmeasured-revenue",
    question: NARRATIVE,
    learner: `${OWN} Add-to-cart from search went from 42% to 49% and added about $1M in revenue, although free shipping started the same month.`,
  },
  {
    id: "open-unhedged-cause",
    question: NARRATIVE,
    learner:
      "My team rebuilt the search results page. I built the filter panel, which raised add-to-cart from search from 42% in the three weeks before launch to 49% in the three weeks after.",
  },
  {
    id: "open-claims-team-work",
    question: NARRATIVE,
    learner:
      "I led the rebuild of the search results page and its ranking. Add-to-cart from search went from 42% to 49%, although free shipping started the same month and we ran no A/B test.",
  },
  {
    id: "accept-different-code-shape",
    question: WINDOWS,
    learner:
      "def window_totals(readings, size):\n    totals, running = [], 0\n    for i, value in enumerate(readings):\n        running += value\n        if i >= size:\n            running -= readings[i - size]\n        if i >= size - 1:\n            totals.append(running)\n    return totals\n\nEach step adds the reading that enters and removes the one that leaves, so no window is summed again.",
  },
  {
    id: "open-recomputes-each-window",
    question: WINDOWS,
    learner:
      "def window_totals(readings, size):\n    return [sum(readings[i:i + size]) for i in range(len(readings) - size + 1)]\n\nThis is simple and gives the right totals.",
  },
];

async function payloadFor(turn: Turn, seed: number) {
  const r = roadmap();
  const q = turn.question;
  const g = gameFor(20261900 + seed, r);
  const e = encounterFor(g, seed);
  const contract = contractFor(g, r, q as never, 1, seed);
  const objectiveId = contract.objectiveIds[0];
  e.problem = {
    title: q.title,
    prompt: q.prompt,
    starter: "",
    rubric: q.rubric,
    provenance: "claude-cli",
    contract,
    scopeDefinitions: [
      {
        id: scopeKey(objectiveId, contract.depth),
        objectiveId,
        depth: contract.depth,
        sourceScope: q.facets.map((f) => f.description).join("; "),
        facets: q.facets,
      },
    ],
  } satisfies Problem;
  let captured: Record<string, unknown> | undefined;
  await withBridge(
    (operation, payload) => {
      if (operation === "tutor") captured = payload;
      return {
        help: {
          nudges: turn.earlier ? [turn.earlier.nudged] : [],
          hints: [],
          gives: [],
          offers: [],
        },
        text: turn.earlier?.tutor ?? "unused",
        complete: false,
      };
    },
    async () => {
      if (turn.earlier) await send(g, e, turn.earlier.learner, r);
      await send(g, e, turn.learner, r);
    },
  );
  if (!captured) throw Error(`${turn.id}: the tutor flow never called out`);
  const messages = captured.messages as Message[];
  if (turn.earlier && !messages.some((m) => m.kind === "tutor"))
    throw Error(`${turn.id}: the earlier tutor reply was not recorded`);
  return captured;
}

export async function buildAcceptanceCases(): Promise<StudyCase[]> {
  const cases: StudyCase[] = [];
  // The app sends nothing until it has seen a connected bridge.
  await withBridge(
    () => ({ text: "unused", complete: false }),
    async () => {
      await checkBridge();
    },
  );
  for (const [index, turn] of TURNS.entries())
    cases.push({
      id: turn.id,
      operation: "tutor",
      payload: await payloadFor(turn, index),
    });
  return cases;
}

type Row = { caseId?: string; outcome?: string; answers?: unknown[] };

/** Accepted means the reply finished the question as solved. */
const verdictOf = (row: Row): Verdict | "invalid" => {
  const answer = row.answers?.at(-1) as Record<string, unknown> | undefined;
  if (row.outcome !== "valid" || !answer) return "invalid";
  return answer.complete === true && answer.outcome === "solved"
    ? "accept"
    : "open";
};

/** Per case: how many replies gave the expected verdict, and the misses. */
export function scoreAcceptance(jsonl: string) {
  const byCase = new Map<
    string,
    { expected: Verdict; runs: number; matched: number; got: string[] }
  >();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let row: Row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const id = row.caseId ?? "";
    const expected = /^(accept|open)-/.exec(id)?.[1] as Verdict | undefined;
    if (!expected) continue;
    const entry = byCase.get(id) ?? { expected, runs: 0, matched: 0, got: [] };
    const got = verdictOf(row);
    entry.runs++;
    if (got === expected) entry.matched++;
    entry.got.push(got);
    byCase.set(id, entry);
  }
  return [...byCase].map(([id, entry]) => ({ id, ...entry }));
}

function argument(name: string) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

const entry = process.argv[1] && resolve(process.argv[1]);
if (entry === fileURLToPath(import.meta.url)) {
  const results = argument("--score");
  if (results) {
    for (const row of scoreAcceptance(readFileSync(results, "utf8")))
      console.log(
        `${row.matched === row.runs ? "ok  " : "MISS"} ${row.id}: ${row.matched}/${row.runs} as expected (${row.got.join(", ")})`,
      );
  } else {
    const out = resolve(argument("--out") ?? ".local/ai-cases/acceptance.json");
    buildAcceptanceCases().then(
      (cases) => {
        mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
        writeFileSync(out, `${JSON.stringify(cases, null, 2)}\n`, {
          mode: 0o600,
        });
        chmodSync(out, 0o600);
        console.log(`Wrote ${cases.length} acceptance cases to ${out}.`);
      },
      (error) => {
        console.error(error);
        process.exitCode = 1;
      },
    );
  }
}
