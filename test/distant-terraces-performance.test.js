import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { DistantTerrain, DISTANT_TERRAIN_LIMITS } from "../src/distant-terrain.js";

const biome = { id: "plains", grassColor: "#83ac52", waterColor: "#489fbb" };

test("terraced horizon cold/warm CPU and resident geometry stay bounded", (t) => {
  for (const quality of ["low", "medium", "high"]) {
    const measurements = [];
    for (let repeat = 0; repeat < 5; repeat++) {
      let reads = 0;
      const world = {
        seed: "terrace-benchmark",
        generatorVersion: 3,
        dimension: "overworld",
        generator: {
          terrainHeight(x, z) {
            reads++;
            return 60 + Math.floor(24 * Math.sin(x / 57) * Math.cos(z / 79));
          },
          getBiome: () => biome,
        },
      };
      const lod = new DistantTerrain(new THREE.Scene(), world);
      const position = { x: 8, z: 8 };
      const options = { quality, outdoors: true, budgetMs: 4 };
      const start = performance.now();
      let frames = 0, maxUpdate = 0;
      while (!lod.ready && frames++ < 500) {
        const frame = performance.now();
        lod.update(position, options);
        maxUpdate = Math.max(maxUpdate, performance.now() - frame);
        assert.ok(lod.lastWork.units <= DISTANT_TERRAIN_LIMITS.workPerUpdate);
        assert.ok(lod.lastWork.samples <= DISTANT_TERRAIN_LIMITS.samplesPerUpdate);
      }
      const coldMs = performance.now() - start;
      assert.equal(lod.ready, true);
      let vertices = 0, indices = 0, bytes = 0, meshes = 0;
      lod.group.traverse((mesh) => {
        if (!mesh.isMesh) return;
        meshes++;
        vertices += mesh.geometry.attributes.position.count;
        indices += mesh.geometry.drawRange.count;
        bytes += mesh.geometry.index.array.byteLength;
        for (const attribute of Object.values(mesh.geometry.attributes))
          bytes += attribute.array.byteLength;
      });
      const sampled = reads;
      const warmStart = performance.now();
      for (let i = 0; i < 100; i++) lod.update(position, options);
      const warmMs = (performance.now() - warmStart) / 100;
      assert.equal(reads, sampled, "stationary frames never resample terrain");
      assert.equal(meshes, 2, "terrain + water: no per-cell draw calls");
      assert.ok(bytes < 12 * 1024 * 1024, "bounded merged GPU geometry");
      measurements.push({ coldMs, warmMs, maxUpdate, frames, reads, vertices, indices, bytes, meshes });
      lod.dispose();
    }
    measurements.sort((a, b) => a.coldMs - b.coldMs);
    t.diagnostic(JSON.stringify({ quality, median: measurements[2] }));
  }
});
