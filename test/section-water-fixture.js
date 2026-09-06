import * as THREE from "three";
import { authoredColumns, shapeRenderer, disposeShapeRenderer } from "./shape-fixture.js";
import { BLOCK } from "../src/blocks.js";

export class SectionWaterMemoryGPU {
  constructor() {
    this.gl = { UNSIGNED_SHORT: 5123, UNSIGNED_INT: 5125, FLOAT: 5126, isContextLost: () => false };
    this.operations = [];
  }
  allocateTexture(r) {
    this.operations.push(r.plan.textureBytes);
    r.texture = new THREE.DataTexture(r.data, r.plan.width, r.plan.height);
    r.textureAllocated = true;
  }
  allocateBuffer(r, field, size) { this.operations.push(size); r[field] = { bytes: new Uint8Array(size) }; }
  uploadBuffer(r, field, offset, data) {
    this.operations.push(data.byteLength);
    r[field].bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset);
    this.afterTransfer?.(r);
  }
  uploadRows(r, first, count) { this.operations.push(count * r.plan.width * 16); this.afterTransfer?.(r); }
  detachGeometry(r) {
    if (!r.drawGeometry) return;
    r.internalDispose = true;
    r.drawGeometry.index = null; r.drawGeometry.attributes = {}; r.drawGeometry.dispose();
    r.internalDispose = false;
  }
  releaseTexture(r) { r.texture?.dispose(); r.texture = null; r.textureAllocated = false; }
  releaseBuffer(r, field) { r[field] = null; }
  reset(r) {
    this.detachGeometry(r); this.releaseTexture(r); r.material?.dispose(); r.material = null;
    r.indexBuffer = r.vbo = null;
  }
  dispose() {}
}

export function sectionWaterFixture(t, limits = {}, entries = [[8, 8, 8, BLOCK.WATER]]) {
  t.mock.method(performance, "now", () => 0);
  const world = authoredColumns([[0, 0]], entries), g = shapeRenderer(world), gpu = new SectionWaterMemoryGPU();
  g.waterFusionEnabled = true; g.contextResourceOwners = new Set();
  g.renderer = { getContext: () => gpu.gl, render() {} };
  g.waterFusionBackendFactory = () => gpu;
  g.meshLimits = { regionalPages: true, maxCopyBytesPerSlice: 2048, ...limits };
  g.camera.position.set(8, 12, 12); g.camera.lookAt(8, 8, 8);
  const frames = [];
  const tick = () => {
    const before = gpu.operations.length;
    g.rebuildDirty(2);
    frames.push({ cells: g.meshStats.lastSliceCells, bytes: g.meshStats.lastSliceCopyBytes,
      steps: g.meshStats.lastSliceSteps, water: g.meshStats.waterWork,
      gpuBytes: gpu.operations.slice(before).reduce((n, b) => n + b, 0) });
  };
  const settle = (predicate = () => !world.dirtySectionRevisions.size && !g.sectionWater.owner.pending.size) => {
    for (let i = 0; i < 2000 && !predicate(); i++) tick();
    if (!predicate()) throw new Error(JSON.stringify({ stats: g.meshStats,
      water: [...g.sectionWater.owner.records.values()].map(r => [r.phase, r.error]),
      jobs: [...g.sectionJobs.values()].map(j => [j.status, !!j.pagePlan]) }));
  };
  t.after(() => { disposeShapeRenderer(g); g.sectionWater?.dispose(); });
  return { g, world, gpu, frames, tick, settle,
    water: () => [...g.sectionWater.owner.records.keys()].filter(m => m.userData.sectionWater.installed) };
}
