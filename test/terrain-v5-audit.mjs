import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createGenerator, GENERATOR_VERSION } from "../src/terrain.js";
import {
  AUDIT_POINTS, AUDIT_SEEDS, auditOrePatch, findAuditTargets,
} from "./terrain-v5-audit-helpers.js";
import { auditBiomeField } from "./terrain-v5-biome-audit.js";

// Explicit parent-run checkpoint diagnostic. It writes JSONL to stdout only.
// Actual generated voxel metrics, not modeled feature probabilities.
const mode = process.argv[2] ?? "baseline";
const versions = (process.argv[3] ?? "4,5").split(",").map(Number);
assert.ok(["baseline", "targets", "biomes"].includes(mode));
assert.ok(versions.length <= 2 && versions.every((v) => v === 4 || v === 5));
const start = performance.now();
console.log(JSON.stringify({
  event: "plan", mode, versions, defaultGeneratorVersion: GENERATOR_VERSION,
  seeds: AUDIT_SEEDS, points: AUDIT_POINTS,
  methods: [
    "Four real independently generated 16x16 chunks per 32x32 core; actual one-cell region halos.",
    "Counts use surviving final ore cells. Host denominator includes natural host rock and matching ore variants.",
    "Surface/cave air use cardinal neighbors and final solid skylines; fluids are not treated as air.",
    "Connected equal-mineral 6-neighbor groups merge stone/deepslate variants; edge-censored groups are separate.",
    "Matched cave/biome Y16 bands, stone/deepslate hosts, surface depth, Nether shelf/ceiling and per-chunk counts.",
    "V5 eligibility/exposure diagnostics read the generator's real pre-ore natural columns.",
    "Targeted samples are not unbiased abundance estimates. No universal vanilla percentages are asserted.",
  ],
}));
for (const version of versions) {
  if (mode === "biomes") {
    console.log(JSON.stringify({ event: "biomes", ...auditBiomeField(version) }));
    continue;
  }
  for (const dimension of ["overworld", "nether", "end"]) {
    if (mode === "targets" && dimension === "end") continue;
    for (const seed of AUDIT_SEEDS) {
      const generator = createGenerator(seed, dimension, version);
      const search = mode === "baseline"
        ? { points: AUDIT_POINTS.map(([x, z]) => ({ x, z, label: "fixed" })), missing: [], samples: 0 }
        : findAuditTargets(generator);
      if (search.missing.length)
        console.log(JSON.stringify({ event: "missing-targets", version, dimension, seed, ...search }));
      for (const point of search.points) {
        assert.ok(performance.now() - start < 20 * 60_000, "bounded diagnostic run");
        const statistics = auditOrePatch(generator, point);
        console.log(JSON.stringify({
          event: "patch", version, dimension, seed, ...point, statistics,
          caches: generator.cacheSizes, counters: generator.counters,
        }));
      }
    }
  }
}
console.log(JSON.stringify({ event: "complete", elapsedMs: Math.round(performance.now() - start) }));
