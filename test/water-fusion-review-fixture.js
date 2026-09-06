import assert from "node:assert/strict";
import * as THREE from "three";
import { WaterFusionOwner, waterFusionBudget } from "../src/water-fusion.js";

// CPU analogue of the existing core test backend, with independent live
// allocation tracking. This does not simulate GL compilation or pixel output.
export class ReviewMemoryGPU {
  constructor() {
    this.gl = { UNSIGNED_SHORT: 5123, UNSIGNED_INT: 5125, FLOAT: 5126, isContextLost: () => false };
    this.buffers = new Set();
    this.textures = new Map();
    this.operations = [];
  }
  allocateTexture(r) {
    r.texture = new THREE.DataTexture(r.data, r.plan.width, r.plan.height);
    r.textureAllocated = true;
    this.textures.set(r.texture, r.plan.textureBytes);
    this.operations.push({ kind: "texture-allocation", bytes: r.plan.textureBytes });
  }
  allocateBuffer(r, field, bytes) {
    r[field] = { data: new Uint8Array(bytes) };
    this.buffers.add(r[field]);
    this.operations.push({ kind: field, bytes });
  }
  uploadBuffer(r, field, offset, data) {
    r[field].data.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset);
    this.operations.push({ kind: "buffer-upload", bytes: data.byteLength });
  }
  uploadRows(r, first, count) {
    this.operations.push({ kind: "row-upload", bytes: count * r.plan.width * 16 });
  }
  detachGeometry(r) {
    if (!r.drawGeometry || r.internalDispose) return;
    r.internalDispose = true;
    r.drawGeometry.index = null;
    r.drawGeometry.attributes = {};
    try { r.drawGeometry.dispose(); } finally { r.internalDispose = false; }
  }
  releaseTexture(r) {
    const texture = r.texture;
    r.texture = null;
    r.textureAllocated = false;
    if (texture) {
      this.textures.delete(texture);
      try { texture.dispose(); } finally { texture.image.data = null; }
    }
  }
  releaseBuffer(r, field) {
    this.buffers.delete(r[field]);
    r[field] = null;
  }
  reset(r) {
    this.detachGeometry(r);
    this.releaseTexture(r);
    this.releaseBuffer(r, "indexBuffer");
    this.releaseBuffer(r, "vbo");
    r.material?.dispose();
    r.material = null;
  }
  bytes() {
    return [...this.textures.values()].reduce((n, bytes) => n + bytes, 0) +
      [...this.buffers].reduce((n, buffer) => n + buffer.data.byteLength, 0);
  }
  dispose() {}
}

export function reviewFixture(t, options = {}) {
  t.mock.method(performance, "now", () => 0);
  const gpu = new ReviewMemoryGPU(), renderer = {}, scene = new THREE.Scene();
  const context = { incarnation: 1, required: true };
  const owner = new WaterFusionOwner({ enabled: true, context, backendFactory: () => gpu, ...options });
  const geometries = [], materials = new Set();
  const material = new THREE.MeshLambertMaterial({
    transparent: true, side: THREE.DoubleSide, vertexColors: true, depthWrite: false,
  });
  const source = (sharedMaterial = material) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute([1, 1, 1, 1, 1, 1, 1, 1, 1], 3));
    geometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2]), 1));
    const mesh = new THREE.Mesh(geometry, sharedMaterial);
    scene.add(mesh);
    geometries.push(geometry);
    materials.add(sharedMaterial);
    return mesh;
  };
  const request = (mesh) => {
    const incarnation = context.incarnation;
    return owner.request(mesh, {
      exclusiveGeometry: true, current: () => context.required && context.incarnation === incarnation,
    });
  };
  const pump = (done = () => owner.pending.size === 0) => {
    for (let i = 0; i < 200 && !done(); i++) {
      const budget = waterFusionBudget();
      owner.step(renderer, budget);
      assert.ok(budget.usedBytes <= 1048576);
      assert.ok(budget.work.length <= 16);
    }
    assert.ok(done(), "bounded CPU fixture must finish pending work");
  };
  const publish = (mesh) => {
    assert.equal(request(mesh).state, "pending");
    pump();
    assert.equal(owner.status(mesh).ready, true);
  };
  t.after(() => {
    owner.dispose();
    for (const geometry of geometries) geometry.dispose();
    for (const m of materials) m.dispose();
  });
  return { gpu, renderer, scene, context, owner, material, source, request, pump, publish };
}

export function ownershipState(f, mesh, record) {
  const decoder = mesh.userData.waterFusion?.decoder?.geometry;
  return {
    owned: f.owner.contains(mesh), pending: f.owner.pending.size,
    published: record.published, ready: record.isReady(), phase: record.phase,
    userDataRetained: !!mesh.userData.waterFusion,
    decoderRetained: !!decoder, decoderIndexRetained: !!decoder?.index,
    physicalIndexRetained: !!mesh.geometry.index,
    canonicalRetained: !!record.data, recordIndicesRetained: !!record.indices,
    publications: f.owner.stats.publications,
    failures: f.owner.stats.failures,
    resources: f.owner.resources(), backendBytes: f.gpu.bytes(),
  };
}

// Deliberately scans actual records outside the measured operation. No imports
// from the ledger, cached contributions, or tracked attachment flags.
export function assertReviewAccounting(f) {
  const backing = new Set(), attributes = new Set();
  let futureCpu = 0, gpu = 0, staging = 0, metadata = 0, draws = 0;
  for (const r of f.owner.records.values()) {
    if (!r.published) {
      for (const a of [...r.plan.attributes, r.plan.index]) {
        backing.add(a.array.buffer); attributes.add(a);
      }
      futureCpu += Number(!r.data) * r.plan.textureBytes + Number(!r.metadata) * r.plan.metadataBytes;
      staging += r.plan.textureBytes + r.plan.metadataBytes;
    }
    for (const array of [r.data, r.indices, r.metadata]) if (array) backing.add(array.buffer);
    metadata += r.metadata?.byteLength ?? 0;
    const modes = new Set([r.mode ?? "fused"]);
    if (r.published && r.target) modes.add(r.target);
    gpu += r.indices.byteLength;
    for (const mode of modes) gpu += mode === "fused" ? r.plan.textureBytes : r.plan.vboBytes;
    let attached = !f.owner.drawsWhenAttached;
    for (let parent = r.mesh.parent; parent; parent = parent.parent) attached ||= parent.isScene === true;
    if (attached && Math.min(r.indices.length, r.range.start + r.range.count) - r.range.start >= 3)
      draws += !r.published || modes.has("original") ? 2 : 1;
  }
  const cpu = [...backing].reduce((n, b) => n + b.byteLength, 0);
  const inputGpu = [...attributes].reduce((n, a) => n + a.array.byteLength, 0);
  const actual = f.owner.resources();
  assert.deepEqual(actual, {
    allocatedCpuBytes: cpu, reservedCpuBytes: cpu + futureCpu,
    reservedGpuBytes: gpu + inputGpu, allocatedOwnedGpuBytes: f.gpu.bytes(),
    retainedInputGpuBytes: inputGpu, stagingBytes: staging, reservedDrawCalls: draws,
    metadataBytes: metadata, sources: f.owner.records.size, pending: f.owner.pending.size,
    jsAndDriverHeapMeasured: false,
  });
  return actual;
}

export function drainWithReviewOracle(f) {
  assertReviewAccounting(f);
  for (let i = 0; i < 400 && f.owner.pending.size; i++) {
    const start = f.gpu.operations.length;
    const budget = waterFusionBudget({ operations: 1 });
    f.owner.step(f.renderer, budget);
    const gpuBytes = f.gpu.operations.slice(start).reduce((n, op) => n + op.bytes, 0);
    const gpuDebit = budget.work.filter(op => op.kind.startsWith("gpu-")).reduce((n, op) => n + op.bytes, 0);
    assert.equal(gpuBytes, gpuDebit, "GPU-only work is charged independently of CPU work");
    assert.ok(budget.work.length <= 1);
    assertReviewAccounting(f);
  }
  assert.equal(f.owner.pending.size, 0);
}
