import { BLOCK_IDS, ITEM_IDS, MAX_BLOCK_ID } from "./content-ids.js";
import { expansionBlocks } from "./expansion-blocks.js";
import { WOOD_FAMILIES, woodBlockProperties } from "./wood-content.js";

export const BLOCK = BLOCK_IDS;

// Texture classes and original palettes are shared by the atlas, icons and meshes.
const cube = (name, color, texture, hardness = 1.5, extra = {}) => ({
  name,
  color,
  solid: true,
  transparent: false,
  shape: "cube",
  texture,
  hardness,
  ...extra,
});
const soil = (name, color, texture = "dirt") =>
  cube(name, color, texture, 0.6, { tool: "shovel" });
const rock = (name, color, texture = "stone", extra = {}) =>
  cube(name, color, texture, 1.5, { tool: "pickaxe", tier: 1, ...extra });
const log = (name, color) =>
  cube(name, color, "log", 2, { tool: "axe", directional: "axis" });
const leaves = (name, color) =>
  cube(name, color, "leaves", 0.2, { transparent: true });
const plant = (name, color, texture = "flower", extra = {}) =>
  cube(name, color, texture, 0, {
    solid: false,
    transparent: true,
    shape: "cross",
    ...extra,
  });
const ore = (name, color, tier) =>
  rock(name, color, "ore", { hardness: 3, tier });

const legacyBlocks = [
  cube("Air", "#ffffff", "special", 0, { solid: false, transparent: true }),
  soil("Grass", "#78a843", "grass"),
  soil("Dirt", "#906442"),
  rock("Stone", "#92969b", "stone", { drop: BLOCK.COBBLESTONE }),
  soil("Sand", "#e4d29a", "sand"),
  log("Oak log", "#765334"),
  leaves("Oak leaves", "#578a3d"),
  cube("Oak planks", "#bd955d", "planks", 2, {
    tool: "axe",
    ...woodBlockProperties(WOOD_FAMILIES[0], "planks"),
  }),
  rock("Cobblestone", "#7c858a", "brick", {
    hardness: 2,
    resourceLocation: "minecraft:cobblestone",
  }),
  cube("Glass", "#c4e9ed", "glass", 0.3, { transparent: true }),
  rock("Brick", "#af604d", "brick", { hardness: 2 }),
  cube("Water", "#489fbb", "water", 100, { solid: false, transparent: true }),
  soil("Snow", "#f1f3ec", "sand"),
  rock("Bedrock", "#41454b", "stone", { hardness: Infinity, tier: 99 }),
  ore("Coal ore", "#60646a", 1),
  log("Birch log", "#e4dfcf"),
  leaves("Birch leaves", "#89ad4b"),
  cube("Glowstone", "#ffcf72", "special", 0.3, {
    emissive: true,
    drop: ITEM_IDS.GLOWSTONE_DUST,
    dropCount: Object.freeze([2, 4]),
    silkDrop: BLOCK.GLOWSTONE,
  }),
  plant("Poppy", "#e5614d"),
  plant("Dandelion", "#f3cd4d"),
  log("Spruce log", "#514134"),
  leaves("Spruce leaves", "#38604a"),
  log("Acacia log", "#8b7262"),
  leaves("Acacia leaves", "#929948"),
  log("Jungle log", "#756b40"),
  leaves("Jungle leaves", "#3e893c"),
  log("Cherry log", "#68424b"),
  leaves("Cherry leaves", "#f2a6c1"),
  log("Dark oak log", "#413329"),
  leaves("Dark oak leaves", "#355731"),
  log("Pale oak log", "#c8c2b4"),
  leaves("Pale oak leaves", "#a8b4a2"),
  cube("Cactus", "#548951", "cactus", 0.4),
  plant("Dead bush", "#92704a"),
  plant("Tall grass", "#719d45", "leaves"),
  soil("Podzol", "#79563e", "grass"),
  soil("Mud", "#574d47"),
  soil("Mycelium", "#98818f", "grass"),
  cube("Red mushroom", "#c75049", "mushroom", 0.2),
  cube("Brown mushroom", "#b0967b", "mushroom", 0.2),
  log("Mushroom stem", "#ded9bd"),
  rock("Terracotta", "#aa704e", "sand"),
  rock("Red terracotta", "#944e3c", "sand"),
  rock("Orange terracotta", "#c78048", "sand"),
  rock("Yellow terracotta", "#d9aa57", "sand"),
  rock("White terracotta", "#d9bca7", "sand"),
  soil("Red sand", "#cd894b", "sand"),
  rock("Sandstone", "#d9c48d", "brick", { hardness: 0.8 }),
  cube("Ice", "#a4d4e8", "glass", 0.5, { transparent: true, tool: "pickaxe" }),
  rock("Packed ice", "#93c3df", "glass", { hardness: 0.5 }),
  rock("Blue ice", "#689dcc", "glass", { hardness: 2.8 }),
  soil("Snow block", "#e4eef0", "sand"),
  soil("Gravel", "#94928b", "stone"),
  soil("Clay", "#a0a7ad"),
  soil("Moss", "#6e9147", "grass"),
  rock("Dripstone", "#a28872", "stone"),
  cube("Sculk", "#184a50", "special", 0.6, { emissive: true }),
  plant("Bamboo", "#90ae4e", "log", { hardness: 0.4, tool: "axe" }),
  log("Mangrove log", "#73564a"),
  leaves("Mangrove leaves", "#4d7842"),
  cube("Coral", "#de779c", "special", 0.5),
  plant("Seagrass", "#4c9977", "leaves", {
    aquatic: true,
    waterloggable: true,
  }),
  ore("Iron ore", "#caa58a", 2),
  ore("Gold ore", "#e4bd59", 3),
  ore("Diamond ore", "#6de0d8", 3),
  ore("Copper ore", "#be8261", 2),
  ore("Redstone ore", "#c54c49", 3),
  ore("Emerald ore", "#56c284", 3),
  ore("Lapis ore", "#4d71b8", 2),
  rock("Obsidian", "#33283f", "stone", { hardness: 50, tier: 4 }),
  rock("Netherrack", "#85463f", "stone", { hardness: 0.4 }),
  soil("Soul sand", "#71604e", "sand"),
  rock("Basalt", "#54545a", "log", {
    hardness: 1.25,
    directional: "axis",
  }),
  rock("Blackstone", "#39363e", "brick", {
    resourceLocation: "minecraft:blackstone",
  }),
  log("Crimson stem", "#874b58"),
  leaves("Crimson canopy", "#aa3b4a"),
  log("Warped stem", "#397f81"),
  leaves("Warped canopy", "#38a69b"),
  rock("End stone", "#dddba5", "stone", { hardness: 3 }),
  rock("Purpur", "#aa86b0", "brick"),
  plant("Chorus plant", "#85627f", "special", { hardness: 0.4 }),
  cube("Lava", "#f68b32", "lava", 100, {
    solid: false,
    transparent: true,
    emissive: true,
  }),
  plant("Torch", "#ffc967", "special", { emissive: true }),
  cube("Crafting table", "#a57c49", "planks", 2.5, { tool: "axe" }),
  rock("Furnace", "#737478", "brick", { hardness: 3.5 }),
  cube("Chest", "#a77737", "planks", 2.5, { tool: "axe" }),
  cube("Wool", "#eee8dc", "special", 0.8),
  cube("TNT", "#c85543", "special", 0),
  soil("Farmland", "#725233"),
  plant("Wheat crop", "#d6bd57", "leaves"),
  cube("Melon", "#87a54c", "cactus", 1, {
    tool: "axe",
    drop: ITEM_IDS.MELON_SLICE,
    dropCount: Object.freeze([3, 7]),
    silkDrop: BLOCK.MELON,
  }),
  cube("Pumpkin", "#d29645", "cactus", 1, { tool: "axe" }),
  cube("Nether portal", "#a465dc", "special", 100, {
    solid: false,
    transparent: true,
    emissive: true,
  }),
  cube("End portal", "#4eaaa6", "special", 100, {
    solid: false,
    transparent: true,
    emissive: true,
  }),
  plant("Sugar cane", "#9fbc68", "log"),
  plant("Fern", "#53864d", "leaves"),
  plant("Lily pad", "#42805b", "leaves"),
  plant("Sunflower", "#efc949"),
  plant("Pink petals", "#edafc4"),
  rock("Sulfur", "#e1ca50"),
  rock("Cinnabar", "#ba5149"),
  rock("Potent sulfur", "#a9c84b", "special", { emissive: true }),
  plant("Sulfur spike", "#e6d773", "special", {
    hardness: 1,
    tool: "pickaxe",
    tier: 1,
  }),
  plant("Cave vine", "#648c46", "leaves"),
  plant("Glow berries", "#efbd61", "leaves", { emissive: true }),
].map((block, id) => Object.freeze({ id, drop: id, ...block }));

const definitions = [
  ...legacyBlocks,
  ...expansionBlocks({ cube, rock, plant }),
];
const registeredIds = new Set(Object.values(BLOCK));
const indexed = [];
for (const definition of definitions) {
  const { id } = definition;
  if (
    !Number.isInteger(id) ||
    id < 0 ||
    id > MAX_BLOCK_ID ||
    !registeredIds.has(id) ||
    indexed[id]
  )
    throw new Error(`Invalid or duplicate block definition: ${id}`);
  indexed[id] = Object.freeze(definition);
}
for (const id of registeredIds) {
  if (!indexed[id]) throw new Error(`Missing block definition: ${id}`);
}

// Indexed lookup and dense iteration are deliberately separate contracts.
export const BLOCKS = Object.freeze(indexed);
export const BLOCK_CATALOG = Object.freeze(
  definitions.map(({ id }) => BLOCKS[id]).sort((a, b) => a.id - b.id)
);

export const HOTBAR = [1, 2, 3, 7, 8, 9, 10, 5, 17];
export const isSolid = (id) => BLOCKS[id]?.solid === true;
export const isTransparent = (id) => BLOCKS[id]?.transparent !== false;
