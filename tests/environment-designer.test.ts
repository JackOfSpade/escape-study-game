import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  newAuthoredDesignDraft as newDesignDraft,
  parseDesignDraft,
  prepareDesignedRun,
  retryDesignDraft,
  type AuthoredDesignDraft,
  type DesignOptions,
} from "../src/run-designer";
import {
  environmentSurfaceFingerprint,
  type EnvironmentContent,
  type RunDesignRequest,
} from "../src/run-design-contract.mjs";
import { previewDesignedRun, finalizeDesignedRun } from "../src/world";
import { decode, encode } from "../src/persistence";
import type { Game, Roadmap } from "../src/model";
import {
  environmentDesignFixture,
  environmentStructureFixture,
} from "./helpers/environment-design";

const roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
) as Roadmap;
function contentFixture(): EnvironmentContent {
  const { surfaces: _surfaces, ...content } =
    environmentDesignFixture().environment;
  return content;
}
function options(
  overrides: Partial<DesignOptions<Game>> = {},
): DesignOptions<Game> {
  return {
    signal: new AbortController().signal,
    capture: () => {},
    build: () => assert.fail("A fresh run must complete both authoring phases"),
    preview: (seed, structure) =>
      previewDesignedRun(seed, roadmap, undefined, structure),
    finalize: finalizeDesignedRun,
    send: async (request) => {
      assert.equal(request.version, 2);
      if (request.version !== 2) throw Error("Unexpected legacy request");
      return request.phase === "structure"
        ? {
            requestId: request.requestId,
            structure: environmentStructureFixture(),
          }
        : { requestId: request.requestId, content: contentFixture() };
    },
    ...overrides,
  };
}

test("a fresh run captures structure then every real object before accepting complete writing and artwork", async () => {
  const draft = newDesignDraft("synthetic-run", 42, [], []),
    captures: AuthoredDesignDraft[] = [],
    requests: RunDesignRequest[] = [];
  let accepted = 0;
  const defaults = options();
  const result = await prepareDesignedRun(
    draft,
    options({
      capture: (d) => {
        assert.equal(d.version, 2);
        captures.push(structuredClone(d) as AuthoredDesignDraft);
      },
      send: async (...args) => {
        requests.push(structuredClone(args[0]));
        return defaults.send!(...args);
      },
      finalize: (candidate, saved) => {
        accepted++;
        return finalizeDesignedRun(candidate, saved);
      },
    }),
  );
  assert.deepEqual(
    requests.map((r) => r.version === 2 && r.phase),
    ["structure", "content"],
  );
  assert.equal(accepted, 1);
  assert.notEqual(requests[0].requestId, requests[1].requestId);
  assert.equal(requests[0].generationId, requests[1].generationId);
  const pending = captures.find((d) => d.request.phase === "content")!;
  assert.ok(pending && pending.request.phase === "content");
  assert.deepEqual(
    pending.request.surfaces,
    environmentDesignFixture().environment.surfaces,
  );
  assert.equal(
    pending.request.surfaceFingerprint,
    environmentSurfaceFingerprint(pending.request.surfaces),
  );
  assert.equal(result.saved.design.version, 3);
  assert.deepEqual(result.saved.design, environmentDesignFixture());
  assert.deepEqual(decode(encode(result.game)).design, result.saved);
});

test("a content transport interruption and reload resume the same captured packet without rerolling structure", async () => {
  const draft = newDesignDraft("synthetic-run", 42, [], []),
    defaults = options();
  let captured = "",
    frozen = "";
  await assert.rejects(
    prepareDesignedRun(
      draft,
      options({
        capture: (d) => {
          captured = JSON.stringify(d);
        },
        send: async (...args) => {
          const request = args[0];
          if (request.version === 2 && request.phase === "content") {
            frozen = JSON.stringify(request);
            throw Error("Synthetic bridge interruption");
          }
          return defaults.send!(...args);
        },
      }),
    ),
    /bridge interruption/,
  );
  const restored = parseDesignDraft(JSON.parse(captured));
  assert.equal(restored.version, 2);
  let calls = 0;
  const result = await prepareDesignedRun(
    restored,
    options({
      send: async (...args) => {
        calls++;
        assert.equal(JSON.stringify(args[0]), frozen);
        return defaults.send!(...args);
      },
    }),
  );
  assert.equal(calls, 1);
  assert.equal(result.saved.design.version, 3);
});

test("content repair preserves the building and inventory while replacing a duplicate passage", async () => {
  const draft = newDesignDraft("synthetic-run", 42, [], []),
    defaults = options(),
    calls: any[] = [];
  let contentCalls = 0;
  const result = await prepareDesignedRun(
    draft,
    options({
      send: async (...args) => {
        const request = args[0];
        if (request.version !== 2 || request.phase !== "content")
          return defaults.send!(...args);
        calls.push(structuredClone(request));
        const content = contentFixture();
        if (++contentCalls === 1) {
          const eligible = new Set(
            request.surfaces.filter((s) => s.maxBody >= 80).map((s) => s.id),
          );
          const targets = content.entries
            .filter((e) => eligible.has(e.surfaceId))
            .slice(0, 2);
          assert.equal(targets.length, 2);
          for (const entry of targets)
            entry.body = [
              { text: "The visitor ledger stayed beside the copper umbrella." },
            ];
        }
        return { requestId: request.requestId, content };
      },
    }),
  );
  assert.equal(contentCalls, 2);
  assert.match(calls[1].repair.errors.join(" "), /Distinct writing required/);
  assert.notEqual(calls[0].requestId, calls[1].requestId);
  assert.deepEqual(calls[0].structure, calls[1].structure);
  assert.deepEqual(calls[0].surfaces, calls[1].surfaces);
  assert.equal(calls[0].surfaceFingerprint, calls[1].surfaceFingerprint);
  assert.equal(result.saved.design.version, 3);
});

test("a saved exhausted phase cannot gain more automatic attempts through reload; explicit Retry retains its repair", async () => {
  const draft = newDesignDraft("synthetic-run", 42, [], []);
  let calls = 0;
  await assert.rejects(
    prepareDesignedRun(
      draft,
      options({
        send: async (request) => {
          calls++;
          return {
            requestId: request.requestId,
            structure: environmentStructureFixture(),
          };
        },
        preview: () => {
          throw Error("Synthetic unreachable terminal");
        },
      }),
    ),
    /three attempts/,
  );
  assert.equal(calls, 3);
  assert.equal(draft.exhausted, true);
  const frozen = JSON.stringify(draft.request),
    restored = parseDesignDraft(JSON.parse(JSON.stringify(draft)));
  await assert.rejects(
    prepareDesignedRun(
      restored,
      options({
        send: async () => assert.fail("Reload must not reset the budget"),
      }),
    ),
    /three attempts/,
  );
  retryDesignDraft(restored);
  assert.equal(JSON.stringify(restored.request), frozen);
  assert.equal(
    (await prepareDesignedRun(restored, options())).saved.design.version,
    3,
  );
});

test("cancelled content cannot accept a run and a failed phase capture sends no content request", async () => {
  const draft = newDesignDraft("synthetic-run", 42, [], []),
    defaults = options(),
    controller = new AbortController();
  let accepted = false;
  await assert.rejects(
    prepareDesignedRun(
      draft,
      options({
        signal: controller.signal,
        send: async (...args) => {
          if (args[0].version === 2 && args[0].phase === "content")
            controller.abort();
          return defaults.send!(...args);
        },
        finalize: () => {
          accepted = true;
          return assert.fail("Cancelled content must not be accepted");
        },
      }),
    ),
    /abort/i,
  );
  assert.equal(accepted, false);
  const next = newDesignDraft("another-run", 42, [], []);
  let sends = 0;
  await assert.rejects(
    prepareDesignedRun(
      next,
      options({
        capture: (d) => {
          if (d.request.version === 2 && d.request.phase === "content")
            throw Error("Synthetic storage failure");
        },
        send: async (...args) => {
          sends++;
          return defaults.send!(...args);
        },
      }),
    ),
    /storage failure/,
  );
  assert.equal(sends, 1);
  assert.equal(next.request.phase, "content");
  assert.equal(next.attempts.content, 1);
});

test("a pending inventory from an incompatible builder cannot be silently rebound", async () => {
  const draft = newDesignDraft("synthetic-run", 42, [], []),
    defaults = options();
  await assert.rejects(
    prepareDesignedRun(
      draft,
      options({
        send: async (...args) => {
          if (args[0].version === 2 && args[0].phase === "content")
            throw Error("stop at content");
          return defaults.send!(...args);
        },
      }),
    ),
    /stop at content/,
  );
  assert.ok(draft.request.phase === "content");
  draft.request.builderVersion = "future-environment-version";
  await assert.rejects(
    prepareDesignedRun(
      parseDesignDraft(JSON.parse(JSON.stringify(draft))),
      options({
        send: async () => assert.fail("Do not release stale object bindings"),
      }),
    ),
    /no longer matches/,
  );
});
