# Coding agents

## Gameplay changes: use the automated GameTest lab

This repository's Test Lab is an agent-facing regression framework. You can author and run scenarios entirely from files and the shell. Do not ask the user to open the visual lab, spawn entities or manually execute tests for you.

1. Read [the test authoring guide](docs/GAME_TEST_LAB.md). Inspect relevant existing JSON fixtures in `tests/fixtures/gametest/`, built-ins in `src/gametest/presets.ts`, and the typed schema in `src/gametest/schema.ts`.
2. Discover cases with `npm run --silent test:game -- --list --json -`. Run an existing case with `npm run --silent test:game -- --filter <id> --json -`.
3. For a gameplay bug, create or update a small deterministic JSON scenario in `tests/fixtures/gametest/<unique-id>.json`. Set up entities/walls, script tick-based actions, and assert the actual intended outcome. Demonstrate the regression before the fix when feasible. Keep assertions meaningful; do not weaken checks to obtain a pass.
4. Run the new case with `npm run --silent test:game -- --scenario tests/fixtures/gametest/<unique-id>.json --json - --artifacts .artifacts/game-tests`. Inspect failed checks, tick, expected/actual values and action outcomes in JSON.
5. After the change, run `npm run --silent test:agents`. It runs the entire built-in and checked-in scenario catalog unattended. Read `.artifacts/game-tests/report.json`; rerun a case using its result's `replay` path. Scenarios are automatically included in the normal core suite too.
6. Run relevant existing unit/browser checks and `npm run build` for the change. Report actual commands/results and any remaining limitations. Human playtesting for feel is separate from automated verification.

Current live fresh runs use `createPlayableGame` and scenarios with `layout: "randomized", rules: "force-fields"`, which build version 5 office floor plans (sectors, plan families and sub-rooms are described in `docs/FLOOR_PLAN_DESIGN.md`). Existing version 1 building fixtures default to legacy geometry, and `layout: "forward"` retains historical version 2/3 geometry for reproducibility. Include `building-footprint-consistency.json`, `building-randomized-egress.json` and `office-plan-vertical-gate.json` when checking current generation/navigation; retain `forward-room-exit.json` for historical coverage. See the guide before choosing a factory.

No dev server, graphical browser, AI model, paid API, Claude CLI call or human action is needed for headless scenarios. Each case uses a fresh memory-only synthetic world and real engine/physics. Preserve real saves, learner progress, curriculum, credentials and private conversations. Do not copy real saves into fixtures. Motor-only scenarios intentionally bypass NPC decisions; use `simulation: "game"` for normal AI behavior. A setup without assertions is unverified and exits nonzero.

For unsupported interactions/assertions, extend the typed scenario schema and runner with appropriate regressions, or write a TypeScript test using `TestRunner`. Imported scenarios are validated data; never evaluate arbitrary code from JSON. The optional `/lab.html` UI visualizes the same scenario format but is not required for agent work.
