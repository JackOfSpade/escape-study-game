# Escape redesign: a life in action, and something about to go wrong

Status: design agreed with the user on 2026-11-12. This document is the source of truth for the redesign; where it conflicts with older docs, this one wins for new games. Old saves keep their historical behaviour.

## 1. The premise

Every new game drops the player into an existing life already in motion: a teacher in the middle of a lesson, an engineer on a Mars colony, a scientist preparing a launch. The AI generates the setting, the person the player controls and that person's backstory, which the player is told.

Something is about to go horribly wrong. The player knows this from the game's design, but is never told what it is. After a grace period it happens, on a real-time clock.

The game is still a study game. Every physical action the player takes to escape (loosening a bolt, wrenching a door, hotwiring a car) is a study terminal. Replacing terminals with timed actions would turn it into a pure game later; that is out of scope.

## 2. Binding decisions

These came from the user and are not to be re-litigated:

1. **Working out what is coming is optional.** Clues are the natural side effects of what is really happening, not a puzzle. A player who only wants to escape can ignore them.
2. **No guaranteed escape.** The world is honest. A burned route stays burned. The generator only builds a world where realistic escape options exist at the start.
3. **The director does not read the player's mind.** The world responds to attempts. Requirements are generated when the player engages with something, then committed.
4. **Real-time clock.** The catastrophe runs on wall-clock game time. The game pauses only on Escape and while waiting for AI to prepare the next question.
5. **One life per game.** Death ends the attempt; **Restart** replays it.
6. **Restart is a time loop.** The world, the catastrophe and its timeline, every AI-generated fact and area, and study progress are all kept. NPCs forget the player. The player keeps their journal.
7. **"New game" replaces "Generate new level".** "Level" disappears from the UI. A game has connected **areas**.
8. **Epilogue.** Shown only when the player clicks **New game**, before the next world is generated, so replays are never spoiled. It covers the premise of what was supposed to happen and an account of what actually happened in the most recent loop.
9. **NPCs are oblivious** to the catastrophe, go about their day, greet the player, chat in character with imperfect knowledge, and react realistically when it hits. They can take damage and die; the dead fall and stay as bodies. Never despawn.
10. **Open conversation.** No dialogue panels. NPCs say things out loud. The player presses Enter, types, presses Enter, and the character says it aloud through the voice system. Anyone who overhears may join in.
11. **Addressee is who the player faces.** A name overrides facing. Facing nobody is a general remark. Being addressed decides who is expected to answer, not who may speak. NPCs turn toward whoever they speak to.
12. **One speaking volume.** No whisper or shout. Hearing range is realistic for a normal voice, with walls and doors attenuating it.
13. **PA system.** Announcements play through building speakers with a realistic loudspeaker sound (a recorded impulse response; licensing is irrelevant for personal use, pick the most realistic). Announcements are true in the world. Most are routine. The PA voice is chosen at random once per game and kept until **New game**. NPCs may share that voice.
14. **NPCs react to announcements** out loud, like real people: comments, questions, arguments, rumours.
15. **Persuasion is realistic, not balanced.** What an NPC has seen and heard lowers the proof it needs. Do not worry about the game becoming too easy.
16. **NPCs only know what they know** about the player and the situation, never the director's view.
17. **Suspicious actions escalate realistically**: notice, question, then accept, watch, report, intervene or detain. Never an instant arrest or game over.
18. **Reporting is a journey.** Only people with authority can detain. Others go to report; the report can be lost if the reporter is distracted, panics or dies. Someone with authority then comes to where the player was last seen.
19. **Detention** is a room locked from outside. Anyone can unlock it from outside. The player can wait and talk to passers-by. Panic makes an NPC easier to persuade, but it does not free the player unasked. Unprompted release needs a reason: a friend, or a guard following evacuation procedure.
20. **Lead, escort and follow** are visible world behaviours; no cut to black. Escort is forceful. An NPC leading the player checks back now and then, with frequency depending on personality, and only notices the player is gone when it checks. Short stops do not count.
21. **Per-NPC history with the player** within one loop ("Hey! I was showing you where it was, where'd you go?"). The NPC resumes its own goal meanwhile.
22. **Voices are stable.** The player picks a gender at **New game**; the player's voice is drawn from that gender and kept through restarts. Every NPC keeps its voice, name, personality and backstory through restarts because NPCs are saved world entities, not rerolled spawns. Everything redraws only on **New game**.
23. **Study tasks map onto question checkpoints** (section 8).
24. **AI predicts what the player is trying to do** from all available signals, only to decide what to build in the background.

## 3. The hidden catastrophe

At generation the AI writes a sealed **catastrophe spec**. Neither the player nor any NPC prompt ever receives it.

```
CatastropheSpec {
  id, title                      // e.g. "The excavation device"
  premise                        // what it really is, in prose (epilogue only)
  origin { areaId, roomHint }    // where it starts
  behaviours: Behaviour[]        // 1-3 entries from the fixed vocabulary
  timeline {
    graceSeconds                 // calm period; 240-900 s
    phases: Phase[]              // omens -> onset -> spread -> peak
  }
  omens: Omen[]                  // 5-10 natural side effects, placed in the world
  publicStory                    // what officials will say over the PA once it is visible
}
```

### Behaviour vocabulary

The AI chooses and tunes behaviours; it never writes code. Each kind is implemented once in the engine.

| Kind              | Engine basis                                                          | Tunable parameters                                                                                                                                                                                                                                            |
| ----------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hunter`          | the existing zombie pursuit, search, door-breaking and contact damage | body (colour, scale, silhouette parts), count, speed, sight range, hearing weight, door behaviour, damage, spawn rule (single, breeding, wave)                                                                                                                |
| `hazard`          | a grid flood-fill spreading room to room through open doors           | medium (fire, smoke, water, gas, vacuum, cold), spread rate, damage per second, blocked by closed doors (yes/no), visibility effect                                                                                                                           |
| `perception-rule` | a predicate evaluated each tick for each living actor                 | trigger: `sees-own-reflection` (reflective tagged surfaces in line of sight), `makes-sound` (speech/running above a loudness), `in-darkness` (room unlit), `looks-at-entity` (a hunter in view); effect: damage rate or instant death; optional warning tells |
| `collapse`        | room/system failure events                                            | targets (power, doors, structure, life support), cadence, consequences (rooms go dark, doors jam or unlock, floor sections fall)                                                                                                                              |

A unique creature is a unique combination of body, behaviour parameters and rules. The validator bounds every number, so the engine can always run it and the GameTest lab can always test it.

### Timeline

- **Grace period**: nothing visible happens beyond normal life and early omens.
- **Omens**: small, honest effects (flickering lights near the origin, a sensor alarm, an NPC with a headache, a lab placed on lockdown).
- **Onset**: the first undeniable event. NPCs who witness it panic; others hear about it through sound, people running and the PA.
- **Spread and peak**: behaviours escalate per their parameters.

The timeline is deterministic for a game: every restart replays the same schedule, so learning its timing pays off.

## 4. Fact ledger and the director

### The ledger

A persistent, append-only list of facts for the game. Each fact has an id, text, subject (an area, object, NPC or system), the source that revealed it, and visibility (`public`, `npc:<id>`, `role:<role>`, `document:<id>`, `hidden`). Once committed a fact never changes; later facts may supersede world _state_ (a door now jammed) but never contradict history.

Facts survive restarts. The _player's knowledge_ of facts is the journal (below); NPC knowledge is derived from visibility.

### Responding to attempts

The director never guesses intent to change the world. Requirements appear when the player **engages**:

- trying an object (the rocket hatch),
- asking an NPC about it,
- reading a document or computer about it.

On engagement, the director asks the AI for the realistic answer ("the hatch needs a flight-crew badge and a launch-control override"), validates it against the ledger, area graph and engine capabilities, commits it as facts, and, if it is an actionable step, registers a **task** (section 8).

### The journal

The player's journal is the only plan they get. It is written automatically from facts the player has actually learned: "Rocket hatch: flight-crew badge (Ortiz has one?)". It survives restarts.

### Intent prediction (background building only)

Periodically and on events (a conversation ends, a fact is learned, the player enters an area), the AI receives the journal, recent conversations, documents read, movement and dwell, and returns a ranked list of likely goals with confidence. It is used only to choose which areas to pre-generate. A wrong guess costs generation, nothing else.

## 5. Areas: a connected world

A game is a graph of **areas** (the colony, the rocket interior, the beacon). Each area is a building-like map the existing engine can simulate. A **portal** joins two areas: an airlock, hatch, lift, vehicle ride or door.

- Only the starting area is generated before play. Other areas start as portal stubs with a short description and are generated when needed.
- **Background generation**: as soon as a route that mentions an area becomes live, or intent prediction ranks it high, generation starts.
- **In-world transitions** hide the rest: an airlock cycling, a lift ride, a car journey, a hatch that takes time to open. If the area is still not ready, the transition lasts longer (the airlock reports "equalising pressure"). As a last resort it shows a loading state.
- Generated areas are saved with the game and kept across restarts.
- The catastrophe reaches other areas only where its behaviours plausibly can (a hazard follows connected space; a hunter can follow through an open portal).

## 6. PA system

- **Speakers** are placed objects in indoor areas. PA audio is a broadcast channel: heard indoors wherever there are speakers, not outdoors. It is the deliberate exception to the single proximity model.
- **Sound**: chime, then the PA voice convolved with a recorded loudspeaker impulse response, with a short room reverb from the listener's area.
- **Voice**: drawn once per game from the voice catalog, saved on the game, kept until **New game**.
- **Content** is generated from the setting, the ledger, and the catastrophe's phase. The mix: mostly routine (weather, schedules, maintenance), some unrelated incidents, some that border on the catastrophe and may mislead, then escalation after onset ("Code red, all staff evacuate immediately. This is not a drill.").
- **Truth**: every announcement is committed to the ledger with public visibility, and any stated state is applied (a power outage turns that room's lights off).
- **NPC reaction**: each announcement is a heard event for every NPC within PA reach. It raises alarm by its content and becomes a conversation topic.

## 7. NPC social simulation

### Awareness

Each NPC keeps an **awareness record**: events it witnessed (saw, heard, was told), the PA announcements it heard, and an **alarm level** derived from them. Witnessed people running, screams, bodies and code red raise alarm sharply. Awareness resets on restart.

### Model of the player

Each NPC keeps its own picture of the player: their role and its relationship to the player, what it has seen the player do, rumours others told it, and an **interaction history** (asked, offered, lies, promises, help given, walked off while being led). This history lasts for one loop.

### Open conversation

- Every utterance (player, NPC, PA) is an event heard by everyone in earshot, with attenuation through walls and doors.
- **Addressee**: for the player, whoever is nearest the centre of view and within earshot; a spoken name overrides; facing nobody makes it a general remark. NPCs address by name or by turning to face.
- **Turn-taking per conversation group**: one speaker at a time, a natural pause, then the next speaker. Priority goes to the addressee, then to whoever has something relevant, then by personality (nosy NPCs butt in, shy ones stay quiet).
- **Knowledge separation**: a cheap first step chooses who speaks; the line is then written with only that NPC's knowledge. Never one combined call that sees every character's knowledge.
- **Latency**: short replies, streamed text, and an immediate small reaction (turning, "hm?") while the line is prepared.
- Speech bubbles stay as world text, not panels.

### Structured outcomes

Each NPC reply carries a structured outcome the game applies, never free text alone:

`none`, `share-fact(factId)`, `lead(targetId)`, `follow`, `stop-following`, `refuse`, `ask-for-proof`, `agree-with-conditions`, `report(player)`, `watch(player)`, `intervene`, `detain`, `unlock(doorId)`, `alarm(+n)`.

The AI judges persuasion from personality, alarm level, relationship, and evidence the player actually presented from the ledger. Gameplay validates that the outcome is possible (an NPC without authority cannot `detain`; `unlock` needs the NPC at the door).

### Suspicion

Noticing depends on sight or hearing of the action, the location, and whether the action fits the player's role (an engineer working on a rover is plausible; a teacher is not). The ladder: notice, question (an open conversation the AI judges against the backstory as the NPC knows it), then an outcome: accept, keep watching, call a supervisor, report (the asset may be locked down), intervene physically, or detain.

### Reporting and detention

- `report` gives the NPC a goal: radio it in if its role has a radio, otherwise walk to someone with authority or a phone. The goal can be dropped if the NPC panics, is distracted by something bigger, or dies.
- A delivered report sends someone with authority to where the player was last seen. If the player has gone, they may search or give up.
- Detention: an NPC with authority escorts the player to a lockable holding room and locks it. The door locks from outside and anyone can unlock it from outside. The player can wait and talk to passers-by.
- A guard returning to an empty room records it in their history and in the history of whoever freed the player, if seen or told.

### Lead, escort, follow

- **Lead**: walks ahead, checks back at intervals based on personality (attentive guard often, distracted or hurried NPC rarely), waits at doors and corners, talks on the way. It notices the player is missing only when a check finds them far away or out of sight; short stops do not count. It then looks around, calls out, walks back a bit, and finally gives up and resumes its own goal.
- **Escort**: forceful. The NPC holds the player; player movement is limited to following. The player can talk the whole way. Breaking free is possible with consequences: alarm, a call for help, a possible chase.
- **Follow**: the NPC becomes a companion with its own will and can lose its nerve, argue or leave.

### Death

NPCs take damage from behaviours. At zero health they fall and stay as bodies, solid to sight and touch only as a floor object, never despawned. Bodies are witnessed events that raise alarm.

## 8. Tasks and terminals

- A **task** is a physical action with a step count chosen to make sense in the story ("loosen the bolts: 4"). The director picks the number; it does not depend on how many parts a question has.
- A **terminal session** is one persistent terminal working through the study queue. It continues across tasks and across games.
- **Each completed question checkpoint advances the current task by one step.** The counter ticks in the terminal and in the world without closing, flickering or reopening the terminal.
- If the question finishes before the task, the same terminal loads the next question. If the AI must prepare it, the game pauses, including the catastrophe clock.
- If the task finishes before the question, the terminal closes automatically at that checkpoint. The rest of the question carries into the next task's terminal, or into the next game.
- Progress saves at every checkpoint and with periodic draft saves.
- While a task is in progress the character shows the action (animation pose and a world progress indicator), and the action makes noise and is visible to NPCs, which feeds suspicion.
- Being interrupted (a threat, an NPC walking in) pauses the task; nothing is lost.
- Learning-evidence rules are unchanged: the game, not the AI, decides credit.

## 9. Voices and player speech

- Speech engine: the existing local Kokoro-82M. It has no whisper or shout control; that idea was dropped.
- The player chooses a gender at **New game**. The player's voice is drawn from that gender's pool and stored on the game.
- Each NPC's voice and matching gender are set when the NPC is first created and stored with that NPC.
- The PA voice is stored on the game.
- Restart keeps all of them. **New game** redraws them.
- Player speech: Enter opens the chat box, Enter sends. The world does not pause while typing. The line plays at the player's position with the normal proximity model.

## 10. Event log and epilogue

- During play the game records a structured event log: catastrophe phases, PA announcements, reports and their delivery, NPC deaths with cause, place and time, alarms, evacuations and departures, and the player's actions and fate.
- When a loop ends (death or escape) the game condenses the log into a timeline grouped by area and phase and asks the AI for an epilogue from the spec plus the timeline. It states only what the log shows; for areas never built it describes what the spec implies, phrased as likely.
- The epilogue is stored and shown only when the player clicks **New game**, during generation. Only the most recent loop is used.

## 11. Restart (time loop) and New game

|                                                | Restart   | New game                |
| ---------------------------------------------- | --------- | ----------------------- |
| World, areas, catastrophe spec, timeline       | kept      | regenerated             |
| Fact ledger                                    | kept      | cleared                 |
| Player journal                                 | kept      | cleared                 |
| NPC identities, voices, personalities          | kept      | regenerated             |
| NPC memory, awareness, history with the player | reset     | regenerated             |
| Player, NPC, PA voices                         | kept      | redrawn                 |
| Study progress                                 | kept      | kept                    |
| Epilogue                                       | not shown | shown before generation |

## 12. Edge rules (from the design review, 2026-11-12)

**Clock.** The catastrophe schedule is measured in game time (`Game.time`), which already stops while the game is paused and while it waits on AI. Every loop therefore replays the same schedule regardless of how long AI calls took. Opening a terminal does not pause the world: the player can be hurt or interrupted while working, and NPCs can see the action.

**Steps and question parts.** Each completed question part advances the current task by exactly one step. The task's step count is chosen for the story (at most 8); a question with more parts than the task has steps leaves its remaining parts for the next task, or the next game. A task records its station (`EscapeTask.stationId`).

**Objects on the fly.** When an engagement turns into a task on an object that has no study station, the game creates a station and a solo encounter at that object. The objects themselves come from the area's design; the director does not invent new geometry mid-game.

**Destroyed or unreachable task objects.** The task becomes `abandoned`; its `onComplete` fact is never committed. Progress already made is not refunded.

**What NPCs know.** An NPC prompt receives (1) durable world facts visible to that NPC through the ledger, and (2) that NPC's own awareness record for events. Event facts (PA announcements, sightings) reach NPCs only through awareness, which depends on who actually heard or saw them. Facts carry the loop they were committed in; durable facts stay true in every loop, event facts belong to their loop. The player's journal keeps everything, tagged by loop.

**Sealed spec.** Prompt builders for NPC speech, PA, engagement and intent prediction receive a projection of the game that never includes `Game.escape.catastrophe`. Omens commit only their perceptible text (`Omen.text`) as observations. The `publicStory` reaches the PA only after onset. `share-fact` is accepted only for facts visible to that NPC. Only the epilogue receives the premise.

**NPC identity.** NPC ids come from deterministic generation of the area, so the same NPC reappears with the same id on every loop. NPCs of generated areas get ids prefixed with the area id. A voice slot implies its gender (`genderOfSlot`).

**Area swap.** Entering a portal parks the current area (its floors, people and hunters) in `areaStore` and activates the destination. Parked areas are frozen: nothing ticks there, nobody there hears the PA, and the catastrophe resumes there when the player returns. Social goals of NPCs left behind are cancelled; a companion with a `follow` goal travels with the player. Hunters and hazards do not cross portals in this version. A failed area generation keeps the portal shut with an in-world reason ("the hatch won't open"); the current area is parked only once the destination is ready.

**Restart.** Task progress resets with the world (the bolts are tight again); tasks and the journal are kept. NPC social state (awareness, model of the player, goals) is cleared. Room power overrides and door locks reset. Ending a loop by Restart writes that loop's epilogue with outcome "restarted"; only the newest completed loop's epilogue is kept.

**Bodies.** Dead NPCs keep `alive: false` and get `downAt`; they are drawn fallen and are never removed. Catastrophe hunters (`Zombie.hunter`) that die keep their record with `downAt` instead of being deleted. Legacy zombies keep their old behaviour.

## 12b. What stays from the current engine

Physics, navigation, doors, furniture, lighting, visibility, acoustics, the hunter pursuit code, the run-design pipeline, NPC chatter and cognition, the Kokoro voice service, terminals, curriculum and learning evidence, persistence and the GameTest lab. The redesign layers new contracts and systems onto these.

## 13. How it maps onto the current code

Findings from the code map (2026-11-12), which shape the plan:

- **One building per game.** `Game.floors` is a fixed array of five floors sharing one footprint (`src/world.ts`, `src/building-layout.ts`), and every system indexes `g.floors[a.floor]`. Areas therefore cannot be extra floors. The plan keeps the _active_ area's floors in `Game.floors` and parks inactive areas, frozen, in `Game.escape.areaStore`; a portal transition swaps them. No system needs to learn about areas except the swap and the area graph.
- **Restart today rebuilds the world** from seed and design (`fresh()` in `src/main.ts`) and deletes `study.pending`. The time loop rebuilds from the same seed and design (which reproduces the starting area exactly), then carries `Game.escape` forward with its loop-only parts reset, and restores generated areas from `areaStore`.
- **No goal objects.** NPC behaviour is a priority chain inside `npc()` in `src/engine.ts`, reading flat `Actor` fields. Social goals become one optional `Actor.socialState` record (`NpcSocial` in `src/escape-types.ts`) and one branch near the top of that chain, implemented in a separate module so `engine.ts` only calls it.
- **No bodies.** Dead survivors stay in `g.survivors` with `alive: false` but are filtered from drawing; dead zombies are deleted by the spawn tick. Bodies need a render path for dead actors and an end to zombie deletion for catastrophe hunters.
- **Doors have one global latch.** Detention needs a new per-door `lock: { side }` that blocks opening from the inside only.
- **Room power is cosmetic and derived from the seed.** A PA "power outage" needs saved, mutable per-room power that both lighting and perception read.
- **The player cannot speak in the world.** The human is excluded from speech in `src/audio.ts`, `npcChatterCandidates`, `conversationSource` and the dialogue validator; all must change together. Voices are a hash of run id and actor id (`npcVoiceFor`), so they change on restart because restart makes a new `Game.id`; they must come from `Game.escape.voices` instead.
- **Terminals are one-use.** A station is bound 1:1 to an encounter and refuses a consumed one. Segments advance only in `completeSegment` (`src/question-thread.ts`), and the world already freezes while waiting for AI (`waitingOnEmbeddedReply` in `src/main.ts`). The task counter hooks `completeSegment`; the persistent session reuses the open thread on the same station rather than closing it.
- **AI operations** are registered in `scripts/lib/ai-contracts.mjs` (`AI_OPERATIONS`, `contracts`) with a `TASK_PROFILES` entry in `scripts/claude-gateway.mjs`.

## 14. Implementation plan

Shared data shapes live in `src/escape-types.ts`, stored on an optional `Game.escape` (saved with the game; absent on old saves, which keep their historical behaviour).

### Wave 1: pure modules (independent, each with unit tests)

| Module                             | Owns                                                                                                                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/catastrophe.ts`               | spec validator with bounded numbers, phase at time t, active behaviours, omen schedule, deterministic per game                                                                                                                 |
| `src/fact-ledger.ts`               | commit, supersede, visibility filtering for an NPC, journal entries, engagement bookkeeping                                                                                                                                    |
| `src/npc-social.ts`                | awareness and alarm, the NPC's model of the player, interaction history, suspicion by role plausibility, outcome validation (authority, at the door), addressee by facing and name, turn-taking choice, lead check-back timing |
| `src/pa-system.ts`                 | announcement schedule (routine cadence, phase-driven escalation), effects, who hears it (indoor speakers), ledger commit                                                                                                       |
| `src/escape-tasks.ts`              | task steps advanced by segment completions, carry-over of unfinished questions, auto-close decision                                                                                                                            |
| `src/voice-identity.ts`            | player gender and voice, PA voice, per-NPC voice fixed at creation, kept on restart, redrawn on New game                                                                                                                       |
| `src/escape-log.ts`                | event log, timeline condensation by area and phase, epilogue request packet                                                                                                                                                    |
| `scripts/lib/escape-contracts.mjs` | AI operations `escape-engage`, `escape-converse`, `escape-pa`, `escape-intent`, `escape-epilogue`, `escape-area` with validators                                                                                               |

### Wave 2: integration

1. **Game state and lifecycle** (`src/model.ts`, `src/persistence.ts`, `src/main.ts`, `src/game-shell.html`): `Game.escape`; **New game** replaces **Generate new level**; gender choice; epilogue on New game; Restart as a time loop.
2. **World runtime** (`src/engine.ts`, new `src/catastrophe-runtime.ts`, `src/doors.ts`, `src/interior-lighting.ts`): behaviours tick, hazard spread, perception rules, collapse, mutable room power, door locks, bodies.
3. **NPC social runtime** (new `src/npc-social-runtime.ts`, a hook in `npc()`): awareness from events, panic, lead, escort, follow, report, detain, unlock.
4. **Speech and PA** (`src/npc-voice.ts`, `src/audio.ts`, new `src/pa-audio.ts`, `src/main.ts` input): Enter chat box, player speech, addressee, NPC turning, open replies with structured outcomes, PA playback through a loudspeaker impulse response.
5. **Tasks at terminals** (`src/question-thread.ts` hook, `src/main.ts` terminal): counter ticks, persistent session, auto-close, task indicator.
6. **Director and areas** (new `src/director.ts`, `src/areas.ts`): engagement to facts and tasks, journal UI, intent prediction, area graph, background generation and portal transitions.

### Verification

Each module ships unit tests; world behaviour ships GameTest scenarios in `tests/fixtures/gametest/`. Full checks: `npm test`, `npm run test:agents`, `npm run build`, `npm run format:check`. Live-model quality (how good the generated lines and areas feel) needs a human playtest; tests use synthetic AI replies.

## 15. Implementation status (2026-11-12)

Built on branch `feat/escape-redesign`. Modules, in the order a game uses them:

| Area                     | Files                                                                                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts                | `src/escape-types.ts`, optional fields in `src/model.ts` (`Game.escape`, `Actor.socialState`, `downAt`, `escortedBy`, `lookAt`, `Zombie.hunter`, `Furniture.lock`)                                                          |
| Game state and lifecycle | `src/escape-state.ts` (create, loop reset, shape guard), `src/main.ts` (New game, gender choice, epilogue panel, Restart as a time loop, journal on J, task indicator, F to try or use, escort input), `src/persistence.ts` |
| Catastrophe              | `src/catastrophe.ts` (validator, phases, omens, offline templates), `src/catastrophe-runtime.ts` (hunters, hazards, perception rules, collapse, omens, bodies), `src/escape-prepare.ts` (AI generation, loop end, epilogue) |
| World                    | `src/engine.ts` hooks, `src/doors.ts` (one-sided locks), `src/interior-lighting.ts` (mutable room power), `src/render.ts` and `src/view3d/visibility.ts` (fallen bodies)                                                    |
| Director                 | `src/director.ts` via `src/escape-runtime.ts` (PA schedule and effects, engagement to facts, tasks and areas, intent prediction, journal), `src/fact-ledger.ts`, `src/pa-system.ts`                                         |
| NPCs                     | `src/npc-social.ts` (pure rules), `src/npc-social-runtime.ts` (awareness, panic, suspicion, lead, follow, report, detain with escort and lock, unlock)                                                                      |
| Speech                   | `src/escape-conversation.ts`, `src/npc-voice.ts`, `src/player-chat.ts` (Enter to talk), `src/pa-audio.ts`, `src/voice-identity.ts`                                                                                          |
| Tasks at terminals       | `src/escape-tasks.ts`, `src/escape-terminal.ts`, the `completeSegment` hook in `src/question-thread.ts`, station rebinding in `src/main.ts`                                                                                 |
| Areas                    | `src/areas.ts` (registration, background planning, portal swap, exit areas that end the loop as escaped)                                                                                                                    |
| AI operations            | `scripts/lib/escape-contracts.mjs`, registered in `scripts/lib/ai-contracts.mjs` and `scripts/claude-gateway.mjs`                                                                                                           |
| Event log and epilogue   | `src/escape-log.ts`                                                                                                                                                                                                         |

Verified by unit tests for every module, a headless 20-minute run of each offline catastrophe template through the real engine, the full unit suite, the GameTest catalog and the production build. Not yet verified: a human playtest, live-model quality of lines, announcements and plans, and the 3-D look of bodies.

What changed after the first version (2026-11-12):

- **Areas get their own building.** A newly discovered place is designed in the background by the same AI run-design pipeline as a new game, with a `place` brief that makes every concept that exact place (`src/area-design.ts`, the optional `place` field in `src/run-quality-contract.mjs`). The accepted design is saved on the area (`AreaStub.design`), so a reload or a Restart rebuilds the same place fresh. The seed-only building is only the fallback when a design fails.
- **The PA uses a recorded PA horn** (`public/audio/pa-ir.wav`, source in `public/audio/PA-IR-SOURCE.md`); the synthesised loudspeaker response remains the fallback.
- **F reads** the note, sign or screen in front of the player (`src/readables.ts`, `escapeRead` in `src/director.ts`); otherwise it tries or uses the object.
- **A companion keeps their voice** when they follow the player into another area (`src/voice-key.ts` is the one rule for NPC voice keys).
- **Areas the player left keep running** at 10 Hz (`src/parked-areas.ts`). This supersedes the "parked areas are frozen" rule in section 12. Catastrophe hunters follow through portals; hazards cross door and walk portals but not airlocks, hatches, lifts or vehicles. The catastrophe originates only in its own area; perception rules apply everywhere.

Remaining limitations:

- **Designing an area takes minutes** (the same pipeline as a new game). Background prediction usually starts it early; otherwise the portal stays shut ("cycling") until it is ready.
- **Old saves** without `Game.escape` keep the historical zombie game.

## 16. Continuous world (rebuild, 2026-11-12)

The user's decision: no portals. Walking into the rocket, the player is in the rocket; once a place is loaded the world is continuous. Loading screens are acceptable only while something is being generated.

### Model: sites stamped into shared world layers

- A **site** is one building (the colony, the rocket, a lighthouse). The start building is the first site; each newly discovered nearby place becomes another site.
- Floors stay what they are today: z-layers that share one x/y coordinate space (`Floor.index` = storey = elevation). A game's floor `k` holds storey `k` of **every** site. All sites therefore share the ground floor's continuous outdoor ground, and every system that already works per floor (physics worlds, navigation graphs, sight, sound, the 3-D floor scenes and the 2-D renderer) covers several buildings with no cross-floor machinery.
- Rasters become per floor: a floor's tile grid is `floorCols(f) x floorRows(f)` (its `tiles` dimensions) instead of the module constants `W x H`. The start site keeps its 44 x 34 grid at world origin (0, 0), so every existing coordinate, save and GameTest fixture stays valid. Adding a site **grows** every floor to the bounding rectangle of all sites (new cells are walls; outdoors on floor 0 the city or terrain plan decides what is walkable, as today).
- **Stamping** (`stampSite`): a site is designed or generated in its own local 44 x 34 coordinates exactly as today, validated there, then translated by its world origin into the shared floors: tiles, furniture, stations, rooms, doors, encounters, people (ids prefixed by the site id). Floor 0's outdoor plan gains a court around the new site and a walkable path to the existing ground, and the site's shell and masonry ring become authored, like the start building's.
- **Open sites** (`setting.form: "open"`) are ground-only. Stamping copies floor 0 and nothing above it: the site record lists floor 0 alone, its stair and entry markers stay on the ground, `Site.extraction` is its ground pad translated into world coordinates, and `extractionPoints(g)` lists it beside the start pickup. Floors 1-4 of an open start site are solid layers (`Floor.open`, `isSolidOpenFloor`) with no roof cover or stairs, and `Game.extraction` is the ground pad on floor 0. Open games save and reload unchanged; absent optional fields are restored on decode. Enclosed stamping still copies every storey it has.
- **Site records** (`Game.sites`, `src/site.ts`) hold each extra site's id, name, origin, the floors it occupies, its world-coordinate footprint, its stair markers per floor and its main gate. The start site's data stays in the existing floor fields (`boundary`, `stairs`, `entry`), so old saves need no migration. Helpers answer the questions the engine used to answer with constants: which sites stand on a floor, which stair marker an actor is in, a site's roof floor.
- **Placement**: a nearby place gets a slot next to the existing sites (east, west or south of the start building, with a gap of open ground). Its position is decided when the director registers the place, so the world map is stable; the building appears there once generated.
- **Far places** (a beacon at the far north of the planet) are separate **regions**: their own stack of world layers, reached by travelling (walking off the edge of the map toward it, or a vehicle), shown as a loading screen while it is generated. Inside a region the world is continuous in the same way. This reuses the area-swap machinery, renamed to regions; there are no portals to press.

### What the player experiences

- The rocket stands on the pad east of the colony. Its door is a real doorway: you walk in. You can see inside through the open hatch, and people walk in and out.
- If you head to a nearby place before its building is ready, a loading screen shows ("Building the launch pad…") the moment you step onto its plot, and closes when it is stamped in. Background prediction usually finishes it first.
- Far places: walking off the map edge toward a known far place, or taking a vehicle there, shows a travel loading screen; you arrive at the matching edge or stop of that region.

### Simulation detail

All sites on the loaded layers simulate. Sites far from the player (more than one site away) tick their people and creatures at reduced rate; regions the player is not in tick at 10 Hz (the current parked-area mechanism).

### Phases

1. Per-floor raster dimensions and site helpers (no behaviour change for one building).
2. Stamping sites into the world, outdoor connection, save validation per site.
3. Rendering several sites: shells, exterior plots, 2-D view.
4. Escape integration: places become sites or regions; portals and the F-to-enter interaction are removed.
5. Distance-based simulation detail and performance measurement.

### Implementation status (2026-11-12)

Built and verified:

- **Phase 1:** collision, routing, sight, sound, physics walls and rendering caches use each floor's own raster (`floorCols`/`floorRows` in `src/site.ts`). Stairs are per site (`stairMarkers`).
- **Phase 2:** `stampSite` in `src/site-stamp.ts` merges a generated building into the shared floors at its plot and turns the outdoors into open walkable ground (`terrainCityPlan`) that carries sight and sound. Saves and validators handle several sites, and NPCs use their own building's stairs.
- **Phase 3:** building shells for every site; no fake neighbouring blocks over real buildings and no ground laid under their floors; lighting, authored props and the 2-D clip for stamped buildings; exterior stairs per site.
- **Phase 4:** near places are site plots east of the existing buildings and far places are regions (`src/areas.ts`). `stampReadySites` stamps each site once its design is ready. A loading screen shows while you stand on a plot whose building is not ready, or travel off the map edge toward a region. Restart re-stamps every place found. There are no portals, and F no longer enters anything.
- **Phase 5:** people and creatures far from the player decide less often (`detailTier` in `src/engine.ts`).
- **Homes:** every NPC has a home building (`Actor.home`). Work and wandering stay there; social goals, fleeing and escorts can take them anywhere. Measured over 120 simulated seconds with two buildings: 19 of 19 residents of each building stayed home (6 of 19 before the fix).

End-to-end check through the real engine: a stamped neighbouring building grows the world to 100 tiles wide. An NPC routes from inside the start building to inside the new one, and walks out of one gate and in through the other in 29 seconds of game time, with line of sight between the gates.

Not yet verified: the look and frame rate in a real browser (the 3-D path is covered only by node tests of its layout helpers), and live-model quality of designed areas.

Known limits:

- Stair access credentials are not site-specific.
- An exit site counts as reached once you enter its plot, even before its building is stamped.
- A traveller arrives 4 tiles inside a region's edge.
- Posters and wall stories of stamped buildings come only from their authored scene.

### Simulation cost (2026-11-12)

Several buildings share one floor raster, so every per-floor cost grows with the number of sites. Measured with `scripts/benchmark-sites.ts` (mean ms per simulated frame, 900 frames, no catastrophe):

| Sites | Before | After |
| ----- | ------ | ----- |
| 1     | 5.5    | 1.5   |
| 3     | 196    | 13    |
| 5     | 920    | 24    |

With the catastrophe struck, three sites run at a median of 8 ms per frame and a 99th percentile of 20 ms after warm-up. The first two frames, which happen during loading, take up to 340 ms. About one 130 ms hitch per minute remains, when a floor's route graph is rebuilt in full. What changed, all without changing what anyone does:

- Actors with the same door access share one navigation view and one route graph. Before, every NPC built its own.
- Route graphs update only near the furniture that moved. Collision tests go through a bucket grid instead of scanning every object.
- One search prices all of an NPC's candidate work stations.
- Route invalidation uses a per-floor geometry hash, not a per-NPC string of every furniture piece. The hash is content-derived, so it survives a save and reload.
- The catastrophe's origin is found once and cached. Free-cell scans are cached per tick.
- Access-door bookkeeping skips people who are too far from a door to touch it.
- Distant actors decide less often, as before (`detailTier`).

`tests/navigation-perf.test.ts` and `tests/hot-path-perf.test.ts` pin the equivalences and a loose frame budget. Set `PERF_BUDGET=1` to apply the tight one.
