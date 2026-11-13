import { ensureDoor } from "./doors";
import { displayScale } from "./display-scale";
import { createCheckpointQueue } from "./checkpoint-queue";
import { isEscapeState } from "./escape-state";
import { fnv1a } from "./hash";
import { reconcileKnowledgeGaps } from "./knowledge-probe";
import { type Game } from "./model";
import { checkpointPhysics } from "./physics";
import {
  closeDirectStudy,
  recoverDirectStudy,
  releaseSettledRequests,
} from "./run-learning";
import { readDurable, writeDurable } from "./storage";
import { parseSavedRunDesign } from "./run-design-contract.mjs";
import { sceneSaveErrors } from "./authored-scene";
import { groundExtractionPad, siteFormOf } from "./open-site";
import { startSite } from "./site";
import {
  assertDesignedEnvironment,
  bindDesignedEnvironment,
  rebindComposedObjects,
} from "./environment-save";
const KEY = "dead-air-save-v1";
interface Envelope {
  schema: 1;
  payload: string;
  checksum: number;
}
/** `revalidate: false` skips the immutable design's full re-check, the costliest
 * step of a save. Only background autosaves do that: every explicit and periodic
 * full save keeps the check, and load rejects a checkpoint that fails it. */
export function encode(g: Game, { revalidate = true } = {}) {
  if (revalidate) assertDesignedEnvironment(g);
  checkpointPhysics(g);
  const payload = JSON.stringify(g);
  return JSON.stringify({
    schema: 1,
    payload,
    checksum: fnv1a(payload),
  } satisfies Envelope);
}
export function decode(text: string): Game {
  const e = JSON.parse(text) as Envelope;
  if (
    e.schema !== 1 ||
    typeof e.payload !== "string" ||
    fnv1a(e.payload) !== e.checksum
  )
    throw Error("Save integrity check failed");
  const g = JSON.parse(e.payload) as Game;
  if (
    g.schema !== 1 ||
    !Array.isArray(g.floors) ||
    !Array.isArray(g.survivors) ||
    g.survivors[0]?.id !== "human" ||
    !g.study ||
    !g.surge
  )
    throw Error("Unsupported save");
  if (g.design) {
    g.design = parseSavedRunDesign(g.design);
    rebindComposedObjects(g);
    assertDesignedEnvironment(g);
    // Geometry and moved furniture remain authoritative. Immutable presentation
    // and collision descriptors must agree with the fingerprinted blueprint.
    for (const floor of g.floors) {
      const designedFloor = g.design.design.floors[floor.index];
      if (designedFloor) floor.design = designedFloor;
      else delete floor.design;
      if (floor.index === 0) floor.exteriorDesign = g.design.design.exterior;
      else delete floor.exteriorDesign;
      const setting = "setting" in g.design.design && g.design.design.setting;
      if (setting) floor.setting = setting;
      else delete floor.setting;
    }
  } else if (g.floors.some((f) => f.design || f.exteriorDesign || f.setting)) {
    throw Error(
      "Authored floor descriptors are missing their saved run design",
    );
  }
  // A run without a design cannot own composed furniture.
  if (!g.design) rebindComposedObjects(g);
  const startFloors = new Set(startSite(g).floors);
  for (const floor of g.floors) {
    // Stamped extra sites own their storeys' content; only the start site's
    // floors carry this save's authored scene.
    if (g.sites?.length && !startFloors.has(floor.index)) continue;
    const errors = sceneSaveErrors(floor, g.sites);
    if (errors.length)
      throw Error(
        `Invalid saved scene on floor ${floor.index}: ${errors.join("; ")}`,
      );
  }
  assertDesignedEnvironment(g);
  bindDesignedEnvironment(g);
  // An open start site's solid upper layers and its ground pickup are part of
  // the save. A save written before those optional fields existed is completed
  // here instead of losing the marked storeys or the extraction point.
  if (g.design && siteFormOf(g.design.design) === "open") {
    for (const floor of g.floors)
      if (startFloors.has(floor.index)) floor.open = true;
    const ground = g.floors[0];
    if (!g.extraction && ground) g.extraction = groundExtractionPad(ground);
  }
  // Discard retired door-hacking state without changing earned keys or field access.
  for (const a of g.survivors) {
    const legacy = a as unknown as Record<string, unknown>;
    if (legacy.hack || legacy.activity === "hacking") {
      a.activity = "exploring";
      a.path = [];
      a.repath = 0;
    }
    delete legacy.hack;
    delete legacy.hackAttempts;
    delete legacy.hackResult;
  }
  if (/hack/i.test(g.notice ?? ""))
    g.notice =
      "Locked doors require a key. Solve a solo terminal or find a green-lit entrance.";

  for (const floor of g.floors)
    for (const o of floor.furniture)
      if (o.id === "main-gate" && o.kind === "gate") ensureDoor(o, floor);
  dropInvalidEscape(g);
  return g;
}
/**
 * An escape state this build cannot read (an older or corrupted value) is
 * dropped and the run continues as a pre-escape save: losing the redesign
 * state is better than losing the run.
 */
function dropInvalidEscape(g: Game) {
  if (g.escape === undefined || isEscapeState(g.escape)) return;
  console.warn("Saved escape state failed validation; continuing without it.");
  delete g.escape;
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
 * megabyte there on every autosave hitches the game. IndexedDB still receives
 * it, and the queue above falls back to localStorage if that write fails. */
export function save(g: Game, options: { background?: boolean } = {}) {
  const payload = JSON.stringify({
    format: 2,
    serial: (serial = Math.max(serial + 1, Date.now() * 1000)),
    data: encode(g, { revalidate: !options.background }),
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
export async function load() {
  const { durable, local, durableError, localError } = await storedCopies();
  // An unreadable store may hold a newer checkpoint than the readable copy.
  // Starting from that older copy would overwrite unseen learning on save.
  if (durableError || localError)
    throw Error(
      "Saved checkpoints could not be read. Reload to retry storage access, or export a recovery backup before importing another run.",
    );
  const valid: { serial: number; game: Game }[] = [];
  for (const raw of [durable, local])
    if (raw !== null)
      try {
        valid.push(unpack(raw));
      } catch {}
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
export function recover(g: Game) {
  dropInvalidEscape(g);
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
  delete g.survivors[0].station;
  for (const e of new Set([
    ...Object.values(g.encounters),
    ...g.study.archives,
  ])) {
    e.chatOpen = false;
    delete e.groupRequest;
    interruptPending(
      e.groupRequests,
      "Application restarted; retry the exact saved group question.",
    );
    interruptPending(
      e.tutorRequests,
      "Application restarted; retry the exact saved private question.",
    );
    // Older saves could carry a previous run's open question into a fresh run.
    // Preserve its artifacts while removing the obsolete completion obligation.
    if (g.study.archives.includes(e)) closeDirectStudy(e);
    recoverDirectStudy(e);
    interruptPending(
      e.materializations,
      "Team-work request interrupted; retry the saved context.",
    );
    interruptPending(
      e.catchups,
      "Application restarted; the captured interval is retained for explicit retry.",
    );
    delete e.generation;
    for (const s of e.submissions)
      if (s.status === "pending") {
        s.status = "error";
        s.feedback = s.completionRequest
          ? "Application restarted during evaluation. Retry the exact saved evaluation; its captured revision is retained."
          : "Application restarted during evaluation. Captured revision retained; resubmit to retry.";
        if (e.state !== "consumed") e.state = "in-progress";
      }
    if (e.outcomeInspection?.state === "pending") {
      e.outcomeInspection.state = "interrupted";
      e.outcomeInspection.error =
        "Outcome inspection interrupted; retry its saved request and candidate.";
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
