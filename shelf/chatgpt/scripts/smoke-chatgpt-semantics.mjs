// Diagnostic orchestration only: answers must come from the real ChatGPT client.
// Run start only after approval for these four packets and code transmission.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createDiagnosticState } from "./lib/diagnostic-state.mjs";
import { fileURLToPath } from "node:url";
import { sha256 } from "./lib/digest.mjs";
import { validateGroupReply } from "../src/group-grounding.ts";
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = root + ".local/chatgpt-handoff/";
const file = directory + "semantic-smoke.json";
const planFile = root + "docs/evidence/chatgpt-semantic-probe-plan.json";
const headers = {
  Origin: "http://127.0.0.1:5173",
  "Content-Type": "application/json",
};
const { ownerOnly, save, load } = createDiagnosticState({ directory, file });
async function call(path, body) {
  const reply = await fetch("http://127.0.0.1:4318" + path, {
    ...(body === undefined
      ? {}
      : { method: "POST", headers, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000),
  });
  const value = await reply.json();
  if (!reply.ok) throw Error(value.error ?? `HTTP ${reply.status}`);
  return { status: reply.status, value };
}
const control = async (body) =>
  (await call("/api/handoff/control", body)).value;
const status = async () => (await call("/api/handoff/status")).value;
const result = (receipt) =>
  call(
    `/api/bridge/result?id=${encodeURIComponent(receipt.id)}&hash=${encodeURIComponent(receipt.hash)}`,
  );
function evaluate(task, answer) {
  if (task.operation === "generate")
    return (
      JSON.stringify(answer.contract) ===
        JSON.stringify(task.payload.contract) &&
      typeof answer.prompt === "string" &&
      !!answer.prompt.trim() &&
      Array.isArray(answer.rubric) &&
      answer.rubric.length > 0 &&
      answer.rubric.every((criterion) => typeof criterion === "string") &&
      JSON.stringify(answer.scopeDefinitions) ===
        JSON.stringify(task.payload.scopeDefinitions) &&
      answer.scopeDefinitions.every((d) => d.objectiveId === "SYNTHETIC:EMPTY")
    );
  if (task.operation === "group") {
    validateGroupReply(answer, task.payload, ["synthetic-robin"], "");
    return (
      answer.messages.length > 0 &&
      answer.messages.every((m) => !m.claims?.length)
    );
  }
  if (task.operation === "complete")
    return (
      answer.complete === true &&
      answer.qualified.includes("human") &&
      answer.qualified.every((id) => ["human", "synthetic-robin"].includes(id))
    );
  if (task.operation === "assess")
    return (
      answer.findings.length > 0 &&
      answer.findings.every(
        (f) =>
          ["assisted", "unknown"].includes(f.outcome) &&
          f.objectiveId === "SYNTHETIC:EMPTY" &&
          f.execution === "not-run" &&
          f.completeCheckpointScope !== true &&
          f.evidence.every((seq) => seq === 2),
      ) &&
      answer.scopeReviews.every((s) => s.completeCoverage === false)
    );
  return false;
}
async function main() {
  const action = process.argv[2] ?? "plan";
  if (action === "plan") {
    const plan = JSON.parse(readFileSync(planFile, "utf8"));
    console.log(
      JSON.stringify({
        status: plan.status,
        operations: plan.tasks.map((t) => t.operation),
        checks: plan.checks,
        note: "Not released. Requires specific approval for four packets and temporary code transmission.",
      }),
    );
    return;
  }
  if (action === "start") {
    if (!process.argv.includes("--approved-four"))
      throw Error(
        "Obtain explicit approval for these four packets before start --approved-four",
      );
    ownerOnly(directory);
    try {
      if (load().phase !== "finished")
        throw Error(
          "Retained diagnostic attempt exists; do not enqueue another set",
        );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const before = await status();
    if (
      !before.public?.linked ||
      !before.tunnel?.verified ||
      before.enabled ||
      before.public.workerActive ||
      before.queued ||
      before.working
    )
      throw Error(
        "Require a linked verified connector and an empty disabled queue with no worker",
      );
    const source = readFileSync(planFile, "utf8"),
      plan = JSON.parse(source);
    if (
      plan.tasks.length !== 4 ||
      plan.tasks.some(
        (t) =>
          !t.payload.diagnostic?.synthetic ||
          t.payload.diagnostic.learningCredit !== false ||
          t.payload.diagnostic.worldEffect !== false,
      )
    )
      throw Error("Require exactly four synthetic packets without effects");
    const state = {
      id: "semantic-smoke-" + randomUUID(),
      planHash: sha256(source),
      phase: "preparing",
      tasks: [],
      createdAt: new Date().toISOString(),
    };
    save(state);
    try {
      await control({ action: "enable", enabled: true });
      const worker = await control({ action: "worker" });
      state.session = worker.session;
      save(state);
      for (const task of plan.tasks) {
        const payload = {
          ...task.payload,
          requestId: `${state.id}/${task.operation}`,
          sessionId: `${state.id}/${task.operation === "group" ? "public" : "diagnostic"}`,
        };
        const entry = { operation: task.operation, payload };
        state.tasks.push(entry);
        save(state);
        entry.receipt = (
          await call("/api/bridge", { operation: task.operation, payload })
        ).value.handoff;
        if (!entry.receipt?.id || !entry.receipt?.hash)
          throw Error("Missing exact diagnostic receipt");
        save(state);
      }
      state.phase = "waiting";
      save(state);
      console.log(
        JSON.stringify({
          ready: true,
          requests: 4,
          stateFile: file,
          note: "Code private; transmit only within the approved four-request test scope. Process these request IDs only, then stop.",
        }),
      );
    } catch (error) {
      await control({ action: "stop-worker" }).catch(() => {});
      delete state.session;
      state.phase = "interrupted";
      save(state);
      throw error;
    }
    return;
  }
  if (action === "correct") {
    const state = load();
    const failed = state.checks?.filter((check) => !check.passed);
    if (
      state.phase !== "finished" ||
      !failed?.length ||
      failed.some((check) => !["generate", "group"].includes(check.operation))
    )
      throw Error(
        "Only the same completed generation/group diagnostic jobs can be corrected",
      );
    const before = await status();
    if (
      !before.public?.linked ||
      !before.tunnel?.verified ||
      before.enabled ||
      before.public.workerActive ||
      before.queued ||
      before.working
    )
      throw Error(
        "Corrections require the linked verified connector with no released work or worker",
      );
    const operations = failed.map((check) => check.operation);
    (state.correctionRuns ??= []).push({
      at: new Date().toISOString(),
      operations,
      previousChecks: state.checks,
    });
    state.phase = "correcting";
    save(state);
    try {
      await control({ action: "enable", enabled: true });
      for (const operation of operations) {
        const task = state.tasks.find((task) => task.operation === operation);
        await control({ action: "reopen", jobId: task.receipt.id });
      }
      state.session = (await control({ action: "worker" })).session;
      state.phase = "waiting";
      save(state);
      console.log(
        JSON.stringify({
          ready: true,
          correctedOriginalOperations: operations,
          newJobs: 0,
        }),
      );
    } catch (error) {
      await control({ action: "stop-worker" }).catch(() => {});
      delete state.session;
      state.phase = "interrupted";
      save(state);
      throw error;
    }
    return;
  }
  if (action === "finish") {
    const state = load();
    if (state.phase !== "waiting")
      throw Error("No waiting four-request attempt");
    const replies = await Promise.all(
      state.tasks.map((t) => result(t.receipt)),
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
    await control({ action: "stop-worker" });
    const after = await status();
    if (after.enabled || after.public?.workerActive || !after.public?.linked)
      throw Error("Cleanup did not preserve OAuth with worker/sharing stopped");
    delete state.session;
    state.phase = "finished";
    state.completedAt = new Date().toISOString();
    const checks = state.tasks.map((task, i) => {
      try {
        return {
          operation: task.operation,
          passed: evaluate(task, replies[i].value),
        };
      } catch {
        return { operation: task.operation, passed: false };
      }
    });
    state.checks = checks;
    save(state);
    const report = {
      ...state,
      answers: replies.map((r) => r.value),
      after,
      scope:
        "Fictional semantic spot checks only; not actual learner evidence, production curriculum validation, model reliability certification or native Study Mode identity.",
    };
    writeFileSync(
      root + "docs/evidence/chatgpt-semantic-probe.json",
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(
      JSON.stringify({
        completed: true,
        checks,
        sharing: after.enabled,
        workerActive: after.public.workerActive,
        linked: after.public.linked,
      }),
    );
    if (checks.some((c) => !c.passed))
      throw Error(
        "One or more synthetic response checks need review; sharing has been stopped",
      );
    return;
  }
  throw Error(
    "Use plan, start --approved-four (after specific approval), correct (same failed jobs only), or finish",
  );
}
main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
