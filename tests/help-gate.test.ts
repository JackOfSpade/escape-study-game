import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Direct .mjs contract test.
import { taskInstructions, validateAnswer } from "../scripts/lib/ai-contracts.mjs"; // prettier-ignore
import {
  HELP_GATE_GUIDANCE,
  helpGateProblem,
  helpStreamGate,
  unlockedHelp,
} from "../scripts/lib/help-gate.mjs";
import { offeredHelp } from "../src/ai";
import { TERMINAL_DIALOGUE_INSTRUCTION } from "../src/knowledge-probe";
import type { Encounter, Message } from "../src/model";

const gated = (unlocked: string[] = []) => ({
  mode: "terminal-dialogue",
  helpPolicy: { unlocked },
});
const help = (over: Record<string, string[]> = {}) => ({
  nudges: [],
  hints: [],
  gives: [],
  offers: [],
  ...over,
});
const reply = (declared: unknown, complete = false) => ({
  help: declared,
  text: "Synthetic tutor text",
  complete,
});

test("the tutor is told about the ladder on both instruction paths", () => {
  assert.ok(
    (taskInstructions("tutor", {}) as string).includes(HELP_GATE_GUIDANCE),
  );
  assert.ok(TERMINAL_DIALOGUE_INSTRUCTION.includes(HELP_GATE_GUIDANCE));
  assert.match(HELP_GATE_GUIDANCE, /move one rung up for that facet/);
});

test("a request from before the ladder is not checked", () => {
  assert.equal(
    helpGateProblem(
      { mode: "terminal-dialogue" },
      reply(help({ gives: ["a"] })),
      true,
    ),
    undefined,
  );
});

test("free rungs and the warning always pass", () => {
  assert.equal(
    helpGateProblem(gated(), reply(help({ nudges: ["a"] })), true),
    undefined,
  );
  assert.equal(
    helpGateProblem(gated(), reply(help({ offers: ["a"] })), true),
    undefined,
  );
});

test("a hint or a given step before the warning is rejected", () => {
  assert.match(
    helpGateProblem(gated(), reply(help({ hints: ["a"] })))!,
    /was not warned about \(a\)/,
  );
  assert.match(
    helpGateProblem(gated(["b"]), reply(help({ hints: ["b"], gives: ["a"] })))!,
    /was not warned about \(a\)/,
  );
});

test("after the warning the ladder may climb, and a closing reply may restate", () => {
  assert.equal(
    helpGateProblem(gated(["a"]), reply(help({ hints: ["a"] }))),
    undefined,
  );
  assert.equal(
    helpGateProblem(gated(["a"]), reply(help({ gives: ["a"] }))),
    undefined,
  );
  // A finished question takes no more answers, so its summary may restate.
  assert.equal(
    helpGateProblem(gated(), reply(help({ gives: ["a"] }), true)),
    undefined,
  );
});

test("the relay requires the declaration; the app tolerates an older relay", () => {
  assert.match(
    helpGateProblem(gated(), reply(undefined), true)!,
    /requires help/,
  );
  assert.equal(helpGateProblem(gated(), reply(undefined)), undefined);
  assert.match(
    helpGateProblem(gated(), reply({ hints: "a" }))!,
    /requires help/,
  );
});

test("the relay's answer validation applies the ladder", () => {
  const job = { operation: "tutor", payload: gated() };
  assert.throws(
    () => validateAnswer(job, reply(help({ hints: ["a"] }))),
    /was not warned about/,
  );
  assert.throws(() => validateAnswer(job, reply(undefined)), /requires help/);
  validateAnswer(job, reply(help({ nudges: ["a"], offers: ["a"] })));
  validateAnswer(
    { operation: "tutor", payload: gated(["a"]) },
    reply(help({ gives: ["a"] })),
  );
});

test("a facet stays unlocked once any earlier tutor reply warned about it", () => {
  const messages = [
    { kind: "tutor", help: help({ nudges: ["a"] }) },
    { kind: "human" },
    { kind: "tutor", help: help({ offers: ["a"] }) },
    { kind: "human" },
    { kind: "tutor", help: help({ hints: ["a"], offers: ["b"] }) },
    // A learner message can never unlock anything, whatever it carries.
    { kind: "human", help: help({ offers: ["c"] }) },
    { kind: "tutor" },
  ];
  assert.deepEqual(unlockedHelp(messages), ["a", "b"]);
  assert.deepEqual(unlockedHelp(undefined), []);
});

test("a streamed reply stays hidden until its declaration passes", () => {
  assert.equal(helpStreamGate({ mode: "terminal-dialogue" }), undefined);
  const free = JSON.stringify(help({ nudges: ["a"] }));
  const hint = JSON.stringify(help({ hints: ["a"] }));
  const clean = helpStreamGate(gated())!;
  assert.equal(clean('{"help":{"nudges":["a"],'), false);
  assert.equal(clean(`{"help":${free},"text":"Hi`), true);
  const early = helpStreamGate(gated())!;
  assert.equal(early(`{"help":${hint},"text":"Look at`), false);
  assert.equal(early(`{"help":${hint},"text":"x"}`), false);
  // Text written before the declaration is never streamed.
  assert.equal(helpStreamGate(gated())!('{"text":"The answer is'), false);
  assert.equal(helpStreamGate(gated(["a"]))!(`{"help":${hint},`), true);
});

test("the hint choice shows only for the tutor's open warning", () => {
  const tutor = (declared?: Message["help"]) =>
    ({ kind: "tutor", ...(declared ? { help: declared } : {}) }) as Message;
  const encounter = (over: Partial<Encounter>) =>
    ({ mode: "solo", state: "open", tutor: [], ...over }) as Encounter;
  const offer = tutor(help({ offers: ["a"] }) as Message["help"]);
  assert.deepEqual(offeredHelp(encounter({ tutor: [offer] })), ["a"]);
  assert.deepEqual(offeredHelp(encounter({ tutor: [tutor()] })), []);
  assert.deepEqual(
    offeredHelp(encounter({ tutor: [offer, { kind: "human" } as Message] })),
    [],
  );
  assert.deepEqual(
    offeredHelp(encounter({ tutor: [offer], state: "consumed" })),
    [],
  );
  assert.deepEqual(
    offeredHelp(
      encounter({
        tutor: [offer],
        tutorRequests: [{ state: "pending" }] as Encounter["tutorRequests"],
      }),
    ),
    [],
  );
});
