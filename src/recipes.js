import { BLOCK } from "./blocks.js";
import { gearRecipes } from "./gear-recipes.js";
import { getItem, ITEM, PLANK_ITEMS, WOOD_SLAB_ITEMS } from "./items.js";
import { resourceRecipes } from "./resource-recipes.js";
import { CHARCOAL_LOG_ITEMS } from "./wood-content.js";
import { woodRecipes } from "./wood-recipes.js";

export { SMITHING_RECIPES } from "./gear-recipes.js";

const ingredient = (id, count = 1, alternatives = [], name) => ({
  id,
  count,
  ...(alternatives.length ? { alternatives } : {}),
  ...(name ? { name } : {}),
});
const logs = () =>
  ingredient(
    CHARCOAL_LOG_ITEMS[0],
    1,
    CHARCOAL_LOG_ITEMS.slice(1),
    "Any overworld log"
  );
const planks = (count) =>
  ingredient(
    BLOCK.PLANKS,
    count,
    PLANK_ITEMS.filter((id) => id !== BLOCK.PLANKS),
    "Any planks"
  );
const slabs = (count) =>
  ingredient(
    BLOCK.OAK_SLAB,
    count,
    WOOD_SLAB_ITEMS.filter((id) => id !== BLOCK.OAK_SLAB),
    "Any wooden slab"
  );
const recipe = (
  id,
  output,
  count,
  ingredients,
  station = "hand",
  extra = {}
) => ({
  id,
  name: getItem(output)?.name ?? id,
  ingredients,
  output: { id: output, count },
  station,
  duration: 0,
  ...extra,
});
const smelt = (id, output, input, extra = {}) =>
  recipe(id, output, 1, [input], "furnace", { duration: 10, ...extra });

// Costs remain the legacy accounting interface. Patterns describe real grid
// cells, where each non-space symbol consumes one of that ingredient.
const patterns = {
  sticks: [["P", "P"], { P: BLOCK.PLANKS }],
  crafting_table: [["PP", "PP"], { P: BLOCK.PLANKS }],
  furnace: [["CCC", "C C", "CCC"], { C: BLOCK.COBBLESTONE }],
  torches: [["C", "S"], { C: ITEM.COAL, S: ITEM.STICK }],
  chest: [["PPP", "P P", "PPP"], { P: BLOCK.PLANKS }],
  bread: [["WWW"], { W: ITEM.WHEAT }],
  bucket: [["I I", " I "], { I: ITEM.IRON_INGOT }],
  iron_armor: [["I I", "III", "III"], { I: ITEM.IRON_INGOT }],
  bow: [[" ST", "S T", " ST"], { S: ITEM.STICK, T: ITEM.STRING }],
  arrows: [["F", "S", "E"], { F: ITEM.FLINT, S: ITEM.STICK, E: ITEM.FEATHER }],
  wool: [["SS", "SS"], { S: ITEM.STRING }],
  tnt: [["GSG", "SGS", "GSG"], { G: ITEM.GUNPOWDER, S: BLOCK.SAND }],
  shield: [["PIP", "PPP", " P "], { P: BLOCK.PLANKS, I: ITEM.IRON_INGOT }],
  iron_helmet: [["III", "I I"], { I: ITEM.IRON_INGOT }],
  iron_leggings: [["III", "I I", "I I"], { I: ITEM.IRON_INGOT }],
  iron_boots: [["I I", "I I"], { I: ITEM.IRON_INGOT }],
  copper_block: [["CCC", "CCC", "CCC"], { C: ITEM.COPPER_INGOT }],
  paper: [["SSS"], { S: BLOCK.SUGAR_CANE }],
  bookshelf: [["PPP", "BBB", "PPP"], { P: BLOCK.PLANKS, B: ITEM.BOOK }],
  oak_slab: [["PPP"], { P: BLOCK.PLANKS }],
  oak_stairs: [["P  ", "PP ", "PPP"], { P: BLOCK.PLANKS }],
  oak_door: [["PP", "PP", "PP"], { P: BLOCK.PLANKS }],
  oak_trapdoor: [["PPP", "PPP"], { P: BLOCK.PLANKS }],
  oak_fence: [["PSP", "PSP"], { P: BLOCK.PLANKS, S: ITEM.STICK }],
  oak_fence_gate: [["SPS", "SPS"], { P: BLOCK.PLANKS, S: ITEM.STICK }],
  ladder: [["S S", "SSS", "S S"], { S: ITEM.STICK }],
  white_bed: [["WWW", "PPP"], { W: BLOCK.WOOL, P: BLOCK.PLANKS }],
  gold_ingot_from_nuggets: [["NNN", "NNN", "NNN"], { N: ITEM.GOLD_NUGGET }],
  quartz_block: [["QQ", "QQ"], { Q: ITEM.QUARTZ }],
  prismarine: [["SS", "SS"], { S: ITEM.PRISMARINE_SHARD }],
  prismarine_bricks: [["SSS", "SSS", "SSS"], { S: ITEM.PRISMARINE_SHARD }],
  sea_lantern: [
    ["SCS", "CCC", "SCS"],
    {
      S: ITEM.PRISMARINE_SHARD,
      C: ITEM.PRISMARINE_CRYSTALS,
    },
  ],
  gold_block: [["GGG", "GGG", "GGG"], { G: ITEM.GOLD_INGOT }],
  nether_bricks: [["NN", "NN"], { N: ITEM.NETHER_BRICK }],
  nether_brick_slab: [["BBB"], { B: BLOCK.NETHER_BRICKS }],
  nether_brick_stairs: [["B  ", "BB ", "BBB"], { B: BLOCK.NETHER_BRICKS }],
  nether_brick_fence: [
    ["BNB", "BNB"],
    { B: BLOCK.NETHER_BRICKS, N: ITEM.NETHER_BRICK },
  ],
  composter: [["S S", "S S", "SSS"], { S: BLOCK.OAK_SLAB }],
  lectern: [["SSS", " B ", " S "], { S: BLOCK.OAK_SLAB, B: BLOCK.BOOKSHELF }],
  cartography_table: [["AA", "PP", "PP"], { A: ITEM.PAPER, P: BLOCK.PLANKS }],
  smithing_table: [["II", "PP", "PP"], { I: ITEM.IRON_INGOT, P: BLOCK.PLANKS }],
};

const recipes = [
  recipe("planks", BLOCK.PLANKS, 4, [ingredient(BLOCK.OAK_LOG)]),
  recipe("sticks", ITEM.STICK, 4, [planks(2)]),
  recipe("crafting_table", BLOCK.CRAFTING_TABLE, 1, [planks(4)]),
  recipe(
    "furnace",
    BLOCK.FURNACE,
    1,
    [ingredient(BLOCK.COBBLESTONE, 8)],
    "table"
  ),
  recipe("torches", BLOCK.TORCH, 4, [
    ingredient(ITEM.COAL),
    ingredient(ITEM.STICK),
  ]),
  recipe("chest", BLOCK.CHEST, 1, [planks(8)], "table"),
  recipe("bread", ITEM.BREAD, 1, [ingredient(ITEM.WHEAT, 3)], "table"),
  recipe("bucket", ITEM.BUCKET, 1, [ingredient(ITEM.IRON_INGOT, 3)], "table"),
  recipe("flint_and_steel", ITEM.FLINT_AND_STEEL, 1, [
    ingredient(ITEM.IRON_INGOT),
    ingredient(ITEM.FLINT),
  ]),
  recipe(
    "iron_armor",
    ITEM.IRON_ARMOR,
    1,
    [ingredient(ITEM.IRON_INGOT, 8)],
    "table"
  ),
  recipe(
    "bow",
    ITEM.BOW,
    1,
    [ingredient(ITEM.STICK, 3), ingredient(ITEM.STRING, 3)],
    "table"
  ),
  recipe(
    "arrows",
    ITEM.ARROW,
    4,
    [ingredient(ITEM.FLINT), ingredient(ITEM.STICK), ingredient(ITEM.FEATHER)],
    "table"
  ),
  recipe("wool", BLOCK.WOOL, 1, [ingredient(ITEM.STRING, 4)]),
  recipe(
    "tnt",
    BLOCK.TNT,
    1,
    [
      ingredient(ITEM.GUNPOWDER, 5),
      ingredient(BLOCK.SAND, 4, [BLOCK.RED_SAND], "Any sand"),
    ],
    "table"
  ),
  recipe(
    "copper_block",
    BLOCK.COPPER_BLOCK,
    1,
    [ingredient(ITEM.COPPER_INGOT, 9)],
    "table"
  ),
  recipe("copper_ingots", ITEM.COPPER_INGOT, 9, [
    ingredient(BLOCK.COPPER_BLOCK),
  ]),
  recipe("paper", ITEM.PAPER, 3, [ingredient(BLOCK.SUGAR_CANE, 3)], "table"),
  recipe("book", ITEM.BOOK, 1, [
    ingredient(ITEM.PAPER, 3),
    ingredient(ITEM.LEATHER),
  ]),
  recipe(
    "bookshelf",
    BLOCK.BOOKSHELF,
    1,
    [planks(6), ingredient(ITEM.BOOK, 3)],
    "table"
  ),
  recipe("oak_slab", BLOCK.OAK_SLAB, 6, [ingredient(BLOCK.PLANKS, 3)], "table"),
  recipe(
    "oak_stairs",
    BLOCK.OAK_STAIRS,
    4,
    [ingredient(BLOCK.PLANKS, 6)],
    "table"
  ),
  recipe("oak_door", BLOCK.OAK_DOOR, 3, [ingredient(BLOCK.PLANKS, 6)], "table"),
  recipe(
    "oak_trapdoor",
    BLOCK.OAK_TRAPDOOR,
    2,
    [ingredient(BLOCK.PLANKS, 6)],
    "table"
  ),
  recipe(
    "oak_fence",
    BLOCK.OAK_FENCE,
    3,
    [ingredient(BLOCK.PLANKS, 4), ingredient(ITEM.STICK, 2)],
    "table"
  ),
  recipe(
    "oak_fence_gate",
    BLOCK.OAK_FENCE_GATE,
    1,
    [ingredient(BLOCK.PLANKS, 2), ingredient(ITEM.STICK, 4)],
    "table"
  ),
  recipe("ladder", BLOCK.LADDER, 3, [ingredient(ITEM.STICK, 7)], "table"),
  recipe(
    "white_bed",
    BLOCK.WHITE_BED,
    1,
    [ingredient(BLOCK.WOOL, 3), planks(3)],
    "table"
  ),
  recipe(
    "gold_ingot_from_nuggets",
    ITEM.GOLD_INGOT,
    1,
    [ingredient(ITEM.GOLD_NUGGET, 9)],
    "table"
  ),
  recipe("gold_nuggets", ITEM.GOLD_NUGGET, 9, [ingredient(ITEM.GOLD_INGOT)]),
  recipe(
    "netherite_ingot",
    ITEM.NETHERITE_INGOT,
    1,
    [ingredient(ITEM.NETHERITE_SCRAP, 4), ingredient(ITEM.GOLD_INGOT, 4)],
    "table"
  ),
  recipe("quartz_block", BLOCK.QUARTZ_BLOCK, 1, [ingredient(ITEM.QUARTZ, 4)]),
  recipe("prismarine", BLOCK.PRISMARINE, 1, [
    ingredient(ITEM.PRISMARINE_SHARD, 4),
  ]),
  recipe(
    "prismarine_bricks",
    BLOCK.PRISMARINE_BRICKS,
    1,
    [ingredient(ITEM.PRISMARINE_SHARD, 9)],
    "table"
  ),
  recipe(
    "sea_lantern",
    BLOCK.SEA_LANTERN,
    1,
    [
      ingredient(ITEM.PRISMARINE_SHARD, 4),
      ingredient(ITEM.PRISMARINE_CRYSTALS, 5),
    ],
    "table"
  ),
  recipe(
    "gold_block",
    BLOCK.GOLD_BLOCK,
    1,
    [ingredient(ITEM.GOLD_INGOT, 9)],
    "table"
  ),
  recipe("gold_ingots", ITEM.GOLD_INGOT, 9, [ingredient(BLOCK.GOLD_BLOCK)]),
  recipe("mossy_cobblestone", BLOCK.MOSSY_COBBLESTONE, 1, [
    ingredient(BLOCK.COBBLESTONE),
    ingredient(BLOCK.MOSS),
  ]),
  recipe("nether_bricks", BLOCK.NETHER_BRICKS, 1, [
    ingredient(ITEM.NETHER_BRICK, 4),
  ]),
  recipe(
    "nether_brick_slab",
    BLOCK.NETHER_BRICK_SLAB,
    6,
    [ingredient(BLOCK.NETHER_BRICKS, 3)],
    "table"
  ),
  recipe(
    "nether_brick_stairs",
    BLOCK.NETHER_BRICK_STAIRS,
    4,
    [ingredient(BLOCK.NETHER_BRICKS, 6)],
    "table"
  ),
  recipe(
    "nether_brick_fence",
    BLOCK.NETHER_BRICK_FENCE,
    6,
    [ingredient(BLOCK.NETHER_BRICKS, 4), ingredient(ITEM.NETHER_BRICK, 2)],
    "table"
  ),
  recipe("composter", BLOCK.COMPOSTER, 1, [slabs(7)], "table"),
  recipe(
    "lectern",
    BLOCK.LECTERN,
    1,
    [slabs(4), ingredient(BLOCK.BOOKSHELF)],
    "table"
  ),
  recipe(
    "cartography_table",
    BLOCK.CARTOGRAPHY_TABLE,
    1,
    [ingredient(ITEM.PAPER, 2), planks(4)],
    "table"
  ),
  recipe(
    "smithing_table",
    BLOCK.SMITHING_TABLE,
    1,
    [ingredient(ITEM.IRON_INGOT, 2), planks(4)],
    "table"
  ),
  smelt("nether_brick", ITEM.NETHER_BRICK, ingredient(BLOCK.NETHERRACK), {
    experience: 0.1,
  }),
  smelt(
    "iron_ingot",
    ITEM.IRON_INGOT,
    ingredient(
      ITEM.RAW_IRON,
      1,
      [BLOCK.IRON_ORE, BLOCK.DEEPSLATE_IRON_ORE],
      "Raw iron / iron ore"
    )
  ),
  smelt(
    "gold_ingot",
    ITEM.GOLD_INGOT,
    ingredient(
      ITEM.RAW_GOLD,
      1,
      [BLOCK.GOLD_ORE, BLOCK.DEEPSLATE_GOLD_ORE, BLOCK.NETHER_GOLD_ORE],
      "Raw gold / gold ore"
    )
  ),
  smelt(
    "copper_ingot",
    ITEM.COPPER_INGOT,
    ingredient(
      ITEM.RAW_COPPER,
      1,
      [BLOCK.COPPER_ORE, BLOCK.DEEPSLATE_COPPER_ORE],
      "Raw copper / copper ore"
    )
  ),
  smelt("charcoal", ITEM.COAL, logs(), { name: "Charcoal" }),
  smelt(
    "netherite_scrap",
    ITEM.NETHERITE_SCRAP,
    ingredient(BLOCK.ANCIENT_DEBRIS),
    {
      experience: 2,
    }
  ),
  smelt("quartz", ITEM.QUARTZ, ingredient(BLOCK.NETHER_QUARTZ_ORE), {
    experience: 0.2,
  }),
  smelt("dry_sponge", BLOCK.SPONGE, ingredient(BLOCK.WET_SPONGE), {
    experience: 0.15,
  }),
  smelt(
    "glass",
    BLOCK.GLASS,
    ingredient(BLOCK.SAND, 1, [BLOCK.RED_SAND], "Any sand")
  ),
  smelt("stone", BLOCK.STONE, ingredient(BLOCK.COBBLESTONE)),
  smelt("bricks", BLOCK.BRICK, ingredient(BLOCK.CLAY)),
  smelt("steak", ITEM.STEAK, ingredient(ITEM.RAW_BEEF)),
  smelt("cooked_pork", ITEM.COOKED_PORK, ingredient(ITEM.RAW_PORK)),
  smelt("cooked_chicken", ITEM.COOKED_CHICKEN, ingredient(ITEM.RAW_CHICKEN)),
  smelt("cooked_mutton", ITEM.COOKED_MUTTON, ingredient(ITEM.RAW_MUTTON)),
  ...woodRecipes(),
  ...gearRecipes(),
  ...resourceRecipes(),
];

recipes.push(
  recipe(
    "shield",
    ITEM.SHIELD,
    1,
    [planks(6), ingredient(ITEM.IRON_INGOT)],
    "table"
  ),
  recipe(
    "iron_helmet",
    ITEM.IRON_HELMET,
    1,
    [ingredient(ITEM.IRON_INGOT, 5)],
    "table"
  ),
  recipe(
    "iron_leggings",
    ITEM.IRON_LEGGINGS,
    1,
    [ingredient(ITEM.IRON_INGOT, 7)],
    "table"
  ),
  recipe(
    "iron_boots",
    ITEM.IRON_BOOTS,
    1,
    [ingredient(ITEM.IRON_INGOT, 4)],
    "table"
  )
);

const freezeIngredient = (input) =>
  Object.freeze({
    ...input,
    ...(input.alternatives
      ? { alternatives: Object.freeze([...input.alternatives]) }
      : {}),
  });

export const RECIPES = Object.freeze(
  recipes.map((entry) => {
    const shape =
      patterns[entry.id] ?? (entry.pattern ? [entry.pattern, entry.key] : null);
    return Object.freeze({
      ...entry,
      output: Object.freeze(entry.output),
      ingredients: Object.freeze(entry.ingredients.map(freezeIngredient)),
      ...(shape
        ? {
            pattern: Object.freeze([...shape[0]]),
            key: Object.freeze(
              Object.fromEntries(
                Object.entries(shape[1]).map(([symbol, value]) => {
                  const input =
                    typeof value === "number"
                      ? entry.ingredients.find((input) => input.id === value)
                      : value;
                  if (!input || !getItem(input.id))
                    throw new RangeError(
                      `Unregistered pattern ingredient: ${entry.id}/${symbol}`
                    );
                  return [symbol, freezeIngredient({ ...input, count: 1 })];
                })
              )
            ),
            mirrored: true,
          }
        : entry.duration === 0
          ? { shapeless: true }
          : {}),
    });
  })
);
const recipeById = new Map(RECIPES.map((entry) => [entry.id, entry]));
if (recipeById.size !== RECIPES.length)
  throw new Error("Duplicate recipe identity");
export const getRecipe = (id) => recipeById.get(id) ?? null;
