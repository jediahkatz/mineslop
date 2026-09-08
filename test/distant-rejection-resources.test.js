import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createGenerator } from "../src/terrain.js";
import { DistantTerrain } from "../src/distant-terrain.js";
import { shapeAtlas } from "./shape-fixture.js";

// Count unique backing capacities, never subarray lengths. Exclude external
// generator/material/scene ownership; explicitly include native and all LOD
// lifecycle roots in the total. JS array/object heap is not a typed capacity.
function capacities(lod, world) {
  const seen = new Set(), buffers = new Set();
  const visit = value => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (ArrayBuffer.isView(value)) { buffers.add(value.buffer); return; }
    if (value instanceof ArrayBuffer) { buffers.add(value); return; }
    if (value instanceof Map || value instanceof Set) {
      for (const entry of value.values()) visit(entry);
      return;
    }
    for (const [key, child] of Object.entries(value))
      if (!["world", "generator", "identity", "scene", "parent", "material", "_atlas"].includes(key))
        visit(child);
  };
  visit(lod._job);
  const pendingTerrainBytes = [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0);
  for (const root of [world.chunks, lod._active, lod._vegetation,
    lod._vegetationJob, lod._samples, lod._treeSamples, lod.detailMask.data])
    visit(root);
  return { pendingTerrainBytes,
    combinedTypedBackingBytes: [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0) };
}

test("native v7 canopy rejection terminates refinement and releases pending terrain capacities", () => {
  const generator = createGenerator("cedar-valley", "overworld", 7);
  const world = { seed: "cedar-valley", dimension: "overworld", generatorVersion: 7,
    spec: generator.spec, generator, chunks: new Map() };
  const lod = new DistantTerrain(new THREE.Scene(), world, { atlas: shapeAtlas });
  try {
    for (let i = 0; i < 1600; i++)
      lod.update(new THREE.Vector3(8, 96, 8), {
        radius: 12, quality: "high", outdoors: true, budgetMs: 2,
      });
    const memory = capacities(lod, world);
    console.log(JSON.stringify({ rejections: lod.vegetationRejections,
      pendingPhase: lod._job?.phase, coarse: lod._active?.data.request.bootstrap, ...memory }));
    assert.ok(lod.vegetationRejections > 0, "must exercise actual native canopy rejection");
    assert.equal(world.chunks.size, 0, "LOD cannot generate native chunks to escape rejection");
    assert.equal(lod._job === null, true, "terminal canopy rejection cannot pin a publish-phase terrain job");
    assert.equal(memory.pendingTerrainBytes, 0);
  } finally {
    lod.dispose();
  }
});
