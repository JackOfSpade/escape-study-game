# Test Lab

The Test Lab is primarily an automated framework for coding agents (Codex, Claude Code and other shell-capable tools). Agents create or modify scenario files, load existing cases, run deterministic suites against the real engine, inspect structured failures and replay them after a code fix. No dev server, browser, AI service or manual setup is required. Repository instructions are in `AGENTS.md` and `CLAUDE.md`.

Each test uses a fresh synthetic memory-only world with actual engine/Planck physics. It never reads or writes real game saves, diagnostic history, learner records or credentials, and makes no study relay or AI requests. The optional visual debugger at **http://127.0.0.1:5173/lab.html** (included in production builds) uses the same scenario format and runner. Diagnostics have no entry in the player menu; agents can still open the lab directly. Browser fixtures can call `window.__deadAir.openAgentMenu()` to access retained inspection and diagnostic controls in their synthetic page. Returning to gameplay hides those controls again.

## Automated agent workflow

```sh
# Discover existing test definitions as machine-readable data.
npm run --silent test:game -- --list --json -
# Select an existing case (substring match on scenario ID).
npm run --silent test:game -- --filter push-door --json -
# Create/edit a JSON fixture directly, then execute it without opening the game.
npm run --silent test:game -- --scenario tests/fixtures/gametest/drag-damage.json --json -
# Run the complete catalog and save replay artifacts, with JSON-only stdout.
npm run --silent test:agents
# Reproduce a case using its generated scenario artifact.
npm run --silent test:game -- --scenario .artifacts/game-tests/drag-damage.scenario.json --json -
```

Agents should author fixtures directly in `tests/fixtures/gametest/<unique-id>.json`, using an existing fixture or `src/gametest/presets.ts` as a starting point. Script actions and outcome assertions, reproduce the failure, fix code, then rerun the case and full suite. Both `test:agents` and normal `npm test` automatically load checked-in fixtures; no registration or UI export is necessary. Multiple `--scenario FILE` arguments run an explicit suite instead of the default catalog. `--filter` also works on that suite. Browser-local setups are not part of the repository catalog.

`--json -` writes one JSON document to stdout; diagnostics are in that document. Use `npm run --silent` to suppress npm's command banner. `--json PATH` writes a JSON file and keeps human-readable console output. `--artifacts DIRECTORY` writes `report.json` and `<id>.scenario.json` / `<id>.result.json` for each executed case, including successful cases. `test:agents` defaults to `.artifacts/game-tests`, ignored by Git. Outputs for selected IDs are overwritten on repeat runs; unrelated files are never deleted. **Read the current report** to identify the cases from the latest invocation; files from previously selected cases can remain.

The version 1 suite report contains:

- `summary`: `total`, `passed`, `failed`, `unverified`, `errors`.
- `results`: per-case status, seed, exact final/failing tick, checks (expected/actual/message), actions, final positions, `source`, complete validated `scenario`, and `replay` path when artifacts are enabled.
- `errors`: `{source, error}` for invalid files, duplicate IDs, world-construction failures or invocation errors. Independent cases continue running after individual input/construction failures. Valid scenarios that fail during construction also receive replay artifacts. Invalid raw input is not copied into replay artifacts.

`--list --json -` returns `{version: 1, scenarios: [{id, name, seed, maxTicks, simulation, source}], errors}`. Exit **0** means every selected case passed (or listing succeeded). Exit **1** means failure, an unverified/no-check case, invalid input/invocation, output error or no matching cases. A constructor failure is an error, not a passing or missing case. Reports are data; inspect results rather than treating the presence of a file as success.

For lower-level control, TypeScript tests can instantiate `new TestRunner(scenario, roadmap)`, call `advance(n)` or `run()`, and inspect `runner.game` / `report()`. `emptyScenario()` in `src/gametest/schema.ts` supplies a blank arena. Use `parseScenario` for validation; extend the typed schema/runner for new supported actions or queries instead of evaluating code from JSON.

The design follows Minecraft GameTest's pattern of a reusable structure, starting entities, scripted actions and time-bounded assertions: [official GameTest introduction and example](https://learn.microsoft.com/en-us/minecraft/creator/documents/gametestbuildyourfirstgametest?view=minecraft-bedrock-stable).

## Optional visual debugging

1. Load a built-in scenario or choose **Blank arena**. Building scenarios use a fixed seed and the normal generated layout/population.
2. Choose a placement tool and click the floor to spawn a player, NPC, zombie, furniture or hinged door. Paint walls/floors one cell at a time. Use the floor selector for other levels.
3. Select an entity to edit its coordinates, health, furniture dimensions/angle, door latch state or stair credential. Editing resets the run so results cannot be mistaken for a test of the previous setup.
4. **Step 1 tick**, **Step 30 ticks**, or **Play / pause** to observe. Focus the canvas for WASD, E and Space; Esc pauses. Keyboard actions are recorded against simulation ticks. **Run test** resets to the setup and replays those actions. **Reset** discards unsaved live recording edits.
5. Add assertions in **Scenario JSON** and apply it. **Run test** advances in small batches until a failure or deadline, leaving the final scene and exact failed tick visible. **Run all built-in tests** runs every built-in independently and retains the first failing scene if any fail.

The full-floor diagnostic view intentionally has no player fog-of-war. NPC decisions still use the game's normal visibility rules. **Game** simulation runs normal NPC behavior, zombies, combat, handling and physics. **Motor test** simulation disables game AI and applies scripted character motors using the same native body contacts/avoidance; use it for controlled queues and opposing traffic. Motor-test results do not establish normal NPC decision quality.

No assertions means **unverified**, never passed. Assertions do not replace human playtesting for feel, readability, sound or learning quality.

## Save, replay and share local fixtures

- **Save setup locally** keeps the newest 12 lab setups within a separate 2 MB library. It never touches the game's save keys. Built-ins remain available after reload.
- **Export setup** saves the initial scene and its authored actions/checks. **Export recording** also includes keyboard actions added during playback. Import either JSON to replay it.
- **Export result** includes the scenario, seed, action outcomes, check expectations/actual values, exact failing tick, and final entity positions.
- **Capture current layout as setup** converts current walls, positions, health and door poses into a fresh arena, clearing actions/checks. This is layout capture, not a full AI-memory or study-state checkpoint. Door frames remain frames rather than being captured as thin leaves.
- Explicit `checkpoint` actions exercise a JSON/physics boundary mid-run. They preserve synthetic game state and reset native caches without using game storage.

## Run after code changes

```sh
npm run test:game
npm run test:game -- --list
npm run test:game -- --filter following-traffic
npm run test:game -- --scenario /absolute/path/to/exported-setup.json
npm run test:game -- --json /tmp/game-test-results.json
```

The CLI exits nonzero for failures, malformed scenarios, unmatched filters and unverified/no-check setups. It uses the same definitions and runner as the visual lab. The normal `npm test` suite also runs all built-ins and checked-in JSON scenarios.

To turn a bug into a lasting regression:

1. Author a fixture directly with a fixed seed or small arena (or use the optional visual debugger). Prefer a small specific setup; keep an actual reported-world seed when geometry matters.
2. Add outcome checks that fail on the buggy behavior and pass after the fix. Assert forward progress and solid contact, for example, rather than only a particular internal variable.
3. Save the scenario as `tests/fixtures/gametest/<unique-id>.json`. Files there are automatically included in `npm run test:game` and `npm test`. They can be imported into the browser lab individually. `drag-damage.json` is the checked-in example.
4. Run the new case before and after the fix, then the full GameTest catalog and appropriate existing core/browser tests. For changes to this tool, run `tests/game-test.test.ts` and `tests/browser/game-test-lab.spec.ts` too.

Built-in examples live in `src/gametest/presets.ts`. The lab's **Run all built-in tests** runs that catalog; checked-in repository JSON fixtures and browser-local setups are additional sources and are not silently treated as built-ins.

## Forward layouts and barricade regressions

For saved AI blueprints, add `design` containing a complete `RunDesign` to a scenario with `template: "building"`, `layout: "randomized"` and `rules: "force-fields"`. Version 3 scenarios additionally require `city: true` and `pacing: "study"`; they use `createPlayableGame` so the exact accepted inventory includes the actual city and current floor plans. The `environmentErrors` query validates all accepted writing, drawings and bindings. `ai-environment-study-arrival.json` checks that integrity before and after a checkpoint while all nineteen NPCs reach study areas. It is strictly validated data, never executable JSON; no bridge or model is contacted. `ai-designed-run.json` embeds the synthetic version 1 harbor blueprint, checks shell validity through a checkpoint and verifies all nineteen NPCs reach the free study area. `ai-scene-study-arrival.json` applies those checks to a version 2 blueprint with individually authored furniture and props. `tests/run-design-world.test.ts` and `tests/authored-scene.test.ts` additionally require actual terminal proximity and thinking progress. `captureLayout` drops the blueprint when capturing an arena raster. The original seed-only catalog remains unchanged. See [AI-authored runs](AI_RUN_DESIGNS.md) for the contract, novelty checks and persistence.

Quality-first generation uses request/draft protocol version 3 while its completed fixture design remains `RunDesignV3`. `run-quality-designer`, `run-quality-contract`, `run-quality-bridge` and `environment-history` tests cover staged concept selection, reviewed structure, room batches, cross-batch/recent duplication, targeted revisions, convergence, exact reload and native chunk delivery. They use the saved synthetic environmental designs and real private world preview/finalization without contacting Claude. Browser tests separately exercise the full application through pending batches and editorial review. These checks prove the generation workflow and saved result, not live-model aesthetic quality.

New live runs use `createPlayableGame` and version 5 office floor plans. Generation first chooses one building footprint, then creates independent interiors inside it. The outline is rectangular, chamfered, stepped or waisted, with widths of 36, 38 or 40 cells and depths of 24, 25 or 26 cells. Corner cuts, wing setbacks and waist positions add variation within each family. The same row mask is copied to every level, including the roof; interior randomization never trims the outside walls. These dimensions leave room for the fixed arrival lane, extraction pad and population while preserving the 44 × 34 physics grid. Inside the shell each floor is a chain of six sectors (reception, the free study hall, three departments in seeded order, the stair lobby) laid out by one of three plan families: `columns` (departments side by side), `serpentine` (the chain winds around a spine wall) or `stack` (interlocking bands, also the fallback). Consecutive sectors share exactly one 3-cell force-field gate, horizontal or vertical; departments carve private offices, meeting rooms, storage and break rooms along their outer walls, each a walled dead end with one 2-cell doorway, and terminals sit in offices, meeting rooms and the open areas. `generation.sectors` records the plan; see `docs/FLOOR_PLAN_DESIGN.md`.

Each ordinary floor keeps the free rear study hall (room 2) first and shuffles rooms 0, 1 and 3 after it. Joint depth allocation gives the rear hall at least five rows and each other room at least four, distributing the remaining depth instead of independently rolling rooms that might not fit. Gate positions are chosen within the usable width on both sides of their wall. Terminal slots, office functions and furniture groups vary by floor. The shell and floor interiors use separate seed-derived streams; furnishing also has its own stream. Generation leaves the simulation/loot RNG unchanged and reproduces exactly for a given seed and generator version.

The four study rooms remain complete cuts across the route, followed by the stair lobby. The first free hall has 24 independent solo terminals for 20 survivors. Validators reject uncovered openings, external bypasses, inaccessible or crowded terminals, insufficient free study capacity, inconsistent boundaries, misaligned stair markers and open tiles outside the shell before a building is exposed. Explicit exceptions cover the carved staircase wells and the ground-level outside arrival lane. Bounded grid floods run at creation, not every frame. Zombies can still overrun occupied rooms.

`tests/building-layout.test.ts` checks 128 seeds / 640 levels, including actual tile containment, shared outlines, varied shape families/sizes/interiors, terminal routes, furniture placement, deterministic replay and save round-trips. `building-footprint-consistency.json` checks the building across normal simulation and a checkpoint. `building-randomized-egress.json` verifies an actual zero-key, credentialed NPC climbs through the randomized layout after a checkpoint.

For version 1 scenario compatibility, `template: "building"` still defaults to legacy geometry. A building with `layout: "forward"` alone retains version 2 geometry; `layout: "forward", rules: "force-fields"` retains historical version 3 geometry. Use `layout: "randomized", rules: "force-fields"` for the current generator. `forward-room-exit.json` retains its historical geometry and furniture assertion. `pursuit-main-breach.json` reproduces the central-hall bypass and verifies actual zombie damage at the rear study entrance, with forward gates untouched. `pursuit-solved-egress.json` verifies a credited, zero-key survivor physically reaches the next floor after the main door breaks while the pursuer remains behind. `pursuit-randomized-egress.json` exercises another historical seed. All three use normal game AI and a checkpoint. `tests/pursuit-layout.test.ts` also exercises real partial study progress under pursuit. Loop candidates adapt to the room’s interior bounds without increasing the search budget.

Loading a saved game does not regenerate its floors or learning state. Restarting through Pause saves recorded learning and partial human work, closes unfinished native questions, and creates the new layout. Unanswered facets remain unassessed; old questions never block stations in the new run. Reloading the same run still resumes its open question. The generator uses its own seeded stream and leaves world RNG behavior unchanged.

`vault-stacked-barricade.json` exercises adjacent furniture, native contacts and a mid-vault JSON/physics checkpoint. Vaults extend past every successive movable prop blocking the landing, stopping at the first safe gap; there is no object-count or arbitrary distance cap. Walls, closed doors, floor boundaries and occupied landings remain solid. Unit cases cover all five movable furniture types at multiple angles. NPC handling regressions cover conflicting restored plans, cooperative same-goal transport, progress toward handling/route goals, bounded retry and real egress blockers. Successful and failed human Space vault attempts are recorded in local run diagnostics.

## Walking pushes and walk-in staircases

`walk-push-chair-free.json`, `walk-push-armchair.json` and `walk-push-heavy-holds.json` walk the player head-on into a chair, an armchair and a fridge with no grip action: the chair slides at nearly walking speed, the armchair slides slowly and the fridge holds. A walking survivor presses through a bounded physics motor (`SURVIVOR_PUSH` in `src/physics.ts`) against the object's floor `resist`; zombies use the same motor with `ZOMBIE_PUSH`, which `zombie-walk-push-plant.json` and `zombie-shoves-chair.json` cover in a corridor the object blocks (zombies route around free-standing furniture). `drag-damage.json` still covers the grip mechanic, which remains for dragging and pivoting heavy pieces.

`stairs-walk-in.json`, `stairs-walk-in-locked.json` and `stairs-walk-out-cancels.json` use the current forward force-field layout, whose staircases are wells carved into the boundary walls (`f.stairs` at (22, 1) and, above floor 0, `f.entry` at (22, 29)). The player walks north from the stair lobby into the well: with a credential the flight starts by itself and ends on the next floor (`survivor-stairs` then `climb` events); without one the well refuses the player and emits a `stairs-locked` event while the floor never changes; walking back out before the flight completes cancels it. Legacy building fixtures keep their open landings at (21.5, 3.5) and (21.5, 26.5), but the same walk-in rule applies to them.

## Furniture weight against zombies

`heavy-furniture-holds-crowd.json` and `desk-blocks-crowd.json` measure how long heavy furniture blocks a doorway: 60 s with no crossing, no shove and actual attack damage. `zombie-shoves-chair.json` checks that one zombie physically shoves a chair through within seconds instead of breaking it. The lab steps at a fixed 30 Hz, so `tests/zombie-furniture-push.test.ts` also replays these fixtures at 60 and 120 Hz; the old per-frame velocity reset pushed harder at higher display rates.

## Terminal conversation integration

`tests/terminal-dialogue-harness.test.ts` uses a forward force-field `TestRunner` world and an isolated real loopback relay, memory-only queue and authenticated synthetic worker. It checks the actual `send`/poll/result path across a follow-up, malformed reply correction, sharing revocation during a claim, worker release, save/reload, byte-identical retry and exactly one personal key/stair reward. It also verifies that development completion leaves the learner ledger unchanged. No live connector, model, real save or credentials are used. Test worlds rebind every encounter’s `runId` to the scenario’s synthetic run ID; otherwise private session validation rejects these requests before they reach the relay.

## Performance investigations

`lag-seed-opening.json` reproduces thirty seconds of normal NPC/zombie activity using the reported lag seed and a stationary indoor player. Its outcome checks remain deterministic; a passing result alone does not establish smooth frame pacing. For timing comparisons, use fresh synthetic worlds, warm up each build, alternate old/new runs, and compare world-state equality as well as measured costs. Measure drawing on animation frames; a tight drawing loop can force GPU synchronization and misrepresent interactive frame costs.

The game records bounded local `performance` entries about every two seconds of active wall time. These contain FPS, slow-frame count, maximum frame interval, average/maximum engine/render/total work and entity counts. Pause and restart reset timing windows. Entries share the existing newest-three-run / 400-entry / 256 KB-per-run limits and are saved with normal diagnostic checkpoints; no real learner data is added to test fixtures.

## Scenario format

A version 1 scenario has a unique ID/name, seed, `template` (`arena` or `building`), `simulation` (`game` or `physics`), `maxTicks`, `startTime`, `naturalSpawns`, and lists named `entities`, `deleted`, `maps`, `actions` and `checks`. Every simulation tick is 1/30 second. Scenes run for at most 3,600 ticks. Timeline ticks start at 1; actions execute in array order before that tick's simulation step; assertions read the resulting world.

Entities use world-unit positions and floor numbers starting at zero. The player has ID `human`; other IDs are unique. Furniture `maxHp` can preserve its original strength independently of damaged `hp`. Entity `angle` is in degrees; a door swings between −70 and +70 degrees. Its width/height describe the frame. `released` unlocks the latch without animating it. Non-door furniture can rotate. Duplicate runtime spawns fail. Character and furniture counts are bounded. Empty arenas have fixed perimeter walls; enabling natural spawns opens the outside staging lane unless an explicit map overrides it. Natural spawning still follows the game's ten-second initial delay.

Maps contain `{ "floor": 0, "rows": [...] }`: exactly 34 strings of 44 cells, with `#` for walls and `.` for floor. Entity overrides replace matching generated IDs; `deleted` removes generated entities, but cannot remove the player.

Actions:

- `decoy`: `floor`, `x`, `y`; places the native 20-second, 10-tile audible decoy in game simulation. Acoustics, walls and furniture still bound hearing. Use an explicit sensory cue when a scenario needs directed zombie pressure.
- `move`: `id`, `x`, `y` (−1 to +1); persists until another move action. Game mode controls only `human`; motor mode can control any character. A zero vector stops its motor. Movement updates facing before a same-tick vault.
- `door`, `grip`, `vault`: survivor `id` and `target` entity ID. They use the actual game's reach/interaction checks. A failed interaction fails the test. `vault` accepts target `auto` for the game's faced-surface selection.
- `spawn`: an `entity` specification, allowing timed arrivals.
- `checkpoint`: serialize/restore the synthetic world at a tick boundary.

Checks have `name`, `mode`, `query`, `op` and `expected`. Operators are `eq`, `gte` and `lte`. Modes are `at` (requires `tick`), `always` (every tick through the deadline) and `eventually` (must become true before timeout). Optional `fromTick` delays a check. A completed eventual check stays complete; always checks continue throughout the window. Tests remain running until their deadline so future assertions and invariants are not skipped.

Queries:

| Type                   | Parameters                              | Result                                                                                                                                               |
| ---------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `property`             | `id`, `field`                           | `x`, `y`, `hp`, `maxHp` (furniture), `floor`, `elevation` (feet metres), `falling`, `alive`, `latched`, or `absAngle` (radians)                      |
| `count`                | `kind`: `npc` or `zombie`               | Living, active population                                                                                                                            |
| `region`               | `kind`, `floor`, `x1`, `y1`, `x2`, `y2` | Living population inside the rectangle                                                                                                               |
| `separation`           | At least two distinct entity `ids`      | Smallest same-floor center-to-center distance                                                                                                        |
| `event`                | `event` type                            | Number of matching game events                                                                                                                       |
| `soundConnected`       | `floor`, points `a` and `b`             | Whether an open acoustic path exists                                                                                                                 |
| `buildingLayoutErrors` | None                                    | Number of randomized-building validation errors: a shared footprint, contained structure and aligned stairs. Missing footprint metadata is an error. |

Use `template: "building", layout: "randomized", rules: "force-fields"` for the current randomized building generator. `layout: "forward"` keeps its historical geometry for existing regressions. The `building-footprint-consistency.json` scenario checks every floor throughout a normal simulation and across a JSON/physics checkpoint.

Fixtures are validated data, not executable scripts. Extend the typed schema and runner for new supported actions or queries, with a failing-case regression, rather than evaluating imported code. Custom TypeScript tests can also instantiate `TestRunner` directly and inspect the resulting synthetic world.

## Force field scenarios

Set optional scenario `rules: "force-fields"` to use the new swarm rules; building templates also receive the fresh-run redesign. Legacy scenarios are unchanged. Door and gate spawns accept `forceField: "green" | "red" | "exit"` and optional `freeLimit` (1–100). Quota fields accept `freeDirection: -1 | 1` for the inward direction along their crossing axis (default +1). Survivor spawns accept `keys` (0–100). Exit fields also allow a survivor with `credential: true`. The `door` action spends a key through the real interaction checks. Layout capture preserves field kinds, initial directional quotas, keys and stair credentials; admission history resets for the fresh setup. Checkpoints preserve personal authorization and quota state. Physics scenarios update the same entrance-crossing bookkeeping and use the new zombie motor speed when these rules are selected.

`force-field-green.json`, `force-field-personal.json` and `force-field-entrance-quota.json` verify actual native contacts and save/checkpoint behavior. `tests/force-fields.test.ts` additionally covers normal zombie AI breaking both colors, personal rewards, navigation, exit independence and continuous replacement at the 600-zombie cap. `npx tsx scripts/benchmark-swarm.ts --dense` measures a synthetic crowd on one floor without accessing real saves or any provider.

`force-field-first-touch.json` closes the entrance at the first physical touch, before traversal completes. `force-field-midway-rejection.json` starts two survivors inside the field and verifies immediate ejection of the later entrant, retention of the first NPC's passage and checkpoint persistence. Native physics resolves field admission after every substep; script/actor array order does not grant priority. Additional TypeScript cases supply exact previous positions to verify swept touch ordering and migration of legacy uncharged grace passes.

`force-field-no-key.json` verifies that zero-key survivors remain physically blocked by red fields across a checkpoint. Key-only interaction, NPC routing and free study routes across 32 seeds / 128 floors are covered in `tests/force-fields.test.ts`.

## NPC study loops

`tests/study-workspace.test.ts` uses a synthetic `TestRunner` world to assert that study-only mode freezes real engine time, actors and RNG even if the ordinary pause flag is changed, then verifies normal simulation resumes on exit. The typed setup is necessary because JSON scenarios do not configure the study workspace. It also checks formal scheduling, unchanged physical stations/pacing, no survival rewards and persistence. `tests/browser/study-workspace.spec.ts` covers the neutral desktop/mobile view, terminal binding and save-failure recovery, all with a fake Claude gateway and synthetic storage.

`tests/npc-work-rhythm.test.ts` uses the same synthetic `TestRunner` study fixture to verify changing thinking pace during uninterrupted terminal work, testing expertise during boundary review, actual milestone progress and identical continuation after a checkpoint. The quiet fixture removes pursuit to isolate cognition. Work pacing derives from actor, encounter, milestone and saved thinking progress: slower orientation/checking surrounds a productive burst, individual steps vary in effort, relevant technical strengths affect speed, and familiarity gives a small within-task benefit. It consumes no extra world RNG, adds no model requests and grants no learner mastery. Mistakes retain their existing rework penalty. This typed setup is needed because JSON scenarios cannot configure a retained question or actor thinking progress.

`tests/npc-study-loop.test.ts` uses `TestRunner` synthetic game worlds with real generated practice questions and native pursuit/physics. The typed helper sets a remembered, partially worked solo task and an elapsed work stall, which the JSON entity schema does not represent. Cases assert actual zombie displacement followed by physical terminal work and academic progress, a nearly finished task completing on return, checkpoint continuation, inaccessible red fields, unseen-enemy invariance, planner cadence and fallback. An overwhelmed case explicitly expects death without a free solve. Ordinary retreat/return is also tested without activating desperation planning. All cases run in `npm test` without AI calls or saved learner data. Survival alone is not the success criterion.

`npx tsx scripts/benchmark-study-loop.ts` measures just the bounded planner using static synthetic actor poses; this intentionally exercises repeated route decisions but excludes rendering and physics. Run `npx tsx scripts/benchmark-swarm.ts --dense` for a 600-zombie headless engine measurement. Timing is diagnostic, not a frame-rate assertion.

`force-field-explore-alternate.json` reproduces the reported crowded locked-door stall with five zero-key NPCs, an exhausted red entrance and a visible green alternative. It failed before the fix (zero explorers reached the alternative) and verifies all five physically cross the green entrance, with a checkpoint during the run. `tests/force-fields.test.ts` additionally covers restored door pursuits, a quota closing during a cached approach, inaccessible terminal reservations and keyed endpoint interactions. Exploration must check personal field access; pathfinding must not turn an unusable field-center destination into a legacy door interaction. Crowd jitter does not reset the force-field exploration stall timer without actual progress toward the goal.

`tests/browser/force-field-health.spec.ts` checks full, half, critical and broken visual states for both colors, then verifies the bar against health lost to actual zombie attacks. Access stays green/red; health uses fading fill, cumulative fracture marks, a proportional bar and a numeric label. Bars and labels for visible sources draw above fog, while hidden sources remain undisclosed.

## Friendly traffic and terminal arrivals

`crowded-study-arrival.json` uses the reported seed 78191111 with normal AI, all 19 NPCs and a checkpoint. Before the navigation change only 15 NPCs reached the rear study hall within ten seconds. The fixture requires all 19, with no deaths. `tests/npc-traffic.test.ts` additionally verifies each bot physically reaches its own solo terminal within fifteen seconds; before the fix only 16 did so. These worlds are freshly generated synthetic runs, not copied player saves.

Friendly local steering forecasts closest approach over 0.65 seconds, tests at most 22 candidate velocities against eight nearby bodies, checks swept wall/force-field clearance, and prefers a consistent passing side and previous motion. Moving queues retain their lane and single-file conflicts retain physical backtracking to a passing bay. Existing danger steering still handles nearby zombies. Native contacts remain authoritative; there is no overlap exemption or teleport. Route following skips up to eight visible, ordinary path nodes to avoid a shared grid-centre bottleneck while retaining door/vault actions. Visible solo terminal reservations are excluded from new task selection rather than merely penalized.

`stationary-traffic-island.json` verifies a moving bot goes around a group of stationary bodies within four seconds, with solid separation across a checkpoint. `tests/browser/npc-traffic.spec.ts` runs both fixtures in the browser Test Lab. `npx tsx scripts/benchmark-traffic.ts` measures 20 local steering decisions per static congested sample and writes `.artifacts/traffic-performance.json`; it excludes the rest of the engine, physics and rendering and is not an FPS guarantee.

## Close-contact survivor traffic

`contact-traffic-release.json` starts opposing NPCs at actual body contact and checks that both pass within three seconds, keep physical separation and continue across a checkpoint. It reproduced a velocity-planner deadlock: the initial gap was penalized for every candidate, including sideways and separating motion, making stopping the cheapest permanent choice. The planner now treats a separating/tangent contact as escapable, samples a bounded set of reverse directions and remembers its passing side for 0.8 seconds to reduce left/right reversals. Native collision, walls and personal force-field permissions still apply. This is local steering over at most eight nearby survivors, with no extra global route searches.

`tests/npc-traffic.test.ts` also tests eight contact orientations in both controller orders, the reported 78191111 opening with all nineteen bots physically working, and three restored waiting bots replacing a solo destination another actor owns. Station waiting and collision stalls are separate failures; saved stale paths alone do not prove a bot is attempting movement. The browser traffic suite replays the crowd, stationary-cluster and touching-opponents cases.

## Doorway flow

`doorway-crowd-flow.json` uses the reported 3705527980 seed, normal game AI, the idle human at the normal spawn, continuous zombie spawning and a checkpoint. Before the doorway-flow change, only 7 of 19 NPCs entered the free hall by ten seconds; it asserts all 19 cross, survive the scenario and face actual swarm pressure. The older open-corridor motor cases alone did not cover this occupied arrival point.

`src/door-traffic.ts` treats wide force-field openings as traversable areas: survivors choose nearby clear gaps, retain a short local preference, ease off behind bodies and use consistent sides for opposing flow. Sideways adjustments remain available while forward progress is blocked. Stable small personal offsets avoid identical tracks; world RNG is unchanged. Physical collision, permission checks and zombie damage remain authoritative, including a quota closing during approach. Narrow one-person passages keep the native yielding behavior. The approach is limited to five units around an actual routed doorway and clears after crossing; bots keep their individual destinations. An already-occupied spawn-hall arrival point no longer has to be touched before entering the hall. Actual crossings satisfy local doorway exploration goals, so bots do not turn back toward an occupied center point. Replacing a claimed terminal also clears stale waypoints immediately.

`tests/npc-traffic.test.ts` covers the idle-player opening across eight seeds and actual terminal work. `tests/door-traffic.test.ts` drives both opposing streams through horizontal and vertical openings using real pathfinding/physics, checks body separation, and rejects a closed personal field without granting access or spending keys. Those motor tests isolate coordination and do not substitute for the normal-AI scenario. The browser traffic suite replays the same scenario and captures `.artifacts/doorway-flow.png`.

## Browser specs and the two world kinds

Fresh runs in the browser use version 5 randomized buildings (office floor plans) with one shared footprint, movable office furniture, force-field doors and gates, solo stations with the single Terminal AI conversation (no separate editor), personal keys, and swarm spawning in batches. Browser specs that exercise those rules enter the building directly. Specs that exercise legacy building mechanics (chairs and vaults, shared rooms with the one-workspace editor, twenty first-floor opportunities, legacy spawn counts) call `enterLegacyBuilding(page)` from `tests/browser/helpers/legacy-world.ts`, which enters the building and swaps the live run for a legacy-layout world with the same roadmap and study state and no rules flag. Starting a live study run creates a fresh force-field world again, so such specs call `useLegacyWorld(page)` after that click. Scenario-based specs that assign a `TestRunner` game into the page must also copy the scenario's `rules`, because a fresh run's force-field rules otherwise survive the swap and disable vaulting.

The rooftop extraction spec (`late-extraction.spec.ts`) drives the survivor with real keyboard input in real time; its outcome depends on per-frame render cost. The play frame is capped at the historical size (`.world` max-width 1034px, viewport height `100vh - 250px`) partly for that reason. Keep other browser pages and heavy processes idle while running it.

### Study pacing and live spectator scenarios

A game scenario may set `pacing: "study"` to use the fresh playable timing profile; omitted pacing preserves historical fixture timing. Game simulation supports `{ "type": "pause", "paused": true }` (and false to resume) as a tick action. Assertions can query `worldTime`, `humanEnded`, or `sinceEnd` with metric `time`, `npcTravel`, or `zombieTravel`. These compare real engine progress after the human outcome; they do not replace combat or evaluate JSON code. See `spectator-live-world.json` for actual zombie combat death, continued world travel and pause/resume, and `study-opening-window.json` for the three-minute opening and gradual spawn cadence.

## Individual zombie search

Zombies do not receive a building map or an automatic stair/roof destination. Each plans inside a six-tile visible neighborhood, keeps at most 96 recent personal search cells, and chooses its own search directions from a seed derived from the run and its ID. Visible survivors update that zombie's last seen position for nine seconds. Audible footsteps give a coarse two-tile location for five seconds; decoys use normal acoustic reach. Neither clues nor search history are shared. Reaching or losing a trail resumes exploration. Physical stair discovery still starts the normal saved flight.

`zombie-search-no-stair-knowledge.json` exercises local exploration across a checkpoint with no same-floor sensory cue. `tests/zombie-search.test.ts` checks hidden survivors and geometry, independent witnesses, approximate hearing, stale visual trails, bounded memory and save continuity. Furniture pressure scenarios must provide an actual visible target or audible lure; silent people behind opaque barricades are not an instruction to attack.

## Physical city scenarios

Set `city: true` with `template: "building"`, `layout: "randomized"` and `rules: "force-fields"` to include the fresh physical neighbourhood. Ground-level entity, region and acoustic coordinates then accept bounded exterior positions from −2048 to 2048; the authored office raster remains 44 × 34. Scenario durations are bounded to 10,800 ticks so a real three-minute approach can be verified. Imported scenarios remain validated data, never code.

With `naturalSpawns: true`, a time-zero city starts with actual distant fronts and later distant reinforcements. `naturalSpawns: false` omits the generated invasion for isolated movement tests. `city-open-street.json` crosses the retired map edge through native physics and a checkpoint; `city-solid-urban-block.json` presses against a real facade; `city-visible-fronts.json` verifies existing, moving distant zombies without doorstep materialization. `city-stair-base.json` walks a licensed survivor from the actual street-side stair base onto the continuous flight and gallery, through a checkpoint and into the next floor. `tests/city-invasion.test.ts` runs the full broad formation until its actual first entrance attack, including a mid-approach physics/JSON checkpoint, and compares that contact time with the configured grace period.

Historical scenarios without `city` keep their former grid and spawn timing. The existing office generation/navigation catalog still checks the building footprint, randomized egress, vertical gates and historical forward geometry. Renderer-only atmosphere and long-distance sightlines are covered separately in the offline browser fixtures, without real saves or bridge traffic.

## Physical first-person stairs, jumping and falls

A game-simulation human `move` action can include `"stairWalk": true` to enter the exterior stair/gallery motor. The body can move freely across the deck and collides with the same slabs, glass guards and columns that are drawn. `stairTravel.walked` retains projected route progress for old saves; the saved `elevated` body owns position, feet height and vertical velocity. NPCs and zombies keep their safe timed stair flights. On plain physical city ground the human returns to native floor-0 movement. Historical worlds without a city retain the elevated body on exterior ground until reaching an actual floor plate, so the old tile-grid border cannot become an invisible wall.

Use `{ "tick": 1, "type": "walkTo", "id": "human", "x": 45, "y": 7.2, "stairWalk": true }` to steer toward a world point until a subsequent `walkTo` or `move` action replaces it. It stops within one movement tick of the target; it does not pathfind or teleport. Building targets allow bounded exterior coordinates. `{ "tick": 1, "type": "jump", "id": "human" }` presses Space once through the real engine input: force-field play jumps, and legacy play first tries a barricade vault. Both actions require game simulation and the human. The lab keyboard records Space as `jump`; explicit `vault` actions still test targeted legacy vaults.

Property checks can read `elevation` (absolute feet height, in metres) and `falling` (airborne with downward velocity). `stairs-continuous-idle.json` checks an idle flight across a checkpoint; `stairs-continuous-gallery.json` walks every turn and reaches the next floor after a checkpoint. `stairs-safe-descent.json` follows the reverse route without damage. `stairs-damaging-fall.json` and `stairs-three-storey-fall.json` walk through actual seeded storm-damaged guard bays and survive 3.6 m and 10.8 m falls with 83 and 25 HP respectively. `stairs-lethal-fall.json` jumps onto the roof parapet and walks off for a fatal 15.4 m fall. These fall scenarios assert airborne state, landing damage/events and survival or death, and preserve the airborne body through a checkpoint. See [fall damage calibration](FALL_DAMAGE.md) for the research and gameplay choices. `jump-standing.json` checks a one-shot jump and safe landing. `stairs-npc-zombie-safety.json` retains the independent, safe AI flights.

`tests/stair-route.test.ts` verifies lateral deck movement, exact saved body pose, bounded horizontal movement, downward/reverse travel, personal permission and visible furniture blocking an arrival. `tests/city-stair-base.test.ts` checks the physical ground join and foundation. Older saves with `walked` but no elevated body migrate from the sampled route pose. Omitted `stairWalk` retains historical stair behavior for existing scenarios and NPC simulation.
