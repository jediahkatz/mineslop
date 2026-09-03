import { BIOME_PROFILES } from "./biomes.js";
import { clamp, hash, smooth } from "./noise.js";

// Ordinary identity has its own scale, independent of the 1–2k-block climate.
// Weights are gameplay tuning, not claims about universal vanilla percentages.
export const V5_BIOME_SIZE = 384;
export const V5_MUSHROOMS = Object.freeze({
  spacing: 1536, occurrence: 0.16, minRadius: 210, maxRadius: 330,
});
const freezeWeights = (rows) =>
  Object.freeze(rows.map((row) => Object.freeze(row)));
export const V5_BIOME_WEIGHTS = Object.freeze({
  cold: freezeWeights([["snowy_plains", 56], ["snowy_taiga", 44]]),
  cool: freezeWeights([
    ["taiga", 63], ["old_growth_pine_taiga", 17],
    ["old_growth_spruce_taiga", 10], ["forest", 10],
  ]),
  temperate: freezeWeights([
    ["plains", 40], ["forest", 32], ["birch_forest", 14],
    ["dark_forest", 10], ["meadow", 4],
  ]),
  wet: freezeWeights([
    ["swamp", 28], ["dark_forest", 36], ["forest", 28], ["plains", 8],
  ]),
  arid: freezeWeights([
    ["desert", 49], ["savanna", 29], ["savanna_plateau", 12], ["badlands", 10],
  ]),
  tropical: freezeWeights([
    ["jungle", 70], ["sparse_jungle", 20], ["mangrove_swamp", 10],
  ]),
  nether: freezeWeights([
    ["nether_wastes", 36], ["soul_sand_valley", 15], ["crimson_forest", 21],
    ["warped_forest", 17], ["basalt_deltas", 11],
  ]),
});

export function selectV5CommonBiome(dimension, temperature, moisture, roll) {
  const key = dimension === "nether" ? "nether"
    : temperature < 0.26 ? "cold"
      : temperature < 0.4 ? "cool"
        : temperature > 0.65 ? (moisture < 0.55 ? "arid" : "tropical")
          : moisture > 0.68 ? "wet" : "temperate";
  const rows = V5_BIOME_WEIGHTS[key];
  let remaining = clamp(roll, 0, 1 - Number.EPSILON) *
    rows.reduce((total, [, weight]) => total + weight, 0);
  for (const [id, weight] of rows) {
    remaining -= weight;
    if (remaining < 0) return id;
  }
  return rows.at(-1)[0];
}

/**
 * Variants occupy a coherent inset of a successful ordinary owner. A rare
 * variant cannot win an unconstrained global palette roll, or cover all of a
 * broad climate. Hill/peak identity follows actual uplift and elevation.
 */
export function selectV5LandBiome(field, { temperature, moisture, mountain, top }) {
  let id = field.id;
  const core = field.core > 0.36;
  const rare = field.variant;
  if (id === "badlands") {
    if (core && rare < 0.14) return "eroded_badlands";
    if (core && rare < 0.40) return "wooded_badlands";
    return id;
  }
  if (id === "savanna" || id === "savanna_plateau") {
    if (top > 118 && mountain > 0.4 && rare < 0.2)
      return "windswept_savanna";
    return id;
  }
  if (["swamp", "mangrove_swamp", "jungle", "sparse_jungle", "desert"].includes(id)) {
    if (id === "jungle" && core && moisture > 0.6 && rare < 0.16)
      return "bamboo_jungle";
    if (id === "desert" && top > 175 && mountain > 0.5) return "stony_peaks";
    return id;
  }
  if (top > 176 && mountain > 0.42)
    return temperature > 0.57 ? "stony_peaks"
      : temperature < 0.17 ? "frozen_peaks" : "jagged_peaks";
  if (temperature < 0.28 && top > 117 && mountain > 0.3)
    return top > 151 ? "snowy_slopes" : "grove";
  if (temperature >= 0.28 && top > 108 && mountain > 0.32) {
    if (temperature > 0.4 && temperature < 0.67 && top < 168) {
      if (core && rare < 0.10 && moisture > 0.36) return "cherry_grove";
      return "meadow";
    }
    return rare < 0.15 ? "windswept_gravelly_hills"
      : rare < 0.58 ? "windswept_hills" : "windswept_forest";
  }
  if (!core) return id;
  if (id === "snowy_plains" && temperature < 0.22 && rare < 0.04)
    return "ice_spikes";
  if (id === "plains" && rare < 0.08) id = "sunflower_plains";
  else if (id === "forest" && rare < 0.07) id = "flower_forest";
  else if (id === "birch_forest" && rare < 0.13) id = "old_growth_birch_forest";
  else if (id === "dark_forest" && moisture > 0.45 && rare < 0.08)
    id = "pale_garden";
  return id;
}

export function v5Owner(gx, gz, salt, temperatureAt, moistureAt, dimension) {
  const x = (gx + 0.5 + (hash(gx, gz, salt ^ 7187) - 0.5) * 0.52) * V5_BIOME_SIZE;
  const z = (gz + 0.5 + (hash(gx, gz, salt ^ 2333) - 0.5) * 0.52) * V5_BIOME_SIZE;
  const id = selectV5CommonBiome(
    dimension, temperatureAt(x, z), moistureAt(x, z), hash(gx, gz, salt ^ 3191)
  );
  return Object.freeze({
    x, z, id, profile: BIOME_PROFILES[id],
    variant: hash(gx, gz, salt ^ 42899),
  });
}

export const v5Ramp = (value, low, high) =>
  smooth(clamp((value - low) / (high - low)));
