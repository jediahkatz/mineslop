# Gravity runtime

Gravity is wired into normal Game staging, activation, replacement, World
event fanout/admission replay and the authoritative simulation frame.

## Representation and saves

Sand, red sand and gravel move down one cell per 0.1 active seconds. Each move
atomically exchanges the source and destination World cells. There is no
secondary falling entity, inventory debit, falling-item drop or save sidecar.
The existing chunk meshes show cell-aligned falling steps; no new renderer is
needed. This is deliberately discrete, not interpolated falling-entity physics.

Ordinary World mutation events already dirty meshes and schedule saves. Every
intermediate position is represented by existing version-3 World edits.
Reload/re-admission incrementally discovers any still-unsupported blocks.
Do not add gravity to save schemas, normalization, size budgets or archive
payloads. Dispose the old service and create a fresh one whenever World owners
are replaced; replay existing residents using the existing event binder.

Water/lava is displaced into the vacated source cell (including flowing-water
codes); the fluid solver receives the same committed events and resumes flow.
Washable cross plants require the existing active
`GameFluidServices.prepareDrops` transaction, including real crop removal and
overflow retention. Refusal retains BOTH block and plant. Waterlogged blocks,
other nonreplaceable blocks, slabs/stairs and even open gates stop the falling
cube above their occupied cell. A fence extending 1.5 cells also prevents a cube
from entering its upper collision volume. Bottom slabs therefore leave a
half-cell visual gap; occupying fractional positions would require a different
persisted entity design. Gravity does not crush actors or deal damage.

## Live ownership and ordering

`Game.prepareWorld` constructs a detached `GameGravityServices` and includes it
in reverse-order failed-stage cleanup. Initialization activates it before World
event binding and disposes the previous service before replacing its World.
The event multiplexer forwards committed mutations and real chunk admissions,
including replay of initial residents.

The single gravity frame runs AFTER Wildlife and the late vehicle-exit Player
handoff. The existing single `graphics.rebuildDirty` budget moves after gravity;
there is no second mesh budget or second Player walking tick. Thus the occupancy
guard sees post-dismount positions and mesh work sees the newly committed cells.
The single zero-dt `graphics.update` now follows that rebuild, before drawing.
Pause, death, hidden tabs, loading and failure freeze gravity. Inventory overlays
continue simulation without controls, matching fluids and vehicles.

### Renderer ordering regression and proof

The earlier ordering was NOT safe. Real Game frames with actual GameRenderer
methods, World edits, admitted indexed detail, DistantTerrain, Atmosphere and
daylight owners reproduced all three failures before this reorder:

- Sand moved from y=68 to y=67 and its rebuilt mesh top became 68, but the
  daylight DataTexture still held the old roof height 69.
- A newly rebuilt chunk had real detail triangles while two fallback LOD
  triangles still intersected the same ground probe.
- A real late horse dismount crossed a chunk boundary. `rebuildDirty` hid the
  cached outer detail row, but the earlier LOD cutout still removed its fallback,
  leaving a genuine indexed-ground hole for that frame.

`test/gravity-renderer-state.cases.mjs` catches these using real mesh raycasts,
the actual daylight texture data and coverage/index state. All three failed
before moving `graphics.update`, and pass with the order
Wildlife → late exit → gravity → one rebuild → renderer update → draw.
Draw-transport snapshots additionally assert that coverage and daylight are
already current when GameRenderer submits the frame. DOM/art/GPU submission
are fake transports; no World, mesh admission, lighting or LOD update method is
mocked. This is CPU scene-state proof, not a GPU image or frame-rate claim.

`camera.getWorldDirection(renderDirection)` stays BEFORE Wildlife. It samples
Player's current camera directly; it does not depend on fog, projection far
distance, daylight or LOD updates. Wildlife uses that view direction/eye for
gel-instance sorting; physical AI still receives `player.forward`, physical eye
and Game's authoritative `currentTime`. The late-exit test checks both direction
inputs and time at the real Wildlife boundary. The renderer update retains its
original zero dt, so it cannot advance the clock twice.

Only rebuilt/admitted meshes are promised current: normal dirty-mesh budgets can
retain old buffers while other work waits, and the existing shadow-map refresh
throttle is unchanged. No renderer source or cave-lighting policy is modified.

`Boats.intersectsBounds` validates finite, ordered bounds and checks every
current-dimension hull, including stationary/unmounted boats. It is read-only
and never serializes records. `gameGravityOccupied` also checks the player's
actual height, horse hull/rider bounds, and every living non-horse mob's species
body dimensions. Dormant residents retain their occupancy. There is no crushing,
damage or deletion of passive, hostile or aquatic mobs. Missing/stale physical
owners fail closed.

Dimension travel preserves the service but resets transient work on the first
real admission of a new World epoch. Successful travel and failed-admission
rollback both rediscover mass through their normal resident admissions.

## Bounds and deliberate limits

- At most 2 ticks/update and 64 evaluated cells/tick. Separately, at most EIGHT
  attempted two-cell World mutations per update, including rejected attempts.
  This caps costly World preparation and observer fanout, not only scalar reads.
- At most 512 admission/rescan cell inspections and 32 scan-job visits/update.
- At most 4,096 queued cells and 512 chunk scan jobs; World has at most 441
  resident chunks (plus a transient admission). Queue overflow coalesces into
  a rescan of only the affected chunk, rather than losing work. Sixty-four queue
  slots are reserved for scans so actor-blocked/rejected retries cannot starve
  independent falls.
- These are transient queue entries and chunk-reference scan jobs, not saved
  entities. Evicted references are discarded as bounded work visits them. The
  transaction guard reserves zero save bytes; actual movement is charged to
  World's existing edit reservation. No per-frame archive serialization occurs.
- A normal proposal reads three cells, resolves at most one support shape and
  prepares one two-cell World mutation. Occupancy queries run before preparation
  and during validation; their bounds additionally depend on the bounded boat
  and wildlife owners. Plant transactions use at most 16 retained participants.
- Mutations wake the changed cell and the next two cells above; no terrain scan
  happens in notification callbacks.
- Admission scans are incremental and deduplicated by resident identity.
  The player's current column gets priority; other columns finish in admission
  order, and repeat scans yield at the end of a pass. Steady supported terrain
  has zero recurring work after its first scan.
- No horizontal travel, no diagonal sliding, no chunk-generation calls, no
  unloaded-as-air reads. Own-column eviction drops stale work; fresh admission
  rediscovers the persisted mass. Adjacent unloaded columns need not load.
- Full save budget/retention refusal or actor occupancy leaves the block in
  place with bounded replay. Work is deferred, never converted into free loot.

## Targeted test command

Run inside a tmux session:

```sh
node --test test/gravity-renderer-state.integration.test.js test/gravity-game-runtime.integration.test.js test/falling-blocks.test.js test/game-gravity-services.test.js test/gravity-occupancy.test.js
```

Ordering regressions also run the existing `renderer-streaming`, `renderer-sections`,
`renderer`, `streaming`, `game-frame-rate.integration`, `game-vehicle-frame.integration`,
`mob-rendering`, `mob-player-context`, `mob-skins`, `mob-daylight`,
`game-world-events`, `cave-daylight` and `daylight-material` test files.
These cover actual indexed fallback/cutout coverage, row reversal,
partial-section admission, retained dirty meshes, frame gating and vehicle
ordering, physical AI versus view inputs, gel sorting and draw-time daylight
binding, not just mock gravity movement counts.

Follow-up results: the main targeted run passes 136/136 top-level tests
(including the child processes' 12 real-Game cases and three renderer cases).
The final draw-submission assertions and `mob-daylight` run pass 4/4 top-level
tests. Supplemental `mob-player-context`/`mob-skins` results are 17/19:
physical/view context and gel sorting pass, but two existing legacy skin
enumeration tests fail because `paintMobSkinFace` has no legacy palette for
`villager`/`blaze`. This reproduces by importing only species/models/skin painting,
without Game or gravity; those source/test files are unchanged. No out-of-scope
skin fix is included.

Coverage includes support removal/placement, mixed-stack cascades, stable
terrain, partial/tall shape support, fluid displacement, real plant/crop/overflow
ownership, refusal/replay, actor occupancy, column eviction/admission,
serialization/reload, throwing/duplicate observers, bounded queue overflow,
pause/death and stale hosts. Real-Game cases execute actual initialization,
frames, Player, World, Fluid, Settlement, Wildlife and Vehicle owners. Only
browser rendering/audio/UI transports and authored terrain provisioning are
substituted. The native historical-terrain case uses the unmodified v3 generator,
real desert travel, native sand, support removal and archive restoration.
Other generated-cell cases use authored terrain to make exact replay assertions;
there is no claim about modern-v6 natural distributions or GPU presentation.

The commit-heavy case reports measured gravity and whole-frame median/max CPU
times for 35 real frames with 98 unsupported blocks, a live boat, horse, sheep
and water. It asserts the eight-attempt cap and exactly one normal mesh budget.
These are headless CPU measurements, not WebGL or 60-FPS evidence, and do not
cover maximum population/boat cardinalities. Contention slows individual falls;
unloaded/capacity-blocked work waits without losing mass.
