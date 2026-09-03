import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { defaultFluidFor } from "../src/block-state.js";
import { createGenerator } from "../src/terrain.js";
import { goldenChunkDigest, goldenDataDigest } from "./terrain-golden-digest.js";

// Fixed constants captured from the unchanged deployed checkout, not from the
// implementation under test. Existing v1-v3 golden tests remain untouched.
const fixture = JSON.parse(
  readFileSync(new URL("./terrain-v4-golden.json", import.meta.url), "utf8")
);
assert.equal(
  goldenDataDigest(fixture),
  "6b6f16551afa69e5be72bfb133745961370302e60766236e29b17c4e91b6b67a",
  "the deployed v4 fixture is immutable"
);
assert.equal(fixture.sourceCommit, "afe5fdcc000dd5bd28ee94a514627741db0da247");

for (const { seed, dimension, spawn, spawnDigest, chunks } of fixture.records)
  test(`pinned deployed v4 ${JSON.stringify(seed)} / ${dimension}`, {
    timeout: 60000,
  }, () => {
    const generator = createGenerator(seed, dimension, 4);
    assert.deepEqual(generator.getSpawn(), spawn);
    assert.equal(goldenDataDigest(generator.getSpawn()), spawnDigest);
    for (const { cx, cz, expected } of chunks)
      assert.deepEqual(
        goldenChunkDigest(generator.generateChunk(cx, cz), defaultFluidFor),
        expected,
        `blocks/biomes/effective states/fluids/structures at ${cx},${cz}`
      );
    for (const { cx, cz, expected } of [...chunks].reverse())
      assert.deepEqual(
        goldenChunkDigest(generator.generateChunk(cx, cz), defaultFluidFor),
        expected,
        `warm-cache reverse order at ${cx},${cz}`
      );
  });
