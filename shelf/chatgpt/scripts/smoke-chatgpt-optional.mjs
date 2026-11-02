// Prepared diagnostic only. Never start without the user's scoped approval.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDiagnosticState } from "./lib/diagnostic-state.mjs";
import { sha256 as hash } from "./lib/digest.mjs";
export const OPTIONAL_PLAN_HASH =
  "3de36a70b2554e14870d28ad2b995fea8ae9909059225e5f13cad3aae53add66";
const names = [
  "tentative-team-note",
  "recorded-catch-up",
  "survivor-reconstruction",
  "independent-reconstruction-review",
  "discussion-is-not-practical-observation",
];
const safeStatus = (s) => ({
  linked: !!s.public?.linked,
  sharing: !!s.enabled,
  autonomous: !!s.autonomousWork,
  worker: !!s.public?.workerActive,
  scoped: !!s.public?.workerScoped,
  queued: s.queued,
  working: s.working,
  done: s.done,
});
function unsafeCheck(task, answer) {
  const p = task.payload;
  if (!answer || answer.requestId !== p.requestId) return false;
  if (task.operation === "materialize-work")
    return (
      answer.sourceRevision === p.sourceRevision &&
      Array.isArray(answer.notes) &&
      answer.notes.length > 0 &&
      answer.notes.every(
        (n) =>
          !n.patch &&
          !n.readyToSubmit &&
          typeof n.text === "string" &&
          n.text.trim() &&
          p.work.some(
            (w) =>
              w.id === n.workId &&
              w.actor === n.author &&
              n.refs?.includes(w.seq),
          ),
      )
    );
  if (task.operation === "group")
    return (
      answer.sourceRevision === p.sourceRevision &&
      Array.isArray(answer.messages) &&
      answer.messages.length > 0 &&
      answer.messages.every(
        (m) =>
          m.kind === "observation" &&
          !m.patch &&
          !m.claims?.length &&
          p.speakers.some((s) => s.id === m.author) &&
          m.refs?.some((ref) => p.range.refs.includes(ref)),
      )
    );
  if (task.operation === "materialize-outcome")
    return (
      JSON.stringify(answer.problem) === JSON.stringify(p.commitment.problem) &&
      answer.execution === "not-run" &&
      typeof answer.solution === "string" &&
      !!answer.solution.trim() &&
      Array.isArray(answer.authors) &&
      answer.authors.length > 0 &&
      answer.authors.every((id) => p.speakers.some((s) => s.id === id)) &&
      Array.isArray(answer.refs) &&
      answer.refs.length > 0 &&
      answer.refs.every((seq) =>
        p.commitment.work.some(
          (w) => w.seq === seq && answer.authors.includes(w.actor),
        ),
      )
    );
  if (task.operation === "complete")
    return (
      answer.complete === true &&
      answer.execution === "not-run" &&
      typeof answer.feedback === "string" &&
      !!answer.feedback.trim()
    );
  return (
    answer.sourceHash === p.sourceHash &&
    answer.observationId === p.observation.id &&
    answer.observationFingerprint === p.observation.fingerprint &&
    answer.envId === p.definition.id &&
    answer.classification === "reported-exposure" &&
    answer.completeScope === false &&
    Array.isArray(answer.reviewedOutputs) &&
    !answer.reviewedOutputs.length &&
    Array.isArray(answer.covered) &&
    !answer.covered.length
  );
}
export function optionalCheck(task, answer) {
  try {
    return Boolean(unsafeCheck(task, answer));
  } catch {
    return false;
  }
}
/** IO injection permits isolated real-relay tests without touching the user's bridge. */
export function createOptionalProbe({
  source,
  read,
  write,
  call,
  publish,
  reportExists = () => false,
  uuid = randomUUID,
  now = () => new Date().toISOString(),
  expectedHash = OPTIONAL_PLAN_HASH,
  expectedNames = names,
  evaluate = optionalCheck,
  deriveValidation = true,
  prefixName = "optional-smoke",
}) {
  const plan = JSON.parse(source),
    digest = hash(source);
  const validate = () => {
    if (
      digest !== expectedHash ||
      JSON.stringify(plan.tasks.map((t) => t.name)) !==
        JSON.stringify(expectedNames) ||
      plan.tasks
        .filter((t) => t.payload)
        .some(
          (t) =>
            t.payload.provider !== "chatgpt-handoff" ||
            t.payload.diagnostic?.synthetic !== true ||
            t.payload.diagnostic.learningCredit !== false ||
            t.payload.diagnostic.worldEffect !== false,
        )
    )
      throw Error(
        "Frozen request plan changed; obtain a new scoped review before release",
      );
  };
  const load = () => {
    const s = read();
    if (!s) throw Error("No retained optional probe");
    if (s.planHash !== digest)
      throw Error("Retained probe belongs to another plan");
    return s;
  };
  const control = async (body) =>
    (await call("/api/handoff/control", body)).value;
  const result = (task) =>
    call(
      `/api/bridge/result?id=${encodeURIComponent(task.receipt.id)}&hash=${encodeURIComponent(task.receipt.hash)}`,
    );
  async function enqueue(s, task) {
    if (task.receipt) return;
    const r = await call("/api/bridge", {
      operation: task.operation,
      provider: "chatgpt-handoff",
      payload: task.payload,
    });
    if (!r.value.handoff?.id || !r.value.handoff?.hash)
      throw Error("Missing exact diagnostic receipt");
    task.receipt = r.value.handoff;
    write(s);
  }
  async function clean(s) {
    await control({ action: "stop-worker" });
    const after = (await call("/api/handoff/status")).value;
    if (
      after.enabled ||
      after.autonomousWork ||
      after.public?.workerActive ||
      !after.public?.linked
    )
      throw Error("Cleanup incomplete; keep the retained attempt for recovery");
    delete s.session;
    s.after = safeStatus(after);
    return after;
  }
  return {
    plan() {
      validate();
      return {
        status: read()?.phase ?? "prepared-not-released",
        planHash: digest,
        requests: expectedNames.length,
        scope: plan.scope,
      };
    },
    async start(approved = false) {
      if (approved !== true)
        throw Error(
          "Specific approval for these fictional requests and one temporary code is required",
        );
      validate();
      if (read() || reportExists())
        throw Error(
          "A retained attempt exists; never start another set or code",
        );
      const before = (await call("/api/handoff/status")).value;
      if (
        !before.public?.linked ||
        !before.tunnel?.verified ||
        before.enabled ||
        before.autonomousWork ||
        before.public?.workerActive ||
        before.queued ||
        before.working
      )
        throw Error(
          "Require a linked verified idle connector with sharing, unattended work and worker off",
        );
      const id = `${prefixName}-${uuid()}`,
        s = {
          schema: 1,
          id,
          prefix: id + "/",
          planHash: digest,
          phase: "preparing",
          createdAt: now(),
          tasks: [],
        };
      write(s);
      try {
        await control({ action: "enable", enabled: true });
        const caps = (await call("/api/status")).value;
        if (
          caps.mode !== "chatgpt-handoff" ||
          ![
            ...new Set([
              ...plan.tasks.map((t) => t.operation),
              ...(deriveValidation ? ["complete"] : []),
            ]),
          ].every((op) => caps.capabilities?.includes(op)) ||
          caps.capabilities.includes("autonomous-work")
        )
          throw Error(
            "Required optional routes unavailable or unattended release enabled",
          );
        const worker = await control({
          action: "worker",
          requestPrefix: s.prefix,
        });
        if (typeof worker.session !== "string" || !worker.session)
          throw Error("Missing temporary worker session");
        s.session = worker.session;
        write(s);
        if (!(await call("/api/handoff/status")).value.public?.workerScoped)
          throw Error("Diagnostic worker is not server-scoped");
        for (const t of plan.tasks.filter((t) => t.payload)) {
          const p = structuredClone(t.payload);
          p.requestId = s.prefix + t.name;
          p.sessionId = s.prefix + "diagnostic";
          if (p.snapshot) p.snapshot.requestId = p.requestId;
          const task = { name: t.name, operation: t.operation, payload: p };
          s.tasks.push(task);
          write(s);
          await enqueue(s, task);
        }
        s.phase = "waiting";
        write(s);
        return {
          ready: true,
          requestsInitiallyQueued: plan.tasks.filter((t) => t.payload).length,
          totalRequests: expectedNames.length,
          code: "Retained privately; never print it. Transmit only within approved scope.",
        };
      } catch (error) {
        s.phase = "cleanup-required";
        write(s);
        await clean(s)
          .then(() => {
            s.phase = "interrupted";
          })
          .catch(() => {});
        write(s);
        throw error;
      }
    },
    async advance() {
      validate();
      if (!deriveValidation)
        throw Error("This plan has no derived validation request");
      const s = load();
      if (s.phase !== "waiting") throw Error("No waiting optional probe");
      let task = s.tasks.find((t) => t.operation === "complete");
      if (task) {
        await enqueue(s, task);
        return { alreadyQueued: true, totalRequests: 5 };
      }
      const original = s.tasks.find(
          (t) => t.operation === "materialize-outcome",
        ),
        r = await result(original);
      if (r.status === 202) return { pending: true };
      (s.answers ??= {})[original.name] = r.value;
      write(s);
      if (!evaluate(original, r.value))
        throw Error(
          "Original reconstruction needs review; no derived request released",
        );
      const candidate = r.value;
      task = {
        name: names[3],
        operation: "complete",
        payload: {
          requestId: s.prefix + names[3],
          provider: "chatgpt-handoff",
          mode: "retrospective-npc-outcome",
          candidateHash: hash(JSON.stringify(candidate)),
          commitment: original.payload.commitment,
          problem: candidate.problem,
          solution: candidate.solution,
          authors: candidate.authors,
          refs: candidate.refs,
          diagnostic: {
            synthetic: true,
            learningCredit: false,
            worldEffect: false,
          },
          instruction:
            "Review this exact fictional reconstruction independently against its question. Never infer correctness from simulated world success. Return {requestId,complete,feedback,execution:'not-run'}. No execution, human qualification, rewards or learning changes.",
        },
      };
      s.tasks.push(task);
      write(s);
      await enqueue(s, task);
      return { queuedValidation: true, totalRequests: 5 };
    },
    async finish() {
      validate();
      const s = load();
      if (s.phase === "finished") return { completed: true, checks: s.checks };
      if (!["waiting", "cleanup-required", "cleaned"].includes(s.phase))
        throw Error("No finishable optional probe");
      if (s.phase === "waiting") {
        if (s.tasks.length !== expectedNames.length)
          throw Error(
            "Queue the exact derived validation through advance first",
          );
        const replies = await Promise.all(s.tasks.map(result));
        if (replies.some((r) => r.status === 202))
          return {
            pending: true,
            received: replies.filter((r) => r.status !== 202).length,
            total: expectedNames.length,
          };
        s.answers = Object.fromEntries(
          s.tasks.map((t, i) => [t.name, replies[i].value]),
        );
        s.checks = s.tasks.map((t) => ({
          name: t.name,
          operation: t.operation,
          limitedCheckPassed: evaluate(t, s.answers[t.name]),
          semanticReview:
            "Raw responses require separate review; not broad model certification.",
        }));
        s.phase = "cleanup-required";
        write(s);
      }
      if (s.phase === "cleanup-required") {
        if (s.checks?.length !== expectedNames.length)
          throw Error(
            "Incomplete attempt; use stop for cleanup without claiming a finished test",
          );
        await clean(s);
        s.completedAt = now();
        s.phase = "cleaned";
        write(s);
      }
      const { session: _secret, ...report } = s;
      publish({
        ...report,
        scope: plan.scope,
        limits: plan.limits,
        semanticReview:
          "Unreviewed raw responses; automation checks identity/format and limited declared outcomes only.",
      });
      s.phase = "finished";
      write(s);
      return { completed: true, checks: s.checks, after: s.after };
    },
    async stop() {
      const s = load();
      if (s.phase === "finished") return { alreadyStopped: true };
      await clean(s);
      s.phase = "interrupted";
      write(s);
      return { stopped: true, after: s.after };
    },
  };
}
const root = fileURLToPath(new URL("../", import.meta.url));
export async function runProbeCLI({
  planName = "chatgpt-optional-capabilities-plan",
  privateName = "optional-smoke",
  reportName = "chatgpt-optional-capabilities-probe",
  approvalFlag = "--approved-five",
  config = {},
} = {}) {
  const directory = root + ".local/chatgpt-handoff/",
    file = directory + privateName + ".json",
    reportFile = root + "docs/evidence/" + reportName + ".json";
  const state = createDiagnosticState({
    directory,
    file,
    label: "Probe state",
  });
  const probe = createOptionalProbe({
    ...config,
    source: readFileSync(root + "docs/evidence/" + planName + ".json", "utf8"),
    read: () => state.loadIfExists(),
    write: (s) => state.save(s),
    reportExists: () => existsSync(reportFile),
    publish(report) {
      const content = JSON.stringify(report, null, 2) + "\n";
      if (existsSync(reportFile)) {
        if (readFileSync(reportFile, "utf8") !== content)
          throw Error(
            "Existing report differs; preserve both rather than overwrite",
          );
        return;
      }
      writeFileSync(reportFile, content, { flag: "wx" });
    },
    async call(path, body) {
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
      return { status: r.status, value };
    },
  });
  const action = process.argv[2] ?? "plan";
  if (!["plan", "start", "advance", "finish", "stop"].includes(action))
    throw Error(`Use plan, start ${approvalFlag}, advance, finish or stop`);
  console.log(
    JSON.stringify(
      await probe[action](
        action === "start" && process.argv.includes(approvalFlag),
      ),
    ),
  );
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  runProbeCLI().catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
