# Architecture and authority

TypeScript, a semantic DOM and Vite build the local browser app (`src/`, entry `src/main.ts`, markup in `src/study-shell.html`). A small Node relay (`scripts/`) runs AI tasks through the Claude CLI and runs learner code in Docker. The browser holds the learner's record and is authoritative for it; the relay validates request shape and holds no learner state of its own.

## Browser modules

**Shell and workspace**

- `main.ts`: loads the roadmap and the save, mounts the shell, owns saving, the menu, settings, import/export and page lifecycle, and wires the modules below together. It exposes `window.__studyApp` (`record`, `roadmap`, `openAgentMenu()`, `logs()`) for agents and browser specs.
- `study-session.ts`: the workspace's controls: status line, save indicator and the start, retry, re-review and regenerate buttons.
- `study-workspace.ts`: which question the workspace shows (an unfinished one before a new one), how the next question is requested, and the progress summary. `study-map.ts` and `study-workspace-view.ts` project the topic map and own its disclosure, scroll and keyboard focus; `study-progress.ts` and `study-progress-reveal.ts` supply the counts and the animated progress change. `study-workspace.css` holds the layout.
- `terminal-panels.ts`, `terminal-request.ts`, `execution-presentation.ts`: the open question's provenance, conversation, submission state and run output. A terminal request settles once, saves, and records any failure on the question instead of throwing.
- `inspector-panel.ts` / `inspector-view.ts`: readiness, recorded knowledge, topic switches, environment observations, roadmap review and adoption, saved assessments and exports. Pure HTML builders are separate from handlers.
- `bug-report.ts`, `run-logs.ts`, `connection-steps.ts`, `display-scale.ts`, `dom.ts`, `html.ts`, `markdown.ts`: report dialog, bounded diagnostics ([run logging](RUN_LOGGING.md)), the steps shown when Claude is not connected, the display preference, DOM helpers, escaping, and a dependency-free markdown renderer for untrusted model text (no links, images or raw HTML).

**Questions and tutoring**

- `ai.ts`: question generation, tutor messages (streamed, display-only until validated), submission and completion checks, regeneration and retry. Every call goes through `bridge-client.ts`. A saved request keeps the provider that captured it.
- `bridge-client.ts`: the handshake (`GET /api/status`) and `POST /api/bridge`, with timeouts, plain-text proxy errors and NDJSON streaming. It only moves requests; learning stays in the owning modules.
- `question-parts.ts`: a question with several asks shown one part at a time: which part is open, the question pane's markup, the "Next part" offer and which messages the conversation shows. The rules and validators are in `scripts/lib/question-parts.mjs`.
- `knowledge-probe.ts`: the tutor's probing stance and its validated reply (`outcome`, findings, implied and declared sub-facets, answer signals), per-question probe state and the carried established-knowledge and gap records. Probe observations are never ledger mastery.
- `topic-assessment.ts`: narrative topic reflections, validated whole before any effect applies. Never curriculum proof.
- `completion-verdict.ts`, `record.ts`, `run-learning.ts`, `provider-label.ts`, `live-study.ts`: completion verdict parsing; the empty record a first visit starts from; settling tutor requests and recovering saved chat sessions as data; labels for saved providers; moving a save recorded on the old practice profile to the live profile with its ledger intact.

**Lessons**

- `lesson-surface.ts`: the lesson screen opened from a recorded gap (two panes: the lesson, and a tutor chat that only answers about it) and its entry points, the offers under a finished question and the map's list of open gaps. The lesson body is mounted once; repaints only touch status text, buttons and the chat. Which lesson is open is memory only. `lesson.css` holds the layout and the block styles.
- `lesson.ts` / `lesson-store.ts`: the controller (request payloads, request identity and retry, chat, saved answers) and its separate IndexedDB database `study-lessons` (earlier builds used `dead-air-lessons`, which is carried over on first open), with checksummed rows that fail closed. `lesson-types.ts` holds the record types.
- `gapPracticeQuestion` (`study-workspace.ts`) opens an empty question for "Test me on this", and `seedGapPractice` (`ai.ts`) seeds its `generate` request with the recorded gap's contract marked `practice`; a practice question is never the scheduled visit and is not assessed.
- `lesson-render.ts` / `lesson-figures.ts`: turn a validated lesson into a safe node tree and draw it with `createElement` and `textContent`. Prose goes through `markdown.ts`; diagrams and step-through figures are drawn from data. `scripts/lib/lesson-schema.mjs` (shared with the relay) validates the model's JSON and `lesson-policy.mjs` holds what the model is told.

**Curriculum and ledger**

- `curriculum.ts`: the scheduler view over the roadmap, eligibility, visit bookkeeping and the evidence packet handed to assessment. `career-profile.ts` is the reversible role overlay (51 core Product Engineering objectives, depth at most 3) that changes future scheduling only.
- `learner.ts` / `learning-model.ts`: the source-bound live ledger: stable generated facet definitions, scoped assessment transactions, immutable receipts, formal session, attempt and evidence IDs, review timing, lower-gate reopening, suspended higher positions and continuations. Whole checkpoints need complete independently evidenced facet coverage plus a separate scope-coverage review; a model pass flag alone cannot change them.
- `learning-assessment.ts`: captures one evidence packet per assessment cutoff. Reload and retry preserve those exact bytes; a late reply must still match the question, provider, study and learner.
- `workspace-history.ts`: exact revision reconstruction from attributed editor deltas, so full drafts are not stored per keystroke; accepted submissions are immutable snapshots.
- `final-requirements.ts`, `retention-history.ts`, `historical-proof.ts`, `historical-scope.ts`, `imported-proof.ts`, `observation-validity.ts`, `baseline-correction.ts`: Tier-4 transfer and integration requirements and readiness; replay of receipt-backed delayed reviews; structural source checks for historical and imported facet mappings; invalidation and reviewed correction of earlier evidence. Structural checks complement, never replace, the assessor's semantic judgment.

**Roadmap export and adoption**

- `roadmap-document.ts` (also used by the build importer through its shared reader), `roadmap-structure.ts`, `roadmap-identifiers.ts`, `roadmap-export.ts`, `roadmap-review.ts`, `roadmap-adoption.ts` with `-types`, `-ui`, `roadmap-active-work.ts`, `roadmap-attempt-updates.ts`, `roadmap-branch-records.ts`, `roadmap-exposure.ts`: reading a saved document without trusting it; shared high-water identifier counters (adoption cannot lower them); the complete source-preserving Markdown export with actual-parent SHA-256 ancestry and a persisted cache so unchanged downloads are byte-identical; inert upload review; model-proposed reconciliation as exact edits, compiled and revalidated before explicit adoption; capture of active attempts; preserved unresolved branch histories.
- `environment-observations.ts`, `environment-review.ts`, `environment-status.ts`, `environment-ui.ts`: practical environment capture and explicit review ([practical observations](ENVIRONMENT_OBSERVATIONS.md)).

**Execution**

- `execution.ts`: eligibility (live profile, a runtime on the question, depth 2 or above and a match with the scheduled scope) and `POST /api/execute`. Receipts carry the code, revision, hashes, image ID and output; they are observations, not correctness.

**Persistence**

- `persistence.ts` / `storage.ts` / `checkpoint-queue.ts`: a checksummed envelope (FNV-1a, `hash.ts`) inside a serialised checkpoint, stored in IndexedDB with a synchronous localStorage copy when quota permits. One durable write is in flight and only the newest waiting checkpoint is kept; an older failed write cannot replace a newer synchronous copy. Unreadable stores or invalid checkpoints trigger write protection and a raw recovery export instead of replacing saved learning. Legacy fields in a loaded save are carried through unread and unchanged.
- `model.ts`, `records.ts`, `digest.ts`: the serialisable state types, record narrowing, SHA-256.

## Scripts

- `scripts/import-curriculum.mjs`: validates the source bytes and protected digests before creating `public/curriculum.json`. Any source update needs an explicit import and migration.
- `scripts/bridge-service.mjs` / `bridge-server.mjs` / `study-bridge-server.mjs`: the persistent relay. It binds loopback, rejects non-loopback origins, accepts only known operations and bounded JSON, and serves `/api/status`, `/api/bridge`, `/api/execute` and `/api/bug-report`. `private-socket.mjs`, `lib/private-fs.mjs` and owner-only files protect its state.
- `scripts/claude-gateway.mjs`: each AI task is one Claude CLI call with no tools and none of the user's settings; per-task model and effort (`TASK_PROFILES`); stable reference data in the cached system prompt; streamed tutor text; named errors for usage limits and signed-out sessions; a per-call usage log. `scripts/lib/ai-contracts.mjs` holds the operation contracts and validators, `lib/probe-reply.mjs` the probe reply, `lib/topic-assessment.mjs`, `lib/study-question-policy.mjs` and `lib/roadmap-edits.mjs` the shared policies. See [AI tasks](AI_TASKS.md).
- `scripts/code-runner.mjs`, `browser-runner.mjs`, `browser-container.mjs`, `runner-*.mjs`, `execution-route.mjs`, `scripts/browser-runner/`: disposable Docker execution.
- `scripts/serve.mjs`: production loopback server for `dist`. Static paths stay inside `dist`; API requests are proxied with their body and Origin to the separately owned relay, which is relaunched on the next call if it died. The app keeps the development origin so browser saves stay valid.
- `scripts/dev.mjs`, `ci-tests.mjs`, `bug-report-route.mjs`, `http-json.mjs`: dev launcher, CI test sharding, bug-report writer, bounded JSON input.
- `scripts/ai-ladder.mjs`, `ai-judge.mjs`, `ai-usage-report.mjs`, `ai-capture/`: measurement tooling ([AI model and effort selection](AI_MODEL_SELECTION.md)).

## Trust boundaries

Lessons are model-written data, not markup: the relay validates a typed JSON document, and trusted code in the browser draws every block, so no model string reaches `innerHTML` unescaped, an attribute, a URL, a style or an event handler. A lesson is never evidence. It, its checks and its chat live only in the `study-lessons` database; they never write the learner's record, never set a gap's `resolved`, and are never sent into question, assessment or tutor requests. A gap closes only when a question shows the learner has it, and the saved record is untouched by anything in a lesson.

Model, tutor and question text is escaped or assigned through `textContent`; markdown has no links or raw HTML. Structured completion and evidence replies pass scoped validators and cannot grant a pass, key or mastery by themselves. The relay accepts only known operations and bounded JSON, binds loopback, and starts the Claude process without `ANTHROPIC_*` variables. It never evaluates submitted code itself: `/api/execute` delegates to disposable Docker containers with no network or host mounts, a non-root user, a read-only root filesystem, dropped capabilities and bounded resources, and there is no host fallback.

The client is authoritative for a local single-user record, not an adversarial service. Import is for the owner's own exported backups; validation checks the envelope, integrity and core structure rather than every nested field, so do not import untrusted files.

Human editor evidence stores revision snapshots and the inserted and removed text, so supplied starter code stays distinct from the learner's edits. Question and starter exposure is recorded once, when first presented. The assessor receives these sources, the human's actual artifacts, private help, the accepted submission and the authoritative track criteria; a changed or missing attribution of supplied context cannot certify independent work.

Question keys combine a run identity with the question id. Pending assessments retry with their original evidence cutoff, and interrupted live requests never substitute other completions.

The roadmap export transaction is complete. Importing a roadmap edited elsewhere goes through review and reconciliation (above); a JSON backup resumes the full ledger and raw artifacts.
