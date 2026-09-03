import assert from "node:assert/strict";
import test from "node:test";
import { BIOME_PROFILES, BIOMES, getBiomeById } from "../src/biomes.js";
import {
  BLOCK,
  BLOCK_CATALOG,
  BLOCKS,
  HOTBAR,
  isSolid,
  isTransparent,
} from "../src/blocks.js";
import { MAX_BLOCK_ID } from "../src/content-ids.js";
import { getItem } from "../src/items.js";

test("block metadata covers every fixed integration ID without losing v1 semantics", () => {
  // Numeric IDs are the save-file and cross-worker wire format, not tunable config.
  const original = [
    "AIR",
    "GRASS",
    "DIRT",
    "STONE",
    "SAND",
    "OAK_LOG",
    "LEAVES",
    "PLANKS",
    "COBBLESTONE",
    "GLASS",
    "BRICK",
    "WATER",
    "SNOW",
    "BEDROCK",
    "COAL_ORE",
    "BIRCH_LOG",
    "BIRCH_LEAVES",
    "GLOWSTONE",
    "RED_FLOWER",
    "YELLOW_FLOWER",
  ];
  original.forEach((name, id) => assert.equal(BLOCK[name], id));
  assert.equal(Object.keys(BLOCK).length, BLOCK_CATALOG.length);
  assert.ok(
    BLOCK_CATALOG.every(({ id }) => id <= MAX_BLOCK_ID),
    "registered block IDs fit the Uint16 resident format"
  );
  assert.deepEqual(
    [BLOCK.SULFUR, BLOCK.CINNABAR, BLOCK.POTENT_SULFUR, BLOCK.SULFUR_SPIKE],
    [99, 100, 101, 102]
  );
  assert.deepEqual([BLOCK.CAVE_VINE, BLOCK.GLOW_BERRIES], [103, 104]);
  assert.deepEqual(
    new Set(Object.values(BLOCK)),
    new Set(BLOCK_CATALOG.map(({ id }) => id))
  );
  const textures = new Set([
    "grass",
    "dirt",
    "stone",
    "sand",
    "log",
    "leaves",
    "planks",
    "brick",
    "ore",
    "flower",
    "glass",
    "water",
    "lava",
    "mushroom",
    "cactus",
    "special",
    "metal",
    "bookshelf",
    "ladder",
    "bed",
    "magma",
    "kelp",
    "sea_lantern",
  ]);
  for (const block of BLOCK_CATALOG) {
    assert.equal(BLOCKS[block.id], block);
    assert.ok(block.name);
    assert.match(block.color, /^#[0-9a-f]{6}$/i);
    assert.equal(typeof block.solid, "boolean");
    assert.equal(typeof block.transparent, "boolean");
    assert.ok(
      [
        "cube",
        "cross",
        "slab",
        "stairs",
        "door",
        "trapdoor",
        "fence",
        "fence_gate",
        "ladder",
        "bed",
      ].includes(block.shape)
    );
    assert.ok(textures.has(block.texture), block.name);
    assert.ok(block.hardness >= 0);
    assert.ok(getItem(block.drop));
    if (block.shape === "cross") {
      assert.equal(block.solid, false);
      assert.equal(block.transparent, true);
    }
    if (block.tool)
      assert.ok(["pickaxe", "axe", "shovel", "hoe"].includes(block.tool));
  }
  assert.deepEqual(HOTBAR, [1, 2, 3, 7, 8, 9, 10, 5, 17]);
  assert.equal(isSolid(BLOCK.WATER), false);
  assert.equal(isSolid(BLOCK.LAVA), false);
  assert.equal(isSolid(BLOCK.GLASS), true);
  assert.equal(isTransparent(BLOCK.ICE), true);
  assert.equal(isTransparent(BLOCK.STONE), false);
  // Regression: copper metadata must require the same stone tier as harvesting.
  assert.equal(BLOCKS[BLOCK.COPPER_ORE].tier, 2);
  assert.equal(BLOCKS[BLOCK.POTENT_SULFUR].emissive, true);
  assert.equal(BLOCKS[BLOCK.SULFUR_SPIKE].shape, "cross");
});

test("catalog includes the complete external Java 26.2 registry roster", () => {
  // Registry baseline: https://www.digminecraft.com/lists/biome_list_pc.php.
  // 26.2 addition: https://www.minecraft.net/en-us/article/minecraft-java-edition-26-2.
  const registry =
    `badlands bamboo_jungle basalt_deltas beach birch_forest cherry_grove
    cold_ocean crimson_forest dark_forest deep_cold_ocean deep_dark deep_frozen_ocean
    deep_lukewarm_ocean deep_ocean desert dripstone_caves end_barrens end_highlands
    end_midlands eroded_badlands flower_forest forest frozen_ocean frozen_peaks
    frozen_river grove ice_spikes jagged_peaks jungle lukewarm_ocean lush_caves
    mangrove_swamp meadow mushroom_fields nether_wastes ocean old_growth_birch_forest
    old_growth_pine_taiga old_growth_spruce_taiga pale_garden plains river savanna
    savanna_plateau small_end_islands snowy_beach snowy_plains snowy_slopes snowy_taiga
    soul_sand_valley sparse_jungle stony_peaks stony_shore sulfur_caves sunflower_plains swamp taiga
    the_end the_void warm_ocean warped_forest windswept_forest windswept_gravelly_hills
    windswept_hills windswept_savanna wooded_badlands`
      .trim()
      .split(/\s+/);
  assert.deepEqual(BIOMES.map(({ id }) => id).sort(), registry.sort());
  assert.equal(new Set(BIOMES.map(({ id }) => id)).size, BIOMES.length);
  for (const biome of BIOMES) {
    assert.equal(getBiomeById(biome.id), biome);
    assert.ok(["overworld", "nether", "end"].includes(biome.dimension));
    assert.ok(biome.name && biome.category && biome.description.length > 20);
    for (const field of [
      "color",
      "grassColor",
      "foliageColor",
      "waterColor",
      "fogColor",
    ])
      assert.match(biome[field], /^#[0-9a-f]{6}$/i, `${biome.id}: ${field}`);
    assert.ok(Number.isFinite(biome.temperature));
    const profile = BIOME_PROFILES[biome.id];
    for (const material of [profile.surface, profile.soil, profile.rock])
      assert.ok(BLOCKS[material]);
    assert.ok(
      Number.isFinite(profile.height) && Number.isFinite(profile.relief)
    );
  }
  assert.equal(getBiomeById("unknown"), null);
});
