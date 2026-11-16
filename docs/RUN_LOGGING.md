# Local diagnostics and bug reports

Diagnostics stay in this browser under `recent-game-diagnostics-v1` (in the durable store `dead-air-durable-state`), separate from the learning save. They are for agents and bug reports, not for download from the interface: read them with `window.__deadAir.logs()` on the page. No upload or model request is involved. The key name is historical and is kept so existing diagnostics stay readable.

## What is recorded

Each entry is `{at, type, data}`, where `at` is the record's time counter. The workspace records only:

- `terminal-message` (message length only) and `terminal-message-blocked` (empty message, or a tutor reply still pending);
- `question-regenerated` (question id and title);
- `browser-error` and `unhandled-rejection` (file, line, column and a message cut to 300 characters);
- `bug-report` (which action was used, its outcome and whether a description was given).

Diagnostics never hold drafts, conversations, question text or curriculum.

## Hard limits

- Entries are grouped by the record id (`Game.id`) that was open when they were written. Only the newest three records are kept; older ones are removed.
- At most 400 entries per record, oldest dropped first.
- Each serialized record is at most **256,000 UTF-8 bytes**; the oldest entries are dropped to fit.
- Each entry is serialized once when recorded, so retention and writes never re-serialize a whole record. Writes are ordered, and a slower older write cannot replace a newer one. If a write fails, the status line says diagnostics could not be saved.
- A damaged stored document is skipped without discarding valid records. Entries restored from storage are checked for shape and length.

Verify with `node --import tsx --test tests/run-logs.test.ts`. Tests use memory-only storage and synthetic records; they do not read real saves or learning history.

## Bug reports

**Report a bug** in the workspace toolbar opens a dialog with an optional description. **Copy to clipboard** posts the browser's part to the relay (`POST /api/bug-report`), which writes `.local/bug-reports/bug-report-<time>.md` and returns the path; the clipboard receives that path and the description, never the report body, so an assistant reads the file from disk. **Save to file** downloads the same report instead. If the relay does not answer, the browser's part alone is copied or downloaded.

A report holds:

- the description;
- page, build, viewport, view and Claude connection, plus the status lines on screen;
- the current question's state, tutor request states and its scheduling and provenance line (which the workspace no longer displays);
- the question text and conversation, unless the learner unticks that box;
- the browser diagnostics above, newest record first (the oldest detail entries are dropped past 600,000 characters);
- the newest 60 AI calls from `claude-usage.jsonl` (counts, timings and outcomes only);
- the last 120 lines of the relay log and the app server log, with repeated blocks collapsed to one copy and a count.

Reports are owner-only files. The newest 20 are kept and any older than seven days is removed on each write. Service log lines are timestamped. Verify with `node --import tsx --test tests/bug-report.test.ts tests/bug-report-diagnostics.test.ts`.
