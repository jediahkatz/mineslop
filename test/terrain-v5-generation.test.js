import assert from "node:assert/strict";
import test from "node:test";
import { defaultFluidFor } from "../src/block-state.js";
import { BLOCK as B, isSolid } from "../src/blocks.js";
import { createGenerator, GENERATOR_VERSION, WORLD_MAX, WORLD_MIN } from "../src/terrain.js";
import { createTerrainV5 } from "../src/terrain-v5.js";
import { V5_LIMITS } from "../src/terrain-v5-config.js";
import { V5_GENERATION_MANIFEST } from "../src/terrain-v5-manifest.js";
import { readV4RegionCell } from "../src/terrain-v4-writer.js";
import { getWorldSpec } from "../src/world-spec.js";
import { goldenChunkDigest } from "./terrain-golden-digest.js";
import { chunkCell } from "./terrain-v4-helpers.js";

test("v5 requires explicit dispatch; the new-world default and old dimensions stay unchanged", () => {
  assert.equal(GENERATOR_VERSION, 3, "activation belongs to a later parent checkpoint");
  for (const dimension of ["overworld", "nether", "end"]) {
    const modern = createGenerator("v5-explicit", dimension, 5);
    assert.equal(modern.generatorVersion, 5);
    assert.equal(modern.generationManifest, V5_GENERATION_MANIFEST);
    assert.deepEqual(modern.spec, getWorldSpec(5, dimension));
    assert.equal(createGenerator("v5-explicit", dimension).generateChunk(0, 0).blocks.length, 96 * 256);
    for (const version of [1, 2, 3])
      assert.equal(getWorldSpec(version, dimension).maxY, 96);
  }
  for (const version of [0, 8, "5", null, NaN])
    assert.throws(() => createGenerator("v5-explicit", "overworld", version), RangeError);
});

function compareRegion(region, chunk) {
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
    const wx = chunk.cx * 16 + x, wz = chunk.cz * 16 + z;
    assert.equal(chunk.biomes[z * 16 + x],
      region.biomes[(wz - region.minZ) * region.width + wx - region.minX]);
    for (let y = chunk.minY; y < chunk.maxY; y++)
      assert.deepEqual(chunkCell(chunk, wx, y, wz), readV4RegionCell(region, wx, y, wz));
  }
  assert.deepEqual(chunk.structures ?? [], (region.structures ?? []).filter(({ bounds }) =>
    bounds.minX < (chunk.cx + 1) * 16 && bounds.maxX > chunk.cx * 16 &&
    bounds.minZ < (chunk.cz + 1) * 16 && bounds.maxZ > chunk.cz * 16
  ));
}

for (const dimension of ["overworld", "nether", "end"])
  for (const [x, z] of [[-16, -16], [WORLD_MIN, WORLD_MAX - 32]])
    test(`v5 ${dimension} full cell/structure seams, cache eviction and reverse order ${x},${z}`, {
      timeout: 60000,
    }, () => {
      const generator = createGenerator("v5-global-owners", dimension, 5);
      const region = generator.generateRegion(x, z, 32, 32);
      const positions = [[x / 16, z / 16], [x / 16 + 1, z / 16],
        [x / 16, z / 16 + 1], [x / 16 + 1, z / 16 + 1]];
      const expected = new Map();
      for (const [cx, cz] of positions) {
        const chunk = createGenerator("v5-global-owners", dimension, 5).generateChunk(cx, cz);
        compareRegion(region, chunk);
        expected.set(`${cx},${cz}`, goldenChunkDigest(chunk, defaultFluidFor));
      }
      for (let i = 0; i < 9000; i++)
        generator.sampleColumn(i * 53 - 700000, i * 71 - 500000);
      for (const [cx, cz] of positions.reverse())
        assert.deepEqual(goldenChunkDigest(generator.generateChunk(cx, cz), defaultFluidFor),
          expected.get(`${cx},${cz}`));
    });

test("v5 scalar field/biome/vegetation queries never generate underground or voxel buffers", () => {
  const generator = createGenerator("v5-cheap-field", "overworld", 5);
  for (let i = 0; i < 10000; i++) {
    const x = i * 137 - 700000, z = i * 193 - 900000;
    generator.sampleColumn(x, z);
    generator.surfaceYAt(x, z);
    generator.getBiome(x, z, -32);
    if (i % 200 === 0) generator.getTrees(Math.floor(x / 8), Math.floor(z / 8));
  }
  for (const key of ["chunkGenerations", "regionGenerations", "voxelVisits",
    "naturalColumns", "naturalQueries", "caveColumns", "oreCells", "oreCandidates"])
    assert.equal(generator.counters[key], 0, key);
  for (const [key, size] of Object.entries(generator.cacheSizes))
    if (V5_LIMITS[key] !== undefined) assert.ok(size <= V5_LIMITS[key], key);
});

test("v5 cold chunk work has bounded owners, deposits, natural halo and retained caches", () => {
  const generator = createTerrainV5("v5-work-bounds");
  generator.generateChunk(-1, -1);
  const work = generator.lastGenerationWork;
  assert.ok(work.oreCells <= 8 * 4 * 4 * 51);
  assert.ok(work.oreCandidates <= 8 * 4 * 4 * 51 * V5_LIMITS.depositSize);
  assert.ok(work.oreExposureChecks <= work.oreCandidates * 6);
  assert.ok(work.naturalColumns <= 18 * 18, "one column raster per real cardinal halo");
  for (const [key, size] of Object.entries(generator.cacheSizes))
    if (V5_LIMITS[key] !== undefined) assert.ok(size <= V5_LIMITS[key], key);
  assert.throws(() => generator.generateRegion(0, 0, 65, 16), RangeError);
});

for (const seed of ["cedar-valley", "mineslop-audit-2", ""])
  for (const dimension of ["overworld", "nether", "end"])
    test(`v5 actual safe spawn and repeatability ${JSON.stringify(seed)}/${dimension}`, {
      timeout: 60000,
    }, () => {
      const generator = createGenerator(seed, dimension, 5), spawn = generator.getSpawn();
      assert.deepEqual(generator.getSpawn(), spawn);
      assert.deepEqual(createGenerator(seed, dimension, 5).getSpawn(), spawn);
      const x = Math.floor(spawn.x), y = Math.floor(spawn.y), z = Math.floor(spawn.z);
      const region = generator.generateRegion(x, z, 1, 1);
      assert.ok(isSolid(readV4RegionCell(region, x, y - 1, z).id));
      for (const dy of [0, 1]) {
        const id = readV4RegionCell(region, x, y + dy, z).id;
        assert.ok(!isSolid(id) && id !== B.WATER && id !== B.LAVA);
      }
      assert.ok(generator.counters.spawnCandidates <= 193 ** 2);
    });
