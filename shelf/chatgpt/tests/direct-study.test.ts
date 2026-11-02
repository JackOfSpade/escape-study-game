import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkBridge, ensureProblem, send } from "../src/ai";
import {
  beginDirectStudy,
  pauseDirectStudy,
  resumeDirectStudyInNewChat,
  NATIVE_TRANSCRIPT_PROVENANCE,
  resumeDirectStudies,
  retryDirectStudy,
  unfinishedDirectStudy,
} from "../src/direct-study";
import { complete } from "../src/engine";
import { initialStudy } from "../src/curriculum";
import { eligibleLearning, registerScopes } from "../src/learner";
import { retainRunLearning } from "../src/run-learning";
import { probeFacets } from "../src/knowledge-probe";
import { event, type Roadmap } from "../src/model";
import { decode, encode, recover } from "../src/persistence";
import { createPlayableGame } from "../src/world";
import { QUESTION_ADAPTATION_GUIDANCE } from "../scripts/lib/study-question-policy.mjs";
import { enterStudyWorkspace } from "../src/study-workspace";

const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));

interface Harness {
  g: any;
  e: any;
  calls: any[];
  /** Resolve the n-th (0-based) bridge call with this JSON body. */
  answer: (n: number, body: unknown, status?: number) => void;
  waitCalls: (n: number) => Promise<void>;
  setCapabilities: (caps: string[]) => Promise<void>;
}

async function fixture(run: (h: Harness) => Promise<void>) {
  const original = globalThis.fetch;
  const calls: any[] = [];
  const resolvers: ((r: Response) => void)[] = [];
  let caps: string[] = [];
  let connected = false;
  globalThis.fetch = async (url, init) => {
    if (String(url) === "/api/status")
      return Response.json({
        mode: connected ? "chatgpt-handoff" : "development",
        label: "Synthetic",
        detail: "No real AI",
        capabilities: connected ? caps : [],
      });
    const p = JSON.parse(String(init?.body));
    calls.push(p);
    return new Promise<Response>((resolve) => resolvers.push(resolve));
  };
  const waitCalls = async (n: number) => {
    // Fingerprint hashing uses the asynchronous crypto pool. An iteration
    // count can elapse before that pool runs under the full parallel suite.
    const deadline = Date.now() + 5000;
    while (calls.length < n && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(calls.length, n);
  };
  try {
    await checkBridge();
    const g = createPlayableGame(717, r);
    const e = g.encounters[g.floors[0].stations[0].encounter];
    await ensureProblem(g, e, r);
    e.mode = "solo";
    e.owner = "human";
    connected = true;
    caps = ["tutor", "direct-study", "topic-assessments"];
    await checkBridge();
    await run({
      g,
      e,
      calls,
      answer: (n, body, status = 200) => {
        const topics = calls[n]?.payload?.topicAssessmentContext?.topicIds;
        const response =
          body &&
          typeof body === "object" &&
          (body as any).complete === true &&
          topics &&
          !("topicAssessments" in body)
            ? {
                ...body,
                topicAssessments: topics.map((topicId: string) => ({
                  topicId,
                  text: "Synthetic AI impression: probably understands the mechanism; boundary confidence is still tentative.",
                })),
              }
            : body;
        resolvers[n](Response.json(response, { status }));
      },
      waitCalls,
      setCapabilities: async (next) => {
        caps = next;
        await checkBridge();
      },
    });
  } finally {
    connected = false;
    await checkBridge();
    globalThis.fetch = original;
  }
}

const transcript = [
  {
    role: "assistant",
    text: "Which value changes first when the window moves?",
  },
  { role: "user", text: "The leftmost reading leaves, so subtract it first." },
  { role: "assistant", text: "Good. What about the boundary at the end?" },
  { role: "user", text: "Stop when the right edge reaches the last index." },
] as const;

function solved(e: any, fingerprint: string, extra: object = {}) {
  const facets = probeFacets(e.problem);
  return {
    text: "You established every part of the question.",
    complete: true,
    outcome: "solved",
    questionFingerprint: fingerprint,
    transcript,
    knowledge: {
      facets: facets.map((f) => ({ id: f.id, status: "demonstrated" })),
    },
    ...extra,
  };
}

function liveQuestion(g: any, e: any) {
  g.study = initialStudy(r, "live");
  g.study.learner.reviews = {};
  const contract = eligibleLearning(r, g.study.learner, "2026-10-22T16:00:00Z");
  e.problem = {
    title: "Synthetic native reasoning",
    prompt: "Explain the mechanism and its boundary.",
    starter: "",
    rubric: ["Explain the mechanism", "Explain the boundary"],
    provenance: "chatgpt-handoff",
    contract,
    scopeDefinitions: [
      {
        id: `${contract.objectiveIds[0]}/D${contract.depth}`,
        objectiveId: contract.objectiveIds[0],
        depth: contract.depth,
        sourceScope: contract.scopes[0],
        facets: [
          { id: "mechanism", description: "Explain the mechanism" },
          { id: "boundary", description: "Explain the boundary" },
        ],
      },
    ],
  };
  e.workspace = "";
  e.revision = 0;
  e.history = [];
  e.tutor = [];
  delete e.problemPresentedSequence;
  registerScopes(r, g.study.learner, e);
}
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate());
}
function judgment(
  packet: any,
  outcome: "independent" | "assisted" = "assisted",
) {
  const user = packet.history.findLast((h: any) => h.author === "human");
  return {
    findings: packet.problem.scopeDefinitions[0].facets.map((f: any) => ({
      objectiveId: packet.problem.contract.objectiveIds[0],
      depth: packet.problem.contract.depth,
      facet: f.id,
      outcome,
      evidence: [user.seq],
      completeCheckpointScope: false,
      execution: "not-run",
      rationale: "Synthetic native attribution regression",
    })),
    visitOutcome: "usable",
    scopeReviews: [
      {
        id: packet.problem.scopeDefinitions[0].id,
        completeCoverage: true,
        rationale: "Synthetic complete scope",
      },
    ],
    helpAttributions: packet.assistanceSources.map((m: any) => ({
      messageId: m.id,
      facets:
        outcome === "assisted" && m.provenance === NATIVE_TRANSCRIPT_PROVENANCE
          ? ["*"]
          : [],
      rationale: "Synthetic visible context attribution",
    })),
  };
}

const humanKeys = (g: any) => g.survivors[0].keys ?? 0;

test("study-only native results are assessed and persist while the world stays frozen and no game items are granted", async () =>
  fixture(async ({ g, e, calls, answer, waitCalls }) => {
    liveQuestion(g, e);
    e.studyOnly = true;
    enterStudyWorkspace(g);
    const keys = humanKeys(g);
    const time = g.time;
    const access = [...g.survivors[0].access];
    await beginDirectStudy(g, e, r);
    await waitCalls(1);
    const fingerprint = e.directStudy.questionFingerprint;
    answer(0, solved(e, fingerprint));
    await retryDirectStudy(g, e, r);
    await waitCalls(2);
    assert.equal(e.directStudy.state, "applied");
    assert.equal(g.study.assessments[0].status, "pending");
    answer(1, judgment(calls[1].payload.packet));
    await waitFor(() => g.study.assessments[0].status !== "pending");
    assert.equal(
      g.study.assessments[0].status,
      "applied",
      g.study.assessments[0].provenance,
    );
    assert.equal(g.study.visits.length, 1);
    assert.equal(humanKeys(g), keys);
    assert.deepEqual(g.survivors[0].access, access);
    assert.equal(g.time, time);
    const saved = recover(decode(encode(g)));
    assert.equal(
      saved.encounters[e.id].directStudy?.questionFingerprint,
      fingerprint,
    );
    assert.equal(saved.encounters[e.id].directStudy?.state, "applied");
    assert.equal(saved.study.assessments[0].status, "applied");
    assert.equal(saved.studyWorkspace?.enabled, true);
    assert.equal(saved.study.visits.length, 1);
  }));

test("live formal completion advances the track before assessment, and the delayed assessment cannot advance it twice", async () =>
  fixture(async ({ g, e, calls, answer, waitCalls }) => {
    liveQuestion(g, e);
    await beginDirectStudy(g, e, r);
    await waitCalls(1);
    answer(0, solved(e, e.directStudy.questionFingerprint));
    await retryDirectStudy(g, e, r);
    await waitCalls(2);
    const l = g.study.learner;
    assert.equal(e.state, "consumed");
    assert.equal(l.cycle, 0, "academic visit still awaits assessment");
    assert.equal(l.studyTurnPosition, 1);
    assert.equal(eligibleLearning(r, l).track, "PE");
    answer(1, judgment(calls[1].payload.packet));
    await waitFor(() => g.study.assessments[0].status !== "pending");
    assert.equal(g.study.assessments[0].status, "applied");
    assert.equal(l.cycle, 1);
    assert.equal(l.studyTurnPosition, 1);
    assert.equal(eligibleLearning(r, l).track, "PE");
    await retryDirectStudy(g, e, r);
    assert.equal(l.studyTurnPosition, 1);
  }));

test("a delayed assessment of an older bound live question cannot consume an owed turn on the other track", async () =>
  fixture(async ({ g, e, calls, answer, waitCalls }) => {
    liveQuestion(g, e);
    await beginDirectStudy(g, e, r);
    await waitCalls(1);
    // A saved resume position can change while the original issued task stays bound.
    g.study.learner.cycleOffset = 1;
    answer(0, solved(e, e.directStudy.questionFingerprint));
    await retryDirectStudy(g, e, r);
    await waitCalls(2);
    assert.equal(g.study.learner.studyTurnPosition, 1);
    answer(1, judgment(calls[1].payload.packet));
    await waitFor(() => g.study.assessments[0].status !== "pending");
    assert.equal(g.study.assessments[0].status, "applied");
    assert.equal(g.study.learner.cycle, 1);
    assert.equal(g.study.learner.studyTurnPosition, 1);
    assert.equal(eligibleLearning(r, g.study.learner).track, "PE");
  }));

test("a previously issued off-track development question stays answerable without consuming the owed track", async () =>
  fixture(async ({ g, e, answer, waitCalls }) => {
    assert.equal(e.problem.contract.track, "PY");
    g.study.cycle = 1;
    e.problemPresentedSequence = 7;
    const original = structuredClone(e.problem);
    await beginDirectStudy(g, e, r);
    await waitCalls(1);
    answer(0, solved(e, e.directStudy.questionFingerprint));
    await retryDirectStudy(g, e, r);
    assert.equal(e.state, "consumed");
    assert.deepEqual(e.problem, original);
    assert.equal(g.study.cycle, 1);
    assert.equal(g.study.visits.length, 0);
  }));

test("a native question opens without learner evidence and completes once with attributed transcript", async () =>
  fixture(async ({ g, e, calls, answer, waitCalls }) => {
    const keys = humanKeys(g);
    const priorTutor = e.tutor.length;
    const changes: number[] = [];
    await beginDirectStudy(g, e, r, { onChange: () => changes.push(1) });
    await waitCalls(1);
    const s = e.directStudy;
    assert.equal(s.state, "pending");
    assert.equal(unfinishedDirectStudy(e), true);
    // Opening is not learner work.
    assert.equal(e.tutor.length, priorTutor);
    assert.equal(e.history.filter((h: any) => h.author === "human").length, 0);
    assert.equal(e.submissions.length, 0);
    assert.equal(e.state === "consumed", false);
    assert.equal(g.study.visits.length, 0);
    const p = calls[0].payload;
    assert.ok(p.instruction.includes(QUESTION_ADAPTATION_GUIDANCE));
    assert.ok(p.probe.stance.includes(QUESTION_ADAPTATION_GUIDANCE));
    assert.doesNotMatch(p.instruction, /Pose exactly this question/);
    assert.equal(calls[0].operation, "tutor");
    assert.deepEqual(calls[0].nativeScope, {
      runId: e.runId,
      encounterId: e.id,
      ...(e.questionRoom ? { questionRoom: e.questionRoom } : {}),
    });
    assert.equal("nativeScope" in p, false);
    assert.equal(p.mode, "terminal-direct");
    assert.equal(p.requestId, s.id);
    assert.equal(p.sessionId, `${e.runId}/${e.id}/private`);
    assert.equal(p.questionFingerprint, s.questionFingerprint);
    assert.match(s.questionFingerprint, /^[0-9a-f]{64}$/);
    assert.deepEqual(p.problem, e.problem);
    const originalProblem = structuredClone(e.problem);
    assert.equal(p.workspace, e.workspace);
    assert.equal(p.draftRevision, e.revision);
    assert.equal("curriculum" in p, false);
    assert.equal("progressContext" in p, false);
    const { topicAssessmentContext: context, ...questionPayload } = p;
    assert.equal(JSON.stringify(questionPayload).length < 60_000, true);
    assert.deepEqual(context.topicIds, [
      ...new Set(
        e.problem.contract.objectiveIds.map((id: string) => id.split(".")[0]),
      ),
    ]);
    assert.equal(JSON.stringify(context).length < 230_000, true);
    assert.ok(changes.length >= 1);
    // The world keeps running while ChatGPT is talking.
    g.time += 30;
    event(g, "unrelated", "A zombie shuffles somewhere.", e.floor);
    // Answering through the in-game tutor is not relayed.
    await send(g, e, "tutor", "In-game answer", r);
    assert.equal(calls.length, 1);
    assert.equal(e.tutor.length, priorTutor);
    // Presentation can differ from the frozen prompt without replacing its
    // assessed task. Keep those actual assistant words in the attributed log.
    const rephrasedTranscript = transcript.map((turn, i) =>
      i === 0
        ? {
            ...turn,
            text: "Let's take the same task in steps: what leaves the window first?",
          }
        : turn,
    );
    answer(
      0,
      solved(e, s.questionFingerprint, { transcript: rephrasedTranscript }),
    );
    await retryDirectStudy(g, e, r);
    assert.equal(s.state, "applied", s.error);
    assert.deepEqual(e.problem, originalProblem);
    assert.equal(s.questionFingerprint, p.questionFingerprint);
    assert.match(s.responseDigest, /^[0-9a-f]{64}$/);
    assert.equal(humanKeys(g), keys + 1);
    assert.equal(e.state, "consumed");
    assert.equal(e.accepted, `direct-${s.id}`);
    assert.equal(e.submissions.length, 1);
    assert.equal(e.submissions[0].status, "complete");
    assert.equal(
      e.submissions[0].content,
      [
        p.workspace === "" ? "" : `Saved work:\n${p.workspace}`,
        `${transcript[1].text}\n\n${transcript[3].text}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
    const added = e.tutor.slice(priorTutor);
    assert.deepEqual(
      added.map((m: any) => [m.kind, m.author, m.text, m.provenance]),
      [
        ...rephrasedTranscript.map((t) => [
          t.role === "user" ? "human" : "tutor",
          t.role === "user" ? "human" : "Terminal AI",
          t.text,
          NATIVE_TRANSCRIPT_PROVENANCE,
        ]),
        [
          "tutor",
          "Terminal AI",
          "You established every part of the question.",
          NATIVE_TRANSCRIPT_PROVENANCE,
        ],
      ],
    );
    assert.equal(
      added.every(
        (m: any) =>
          m.requestId === s.id &&
          m.presented === m.seq &&
          e.history.find((h: any) => h.seq === m.seq)?.presented === m.seq,
      ),
      true,
    );
    assert.equal(
      e.tutor.filter((m: any) => m.provenance === "live-human").length,
      0,
    );
    assert.equal(e.probe.turns.length, 1);
    assert.equal(e.probe.turns[0].requestId, s.id);
    // Replay and reload grant nothing further.
    await retryDirectStudy(g, e, r);
    await beginDirectStudy(g, e, r);
    const loaded = recover(decode(encode(g)));
    resumeDirectStudies(loaded, r);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1);
    assert.equal(humanKeys(g), keys + 1);
    assert.equal(e.tutor.length, priorTutor + 5);
    assert.equal(e.submissions.length, 1);
    assert.equal(loaded.encounters[e.id].directStudy!.state, "applied");
    assert.equal(
      loaded.encounters[e.id].directStudy!.responseDigest,
      s.responseDigest,
    );
  }));

test("completion after death records native learning but awards no key", async () =>
  fixture(async ({ g, e, answer, waitCalls }) => {
    const keys = humanKeys(g);
    await beginDirectStudy(g, e, r);
    await waitCalls(1);
    g.status = "dead";
    g.survivors[0].alive = false;
    answer(0, solved(e, e.directStudy!.questionFingerprint));
    await retryDirectStudy(g, e, r);
    assert.equal(e.directStudy!.state, "applied", e.directStudy.error);
    assert.equal(humanKeys(g), keys);
    assert.equal(g.survivors[0].access.includes(e.floor), false);
    assert.equal(
      e.tutor.filter((m: any) => m.requestId === e.directStudy!.id).length,
      5,
    );
    assert.equal(e.probe.turns.length, 1);
  }));

const staleChanges: [string, (g: any, e: any) => void][] = [
  ["creation time", (_g, e) => (e.directStudy.createdAt = Number.NaN)],
  ["run", (_g, e) => (e.runId = "another-run")],
  ["replaced encounter", (g, e) => (g.encounters[e.id] = structuredClone(e))],
  [
    "workspace",
    (_g, e) => {
      e.workspace += "\n# newer work";
      e.revision++;
    },
  ],
  ["profile", (g) => (g.study.profile = "live")],
  ["question", (_g, e) => (e.problem = { ...e.problem, prompt: "Replaced" })],
];
for (const [label, change] of staleChanges)
  test(`a stale ${label} rejects the completion atomically`, async () =>
    fixture(async ({ g, e, answer, waitCalls }) => {
      const keys = humanKeys(g),
        tutor = e.tutor.length,
        history = e.history.length;
      await beginDirectStudy(g, e, r);
      await waitCalls(1);
      const s = e.directStudy;
      const frozen = s.payloadJson;
      change(g, e);
      const after = e.history.length;
      answer(0, solved(e, s.questionFingerprint));
      await retryDirectStudy(g, e, r);
      assert.equal(s.state, "interrupted");
      assert.ok(s.error.length > 0);
      assert.equal(s.payloadJson, frozen);
      assert.equal(humanKeys(g), keys);
      assert.equal(e.tutor.length, tutor);
      assert.equal(e.submissions.length, 0);
      assert.equal(e.probe?.turns.length ?? 0, 0);
      assert.equal(e.state === "consumed", false);
      assert.equal(e.history.length, after);
      assert.ok(after >= history);
    }));

const malformed: [string, (e: any, fp: string) => unknown][] = [
  [
    "missing topic assessments",
    (e, fp) => solved(e, fp, { topicAssessments: undefined }),
  ],
  [
    "foreign topic assessment",
    (e, fp) =>
      solved(e, fp, {
        topicAssessments: [{ topicId: "PE:T99", text: "Probably has a gap." }],
      }),
  ],
  [
    "empty topic assessment",
    (e, fp) =>
      solved(e, fp, {
        topicAssessments: [
          {
            topicId: e.problem.contract.objectiveIds[0].split(".")[0],
            text: " ",
          },
        ],
      }),
  ],
  ["incomplete", (e, fp) => solved(e, fp, { complete: false })],
  ["string complete", (e, fp) => solved(e, fp, { complete: "true" })],
  ["mismatched fingerprint", (e) => solved(e, "0".repeat(64))],
  [
    "missing fingerprint",
    (e, fp) => solved(e, fp, { questionFingerprint: undefined }),
  ],
  ["empty transcript", (e, fp) => solved(e, fp, { transcript: [] })],
  [
    "assistant-only transcript",
    (e, fp) =>
      solved(e, fp, {
        transcript: [{ role: "assistant", text: "I solved it." }],
      }),
  ],
  [
    "empty entry",
    (e, fp) => solved(e, fp, { transcript: [{ role: "user", text: "  " }] }),
  ],
  [
    "unknown role",
    (e, fp) => solved(e, fp, { transcript: [{ role: "system", text: "x" }] }),
  ],
  [
    "oversized entry",
    (e, fp) =>
      solved(e, fp, { transcript: [{ role: "user", text: "x".repeat(8001) }] }),
  ],
  [
    "too many entries",
    (e, fp) =>
      solved(e, fp, {
        transcript: Array.from({ length: 101 }, () => ({
          role: "user",
          text: "a",
        })),
      }),
  ],
  [
    "total too long",
    (e, fp) =>
      solved(e, fp, {
        transcript: Array.from({ length: 13 }, () => ({
          role: "user",
          text: "y".repeat(8000),
        })),
      }),
  ],
  ["bad outcome", (e, fp) => solved(e, fp, { outcome: "continue" })],
  ["bare solved assertion", (e, fp) => solved(e, fp, { knowledge: undefined })],
  [
    "gap without findings",
    (e, fp) =>
      solved(e, fp, {
        outcome: "gap",
        knowledge: {
          facets: probeFacets(e.problem).map((f) => ({
            id: f.id,
            status: "demonstrated",
          })),
        },
      }),
  ],
  [
    "gap naming only unasked facets",
    (e, fp) =>
      solved(e, fp, {
        outcome: "gap",
        knowledge: { facets: [{ id: "never-asked", status: "gap" }] },
      }),
  ],
  [
    "only one required facet",
    (e, fp) =>
      solved(e, fp, {
        knowledge: {
          facets: [
            { id: probeFacets(e.problem)[0].id, status: "demonstrated" },
          ],
        },
      }),
  ],
  [
    "unknown findings mixed with valid ones",
    (e, fp) =>
      solved(e, fp, {
        knowledge: {
          facets: [
            ...probeFacets(e.problem).map((f) => ({
              id: f.id,
              status: "demonstrated",
            })),
            { id: "invented", status: "demonstrated" },
          ],
        },
      }),
  ],
  [
    "duplicate facet",
    (e, fp) =>
      solved(e, fp, {
        knowledge: {
          facets: [
            ...probeFacets(e.problem).map((f) => ({
              id: f.id,
              status: "demonstrated",
            })),
            { id: probeFacets(e.problem)[0].id, status: "demonstrated" },
          ],
        },
      }),
  ],
  [
    "unanchored implication",
    (e, fp) =>
      solved(e, fp, {
        knowledge: {
          facets: probeFacets(e.problem).map((f) => ({
            id: f.id,
            status: "implied",
            impliedBy: "unasked",
          })),
        },
      }),
  ],
  [
    "forged evidence field",
    (e, fp) =>
      solved(e, fp, {
        knowledge: {
          facets: probeFacets(e.problem).map((f) => ({
            id: f.id,
            status: "demonstrated",
            evidence: [123],
          })),
        },
      }),
  ],
  [
    "redefined original facet",
    (e, fp) =>
      solved(e, fp, {
        knowledge: {
          facets: probeFacets(e.problem).map((f) => ({
            id: f.id,
            status: "demonstrated",
            partOf: probeFacets(e.problem)[0].id,
            description: "Rewritten task",
          })),
        },
      }),
  ],
  [
    "unknown knowledge field",
    (e, fp) =>
      solved(e, fp, { knowledge: { facets: [], automaticMastery: true } }),
  ],
  ["not an object", () => ["solved"]],
];
for (const [label, body] of malformed)
  test(`a ${label} response is rejected without mutation`, async () =>
    fixture(async ({ g, e, answer, waitCalls }) => {
      const keys = humanKeys(g),
        tutor = e.tutor.length;
      await beginDirectStudy(g, e, r);
      await waitCalls(1);
      const history = e.history.length,
        seq = g.seq;
      answer(0, body(e, e.directStudy!.questionFingerprint));
      await retryDirectStudy(g, e, r);
      assert.equal(e.directStudy!.state, "interrupted");
      assert.equal(humanKeys(g), keys);
      assert.equal(e.tutor.length, tutor);
      assert.equal(e.history.length, history);
      assert.equal(g.seq, seq);
      assert.equal(e.submissions.length, 0);
      assert.equal(e.probe?.turns.length ?? 0, 0);
    }));

test("a gap with explicitly named findings concedes once and records only those gaps", async () =>
  fixture(async ({ g, e, answer, waitCalls }) => {
    const keys = humanKeys(g);
    const facets = probeFacets(e.problem);
    assert.ok(facets.length >= 1);
    await beginDirectStudy(g, e, r);
    await waitCalls(1);
    answer(
      0,
      solved(e, e.directStudy!.questionFingerprint, {
        outcome: "gap",
        knowledge: { facets: [{ id: facets[0].id, status: "gap" }] },
      }),
    );
    await retryDirectStudy(g, e, r);
    assert.equal(e.directStudy!.state, "applied", e.directStudy.error);
    assert.equal(humanKeys(g), keys + 1);
    const turn = e.probe.turns[0];
    assert.equal(turn.outcome, "gap");
    assert.deepEqual(
      turn.findings.map((f: any) => [f.id, f.status]),
      [[facets[0].id, "gap"]],
    );
  }));

test("a pending session survives reload with immutable identity and retries the exact payload once", async () =>
  fixture(async ({ g, e, calls, answer, waitCalls }) => {
    const keys = humanKeys(g);
    await beginDirectStudy(g, e, r);
    await waitCalls(1);
    const loaded = recover(decode(encode(g)));
    const le = loaded.encounters[e.id];
    assert.equal(le.directStudy!.state, "interrupted");
    assert.equal(le.directStudy!.id, e.directStudy!.id);
    assert.equal(le.directStudy!.payloadJson, e.directStudy!.payloadJson);
    assert.equal(unfinishedDirectStudy(le), true);
    resumeDirectStudies(loaded, r);
    resumeDirectStudies(loaded, r);
    await waitCalls(2);
    assert.deepEqual(calls[1].payload, calls[0].payload);
    // Beginning again on the same snapshot reuses the session rather than rerolling.
    await beginDirectStudy(loaded, le, r);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 2);
    answer(1, solved(le, le.directStudy!.questionFingerprint));
    await retryDirectStudy(loaded, le, r);
    assert.equal(le.directStudy!.state, "applied", le.directStudy!.error);
    assert.equal(humanKeys(loaded), keys + 1);
    // The superseded original page later returns the same answer: inert.
    answer(0, solved(e, e.directStudy!.questionFingerprint));
    await retryDirectStudy(g, e, r);
    assert.equal(
      le.tutor.filter((m: any) => m.requestId === le.directStudy!.id).length,
      5,
    );
    assert.equal(le.submissions.length, 1);
  }));

test("a malformed saved session is marked interrupted and never sent", async () =>
  fixture(async ({ g, e, calls, waitCalls }) => {
    await beginDirectStudy(g, e, r);
    await waitCalls(1);
    const saved = JSON.parse(decode(encode(g)) ? encode(g) : "null");
    void saved;
    const copy = decode(encode(g));
    copy.encounters[e.id].directStudy!.payloadJson = "{not json";
    const loaded = recover(copy);
    const s = loaded.encounters[e.id].directStudy!;
    assert.equal(s.state, "interrupted");
    assert.match(s.error!, /malformed/);
    resumeDirectStudies(loaded, r);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1);
    assert.equal(s.state, "interrupted");
  }));

test("an NPC acceptance during the session stays unchanged; native answers remain learning-only", async () =>
  fixture(async ({ g, e, answer, waitCalls }) => {
    const keys = humanKeys(g);
    await beginDirectStudy(g, e, r);
    await waitCalls(1);
    const npc = g.survivors.find((a: any) => a.id !== "human");
    e.mode = "shared";
    e.submissions.push({
      id: "npc-accepted",
      revision: e.revision + 1,
      author: npc.id,
      content: "npc work",
      status: "pending",
      feedback: "",
      seq: g.seq,
    });
    assert.equal(
      complete(g, e.id, "npc-accepted", [npc.id], "NPC solved"),
      true,
    );
    const accepted = structuredClone(e.submissions);
    answer(0, solved(e, e.directStudy!.questionFingerprint));
    await retryDirectStudy(g, e, r);
    assert.equal(e.directStudy!.state, "applied", e.directStudy.error);
    assert.equal(e.accepted, "npc-accepted");
    assert.deepEqual(e.submissions, accepted);
    assert.equal(e.workspace, "npc work");
    assert.equal(humanKeys(g), keys);
    assert.equal(
      e.tutor.filter((m: any) => m.requestId === e.directStudy!.id).length,
      5,
    );
    assert.equal(e.probe.turns.length, 1);
  }));

test("without the direct-study capability nothing is accepted locally", async () =>
  fixture(async ({ g, e, calls, setCapabilities }) => {
    await setCapabilities(["tutor"]);
    await beginDirectStudy(g, e, r);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 0);
    assert.equal(e.directStudy, undefined);
    assert.ok(e.error.length > 0);
  }));

test("completion after extraction saves native learning and grants no key or access", async () =>
  fixture(async ({ g, e, answer, waitCalls }) => {
    const keys = humanKeys(g),
      access = [...g.survivors[0].access];
    await beginDirectStudy(g, e, r);
    await waitCalls(1);
    g.status = "escaped";
    g.survivors[0].escaped = true;
    answer(0, solved(e, e.directStudy.questionFingerprint));
    await retryDirectStudy(g, e, r);
    assert.equal(e.directStudy.state, "applied", e.directStudy.error);
    assert.equal(humanKeys(g), keys);
    assert.deepEqual(g.survivors[0].access, access);
    assert.ok(e.history.some((h: any) => h.author === "human"));
  }));

test("visible native assistant help is included in assessment and cannot silently certify independent repetition", async () =>
  fixture(async ({ g, e, calls, answer, waitCalls }) => {
    liveQuestion(g, e);
    let changes = 0;
    await beginDirectStudy(g, e, r, {
      onChange: () => {
        changes++;
      },
    });
    await waitCalls(1);
    answer(
      0,
      solved(e, e.directStudy.questionFingerprint, {
        transcript: [
          {
            role: "assistant",
            text: "The answer is subtract the departing item before adding the arriving item. Stop at the last index.",
          },
          {
            role: "user",
            text: "Subtract the departing item before adding the arriving item; stop at the last index.",
          },
        ],
      }),
    );
    await retryDirectStudy(g, e, r);
    await waitCalls(2);
    const packet = calls[1].payload.packet;
    assert.equal(calls[1].operation, "assess");
    const help = packet.assistanceSources.find(
      (m: any) => m.provenance === NATIVE_TRANSCRIPT_PROVENANCE,
    );
    const response = packet.history.find((h: any) => h.author === "human");
    assert.ok(help);
    assert.ok(help.presented < response.seq);
    assert.ok(
      packet.history.some(
        (h: any) => h.kind === "tutor" && h.presented < response.seq,
      ),
    );
    const proposed = judgment(packet, "independent");
    proposed.helpAttributions = proposed.helpAttributions.filter(
      (h: any) => h.messageId !== help.id,
    );
    const before = changes;
    answer(1, proposed);
    await waitFor(() => g.study.assessments[0].status !== "pending");
    assert.equal(g.study.assessments[0].status, "review-required");
    assert.match(
      g.study.assessments[0].provenance,
      /Prior help needs explicit facet attribution/,
    );
    assert.equal(g.study.learner.evidence.length, 0);
    assert.ok(
      changes > before,
      "late assessment resolution requests a durable save",
    );
  }));

test("consumed NPC lock gets separate assessment of native answers without replacing its accepted result", async () =>
  fixture(async ({ g, e, calls, answer, waitCalls }) => {
    liveQuestion(g, e);
    const keys = humanKeys(g);
    await beginDirectStudy(g, e, r);
    await waitCalls(1);
    const npc = g.survivors[1];
    e.submissions.push({
      id: "npc-accepted-native",
      revision: e.revision + 1,
      author: npc.id,
      content: "NPC accepted work",
      status: "pending",
      feedback: "",
      seq: g.seq,
    });
    complete(
      g,
      e.id,
      "npc-accepted-native",
      [npc.id],
      "Synthetic NPC acceptance",
    );
    const accepted = structuredClone({
      accepted: e.accepted,
      submissions: e.submissions,
      workspace: e.workspace,
      revision: e.revision,
    });
    let changes = 0;
    // Reusing an active session installs no second request; the original callback
    // is tested in the archive case below. Here the grading record is decisive.
    answer(0, solved(e, e.directStudy.questionFingerprint));
    await retryDirectStudy(g, e, r, () => {
      changes++;
    });
    await waitCalls(2);
    answer(1, judgment(calls[1].payload.packet));
    await waitFor(() => g.study.assessments[0].status !== "pending");
    assert.equal(
      g.study.assessments[0].status,
      "applied",
      g.study.assessments[0].provenance,
    );
    assert.ok(
      g.study.learner.evidence.some((ev: any) => ev.outcome === "assisted"),
    );
    assert.deepEqual(
      {
        accepted: e.accepted,
        submissions: e.submissions,
        workspace: e.workspace,
        revision: e.revision,
      },
      accepted,
    );
    assert.equal(humanKeys(g), keys);
    void changes;
  }));

test("restart closes the archived question, preserves partial work and ignores late completion after reload", async () =>
  fixture(async ({ g, e, calls, answer, waitCalls }) => {
    liveQuestion(g, e);
    await beginDirectStudy(g, e, r);
    await waitCalls(1);
    const id = e.directStudy.id;
    // Only persisted learner evidence is saved; an unanswered facet stays unknown.
    e.history.push({
      seq: ++g.seq,
      author: "human",
      kind: "reasoning",
      text: "Synthetic partial reasoning for the hard part",
      at: g.time,
      revision: e.revision,
    });
    const evidence = structuredClone(g.study.learner.evidence);
    retainRunLearning(g, true);
    assert.equal(e.directStudy.state, "superseded");
    assert.equal(unfinishedDirectStudy(e), false);
    const restarted = createPlayableGame(748, r, g.study);
    const loaded = recover(decode(encode(restarted)));
    const archived = loaded.study.archives.find(
      (a: any) => a.directStudy?.id === id,
    )!;
    assert.ok(archived.history.some((h: any) => h.text.includes("hard part")));
    assert.equal(archived.directStudy!.state, "superseded");
    const keys = humanKeys(loaded);
    resumeDirectStudies(loaded, r);
    answer(0, solved(e, e.directStudy.questionFingerprint));
    await retryDirectStudy(g, e, r);
    assert.equal(calls.length, 1, "no old question or assessment is reissued");
    assert.equal(archived.directStudy!.state, "superseded");
    assert.equal(e.submissions.length, 0);
    assert.equal(humanKeys(loaded), keys);
    assert.deepEqual(loaded.study.learner!.evidence, evidence);
  }));

test("older saves with an archived pending question close it on recovery without erasing artifacts", async () =>
  fixture(async ({ g, e, waitCalls }) => {
    await beginDirectStudy(g, e, r);
    await waitCalls(1);
    const frozen = e.directStudy.payloadJson;
    // Reproduce the saved shape from before restart closed native questions.
    g.study.archives.push(e);
    const fresh = createPlayableGame(748, r, g.study);
    const loaded = recover(decode(encode(fresh)));
    const archived = loaded.study.archives[0];
    assert.equal(archived.directStudy!.state, "superseded");
    assert.deepEqual(
      JSON.parse(archived.directStudy!.payloadJson).problem,
      JSON.parse(frozen).problem,
    );
    assert.equal(unfinishedDirectStudy(archived), false);
  }));

test("valid implied base facets and a one-level declared prerequisite remain supported", async () =>
  fixture(async ({ g, e, answer, waitCalls }) => {
    await beginDirectStudy(g, e, r);
    await waitCalls(1);
    const facets = probeFacets(e.problem),
      root = facets[0].id;
    answer(
      0,
      solved(e, e.directStudy.questionFingerprint, {
        knowledge: {
          facets: [
            { id: root, status: "demonstrated" },
            ...facets
              .slice(1)
              .map((f) => ({ id: f.id, status: "implied", impliedBy: root })),
            {
              id: "needed-part",
              status: "demonstrated",
              partOf: root,
              description: "One prerequisite that the learner established",
            },
          ],
        },
      }),
    );
    await retryDirectStudy(g, e, r);
    assert.equal(e.directStudy.state, "applied", e.directStudy.error);
    assert.ok(e.probe.facets.some((f: any) => f.id === "needed-part"));
  }));

test("an older bridge can finish existing-style questions without the new narrative field", async () =>
  fixture(async ({ g, e, calls, answer, waitCalls, setCapabilities }) => {
    await setCapabilities(["tutor", "direct-study"]);
    await beginDirectStudy(g, e, r);
    await waitCalls(1);
    assert.equal(calls[0].payload.topicAssessmentContext, undefined);
    assert.equal(calls[0].payload.responseFormat.topicAssessments, undefined);
    answer(0, solved(e, e.directStudy.questionFingerprint));
    await retryDirectStudy(g, e, r);
    assert.equal(e.directStudy.state, "applied", e.directStudy.error);
    assert.equal(g.study.topicAssessments, undefined);
  }));

test("stopped questions survive reload without polling and resume with a fresh delivery that rejects late results", async () => {
  await fixture(async ({ g, e, calls, waitCalls, answer }) => {
    await beginDirectStudy(g, e, r);
    await waitCalls(1);
    const old = e.directStudy;
    const oldWait = retryDirectStudy(g, e, r);
    const before = structuredClone({
      problem: e.problem,
      ledger: g.study.learner,
      keys: g.survivors[0].keys,
    });
    assert.equal(pauseDirectStudy(e), true);
    assert.equal(unfinishedDirectStudy(e), true);
    assert.equal(pauseDirectStudy(e), false);
    const saved = recover(decode(encode(g)));
    assert.equal(saved.encounters[e.id].directStudy?.state, "paused");
    resumeDirectStudies(saved, r);
    await beginDirectStudy(g, e, r);
    await retryDirectStudy(g, e, r);
    assert.equal(calls.length, 1);
    const resumed = Promise.all([
      resumeDirectStudyInNewChat(g, e, r),
      resumeDirectStudyInNewChat(g, e, r),
    ]);
    await waitCalls(2);
    assert.notEqual(e.directStudy.id, old.id);
    assert.equal(e.directStudy.questionFingerprint, old.questionFingerprint);
    assert.deepEqual(calls[1].payload.problem, calls[0].payload.problem);
    answer(0, solved(e, old.questionFingerprint));
    await oldWait;
    assert.equal(e.submissions.length, 0);
    assert.equal(e.directStudy.state, "pending");
    assert.deepEqual(
      {
        problem: e.problem,
        ledger: g.study.learner,
        keys: g.survivors[0].keys,
      },
      before,
    );
    answer(1, solved(e, e.directStudy.questionFingerprint));
    await resumed;
    assert.equal(e.directStudy.state, "applied");
    assert.equal(e.submissions.length, 1);
    assert.equal(pauseDirectStudy(e), false);
  });
});

test("concurrent native openings share one immutable session and one delivery", async () =>
  fixture(async ({ g, e, calls, answer, waitCalls }) => {
    const sessions = new Set();
    const options = { onChange: () => sessions.add(e.directStudy) };
    await Promise.all([
      beginDirectStudy(g, e, r, options),
      beginDirectStudy(g, e, r, options),
      beginDirectStudy(g, e, r, options),
    ]);
    await waitCalls(1);
    assert.equal(sessions.size, 1);
    const session = e.directStudy;
    answer(0, solved(e, session.questionFingerprint));
    await retryDirectStudy(g, e, r);
    assert.equal(calls.length, 1);
    assert.equal(session.state, "applied", session.error);
    assert.equal(e.submissions.length, 1);
  }));

test("resuming a malformed paused session keeps its saved task and reports the error", async () =>
  fixture(async ({ g, e, calls, waitCalls }) => {
    await beginDirectStudy(g, e, r);
    await waitCalls(1);
    pauseDirectStudy(e);
    const session = e.directStudy;
    session.payloadJson = "{invalid";
    let changes = 0;
    await assert.doesNotReject(async () =>
      resumeDirectStudyInNewChat(g, e, r, () => changes++),
    );
    assert.equal(e.directStudy, session);
    assert.equal(session.state, "paused");
    assert.match(session.error, /SyntaxError|malformed|invalid/);
    assert.equal(calls.length, 1);
    assert.equal(changes, 1);
  }));

test("a task changed while its identity is hashing is never issued with a stale fingerprint", async () =>
  fixture(async ({ g, e, calls }) => {
    const opening = beginDirectStudy(g, e, r);
    e.workspace += "\n# changed during opening";
    e.revision++;
    await assert.rejects(opening, /changed while opening/);
    assert.equal(e.directStudy, undefined);
    assert.equal(calls.length, 0);
  }));
