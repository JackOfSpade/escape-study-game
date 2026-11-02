# ChatGPT stack, shelved

The ChatGPT chat workers, tunnel, connector and terminal apps were retired when the game moved to the Claude CLI. They live here so they can return if OpenAI restores unlimited chats. Nothing in this folder is built, type-checked or tested.

The exact working stack before the move is the annotated tag `archive/chatgpt-stack-v1`, also on the branch `shelf/chatgpt-stack`.

## To re-enable

Restoring from the tag is the reliable path, because files here keep their old relative imports:

1. Check out `archive/chatgpt-stack-v1`, or restore its `scripts/`, `public/terminal-mcp-app.html`, `tests/` and `package.json` onto a new branch.
2. Restore the worker's bridge wiring in `scripts/bridge-server.mjs` and `scripts/study-bridge-server.mjs`.
3. Follow `docs/CHATGPT_HANDOFF.md` to run the tunnel and connector.

## What git does not hold

Note these before removing any of them, because they cannot be restored from the tag:

- `.local/chatgpt-handoff`, `.local/chatgpt-public` and `.local/bridge-service`
- `~/.cloudflared/*`, the Cloudflare tunnel and its DNS record
- The ChatGPT app registration: disable it rather than deleting it, and keep its name, URL and scopes

## Still in the main tree

- `scripts/lib/ai-contracts.mjs` holds the operation contracts and answer validators the Claude gateway uses. The shelved `scripts/chatgpt-handoff-queue.mjs` carries its own older copy of them, including the ChatGPT delivery wording, the `terminal-direct` completion rules and the topic assessment instruction.
- The `chatgpt-handoff` provider value, the `DirectStudySession` and `Encounter.directStudy` model types and `releaseRetiredChatRequests` stay so existing saves keep loading. `src/topic-assessment.ts`, `src/run-learning.ts` and `src/persistence.ts` still read saved sessions.
- Saved run designs keep `chatgpt-handoff` as a valid `source`. Saved run-design drafts that carry a `chatCode` or queue `receipt` still load; both fields are dropped when read.

## Moved out of the client

- `src/direct-study.ts` is here, at the same relative path. It also needs `applyDirectCompletion` and `recordAttributedMessage` from `src/ai.ts`, and `topicAssessmentContext` and `recordTopicAssessments` from `src/topic-assessment.ts` (both of which still exist).

## Removed from files that stay

These small pieces are only on the tag `archive/chatgpt-stack-v1`:

- `src/bridge-client.ts`: handoff polling and receipts, chat codes (`newStudyChat`, `studyChatCode`), relay listening (`relayListening`, `relayServes`), the native scope (`nativeStudyScope`), `discardRunDesign`, the outage grace and the direct-study timeout. The third `onProgress` argument of `bridgeRequest` and the `onQueued`, `chatCode` and `nativeScope` options are gone.
- `src/main.ts` and `src/game-shell.html`: the native study panel (`#native-study`), the copy-request, Connect and completion-retry flows, the ChatGPT tab handling, the `#chatgpt-prompt` and `#open-chatgpt` elements, the whole ChatGPT settings section (`#chatgpt-settings`, `#handoff-*`) and the silent reconnect at start-up.
- `src/run-designer.ts`, `src/run-quality-designer.ts` and `src/run-design-ui.ts`: the chat code and queue receipt on drafts, `cancelDesignDraft`, `designChatPrompt` and the Connect ChatGPT step of the run-design dialog.
- `src/ai.ts`: `applyDirectCompletion`, `recordAttributedMessage`, the `handoffAutonomous` gate on unattended NPC work and the `studyPrompt` field of the tutor payload.
