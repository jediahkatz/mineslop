/**
 * Reference-only, unenchanted Java Edition 26.2 equipment. No catalog IDs,
 * recipes, equipped-item state, or gameplay effects are registered here.
 *
 * References checked 2026-09-01:
 * https://minecraft.wiki/w/Tool_materials
 * https://minecraft.wiki/w/Pickaxe
 * https://minecraft.wiki/w/Axe
 * https://minecraft.wiki/w/Sword
 * https://minecraft.wiki/w/Shovel
 * https://minecraft.wiki/w/Hoe
 * https://minecraft.wiki/w/Armor#Statistics
 * https://minecraft.wiki/w/Armor#Damage_formulas
 * https://minecraft.wiki/w/Armor_materials
 * https://minecraft.wiki/w/Turtle_Shell
 *
 * Prefer the Java-specific item tables where summary pages disagree:
 * https://minecraft.wiki/w/Copper_Pickaxe specifies 190 durability (191 is
 * Bedrock), and https://minecraft.wiki/w/Copper_Boots specifies 1 armor point.
 * The seven-tier armor totals are 7, 10, 11, 12, 15, 20, and 20.
 *
 * Public fields:
 * - durability: maximum remaining durability, not current wear.
 * - harvestLevel: vanilla 0-based material level, NOT the app's 1-based tier;
 *   only pickaxes use this to gate block drops. It is not a material ranking:
 *   gold equals wood, and copper equals stone.
 * - miningEfficiency: the material's multiplier for suitable mining blocks,
 *   not a universal breaking speed. getToolSpec omits it for swords, whose
 *   block-specific mining rates do not use the material multiplier.
 * - attackDamage / attackSpeed: total player HP per fully charged ordinary
 *   hit (including the player's base 1 HP) / attacks per second, not modifiers.
 *   Material tables map these fields by tool; tool specs contain scalar values.
 * - enchantability: vanilla material enchantability, not an enchantment level.
 * - durabilityMultiplier: armor material multiplier; base slot durabilities
 *   are head 11, chest 16, legs 15, feet 13. Armor specs contain their product.
 * - armorPoints: material tables map supported slots to points; armor specs
 *   contain one piece's points. toughness and knockbackResistance are also
 *   per piece; resistance is a fraction (netherite 0.1, not 10).
 * - repairIngredients: alternative symbolic Minecraft item identifiers;
 *   #minecraft:planks means any plank. These are not application item IDs.
 * - repairDurabilityPerUnit: floor(maximum durability / 4) restored per anvil
 *   ingredient, capped by missing durability by the caller. This module does
 *   not apply repairs or their XP costs.
 * - craftable: a new item can be made directly in a crafting grid. This does
 *   not describe repair combining, loot, or trading.
 * - smithingUpgrade: null, or one matching baseMaterial tool/armor piece plus
 *   one ingredient and one consumed template. It does not execute an upgrade.
 *
 * All exported data is deeply frozen. Lookups return fresh, deeply frozen
 * snapshots with no object/array aliases to the tables or previous lookups.
 * Selectors are exact lowercase strings; non-strings throw TypeError and
 * unsupported materials/tools/slots throw RangeError. Turtle supports head only.
 */

export const TOOL_KINDS = Object.freeze([
  "pickaxe",
  "axe",
  "sword",
  "shovel",
  "hoe",
]);

export const ARMOR_SLOTS = Object.freeze(["head", "chest", "legs", "feet"]);

const ARMOR_SLOT_DURABILITY = Object.freeze({
  head: 11,
  chest: 16,
  legs: 15,
  feet: 13,
});

const NETHERITE_UPGRADE = {
  baseMaterial: "diamond",
  ingredient: "minecraft:netherite_ingot",
  template: "minecraft:netherite_upgrade_smithing_template",
};

export const TOOL_MATERIALS = frozenCopy({
  wood: {
    durability: 59,
    harvestLevel: 0,
    miningEfficiency: 2,
    enchantability: 15,
    repairIngredients: ["#minecraft:planks"],
    craftable: true,
    smithingUpgrade: null,
    attackDamage: { pickaxe: 2, axe: 7, sword: 4, shovel: 2.5, hoe: 1 },
    attackSpeed: { pickaxe: 1.2, axe: 0.8, sword: 1.6, shovel: 1, hoe: 1 },
  },
  gold: {
    durability: 32,
    harvestLevel: 0,
    miningEfficiency: 12,
    enchantability: 22,
    repairIngredients: ["minecraft:gold_ingot"],
    craftable: true,
    smithingUpgrade: null,
    attackDamage: { pickaxe: 2, axe: 7, sword: 4, shovel: 2.5, hoe: 1 },
    attackSpeed: { pickaxe: 1.2, axe: 1, sword: 1.6, shovel: 1, hoe: 1 },
  },
  stone: {
    durability: 131,
    harvestLevel: 1,
    miningEfficiency: 4,
    enchantability: 5,
    repairIngredients: [
      "minecraft:cobblestone",
      "minecraft:cobbled_deepslate",
      "minecraft:blackstone",
    ],
    craftable: true,
    smithingUpgrade: null,
    attackDamage: { pickaxe: 3, axe: 9, sword: 5, shovel: 3.5, hoe: 1 },
    attackSpeed: { pickaxe: 1.2, axe: 0.8, sword: 1.6, shovel: 1, hoe: 2 },
  },
  copper: {
    durability: 190,
    harvestLevel: 1,
    miningEfficiency: 5,
    enchantability: 13,
    repairIngredients: ["minecraft:copper_ingot"],
    craftable: true,
    smithingUpgrade: null,
    attackDamage: { pickaxe: 3, axe: 9, sword: 5, shovel: 3.5, hoe: 1 },
    attackSpeed: { pickaxe: 1.2, axe: 0.8, sword: 1.6, shovel: 1, hoe: 2 },
  },
  iron: {
    durability: 250,
    harvestLevel: 2,
    miningEfficiency: 6,
    enchantability: 14,
    repairIngredients: ["minecraft:iron_ingot"],
    craftable: true,
    smithingUpgrade: null,
    attackDamage: { pickaxe: 4, axe: 9, sword: 6, shovel: 4.5, hoe: 1 },
    attackSpeed: { pickaxe: 1.2, axe: 0.9, sword: 1.6, shovel: 1, hoe: 3 },
  },
  diamond: {
    durability: 1561,
    harvestLevel: 3,
    miningEfficiency: 8,
    enchantability: 10,
    repairIngredients: ["minecraft:diamond"],
    craftable: true,
    smithingUpgrade: null,
    attackDamage: { pickaxe: 5, axe: 9, sword: 7, shovel: 5.5, hoe: 1 },
    attackSpeed: { pickaxe: 1.2, axe: 1, sword: 1.6, shovel: 1, hoe: 4 },
  },
  netherite: {
    durability: 2031,
    harvestLevel: 4,
    miningEfficiency: 9,
    enchantability: 15,
    repairIngredients: ["minecraft:netherite_ingot"],
    craftable: false,
    smithingUpgrade: NETHERITE_UPGRADE,
    attackDamage: { pickaxe: 6, axe: 10, sword: 8, shovel: 6.5, hoe: 1 },
    attackSpeed: { pickaxe: 1.2, axe: 1, sword: 1.6, shovel: 1, hoe: 4 },
  },
});

export const ARMOR_MATERIALS = frozenCopy({
  leather: {
    durabilityMultiplier: 5,
    armorPoints: { head: 1, chest: 3, legs: 2, feet: 1 },
    toughness: 0,
    knockbackResistance: 0,
    enchantability: 15,
    repairIngredients: ["minecraft:leather"],
    craftable: true,
    smithingUpgrade: null,
  },
  copper: {
    durabilityMultiplier: 11,
    armorPoints: { head: 2, chest: 4, legs: 3, feet: 1 },
    toughness: 0,
    knockbackResistance: 0,
    enchantability: 8,
    repairIngredients: ["minecraft:copper_ingot"],
    craftable: true,
    smithingUpgrade: null,
  },
  gold: {
    durabilityMultiplier: 7,
    armorPoints: { head: 2, chest: 5, legs: 3, feet: 1 },
    toughness: 0,
    knockbackResistance: 0,
    enchantability: 25,
    repairIngredients: ["minecraft:gold_ingot"],
    craftable: true,
    smithingUpgrade: null,
  },
  chainmail: {
    durabilityMultiplier: 15,
    armorPoints: { head: 2, chest: 5, legs: 4, feet: 1 },
    toughness: 0,
    knockbackResistance: 0,
    enchantability: 12,
    repairIngredients: ["minecraft:iron_ingot"],
    craftable: false,
    smithingUpgrade: null,
  },
  iron: {
    durabilityMultiplier: 15,
    armorPoints: { head: 2, chest: 6, legs: 5, feet: 2 },
    toughness: 0,
    knockbackResistance: 0,
    enchantability: 9,
    repairIngredients: ["minecraft:iron_ingot"],
    craftable: true,
    smithingUpgrade: null,
  },
  diamond: {
    durabilityMultiplier: 33,
    armorPoints: { head: 3, chest: 8, legs: 6, feet: 3 },
    toughness: 2,
    knockbackResistance: 0,
    enchantability: 10,
    repairIngredients: ["minecraft:diamond"],
    craftable: true,
    smithingUpgrade: null,
  },
  netherite: {
    durabilityMultiplier: 37,
    armorPoints: { head: 3, chest: 8, legs: 6, feet: 3 },
    toughness: 3,
    knockbackResistance: 0.1,
    enchantability: 15,
    repairIngredients: ["minecraft:netherite_ingot"],
    craftable: false,
    smithingUpgrade: NETHERITE_UPGRADE,
  },
  turtle: {
    durabilityMultiplier: 25,
    armorPoints: { head: 2 },
    toughness: 0,
    knockbackResistance: 0,
    enchantability: 9,
    repairIngredients: ["minecraft:turtle_scute"],
    craftable: true,
    smithingUpgrade: null,
  },
});

/** Return one immutable tool spec; material and tool are symbolic selectors. */
export function getToolSpec(material, tool) {
  const { attackDamage, attackSpeed, miningEfficiency, ...properties } = member(
    TOOL_MATERIALS,
    material,
    "tool material"
  );
  const damage = member(attackDamage, tool, "tool");
  return frozenCopy({
    material,
    tool,
    ...properties,
    ...(tool === "sword" ? {} : { miningEfficiency }),
    attackDamage: damage,
    attackSpeed: attackSpeed[tool],
    repairDurabilityPerUnit: Math.floor(properties.durability / 4),
  });
}

/** Slots are head/chest/legs/feet, matching the app's equipment slot names. */
export function getArmorSpec(material, slot) {
  const { durabilityMultiplier, armorPoints, ...properties } = member(
    ARMOR_MATERIALS,
    material,
    "armor material"
  );
  const points = member(armorPoints, slot, "armor slot");
  const durability = durabilityMultiplier * ARMOR_SLOT_DURABILITY[slot];
  return frozenCopy({
    material,
    slot,
    ...properties,
    armorPoints: points,
    durability,
    repairDurabilityPerUnit: Math.floor(durability / 4),
  });
}

/**
 * Return HP taken after Java's armor/toughness stage:
 * damage * (1 - min(20, max(armor/5, armor - damage/(2+toughness/4))) / 25).
 *
 * Inputs are nonnegative finite numbers (fractional values are allowed).
 * Non-numbers throw TypeError; negatives/NaN/infinities throw RangeError,
 * including when another argument is zero. Toughness uses Java's cap of 20;
 * the effective armor reduction is capped at 80%, not armorPoints itself.
 * Zero damage returns positive zero, and zero armor returns incoming damage.
 * Uses JS numbers without rounding the result to whole HP or hearts.
 *
 * Caller decides whether armor applies: fall, drowning, ender-pearl damage and
 * other armor-bypassing sources must skip this function. Enchantments, Breach,
 * effects, absorption, durability loss, and source-specific rules are separate.
 */
export function reduceArmorDamage(damage, armorPoints, toughness = 0) {
  nonnegativeFinite(damage, "damage");
  nonnegativeFinite(armorPoints, "armorPoints");
  nonnegativeFinite(toughness, "toughness");
  if (damage === 0) return 0;
  if (armorPoints === 0) return damage;
  const effectiveArmor = Math.min(
    20,
    Math.max(
      armorPoints / 5,
      armorPoints - damage / (2 + Math.min(toughness, 20) / 4)
    )
  );
  return damage * (1 - effectiveArmor / 25);
}

function member(table, key, label) {
  if (typeof key !== "string") throw new TypeError(`${label} must be a string`);
  if (!Object.hasOwn(table, key))
    throw new RangeError(`Unsupported ${label}: ${key}`);
  return table[key];
}

function nonnegativeFinite(value, label) {
  if (typeof value !== "number")
    throw new TypeError(`${label} must be a number`);
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError(`${label} must be finite and nonnegative`);
}

// Only plain reference records/arrays enter this private copier.
function frozenCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenCopy));
  if (value !== null && typeof value === "object")
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, frozenCopy(child)])
      )
    );
  return value;
}
