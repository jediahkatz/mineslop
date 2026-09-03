import {
  immutable,
  integer,
  isPlainEnchantableBook,
} from "./enchantment-domain.js";
import { getEnchantment } from "./item-stack-data.js";

/**
 * Finite effect-backed subset, not a replacement metadata registry.
 * Sources:
 * https://minecraft.wiki/w/Enchanting_mechanics
 * https://minecraft.wiki/w/Anvil_mechanics#Costs_for_combining_enchantments
 * https://raw.githubusercontent.com/misode/mcmeta/26.2-data/data/minecraft/enchantment/protection.json
 *
 * Ranges are inclusive effective ranges: the highest eligible level wins.
 * Protection's 26.2 data is 1+11*(level-1), not the erroneous Blast Protection
 * ranges duplicated in some Wiki summary tables.
 *
 * 'effects' names concrete pure hooks in enchantment-effects.js. Consumers MUST
 * use getSupportedEnchantments/getEnchantmentRule, not iterate this reference:
 * staged fishing rules remain unavailable until the canonical metadata registry
 * declares them. No fire/curse/knockback/Thorns/glint-only offers are advertised.
 */
const rule = (maxLevel, weight, anvilItemCost, primary, ranges, effects) => ({
  maxLevel,
  weight,
  anvilItemCost,
  anvilBookCost: Math.max(1, anvilItemCost / 2),
  primary,
  treasure: primary === null,
  ranges,
  effects,
});

export const ENCHANTMENT_RULES = immutable({
  aqua_affinity: rule(1, 2, 4, "head", [[1, 41]], ["miningSpeed"]),
  depth_strider: rule(
    3,
    2,
    4,
    "feet",
    [
      [10, 19],
      [20, 29],
      [30, 45],
    ],
    ["waterMovement"]
  ),
  efficiency: rule(
    5,
    10,
    1,
    "mining",
    [
      [1, 10],
      [11, 20],
      [21, 30],
      [31, 40],
      [41, 91],
    ],
    ["miningSpeed"]
  ),
  feather_falling: rule(
    4,
    5,
    2,
    "feet",
    [
      [5, 10],
      [11, 16],
      [17, 22],
      [23, 29],
    ],
    ["reduceEnchantedDamage"]
  ),
  fortune: rule(
    3,
    2,
    4,
    "mining",
    [
      [15, 23],
      [24, 32],
      [33, 83],
    ],
    [
      "fortuneOreMultiplier",
      "fortuneUniformCount",
      "fortuneBinomialCount",
      "fortuneDropChance",
    ]
  ),
  luck_of_the_sea: rule(
    3,
    2,
    4,
    "fishing",
    [
      [15, 23],
      [24, 32],
      [33, 83],
    ],
    ["fishingLootWeights"]
  ),
  lure: rule(
    3,
    2,
    4,
    "fishing",
    [
      [15, 23],
      [24, 32],
      [33, 83],
    ],
    ["fishingWaitTicks"]
  ),
  mending: rule(1, 2, 4, null, [], ["planMendingExperience"]),
  power: rule(
    5,
    10,
    1,
    "bow",
    [
      [1, 10],
      [11, 20],
      [21, 30],
      [31, 40],
      [41, 56],
    ],
    ["bowDamage"]
  ),
  projectile_protection: rule(
    4,
    5,
    2,
    "armor",
    [
      [3, 8],
      [9, 14],
      [15, 20],
      [21, 27],
    ],
    ["reduceEnchantedDamage"]
  ),
  protection: rule(
    4,
    10,
    1,
    "armor",
    [
      [1, 11],
      [12, 22],
      [23, 33],
      [34, 45],
    ],
    ["reduceEnchantedDamage"]
  ),
  respiration: rule(
    3,
    2,
    4,
    "head",
    [
      [10, 19],
      [20, 29],
      [30, 60],
    ],
    ["respirationAirLoss"]
  ),
  sharpness: rule(
    5,
    10,
    1,
    "sword",
    [
      [1, 11],
      [12, 22],
      [23, 33],
      [34, 44],
      [45, 65],
    ],
    ["meleeDamage"]
  ),
  silk_touch: rule(1, 1, 8, "mining", [[15, 65]], ["selectSilkTouchDrops"]),
  smite: rule(
    5,
    5,
    2,
    "sword",
    [
      [5, 12],
      [13, 20],
      [21, 28],
      [29, 36],
      [37, 57],
    ],
    ["meleeDamage"]
  ),
  unbreaking: rule(
    3,
    5,
    2,
    "table_durable",
    [
      [5, 12],
      [13, 20],
      [21, 71],
    ],
    ["durabilityUseChance", "durabilityLoss"]
  ),
});

/** Unknown/unregistered/mismatched canonical definitions fail closed. */
export function getEnchantmentRule(name) {
  const rule =
    typeof name === "string" && Object.hasOwn(ENCHANTMENT_RULES, name)
      ? ENCHANTMENT_RULES[name]
      : null;
  const canonical = getEnchantment(name);
  return rule && canonical?.maxLevel === rule.maxLevel ? rule : null;
}

export function getSupportedEnchantments({ tableOnly = false } = {}) {
  return Object.freeze(
    Object.keys(ENCHANTMENT_RULES).filter((name) => {
      const rule = getEnchantmentRule(name);
      return rule && (!tableOnly || !rule.treasure);
    })
  );
}

const miningTools = ["pickaxe", "axe", "shovel", "hoe"];
const armorSlots = ["head", "chest", "legs", "feet"];

export function tableEligible(name, item) {
  const rule = getEnchantmentRule(name);
  if (!rule || rule.treasure || !item || typeof item !== "object") return false;
  if (isPlainEnchantableBook(item)) return true;
  if (!getEnchantment(name).eligible(item)) return false;
  if (rule.primary === "mining") return miningTools.includes(item.tool);
  if (rule.primary === "armor") return armorSlots.includes(item.equipmentSlot);
  if (rule.primary === "fishing") return item.tool === "fishing_rod";
  if (rule.primary === "table_durable")
    return (
      armorSlots.includes(item.equipmentSlot) ||
      [
        ...miningTools,
        "sword",
        "bow",
        "crossbow",
        "fishing_rod",
        "trident",
      ].includes(item.tool)
    );
  return item.tool === rule.primary || item.equipmentSlot === rule.primary;
}

/** Canonical compatibility is symmetric, including unsupported stored levels. */
export function enchantmentsCompatible(first, second) {
  const a = getEnchantment(first);
  const b = getEnchantment(second);
  return Boolean(
    a &&
      b &&
      (first === second ||
        (!a.conflicts.includes(second) && !b.conflicts.includes(first)))
  );
}

export function enchantmentCandidates(item, power) {
  integer(power, "modified enchantment power", 1);
  const candidates = [];
  for (const name of getSupportedEnchantments({ tableOnly: true })) {
    if (!tableEligible(name, item)) continue;
    const rule = getEnchantmentRule(name);
    for (let level = rule.maxLevel; level >= 1; level--) {
      const [minimum, maximum] = rule.ranges[level - 1];
      if (power >= minimum && power <= maximum) {
        candidates.push({ name, level, weight: rule.weight });
        break;
      }
    }
  }
  return immutable(candidates);
}
