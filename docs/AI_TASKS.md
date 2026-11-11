# AI tasks

Every AI task is one call to the signed-in Claude CLI, made by `scripts/claude-gateway.mjs` behind the local relay (`scripts/bridge-server.mjs`, `POST /api/bridge`). The CLI is started with no tools, none of the player's own settings, memory or MCP servers, and without any `ANTHROPIC_*` variables. `GET /api/status` reports `mode: "claude-cli"` and the operations the gateway serves; without the gateway it reports a development fallback that awards no academic credit.

The operation names, their instructions and the validators that check each answer are in `scripts/lib/ai-contracts.mjs`. That file is the contract: read it before changing a task. Each task's model and effort are in `TASK_PROFILES` in the gateway. The policy that chose those settings, how to measure a setting, and the evaluation and test plan for every call are in [AI model and effort selection](AI_MODEL_SELECTION.md).

| Operation                                 | Purpose                                                                                               |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `generate`                                | A question for a terminal, built from the eligible contract and the exact track curriculum            |
| `tutor`                                   | One reply in the terminal conversation, with the probe reply `{text, complete, outcome?, knowledge?}` |
| `complete`                                | Whether a captured submission solves the question, from the attributed history                        |
| `assess`                                  | Formal learning assessment of one frozen question and its evidence                                    |
| `group`                                   | A bounded NPC group message or proposal from public work records                                      |
| `materialize-work`, `materialize-outcome` | NPC notes or code candidates, and reconstruction of a consumed offscreen solution                     |
| `review-environment`                      | Review of a practical environment observation                                                         |
| `reconcile-roadmap`                       | A proposal for reconciling an uploaded roadmap revision                                               |
| `npc-chatter`, `npc-chatter-review`       | A background NPC line and its critic pass                                                             |
| `design-run`                              | The staged AI design of a new run (see [AI-authored runs](AI_RUN_DESIGNS.md))                         |

The gateway does not offer `retrospective-group` or `autonomous-work`.

## What the game keeps for itself

- Questions carry the local contract unchanged, and stable `scopeDefinitions` (objective, depth, source scope and facets). Once registered, a definition is reused, never shrunk.
- A question may carry `runtime: { language }` for executable work at D2 and above, or the isolated React environment. The relay never runs learner code itself; `/api/execute` uses disposable Docker containers.
- `assess` returns findings per facet (`independent`, `assisted`, `unknown`, `contradicted`), a visit outcome, scope-coverage reviews and attribution of the help the learner saw. A model pass flag alone never changes mastery. Execution may be reported only with a matching runner receipt.
- Tier-4 transfer and integration work, and historical source-to-facet mappings, use the same finding and attribution rules.
- Every answer is validated before it is applied. The game decides what it grants; a reply cannot grant a key, a pass or mastery by itself.

The earlier ChatGPT transport used the same operations. Its longer specification is archived at `shelf/chatgpt/docs/STUDY_MODE_BRIDGE.md`.
