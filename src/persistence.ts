import { displayScale } from "./display-scale";
import { createCheckpointQueue } from "./checkpoint-queue";
import { fnv1a } from "./hash";
import { reconcileKnowledgeGaps } from "./knowledge-probe";
import { type StudyRecord } from "./model";
import {
  closeDirectStudy,
  recoverDirectStudy,
  releaseSettledRequests,
} from "./run-learning";
import { readDurable, writeDurable } from "./storage";
const KEY = "dead-air-save-v1";
interface Envelope {
  schema: 1;
  payload: string;
  checksum: number;
}
/** Saves written by the retired game hold more fields than `StudyRecord` declares
 * (floors, survivors, the run design and the rest). They are neither read nor
 * validated: they stay in the parsed object and are written back unchanged,
 * so a save written here still loads in the old build. */
export function encode(g: StudyRecord) {
  const payload = JSON.stringify(g);
  return JSON.stringify({
    schema: 1,
    payload,
    checksum: fnv1a(payload),
  } satisfies Envelope);
}
export function decode(text: string): StudyRecord {
  const e = JSON.parse(text) as Envelope;
  if (
    e.schema !== 1 ||
    typeof e.payload !== "string" ||
    fnv1a(e.payload) !== e.checksum
  )
    throw Error("Save integrity check failed");
  const g = JSON.parse(e.payload) as StudyRecord;
  if (
    !g ||
    g.schema !== 1 ||
    !g.study ||
    !g.settings ||
    typeof g.encounters !== "object" ||
    !g.encounters
  )
    throw Error("Unsupported save");
  return g;
}
let serial = 0;
const checkpoints = createCheckpointQueue<{
  payload: string;
  checkpoint: boolean;
  serial: number;
}>(async ({ payload, checkpoint, serial: checkpointSerial }) => {
  try {
    await writeDurable(KEY, payload);
  } catch (error) {
    if (checkpoint) return;
    // A newer checkpoint may have reached local storage while this
    // older durable transaction was pending. Never roll that fallback back.
    let local: string | null = null;
    try {
      local = localStorage.getItem(KEY);
    } catch {}
    if (local)
      try {
        if (unpack(local).serial >= checkpointSerial) return;
      } catch {}
    try {
      localStorage.setItem(KEY, payload);
    } catch {
      throw error;
    }
  }
});
interface StoredSave {
  format: 2;
  serial: number;
  data: string;
}
function unpack(raw: string) {
  const parsed = JSON.parse(raw);
  const stored =
    parsed.format === 2
      ? (parsed as StoredSave)
      : { format: 2, serial: 0, data: raw };
  if (
    !Number.isSafeInteger(stored.serial) ||
    stored.serial < 0 ||
    typeof stored.data !== "string"
  )
    throw Error("Invalid saved checkpoint");
  return { serial: stored.serial, game: decode(stored.data) };
}
/** A background checkpoint skips the synchronous localStorage mirror: copying a
 * megabyte there on every autosave hitches the page. IndexedDB still receives
 * it, and the queue above falls back to localStorage if that write fails. */
export function save(g: StudyRecord, options: { background?: boolean } = {}) {
  const payload = JSON.stringify({
    format: 2,
    serial: (serial = Math.max(serial + 1, Date.now() * 1000)),
    data: encode(g),
  } satisfies StoredSave);
  let checkpoint = false;
  // Capture the whole snapshot before yielding to IndexedDB, including large
  // drafts/archives when they still fit the browser's actual storage quota.
  // A fixed size cutoff silently left those edits without crash recovery.
  if (!options.background)
    try {
      localStorage.setItem(KEY, payload);
      checkpoint = true;
    } catch {}
  return checkpoints.enqueue({ payload, checkpoint, serial });
}
async function storedCopies() {
  let durable: string | null = null,
    local: string | null = null,
    durableError: string | undefined,
    localError: string | undefined;
  try {
    durable = await readDurable(KEY);
  } catch (error) {
    durableError = String(error);
  }
  try {
    local = localStorage.getItem(KEY);
  } catch (error) {
    localError = String(error);
  }
  return { durable, local, durableError, localError };
}
/** Preserve the original stored bytes, including a damaged or unreadable copy. */
export async function exportRecoveryBackup() {
  return JSON.stringify(
    { format: "dead-air-recovery-v1", key: KEY, ...(await storedCopies()) },
    null,
    2,
  );
}
/** A stored copy that failed validation while the other copy loaded. */
export interface RejectedCopy {
  store: "durable" | "local";
  /** The stored bytes exactly as they were read. */
  raw: string;
  reason: string;
}
let rejected: RejectedCopy | undefined;
/** The copy the last `load()` refused although it returned the other one.
 * It may have been the newer checkpoint, and the next save replaces it. */
export function rejectedCopy() {
  return rejected;
}
export async function load() {
  const { durable, local, durableError, localError } = await storedCopies();
  // An unreadable store may hold a newer checkpoint than the readable copy.
  // Starting from that older copy would overwrite unseen learning on save.
  if (durableError || localError)
    throw Error(
      "Saved checkpoints could not be read. Reload to retry storage access, or export a recovery backup before importing another run.",
    );
  const valid: { serial: number; game: StudyRecord }[] = [];
  const refused: RejectedCopy[] = [];
  for (const [store, raw] of [
    ["durable", durable],
    ["local", local],
  ] as const)
    if (raw !== null)
      try {
        valid.push(unpack(raw));
      } catch (error) {
        refused.push({ store, raw, reason: String(error) });
      }
  // A refused copy has no readable serial, so it may be the newer one. Keep
  // its bytes: the next save overwrites it in storage.
  rejected = valid.length ? refused[0] : undefined;
  if (!valid.length) {
    if (durable !== null || local !== null)
      throw Error(
        "Saved checkpoints failed integrity checks. Export a recovery backup before starting another run.",
      );
    return null;
  }
  valid.sort((a, b) => b.serial - a.serial);
  serial = valid[0].serial;
  return valid[0].game;
}
export function flushSaves() {
  return checkpoints.flush();
}
export function download(
  name: string,
  text: string,
  type = "application/json",
) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function interruptPending(
  jobs: { state?: string; status?: string; error?: string }[] | undefined,
  message: string,
  field: "state" | "status" = "state",
) {
  for (const job of jobs ?? []) {
    if (job[field] === "pending") {
      job[field] = "interrupted";
      job.error = message;
    }
  }
}
export function recover(g: StudyRecord) {
  g.settings.displayScale = displayScale(g.settings.displayScale);
  interruptPending(
    g.study.roadmapReconciliations,
    "Roadmap review interrupted; explicit retry retains its exact snapshot.",
  );
  interruptPending(
    g.study.environmentReviews,
    "Review interrupted; retry the captured packet explicitly.",
  );
  g.study.profile ??= "development";
  if (g.study.profile === "live" && !g.study.learner)
    throw Error(
      "Live save is missing its learner ledger; refusing to reset learning state.",
    );
  if (g.study.pending && !g.study.pending.encounter.includes("/"))
    g.study.pending.encounter = `${g.id}/${g.study.pending.encounter}`;
  for (const e of Object.values(g.encounters)) e.runId ??= g.id;
  for (const e of new Set([
    ...Object.values(g.encounters),
    ...g.study.archives,
  ])) {
    e.chatOpen = false;
    interruptPending(
      e.tutorRequests,
      "Application restarted; retry the exact saved private question.",
    );
    // Older saves could carry a previous run's open question into a fresh run.
    // Preserve its artifacts while removing the obsolete completion obligation.
    if (g.study.archives.includes(e)) closeDirectStudy(e);
    recoverDirectStudy(e);
    delete e.generation;
    for (const s of e.submissions)
      if (s.status === "pending") {
        s.status = "error";
        s.feedback = s.completionRequest
          ? "Application restarted during evaluation. Retry the exact saved evaluation; its captured revision is retained."
          : "Application restarted during evaluation. Captured revision retained; resubmit to retry.";
        if (e.state !== "consumed") e.state = "in-progress";
      }
    interruptPending(
      e.executions,
      "Application restarted during execution. Captured code retained; run again to retry.",
      "status",
    );
  }
  for (const e of Object.values(g.encounters)) releaseSettledRequests(e);
  for (const e of g.study.archives) releaseSettledRequests(e, true);
  for (const a of g.study.assessments)
    if (a.status === "pending") {
      a.status = "review-required";
      a.provenance =
        "Application restarted during assessment. Evidence cutoff and request identity retained for retry.";
    }
  reconcileKnowledgeGaps(g);
  return g;
}
