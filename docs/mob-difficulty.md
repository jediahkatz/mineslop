# Difficulty integration contract

`src/mob-difficulty.js` is a renderer-free, side-effect-free policy. Game,
saved-world settings, UI and the active entity owners remain the parent's
integration surfaces. `mob-ai.js` consumes its combat/suppression policy; the
parent supplies the world setting and admission, damage and lifecycle wiring.

## Modes

- Canonical saved values: `peaceful`, `easy`, `normal`, `hard`. Policy records
  provide the display labels Peaceful/Easy/Normal/Hard.
- `normalizeDifficulty(undefined)` migrates a missing legacy field to Normal.
  Explicit `null`, unknown strings, incorrect casing, numbers and booleans
  throw `RangeError`. Validate before installing any new settings or owner.
  Do not use a falsy/nullish fallback before this validation.
- Peaceful denies new hostile/watchful admissions and all creature-to-player
  danger, including neutral retaliation, projectiles, explosions and thorns.
- Easy incoming creature damage is `min(base, base / 2 + 1)`; weak hits are
  never increased. Normal preserves raw damage exactly; Hard uses `base * 1.5`.
  Species health, attack cooldowns, telegraphs and rewards stay the same.
- Easy/Normal/Hard share the existing hostile cap. Call
  `hostileLimitForDifficulty(difficulty, MAX_HOSTILES)` (currently 10). Peaceful
  returns 0. Keep `maxEntities`, per-species caps and loaded/collider checks.
  Changing difficulty never trims an existing population to a smaller cap.
- Passive density, habitat, species weights and spawn-attempt scheduling are
  independent of difficulty. This is intentionally not a spawn multiplier.

## Admission and damage hooks

1. Supply the normalized setting as `wildlife.context.difficulty` before the
   first admission, wake or simulation step, including world/dimension restore.
2. Gate all new spawns, including authored and ecology spawns, with
   `mobSpawnAllowedByDifficulty(spec, difficulty)`. In `Wildlife.populate()` and
   `GameEcologyServices._spawnAllowed()`, combine that gate with the hostile
   limit. Do not redirect rejected hostile attempts into extra passive attempts.
   Do not run this gate as a filter over saved identities.
3. Gate AI targeting/retaliation, ranged launch, fuse detonation, explosion
   world edits and source-owned harmful effects using
   `difficultyPolicy(difficulty).mobCombat`. In particular,
   `stepMob()`, `ecologyCanTarget()`, `Wildlife.shoot()`, `explodeMob()`,
   `explosion()` and projectile impact need the same current policy.
   Zero damage alone does not prevent terrain destruction or mining fatigue.
4. At the common `Wildlife.damagePlayer()` boundary, compute
   `difficultyMobDamage(amount, difficulty)` ONCE before decrementing context
   health, invoking `onDamage`, or choosing a wolf-defense target. A zero result
   returns without those side effects. Let Gameplay apply armor/shields/effects
   afterward and reconcile actual health as today. Keep AI/projectile damage
   raw; do not also scale it when launching or when calling `onDamage`.
   Apply the same hook to any creature attack bypassing that common boundary.
   Player attacks, environmental damage and existing potion owners are separate.
5. Capture the difficulty value/revision in prepared spawn and hostile-action
   guards, and recheck it at commit. Switching modes must invalidate an admission
   or hit prepared under a different policy, even when both modes allow combat.

## Entering, restoring and leaving Peaceful

Resolve `mobDifficultyAction(mob, difficulty, { owned, saddled })` using the real
ownership sidecars. Native `mob.tamed`/`mob.saddled` booleans are also recognized.
These are preservation hints, never authority to move or ride a creature.

- `keep`: ordinary behavior; this is not an instruction to wake a dormant mob.
- `pacify`: preserve the visible body, identity, HP, inventory and ownership;
  continue passive behavior with all creature combat disabled.
- `suspend`: retain the live identity, pose, HP and domain records, but skip
  simulation, picking, damage and wake while Peaceful. In particular, suspend
  before sunlight/gravity/cull processing so the mode switch cannot cause a
  death/drop. Unique encounter members remain alive and incomplete.

On Peaceful entry/restore, apply the detached `peacefulMobCombatReset(spec)` to
retained actors. It clears anger, stare, fuse and attack flags and restores only
the species' existing valid cooldown. Clear `Wildlife.projectiles`,
`defendTarget`/`defendUntil`, and hostile source AI intents, beams, burst shots
and harmful effects. `GameEcologyServices.clearIntent(mob)` clears that source's
AI, effects and attack render records; `clearAttacks()` clears the shared attack
pool. Preserve unrelated beneficial effects and ownership state.

Ecology residents can use the existing `suspendEcology(mob)` path, with a
Peaceful guard added to `canWake()` including actors already active. For legacy
hostiles, retain their existing bounded records and derive runtime suppression;
`dormant = true` alone is insufficient because the normal update loop resets it.
Do not add an unbounded secondary archive or change the strict mob-save schema.

Never call `damage()`, `remove()`, `rememberKilled()`, prepared death/drop/XP
operations or `prepareEncounterComplete()` as part of a difficulty transition.
Do not filter out owned/saddled creatures or persistent encounter members on
save/load. Restore saved records first and rederive suppression from difficulty.
On exit, apply the combat reset again before reactivation so hits received while
Peaceful cannot leave armed retaliation or an exhausted cooldown. Normal
loaded-space, distance and capacity rules govern waking; fresh combat windups
are required. Do not resurrect dead/tombstoned mobs or replay discarded
projectiles.

## Verification

After the parent's complete-delivery checkpoint, run from
`/tmp/mineslop-development`:

```sh
node --test test/mob-difficulty.test.js
```

The tests cover strict legacy/default handling, hostile-only admission, bounded
caps, combat scaling, ownership and persistent-encounter preservation, and pure
combat resets. Once the parent wires the owners, exercise live mode switches,
reload and dimension travel with an in-flight arrow/fireball, lit creeper fuse,
guardian beam/mining fatigue, owned mount and incomplete elder encounter; use
the existing mob/ecology lifecycle suites and `mise run test` for regression
coverage. The accompanying `animal-spawn-integration.md` documents the full
behavior, motion-ownership, vocalization and natural-spawn contract.
