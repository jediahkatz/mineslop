/**
 * Pure combat/admission policy. Passive density, habitats, species weights,
 * health, loot and spawn/GPU budgets do not depend on difficulty.
 *
 * Peaceful blocks all creature-to-player combat and new hostile/watchful mobs.
 * Easy uses min(base, base / 2 + 1), Normal preserves base, Hard uses base * 1.5.
 * All non-Peaceful modes retain the caller's existing hostile population cap.
 * See ../docs/mob-difficulty.md for safe live-switch and persistence hooks.
 */
const policies = Object.freeze(
  Object.fromEntries(
    [
      ["peaceful", "Peaceful", false],
      ["easy", "Easy", true],
      ["normal", "Normal", true],
      ["hard", "Hard", true],
    ].map(([id, label, combat]) => [
      id,
      Object.freeze({
        id,
        label,
        hostileSpawns: combat,
        mobCombat: combat,
      }),
    ])
  )
);

export const DEFAULT_DIFFICULTY = "normal";
export const DIFFICULTIES = Object.freeze(Object.keys(policies));

/** Only an absent legacy field defaults. null, casing errors and unknown
 * explicit values reject; save/UI callers must not use `value || "normal"`.
 */
export function normalizeDifficulty(value) {
  if (value === undefined) return DEFAULT_DIFFICULTY;
  if (typeof value !== "string" || !Object.hasOwn(policies, value))
    throw new RangeError(
      "Invalid difficulty: expected peaceful, easy, normal or hard"
    );
  return value;
}

export function difficultyPolicy(value) {
  return policies[normalizeDifficulty(value)];
}

function hostileSpecies(spec) {
  if (
    !["passive", "neutral", "hostile", "watchful"].includes(spec?.temperament)
  )
    throw new RangeError("Difficulty policy requires a known mob temperament");
  return spec.temperament === "hostile" || spec.temperament === "watchful";
}

/** Admission gate only, not habitat, distance, ownership or capacity admission.
 * Restoring a saved identity is NOT a new spawn: retain it and use the action
 * policy below, including unique persistent encounters.
 */
export function mobSpawnAllowedByDifficulty(spec, value) {
  const policy = difficultyPolicy(value);
  return !hostileSpecies(spec) || policy.hostileSpawns;
}

/** Never enlarges an existing host budget. The host still checks its total
 * entity/GPU and per-species caps independently, for all spawn paths.
 */
export function hostileLimitForDifficulty(value, normalLimit) {
  const policy = difficultyPolicy(value);
  if (!Number.isSafeInteger(normalLimit) || normalLimit < 0)
    throw new RangeError(
      "Hostile population limit must be a nonnegative integer"
    );
  return policy.hostileSpawns ? normalLimit : 0;
}

/** Apply ONCE to raw creature-to-player damage at the common damage boundary,
 * before armor/shields/effects, including projectiles, explosions and thorns.
 * Not for player attacks, mob health, fall/lava/starvation or other hazards.
 */
export function difficultyMobDamage(baseDamage, value) {
  const { id } = difficultyPolicy(value);
  if (!Number.isFinite(baseDamage) || baseDamage < 0)
    throw new RangeError("Mob damage must be finite and nonnegative");
  const damage =
    id === "peaceful"
      ? 0
      : id === "easy"
        ? Math.min(baseDamage, baseDamage / 2 + 1)
        : id === "hard"
          ? baseDamage * 1.5
          : baseDamage;
  if (!Number.isFinite(damage))
    throw new RangeError("Difficulty-scaled mob damage is not finite");
  return damage;
}

/** Pure runtime disposition; NEVER a kill, deletion, completion or reward.
 * "keep": ordinary behavior; do not cull existing populations to fit a cap.
 * "pacify": keep the body/ownership and passive behavior, clear combat.
 * "suspend": retain identity, pose, HP and owner/encounter state; skip hostile
 * simulation, damage, picking and wake-up until non-Peaceful admission is safe.
 * Caller supplies sidecar ownership/saddle facts, not fabricated mob-save fields.
 */
export function mobDifficultyAction(
  mob,
  value,
  { owned = false, saddled = false } = {}
) {
  const policy = difficultyPolicy(value);
  const hostile = hostileSpecies(mob?.spec);
  if (typeof owned !== "boolean" || typeof saddled !== "boolean")
    throw new RangeError("Mob ownership protection flags must be boolean");
  if (policy.mobCombat || mob.dead === true) return "keep";
  const protectedCreature =
    owned || saddled || mob.tamed === true || mob.saddled === true;
  return hostile && !protectedCreature ? "suspend" : "pacify";
}

/** Detached combat reset for entering, restoring or leaving Peaceful. The host
 * also clears source-owned projectiles/beams/effects/AI intents. No HP, owner,
 * persistent encounter state, loot, pacification or follow timers are touched.
 * Retaining the species cooldown (not a difficulty multiplier) stays valid in
 * the existing mob snapshot schema and prevents an immediate resumed strike.
 */
export function peacefulMobCombatReset(spec) {
  if (!Number.isFinite(spec?.cooldown) || spec.cooldown < 0)
    throw new RangeError("Combat reset requires a finite species cooldown");
  return Object.freeze({
    angry: 0,
    lookTimer: 0,
    fuse: 0,
    fusing: false,
    attacking: false,
    attackCooldown: spec.cooldown,
  });
}
