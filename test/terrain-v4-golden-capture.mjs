import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { goldenChunkDigest, goldenDataDigest } from "./terrain-golden-digest.js";

// Manual, read-only baseline diagnostic; NEVER imported by the test suite.
// Pass the unchanged deployed checkout explicitly, not the checkout under test.
const root = process.argv[2];
assert.ok(root?.startsWith("/"), "an absolute deployed-source path is required");
assert.notEqual(resolve(root), resolve(new URL("..", import.meta.url).pathname));
const { createGenerator, GENERATOR_VERSION } = await import(
  pathToFileURL(resolve(root, "src/terrain.js")).href
);
const { defaultFluidFor } = await import(
  pathToFileURL(resolve(root, "src/block-state.js")).href
);
assert.equal(GENERATOR_VERSION, 3, "the deployed source still defaults to v3");
const records = [];
for (const seed of ["cedar-valley", "mineslop-audit-2", ""]) {
  for (const dimension of ["overworld", "nether", "end"]) {
    const generator = createGenerator(seed, dimension, 4);
    const spawn = generator.getSpawn();
    const coordinates = [
      [0, 0], [-1, 2], [100000, -90000], [-1875000, 1874999],
      [Math.floor(spawn.x / 16), Math.floor(spawn.z / 16)],
    ];
    if (seed === "cedar-valley" && dimension === "overworld")
      coordinates.push([-222, -260], [-297, -233], [70, -72]);
    if (seed === "cedar-valley" && dimension === "nether")
      coordinates.push([-5, -5], [40, 48]);
    const chunks = [];
    const seen = new Set();
    for (const [cx, cz] of coordinates) {
      const key = `${cx},${cz}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const chunk = generator.generateChunk(cx, cz);
      const expected = goldenChunkDigest(chunk, defaultFluidFor);
      assert.deepEqual(
        goldenChunkDigest(generator.generateChunk(cx, cz), defaultFluidFor),
        expected,
        "unchanged deployed source repeats with warm caches"
      );
      chunks.push({
        cx, cz, expected,
        coverage: {
          structureKinds: (chunk.structures ?? []).map(({ kind }) => kind),
          stateSections: chunk.sections?.filter((s) => s.states).length ?? 0,
          fluidSections: chunk.sections?.filter((s) => s.fluids).length ?? 0,
        },
      });
    }
    records.push({
      seed, dimension, spawn, spawnDigest: goldenDataDigest(spawn), chunks,
    });
    console.log(JSON.stringify({ seed, dimension, spawn, chunks: chunks.length }));
  }
}
const fixture = {
  sourceCommit: "afe5fdcc000dd5bd28ee94a514627741db0da247",
  generatorVersion: 4,
  defaultGeneratorVersion: 3,
  encoding: "SHA-256, u16 little-endian, effective state/fluid planes, canonical JSON",
  records,
};
writeFileSync(
  "/tmp/mineslop-development/test/terrain-v4-golden.json",
  `${JSON.stringify(fixture, null, 2)}\n`
);
console.log(JSON.stringify({
  result: "captured unchanged deployed v4 constants",
  records: records.length,
  chunks: records.reduce((n, row) => n + row.chunks.length, 0),
  sha256: goldenDataDigest(fixture),
}));
