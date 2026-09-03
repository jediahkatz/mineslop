import { BLOCK_IDS as B, ITEM_IDS as I } from "./content-ids.js";
import {
  armorItemId,
  ARMOR_ITEM_SUFFIXES,
  toolItemId,
} from "./gear-content.js";
import {
  ARMOR_MATERIALS,
  ARMOR_SLOTS,
  TOOL_KINDS,
  TOOL_MATERIALS,
} from "./gear.js";
import {
  contentIngredient as ingredient,
  shapedContentRecipe as shaped,
} from "./recipe-content.js";
import { PLANK_ITEMS } from "./wood-content.js";

const toolPatterns = Object.freeze({
  pickaxe: ["MMM", " S ", " S "],
  axe: ["MM", "MS", " S"],
  sword: ["M", "M", "S"],
  shovel: ["M", "S", "S"],
  hoe: ["MM", " S", " S"],
});
const armorPatterns = Object.freeze({
  head: ["MMM", "M M"],
  chest: ["M M", "MMM", "MMM"],
  legs: ["MMM", "M M", "M M"],
  feet: ["M M", "M M"],
});
const ingredientFor = (material) => {
  if (material === "wood")
    return ingredient(
      B.PLANKS,
      1,
      PLANK_ITEMS.filter((id) => id !== B.PLANKS),
      "Any planks"
    );
  if (material === "stone")
    return ingredient(
      B.COBBLESTONE,
      1,
      [B.BLACKSTONE, B.COBBLED_DEEPSLATE],
      "Any stone tool material"
    );
  return ingredient(
    {
      leather: I.LEATHER,
      copper: I.COPPER_INGOT,
      gold: I.GOLD_INGOT,
      iron: I.IRON_INGOT,
      diamond: I.DIAMOND,
      turtle: I.SCUTE,
    }[material]
  );
};

export function gearRecipes() {
  const entries = [];
  for (const [material, spec] of Object.entries(TOOL_MATERIALS)) {
    if (!spec.craftable) continue;
    for (const tool of TOOL_KINDS)
      entries.push(
        shaped(
          `${material}_${tool}`,
          toolItemId(material, tool),
          1,
          toolPatterns[tool],
          {
            M: ingredientFor(material),
            S: ingredient(I.STICK),
          }
        )
      );
  }
  for (const [material, spec] of Object.entries(ARMOR_MATERIALS)) {
    // The four existing iron recipes already use these exact grid quantities.
    if (!spec.craftable || material === "iron") continue;
    for (const slot of ARMOR_SLOTS) {
      if (!Object.hasOwn(spec.armorPoints, slot)) continue;
      entries.push(
        shaped(
          `${material}_${ARMOR_ITEM_SUFFIXES[slot].toLowerCase()}`,
          armorItemId(material, slot),
          1,
          armorPatterns[slot],
          { M: ingredientFor(material) }
        )
      );
    }
  }
  return entries;
}

const upgrade = (id, base, result) =>
  Object.freeze({
    id,
    station: "smithing",
    template: Object.freeze({ id: I.NETHERITE_UPGRADE_TEMPLATE, count: 1 }),
    base: Object.freeze({ id: base, count: 1 }),
    addition: Object.freeze({ id: I.NETHERITE_INGOT, count: 1 }),
    output: Object.freeze({ id: result, count: 1 }),
    preserveMetadata: true,
    durabilityPolicy: "preserve_damage",
  });

/**
 * Not part of RECIPES: the ordinary grid cannot do a metadata-preserving upgrade.
 * The station owner must prepare base/template/ingot consumption and output
 * atomically, carrying data and preserving DAMAGE, not remaining durability.
 */
export const SMITHING_RECIPES = Object.freeze([
  ...TOOL_KINDS.map((tool) =>
    upgrade(
      `netherite_${tool}`,
      toolItemId("diamond", tool),
      toolItemId("netherite", tool)
    )
  ),
  ...ARMOR_SLOTS.map((slot) =>
    upgrade(
      `netherite_${ARMOR_ITEM_SUFFIXES[slot].toLowerCase()}`,
      armorItemId("diamond", slot),
      armorItemId("netherite", slot)
    )
  ),
]);
