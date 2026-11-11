# AI capture driver (manual only)

Plays the **real game** against the **real local study relay** (real Claude CLI
behind it) so the relay's opt-in replay-sample store collects realistic prompts
and answers for every AI operation. It is not part of `npm run test:browser` and
must not run in CI: it spends real Claude usage and real wall-clock time.

## 1. Start the relay with sample capture

```bash
npm run bridge:stop
ZOMBIE_AI_REPLAY_SAMPLES=1 npm run bridge:start
```

Leave it running. Every bridge call is written to
`.local/bridge-service/ai-replay-samples/<operation>/` (one payload + answer per
call), where `<operation>` is e.g. `generate`, `tutor`, `complete`, `assess`,
`group`, `materialize-work`, `materialize-outcome`, `review-environment`,
`reconcile-roadmap`, `npc-chatter`, `npc-chatter-review`, `design-run`.

Do not set `STUDY_BRIDGE_URL`: the capture Vite server proxies `/api` to the real
relay on `http://127.0.0.1:4318`. The driver mocks nothing under `/api`.

## 2. Run a capture

```bash
# 8 live questions, rotating simulated-learner personas (generate/tutor/complete/assess)
npm run ai:capture -- study.capture.ts

# 15 minutes of a live run with the whole cast: chatter, group chat, NPC work
CAPTURE_NPC_MINUTES=15 npm run ai:capture -- npc.capture.ts

# 3 review-environment + 3 reconcile-roadmap samples
CAPTURE_EVIDENCE=3 npm run ai:capture -- evidence.capture.ts

# real level designs — expensive, roughly an hour each
CAPTURE_DESIGN=1 CAPTURE_DESIGNS=1 npm run ai:capture -- design.capture.ts
```

Environment knobs: `CAPTURE_QUESTIONS` (default 8), `CAPTURE_NPC_MINUTES`
(default 15), `CAPTURE_EVIDENCE` (default 3), `CAPTURE_DESIGNS` (default 1),
`CAPTURE_TIMEOUT_MIN` (default 120), `CAPTURE_PORT` (default 5279).

## 3. Cost and the simulated learner

- The tutor, assessor, reviewer and designer calls are real Claude CLI calls
  through the relay. A full `study.capture.ts` run is dozens of tutoring calls;
  a real design is one large multi-stage run that can take up to an hour.
- The _learner_ is a real but cheap model: `learner.ts` shells out to the
  `offload` CLI (`OFFLOAD_BIN`, default `offload` on `PATH`) with
  `{"route":"deepseek-flash","caller":"zombie-ai-capture","tag":"learner","maxTokens":700,...}`,
  i.e. DeepSeek Flash, not Claude.

## 4. Cheap checks before a live run

```bash
node --import tsx --test tests/ai-capture/learner.test.ts   # pure helpers, spawns nothing
npx tsc --noEmit                                            # whole project typechecks
```
