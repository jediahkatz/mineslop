import assert from "node:assert/strict";
import test from "node:test";
import { defaultFluidFor } from "../src/block-state.js";
import { BLOCK as B } from "../src/blocks.js";
import { GENERATOR_VERSION, WORLD_MIN, WORLD_MAX, createGenerator } from "../src/terrain.js";
import { readV4RegionCell } from "../src/terrain-v4-writer.js";
import { V5_LIMITS } from "../src/terrain-v5-config.js";
import { createTerrainV7 } from "../src/terrain-v7.js";
import { V7_END_LIMITS } from "../src/terrain-v7-end.js";
import { V7_GENERATION_MANIFEST } from "../src/terrain-v7-manifest.js";
import { getWorldSpec } from "../src/world-spec.js";
import { goldenChunkDigest } from "./terrain-golden-digest.js";
import { chunkCell } from "./terrain-v4-helpers.js";

test("production factory exposes v7 manifest, expanded bounds and scalar budgets; default remains3", () => {
  assert.equal(GENERATOR_VERSION, 3);
  for (const dimension of ["overworld", "nether", "end"]) {
    const gen = createGenerator("v7-bounds", dimension, 7);
    assert.equal(gen.generatorVersion, 7);
    assert.equal(gen.generationManifest, V7_GENERATION_MANIFEST);
    assert.deepEqual(gen.spec, getWorldSpec(7, dimension));
    assert.deepEqual([gen.minY, gen.maxY, gen.seaLevel],
      dimension === "overworld" ? [-64, 320, 63] : [0, 256, null]);
    for (const [x, z] of [[WORLD_MIN - 1, 0], [WORLD_MAX, 0], [0, NaN], [Infinity, 0]])
      assert.equal(gen.sampleColumn(x, z), null);
    assert.equal(gen.getNaturalBlock(0, gen.minY - 1, 0), B.AIR);
    assert.equal(gen.getNaturalBlock(0, gen.maxY, 0), B.AIR);
    for (let i = 0; i < 9000; i++) {
      gen.sampleColumn(i % 201 - 100, Math.floor(i / 201) - 100);
      gen.sampleColumn(i * 137 - 700000, i * 193 - 900000);
      gen.getEndPillars();
    }
    for (const key of ["chunkGenerations", "regionGenerations", "naturalColumns", "voxelVisits", "landmarkWrites"])
      assert.equal(gen.counters[key], 0);
    for (const [key, size] of Object.entries(gen.cacheSizes))
      if (V5_LIMITS[key] !== undefined) assert.ok(size <= V5_LIMITS[key], key);
    if (dimension === "end")
      assert.equal(gen.cacheSizes.centralColumns, V7_END_LIMITS.centralColumns);
    console.log(JSON.stringify({ dimension, scalarCounters: gen.counters, caches: gen.cacheSizes }));
  }
  assert.throws(() => getWorldSpec(8, "end"), RangeError);
});

for (const dimension of ["overworld", "nether", "end"])
  test(`v7 ${dimension} cold/warm/reverse/evicted/chunk-region parity`, { timeout: 60000 }, () => {
    const gen = createGenerator("cedar-valley", dimension, 7);
    const point = dimension === "end" ? gen.getEndPillars()[2] : { x: -1, z: -1 };
    const x = Math.floor(point.x / 16) * 16, z = Math.floor(point.z / 16) * 16;
    const region = gen.generateRegion(x, z, 32, 32), expected = new Map();
    const positions = [[x / 16, z / 16], [x / 16 + 1, z / 16],
      [x / 16, z / 16 + 1], [x / 16 + 1, z / 16 + 1]];
    for (const [cx, cz] of positions) {
      const cold = createGenerator("cedar-valley", dimension, 7).generateChunk(cx, cz);
      expected.set(`${cx},${cz}`, goldenChunkDigest(cold, defaultFluidFor));
      for (let dz = 0; dz < 16; dz++) for (let dx = 0; dx < 16; dx++)
        for (let y = gen.minY; y < gen.maxY; y++)
          assert.deepEqual(chunkCell(cold, cx * 16 + dx, y, cz * 16 + dz),
            readV4RegionCell(region, cx * 16 + dx, y, cz * 16 + dz));
      assert.deepEqual(goldenChunkDigest(gen.generateChunk(cx, cz), defaultFluidFor), expected.get(`${cx},${cz}`));
    }
    for (let i = 0; i < 9000; i++) {
      gen.sampleColumn(i * 53 - 700000, i * 71 - 500000);
      gen.sampleColumn(i % 201 - 100, Math.floor(i / 201) - 100);
    }
    for (let i = 0; i < 4609; i++) gen.getNaturalBlock(i * 13 - 60000, 20, i * 19 - 40000);
    for (let i = 0; i < 1100; i++) gen.getTrees(i * 3, -i * 5);
    for (const [cx, cz] of positions.reverse())
      assert.deepEqual(goldenChunkDigest(gen.generateChunk(cx, cz), defaultFluidFor), expected.get(`${cx},${cz}`));
    assert.throws(() => gen.generateRegion(0, 0, 65, 16), RangeError);
  });

test("v7 retains v6 Overworld seams and density bytes plus Nether bytes", () => {
  for (const [dimension, seed, points] of [
    ["overworld", "mineslop-audit-2", [[64, 20], [0, 118], [-64, -115], [64, -120]]],
    ["overworld", "cedar-valley", [[31, 0]]],
    ["nether", "cedar-valley", [[-1, 0], [2, -3]]],
  ]) {
    const old = createGenerator(seed, dimension, 6), gen = createGenerator(seed, dimension, 7);
    for (const [cx, cz] of points) {
      const before = goldenChunkDigest(old.generateChunk(cx, cz), defaultFluidFor);
      const after = goldenChunkDigest(gen.generateChunk(cx, cz), defaultFluidFor);
      for (const plane of ["blocks", "biomes", "states", "fluids", "envelope"])
        assert.equal(after[plane], before[plane], `${dimension}/${cx},${cz}/${plane}`);
      assert.deepEqual(gen.sampleColumn(cx * 16, cz * 16), old.sampleColumn(cx * 16, cz * 16));
    }
  }
});

test("v7 nested cross-dimension navigation uses v7 contexts", () => {
  const versions = [];
  const decorator = {
    id: "context-observer", spacing: 192, reach: 0, maxWrites: 1,
    describe(context) { versions.push([context.generatorVersion, context.dimension]); return []; },
    emit() {},
  };
  const gen = createTerrainV7("cedar-valley", "end", { decorators: [decorator] });
  gen.locateBiome("nether_wastes");
  assert.ok(versions.some(([version, dimension]) => version === 7 && dimension === "nether"));
  assert.ok(versions.every(([version]) => version === 7));
});

test("v7 End bounded cold chunk, warm chunk and landmark source work", () => {
  const gen = createGenerator("cedar-valley", "end", 7), pillar = gen.getEndPillars()[0];
  const cx = Math.floor(pillar.x / 16), cz = Math.floor(pillar.z / 16);
  const start = performance.now();
  gen.generateChunk(cx, cz);
  const cold = gen.lastGenerationWork, coldMs = performance.now() - start;
  assert.equal(cold.naturalColumns, 256);
  assert.ok(cold.voxelVisits <= 256 * 512, "one raster and one write per column");
  assert.ok(cold.landmarkColumns <= 21);
  assert.ok(cold.landmarkWrites <= 21 * 51 + 1);
  gen.generateChunk(cx, cz);
  const warm = gen.lastGenerationWork;
  assert.equal(warm.naturalColumns, 0);
  assert.equal(warm.voxelVisits, 256 * 256);
  assert.equal(warm.landmarkWrites, cold.landmarkWrites);
  console.log(JSON.stringify({ coldMs, cold, warm, caches: gen.cacheSizes }));
});
