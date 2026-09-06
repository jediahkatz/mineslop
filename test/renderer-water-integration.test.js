import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { detailMeshResources } from "../src/section-renderer.js";
import { sectionMeshVisible, sectionSourceGroup } from "../src/section-pages.js";
import { captureMeshRevision, meshRevisionCurrent } from "../src/mesh-snapshot.js";
import { sectionInspectionGeometry } from "../src/section-water-fusion.js";
import { sectionWaterFixture } from "./section-water-fixture.js";
import { colorGeometry } from "./water-pull-fixture.js";

test("detached conversion fits a one-draw cap that raw two-pass water cannot fit", t => {
  const f = sectionWaterFixture(t, { maxDrawCalls: 1 });
  f.settle();
  assert.equal(f.water().length, 1);
  assert.equal(detailMeshResources(f.g).drawCalls, 1);
  assert.equal(f.g.detailCoverage().has("0,0"), true);
  assert.ok(f.frames.some(frame => frame.water.length && frame.cells));
  for (const frame of f.frames) {
    assert.ok(frame.bytes <= 2048);
    assert.ok(frame.gpuBytes <= frame.bytes);
    assert.ok(frame.steps <= 16 && frame.cells <= 8192);
  }
});

test("edits preserve old attached water until atomic replacement; stale geometry is not coverage", t => {
  const f = sectionWaterFixture(t, { maxDrawCalls: 1 });
  f.settle();
  const old = f.water()[0], oldGeometry = old.geometry;
  f.world.put(8, 8, 8, BLOCK.WATER, 0, 2);
  f.g.sectionMeshLimits = { maxCellsPerSlice: 32 };
  f.tick();
  assert.equal(f.water()[0], old);
  assert.ok(old.parent?.parent);
  assert.equal(sectionMeshVisible(old, f.g.camera, f.g.scene), false);
  assert.ok(oldGeometry.index, "old canonical ownership survives pending edit");
  f.settle();
  assert.notEqual(f.water()[0], old);
  assert.equal(oldGeometry.index, null);
  assert.deepEqual(oldGeometry.attributes, {});
  assert.equal(f.g.detailCoverage().has("0,0"), true);
});

test("canonical resources, mesher aliases, decoder and physical eligibility share one authority", t => {
  const f = sectionWaterFixture(t);
  f.settle();
  const mesh = f.water()[0], r = f.g.sectionWater.owner.records.get(mesh);
  const stats = detailMeshResources(f.g), own = f.g.sectionWater.owner.resources();
  assert.equal(stats.canonicalBytes, own.allocatedCpuBytes + stats.palette.cpuBytes);
  assert.equal(stats.gpuBytes, own.reservedGpuBytes + stats.palette.gpuBytes);
  assert.equal(stats.waterStagingGpuBytes, 0);
  assert.equal(stats.waterAllocatedGpuBytes, own.allocatedOwnedGpuBytes);
  const decoded = sectionInspectionGeometry(mesh);
  assert.equal(decoded.attributes.position.data.array.buffer, r.data.buffer);
  const ray = new THREE.Raycaster(new THREE.Vector3(8.5, 12, 8.5), new THREE.Vector3(0, -1, 0));
  f.g.scene.updateMatrixWorld(true);
  assert.ok(ray.intersectObject(mesh).some(h => h.object === mesh));
  for (const mutate of [
    () => { mesh.visible = false; return () => mesh.visible = true; },
    () => { mesh.layers.set(2); return () => mesh.layers.set(0); },
    () => { const b = r.indexBuffer; r.indexBuffer = null; return () => r.indexBuffer = b; },
    () => { r.textureAllocated = false; return () => r.textureAllocated = true; },
  ]) {
    const restore = mutate();
    assert.equal(sectionMeshVisible(mesh, f.g.camera, f.g.scene), false);
    assert.equal(f.g.detailCoverage().has("0,0"), false);
    restore();
  }
  assert.equal(f.g.detailCoverage().has("0,0"), true);
});

test("context owner registration, quality refresh and render reuse cannot grant another frame budget", t => {
  const f = sectionWaterFixture(t);
  f.settle();
  const g = f.g, mesh = f.water()[0], previous = mesh.material;
  assert.ok(g.contextResourceOwners.has(g.sectionWater));
  assert.ok(g.sectionWater.contextResources().includes(mesh.material));
  g.materials.water.needsUpdate = true; g.sectionWater.refresh();
  assert.equal(g.sectionWater.refreshPending, true, "quality invalidates in O(1); refresh awaits shared quota");
  assert.equal(g.sectionWater.owner.pending.size, 0, "no unmetered owner walk at invalidation");
  assert.equal(g.detailCoverage().has("0,0"), false, "pending material publication is not current physical coverage");
  g.meshStats.lastSliceCopyBytes = 2048;
  g.sectionWater.frame.steps = 16;
  assert.equal(g.render(), false);
  assert.equal(g.render(), false);
  assert.equal(g.meshStats.lastSliceCopyBytes, 2048);
  f.tick();
  assert.notEqual(mesh.material, previous);
  const data = g.sectionWater.owner.records.get(mesh).data;
  // Recovery may use genuinely unspent operations. Exhaust them explicitly
  // before asserting that render cannot invent a replacement frame allowance.
  g.sectionWater.frame.steps = 16;
  g.sectionWater.owner.resetGPU();
  assert.equal(g.render(), false);
  f.settle(() => !g.sectionWater.owner.pending.size);
  assert.equal(g.sectionWater.owner.records.get(mesh).data, data);
  assert.equal(g.render(), true);
});

test("unload/incarnation/world cancellation releases staged and canonical owners", t => {
  const f = sectionWaterFixture(t);
  f.settle();
  const old = f.water()[0].geometry;
  f.world.admit(0, 0);
  f.tick();
  assert.equal(old.index, null);
  f.settle();
  assert.equal(f.water().length, 0, "new empty incarnation cannot resurrect old water");
  f.world.put(8, 8, 8, BLOCK.WATER);
  f.settle();
  f.world.chunks.delete("0,0"); f.world.removedChunks.add("0,0");
  f.tick();
  assert.equal(f.g.sectionWater.owner.records.size, 0);
  assert.equal(f.g.sectionWater.entries.size, 0);
  assert.equal(detailMeshResources(f.g).waterAllocatedGpuBytes, 0);
});

test("oversized conversion stays on the original two-call path and can still be refused", t => {
  const f = sectionWaterFixture(t, { maxCopyBytesPerSlice: 512, maxDrawCalls: 1 });
  for (let i = 0; i < 100; i++) f.tick();
  assert.equal(f.water().length, 0);
  assert.equal(f.g.detailCoverage().has("0,0"), false);
  assert.ok(f.world.dirtySectionRevisions.has("0,0,0"));
  assert.ok(detailMeshResources(f.g).drawCalls <= 1);
  f.g.meshLimits.maxDrawCalls = 2;
  f.settle();
  const mesh = f.g.chunks.get("0,0").userData.transparentMeshes[0];
  assert.equal(mesh.userData.sectionWater.fallback, "single-allocation-limit");
  assert.equal(mesh.material.forceSinglePass, false);
  assert.equal(detailMeshResources(f.g).drawCalls, 2);
  assert.equal(f.g.detailCoverage().has("0,0"), true);
});

test("failed detached transfers retain the old section; revision changes cannot publish stale replacements", t => {
  const f = sectionWaterFixture(t, { maxDrawCalls: 1 });
  f.settle();
  const mesh = f.water()[0], data = f.g.sectionWater.owner.records.get(mesh).data;
  f.world.put(8, 8, 8, BLOCK.WATER, 0, 2);
  f.gpu.afterTransfer = () => { f.gpu.afterTransfer = null; throw new Error("failed host transfer"); };
  for (let i = 0; i < 100 && !f.g.sectionWater.owner.stats.failures; i++) f.tick();
  assert.equal(f.g.sectionWater.owner.records.get(mesh).data, data);
  assert.equal(mesh.parent.parent, f.g.chunks.get("0,0"));
  const publications = f.g.sectionWater.owner.stats.publications;
  f.gpu.afterTransfer = () => {
    f.gpu.afterTransfer = null;
    f.world.put(8, 8, 8, BLOCK.WATER, 0, 3);
  };
  f.tick();
  assert.equal(f.g.sectionWater.owner.stats.publications, publications);
  f.settle();
  assert.notEqual(f.water()[0], mesh);
  assert.equal(f.g.detailCoverage().has("0,0"), true);
});

test("radius eviction and world swaps cancel both staged and installed ownership", t => {
  const f = sectionWaterFixture(t);
  f.settle();
  f.world.put(8, 8, 8, BLOCK.WATER, 0, 2);
  f.g.sectionMeshLimits = { maxCellsPerSlice: 32 };
  f.tick();
  f.g.camera.position.x = 1000;
  f.tick();
  assert.equal(f.g.sectionWater.owner.records.size, 0);
  assert.equal(f.g.sectionWater.entries.size, 0);
  assert.equal(f.g.sectionJobs.size, 0);
  f.g.camera.position.x = 8;
  f.g.world = { ...f.world, epoch: f.world.epoch + 1 };
  f.g.rebuildDirty(0);
  assert.equal(f.g.sectionWater.owner.context, f.g.world);
  assert.equal(f.g.sectionWater.frame, null, "paused rebuild cannot grant render a fresh water allowance");
});

test("detached canonical storage deduplicates shared index views and retained mesher geometry references", t => {
  const f = sectionWaterFixture(t, {}, []);
  f.tick();
  const a = colorGeometry(new THREE.BoxGeometry()), b = colorGeometry(new THREE.BoxGeometry());
  const index = new Uint16Array(a.index.array);
  a.setIndex(new THREE.BufferAttribute(index.subarray(0), 1));
  b.setIndex(new THREE.BufferAttribute(index.subarray(0), 1));
  const stamp = captureMeshRevision(f.world, 0, 0, 0);
  const job = { world: f.world, stamp, done: true, status: "ready", snapshotBytes: 0,
    limits: { maxTotalBytes: 2097152 }, result: { parts: [{ water: a }, { water: b }] },
    current: () => meshRevisionCurrent(f.world, stamp) };
  job.waterGroup = sectionSourceGroup(job.result, f.g.materials);
  job.dispose = () => f.g.sectionWater.release(job.waterGroup);
  f.g.sectionJobs.set("0,0,0", job);
  for (let i = 0; i < 100; i++) {
    if (f.g.sectionWater.prepare(job)) break;
    f.g.meshStats.lastSliceCopyBytes = 0;
    f.g.sectionWater.step(f.g.meshStats.limits, 0, 0);
  }
  assert.equal(f.g.sectionWater.prepare(job), true);
  const records = [...f.g.sectionWater.owner.records.values()];
  assert.equal(records.length, 2);
  assert.equal(records[0].indices.buffer, records[1].indices.buffer);
  const own = f.g.sectionWater.owner.resources(), all = detailMeshResources(f.g);
  const canonical = records.reduce((n, r) => n + r.data.byteLength + r.metadata.byteLength, index.byteLength);
  assert.equal(own.allocatedCpuBytes, canonical);
  assert.equal(all.stagingSourceBytes, canonical, "mesher references are emptied, not counted twice");
  assert.equal(all.waterStagingGpuBytes, own.reservedGpuBytes, "two actual index allocations remain charged");
  assert.equal(own.reservedGpuBytes, records.reduce((n, r) => n + r.data.byteLength + r.indices.byteLength, 0));
  assert.deepEqual(a.attributes, {}); assert.equal(a.index, null);
  assert.deepEqual(b.attributes, {}); assert.equal(b.index, null);
  job.dispose(); f.g.sectionJobs.delete("0,0,0");
});
