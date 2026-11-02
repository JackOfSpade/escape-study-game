// Local orchestration only. ChatGPT must claim/answer the synthetic request
// through the actual OAuth connector; this script never supplies its answer.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDiagnosticState } from "./lib/diagnostic-state.mjs";
const base = "http://127.0.0.1:4318";
const directory = fileURLToPath(
  new URL("../.local/chatgpt-handoff/", import.meta.url),
);
const file = directory + "live-smoke.json";
const headers = {
  Origin: "http://127.0.0.1:5173",
  "Content-Type": "application/json",
};
async function call(path, body) {
  const response = await fetch(base + path, {
    ...(body === undefined
      ? {}
      : { method: "POST", headers, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000),
  });
  const value = await response.json();
  if (!response.ok && response.status !== 202)
    throw Error(value.error ?? `HTTP ${response.status}`);
  return { status: response.status, value };
}
const control = async (body) =>
  (await call("/api/handoff/control", body)).value;
const {
  ownerOnly: privatePath,
  save,
  load,
} = createDiagnosticState({
  directory,
  file,
  label: "Smoke state",
});
async function main() {
  const action = process.argv[2] ?? "status";
  if (action === "status") {
    const state = (await call("/api/handoff/status")).value;
    console.log(
      JSON.stringify({
        linked: state.public?.linked,
        enabled: state.enabled,
        workerActive: state.public?.workerActive,
        queued: state.queued,
        working: state.working,
        done: state.done,
      }),
    );
    return;
  }
  if (action === "start") {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    privatePath(directory);
    if (existsSync(file) && load().phase !== "finished")
      throw Error(
        "A retained smoke attempt already exists; inspect/finish it instead of issuing another request",
      );
    const before = (await call("/api/handoff/status")).value;
    if (
      !before.public?.linked ||
      !before.tunnel?.verified ||
      before.enabled ||
      before.public.workerActive ||
      before.queued ||
      before.working
    )
      throw Error(
        "Start only with the linked/verified connector and an empty disabled queue with no worker",
      );
    const state = {
      requestId: "synthetic-smoke-" + randomUUID(),
      marker: "PROBE_" + randomUUID().replaceAll("-", ""),
      createdAt: new Date().toISOString(),
      phase: "preparing",
    };
    save(state);
    try {
      await control({ action: "enable", enabled: true });
      const worker = await control({ action: "worker" });
      state.session = worker.session;
      save(state);
      const payload = {
        requestId: state.requestId,
        sessionId: state.requestId + "/private",
        problem: {
          title: "Synthetic connector transport check",
          prompt:
            "This is made-up diagnostic context, not curriculum work. No learning credit or world effect.",
        },
        workspace: "",
        transcript: [
          {
            author: "human",
            text: `Ask one guiding question about testing an empty collection. Include the diagnostic marker ${state.marker} in the text. Do not give a solution or code.`,
          },
        ],
        diagnostic: { synthetic: true, learningCredit: false },
      };
      const receipt = (
        await call("/api/bridge", { operation: "tutor", payload })
      ).value;
      if (
        typeof receipt.handoff?.id !== "string" ||
        typeof receipt.handoff?.hash !== "string"
      )
        throw Error("Missing correlated smoke receipt");
      state.receipt = receipt.handoff;
      state.phase = "waiting";
      save(state);
      console.log(
        JSON.stringify({
          ready: true,
          requestId: state.requestId,
          sessionFile: file,
          note: "Session code is private; do not print it. Submit through the actual linked ChatGPT connector.",
        }),
      );
    } catch (error) {
      await control({ action: "stop-worker" }).catch(() => {});
      delete state.session;
      state.phase = "error";
      state.error = String(error);
      save(state);
      throw error;
    }
    return;
  }
  if (action === "resume") {
    const state = load();
    if (state.phase !== "waiting" || !state.receipt?.id || !state.receipt?.hash)
      throw Error("No retained waiting smoke request");
    const before = (await call("/api/handoff/status")).value;
    if (
      !before.public?.linked ||
      !before.tunnel?.verified ||
      before.enabled ||
      before.public.workerActive ||
      before.queued !== 1 ||
      before.working
    )
      throw Error(
        "Resume requires the same pending request, linked tunnel, and one disabled unclaimed job",
      );
    try {
      await control({ action: "enable", enabled: true });
      const pending = await call(
        `/api/bridge/result?id=${encodeURIComponent(state.receipt.id)}&hash=${encodeURIComponent(state.receipt.hash)}`,
      );
      if (pending.status !== 202)
        throw Error("The retained smoke request is no longer pending");
      const worker = await control({ action: "worker" });
      state.session = worker.session;
      state.resumedAt = new Date().toISOString();
      save(state);
      console.log(
        JSON.stringify({
          ready: true,
          requestId: state.requestId,
          retainedRequest: true,
        }),
      );
    } catch (error) {
      await control({ action: "stop-worker" }).catch(() => {});
      delete state.session;
      save(state);
      throw error;
    }
    return;
  }
  if (action === "finish") {
    const state = load();
    if (state.phase !== "waiting") throw Error("No waiting smoke request");
    const reply = await call(
      `/api/bridge/result?id=${encodeURIComponent(state.receipt.id)}&hash=${encodeURIComponent(state.receipt.hash)}`,
    );
    if (reply.status === 202) {
      console.log(JSON.stringify({ pending: true }));
      return;
    }
    const text = reply.value.text;
    const valid =
      typeof text === "string" &&
      text.includes(state.marker) &&
      text.includes("?");
    await control({ action: "stop-worker" });
    const after = (await call("/api/handoff/status")).value;
    if (after.enabled || after.public?.workerActive || !after.public?.linked)
      throw Error(
        "Smoke cleanup did not preserve the OAuth link while stopping release and the worker",
      );
    delete state.session;
    state.phase = "finished";
    state.completedAt = new Date().toISOString();
    state.valid = valid;
    save(state);
    const report = {
      ...state,
      answer: reply.value,
      after,
      scope:
        "Synthetic transport roundtrip only; not learning evidence, native Study Mode verification or a semantic quality evaluation.",
    };
    const output = fileURLToPath(
      new URL("../docs/evidence/chatgpt-live-smoke.json", import.meta.url),
    );
    writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
    console.log(
      JSON.stringify({
        completed: true,
        valid,
        sharing: after.enabled,
        workerActive: after.public.workerActive,
        linked: after.public.linked,
        report: output,
      }),
    );
    if (!valid)
      throw Error(
        "The real reply did not satisfy the synthetic probe's marker/question checks",
      );
    return;
  }
  throw Error(
    "Use status, start (only after approval to send its session to ChatGPT), resume (same approved request), or finish",
  );
}
main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
