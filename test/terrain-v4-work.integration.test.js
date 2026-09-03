import assert from "node:assert/strict";
import test from "node:test";
import { createGenerator } from "../src/terrain.js";
import { createTerrainV4 } from "../src/terrain-v4.js";
import { V4_LIMITS } from "../src/terrain-v4-config.js";
import { getNativeV4Decorators } from "../src/terrain-v4-manifest.js";
import { v4Digest } from "./terrain-v4-helpers.js";

test("real HUD/LOD column and tree queries never generate chunks or plan full cave/structure geometry", {
  timeout: 30000, // Enough independent columns to exceed the real bounded surface cache.
}, () => {
  const described = [];
  const generator = createTerrainV4("v4-cheap-sampling", "overworld", {
    decorators: [
      {
        id: "authored-unused-decorator",
        spacing: 32,
        reach: 0,
        maxWrites: 1,
        describe(context) {
          described.push([context.gx, context.gz]);
          return [];
        },
        emit() {
          assert.fail("sampling must not emit decorations");
        },
      },
    ],
  });
  const first = generator.sampleColumn(0, 0);
  for (let i = 0; i <= V4_LIMITS.columns + 17; i++) {
    const x = i * 61 - 1000;
    const z = i * 97 - 1000;
    const col = generator.sampleColumn(x, z);
    assert.equal(generator.surfaceYAt(x, z), col.top);
    assert.equal(generator.terrainHeight(x, z), col.top);
    assert.ok(generator.getBiome(x, z));
    assert.ok(generator.getBiome(x, z, -30));
  }
  for (let i = 0; i <= V4_LIMITS.trees + 17; i++)
    generator.getTrees(i * 29, -i * 31);
  assert.deepEqual(
    generator.sampleColumn(0, 0),
    first,
    "cache eviction cannot alter the field"
  );
  const counters = generator.counters;
  assert.equal(counters.chunkGenerations, 0);
  assert.equal(counters.regionGenerations, 0);
  assert.equal(counters.caveColumns, 0);
  assert.equal(counters.oreCells, 0);
  assert.equal(counters.decoratorCells, 0);
  assert.equal(counters.voxelVisits, 0);
  assert.equal(described.length, 0);
  assert.equal(generator.cavePlanCacheSize, 0);
  assert.ok(generator.cacheSizes.columns <= V4_LIMITS.columns);
  assert.ok(generator.cacheSizes.regions <= V4_LIMITS.regions);
  assert.ok(generator.cacheSizes.trees <= V4_LIMITS.trees);
  assert.equal(generator.lastGenerationWork, null);
});

test("real caves, marine descriptors and ore caches remain bounded and generation has finite per-chunk work", {
  timeout: 30000, // Fill the production caches, then generate independent chunks.
}, () => {
  const generator = createGenerator("v4-bounded-generation", "overworld", 4);
  const decorators = getNativeV4Decorators().filter((entry) =>
    entry.dimensions.includes("overworld")
  );
  const expected = v4Digest(generator.generateChunk(-1, -1));
  for (let i = 0; i <= V4_LIMITS.caves + 17; i++)
    generator.getCaveIntervals(i * 17 - 3000, i * 23 - 3000);
  for (let i = 0; i <= V4_LIMITS.marine + 17; i++)
    generator.getMarineFeatures(i * 13 - 1000, -i * 17 + 1000);
  for (let i = 0; i < 16; i++) {
    generator.generateChunk(i * 113 - 100, -i * 79 + 100);
    const work = generator.lastGenerationWork;
    assert.equal(work.width, 16);
    assert.equal(work.depth, 16);
    assert.equal(work.chunkGenerations, 1);
    assert.equal(work.regionGenerations, 0);
    assert.ok(work.caveColumns <= 256);
    assert.ok(work.surfaceSamples <= 4096);
    assert.ok(work.voxelVisits <= 2 * 384 * 256);
    assert.ok(
      work.featureWrites <= 250000,
      "bounded global-owner feature emission"
    );
    assert.ok(work.oreCells <= 4096);
    // A 16-aligned chunk cannot straddle a 192-aligned canonical owner. There
    // is no decorator cache or recursive voxel generation hidden by these caps.
    assert.equal(work.decoratorCells, decorators.length);
    assert.ok(
      work.decoratorSamples <=
        decorators.reduce((sum, entry) => sum + entry.maxSamples, 0)
    );
    assert.ok(
      work.decoratorDescriptors <= 1,
      "one canonical family per global owner"
    );
    assert.ok(
      work.decoratorWrites <=
        Math.max(...decorators.map((entry) => entry.maxWrites))
    );
    for (const name of [
      "columns",
      "regions",
      "trees",
      "caves",
      "ores",
      "marine",
    ])
      assert.ok(generator.cacheSizes[name] <= V4_LIMITS[name], `${name} cache`);
  }
  assert.equal(v4Digest(generator.generateChunk(-1, -1)), expected);
  assert.ok(generator.counters.caveColumns > V4_LIMITS.caves);
  assert.ok(generator.counters.marineCells > V4_LIMITS.marine);
});

test("real biome location returns supported dimension-aware points without unbounded validation", {
  timeout: 30000, // Explicit locator validation may generate terrain; HUD sampling may not.
}, () => {
  const generator = createGenerator("v4-biome-location", "overworld", 4);
  const spawn = generator.getSpawn();
  const id = generator.getBiome(spawn.x, spawn.z).id;
  const before = generator.counters;
  const point = generator.locateBiome(id, spawn);
  assert.ok(point);
  assert.equal(point.dimension, "overworld");
  assert.equal(generator.getBiome(point.x, point.z).id, id);
  assert.ok(
    generator.counters.regionGenerations - before.regionGenerations <= 64
  );
  assert.ok(generator.counters.locatorSamples - before.locatorSamples <= 16641);
  const after = generator.counters;
  assert.deepEqual(generator.locateBiome(id, spawn), point);
  assert.deepEqual(generator.counters, after, "resolved locations are cached");
  const end = generator.locateBiome("the_end", spawn);
  assert.ok(end && end.dimension === "end");
  assert.equal(generator.locateBiome("not-a-biome", spawn), null);
  assert.equal(generator.surfaceYAt(NaN, 0), null);
  assert.equal(generator.sampleColumn(Infinity, 0), null);
});

test("all-family native sampling stays raw and never describes structures or generates voxels", {
  timeout: 30000, // Evict the real bounded surface cache in all three dimensions.
}, () => {
  for (const dimension of ["overworld", "nether", "end"]) {
    const generator = createGenerator("v4-native-raw-field", dimension, 4);
    const raw = createTerrainV4(generator.seed, dimension);
    for (let i = 0; i <= V4_LIMITS.columns + 1; i++) {
      const x = i * 61 - 8192;
      const z = i * -97 + 4096;
      const column = generator.sampleColumn(x, z);
      assert.equal(generator.terrainHeight(x, z), column.top);
      if (i % 512 === 0) assert.deepEqual(column, raw.sampleColumn(x, z));
    }
    for (const counter of [
      "decoratorCells",
      "decoratorSamples",
      "decoratorDescriptors",
      "decoratorWrites",
      "chunkGenerations",
      "regionGenerations",
      "caveColumns",
      "oreCells",
      "voxelVisits",
    ])
      assert.equal(generator.counters[counter], 0, `${dimension}/${counter}`);
    assert.ok(generator.cacheSizes.columns <= V4_LIMITS.columns);
    assert.ok(generator.cacheSizes.regions <= V4_LIMITS.regions);
    assert.equal(generator.lastGenerationWork, null);
  }
});
