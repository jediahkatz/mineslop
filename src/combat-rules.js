import { difficultyMobDamage, difficultyPolicy } from "./mob-difficulty.js";

export const COMBAT_RULES_VERSION = "mineslop-combat-contract-v2";
export const HURT_WINDOW_SECONDS = 0.5;
export const PLAYER_CREDIT_SECONDS = 5;
export const BLAZE_IMPACT_DAMAGE = 5;

const nonnegative = (value) => Number.isFinite(value) && value >= 0;
const id = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 1200;
const actorKind = (value) => value === "player" || value === "mob";
const requireFact = (condition, message) => {
  if (!condition) throw new RangeError(message);
};

/**
 * Explicit immediate causes, not labels inferred from reward credit or a
 * shooter's current species/liveness. A reflected ghast shot may have a player
 * responsible for it. Burning arrows still have non-fire impact damage.
 *
 * `shield` is a category for a future owner calculation, not a block decision.
 * Ghast impact/explosion are distinct; this does not admit or deliver a blast.
 */
const attacks = Object.freeze({
  melee: Object.freeze({ damageType: "melee", shield: "directional", isFire: false, projectile: false }),
  arrow: Object.freeze({ damageType: "projectile", shield: "directional", isFire: false, projectile: true }),
  blaze_fireball: Object.freeze({ damageType: "fireball", shield: "directional", isFire: true, projectile: true }),
  ghast_fireball: Object.freeze({ damageType: "fireball", shield: "directional", isFire: true, projectile: true }),
  ghast_explosion: Object.freeze({ damageType: "explosion", shield: "directional", isFire: false, projectile: false }),
  creeper_explosion: Object.freeze({ damageType: "explosion", shield: "directional", isFire: false, projectile: false }),
  tnt_explosion: Object.freeze({ damageType: "explosion", shield: "directional", isFire: false, projectile: false }),
  guardian_beam: Object.freeze({ damageType: "magic", shield: "none", isFire: false, projectile: false }),
  guardian_thorns: Object.freeze({ damageType: "thorns", shield: "none", isFire: false, projectile: false }),
  fire_tick: Object.freeze({ damageType: "on_fire", shield: "none", isFire: true, projectile: false }),
});

/**
 * @param {{attackKind: string, responsibleKind: "player"|"mob"|"environment",
 *   victimKind: "player"|"mob"}} facts Immutable provenance/classification facts.
 * @returns {Readonly<object>} Classification only: never attack authorization,
 * victim ownership, a shield result, or reward eligibility.
 */
export function classifyCombatAttack({ attackKind, responsibleKind, victimKind } = {}) {
  requireFact(typeof attackKind === "string" && Object.hasOwn(attacks, attackKind),
    "Unknown combat attack kind");
  requireFact(actorKind(responsibleKind) || responsibleKind === "environment",
    "Unknown responsible actor kind");
  requireFact(actorKind(victimKind), "Unknown combat victim kind");
  requireFact(responsibleKind !== "environment" ||
    attackKind === "tnt_explosion" || attackKind === "fire_tick",
  "This immediate cause requires a responsible actor");
  const scaling = attackKind === "blaze_fireball" ? "fixed-blaze"
    : responsibleKind === "mob" && victimKind === "player" &&
      attackKind !== "tnt_explosion" && attackKind !== "fire_tick"
      ? "mob-to-player" : "none";
  return Object.freeze({
    attackKind, responsibleKind, victimKind, ...attacks[attackKind], scaling,
  });
}

/**
 * Raw FULL damage -> one difficulty selection -> FULL adjusted pre-armor damage.
 * Never pass a hurt-window delta here: Easy is nonlinear. Blaze small-fireball
 * impact is exactly five before defenses; conflicting raw facts reject.
 * Peaceful suppresses creature attacks (including creature-to-creature attacks)
 * without applying a difficulty multiplier to mob victims. Environmental TNT
 * and ongoing fire are not reclassified into difficulty-scaled creature hits.
 * Source death is intentionally not an input.
 */
export function adjustCombatDamage(facts = {}) {
  const classification = classifyCombatAttack(facts);
  const policy = difficultyPolicy(facts.difficulty);
  const rawDamage = facts.rawDamage;
  requireFact(nonnegative(rawDamage), "Raw combat damage must be finite and nonnegative");
  requireFact(classification.scaling !== "fixed-blaze" || rawDamage === BLAZE_IMPACT_DAMAGE,
    "Blaze small-fireball raw impact must be exactly five");
  const suppressed = classification.responsibleKind === "mob" &&
    !policy.mobCombat && classification.attackKind !== "tnt_explosion" &&
    classification.attackKind !== "fire_tick";
  const difficultyAdjustedFullDamage = suppressed ? 0
    : classification.scaling === "mob-to-player"
      ? difficultyMobDamage(rawDamage, policy.id) : rawDamage;
  return Object.freeze({
    ...classification, rawDamage, difficulty: policy.id, suppressed,
    difficultyAdjustedFullDamage,
  });
}

const species = {};
function speciesGroup(names, owner, retaliation, pack = false) {
  for (const name of names.split(" "))
    species[name] = Object.freeze({ owner, retaliation, pack });
}
speciesGroup("sheep pig cow chicken rabbit fox goat panda camel frog mooshroom cod squid sulfur_cube",
  "Wildlife", "flee");
speciesGroup("horse", "Horses", "flee");
speciesGroup("zombie skeleton stray husk spider enderman", "Wildlife", "revenge");
speciesGroup("wolf", "Wildlife", "wolf", true);
speciesGroup("polar_bear piglin", "Wildlife", "revenge", true);
speciesGroup("creeper", "Wildlife", "player-priority");
speciesGroup("slime ghast", "Wildlife", "none");
speciesGroup("dolphin", "GameEcologyServices", "neutral-capability", true);
speciesGroup("turtle villager", "GameEcologyServices", "flee");
speciesGroup("drowned", "GameEcologyServices", "revenge");
speciesGroup("blaze", "GameEcologyServices", "revenge", true);
speciesGroup("guardian elder_guardian", "GameEcologyServices", "none");

/**
 * Species matrix pinned to COMBAT_RULES_VERSION, a supported Java-style subset,
 * not a promise of full vanilla AI parity. In particular: skeletons can revenge
 * other skeletons; creepers prefer eligible players; ghasts/slimes/guardians get
 * no generic revenge. Dolphins require an actual damaging capability supplied
 * by their owner (the current passive ecology definition is NOT that proof).
 * Enderman projectile handling stays with the existing specialized policy.
 */
export const COMBAT_SPECIES_RULES = Object.freeze(species);

function speciesRule(name) {
  requireFact(typeof name === "string" && Object.hasOwn(COMBAT_SPECIES_RULES, name),
    "Unknown combat species");
  return COMBAT_SPECIES_RULES[name];
}

/**
 * Routing, never an ownership/admission receipt. ALL horses route to Horses:
 * retention, taming, saddle and sidecar presence do not select a fallback.
 * An unavailable/refusing selected owner must remain handled by that owner.
 */
export function combatVictimOwner({ kind, species: name } = {}) {
  requireFact(actorKind(kind), "Unknown combat victim kind");
  return kind === "player" ? "Gameplay" : speciesRule(name).owner;
}

function targetFact(target) {
  if (target === null) return;
  requireFact(target && actorKind(target.kind) && id(target.id) &&
    typeof target.eligible === "boolean" &&
    (target.playerOwnerId == null || id(target.playerOwnerId)),
  "Invalid retaliation target facts");
  if (target.kind === "mob") speciesRule(target.species);
}

const reaction = (kind, reason, target = null, alertPack = false) => Object.freeze({
  kind, reason, targetKind: target?.kind ?? null,
  targetId: target?.id ?? null, alertPack,
});

/**
 * Select ONE response; this neither acquires natural targets nor runs AI.
 * `eligible` must already include canonical identity, current life/liveness,
 * active/loaded body, dimension/epoch, range, leash and visibility-memory rules.
 * IDs here describe decisions, NOT a sufficient guard for a future attack.
 *
 * `lastKnownThreat` means a caller-validated bounded responsible-attacker point,
 * never the nearby player's pose. Pack output is a single new-transition hint;
 * the future runtime must inspect only bounded active peers, without recursion.
 *
 * @param {{victimSpecies:string, victimId:string, victimPlayerOwnerId?:string|null,
 *   victimCanDamage:boolean, healthDamage:number, attackKind:string,
 *   attacker?:object|null, currentRevenge?:object|null, playerTarget?:object|null,
 *   lastKnownThreat?:boolean}} facts Facts of an already committed damaging hit.
 */
export function decideCombatRetaliation({
  victimSpecies, victimId, victimPlayerOwnerId = null, victimCanDamage,
  healthDamage, attackKind, attacker = null, currentRevenge = null,
  playerTarget = null, lastKnownThreat = false,
} = {}) {
  const rule = speciesRule(victimSpecies);
  requireFact(id(victimId) && (victimPlayerOwnerId === null || id(victimPlayerOwnerId)) &&
    typeof victimCanDamage === "boolean" && nonnegative(healthDamage) &&
    typeof attackKind === "string" && Object.hasOwn(attacks, attackKind) &&
    typeof lastKnownThreat === "boolean",
  "Invalid retaliation facts");
  for (const target of [attacker, currentRevenge, playerTarget]) targetFact(target);
  requireFact(playerTarget === null || playerTarget.kind === "player",
    "Player priority requires a player target");
  if (healthDamage === 0) return reaction("none", "no-damaging-hit");
  if (victimSpecies === "enderman" && attacks[attackKind].projectile)
    return reaction("none", "preserve-enderman-projectile-policy");
  if (rule.retaliation === "none") return reaction("none", "species-no-revenge");

  const allowed = (target) => {
    if (!target?.eligible || (target.kind === "mob" && target.id === victimId)) return false;
    if (victimSpecies !== "wolf" || victimPlayerOwnerId === null) return true;
    return !(target.kind === "player" && target.id === victimPlayerOwnerId) &&
      target.playerOwnerId !== victimPlayerOwnerId;
  };
  const flee = () => allowed(attacker)
    ? reaction("flee", "responsible-attacker", attacker)
    : lastKnownThreat ? reaction("flee", "last-known-threat")
      : reaction("none", "no-eligible-threat");
  if (rule.retaliation === "flee") return flee();
  if (!victimCanDamage) return flee();
  if (rule.retaliation === "player-priority") {
    const existingPlayer = currentRevenge?.kind === "player" && allowed(currentRevenge);
    const preferred = allowed(playerTarget) ? playerTarget
      : attacker?.kind === "player" && allowed(attacker) ? attacker : null;
    // Do not switch between two valid players merely because another hit arrived.
    if (existingPlayer || preferred)
      return reaction(existingPlayer ? "keep" : "target", "creeper-player-priority",
        existingPlayer ? currentRevenge : preferred);
  }
  if (allowed(currentRevenge)) return reaction("keep", "existing-revenge", currentRevenge);
  if (!allowed(attacker)) return reaction("none", "attacker-unavailable-or-excluded");
  return reaction("target", "new-revenge", attacker, rule.pack);
}

function checkDt(dt) {
  requireFact(nonnegative(dt), "Admitted simulation dt must be finite and nonnegative");
}

function checkClock(clock, duration) {
  requireFact(nonnegative(clock.elapsedSeconds) && clock.elapsedSeconds <= duration &&
    Number.isFinite(clock.compensation) &&
    Math.abs(clock.compensation) <= Number.EPSILON * duration,
  "Invalid admitted-time clock");
}

// Compensated addition avoids an extra update of immunity/credit after decimal
// partitions such as ten 0.05s steps. No rounding to frames or wall-clock time.
function elapsedAfter(clock, dt, duration) {
  checkDt(dt);
  if (clock.elapsedSeconds >= duration || dt >= duration) return null;
  if (dt === 0) return {
    elapsedSeconds: clock.elapsedSeconds, compensation: clock.compensation,
  };
  const increment = dt - clock.compensation;
  const elapsedSeconds = clock.elapsedSeconds + increment;
  if (elapsedSeconds >= duration) return null;
  return {
    elapsedSeconds,
    compensation: (elapsedSeconds - clock.elapsedSeconds) - increment,
  };
}

function hurtFact(window) {
  if (window === null) return null;
  requireFact(window && nonnegative(window.difficultyAdjustedFullDamage) &&
    window.difficultyAdjustedFullDamage > 0, "Invalid full pre-armor hurt amount");
  checkClock(window, HURT_WINDOW_SECONDS);
  return window.elapsedSeconds >= HURT_WINDOW_SECONDS ? null : Object.freeze({
    difficultyAdjustedFullDamage: window.difficultyAdjustedFullDamage,
    elapsedSeconds: window.elapsedSeconds, compensation: window.compensation,
  });
}

/**
 * Advance once per admitted simulation step; pause supplies zero. Null denotes
 * no live window. Returned data is transient and is never a saved mob field.
 */
export function advanceHurtWindow(window, admittedDt) {
  checkDt(admittedDt);
  const current = hurtFact(window);
  if (!current) return null;
  const clock = elapsedAfter(current, admittedDt, HURT_WINDOW_SECONDS);
  return clock && Object.freeze({ ...current, ...clock });
}

/**
 * FULL difficulty-adjusted pre-armor amount -> incremental pre-armor amount.
 * Apply armor/effects ONLY to `preArmorDamage`; store the FULL amount. A stronger
 * in-window hit does not restart the clock. Caller installs `nextWindow` only
 * with its accepted damaging transaction, not on shields/immunity/refusal.
 * This is a calculation, NOT health loss, payment or attack authorization.
 */
export function decideHurtWindow(window, difficultyAdjustedFullDamage) {
  requireFact(nonnegative(difficultyAdjustedFullDamage),
    "Hurt comparison requires finite nonnegative FULL adjusted pre-armor damage");
  const current = hurtFact(window);
  const preArmorDamage = Math.max(0,
    difficultyAdjustedFullDamage - (current?.difficultyAdjustedFullDamage ?? 0));
  const nextWindow = preArmorDamage === 0 ? current : Object.freeze({
    difficultyAdjustedFullDamage,
    elapsedSeconds: current?.elapsedSeconds ?? 0,
    compensation: current?.compensation ?? 0,
  });
  return Object.freeze({ preArmorDamage, nextWindow });
}

function creditFact(credit) {
  if (credit === null) return null;
  requireFact(credit && id(credit.playerOwnerId), "Credit requires a stable player owner ID");
  checkClock(credit, PLAYER_CREDIT_SECONDS);
  return credit.elapsedSeconds >= PLAYER_CREDIT_SECONDS ? null : Object.freeze({
    playerOwnerId: credit.playerOwnerId,
    elapsedSeconds: credit.elapsedSeconds, compensation: credit.compensation,
  });
}

/** Only admitted simulation time expires credit. Saving/rendering do not call this. */
export function advanceCombatCredit(credit, admittedDt) {
  checkDt(admittedDt);
  const current = creditFact(credit);
  if (!current) return null;
  const clock = elapsedAfter(current, admittedDt, PLAYER_CREDIT_SECONDS);
  return clock && Object.freeze({ ...current, ...clock });
}

/**
 * Qualifying committed HEALTH loss refreshes five seconds of player credit.
 * `playerOwnerId` is explicit stable reward provenance, not a live player ref,
 * position, hand, life, attack authority or victim owner. An owned wolf may
 * qualify; other mobs do not. Source death does not erase travelling provenance.
 * Uncredited hits, misses, blocked/immune zero damage, refusals and DoT neither
 * refresh nor erase existing credit. DoT may carry provenance without renewal.
 */
export function decideCombatCredit(credit, {
  committed, healthDamage, responsibleKind, responsibleSpecies = null,
  playerOwnerId = null, damageOverTime = false,
} = {}) {
  const current = creditFact(credit);
  requireFact(typeof committed === "boolean" && nonnegative(healthDamage) &&
    (actorKind(responsibleKind) || responsibleKind === "environment") &&
    (playerOwnerId === null || id(playerOwnerId)) && typeof damageOverTime === "boolean",
  "Invalid committed-hit credit facts");
  if (responsibleKind === "mob") speciesRule(responsibleSpecies);
  const qualifies = committed && healthDamage > 0 && !damageOverTime &&
    playerOwnerId !== null && (responsibleKind === "player" ||
      (responsibleKind === "mob" && responsibleSpecies === "wolf"));
  return qualifies ? Object.freeze({
    playerOwnerId, elapsedSeconds: 0, compensation: 0,
  }) : current;
}
