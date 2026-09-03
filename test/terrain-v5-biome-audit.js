import { createGenerator } from "../src/terrain.js";
import { AUDIT_SEEDS } from "./terrain-v5-audit-helpers.js";

const ordinary = new Set([
  "plains", "forest", "birch_forest", "dark_forest", "taiga",
  "snowy_plains", "snowy_taiga", "desert", "savanna", "jungle",
]);
const add = (map, key) => { map[key] = (map[key] ?? 0) + 1; };
export function quantiles(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length, min: sorted[0], max: sorted.at(-1),
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p90: sorted[Math.ceil(sorted.length * 0.9) - 1],
  };
}

export function auditBiomeField(version, seeds = AUDIT_SEEDS) {
  const named = {}, categories = {}, namedRuns = [], climateRuns = [];
  let samples = 0, dryLand = 0;
  for (const seed of seeds) {
    const generator = createGenerator(seed, "overworld", version);
    for (let z = -8192; z <= 8192; z += 128)
      for (let x = -8192; x <= 8192; x += 128) {
        const col = generator.sampleColumn(x, z), biome = generator.getBiome(x, z);
        samples++;
        add(named, col.id); add(categories, biome.category);
        if (!["ocean", "shore", "river"].includes(biome.category)) dryLand++;
      }
    for (const z of [-8192, -4096, 0, 4096, 8192]) {
      let id = null, length = 0, first = true, climate = null, climateLength = 0, firstClimate = true;
      for (let x = -16384; x <= 16384; x += 8) {
        const col = generator.sampleColumn(x, z);
        if (id === col.id) length += 8;
        else {
          if (!first && ordinary.has(id)) namedRuns.push(length);
          if (id !== null) first = false;
          id = col.id; length = 8;
        }
        const current = col.temperature < 0.26 ? "cold" : col.temperature < 0.4 ? "cool"
          : col.temperature < 0.65 ? "temperate" : "hot";
        if (climate === current) climateLength += 8;
        else {
          if (!firstClimate) climateRuns.push(climateLength);
          if (climate !== null) firstClimate = false;
          climate = current; climateLength = 8;
        }
      }
      // Both end-censored runs are intentionally omitted.
    }
  }
  return {
    version, samples, dryLand, named, categories,
    ordinaryRunBlocks: quantiles(namedRuns), climateRunBlocks: quantiles(climateRuns),
    method: "Six seeded 129x129 real column grids at step128; five step8 transects per seed; edge-censored ordinary named runs omitted.",
  };
}
