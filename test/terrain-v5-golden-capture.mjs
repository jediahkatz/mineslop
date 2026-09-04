import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { goldenChunkDigest, goldenDataDigest } from "./terrain-golden-digest.js";

// Manual capture only. All generation imports (and their dependencies) resolve
// in the immutable checkpoint, never in the implementation being tested.
const sourceCommit = "a95ac880cd1075d5ba7339edb8b7bfc23c24a525";
const root = process.argv[2];
assert.ok(root?.startsWith("/"));
assert.notEqual(resolve(root), resolve(new URL("..", import.meta.url).pathname));
const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
assert.equal(git("rev-parse", "HEAD"), sourceCommit);
assert.equal(git("status", "--porcelain"), "", "capture source must remain clean");
const load = (path) => import(pathToFileURL(resolve(root, path)).href);
const { createGenerator, GENERATOR_VERSION } = await load("src/terrain.js");
const { defaultFluidFor } = await load("src/block-state.js");
const { seedHash } = await load("src/noise.js");
const { v4ForestDensity } = await load("src/terrain-v4-vegetation.js");
const { firstV5Structure } = await load("test/terrain-v5-native-fixtures.js");
const { findAuditTargets } = await load("test/terrain-v5-audit-helpers.js");
const { V5_GENERATION_MANIFEST } = await load("src/terrain-v5-manifest.js");
assert.equal(GENERATOR_VERSION, 3);
const records = [];
function chunkRecord(generator, cx, cz, label) {
  const chunk = generator.generateChunk(cx, cz);
  const expected = goldenChunkDigest(chunk, defaultFluidFor);
  assert.deepEqual(goldenChunkDigest(generator.generateChunk(cx, cz), defaultFluidFor), expected);
  return {
    cx, cz, label, expected,
    coverage: {
      structureKinds: (chunk.structures ?? []).map(({ kind }) => kind),
      stateSections: (chunk.sections ?? []).filter((section) => section.states).length,
      fluidSections: (chunk.sections ?? []).filter((section) => section.fluids).length,
      sectionCount: chunk.sections?.length ?? 0,
    },
  };
}
for (const seed of ["cedar-valley", "mineslop-audit-2", ""]) {
  for (const dimension of ["overworld", "nether", "end"]) {
    const generator = createGenerator(seed, dimension, 5);
    const spawn = generator.getSpawn();
    const coordinates = [
      [0, 0, "origin"], [-1, 2, "negative"], [100000, -90000, "distant"],
      [-1875000, 1874999, "world-edge"],
      [Math.floor(spawn.x / 16), Math.floor(spawn.z / 16), "spawn"],
    ];
    if (dimension === "overworld" && seed === "cedar-valley") {
      const targets = findAuditTargets(generator);
      assert.deepEqual(targets.missing, []);
      coordinates.push(...targets.points.map(({ x, z, label }) => [x / 16, z / 16, label]));
      let swamp;
      for (let z = -4096; z <= 4096 && !swamp; z += 64)
        for (let x = -4096; x <= 4096 && !swamp; x += 64)
          if (generator.getBiome(x, z).category === "swamp") swamp = [x / 16, z / 16, "swamp"];
      assert.ok(swamp, "bounded swamp fixture");
      coordinates.push(swamp, [31, 0, "taiga-plains-density"]);
    }
    if (dimension === "overworld" && seed === "mineslop-audit-2")
      coordinates.push([64, 20, "birch-desert-dune"], [0, 118, "desert-plateau"],
        [-64, -115, "beach-ocean"], [64, -120, "river-negative-control"]);
    const chunks = coordinates.map(([cx, cz, label]) => chunkRecord(generator, cx, cz, label));
    records.push({
      seed, dimension, spec: generator.spec, specDigest: goldenDataDigest(generator.spec),
      spawn, spawnDigest: goldenDataDigest(spawn), chunks,
    });
    console.log(JSON.stringify({ seed, dimension, chunks: chunks.length }));
  }
}
const native = [];
for (const kind of V5_GENERATION_MANIFEST.structureKinds) {
  const { generator, descriptor } = firstV5Structure(kind);
  const chunks = [];
  const { minX, maxX, minZ, maxZ } = descriptor.bounds;
  for (let cz = Math.floor(minZ / 16); cz <= Math.floor((maxZ - 1) / 16); cz++)
    for (let cx = Math.floor(minX / 16); cx <= Math.floor((maxX - 1) / 16); cx++) {
      const chunk = chunkRecord(generator, cx, cz, kind);
      assert.ok(chunk.coverage.structureKinds.includes(kind));
      chunks.push(chunk);
    }
  native.push({
    seed: generator.seed, dimension: generator.dimension, kind, descriptor,
    descriptorDigest: goldenDataDigest(descriptor), chunks,
  });
  console.log(JSON.stringify({ kind, chunks: chunks.length, origin: descriptor.origin }));
}
const profiles = [];
for (const [seed, x, z, dx, dz, label] of [
  ["mineslop-audit-2", 1024, 325, 0, 1, "dune"],
  ["mineslop-audit-2", 0, 1889, 0, 1, "plateau"],
  ["mineslop-audit-2", -1024, -1838, 0, 1, "coast"],
  ["mineslop-audit-2", 1024, -1919, 0, 1, "river-control"],
  ["cedar-valley", 496, 0, 1, 0, "density"],
]) {
  const generator = createGenerator(seed, "overworld", 5);
  const columns = [];
  for (let offset = -16; offset <= 17; offset++) {
    const col = generator.sampleColumn(x + dx * offset, z + dz * offset);
    columns.push({ offset, ...col, forestDensity: v4ForestDensity(col, seedHash(seed)) });
  }
  profiles.push({ seed, x, z, dx, dz, label, columns, digest: goldenDataDigest(columns) });
}
const fixture = {
  sourceCommit, generatorVersion: 5, defaultGeneratorVersion: 3,
  encoding: "SHA-256, u16 little-endian, effective state/fluid planes, canonical JSON",
  manifest: V5_GENERATION_MANIFEST, records, native, profiles,
};
assert.equal(git("status", "--porcelain"), "");
writeFileSync(new URL("./terrain-v5-golden.json", import.meta.url), `${JSON.stringify(fixture, null, 2)}\n`);
console.log(JSON.stringify({
  sourceCommit, fixtureDigest: goldenDataDigest(fixture), records: records.length,
  chunks: [...records, ...native].reduce((n, row) => n + row.chunks.length, 0),
  nativeFamilies: native.length, profiles: profiles.length,
}));
