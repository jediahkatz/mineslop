import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { DistantTerrain } from "../src/distant-terrain.js";
import { DistantTerraces } from "../src/distant-terraces.js";

const baselineRef = process.env.LOD_BASELINE_REF;
const biome = { id: "plains", grassColor: "#83ac52", waterColor: "#489fbb" };
const clock = () => performance.now();
const distribution = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  return { count: sorted.length, p95: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0, worst: sorted.at(-1) ?? 0 };
};

async function loadBaseline(ref) {
  const root = new URL("../", import.meta.url);
  let source = execFileSync("git", ["show", `${ref}:src/distant-terrain.js`], {
    cwd: fileURLToPath(root), encoding: "utf8",
  });
  assert.ok(!source.includes("DistantTerraces"), "select a pre-terrace baseline revision");
  source = source.replace(/from "([^"]+)"/g, (_, specifier) => {
    const resolved = specifier === "three"
      ? import.meta.resolve("three")
      : new URL(specifier, new URL("src/", root)).href;
    return `from "${resolved}"`;
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).DistantTerrain;
}

function trace(Terrain, quality, shape) {
  let reads = 0;
  const world = {
    seed: "terrace-benchmark", generatorVersion: 3, dimension: "overworld",
    generator: {
      terrainHeight(x, z) {
        reads++;
        return shape === "flat" ? 60 : 60 + Math.floor(24 * Math.sin(x / 57) * Math.cos(z / 79));
      },
      getBiome: () => biome,
    },
  };
  const lod = new Terrain(new THREE.Scene(), world);
  const update = [], busy = [], cpu = [], publication = [], publicationUpdate = [];
  const cutout = [], finalization = [], allocation = [];
  const publicationCPU = [], finalizationCPU = [], allocationCPU = [];
  const originalPublish = lod._publish, originalCutout = lod._cutout;
  lod._publish = function (...args) {
    const cpuStart = process.cpuUsage();
    const start = clock();
    const result = originalPublish.apply(this, args);
    publication.push(clock() - start);
    const cost = process.cpuUsage(cpuStart);
    publicationCPU.push((cost.user + cost.system) / 1000);
    return result;
  };
  lod._cutout = function (...args) {
    const start = clock();
    const result = originalCutout.apply(this, args);
    cutout.push(clock() - start);
    return result;
  };
  const originalFinish = DistantTerraces.prototype.finish;
  const originalBegin = DistantTerraces.prototype.begin;
  DistantTerraces.prototype.begin = function (...args) {
    const cpuStart = process.cpuUsage();
    const start = clock();
    const result = originalBegin.apply(this, args);
    allocation.push(clock() - start);
    const cost = process.cpuUsage(cpuStart);
    allocationCPU.push((cost.user + cost.system) / 1000);
    return result;
  };
  DistantTerraces.prototype.finish = function (...args) {
    const cpuStart = process.cpuUsage();
    const start = clock();
    const result = originalFinish.apply(this, args);
    finalization.push(clock() - start);
    const cost = process.cpuUsage(cpuStart);
    finalizationCPU.push((cost.user + cost.system) / 1000);
    return result;
  };
  let worst = { ms: 0 };
  try {
    for (let frame = 0; frame < 600; frame++) {
      const x = 8 + Math.floor(frame / 200) * 64;
      const coverage = frame % 200 >= 50 && frame % 200 < 150
        ? new Set([`${Math.floor(x / 16)},0`, `${Math.floor(x / 16) + 1},0`])
        : new Set();
      const phase = lod._job?.phase ?? "idle";
      const old = lod._active;
      const cpuStart = process.cpuUsage();
      const start = clock();
      lod.update({ x, z: 8 }, { quality, outdoors: true, coverage, budgetMs: quality === "high" ? 2 : 1 });
      const ms = clock() - start;
      const elapsedCPU = process.cpuUsage(cpuStart);
      update.push(ms);
      cpu.push((elapsedCPU.user + elapsedCPU.system) / 1000);
      if (lod.lastWork.units > 0 || lod._job || lod._active !== old) busy.push(ms);
      if (lod._active !== old) publicationUpdate.push(ms);
      if (ms > worst.ms) worst = {
        ms, cpuMs: (elapsedCPU.user + elapsedCPU.system) / 1000, frame, phase,
        nextPhase: lod._job?.phase ?? "idle", published: old !== lod._active,
      };
      assert.ok(lod.lastWork.samples <= 128 && lod.lastWork.units <= 512);
      if (frame % 200 === 199) assert.ok(lod.ready && !lod._job, "each matched stationary window completes");
    }
    let bytes = 0, vertices = 0, referenced = 0, terrainVertices = 0, terrainReferenced = 0, draws = 0;
    lod.group.traverse((mesh) => {
      if (!mesh.isMesh) return;
      if (mesh.visible && mesh.geometry.drawRange.count) draws++;
      vertices += mesh.geometry.attributes.position.count;
      referenced += new Set(mesh.geometry.index.array.subarray(0, mesh.geometry.drawRange.count)).size;
      if (mesh === lod._active.terrain) {
        terrainVertices = mesh.geometry.attributes.position.count;
        terrainReferenced = new Set(mesh.geometry.index.array.subarray(0, mesh.geometry.drawRange.count)).size;
      }
      bytes += mesh.geometry.index.array.byteLength;
      for (const attribute of Object.values(mesh.geometry.attributes)) bytes += attribute.array.byteLength;
    });
    return {
      update: distribution(update), busy: distribution(busy), cpu: distribution(cpu),
      publication: distribution(publication), cutout: distribution(cutout), finalization: distribution(finalization),
      publicationUpdate: distribution(publicationUpdate), allocation: distribution(allocation),
      raw: {
        update, busy, cpu, publication, publicationUpdate, cutout, finalization, allocation,
        publicationCPU, finalizationCPU, allocationCPU,
      },
      worst, reads, bytes, vertices, referenced, terrainVertices, terrainReferenced, draws,
      totalMs: update.reduce((sum, value) => sum + value, 0),
    };
  } finally {
    DistantTerraces.prototype.finish = originalFinish;
    DistantTerraces.prototype.begin = originalBegin;
    lod.dispose();
  }
}

test("matched baseline/terrace camera traces expose per-update and publication costs", {
  skip: !baselineRef && "set LOD_BASELINE_REF to a pre-terrace commit for the matched comparison",
}, async (t) => {
  const Baseline = await loadBaseline(baselineRef);
  // Warm both implementations; then alternate order to reduce JIT/cache bias.
  trace(Baseline, "low", "rolling");
  trace(DistantTerrain, "low", "rolling");
  for (const shape of ["flat", "rolling"]) {
    for (const quality of ["low", "medium", "high"]) {
      const results = { baseline: [], terraces: [] };
      for (let repeat = 0; repeat < 5; repeat++) {
        const order = repeat % 2 ? ["terraces", "baseline"] : ["baseline", "terraces"];
        for (const variant of order)
          results[variant].push(trace(variant === "baseline" ? Baseline : DistantTerrain, quality, shape));
        assert.equal(results.baseline.at(-1).reads, results.terraces.at(-1).reads);
        assert.equal(results.baseline.at(-1).draws, results.terraces.at(-1).draws);
      }
      const summary = Object.fromEntries(Object.entries(results).map(([variant, runs]) => [
        variant,
        {
          ...Object.fromEntries(Object.keys(runs[0].raw).map((metric) => [
            metric, distribution(runs.flatMap((run) => run.raw[metric])),
          ])),
          medianTotalMs: runs.map((run) => run.totalMs).sort((a, b) => a - b)[2],
          bytes: runs[0].bytes, terrainVertices: runs[0].terrainVertices,
          terrainReferenced: runs[0].terrainReferenced, reads: runs[0].reads, draws: runs[0].draws,
          worst: runs.toSorted((a, b) => b.worst.ms - a.worst.ms)[0].worst,
        },
      ]));
      t.diagnostic(JSON.stringify({ shape, quality, baselineRef, summary }));
    }
  }
});
