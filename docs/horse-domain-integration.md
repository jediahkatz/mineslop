# Horse domain checkpoint

Authoritative checkout: `/tmp/mineslop-development`, branch
`cursor/mineslop-distance-horses-audio-351d`.
This is an **unexecuted checkpoint** for the parent's commit/push. No tests,
servers, dependency installation, or Git writes were performed by this worker.
The ratified contract is `/tmp/mineslop-horse-contract.md`.

## Ownership and implemented behavior

Wildlife alone owns identity, position, heading, health and the base model.
`Horses` owns a sidecar, not a second pose/corpse collection. Tracking admits an
existing natural or authored Wildlife horse; it never spawns a replacement.

- Eight living tracked horses across dimensions; 1,024 permanent IDs including
  tombstones. No untracking/ID eviction or tombstone resurrection.
- Empty hands mount untamed or bareback horses. Food heals and raises temper,
  never instantly tames. Authored taming interval: 60 ticks at 20 ticks/second.
  Attempts compare the existing temper against an ID/raw-world/failure-count
  draw, then add five temper on failure. Temper 100 succeeds. Remaining ticks,
  completed blocked bucks and failed-attempt counts survive saves.
- Only tamed+saddled riders steer/jump. Releasing a charged Space jumps; loading
  or mounting requires a fresh release before charging. Saddle removal keeps
  the rider bareback without control.
- Terrain collision uses the .88 radius / 2.45 height horse plus the rider
  envelope reaching 2.75 above its feet. Species-local steps are at most one
  block; global Player step height remains unchanged. Physics caps elapsed
  time at .2 seconds and steps at .05 seconds, never requests chunks, and freezes
  pose/velocity/fall/taming at unknown frontiers.
- Shallow water slows to .45 speed. Deep water rejects mounts/jumps, freezes
  movement, and requests a loaded safe exit. Blocked ordinary exits/bucks stay
  mounted. Exit searches sweep rise, horizontal motion and descent, check
  support, hazards, loaded neighbors and other active mob bodies.
- Feed, saddle transfers, damage/death and riding proposals use a single commit
  with one participant per owner. Leather and the exact saddle share one
  overflow participant; player kills also require the XP participant. A veto
  or capacity failure does not partially heal, debit, unequip, kill or unseat.
- Death first tries a supported exit. If none exists, only death may release
  the exact clear rider seat with its current velocity and `grounded:false`.
  This uses loaded, full player-envelope clearance, world limits, hazards and
  other active mob bodies; only the dying horse's body is exempt. There is no
  search, upward lift, invented support or wall/roof teleport. Fatal landings
  use the same bounded physics proposal's validated seat. Invalid/unknown
  seats still refuse the whole death, and commit rechecks the chosen exit.
- Retained horses become dormant in the same Wildlife object/record. They wake
  at the saved position, never use wolf catch-up, and never enlarge active/GPU
  capacity. Riding updates the ephemeral AI home to the ridden position and
  consumes the mounted impulse so generic AI cannot apply it a second time.

Armor, breeding, leads, shears removal and transporting horses through portals
are not implemented. Uncontrolled rides do not have a new random buck-animation
solver: the persisted attempt and safe ejection are the gameplay mechanics.
Ordinary Shift, water exits and blocked bucks still require supported exits;
they cannot use the death-only airborne release.

## Constructor and hooks

```js
const horses = new Horses(null, world, {
  gameplay, coordinator: world.coordinator, context,
  overflow, experienceOrbs, // optional if the corresponding adapters are supplied
  readOwner, canMount, available,
  prepareHandCost, prepareDrops, prepareExperience, // optional adapters
  sampleFluid, identityReserved, onEvent, onChange, // optional hooks
  allowOverBudget: false, // archive staging only may opt in
});
```

All hooks are synchronous. `scene` must be null/undefined; no second renderer is
created. The world, Gameplay and supplied sinks share the real coordinator.

- `readOwner(ownerId, hand)` returns
  `{position:{x,y,z}, dimension, dead, eye?:{x,y,z}, targetKey?, poseRevision?}`
  or null. Only `"player"` and hands `"main"`/`"offhand"` are supported.
  The domain reads the actual Gameplay hand/revision itself. Its committed
  seat/pending exit takes precedence over a not-yet-consumed Player pose.
- `canMount(ownerId, horseId)` returns exactly true only if the OTHER vehicle
  owner is unoccupied. It is checked during preparation AND commit, including
  sidecar load. It must work during detached staging. Missing guard refuses
  mounting; it is not a UI-only check. Parent must add the reciprocal Boat guard.
- `available()` checks the current Game/scene/Player/input bindings. Every
  ownership participant rechecks it at commit. Permit the correctly bound
  saddle session for slot operations, even when normal walking input is blocked.
  Pass operation-specific `validate()` for exact session/target/lifecycle guards.
- `identityReserved(id)` returns true for another domain/canonical identity
  reservation and false for an available existing horse. It must not reject
  that exact current Wildlife horse merely because its base already exists.
  Bound Ecology reservations are checked in addition to this callback.
- `sampleFluid(world, point)` uses the existing aquatic sampling shape:
  `{fluid, surfaceY?, current?:{x,y,z}, valid?, loaded?}` or null.
  Omission uses the existing loaded geometry/fluid-volume reader.
- `onEvent(event)` and `onChange()` are postcommit observers only. Their errors
  become `observerErrors`, not transaction refusal. They must not decide whether
  the committed resource/exit exists.

Resource adapters receive frozen requests and return ONE registered participant
`{owner,beforeBytes,afterBytes,validate,publish,notify?}` or null:

```js
// Gameplay owner; feeding uses count:1, wear:0.
prepareHandCost({
  ownerId: "player", hand, stack, handRevision, slotKey, count: 1, wear: 0,
});

// ONE DropOverflow owner for the entire batch (one or two stacks on death).
prepareDrops({
  stacks, position, dimension, velocity: {x:0,y:1.5,z:0}, pickupDelay: .4,
  reason: "horse-death", // or "horse-inventory-drop"
});

// ExperienceOrbs owner; player kill amount is a stable draw in 1..3.
prepareExperience({
  amount, position, dimension, velocity: {x:0,y:1,z:0}, pickupDelay: .4,
  reason: "horse-death",
});
```

Without adapters, real Gameplay/DropOverflow/ExperienceOrbs preparation methods
are used. Creative main-hand feeding is the existing unlimited palette policy;
offhands and every saddle UI source/cursor are finite even in Creative.

IMPORTANT: the old `prepareVehicleDrops()` accepts exactly one stack. Extend or
replace it for the batched horse payload. Death can occur during a simulation
frame; an adapter gated only by the old UI `_actionAvailable()` is insufficient.
Use current owner/scene/frame guards for physics/environment reward preparation.

## Public plans and receipts

Ownership preparation returns
`{ok:true, handled:true, action, id, participants, ...receipt}` or
`{ok:false, handled:true, reason}`. `horses.commit(plan)` returns the receipt
without `participants`, plus `{ok:true, observerErrors}`. Rejection returns
`{ok:false, handled:true, reason}`. The parent can instead compose all prepared
participants and call the shared coordinator ONCE.

- `prepareTrack(id, {ownerId="player"})` / `track()`:
  action `"track"`, participants Horses+Wildlife.
- `prepareMount(id, ownerId="player", {hand="main", validate, participants=[]})`
  / `mount()`: action `"mount"`, receipt `{position}`.
- `prepareDismount(ownerId="player", {reason="input", validate, participants=[]})`
  / `dismount()`: action `"dismount"`, receipt `{exit}`.
  Reasons are `"input"`, `"buck"` or `"water"`.
- `preparePassengerRelease(ownerId="player", {travelling=false, validate})`
  / `releasePassenger()`: action `"release"`, ONLY a Horses participant.
  Requires accepted travel, dead owner, or an owner already in another
  dimension. It is not a blocked-Shift fallback.
- `prepareFeed(id, {ownerId="player", hand="main", validate, participants=[]})`
  / `feed()`: action `"feed"`, receipt
  `{handCostCommitted:true, health, temper, tamed}`.
- `prepareSlotAction(id, command, {ownerId="player", validate, participants=[]})`
  / `slotAction()`: action `"slot"`, receipt
  `{saddle, dropsCommitted:true, handCostCommitted:true}`.
  The sole horse slot is `"container":0`. Supported commands:
  `"click"` (button 0/2), `"quickMove"`, `"swapHotbar"`, `"swapOffhand"`,
  `"collect"`, `"distribute"`, `"drop"`.
  Player areas are owned `"inventory":0..35`, `"offhand":0`, `"equipment":0..3`;
  `"cursor":0` is an explicit drop address only. No crafting/Creative-copy/close
  command is fabricated. Parent closes through the existing cursor authority.
- `prepareInteraction(id, {ownerId, hand, inventory=false, validate, participants})`
  / `interact()`: food delegates to feed, empty hand to mount. A tamed horse with
  `inventory:true` or a held saddle returns presentation-only
  `{ok:true,handled:true,action:"inventory",id,view,participants:[]}`.
  This does not grant a UI ownership lease; every actual slot command validates
  the captured session independently.
- `prepareHit(id, amount, direction, {ownerId="player", playerKill=false,
  retaliate=true, validate, participants=[]})`: action `"hit"`, receipt
  `{hit:true,killed,damage,entityId:id,kind:"horse",drops,experience,
  dropsCommitted:true,experienceCommitted:true,handCostCommitted,exit?}`.
  Player kills require synchronous target `validate`; supply the ONE prepared
  Gameplay tool-cost participant in `participants`. Do not run legacy
  `Wildlife.damage/interact`, debit wear, spawn drops or grant XP again.
- `hurt(mobOrId, amount, direction, options)` is the committing environmental-hit
  wrapper and always uses `playerKill:false`. Refusal includes
  `{hit:false,killed:false,damage:0}`.

Events are `"feed"`, `"saddle-slot"`, `"mount"`, `"dismount"`, `"release"`,
`"tamed"`, `"taming-failed"`, `"hurt"`, `"death"` and `"horse-step"`.
`"horse-step"` carries `{id,blockId,position}`; bridge it to
`effects.sound("horse-step", event.blockId, {position:event.position})`.
Only actual grounded stride distance emits it, never air/deep-water/stationary
input. Do not also emit a walking Player step while seated.

## Canonical archive and Wildlife lifecycle

Keep outer archive version 3. Optional top-level `horses` is the ratified v1
sidecar. Check property descriptors BEFORE reading the archive property:
missing means `emptyHorseSnapshot(context)`; present undefined/null/accessor
means rejection. Preserve raw seed spelling and supported generator contexts.

1. Normalize Horses and Ecology first. Produce ONE canonical mob snapshot per
   dimension from all archive compatibility locations.
2. Every base normalization call that can include retained horses must use:
   `normalizeMobSnapshot(raw, context, dimension, {horses: normalizedHorses})`.
   Omitting the option applies the legacy cap. Explicit invalid options reject.
3. Compare all compatibility copies on the complete base projection:
   `sameHorseBase(horseBaseProjection(a), horseBaseProjection(b))`.
   Reject conflicting ID/kind/position/health/yaw/tamed/angry/cooldown/fuse/
   pacification fields; do not concatenate repeated compatibility snapshots.
4. Validate the canonical array with
   `horseMobLinksValid(normalizedHorses, canonicalSnapshots, {ecology: normalizedEcology})`.
   Every live tracked ID needs exactly one horse in its dimension; every dead ID
   needs zero live records and no duplicate legacy killed marker. Ecology
   entries, egg IDs/child IDs, other species/dimensions cannot alias.
5. Load sidecar while detached (`prepareLoad(data)` returns one participant;
   `load(data,{allowOverBudget})` returns boolean).
   Restore Wildlife ONCE using
   `wildlife.load(canonicalActive, {context,horses:normalizedHorses,ecology:ecologyOwner})`,
   then `horses.bindWildlife(wildlife)`. Ecology must bind to this same restored
   base owner instead of independently loading/replacing it.
6. Parent preflight checks the sole cross-Boat/Horse rider, saved Player/seat
   agreement, active capacity, loaded horse+rider clearance and dimension before
   tearing down live Game. `riderPose()` can expose a staged saved seat; that
   alone is not a loaded/visible-rider admission check.

Wildlife registers its own zero-byte participant and releases it only during
disposal. Horses borrows/checks it and never releases it. Parent must change
Ecology activation/suspension to borrow the same registration. `Wildlife.load`
refuses while either host is bound, including inactive/stale bindings.

Moving ownership reservations are fixed, not per-frame JSON sizes:
`1024` header bytes, `2048 + 4*2048` per live sidecar+paired base copies,
`1024` per tombstone. Enforce `HORSE_BASE_COPY_LIMIT=4` across compatibility
locations. Loading/action validation checks bounded data; motion never
serializes a complete save/inventory. No sidecar stores a base pose/health.

## Frame, travel, UI and presentation checklist

- Call `beginFrame(frameId)` at the START of every Game frame, before late
  interactions. Call `update(dt,{viewer,controls:{player:horseInput(keys,player.yaw)},
  frameId})` using the same token. It returns
  `{moved,steps,exits,observerErrors}`. Keep ticking unseated airborne handoffs.
- `ownsMotionThisFrame(mobOrId)` includes every rider and pending airborne
  handoff, including a same-frame release. Wildlife passes the predicate to
  `stepMob()`, whose mounted path advances voices only, not gravity/steering.
  Do not independently run another generic movement or voice step.
- `mountFor()` returns `{vehicleType:"horse",id,dimension}` or null.
  `riderPose()` returns that plus `{position,velocity,hullYaw,seated:true,
  grounded:false}`. Horse +Z forward is converted to Player -Z heading.
  Never rotate physical Player aim from `hullYaw` when steering by that aim.
- `poseForArchive()` owns the seat/exit before observers; `takeExitPose()` consumes
  a pending exit once. Seat feet are .95 above the horse. Fix both Space keydown
  and repeated seated-pose consumption without activating flight/sprint taps.
  Pass exit `position`, `velocity` and `grounded` through unchanged: a death
  exit can be `{vehicleType:"horse",id,dimension,position,velocity,
  seated:false,grounded:false}` and must resume normal player falling.
- Stage/inspect travel destination without switching live owners. Commit
  `preparePassengerRelease(...,{travelling:true,validate})` at source, capture
  canonical Wildlife, suspend borrowers, switch, restore once and rebind.
  The horse stays at source. After committed departure, a failure must not
  restore an old seated Player pose. `needsDeparture()` also sees an unconsumed
  exit after a same-frame dismount/death. Pearl extras need only Horses,
  optional Fishing and vehicle host unless a real additional handoff is needed.
- `suspend()` refuses a still-mounted rider; `dispose()` releases only Horses'
  reservation. Saved airborne dynamics remain in the sidecar through suspend.
  Neither operation can release Ecology/Wildlife ownership.
- `state(id)` returns an immutable sidecar record. `getHorse(id)` adds a detached
  current base view plus `saddled`, `controlled`, `jumpCharge`. `presentation(id)`
  returns immutable `{tamed,saddled,ridden,grounded,swimming}` or null with bounded
  loaded geometry reads, no second saved state.
- Horse record publication installs a precomputed frozen `mob.horseView` in the
  same commit, before ANY participant's observers. A veto cannot display a
  saddle, dismount or corpse early. Motion reuses its bounded solver result;
  publication does not invoke geometry/observer callbacks or serialize saves.
- Wildlife refreshes the derived view on bind, validated base restore,
  suspension/wake, before animation and before picking; detach clears it.
  Both native batching and picking now use `isMobPartVisible(part,mob)`.
  Non-horse conditions, instance capacities and shared atlas/mesh resources
  remain unchanged. No extra parent view-publishing participant is needed.
  The small view contains no pose/stack and is absent from both save owners.
- Adapt that view to HorseUI's `{kind:"horse",sessionToken,horseId,dimension,
  tamed,ridden,slots:[exactSaddleOrNull],gameplay:gameplay.getState(),supportedActions}`.
  Strip `sessionToken` only after capturing it in the domain action's `validate`.
  Closing must preserve/return the actual Gameplay cursor through its owner.
- Parent has supplied `ITEM.SADDLE=65633`, stack size one/no durability/armor slot,
  the ratified leather+iron recipe and the real fishing treasure route.
  Saddle tests intentionally require that real registry entry.

## Final domain file set

Paths are relative to `/tmp/mineslop-development`. Other workers' pending
model/skin/UI/AI/audio/content/Game/vehicle-host work remains untouched.

Runtime:
`src/horse-definitions.js`, `src/horse-save.js`, `src/horse-taming.js`,
`src/horse-collision.js`, `src/horse-physics.js`, `src/horse-actions.js`,
`src/horse-riding.js`, `src/horse-slots.js`, `src/horses.js`.

Existing base-owner integrations:
`src/wildlife.js`, `src/mob-save.js`.

Domain fixtures/tests:
`test/horse-fixture.js`, `test/horse-save.test.js`, `test/horse-taming.test.js`,
`test/horse-transactions.integration.test.js`, `test/horse-slots.integration.test.js`,
`test/horse-lifecycle.integration.test.js`, `test/horse-physics.integration.test.js`,
`test/horse-death-release.integration.test.js`, `test/horse-view.integration.test.js`.

Handoff: `docs/horse-domain-integration.md`.

## Verification after parent checkpoint

Run from `/tmp/mineslop-development`, after content/borrower integration:

```sh
node --test test/horse-save.test.js test/horse-taming.test.js \
  test/horse-transactions.integration.test.js test/horse-slots.integration.test.js \
  test/horse-lifecycle.integration.test.js test/horse-physics.integration.test.js \
  test/horse-death-release.integration.test.js test/horse-view.integration.test.js
node --test test/horse-presentation.test.js
node --test test/mob-save.test.js test/wildlife*.test.js \
  test/ecology-host-*.integration.test.js test/mob-animal-behavior.integration.test.js
```

Then run the parent-owned vehicle/archive/UI/render tests and full package suite.
The new death cases cover unsupported clear seats, exact velocity/position,
supported-exit preference, walls/roofs/frontiers, other active mobs, stale
clearance, both real reward-owner vetoes and fatal enclosed landings. The new
view cases cover pre-observer atomic publication, real saddle transfer/removal,
native batching/picking, untamed bareback, detach/restore/wake, airborne/deep
water, frozen snapshots and unchanged save/buffer budgets. These cases have
been authored, not executed, pending the parent checkpoint.
The natural-existing test uses the real Wildlife population path on authored
admitted terrain; it does not claim native-generation distribution, browser
play, Survival progression, UI layout, audio listening or measured frame rate.
Those integrated checks remain with the parent after checkpoint.
