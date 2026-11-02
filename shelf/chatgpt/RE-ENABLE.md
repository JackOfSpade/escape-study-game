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
- `src/direct-study.ts` and the `chatgpt-handoff` provider stay so existing saves keep loading.
