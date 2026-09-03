import { ITEM_IDS as I } from "./content-ids.js";
import { EXPANSION_GEAR_PALETTES } from "./expansion-art-common.js";
import {
  ARMOR_MATERIALS,
  ARMOR_SLOTS,
  getArmorSpec,
  getToolSpec,
  TOOL_KINDS,
  TOOL_MATERIALS,
} from "./gear.js";

const toolNames = Object.freeze({
  wood: "Wooden",
  stone: "Stone",
  copper: "Copper",
  iron: "Iron",
  gold: "Golden",
  diamond: "Diamond",
  netherite: "Netherite",
});
const armorNames = Object.freeze({
  leather: "Leather",
  copper: "Copper",
  gold: "Golden",
  chainmail: "Chainmail",
  iron: "Iron",
  diamond: "Diamond",
  netherite: "Netherite",
  turtle: "Turtle",
});
export const ARMOR_ITEM_SUFFIXES = Object.freeze({
  head: "HELMET",
  chest: "CHESTPLATE",
  legs: "LEGGINGS",
  feet: "BOOTS",
});
const legacyToolMaterials = new Set(["wood", "stone", "iron", "diamond"]);
const legacyToolColors = Object.freeze({
  wood: "#b18751",
  stone: "#91999d",
  iron: "#d8dce1",
  diamond: "#5dd9d0",
});

export const toolItemId = (material, tool) =>
  I[`${material}_${tool}`.toUpperCase()];
export const armorItemId = (material, slot) =>
  material === "iron" && slot === "chest"
    ? I.IRON_ARMOR
    : I[`${material.toUpperCase()}_${ARMOR_ITEM_SUFFIXES[slot]}`];

/** gear.js is the sole authority for every tiered numeric equipment value. */
export function gearItems() {
  const entries = [];
  for (const material of Object.keys(TOOL_MATERIALS)) {
    for (const tool of TOOL_KINDS) {
      const spec = getToolSpec(material, tool);
      const legacy = legacyToolMaterials.has(material) && tool !== "hoe";
      const resourceMaterial =
        material === "wood"
          ? "wooden"
          : material === "gold"
            ? "golden"
            : material;
      entries.push({
        id: toolItemId(material, tool),
        name: `${toolNames[material]} ${tool}`,
        kind: "tool",
        icon: tool,
        stackSize: 1,
        color: legacy
          ? legacyToolColors[material]
          : EXPANSION_GEAR_PALETTES[material][2],
        ...spec,
        gearMaterial: material,
        resourceLocation: `minecraft:${resourceMaterial}_${tool}`,
        tier: spec.harvestLevel + 1,
        damage: spec.attackDamage,
        // Legacy swords retain their old scalar projection, but the reference
        // spec intentionally has no universal sword miningEfficiency.
        ...(spec.miningEfficiency !== undefined
          ? { speed: spec.miningEfficiency }
          : legacy
            ? { speed: TOOL_MATERIALS[material].miningEfficiency }
            : {}),
        ...(legacy
          ? {}
          : {
              art: Object.freeze({ kind: "gear_tool", material, tool }),
            }),
      });
    }
  }
  for (const material of Object.keys(ARMOR_MATERIALS)) {
    for (const slot of ARMOR_SLOTS) {
      if (!Object.hasOwn(ARMOR_MATERIALS[material].armorPoints, slot)) continue;
      const spec = getArmorSpec(material, slot);
      const suffix = ARMOR_ITEM_SUFFIXES[slot].toLowerCase();
      const resourceMaterial = material === "gold" ? "golden" : material;
      entries.push({
        id: armorItemId(material, slot),
        name:
          material === "turtle"
            ? "Turtle shell"
            : `${armorNames[material]} ${suffix}`,
        kind: "equipment",
        icon: slot === "chest" ? "armor" : suffix,
        equipmentSlot: slot,
        stackSize: 1,
        color:
          material === "iron"
            ? "#c7cdd4"
            : EXPANSION_GEAR_PALETTES[material][2],
        ...spec,
        gearMaterial: material,
        resourceLocation: `minecraft:${resourceMaterial}_${suffix}`,
        ...(material === "iron"
          ? {}
          : {
              art: Object.freeze({ kind: "gear_armor", material, slot }),
            }),
      });
    }
  }
  return entries;
}

// Non-crafting acquisitions remain explicit integration requirements. A gear
// entry must not turn chainmail or a netherite upgrade into a free grid recipe.
export const GEAR_ACQUISITION_HOOKS = Object.freeze({
  chainmail: Object.freeze({
    source: "armorer trades or equipped hostile-mob drops",
    requiredOwner: "Trading/Wildlife",
  }),
  netherite: Object.freeze({
    source: "smithing diamond gear with an ingot and consumed upgrade template",
    requiredOwner: "ProgressionStations/Gameplay",
  }),
  turtle: Object.freeze({
    source: "five SCUTE from baby-turtle growth",
    requiredOwner: "ExpansionEcology",
    use: "refresh ten seconds of water breathing while the equipped wearer is out of water",
  }),
});
