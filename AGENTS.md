# Coding agents

This repository is an interview-preparation study workspace: a local browser app (`src/`, entry `src/main.ts`)
backed by a loopback bridge that runs AI tasks through the Claude CLI (`scripts/`). There is no game in it. An
earlier escape game was removed in November 2026; it survives only in git history. Do not resurrect or reference
it, and treat any leftover game wording you find as a bug to remove.

## What to protect

- The learner's real record. Saves live in the browser (IndexedDB plus a localStorage copy) and may still carry
  fields written by the old game. Loading must keep working and those fields must be carried through untouched;
  `tests/legacy-save.test.ts` with `tests/fixtures/legacy-save/` guards this. Never change the save envelope,
  encoding or integrity scheme without an explicit migration.
- The curriculum files in the repo root (`interview_prep_roadmap.md`, `MANIFEST.sha256`,
  `SOURCE_INTEGRITY.json`, `START_HERE.md`, `ACCEPTANCE_TESTS.md`, `GAME_DESIGN_HANDOFF.md`) are integrity-pinned.
  Do not edit them.
- Exported formats (roadmap document export, career export, bug reports) and the bridge's wire formats.
- `shelf/` is a separate archive (the shelved ChatGPT integration). Leave it alone unless asked.
- The owner's running app on port 5173 and bridge on 4318. Never start, stop or signal them, and never copy real
  saves into fixtures.

## Verifying a change

1. `npm run typecheck` and `npm run format:check`.
2. Unit tests: `npm test`, or one file with `node --import tsx --test tests/<file>`. Tests that start servers use
   random ports.
3. Browser tests: `npx playwright test` (optionally a spec path). The config starts its own isolated Vite server on
   `STUDY_TEST_PORT` (default 5278) and points the bridge at a dead port; specs mock `/api` themselves. No real
   Claude call, provider or human action is needed.
4. Code-runner tests need Docker: `npm run test:runner` and `npm run test:browser:runner`.
5. `npm run build` for anything that ships.

Report the commands you ran and their real results, including failures.
