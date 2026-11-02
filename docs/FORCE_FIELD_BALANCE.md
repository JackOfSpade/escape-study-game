# Door health and study balance

Force fields are now physical access doors. `o.field` remains the door's access
record, so saves keep working, and "field" below means the same door. A door
swings open for anyone allowed through, stays open, and closes itself when a zombie comes within 6 tiles. Zombies never slip past
an open leaf and keep sensing through closed doors, so health remains a real time
budget. A run design can set a door's look and starting health (400 to 2,400 HP).
Pacing can raise a pristine hall entrance above that, never lower it.

A prepared question is unbound until a room opens it, so its estimate is adopted
only when it is issued. An unused question cannot raise a door's health.

Fresh study runs can size the public entrance force field on each floor to the
expected work on that floor. This changes durability without changing the floor
plan, adding gates, changing questions or awarding learning credit. Older saves
and historical world factories keep their existing health values.

The goal is to give a learner who takes longer than the nominal estimate a
reasonable opening and some room to advance. Setting a gate's break time equal
to an average solve time would leave little room for reading, mistakes or finding
a terminal. The opening therefore receives more slack than later floors. These
are initial tuning heuristics; the factors do not represent measured percentiles
or promise a survival rate.

## Required work and question estimates

One completed solo terminal grants that survivor the floor credential and a key.
The credential permits all forward force fields on that floor. The four room
questions are alternatives, so the balance calculation counts **one solve per
floor**, not four consecutive solves.

A generated `Problem` may include `estimatedSolveSeconds`: the nominal time to
read, reason through and answer that particular question. A supplied estimate
must be a finite number from 30 through 900 seconds. Malformed supplied values
are rejected rather than silently accepted as a trustworthy estimate. A missing
estimate uses a local depth fallback: 180 seconds at depth 1, 300 at depth 2, 450
at depth 3 and 600 at deeper levels. The estimate is gameplay metadata, not an
assessment of the player or a change to the learning contract.

For each floor, the adopted estimate is the maximum of its depth fallback and
known alternative question estimates. Unopened alternatives retain the fallback.
The adopted estimate can increase as questions become known, but cannot fall.
Generating another room therefore cannot multiply the required solve time, and
retries or sharing one room question between stations cannot create extra work
allowances.

## Cumulative deadline

For floors numbered 0 through 3, the initial constants are:

| Floor | Solve-time multiplier | Additional study buffer |
| --- | ---: | ---: |
| 0 | 1.80 | 60 seconds |
| 1 | 1.65 | 45 seconds |
| 2 | 1.50 | 30 seconds |
| 3 | 1.35 | 30 seconds |

There is a 90-second onboarding allowance and a 30-second player traversal
allowance per floor. If `S[k]` is the adopted estimate, the absolute deadline for
floor `f` is:

```text
deadline[f] = 90 + sum(k = 0..f) (factor[k] * S[k] + buffer[k] + 30)
```

This is a target time since the start of the run. It is never reset to “now plus
a full solve allowance” when generation finishes, another terminal is opened or
a save is reloaded. A slower opening can consume the early slack; later floors
add less slack relative to their nominal work. A fast learner can keep the lead
they earned.

## Credit protection already on the route

Zombies must pass the main gate, the public study-hall entrance and the four
forward fields before reaching the next floor. The calculation credits the
actual remaining health of earlier serial barriers, including those on earlier
floors. Destroyed barriers contribute zero. It also credits the unused part of
the study profile's 180-second spawn grace:

```text
remainingGrace = max(0, 180 - worldTime)
upstreamDelay = sum(actualRemainingHP / referenceDPS for each earlier barrier)
neededPublicHold = deadline[f] - worldTime - remainingGrace - upstreamDelay
```

Only barriers that zombies must breach **before entering this floor's study
hall** belong in that floor's upstream credit. Its own forward fields come after
the first study room and cannot protect a learner working there. They contribute
to protection for later floors. Counting them too early would overstate the safe
window.

There is currently no credit for zombie travel, searching, traffic or time spent
crossing stairs. The calculation assumes prompt arrival at each successive
barrier. The 30-second traversal allowance is for the learner, rather than an
assumed zombie delay. This deliberately conservative model does not require a
particular random plan or NPC route.

The public entrance's hold target is bounded from 30 to 1,800 seconds, and force
field health is capped at 100,000 HP. Existing higher health is retained. Only
the public entrance is tuned; the main gate and forward fields retain their
normal durability. The four floors therefore have a fixed, bounded protection
budget rather than an unbounded response to retries or later questions.

## Convert delay to health using actual combat limits

A zombie strikes furniture for 4 HP normally or 7 HP during a surge, with a
1.25-second cooldown. The engine limits simultaneous attackers by the length of
the face they contact. The reference calculation uses the broad upstream face
and surge damage:

```text
frontage = max(width, height)
referenceDPS = frontage * 7 / 1.25
plannedHP = ceil(boundedPublicHold * referenceDPS)
```

A normal 3-cell field therefore uses 16.8 HP/second; the 4-cell main gate uses
22.4 HP/second. Normal damage would yield 9.6 and 12.8 HP/second respectively.
Using surge damage avoids making the planned window depend on a calm horde.
Actual attacks may be much slower when few zombies have reached a field.

This is a model of a serial horde attacking from upstream. It is not a guarantee
when zombies already occupy both sides of a field, the learner leaves cover or
the required route has already been breached.

For example, a nominal 180-second first-floor question gives:

```text
deadline[0] = 90 + (1.8 * 180 + 60 + 30) = 504 seconds
mainGateDelay = 600 / 22.4 = about 26.8 seconds
publicHold = 504 - 180 - 26.8 = about 297.2 seconds
publicHP = ceil(297.2 * 16.8) = about 4,994 HP
```

The 180-second spawn grace and main gate already provide part of that deadline.
The public entrance supplies the remainder. The four fields after the first
study room are not double-counted as protection for this first question.

## Generation, damage and persistence

Only opted-in fresh study runs initialize this policy. Its adopted estimates and
planning metadata are saved with the run, so loading cannot reset its deadlines
or repeat a durability award. Updating estimates is an event-driven calculation,
not an operation performed every simulation tick.

A field's health can increase only while it is pristine. Once it has taken
damage, its durability is frozen; a destroyed field is never restored. Increasing
maximum health while keeping the same damage total would still increase current
health during an attack, so that approach is intentionally excluded.

Consequently a difficult question generated after the public entrance has been
damaged may not receive its full planned window on that floor. Its estimate can
still inform cumulative planning for later intact public entrances. Conservative
fallbacks help with delayed generation, but cannot make that tradeoff disappear.
The health and hold caps can also leave a very long question below its target
deadline. Neither case grants a free solve, pauses combat or changes the
question's requirements.

## Tune from bounded run evidence

Use the existing bounded run logs to compare estimates with actual outcomes.
Useful evidence includes the adopted estimate, target deadline, remaining grace,
upstream delay, resulting HP, whether damage prevented retuning, public-entrance
breach times, floor arrivals, terminal completion times and the human outcome.
Keep compact planning records within the existing log limits; do not add an
unbounded per-tick balance history.

Look at repeated runs before interpreting one defeat as a tuning failure.
Separate time spent finding a terminal, generation or tutor transport, active
study, retreating and spectating where the available evidence allows it. Death
before the first meaningful study attempt suggests insufficient opening slack;
repeated effortless late-floor escapes suggest excess cumulative protection.
Compare slower successful attempts as well as nominal ones, and keep the
question's learning difficulty independent of survival tuning.
