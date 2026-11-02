# Local run diagnostics

Diagnostics stay in this browser under `recent-game-diagnostics-v1`, separate from saves and learning history. The agent-only `window.__deadAir.logs()` hook exports them. No upload or model request is involved.

## Hard limits

- Newest three runs only; older runs are automatically removed.
- Each complete serialized run is at most **256,000 UTF-8 bytes**, including all summaries and audit metadata. The document adds a small fixed JSON envelope.
- At most 400 detailed entries per run. Real worlds reserve 64,000 bytes of that same budget for lifecycle evidence; this is not additional storage.
- Audit arrays have independent caps: 48 timeline checkpoints, 96 important events and 24 spectator records. A further byte cap handles long Unicode metadata.
- Writes remain ordered and coalesced, and cached detail entries are not serialized again on each record.

## Evidence retained

`entries` contains the bounded playable detail tail. After the human dies or escapes, spectator sampling stops replacing these entries. The `audit` contains:

- `configuration`: rules, pacing and generator version.
- `firstObservedAt` / `partial`: whether observation began after the start of the run. Historical logs without an audit have unknown coverage.
- `timeline`: compact human state, survivor/zombie counts by floor and world counters, sampled about every 30 simulation seconds. Compaction preserves the opening and distributed later checkpoints.
- `ended`: the human's end time and observed final state. `data.observedAt` and `data.exact` distinguish a timely capture from first observing an already-ended save. Later spectator changes do not rewrite this evidence.
- `events`: bounded lifecycle, error and study request metadata, including late response/application receipts. Captured metadata excludes question text, answers, transcripts, credentials and private curriculum.
- `performance.playable` and `performance.spectator`: separate aggregate FPS, slow-frame counts and maximum frame/simulation/work times. Their sample counts and measured wall duration make the coverage explicit.
- `spectator`: compact recent spectator snapshots and important world events; post-death NPC activity cannot crowd the playable event history.
- `dropped`: counts of removed detailed entries, compacted timeline samples, evicted events and spectator records. A bounded log is not a complete replay.

Detailed snapshots identify sampled zombies and their current target/next route nodes. `zombieCount` and `zombiesOmitted` disclose the 80-zombie sampling cap. World events include their actual occurrence time, encounter and position where available, separately from capture time.

`marks` records the last logged world event and recent study transport states, so a page reload does not replay them into the same run; a new run also skips archived study requests that settled before its log began.

Old v1 logs still load. Missing or malformed audit metadata does not discard valid old detail records. Already-evicted history cannot be recovered; a newly observed historical run is marked partial.

Verify with `node --import tsx --test tests/run-logs.test.ts tests/frame-performance.test.ts`. Tests use memory-only synthetic worlds, including long spectator sessions, reloads, late study receipts, timeline compaction, Unicode bursts and repeated run eviction. They do not read real saves or learning history.
