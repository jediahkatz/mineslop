import assert from "node:assert/strict";
import {
  describeStructure,
  locateStructure,
  structureTarget,
} from "../src/structure-catalog.js";
import { createGenerator } from "../src/terrain.js";

export const NATIVE_STRUCTURE_SEARCH = Object.freeze({
  radius: 12,
  maxCells: 625,
  maxSamples: 12288,
});
const seeds = ["cedar-valley", "tidal-archive", "basalt-crossing"];
const origins = [
  { x: -4096, z: -4096 },
  { x: 0, z: 0 },
  { x: 6144, z: 4096 },
  { x: -6144, z: 6144 },
];

export const nativeContext = (generator) => ({
  seed: generator.seed,
  dimension: generator.dimension,
  spec: generator.spec,
  sampleColumn: generator.sampleColumn,
});

export function nativeJob(generator, cx, cz, id = 7, epoch = 3) {
  return {
    type: "generate",
    schemaVersion: 2,
    id,
    epoch,
    seed: generator.seed,
    dimension: generator.dimension,
    generatorVersion: 4,
    minY: generator.minY,
    maxY: generator.maxY,
    cx,
    cz,
  };
}

/** First real locator result, never retry after a geometry/transport failure. */
export function firstNativeStructure(kind, dimension = "overworld") {
  const attempts = [];
  for (const seed of seeds) {
    const generator = createGenerator(seed, dimension, 4);
    const context = nativeContext(generator);
    for (const from of origins) {
      const before = generator.counters;
      const found = locateStructure(
        kind,
        context,
        from,
        NATIVE_STRUCTURE_SEARCH
      );
      assert.ok(found.examinedCells <= NATIVE_STRUCTURE_SEARCH.maxCells);
      assert.ok(found.sampledColumns <= NATIVE_STRUCTURE_SEARCH.maxSamples);
      assert.equal(
        generator.counters.surfaceQueries - before.surfaceQueries,
        found.sampledColumns
      );
      for (const key of [
        "chunkGenerations",
        "regionGenerations",
        "decoratorCells",
        "caveColumns",
        "voxelVisits",
      ])
        assert.equal(
          generator.counters[key],
          before[key],
          `discovery must not perform ${key}`
        );
      attempts.push({ seed, from, ...found });
      if (!found.target) continue;
      const queries = generator.counters.surfaceQueries;
      const descriptor = describeStructure(
        kind,
        context,
        found.target.gx,
        found.target.gz
      );
      assert.ok(generator.counters.surfaceQueries - queries <= 256);
      assert.ok(descriptor);
      assert.deepEqual(structureTarget(descriptor), found.target);
      return { generator, descriptor, attempts };
    }
  }
  assert.fail(
    `No native ${kind} in the fixed bounded search: ${JSON.stringify(attempts)}`
  );
}

export function structureChunks(descriptor) {
  const chunks = [];
  for (
    let cz = Math.floor(descriptor.bounds.minZ / 16);
    cz <= Math.floor((descriptor.bounds.maxZ - 1) / 16);
    cz++
  )
    for (
      let cx = Math.floor(descriptor.bounds.minX / 16);
      cx <= Math.floor((descriptor.bounds.maxX - 1) / 16);
      cx++
    )
      chunks.push({ cx, cz });
  assert.ok(chunks.length <= 16, "bounded native structure footprint");
  return chunks;
}

export const chunkBounds = (chunk) => ({
  minX: chunk.cx * 16,
  minZ: chunk.cz * 16,
  minY: chunk.minY,
  maxX: (chunk.cx + 1) * 16,
  maxZ: (chunk.cz + 1) * 16,
  maxY: chunk.maxY,
});

export function drainNativeFallback(t, world) {
  for (let step = 0; step < 1024 && world._requests.size; step++)
    t.mock.timers.tick(1);
  assert.equal(world._requests.size, 0, "native fallback requests must settle");
  assert.equal(world._inFlight.size, 0);
}
