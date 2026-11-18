# Interview-prep study workspace

A local browser app for interview preparation. It follows a fixed curriculum (`interview_prep_roadmap.md`, revision 9: 80 Python objectives and 112 Product Engineering objectives), asks one question at a time, tutors the learner in a conversation, runs code on request, and assesses the finished work against the original source criteria.

Every AI task runs through the signed-in Claude CLI on this computer, using `scripts/claude-gateway.mjs` behind a loopback relay. Install the CLI and run `claude auth login` first. No API key is used. Without the CLI the app opens, but questions cannot be prepared and nothing earns academic credit.

## Using it

The workspace shows a skill map of the current tier, a progress summary, and a terminal for the open question.

1. **Start next question** asks Claude for the next question the curriculum schedules. A question can be regenerated before it is answered.
2. Answer in the conversation beside the question. The tutor probes for what you already know, records gaps, and gives footholds rather than full answers.
3. The tutor's reply decides when the question is finished; there is no separate submit step.
4. A separate assessment judges the frozen question and its evidence. Finishing a question never certifies mastery on its own.

The menu (Menu or Esc) holds Settings: display scale, the role profile, the Claude connection, and full backup export and import. **Report a bug** in the toolbar writes a diagnostic report (see [run logging](docs/RUN_LOGGING.md)).

The role profile controls future scheduling only. "Product feature owner (consumer and creative web)" narrows the Product Engineering track to 51 core objectives at depth 3 or less; "Full original curriculum" restores everything. Changing it never rewrites source cells, evidence or reviews. See [question design](docs/QUESTION_DESIGN.md).

The inspector (readiness, recorded knowledge, practical environment observations, roadmap export, roadmap review and adoption) is not part of the learner interface. Coding agents open it with `window.__deadAir.openAgentMenu()` in a synthetic browser context.

## Run

Requires Node.js 22.12 or later and npm.

```sh
npm ci
npm run import:curriculum
npm run dev
```

Open http://127.0.0.1:5173. `npm run dev` starts Vite and reconnects to, or starts, the persistent relay.

For production, run `npm run build` and then `npm start`. This serves only `dist` on `127.0.0.1:5173` (`PORT` overrides), reconnects the relay and proxies its API at the same origin, so browser saves stay valid. HTML and curriculum bypass caches; `GET /_app-health` reports the running build fingerprint. `npm run preview` is a temporary bundle preview and does not start the relay.

On the owner's macOS workstation a LaunchAgent (`com.jack.zombie-study-escape`) supervises `npm start`. Deploy by building, then terminating the old server process and letting launchd respawn it; never start a second copy.

## Claude CLI relay

`scripts/bridge-server.mjs` is a loopback relay on `127.0.0.1:4318`, launched and tracked by `scripts/bridge-service.mjs`. It runs each AI task as one `claude -p` call: no tools, none of your own Claude settings, memory or MCP servers, and any `ANTHROPIC_*` variables removed. Each task has its own model and effort in `TASK_PROFILES`. The relay runs apart from the dev server, so restarting Vite does not interrupt a running task. Manage it with `npm run bridge:start`, `npm run bridge:status` and `npm run bridge:stop`. After changing relay code, stop it so the next start loads the change.

The operations, their contracts and the answer validators are described in [AI tasks](docs/AI_TASKS.md); how models and efforts were chosen is in [AI model and effort selection](docs/AI_MODEL_SELECTION.md).

## Learning evidence

- A scheduled question records its pending formal task before any answer exists. Reading it gives no visit and no evidence.
- Assessment uses the frozen task and an evidence cutoff, with human and assistant turns attributed separately. A scope-coverage review checks the complete original source criteria, not whether the latest answer was correct.
- Supplied solutions and tutor help cannot become independent proof. Execution claims need a runner receipt; a model's statement that it ran tests creates none.
- Every model reply is validated locally before it is applied. A reply cannot grant a pass, a facet or mastery by itself.
- The source curriculum stays byte-identical to the supplied revision 9. Import verifies the whole-file hash, the three protected blocks and the objective counts. Roadmap progress exports (Markdown) preserve protected bytes, project current checkpoints, facets, reviews and attempts, and record the hash of the preceding complete revision; unchanged exports are byte-identical. Raw prompts, code, answers and conversations stay in the JSON backup, never in the roadmap.
- Uploaded roadmap revisions can be compared against saved progress (structural review only) and, with the Claude CLI connected, reconciled by a model proposal that is validated, shown in full, and adopted only on explicit request. Adoption rechecks current state and creates no new academic demonstration.

## Persistence

The save is one record holding the learning state, its questions and conversations, and the settings. It is saved after question, message and submission activity and when the window loses focus, the tab hides or the page closes; the menu also has a Save button. Durable saves use IndexedDB with a checksummed envelope and monotonic checkpoint order, plus a synchronous localStorage copy when quota allows. If either copy cannot be read or fails its integrity check, the recovery screen protects the stored data from autosaves; retry, export the raw recovery data, or explicitly restore a valid backup. Settings also exports and imports a full JSON backup. Storage is browser-local: clearing it deletes the save.

Saves written by earlier versions of the app carry extra fields. They load unchanged, the learning record is read from them as usual, and the extra fields are written back untouched. `tests/legacy-save.test.ts` with `tests/fixtures/legacy-save/` guards this.

Interrupted requests keep their exact question and request identity. A lost acknowledgement retries safely, an unsent draft or interrupted question is never treated as learning, and an assessment captures its evidence before waiting for a connection.

## Code execution

Questions at depth 2 or above can carry a runtime (Python, TypeScript or JavaScript, or an isolated React environment). Execution is optional and needs Docker. Install the ordinary images explicitly:

```sh
docker pull python:3.12-alpine
docker pull node:22
# Optional browser/React runtime, pinned base and package lock:
docker build -t zombie-escape-browser-runtime:0.1.0 scripts/browser-runner
node scripts/preflight-browser-runner.mjs
npm run test:runner
npm run test:browser:runner
```

The relay resolves each installed image to an immutable image ID, never pulls during a job, and never falls back to running on the host. `CODE_RUNNER_PYTHON_IMAGE` and `CODE_RUNNER_NODE_IMAGE` select trusted installed alternatives; `CODE_RUNNER_REACT_IMAGE` does the same for React. Runs use a non-root user, a read-only root filesystem, no network, no host mounts or Docker socket, dropped capabilities and no new privileges, with bounded CPU, memory, processes, temporary storage, wall time and output. One relay job runs at a time. Errors, limits and unavailable Docker stay visible.

A React task is a single TSX module with a default-export component, run in sandboxed Chromium inside a separate container. The controller captures bounded console output, DOM text, up to eight selector interactions or checks and an optional 640x400 JPEG. TypeScript is transpiled, not type-checked.

Each run preserves the exact code, revision, edit references, code hash, image ID, exit status and output as a receipt. Running code never completes a task or awards mastery by itself; output is treated as text. Rebuild the browser runtime after changing its controller. Restart the relay after changing backend modules.

## Tests

```sh
npm run typecheck
npm run format:check
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

`npm test` runs the TypeScript and JavaScript unit tests in `tests/` (it imports the curriculum first). One file: `node --import tsx --test tests/<file>`. CI shards the same list with `scripts/ci-tests.mjs`.

`npm run test:browser` runs Playwright against its own isolated Vite server on `STUDY_TEST_PORT` (default 5278) with the relay pointed at a dead port; specs mock `/api` themselves. It reuses nothing running, and one browser runs at a time. `playwright.ci.config.ts` is the offline CI configuration on port 5279. Container-backed specs run only with `npm run test:browser:runner`.

Tests use synthetic curricula, fixtures and gateway replies. They do not show live Claude quality, and no human has certified any learner.

## Known limitations

- Claude's question, tutoring and assessment quality has limited external spot-check evidence and is not independently certified. The evidence transaction and scheduling pipeline is verified with isolated fixtures, not a live model.
- Reconciliation corrections that involve later verified retention or a material contradiction are rejected pending dedicated reassessment, and semantic conflict resolution for session collisions is unfinished.
- Practical environment (ENV) review is optional and verified with synthetic judgments; see [practical observations](docs/ENVIRONMENT_OBSERVATIONS.md).
- D1 is reasoning and trace work. Code execution needs Docker and records an observation, not correctness.
- Model and effort settings come from measured but synthetic cases; see [AI model and effort selection](docs/AI_MODEL_SELECTION.md).

## More documentation

[Architecture](docs/ARCHITECTURE.md), [AI tasks](docs/AI_TASKS.md), [AI model and effort selection](docs/AI_MODEL_SELECTION.md), [question design](docs/QUESTION_DESIGN.md), [run logging and bug reports](docs/RUN_LOGGING.md), [practical environment observations](docs/ENVIRONMENT_OBSERVATIONS.md), [CI and merging](.github/CI_POLICY.md). Coding agents also read [AGENTS.md](AGENTS.md).
