import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { defaultFluidFor } from "../src/block-state.js";
import { BLOCK as B, isSolid } from "../src/blocks.js";
import { createGenerator, GENERATOR_VERSION, WORLD_MAX, WORLD_MIN } from "../src/terrain.js";
import { readV4RegionCell } from "../src/terrain-v4-writer.js";
import { V5_LIMITS } from "../src/terrain-v5-config.js";
import { createTerrainV6 } from "../src/terrain-v6.js";
import { V6_GENERATION_MANIFEST } from "../src/terrain-v6-manifest.js";
import { getWorldSpec } from "../src/world-spec.js";
import { goldenChunkDigest } from "./terrain-golden-digest.js";
import { chunkCell } from "./terrain-v4-helpers.js";

test("explicit v6 is expanded in every dimension; normal default remains gated at 3", () => {
  assert.equal(GENERATOR_VERSION, 3);
  for (const dimension of ["overworld", "nether", "end"]) {
    const generator = createGenerator("v6-bounds", dimension, 6);
    assert.equal(generator.generatorVersion, 6);
    assert.equal(generator.generationManifest, V6_GENERATION_MANIFEST);
    assert.deepEqual(generator.spec, getWorldSpec(6, dimension));
    assert.deepEqual([generator.minY, generator.maxY, generator.seaLevel],
      dimension === "overworld" ? [-64, 320, 63] : [0, 256, null]);
    assert.equal(generator.sampleColumn(WORLD_MIN - 1, 0), null);
    assert.equal(generator.sampleColumn(WORLD_MAX, 0), null);
    assert.equal(generator.sampleColumn(0, NaN), null);
    assert.equal(generator.getNaturalBlock(0, generator.minY - 1, 0), B.AIR);
    assert.equal(generator.getNaturalBlock(0, generator.maxY, 0), B.AIR);
  }
  for (const version of [0, 8, "6", null, NaN])
    assert.throws(() => createGenerator("future", "overworld", version), RangeError);
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
    bounds.minZ < (chunk.cz + 1) * 16 && bounds.maxZ > chunk.cz * 16));
}

for (const dimension of ["overworld", "nether", "end"])
  for (const [x, z] of [[-16, -16], [WORLD_MIN, WORLD_MAX - 32]])
    test(`v6 ${dimension} cold/warm/reverse/evicted/chunk-region parity ${x},${z}`, { timeout: 60000 }, () => {
      const generator = createGenerator("v6-global-owners", dimension, 6);
      const region = generator.generateRegion(x, z, 32, 32);
      const positions = [[x / 16, z / 16], [x / 16 + 1, z / 16],
        [x / 16, z / 16 + 1], [x / 16 + 1, z / 16 + 1]];
      const expected = new Map();
      for (const [cx, cz] of positions) {
        const chunk = createGenerator("v6-global-owners", dimension, 6).generateChunk(cx, cz);
        compareRegion(region, chunk);
        expected.set(`${cx},${cz}`, goldenChunkDigest(chunk, defaultFluidFor));
        assert.deepEqual(goldenChunkDigest(generator.generateChunk(cx, cz), defaultFluidFor),
          expected.get(`${cx},${cz}`));
      }
      // More than the column, region, cave, natural, tree and mineral caches.
      for (let i = 0; i < 9000; i++)
        generator.sampleColumn(i * 53 - 700000, i * 71 - 500000);
      for (let i = 0; i < 1100; i++) generator.getTrees(i * 3, -i * 5);
      for (let i = 0; i < 4609; i++)
        generator.getNaturalBlock(i * 13 - 60000, 20, i * 19 - 40000);
      for (const [cx, cz] of positions.reverse())
        assert.deepEqual(goldenChunkDigest(generator.generateChunk(cx, cz), defaultFluidFor),
          expected.get(`${cx},${cz}`));
      for (const [key, size] of Object.entries(generator.cacheSizes))
        if (V5_LIMITS[key] !== undefined) assert.ok(size <= V5_LIMITS[key], key);
    });

test("v6 scalar field, vegetation and cave-biome queries never rasterize underground", () => {
  const generator = createGenerator("v6-cheap", "overworld", 6);
  for (let i = 0; i < 9000; i++) {
    const x = i * 137 - 700000, z = i * 193 - 900000;
    generator.sampleColumn(x, z);
    generator.getBiome(x, z, -32);
    if (i % 100 === 0) generator.getTrees(Math.floor(x / 8), Math.floor(z / 8));
  }
  for (const key of ["chunkGenerations", "regionGenerations", "voxelVisits",
    "naturalColumns", "naturalQueries", "caveColumns", "oreCells", "oreCandidates"])
    assert.equal(generator.counters[key], 0, key);
});

test("v6 keeps bounded cold-chunk work, deposits and natural cardinal halo", () => {
  const generator = createTerrainV6("v6-work-bounds");
  generator.generateChunk(-1, -1);
  const work = generator.lastGenerationWork;
  assert.ok(work.oreCells <= 8 * 4 * 4 * 51);
  assert.ok(work.oreCandidates <= 8 * 4 * 4 * 51 * V5_LIMITS.depositSize);
  assert.ok(work.oreExposureChecks <= work.oreCandidates * 6);
  assert.ok(work.naturalColumns <= 18 * 18);
  for (const [key, size] of Object.entries(generator.cacheSizes))
    if (V5_LIMITS[key] !== undefined) assert.ok(size <= V5_LIMITS[key], key);
  assert.throws(() => generator.generateRegion(0, 0, 65, 16), RangeError);
  console.log(JSON.stringify({ v6ColdChunkWork: work, caches: generator.cacheSizes }));
});

test("v6 reuses expanded caves, deep oceans, mountains and mineral-bearing native cells", () => {
  const fixture = JSON.parse(readFileSync(new URL("./terrain-v5-golden.json", import.meta.url), "utf8"));
  const row = fixture.records.find((entry) => entry.seed === "cedar-valley" && entry.dimension === "overworld");
  const generator = createGenerator(row.seed, row.dimension, 6);
  for (const label of ["deep_ocean", "mountain", "swamp", "dripstone", "lush"]) {
    const point = row.chunks.find((chunk) => chunk.label === label);
    const chunk = generator.generateChunk(point.cx, point.cz);
    const col = generator.sampleColumn(point.cx * 16 + 7, point.cz * 16 + 11);
    assert.equal(chunk.blocks.length, 384 * 256);
    assert.ok(chunk.blocks.includes(B.DEEPSLATE));
    if (label === "deep_ocean") {
      assert.ok(col.top < 10);
      assert.ok(chunk.blocks.includes(B.WATER));
    }
    if (label === "mountain") assert.ok(col.top > 140);
    if (label === "dripstone" || label === "lush") {
      assert.ok(generator.getCaveIntervals(col.x, col.z).length > 0);
      assert.ok(chunk.blocks.includes(B.COAL_ORE) || chunk.blocks.includes(B.IRON_ORE));
    }
  }
});

test("v6 cross-dimension navigation carries v6 decorator context", () => {
  const seen = new Set();
  const decorator = {
    id: "version-observer", spacing: 192, reach: 0, maxWrites: 1,
    describe(context) { assert.equal(context.generatorVersion, 6); seen.add(context.dimension); return []; },
    emit() {},
  };
  const generator = createTerrainV6("cedar-valley", "overworld", { decorators: [decorator] });
  assert.equal(generator.locateBiome("the_end").dimension, "end");
  assert.equal(generator.locateBiome("nether_wastes").dimension, "nether");
  assert.deepEqual(seen, new Set(["end", "nether"]));
});

for (const seed of ["cedar-valley", "mineslop-audit-2", ""])
  for (const dimension of ["overworld", "nether", "end"])
    test(`v6 natural safe repeatable spawn ${JSON.stringify(seed)}/${dimension}`, { timeout: 60000 }, () => {
      const generator = createGenerator(seed, dimension, 6), spawn = generator.getSpawn();
      assert.deepEqual(generator.getSpawn(), spawn);
      assert.deepEqual(createGenerator(seed, dimension, 6).getSpawn(), spawn);
      const x = Math.floor(spawn.x), y = Math.floor(spawn.y), z = Math.floor(spawn.z);
      const region = generator.generateRegion(x, z, 1, 1);
      assert.ok(isSolid(readV4RegionCell(region, x, y - 1, z).id));
      for (const dy of [0, 1]) {
        const id = readV4RegionCell(region, x, y + dy, z).id;
        assert.ok(!isSolid(id) && id !== B.WATER && id !== B.LAVA);
      }
      assert.ok(generator.counters.spawnCandidates <= 193 ** 2);
    });
