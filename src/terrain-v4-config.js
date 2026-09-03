// These are generation settings, not replacements for the historical exports.
// Do not import world-spec/chunk-data here: they depend on terrain.js, which
// dispatches to v4. The public spec is checked against world-spec in the tests.
export const V4_SPECS = Object.freeze({
  overworld: Object.freeze({
    minY: -64,
    maxY: 320,
    seaLevel: 63,
    voidY: -128,
  }),
  nether: Object.freeze({
    minY: 0,
    maxY: 256,
    seaLevel: null,
    voidY: -64,
  }),
  end: Object.freeze({
    minY: 0,
    maxY: 256,
    seaLevel: null,
    voidY: -64,
  }),
});

export const V4_MIN_XZ = -30000000;
export const V4_MAX_XZ = 30000000;
export const V4_NETHER_ROOF = 127;
export const V4_LAVA_LEVEL = 31;
export const V4_TREE_SPACING = 8;
export const V4_TREE_REACH = 8;
export const V4_LIMITS = Object.freeze({
  columns: 8192,
  regions: 1024,
  caves: 2048,
  ores: 4096,
  trees: 1024,
  marine: 512,
  locators: 64,
  regionSide: 64,
  decorators: 8,
});

export const v4InBounds = (x, z) =>
  Number.isFinite(x) &&
  Number.isFinite(z) &&
  x >= V4_MIN_XZ &&
  x < V4_MAX_XZ &&
  z >= V4_MIN_XZ &&
  z < V4_MAX_XZ;

// FIFO is deliberate: reads cannot affect terrain or cost an O(n) LRU reorder.
export function remember(cache, key, value, limit) {
  if (cache.size >= limit) cache.delete(cache.keys().next().value);
  cache.set(key, value);
  return value;
}

export function newV4Counters() {
  return {
    surfaceQueries: 0,
    surfaceSamples: 0,
    regionSamples: 0,
    caveColumns: 0,
    oreCells: 0,
    treeCells: 0,
    marineCells: 0,
    decoratorCells: 0,
    decoratorSamples: 0,
    decoratorDescriptors: 0,
    decoratorWrites: 0,
    featureWrites: 0,
    voxelVisits: 0,
    chunkGenerations: 0,
    regionGenerations: 0,
    spawnCandidates: 0,
    locatorSamples: 0,
  };
}
