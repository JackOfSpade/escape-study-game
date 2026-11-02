// Isolated real-scope quality spot check. Explicit approval is required before start.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDiagnosticState } from "./lib/diagnostic-state.mjs";
import { sha256 as hash } from "./lib/digest.mjs";
const root = fileURLToPath(new URL("../", import.meta.url)),
  directory = root + ".local/chatgpt-handoff/",
  stateFile = directory + "curriculum-quality-smoke.json",
  planFile = root + "docs/evidence/chatgpt-curriculum-quality-plan.json";
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function evaluateCurriculumProbe(task, answer) {
  try {
    return evaluateAnswer(task, answer);
  } catch {
    return false;
  }
}
function evaluateAnswer(task, answer) {
  if (!answer || typeof answer !== "object") return false;
  const definitions = Object.values(
    task.payload.existingScopeDefinitions ?? {},
  );
  if (task.operation === "generate")
    return (
      equal(answer.contract, task.payload.contract) &&
      equal(answer.scopeDefinitions, definitions) &&
      typeof answer.title === "string" &&
      !!answer.title.trim() &&
      typeof answer.prompt === "string" &&
      !!answer.prompt.trim() &&
      answer.starter === "" &&
      answer.runtime === undefined &&
      Array.isArray(answer.rubric) &&
      answer.rubric.length > 0 &&
      answer.rubric.every((v) => typeof v === "string")
    );
  const definition = task.payload.scopeDefinitions[0],
    facets = definition.facets.map((f) => f.id),
    findings = answer.findings;
  if (
    !Array.isArray(findings) ||
    !findings.length ||
    !Array.isArray(answer.scopeReviews) ||
    !Array.isArray(answer.helpAttributions) ||
    !["usable", "unresolved"].includes(answer.visitOutcome) ||
    findings.some(
      (f) =>
        f.objectiveId !== definition.objectiveId ||
        f.depth !== 1 ||
        !facets.includes(f.facet) ||
        f.execution !== "not-run" ||
        !Array.isArray(f.evidence) ||
        f.evidence.some((seq) => seq !== 2) ||
        !["independent", "assisted", "unknown", "contradicted"].includes(
          f.outcome,
        ) ||
        typeof f.rationale !== "string" ||
        !f.rationale.trim(),
    ) ||
    new Set(findings.map((f) => f.facet)).size !== findings.length ||
    answer.scopeReviews.some(
      (s) => s.id !== definition.id || typeof s.completeCoverage !== "boolean",
    ) ||
    (answer.historicalMappings?.length ?? 0) > 0
  )
    return false;
  const outcome = (facet, expected) =>
    findings.some(
      (f) =>
        f.facet === facet && f.outcome === expected && f.evidence.includes(2),
    );
  if (task.key === "independent")
    return (
      facets.every((f) => outcome(f, "independent")) &&
      answer.helpAttributions.length === 0 &&
      answer.scopeReviews.some(
        (s) => s.id === definition.id && s.completeCoverage,
      )
    );
  if (task.key === "assisted")
    return (
      facets.every((f) => outcome(f, "assisted")) &&
      answer.helpAttributions.some(
        (h) =>
          h.messageId === "fictional-tutor-help" &&
          Array.isArray(h.facets) &&
          facets.every((f) => h.facets.includes(f) || h.facets.includes("*")),
      )
    );
  if (task.key === "incorrect")
    return (
      outcome("update", "contradicted") &&
      outcome("boundary", "contradicted") &&
      !findings.some(
        (f) =>
          ["state", "update", "boundary"].includes(f.facet) &&
          f.outcome === "independent",
      )
    );
  return false;
}
export function handoffReceipt(value) {
  const receipt = value?.handoff;
  if (
    value?.status !== "pending" ||
    typeof receipt?.id !== "string" ||
    typeof receipt?.hash !== "string" ||
    !receipt.id ||
    !receipt.hash
  )
    throw Error("Missing exact handoff receipt in queue response");
  return receipt;
}
const { ownerOnly, load, save } = createDiagnosticState({
  directory,
  file: stateFile,
});
async function call(path, body) {
  const response = await fetch("http://127.0.0.1:4318" + path, {
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: {
            Origin: "http://127.0.0.1:5173",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }),
    signal: AbortSignal.timeout(10000),
  });
  const value = await response.json();
  if (!response.ok) throw Error(value.error ?? `HTTP ${response.status}`);
  return { status: response.status, value };
}
const status = async () => (await call("/api/handoff/status")).value;
const control = async (body) =>
  (await call("/api/handoff/control", body)).value;
async function cleanup(state, phase) {
  await control({ action: "stop-worker" });
  const after = await status();
  if (after.enabled || after.public?.workerActive || !after.public?.linked)
    throw Error("Cleanup must leave sharing/worker off and OAuth linked");
  delete state.session;
  state.phase = phase;
  state.completedAt = new Date().toISOString();
  save(state);
  return {
    linked: after.public.linked,
    sharing: after.enabled,
    workerActive: after.public.workerActive,
    queued: after.queued,
    working: after.working,
    done: after.done,
  };
}
export async function main() {
  const action = process.argv[2] ?? "plan",
    source = readFileSync(planFile, "utf8"),
    plan = JSON.parse(source),
    planHash = hash(source);
  if (action === "plan") {
    const retained = existsSync(stateFile) ? load() : undefined;
    console.log(
      JSON.stringify({
        phase: retained?.phase ?? plan.status,
        planHash,
        scope: plan.scope,
        checks: plan.checks,
        released: !!retained,
        accessCodePrinted: false,
      }),
    );
    return;
  }
  if (action === "start" || action === "resume-start") {
    const ack = process.argv.indexOf("--approved-plan-sha256");
    if (ack < 0 || process.argv[ack + 1] !== planHash)
      throw Error(
        "Obtain explicit approval for this exact four-request plan and code transmission, then supply --approved-plan-sha256 HASH",
      );
    ownerOnly(directory);
    const retained = action === "resume-start" ? load() : undefined;
    if (
      retained &&
      (retained.phase !== "failed-start" ||
        retained.planHash !== planHash ||
        retained.session)
    )
      throw Error(
        "Only the same cleaned-up failed start and unchanged approved plan may resume",
      );
    if (!retained && existsSync(stateFile))
      throw Error("Retained attempt exists; never silently create another set");
    for (const packet of retained?.tasks ?? [])
      packet.receipt = packet.receipt?.handoff ?? packet.receipt;
    if (
      plan.tasks.length !== 4 ||
      plan.tasks.filter((t) => t.operation === "generate").length !== 1 ||
      plan.tasks.filter((t) => t.operation === "assess").length !== 3 ||
      plan.tasks.some(
        (t) =>
          !t.payload.diagnostic?.synthetic ||
          t.payload.diagnostic.learningCredit !== false ||
          t.payload.diagnostic.worldEffect !== false ||
          t.payload.contract.priorEvidence.length,
      )
    )
      throw Error(
        "Require exactly four isolated packets without original learner history or effects",
      );
    const before = await status();
    if (
      !before.public?.linked ||
      !before.tunnel?.verified ||
      before.enabled ||
      before.public.workerActive ||
      before.working ||
      (retained
        ? before.queued !==
            retained.tasks.filter((t) => t.receipt?.id).length ||
          before.recent.filter((j) => j.status === "queued").length !==
            before.queued ||
          before.recent.some(
            (j) =>
              j.status === "queued" &&
              !retained.tasks.some((t) => t.receipt?.id === j.id),
          )
        : before.queued)
    )
      throw Error(
        "Require a verified linked connector and empty disabled queue with no worker",
      );
    const state = retained ?? {
      id: "curriculum-quality-" + randomUUID(),
      planHash,
      phase: "preparing",
      tasks: [],
      createdAt: new Date().toISOString(),
    };
    save(state);
    try {
      await control({ action: "enable", enabled: true });
      state.session = (await control({ action: "worker" })).session;
      if (typeof state.session !== "string" || !state.session)
        throw Error("Worker code missing");
      save(state);
      for (const task of plan.tasks) {
        const expected = structuredClone(task);
        expected.payload.requestId = state.id + "/" + task.key;
        expected.payload.sessionId = state.id + "/diagnostic/" + task.key;
        const packet = state.tasks.find((p) => p.key === task.key) ?? expected;
        if (!equal(packet.payload, expected.payload))
          throw Error(
            "Retained packet changed; do not substitute a new request",
          );
        if (!state.tasks.includes(packet)) state.tasks.push(packet);
        save(state);
        packet.receipt = handoffReceipt(
          (
            await call("/api/bridge", {
              operation: task.operation,
              payload: packet.payload,
            })
          ).value,
        );
        save(state);
      }
      state.phase = "queued";
      save(state);
      console.log(
        JSON.stringify({
          phase: state.phase,
          requests: state.tasks.map((t) => t.payload.requestId),
          planHash,
          accessCodePrinted: false,
          note: "Temporary code is only in owner-only local state; transmit only after specific approval.",
        }),
      );
    } catch (error) {
      await cleanup(state, "failed-start");
      throw error;
    }
    return;
  }
  const state = load();
  if (state.planHash !== planHash)
    throw Error("Prepared plan changed; do not reuse the approved scope");
  if (action === "finish") {
    if (state.phase === "finished") {
      console.log(
        JSON.stringify({
          phase: "finished",
          checks: state.checks,
          note: "No new request or code created",
        }),
      );
      return;
    }
    if (
      !["queued", "results-collected"].includes(state.phase) ||
      state.tasks.length !== 4 ||
      state.tasks.some((t) => !t.receipt)
    )
      throw Error("No complete queued set to finish");
    const replies = await Promise.all(
      state.tasks.map((t) =>
        call(
          `/api/bridge/result?id=${encodeURIComponent(t.receipt.id)}&hash=${encodeURIComponent(t.receipt.hash)}`,
        ),
      ),
    );
    if (replies.some((r) => r.status === 202)) {
      console.log(
        JSON.stringify({
          pending: true,
          received: replies.filter((r) => r.status !== 202).length,
          total: 4,
        }),
      );
      return;
    }
    const after = await cleanup(state, "results-collected");
    state.checks = state.tasks.map((t, i) => ({
      key: t.key,
      passed: evaluateCurriculumProbe(t, replies[i].value),
    }));
    save(state);
    writeFileSync(
      root + "docs/evidence/chatgpt-curriculum-quality.json",
      JSON.stringify(
        {
          ...state,
          phase: "finished",
          answers: replies.map((r) => r.value),
          after,
          limits: plan.limits,
          manualQualityReview:
            "Pending: inspect generated prompt, source-to-facet coverage and grading rationales before making semantic claims.",
        },
        null,
        2,
      ) + "\n",
    );
    state.phase = "finished";
    save(state);
    console.log(
      JSON.stringify({
        phase: "finished",
        checks: state.checks,
        after,
        manualQualityReview: "pending",
      }),
    );
    if (state.checks.some((c) => !c.passed)) process.exitCode = 1;
    return;
  }
  if (action === "stop") {
    console.log(
      JSON.stringify({
        phase: "stopped",
        after: await cleanup(state, "stopped"),
      }),
    );
    return;
  }
  throw Error(
    "Use plan, start/resume-start --approved-plan-sha256 HASH, finish or stop",
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
