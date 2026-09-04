import assert from "node:assert/strict";
import { locateStructure } from "../src/structure-catalog.js";
import { createGenerator } from "../src/terrain.js";
import { describeV6Structure } from "../src/terrain-v6-manifest.js";

export const v6Context = (generator) => ({
  seed: generator.seed, generatorVersion: 6, dimension: generator.dimension,
  spec: generator.spec, sampleColumn: generator.sampleColumn,
});
export const v6Job = (generator, cx, cz) => ({
  type: "generate", schemaVersion: 2, id: 7, epoch: 3, seed: generator.seed,
  dimension: generator.dimension, generatorVersion: generator.generatorVersion,
  minY: generator.minY, maxY: generator.maxY, cx, cz,
});

// Real bounded discovery, before any block generation. No hand-built columns,
// fabricated descriptors, retries after validation failure, or catalog-only tests.
export function firstV6Structure(kind) {
  const dimension = ["nether_fortress", "bastion_remnant"].includes(kind) ? "nether" : "overworld";
  for (const seed of ["cedar-valley", "tidal-archive", "basalt-crossing"]) {
    const generator = createGenerator(seed, dimension, 6), context = v6Context(generator);
    for (const from of [{ x: -4096, z: -4096 }, { x: 0, z: 0 },
      { x: 6144, z: 4096 }, { x: -6144, z: 6144 }]) {
      const found = locateStructure(kind, context, from, { radius: 12, maxCells: 625, maxSamples: 12288 });
      assert.ok(found.examinedCells <= 625 && found.sampledColumns <= 12288);
      assert.equal(generator.counters.chunkGenerations, 0);
      assert.equal(generator.counters.regionGenerations, 0);
      assert.equal(generator.counters.naturalColumns, 0);
      if (!found.target) continue;
      const descriptor = describeV6Structure(kind, context, found.target.gx, found.target.gz);
      assert.ok(descriptor);
      assert.equal(descriptor.generatorVersion, 6);
      return { generator, descriptor };
    }
  }
  assert.fail(`No real v6 ${kind} in the fixed bounded search`);
}
