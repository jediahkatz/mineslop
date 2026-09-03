import assert from "node:assert/strict";
import test from "node:test";
import { STRUCTURE_KINDS } from "../src/structure-catalog.js";
import {
  createGenerator,
  GENERATOR_VERSION,
  WATER_LEVEL,
  WORLD_HEIGHT,
} from "../src/terrain.js";
import { createTerrainV4 } from "../src/terrain-v4.js";
import {
  getNativeV4Decorators,
  V4_GENERATION_MANIFEST,
} from "../src/terrain-v4-manifest.js";
import { getWorldSpec } from "../src/world-spec.js";

test("native v4 installs the complete frozen manifest only on the explicit versioned factory path", {
  timeout: 30000, // Exercise native dispatch and a real chunk in every dimension.
}, () => {
  const decorators = getNativeV4Decorators();
  assert.ok(Object.isFrozen(V4_GENERATION_MANIFEST));
  assert.ok(Object.isFrozen(V4_GENERATION_MANIFEST.structureKinds));
  assert.ok(Object.isFrozen(decorators));
  assert.throws(() => V4_GENERATION_MANIFEST.structureKinds.pop(), TypeError);
  // Mechanism guard: an omitted catalog family would produce a different
  // regenerated baseline. Natural first-result coverage exercises every family.
  assert.deepEqual(
    new Set(V4_GENERATION_MANIFEST.structureKinds),
    new Set(STRUCTURE_KINDS)
  );
  assert.equal(
    new Set(decorators.map((entry) => entry.id)).size,
    STRUCTURE_KINDS.length
  );
  for (const dimension of ["overworld", "nether", "end"]) {
    const generator = createGenerator("native-v4-manifest", dimension, 4);
    assert.equal(generator.generationManifest, V4_GENERATION_MANIFEST);
    assert.deepEqual(generator.spec, getWorldSpec(4, dimension));
    assert.equal(
      generator.counters.decoratorCells,
      0,
      "factory registration is not description/emission"
    );
    generator.generateChunk(0, 0);
    assert.equal(generator.counters.chunkGenerations, 1);
    assert.equal(
      generator.counters.regionGenerations,
      0,
      "no recursive decorated sampling"
    );
    assert.equal(
      generator.counters.decoratorCells,
      decorators.filter((entry) => entry.dimensions.includes(dimension)).length
    );
  }
  assert.equal(GENERATOR_VERSION, 3);
  assert.equal(WORLD_HEIGHT, 96);
  assert.equal(WATER_LEVEL, 24);
  for (const version of [1, 2, 3]) {
    const generator = createGenerator(
      "native-v4-manifest",
      "overworld",
      version
    );
    assert.equal(generator.generationManifest, undefined);
    const chunk = generator.generateChunk(0, 0);
    assert.ok(chunk.blocks instanceof Uint8Array);
    assert.equal(chunk.blocks.length, WORLD_HEIGHT * 256);
    assert.equal(chunk.structures, undefined);
  }
});

test("the explicit low-level v4 decorator seam stays undecorated and shares the native raw field", {
  timeout: 30000, // Two real fields and a native full-height chunk, not an injected generator.
}, () => {
  const raw = createTerrainV4("native-v4-raw-seam");
  const native = createGenerator(raw.seed, "overworld", 4);
  for (const [x, z] of [
    [0, 0],
    [-1, -1],
    [-6144, 4096],
    [-30000000, 29999999],
  ]) {
    assert.deepEqual(native.sampleColumn(x, z), raw.sampleColumn(x, z));
    assert.equal(native.surfaceYAt(x, z), raw.surfaceYAt(x, z));
  }
  assert.equal(native.counters.decoratorCells, 0);
  assert.equal(native.counters.chunkGenerations, 0);
  assert.equal(raw.generateChunk(0, 0).structures, undefined);
  assert.equal(raw.counters.decoratorCells, 0);
  assert.equal(raw.generationManifest, undefined);
});
