import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkBridge, send } from "../src/ai";
import { eligible } from "../src/curriculum";
import {
  encounterProbeContract,
  parseProbeReply,
  probeFacets,
  probeState,
  recordProbeTurn,
  TERMINAL_DIALOGUE_INSTRUCTION,
} from "../src/knowledge-probe";
import type { Problem, Roadmap } from "../src/model";
import { createPlayableGame } from "../src/world";
import { QUESTION_ADAPTATION_GUIDANCE } from "../scripts/lib/study-question-policy.mjs";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);

test("a clarification-only terminal turn receives the clarity policy and preserves demonstrated knowledge", async () => {
  const originalFetch = globalThis.fetch;
  let connected = false;
  const packets: {
    operation: string;
    payload: {
      mode: string;
      instruction: string;
      probe: { stance: string };
      problem: Problem;
    };
  }[] = [];
  globalThis.fetch = async (url, init) => {
    if (String(url) === "/api/status")
      return Response.json({
        mode: connected ? "claude-cli" : "development",
        label: "Synthetic question clarity fixture",
        detail: "No real AI",
        capabilities: connected ? ["tutor"] : [],
      });
    const packet = JSON.parse(String(init?.body));
    assert.equal(packet.operation, "tutor");
    packets.push(packet);
    // This synthetic response tests transport and state behavior, not model judgment.
    return Response.json({
      text: "The prompt did not specify a popup. Classify only the listed state items; no popup is required.",
      complete: false,
    });
  };
  try {
    await checkBridge();
    const g = createPlayableGame(20261020, roadmap);
    const e = g.encounters[g.floors[0].stations[0].encounter];
    e.mode = "solo";
    e.owner = "human";
    e.state = "in-progress";
    e.problem = {
      title: "Synthetic state classification",
      prompt:
        "The share dialog is open. A server record holds whether the link is enabled, and another browser holds a previously fetched copy of that record. Classify these three state items and explain why their values may differ after revocation.",
      rubric: ["Classify the listed state", "Explain a stale browser copy"],
      starter: "",
      provenance: "development",
      contract: {
        ...eligible(roadmap, g.study),
        track: "PE",
        objectiveIds: ["PE:T07.1"],
        scopes: ["Distinguish interface, server and cached state."],
      },
    };
    const facets = probeFacets(e.problem);
    recordProbeTurn(
      g,
      e,
      parseProbeReply(
        {
          complete: false,
          knowledge: {
            facets: [{ id: facets[0].id, status: "demonstrated" }],
          },
        },
        facets,
      ),
      {
        requestId: "synthetic-before-clarification",
        questionSequence: 1,
        provider: "claude-cli",
        statement: "Synthetic previously established classification",
        at: "2026-10-20T12:00:00.000Z",
      },
    );
    const beforeState = probeState(e);
    const beforeEstablished = structuredClone(g.study.knowledgeEstablished);
    const beforeGaps = structuredClone(g.study.knowledgeGaps);
    const beforeLearner = structuredClone(g.study.learner);
    const beforeProblem = structuredClone(e.problem);
    const keys = g.survivors[0].keys ?? 0;
    connected = true;
    await checkBridge();
    await send(
      g,
      e,
      "tutor",
      "Are there any popups in this implementation, or should I classify only the three listed items?",
      roadmap,
    );

    assert.equal(packets.length, 1);
    const packet = packets[0].payload;
    assert.equal(packet.mode, "terminal-dialogue");
    assert.equal(packet.instruction, TERMINAL_DIALOGUE_INSTRUCTION);
    assert.equal(
      packet.probe.stance,
      encounterProbeContract(e, e.problem).stance,
    );
    for (const policy of [packet.instruction, packet.probe.stance]) {
      assert.ok(policy.includes(QUESTION_ADAPTATION_GUIDANCE));
      assert.match(policy, /check whether the prompt is ambiguous/);
      assert.match(policy, /Acknowledge missing facts and clarify/);
      assert.match(policy, /identify any added facts as a clarification/);
      assert.match(policy, /without revealing the concept's solution/);
      assert.match(policy, /without revealing.*adding tasks, rubric demands/);
      assert.match(
        policy,
        /intentional design choice.*unspecified implementation/,
      );
      assert.match(
        policy,
        /accept reasonable examples or assumptions.*explicitly chooses/,
      );
      assert.match(
        policy,
        /Requesting clarification alone is not evidence of partial knowledge, guessing or a gap/,
      );
      assert.match(
        policy,
        /clarification-only turn, keep complete:false and omit knowledge findings and knowledge\.signal/,
      );
      assert.doesNotMatch(policy, /asking what the question means are signals/);
    }
    assert.deepEqual(packet.problem, beforeProblem);
    assert.deepEqual(e.problem, beforeProblem);
    assert.deepEqual(probeState(e), beforeState);
    assert.deepEqual(g.study.knowledgeEstablished, beforeEstablished);
    assert.deepEqual(g.study.knowledgeGaps, beforeGaps);
    assert.deepEqual(g.study.learner, beforeLearner);
    assert.equal(e.probe!.turns.length, 2);
    assert.deepEqual(e.probe!.turns.at(-1)!.findings, []);
    assert.equal(e.probe!.turns.at(-1)!.signal, undefined);
    assert.equal(e.tutorRequests!.at(-1)!.state, "applied");
    assert.equal(e.tutor.at(-1)!.kind, "tutor");
    assert.equal(e.state, "in-progress");
    assert.equal(g.survivors[0].keys ?? 0, keys);
    assert.equal(e.submissions.length, 0);
  } finally {
    connected = false;
    await checkBridge();
    globalThis.fetch = originalFetch;
  }
});
