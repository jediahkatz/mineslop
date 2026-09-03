import { BLOCK as B } from "./blocks.js";
import { hash, noise } from "./noise.js";

export const strata = [
  B.TERRACOTTA,
  B.ORANGE_TERRACOTTA,
  B.ORANGE_TERRACOTTA,
  B.YELLOW_TERRACOTTA,
  B.TERRACOTTA,
  B.RED_TERRACOTTA,
  B.RED_TERRACOTTA,
  B.WHITE_TERRACOTTA,
  B.TERRACOTTA,
  B.ORANGE_TERRACOTTA,
  B.TERRACOTTA,
  B.YELLOW_TERRACOTTA,
];
const cold = [
  "snowy_plains",
  "snowy_taiga",
  "ice_spikes",
  "grove",
  "snowy_slopes",
  "frozen_peaks",
  "jagged_peaks",
];
const cool = [
  "taiga",
  "old_growth_pine_taiga",
  "old_growth_spruce_taiga",
  "windswept_hills",
  "windswept_forest",
  "windswept_gravelly_hills",
];
const temperate = [
  "plains",
  "sunflower_plains",
  "forest",
  "flower_forest",
  "birch_forest",
  "old_growth_birch_forest",
  "dark_forest",
  "pale_garden",
  "meadow",
  "cherry_grove",
];
const arid = [
  "desert",
  "savanna",
  "savanna_plateau",
  "windswept_savanna",
  "badlands",
  "eroded_badlands",
  "wooded_badlands",
  "stony_peaks",
];
const tropical = ["jungle", "bamboo_jungle", "sparse_jungle", "mangrove_swamp"];
const nether = [
  "nether_wastes",
  "soul_sand_valley",
  "crimson_forest",
  "warped_forest",
  "basalt_deltas",
];
const select = (values, value) =>
  values[Math.min(values.length - 1, Math.floor(value * values.length))];

export function oceanId(temperature, deep) {
  if (temperature < 0.23) return deep ? "deep_frozen_ocean" : "frozen_ocean";
  if (temperature < 0.4) return deep ? "deep_cold_ocean" : "cold_ocean";
  if (temperature < 0.64) return deep ? "deep_ocean" : "ocean";
  if (temperature < 0.8) return deep ? "deep_lukewarm_ocean" : "lukewarm_ocean";
  return "warm_ocean";
}

export function selectRegionBiome(
  dimension,
  temperature,
  moisture,
  continental,
  variant
) {
  if (dimension === "nether") return select(nether, variant);
  if (continental < 0.39) return oceanId(temperature, continental < 0.28);
  if (continental < 0.49 && variant < 0.13) return "mushroom_fields";
  if (temperature < 0.26) return select(cold, variant);
  if (temperature < 0.4) return select(cool, variant);
  if (temperature > 0.65 && moisture < 0.55) return select(arid, variant);
  if (temperature > 0.65) return select(tropical, variant);
  if (moisture > 0.68) return variant < 0.65 ? "swamp" : "dark_forest";
  return select(temperate, variant);
}

function baseCaveId(col, y) {
  return y <= 12
    ? "deep_dark"
    : col.caveHumidity > 0.49
      ? "lush_caves"
      : "dripstone_caves";
}

export function caveId(col, y) {
  if (col.sulfur && y >= col.sulfur.low - 4 && y <= col.sulfur.high + 2)
    return "sulfur_caves";
  return baseCaveId(col, y);
}

export function sulfurPocket(col, field, salt) {
  if (
    col.top < 25 ||
    col.top > 42 ||
    col.temperature < 0.55 ||
    field.nearest.moisture < 0.48 ||
    field.ocean > 0.1 ||
    field.relief > 8 ||
    col.profile.relief > 8
  )
    return null;
  const density = noise(col.x / 125, col.z / 125, salt ^ 9791);
  if (density < 0.62) return null;
  return {
    low: 17,
    high: Math.min(
      col.top - 5,
      25 + Math.floor(noise(col.x / 78, col.z / 78, salt ^ 3793) * 3)
    ),
    open: density > 0.66,
    pool: noise(col.x / 28, col.z / 28, salt ^ 6977) > 0.55,
  };
}

function sulfurBlock(id, col, y, chance) {
  const { low, high, open, pool } = col.sulfur;
  if (y < low - 4 || y > high + 2) return id;
  const band =
    Math.floor((y + col.strataOffset) / 2) % 2 ? B.CINNABAR : B.SULFUR;
  if (!open) return band;
  if (y < low) {
    if (pool && y === low - 3) return B.POTENT_SULFUR;
    if (pool && y > low - 3) return B.WATER;
    return y === low - 1 ? B.SULFUR : band;
  }
  if (y > high) return y === high + 1 ? B.SULFUR : band;
  const spikeHeight = 1 + Math.floor((chance % 0.1) * 30);
  if (
    (!pool && chance < 0.1 && y < low + spikeHeight) ||
    (chance > 0.9 && y > high - spikeHeight)
  )
    return B.SULFUR_SPIKE;
  return B.AIR;
}

function carveNaturalCaves(id, col, y, chance) {
  const growth = col.caveGrowth;
  for (const [low, high] of col.caves) {
    if (y >= low && y <= high) {
      id = B.AIR;
      const biome = baseCaveId(col, y);
      if (biome === "dripstone_caves" && high - low >= 6) {
        if ((chance < 0.08 && y === low) || (chance > 0.94 && y >= high - 1))
          id = B.DRIPSTONE;
      }
      // A short, real block chain hangs from the final (merged) rock ceiling.
      // Keep three cells clear above the floor; an open entrance has no anchor.
      if (
        !col.sulfur &&
        biome === "lush_caves" &&
        high + 1 < col.top - 3 &&
        growth > 0.46 &&
        chance < 0.1
      ) {
        const length = Math.min(
          high - low - 2,
          1 + (Math.floor(chance * 977) % 4)
        );
        const tip = high - length + 1;
        // Berry-bearing tips are rare even within the denser, coherent growth
        // pockets. Most hanging chains are ordinary, unlit foliage.
        if (y >= tip)
          id =
            y === tip && growth > 0.62 && Math.floor(chance * 10000) % 11 === 0
              ? B.GLOW_BERRIES
              : B.CAVE_VINE;
      }
    } else if (y === low - 1 || y === high + 1) {
      const biome = baseCaveId(col, y);
      // Coherent patches expose rock/ore between growth, not two continuous
      // moss/sculk sheets. The supporting voxels remain fully collidable.
      if (biome === "deep_dark" && growth > 0.43) id = B.SCULK;
      else if (biome === "lush_caves" && growth > (y < low ? 0.38 : 0.55))
        id = B.MOSS;
      else if (biome === "dripstone_caves" && growth < 0.48) id = B.DRIPSTONE;
    }
  }
  return col.sulfur ? sulfurBlock(id, col, y, chance) : id;
}

// All density/noise work is column-scoped; this voxel pass only applies cached
// cave intervals and material bands. Saved v1/v2 behavior stays unchanged.
export function carveCaves(id, col, y, chance) {
  if (col.naturalCaves) return carveNaturalCaves(id, col, y, chance);
  for (const [low, high] of col.caves) {
    if (high - low < 3) continue;
    const biome = baseCaveId(col, low + 1);
    if (y >= low && y <= high) {
      id = B.AIR;
      if (
        biome === "dripstone_caves" &&
        chance < 0.09 &&
        (y < low + 2 || y > high - 2)
      )
        id = B.DRIPSTONE;
      if (biome === "lush_caves" && y === high && chance < 0.12) id = B.MOSS;
      if (biome === "lush_caves" && y === high - 1 && chance < 0.025)
        id = B.GLOWSTONE;
    } else if (y === low - 1 || y === high + 1) {
      id =
        biome === "deep_dark"
          ? B.SCULK
          : biome === "lush_caves"
            ? B.MOSS
            : B.DRIPSTONE;
    }
  }
  return col.sulfur ? sulfurBlock(id, col, y, chance) : id;
}

export function oreCell(x, gy, z, salt) {
  const chance = hash(x, z, salt ^ Math.imul(gy + 1, 7673));
  const y = gy * 4;
  if (chance < 0.025) return B.COAL_ORE;
  if (chance < 0.044 && y < 56) return B.IRON_ORE;
  if (chance < 0.05 && y < 28) return B.GOLD_ORE;
  if (chance < 0.055 && y < 16) return B.DIAMOND_ORE;
  if (chance < 0.063 && y < 20) return B.REDSTONE_ORE;
  if (chance < 0.077 && y >= 16 && y < 52) return B.COPPER_ORE;
  if (chance < 0.08 && y >= 12 && y < 60) return B.EMERALD_ORE;
  if (chance < 0.087 && y < 28) return B.LAPIS_ORE;
  return B.STONE;
}

export const TREE_SPECIES = {
  oak: [B.OAK_LOG, B.LEAVES, 5, 3],
  birch: [B.BIRCH_LOG, B.BIRCH_LEAVES, 7, 2],
  tall_birch: [B.BIRCH_LOG, B.BIRCH_LEAVES, 13, 3],
  dark: [B.DARK_OAK_LOG, B.DARK_OAK_LEAVES, 7, 4],
  pale: [B.PALE_LOG, B.PALE_LEAVES, 8, 4],
  cherry: [B.CHERRY_LOG, B.CHERRY_LEAVES, 6, 3],
  jungle: [B.JUNGLE_LOG, B.JUNGLE_LEAVES, 13, 4],
  mangrove: [B.MANGROVE_LOG, B.MANGROVE_LEAVES, 8, 3],
  swamp_oak: [B.OAK_LOG, B.LEAVES, 6, 3],
  crimson: [B.CRIMSON_STEM, B.CRIMSON_LEAVES, 6, 3],
  warped: [B.WARPED_STEM, B.WARPED_LEAVES, 7, 3],
};
