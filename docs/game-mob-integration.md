# Game horse and ecology integration handoff

Checkout: `/tmp/mineslop-development`.
Branch: `cursor/mineslop-distance-horses-audio-351d`.

The coherent integration is checkpointed at
`c6bf9a63048828333de6cab56d10c1342e2ace4e`. Existing movement diagnostics and
concurrent art changes are excluded and remain untouched. Verification is in
progress; this document does not constitute release clearance.

## Runtime verification — September 3, 2026

The initial checkpoint ran in an isolated worktree with the unchanged lockfile:

- Ecology owner contract: **43/43 pass**.
- Existing Game/vehicle/input/travel/progression regressions: **180/180 pass**.
- Existing horse/ecology/Wildlife suites: **245/250 pass**. The five failures
  are the already-failing native ecology fixtures (`World loading was
  cancelled`), also present before this integration.
- Initial new Game host suites: **36 pass, three failures**. Egg mining returns no
  prepared plan; the owned-bow observer/replay case throws; the archive suite
  completes six cases before its saved-rider restoration test process reaches
  the heap limit. The archive test failure is resolved below.
- Production build succeeds. Both Pages-path checks pass, including real
  WebGL2, the terrain worker, IndexedDB save/reload, camera and control settings.

The native Game suite initially exposed a strict-data boundary error:
`Trading.jobsiteOwnerAt` received a rich block hit instead of `{ x, y, z }`.
Checkpoint `def3370d2a94dbfe665c214986074ff5e92c03ad` projects the coordinates
without weakening the Trading validator. The new ordinary-mining regression
passes, and **all five native Game cases pass** after the fix: ocean admission,
finite villager trading/jobsite removal, villager death and V4/V5 marker reads.

Checkpoint `8d1c3bef6533025f02afc5ab386e01d50a0687f3` fixes the archive test's
spy lifetime. Scalar instrumentation showed successful single-load restoration,
correct borrower/Trading identities and the rider before the test deliberately
attempted a forbidden bound reload. The detached-only spy was still installed,
so its assertion failed and formatting the complete owner graph exhausted the
heap. Restoring the spy first exercises the actual refusal without weakening
the assertions. **All 11 archive cases pass**, including unchanged owners after
the refusal; the temporary instrumentation is removed. No production restore
bug was evidenced.

The full suite at that checkpoint completes **3,451 tests: 3,423 pass, 28 fail**.
The 18 pre-existing failures have identical names and assertions. The ten new
failures are egg harvesting, bow observer/replay, seven lifecycle cases across
exploration travel, projectile persistence and respawn safety, and a legacy
sidecar-absence fixture.

Checkpoint `a2376500c36699c0e1dd7158f07d5ffed13e4c0b` corrects that last fixture:
legacy absence omits mob properties rather than supplying explicit `undefined`.
The canonical malformed-data guard remains strict. **All 14 archive/preflight
checks pass** together after this correction. This is targeted verification,
not a rerun of the full suite.

The egg/bow and remaining lifecycle failures plus manual riding/Survival
acceptance are still open. Do not publish this batch as verified.

## Completed ecology owner contract

The previously missing owner APIs are implemented in this delivery. Game now
has the concrete constructor → one Wildlife load → adoption → Horses bind →
Ecology activation path, including an empty new-world horse sidecar. No
always-successful owner substitutes or fallback second base loads are used.
This removes the missing-API activation blocker. The owner-contract tests pass;
the remaining runtime acceptance gates are recorded above.

- `normalizeEcologyServicesSnapshot(value, context, options = {})` in
  `src/ecology-save.js` validates optional data-only `{ horses }`. Explicit
  undefined/null/malformed/accessor sidecars refuse; omission preserves legacy
  callers. The normalized sidecar reaches every dimension's base normalizer.
  `horseMobLinksValid` runs alongside ecology/base/egg/child validation, including
  tombstone aliases and inactive dimensions. Valid retained horse records can
  exceed the legacy base cap without changing active/GPU, identity or byte caps.
- `GameEcologyServices` accepts a synchronous `readHorses` hook and consults its
  current value during construction, restoration, adoption, activation and
  serialization. Absent hooks omit the horse option. Configured failures,
  thenables and malformed data refuse. Game reads its initial sidecar only
  before the vehicle owner exists; afterward even an unreadable live leaf
  cannot fall back to the initial snapshot.
- Public `bindRestoredWildlife(wildlife, { horses })` is adoption-only. It checks
  real Wildlife identity/liveness, current World/context/dimension/epoch,
  self-owned zero-byte registration, runtime resident/retained-ID consistency
  and complete canonical base agreement: all owned pose/combat fields, sulfur
  cargo, RNG, next-ID and killed-ID metadata. It rechecks all-dimension sidecar
  and exploration-completion links. Explicit sidecar data must agree with the
  current hook. Correctly paired active Horse borrowers are accepted; stale,
  foreign or replaced borrowers refuse. Refusal preserves any previous valid
  candidate and does not load, register, release, render or mutate owner state.
- Activation revalidates the candidate and current horse data before registering
  Ecology's own sidecar. Only ephemeral lifetime guards are retained for seen
  Wildlife objects, so an old renderer cannot be recycled across an epoch
  change. These are not another base-record collection.
- `restoreWildlife()` remains the standalone compatibility loading entry point.
  It performs at most one horse-aware base load and shares adoption validation.
  It refuses bound Horse borrowers rather than replacing their base. Game uses
  the adoption-only method, not this loading entry point.
- Ecology activation/suspension/disposal never register or release Wildlife.
  Wildlife keeps its self-owned zero-byte registration until its own disposal;
  Horses and Ecology can suspend independently without releasing each other.

## Installed host behavior

- `normalizeGameMobArchive()` validates original property descriptors before
  cloning. It reconciles `mobs`, `mobStates`, `mobsByDimension` and
  `ecology.mobsByDimension` into one all-dimension canonical set, preserving
  legacy actors and every compatibility spelling. Copies must agree on complete
  base fields, sulfur state, RNG, next-ID and killed-ID metadata. Horse live,
  dead, rider and ecology/egg/child identities are cross-checked before live
  screen/owner teardown. No duplicate runtime base is made from those copies.
- `GameMobIntegration` stages the actual ExperienceOrbs and GameEcologyServices
  beside the existing progression owner. Ecology uses that owner's exact
  Trading instance and the real Gameplay/DropOverflow owners. Horses loads
  detached; Wildlife loads once with both normalized sidecars; Ecology adopts
  that base and Horses binds to it. Saved rider position, active admission and
  loaded horse-plus-player clearance are checked before live installation.
- Game installs the staged owners, activates vehicles/building/fluids/pearls/
  progression/exploration, and then activates Ecology. Vehicle teardown releases
  the Horse borrower before mob/Ecology teardown; the integration refuses its
  own disposal while Horses is still bound. Only Wildlife releases its base
  registration. The archive reads the same canonical owner at save/travel
  boundaries, not a second per-frame projection.
- Raw public Boat and Horse mount preparations check the other owner again at
  commit. Boat mounting includes a zero-change Horses participant so two
  independently prepared mounts cannot publish together in one transaction.
  Detached aggregate loads admit one saved rider; raw leaf loads cannot add a
  competing rider. Existing unchanged Boat riders and untagged Boat poses remain
  on their compatibility paths.
- Real entity use routes empty hands to bareback mounting, either hand's food
  to atomic feed/temper, and a saddle or sneak-use to the real saddle panel.
  `E` opens the ridden tamed horse's saddle slot. The panel holds a token-checked
  session, not an inventory: the actual Gameplay backpack/cursor and Horses
  saddle slot participate in each transfer. Ordinary input remains unavailable
  under the separate saddle action gate. Closing retains the real cursor;
  neither a full backpack nor absent overflow capacity forces a saddle drop.
- Each Game frame establishes one Horse motion token, updates Horses before
  Player, then runs the existing late Wildlife scheduler. Bareback and same-frame
  released horses retain motion ownership through that late pass. Repeated
  poses for the same horse preserve raw Space for charged jumping, without
  walking, flight-double-tap or sprint latches. Reset, dismount, death and travel
  clear horse input. A late death's exact pending position/velocity/grounded exit
  is consumed once with zero extra Player physics time.
- Player presentation receives `vehicleType`, the committed `hullYaw`, and the
  exact immutable `mob.horseView`. Physical aim is not rotated with the hull.
  Actual stride events call
  `effects.sound("horse-step", blockId, { position })`; seated Player does not
  produce a second walking step.
- `GameMobActions` dispatches owned horse/ecology feed, melee and bow hits to
  prepared owners, never to legacy damage/interaction after refusal. Tool wear,
  arrows, saddle/leather, XP and tombstones publish together. Postcommit
  target/HUD/shot/sound errors cannot make a paid action retryable.
  `GameMobHarvestActions` joins owned egg retirement and villager jobsite release
  to the original World/tool/drop/station plan, with one participant per owner.
  The existing explosion policy remains atomic per logical block, not globally
  atomic over every block in an explosion.
- `GameEcologyMarkers` reads rich frozen member/home/jobsite/encounter descriptors
  only from the existing, current, canonically admitted resident index. Column,
  descriptor, marker, result and cache bounds remain explicit. Reads do not call
  generators, clone the whole index or admit terrain. Real villager work intents
  reach progression registration/restocking; physical entity use opens the real
  availability-checked finite Trading flow. World changes invalidate Ecology.
- Travel uses a detached World to inspect the destination without changing
  source epochs, riders, casts or mob borrowers. It commits source departure,
  then retires other progression/projectile lifecycles, captures source,
  suspends both borrowers, switches dimension, restores Wildlife once and
  rebinds. A post-departure failure recovers the source unseated; the horse stays
  in the source dimension. Prepared arrival/return-portal edits refuse to erase
  stations, eggs or other non-air/non-liquid resources.
- Pearl impacts retain the existing core pose/health/retirement transaction.
  Horse departure contributes Horses, optional Fishing and the vehicle host:
  three extra participants at most, below the existing limit of four. Saddle
  UI/presentation do not become extra transaction owners. Death/respawn continues
  through the actual Gameplay and pearl-life owners.

## Explicit limitations and external work

- Default generation remains `GENERATOR_VERSION = 3`. Only the necessary Game
  and preflight gates changed to `hasExpandedTerrain`.
- The currently committed exploration files already use `hasExpandedTerrain`
  and route V5 canonical descriptions through `describeV5Structure`; settlement
  bounds also use `hasExpandedTerrain`. The existing native fixture already
  selects that V5 descriptor. No remaining hard-coded V4 gate/redescription
  blocker was confirmed in those paths during this static inspection. This is
  **not** a native acceptance result; any descriptor/admission failure belongs
  with the parent's exploration/settlement work. Do not bypass canonical checks.
  `nativeExplorationContext()` omitting a generator-version property is not by
  itself a defect: the current version-specific descriptor wrapper selects V5.
- `readWorldDifficulty()` normalizes `game.worldDifficulty?.value` and validates
  its nonnegative safe-integer `revision`, forwarding both to Wildlife. No new
  settings UI or saved difficulty field is introduced.
- Habitat uses Ecology's existing admitted-chunk biome reader. World does not
  provide a real local block-light/sky-light bridge here, so drowned admission
  remains unavailable rather than fabricating light. Parent can supply the
  existing synchronous `readHabitat` hook once actual loaded light is available.
- Mining consumes Ecology's actual mining-speed modifier. Dolphin's Grace is
  exposed as `game.ecologyModifiers`, but Player has no movement-modifier hook;
  its swim-speed benefit is **not yet applied**. A parent-owned Player movement
  change must compose this with other effects. This worker's Player edits are
  limited to horse input/pose lifecycle.
- Horse armor, breeding, leads, shears removal and portal transport remain
  unsupported as specified by the domain contract. Generic combat attribution
  and broader enchantment/status-combat integration remain with the parent;
  existing owned-hit drop/XP/hand-cost receipts are preserved.
- No browser play, Survival acquisition, GUI layout, audible hoof playback,
  frame-rate or natural-distribution acceptance is claimed.

## Authored tests and fixture updates

The test plan precedes these edits: real-owner archive migration/corruption and
single base load; sequential/composed mount races; saddle conservation and
session races; held Space/input reset/frame order; corpse/late exit and observer
ownership; source-first inspection/departure/rollback; death/bed/pearl handoff;
shared ecology, atomic feeds/eggs/jobsites/trades and bounded native markers.
The executed groups and outstanding failures are recorded above. Use the
commands below against a frozen checkpoint when repeating them.

`test/game-mob-integration-fixture.js` uses actual Game methods, World, Player,
Wildlife, vehicle, progression, Ecology, XP, drops and coordinator ownership.
Authored transaction cases have a labeled flat terrain prerequisite; only DOM,
RAF, graphics submission and audio delivery are transports. Its native mode
uses a supplied real World, `autoSpawn: true`, and `admissionRadius: 3`.
`test/game-mob-native-fixture.js` searches the existing bounded native windows,
uses the actual resident index, and approaches actors through loaded physical
geometry. Neither fabricates stock nor installs successful owner callbacks.

Owner-contract coverage is added in `test/ecology-horse-save.test.js` and
`test/ecology-wildlife-adoption.integration.test.js`, with real owners supplied
by `test/ecology-horse-fixture.js`. Cases include descriptor-only option
validation; legacy omission; complete base conflicts; retained/tamed/dead
records beyond the old cap; foreign/stale/pre-bound/replaced borrowers; epoch
changes after suspension; current-hook failures and updates through actual
tracking/taming/death; one legacy base load; failed budget admission; unchanged
owners on adoption refusal; independent suspension and standalone compatibility.
The Game archive suite also covers refusal without a fallback second load and
an unreadable live horse leaf without a fallback to the initial sidecar.

The previously named parent fixture gaps are aligned in this delivery:

- `test/game-progression-host.integration.test.js` disposes vehicles before the
  new mob integration and progression/exploration owners. It checks the shared
  Trading identity and release of staged Wildlife/ExperienceOrbs registrations.
- `test/game-travel-bed.test.js` binds Player to World and injects an actual
  detached World with the fixture generator and designated spawn. Inspection
  callbacks observe/block/fail preview admission; live destination admission
  is observed separately. Missing-bed expectations are two preview admissions
  and one live admission. Source epochs/poses remain unchanged during inspection,
  previews are disposed, and `protectSpawn()` observes successful Gameplay
  respawn rather than an old `createWildlife({ safeSpawn: true })` argument.
- `test/game-vehicle-preflight.integration.test.js` and
  `test/game-vehicle-lifecycle.integration.test.js` include the `horses` sidecar,
  malformed/accessor cases, occupied binding and `game.horses` cleanup.
- `test/vehicle-pearl.integration.test.js`, `test/vehicle-pearl-fixture.js`,
  `test/vehicle-frame-fixture.js` and `test/game-vehicle-frame.integration.test.js`
  include the third leaf in saved snapshots, owner/reservation observations and
  pause invariants. Boat-only pose and camera expectations remain unchanged.
- `test/horse-lifecycle.integration.test.js` supplies the current `readHorses`
  hook when testing Ecology and Horses borrowing the same base.

## Exact post-checkpoint commands

Run against coherent checkpointed source, including the completed owner APIs
and fixture alignments. All commands use
`/tmp/mineslop-development` as their working directory.
Use the parent's immutable-checkpoint workflow; do not run while another worker
is modifying the same source. No dependency installation is required by this
handoff.

Focused ecology contract coverage:

```sh
node --test --test-concurrency=1 \
  test/ecology-horse-save.test.js \
  test/ecology-wildlife-adoption.integration.test.js
```

Focused real-owner Game coverage:

```sh
node --test --test-concurrency=1 \
  test/game-mob-archive.integration.test.js \
  test/game-horse-ownership.integration.test.js \
  test/game-horse-input.integration.test.js \
  test/game-horse-ui.integration.test.js \
  test/game-horse-pearl.integration.test.js \
  test/game-mob-travel.integration.test.js \
  test/game-ecology-coexistence.integration.test.js
node --test --test-concurrency=1 test/game-mob-native.integration.test.js
```

Existing owner, input, archive, travel and progression regressions with the
included fixture alignments:

```sh
node --test --test-concurrency=1 \
  test/game-vehicle-*.integration.test.js \
  test/vehicle-pearl.integration.test.js \
  test/mounted-player*.test.js \
  test/player-flight-input.test.js \
  test/player-sprint-sneak.test.js \
  test/player-save.test.js \
  test/game-world-stage.test.js \
  test/game-travel-bed.test.js \
  test/game-progression-*.test.js
node --test --test-concurrency=1 \
  test/horse-*.test.js \
  test/ecology-*.test.js \
  test/mob-save.test.js \
  test/wildlife*.test.js
npm test
npm run build
```

Then perform the parent-owned browser/Survival acceptance. The Node saddle panel
test exercises the actual callback UI against a test DOM; it is not browser or
visual evidence.

## Worker-owned changed files

Modified runtime files:

```text
src/boats.js                       (reciprocal mount/load guards only)
src/ecology-save.js
src/game-archive.js
src/game-controls.js
src/game-ecology-services.js
src/game-travel.js
src/game-use-actions.js
src/game-vehicle-integration.js
src/game-vehicle-owners.js
src/game-vehicle-services.js
src/game-vehicle-state.js
src/game-world-events.js
src/game.js
src/player.js                      (horse input/pose lifecycle only)
src/save-preflight.js
```

New integration helpers:

```text
src/game-ecology-markers.js
src/game-horse-inventory.js
src/game-mob-actions.js
src/game-mob-harvest-actions.js
src/game-mob-integration.js
src/game-mob-state.js
src/game-travel-stage.js
```

New fixtures, tests and this handoff:

```text
test/ecology-horse-fixture.js
test/ecology-horse-save.test.js
test/ecology-wildlife-adoption.integration.test.js
test/game-ecology-coexistence.integration.test.js
test/game-horse-input.integration.test.js
test/game-horse-ownership.integration.test.js
test/game-horse-pearl.integration.test.js
test/game-horse-ui.integration.test.js
test/game-mob-archive.integration.test.js
test/game-mob-integration-fixture.js
test/game-mob-native-fixture.js
test/game-mob-native.integration.test.js
test/game-mob-travel.integration.test.js
docs/game-mob-integration.md
```

Aligned existing fixtures/tests:

```text
test/game-progression-host.integration.test.js
test/game-travel-bed.test.js
test/game-vehicle-frame.integration.test.js
test/game-vehicle-lifecycle.integration.test.js
test/game-vehicle-preflight.integration.test.js
test/horse-lifecycle.integration.test.js
test/vehicle-frame-fixture.js
test/vehicle-pearl-fixture.js
test/vehicle-pearl.integration.test.js
```

Horse domain/physics/slots, Wildlife/mob-save, presentation assets, audio, AI,
terrain, block/ore art and unrelated movement/held-item diagnostics are not
edited by this delivery. Existing diagnostic hunks in shared host files remain
untouched. Do not sweep other workers' pending files or those diagnostic hunks
into this integration checkpoint.
