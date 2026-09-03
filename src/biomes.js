import { BLOCK as B } from "./blocks.js";

const herbivores = ["sheep", "pig", "cow", "chicken"];
const woodland = [...herbivores, "wolf"];
const coldAnimals = ["rabbit", "fox", "wolf"];
const oceanAnimals = ["fish"];
const climates = {
  grassland: ["#83ac52", "#699947", "#4e9cac", "#c4dce0", 0.65],
  forest: ["#719b49", "#54823d", "#438baf", "#b4d1ce", 0.6],
  mountain: ["#7ba36a", "#689067", "#5299b9", "#d3e1e4", 0.35],
  snowy: ["#96b6a2", "#628b7b", "#629ec5", "#deedf0", 0.05],
  taiga: ["#789679", "#446b57", "#448cba", "#c2d9d8", 0.3],
  desert: ["#bbad61", "#a3a158", "#51aabc", "#ead5b2", 1],
  badlands: ["#b5a254", "#979440", "#659fb3", "#dfb48e", 1],
  savanna: ["#b0ae55", "#969a42", "#55999f", "#dfd5ad", 0.9],
  jungle: ["#61a13d", "#378638", "#38a094", "#b8d6b3", 0.95],
  swamp: ["#768148", "#647536", "#657c61", "#b9c5b0", 0.8],
  mushroom: ["#9e859c", "#a9a09d", "#776eae", "#d7c5dc", 0.65],
  ocean: ["#89b399", "#66917e", "#397dba", "#b8d9e8", 0.5],
  shore: ["#96ad75", "#709c67", "#54a4bc", "#d3e2db", 0.6],
  river: ["#7eaa68", "#659955", "#458fae", "#c3dcd5", 0.5],
  cave: ["#739753", "#588743", "#4c9898", "#36444d", 0.5],
  nether: ["#98764e", "#936743", "#dc7832", "#6a302c", 1],
  end: ["#c2c18d", "#a791b7", "#8b76a4", "#292334", 0.5],
  void: ["#a8a3b0", "#888192", "#68607d", "#181624", 0.5],
};

function biome(id, category, color, description, terrain = {}, options = {}) {
  const [grass, foliage, water, fog, temperature] = climates[category];
  return {
    id,
    name:
      options.name ??
      id
        .split("_")
        .map((part) => part[0].toUpperCase() + part.slice(1))
        .join(" "),
    dimension:
      category === "nether"
        ? "nether"
        : category === "end" || category === "void"
          ? "end"
          : "overworld",
    category,
    description,
    color,
    grassColor: grass,
    foliageColor: foliage,
    waterColor: water,
    fogColor: fog,
    temperature,
    trees: terrain.tree ? [terrain.tree] : [],
    mobs: herbivores,
    ...options,
    terrain: {
      height: 32,
      relief: 5,
      surface: B.GRASS,
      soil: B.DIRT,
      rock: B.STONE,
      density: 0,
      flowers: 0.025,
      ...terrain,
    },
  };
}

// Java 26.2 roster (66 IDs); descriptions and art palettes are original.
// Terrain parameters are deliberately separate from the UI-facing registry.
const definitions = [
  biome(
    "badlands",
    "badlands",
    "#bd7448",
    "Burnt-orange mesas reveal ribbons of ancient terracotta.",
    {
      height: 39,
      relief: 13,
      surface: B.RED_SAND,
      soil: B.TERRACOTTA,
      rock: B.TERRACOTTA,
    },
    { mobs: ["rabbit", "husk"] }
  ),
  biome(
    "bamboo_jungle",
    "jungle",
    "#85ac42",
    "Tall bamboo groves crowd a lush, rolling jungle floor.",
    { height: 33, relief: 6, tree: "jungle", density: 0.45, bamboo: 0.2 },
    { mobs: ["panda", "chicken"] }
  ),
  biome(
    "basalt_deltas",
    "nether",
    "#5c585d",
    "Jagged basalt columns rise above glowing lava channels.",
    {
      height: 30,
      relief: 13,
      surface: B.BASALT,
      soil: B.BLACKSTONE,
      rock: B.BLACKSTONE,
    },
    { fogColor: "#635955", mobs: ["ghast"] }
  ),
  biome(
    "beach",
    "shore",
    "#e2d198",
    "Pale sand traces the meeting of land and open sea.",
    { height: 24, relief: 1, surface: B.SAND, soil: B.SANDSTONE },
    { mobs: ["chicken"] }
  ),
  biome(
    "birch_forest",
    "forest",
    "#b1c773",
    "White-barked birches glow above a light green understory.",
    { height: 34, relief: 6, tree: "birch", density: 0.8 },
    { mobs: woodland }
  ),
  biome(
    "cherry_grove",
    "mountain",
    "#eeb2ca",
    "Pink blossom crowns drape soft, petal-covered hills.",
    { height: 45, relief: 8, tree: "cherry", density: 0.76, flowers: 0.2 },
    {
      grassColor: "#94b671",
      foliageColor: "#eda6c0",
      mobs: ["pig", "sheep", "rabbit"],
    }
  ),
  biome(
    "cold_ocean",
    "ocean",
    "#467fa2",
    "Cool blue water rolls above gravel and seagrass beds.",
    { height: 14, relief: 3, surface: B.GRAVEL, soil: B.GRAVEL },
    { temperature: 0.25, waterColor: "#387cab", mobs: oceanAnimals }
  ),
  biome(
    "crimson_forest",
    "nether",
    "#ab4653",
    "Crimson fungal crowns light a red, spore-rich landscape.",
    {
      height: 31,
      relief: 6,
      surface: B.NETHERRACK,
      soil: B.NETHERRACK,
      rock: B.NETHERRACK,
      tree: "crimson",
      density: 0.88,
    },
    { fogColor: "#79323d", foliageColor: "#b83e52", mobs: ["piglin"] }
  ),
  biome(
    "dark_forest",
    "forest",
    "#405735",
    "Broad dark oak canopies shelter enormous mushrooms.",
    { height: 35, relief: 6, tree: "dark", density: 0.96 },
    {
      grassColor: "#59703f",
      foliageColor: "#36552e",
      fogColor: "#a4b59c",
      mobs: ["wolf", "pig", "spider"],
    }
  ),
  biome(
    "deep_cold_ocean",
    "ocean",
    "#315d8b",
    "Deep, cold trenches hold dark gravel shelves.",
    { height: 7, relief: 3, surface: B.GRAVEL, soil: B.GRAVEL },
    { temperature: 0.25, waterColor: "#326895", mobs: oceanAnimals }
  ),
  biome(
    "deep_dark",
    "cave",
    "#23565d",
    "Silent low caverns are carpeted with faintly glowing sculk.",
    { height: 9, relief: 4, surface: B.SCULK },
    { fogColor: "#15242c", mobs: [] }
  ),
  biome(
    "deep_frozen_ocean",
    "ocean",
    "#609eb9",
    "Blue icebergs drift above the deepest frozen waters.",
    { height: 6, relief: 3, surface: B.GRAVEL, soil: B.GRAVEL },
    { temperature: 0, waterColor: "#427baa", mobs: ["polar_bear"] }
  ),
  biome(
    "deep_lukewarm_ocean",
    "ocean",
    "#3b8fa7",
    "Warm blue depths alternate between sandy ridges and clay.",
    { height: 8, relief: 3, surface: B.SAND, soil: B.CLAY },
    { temperature: 0.72, waterColor: "#348fa9", mobs: oceanAnimals }
  ),
  biome(
    "deep_ocean",
    "ocean",
    "#365d97",
    "An open blue expanse hides deep stone and gravel basins.",
    { height: 7, relief: 3, surface: B.GRAVEL, soil: B.CLAY },
    { waterColor: "#365e9d", mobs: oceanAnimals }
  ),
  biome(
    "desert",
    "desert",
    "#e3c787",
    "Wind-carved dunes, sandstone and solitary cacti stretch to the horizon.",
    { height: 32, relief: 7, surface: B.SAND, soil: B.SANDSTONE },
    { mobs: ["camel", "rabbit", "husk"] }
  ),
  biome(
    "dripstone_caves",
    "cave",
    "#b0947f",
    "Mineral chambers bristle with pointed stalactites and stalagmites.",
    { height: 20, relief: 5, surface: B.DRIPSTONE },
    { fogColor: "#574d47", mobs: ["spider", "zombie"] }
  ),
  biome(
    "end_barrens",
    "end",
    "#b5b787",
    "Bare end-stone ledges taper into the surrounding void.",
    {
      height: 27,
      relief: 3,
      surface: B.END_STONE,
      soil: B.END_STONE,
      rock: B.END_STONE,
    },
    { mobs: ["enderman"] }
  ),
  biome(
    "end_highlands",
    "end",
    "#d7d49c",
    "High floating islands support branching chorus groves.",
    {
      height: 48,
      relief: 9,
      surface: B.END_STONE,
      soil: B.END_STONE,
      rock: B.END_STONE,
    },
    { mobs: ["enderman"] }
  ),
  biome(
    "end_midlands",
    "end",
    "#c5c591",
    "Soft end-stone slopes connect the high island interiors.",
    {
      height: 37,
      relief: 5,
      surface: B.END_STONE,
      soil: B.END_STONE,
      rock: B.END_STONE,
    },
    { mobs: ["enderman"] }
  ),
  biome(
    "eroded_badlands",
    "badlands",
    "#c18765",
    "Isolated striped hoodoos rise from red-sand gullies.",
    {
      height: 35,
      relief: 23,
      surface: B.RED_SAND,
      soil: B.TERRACOTTA,
      rock: B.TERRACOTTA,
    },
    { mobs: ["rabbit", "husk"] }
  ),
  biome(
    "flower_forest",
    "forest",
    "#a3b966",
    "A bright woodland opens into dense wildflower clearings.",
    { height: 34, relief: 7, tree: "oak", density: 0.62, flowers: 0.38 },
    { mobs: ["rabbit", ...herbivores] }
  ),
  biome(
    "forest",
    "forest",
    "#609044",
    "Oak and birch trees frame green glades and quiet streams.",
    { height: 33, relief: 5, tree: "mixed", density: 0.78 },
    { mobs: woodland }
  ),
  biome(
    "frozen_ocean",
    "ocean",
    "#8cc8d8",
    "A fractured ice sheet surrounds sculpted icebergs.",
    { height: 13, relief: 3, surface: B.GRAVEL, soil: B.GRAVEL },
    { temperature: 0, waterColor: "#507fab", mobs: ["polar_bear"] }
  ),
  biome(
    "frozen_peaks",
    "snowy",
    "#cde5eb",
    "Smooth, gleaming blue ice caps crown high snowy summits.",
    { height: 65, relief: 15, surface: B.SNOW_BLOCK, soil: B.PACKED_ICE },
    { mobs: ["goat"] }
  ),
  biome(
    "frozen_river",
    "river",
    "#9cc9db",
    "Ice seals a winding channel through the cold landscape.",
    { height: 20, relief: 1, surface: B.GRAVEL, soil: B.CLAY },
    { temperature: 0, waterColor: "#6496bd", mobs: ["rabbit", "polar_bear"] }
  ),
  biome(
    "grove",
    "snowy",
    "#8ea69a",
    "Snowy spruce trees climb the sheltered mountain foothills.",
    { height: 46, relief: 9, surface: B.SNOW, tree: "spruce", density: 0.67 },
    { mobs: coldAnimals }
  ),
  biome(
    "ice_spikes",
    "snowy",
    "#b1d6df",
    "Tall packed-ice needles punctuate a snow-covered plain.",
    { height: 34, relief: 4, surface: B.SNOW_BLOCK, soil: B.SNOW_BLOCK },
    { mobs: ["rabbit", "polar_bear"] }
  ),
  biome(
    "jagged_peaks",
    "snowy",
    "#b3bfbe",
    "Exposed stone teeth and snowfields form a rugged skyline.",
    { height: 61, relief: 22, surface: B.SNOW, soil: B.STONE },
    { mobs: ["goat"] }
  ),
  biome(
    "jungle",
    "jungle",
    "#438e3c",
    "Giant jungle trunks, broad crowns and melons fill a humid forest.",
    { height: 34, relief: 8, tree: "jungle", density: 0.91 },
    { mobs: ["panda", "chicken"] }
  ),
  biome(
    "lukewarm_ocean",
    "ocean",
    "#51aab5",
    "Clear turquoise water reveals sandy shelves and seagrass.",
    { height: 15, relief: 3, surface: B.SAND, soil: B.CLAY },
    { temperature: 0.72, waterColor: "#379dab", mobs: oceanAnimals }
  ),
  biome(
    "lush_caves",
    "cave",
    "#75a85e",
    "Mossy chambers and hanging greenery gather around little pools.",
    { height: 20, relief: 6, surface: B.MOSS },
    { fogColor: "#3d5a50", foliageColor: "#73a44d", mobs: ["frog"] }
  ),
  biome(
    "mangrove_swamp",
    "swamp",
    "#698053",
    "Tangled mangrove roots stride across mud and shallow green water.",
    {
      height: 25,
      relief: 2,
      surface: B.MUD,
      soil: B.CLAY,
      tree: "mangrove",
      density: 0.9,
    },
    { waterColor: "#697d50", mobs: ["frog", "slime"] }
  ),
  biome(
    "meadow",
    "mountain",
    "#a3bc76",
    "Flower-strewn upland meadows offer wide mountain views.",
    { height: 43, relief: 8, flowers: 0.23 },
    { mobs: ["sheep", "rabbit", "horse"] }
  ),
  biome(
    "mushroom_fields",
    "mushroom",
    "#a0849b",
    "Quiet mycelium islands support enormous red and brown mushrooms.",
    {
      height: 31,
      relief: 6,
      surface: B.MYCELIUM,
      tree: "mushroom",
      density: 0.78,
    },
    { mobs: ["mooshroom"] }
  ),
  biome(
    "nether_wastes",
    "nether",
    "#a75743",
    "Red netherrack shelves overlook lava seas and glowstone.",
    {
      height: 28,
      relief: 8,
      surface: B.NETHERRACK,
      soil: B.NETHERRACK,
      rock: B.NETHERRACK,
    },
    { mobs: ["piglin", "ghast"] }
  ),
  biome(
    "ocean",
    "ocean",
    "#4f82b5",
    "A broad temperate sea carries gravel banks and waving seagrass.",
    { height: 14, relief: 4, surface: B.GRAVEL, soil: B.CLAY },
    { mobs: oceanAnimals }
  ),
  biome(
    "old_growth_birch_forest",
    "forest",
    "#becb8b",
    "Unusually tall white birches rise over fern-filled hills.",
    { height: 35, relief: 7, tree: "tall_birch", density: 0.72 },
    { mobs: woodland }
  ),
  biome(
    "old_growth_pine_taiga",
    "taiga",
    "#7a8664",
    "Tall, narrow pines tower above podzol and scattered boulders.",
    { height: 36, relief: 7, surface: B.PODZOL, tree: "pine", density: 0.72 },
    { mobs: coldAnimals }
  ),
  biome(
    "old_growth_spruce_taiga",
    "taiga",
    "#4e7160",
    "Huge tiered spruces shelter a mossy podzol forest floor.",
    {
      height: 37,
      relief: 8,
      surface: B.PODZOL,
      tree: "giant_spruce",
      density: 0.83,
    },
    { mobs: coldAnimals }
  ),
  biome(
    "pale_garden",
    "forest",
    "#b7bbae",
    "Silver leaves and pale trunks create a hushed, misty woodland.",
    { height: 35, relief: 5, surface: B.MOSS, tree: "pale", density: 0.88 },
    {
      grassColor: "#87947e",
      foliageColor: "#bdc4b6",
      fogColor: "#c7ccc3",
      mobs: [],
    }
  ),
  biome(
    "plains",
    "grassland",
    "#91b85b",
    "Open grassy country with gentle hills, ponds and room to build.",
    { height: 31, relief: 4, flowers: 0.025 },
    { mobs: [...herbivores, "horse"] }
  ),
  biome(
    "river",
    "river",
    "#619aaa",
    "A sinuous freshwater channel joins lowland valleys and lakes.",
    { height: 20, relief: 1, surface: B.GRAVEL, soil: B.CLAY },
    { mobs: ["frog", "fish"] }
  ),
  biome(
    "savanna",
    "savanna",
    "#b3af59",
    "Flat-topped acacias cast long shadows over golden grass.",
    { height: 33, relief: 4, tree: "acacia", density: 0.31 },
    { mobs: ["horse", "cow", "sheep"] }
  ),
  biome(
    "savanna_plateau",
    "savanna",
    "#bba266",
    "Golden, acacia-dotted tablelands stand above the surrounding plains.",
    { height: 48, relief: 5, tree: "acacia", density: 0.35 },
    { mobs: ["horse", "cow", "sheep"] }
  ),
  biome(
    "small_end_islands",
    "end",
    "#b8b28c",
    "Small floating fragments hang between the larger outer islands.",
    {
      height: 27,
      relief: 6,
      surface: B.END_STONE,
      soil: B.END_STONE,
      rock: B.END_STONE,
    },
    { mobs: ["enderman"] }
  ),
  biome(
    "snowy_beach",
    "shore",
    "#d7dacf",
    "Snow-dusted sand borders a cold and icy sea.",
    { height: 24, relief: 1, surface: B.SNOW, soil: B.SAND },
    { temperature: 0.05, mobs: ["rabbit"] }
  ),
  biome(
    "snowy_plains",
    "snowy",
    "#d9e5dd",
    "Gently rolling snowfields leave the winter sky wide open.",
    { height: 32, relief: 4, surface: B.SNOW, soil: B.DIRT },
    { mobs: ["rabbit", "polar_bear", "stray"] }
  ),
  biome(
    "snowy_slopes",
    "snowy",
    "#d3dcda",
    "Deep snow climbs steep, treeless mountain shoulders.",
    { height: 54, relief: 13, surface: B.SNOW_BLOCK, soil: B.SNOW_BLOCK },
    { mobs: ["goat", "rabbit"] }
  ),
  biome(
    "snowy_taiga",
    "snowy",
    "#87a99b",
    "Snow settles between dark, conical spruce trees.",
    { height: 34, relief: 6, surface: B.SNOW, tree: "spruce", density: 0.78 },
    { mobs: coldAnimals }
  ),
  biome(
    "soul_sand_valley",
    "nether",
    "#8c7663",
    "Soul-sand dunes surround white fossil ribs in a blue haze.",
    {
      height: 29,
      relief: 5,
      surface: B.SOUL_SAND,
      soil: B.SOUL_SAND,
      rock: B.NETHERRACK,
    },
    { fogColor: "#456267", mobs: ["skeleton", "ghast"] }
  ),
  biome(
    "sparse_jungle",
    "jungle",
    "#86ac52",
    "Sunny jungle edges mix scattered tall trees with long grass.",
    { height: 32, relief: 5, tree: "jungle", density: 0.3 },
    { mobs: ["chicken", "pig"] }
  ),
  biome(
    "stony_peaks",
    "mountain",
    "#a4a596",
    "Bare, warm stone ridges rise above the surrounding green lowlands.",
    { height: 60, relief: 19, surface: B.STONE, soil: B.STONE },
    { temperature: 0.8, mobs: ["goat"] }
  ),
  biome(
    "stony_shore",
    "shore",
    "#999e99",
    "Rocky coastal shelves descend through gravel to the sea.",
    { height: 27, relief: 3, surface: B.STONE, soil: B.GRAVEL },
    { mobs: ["goat"] }
  ),
  biome(
    "sunflower_plains",
    "grassland",
    "#bdc865",
    "Golden sunflower patches brighten an open, gentle plain.",
    { height: 31, relief: 3, flowers: 0.2 },
    { mobs: [...herbivores, "horse"] }
  ),
  biome(
    "swamp",
    "swamp",
    "#77845b",
    "Low oak islands and lily pads break up still, shallow water.",
    {
      height: 25,
      relief: 2,
      surface: B.MUD,
      soil: B.CLAY,
      tree: "swamp_oak",
      density: 0.52,
    },
    { mobs: ["frog", "slime", "pig"] }
  ),
  biome(
    "taiga",
    "taiga",
    "#678567",
    "Cool spruce woods grow over a fern-covered forest floor.",
    { height: 34, relief: 6, tree: "spruce", density: 0.82 },
    { mobs: coldAnimals }
  ),
  biome(
    "the_end",
    "end",
    "#dcd8a2",
    "A central end-stone island carries tall obsidian sentinels.",
    {
      height: 41,
      relief: 5,
      surface: B.END_STONE,
      soil: B.END_STONE,
      rock: B.END_STONE,
    },
    { name: "The End", mobs: ["enderman"] }
  ),
  biome(
    "the_void",
    "void",
    "#494154",
    "The open gulf between End islands. Bring creative flight.",
    { height: -1, relief: 0, surface: B.AIR, soil: B.AIR, rock: B.AIR },
    { name: "The Void", mobs: [] }
  ),
  biome(
    "warm_ocean",
    "ocean",
    "#5bc3c3",
    "Bright coral gardens flourish beneath clear, shallow turquoise water.",
    { height: 17, relief: 3, surface: B.SAND, soil: B.SANDSTONE },
    { temperature: 1, waterColor: "#39b6b8", mobs: oceanAnimals }
  ),
  biome(
    "warped_forest",
    "nether",
    "#3c9e98",
    "Turquoise fungal groves shine against dark Nether stone.",
    {
      height: 33,
      relief: 6,
      surface: B.MOSS,
      soil: B.NETHERRACK,
      rock: B.NETHERRACK,
      tree: "warped",
      density: 0.84,
    },
    { fogColor: "#285f62", foliageColor: "#36b5a7", mobs: ["enderman"] }
  ),
  biome(
    "windswept_forest",
    "mountain",
    "#809969",
    "Scattered spruce and oak trees cling to exposed green ridges.",
    { height: 46, relief: 15, tree: "mixed", density: 0.35 },
    { mobs: ["wolf", "sheep", "goat"] }
  ),
  biome(
    "windswept_gravelly_hills",
    "mountain",
    "#9f9e92",
    "Loose gravel blankets steep hills and bare stone outcrops.",
    { height: 48, relief: 17, surface: B.GRAVEL, soil: B.GRAVEL },
    { mobs: ["goat", "sheep"] }
  ),
  biome(
    "windswept_hills",
    "mountain",
    "#8a9a7d",
    "Grassy bluffs and exposed stone make a windswept skyline.",
    { height: 46, relief: 16 },
    { mobs: ["goat", "sheep"] }
  ),
  biome(
    "windswept_savanna",
    "savanna",
    "#a69a65",
    "Rugged, broken acacia hills interrupt the warm grasslands.",
    { height: 46, relief: 21, tree: "acacia", density: 0.29 },
    { mobs: ["horse", "goat"] }
  ),
  biome(
    "wooded_badlands",
    "badlands",
    "#998650",
    "Oak woodland crowns mesas of layered terracotta.",
    {
      height: 46,
      relief: 9,
      tree: "oak",
      density: 0.46,
      soil: B.TERRACOTTA,
      rock: B.TERRACOTTA,
    },
    { mobs: ["cow", "rabbit"] }
  ),
  // Append new biomes so existing chunk biome indices remain stable.
  biome(
    "sulfur_caves",
    "cave",
    "#d7c253",
    "Yellow sulfur and red cinnabar bands surround green mineral pools and pale crystal spikes.",
    { height: 17, relief: 5, surface: B.SULFUR, soil: B.CINNABAR },
    {
      temperature: 0.8,
      waterColor: "#98b94a",
      fogColor: "#596744",
      mobs: ["sulfur_cube", "cave_spider"],
    }
  ),
];

export const BIOMES = Object.freeze(
  definitions.map(({ terrain, ...entry }) => Object.freeze(entry))
);
export const BIOME_PROFILES = Object.freeze(
  Object.fromEntries(
    definitions.map(({ id, terrain }) => [id, Object.freeze(terrain)])
  )
);
const byId = new Map(BIOMES.map((entry) => [entry.id, entry]));
export const getBiomeById = (id) => byId.get(id) ?? null;
export const BIOME_INDEX = Object.freeze(
  Object.fromEntries(BIOMES.map((entry, index) => [entry.id, index]))
);
