import { BLOCK_IDS as B, ITEM_IDS as I } from "./content-ids.js";
import {
  contentIngredient as ingredient,
  contentRecipe as recipe,
  shapedContentRecipe as shaped,
  smeltingContentRecipe as smelt,
} from "./recipe-content.js";
import { PLANK_ITEMS, WOOD_SLAB_ITEMS } from "./wood-content.js";

export function resourceRecipes() {
  const planks = ingredient(
    B.PLANKS,
    1,
    PLANK_ITEMS.filter((id) => id !== B.PLANKS),
    "Any planks"
  );
  const slabs = ingredient(
    B.OAK_SLAB,
    1,
    WOOD_SLAB_ITEMS.filter((id) => id !== B.OAK_SLAB),
    "Any wooden slab"
  );
  return [
    shaped("saddle", I.SADDLE, 1, ["LLL", " I "], {
      L: ingredient(I.LEATHER),
      I: ingredient(I.IRON_INGOT),
    }),
    shaped("fishing_rod", I.FISHING_ROD, 1, ["  S", " ST", "S T"], {
      S: ingredient(I.STICK),
      T: ingredient(I.STRING),
    }),
    shaped("barrel", B.BARREL, 1, ["PSP", "P P", "PSP"], {
      P: planks,
      S: slabs,
    }),
    shaped("blast_furnace", B.BLAST_FURNACE, 1, ["III", "IFI", "SSS"], {
      I: ingredient(I.IRON_INGOT),
      F: ingredient(B.FURNACE),
      S: ingredient(B.SMOOTH_STONE),
    }),
    shaped("brewing_stand", B.BREWING_STAND, 1, [" R ", "CCC"], {
      R: ingredient(I.BLAZE_ROD),
      C: ingredient(
        B.COBBLESTONE,
        1,
        [B.BLACKSTONE, B.COBBLED_DEEPSLATE],
        "Any brewing base stone"
      ),
    }),
    shaped("enchanting_table", B.ENCHANTING_TABLE, 1, [" B ", "DOD", "OOO"], {
      B: ingredient(I.BOOK),
      D: ingredient(I.DIAMOND),
      O: ingredient(B.OBSIDIAN),
    }),
    shaped("iron_block", B.IRON_BLOCK, 1, ["III", "III", "III"], {
      I: ingredient(I.IRON_INGOT),
    }),
    recipe("iron_ingots", I.IRON_INGOT, 9, [ingredient(B.IRON_BLOCK)]),
    shaped("anvil", B.ANVIL, 1, ["BBB", " I ", "III"], {
      B: ingredient(B.IRON_BLOCK),
      I: ingredient(I.IRON_INGOT),
    }),
    shaped("conduit", B.CONDUIT, 1, ["NNN", "NHN", "NNN"], {
      N: ingredient(I.NAUTILUS_SHELL),
      H: ingredient(I.HEART_OF_THE_SEA),
    }),
    shaped("dark_prismarine", B.DARK_PRISMARINE, 1, ["SSS", "SDS", "SSS"], {
      S: ingredient(I.PRISMARINE_SHARD),
      D: ingredient(I.BLACK_DYE),
    }),
    recipe("black_dye", I.BLACK_DYE, 1, [ingredient(I.INK_SAC)]),
    shaped("glass_bottles", I.GLASS_BOTTLE, 3, ["G G", " G "], {
      G: ingredient(B.GLASS),
    }),
    recipe("blaze_powder", I.BLAZE_POWDER, 2, [ingredient(I.BLAZE_ROD)]),
    recipe("sugar", I.SUGAR, 1, [ingredient(B.SUGAR_CANE)]),
    recipe("fermented_spider_eye", I.FERMENTED_SPIDER_EYE, 1, [
      ingredient(I.SPIDER_EYE),
      ingredient(I.SUGAR),
      ingredient(B.BROWN_MUSHROOM),
    ]),
    recipe("magma_cream", I.MAGMA_CREAM, 1, [
      ingredient(I.SLIME_BALL),
      ingredient(I.BLAZE_POWDER),
    ]),
    shaped(
      "magma_block",
      B.MAGMA_BLOCK,
      1,
      ["MM", "MM"],
      {
        M: ingredient(I.MAGMA_CREAM),
      },
      "hand"
    ),
    shaped(
      "glowstone",
      B.GLOWSTONE,
      1,
      ["DD", "DD"],
      {
        D: ingredient(I.GLOWSTONE_DUST),
      },
      "hand"
    ),
    ...[
      ["golden_carrot", I.GOLDEN_CARROT, I.CARROT],
      ["glistering_melon_slice", I.GLISTERING_MELON_SLICE, I.MELON_SLICE],
    ].map(([id, output, center]) =>
      shaped(id, output, 1, ["NNN", "NCN", "NNN"], {
        N: ingredient(I.GOLD_NUGGET),
        C: ingredient(center),
      })
    ),
    shaped("melon", B.MELON, 1, ["MMM", "MMM", "MMM"], {
      M: ingredient(I.MELON_SLICE),
    }),
    shaped("dried_kelp_block", B.DRIED_KELP_BLOCK, 1, ["KKK", "KKK", "KKK"], {
      K: ingredient(I.DRIED_KELP),
    }),
    recipe("dried_kelp_from_block", I.DRIED_KELP, 9, [
      ingredient(B.DRIED_KELP_BLOCK),
    ]),
    shaped(
      "shears",
      I.SHEARS,
      1,
      [" I", "I "],
      { I: ingredient(I.IRON_INGOT) },
      "hand"
    ),
    shaped(
      "duplicate_netherite_upgrade_template",
      I.NETHERITE_UPGRADE_TEMPLATE,
      2,
      ["DTD", "DND", "DDD"],
      {
        D: ingredient(I.DIAMOND),
        T: ingredient(I.NETHERITE_UPGRADE_TEMPLATE),
        N: ingredient(B.NETHERRACK),
      }
    ),
    smelt("smooth_stone", B.SMOOTH_STONE, B.STONE, 0.1),
    smelt("cooked_cod", I.COOKED_COD, I.RAW_COD, 0.35),
    smelt("cooked_salmon", I.COOKED_SALMON, I.RAW_SALMON, 0.35),
    smelt("dried_kelp", I.DRIED_KELP, B.KELP, 0.1),
  ];
}
