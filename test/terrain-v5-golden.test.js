import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { defaultFluidFor } from "../src/block-state.js";
import { seedHash } from "../src/noise.js";
import { createGenerator } from "../src/terrain.js";
import { v4ForestDensity } from "../src/terrain-v4-vegetation.js";
import { describeV5Structure, V5_GENERATION_MANIFEST } from "../src/terrain-v5-manifest.js";
import { goldenChunkDigest, goldenDataDigest } from "./terrain-golden-digest.js";

const fixture = JSON.parse(readFileSync(new URL("./terrain-v5-golden.json", import.meta.url), "utf8"));
assert.equal(fixture.sourceCommit, "a95ac880cd1075d5ba7339edb8b7bfc23c24a525");
assert.equal(goldenDataDigest(fixture), "e4256c443d4c6c30fa537bba212682d545c67466a1bd566c2a486135ab3f9c04");
assert.deepEqual(fixture.manifest, V5_GENERATION_MANIFEST);
assert.equal(fixture.native.length, 8);
console.log(JSON.stringify({
  immutableV5Source: fixture.sourceCommit, fixtureDigest: goldenDataDigest(fixture),
  chunks: [...fixture.records, ...fixture.native].reduce((count, row) => count + row.chunks.length, 0),
  nativeFamilies: fixture.native.length,
}));

for (const row of fixture.records)
  test(`immutable v5 ${JSON.stringify(row.seed)}/${row.dimension}`, { timeout: 60000 }, () => {
    const generator = createGenerator(row.seed, row.dimension, 5);
    assert.deepEqual(generator.spec, row.spec);
    assert.equal(goldenDataDigest(generator.spec), row.specDigest);
    assert.deepEqual(generator.getSpawn(), row.spawn);
    assert.equal(goldenDataDigest(generator.getSpawn()), row.spawnDigest);
    for (const { cx, cz, label, expected } of row.chunks)
      assert.deepEqual(goldenChunkDigest(generator.generateChunk(cx, cz), defaultFluidFor), expected, label);
  });

for (const row of fixture.native)
  test(`immutable v5 native ${row.kind}: cells, full declarations and marker anchors`, { timeout: 60000 }, () => {
    const generator = createGenerator(row.seed, row.dimension, 5);
    const context = {
      seed: row.seed, dimension: row.dimension, generatorVersion: 5,
      spec: generator.spec, sampleColumn: generator.sampleColumn,
    };
    const actual = describeV5Structure(row.kind, context, row.descriptor.gx, row.descriptor.gz);
    assert.deepEqual(actual, row.descriptor);
    assert.equal(goldenDataDigest(actual), row.descriptorDigest);
    for (const { cx, cz, expected } of [...row.chunks].reverse())
      assert.deepEqual(goldenChunkDigest(generator.generateChunk(cx, cz), defaultFluidFor), expected);
  });

for (const row of fixture.profiles)
  test(`immutable v5 local operator profile: ${row.label}`, () => {
    const generator = createGenerator(row.seed, "overworld", 5);
    const columns = row.columns.map(({ offset }) => {
      const col = generator.sampleColumn(row.x + row.dx * offset, row.z + row.dz * offset);
      return { offset, ...col, forestDensity: v4ForestDensity(col, seedHash(row.seed)) };
    });
    assert.equal(goldenDataDigest(columns), row.digest);
  });
