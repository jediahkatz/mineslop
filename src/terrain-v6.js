import { BIOME_INDEX, getBiomeById } from "./biomes.js";
import { seedHash } from "./noise.js";
import { requireTerrainV4Content } from "./terrain-v4-content.js";
import { createV4Decorators } from "./terrain-v4-decorators.js";
import { createV4Marine } from "./terrain-v4-marine.js";
import { v4CaveBiome } from "./terrain-v4-underground.js";
import { createV4Writer } from "./terrain-v4-writer.js";
import { newV5Counters, V5_LIMITS, V5_SPECS } from "./terrain-v5-config.js";
import { createV5Natural } from "./terrain-v5-natural.js";
import { createV5Navigation } from "./terrain-v5-navigation.js";
import { createV5Ores } from "./terrain-v5-ores.js";
import { createV6Field } from "./terrain-v6-field.js";
import { createV6Vegetation } from "./terrain-v6-vegetation.js";

// Bounds, caves, ores, marine features and layout-v1 writer contracts retain
// v5 expanded semantics. This orchestration is version-isolated: every nested
// dimension constructs v6, never a default generator or a v5 generator.
const EMPTY = Object.freeze([]);
export function createTerrainV6(
  seed = "cedar-valley", dimension = "overworld", { decorators = [] } = {}
) {
  if (!Object.hasOwn(V5_SPECS, dimension)) throw new RangeError("Unknown dimension");
  requireTerrainV4Content();
  const seedString = String(seed).slice(0, 80), salt = seedHash(seedString);
  const spec = V5_SPECS[dimension], counters = newV5Counters();
  const field = createV6Field(salt, dimension, counters);
  const { sampleColumn } = field;
  const context = { salt, dimension, spec, sampleColumn, counters };
  const natural = createV5Natural(context);
  const ores = createV5Ores({ ...context, natural });
  const vegetation = createV6Vegetation(context);
  const marine = dimension === "overworld" ? createV4Marine(context) : null;
  const decorate = createV4Decorators(
    decorators, { seed: seedString, salt, dimension, spec, sampleColumn, generatorVersion: 6 }, counters
  );
  const otherDimensions = new Map();
  let lastGenerationWork = null;

  function buildRegion(minX, minZ, width, depth, chunk) {
    if (![minX, minZ, width, depth, minX + width, minZ + depth].every(Number.isSafeInteger) ||
      width < 1 || depth < 1 || width > V5_LIMITS.regionSide || depth > V5_LIMITS.regionSide)
      throw new RangeError("Terrain regions require integer dimensions of 1–64 blocks");
    const bounds = { minX, minZ, width, depth };
    const writer = createV4Writer({ ...bounds, spec, counters });
    const columns = new Array(width * depth);
    const biomes = new Uint8Array(width * depth).fill(BIOME_INDEX.the_void);
    for (let z = minZ; z < minZ + depth; z++) for (let x = minX; x < minX + width; x++) {
      const at = (z - minZ) * width + x - minX, col = sampleColumn(x, z);
      if (!col) continue;
      columns[at] = col;
      biomes[at] = BIOME_INDEX[col.id];
      natural.writeColumn(writer, col);
    }
    ores.decorate(bounds, writer);
    vegetation.decorate(bounds, writer);
    marine?.decorate(bounds, writer);
    for (const col of columns) {
      if (!col || col.top === null) continue;
      vegetation.groundCover(col, writer.put);
      marine?.plants(col, writer.put);
    }
    const structures = decorate(bounds, writer);
    return { ...writer.finish(chunk), biomes,
      ...(structures.length ? { structures } : {}), ...(chunk ? {} : bounds) };
  }

  function recordGeneration(before, width, depth) {
    lastGenerationWork = Object.freeze({
      width, depth,
      ...Object.fromEntries(Object.keys(counters).map((key) => [key, counters[key] - before[key]])),
    });
  }
  function generateRegion(minX, minZ, width = 16, depth = 16) {
    const before = { ...counters };
    counters.regionGenerations++;
    const result = buildRegion(minX, minZ, width, depth, false);
    recordGeneration(before, width, depth);
    return result;
  }
  function generateChunk(cx, cz) {
    if (![cx, cz, cx * 16, cz * 16].every(Number.isSafeInteger))
      throw new RangeError("Chunk coordinates must be safe integers");
    const before = { ...counters };
    counters.chunkGenerations++;
    const result = { cx, cz, ...buildRegion(cx * 16, cz * 16, 16, 16, true) };
    recordGeneration(before, 16, 16);
    return result;
  }
  const navigation = createV5Navigation({
    ...context, generateRegion, vegetation,
    forDimension(target) {
      if (!otherDimensions.has(target))
        otherDimensions.set(target, createTerrainV6(seedString, target, { decorators }));
      return otherDimensions.get(target);
    },
  });
  const surfaceYAt = (x, z) => sampleColumn(x, z)?.top ?? null;
  return {
    seed: seedString, dimension, generatorVersion: 6,
    spec, minY: spec.minY, maxY: spec.maxY, seaLevel: spec.seaLevel,
    generateChunk, generateRegion, sampleColumn, surfaceYAt, terrainHeight: surfaceYAt,
    getBiome(x, z, y) {
      const col = sampleColumn(x, z);
      if (!col) return getBiomeById("the_void");
      return getBiomeById(dimension === "overworld" && Number.isFinite(y) &&
        y >= spec.minY + 5 && y < col.top - 4 ? v4CaveBiome(col, y, salt) : col.id);
    },
    getSpawn: navigation.getSpawn,
    locateBiome: navigation.locateBiome,
    getTrees: vegetation.getTrees,
    getMarineFeatures: (gx, gz) => marine?.getFeatures(gx, gz) ?? EMPTY,
    getMushroomIsland: (gx, gz) => dimension === "overworld" ? field.mushroomIsland(gx, gz) : null,
    getNaturalBlock: natural.blockAt,
    getCaveIntervals(x, z) {
      const col = sampleColumn(x, z);
      return dimension === "overworld" && col
        ? natural.caves(col).map((interval) => [...interval]) : [];
    },
    get counters() { return { ...counters }; },
    get cacheSizes() {
      return {
        ...field.cacheSizes, ...natural.cacheSizes, deposits: ores.cacheSize,
        trees: vegetation.cacheSize, marine: marine?.cacheSize ?? 0,
        locators: navigation.cacheSize, dimensions: otherDimensions.size,
      };
    },
    get lastGenerationWork() { return lastGenerationWork; },
    get cavePlanCacheSize() { return natural.cacheSizes.caves; },
    get locatorSamples() { return counters.locatorSamples; },
  };
}
