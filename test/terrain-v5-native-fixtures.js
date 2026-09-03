import assert from "node:assert/strict";
import { locateStructure } from "../src/structure-catalog.js";
import { createGenerator } from "../src/terrain.js";
import { describeV5Structure } from "../src/terrain-v5-manifest.js";

export const v5Job = (generator, cx, cz, id = 7, epoch = 3) => ({
  type: "generate", schemaVersion: 2, id, epoch,
  seed: generator.seed, dimension: generator.dimension, generatorVersion: 5,
  minY: generator.minY, maxY: generator.maxY, cx, cz,
});
export const v5StructureContext = (generator) => ({
  seed: generator.seed, generatorVersion: 5, dimension: generator.dimension,
  spec: generator.spec, sampleColumn: generator.sampleColumn,
});

export function firstV5Structure(kind) {
  const dimension = ["nether_fortress", "bastion_remnant"].includes(kind) ? "nether" : "overworld";
  for (const seed of ["cedar-valley", "tidal-archive", "basalt-crossing"]) {
    const generator = createGenerator(seed, dimension, 5), context = v5StructureContext(generator);
    for (const from of [{ x: -4096, z: -4096 }, { x: 0, z: 0 },
      { x: 6144, z: 4096 }, { x: -6144, z: 6144 }]) {
      const found = locateStructure(kind, context, from, { radius: 12, maxCells: 625, maxSamples: 12288 });
      assert.ok(found.examinedCells <= 625 && found.sampledColumns <= 12288);
      assert.equal(generator.counters.chunkGenerations, 0);
      assert.equal(generator.counters.regionGenerations, 0);
      assert.equal(generator.counters.naturalColumns, 0);
      if (!found.target) continue;
      const descriptor = describeV5Structure(kind, context, found.target.gx, found.target.gz);
      assert.ok(descriptor);
      assert.equal(descriptor.generatorVersion, 5);
      return { generator, descriptor };
    }
  }
  assert.fail(`No real v5 ${kind} in the fixed bounded search`);
}
