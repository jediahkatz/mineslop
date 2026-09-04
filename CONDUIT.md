# Conduit gameplay

Conduits are derived from resident world cells, not stored potion effects. The
existing recipe still costs eight nautilus shells and one heart of the sea.
Existing acquisition remains: open-water fishing treasure for shells, a
once-materialized buried-treasure chest for its guaranteed heart, and monument
prismarine/sea lanterns. This change adds no drowned-shell loot route.

## Rules

- Every inner 3×3×3 cell must contain actual water fluid, including the
  waterlogged conduit. Flowing/falling water and bubbles count; dry, lava and
  unknown cells do not.
- The frame is the 42 distinct positions on three intersecting 5×5 perimeter
  rings. Only full prismarine, prismarine bricks, dark prismarine and sea lantern
  block IDs count. Slabs, stairs and cube corners do not.
- At least 16 blocks activate. Counts 16/21/28/35/42 give radii
  32/48/64/80/96. Range is an inclusive 3D sphere from the conduit block center
  to the player's physical feet. The player's freshly sampled body must be
  known and wet. Overlapping sources do not stack.
- Air uses the existing Gameplay clock and transactional Respiration RNG:
  `max(preTickPotionProtectedSeconds, currentlyValidatedConduitSeconds)`.
- Actual `Game.primary()` speed uses raw tool speed, Efficiency once,
  underwater/airborne penalties with Aqua Affinity, stronger-of potion Haste
  and conduit Haste I, then the existing ecology fatigue multiplier once.
  Helmet observation uses `getEquipmentStack("head")`, not a backpack clone.
  Harvest permission, loot, tool payment and break transactions are unchanged.
- A full 42-block frame attempts four environmental damage every two simulation
  seconds against one resident wet drowned, guardian or elder guardian within
  eight blocks. Drops and elder completion use the existing atomic ecology
  transaction. There is no player XP or retaliation credit.
- Parity limitation: wet non-aquatic hostile species are not attack targets.

## Runtime API and bounds

`GameConduitServices` is created by `Game.bindWorldServiceEvents()` after live
owners are installed. It receives existing mutation/admission events and
advances from `Game.frame()`. It is not registered as a save-budget owner.

`observePlayer()` returns a short-lived observation with `validate()`, never a
persistent buff. Consumers verify the exact Game/world/player/progression owner.
Validation checks source/frame/water column revisions and incarnations, world
epoch/dimension, player life/pose, and current known wetness. Source removal or
unload cannot wait for the next discovery scan before invalidating a grant.
Travel/loading clears presentation and retires observations; rollback and
reload reconstruct the source from cells.

`ConduitIndex` holds at most 128 source positions, 128 cached frame observations,
64 queued column identities and one fallback snapshot of at most 8192 resident
column identities. No chunk buffers, terrain generation calls or pins are held.
Each step scans at most 32768 block-array entries across at most four column
work items, split evenly between admission and fallback lanes. A cache miss
checks at most four distinct frame columns and 70 cells. Small mutation events
(up to 256 changes) discover new sources directly; larger events and queue
overflow request finite resident sweeps.
Mutation revision gaps also request a sweep. One native World revision scalar
comparison per step catches a missing final event without waiting for another
publication. Gaps during a sweep coalesce into a follow-up sweep; a stable,
fully observed world performs no recurring cell scan. Stale/replayed events
cannot acknowledge a gap or update discovery.

More than 128 resident sources fails closed until a complete sweep establishes
that the source set fits again. Pulse attempts are bounded to four sources per
simulation step, so excessive simultaneous sources can delay attacks; no
missed-time burst is replayed. Pause, hidden tabs and loading do not advance
cooldowns. No conduit clock, cache or derived modifier is serialized.
The scheduler maintains a circular queue of at most 128 source identities,
independent of readiness and discovery-map order. New identities join behind
waiting peers; removals retain the next surviving peer. It advances past the
last attempted identity even when there is no target or a transaction veto.
A continuously ready source is serviced within at most 32 running steps;
with 0.1-second steps, a continuing source's attempt interval is at least
20 and at most 52 steps, including its two-second cooldown.

`updatePlayerVisualEffects(game)` sends finite clamped potion
`gear.lighting.strength` and freshly validated `conduitPower` immediately before
`graphics.update()`. The optional renderer API is
`setPlayerVisualEffects({ nightVision, conduitPower })`.

## Remaining manual Survival walkthrough

1. Obtain a treasure map, loot its buried treasure once, and retain the heart.
2. Catch eight shells through open-water fishing; collect monument frame blocks.
3. Craft and waterlog the conduit; build 15 then 16 blocks and expand through
   the five radius tiers. Verify air, underwater mining and visible clarity.
4. Remove water/frame/source blocks and cross horizontal/vertical boundaries;
   verify immediate loss, ordinary air drain, and no overlap stacking.
5. Complete 42 blocks near an aquatic hostile. Observe two-second single-target
   damage, elder drops/completion without player XP, then save/reload and travel.

The automated fixtures author finite worlds/resources. They do not claim this
Survival acquisition walkthrough or GPU/GUI acceptance has been performed.
