import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Direct .mjs contract test.
import { taskInstructions, validateAnswer } from "../scripts/lib/ai-contracts.mjs"; // prettier-ignore
import {
  HELP_GATE_GUIDANCE,
  helpGateProblem,
  helpStreamGate,
} from "../scripts/lib/help-gate.mjs";
import { offeredHelp } from "../src/ai";
import { TERMINAL_DIALOGUE_INSTRUCTION } from "../src/knowledge-probe";
import type { Encounter, Message } from "../src/model";

const gated = (confirmed: string[] = []) => ({
  mode: "terminal-dialogue",
  helpPolicy: { confirmed },
});
const reply = (help: unknown, complete = false) => ({
  help,
  text: "Synthetic tutor text",
  complete,
});

test("the tutor is told about the gate on both instruction paths", () => {
  assert.ok(
    (taskInstructions("tutor", {}) as string).includes(HELP_GATE_GUIDANCE),
  );
  assert.ok(TERMINAL_DIALOGUE_INSTRUCTION.includes(HELP_GATE_GUIDANCE));
});

test("a request from before the gate is not checked", () => {
  assert.equal(
    helpGateProblem(
      { mode: "terminal-dialogue" },
      reply({ supplies: ["a"], offers: [] }),
      true,
    ),
    undefined,
  );
});

test("help the learner did not confirm is rejected", () => {
  assert.match(
    helpGateProblem(gated(), reply({ supplies: ["a"], offers: [] }))!,
    /has not confirmed \(a\)/,
  );
  assert.match(
    helpGateProblem(gated(["b"]), reply({ supplies: ["a", "b"], offers: [] }))!,
    /has not confirmed \(a\)/,
  );
});

test("an offer, confirmed help and a closing reply all pass", () => {
  assert.equal(
    helpGateProblem(gated(), reply({ supplies: [], offers: ["a"] })),
    undefined,
  );
  assert.equal(
    helpGateProblem(gated(["a"]), reply({ supplies: ["a"], offers: [] })),
    undefined,
  );
  // A finished question takes no more answers, so its summary may restate.
  assert.equal(
    helpGateProblem(gated(), reply({ supplies: ["a"], offers: [] }, true)),
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
    helpGateProblem(gated(), reply({ supplies: "a" }))!,
    /requires help/,
  );
});

test("the relay's answer validation applies the gate", () => {
  const job = { operation: "tutor", payload: gated() };
  assert.throws(
    () => validateAnswer(job, reply({ supplies: ["a"], offers: [] })),
    /has not confirmed/,
  );
  assert.throws(() => validateAnswer(job, reply(undefined)), /requires help/);
  validateAnswer(job, reply({ supplies: [], offers: ["a"] }));
  validateAnswer(
    { operation: "tutor", payload: gated(["a"]) },
    reply({ supplies: ["a"], offers: [] }),
  );
});

test("a streamed reply stays hidden until its declaration passes", () => {
  assert.equal(helpStreamGate({ mode: "terminal-dialogue" }), undefined);
  const clean = helpStreamGate(gated())!;
  assert.equal(clean('{"help":{"supplies":[],'), false);
  assert.equal(
    clean('{"help":{"supplies":[],"offers":["a"]},"text":"Hi'),
    true,
  );
  const leaking = helpStreamGate(gated())!;
  assert.equal(
    leaking('{"help":{"supplies":["a"],"offers":[]},"text":"The answer is'),
    false,
  );
  assert.equal(
    leaking('{"help":{"supplies":["a"],"offers":[]},"text":"x"}'),
    false,
  );
  // Text written before the declaration is never streamed.
  assert.equal(helpStreamGate(gated())!('{"text":"The answer is'), false);
  assert.equal(
    helpStreamGate(gated(["a"]))!('{"help":{"supplies":["a"],"offers":[]},'),
    true,
  );
});

test("the help choice shows only for the tutor's open offer", () => {
  const tutor = (help?: Message["help"]) =>
    ({ kind: "tutor", ...(help ? { help } : {}) }) as Message;
  const encounter = (over: Partial<Encounter>) =>
    ({ mode: "solo", state: "open", tutor: [], ...over }) as Encounter;
  const offer = tutor({ supplies: [], offers: ["a"] });
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
