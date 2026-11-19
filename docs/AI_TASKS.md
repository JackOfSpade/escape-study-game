# AI tasks

Every AI task is one call to the signed-in Claude CLI, made by `scripts/claude-gateway.mjs` behind the local relay (`scripts/bridge-server.mjs`, `POST /api/bridge`). The CLI is started with no tools, none of the player's own settings, memory or MCP servers, and without any `ANTHROPIC_*` variables. `GET /api/status` reports `mode: "claude-cli"` and the operations the gateway serves. Without a working gateway it reports `mode: "development"` with no capabilities, and questions cannot be prepared.

The operation names, their instructions and the validators that check each answer are in `scripts/lib/ai-contracts.mjs` (`AI_OPERATIONS`). That file is the contract: read it before changing a task. Each task's model, effort and timeout are in `TASK_PROFILES` in the gateway. The policy that chose those settings, how to measure a setting, and what has been measured are in [AI model and effort selection](AI_MODEL_SELECTION.md).

| Operation            | Purpose                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generate`           | A question, built from the eligible contract and the exact track curriculum. Each question is sized for one sitting of at most 15 minutes ([question design](QUESTION_DESIGN.md)).    |
| `tutor`              | One reply in the question's conversation, as the probe reply `{text, complete, partComplete?, outcome?, knowledge?}`. The reply streams, and `text` is written first.                 |
| `assess`             | Formal learning assessment of one frozen question and its evidence.                                                                                                                   |
| `review-environment` | Review of a practical environment observation ([practical observations](ENVIRONMENT_OBSERVATIONS.md)).                                                                                |
| `reconcile-roadmap`  | A proposal for reconciling an uploaded roadmap revision, returned as exact `{find, replace}` edits to the local roadmap or `outcome: "keep-local"` (`scripts/lib/roadmap-edits.mjs`). |

## What the app keeps for itself

- Questions carry the local contract unchanged, and stable `scopeDefinitions` (objective, depth, source scope and facets). Once registered, a definition is reused, never shrunk.
- A question may carry `runtime: { language }` for executable work at D2 and above, or the isolated React environment. The relay never runs learner code itself; `/api/execute` uses disposable Docker containers.
- `assess` returns findings per facet (`independent`, `assisted`, `unknown`, `contradicted`), a visit outcome, scope-coverage reviews and attribution of the help the learner saw. A model pass flag alone never changes mastery. Execution may be reported only with a matching runner receipt.
- Tutor help follows a hint ladder (`scripts/lib/help-gate.mjs`). Every conversation reply declares `help: {nudges, hints, gives, offers}` per facet: nudges are free, hints and given steps cost credit. The relay and the app reject a hint or given step on a facet no earlier tutor reply warned about (`offers`), and the reply is not streamed until its declaration passes. An assisted finding carries `assistance: hinted | given`; neither verifies a checkpoint, and both export as assisted. Question generation receives the degree as `facetAssistance`.
- Tier-4 transfer and integration work, and historical source-to-facet mappings, use the same finding and attribution rules.
- A question with several asks is worked one part at a time ([question design](QUESTION_DESIGN.md)): `generate` returns the asks as `parts`, each tutor request names the open part in `stage`, and `partComplete: true` opens the next. The relay and the app reject `complete: true` while a part is still hidden.
- Every answer is validated before it is applied. The app decides what it grants; a reply cannot grant a pass or mastery by itself.
- A saved request keeps the provider that captured it. The relay refuses a request whose provider is not `claude-cli` rather than forwarding it.

A `complete` operation once judged an answer submitted from a separate editor. It was removed on 2026-11-18: every question is a conversation that a `tutor` reply finishes, and an older saved question that used the editor is answered the same way.

The earlier ChatGPT transport used the same operations. It was removed in November 2026 and survives only in git history; saved records still name it as the `chatgpt-handoff` provider.
