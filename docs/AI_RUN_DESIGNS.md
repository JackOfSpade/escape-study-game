# AI-authored runs

Every new game completes the reviewed AI design pipeline before play. The Claude CLI develops one complete blueprint through creative exploration, focused room authoring and editorial review. Preparation prioritizes quality and distinctiveness over startup speed or minimizing chat turns. Loading a saved game keeps its geometry, design and progress; it never requests a replacement design. Existing saves and seed-only GameTest worlds keep their previous behavior.

## Authored choices

The `RunDesign` contract (`src/run-design-contract.mjs` and its TypeScript declaration) includes:

- A title, premise, opening, four floor names and a roof name.
- Title-card typography: `titleCard` sets the font (from a fixed catalog of fifteen Google Fonts families, each with an offline fallback stack), hex color and pixel size of the title and of the backstory. Colors must reach WCAG contrast 3 (title) and 4.5 (story) on black; sizes are bounded to 28–96 px and 14–28 px. The field is optional so older designs stay valid; those use the game's default typography.
- Building footprint shape, width, depth and setbacks.
- Per-floor plan family, study-room order, furniture functions and density, permitted subroom types, field quotas and a seed for smaller spatial details.
- Nineteen named survivors with roles, skill, risk and sociability.
- Per-room power and the damaged exterior guard bay. Historical versions 1 and 2 also have six story cards per floor.
- City road dimensions, district size, height range, palette and damage; building/quarantine signs, eight street/shop labels and skyline characteristics.
- Bounded horde cadence/capacity, NPC thought rate and helicopter timing.

Version 2 introduced an individual scene for each study room:

- A room title, purpose, named owner, surface/metal/accent palette and condition.
- Specific pieces of physical furniture with a requested position within the room, rotation, color, condition, label and owner.
- Individual mugs, books, papers, pens, photos, notes, plants, bottles, phones, boxes, lamps and trophies attached to named furniture. Each has its own position on the surface, rotation, scale, colors, condition, label, owner and text.

Owners must belong to the authored survivor roster. The designer can connect a person's objects, notes and room purpose into a consistent fictional story. It supplies structured data from an approved catalog; no generated scripts, arbitrary asset URLs or executable world code are accepted. Version 1 and 2 saves and already captured requests retain their original contract and behavior.

Completed designs use version 3. The engine constructs a private candidate and identifies every actual eligible writing and illustration surface. Each gets an entry under a stable surface ID, replacing the six shared floor stories and eight shared street-label rows. Accepted designs contain the complete original inventory, individual text, explicit shared fragments and bounded drawings. Fresh request protocol version 3 uses the quality process below; retained request version 2 keeps its original two-phase flow. See [individual environmental writing and artwork](ENVIRONMENT_AUTHORING.md) for the full inventory and fixed-text exceptions.

Explicit furniture is placed before the procedural filler. The engine chooses the nearest valid position to the requested room anchor, preserving terminal access, passage clearance and egress. Furniture uses its ordinary visible geometry and native collision body. Worn pieces start at 85% health and damaged pieces at 45%, so the choice affects their usefulness as barricades. Surface props are decorative and follow their supporting furniture when it moves or rotates; destroying or removing that support hides its decorations. They add no invisible collision volumes.

Surface anchors describe positions within the usable tabletop. A bounded deterministic packing pass keeps rotated, scaled props supported and separated. A design that cannot fit is rejected with an item-specific repair reason; requested objects are never silently discarded. Each floor permits at most 16 authored furniture pieces and 48 small props. These budgets apply before any rendering work.

Looking closely at a prop or room sign shows its readable caption while the normal furniture interaction stays available. NPC dialogue can use nearby, currently visible inscriptions; it does not receive every room's story as hidden knowledge. Those observations are rechecked if the object moves, is destroyed or leaves sight. Individual writing and illustrations share padded texture atlases and instanced planes; the physical authored dressing uses at most five instanced draw calls per floor.

The engine still supplies unspecified furniture, small procedural details, physics and moment-to-moment behavior. Floor count, terminal capacity, curriculum eligibility, learning evidence, credential/key rules, collision dimensions, fall damage and the 180-second opening remain engine constraints. AI text is plain text rendered through escaped DOM or canvas operations.

## Generation and offline behavior

1. A new-run request captures a fresh seed, an independent generation ID and up to five recent fictional design and writing summaries. It contains no learner state, curriculum, conversations, credentials or real save content.
2. The UI stores the exact request before release and sends `design-run` stage by stage through the Claude gateway. All stages of one design share a single Claude conversation, keyed by the generation ID, so later stages see the earlier ones. Each stage runs on Opus at medium effort (the content batches use high), and has a thirty-minute limit.
3. The designer proposes three different creative directions. A separate selection turn compares them, then the chosen premise informs the structure and cast. The client constructs a private candidate and checks real building, floor-plan and furnishing invariants. A structural review can request refinement before the object inventory is frozen.
4. A writing plan establishes each room's everyday life, occupant evidence, illustration direction and deliberate shared branding/clues. Focused batches author at most 24 surfaces from one room or common-area group. They see the full fictional context and already accepted content; validation catches repetition across batches. A final editorial review identifies concrete problems on exact objects, and targeted revisions preserve unrelated entries and all geometry. No incomplete or unreviewed candidate becomes an active game or accepted save.
5. Repairs and revisions retain the generation with new request IDs. Exact transport retries retain the captured packet and ID. Drafts persist the current stage, accepted batches and compact review ledger; reload cannot reset counters or rebind writing to a different inventory.
6. While Claude prepares the session, a loading screen shows the current stage. The thirty-minute limit also checks wall time after a suspended page resumes. A completed first run or replacement is saved in the ready state and opens on a black title card: the design's title, then its premise and opening as the backstory, each in the designer's chosen typography, with **Start game** beneath. The run waits for the player to press it. The clock, survivors and zombies stay frozen until that click, including after a reload; preparation never starts gameplay automatically.
7. A failed or timed-out attempt shows **Retry design** and Cancel. A usage limit or a signed-out CLI is named in the message, and the work so far is kept. There is no procedural bypass: a completed, reviewed design is required to start a run or to replace its level. Restart replays the current `Game.design` and seed with no model call. Only **Generate new level** in the Pause menu requests a new design, and once it completes it starts at once and becomes what later restarts replay. A save with no usable design generates one on restart instead. Cancellation leaves the previous run intact and rejects late results. Existing version 2 drafts retain their original three-attempt repair behavior.

Reviews report specific evidence, a target and a proposed improvement, not a self-assigned quality score. No findings completes a review. The controller tracks repeated issues, actual candidate changes and cycles. Two rounds without effective progress can finish minor-only polishing with the last valid reviewed candidate. Major unresolved problems and hard validation failures pause for explicit Retry instead of being relabeled as quality. An eight-round emergency bound prevents a runaway review loop; it is not the normal stopping rule or a startup-time target. Retry keeps the accepted work and resets only the stalled stage. Runtime object counts, readable text lengths, drawing complexity and transport bounds remain enforced: more preparation time does not improve an overloaded or unreadable scene.

The local first-start backdrop cannot become a playable run without an accepted design. A relay process being present does not mean Claude can answer; the CLI must be installed and signed in.

## Validation, novelty and persistence

The shared validator rejects unknown fields, wrong counts/types, unbounded strings and out-of-range choices. It requires a lit free study hall, nineteen unique names and a valid study-room permutation. Generated geometry must retain one shared shell, accessible portals, the force-field chain, enough free terminals for all survivors, spaced terminals with wide access and credentialed egress, and furnishing that leaves routes open. Designed floors retry smaller details within the requested family; failure requests AI repair rather than silently substituting a different family.

Novelty checks compare effective building/floor/street arrangement and require changes to at least two of atmosphere, cast and tempo, plus a distinct title and premise, against each of the last five accepted designs. Version 2 also compares physical furniture kinds and positions, using room-relative fifths and 30-degree heading bins. A different seed, object-key order, label, tabletop prop or tiny position nudge cannot disguise an identical spatial plan. This prevents recent exact patterns; it is not a guarantee that two runs can never feel similar.

The quality flow also checks ordinary prose and drawings against recent environmental samples, rather than only mentioning them in the prompt. New summaries balance floors, room groups, surface roles and short/long writing; one busy floor or a set of long passages cannot monopolize the history. Deliberately declared shared content and engine facts retain their exceptions. Editorial review additionally assesses subject/composition repetition and narrative coherence that deterministic comparisons cannot establish.

`Game.design` stores the full accepted blueprint, source, request/generation IDs and a deterministic fingerprint. Floors store the descriptors used by rendering and collisions and the resolved scene manifest. Save decoding validates these against the canonical blueprint without rebuilding geometry, rerolling decorations, moving furniture or restoring damage. Pending design packets and recent fictional summaries use separate local-storage keys. An explicit cancellation can discard a corrupt design draft without changing a run save. Study progress continues across restarts through the existing archive/save flow.

## Automated evidence

`tests/fixtures/run-designs/harbor-archive.json` and `glass-orchard.json` are authored synthetic fixtures, not claimed live-model outputs. Unit coverage checks direct choices, actual layout differences, field rules, malformed packets, bounded repairs, novelty, cancellation, exact retry and save continuation. `ai-designed-run.json` runs the real engine offline and checks all nineteen NPCs reach study positions through a checkpoint. Browser tests exercise the full first-start/restart/reload flow with a fake Claude gateway and inspect actual authored scene textures. Tests never need a live model, real saves or private learning data.

The version 2 fixtures `botanical-office.json` and `observatory-records.json` add specific furniture and all twelve small prop kinds. `ai-scene-study-arrival.json` retains the same meaningful crowd/checkpoint checks with an authored scene. Further tests cover actual movement blocked by furniture and released after destruction, exact tabletop support, packed-prop rejection, saved pose/damage preservation, wall/visibility-limited reading, distinct rendered labels, and disposal of old scene textures. The complete app's design/retry/reload browser flows use complete version 3 environmental fixtures through the quality pipeline, including exact mid-batch and review reload and targeted revision. Relay tests exercise all stages with synthetic responses. These checks establish orchestration and persistence, not a measured improvement in a live model's aesthetic judgment.

The relay's operation code is loaded when it starts. Restarting only Vite does not reload an already-running relay.
