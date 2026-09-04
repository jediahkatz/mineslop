import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { defaultFluidFor } from "../src/block-state.js";
import { createGenerator } from "../src/terrain.js";
import { describeV7Structure, V7_GENERATION_MANIFEST } from "../src/terrain-v7-manifest.js";
import { goldenChunkDigest, goldenDataDigest } from "./terrain-golden-digest.js";
import { v7Context } from "./terrain-v7-fixtures.js";
import { centralOutline, hollowSpill } from "./terrain-v7-profiles.js";

const fixture = JSON.parse(readFileSync(new URL("./terrain-v7-golden.json", import.meta.url), "utf8"));
assert.equal(goldenDataDigest(fixture), "bb04440f58a1751ea9e60457ea694facb70b97e84502325464b22f13019363ff");
assert.equal(fixture.preservedBaselineCommit, "6c3790183176f60d6fd15cb6253838d5c3d8eb61");
assert.equal(fixture.preservedBaselineDigest, "7326762cdb8830b8654f0281e8571de6017863a5f8ba7a017757ad6abedeabae");
assert.deepEqual(fixture.manifest, V7_GENERATION_MANIFEST);
console.log(JSON.stringify({ staticV7FixtureDigest: goldenDataDigest(fixture),
  chunks: [...fixture.records, ...fixture.native].reduce((n, row) => n + row.chunks.length, 0) }));

for (const row of fixture.records)
  test(`static v7 ${JSON.stringify(row.seed)}/${row.dimension}: cells, specs, profiles and geometry metadata`, { timeout: 60000 }, () => {
    const gen = createGenerator(row.seed, row.dimension, 7);
    assert.deepEqual(gen.spec, row.spec);
    assert.deepEqual(gen.getSpawn(), row.spawn);
    if (row.plan) {
      assert.deepEqual(gen.getEndPillars(), row.pillars);
      assert.deepEqual(gen.getEndTerrainPlan(), row.plan);
      assert.deepEqual(centralOutline(gen), row.outline);
      assert.deepEqual(row.plan.bowls.map((bowl) => hollowSpill(gen, bowl)), row.spills);
    }
    for (const { cx, cz, expected } of [...row.chunks].reverse())
      assert.deepEqual(goldenChunkDigest(gen.generateChunk(cx, cz), defaultFluidFor), expected, `${cx},${cz}`);
  });

for (const row of fixture.native)
  test(`static v7 native ${row.kind}: full declarations and marker anchors`, { timeout: 60000 }, () => {
    const gen = createGenerator(row.seed, row.dimension, 7);
    assert.deepEqual(describeV7Structure(row.kind, v7Context(gen), row.descriptor.gx, row.descriptor.gz), row.descriptor);
    for (const { cx, cz, expected } of [...row.chunks].reverse())
      assert.deepEqual(goldenChunkDigest(gen.generateChunk(cx, cz), defaultFluidFor), expected);
  });
