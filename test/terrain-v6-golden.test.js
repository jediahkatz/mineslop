import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { defaultFluidFor } from "../src/block-state.js";
import { createGenerator } from "../src/terrain.js";
import { describeV6Structure, V6_GENERATION_MANIFEST } from "../src/terrain-v6-manifest.js";
import { goldenChunkDigest, goldenDataDigest } from "./terrain-golden-digest.js";

const fixture = JSON.parse(readFileSync(new URL("./terrain-v6-golden.json", import.meta.url), "utf8"));
assert.equal(fixture.sourceCommit, "6c3790183176f60d6fd15cb6253838d5c3d8eb61");
assert.equal(goldenDataDigest(fixture), "7326762cdb8830b8654f0281e8571de6017863a5f8ba7a017757ad6abedeabae");
assert.deepEqual(fixture.manifest, V6_GENERATION_MANIFEST);
assert.equal(fixture.native.length, 8);
console.log(JSON.stringify({ immutableV6Source: fixture.sourceCommit,
  fixtureDigest: goldenDataDigest(fixture), chunks: 129, nativeFamilies: 8 }));

for (const row of fixture.records)
  test(`immutable v6 ${JSON.stringify(row.seed)}/${row.dimension}`, { timeout: 60000 }, () => {
    const generator = createGenerator(row.seed, row.dimension, 6);
    assert.deepEqual(generator.spec, row.spec);
    assert.equal(goldenDataDigest(generator.spec), row.specDigest);
    assert.deepEqual(generator.getSpawn(), row.spawn);
    for (const { cx, cz, label, expected } of row.chunks)
      assert.deepEqual(goldenChunkDigest(generator.generateChunk(cx, cz), defaultFluidFor), expected, label);
  });

for (const row of fixture.native)
  test(`immutable v6 native ${row.kind}`, { timeout: 60000 }, () => {
    const generator = createGenerator(row.seed, row.dimension, 6);
    const context = { seed: row.seed, dimension: row.dimension, generatorVersion: 6,
      spec: generator.spec, sampleColumn: generator.sampleColumn };
    const actual = describeV6Structure(row.kind, context, row.descriptor.gx, row.descriptor.gz);
    assert.deepEqual(actual, row.descriptor);
    assert.equal(goldenDataDigest(actual), row.descriptorDigest);
    for (const { cx, cz, expected } of [...row.chunks].reverse())
      assert.deepEqual(goldenChunkDigest(generator.generateChunk(cx, cz), defaultFluidFor), expected);
  });
