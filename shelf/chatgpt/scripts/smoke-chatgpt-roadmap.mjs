// One fictional live-client probe. Preparation never releases a request or code.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createDiagnosticState } from "./lib/diagnostic-state.mjs";
import { fileURLToPath } from "node:url";
import { sha256 as hash } from "./lib/digest.mjs";
const root = fileURLToPath(new URL("../", import.meta.url)),
  directory = root + ".local/chatgpt-handoff/",
  file = directory + "roadmap-smoke.json",
  planFile = root + "docs/evidence/chatgpt-roadmap-probe-plan.json";
const { ownerOnly, save, load } = createDiagnosticState({ directory, file });
async function call(path, body) {
  const r = await fetch("http://127.0.0.1:4318" + path, {
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
  const value = await r.json();
  if (!r.ok) throw Error(value.error ?? `HTTP ${r.status}`);
  return value;
}
const control = (body) => call("/api/handoff/control", body);
async function main() {
  const action = process.argv[2] ?? "plan",
    source = readFileSync(planFile, "utf8"),
    plan = JSON.parse(source);
  if (action === "plan") {
    const retained = existsSync(file) ? load() : undefined;
    console.log(
      JSON.stringify({
        status: retained?.phase ?? plan.status,
        operation: plan.task.operation,
        scope: plan.scope,
        checks: plan.checks,
        planFile,
        planHash: hash(source),
        note: retained
          ? "This probe has retained state; never rerun start or silently create another job or code."
          : "Not released; explicit approval is required before creating or transmitting the temporary worker code.",
      }),
    );
    return;
  }
  if (action === "start") {
    if (!process.argv.includes("--approved-one-roadmap"))
      throw Error(
        "Obtain explicit approval for this one fictional roadmap packet and temporary code transmission first",
      );
    ownerOnly(directory);
    if (existsSync(file))
      throw Error(
        "A retained probe already exists; do not create another job or code",
      );
    const before = await call("/api/handoff/status");
    if (
      !before.public?.linked ||
      !before.tunnel?.verified ||
      before.enabled ||
      before.public.workerActive ||
      before.queued ||
      before.working
    )
      throw Error(
        "Require a verified linked connector and empty disabled queue without a worker",
      );
    const task = plan.task;
    if (
      task.operation !== "reconcile-roadmap" ||
      !task.payload.diagnostic?.synthetic ||
      task.payload.diagnostic.learningCredit !== false ||
      task.payload.diagnostic.worldEffect !== false ||
      hash(task.payload.local) !== task.payload.localHash ||
      hash(task.payload.candidate) !== task.payload.candidateHash
    )
      throw Error("Invalid frozen fictional probe");
    const state = {
      id: "roadmap-smoke-" + randomUUID(),
      planHash: hash(source),
      phase: "preparing",
      createdAt: new Date().toISOString(),
      expectedCanonical: plan.expectedCanonical,
    };
    save(state);
    try {
      await control({ action: "enable", enabled: true });
      const worker = await control({ action: "worker" });
      state.session = worker.session;
      save(state);
      state.payload = { ...task.payload, requestId: state.id };
      save(state);
      state.receipt = (
        await call("/api/bridge", {
          operation: task.operation,
          payload: state.payload,
        })
      ).handoff;
      if (!state.receipt?.id || !state.receipt?.hash)
        throw Error("Missing exact diagnostic receipt");
      state.phase = "waiting";
      save(state);
      console.log(
        JSON.stringify({
          ready: true,
          requests: 1,
          stateFile: file,
          note: "Worker code remains private. Send only within the explicit one-roadmap approval; process this request ID only, then stop.",
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
    if (state.phase !== "waiting" || state.planHash !== hash(source))
      throw Error(
        "Require the unchanged retained waiting probe; never silently repeat a test",
      );
    const result = await call(
      `/api/bridge/result?id=${encodeURIComponent(state.receipt.id)}&hash=${encodeURIComponent(state.receipt.hash)}`,
    );
    if (result.status === "pending") {
      console.log(
        JSON.stringify({
          pending: true,
          note: "Original request retained. Do not start another probe.",
        }),
      );
      return;
    }
    try {
      const a = result,
        p = state.payload;
      const checks = {
        correlated:
          a.requestId === p.requestId &&
          a.localHash === p.localHash &&
          a.candidateHash === p.candidateHash,
        canonical: a.canonical === state.expectedCanonical,
        shape: ["definitions", "mappings", "completeScopes", "decisions"].every(
          (k) => Array.isArray(a[k]) && a[k].length === 0,
        ),
        retention:
          a.retentionUpdates?.length === 1 &&
          a.retentionUpdates[0].scopeId === "SYNTHETIC:BOUNDARY/D1" &&
          typeof a.retentionUpdates[0].rationale === "string" &&
          !!a.retentionUpdates[0].rationale.trim(),
        rationale: typeof a.rationale === "string" && !!a.rationale.trim(),
      };
      state.answer = a;
      state.checks = checks;
      state.passed = Object.values(checks).every(Boolean);
      state.phase = "finished";
      const report = {
        at: new Date().toISOString(),
        planHash: state.planHash,
        requestId: state.id,
        receipt: state.receipt,
        checks,
        passed: state.passed,
        answer: a,
        limits: [plan.limits[0]],
        scope: plan.scope,
      };
      writeFileSync(
        root + "docs/evidence/chatgpt-roadmap-probe.json",
        JSON.stringify(report, null, 2) + "\n",
      );
    } finally {
      await control({ action: "stop-worker" });
      delete state.session;
      save(state);
    }
    console.log(
      JSON.stringify({
        finished: true,
        passed: state.passed,
        checks: state.checks,
        sharing: false,
        workerActive: false,
      }),
    );
    return;
  }
  throw Error("Use plan, start --approved-one-roadmap, or finish");
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
