# ChatGPT stack, shelved

The ChatGPT chat workers, tunnel, connector and terminal apps were retired when the game moved to the Claude CLI. They live here so they can return if ChatGPT chats become usable again. Nothing in this folder is built, type-checked or tested.

The exact working stack before the move is the annotated tag `archive/chatgpt-stack-v1`, also on the branch `shelf/chatgpt-stack`.

## To re-enable

Two routes. The first needs no merging and is the safest.

**Run the old stack beside the new one.** The tag holds the complete working game as it was:

```sh
git worktree add ../zombie-chatgpt archive/chatgpt-stack-v1
cd ../zombie-chatgpt && npm ci && npm run import:curriculum
```

Saves live in the browser origin, so give it a different port from the Claude build, and read `docs/CHATGPT_HANDOFF.md` there for the tunnel and connector. Do not open a save written by the Claude build in it, because the old build does not know the `claude-cli` provider; use a copy of the older save instead.

**Bring the stack back into this branch.** On a new branch:

1. Move every file under this folder back to its same relative path with `git mv shelf/chatgpt/<path> <path>`, except `RE-ENABLE.md`. The scripts, public page, `src/direct-study.ts`, docs and tests all keep their old relative imports.
2. Restore `package.json` scripts `bridge:mcp` (`node scripts/chatgpt-handoff-mcp.mjs`) and `bridge:configure` (`node scripts/chatgpt-tunnel-config.mjs`).
3. Rewire `scripts/bridge-server.mjs`, `scripts/bridge-service.mjs`, `scripts/study-bridge-server.mjs` and `scripts/serve.mjs`. They changed to serve the Claude gateway; `git diff archive/chatgpt-stack-v1 HEAD -- scripts/<file>` shows each change to reverse.
4. Put back the small pieces listed under "Removed from files that stay", then the shelved tests, which need the old `native-study-harness.ts` as well.
5. Run `npx tsc --noEmit -p .`, `npm test` and `npx playwright test`. Expect work in steps 3 and 4; the tag is the reference for how each file looked.

## What git does not hold

Note these before removing any of them, because they cannot be restored from the tag:

- `.local/chatgpt-handoff`, `.local/chatgpt-public` and `.local/bridge-service`
- `~/.cloudflared/*`, the Cloudflare tunnel and its DNS record
- The ChatGPT app registration: it is disabled, not deleted. Keep its name, URL and scopes so it can be turned back on
- The Cloudflare tunnel: disabled, not deleted. Its tunnel ID, credentials file in `~/.cloudflared/` and DNS record are only on this computer

## Everything shelved

All paths below are in this folder at the same relative path they had in the project.

- `scripts/`: the ChatGPT handoff queue, routes, tools, MCP worker and public bridge (`chatgpt-handoff-*.mjs`, `chatgpt-public-bridge.mjs`), the tunnel (`chatgpt-tunnel-config.mjs`, `chatgpt-tunnel-supervisor.mjs`), the OAuth and security modules (`chatgpt-security/`), the terminal MCP apps (`terminal-relay-app.mjs`, `terminal-mcp-app.mjs`), the smoke scripts (`smoke-chatgpt-*.mjs`), and the helpers only they used (`lib/mcp-app.mjs`, `lib/diagnostic-state.mjs`).
- `public/terminal-mcp-app.html`: the terminal app page for ChatGPT.
- `src/direct-study.ts`: the ChatGPT-driven study session client.
- `docs/CHATGPT_HANDOFF.md`: connector, tunnel and recovery setup. `docs/STUDY_MODE_BRIDGE.md`: the full operation contract as it was written for that bridge.
- `tests/`: see "Tests" below.
- `package.json` scripts `bridge:mcp` and `bridge:configure` were removed. They are only on the tag.

## What stays for old saves

Do not remove these. Saves from the ChatGPT era depend on them:

- `Provider` in `src/model.ts` still accepts `"chatgpt-handoff"`, and `src/run-design-contract.mjs` still accepts it as a saved run design `source`. `src/provider-label.ts` and `src/learner.ts` keep reading it.
- The model types `DirectStudySession` and `Encounter.directStudy`, and `src/persistence.ts`, still load saved sessions. `src/topic-assessment.ts` and `src/run-learning.ts` still read applied sessions so learning history counts them.
- `releaseRetiredChatRequests` in `src/ai.ts` releases any request that was still waiting on the retired chat.
- `scripts/lib/ai-contracts.mjs` holds the operation contracts the Claude gateway uses. The shelved `scripts/chatgpt-handoff-queue.mjs` has its own older copy, including ChatGPT delivery wording, the `terminal-direct` completion rules and the topic assessment instruction.
- Tests that prove old saves load stay in `tests/` (for example `tests/knowledge-probe.test.ts`, `tests/completion-retry.test.ts`, `tests/group-retry.test.ts`).

## Moved out of the client

- `src/direct-study.ts` is here, at the same relative path. It also needs `applyDirectCompletion` (a thin alias of `applyCompletion`, which `src/ai.ts` now exports) and `recordAttributedMessage` from `src/ai.ts`, and `topicAssessmentContext` and `recordTopicAssessments` from `src/topic-assessment.ts` (both of which still exist).

## Removed from files that stay

These small pieces are only on the tag `archive/chatgpt-stack-v1`:

- `src/bridge-client.ts`: handoff polling and receipts, chat codes (`newStudyChat`, `studyChatCode`), relay listening (`relayListening`, `relayServes`), the native scope (`nativeStudyScope`), `discardRunDesign`, the outage grace and the direct-study timeout. The third `onProgress` argument of `bridgeRequest` and the `onQueued`, `chatCode` and `nativeScope` options are gone.
- `src/main.ts` and `src/game-shell.html`: the native study panel (`#native-study`), the copy-request, Connect and completion-retry flows, the ChatGPT tab handling, the `#chatgpt-prompt` and `#open-chatgpt` elements, the whole ChatGPT settings section (`#chatgpt-settings`, `#handoff-*`) and the silent reconnect at start-up.
- `src/run-designer.ts`, `src/run-quality-designer.ts` and `src/run-design-ui.ts`: the chat code and queue receipt on drafts, `cancelDesignDraft`, `designChatPrompt` and the Connect ChatGPT step of the run-design dialog.
- `src/ai.ts`: `applyDirectCompletion`, `recordAttributedMessage`, the `handoffAutonomous` gate on unattended NPC work and the `studyPrompt` field of the tutor payload.

## Tests

`shelf/chatgpt/tests/` holds the tests of retired behaviour. Several are whole-file copies of the original, kept beside a converted file of the same name in `tests/`; the converted file is the live one.

- Whole files moved here: `bridge-client.test.ts` (queue, receipts, chat codes, outage grace), `direct-study.test.ts`, `browser/direct-study.spec.ts`, `browser/study-connection-recovery.spec.ts`, `browser/reconnect-button.spec.ts` and `browser/native-study-harness.ts` (the ChatGPT direct-study mock).
- Single tests taken out of files that stay: `autonomous-work-chatgpt.test.ts`, `study-workspace-direct.test.ts`, `npc-voice-receipt.test.ts`, `run-designer-receipt.test.ts`, `environment-review-queue.test.ts`, `chat-catchup-queue.test.ts`, `browser/maintenance-handoff.spec.ts`.
- Original copies of files that have a converted version in `tests/`: `npc-voice-bridge.test.mjs`, `terminal-dialogue-harness.test.ts`, `browser/run-designer.spec.ts`, `browser/roadmap-handoff.spec.ts`, `browser/study-workspace.spec.ts`, `browser/task-issuance.spec.ts`, `browser/terminal-selection.spec.ts` and `browser/topic-assessment.spec.ts`.

They import the shelved queue and routes and the old `native-study-harness.ts`, so move them back together with those files.
