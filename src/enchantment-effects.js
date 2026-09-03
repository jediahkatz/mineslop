import {
  dataRecord,
  finite,
  immutable,
  integer,
  isEnchantmentCarrier,
  randomUnit,
} from "./enchantment-domain.js";
import { ENCHANTMENT_RULES, getEnchantmentRule } from "./enchantment-rules.js";
import { isValidExperience } from "./experience.js";
import { normalizeStack } from "./inventory-slots.js";
import { enchantmentLevel, getEnchantment } from "./item-stack-data.js";
import { getItem } from "./items.js";

/**
 * Pure, effect-backed integration hooks. No ticks, loot IDs, inventory writes,
 * implicit Math.random, or animation-only promises. Call these at the owning
 * mechanic, using UNMODIFIED base stats; do not also add resolveItemStats's
 * projections for the same enchantment. Random samples belong to the caller's
 * prepared RNG state and must not advance a live RNG on failed transactions.
 * That effects RNG is separate from the table's player enchanting seed: wearing
 * gear, repairing with XP or fishing must not reroll enchanting-table offers.
 *
 * Sources:
 * https://minecraft.wiki/w/Efficiency
 * https://minecraft.wiki/w/Fortune
 * https://minecraft.wiki/w/Protection
 * https://minecraft.wiki/w/Respiration
 * https://minecraft.wiki/w/Depth_Strider
 * https://minecraft.wiki/w/Unbreaking
 * https://minecraft.wiki/w/Mending
 * https://minecraft.wiki/w/Fishing
 * https://raw.githubusercontent.com/misode/mcmeta/26.2-data/data/minecraft/loot_table/gameplay/fishing.json
 */
const armorSlots = ["head", "chest", "legs", "feet"];
const equippedSlots = ["main", "offhand", ...armorSlots];

function flag(value, label) {
  if (typeof value !== "boolean") throw new RangeError(`Invalid ${label}`);
  return value;
}

function level(value, name) {
  return integer(value, `${name} level`, 0, ENCHANTMENT_RULES[name].maxLevel);
}

/** Stored book enchantments never act as equipped effects. */
export function activeEnchantmentLevel(stack, name, context) {
  if (stack === null || stack === undefined) return 0;
  const clean = normalizeStack(stack, context);
  const item = getItem(clean.id);
  const definition = getEnchantment(name);
  return getEnchantmentRule(name) &&
    definition?.eligible(item) &&
    !isEnchantmentCarrier(item)
    ? enchantmentLevel(clean, name, context)
    : 0;
}

/**
 * Apply Efficiency only to effective tools with base mining speed > 1. Aqua
 * Affinity removes only the underwater /5 penalty, not the airborne /5 penalty.
 * Haste, fatigue, hardness, harvest permission and block ownership stay outside.
 */
export function miningSpeed(
  baseSpeed,
  tool,
  {
    effectiveTool = false,
    submerged = false,
    onGround = true,
    helmet = null,
    context,
  } = {}
) {
  finite(baseSpeed, "base mining speed");
  flag(effectiveTool, "effective tool flag");
  flag(submerged, "submerged flag");
  flag(onGround, "grounded flag");
  const efficiency = activeEnchantmentLevel(tool, "efficiency", context);
  const affinity = activeEnchantmentLevel(helmet, "aqua_affinity", context);
  let speed = baseSpeed;
  if (effectiveTool && baseSpeed > 1 && efficiency)
    speed += efficiency ** 2 + 1;
  if (submerged && !affinity) speed /= 5;
  if (!onGround) speed /= 5;
  return speed;
}

/**
 * baseDamage is the unenchanted melee component AFTER charge/critical scaling.
 * Java adds the enchantment bonus separately, scaled by attack strength but not
 * the critical multiplier. Do not pass a bow's projectile damage here.
 */
export function meleeDamage(
  baseDamage,
  weapon,
  { targetFamily = "other", attackStrength = 1, context } = {}
) {
  finite(baseDamage, "base melee damage");
  finite(attackStrength, "attack strength", 0, 1);
  const sharpness = activeEnchantmentLevel(weapon, "sharpness", context);
  const smite = activeEnchantmentLevel(weapon, "smite", context);
  const bonus =
    (sharpness ? 0.5 * sharpness + 0.5 : 0) +
    (targetFamily === "undead" ? 2.5 * smite : 0);
  return baseDamage + bonus * attackStrength;
}

/** Power modifies a bow projectile's damage before its critical random bonus. */
export function bowDamage(baseDamage, bow, context) {
  finite(baseDamage, "base projectile damage");
  const power = activeEnchantmentLevel(bow, "power", context);
  return baseDamage * (power ? 1 + 0.25 * (power + 1) : 1);
}

function equippedArmor(equipment, context) {
  dataRecord(equipment, armorSlots, "equipped armor");
  return armorSlots.map((slot) => {
    const stack = equipment[slot] ?? null;
    if (stack === null) return null;
    const clean = normalizeStack(stack, context);
    if (getItem(clean.id).equipmentSlot !== slot)
      throw new RangeError("Armor is in the wrong equipment slot");
    return clean;
  });
}

/**
 * EPF is applied AFTER armor/toughness, not added to armor points. Fall/pearl
 * damage skips armor but may still use Protection and Feather Falling. Feed
 * the source's bypass-enchantments classification explicitly for other kinds.
 */
export function reduceEnchantedDamage(
  damage,
  equipment,
  { damageType = "generic", bypassesEnchantments = false, context } = {}
) {
  finite(damage, "incoming damage");
  flag(bypassesEnchantments, "enchantment bypass flag");
  const armor = equippedArmor(equipment, context);
  if (
    bypassesEnchantments ||
    ["starvation", "void", "sonic_boom", "kill"].includes(damageType)
  )
    return damage;
  let factor = 0;
  for (const stack of armor) {
    factor += activeEnchantmentLevel(stack, "protection", context);
    if (damageType === "projectile")
      factor +=
        2 * activeEnchantmentLevel(stack, "projectile_protection", context);
    if (damageType === "fall" || damageType === "pearl")
      factor += 3 * activeEnchantmentLevel(stack, "feather_falling", context);
  }
  return damage * (1 - Math.min(20, factor) / 25);
}

/**
 * Apply once to each underwater air-decrement tick, including the negative-air
 * countdown used for drowning. Do not ALSO roll a separate drowning reduction.
 * Refilling air, Water Breathing and turtle-shell air are owned by the caller.
 */
export function respirationAirLoss(helmet, roll, context) {
  randomUnit(roll);
  const respiration = activeEnchantmentLevel(helmet, "respiration", context);
  return roll < 1 / (respiration + 1) ? 1 : 0;
}

/**
 * Horizontal water movement: add L/3 water-movement efficiency, with half the
 * interpolation while airborne. Pass sprint/effect-adjusted base water drag
 * and land acceleration. Do not modify vertical velocity with Depth Strider.
 */
export function waterMovement(
  boots,
  {
    waterDrag = 0.8,
    waterAcceleration = 0.02,
    landAcceleration = 0.1,
    onGround = true,
    context,
  } = {}
) {
  finite(waterDrag, "water drag", 0, 1);
  finite(waterAcceleration, "water acceleration");
  finite(landAcceleration, "land acceleration");
  flag(onGround, "grounded flag");
  const efficiency =
    activeEnchantmentLevel(boots, "depth_strider", context) / 3;
  const interpolation = efficiency * (onGround ? 1 : 0.5);
  return immutable({
    waterMovementEfficiency: efficiency,
    drag: waterDrag + (0.54600006 - waterDrag) * interpolation,
    acceleration:
      waterAcceleration +
      (landAcceleration - waterAcceleration) * interpolation,
  });
}

export function durabilityUseChance(stack, context) {
  const clean = normalizeStack(stack, context);
  const item = getItem(clean.id);
  if (!item.durability)
    throw new RangeError("Durability requires durable equipment");
  const unbreaking = activeEnchantmentLevel(clean, "unbreaking", context);
  return item.equipmentSlot
    ? 0.6 + 0.4 / (unbreaking + 1)
    : 1 / (unbreaking + 1);
}

/** One independent sample per point of vanilla wear, not one roll per action. */
export function durabilityLoss(stack, rolls, context) {
  if (!Array.isArray(rolls) || rolls.length > 65536)
    throw new RangeError("Invalid durability samples");
  Array.from(rolls).forEach(randomUnit);
  const chance = durabilityUseChance(stack, context);
  return rolls.reduce((loss, roll) => loss + Number(roll < chance), 0);
}

/** Vanilla ore_drops bonus; two outcomes have multiplier 1. */
export function fortuneOreMultiplier(fortune, roll) {
  level(fortune, "fortune");
  randomUnit(roll);
  return Math.max(1, Math.floor(roll * (fortune + 2)));
}

/**
 * Vanilla uniform_bonus_count modifier, AFTER the loot owner's base-count roll.
 * A block's cap (glowstone 4, sea lantern 5, melon 9) is supplied by its profile.
 */
export function fortuneUniformCount(
  baseCount,
  fortune,
  roll,
  { bonusMultiplier = 1, maximum = Number.MAX_SAFE_INTEGER } = {}
) {
  integer(baseCount, "base loot count");
  level(fortune, "fortune");
  randomUnit(roll);
  integer(bonusMultiplier, "fortune bonus multiplier", 0, 64);
  integer(maximum, "loot count cap");
  const count = baseCount + Math.floor(roll * (fortune * bonusMultiplier + 1));
  integer(count, "resulting loot count");
  return Math.min(maximum, count);
}

/** Vanilla binomial_with_bonus_count; e.g. mature crops use extra=3,p=4/7. */
export function fortuneBinomialCount(
  baseCount,
  fortune,
  rolls,
  { extra = 3, probability = 4 / 7 } = {}
) {
  integer(baseCount, "base loot count");
  level(fortune, "fortune");
  integer(extra, "binomial extra trials", 0, 64);
  finite(probability, "binomial probability", 0, 1);
  if (!Array.isArray(rolls) || rolls.length !== extra + fortune)
    throw new RangeError("Incorrect number of binomial samples");
  Array.from(rolls).forEach(randomUnit);
  const count = baseCount + rolls.filter((roll) => roll < probability).length;
  return integer(count, "resulting loot count");
}

const fortuneChances = immutable({
  gravel: [1 / 10, 1 / 7, 1 / 4, 1],
  gilded_blackstone: [1 / 10, 1 / 7, 1 / 4, 1],
  sapling: [1 / 20, 1 / 16, 1 / 12, 1 / 10],
  jungle_sapling: [1 / 40, 1 / 36, 1 / 32, 1 / 24],
  leaf_stick: [1 / 50, 1 / 45, 1 / 40, 1 / 30],
  apple: [1 / 200, 1 / 180, 1 / 160, 1 / 120],
  vine: [0.33, 0.55, 0.77, 1],
});

/** Loot owner chooses a verified profile; this never identifies blocks by name. */
export function fortuneDropChance(profile, fortune) {
  level(fortune, "fortune");
  if (typeof profile !== "string" || !Object.hasOwn(fortuneChances, profile))
    throw new RangeError("Unknown Fortune chance profile");
  return fortuneChances[profile][fortune];
}

/**
 * Explicit registered silk-drop payloads, never a made-up block/item identity.
 * The loot owner supplies normal drops with any Fortune modifier already applied.
 * null silkDrops means that block has no Silk Touch behavior. The owner still
 * guards block drops, container contents and removals in its World transaction.
 */
export function selectSilkTouchDrops(
  tool,
  { normalDrops, silkDrops = null, experience = 0, canHarvest = true },
  context
) {
  if (
    !Array.isArray(normalDrops) ||
    (silkDrops !== null && !Array.isArray(silkDrops))
  )
    throw new RangeError("Invalid harvest drops");
  const normal = Array.from(normalDrops, (stack) =>
    normalizeStack(stack, context)
  );
  const silk =
    silkDrops === null
      ? null
      : Array.from(silkDrops, (stack) => normalizeStack(stack, context));
  if (!isValidExperience(experience))
    throw new RangeError("Invalid harvest experience");
  flag(canHarvest, "harvest permission");
  const useSilk =
    activeEnchantmentLevel(tool, "silk_touch", context) > 0 && silk !== null;
  return immutable({
    drops: !canHarvest ? [] : useSilk ? silk : normal,
    experience: !canHarvest || useSilk ? 0 : experience,
    silkTouch: canHarvest && useSilk,
  });
}

/**
 * Pure projection for one XP pickup over the currently held/equipped candidates.
 * Selection is uniform among damaged Mending items, with no slot/wear priority.
 * Reconsider remaining damaged equipment while XP remains; never reuse the
 * original orb amount in recursive repairs. Each item consumes floor(repair/2)
 * XP, so repairing an odd final durability point rounds down.
 *
 * Parent applies returned equipment and experienceRemaining in ONE Gameplay
 * prepareInventory participant, together with the orb/source and RNG participants.
 * Do not also credit the full orb through prepareExperience (that double pays).
 */
export function planMendingExperience(equipment, experience, rolls, context) {
  dataRecord(equipment, equippedSlots, "Mending equipment");
  if (!isValidExperience(experience))
    throw new RangeError("Invalid Mending experience");
  if (!Array.isArray(rolls) || rolls.length > equippedSlots.length)
    throw new RangeError("Invalid Mending selection samples");
  Array.from(rolls).forEach(randomUnit);
  const next = {};
  for (const slot of equippedSlots) {
    const stack = equipment[slot] ?? null;
    next[slot] = stack === null ? null : normalizeStack(stack, context);
    if (
      armorSlots.includes(slot) &&
      stack &&
      getItem(stack.id).equipmentSlot !== slot
    )
      throw new RangeError("Mending armor is in the wrong slot");
  }
  let remaining = experience;
  let repaired = 0;
  let drawsUsed = 0;
  while (remaining > 0) {
    const candidates = equippedSlots.filter((slot) => {
      const stack = next[slot];
      return (
        stack &&
        activeEnchantmentLevel(stack, "mending", context) &&
        stack.durability < getItem(stack.id).durability
      );
    });
    if (!candidates.length) break;
    if (drawsUsed >= rolls.length)
      throw new RangeError("Missing Mending selection sample");
    const slot = candidates[Math.floor(rolls[drawsUsed++] * candidates.length)];
    const stack = next[slot];
    const amount = Math.min(
      getItem(stack.id).durability - stack.durability,
      remaining * 2
    );
    next[slot] = { ...stack, durability: stack.durability + amount };
    repaired += amount;
    remaining -= Math.floor(amount / 2);
  }
  return immutable({
    equipment: next,
    repaired,
    experienceSpent: experience - remaining,
    experienceRemaining: remaining,
    drawsUsed,
  });
}

/**
 * Lure subtracts 100 ticks per level from a 100..600-tick base roll. A result <=0
 * requests another wait roll NEXT TICK, not an instant bite or an unbounded loop.
 */
export function fishingWaitTicks(baseTicks, lure) {
  integer(baseTicks, "base fishing wait", 100, 600);
  level(lure, "lure");
  return baseTicks - 100 * lure;
}

/**
 * Exact Java fishing category weights (quality -1/-2/+2), not fixed percentages.
 * Caller supplies the live open-water verdict; no treasure is enabled by default.
 * Lure does not alter these probabilities. Luck is the player's separate attribute.
 */
export function fishingLootWeights(
  luckOfTheSea,
  { luck = 0, openWater = false } = {}
) {
  level(luckOfTheSea, "luck_of_the_sea");
  finite(luck, "fishing luck", -1024, 1024);
  flag(openWater, "open water flag");
  const totalLuck = luckOfTheSea + luck;
  return immutable({
    fish: Math.max(0, Math.floor(85 - totalLuck)),
    junk: Math.max(0, Math.floor(10 - 2 * totalLuck)),
    treasure: openWater ? Math.max(0, Math.floor(5 + 2 * totalLuck)) : 0,
  });
}
