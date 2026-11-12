import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Local .mjs module is exercised directly without a declaration shim.
import { taskProfile } from "../scripts/claude-gateway.mjs";
import {
  CASES_FILE,
  runDesignArm,
  type DesignGatewayFactory,
  type DesignGatewayOptions,
} from "../scripts/ai-capture/design-arm";
import { environmentDesignFixture } from "./helpers/environment-design";
import { qualityFixtureReply } from "./helpers/quality-design";

const design = environmentDesignFixture();
const store = () => mkdtempSync(join(tmpdir(), "design-arm-"));
const NOW = Date.UTC(2026, 10, 11);
/** The synthetic fixture covers the surfaces this seed's preview generates. */
const SEED = 42;

/** A gateway double: canned stage answers through the arm's usage sink. */
function fakeFactory({ fail = false } = {}) {
  const arms: {
    options: DesignGatewayOptions;
    phases: string[];
    profiles: any[];
  }[] = [];
  const factory: DesignGatewayFactory = (options) => {
    const arm = { options, phases: [] as string[], profiles: [] as any[] };
    arms.push(arm);
    return {
      run: async (operation, payload: any) => {
        assert.equal(operation, "design-run");
        const profile = options.profileFor(operation, payload);
        arm.phases.push(payload.phase);
        arm.profiles.push(profile);
        options.usageLog({
          v: 1,
          at: new Date(NOW).toISOString(),
          operation,
          phase: payload.phase,
          attempt: 0,
          alias: profile.model,
          effort: profile.effort,
          model: `claude-${profile.model}-5-5`,
          costUsd: 0.01,
          durationMs: 5,
          firstTextMs: 2,
          outcome: "accepted",
        });
        if (fail) throw Error("Synthetic gateway outage");
        return structuredClone(qualityFixtureReply(payload, design, [design]));
      },
    };
  };
  return { factory, arms };
}

const stages = [
  "concepts",
  "selection",
  "structure",
  "structure-review",
  "content-plan",
  "content-batch",
  "content-review",
];

test("one seed yields one valid judge-shaped row for the whole pipeline", async () => {
  const out = join(store(), "run");
  const { factory, arms } = fakeFactory();
  const result = await runDesignArm({
    setting: "sonnet:medium",
    seed: SEED,
    rep: 0,
    out,
    ephemeral: true,
    gatewayFactory: factory,
    now: () => NOW,
  });
  assert.equal(result.skipped, false);
  const row = result.row;
  assert.equal(row.v, 1);
  assert.equal(row.at, "2026-11-11T00:00:00.000Z");
  assert.equal(row.caseId, `design-seed-${SEED}`);
  assert.equal(row.operation, "design-run");
  assert.equal(row.setting, "sonnet:medium");
  assert.equal(row.rep, 0);
  assert.equal(row.outcome, "valid");
  assert.equal(row.answers.length, 1);
  assert.deepEqual(row.answers[0], design);
  assert.equal(row.stages, arms[0].phases.length);
  assert.ok(row.stages > 1);
  assert.equal(row.corrections, 0);
  assert.ok(
    Math.abs(row.costUsd! - 0.01 * arms[0].phases.length) < 1e-9,
    `costUsd ${row.costUsd}`,
  );
  assert.equal(row.durationMs, 5 * arms[0].phases.length);
  assert.deepEqual(row.model, ["claude-sonnet-5-5"]);
  const written = readFileSync(join(out, "results.jsonl"), "utf8").trim();
  assert.deepEqual(JSON.parse(written), row);
  const cases = JSON.parse(readFileSync(join(out, CASES_FILE), "utf8"));
  assert.deepEqual(cases, [
    {
      id: `design-seed-${SEED}`,
      operation: "design-run",
      payload: { seed: SEED, note: "full pipeline" },
    },
  ]);
});

test("every stage of the arm receives the forced model and effort", async () => {
  const out = join(store(), "run");
  const { factory, arms } = fakeFactory();
  const result = await runDesignArm({
    setting: "opus:low",
    seed: SEED,
    rep: 1,
    out,
    ephemeral: true,
    gatewayFactory: factory,
    now: () => NOW,
  });
  assert.equal(result.row.outcome, "valid");
  assert.equal(arms.length, 1);
  const arm = arms[0];
  assert.deepEqual([...new Set(arm.phases)].sort(), [...stages].sort());
  for (const [index, phase] of arm.phases.entries()) {
    const profile = arm.profiles[index];
    assert.equal(profile.model, "opus", phase);
    assert.equal(profile.effort, "low", phase);
    assert.equal(
      profile.timeoutMs,
      taskProfile("design-run", { phase }).timeoutMs,
      phase,
    );
  }
  // Production now runs Sonnet medium in every stage, the content batch too.
  assert.deepEqual(
    [
      taskProfile("design-run", { phase: "content-batch" }).model,
      taskProfile("design-run", { phase: "content-batch" }).effort,
    ],
    ["sonnet", "medium"],
  );
  assert.equal(arm.profiles[arm.phases.indexOf("content-batch")].effort, "low");
  const [model, effort, seed, rep, ...stamp] =
    arm.options.sessionNamespace.split(":");
  assert.deepEqual(
    [model, effort, seed, rep],
    ["opus", "low", String(SEED), "1"],
  );
  const namespace = stamp.join(":");
  assert.equal(new Date(namespace).toISOString(), namespace);
});

test("a recorded seed/setting/rep is skipped without a second gateway", async () => {
  const out = join(store(), "run");
  const { factory, arms } = fakeFactory();
  const input = {
    setting: "haiku:high",
    seed: SEED,
    rep: 0,
    out,
    ephemeral: true,
    gatewayFactory: factory,
    now: () => NOW,
  };
  const first = await runDesignArm(input);
  assert.equal(first.skipped, false);
  const second = await runDesignArm(input);
  assert.equal(second.skipped, true);
  assert.deepEqual(second.row, first.row);
  assert.equal(arms.length, 1);
  const lines = readFileSync(join(out, "results.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), first.row);
});

test("a failing gateway records a failed row instead of throwing", async () => {
  const out = join(store(), "run");
  const { factory, arms } = fakeFactory({ fail: true });
  const result = await runDesignArm({
    setting: "haiku:low",
    seed: SEED,
    rep: 2,
    out,
    ephemeral: true,
    gatewayFactory: factory,
    now: () => NOW,
  });
  assert.equal(result.skipped, false);
  assert.equal(result.row.outcome, "failed: Synthetic gateway outage");
  assert.deepEqual(result.row.answers, []);
  assert.equal(result.row.stages, 1);
  assert.equal(result.row.corrections, 0);
  assert.equal(result.row.costUsd, 0.01);
  assert.equal(arms.length, 1);
  const written = readFileSync(join(out, "results.jsonl"), "utf8").trim();
  assert.deepEqual(JSON.parse(written), result.row);
});

test("a temporary output directory is refused unless the caller opts in", async () => {
  const out = join(store(), "run");
  const { factory } = fakeFactory();
  await assert.rejects(
    runDesignArm({
      setting: "sonnet:medium",
      seed: SEED,
      out,
      gatewayFactory: factory,
      now: () => NOW,
    }),
    /Refusing output directory/,
  );
});
