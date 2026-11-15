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
- Generation evidence in `events`: `run-design` (title, source, site form, venue, surroundings, the design's request/generation ids and fingerprint, and the catastrophe's id, title and behaviour kinds) and `catastrophe-prepared` (`source` `ai` or `offline`, request count, whether a recent threat was re-asked, and for a fallback the `failure` — `request-failed`, `malformed`, `invalid` or `threw` — with the bounded transport error or first validator problem). Both are written once at the start of a run, where snapshots push them out of `entries` within about a minute; the audit copy lasts the whole run. An `offline` source means the player got the deterministic fallback catastrophe, not an authored one.
- `performance.playable` and `performance.spectator`: separate aggregate FPS, slow-frame counts and maximum frame/simulation/work times. Their sample counts and measured wall duration make the coverage explicit.
- `spectator`: compact recent spectator snapshots and important world events; post-death NPC activity cannot crowd the playable event history.
- `dropped`: counts of removed detailed entries, compacted timeline samples, evicted events and spectator records. A bounded log is not a complete replay.

Detailed snapshots identify sampled zombies and their current target/next route nodes. `zombieCount` and `zombiesOmitted` disclose the 80-zombie sampling cap. World events include their actual occurrence time, encounter and position where available, separately from capture time.

`marks` records the last logged world event and recent study transport states, so a page reload does not replay them into the same run; a new run also skips archived study requests that settled before its log began.

Old v1 logs still load. Missing or malformed audit metadata does not discard valid old detail records. Already-evicted history cannot be recovered; a newly observed historical run is marked partial.

Verify with `node --import tsx --test tests/run-logs.test.ts tests/frame-performance.test.ts`. Tests use memory-only synthetic worlds, including long spectator sessions, reloads, late study receipts, timeline compaction, Unicode bursts and repeated run eviction. They do not read real saves or learning history.

## Bug reports

**Report a bug** in the workspace toolbar opens a dialog with an optional description. **Copy to clipboard** posts the browser's part to the study bridge (`POST /api/bug-report`), which writes `.local/bug-reports/bug-report-<time>.md` and returns the path; the clipboard receives that path and the description, never the report body, so an assistant reads the file from disk. **Save to file** downloads the same report instead of saving it. If the bridge does not answer, the browser's part alone is copied or downloaded.

A report holds: the description; page, build, viewport, view and Claude connection; the on-screen status lines; the current question's state, tutor request states and its scheduling/provenance line (which the workspace no longer displays); the question text and conversation unless the learner unticks that box; the run diagnostics above, newest run first (lifecycle events in full, oldest detail entries dropped past 600,000 characters); the newest 60 AI calls from `claude-usage.jsonl` (counts, timings and outcomes only); and the last 120 lines of the bridge and app server logs with repeated blocks collapsed to one copy and a count.

Reports are owner-only files. The newest 20 are kept and anything older than seven days is removed on each write. Service log lines are now timestamped, and `browser-error` / `unhandled-rejection` entries carry the bounded error message. Verify with `node --import tsx --test tests/bug-report.test.ts`.
