import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as THREE from "three";

// Snapshot before dynamically importing production code. A concurrent repair
// invalidates the run instead of silently mixing revisions or relaxing a gate.
const sourceFiles = [
  "src/water-fusion.js", "src/water-fusion-ledger.js", "src/water-fusion-geometry.js",
  "src/water-fusion-material.js", "src/water-fusion-gpu.js", "src/section-water-fusion.js",
  "src/section-water-resources.js",
  "src/section-water-visibility.js", "src/section-water-attachments.js", "src/section-water-reclaim.js",
  "src/section-renderer.js", "src/section-pages.js", "src/regional-section-pages.js",
  "src/section-mesh.js", "src/mesh-snapshot.js", "src/renderer.js",
  "test/shape-fixture.js", "test/renderer-water-review-fixture.js",
  "test/renderer-water-review-regression.test.js",
  "test/renderer-water-resource-index.test.js",
];
const root = new URL("../", import.meta.url);
const sha = text => createHash("sha256").update(text).digest("hex");
export function captureHostReviewSources() {
  const hashes = Object.fromEntries(sourceFiles.map(path => [path, sha(readFileSync(new URL(path, root), "utf8"))]));
  const unchanged = () => {
    const changed = sourceFiles.filter(path => sha(readFileSync(new URL(path, root), "utf8")) !== hashes[path]);
    assert.deepEqual(changed, [], "PROVENANCE_CHANGED: concurrent repair invalidates this reproduction");
  };
  return { unchanged };
}

export async function loadHostReviewModules() {
  const [host, scheduler, pages, snapshot, jobs, shape, core, blocks] = await Promise.all([
    import("../src/section-water-fusion.js"), import("../src/section-renderer.js"),
    import("../src/section-pages.js"), import("../src/mesh-snapshot.js"),
    import("../src/section-mesh.js"), import("./shape-fixture.js"),
    import("../src/water-fusion.js"), import("../src/blocks.js"),
  ]);
  return { ...host, ...scheduler, ...pages, ...snapshot, ...jobs, ...shape, ...core, ...blocks };
}

/** Independent CPU allocation model; no GL, shaders or pixel claims. Registry
 * entries are actual byte arrays, not mode-derived ledger contributions. */
class HostReviewMemoryGPU {
  constructor() {
    this.gl = { FLOAT: 5126, UNSIGNED_SHORT: 5123, UNSIGNED_INT: 5125, isContextLost: () => false };
    this.allocations = new Map();
  }
  allocateTexture(r) {
    const texture = new THREE.DataTexture(r.data, r.plan.width, r.plan.height);
    this.allocations.set(texture, { domain: "water", data: new Uint8Array(r.plan.textureBytes) });
    r.texture = texture; r.textureAllocated = true;
  }
  allocateBuffer(r, field, size) {
    const buffer = { data: new Uint8Array(size) };
    this.allocations.set(buffer, { domain: "water", data: buffer.data });
    r[field] = buffer;
  }
  allocateExternal(size) {
    const buffer = { data: new Uint8Array(size) };
    this.allocations.set(buffer, { domain: "external", data: buffer.data });
  }
  uploadBuffer(r, field, offset, view) {
    r[field].data.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), offset);
  }
  uploadRows(r, row, count) {
    const offset = row * r.plan.width * 16, size = count * r.plan.width * 16;
    this.allocations.get(r.texture).data.set(new Uint8Array(r.data.buffer, offset, size), offset);
  }
  detachGeometry(r) {
    if (!r.drawGeometry || r.internalDispose) return;
    r.internalDispose = true;
    r.drawGeometry.index = null; r.drawGeometry.attributes = {};
    try { r.drawGeometry.dispose(); } finally { r.internalDispose = false; }
  }
  releaseTexture(r) {
    const texture = r.texture;
    r.texture = null; r.textureAllocated = false;
    if (!texture) return;
    this.allocations.delete(texture);
    try { texture.dispose(); } finally { texture.image.data = null; }
  }
  releaseBuffer(r, field) { this.allocations.delete(r[field]); r[field] = null; }
  reset(r) {
    this.detachGeometry(r); this.releaseTexture(r);
    this.releaseBuffer(r, "indexBuffer"); this.releaseBuffer(r, "vbo");
    r.material?.dispose(); r.material = null;
  }
  bytes(domain) {
    return [...this.allocations.values()].reduce((n, allocation) =>
      n + (!domain || allocation.domain === domain ? allocation.data.byteLength : 0), 0);
  }
  dispose() {}
}

function triangle() {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([8, 8, 8, 9, 8, 8, 8, 9, 8], 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
  g.setAttribute("color", new THREE.Float32BufferAttribute([1, 1, 1, 1, 1, 1, 1, 1, 1], 3));
  g.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2]), 1));
  return g;
}

export function hostReviewFixture(t, m) {
  t.mock.method(performance, "now", () => 0);
  const world = m.authoredColumns([[0, 0]]);
  world.put(8, 8, 8, m.BLOCK.WATER);
  const g = m.shapeRenderer(world), gpu = new HostReviewMemoryGPU();
  g.camera.position.set(8, 12, 12); g.camera.lookAt(8, 8, 8);
  g.waterFusionEnabled = true;
  g.meshLimits = { regionalPages: true };
  g.sectionPackingMode = "regional";
  g.sectionRegions = new Map(); g.sectionJobs = new Map();
  g.contextResourceOwners = new Set();
  g.renderer = { getContext: () => gpu.gl, render() {} };
  g.waterFusionBackendFactory = () => gpu;
  g.meshStats = { staleJobs: 0, budgetRejections: 0, lastSliceCopyBytes: 0, waterWork: [] };
  const limits = { ...m.DETAIL_MESH_LIMITS, ...m.REGIONAL_MESH_LIMITS };
  const visits = { censusCalls: 0, regionalMeshVisits: 0, ownedMeshVisits: 0, refreshEntryVisits: 0 };
  const host = g.sectionWater = new m.SectionWaterFusion(g, limits, renderer => {
    visits.censusCalls++;
    return m.detailMeshResources(renderer);
  });
  const column = new THREE.Group();
  column.userData = { cx: 0, cz: 0, incarnation: world.chunks.get("0,0").incarnation,
    meshed: true, requiredSections: [0], sections: new Map(), transparentMeshes: [], pages: [], emitters: [] };
  g.chunks.set("0,0", column); g.scene.add(column);
  const disposeJob = job => {
    const original = job.dispose?.bind(job) ?? (() => {});
    job.dispose = () => {
      if (!job.waterGroup.parent) host.release(job.waterGroup);
      job.pagePlan?.dispose();
      original();
    };
    return job;
  };
  const makeJob = (count = 1) => {
    const stamp = m.captureMeshRevision(world, 0, 0, 0);
    const result = { parts: Array.from({ length: count }, () => ({ water: triangle() })) };
    const job = disposeJob({ world, stamp, result, status: "ready", done: true, snapshotBytes: 0,
      limits: m.SECTION_MESH_LIMITS, bytes: count * 138, draws: count,
      waterGroup: m.sectionSourceGroup(result, g.materials),
      current: () => m.meshRevisionCurrent(world, stamp) });
    job.waterGroup.userData.sy = 0;
    g.sectionJobs.set("0,0,0", job);
    return job;
  };
  const step = (stepsAlreadySpent = 0) => {
    g.meshStats.lastSliceCopyBytes = 0; g.meshStats.waterWork = [];
    return host.step(limits, 0, stepsAlreadySpent);
  };
  const drain = () => {
    for (let i = 0; i < 2048 && (host.owner.pending.size || host.refreshPending); i++) step();
    assert.equal(host.owner.pending.size, 0, "fixture core work did not finish");
    assert.equal(host.refreshPending, false, "fixture host refresh did not finish");
  };
  const publish = count => {
    const job = makeJob(count);
    for (let i = 0; i < 2048 && !host.prepare(job); i++) step();
    assert.equal(host.prepare(job), true);
    assert.equal(host.owner.records.size, count);
    for (const r of host.owner.records.values()) {
      assert.equal(r.published, true); assert.equal(r.ready, true);
      assert.equal(r.installed, true, "core geometry exchange has completed");
    }
    column.add(job.waterGroup);
    column.userData.sections.set(0, { group: job.waterGroup, bytes: job.bytes, draws: job.draws, stamp: job.stamp, emitters: [] });
    column.userData.transparentMeshes = job.waterGroup.children.slice();
    host.install(job.waterGroup);
    g.sectionJobs.delete("0,0,0");
    world.acknowledgeSectionMesh(0, 0, 0, job.stamp.ticket);
    return job.waterGroup.children;
  };
  const generatedReplacement = () => {
    world.put(8, 8, 8, m.BLOCK.WATER, 0, 2);
    const job = m.createSectionMeshJob(world, 0, 0, 0, g.atlas, {
      ...m.SECTION_MESH_LIMITS, typedScratch: true,
      maxTotalBytes: limits.maxJobBytes, maxDrawCalls: limits.maxDrawCalls,
    });
    job.admissionKey = [limits.maxCpuBytes, limits.maxGpuBytes, limits.maxStagingBytes].join(":");
    job.step({ flush: true });
    assert.equal(job.status, "ready");
    job.waterGroup = m.sectionSourceGroup(job.result, g.materials);
    job.waterGroup.userData.sy = 0;
    disposeJob(job); g.sectionJobs.set("0,0,0", job);
    return job;
  };
  const instrument = () => {
    const iterator = Map.prototype[Symbol.iterator], keys = Map.prototype.keys;
    t.mock.method(host.owner.records, Symbol.iterator, function* () {
      for (const entry of iterator.call(this)) { visits.ownedMeshVisits++; yield entry; }
    });
    t.mock.method(host.owner.records, "keys", function* () {
      for (const key of keys.call(this)) { visits.ownedMeshVisits++; yield key; }
    });
    t.mock.method(host.entries, Symbol.iterator, function* () {
      for (const entry of iterator.call(this)) { visits.refreshEntryVisits++; yield entry; }
    });
    const list = column.userData.transparentMeshes, arrayIterator = Array.prototype[Symbol.iterator];
    // Node's MockTracker rejects Array targets. Instrument only this fixture
    // instance and restore its descriptor, leaving Array.prototype untouched.
    const previous = Object.getOwnPropertyDescriptor(list, Symbol.iterator);
    Object.defineProperty(list, Symbol.iterator, { configurable: true, value: function* () {
      for (const mesh of arrayIterator.call(this)) { visits.regionalMeshVisits++; yield mesh; }
    } });
    t.after(() => {
      if (previous) Object.defineProperty(list, Symbol.iterator, previous);
      else delete list[Symbol.iterator];
    });
  };
  const resetVisits = () => { for (const key of Object.keys(visits)) visits[key] = 0; };
  const addExternal = () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3 * 256), 3));
    geometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2]), 1));
    const mesh = new THREE.Mesh(geometry, g.materials.glass);
    mesh.userData.batch = "glass";
    column.add(mesh); column.userData.transparentMeshes.push(mesh);
    for (const a of [geometry.attributes.position, geometry.index]) gpu.allocateExternal(a.array.byteLength);
    return mesh;
  };
  const cpuBackingBytes = () => {
    const buffers = new Set();
    for (const mesh of column.userData.transparentMeshes) {
      for (const a of [...Object.values(mesh.geometry.attributes), mesh.geometry.index])
        if (a?.array) buffers.add(a.array.buffer);
    }
    for (const r of host.owner.records.values())
      for (const a of [r.data, r.metadata, r.indices]) if (a) buffers.add(a.buffer);
    return [...buffers].reduce((n, b) => n + b.byteLength, 0);
  };
  t.after(() => {
    for (const job of g.sectionJobs.values()) job.dispose();
    g.sectionJobs.clear(); host.dispose();
    column.traverse(mesh => mesh.geometry?.dispose());
    for (const material of Object.values(g.materials)) material.dispose();
  });
  return { g, world, host, owner: host.owner, gpu, limits, column, visits, resetVisits,
    makeJob, generatedReplacement, step, drain, publish, instrument, addExternal, cpuBackingBytes };
}
