import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createQualityDraft,
  parseQualityDraft,
  prepareQualityRun,
  retryQualityDraft,
} from "../src/run-quality-designer";
import {
  qualityContentBatches,
  type QualityFinding,
  type QualityRunDesignRequest,
} from "../src/run-quality-contract.mjs";
import { runDesignFingerprint } from "../src/run-design-contract.mjs";
import { previewDesignedRun, finalizeDesignedRun } from "../src/world";
import { encode, decode } from "../src/persistence";
import type { Roadmap } from "../src/model";
import type { RunDesignActivity } from "../src/run-design-progress";
import { environmentDesignFixture } from "./helpers/environment-design";
import { qualityFixtureReply } from "./helpers/quality-design";

const roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
) as Roadmap;
const design = environmentDesignFixture();
type Options = Parameters<typeof prepareQualityRun>[1];
type Send = Parameters<typeof prepareQualityRun>[2];
const send: Send = async (request) =>
  structuredClone(qualityFixtureReply(request, design, [design]));
function draft() {
  return createQualityDraft({
    targetRunId: "synthetic-quality-run",
    generationId: `design-${crypto.randomUUID()}`,
    seed: 42,
    recent: [],
    recentContent: [],
  });
}
function options(overrides: Partial<Options> = {}): Options {
  return {
    signal: new AbortController().signal,
    capture: () => {},
    preview: (seed, structure) =>
      previewDesignedRun(seed, roadmap, undefined, structure),
    finalize: finalizeDesignedRun,
    ...overrides,
  };
}
const phaseDrafts = new Map<string, Promise<string>>();
async function atPhase(phase: QualityRunDesignRequest["phase"]) {
  let value = phaseDrafts.get(phase);
  if (!value) {
    value = (async () => {
      const current = draft();
      await assert.rejects(
        prepareQualityRun(current, options(), async (request, ...args) => {
          if (request.phase === phase)
            throw Error("Synthetic phase checkpoint");
          if (
            phase === "content-revision" &&
            request.phase === "content-review"
          )
            return {
              requestId: request.requestId,
              findings: [finding("major", `surface:${bodyTarget(request)}`)],
            };
          return send(request, ...args);
        }),
        /Synthetic phase checkpoint/,
      );
      return JSON.stringify(parseQualityDraft(current));
    })();
    phaseDrafts.set(phase, value);
  }
  return parseQualityDraft(JSON.parse(await value));
}
function finding(priority: "major" | "minor", target = "run"): QualityFinding {
  return {
    id: "occupant-evidence",
    priority,
    target,
    problem:
      "This object does not yet communicate the occupant’s daily routine.",
    evidence:
      "Its brief title names a subject without a concrete trace of work.",
    recommendation:
      "Add a specific ordinary workplace detail that fits its owner.",
  };
}
function bodyTarget(
  request: Extract<
    QualityRunDesignRequest,
    { phase: "content-review" | "content-revision" }
  >,
) {
  return request.surfaces.find((s) => s.maxBody >= 100)!.id;
}
function revisedEntry(
  request: Extract<QualityRunDesignRequest, { phase: "content-revision" }>,
  text = "A folded lunch roster marks the afternoon shift; one pencilled name has been carefully rubbed away.",
) {
  const id = bodyTarget(request),
    entry = structuredClone(
      request.content.entries.find((e) => e.surfaceId === id)!,
    );
  entry.body = [{ text }];
  entry.layout = entry.drawing ? "mixed" : "text";
  return entry;
}

test("quality generation explores, selects, reviews and authors each coherent object batch before activating the complete world", async () => {
  const current = draft(),
    phases: string[] = [],
    captured: string[] = [],
    activities: RunDesignActivity[] = [],
    requestedStages: RunDesignActivity["stage"][] = [],
    batches = qualityContentBatches(design.environment.surfaces);
  let activations = 0,
    workingSignals = 0,
    authoredBatches = 0,
    previews = 0;
  const result = await prepareQualityRun(
    current,
    options({
      capture: (d) => {
        const parsed = parseQualityDraft(d);
        captured.push(`${parsed.request.phase}:${parsed.reviews.content.stop}`);
      },
      activity: (event) => activities.push(event),
      preview: (seed, structure) => {
        assert.equal(activities.at(-1)?.state, "checking");
        assert.equal(activities.at(-1)?.stage, "design");
        previews++;
        return previewDesignedRun(seed, roadmap, undefined, structure);
      },
      finalize: (candidate, saved) => {
        assert.equal(phases.at(-1), "content-review");
        assert.ok(captured.includes("content-review:ready"));
        assert.equal(activities.at(-1)?.state, "checking");
        assert.equal(activities.at(-1)?.stage, "review");
        activations++;
        return finalizeDesignedRun(candidate, saved);
      },
    }),
    async (request, currentDraft, signal) => {
      phases.push(request.phase);
      const started = activities.at(-1)!;
      assert.equal(
        started.state,
        "working",
        "a captured request shows work as soon as it is sent",
      );
      requestedStages.push(started.stage);
      await Promise.resolve();
      assert.equal(activities.at(-1), started);
      if (request.phase === "content-batch") {
        assert.equal(started.stage, "details");
        assert.ok(
          started.detail.includes(
            `group ${++authoredBatches} of ${batches.length}`,
          ),
          "batch progress follows the actual accepted object groups",
        );
      }
      workingSignals++;
      return send(request, currentDraft, signal);
    },
  );
  assert.deepEqual(phases, [
    "concepts",
    "selection",
    "structure",
    "structure-review",
    "content-plan",
    ...batches.map(() => "content-batch"),
    "content-review",
  ]);
  assert.ok(
    batches.length > 10,
    "hundreds of objects receive focused authoring calls",
  );
  assert.ok(batches.every((b) => b.targets.length <= 24));
  assert.equal(authoredBatches, batches.length);
  assert.equal(previews, 1);
  assert.equal(
    activities.filter((event) => event.state === "working").length,
    workingSignals,
  );
  assert.deepEqual(
    requestedStages.filter(
      (stage, index) => stage !== requestedStages[index - 1],
    ),
    ["design", "details", "review"],
    "accepted preparation transitions advance through the player-facing stages",
  );
  assert.equal(activations, 1);
  assert.deepEqual(result.saved.design, design);
  const game = result.game as ReturnType<typeof finalizeDesignedRun>;
  assert.deepEqual(decode(encode(game)).design, result.saved);
});

test("mid-batch interruption and reload keep accepted objects and the exact current packet without rerolling", async () => {
  const current = await atPhase("content-batch");
  let batches = 0,
    frozen = "",
    durable = "";
  await assert.rejects(
    prepareQualityRun(
      current,
      options({
        capture: (d) => {
          durable = JSON.stringify(parseQualityDraft(d));
        },
      }),
      async (request, ...args) => {
        if (request.phase === "content-batch" && ++batches === 2) {
          frozen = JSON.stringify(request);
          throw Error("Synthetic dropped batch transport");
        }
        return send(request, ...args);
      },
    ),
    /dropped batch transport/,
  );
  const restored = parseQualityDraft(JSON.parse(durable));
  assert.equal(restored.request.phase, "content-batch");
  assert.ok(
    "content" in restored.request &&
      restored.request.content.entries.length > 0,
  );
  let first = true;
  const result = await prepareQualityRun(
    restored,
    options(),
    async (request, ...args) => {
      if (first) {
        assert.equal(JSON.stringify(request), frozen);
        first = false;
      }
      assert.notEqual(request.phase, "structure");
      return send(request, ...args);
    },
  );
  assert.deepEqual(result.saved.design, design);
});

test("cross-batch duplication produces a targeted repair without replacing already accepted writing", async () => {
  const current = await atPhase("content-batch");
  let injected = false,
    repaired = false,
    accepted = "",
    targetRequest = "";
  const result = await prepareQualityRun(
    current,
    options(),
    async (request, ...args) => {
      const value = (await send(request, ...args)) as {
        requestId: string;
        entries?: any[];
      };
      if (request.phase !== "content-batch" || !value.entries) return value;
      if (request.repair) {
        repaired = true;
        assert.notEqual(request.requestId, targetRequest);
        assert.equal(JSON.stringify(request.content), accepted);
        assert.match(
          request.repair.errors.join(" "),
          /Distinct writing|duplicate|near-copy/i,
        );
        return value;
      }
      if (!injected && request.content.entries.length) {
        const source = request.content.entries.find((e) =>
          e.title.some((p) => "text" in p && p.text.length >= 12),
        );
        const destination =
          source &&
          value.entries.find((e) => {
            const slot = request.surfaces.find((s) => s.id === e.surfaceId)!;
            return (
              slot.maxTitle >=
              source.title.map((p) => ("text" in p ? p.text : "")).join("")
                .length
            );
          });
        if (source && destination) {
          injected = true;
          accepted = JSON.stringify(request.content);
          targetRequest = request.requestId;
          destination.title = structuredClone(source.title);
          destination.body = [];
          destination.drawing = null;
          destination.description = "";
          destination.layout = "text";
        }
      }
      return value;
    },
  );
  assert.ok(injected && repaired);
  assert.deepEqual(result.saved.design, design);
});

test("a reviewed targeted revision changes only its identified object, survives reload and receives a new global review", async () => {
  const current = await atPhase("content-review"),
    original = JSON.stringify(design.environment.entries);
  let durable = "",
    frozen = "";
  await assert.rejects(
    prepareQualityRun(
      current,
      options({
        capture: (d) => {
          durable = JSON.stringify(parseQualityDraft(d));
        },
      }),
      async (request) => {
        if (request.phase === "content-review")
          return {
            requestId: request.requestId,
            findings: [finding("major", `surface:${bodyTarget(request)}`)],
          };
        if (request.phase === "content-revision") {
          frozen = JSON.stringify(request);
          throw Error("Synthetic pending revision");
        }
        throw Error("Unexpected quality phase");
      },
    ),
    /pending revision/,
  );
  const restored = parseQualityDraft(JSON.parse(durable));
  let revisions = 0,
    reviews = 0,
    target = "";
  const result = await prepareQualityRun(
    restored,
    options(),
    async (request) => {
      if (request.phase === "content-revision") {
        assert.equal(JSON.stringify(request), frozen);
        revisions++;
        const entry = revisedEntry(request);
        target = entry.surfaceId;
        return { requestId: request.requestId, entries: [entry] };
      }
      assert.equal(request.phase, "content-review");
      reviews++;
      return { requestId: request.requestId, findings: [] };
    },
  );
  assert.equal(revisions, 1);
  assert.equal(reviews, 1);
  assert.equal(result.saved.design.version, 3);
  if (result.saved.design.version !== 3) return;
  assert.deepEqual(
    result.saved.design.environment.surfaces,
    design.environment.surfaces,
  );
  assert.deepEqual(
    result.saved.design.environment.entries.filter(
      (e) => e.surfaceId !== target,
    ),
    JSON.parse(original).filter((e: any) => e.surfaceId !== target),
  );
  assert.notDeepEqual(
    result.saved.design.environment.entries.find((e) => e.surfaceId === target),
    design.environment.entries.find((e) => e.surfaceId === target),
  );
});

test("two no-op minor revisions stop at the last reviewed valid content instead of wasting calls", async () => {
  const current = await atPhase("content-review");
  let revisions = 0;
  const result = await prepareQualityRun(
    current,
    options(),
    async (request) => {
      if (request.phase === "content-review")
        return {
          requestId: request.requestId,
          findings: [finding("minor", `surface:${bodyTarget(request)}`)],
        };
      assert.equal(request.phase, "content-revision");
      if (request.phase !== "content-revision") throw Error("Unexpected phase");
      revisions++;
      return {
        requestId: request.requestId,
        entries: [
          request.content.entries.find(
            (e) => e.surfaceId === bodyTarget(request),
          ),
        ],
      };
    },
  );
  assert.equal(revisions, 2);
  assert.equal(current.reviews.content.stop, "plateau");
  assert.deepEqual(result.saved.design, design);
});

test("major no-op findings pause durably and explicit Retry keeps the exact repair and accepted content", async () => {
  const current = await atPhase("content-review");
  let revisions = 0,
    durable = "";
  await assert.rejects(
    prepareQualityRun(
      current,
      options({
        capture: (d) => {
          durable = JSON.stringify(parseQualityDraft(d));
        },
        finalize: () =>
          assert.fail("Unresolved major findings cannot activate a run"),
      }),
      async (request) => {
        if (request.phase === "content-review")
          return {
            requestId: request.requestId,
            findings: [finding("major", `surface:${bodyTarget(request)}`)],
          };
        if (request.phase !== "content-revision")
          throw Error("Unexpected phase");
        revisions++;
        return {
          requestId: request.requestId,
          entries: [
            request.content.entries.find(
              (e) => e.surfaceId === bodyTarget(request),
            ),
          ],
        };
      },
    ),
    /material issue/,
  );
  assert.equal(revisions, 2);
  const restored = parseQualityDraft(JSON.parse(durable)),
    frozen = JSON.stringify(restored.request);
  assert.equal(restored.exhausted, true);
  await assert.rejects(
    prepareQualityRun(restored, options(), async () =>
      assert.fail("Reload must not reset an exhausted loop"),
    ),
    /material issue/,
  );
  retryQualityDraft(restored);
  assert.equal(JSON.stringify(restored.request), frozen);
  const result = await prepareQualityRun(
    restored,
    options(),
    async (request) => {
      if (request.phase === "content-revision")
        return {
          requestId: request.requestId,
          entries: [revisedEntry(request)],
        };
      return { requestId: request.requestId, findings: [] };
    },
  );
  assert.equal(result.saved.design.version, 3);
  assert.equal(restored.reviews.content.stop, "ready");
});

test("cycling revisions cannot replace the last valid candidate with a previously rejected version", async () => {
  const current = await atPhase("content-review");
  let revisions = 0;
  await assert.rejects(
    prepareQualityRun(
      current,
      options({
        finalize: () => assert.fail("A cycling major issue must pause"),
      }),
      async (request) => {
        if (request.phase === "content-review")
          return {
            requestId: request.requestId,
            findings: [finding("major", `surface:${bodyTarget(request)}`)],
          };
        if (request.phase !== "content-revision")
          throw Error("Unexpected phase");
        revisions++;
        return {
          requestId: request.requestId,
          entries: [
            revisions === 1
              ? revisedEntry(request)
              : design.environment.entries.find(
                  (e) => e.surfaceId === bodyTarget(request),
                ),
          ],
        };
      },
    ),
    /material issue/,
  );
  assert.ok(revisions >= 2 && revisions <= 3);
  assert.equal(current.request.phase, "content-revision");
  if (current.request.phase === "content-revision")
    assert.match(
      JSON.stringify(
        current.request.content.entries.find(
          (e) =>
            e.surfaceId ===
            bodyTarget(
              current.request as Extract<
                QualityRunDesignRequest,
                { phase: "content-revision" }
              >,
            ),
        ),
      ),
      /folded lunch roster/,
    );
});

test("a structural review refines real geometry before any environmental work, and repeated major no-ops pause", async () => {
  const current = await atPhase("structure-review");
  let revisions = 0;
  await assert.rejects(
    prepareQualityRun(current, options(), async (request, ...args) => {
      if (request.phase === "structure-review")
        return {
          requestId: request.requestId,
          findings: [finding("major", "room:0:2")],
        };
      assert.equal(request.phase, "structure");
      revisions++;
      return send(request, ...args);
    }),
    /material issue/,
  );
  assert.equal(revisions, 2);
  assert.equal(current.request.phase, "structure");
  assert.equal(current.exhausted, true);
  assert.equal(current.reviews.content.rounds, 0);
});

test("repeated hard geometry failures capture a fresh exhausted repair atomically", async () => {
  const current = await atPhase("structure");
  let failures = 0;
  const captures: { id: string; exhausted: boolean; repeats: number }[] = [];
  await assert.rejects(
    prepareQualityRun(
      current,
      options({
        preview: () => {
          failures++;
          throw Error("Synthetic inaccessible terminal");
        },
        capture: (d) => {
          parseQualityDraft(d);
          captures.push({
            id: d.request.requestId,
            exhausted: d.exhausted,
            repeats: d.failure.repeats,
          });
        },
      }),
      send,
    ),
    /invalid result|further repair/,
  );
  assert.equal(failures, 2);
  assert.equal(current.exhausted, true);
  const fresh = captures.filter((c) => c.id === current.request.requestId);
  assert.ok(fresh.length && fresh.every((c) => c.exhausted && c.repeats === 2));
  await assert.rejects(
    prepareQualityRun(parseQualityDraft(current), options(), async () =>
      assert.fail("Exhausted replay cannot send"),
    ),
    /invalid result|further repair/,
  );
});

test("a rejected structural refinement keeps the reviewed valid baseline and its original actionable findings", async () => {
  const current = await atPhase("structure-review"),
    issue = finding("minor", "room:0:2");
  let revisions = 0,
    sawRejectedFeedback = false;
  const result = await prepareQualityRun(
    current,
    options({
      preview: (seed, structure) => {
        if (structure.title === "Blocked revised building")
          throw Error("Synthetic revised furniture blocks a terminal");
        return previewDesignedRun(seed, roadmap, undefined, structure);
      },
      finalize: (candidate, saved) => {
        assert.equal(saved.design.title, design.title);
        return finalizeDesignedRun(candidate, saved);
      },
    }),
    async (request, ...args) => {
      if (request.phase === "structure-review")
        return { requestId: request.requestId, findings: [issue] };
      const response = (await send(request, ...args)) as {
        requestId: string;
        structure?: any;
      };
      if (request.phase === "structure") {
        revisions++;
        if (revisions === 1)
          response.structure.title = "Blocked revised building";
        else {
          assert.equal(request.repair!.candidate.title, design.title);
          if (revisions === 2) {
            const feedback = request.repair!.errors.join(" ");
            assert.match(
              feedback,
              /captured candidate is the last valid reviewed building/,
            );
            assert.ok(feedback.includes(issue.problem));
            assert.match(
              feedback,
              /Rejected revision: Synthetic revised furniture blocks a terminal/,
            );
            sawRejectedFeedback = true;
          }
        }
      }
      return response;
    },
  );
  assert.equal(revisions, 3);
  assert.equal(sawRejectedFeedback, true);
  assert.equal(current.reviews.structure.stop, "plateau");
  assert.deepEqual(result.saved.design, design);
});

test("cancellation after each new authoring phase prevents every dependent request and activation", async () => {
  for (const phase of [
    "concepts",
    "selection",
    "structure",
    "structure-review",
    "content-plan",
    "content-batch",
    "content-review",
    "content-revision",
  ] as const) {
    const current = await atPhase(phase),
      controller = new AbortController();
    let sends = 0;
    await assert.rejects(
      prepareQualityRun(
        current,
        options({
          signal: controller.signal,
          finalize: () => assert.fail("Cancelled quality work cannot activate"),
        }),
        async (request, ...args) => {
          sends++;
          const response =
            request.phase === "content-revision"
              ? {
                  requestId: request.requestId,
                  entries: [revisedEntry(request)],
                }
              : await send(request, ...args);
          controller.abort();
          return response;
        },
      ),
      /abort/i,
    );
    assert.equal(sends, 1, phase);
  }
});

test("recent-run copied prose is repaired before the full content can reach editorial approval", async () => {
  const current = await atPhase("content-batch");
  assert.equal(current.request.phase, "content-batch");
  if (current.request.phase !== "content-batch") return;
  const target = current.request.targets.find((id) => {
    const e = design.environment.entries.find(
      (entry) => entry.surfaceId === id,
    )!;
    return e.title.some((p) => "text" in p && p.text.length >= 12);
  })!;
  assert.ok(target);
  const title = design.environment.entries
    .find((e) => e.surfaceId === target)!
    .title.map((p) => ("text" in p ? p.text : ""))
    .join("");
  current.request.recentContent = [
    {
      fingerprint: "0123456789abcdef",
      phrases: [title],
      art: [],
      artDescriptions: [],
    },
  ];
  let attempts = 0;
  const result = await prepareQualityRun(
    current,
    options(),
    async (request, ...args) => {
      const response = (await send(request, ...args)) as {
        requestId: string;
        entries?: any[];
      };
      if (
        request.phase === "content-batch" &&
        request.targets.includes(target)
      ) {
        attempts++;
        if (request.repair) {
          assert.match(request.repair.errors.join(" "), /recent-run writing/);
          const entry = response.entries!.find((e) => e.surfaceId === target);
          entry.title = [{ text: "Unposted coastal receipts" }];
        }
      }
      return response;
    },
  );
  assert.equal(attempts, 2);
  assert.equal(result.saved.design.version, 3);
  if (result.saved.design.version === 3)
    assert.deepEqual(
      result.saved.design.environment.entries.find(
        (e) => e.surfaceId === target,
      )!.title,
      [{ text: "Unposted coastal receipts" }],
    );
});

test("repeated invalid batches pause without discarding earlier content and can resume after explicit Retry", async () => {
  const current = await atPhase("content-batch");
  let attempts = 0;
  await assert.rejects(
    prepareQualityRun(current, options(), async (request, ...args) => {
      const response = (await send(request, ...args)) as {
        requestId: string;
        entries?: any[];
      };
      if (request.phase === "content-batch") {
        attempts++;
        response.entries![0].surfaceId = "unknown-surface";
      }
      return response;
    }),
    /invalid result|further repair/,
  );
  assert.equal(attempts, 2);
  const restored = parseQualityDraft(current),
    exact = JSON.stringify(restored.request);
  retryQualityDraft(restored);
  assert.equal(JSON.stringify(restored.request), exact);
  parseQualityDraft(restored);
  const result = await prepareQualityRun(restored, options(), send);
  assert.deepEqual(result.saved.design, design);
});

test("the generous emergency review guard stops endless distinct minor suggestions without accepting a major finding", async () => {
  const current = await atPhase("content-review");
  let reviews = 0,
    revisions = 0;
  const details = [
    "breakfast",
    "inventory",
    "weather",
    "gardening",
    "birthdays",
    "commuting",
    "repairs",
    "recipes",
  ];
  const result = await prepareQualityRun(
    current,
    options(),
    async (request) => {
      if (request.phase === "content-review") {
        const issue = finding("minor", `surface:${bodyTarget(request)}`);
        issue.problem = `The occupant’s ${details[reviews++]} routine could be clearer.`;
        return { requestId: request.requestId, findings: [issue] };
      }
      if (request.phase !== "content-revision") throw Error("Unexpected phase");
      const entry = revisedEntry(
        request,
        `A ${details[revisions++]} list lies beneath a brass weight; the last handwritten item is crossed out.`,
      );
      return { requestId: request.requestId, entries: [entry] };
    },
  );
  assert.equal(reviews, 8);
  assert.equal(revisions, 7);
  assert.equal(current.reviews.content.stop, "plateau");
  assert.equal(result.saved.design.version, 3);
});

test("a failed batch transition capture releases no batch, and a failed final approval capture cannot activate on retry", async () => {
  const current = await atPhase("content-plan");
  let sends = 0;
  await assert.rejects(
    prepareQualityRun(
      current,
      options({
        capture: (d) => {
          if (d.request.phase === "content-batch")
            throw Error("Synthetic batch storage failure");
        },
      }),
      async (...args) => {
        sends++;
        return send(...args);
      },
    ),
    /batch storage failure/,
  );
  assert.equal(sends, 1);
  const final = await atPhase("content-review");
  let activations = 0,
    replies = 0;
  const blocked = options({
    capture: (d) => {
      if (d.reviews.content.stop === "ready")
        throw Error("Synthetic approval storage failure");
    },
    finalize: () => {
      activations++;
      return assert.fail("Uncaptured approval cannot activate");
    },
  });
  await assert.rejects(
    prepareQualityRun(final, blocked, async (...args) => {
      replies++;
      return send(...args);
    }),
    /approval storage failure/,
  );
  await assert.rejects(
    prepareQualityRun(final, blocked, async () =>
      assert.fail("Accepted review need not be regenerated"),
    ),
    /approval storage failure/,
  );
  assert.equal(activations, 0);
  assert.equal(replies, 1);
  const restored = parseQualityDraft(final);
  const result = await prepareQualityRun(restored, options(), async () =>
    assert.fail("Retry captures the exact reviewed result"),
  );
  assert.deepEqual(result.saved.design, design);
});

test("changed builders and tampered approval fingerprints cannot silently rebind or approve content", async () => {
  const current = await atPhase("content-review");
  await assert.rejects(
    prepareQualityRun(
      current,
      options({
        preview: (seed, structure) => ({
          ...previewDesignedRun(seed, roadmap, undefined, structure),
          builderVersion: "different-builder",
        }),
      }),
      async () =>
        assert.fail("Incompatible inventory must stop before transport"),
    ),
    /inventory no longer matches/,
  );
  const malformed = structuredClone(current);
  malformed.reviews.content.rounds = 1;
  malformed.reviews.content.stop = "ready";
  malformed.reviews.content.approvedFingerprint =
    runDesignFingerprint("another candidate");
  assert.throws(
    () => parseQualityDraft(malformed),
    /approval no longer matches/,
  );
  assert.throws(() => parseQualityDraft({ ...current, attempts: 0 }), /budget/);
});

test("a failed final world check pauses durably and Retry preserves the approved review", async () => {
  const current = await atPhase("content-review");
  let durable = "",
    finalizations = 0,
    sends = 0;
  await assert.rejects(
    prepareQualityRun(
      current,
      options({
        capture: (d) => {
          durable = JSON.stringify(parseQualityDraft(d));
        },
        finalize: () => {
          finalizations++;
          throw Error("Synthetic final environment binding failure");
        },
      }),
      async (...args) => {
        sends++;
        return send(...args);
      },
    ),
    /final saved world could not be prepared: Synthetic final environment binding failure/,
  );
  assert.equal(sends, 1);
  assert.equal(finalizations, 1);
  const restored = parseQualityDraft(JSON.parse(durable));
  assert.equal(restored.exhausted, true);
  assert.equal(restored.reviews.content.stop, "ready");
  assert.match(
    restored.pauseReason,
    /Synthetic final environment binding failure/,
  );
  retryQualityDraft(restored);
  assert.equal(restored.exhausted, false);
  assert.equal(restored.reviews.content.stop, "ready");
  const result = await prepareQualityRun(restored, options(), async () =>
    assert.fail("The approved review must not be delivered again"),
  );
  assert.deepEqual(result.saved.design, design);
});

test("an approved older draft with repeated art repairs only the later surface before a fresh review", async () => {
  const current = await atPhase("content-review");
  assert.equal(current.request.phase, "content-review");
  if (current.request.phase !== "content-review") return;
  const illustrated = current.request.content.entries.filter((e) => e.drawing),
    [earlier, later] = illustrated;
  assert.ok(earlier && later);
  later.drawing = structuredClone(earlier.drawing);
  const approvedContent = structuredClone(current.request.content);
  current.reviews.content.rounds = 1;
  current.reviews.content.stop = "ready";
  current.reviews.content.approvedFingerprint =
    runDesignFingerprint(approvedContent);
  // This has the exact shape of a durable draft approved before the new
  // within-run art check. Historical parsing still accepts its content.
  const restored = parseQualityDraft(JSON.parse(JSON.stringify(current)));
  const phases: string[] = [];
  let revisionCaptured = false;
  const result = await prepareQualityRun(
    restored,
    options({
      capture: (d) => {
        const saved = parseQualityDraft(d);
        if (saved.request.phase === "content-revision") {
          revisionCaptured = true;
          assert.equal(saved.reviews.content.stop, "pending");
          assert.equal(saved.reviews.content.approvedFingerprint, null);
          assert.deepEqual(saved.request.content, approvedContent);
          assert.deepEqual(
            saved.request.findings.map((f) => f.target),
            [`surface:${later.surfaceId}`],
          );
        }
      },
    }),
    async (request) => {
      phases.push(request.phase);
      if (request.phase === "content-revision") {
        assert.deepEqual(request.content, approvedContent);
        assert.deepEqual(
          request.findings.map((f) => f.target),
          [`surface:${later.surfaceId}`],
        );
        // The usual fixture reply echoes revisions. This response simulates
        // an author replacing only the duplicate with its original artwork.
        return {
          requestId: request.requestId,
          entries: [
            structuredClone(
              design.environment.entries.find(
                (entry) => entry.surfaceId === later.surfaceId,
              )!,
            ),
          ],
        };
      }
      if (request.phase === "content-review") {
        assert.deepEqual(
          request.content.entries.filter(
            (e) => e.surfaceId !== later.surfaceId,
          ),
          approvedContent.entries.filter(
            (e) => e.surfaceId !== later.surfaceId,
          ),
        );
        assert.deepEqual(
          request.content.entries.find((e) => e.surfaceId === later.surfaceId),
          design.environment.entries.find(
            (e) => e.surfaceId === later.surfaceId,
          ),
        );
        return { requestId: request.requestId, findings: [] };
      }
      assert.fail(`Unexpected phase ${request.phase}`);
    },
  );
  assert.equal(revisionCaptured, true);
  assert.deepEqual(phases, ["content-revision", "content-review"]);
  assert.deepEqual(result.saved.design, design);
});
