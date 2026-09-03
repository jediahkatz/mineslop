import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK, BLOCK_CATALOG, BLOCKS } from "../src/blocks.js";
import {
  BLOCK_IDS,
  FIRST_EXPANSION_ITEM_ID,
  ITEM_IDS,
  MAX_BLOCK_ID,
} from "../src/content-ids.js";
import { usesHeldSprite } from "../src/held-item.js";
import { getItem, isBlockItem, ITEM, ITEMS } from "../src/items.js";
import { blockTexturePixels, itemTexturePixels } from "../src/textures.js";
import { itemCategory } from "../src/ui/model.js";

// These ordered names independently pin the identifiers already in saved worlds.
const oldBlocks = `
AIR GRASS DIRT STONE SAND OAK_LOG LEAVES PLANKS COBBLESTONE GLASS BRICK WATER
SNOW BEDROCK COAL_ORE BIRCH_LOG BIRCH_LEAVES GLOWSTONE RED_FLOWER YELLOW_FLOWER
SPRUCE_LOG SPRUCE_LEAVES ACACIA_LOG ACACIA_LEAVES JUNGLE_LOG JUNGLE_LEAVES
CHERRY_LOG CHERRY_LEAVES DARK_OAK_LOG DARK_OAK_LEAVES PALE_LOG PALE_LEAVES CACTUS
DEAD_BUSH TALL_GRASS PODZOL MUD MYCELIUM RED_MUSHROOM BROWN_MUSHROOM MUSHROOM_STEM
TERRACOTTA RED_TERRACOTTA ORANGE_TERRACOTTA YELLOW_TERRACOTTA WHITE_TERRACOTTA
RED_SAND SANDSTONE ICE PACKED_ICE BLUE_ICE SNOW_BLOCK GRAVEL CLAY MOSS DRIPSTONE
SCULK BAMBOO MANGROVE_LOG MANGROVE_LEAVES CORAL SEAGRASS IRON_ORE GOLD_ORE
DIAMOND_ORE COPPER_ORE REDSTONE_ORE EMERALD_ORE LAPIS_ORE OBSIDIAN NETHERRACK
SOUL_SAND BASALT BLACKSTONE CRIMSON_STEM CRIMSON_LEAVES WARPED_STEM WARPED_LEAVES
END_STONE PURPUR CHORUS LAVA TORCH CRAFTING_TABLE FURNACE CHEST WOOL TNT FARMLAND
WHEAT_CROP MELON PUMPKIN NETHER_PORTAL END_PORTAL SUGAR_CANE FERN LILY_PAD
SUNFLOWER PINK_PETALS SULFUR CINNABAR POTENT_SULFUR SULFUR_SPIKE CAVE_VINE GLOW_BERRIES
`
  .trim()
  .split(/\s+/);
const oldItems = `
WOOD_PICKAXE STONE_PICKAXE IRON_PICKAXE DIAMOND_PICKAXE WOOD_AXE STONE_AXE
IRON_AXE DIAMOND_AXE WOOD_SWORD STONE_SWORD IRON_SWORD DIAMOND_SWORD WOOD_SHOVEL
STONE_SHOVEL IRON_SHOVEL DIAMOND_SHOVEL STICK COAL IRON_INGOT GOLD_INGOT DIAMOND
RAW_BEEF STEAK RAW_PORK COOKED_PORK RAW_CHICKEN COOKED_CHICKEN RAW_MUTTON
COOKED_MUTTON APPLE BREAD WHEAT SEEDS LEATHER FEATHER BONE ARROW GUNPOWDER STRING
FLINT_AND_STEEL BUCKET WATER_BUCKET IRON_ARMOR EGG ENDER_PEARL RAW_IRON RAW_GOLD
RAW_COPPER COPPER_INGOT BOW REDSTONE EMERALD LAPIS FLINT SLIME_BALL SHIELD
IRON_HELMET IRON_LEGGINGS IRON_BOOTS
`
  .trim()
  .split(/\s+/);

test("all shipped block and ordinary-item identifiers retain their exact values", () => {
  assert.equal(oldBlocks.length, 105);
  assert.equal(oldItems.length, 59);
  for (const [id, name] of oldBlocks.entries()) {
    assert.equal(BLOCK_IDS[name], id, name);
    assert.equal(BLOCK[name], id, name);
    assert.equal(ITEM[name], id, name);
    assert.equal(BLOCKS[id].id, id);
    assert.equal(getItem(id).blockId, id);
  }
  for (const [offset, name] of oldItems.entries()) {
    const id = 256 + offset;
    assert.equal(ITEM_IDS[name], id, name);
    assert.equal(ITEM[name], id, name);
    assert.equal(getItem(id).id, id);
    assert.equal(BLOCKS[id], undefined);
  }
});

test("dense catalog iteration and sparse block-ID lookup are separate immutable contracts", () => {
  assert.ok(Object.isFrozen(BLOCK_CATALOG));
  assert.ok(Object.isFrozen(BLOCKS));
  assert.ok(Object.isFrozen(BLOCK_IDS));
  assert.ok(Object.isFrozen(ITEM_IDS));
  assert.equal(BLOCK_CATALOG.length, Object.keys(BLOCK_IDS).length);
  assert.equal(
    new Set(BLOCK_CATALOG.map(({ id }) => id)).size,
    BLOCK_CATALOG.length
  );
  assert.equal(new Set(ITEMS.map(({ id }) => id)).size, ITEMS.length);
  for (const block of BLOCK_CATALOG) {
    assert.ok(block && Object.isFrozen(block));
    assert.equal(BLOCKS[block.id], block);
    assert.ok(block.id >= 0 && block.id <= MAX_BLOCK_ID);
    assert.equal(getItem(block.id).kind, "block");
    assert.ok(getItem(block.drop), `registered drop for ${block.name}`);
  }
  for (const id of [105, 255, 256, 314, 315, FIRST_EXPANSION_ITEM_ID])
    assert.equal(
      BLOCKS[id],
      undefined,
      `${id} must not become a phantom block`
    );
  assert.ok(ITEMS.every((item) => item && Object.isFrozen(item)));
  assert.ok(
    ITEMS.every((item, index) => index === 0 || ITEMS[index - 1].id < item.id)
  );
});

test("high block IDs never collide with legacy tools or expansion materials", () => {
  assert.equal(BLOCK.COPPER_BLOCK, 1024);
  assert.equal(ITEM.PAPER, FIRST_EXPANSION_ITEM_ID);
  assert.ok(ITEM.BOOK > MAX_BLOCK_ID);
  for (const id of Object.values(ITEM_IDS)) {
    assert.ok(getItem(id));
    assert.equal(BLOCKS[id], undefined);
    assert.equal(isBlockItem(id), false);
  }
  assert.equal(isBlockItem(BLOCK.COPPER_BLOCK), true);
  assert.equal(getItem(BLOCK.COPPER_BLOCK).miningTool, "pickaxe");
  assert.equal(getItem(BLOCK.COPPER_BLOCK).tool, undefined);
  assert.equal(getItem(ITEM.WOOD_PICKAXE).tool, "pickaxe");
});

test("catalog categories and held rendering use registered kinds, not numeric ranges", () => {
  assert.equal(itemCategory(getItem(BLOCK.COPPER_BLOCK)), "blocks");
  assert.equal(itemCategory(getItem(BLOCK.OAK_SLAB)), "blocks");
  assert.equal(itemCategory(getItem(ITEM.WOOD_PICKAXE)), "tools");
  assert.equal(itemCategory(getItem(ITEM.PAPER)), "materials");
  assert.equal(itemCategory(getItem(ITEM.APPLE)), "food");
  assert.equal(itemCategory({ id: BLOCK.STONE, name: "Stone" }), "blocks");
  assert.equal(usesHeldSprite(BLOCK.COPPER_BLOCK), false);
  assert.equal(usesHeldSprite(BLOCK.OAK_SLAB), false);
  assert.equal(usesHeldSprite(BLOCK.KELP), true);
  assert.equal(usesHeldSprite(ITEM.WOOD_PICKAXE), true);
  assert.equal(usesHeldSprite(ITEM.PAPER), true);
  assert.equal(usesHeldSprite(987654321), false);
  assert.equal(isBlockItem(987654321), false);
});

test("high-ID block icons retain their actual block textures", () => {
  for (const id of [BLOCK.COPPER_BLOCK, BLOCK.OAK_SLAB, BLOCK.KELP]) {
    assert.deepEqual(itemTexturePixels(id), blockTexturePixels(id));
    assert.equal(itemTexturePixels(id).length, 16 * 16 * 4);
  }
  for (const id of [ITEM.PAPER, ITEM.BOOK]) {
    const pixels = itemTexturePixels(id);
    assert.equal(pixels.length, 16 * 16 * 4);
    assert.ok(pixels.some((value, index) => index % 4 === 3 && value > 0));
  }
});

test("initial shape definitions declare water coexistence without wet doors or beds", () => {
  for (const id of [
    BLOCK.OAK_SLAB,
    BLOCK.OAK_STAIRS,
    BLOCK.OAK_TRAPDOOR,
    BLOCK.OAK_FENCE,
    BLOCK.LADDER,
  ])
    assert.equal(BLOCKS[id].waterloggable, true);
  for (const id of [BLOCK.OAK_DOOR, BLOCK.WHITE_BED, BLOCK.OAK_FENCE_GATE])
    assert.notEqual(BLOCKS[id].waterloggable, true);
  assert.equal(BLOCKS[BLOCK.SEAGRASS].aquatic, true);
  assert.equal(BLOCKS[BLOCK.KELP].aquatic, true);
});
