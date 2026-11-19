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

## One part at a time

A question that asks for more than one thing is shown one ask at a time, so the learner starts with a single thing to answer. `generate` returns the shared material (scenario, code, data, fixed facts) as `prompt` and each ask as an entry of `parts` (one to three; the validators accept up to five). The app stores the whole text in `problem.prompt`, which every other reader uses (assessment, history, bug reports), and, when there are two or more asks, the staged form in `problem.staged: { shared, parts }`. A question with one ask is shown whole, as is any question saved before 2026-11-18.

While a staged question is open the question pane shows the shared material and the open part only. Each tutor request carries `stage: { part, of, question }`; the tutor works on that part alone and never mentions a later one. When the part is answered, or the learner gives up what remains of it, the tutor returns `partComplete: true` with `complete: false`. The app records that message in `encounter.partReady` and the conversation ends with a "Next part" button, shown only then. The part stays open until the learner presses it, so they can read the confirmation and ask more about that part first (those requests carry `stage.confirmed: true`). Pressing it records the last message of the part in `encounter.partsDone`, fades the old part out and writes the next in its place, with the finished parts under a closed "Earlier parts" disclosure, and clears the conversation on screen. The cleared messages stay in the record and every tutor request still carries them; `stage.since` is the seq of the last message before the open part, so the tutor reads later messages as answers to that part even when the learner does not restate it. A facet given up when leaving a part is recorded as a knowledge gap at once. Only the last part can finish the question: the relay and the app both reject `complete: true` while a part is still hidden. It stays one question, with one conversation, one completion and one assessment. A finished question shows every part and the whole conversation, with a marker where each part ended.

The rules live in `scripts/lib/question-parts.mjs` (guidance text and validators) and `src/question-parts.ts` (what is shown).

## Question length

Complex questions are fine; sitting at one for a long time is not. Every question is sized for one sitting: `generate` returns `estimatedSolveSeconds` from 30 to 900 (15 minutes), and both the gateway validator and `validateProblem` in `src/ai.ts` reject a longer estimate. Evidence (researched 2026-11-11): there is no real 10 to 15 minute attention cliff (Wilson and Korn 2007; Bradbury 2016), but fixed study/break cycles beat self-regulated long stretches on fatigue and concentration (Biwer et al. 2023, Br J Educ Psychol).

Older saves may hold a `segments` plan on a question and a `thread` on the record or a conversation, from a split-question design that was never wired into the study workspace. Those fields are carried through as saved data and nothing reads them; such a question is worked as a whole.

## Limits

- The generated bank is not adaptive beyond the scheduler's contract and the recorded probe gaps; a prompt cannot rewrite scheduler state, version or evidence constraints.
- Question quality has been judged on synthetic cases only; see [AI model and effort selection](AI_MODEL_SELECTION.md).

## Verification

```sh
npx tsc --noEmit -p .
node --import tsx --test tests/question-design.test.ts tests/question-clarity.test.ts tests/question-parts.test.ts
npx playwright test tests/browser/question-parts.spec.ts
```
