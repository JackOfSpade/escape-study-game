# Office floor plans (generation version 5)

Fresh AI-authored runs now select the shell parameters, plan family, room order, furnishing functions/density and field quotas through a saved validated blueprint. The engine still realizes version 5 geometry and enforces the invariants below. Seed-only runs retain the original algorithm described here. See [AI-authored runs](AI_RUN_DESIGNS.md).

Fresh force-field floors (generation 4) carve four full-width transverse
bands between the rear entry and the front stairs. Every study room is a
strip about 4 to 6 cells deep and 36 to 40 cells wide, so every room reads
as a hallway. Version 5 keeps every gameplay rule of the field chain and
replaces the geometry with office-like plans: departments ("sectors") of
varied shape, each with corridors and rooms (private offices, meeting rooms,
storage, break areas) off them, and open-plan halls where terminals are desks.

Cells are about one metre. The building shell (`BuildingFootprint`) and its
seeded stream are unchanged. One cell is one wall thickness.

## Gameplay invariants (unchanged from version 4)

1. A floor is a chain of six sectors from the rear entry to the front stairs:
   `entry` (reception) -> `room2` (free study hall) -> three of
   `room0`/`room1`/`room3` in seeded random order -> `lobby` (stair lobby).
2. Consecutive sectors are joined by exactly one 3-cell opening (a gate)
   covered by exactly one force field. The public gate `f{i}-room2-door` is
   the entry-to-room2 gate (`publicEntry`, no limit). Each study sector's
   forward gate `f{i}-room{n}-forward` has `exit: true`,
   an authored quota from 2 to 6 (or the seed-only formula
   `limit: 3 + ((seed + floor + n) % 3)`) and a `direction` such that the free
   first-touch pass is claimed when arriving from the previous sector.
   Non-consecutive sectors share no opening. A red field can never be walked
   around: every study sector is a cut of the entry-to-stairs graph.
3. `f.doors[n]` is the point of the gate through which `room{n}` is entered;
   `f.rooms[n].forwardEntry`/`forwardExit` are that gate and the sector's
   forward gate. The main gate, outside lane, carved stair wells, `f.entry`
   and `f.stairs` are unchanged (`carveStairwells`, floor 0 entry at
   (21.5, 26.5), upper entries at (22, bottom + 1), stairs at (22, top - 1)).
4. Terminal counts per sector are the existing station lists (room2 is topped
   up to `survivors.length + 4`). Every terminal sits at a cell centre whose
   cell is open, at least 1.4 cells from any other terminal (aim for 2.0), is
   reachable from its sector's entry gate without crossing another gate, and
   has credentialed egress to the stairs with all entrance quotas exhausted.
   At least `survivors.length` terminals are reachable from the entry through
   the public gate alone.
5. Generation reads only `layoutRandom(seed, 0x726f6f6d, floor)` (using the
   saved floor `layoutSeed` for authored runs); the world
   stream (`g.rng`) never moves; the same seed always builds the same floor;
   saves restore floors exactly (geometry is persisted, never regenerated).
6. Historical geometry is untouched: `pursuitLayout` without `f.boundary`
   (version 3, `layout: "forward"`) must stay byte-identical, and version 4
   saves still load and play (their `stages` stay readable).

## Vocabulary and data model

- **Sector**: one chain node. Its _territory_ is the set of interior cells
  inside its outer walls: corridors, open halls, sub-room interiors and the
  sub-room partition walls. Sector outer walls (and the shell) belong to no
  sector. Gate cells are carved outer-wall cells; they belong to no sector.
- **Gate**: the single 3-cell opening between consecutive sectors, horizontal
  (field 3 x 1) on a horizontal wall run or vertical (field 1 x 3) on a
  vertical wall run. Vertical gates are expected and must work end to end.
- **Sub-room**: a rectangular room carved inside a sector, walled on all four
  sides, with exactly one 2-cell doorway (no door object) onto the sector's
  circulation. Sub-rooms are dead ends; corridors carry through-traffic.
- **Circulation**: sector territory outside sub-rooms and their walls.
  Corridors are the circulation rectangles the planner carved deliberately.

```ts
/** Inclusive interior cell ranges. */
interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
interface SubRoom {
  /** Zone id for furnishing and furniture ids, e.g. "room3r1". */
  id: string;
  kind: "office" | "meeting" | "storage" | "break";
  rect: Rect; // interior cells
  doorway: Rect; // the two open cells in this room's wall ring
}
interface Sector {
  id: "entry" | "lobby" | "room0" | "room1" | "room2" | "room3";
  room?: 0 | 1 | 2 | 3; // study sectors only
  order: number; // 0 = entry ... 5 = lobby
  blocks: Rect[]; // union = territory; one to three rects
  corridors: Rect[]; // deliberate corridor cells (subset of circulation)
  rooms: SubRoom[];
  gate?: Point; // centre of the opening to the next sector
}
// Floor.generation for fresh floors:
// { version: 5, upperDivider, lowerDivider, sectors: Sector[] }
// upperDivider/lowerDivider stay numbers (the lobby's south wall row and the
// entry's north wall row); nothing in version 5 reads them.
```

`src/floor-plan.ts` exposes the lookups every consumer uses so that version
3/4 `stages` and version 5 `sectors` are handled in one place:
`floorSectors(f)` (synthesises sectors from stages for 3/4, one block per
band spanning the usable width), `sectorAt(f, p)` and
`sectorBounds(f, p)` (the containing block rect).

## Plan families

The field is the interior minus the two lobbies and their walls. Each floor
picks one family and its parameters from the seeded stream, builds the plan,
validates it, and on failure draws again (bounded, at most 24 attempts) before
falling back to the `stack` family with its default parameters, which must
always validate. Generation never throws for a valid shell.

Lobbies: `entry` is a rectangle at the south centre, 3 to 5 rows deep, 12 to
18 columns wide (even), or the full south band; it always contains columns
16..27 of its rows so the arrival lane and the main-gate mouth stay open.
`lobby` is at the north centre, 3 to 5 rows deep, 10 columns to full width,
always containing columns 21..22 (the stair mouth and `stairwellApproach`).

- **stack** (bands with offset): four bands south to north (`room2` first,
  4 to 8 rows deep, the others 3 to 7; the shell leaves only 13 to 18 rows
  for all four, so this family stays hallway-like and mainly serves as the
  fallback). A boundary may step by 1 to 3 rows at one x breakpoint, so
  bands interlock and sectors become L or Z shapes; a band is a union of up
  to three rects. When the entry lobby is narrower than the shell, `room2`
  wraps around it (U shape).
- **columns**: `room2` is the south band (6 to 9 rows). Above it two vertical
  walls split the field into three columns at least 8 cells wide; the chain
  runs left -> centre -> right (or mirrored) and the stair lobby spans the
  full width so the last column reaches it. Gates between columns are
  vertical.
- **serpentine**: `room2` is the south band. A spine wall at x in [18, 26]
  splits the rest into west and east halves; one half is split horizontally
  into a south part and a north part. Chain: `room2` -> that half's south
  part -> the other half (full height) -> the north part -> `lobby` (the
  lobby must touch the north part). Mirrored variant too.

Within each family, randomise split positions, depths, lobby sizes, the
wrap choice, gate positions along their wall runs (at least one cell from
every corner), sub-room carving and terminal arrangement.

## Sub-rooms and corridors (per sector)

Primary pattern: **rooms along the outer walls, open core**. Choose one or two
outer wall runs of the sector (long runs first), carve a strip 3 to 5 cells
deep along the run, and slice it into rooms 3 to 7 cells wide with 1-cell
partitions, each with a 2-cell doorway on its inner face. Skip strip
segments within 2 cells of a gate (gates open onto circulation with 2 clear
cells in front on both sides). Strips on opposite walls that leave a 2 to 3
cell gap produce a double-loaded corridor; record such gaps in `corridors`.
Any leftover sliver thinner than 3 cells stays open. Circulation must stay at
least 2 cells wide everywhere on the route from the sector's entry gate to
its exit gate, to every doorway and to every terminal.

Room sizes (cells):

| kind    | interior   | furnishing types |
| ------- | ---------- | ---------------- |
| office  | 3x3 to 4x5 | manager          |
| meeting | 4x5 to 6x8 | meeting          |
| storage | 3x3 to 3x4 | storage          |
| break   | 5x5 to 7x8 | break            |

`room2` stays an open-plan hall: at most two small sub-rooms, and at least
24 terminal slots on a grid with 2.5 to 3 cell spacing must remain. Thin
sectors that cannot hold a 3-deep strip plus 2 cells of circulation stay
open-plan. Across a run, every kind must occur.

Terminals: offices take one terminal, meeting rooms one or two, then the
open area on a 2.5 to 3 cell grid; keep gate approaches, doorways and
corridors free.

## Furnishing zones (office-layout)

`pursuitOfficeZones` derives zones from sectors. Circulation zones: one
`OfficeZone` per block, ids `room3`, `room3b`, `room3c` (letters for the
second and third block). Sub-room zones: the sub-room id `room3r1`,
`room3r2`, ... with `types` from the table (`office` -> `manager`).
Circulation of `room2` is always `cubicles`; circulation of other study
sectors allows `cubicles`, `break` or `reception`; `entry` is `reception`;
`lobby` is `break` or `reception`. Furniture ids keep the form
`f{floor}-{zone}-{type}{n}-{kind}{i}`; `terminalBays` must look up the
sector's entrance gate rather than `f{i}-{zone}-door`. `fieldClearance` must
clear both orientations of a field plus two cells in front of it on both
sides.

## Rendering, AI and validation consumers

- `office-art.floorZone`: version 5 cells in `entry`/`lobby` circulation and
  in `corridors` are `lino`; sub-rooms and other circulation are `carpet` /
  `carpetAlt`, alternating by sector order (sub-rooms alternate within a
  sector). Version 3/4 behaviour is unchanged.
- `engine.roomAt`: version 5 uses `sectorAt(f, p)?.room ?? -1`.
- `npc-study-loop` loop candidates clamp to `sectorBounds` of the station.
- `pursuitLayoutErrors` validates version 5 floors: every open interior cell
  is in exactly one sector or is a gate cell covered by exactly one field;
  one field per consecutive pair and none elsewhere; blocking any study
  sector's territory severs entry from stairs; wide-cell connectivity (a cell
  is wide when some fully open 2x2 square contains it) from each sector's
  entry gate to its exit gate, every doorway and every terminal; every
  sub-room has exactly one doorway; the existing egress, free-study,
  clearance and spacing checks. Version 3/4 floors keep the existing checks.

## Open sites

A version 3 design with `setting.form: "open"` authors one ground plan instead
of stacked office floors. It is still generated and validated with the version
5 layout code, but the result is interpreted as outdoor ground: rooms become
stall rows, plazas, pens or terraces, boundaries lean on stalls, low fences and
kerbs rather than full walls, and the floor's stairs marker is the open pad that
`groundExtractionPad` turns into `Game.extraction` (floor 0, inside the plan,
shrunk until its disc is walkable). Floors 1 to 4 exist as solid, unreachable
layers (`Floor.open` on every floor of the start site, `isSolidOpenFloor` for
indices above 0): they carry no furniture, no interior plan, no roof cover and
no stairs of their own, so nobody climbs to a rooftop. The renderer draws the
market ground, canopies and weather on floor 0. Open sites are stamped into a
shared escape world as their ground floor only, keeping their own
`Site.extraction` pad.

## Realism references

Perimeter and core office layouts, central corridors with team clusters,
reception near the entrance and focus rooms deeper in the plan
([BD+C office layout models](https://www.bdcnetwork.com/building-sector-reports/office-buildings/blog/55152810/mastering-office-layouts-5-primary-models-for-maximum-efficiency-and-productivity),
[WBDG layout and common areas](https://afcfs.wbdg.org/facilities-interiors/buildings-configurations/layout-and-common-areas/index.html)).
Corridors of about 6 ft with offices on both sides
([Texas State space standards](https://docs.gato.txst.edu/141275/3-03_Academic-Building-Interior-Space-Square-Footage-Standards.pdf)),
cell offices of 9 to 13 m2 and executive offices up to 25 m2
([ASR A1.2 via Heidelberg](https://uni-heidelberg.de/en/node/43021)),
small to large conference rooms from about 4.8 x 6 m to 7.2 x 9.6 m, and
main aisles of 1.5 to 2.4 m in open plans
([open office clearances](https://arcedior.com/blog/open-office-layout-standards-clearances-2025)).
