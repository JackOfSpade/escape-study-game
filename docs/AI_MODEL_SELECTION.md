# AI model and effort selection

Read this before testing here. It records which model and effort each AI call uses, the policy that decides them, how to measure a setting, and what is known (very little) about every call. A call marked **Proven** needs no re-test until one of the re-test triggers applies; anything else is an untested default.

Where the settings live: `TASK_PROFILES` in `scripts/claude-gateway.mjs`, one entry per operation. `taskProfile()` may raise a setting for a particular payload; the only such override today is the `content-batch` stage of `design-run`, which runs at high effort instead of the profile's medium. Every call is one signed-in Claude CLI call made through the local relay (`scripts/bridge-server.mjs`, `POST /api/bridge`, operation `npc-chatter-review` included). The profile also holds a timeout and the payload keys that go into the cached system prompt.

No measurement data survive for any of these choices. The file header says the settings were "chosen by blind quality scoring against cost", but no run logs, prompt sets or per-setting numbers exist in the repository or its history, and until 2026-11-10 the gateway recorded no usage, cost or resolved model (it now does; see How to measure). Every call below is therefore **Needs test**, except the `design-run` content batch, which is **Partial** because one written conclusion survives ("The content batch alone gained from more effort; xhigh added nothing") without the numbers behind it.

## Policy

### Hard exclusions

- Never `max` effort. The highest allowed effort is `xhigh`.
- Never Fable. It is not a candidate for any call.
- Always use the latest model through the aliases `haiku`, `sonnet` and `opus`. Never test or pin an older version, even as a control.
- The candidate ladder for every call is Haiku, Sonnet and Opus, each at `low`, `medium`, `high` and `xhigh`: twelve settings, every allowed effort below max.
- Other providers are out of scope: the game has only the Claude CLI route, so DeepSeek and every other provider are not candidates.

### Which rule applies to a call

| Call class                                                                                                                             | Rule                                     |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Every call except NPC conversation replies                                                                                             | Quality knee                             |
| `npc-chatter` and `npc-chatter-review` for the first line of a conversation                                                            | Quality knee                             |
| `npc-chatter` and `npc-chatter-review` for a reply in an ongoing conversation (`turn >= 2`, or `payload.conversation.replyTo` present) | Fastest p95 that meets the quality floor |

### Quality knee (all non-live calls)

1. Order the candidate settings by **measured cost per call**, never by assumed tier order. Effort mainly changes output cost, so on an input-heavy prompt a lower effort may save nothing and a "cheaper" tier may not be cheaper at all.
2. Start testing at the cheapest measured setting and climb one setting at a time.
3. Stop at the first setting S whose quality no longer improves: the next dearer setting or settings do not beat S by more than the noise floor. Choose S even if it is not the cheapest acceptable setting, and even if a dearer setting is marginally better within noise.
4. Quality must also pass the application's own validator at about the production first-try rate. A setting that needs correction turns pays for them: count retry cost, not just the first reply.
5. Measure the noise floor by running a reference setting twice, or by keeping an unchanged control arm in the same batch. Run order must be shuffled or interleaved so drift does not read as a tier difference.
6. For a stage that feeds another stage (`design-run` stages, and `generate` feeding `tutor` and `assess`), judge the downstream result too, not only the stage's own validator.
7. Generation time is not a criterion for these calls. A slower setting that wins on quality is the correct choice.

### Live NPC replies

A reply line in an ongoing NPC exchange is heard while the player waits, so it uses a different rule:

- Measure **p95 time to first audible word** under realistic load, from the model reply through the critic pass to the start of local Kokoro speech, for each candidate setting.
- Among settings that meet a quality floor (realism review pass rate on real captured cases), choose the fastest p95.
- Tie rule: when the speed difference is insignificant (inside timing noise, or a small fraction of the latency budget) but the quality loss is significant, choose the better-quality setting.
- The hard ceiling is `NPC_VOICE_LIMITS.replySeconds` (30 s): a reply request is aborted once the conversation's reply window closes. The real budget is far tighter, because the player is waiting in silence, and the critic pass is a second full model round trip before any audio starts.

Recommended code change, not implemented here: split the `npc-chatter` and `npc-chatter-review` profiles by `payload.conversation`, the way `taskProfile()` already splits `design-run` on `payload.phase`, so first lines and replies can hold different settings. Also evaluate whether the critic pass should run on live replies at all, since it adds a full model round trip before speech; the first-line and ambient paths should keep it.

### Proof

Every call is proven only by a test. Running on the cheapest setting (Haiku at low) proves nothing about quality. Keep each test proportionate to the call's risk: a wrong grade is worth more testing than an ambient line.

### Versions and re-test triggers

Results are tied to model versions, so record the resolved model id with every result (the CLI's init event reports it, and the gateway already checks it against the alias). Re-test a call when:

- a new model version is released in a family it uses (the alias moves under it);
- its prompt, payload schema, JSON schema or validator changes;
- production signals appear: validator rejections, correction turns, retries, or quality drift.

## Model versions tested

| Family alias | Resolved model id | Date measured | Where measured |
| ------------ | ----------------- | ------------- | -------------- |
| `haiku`      | none recorded     | 2026-11-10    | no measurement |
| `sonnet`     | none recorded     | 2026-11-10    | no measurement |
| `opus`       | none recorded     | 2026-11-10    | no measurement |

As of 2026-11-10 nothing has been measured. The table stays empty until the tooling below produces results; every row copied here must name the resolved id the CLI reported, not the alias alone.

## How to measure

### What exists today

- `scripts/evaluate-npc-dialogue.ts` (`npm run eval:dialogue`) with the corpus in `tests/fixtures/npc-dialogue-realism/cases.json` (18 cases, 42 examples, of which 37 are spoken lines; the silent examples are skipped). It builds review packets with `buildNpcDialogueReview`, accepts externally produced responses tagged `scripted`, `human` or `model`, and scores agreement with the corpus verdicts (`criticAgreement`); it passes only at full agreement with no invalid or missing rows. That measures the critic's realism judgement, not the generator's output, and it is the natural seed for NPC quality floors.
- The gateway itself is reusable for ladder runs: `buildPrompt(operation, payload)` and `validateAnswer(job, answer)` are exported, so a runner can replay a captured payload through the real system prompt, the real schema and the real validator.
- `tests/fixtures/run-designs/` holds synthetic design replies used by relay tests. They establish orchestration, not live model quality, and are not measurement data.
- **Per-call usage log (built 2026-11-10).** The bridge service writes one row per CLI invocation, correction turns and session retries included, to `.local/bridge-service/claude-usage.jsonl` (owner-only, rotated to `.1` above 5 MB). A row holds the operation, `phase`, `conversationTurn` (1 = NPC first line, 2+ = reply), `attempt` (0 first try, 1 correction), alias, effort, resolved model id, `costUsd`, input/output/cache tokens, CLI turns, wall and API duration, `firstTextMs` for streamed calls, and `outcome` (`accepted`, `rejected`, `schema-rejected`, `timeout`, or the error code such as `usage-limit`). Missing numbers are `null`. It never records prompt, reply, validator text, stderr or request ids. `npm run ai:usage` (`scripts/ai-usage-report.mjs`, `--json` for machine output) summarizes it per operation, phase, first line or reply, setting and model: calls, first-try accept rate, corrections, failures, total and mean cost, mean tokens, p50/p95 duration and p95 first-text time. Run the game normally for a while before reading it; the means become the measured cost order for each ladder.
- No captured production prompt set, no blind judging protocol and no NPC latency harness exist.

### Tooling to build first, in priority order

1. **Per-call usage log in the gateway.** Done 2026-11-10 (see What exists today). The CLI's stream-json `result` event already reports `total_cost_usd`, token usage, duration and the resolved model from the `init` event; the gateway currently reads the model only for its alias check and discards everything else. Log one row per attempt: operation, phase when present, requested alias and effort, resolved model id, `total_cost_usd`, input/output/cache tokens, wall duration, whether the validator accepted the first reply, correction turns, and CLI schema rejections. Billing is the signed-in subscription, so `total_cost_usd` is the cost proxy, not an invoice. A local JSONL file written on the machine is enough.
2. **Replay-sample store and ladder runner.** Capture the newest N real prompts per operation (N roughly 20, fewer where calls are expensive), owner-only and outside the repository, with no learner-identifying content leaving the machine. Strip or replace names and personal text where it does not change the task. The runner replays a sample at any list of `model:effort` settings through the gateway's own `buildPrompt` and `validateAnswer`, writing each result row to a durable location as it goes (not a session temp folder), then a second pass writes the rows into this document.
3. **Blind judging and planted-defect sets.** For the judging and critic calls (`complete`, `assess`, `review-environment`, `npc-chatter-review`), build pairs or ranked sets and hide which setting produced which reply; the judge model must not be one of the arms where possible (use a different family, or a human; `npc-chatter-review` cannot judge itself). Planted defects (a correct solution graded wrong, an assisted answer relabelled independent, an observation with no output claimed observed, an invalid NPC line defended as realistic) give a catch rate that a validator alone cannot give.
4. **NPC latency harness.** Drive the real reply path (generator, critic, Kokoro synthesis start) with captured `payload.conversation` requests, under realistic concurrent load, and record time to first audible word. Report p95 per setting, not means.

Every result row, whatever tool produced it, is copied into this document with the resolved model id and the date.

## New model release playbook

1. Regression-check the current setting on the new version before changing anything: same sample, same validators, plus the planted-defect set for judging calls. If it holds, keep it.
2. If the cheaper family improved, step the knee search down one rung (the next cheaper setting) and check whether the noise-floor condition now holds there. Step up one rung only if the current setting's quality dropped below the validator or quality floor.
3. Record the new resolved model id and date in the versions table and the results rows.
4. For live NPC replies, re-measure p95 time to first audible word first; a newer model may change the latency ordering even if quality is unchanged.

## Results by call

Status: **Proven** means a recorded test meets the policy and no trigger applies; **Partial** means something survives but not enough to prove the setting; **Needs test** means no measurement exists. No row is Proven.

| Call                                            | Current                                                         | Status                                              | Recommendation                                                                                                                                                                                                                                                                                                                                                   | Test plan (signal, ladder start, noise-floor arm)                                                                                                                                                                                                                                                                            |
| ----------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generate`                                      | Opus, xhigh, 30 min                                             | Needs test                                          | Ladder from the cheapest measured setting. Expect the knee around Sonnet high or Opus low: the validator is mostly structural (exact contract copy, stable facets, rubric strings, `estimatedSolveSeconds`), while the design judgement needs blind scoring. Do not settle below Sonnet medium until downstream `tutor` and `assess` hold on the same questions. | Validator first-try rate, blind pairwise rank of question quality against the current setting, downstream tutor/assess behaviour; 20 captured payloads; control arm = Opus xhigh run twice                                                                                                                                   |
| `tutor`                                         | Sonnet, medium, 120 s                                           | Needs test                                          | Ladder from cheapest; the probe reply's learning judgement (`knowledge.facets`, `impliedBy`, `complete`/`outcome`) is the quality that matters, not prose. Sonnet medium is a plausible knee; Haiku arms are the main cost saving to test.                                                                                                                       | Validator rate plus blind review of probe stance (one leverage question, no breadth inflation) and agreement with a reference on `complete`/`outcome`; 20 transcripts; control = current setting twice. Open question for the user: if first-word latency matters, `tutor` becomes the next candidate for the live-call rule |
| `complete`                                      | Sonnet, medium, 120 s                                           | Needs test                                          | Start cheapest. Grading errors change what the game grants, so use planted defects and require a high catch rate; expect the knee at Sonnet high or Opus low if Sonnet medium misses planted wrong/assisted solutions.                                                                                                                                           | Planted-defect catch rate (wrong solution marked complete, assistant-written solution credited, defender work ignored, false execution claim) plus agreement with a reference on `complete`/`qualified`; 20 real submissions each with a known verdict; control arm twice                                                    |
| `assess`                                        | Sonnet, medium, 5 min                                           | Needs test                                          | Highest-stakes call: findings, help attributions, scope reviews and definition issues change mastery. Start cheapest, but expect the knee to sit at Sonnet high or Opus medium; a cheaper setting that misses one assisted-origin facet is a loss.                                                                                                               | Planted-defect catch rate (assisted work marked independent, NPC work credited, incomplete scope marked complete, fabricated definition issue) plus facet-level agreement with a reference on 15-20 real frozen assessments; control = current setting twice                                                                 |
| `group`                                         | Sonnet, medium, 120 s                                           | Needs test                                          | High-volume short call; candidate to step down to Haiku high or Sonnet low. The validator already forces exact `requestId`, `sourceRevision`, integer `refs` and selected speakers, so measure whether cheaper settings invent work or repeat lines.                                                                                                             | Validator first-try rate plus blind realism/redundancy review and ref-accuracy count against captured events; 20 packets; control = Sonnet medium twice                                                                                                                                                                      |
| `materialize-work`                              | Sonnet, medium, 120 s                                           | Needs test                                          | Mechanical: one note per recorded work, exact author, real refs, a patch that must match the captured workspace range. Candidate for Haiku high; the validator catches a bad patch, so quality risk is confined to note grounding and duplicate contributions.                                                                                                   | Validator rate plus blind check that each note adds a distinct grounded contribution and no unsolicited autonomy; 20 packets; control arm twice                                                                                                                                                                              |
| `materialize-outcome`                           | Sonnet, medium, 120 s                                           | Needs test                                          | Candidate to step down one or two rungs. The validator pins the exact committed problem or source contract, authors and refs; the quality question is whether the reconstruction is conceptual at D1 and never claims execution.                                                                                                                                 | Validator rate plus agreement with a reference on problem/solution shape and planted "claims execution"/"solved elsewhere" traps; 15 packets; control arm twice                                                                                                                                                              |
| `review-environment`                            | Sonnet, medium, 120 s                                           | Needs test                                          | Start cheapest; expect Sonnet medium or high. Classification (`reported-exposure`/`partially-observed`/`observed`) and exact `learnerWorkQuote` excerpts are the whole job, and the planted-defect set is cheap to build.                                                                                                                                        | Planted-defect catch rate (statement-only claimed observed, generic execution claimed as hands-on browser work, excerpt not in the source) plus validator rate; 15 real observations; control arm twice                                                                                                                      |
| `reconcile-roadmap`                             | Opus, medium, 30 min                                            | Needs test                                          | Keep Opus in the ladder but test Opus low and Sonnet xhigh: the validator is structural (hashes, full canonical Markdown) while the real risk is losing evidence or inventing observations in a large packet.                                                                                                                                                    | Reference reconciliation on decisions/definitions/mappings plus a count of preserved observations, assessment ids and mastery rows; 10 real conflicting snapshots; control = current setting twice. Blind human read of the canonical Markdown is required because no validator judges it                                    |
| `npc-chatter` (first line)                      | Haiku, high, 45 s                                               | Needs test                                          | Knee rule. Ladder from the cheapest measured Haiku arm; expect the knee at Haiku medium or high, since the line is at most 180 plain characters and the realism corpus is the quality floor.                                                                                                                                                                     | Realism review pass rate on captured first-line cases (including the six conversation-start cases in the corpus) plus validator rate; 30 requests; control arm twice                                                                                                                                                         |
| `npc-chatter` (reply, `turn >= 2` or `replyTo`) | Haiku, high, 45 s                                               | Needs test                                          | Live rule: fastest p95 time to first audible word among settings meeting the realism floor, with the speed-vs-quality tie rule. Test whether the same setting serves both paths before splitting the profile.                                                                                                                                                    | p95 from model reply through critic to Kokoro start on 30 captured reply requests under load; quality floor = realism pass rate; also measure one arm with the critic pass skipped                                                                                                                                           |
| `npc-chatter-review` (ambient and first line)   | Haiku, high, 45 s                                               | Needs test                                          | Knee rule; it is a judge call, so planted defects decide. Haiku high is plausible; a cheaper critic that waves through an invalid line is worse than no critic.                                                                                                                                                                                                  | Planted-defect set: unseen enemy, invented success, URL/markup, over-length text, ungrounded memory, plus false-silence rate; 30 drafts; control arm twice                                                                                                                                                                   |
| `npc-chatter-review` (reply path)               | Haiku, high, 45 s                                               | Needs test                                          | Live rule if retained; first decide whether the critic runs on replies at all, since it adds a full round trip to the first-audible-word budget.                                                                                                                                                                                                                 | Same p95 harness with the critic included and excluded; planted-defect catch rate for the retained option                                                                                                                                                                                                                    |
| `design-run`                                    | Opus, medium (content-batch: high), 30 min, shared conversation | Partial (content-batch) / Needs test (other stages) | Only one written conclusion survives: the content batch gained from high and "xhigh added nothing", with no numbers. Keep Opus in every stage ladder; test each stage separately because the jobs differ wildly in size and in whether the validator can see the failure.                                                                                        | Per stage below; each stage needs a captured packet, validator rate, a stage-specific quality signal, and a control arm at the current setting                                                                                                                                                                               |

### `design-run` stages

Every stage runs on Opus: medium, or high for `content-batch`. The stages share one conversation keyed by generation ID, so a ladder arm must replay the whole stage sequence from the same captured packet; replaying a later stage in isolation changes what the model has already seen. Quality signals differ per stage:

| Stage            | Current                                         | Hardest prompt / what to judge                                                                                                | Test plan                                                                                                              |
| ---------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| concepts         | Opus, medium                                    | A premise that is novel yet buildable; the validator checks shape and bounds only. Judge blind: would a player want this run? | 10 packets, blind pairwise premise ranking plus downstream selection acceptability                                     |
| selection        | Opus, medium                                    | Choosing a concept against the seed and packet constraints; a weak choice poisons every later stage                           | Downstream structure acceptance rate and blind rank of the selected concept                                            |
| structure        | Opus, medium                                    | Version 3 floor plan, cast and surfaces within byte and count limits; hard validator, geometry errors surface later           | Validator rate on the exact structure reply plus engine acceptance of the constructed candidate                        |
| structure-review | Opus, medium                                    | Review must find real defects and propose concrete fixes, not score itself                                                    | Planted structural defects (blocked egress, unreachable surface, overloaded room) and false-finding rate               |
| content-plan     | Opus, medium                                    | A global plan that survives every batch; fragments and memberships must stay fixed                                            | Later stages' accepted plan and the plan-change validator failures                                                     |
| content-batch    | Opus, high (only surviving partial measurement) | Large per-surface writing batch; the one recorded note says high beat medium and xhigh added nothing                          | Re-measure at high and medium on captured batches, validator rate plus blind writing quality; control arm = high twice |
| content-review   | Opus, medium                                    | Editorial findings that name evidence, target and improvement                                                                 | Planted writing defects (unreadable, off-theme, duplicated text) and false-finding rate                                |
| content-revision | Opus, medium                                    | Targeted repair without collateral rewrites; validator rejects overreach                                                      | Validator rate, diff size against the requested findings, blind before/after rank                                      |

Estimate each stage ladder at 12 settings × 10 stage packets, with the replay cost of preceding stages counted in (a stage is not isolated). Record `total_cost_usd` of every conversation turn, not only the final one.

### `generate` and its downstream

- Hardest prompts: an `openGap` with `reuseInScopeDefinitions: true` where the apex facet must shape the question; several open gaps competing for one bounded question; D1 conceptual diagnosis with an empty starter; a code-review question that must include the helper and its authorization semantics without leaking the verdict; an integrative objective that must stay small.
- Quality signal: validator first-try rate (contract copy, stable facets, rubric strings, `estimatedSolveSeconds` between 30 and 900); blind pairwise rank with a criterion set covering self-containment, visible requirements, no unstated assumptions and no leaked solution; then run `tutor` and `assess` on the winning questions and compare those results across arms.
- Ladder: cheapest by measured cost first. Estimate 12 settings × 20 questions = 240 calls; because the curriculum packet is large and prompt-cached, the input share dominates, so lower effort may save little. Total estimate = 240 × the measured mean `total_cost_usd` for the operation, which the usage log supplies.
- Noise-floor arm: Opus xhigh run twice.

### `tutor`

- Hardest prompts: a learner answer that demonstrates a facet by implication and must mark dependents `impliedBy`; a declared gap that needs one focused follow-up rather than a prerequisite tree; a press for the full answer where a foothold is due; a misconception that must be corrected plainly; a streamed reply whose `text` must appear before the rest of the object.
- Quality signal: validator rate on `{text, complete, outcome, knowledge}`; blind review for the probe stance (one leverage question, no breadth inflation, no hidden full-project follow-up); agreement with a reference on `complete`/`outcome` and facet statuses; optionally a short delayed check that the learner's next answer improves.
- Ladder: estimate 12 settings × 20 transcripts = 240 calls, cheap compared with `generate` because transcripts are short; total = 240 × measured mean cost.
- Noise-floor arm: current Sonnet medium twice. Generation time is not a criterion, but record first-word latency anyway for the open question above.

### `complete` and `assess`

- Hardest prompts for `complete`: a solution with credited NPC or assistant contributions; a defender whose useful physical work must count; a claim of execution without a runner receipt; the retrospective NPC outcome where simulated world success must be ignored.
- Hardest prompts for `assess`: a correct but assisted solution, an answer copied from help, an NPC-authored solution, a partially covered scope that must stay `partial`, a definition issue that needs an exact 20-2000 character quote, and every visible assistance source needing its own `helpAttributions` entry.
- Quality signal: planted-defect catch rate first, then ordinary agreement with a reference on findings, visit outcome and attributions. A validator pass alone proves nothing here because these replies are structurally easy and semantically decisive.
- Ladder: estimate 12 settings × 15 graded cases = 180 calls per operation, each with a known reference verdict; total = 180 × measured mean cost.
- Noise-floor arm: the current setting twice; because grading variance is the danger, use the same cases in interleaved order.

### `group`, `materialize-work`, `materialize-outcome`

- Hardest prompts: `group` catch-up over a long event range where every `refs` value must be a real `events[].seq` and no unseen dialogue may be invented; `materialize-work` with a workspace where the patch must match the exact range and notes must be distinct; `materialize-outcome` where the committed problem must be copied byte-for-byte or the contract matched exactly.
- Quality signal: validator first-try rate (it enforces the mechanical parts), plus blind grounding review and, for `group`, ref accuracy and redundancy against the captured events; for `materialize-outcome`, a planted "claims execution" and "solved by another" trap.
- Ladder: start at the cheapest measured setting; these are high-volume short calls, so all twelve arms are cheap. Estimate 12 settings × 20 packets = 240 calls per operation.
- Noise-floor arm: Sonnet medium twice.

### `review-environment` and `reconcile-roadmap`

- Hardest prompts for `review-environment`: a statement of exposure with no output (must stay `reported-exposure`), generic code execution offered as hands-on browser or profiling evidence, a real but partial observation, an exact `learnerWorkQuote` that must be present verbatim.
- Hardest prompts for `reconcile-roadmap`: two snapshots that genuinely conflict, a large uploaded revision where every observation and assessment id must survive, and a canonical Markdown file whose shape no validator can judge.
- Quality signal: planted-defect catch rate for the environment review; for the roadmap, a reference reconciliation on decisions plus preserved-evidence counts and a blind human read of the canonical Markdown.
- Ladder: environment review 12 settings × 15 observations = 180 calls; roadmap 12 settings × 10 snapshots, the most expensive ladder in the document because each packet is large and the timeout is thirty minutes. Estimate the roadmap total as 120 × measured mean cost, and expect the input tokens to dominate.
- Noise-floor arm: current setting twice per call.

### NPC calls

- Hardest prompts for `npc-chatter`: an immediate attack where silence or a whisper is correct; a conversation reply that must answer the actual addressed point; a recent-line repetition trap; an unknown that the line must not invent; a fact-heavy scene where the 180-character line must stay grounded.
- Quality signal: realism review pass rate on captured cases (the six conversation cases in the corpus are the reply-path sample) and validator rate (identity, length, no URL, markup or control characters). The corpus expects silence in some cases, so score the decision as well as the wording.
- Ladder for the first line: twelve settings × 30 captured requests, ordered by measured cost; the Haiku arms are cheapest, so the climb usually reaches Sonnet only if Haiku misses the realism floor.
- Live reply measurement: p95 time to first audible word on 30 captured reply requests, with the model reply, the critic pass and Kokoro start included; run under the normal concurrent background load. Measure one arm with the critic pass skipped so the cost of the extra round trip is known rather than assumed.
- Noise-floor arm: the current Haiku high setting twice; for the latency comparison, the same arm repeated on a different minute to estimate timing noise.

## Web research and Tavily

No current call uses the internet. `claudeArgs()` passes `--tools ""`, `--setting-sources ""` and `--strict-mcp-config` for every operation, and every prompt tells the model to treat the supplied packet as untrusted data and not to browse links. That is the baseline this section compares against.

Would web access improve quality? Per call:

| Call                                       | Would live web help?                                                                                                                       | Risk                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `generate`                                 | Possibly, for executable tracks whose questions should match current library, API or language behaviour, and for real-world scenario facts | The fetched page is untrusted text in the prompt that designs a graded question; a stale or wrong page yields confidently wrong requirements |
| `assess`, `complete`, `review-environment` | No. These judge supplied evidence; a web page cannot verify a learner's artifact and must never enter a grading path                       | A model that goes looking for the answer can be steered by it; nondeterminism in a mastery decision                                          |
| `reconcile-roadmap`                        | Marginal: checking a library or venue named in an uploaded revision                                                                        | Uploaded documents are already untrusted; extra web text raises the injection surface                                                        |
| `design-run`                               | Plausible for real-world venue detail and current-API flavour in a fictional building                                                      | Large prompts, long calls, and a nondeterministic addition to something already hard to review                                               |
| `tutor`                                    | No for the same reason as `assess`: it must judge the learner's reasoning, not look up the answer                                          | Latency and distraction from the probe                                                                                                       |
| NPC calls                                  | No                                                                                                                                         | Latency before speech, and the line must stay grounded in the game, not the world                                                            |

Options if web grounding were added to one operation:

1. **Claude's built-in WebSearch/WebFetch tools through the CLI.** Requires relaxing `--tools ""` for that one operation only. Billed at about $10 per 1,000 searches plus the tokens the results add (approximate, verify against current pricing before use). The model decides what to fetch, which is flexible but adds a second source of nondeterminism and makes prompt caching worse.
2. **Tavily search API called by the relay as a pre-fetch step.** The relay queries, then passes the results into the prompt as untrusted reference data, so the CLI stays tool-free and the same `--tools ""` lock holds. Pricing is credit-based: about 1 credit for a basic search and 2 for an advanced one, roughly $0.008 per credit pay-as-you-go with a free monthly allowance (approximate, verify before use). Deterministic and cacheable per question, but the relay must bound, deduplicate and cite the results.
3. **Both merged.** Built-in search for pages the model discovers itself, Tavily for the fixed pre-fetch. Highest cost and the hardest to attribute a quality change to.

Recommendation: keep every call offline for now. No call has a measured quality gap that web access would fill, and the grading paths will never take live web content. If grounding is added, add it to `generate` only, prefer the relay-side Tavily pre-fetch so the CLI keeps no tools, and test built-in search versus Tavily versus merged with the same knee method: same captured prompts, verified-source coverage as the quality signal (does the fetched page actually support the fact the question states?), downstream question quality ranked blind, and the noise-floor arm run twice. Prices above are approximate; confirm them before quoting cost.

## Open gaps

- No measurement data exists for any call yet. The usage log now records cost, usage, resolved model and validator outcome per call, but it starts empty and holds no quality signal on its own.
- No store of real production prompts exists per operation, so no ladder can be replayed yet. `tests/fixtures/run-designs/` is synthetic and cannot stand in.
- No blind judging protocol, no planted-defect sets and no agreed noise-floor size in quality points.
- `design-run` content-batch is only Partial: one conclusion, "high gained, xhigh added nothing", with no numbers, no sample size and no resolved model id.
- `tutor` and `generate` have never been judged downstream together, so the shared cost of the pair is unknown.
- `npc-chatter` first lines and replies share one profile, and the critic pass runs on replies with no measured latency contribution.
- The `npc-chatter-review` call is a judge that has never been tested against planted bad lines, so a false accept rate is unknown.
- The cost proxy is the CLI's `total_cost_usd` under a subscription; it is useful for ordering settings, not for an invoice.

## Log

- 2026-11-10: document created. No measurements yet. Tooling listed in "How to measure" still to build: per-call usage log, replay-sample store and ladder runner, blind judging with planted defects, NPC latency harness.
- 2026-11-10: per-call usage log added to the gateway (`.local/bridge-service/claude-usage.jsonl`) with `npm run ai:usage` to summarize it. Restart the relay (`npm run bridge:stop`, then start the game) to load it. Next tool: the replay-sample store and ladder runner.
