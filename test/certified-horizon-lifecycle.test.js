import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { DistantTerrain, DISTANT_TERRAIN_LIMITS } from "../src/distant-terrain.js";
import { createGenerator } from "../src/terrain.js";
import { reviewTerrainBacking } from "./distant-transition-review-fixtures.js";

test("degraded native forest releases staging, refreshes real bounds and resumes after revision change", t => {
  t.mock.method(performance, "now", () => 0);
  const generator = createGenerator("cedar-valley", "overworld", 7);
  const world = { generator, spec: generator.spec, generatorVersion: 7, dimension: "overworld",
    seed: "cedar-valley", epoch: 0, chunks: new Map() };
  const scene = new THREE.Scene();
  const lod = new DistantTerrain(scene, world);
  const options = { radius: 12, quality: "high", outdoors: true, budgetMs: 4, nativeBoundaries: new Map() };
  const peaks = { cpu: 0, gpu: 0, staging: 0 };
  const step = position => {
    lod.update(position, options);
    assert.ok(lod.lastWork.samples <= DISTANT_TERRAIN_LIMITS.samplesPerUpdate);
    assert.ok(lod.lastWork.units <= DISTANT_TERRAIN_LIMITS.workPerUpdate);
    const r = lod.resources();
    assert.ok(r.cpuBytes + r.stagingBytes >= reviewTerrainBacking(lod));
    peaks.cpu = Math.max(peaks.cpu, r.cpuBytes + r.stagingBytes);
    peaks.gpu = Math.max(peaks.gpu, r.gpuBytes);
    peaks.staging = Math.max(peaks.staging, r.stagingBytes);
    assert.ok(r.cpuBytes + r.stagingBytes <= 256 * 1024 ** 2);
    assert.ok(r.gpuBytes <= 256 * 1024 ** 2);
    assert.ok(r.stagingBytes <= 16 * 1024 ** 2);
  };
  try {
    for (let i = 0; i < 1600; i++) step({ x: 8, z: 8 });
    assert.equal(lod.publication.state, "degraded");
    assert.equal(lod._job, null);
    assert.equal(lod.resources().stagingBytes, 0);
    assert.equal(lod.fogDistance, 192);
    const first = lod._active;
    const rejections = lod.vegetationRejections;
    for (let i = 0; i < 100; i++) step({ x: 8, z: 8 });
    assert.equal(lod._active, first);
    assert.equal(lod.vegetationRejections, rejections, "stationary rejection is not retried");
    step({ x: 104, z: 8 });
    assert.equal(lod._active, first, "old installed geometry survives replacement staging");
    assert.equal(lod.fogDistance, 128);
    for (let i = 0; i < 1600; i++) step({ x: 104, z: 8 });
    assert.notEqual(lod._active, first);
    assert.equal(lod._job, null);
    assert.ok(lod.fogDistance >= 192);
    step({ x: 8, z: 8 });
    assert.ok(lod.fogDistance > 0, "reversal retains the real overlap before replacement");
    const previous = lod._active;
    world.epoch++;
    lod.update({ x: 8, z: 8 }, { ...options, budgetMs: 0 });
    assert.equal(lod.ready, false);
    assert.equal(lod._active, null);
    assert.equal(previous.group.parent, null);
    assert.equal(lod.resources().cpuBytes, 0);
  } finally { lod.dispose(); }
  assert.deepEqual(lod.resources(),
    { cpuBytes: 0, gpuBytes: 0, stagingBytes: 0, pendingCanopyElements: 0 });
  assert.equal(scene.children.length, 0);
  t.diagnostic(JSON.stringify({ exactTypedBackingPeaks: peaks, nativeChunks: world.chunks.size }));
});
