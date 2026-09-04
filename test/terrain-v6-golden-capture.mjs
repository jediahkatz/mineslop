import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { goldenChunkDigest, goldenDataDigest } from "./terrain-golden-digest.js";

// Explicit manual capture from deployed source, never run by assertions.
const sourceCommit = "6c3790183176f60d6fd15cb6253838d5c3d8eb61";
const root = process.argv[2];
assert.ok(root?.startsWith("/"));
assert.notEqual(resolve(root), resolve(new URL("..", import.meta.url).pathname));
const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
assert.equal(git("rev-parse", "HEAD"), sourceCommit);
assert.equal(git("status", "--porcelain"), "");
const load = (path) => import(pathToFileURL(resolve(root, path)).href);
const { createGenerator, GENERATOR_VERSION } = await load("src/terrain.js");
const { defaultFluidFor } = await load("src/block-state.js");
const { firstV6Structure } = await load("test/terrain-v6-fixtures.js");
const { V6_GENERATION_MANIFEST } = await load("src/terrain-v6-manifest.js");
assert.equal(GENERATOR_VERSION, 3);
const prior = JSON.parse(readFileSync(resolve(root, "test/terrain-v5-golden.json"), "utf8"));
const records = [], native = [];
const capture = (generator, cx, cz, label) => {
  const chunk = generator.generateChunk(cx, cz);
  return { cx, cz, label, expected: goldenChunkDigest(chunk, defaultFluidFor) };
};
for (const row of prior.records) {
  const generator = createGenerator(row.seed, row.dimension, 6);
  const spawn = generator.getSpawn();
  const points = row.chunks.map(({ cx, cz, label }) => [cx, cz, label]);
  points.push([Math.floor(spawn.x / 16), Math.floor(spawn.z / 16), "v6-spawn"]);
  if (row.dimension === "end") points.push(
    [3, 0, "central-trough"], [11, 0, "central-rim"], [-13, -1, "negative-rim"],
    [-37, -49, "outer-highland"], [-8, -51, "thin-outer-island"], [28, 0, "void-moat"],
  );
  records.push({
    seed: row.seed, dimension: row.dimension, spec: generator.spec,
    spawn, specDigest: goldenDataDigest(generator.spec), spawnDigest: goldenDataDigest(spawn),
    chunks: points.map(([cx, cz, label]) => capture(generator, cx, cz, label)),
  });
  console.log(JSON.stringify({ seed: row.seed, dimension: row.dimension, chunks: points.length }));
}
for (const kind of V6_GENERATION_MANIFEST.structureKinds) {
  const { generator, descriptor } = firstV6Structure(kind);
  const chunks = [];
  for (let cz = Math.floor(descriptor.bounds.minZ / 16); cz <= Math.floor((descriptor.bounds.maxZ - 1) / 16); cz++)
    for (let cx = Math.floor(descriptor.bounds.minX / 16); cx <= Math.floor((descriptor.bounds.maxX - 1) / 16); cx++)
      chunks.push(capture(generator, cx, cz, kind));
  native.push({ seed: generator.seed, dimension: generator.dimension, kind,
    descriptor, descriptorDigest: goldenDataDigest(descriptor), chunks });
}
const fixture = {
  sourceCommit, generatorVersion: 6, defaultGeneratorVersion: 3,
  encoding: "SHA-256, u16 little-endian, effective state/fluid planes, canonical JSON",
  manifest: V6_GENERATION_MANIFEST, records, native,
};
assert.equal(git("status", "--porcelain"), "");
writeFileSync(new URL("./terrain-v6-golden.json", import.meta.url), `${JSON.stringify(fixture, null, 2)}\n`);
console.log(JSON.stringify({ sourceCommit, fixtureDigest: goldenDataDigest(fixture),
  chunks: [...records, ...native].reduce((n, row) => n + row.chunks.length, 0) }));
