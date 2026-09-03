import { BLOCK_IDS as B, ITEM_IDS as I } from "./content-ids.js";
import { EXPANSION_WOOD_PALETTES } from "./expansion-art-common.js";
import { WOOD_FAMILIES } from "./wood-content.js";

const entry = (id, name, color, art, extra = {}) => ({
  id,
  name,
  color,
  kind: "material",
  art: Object.freeze(art),
  ...extra,
});
const food = (id, name, color, art, hunger, saturation, extra = {}) =>
  entry(id, name, color, art, {
    kind: "food",
    food: hunger,
    saturation,
    ...extra,
  });
const effect = (id, amplifier, durationTicks, chance = 1) =>
  Object.freeze({ id, amplifier, durationTicks, chance });

/** Catalog capabilities only; owners must execute use/drop/crop transactions. */
export function resourceItems() {
  return [
    ...WOOD_FAMILIES.filter(({ vehicle }) => vehicle !== null).map((family) =>
      entry(
        family.boat,
        `${family.name} ${family.vehicle}`,
        EXPANSION_WOOD_PALETTES[family.key][3],
        { kind: family.vehicle, variant: family.key },
        {
          kind: "vehicle",
          vehicle: family.vehicle,
          wood: family.key,
          stackSize: 1,
        }
      )
    ),
    entry(
      I.FISHING_ROD,
      "Fishing rod",
      "#b58b52",
      { kind: "fishing_rod" },
      {
        kind: "tool",
        tool: "fishing_rod",
        durability: 64,
        stackSize: 1,
        enchantability: 1,
      }
    ),
    food(
      I.RAW_COD,
      "Raw cod",
      "#aba779",
      { kind: "fish", variant: "cod" },
      2,
      0.4
    ),
    food(
      I.COOKED_COD,
      "Cooked cod",
      "#b79562",
      { kind: "cooked_fish", variant: "cod" },
      5,
      6
    ),
    food(
      I.RAW_SALMON,
      "Raw salmon",
      "#b56a5a",
      { kind: "fish", variant: "salmon" },
      2,
      0.4
    ),
    food(
      I.COOKED_SALMON,
      "Cooked salmon",
      "#c58562",
      { kind: "cooked_fish", variant: "salmon" },
      6,
      9.6
    ),
    food(
      I.TROPICAL_FISH,
      "Tropical fish",
      "#e2ad53",
      { kind: "fish", variant: "tropical" },
      1,
      0.2
    ),
    food(
      I.PUFFERFISH,
      "Pufferfish",
      "#c4a158",
      { kind: "fish", variant: "pufferfish" },
      1,
      0.2,
      {
        brewingIngredient: "pufferfish",
        consumptionEffects: Object.freeze([
          effect("hunger", 2, 300),
          effect("poison", 3, 1200),
          effect("nausea", 0, 300),
        ]),
      }
    ),
    entry(I.INK_SAC, "Ink sac", "#3f404d", { kind: "ink_sac" }),
    entry(I.BLACK_DYE, "Black dye", "#41414d", { kind: "black_dye" }),
    entry(I.SCUTE, "Turtle scute", "#88a65d", {
      kind: "scute",
      variant: "turtle",
    }),
    entry(I.NAUTILUS_SHELL, "Nautilus shell", "#d1b28a", {
      kind: "nautilus_shell",
    }),
    entry(I.HEART_OF_THE_SEA, "Heart of the sea", "#439ab3", {
      kind: "heart_of_the_sea",
    }),
    entry(
      I.TREASURE_MAP,
      "Buried treasure map",
      "#d9c89e",
      { kind: "treasure_map" },
      {
        kind: "map",
        map: true,
        stackSize: 1,
      }
    ),
    entry(
      I.NETHERITE_UPGRADE_TEMPLATE,
      "Netherite upgrade smithing template",
      "#94777c",
      {
        kind: "netherite_upgrade_template",
      },
      { smithingTemplate: "netherite_upgrade" }
    ),
    entry(
      I.ENCHANTED_BOOK,
      "Enchanted book",
      "#815f9d",
      { kind: "enchanted_book" },
      {
        kind: "book",
        enchantmentCarrier: true,
        enchantable: false,
        stackSize: 1,
      }
    ),
    entry(
      I.GLASS_BOTTLE,
      "Glass bottle",
      "#a3beba",
      { kind: "potion", variant: "empty" },
      {
        emptyBottle: true,
        stackSize: 64,
      }
    ),
    entry(
      I.POTION,
      "Potion",
      "#629ebd",
      {
        kind: "brewed_potion",
        variant: "water",
        form: "drinkable",
      },
      {
        kind: "potion",
        potionForm: "drinkable",
        stackSize: 1,
        alwaysConsumable: true,
        useSeconds: 1.6,
        useRemainder: I.GLASS_BOTTLE,
      }
    ),
    entry(
      I.SPLASH_POTION,
      "Splash potion",
      "#629ebd",
      {
        kind: "brewed_potion",
        variant: "water",
        form: "splash",
      },
      { kind: "potion", potionForm: "splash", stackSize: 1 }
    ),
    entry(I.BLAZE_ROD, "Blaze rod", "#e1b05c", { kind: "blaze_rod" }),
    entry(
      I.BLAZE_POWDER,
      "Blaze powder",
      "#edac4d",
      { kind: "blaze_powder" },
      {
        brewingIngredient: "blaze_powder",
        brewingFuelOperations: 20,
      }
    ),
    entry(
      I.SUGAR,
      "Sugar",
      "#e5dfcd",
      { kind: "sugar" },
      { brewingIngredient: "sugar" }
    ),
    food(
      I.SPIDER_EYE,
      "Spider eye",
      "#a24857",
      { kind: "spider_eye" },
      2,
      3.2,
      {
        brewingIngredient: "spider_eye",
        consumptionEffects: Object.freeze([effect("poison", 0, 100)]),
      }
    ),
    entry(
      I.FERMENTED_SPIDER_EYE,
      "Fermented spider eye",
      "#a17472",
      {
        kind: "fermented_spider_eye",
      },
      { brewingIngredient: "fermented_spider_eye" }
    ),
    entry(
      I.GHAST_TEAR,
      "Ghast tear",
      "#cde5de",
      { kind: "ghast_tear" },
      {
        brewingIngredient: "ghast_tear",
      }
    ),
    entry(
      I.MAGMA_CREAM,
      "Magma cream",
      "#bf7840",
      { kind: "magma_cream" },
      {
        brewingIngredient: "magma_cream",
      }
    ),
    entry(
      I.GLOWSTONE_DUST,
      "Glowstone dust",
      "#d4b85d",
      { kind: "glowstone_dust" },
      {
        brewingIngredient: "glowstone_dust",
      }
    ),
    food(I.CARROT, "Carrot", "#d38d43", { kind: "carrot" }, 3, 3.6, {
      plantBlock: B.CARROT_CROP,
    }),
    food(
      I.GOLDEN_CARROT,
      "Golden carrot",
      "#e8c66b",
      { kind: "golden_carrot" },
      6,
      14.4,
      {
        brewingIngredient: "golden_carrot",
      }
    ),
    food(
      I.MELON_SLICE,
      "Melon slice",
      "#d37664",
      { kind: "melon_slice" },
      2,
      1.2
    ),
    entry(
      I.GLISTERING_MELON_SLICE,
      "Glistering melon slice",
      "#d8ad65",
      {
        kind: "glistering_melon_slice",
      },
      { brewingIngredient: "glistering_melon_slice" }
    ),
    food(
      I.DRIED_KELP,
      "Dried kelp",
      "#587044",
      { kind: "dried_kelp" },
      1,
      0.6,
      {
        useSeconds: 0.8,
      }
    ),
    entry(
      I.SHEARS,
      "Shears",
      "#b8c9c7",
      { kind: "shears" },
      {
        kind: "tool",
        tool: "shears",
        durability: 238,
        stackSize: 1,
        enchantability: 0,
      }
    ),
    food(
      I.ROTTEN_FLESH,
      "Rotten flesh",
      "#99724c",
      { kind: "rotten_flesh" },
      4,
      0.8,
      {
        consumptionEffects: Object.freeze([effect("hunger", 0, 600, 0.8)]),
      }
    ),
    entry(
      I.SADDLE,
      "Saddle",
      "#945a36",
      { kind: "saddle" },
      { kind: "equipment", saddle: true, stackSize: 1 }
    ),
  ];
}

// Internal constant names are not always Minecraft resource locations. These
// explicit exceptions avoid aliases in ITEM while enabling semantic anvil tags.
const resourceNames = Object.freeze({
  RAW_BEEF: "beef",
  STEAK: "cooked_beef",
  RAW_PORK: "porkchop",
  COOKED_PORK: "cooked_porkchop",
  RAW_CHICKEN: "chicken",
  RAW_MUTTON: "mutton",
  SEEDS: "wheat_seeds",
  LAPIS: "lapis_lazuli",
  RAW_COD: "cod",
  RAW_SALMON: "salmon",
  SCUTE: "turtle_scute",
  NETHERITE_UPGRADE_TEMPLATE: "netherite_upgrade_smithing_template",
  TREASURE_MAP: "filled_map",
  IRON_ARMOR: "iron_chestplate",
  ...Object.fromEntries(
    ["pickaxe", "axe", "sword", "shovel", "hoe"].flatMap((tool) => [
      [`WOOD_${tool.toUpperCase()}`, `wooden_${tool}`],
      [`GOLD_${tool.toUpperCase()}`, `golden_${tool}`],
    ])
  ),
  ...Object.fromEntries(
    ["helmet", "chestplate", "leggings", "boots"].map((slot) => [
      `GOLD_${slot.toUpperCase()}`,
      `golden_${slot}`,
    ])
  ),
});
export const ORDINARY_ITEM_RESOURCE_LOCATIONS = Object.freeze(
  Object.fromEntries(
    Object.entries(I).map(([symbol, id]) => [
      id,
      `minecraft:${resourceNames[symbol] ?? symbol.toLowerCase()}`,
    ])
  )
);
