# Pure combat foundations

The first slice is implemented at
`5f6b48d3c2989fb65397138485d6c26f8b42fb52`. It is intentionally **unwired**:
it does not deliver damage, run AI, create a combat owner, migrate projectiles,
grant rewards or make friendly fire playable.

## Rules

`src/combat-rules.js` separates attack classification, victim-owner routing and
reward credit. Every horse routes to Horses, including an untracked wild horse;
an unavailable owner is not permission to fall back to legacy mutation.

Damage follows this order:

1. Classify the full raw attack and select its one difficulty adjustment.
2. Compare `difficultyAdjustedFullDamage` with the previous full adjusted
   pre-armor amount inside the hurt window.
3. Pass only the resulting `preArmorDamage` to the actual armor/effects owner.

The caller installs `nextWindow` only with an accepted damaging transaction.
The effective comparison window is 0.5 admitted simulation seconds. Player
credit lasts 5.0 admitted simulation seconds; pause supplies zero time.
Compensated clocks preserve expiry across different step partitions. Source
liveness, attack authority and stable player reward ownership are distinct.

The species matrix and policy tests pin `mineslop-combat-contract-v2`.
No particular upstream Java release has been behavior-verified by this slice;
the implementation must not be described as complete vanilla parity. The
intended live comparison target is Java Edition, consistent with the game,
with release-specific references still required before a parity claim.

## Collision and validation

`traceCombatSegment(facts, readCurrent)` returns immutable scalar results:
`flight`, `contact`, `frontier` or `invalid`, plus `validate()`.

- Sweep the complete segment and declared AABB half-extent through actual
  partial/connected World collision shapes.
- Resolve nearest contacts deterministically. Tolerance ties are anchored to
  the global minimum, then ordered by world precedence and complete stable IDs.
- Immune and owner-unavailable bodies remain physical contacts.
- Launch-envelope members remain separate targets. Source death does not
  erase travelling provenance; returning shots can hit their source after exit.
- Missing geometry anywhere in the bounded read apron yields `frontier`,
  never air, an explosive impact or a partial successful trace.

The required current-facts reader must return the same pending ticket/segment
and a fresh complete bounded physical roster, not merely the selected victim.
Validation re-queries nearest contact and pins World, chunk identity/incarnation,
revision, epoch, collider identity and player life. An intervening actor moving
ahead therefore invalidates a pending hit even without a shared revision bump.
The reader's own gathering work must also remain bounded.

Limits per query and re-query:

- Segment length 16 blocks; radius at most 1; at most 28 mobs plus one player.
- Two source-envelope members and eight-block actor/envelope extents.
- 2,048 geometry cells; 4,096 unique cell reads; nine columns.
- 16,384 read operations; 8,192 geometry boxes/intersection tests.
- Sixteen shape parts per cell; full IDs at most 1,200 characters.
- Contact tolerance `1e-7`; oversized work refuses without partial contacts.

## Executed checks

All 50 new focused checks pass using actual World geometry. The 22 existing
pearl-physics and difficulty regressions also pass.

The full frozen suite completes 3,573 tests: 3,555 pass and the same 18 inherited
failures remain. Baseline comparison finds no new failures or changed failure
assertions. The production build succeeds. These results do not imply live
combat integration or a performance budget has been accepted.

```sh
node --test test/combat-rules.test.js test/combat-collision.test.js \
  test/combat-collision-guards.test.js test/combat-collision-limits.test.js
node --test test/pearl-physics.test.js test/mob-difficulty.test.js
```

These checks cover facts/calculations, geometry, ordering, limits and stale
guards. They are not live damage, retaliation, Survival or performance evidence.

## Remaining integration gates

The next slice needs real owner-authorized hit preparations, one transient
runtime, unique per-owner transaction composition, difficulty persistence and
receipt-driven feedback. Shared blast processing and atomic ghast-shot
retirement/ticket admission must exist before migrating ghast flight. Creeper
source retirement needs its own atomic adapter; TNT provenance remains deferred.

Canonical save normalization, one Wildlife load and borrower adoption precede
transient combat resets. Both existing flight simulations must relinquish
authority exactly once at activation. Per-victim blast plans are prepared
sequentially; refusals never route through legacy damage or indefinitely retry.
Live owner, lifecycle, browser and performance acceptance remain mandatory.
