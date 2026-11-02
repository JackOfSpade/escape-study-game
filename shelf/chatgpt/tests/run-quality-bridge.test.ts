import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-expect-error Direct .mjs transport integration, validated at runtime.
import { createHandoffQueue } from "../scripts/chatgpt-handoff-queue.mjs";
// @ts-expect-error Direct .mjs native relay integration.
import * as relay from "../scripts/terminal-relay-app.mjs";
import {
  newDesignDraft,
  parseDesignDraft,
  prepareDesignedRun,
} from "../src/run-designer";
import { previewDesignedRun, finalizeDesignedRun } from "../src/world";
import { environmentDesignFixture } from "./helpers/environment-design";
import { qualityFixtureReply } from "./helpers/quality-design";
import { qualityContentBatches } from "../src/run-quality-contract.mjs";
const { createTerminalRelayApp, PROMPT_LIMIT } = relay;

test("the real native relay carries every quality stage, exact chunks and bound continuation before a complete run can activate", async () => {
  const queue = createHandoffQueue(),
    app = createTerminalRelayApp({ queue, continuationWaitMs: 5 }),
    owner = { linkId: "synthetic-quality-owner" },
    design = environmentDesignFixture(),
    roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8")),
    draft = newDesignDraft("quality-bridge-synthetic", 42, [], []),
    phases: string[] = [],
    requestIds = new Set<string>();
  queue.enable(true);
  let after: any,
    chunked = 0,
    finalized = false;
  const result = await prepareDesignedRun(draft, {
    signal: new AbortController().signal,
    capture: (value) => {
      assert.deepEqual(
        parseDesignDraft(JSON.parse(JSON.stringify(value))),
        value,
      );
    },
    build: () => assert.fail("Quality generation cannot use legacy activation"),
    preview: (seed, structure) =>
      previewDesignedRun(seed, roadmap, undefined, structure),
    finalize: (candidate, saved) => {
      assert.equal(phases.at(-1), "content-review");
      finalized = true;
      return finalizeDesignedRun(candidate, saved);
    },
    send: async (request) => {
      assert.equal(finalized, false);
      assert.equal(request.version, 3);
      if (request.version !== 3) throw Error("Unexpected legacy request");
      assert.equal(requestIds.has(request.requestId), false);
      requestIds.add(request.requestId);
      phases.push(request.phase);
      const scope = { runId: request.generationId, encounterId: "run-design" },
        receipt = queue.enqueue("design-run", request, scope, draft.chatCode),
        turn = (
          await app.call(
            "get_current_study_question",
            {
              chat: draft.chatCode,
              ...(after ? { after } : {}),
            },
            owner,
          )
        ).structuredContent;
      assert.equal(turn.jobFingerprint, receipt.hash);
      assert.deepEqual(turn.nativeScope, scope);
      assert.ok(turn.prompt.length <= PROMPT_LIMIT);
      assert.match(turn.prompt, /One captured stage/);
      const response = qualityFixtureReply(request, design, [design]);
      const finish = (answer: any) =>
        app.call(
          "finish_study_preparation",
          {
            relayId: turn.relayId,
            turnId: turn.turnId,
            jobFingerprint: turn.jobFingerprint,
            response: JSON.stringify(answer),
          },
          owner,
        ).structuredContent;
      if (turn.prompt.includes('"omitted":["payload"]')) {
        chunked++;
        assert.throws(() => finish(response), /Read every/);
        const read = (index: number) =>
          app.call(
            "read_study_terminal_context",
            {
              chat: draft.chatCode,
              relayId: turn.relayId,
              turnId: turn.turnId,
              part: "payload",
              index,
            },
            owner,
          ).structuredContent;
        const first = read(0),
          parts = [first.text];
        for (let index = 1; index < first.parts; index++)
          parts.push(read(index).text);
        assert.equal(parts.join(""), JSON.stringify(request));
      }
      assert.throws(
        () => finish({ ...response, requestId: "design-stale-stage" }),
        /requestId/,
      );
      assert.throws(
        () => finish({ ...response, study: "unsupported private field" }),
        /unknown field/,
      );
      const completed = finish(response);
      assert.equal(completed.completion.status, "sent");
      assert.equal(finish(response).completion.duplicate, true);
      after = completed.completion.continuation.after;
      assert.ok(after);
      return queue.result(receipt.id, receipt.hash).answer;
    },
  });
  assert.deepEqual(phases, [
    "concepts",
    "selection",
    "structure",
    "structure-review",
    "content-plan",
    ...qualityContentBatches(design.environment.surfaces).map(
      () => "content-batch",
    ),
    "content-review",
  ]);
  assert.ok(chunked > 1);
  assert.equal(finalized, true);
  assert.deepEqual(result.saved.design, design);
});
