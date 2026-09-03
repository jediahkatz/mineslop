import { normalizeSupportedPotion, potionEffect } from "./potion-rules.js";
import { TransactionCoordinator } from "./transactions.js";

export const STATUS_EFFECT_VERSION = 1;
export const STATUS_TICKS_PER_SECOND = 20;
// Safety bounds, not additional obtainable potion tiers or duration recipes.
export const MAX_STATUS_DURATION_TICKS = 72_000;
export const MAX_STATUS_STEP_SECONDS = 60;
export const STATUS_EFFECT_RESERVED_BYTES = 16_384;

// Java rules: minecraft.wiki/w/{Strength,Weakness,Haste,Poison,Regeneration,
// Fire_Resistance,Resistance,Status_effect}. Command-only periodic amplifiers
// needing additional hurt-cooldown behavior are intentionally not accepted.
const definition = (maxAmplifier, interval = 0) =>
  Object.freeze({ maxAmplifier, interval });
export const STATUS_EFFECT_TYPES = Object.freeze({
  speed: definition(4),
  slowness: definition(4),
  strength: definition(4),
  weakness: definition(4),
  water_breathing: definition(0),
  fire_resistance: definition(0),
  night_vision: definition(0),
  regeneration: definition(1, 50),
  poison: definition(1, 25),
  wither: definition(1, 40),
  haste: definition(4),
  mining_fatigue: definition(4),
  resistance: definition(4),
});
const effectIds = Object.keys(STATUS_EFFECT_TYPES).sort();
const EPSILON = 1e-9;
const noOp = () => {};
const boundedInteger = (value, min, max) =>
  Number.isSafeInteger(value) && value >= min && value <= max;
const dataRecord = (value, fields) =>
  value !== null &&
  typeof value === "object" &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
  Reflect.ownKeys(value).every((key) => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return (
      typeof key === "string" &&
      fields.includes(key) &&
      property.enumerable &&
      Object.hasOwn(property, "value")
    );
  });
const finiteRange = (value, min, max) =>
  Number.isFinite(value) && value >= min && value <= max;
const synchronous = (value) =>
  typeof value === "function" &&
  Object.prototype.toString.call(value) === "[object Function]";
const freeze = (value) => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

export function createStatusEffects() {
  return { version: STATUS_EFFECT_VERSION, tickRemainder: 0, effects: [] };
}

function normalizeLayer(value, id, fields = ["amplifier", "remainingTicks"]) {
  if (
    !dataRecord(value, fields) ||
    !boundedInteger(value.amplifier, 0, STATUS_EFFECT_TYPES[id].maxAmplifier) ||
    !boundedInteger(value.remainingTicks, 1, MAX_STATUS_DURATION_TICKS)
  )
    throw new RangeError("Invalid status effect duration or amplifier");
  return { amplifier: value.amplifier, remainingTicks: value.remainingTicks };
}

function fromLayers(id, layers) {
  const [active, ...hidden] = layers;
  return { id, ...active, ...(hidden.length ? { hidden } : {}) };
}

const layersOf = ({ amplifier, remainingTicks, hidden = [] }) => [
  { amplifier, remainingTicks },
  ...hidden,
];

/**
 * A bounded, canonical active effect plus useful weaker fallbacks. Hidden
 * durations count down too; loading replaces this state and never reapplies it.
 * Instant health/damage are intentionally NOT valid persistent effect IDs.
 */
export function normalizeStatusEffects(value = createStatusEffects()) {
  if (
    !dataRecord(value, ["version", "tickRemainder", "effects"]) ||
    value.version !== STATUS_EFFECT_VERSION ||
    !finiteRange(value.tickRemainder, 0, 1) ||
    value.tickRemainder === 1 ||
    !Array.isArray(value.effects) ||
    value.effects.length > effectIds.length
  )
    throw new RangeError("Invalid status effect state");
  const seen = new Set();
  const effects = Array.from(value.effects, (effect) => {
    if (
      !dataRecord(effect, ["id", "amplifier", "remainingTicks", "hidden"]) ||
      !effectIds.includes(effect.id) ||
      seen.has(effect.id)
    )
      throw new RangeError("Unknown or duplicate status effect");
    seen.add(effect.id);
    const active = normalizeLayer(effect, effect.id, [
      "id",
      "amplifier",
      "remainingTicks",
      "hidden",
    ]);
    const hidden = effect.hidden ?? [];
    if (
      !Array.isArray(hidden) ||
      hidden.length > STATUS_EFFECT_TYPES[effect.id].maxAmplifier
    )
      throw new RangeError("Too many hidden status effects");
    const layers = [active];
    for (const value of hidden) {
      const layer = normalizeLayer(value, effect.id);
      const previous = layers.at(-1);
      if (
        layer.amplifier >= previous.amplifier ||
        layer.remainingTicks <= previous.remainingTicks
      )
        throw new RangeError("Invalid hidden effect precedence");
      layers.push(layer);
    }
    return fromLayers(effect.id, layers);
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (!effects.length && value.tickRemainder !== 0)
    throw new RangeError("Fractional effect time without effects");
  return {
    version: STATUS_EFFECT_VERSION,
    tickRemainder: value.tickRemainder,
    effects,
  };
}

/** Stronger wins, equal strength refreshes only upward, weaker can outlive it. */
export function addStatusEffects(value, additions) {
  const state = normalizeStatusEffects(value);
  if (!Array.isArray(additions) || additions.length > effectIds.length)
    throw new RangeError("Invalid effect additions");
  for (const addition of additions) {
    if (
      !dataRecord(addition, ["id", "amplifier", "durationTicks"]) ||
      !effectIds.includes(addition.id)
    )
      throw new RangeError("Unsupported timed effect");
    const incoming = normalizeLayer(
      {
        amplifier: addition.amplifier,
        remainingTicks: addition.durationTicks,
      },
      addition.id
    );
    const index = state.effects.findIndex(({ id }) => id === addition.id);
    const layers = index < 0 ? [] : layersOf(state.effects[index]);
    const durations = new Map();
    for (const layer of [...layers, incoming])
      durations.set(
        layer.amplifier,
        Math.max(durations.get(layer.amplifier) ?? 0, layer.remainingTicks)
      );
    const retained = [];
    for (const amplifier of [...durations.keys()].sort((a, b) => b - a)) {
      const remainingTicks = durations.get(amplifier);
      if (remainingTicks > (retained.at(-1)?.remainingTicks ?? 0))
        retained.push({ amplifier, remainingTicks });
    }
    const next = fromLayers(addition.id, retained);
    if (index < 0) state.effects.push(next);
    else state.effects[index] = next;
  }
  return normalizeStatusEffects(state);
}

/** Milk/death use no ids (clear all); a specific cure may clear an explicit list. */
export function clearStatusEffects(value, ids = effectIds) {
  const state = normalizeStatusEffects(value);
  if (
    !Array.isArray(ids) ||
    ids.length > effectIds.length ||
    !Array.from(ids).every((id) => effectIds.includes(id))
  )
    throw new RangeError("Invalid effect removal");
  state.effects = state.effects.filter(({ id }) => !ids.includes(id));
  if (!state.effects.length) state.tickRemainder = 0;
  return state;
}

function modifiers(effects) {
  const level = (id) => {
    const effect = effects.find((entry) => entry.id === id);
    return effect ? effect.amplifier + 1 : 0;
  };
  const fatigue = level("mining_fatigue");
  // Java 26.2 retains MC-279819. The consistent 0.3^level fix is 26.3, not 26.2.
  // https://minecraft.wiki/w/Mining_Fatigue
  const fatigueMining = [1, 0.3, 0.09, 0.0027, 0.00081][Math.min(fatigue, 4)];
  return {
    movementMultiplier:
      (1 + 0.2 * level("speed")) * Math.max(0, 1 - 0.15 * level("slowness")),
    miningMultiplier: (1 + 0.2 * level("haste")) * fatigueMining,
    attackSpeedMultiplier:
      (1 + 0.1 * level("haste")) * Math.max(0, 1 - 0.1 * fatigue),
    meleeDamageBonus: 3 * level("strength") - 4 * level("weakness"),
    resistanceMultiplier: Math.max(0, 1 - 0.2 * level("resistance")),
    waterBreathing: level("water_breathing") > 0,
    fireImmune: level("fire_resistance") > 0,
    nightVision: level("night_vision") > 0 ? 1 : 0,
  };
}

export function statusModifiers(value) {
  return modifiers(normalizeStatusEffects(value).effects);
}

function nonnegative(value) {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError("Expected a finite nonnegative mechanic value");
  return value;
}

/** Speed/slowness change ground locomotion, not swimming or creative flight. */
export function modifyMovementSpeed(base, value, { kind = "ground" } = {}) {
  nonnegative(base);
  if (!["ground", "swim", "flight"].includes(kind))
    throw new RangeError("Invalid movement kind");
  const projection = statusModifiers(value);
  return kind === "ground" ? base * projection.movementMultiplier : base;
}

export function modifyMiningSpeed(base, value, { creative = false } = {}) {
  nonnegative(base);
  if (typeof creative !== "boolean") throw new RangeError("Invalid game mode");
  const projection = statusModifiers(value);
  return creative ? base : base * projection.miningMultiplier;
}

/** Apply to base attack attributes; the damage owner adds enchantment damage. */
export function modifyAttackDamage(base, value, { kind = "melee" } = {}) {
  nonnegative(base);
  if (!["melee", "projectile", "spear_charge"].includes(kind))
    throw new RangeError("Invalid attack kind");
  const projection = statusModifiers(value);
  return kind === "melee"
    ? Math.max(0, base + projection.meleeDamageBonus)
    : base;
}

const fireKinds = new Set([
  "fire",
  "in_fire",
  "on_fire",
  "lava",
  "magma",
  "hot_floor",
  "campfire",
  "fireball",
]);
const resistanceBypass = new Set(["starvation", "void", "kill"]);

/**
 * Fire immunity is tested before armor wear; resistance after ordinary armor
 * reduction. Neither removes burning state (Java can resume burn damage after
 * expiry). Explosions, blaze melee and a burning arrow's impact are NOT fire.
 */
export function modifyIncomingDamage(
  amount,
  value,
  { kind = "generic", isFire = false, bypassResistance = false } = {}
) {
  nonnegative(amount);
  if (
    typeof kind !== "string" ||
    typeof isFire !== "boolean" ||
    typeof bypassResistance !== "boolean"
  )
    throw new RangeError("Invalid damage classification");
  const projection = statusModifiers(value);
  if (projection.fireImmune && (isFire || fireKinds.has(kind))) return 0;
  return bypassResistance || resistanceBypass.has(kind)
    ? amount
    : amount * projection.resistanceMultiplier;
}

/**
 * Normalized Gameplay air defaults (20 units = 300 Java air ticks).
 * Since Java 1.21.4, Water Breathing REFILLS air underwater, not just freezes it.
 * https://minecraft.wiki/w/Water_Breathing
 * Supply the PRE-tick effects and the same active dt passed to advance below;
 * expiry inside a large step protects only the appropriate portion of that dt.
 */
export function advanceStatusBreathing(
  value,
  air,
  dt,
  { underwater = true, paused = false, maximum = 20 } = {}
) {
  const state = normalizeStatusEffects(value);
  if (
    !finiteRange(maximum, Number.MIN_VALUE, 1_000_000) ||
    !finiteRange(air, 0, maximum) ||
    typeof underwater !== "boolean" ||
    typeof paused !== "boolean"
  )
    throw new RangeError("Invalid breathing state");
  const elapsed =
    paused || !Number.isFinite(dt) || dt <= 0
      ? 0
      : Math.min(dt, MAX_STATUS_STEP_SECONDS);
  const effect = state.effects.find(({ id }) => id === "water_breathing");
  const protectedSeconds =
    underwater && effect
      ? Math.min(
          elapsed,
          Math.max(
            0,
            (effect.remainingTicks - state.tickRemainder) /
              STATUS_TICKS_PER_SECOND
          )
        )
      : 0;
  const refillRate = maximum / 3.75; // Four air ticks per tick, 300 maximum.
  if (!underwater)
    return {
      air: Math.min(maximum, air + elapsed * refillRate),
      drowningSeconds: 0,
      protectedSeconds: 0,
    };
  air = Math.min(maximum, air + protectedSeconds * refillRate);
  const exposed = elapsed - protectedSeconds;
  const drainRate = maximum / 15;
  return {
    air: Math.max(0, air - exposed * drainRate),
    drowningSeconds: Math.max(0, exposed - air / drainRate),
    protectedSeconds,
  };
}

/**
 * Explicit renderer hook. Apply to visual light only, NEVER world light used by
 * spawning/growth. The host may animate expiry; this domain avoids screen flash.
 */
export function nightVisionRenderHook(value) {
  const strength = statusModifiers(value).nightVision;
  return {
    strength,
    minimumVisualLight: strength,
    brightensUnderwater: strength > 0,
  };
}

export function applyNightVisionLight(light, value) {
  if (!finiteRange(light, 0, 1)) throw new RangeError("Invalid visual light");
  return Math.max(light, nightVisionRenderHook(value).minimumVisualLight);
}

function healthEvent(id, amount, tick, projection) {
  const heal = id === "regeneration" || id === "instant_health";
  return {
    tick,
    kind: heal ? "heal" : "damage",
    cause: id,
    amount,
    floor: id === "poison" ? 1 : 0,
    bypassArmor: true,
    resistanceMultiplier: heal ? 1 : projection.resistanceMultiplier,
  };
}

/**
 * Pure timer transition. Only the active layer pulses; hidden layers decrement
 * alongside it. Pulses use Java's remaining-duration modulo (before decrement),
 * so saving/loading cannot restart an independent regeneration/poison clock.
 * Bounded effect-expiry segments let the caller apply hazards without granting
 * a whole large frame of immunity to an effect that expires halfway through it.
 */
export function advanceStatusEffects(value, dt, { paused = false } = {}) {
  const state = normalizeStatusEffects(value);
  if (typeof paused !== "boolean") throw new RangeError("Invalid pause state");
  const elapsedSeconds =
    paused || !Number.isFinite(dt) || dt <= 0
      ? 0
      : Math.min(dt, MAX_STATUS_STEP_SECONDS);
  const result = {
    state,
    changed: false,
    elapsedTicks: 0,
    elapsedSeconds,
    gameplayPlan: { health: [] },
    segments: [],
    expired: [],
  };
  if (!elapsedSeconds) return result;
  if (!state.effects.length) {
    result.segments.push({
      fromTick: 0,
      ticks: 0,
      fromSeconds: 0,
      seconds: elapsedSeconds,
      modifiers: modifiers([]),
    });
    return result;
  }
  const initialRemainder = state.tickRemainder;
  const total = initialRemainder + elapsedSeconds * STATUS_TICKS_PER_SECOND;
  let ticks = Math.floor(total + EPSILON);
  const remainder = Math.max(0, total - ticks);
  result.elapsedTicks = ticks;
  result.changed = ticks > 0 || remainder !== state.tickRemainder;
  let elapsed = 0;
  let coveredSeconds = 0;
  while (ticks > 0) {
    const span = Math.min(
      ticks,
      ...state.effects.map((effect) => effect.remainingTicks)
    );
    const projection = modifiers(state.effects);
    const untilSeconds = Math.min(
      elapsedSeconds,
      (elapsed + span - initialRemainder) / STATUS_TICKS_PER_SECOND
    );
    result.segments.push({
      fromTick: elapsed,
      ticks: span,
      fromSeconds: coveredSeconds,
      seconds: untilSeconds - coveredSeconds,
      modifiers: projection,
    });
    coveredSeconds = untilSeconds;
    for (const effect of state.effects) {
      const spec = STATUS_EFFECT_TYPES[effect.id];
      if (!spec.interval) continue;
      const interval = Math.max(
        1,
        Math.floor(spec.interval / 2 ** effect.amplifier)
      );
      for (
        let offset = (effect.remainingTicks % interval) + 1;
        offset <= span;
        offset += interval
      )
        result.gameplayPlan.health.push(
          healthEvent(effect.id, 1, elapsed + offset, projection)
        );
    }
    state.effects = state.effects.flatMap((effect) => {
      const remaining = layersOf(effect)
        .map((layer) => ({
          ...layer,
          remainingTicks: layer.remainingTicks - span,
        }))
        .filter((layer) => layer.remainingTicks > 0);
      if (remaining.length) return [fromLayers(effect.id, remaining)];
      result.expired.push(effect.id);
      return [];
    });
    elapsed += span;
    ticks -= span;
  }
  // Fractional frames still need hazard coverage, especially the unprotected
  // part after the last effect expires. Consumers use seconds, not ticks / 20.
  if (coveredSeconds < elapsedSeconds)
    result.segments.push({
      fromTick: elapsed,
      ticks: 0,
      fromSeconds: coveredSeconds,
      seconds: elapsedSeconds - coveredSeconds,
      modifiers: modifiers(state.effects),
    });
  state.tickRemainder = state.effects.length ? remainder : 0;
  result.gameplayPlan.health.sort(
    (a, b) => a.tick - b.tick || a.cause.localeCompare(b.cause)
  );
  return result;
}

/**
 * A splash distance is the closest distance between the projectile's impact
 * hitbox and the target's hitbox, NOT center-to-center or impact-point distance.
 * The caller must first select entities inside the Java impact AABB expanded
 * by (4,2,4). Java uses full drink duration, nearest-tick rounding, and ignores
 * non-instant splash effects with <=20 ticks remaining.
 * https://minecraft.wiki/w/Splash_Potion
 */
export function splashExposure({ distance, directHit = false } = {}) {
  if (
    !Number.isFinite(distance) ||
    distance < 0 ||
    typeof directHit !== "boolean"
  )
    throw new RangeError("Invalid splash exposure");
  return directHit ? 1 : Math.max(0, 1 - distance / 4);
}

function targetFlags(target = {}) {
  if (
    !dataRecord(target, [
      "undead",
      "ignoresPoisonAndRegeneration",
      "poisonImmune",
      "effectImmune",
    ])
  )
    throw new RangeError("Invalid potion target");
  const {
    undead = false,
    ignoresPoisonAndRegeneration = undead,
    poisonImmune = false,
    effectImmune = false,
  } = target;
  if (
    ![undead, ignoresPoisonAndRegeneration, poisonImmune, effectImmune].every(
      (flag) => typeof flag === "boolean"
    )
  )
    throw new RangeError("Invalid potion target");
  return { undead, ignoresPoisonAndRegeneration, poisonImmune, effectImmune };
}

/** Instant effects are explicit Gameplay plans, NEVER persistent timers or writes. */
export function planPotionApplication(
  value,
  potionData,
  { splash, target } = {}
) {
  const state = normalizeStatusEffects(value);
  const potion = normalizeSupportedPotion(potionData);
  const flags = targetFlags(target);
  if ((potion.form === "splash") !== (splash !== undefined))
    throw new RangeError("Potion form does not match its application");
  const factor = splash === undefined ? 1 : splashExposure(splash);
  const effect = potionEffect(potion);
  const result = {
    state,
    gameplayPlan: { health: [] },
    applied: false,
    // The impact owner handles extinguishing and water-sensitive entities.
    splashWater:
      potion.id === "water" && potion.form === "splash" && factor > 0,
  };
  if (!effect || factor === 0 || flags.effectImmune) return result;
  if (
    (["poison", "regeneration"].includes(effect.id) &&
      flags.ignoresPoisonAndRegeneration) ||
    (effect.id === "poison" && flags.poisonImmune)
  )
    return result;
  if (effect.durationTicks === 0) {
    const heals = (effect.id === "instant_health") !== flags.undead;
    const amount = Math.floor(
      (heals ? 4 : 6) * 2 ** effect.amplifier * factor + 0.5
    );
    if (amount > 0) {
      result.gameplayPlan.health.push(
        healthEvent(
          heals ? "instant_health" : "instant_damage",
          amount,
          0,
          modifiers(state.effects)
        )
      );
      result.applied = true;
    }
    return result;
  }
  const durationTicks = Math.floor(effect.durationTicks * factor + 0.5);
  if (splash !== undefined && durationTicks <= STATUS_TICKS_PER_SECOND)
    return result;
  result.state = addStatusEffects(state, [{ ...effect, durationTicks }]);
  result.applied = true;
  return result;
}

/**
 * Reduce a plan against a DETACHED Gameplay draft/target snapshot. Magic bypasses
 * ordinary armor/shields, but Resistance and Protection still reduce damage.
 * Poison never lowers health below 1; regeneration/healing never resurrect.
 * Health changes are processed in tick order, not aggregated (floors matter).
 */
export function projectStatusHealth(
  vitals,
  plan,
  { maximum = 20, invulnerable = false, protectionFactor = 0, target } = {}
) {
  const flags = targetFlags(target);
  if (
    !finiteRange(maximum, Number.MIN_VALUE, 1_000_000) ||
    !finiteRange(vitals?.health, 0, maximum) ||
    typeof vitals.dead !== "boolean" ||
    vitals.dead !== (vitals.health === 0) ||
    (vitals.deathCause !== null &&
      (typeof vitals.deathCause !== "string" ||
        vitals.deathCause.length > 80)) ||
    (!vitals.dead && vitals.deathCause !== null) ||
    typeof invulnerable !== "boolean" ||
    !finiteRange(protectionFactor, 0, 20) ||
    !dataRecord(plan, ["health"]) ||
    !Array.isArray(plan.health) ||
    plan.health.length > MAX_STATUS_STEP_SECONDS * STATUS_TICKS_PER_SECOND * 3
  )
    throw new RangeError("Invalid status health plan");
  const next = {
    health: vitals.health,
    dead: vitals.dead,
    deathCause: vitals.deathCause,
    damageTaken: 0,
    healed: 0,
  };
  let previousTick = -1;
  for (const event of plan.health) {
    if (
      !dataRecord(event, [
        "tick",
        "kind",
        "cause",
        "amount",
        "floor",
        "bypassArmor",
        "resistanceMultiplier",
      ]) ||
      !boundedInteger(
        event.tick,
        0,
        MAX_STATUS_STEP_SECONDS * STATUS_TICKS_PER_SECOND
      ) ||
      event.tick < previousTick ||
      !["heal", "damage"].includes(event.kind) ||
      ![
        "instant_health",
        "instant_damage",
        "poison",
        "regeneration",
        "wither",
      ].includes(event.cause) ||
      (event.kind === "heal") !==
        ["instant_health", "regeneration"].includes(event.cause) ||
      !finiteRange(event.amount, 0, 128) ||
      event.floor !== (event.cause === "poison" ? 1 : 0) ||
      event.bypassArmor !== true ||
      !finiteRange(event.resistanceMultiplier, 0, 1)
    )
      throw new RangeError("Invalid health event");
    previousTick = event.tick;
    if (
      next.dead ||
      flags.effectImmune ||
      (["poison", "regeneration"].includes(event.cause) &&
        flags.ignoresPoisonAndRegeneration) ||
      (event.cause === "poison" && flags.poisonImmune)
    )
      continue;
    if (event.kind === "heal") {
      const amount = Math.min(maximum - next.health, event.amount);
      next.health += amount;
      next.healed += amount;
    } else if (!invulnerable) {
      const amount =
        event.amount * event.resistanceMultiplier * (1 - protectionFactor / 25);
      const taken = Math.min(Math.max(0, next.health - event.floor), amount);
      next.health -= taken;
      next.damageTaken += taken;
      if (next.health === 0) {
        next.dead = true;
        next.deathCause = event.cause;
      }
    }
  }
  return next;
}

/**
 * One bounded effect owner per entity, on the SAME coordinator as Gameplay,
 * Settlement, World and projectiles. It owns no inventory and no live vitals.
 * Fixed reservation avoids serializing the effect domain on every frame.
 */
export class StatusEffects {
  #state;
  #revision = 0;
  #disposed = false;
  #sealed = false;

  constructor({
    coordinator,
    state,
    onChange = noOp,
    allowOverBudget = false,
  } = {}) {
    if (
      !(coordinator instanceof TransactionCoordinator) ||
      !synchronous(onChange) ||
      typeof allowOverBudget !== "boolean"
    )
      throw new RangeError("Status effects require the shared coordinator");
    this.#state = freeze(normalizeStatusEffects(state));
    this.coordinator = coordinator;
    this.onChange = onChange;
    if (
      !coordinator.register(this, STATUS_EFFECT_RESERVED_BYTES, {
        allowOverBudget,
      })
    )
      throw new RangeError("Cannot reserve status effects");
  }

  get revision() {
    return this.#revision;
  }
  get reservedBytes() {
    return this.#disposed ? 0 : STATUS_EFFECT_RESERVED_BYTES;
  }
  get hasActiveEffects() {
    return this.#state.effects.length > 0;
  }
  get modifiers() {
    return modifiers(this.#state.effects);
  }
  get renderHook() {
    return nightVisionRenderHook(this.#state);
  }
  serialize() {
    return normalizeStatusEffects(this.#state);
  }

  // Read-only runtime projections avoid taking an archive snapshot each frame.
  modifyMovementSpeed(base, options) {
    return modifyMovementSpeed(base, this.#state, options);
  }
  modifyMiningSpeed(base, options) {
    return modifyMiningSpeed(base, this.#state, options);
  }
  modifyAttackDamage(base, options) {
    return modifyAttackDamage(base, this.#state, options);
  }
  modifyIncomingDamage(amount, options) {
    return modifyIncomingDamage(amount, this.#state, options);
  }
  advanceBreathing(air, dt, options) {
    return advanceStatusBreathing(this.#state, air, dt, options);
  }
  applyNightVisionLight(light) {
    return applyNightVisionLight(light, this.#state);
  }

  /** Previews, including instant no-op effect guards, are detached/single-use. */
  prepare(value, { notify = true } = {}) {
    if (this.#disposed || typeof notify !== "boolean") return null;
    let next;
    try {
      next = freeze(normalizeStatusEffects(value));
    } catch {
      return null;
    }
    const before = this.#state;
    const revision = this.#revision;
    const coordinator = this.coordinator;
    let used = false;
    return Object.freeze({
      owner: this,
      beforeBytes: STATUS_EFFECT_RESERVED_BYTES,
      afterBytes: STATUS_EFFECT_RESERVED_BYTES,
      validate: () =>
        !used &&
        !this.#disposed &&
        this.#revision === revision &&
        this.#state === before &&
        this.coordinator === coordinator &&
        coordinator.usage(this) === STATUS_EFFECT_RESERVED_BYTES,
      publish: () => {
        used = true;
        this.#state = next;
        this.#revision++;
      },
      ...(notify ? { notify: () => this.onChange(this.serialize()) } : {}),
    });
  }

  preparePotion(potion, options = {}) {
    if (
      this.#disposed ||
      !dataRecord(options, ["splash", "target", "notify"]) ||
      (options.notify !== undefined && typeof options.notify !== "boolean")
    )
      return null;
    try {
      const plan = planPotionApplication(this.#state, potion, options);
      const participant = this.prepare(plan.state, {
        notify: options.notify ?? true,
      });
      return participant ? { ...plan, participant } : null;
    } catch {
      return null;
    }
  }

  prepareAdvance(dt, options = {}) {
    if (
      this.#disposed ||
      !dataRecord(options, ["paused", "notify"]) ||
      (options.notify !== undefined && typeof options.notify !== "boolean")
    )
      return null;
    try {
      const plan = advanceStatusEffects(this.#state, dt, options);
      const participant = plan.changed
        ? this.prepare(plan.state, { notify: options.notify ?? false })
        : null;
      return plan.changed && !participant ? null : { ...plan, participant };
    } catch {
      return null;
    }
  }

  prepareClear(ids, options) {
    if (this.#disposed) return null;
    try {
      return this.prepare(clearStatusEffects(this.#state, ids), options);
    } catch {
      return null;
    }
  }

  /** Replaces timers only; cannot replay healing or infer offline/day elapsed time. */
  load(value, options = {}) {
    if (
      this.#sealed ||
      !dataRecord(options, ["notify"]) ||
      (options.notify !== undefined && typeof options.notify !== "boolean")
    )
      return false;
    const participant = this.prepare(value, {
      notify: options.notify ?? false,
    });
    return participant !== null && this.coordinator.commit([participant]).ok;
  }

  /** Activated hosts replace complete candidates, never one timer sidecar. */
  seal() {
    if (this.#disposed || !this.coordinator.register(
      this, STATUS_EFFECT_RESERVED_BYTES, { allowOverBudget: true }
    )) return false;
    this.#sealed = true;
    return true;
  }

  dispose() {
    if (this.#disposed || !this.coordinator.release(this)) return false;
    this.#disposed = true;
    this.#revision++;
    return true;
  }
}
