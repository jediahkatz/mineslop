import { readFileSync, writeFileSync } from "node:fs";
import { defaultFluidFor } from "../src/block-state.js";
import { createNativeTerrainV7 } from "../src/terrain-v7.js";
import { describeV7Structure, V7_GENERATION_MANIFEST } from "../src/terrain-v7-manifest.js";
import { goldenChunkDigest, goldenDataDigest } from "./terrain-golden-digest.js";
import { v7Context } from "./terrain-v7-fixtures.js";
import { centralOutline, hollowSpill } from "./terrain-v7-profiles.js";

// Manual capture only. Assertions load the static JSON; they never recapture.
// v7 is deliberately uncommitted during parent integration: record its source
// digest separately from the immutable v6 baseline rather than invent a SHA.
const prior = JSON.parse(readFileSync(new URL("./terrain-v6-golden.json", import.meta.url), "utf8"));
const records = [], native = [];
const capture = (gen, cx, cz) => ({ cx, cz, expected: goldenChunkDigest(gen.generateChunk(cx, cz), defaultFluidFor) });
for (const row of prior.records) {
  const gen = createNativeTerrainV7(row.seed, row.dimension);
  const coordinates = new Set(row.chunks.map(({ cx, cz }) => `${cx},${cz}`));
  const pillars = gen.getEndPillars(), plan = gen.getEndTerrainPlan();
  if (plan) {
    for (const point of [...pillars, ...plan.bowls])
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++)
        coordinates.add(`${Math.floor(point.x / 16) + dx},${Math.floor(point.z / 16) + dz}`);
  }
  records.push({
    seed: row.seed, dimension: row.dimension, spec: gen.spec, spawn: gen.getSpawn(),
    ...(plan ? { pillars, plan, outline: centralOutline(gen),
      spills: plan.bowls.map((bowl) => hollowSpill(gen, bowl)) } : {}),
    chunks: [...coordinates].map((key) => capture(gen, ...key.split(",").map(Number))),
  });
  console.log(JSON.stringify({ seed: row.seed, dimension: row.dimension, chunks: coordinates.size }));
}
for (const row of prior.native) {
  const gen = createNativeTerrainV7(row.seed, row.dimension);
  native.push({
    seed: row.seed, dimension: row.dimension, kind: row.kind,
    descriptor: describeV7Structure(row.kind, v7Context(gen), row.descriptor.gx, row.descriptor.gz),
    chunks: row.chunks.map(({ cx, cz }) => capture(gen, cx, cz)),
  });
}
const sourceDigests = Object.fromEntries(["terrain-v7.js", "terrain-v7-end.js", "terrain-v7-manifest.js"]
  .map((file) => [file, goldenDataDigest(readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"))]));
const fixture = {
  generatorVersion: 7, defaultGeneratorVersion: 3,
  preservedBaselineCommit: prior.sourceCommit, preservedBaselineDigest: goldenDataDigest(prior),
  sourceDigests, manifest: V7_GENERATION_MANIFEST, records, native,
};
writeFileSync(new URL("./terrain-v7-golden.json", import.meta.url), `${JSON.stringify(fixture, null, 2)}\n`);
console.log(JSON.stringify({ fixtureDigest: goldenDataDigest(fixture),
  chunks: [...records, ...native].reduce((n, row) => n + row.chunks.length, 0) }));
