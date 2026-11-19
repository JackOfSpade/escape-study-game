# Question design

## Role focus and tutor depth

The active role is a product engineer who owns consumer and creative web features end to end, with strong UI craft and appropriate working backend knowledge. `src/career-profile.ts` overlays 51 core Product Engineering objectives (`CORE_IDS`) at a maximum required depth of 3; it does not rewrite the 112-objective source bank or its original targets. Reference and optional objectives remain available as source material but are excluded from focused gates and automatic practice. The "Full original curriculum" setting reverses the overlay. Python interview fundamentals are unchanged.

Generation payloads carry the role's bounded scope guidance (`careerScopeGuidance`). Switching profiles never rerolls a question already issued.

New tutor exchanges allow at most one directly relevant prerequisite level (the tutor instruction in `scripts/lib/ai-contracts.mjs`). The probe parser still reads older saved observations with two levels (`SUB_FACET_DEPTH` in `src/knowledge-probe.ts`); new exchanges cannot create deeper branches. An unspecified gap outcome does not mark every unknown sibling as missing: only explicit findings are recorded, and unasked facets stay unassessed.

## Generation policy

Every question is written by Claude (`generate`). The instructions are assembled by `taskInstructions("generate")` in `scripts/lib/ai-contracts.mjs` from the constants in `scripts/lib/study-question-policy.mjs` and `scripts/lib/question-parts.mjs`; the request also carries `QUESTION_GENERATION_POLICY` from `src/ai.ts`. Each rule is sent once.

The top-level rule, shared by generation and tutoring, is **minimum evidence** (`MINIMUM_EVIDENCE_GUIDANCE`): ask for the smallest thing that proves the skill, once, as short as the skill allows. A second item, part, facet or follow-up is allowed only when it tests something the first does not. Extra probing is for after a miss. A complete correct answer ends the question or the part at once; where the reasoning is the skill, the question asks for the answer and its reason together.

The policy asks for:

- a standalone question: the shared prompt and the part on screen together supply the scenario, code, data, timing and rules needed to answer without the chat, and every rubric requirement is visible there;
- the smallest self-contained diagnostic, with one main problem and a follow-up only when it tests something the main problem does not, in plain language that never mentions the schedule, objective IDs, tiers or depth;
- depth 1 as code reading or reasoning, with an empty starter and no implementation requirement drawn from an objective's verb; at depth 3, for scoping and design objectives, only the brief and hard constraints are given and the learner states the assumptions;
- the contract and existing stable scope definitions copied exactly, with open knowledge gaps (`probeRecords`) as the apex of the question;
- interview realism: the problem shapes, constraints and follow-ups a working interviewer would use. For an objective about the learner's own projects, the learner picks a real project of their own and the rubric judges structure and honesty, never particular facts; a critique of a supplied answer is the exception and is limited to four one-line facts and one short answer;
- for the product-engineer profile, a consumer or creative web feature as the setting when the objective does not fix a domain (`careerScopeGuidance`);
- variety: the request carries up to five earlier questions on the same objectives (`earlierQuestions`: title, a 160-character opening and the asks, never answers or tutor text), and a regenerated question's `replaces` carries the replaced asks, so the new question changes scenario and the shape of its ask.

`QUESTION_SHAPE_GUIDANCE` is the last block the generator reads. Answerability comes first: a fact a correct answer needs is never dropped. Beyond that:

- short reading: a few terse facts, only those a correct answer turns on (plus deliberate distractors when filtering is the skill), with no framing story, cast or restated instructions;
- one of each kind: items of the same kind are asked about once; "identify each" and "for each one" are used only when finding every instance is the skill, and never in front of a justification that would read the same for every item;
- facets and rubric: a new scope definition has one facet per distinct understanding, never one per list member, because the tutor probes every facet; a rubric line is one checkable judgement;
- parts: most questions have one. A part is added only when it tests something the first does not.

The tutor and the assessor follow the same rule: one general statement, or the point worked for one item, establishes facets of the same kind; a correct answer is not kept open for elaboration; and a short correct answer is never marked down.

`estimatedSolveSeconds` is the time a learner who already has the skill needs for one complete correct answer. Nothing in the app reads it except validation and the capture metrics.

A correct answer to one question is practice evidence, never certification of full objective mastery. Previously captured questions, conversations and retries keep their stored text.

## One part at a time

A question that asks for more than one thing is shown one ask at a time, so the learner starts with a single thing to answer. `generate` returns the shared material (scenario, code, data, fixed facts) as `prompt` and each ask as an entry of `parts` (one to three, usually one; a generated reply with more than three is rejected and corrected, while stored questions with up to five still load). The app stores the whole text in `problem.prompt`, which every other reader uses (assessment, history, bug reports), and, when there are two or more asks, the staged form in `problem.staged: { shared, parts }`. A question with one ask is shown whole, as is any question saved before 2026-11-18.

While a staged question is open the question pane shows the shared material and the open part only. Each tutor request carries `stage: { part, of, question }`; the tutor works on that part alone and never mentions a later one. When the part is answered, or the learner gives up what remains of it, the tutor returns `partComplete: true` with `complete: false`. The app records that message in `encounter.partReady` and the conversation ends with a "Next part" button, shown only then. The part stays open until the learner presses it, so they can read the confirmation and ask more about that part first (those requests carry `stage.confirmed: true`). Pressing it records the last message of the part in `encounter.partsDone`, fades the old part out and writes the next in its place, with the finished parts under a closed "Earlier parts" disclosure, and clears the conversation on screen. The cleared messages stay in the record and every tutor request still carries them; `stage.since` is the seq of the last message before the open part, so the tutor reads later messages as answers to that part even when the learner does not restate it. A facet given up when leaving a part is recorded as a knowledge gap at once. Only the last part can finish the question: the relay and the app both reject `complete: true` while a part is still hidden. It stays one question, with one conversation, one completion and one assessment. A finished question shows every part and the whole conversation, with a marker where each part ended.

The rules live in `scripts/lib/question-parts.mjs` (guidance text and validators) and `src/question-parts.ts` (what is shown).

## Question length

Complex questions are fine; sitting at one for a long time is not. Every question is sized for one sitting: `generate` returns `estimatedSolveSeconds` from 30 to 900 (15 minutes), and both the gateway validator and `validateProblem` in `src/ai.ts` reject a longer estimate. Evidence (researched 2026-11-11): there is no real 10 to 15 minute attention cliff (Wilson and Korn 2007; Bradbury 2016), but fixed study/break cycles beat self-regulated long stretches on fatigue and concentration (Biwer et al. 2023, Br J Educ Psychol).

Older saves may hold a `segments` plan on a question and a `thread` on the record or a conversation, from a split-question design that was never wired into the study workspace. Those fields are carried through as saved data and nothing reads them; such a question is worked as a whole.

## Rejected replies

A reply the gateway's validator rejects gets one correction, which shows the model its own rejected reply (the first 6,000 characters) with the reason. A reply the gateway accepted but the app refuses (`validateProblem` or the scope checks) is retried under a new request identity, because the gateway keeps accepted answers by request id for ten minutes and would otherwise hand back the same reply. A transport failure still retries the exact saved request.

## Measuring questions

`node scripts/ai-capture/question-metrics.mjs <results.jsonl>` prints, with no network use, the reading load of generated questions in a ladder results file: words and bullet lines outside code, part count, the share of text shown up front, facet count, and whether a part asks for a per-item justification. There is no hard length limit: code-reading questions are legitimately long, so length is reported, not rejected.

## Limits

- The generated bank is not adaptive beyond the scheduler's contract and the recorded probe gaps; a prompt cannot rewrite scheduler state, version or evidence constraints.
- Question quality has been judged on synthetic cases only; see [AI model and effort selection](AI_MODEL_SELECTION.md).

## Verification

```sh
npx tsc --noEmit -p .
node --import tsx --test tests/question-design.test.ts tests/question-clarity.test.ts tests/question-parts.test.ts tests/question-metrics.test.ts
npx playwright test tests/browser/question-parts.spec.ts
```
