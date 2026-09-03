// Explicit generation constants. Importing this leaf never imports terrain.js.
export const V5_SPECS = Object.freeze({
  overworld: Object.freeze({ minY: -64, maxY: 320, seaLevel: 63, voidY: -128 }),
  nether: Object.freeze({ minY: 0, maxY: 256, seaLevel: null, voidY: -64 }),
  end: Object.freeze({ minY: 0, maxY: 256, seaLevel: null, voidY: -64 }),
});
export const V5_MIN_XZ = -30000000;
export const V5_MAX_XZ = 30000000;
export const V5_NETHER_ROOF = 127;
export const V5_LAVA_LEVEL = 31;
export const V5_TREE_SPACING = 8;
export const V5_LIMITS = Object.freeze({
  columns: 8192,
  regions: 1024,
  mushrooms: 128,
  caves: 2048,
  // Covers one maximum 64x64 region plus its cardinal exposure halo, so
  // mineral-by-mineral passes do not repeatedly rerasterize the same columns.
  naturalColumns: 4608,
  deposits: 4096,
  trees: 1024,
  marine: 512,
  locators: 64,
  regionSide: 64,
  decorators: 8,
  depositSize: 24,
  depositReach: 3,
});
export const v5InBounds = (x, z) =>
  Number.isFinite(x) && Number.isFinite(z) &&
  x >= V5_MIN_XZ && x < V5_MAX_XZ && z >= V5_MIN_XZ && z < V5_MAX_XZ;

export function rememberV5(cache, key, value, limit) {
  if (cache.size >= limit) cache.delete(cache.keys().next().value);
  cache.set(key, value);
  return value;
}

export function newV5Counters() {
  return {
    surfaceQueries: 0, surfaceSamples: 0, regionSamples: 0, mushroomCells: 0,
    caveColumns: 0, naturalColumns: 0, naturalQueries: 0,
    oreCells: 0, oreCandidates: 0, oreWrites: 0, oreExposureChecks: 0,
    oreExposureDiscards: 0, treeCells: 0, marineCells: 0,
    decoratorCells: 0, decoratorSamples: 0, decoratorDescriptors: 0,
    decoratorWrites: 0, featureWrites: 0, voxelVisits: 0,
    chunkGenerations: 0, regionGenerations: 0, spawnCandidates: 0,
    locatorSamples: 0,
  };
}
