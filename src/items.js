import { BLOCK, BLOCK_CATALOG } from "./blocks.js";
import { ITEM_IDS } from "./content-ids.js";
import { gearItems } from "./gear-content.js";
import {
  ORDINARY_ITEM_RESOURCE_LOCATIONS,
  resourceItems,
} from "./resource-content.js";
import { WOOD_FUELS, WOOD_LOG_ITEMS } from "./wood-content.js";

export { PLANK_ITEMS, WOOD_SLAB_ITEMS } from "./wood-content.js";

// Block-item identities and shipped ordinary-item IDs remain save compatible.
export const ITEM = Object.freeze({
  ...BLOCK,
  ...ITEM_IDS,
});

export const LOG_ITEMS = WOOD_LOG_ITEMS;

const fuels = new Map([
  [ITEM.COAL, 80],
  [BLOCK.DRIED_KELP_BLOCK, 200],
  [ITEM.BLAZE_ROD, 120],
  ...WOOD_FUELS,
  [ITEM.STICK, 5],
  [BLOCK.BAMBOO, 2.5],
  [BLOCK.COMPOSTER, 15],
  [BLOCK.LECTERN, 15],
  [BLOCK.CARTOGRAPHY_TABLE, 15],
  [BLOCK.SMITHING_TABLE, 15],
  [BLOCK.BARREL, 15],
  [BLOCK.BOOKSHELF, 15],
  [BLOCK.LADDER, 15],
  [BLOCK.CHEST, 15],
  [BLOCK.CRAFTING_TABLE, 15],
  [ITEM.BOW, 15],
  [ITEM.FISHING_ROD, 15],
  ...[
    ITEM.WOOD_PICKAXE,
    ITEM.WOOD_AXE,
    ITEM.WOOD_SWORD,
    ITEM.WOOD_SHOVEL,
    ITEM.WOOD_HOE,
  ].map((id) => [id, 10]),
]);

const material = (id, name, color, extra = {}) => ({
  id,
  name,
  color,
  kind: "material",
  ...extra,
});
const food = (id, name, color, hunger, saturation) => ({
  id,
  name,
  color,
  kind: "food",
  food: hunger,
  saturation,
});

const extras = [
  ...gearItems(),
  ...resourceItems(),
  material(ITEM.STICK, "Stick", "#957044"),
  material(ITEM.COAL, "Coal / charcoal", "#34343c"),
  material(ITEM.IRON_INGOT, "Iron ingot", "#d8dce1"),
  material(ITEM.GOLD_INGOT, "Gold ingot", "#edc84d"),
  material(ITEM.DIAMOND, "Diamond", "#5dd9d0"),
  food(ITEM.RAW_BEEF, "Raw beef", "#bb5554", 3, 1.8),
  food(ITEM.STEAK, "Steak", "#814633", 8, 12.8),
  food(ITEM.RAW_PORK, "Raw porkchop", "#e49a95", 3, 1.8),
  food(ITEM.COOKED_PORK, "Cooked porkchop", "#bf8c61", 8, 12.8),
  food(ITEM.RAW_CHICKEN, "Raw chicken", "#e2c1a7", 2, 1.2),
  food(ITEM.COOKED_CHICKEN, "Cooked chicken", "#bc8249", 6, 7.2),
  food(ITEM.RAW_MUTTON, "Raw mutton", "#b55457", 2, 1.2),
  food(ITEM.COOKED_MUTTON, "Cooked mutton", "#855547", 6, 9.6),
  food(ITEM.APPLE, "Apple", "#d84942", 4, 2.4),
  food(ITEM.BREAD, "Bread", "#cc9a50", 5, 6),
  material(ITEM.WHEAT, "Wheat", "#d7bb5a"),
  material(ITEM.SEEDS, "Wheat seeds", "#779845"),
  material(ITEM.LEATHER, "Leather", "#ad754a"),
  material(ITEM.FEATHER, "Feather", "#ece8de"),
  material(ITEM.BONE, "Bone", "#dcd7c6"),
  material(ITEM.ARROW, "Arrow", "#b3a28b"),
  material(ITEM.GUNPOWDER, "Gunpowder", "#6a6970", {
    brewingIngredient: "gunpowder",
  }),
  material(ITEM.STRING, "String", "#e4e0d6"),
  material(ITEM.FLINT_AND_STEEL, "Flint and steel", "#959aa5", {
    kind: "tool",
    tool: "firestarter",
    durability: 64,
    stackSize: 1,
  }),
  material(ITEM.BUCKET, "Bucket", "#b8c5cc", { stackSize: 16 }),
  material(ITEM.WATER_BUCKET, "Water bucket", "#548fc2", { stackSize: 1 }),
  material(ITEM.EGG, "Egg", "#e9dfbd", { stackSize: 16 }),
  material(ITEM.ENDER_PEARL, "Ender pearl", "#267e79", { stackSize: 16 }),
  material(ITEM.RAW_IRON, "Raw iron", "#c49d84"),
  material(ITEM.RAW_GOLD, "Raw gold", "#dfbb54"),
  material(ITEM.RAW_COPPER, "Raw copper", "#be825d"),
  material(ITEM.COPPER_INGOT, "Copper ingot", "#c3845c"),
  material(ITEM.BOW, "Bow", "#b58a58", {
    kind: "tool",
    tool: "bow",
    damage: 4,
    durability: 384,
    stackSize: 1,
  }),
  material(ITEM.REDSTONE, "Redstone dust", "#c6403e", {
    brewingIngredient: "redstone",
  }),
  material(ITEM.EMERALD, "Emerald", "#53ce78"),
  material(ITEM.LAPIS, "Lapis lazuli", "#456bc0", {
    enchantingReagent: "lapis",
  }),
  material(ITEM.FLINT, "Flint", "#5f626e"),
  material(ITEM.SLIME_BALL, "Slime ball", "#83bd67"),
  material(ITEM.SHIELD, "Shield", "#a38a69", {
    kind: "equipment",
    icon: "shield",
    tool: "shield",
    durability: 336,
    stackSize: 1,
    // The world/combat bridge tests direction and held-use time; inventory does
    // not grant passive shield protection merely for carrying one.
    shield: Object.freeze({ arc: 180, raiseTime: 0.25 }),
  }),
  material(ITEM.PAPER, "Paper", "#e7e2d1", {
    art: Object.freeze({ kind: "paper" }),
  }),
  material(ITEM.BOOK, "Book", "#956746", {
    kind: "book",
    enchantable: true,
    enchantability: 1,
    art: Object.freeze({ kind: "book" }),
  }),
  material(ITEM.QUARTZ, "Nether quartz", "#e7dec8", {
    art: Object.freeze({ kind: "quartz" }),
  }),
  material(ITEM.NETHERITE_SCRAP, "Netherite scrap", "#675249", {
    art: Object.freeze({ kind: "netherite_scrap" }),
  }),
  material(ITEM.GOLD_NUGGET, "Gold nugget", "#dec064", {
    art: Object.freeze({ kind: "gold_nugget" }),
  }),
  material(ITEM.NETHERITE_INGOT, "Netherite ingot", "#594c48", {
    art: Object.freeze({ kind: "netherite_ingot" }),
  }),
  material(ITEM.PRISMARINE_SHARD, "Prismarine shard", "#72aaa0", {
    art: Object.freeze({ kind: "prismarine_shard" }),
  }),
  material(ITEM.PRISMARINE_CRYSTALS, "Prismarine crystals", "#b3d4bd", {
    art: Object.freeze({ kind: "prismarine_crystals" }),
  }),
  material(ITEM.NETHER_WART, "Nether wart", "#a7474f", {
    brewingIngredient: "nether_wart",
    plantBlock: BLOCK.NETHER_WART_CROP,
    art: Object.freeze({ kind: "nether_wart" }),
  }),
  material(ITEM.NETHER_BRICK, "Nether brick", "#492d35", {
    art: Object.freeze({ kind: "nether_brick" }),
  }),
];

// A dense iterable catalog, not an ID-indexed array; always look up via getItem.
export const ITEMS = Object.freeze(
  [
    ...BLOCK_CATALOG.map(({ tool, tier, ...block }) => ({
      ...block,
      kind: "block",
      blockId: block.id,
      miningTool: tool,
      miningTier: tier,
      placeable: block.id !== BLOCK.AIR,
      ...(block.id === BLOCK.MELON ? { food: 4, saturation: 2.4 } : {}),
    })),
    ...extras,
  ]
    .sort((a, b) => a.id - b.id)
    .map((item) =>
      Object.freeze({
        stackSize: 64,
        placeable: false,
        ...(Object.hasOwn(ORDINARY_ITEM_RESOURCE_LOCATIONS, item.id)
          ? { resourceLocation: ORDINARY_ITEM_RESOURCE_LOCATIONS[item.id] }
          : {}),
        ...item,
        fuel: fuels.get(item.id) ?? 0,
      })
    )
);

const itemById = new Map(ITEMS.map((item) => [item.id, item]));
if (itemById.size !== ITEMS.length)
  throw new Error("Duplicate block/item registry identity");
for (const id of Object.values(ITEM_IDS)) {
  if (!itemById.has(id)) throw new Error(`Missing item definition: ${id}`);
}
export const getItem = (id) => itemById.get(id) ?? null;
export const isBlockItem = (id) => getItem(id)?.kind === "block";

// Prefer efficient fuel, then wood; ingredient reservation happens before fuel.
export const FUEL_ITEMS = Object.freeze([...fuels.keys()]);
