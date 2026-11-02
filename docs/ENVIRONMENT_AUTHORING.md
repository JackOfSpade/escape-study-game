# Individual environmental writing and artwork

New version 3 runs author actual instances through the Claude CLI gateway. The engine builds and validates the proposed world, then supplies its complete eligible surface inventory to the designer. Fresh quality requests establish room stories before writing batches of at most 24 objects, followed by global editorial review and targeted revision. Every surface needs exactly one accepted content entry. IDs identify walls, furniture, props and city faces; they do not depend on a game UUID or the order of unrelated objects.

## What the designer can customize

| Surface                                    | Individual content and binding                                                                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Wall posters, notices and wall whiteboards | Each selected wall tile and face gets its own title, body and drawing.                                                                         |
| Desk papers, notes and framed photos       | Each actual supporting furniture ID and surface role has separate writing and imagery.                                                         |
| Movable whiteboards                        | The writing face has its own entry, including boards explicitly placed by the designer. Ownership labels are separate.                         |
| Room signs                                 | Each room plaque has its own writing and illustration, informed by its purpose and occupants.                                                  |
| Furniture labels                           | Each authored furniture piece has an individual label.                                                                                         |
| Authored small objects                     | Each mug, book, sheet, pen, photo, note, plant, bottle, phone, box, lamp and trophy has an individual eligible face.                           |
| Building and quarantine signs              | Each physical sign is individually authored; factual game instructions remain separate.                                                        |
| Shopfront and street signs                 | Each actual city facade face has its own entry, replacing the old eight-row text pool.                                                         |
| Graffiti                                   | Dedicated engine-selected wall faces receive individual transparent artwork and writing. These are cosmetic surfaces with no collision bodies. |

The complete synthetic harbor fixture contains 287 surfaces; the observatory fixture contains 276. Counts depend on the actual built world. The engine rejects an excessive inventory rather than silently omitting objects from authoring. The inventory and resolved physical dimensions are exposed as data; the AI cannot move a writing surface onto an arbitrary wall or change its collider.

## Coherent writing and controlled repetition

The content request includes the fictional premise, room purposes, roster relationships, ownership and local object context. Guidance asks for varied subjects, tone, length and presentation, mixing ordinary workplace traces with evacuation stories and evidence of previous occupants.

Normalized duplicate checks compare individual prose and visible drawing descriptions independently of titles, including Unicode and punctuation changes. Longer near-copies are compared by shared token sequences and edit similarity. A different object ID or renamed title cannot conceal a copied passage. Up to five recent writing summaries, including readable artwork descriptions and composition summaries, inform new requests. Fresh quality generation checks reused prose and artwork against this history, while its editorial review considers repeated subjects and compositions. New history sampling represents floors, room groups, surface roles and different lengths of writing.

Deliberate repetition uses explicitly declared fragments with named member surfaces and a reason: consistent branding, connected clues, or an approved directional fact. Ordinary text around a fragment still receives duplicate checks. A fragment is not a blanket exemption for copying every object. Directional facts come from engine-owned constants; fictional clues cannot change credentials, keys, rewards or extraction rules.

An intentionally repeated logo or clue can retain an identical description when its surfaces explicitly share a fragment and the drawing data is identical. Different artwork does not inherit that exemption.

A conservative validator rejects direct access, bypass and reward instructions in ordinary prose, shared fictional fragments and artwork descriptions. Approved directional fragments stand alone so surrounding words cannot negate them. This guard does not prove arbitrary natural-language meaning; the fixed gameplay signs remain authoritative. Ordinary narrative references to workplace keys or stairs are allowed.

## Saved drawings, not executable code

Artwork uses normalized rectangles, ellipses, polygons and strokes with bounded points, colors, rotation, width and opacity. The renderer interprets this fixed data format. There are no SVG strings, scripts, arbitrary fonts, shaders, external image URLs or generated executable code. Drawings can produce diagrams, portraits, sketches, posters and graffiti; these are vector-style illustrations, not generated photographic image files.

Words belong to the validated writing fields, not an unchecked text drawing command. Each drawing also has a saved description used by the readable caption. Titles and bodies expand the same shared fragments for rendering and reading, so the two cannot silently disagree.

Per-run budgets cap the inventory at 1,024 surfaces, 2,048 drawing primitives and 8,192 points, with additional per-surface and byte limits. Content responses are limited to 512 KB; inventory data to 220 KB; the combined manifest to 750 KB; a complete accepted design to 900 KB. A captured request may include structure, inventory, recent summaries and a repair candidate within its 1.5 MB limit. Native prompt chunking counts instructions and metadata as well as the exact payload.

Rendering uses padded shared texture atlases, aspect-aware text layout and instanced planes. It wraps complete bounded text instead of truncating passages. Close inspection presents the full text and artwork description in the readable caption. Surface bindings follow moved and rotated furniture; destroyed or removed hosts hide their surfaces. Atlas resources are released when the run changes.

## Persistence and compatibility

The accepted version 3 design stores the original surface inventory and all writing and artwork. Save decoding validates canonical bindings without generating replacement text or re-enumerating moved furniture. Checkpoints and offline replays retain identical object content. Historical version 1 and 2 designs keep their existing shared textures and single-phase request behavior.

Pending drafts retain their exact phase, request ID, chat code, captured history, inventory fingerprint, builder version and attempt budget. Quality draft version 3 additionally retains accepted batches and compact review/convergence state, without copying every prior full request. Reload rebuilds only the private candidate and verifies it against the captured inventory before resuming. A changed builder cannot silently attach old writing to new objects. Retry, cancellation and late-result rejection preserve the active run. New runs require the reviewed version 3 pipeline, with no procedural bypass. Retained request/draft version 2 continues its original two-phase behavior without an automatic upgrade.

## Remaining fixed or shared content

The engine owns stair arrows, destination floor numbers, access requirements, terminal status, interaction prompts, helipad/seat facts, extraction instructions, live phone status and accessibility control labels. Curriculum, questions and assessments are outside environmental authoring. Survivor names still come from the saved AI roster; live dialogue follows its separate observation and study rules.

Procedural material textures, lighting, smoke, fire and the ordinary visual asset catalog remain shared engine resources. New runs customize their eligible illustrations and writing through data. Historical saves retain their original text and art for exact compatibility. Every new run uses reviewed environmental writing and artwork.

## Deterministic verification

`harbor-inscriptions.json` and `observatory-inscriptions.json` are synthetic complete saved designs, not claimed live-model outputs. The `ai-environment-study-arrival` GameTest runs the real engine, checks the authored environment through a checkpoint and verifies all nineteen NPCs reach their study areas. Contract tests cover missing/unknown bindings, duplicates and near-copies, intentional fragments, malformed drawings and composed transport limits. Controller tests cover the two phases, exact retry/reload, repair, cancellation, exhausted budgets and incompatible inventories. Browser coverage renders distinct writing and artwork, checks wrapping and saved atlas equality, and verifies movement, destruction and disposal.
