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
import {
  readCurrentDurable,
  readLegacyDurable,
  retireLegacyDurable,
  writeDurable,
} from "./storage";
import { briefError, studyEvent } from "./study-events";
const KEY = "study-save-v1";
/**
 * The save's key before the rename, in localStorage and in the earlier
 * database (`LEGACY_DB` in storage.ts). Both copies are still read, so a save
 * from before the update, or from a tab still running the earlier build, is
 * never shadowed by an older one. A legacy copy is removed only after a copy
 * at least as new is safely written under the new names (see AGENTS.md).
 */
const LEGACY_KEY = "dead-air-save-v1";
interface Envelope {
  schema: 1;
  payload: string;
  checksum: number;
}
/** Saves written by earlier builds hold more fields than `StudyRecord` declares
 * (legacy simulation state). They are neither read nor validated and are
 * written back unchanged. */
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
    retireLegacyLocal(checkpointSerial);
    return;
  }
  // The strict transaction completed: this checkpoint is on disk under the new
  // name, so older legacy copies are redundant. Removing the localStorage one
  // also frees quota for the next synchronous mirror.
  retireLegacyLocal(checkpointSerial);
  retireLegacyStore(checkpointSerial);
});
/** Whether a legacy copy may go now that `written` is safely stored. A valid
 * copy may go when it is not newer. A damaged one has no readable serial, so
 * it goes only once `load()` offered its bytes to the learner, exactly as a
 * damaged copy under the new name is replaced by the next save. */
function legacyDiscardable(raw: unknown, written: number) {
  if (typeof raw !== "string") return false;
  try {
    return unpack(raw).serial <= written;
  } catch {
    return (
      rejected?.raw === raw ||
      !!rejected?.others?.some((copy) => copy.raw === raw)
    );
  }
}
function retireLegacyLocal(written: number) {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (raw === null || !legacyDiscardable(raw, written)) return;
    localStorage.removeItem(LEGACY_KEY);
    studyEvent("save-legacy-copy-removed", { store: "legacy-local" });
  } catch (error) {
    studyEvent("save-legacy-cleanup-failed", {
      store: "legacy-local",
      error: briefError(error),
    });
  }
}
let legacyStoreGone = false,
  legacyRetiring: Promise<void> | undefined;
/** Best effort and never awaited by a save: a delete blocked by another tab
 * stays pending in the browser, and a failure is retried by a later save. */
function retireLegacyStore(written: number) {
  if (legacyStoreGone || legacyRetiring) return;
  const retiring = retireLegacyDurable(
    LEGACY_KEY,
    (raw) => legacyDiscardable(raw, written),
    () =>
      studyEvent("save-legacy-cleanup-blocked", { store: "legacy-durable" }),
  ).then(
    (result) => {
      if (result !== "kept") legacyStoreGone = true;
      if (result === "deleted")
        studyEvent("save-legacy-copy-removed", { store: "legacy-durable" });
    },
    (error) =>
      studyEvent("save-legacy-cleanup-failed", {
        store: "legacy-durable",
        error: briefError(error),
      }),
  );
  legacyRetiring = retiring;
  void retiring.finally(() => {
    if (legacyRetiring === retiring) legacyRetiring = undefined;
  });
}
/** Settles once a running legacy cleanup finishes (for tests). */
export function legacyCleanupSettled() {
  return legacyRetiring ?? Promise.resolve();
}
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
  return { serial: stored.serial, record: decode(stored.data) };
}
/** Whether the last full save reached the localStorage fallback copy. */
let mirrorCurrent = true;
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
  if (!options.background) {
    try {
      localStorage.setItem(KEY, payload);
      checkpoint = true;
      retireLegacyLocal(serial);
    } catch (error) {
      // IndexedDB still takes this save, so nothing is shown to the learner;
      // the fallback copy, though, now stays at an older checkpoint.
      if (mirrorCurrent)
        studyEvent("save-fallback-copy-failed", {
          chars: payload.length,
          error: briefError(error),
        });
    }
    if (checkpoint && !mirrorCurrent)
      studyEvent("save-fallback-copy-restored", { chars: payload.length });
    mirrorCurrent = checkpoint;
  }
  return checkpoints.enqueue({ payload, checkpoint, serial });
}
async function attempt(read: () => string | null | Promise<string | null>) {
  try {
    return { raw: await read() };
  } catch (error) {
    return { raw: null, error: String(error) };
  }
}
async function storedCopies() {
  const durable = await attempt(() => readCurrentDurable(KEY)),
    local = await attempt(() => localStorage.getItem(KEY)),
    legacyDurable = await attempt(() => readLegacyDurable(LEGACY_KEY)),
    legacyLocal = await attempt(() => localStorage.getItem(LEGACY_KEY));
  return {
    durable: durable.raw,
    local: local.raw,
    legacyDurable: legacyDurable.raw,
    legacyLocal: legacyLocal.raw,
    durableError: durable.error,
    localError: local.error,
    legacyDurableError: legacyDurable.error,
    legacyLocalError: legacyLocal.error,
  };
}
/** Preserve the original stored bytes, including a damaged or unreadable copy.
 * Nothing in the app reads a recovery file back (a backup is imported as a
 * plain encoded record), so the format name changed with the storage names
 * and needs no reader for the earlier "dead-air-recovery-v1" name. */
export async function exportRecoveryBackup() {
  return JSON.stringify(
    {
      format: "study-recovery-v1",
      key: KEY,
      legacyKey: LEGACY_KEY,
      ...(await storedCopies()),
    },
    null,
    2,
  );
}
/** A stored copy that failed validation while the other copy loaded. */
export interface RejectedCopy {
  store: "durable" | "local" | "legacy-durable" | "legacy-local";
  /** The stored bytes exactly as they were read. */
  raw: string;
  reason: string;
  /** Further refused copies when more than one store held damaged bytes;
   * they ride along in the same download. */
  others?: Omit<RejectedCopy, "others">[];
}
let rejected: RejectedCopy | undefined;
/** The copy the last `load()` refused although it returned the other one.
 * It may have been the newer checkpoint, and the next save replaces it. */
export function rejectedCopy() {
  return rejected;
}
export async function load() {
  const copies = await storedCopies();
  // A fresh look at storage: the first save checks for the legacy database again.
  legacyStoreGone = false;
  const unreadable = Error(
    "Saved checkpoints could not be read. Reload to retry storage access, or export a recovery backup before importing a backup.",
  );
  // An unreadable store may hold a newer checkpoint than the readable copy.
  // Starting from that older copy would overwrite unseen learning on save.
  if (copies.durableError || copies.localError) throw unreadable;
  // An unreadable legacy copy only blocks loading while the same store has no
  // copy under the new name; once it has, the legacy one predates it.
  for (const [store, error, replacement] of [
    ["legacy-durable", copies.legacyDurableError, copies.durable],
    ["legacy-local", copies.legacyLocalError, copies.local],
  ] as const)
    if (error) {
      if (replacement === null) throw unreadable;
      studyEvent("save-legacy-read-failed", {
        store,
        error: briefError(error),
      });
    }
  const valid: { serial: number; record: StudyRecord }[] = [];
  const refused: RejectedCopy[] = [];
  const stored = [
    ["durable", copies.durable],
    ["local", copies.local],
    ["legacy-durable", copies.legacyDurable],
    ["legacy-local", copies.legacyLocal],
  ] as const;
  for (const [store, raw] of stored)
    if (raw !== null)
      try {
        valid.push(unpack(raw));
      } catch (error) {
        refused.push({ store, raw, reason: String(error) });
      }
  // A refused copy has no readable serial, so it may be the newer one. Keep
  // its bytes: the next save overwrites it in storage.
  rejected = valid.length
    ? refused.length > 1
      ? { ...refused[0], others: refused.slice(1) }
      : refused[0]
    : undefined;
  if (!valid.length) {
    if (stored.some(([, raw]) => raw !== null))
      throw Error(
        "Saved checkpoints failed integrity checks. Export a recovery backup before starting over.",
      );
    return null;
  }
  valid.sort((a, b) => b.serial - a.serial);
  serial = valid[0].serial;
  return valid[0].record;
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
