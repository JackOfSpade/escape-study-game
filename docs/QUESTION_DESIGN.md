# Development question design (PE track)

## Role focus and tutor depth

The active role is a product engineer who owns consumer/creative web features end to end, with strong UI craft and appropriate working backend knowledge. `career-profile.ts` overlays 51 core PE objectives at a maximum required depth of 3; it does not rewrite the 112-objective source bank or its original targets. Reference and optional objectives remain available as source material but are excluded from focused gates and automatic practice. The Full original curriculum setting reverses the overlay. Python interview fundamentals are unchanged.

New D1 tutor exchanges allow at most one directly relevant prerequisite level. The parser still understands older saved two-level observations; new exchanges cannot create those deeper branches. An unspecified gap outcome does not mark every unknown sibling as missing. Only explicit findings are recorded, and unasked facets remain unassessed.

The recipe-loading question now supplies DNS/HTTPS setup as completed facts, states DOM readiness behavior, and asks about stylesheet/script blocking, earlier heading paint and API/render ordering. Transport connection-order recall is outside that question. New live generation and native chat receive the role's bounded scope guidance; switching profiles does not reroll an already issued question.

## Root cause of the old questions

`productPractice` used to pick one of a few shared feature cases per objective
family, append family-wide "addenda" (for example the T20 microservice note)
and paste the objective's raw curriculum scope as "Your task: …". The scope is
a broad capability statement, so a single terminal question became an
open-ended project, its rubric quoted the scope, and unrelated families shared
the same facts. Declared gaps were also appended as extra "cover it too" chores.

## Current design

- **Exact objective lookup.** `src/product-practice.ts` looks up the
  objective's own question with `Object.hasOwn` across the T07 state bank, the
  X09 narrative bank, `foundationQuestions`, `deliveryQuestions` and
  `aiPracticeQuestions`. All 112 PE objectives are covered. Unknown,
  prototype-named (`__proto__`, `toString`, …) or missing ids throw
  `Unsupported development question: …`; nothing is invented.
- **Small concrete artifacts.** Each prompt supplies its own snippet, trace,
  log, schema or facts and asks one main reasoning question.
- **Task/rubric alignment.** Rubric items grade only what the prompt asks. The
  rubric is cloned per call so a caller's edits cannot change the bank. Rubrics
  may contain expected answers; `presentProblem` in `src/ai.ts` records only
  `prompt` and `starter` for the player, not the rubric.
- **Depth 1 is code reading.** At D1, X08.2 (debounce) and X08.3 (tabs) use
  overrides: trace a supplied snippet and describe a fix in words; no
  implementation and an empty starter. X08.1 at D1 may describe its `once`
  typing instead of writing it. D2+ keeps genuine implementation intent.
- **Narratives stay truthful.** X09 asks are bounded to one slice of one real
  project and forbid invented facts, work or metrics.
- **T20.2 is checked against its code.** A test runs the shown generated code
  on stubs and confirms the two defects the rubric expects (any collaborator
  can revoke; a revoked token still authorizes reads).

## Segmented questions and continuation

Complex questions are fine; sitting at one terminal for a long time is not. A
long question is therefore split into parts worked one per terminal visit,
and the walk to the next terminal (moving and looking around) is the break.

### Segment length

- Target about 10 minutes per part, allowed 6-15 minutes (360-900 s), scaled
  by depth: near 7 minutes at D1, 10 at D2 and 13-14 at D3-D4
  (`SEGMENT_POLICY` in `scripts/lib/question-segments.mjs`).
- A question estimated at 15 minutes (900 s) or less stays whole, exactly as
  before. Only longer questions (up to 60 minutes) are split, into 2-6 parts.
- Boundaries fall where a natural sub-goal is complete, never on a timer.
- Evidence (researched 2026-11-11): fixed 24/6 study/break cycles beat
  self-regulated long stretches on fatigue and concentration with equal task
  completion (Biwer et al. 2023, Br J Educ Psychol); 12/3 cycles showed no
  performance difference but most students found them too frequent and too
  short (Göksu, Wiradhany & de Bruin 2026, Behavioral Sciences); there is no
  real 10-15 minute attention cliff (Wilson & Korn 2007; Bradbury 2016); brief
  switches to a different task prevent the vigilance decrement (Ariga &
  Lleras 2011, Cognition); micro-breaks help vigor and fatigue, though
  recovering from very demanding work may need more than 10 minutes
  (Albulescu et al. 2022, PLOS ONE). Interrupting a half-finished thought is
  what made short cycles feel bad, hence sub-goal boundaries.

### Planning

`generate` plans the parts once. A question over 900 s must return
`segments: [{goal, rubricItems, facets, estimatedSolveSeconds}]`;
`validateQuestionSegments` (used by the gateway validator and by
`validateProblem` in `src/ai.ts`) rejects a plan unless every part has a goal,
at least one rubric index and real `scopeDefinitions` facet ids, every rubric
item belongs to exactly one part, each part is 360-900 s (so the first part is
never a trivial warm-up), goals are distinct and the parts add up to the whole
estimate within 25%. A question at or under 900 s must not carry segments.
The prompt still states the whole question; segments only order the work.

### One part per visit, one key per part

- The tutor payload carries `segment` (current goal, its rubric and facets,
  summaries of finished parts, and this part's conversation from earlier
  visits). The tutor works only toward that goal; `complete:true` means this
  part is done and comes with an optional `segmentSummary`.
- The game, not the reply, grants the key, through the existing completion
  path: the terminal is consumed and the key granted exactly as for a whole
  question, so the key economy and floor balance are unchanged.
- Field pacing (`solveEstimate`) uses the current part's estimate, not the
  whole question's.

### Continuation: the thread

- Every question the human is shown at a solo world terminal becomes a
  thread (`g.study.thread`, `src/question-thread.ts`); a short question is a
  one-part thread. Study-only workspace questions and linked group terminals
  are not threads.
- If a question is not done, the very next terminal the human opens continues
  it, on any floor, after a level change, after death and in the next run,
  with the full earlier conversation shown above the chat and its progress
  kept. The thread always comes before the curriculum scheduler; there is no
  parking, and no new question is prepared in the background while one is
  open. A terminal that already holds another started question keeps it.
- Only the terminal opened last can finish the current part; opening an
  earlier terminal of the same part moves the question back there. The
  learning attempt follows the question to its new terminal.
- Death keeps everything. After death the part stays answerable without a
  key, as before; finishing it then counts as done (the visit records
  `keyGranted: false`). Otherwise the next run's first terminal continues the
  same part with its chat. This replaces the old rule that a new run asks an
  unfinished question again from scratch.

### Assessment

`assess` waits until the thread is finished, then assesses each visit with
its own evidence and `packet.segment` (that part's goal, rubric and facets,
plus summaries of earlier parts as context). Facets of other parts stay
unknown in that visit's findings. A thread whose objective is suspended by a
reopened lower gate, or no longer scheduled, still continues: as with any
unscheduled terminal work, that visit is then not a ledger visit and the
terminal says why.

### Saving

The thread is part of study state, so it is written in the same checksummed
snapshot as the terminals and keys it refers to: a crash can never leave a
half-written thread or a key without its recorded part (`load` keeps the
newest copy that passes its integrity check). The game saves right after each
learner message, after each applied reply (which includes part completion),
on binding a thread to a terminal, on tab hide and on page close (whose
synchronous local copy lands even if IndexedDB cannot finish). A reply cut off
by a reload, crash or relay restart is resent once, as the same request, when
its terminal is reopened; the existing reply-id check means it is never
applied twice. A message left unanswered in an earlier run is offered as the
new terminal's draft instead of being copied as new evidence.

## Development vs live

`devProblem` returns `provenance: "development"`, the exact scheduled contract
(unchanged source scopes and curriculum; the selected role overlay controls future scheduling) and `starter: ""`. Its
random draws are unchanged. Live questions are written by the tutor under
`PROBE_STANCE`: one focused question whose correct answer genuinely depends on
its prerequisite facets, never a wider question or extra task. The synthetic
terminal demo (`scripts/terminal-mcp-app.mjs`) uses the same wording and still
describes gap descent and its single synthetic key.

## Limits

- A correct answer to one development question is practice evidence, never
  certification of full objective mastery.
- The static PE bank does not adapt to arbitrary declared gaps, so PE prompts
  no longer append gap lines. Python development traces keep their gap line.
- Previously captured questions, encounters and retries keep their stored
  problem text; only newly generated development questions change.

## Verification

```sh
npx tsc --noEmit -p .
npx tsx --test tests/practice-problem.test.ts tests/question-thread.test.ts
node --test tests/terminal-mcp-app.test.mjs
```
