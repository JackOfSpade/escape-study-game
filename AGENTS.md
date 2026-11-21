# Coding agents

This repository is an interview-preparation study workspace: a local browser app (`src/`, entry `src/main.ts`)
backed by a loopback bridge that runs AI tasks through the Claude CLI (`scripts/`). It began as an escape game;
that code was removed in November 2026 and lives only in git history, as does a shelved ChatGPT integration. Do
not resurrect or reference them, and treat any leftover game wording you find as a bug to remove. The provider
value `chatgpt-handoff` stays because saved records carry it.

## What to protect

- The learner's real record. Saves live in the browser (IndexedDB plus a localStorage copy) and may still carry
  fields written by earlier builds (legacy fields). Loading must keep working and those fields must be carried
  through untouched;
  `tests/legacy-save.test.ts` with `tests/fixtures/legacy-save/` guards this. Never change the save envelope,
  encoding or integrity scheme without an explicit migration.
- Persisted storage names and their legacy readers. The earlier build's names were migrated on 2026-11-20, and
  the old names must keep being read: the save key `dead-air-save-v1` (now `study-save-v1`), the IndexedDB
  databases `dead-air-durable-state` and `dead-air-lessons` (now `study-durable-state` and `study-lessons`; a
  legacy copy is read, carried over, and deleted only after the new copy is written), the roadmap export's
  `GAME_AI_ASSESSED_*` tokens and its "0.12 Game semantic scope and continuation state" heading (now
  `STUDY_AI_ASSESSED_*` and "0.12 Study semantic scope ..."; files exported or uploaded earlier still carry the
  old ones), and the diagnostics key `recent-game-diagnostics-v1` (now `recent-study-diagnostics-v1`). Never
  remove a legacy reader, and give any further rename the same backward-compatible migration, with tests. An
  unchanged re-export stays byte-identical because the saved export is reused while the semantic fingerprint is
  unchanged, so export prose may be reworded.
- The curriculum files in the repo root (`interview_prep_roadmap.md`, the hash fields of `SOURCE_INTEGRITY.json`,
  and `MANIFEST.sha256`) are integrity-pinned. Do not edit them. MANIFEST.sha256 is regenerated with
  `shasum -a 256 SOURCE_INTEGRITY.json interview_prep_roadmap.md > MANIFEST.sha256` if SOURCE_INTEGRITY.json's
  informational fields change.
- Exported formats (roadmap document export, career export, bug reports) and the bridge's wire formats.
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
