# Inactive combat runtime checkpoint

`CombatRuntime` is a bounded transient data owner. Normal Game does not create,
activate or update it yet. It has no damage delivery, AI, rendering, save/load
or terrain-destruction entry point. Its tested data ownership is not proof of
Game/source/victim authorization or playable friendly fire.

## Ownership and batches

Construction requires a registered real World and matching context. Exactly
one runtime may be registered for that World. Its reservation is zero save
bytes; pool limits bound transient memory instead of adding another entity
archive. Canonical references remain opaque and are neither traversed nor
frozen as live entity objects.

`begin()` creates a detached batch. Contributions include roster/target-memory
updates, launch/motion, presentation acknowledgment, clock advancement,
cancellation, blast admission and victim advancement, hit quotations and
bounded derived contacts. Refused/conflicting contributions poison the batch;
there is no salvage of a success-looking partial result.

`finalize({participants, notify})` produces one runtime participant for all
changing operations. Every exact required owner participant must be present,
and the peer list must already contain unique owners. Commit the complete
returned `participants` list; do not extract a runtime publisher from a
health-bearing composition. State installs before notifications, and copied,
replayed or stale runtime tokens reject. Zero-time-only batches have no
participants.

Scalar views expose shots, blasts, derived work and actor metadata without
canonical refs. World epoch changes make old work unavailable immediately;
World-object replacement requires disposing the old runtime. Disposal releases
only this owner. Replacing one player life does not erase unrelated victims
or travelling provenance.

## Prepared operations

- `syncActors()` supplies the complete bounded admitted roster.
  `rememberTarget()` stores validated identity memory; live target acquisition,
  visibility-memory/leash scheduling and AI consumption remain unimplemented.
- `launch()` captures immutable provenance and bounded supplied parameters.
  `motion()` uses the existing guarded nearest-contact helper. Contact/frontier
  retains the original pending segment rather than moving through a body.
- `acknowledgePresentation()` requires the bridge's completed-render proof.
  A blaze cannot acknowledge its own launch batch or combine new acknowledgment
  with damage-capable motion in that batch. Original lifetimes still expire.
- `admitGhastBlast()` combines shot retirement and blast-ticket admission.
  Capacity refusal preserves the pending shot and its original deadline.
- `quoteHit()`, `quoteContact()`, `quoteBlastVictim()` and `quoteDerived()` are
  calculations, not damage. `acceptHit()` requires an actual positive prepared
  owner result and records the exact peers needed by finalization.
- `skipBlastVictim()` advances a refused/stale victim once through an explicit
  runtime-only commit. The bridge must perform that skip after a failed victim
  attempt rather than retrying after resources become available.
- `admitDerived()` allows one nonrecursive guardian reflection from an accepted
  origin, admitted with that hit and consumed only afterward.
- `advanceClocks()` uses admitted simulation dt. Pause supplies zero; waiting,
  rendering and retries do not extend deadlines or reset hurt/credit clocks.

## Bounds

The runtime retains at most 12 legacy shots, 12 blaze shots, 29 actor records
(28 mobs and one player), four blasts with 29 captured victims each, and eight
derived tickets. TTL ceilings are six admitted seconds for shots, three for
blaze, one for blasts and half a second for derived work.

Each batch permits at most 128 operations, 256 guards and 128 supplied peers.
Raw damage 1,024, vector magnitude/gravity 64 and blast radius 16 are validation
ceilings, not approved gameplay tuning. The collision helper's independent
geometry/roster/work limits remain authoritative.

## Verification and remaining gates

Checkpoint `58212d4c30b9cce7ecd66a1a56793e7c290327c7` passes all 44 runtime tests
and 71 pure-rule/collision/transaction regressions. The full frozen suite
completes 3,618 tests: 3,600 pass and the same 18 inherited failures remain, with
no new failure names or changed assertions. The production build succeeds.

Tests use real World/coordinator and actual prepared
Gameplay/gear health edits while explicitly withholding any claim of mob-owner
or live-Game authorization.

The future bridge must supply complete fresh canonical actors/geometry,
difficulty value and revision guards, source eligibility, actual owner results
and all uniquely composed resource participants. Stable player identity/life
comes from existing pearl services.

Normal Game activation, source/victim authorization, owner-batch integration,
AI/kinematics, complete blast terrain processing, legacy radii/reward decisions,
burn scheduling and TNT migration remain separate gates. The accepted
four-second blaze payload is retained as data, not implemented burning.
