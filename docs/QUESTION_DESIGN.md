# Question design

## Role focus and tutor depth

The active role is a product engineer who owns consumer and creative web features end to end, with strong UI craft and appropriate working backend knowledge. `src/career-profile.ts` overlays 51 core Product Engineering objectives (`CORE_IDS`) at a maximum required depth of 3; it does not rewrite the 112-objective source bank or its original targets. Reference and optional objectives remain available as source material but are excluded from focused gates and automatic practice. The "Full original curriculum" setting reverses the overlay. Python interview fundamentals are unchanged.

Generation payloads carry the role's bounded scope guidance (`careerScopeGuidance`). Switching profiles never rerolls a question already issued.

New tutor exchanges allow at most one directly relevant prerequisite level (the tutor instruction in `scripts/lib/ai-contracts.mjs`). The probe parser still reads older saved observations with two levels (`SUB_FACET_DEPTH` in `src/knowledge-probe.ts`); new exchanges cannot create deeper branches. An unspecified gap outcome does not mark every unknown sibling as missing: only explicit findings are recorded, and unasked facets stay unassessed.

## Generation policy

Every question is written by Claude (`generate`), under `QUESTION_GENERATION_POLICY` in `src/ai.ts` and the shared guidance in `scripts/lib/study-question-policy.mjs`. The policy asks for:

- a standalone question: the prompt alone supplies the scenario, code, data, timing and rules needed to answer without the chat, and every rubric requirement is visible in it;
- the smallest self-contained diagnostic, with one main problem and at most one or two connected follow-ups, in plain language that never mentions the schedule, objective IDs, tiers or depth;
- depth 1 as code reading or reasoning, with an empty starter and no implementation requirement drawn from an objective's verb;
- the contract and existing stable scope definitions copied exactly, with open knowledge gaps (`probeRecords`) as the apex of the question;
- interview realism: the problem shapes, constraints and follow-ups a working interviewer would use.

A correct answer to one question is practice evidence, never certification of full objective mastery. Previously captured questions, conversations and retries keep their stored text.

## Segmented questions

Complex questions are fine; sitting at one for a long time is not. A question estimated over 15 minutes is planned at generation time as ordered parts of about ten minutes.

### Segment length

- Target about 10 minutes per part, allowed 6 to 15 minutes (360 to 900 s), scaled by depth: near 7 minutes at D1, 10 at D2 and 13 to 14 at D3 and D4 (`SEGMENT_POLICY` in `scripts/lib/question-segments.mjs`).
- A question estimated at 900 s or less stays whole. A longer one (up to 3600 s) is split into 2 to 6 parts. Boundaries fall where a natural sub-goal is complete, never on a timer.
- Evidence (researched 2026-11-11): fixed 24/6 study/break cycles beat self-regulated long stretches on fatigue and concentration with equal task completion (Biwer et al. 2023, Br J Educ Psychol); 12/3 cycles showed no performance difference but most students found them too frequent and too short (Goksu, Wiradhany and de Bruin 2026, Behavioral Sciences); there is no real 10 to 15 minute attention cliff (Wilson and Korn 2007; Bradbury 2016); brief switches to a different task prevent the vigilance decrement (Ariga and Lleras 2011, Cognition); micro-breaks help vigor and fatigue, though recovering from very demanding work may need more than 10 minutes (Albulescu et al. 2022, PLOS ONE). Interrupting a half-finished thought is what made short cycles feel bad, hence sub-goal boundaries.

### Planning

`generate` plans the parts once. A question over 900 s must return `segments: [{goal, rubricItems, facets, estimatedSolveSeconds}]`. `validateQuestionSegments` (used by the gateway validator and by `validateProblem` in `src/ai.ts`) rejects a plan unless every part has a goal, at least one rubric index and real `scopeDefinitions` facet ids, every rubric item belongs to exactly one part, each part is 360 to 900 s, goals are distinct and the parts add up to the whole estimate within 25%. A question at or under 900 s must not carry segments. The prompt still states the whole question; segments only order the work.

### Threads: current state

Working a segmented question one part per visit is implemented as a thread (`study.thread`, `src/question-thread.ts`), but the study workspace no longer starts one, so a newly generated question is worked as a whole. What remains is support for saves that already hold a thread: such a thread can still be continued, completed and assessed. For those saves:

- The tutor payload carries `segment` (the current goal, its rubric and facets, summaries of finished parts and this part's earlier conversation). The tutor works only toward that goal, and `complete: true` means this part is done, with an optional `segmentSummary`.
- Only the thread's active conversation can finish the current part; a reply from another visit of the thread cannot set `complete`.
- `assess` waits until the thread is finished, then assesses each visit with its own evidence and `packet.segment`; facets of other parts stay unknown in that visit's findings.
- The thread is saved in the same checksummed snapshot as the conversations it refers to, so a crash cannot leave a half-written thread.

## Limits

- The generated bank is not adaptive beyond the scheduler's contract and the recorded probe gaps; a prompt cannot rewrite scheduler state, version or evidence constraints.
- Question quality has been judged on synthetic cases only; see [AI model and effort selection](AI_MODEL_SELECTION.md).

## Verification

```sh
npx tsc --noEmit -p .
node --import tsx --test tests/question-design.test.ts tests/question-clarity.test.ts tests/question-thread.test.ts
```
