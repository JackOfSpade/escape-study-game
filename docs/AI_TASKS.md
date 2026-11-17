# AI tasks

Every AI task is one call to the signed-in Claude CLI, made by `scripts/claude-gateway.mjs` behind the local relay (`scripts/bridge-server.mjs`, `POST /api/bridge`). The CLI is started with no tools, none of the player's own settings, memory or MCP servers, and without any `ANTHROPIC_*` variables. `GET /api/status` reports `mode: "claude-cli"` and the operations the gateway serves. Without a working gateway it reports `mode: "development"` with no capabilities, and questions cannot be prepared.

The operation names, their instructions and the validators that check each answer are in `scripts/lib/ai-contracts.mjs` (`AI_OPERATIONS`). That file is the contract: read it before changing a task. Each task's model, effort and timeout are in `TASK_PROFILES` in the gateway. The policy that chose those settings, how to measure a setting, and what has been measured are in [AI model and effort selection](AI_MODEL_SELECTION.md).

| Operation            | Purpose                                                                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generate`           | A question, built from the eligible contract and the exact track curriculum. Each question is sized for one sitting of at most 15 minutes ([question design](QUESTION_DESIGN.md)).    |
| `tutor`              | One reply in the question's conversation, as the probe reply `{text, complete, outcome?, knowledge?}`. The reply streams, and `text` is written first.                                |
| `complete`           | Whether a captured submission solves the question, from the attributed history.                                                                                                        |
| `assess`             | Formal learning assessment of one frozen question and its evidence.                                                                                                                    |
| `review-environment` | Review of a practical environment observation ([practical observations](ENVIRONMENT_OBSERVATIONS.md)).                                                                                 |
| `reconcile-roadmap`  | A proposal for reconciling an uploaded roadmap revision, returned as exact `{find, replace}` edits to the local roadmap or `outcome: "keep-local"` (`scripts/lib/roadmap-edits.mjs`).  |

## What the app keeps for itself

- Questions carry the local contract unchanged, and stable `scopeDefinitions` (objective, depth, source scope and facets). Once registered, a definition is reused, never shrunk.
- A question may carry `runtime: { language }` for executable work at D2 and above, or the isolated React environment. The relay never runs learner code itself; `/api/execute` uses disposable Docker containers.
- `assess` returns findings per facet (`independent`, `assisted`, `unknown`, `contradicted`), a visit outcome, scope-coverage reviews and attribution of the help the learner saw. A model pass flag alone never changes mastery. Execution may be reported only with a matching runner receipt.
- Tier-4 transfer and integration work, and historical source-to-facet mappings, use the same finding and attribution rules.
- Every answer is validated before it is applied. The app decides what it grants; a reply cannot grant a pass or mastery by itself.
- A saved request keeps the provider that captured it. The relay refuses a request whose provider is not `claude-cli` rather than forwarding it.

The earlier ChatGPT transport used the same operations. Its longer specification is archived at `shelf/chatgpt/docs/STUDY_MODE_BRIDGE.md`.
