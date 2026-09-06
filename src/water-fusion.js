import * as THREE from "three";
import { WATER_FIELDS, planWaterGeometry, waterInputCurrent, createWaterDecoder,
  createWaterDrawGeometry } from "./water-fusion-geometry.js";
import { createWaterFusionMaterial, retainWaterMaterial, waterMaterialState, waterMaterialUnsupported } from "./water-fusion-material.js";
import { WaterFusionGPU } from "./water-fusion-gpu.js";
import { WaterFusionLedger, watchWaterAttachment } from "./water-fusion-ledger.js";

// Same ceilings as the existing regional scheduler. Caller budgets may only
// narrow them. This independent opt-in core does not activate GameRenderer.
export const WATER_FUSION_LIMITS = Object.freeze({
  maxCpuBytes: 256 * 1024 * 1024, maxGpuBytes: 256 * 1024 * 1024,
  maxStagingBytes: 16 * 1024 * 1024, maxDrawCalls: 1024,
  maxCopyBytesPerSlice: 1024 * 1024, maxAllocationBytes: 1024 * 1024,
  maxSliceMs: 8, maxStepsPerSlice: 16,
});
const QUANTUM = 16384;
const ZERO_RANGE = Object.freeze({ start: 0, count: 0 });
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Share THIS mutable budget with other meshing work in the same frame. */
export function waterFusionBudget({ bytes = 1048576, operations = 16, milliseconds = 8 } = {}) {
  return { remainingBytes: Math.min(1048576, Math.max(0, bytes)),
    remainingOperations: Math.min(16, Math.max(0, operations)),
    deadline: performance.now() + Math.min(8, Math.max(0, milliseconds)), usedBytes: 0, work: [] };
}

function debit(budget, bytes, kind) {
  if (performance.now() >= budget.deadline || budget.remainingOperations < 1 || budget.remainingBytes < bytes) return false;
  budget.remainingBytes -= bytes; budget.usedBytes += bytes; budget.remainingOperations--;
  budget.work.push({ kind, bytes });
  return true;
}

/**
 * Owns each source independently. externalResources MUST exclude contains(mesh)
 * sources and include all other live/replacement/staging allocations and draws.
 * Proof callbacks must cover world epoch, chunk incarnation, section revision,
 * source identity and required-radius membership; they run before every unit
 * of work, after transfers, at publication and at draw/inspection time.
 */
export class WaterFusionOwner {
  constructor({ enabled = false, context = null, limits = {}, externalResources = () => ({}),
    backendFactory = (renderer, changed) => new WaterFusionGPU(renderer, changed),
    drawsWhenAttached = false } = {}) {
    this.enabled = enabled;
    this.context = context;
    this.limits = Object.fromEntries(Object.entries(WATER_FUSION_LIMITS)
      .map(([key, value]) => [key, Math.min(value, limits[key] ?? value)]));
    this.externalResources = externalResources;
    this.backendFactory = backendFactory;
    this.drawsWhenAttached = drawsWhenAttached;
    this.records = new Map();
    this.ledger = new WaterFusionLedger();
    this.construction = null;
    this.gpuEpoch = 0;
    this.pending = new Set();
    this.diagnostics = new WeakMap();
    this.serial = this.revision = 0;
    this.stats = { publications: 0, cancellations: 0, failures: 0, fallbacks: 0,
      peakCpuBytes: 0, peakGpuBytes: 0, peakStagingBytes: 0 };
  }

  contains(mesh) { return this.records.has(mesh); }
  status(mesh) {
    const r = this.records.get(mesh);
    return r ? { mode: r.mode, ready: r.isReady(), pending: !!r.phase, error: r.error,
      unsupported: r.unsupported, serial: r.serial } : this.diagnostics.get(mesh);
  }

  request(mesh, { current, exclusiveGeometry = false, reviewedHooks = new Set() } = {}) {
    if (!this.enabled || this.disposed) return { state: "disabled" };
    if (this.records.has(mesh)) return this.status(mesh);
    const unsupported = !exclusiveGeometry ? "exclusive-geometry-required" :
      typeof current !== "function" ? "revision-validator-required" :
      waterMaterialUnsupported(mesh, mesh.material, reviewedHooks);
    const plan = unsupported ? null : planWaterGeometry(mesh,
      Math.min(this.limits.maxAllocationBytes, this.limits.maxCopyBytesPerSlice));
    const reason = unsupported ?? plan?.unsupported;
    if (reason) {
      const status = { state: "unsupported", reason, originalPathPreserved: true };
      this.diagnostics.set(mesh, status);
      return status;
    }
    // Only one source construction at a time; callers retry untouched sources.
    if (this.construction) return { state: "busy" };
    const r = { mesh, plan, validate: current, context: this.context, serial: ++this.serial,
      reviewedHooks, sourceMaterial: mesh.material, range: plan.geometry.drawRange,
      indices: plan.index.array, sourceRaycast: mesh.raycast, sourceBefore: mesh.onBeforeRender,
      data: null, metadata: null, copyVertex: 0, sphereVertex: 0, validateIndex: 0,
      box: plan.geometry.boundingBox?.clone() ?? new THREE.Box3(),
      sphere: plan.geometry.boundingSphere?.clone() ?? null,
      radiusSquared: 0, ready: false, published: false, mode: null, target: "fused",
      phase: "cpu-allocation", row: 0, indexUpload: 0, vboUpload: 0 };
    r.current = () => {
      try {
        return this.records.get(mesh) === r && r.context === this.context && r.validate() &&
          this.records.get(mesh) === r && r.context === this.context &&
          (r.installed ? mesh.geometry === r.drawGeometry && mesh.material === r.renderMaterial : waterInputCurrent(r));
      } catch { return false; }
    };
    // Loss can be observable before the asynchronous DOM event reaches us.
    r.isReady = () => r.ready && !this.backend?.gl.isContextLost() && r.current();
    this.records.set(mesh, r);
    this.construction = r;
    this.ledger.add(r);
    r.unwatchAttachment = watchWaterAttachment(r, this.drawsWhenAttached);
    r.releaseMaterial = retainWaterMaterial(r.sourceMaterial);
    if (!r.current() || !this.fits() || !r.current()) {
      if (this.records.get(mesh) === r) this.cancel(mesh, "stale-or-reservation");
      const status = { state: "blocked", reason: "stale-or-reservation", originalPathPreserved: true };
      this.diagnostics.set(mesh, status);
      return status;
    }
    this.pending.add(r); this.revision++;
    return { state: "pending", serial: r.serial };
  }

  resources() {
    return this.ledger.resources(this.records.size, this.pending.size);
  }

  fits() {
    // The host owns this callback's cost; it should be a side-effect-free
    // census. Read our O(1) ledger afterwards, including any callback changes.
    const e = this.externalResources(), s = this.resources();
    const cpu = s.reservedCpuBytes + (e.cpuBytes ?? 0), gpu = s.reservedGpuBytes + (e.gpuBytes ?? 0);
    const staging = s.stagingBytes + (e.stagingBytes ?? 0), draws = s.reservedDrawCalls + (e.drawCalls ?? 0);
    const fits = [cpu, gpu, staging, draws].every(Number.isFinite) &&
      cpu <= this.limits.maxCpuBytes && gpu <= this.limits.maxGpuBytes &&
      staging <= this.limits.maxStagingBytes && draws <= this.limits.maxDrawCalls;
    if (fits) {
      this.stats.peakCpuBytes = Math.max(this.stats.peakCpuBytes, cpu);
      this.stats.peakGpuBytes = Math.max(this.stats.peakGpuBytes, gpu);
      this.stats.peakStagingBytes = Math.max(this.stats.peakStagingBytes, staging);
    }
    return fits;
  }

  bind(renderer) {
    if (this.renderer === renderer) return;
    if (this.backend) { this.resetGPU(); this.backend.dispose(); }
    this.renderer = renderer;
    this.backend = this.backendFactory(renderer, () => this.resetGPU());
  }

  step(renderer, budget = waterFusionBudget({ bytes: this.limits.maxCopyBytesPerSlice,
    operations: this.limits.maxStepsPerSlice, milliseconds: this.limits.maxSliceMs })) {
    if (this.disposed) return budget;
    budget.remainingBytes = Math.min(budget.remainingBytes, this.limits.maxCopyBytesPerSlice);
    budget.remainingOperations = Math.min(budget.remainingOperations, this.limits.maxStepsPerSlice);
    budget.deadline = Math.min(budget.deadline, performance.now() + this.limits.maxSliceMs);
    this.bind(renderer);
    if (this.backend.gl.isContextLost()) return budget;
    // A bounded rotating audit reclaims out-of-radius/epoch-stale hidden data.
    this.audit ??= this.records.values();
    for (let i = 0; i < 4 && budget.remainingOperations > (this.pending.size ? 1 : 0); i++) {
      const next = this.audit.next();
      if (next.done) { this.audit = this.records.values(); break; }
      if (!debit(budget, 0, "validate-owner")) break;
      const r = next.value;
      if (!r.current()) this.release(r.mesh);
      else if (r.published && !r.phase) this.scheduleRefresh(r);
    }
    for (const r of this.pending) {
      while (budget.remainingOperations > 0 && performance.now() < budget.deadline) {
        if (!r.current()) { if (this.records.get(r.mesh) === r) this.release(r.mesh); break; }
        if (!this.fits()) { r.error = "reservation-blocked"; break; }
        if (!r.current()) { if (this.records.get(r.mesh) === r) this.release(r.mesh); break; }
        try {
          if (!this.advance(r, budget)) break;
          if (!r.current()) { if (this.records.get(r.mesh) === r) this.release(r.mesh); break; }
          r.error = null;
        } catch (error) {
          this.stats.failures++;
          r.error = String(error.message ?? error);
          if (this.records.get(r.mesh) !== r) break;
          if (r.phase?.startsWith("cpu")) { this.cancel(r.mesh, r.error); break; }
          if (r.published && r.ready) {
            if (r.target !== r.mode) {
              if (r.target === "original") this.backend.releaseBuffer(r, "vbo");
              else this.backend.releaseTexture(r);
            }
          } else this.backend.reset(r);
          if (this.records.get(r.mesh) !== r) break;
          r.row = r.indexUpload = r.vboUpload = 0;
          r.phase = r.ready && r.mode === r.target ? "publish" : "gpu-allocation";
          break; // Never spin on an error or exhaust another frame's quota.
        }
        if (!r.phase) break;
      }
      if (budget.remainingOperations <= 0 || performance.now() >= budget.deadline) break;
    }
    return budget;
  }

  advance(r, b) {
    const p = r.plan;
    const epoch = this.gpuEpoch;
    if (r.phase === "cpu-allocation") {
      if (!r.data) {
        if (!debit(b, p.textureBytes, "cpu-zero-allocation")) return false;
        r.data = new Float32Array(p.textureBytes / 4);
        return true;
      }
      if (!debit(b, p.metadataBytes, "metadata-allocation")) return false;
      r.metadata = new Uint32Array(p.metadataBytes / 4);
      r.metadata.set([r.serial, p.vertices, p.width, p.height, r.indices.length, r.indices.BYTES_PER_ELEMENT]);
      r.phase = "cpu-copy";
      return true;
    }
    if (r.phase === "cpu-copy") {
      const n = Math.min(p.vertices - r.copyVertex, Math.floor(Math.min(QUANTUM, b.remainingBytes) / 92));
      if (!n || !debit(b, n * 92, "cpu-read-and-copy")) return false;
      const bits = new Uint32Array(r.data.buffer);
      for (let v = r.copyVertex; v < r.copyVertex + n; v++) {
        for (let f = 0; f < WATER_FIELDS.length; f++) {
          const [, size, offset] = WATER_FIELDS[f], a = p.attributes[f];
          const input = p.bits[f];
          for (let k = 0; k < size; k++) {
            if (!Number.isFinite(a.array[v * size + k])) throw new Error("cpu-nonfinite-attribute");
            bits[v * 12 + offset + k] = input[v * size + k];
          }
        }
        if (!p.providedBox) {
          const x = r.data[v * 12], y = r.data[v * 12 + 1], z = r.data[v * 12 + 2];
          r.box.min.x = Math.min(r.box.min.x, x); r.box.max.x = Math.max(r.box.max.x, x);
          r.box.min.y = Math.min(r.box.min.y, y); r.box.max.y = Math.max(r.box.max.y, y);
          r.box.min.z = Math.min(r.box.min.z, z); r.box.max.z = Math.max(r.box.max.z, z);
        }
      }
      r.copyVertex += n;
      if (r.copyVertex === p.vertices) {
        r.sphere ??= new THREE.Sphere(r.box.getCenter(new THREE.Vector3()), 0);
        r.phase = "cpu-sphere";
      }
      return true;
    }
    if (r.phase === "cpu-sphere") {
      const n = Math.min(p.vertices - r.sphereVertex, Math.floor(Math.min(QUANTUM, b.remainingBytes) / 12));
      if (!n || !debit(b, n * 12, "cpu-bounds")) return false;
      if (!p.providedSphere)
        for (let v = r.sphereVertex; v < r.sphereVertex + n; v++) {
          const x = r.data[v * 12] - r.sphere.center.x, y = r.data[v * 12 + 1] - r.sphere.center.y,
            z = r.data[v * 12 + 2] - r.sphere.center.z;
          r.radiusSquared = Math.max(r.radiusSquared, x * x + y * y + z * z);
        }
      r.sphereVertex += n;
      if (r.sphereVertex === p.vertices) {
        if (!p.providedSphere) r.sphere.radius = Math.sqrt(r.radiusSquared);
        r.phase = "cpu-indices";
      }
      return true;
    }
    if (r.phase === "cpu-indices") {
      const n = Math.min(r.indices.length - r.validateIndex,
        Math.floor(Math.min(QUANTUM, b.remainingBytes) / r.indices.BYTES_PER_ELEMENT));
      if (!n || !debit(b, n * r.indices.BYTES_PER_ELEMENT, "cpu-index-validation")) return false;
      const restart = r.indices instanceof Uint16Array ? 0xffff : 0xffffffff;
      for (let i = r.validateIndex; i < r.validateIndex + n; i++) {
        if (r.indices[i] === restart) throw new Error("cpu-primitive-restart");
        if (r.indices[i] >= p.vertices) throw new Error("cpu-index-out-of-range");
      }
      r.validateIndex += n;
      if (r.validateIndex === r.indices.length) r.phase = "gpu-allocation";
      return true;
    }
    if (r.phase === "gpu-allocation") {
      if (!r.indexBuffer) {
        if (!debit(b, p.indexBytes, "gpu-index-zero-allocation")) return false;
        this.backend.allocateBuffer(r, "indexBuffer", p.indexBytes);
        if (epoch !== this.gpuEpoch || !r.current()) return true;
        r.indexUpload = 0;
        return true;
      }
      if (r.target === "fused" && !r.textureAllocated) {
        if (!debit(b, p.textureBytes, "gpu-texture-zero-allocation")) return false;
        this.backend.allocateTexture(r);
        if (epoch !== this.gpuEpoch || !r.current()) return true;
        r.row = 0;
        return true;
      }
      if (r.target === "original" && !r.vbo) {
        if (!debit(b, p.vboBytes, "gpu-vbo-zero-allocation")) return false;
        this.backend.allocateBuffer(r, "vbo", p.vboBytes);
        if (epoch !== this.gpuEpoch || !r.current()) return true;
        r.vboUpload = 0;
        return true;
      }
      r.phase = "gpu-upload";
      return true;
    }
    if (r.phase === "gpu-upload") {
      if (r.indexUpload < r.indices.length) {
        const n = Math.min(r.indices.length - r.indexUpload,
          Math.floor(Math.min(QUANTUM, b.remainingBytes) / r.indices.BYTES_PER_ELEMENT));
        if (!n || !debit(b, n * r.indices.BYTES_PER_ELEMENT, "gpu-index-upload")) return false;
        this.backend.uploadBuffer(r, "indexBuffer", r.indexUpload * r.indices.BYTES_PER_ELEMENT,
          r.indices.subarray(r.indexUpload, r.indexUpload + n));
        if (epoch !== this.gpuEpoch || !r.current()) return true;
        r.indexUpload += n;
        return true;
      }
      if (r.target === "fused" && r.row < p.height) {
        const rows = Math.min(p.height - r.row, Math.floor(Math.min(QUANTUM, b.remainingBytes) / (p.width * 16)));
        if (!rows || !debit(b, rows * p.width * 16, "gpu-row-upload")) return false;
        this.backend.uploadRows(r, r.row, rows);
        if (epoch !== this.gpuEpoch || !r.current()) return true;
        r.row += rows;
        return true;
      }
      if (r.target === "original" && r.vboUpload < p.vertices * 12) {
        const n = Math.min(p.vertices * 12 - r.vboUpload, Math.floor(Math.min(QUANTUM, b.remainingBytes) / 4));
        if (!n || !debit(b, n * 4, "gpu-vbo-upload")) return false;
        this.backend.uploadBuffer(r, "vbo", r.vboUpload * 4, r.data.subarray(r.vboUpload, r.vboUpload + n));
        if (epoch !== this.gpuEpoch || !r.current()) return true;
        r.vboUpload += n;
        return true;
      }
      r.phase = "publish";
      return true;
    }
    if (r.phase === "publish") {
      if (!debit(b, 0, "atomic-publication")) return false;
      if (!r.current() || !this.fits() || this.backend.gl.isContextLost()) return false;
      const unsupported = waterMaterialUnsupported(r.mesh, r.sourceMaterial, r.reviewedHooks);
      const desired = this.enabled && !unsupported ? "fused" : "original";
      if (desired !== r.target) {
        if (!r.published) { this.cancel(r.mesh, unsupported ?? "disabled-before-publication"); return true; }
        if (r.ready && r.target !== r.mode) {
          if (r.target === "fused") this.backend.releaseTexture(r);
          else this.backend.releaseBuffer(r, "vbo");
        } else if (!r.ready) this.backend.reset(r);
        r.target = desired;
        r.phase = r.ready && desired === r.mode ? "publish" : "gpu-allocation";
        r.row = r.indexUpload = r.vboUpload = 0;
        return true;
      }
      if (!r.current()) return false;
      this.publish(r);
      return true;
    }
    return false;
  }

  publish(r) {
    const oldMode = r.mode, oldMaterial = r.material;
    const epoch = this.gpuEpoch;
    const current = () => {
      if (!r.current()) {
        if (this.records.get(r.mesh) === r) this.retire(r, "stale-during-publication");
        return false;
      }
      return epoch === this.gpuEpoch && !this.backend.gl.isContextLost();
    };
    let material, geometry, assigned = false, detached = false;
    const discard = () => {
      material?.dispose();
      if (geometry) { geometry.attributes = {}; geometry.index = null; geometry.dispose(); }
    };
    try {
      material = r.target === "fused" ? createWaterFusionMaterial(r.sourceMaterial, r.texture, r.plan.width) : null;
      if (!current()) { discard(); return; }
      geometry = createWaterDrawGeometry(r, this.backend.gl, r.target);
      detached = true;
      this.backend.detachGeometry(r);
      if (!current()) { discard(); return; }
      r.material = material;
      r.drawGeometry = geometry;
      assigned = true;
      geometry.addEventListener("dispose", () => {
        if (!r.internalDispose && !this.backend.gl.isContextLost() && this.records.get(r.mesh) === r)
          this.release(r.mesh);
      });
      r.decoder ??= createWaterDecoder(r);
      r.mesh.geometry = geometry;
      r.mesh.material = r.material ?? r.sourceMaterial;
      r.renderMaterial = r.mesh.material;
      r.mesh.raycast = r.decoder.raycast;
      r.mesh.userData.waterFusion = r;
      r.beforeHook = (...args) => {
        geometry.drawRange = r.isReady() ? r.range : ZERO_RANGE;
        r.sourceBefore.apply(r.mesh, args);
      };
      r.mesh.onBeforeRender = r.beforeHook;
      // Installed identity differs from a completed publication. Disposal
      // callbacks may release/re-request/reset here; readiness and successful
      // publication counters are committed only after all callbacks return.
      r.installed = true;
      r.ready = false;
      r.mode = r.target;
      // The old clone is no longer in a record slot. Retire it before any
      // later callback can reset this generation and abandon the transaction.
      oldMaterial?.dispose();
      if (!current()) return;
      if (!r.published) {
        const original = r.plan.geometry;
        try { original.dispose(); }
        finally {
          original.attributes = {};
          original.index = null;
        }
        if (this.records.get(r.mesh) === r) {
          r.published = true;
          r.plan.geometry = null;
          r.plan.attributes = r.plan.index = r.plan.bits = null;
          if (this.construction === r) this.construction = null;
        }
        if (!current()) return;
      }
      if (oldMode === "fused" && r.mode === "original") this.backend.releaseTexture(r);
      if (!current()) return;
      if (oldMode === "original" && r.mode === "fused") this.backend.releaseBuffer(r, "vbo");
      if (!current()) return;
      const snapshot = waterMaterialState(r.sourceMaterial);
      if (!current()) return;
      r.materialSnapshot = snapshot;
      r.target = null;
      r.ready = true;
      r.phase = null;
      this.pending.delete(r);
      this.stats.publications++; this.stats.fallbacks += Number(r.mode === "original");
      this.revision++;
    } catch (error) {
      if (!assigned) discard();
      if (detached && this.records.get(r.mesh) === r) this.retire(r, String(error.message ?? error));
      throw error;
    }
  }

  scheduleRefresh(r) {
    const unsupported = waterMaterialUnsupported(r.mesh, r.sourceMaterial, r.reviewedHooks);
    const target = this.enabled && !unsupported ? "fused" : "original";
    const state = waterMaterialState(r.sourceMaterial);
    if (!r.current() || r.phase) return;
    // The conventional path already renders the LIVE source material. Three
    // increments its version for the BACK/FRONT passes; those internal changes
    // must not trigger geometry/material publication on every frame.
    if (target === "original" && r.mode === target && r.renderMaterial === r.sourceMaterial) return;
    if (target === r.mode && same(state, r.materialSnapshot)) return;
    r.unsupported = unsupported;
    r.target = target;
    const fits = this.fits();
    if (!r.current() || r.phase) return;
    if (!fits) { r.target = null; r.error = "fallback-or-refresh-reservation-blocked"; return; }
    r.phase = target === r.mode ? "publish" : "gpu-allocation";
    this.pending.add(r);
  }

  refresh(mesh, { material, reviewedHooks } = {}) {
    const r = this.records.get(mesh);
    if (!r?.published) return false;
    if (material && material !== r.sourceMaterial) {
      r.releaseMaterial?.();
      r.sourceMaterial = material;
      r.releaseMaterial = retainWaterMaterial(material);
    }
    if (reviewedHooks) r.reviewedHooks = reviewedHooks;
    if (!r.phase) this.scheduleRefresh(r);
    return true;
  }

  setEnabled(enabled) { this.enabled = !!enabled; }
  setContext(context) { this.context = context; this.audit = this.records.values(); }

  resetGPU() {
    if (!this.backend) return;
    this.gpuEpoch++;
    for (const r of this.records.values()) {
      r.ready = false;
      if (r.drawGeometry) r.drawGeometry.drawRange = ZERO_RANGE;
      this.backend.reset(r);
      if (this.records.get(r.mesh) !== r) continue;
      r.row = r.indexUpload = r.vboUpload = 0;
      if (r.data && !r.phase?.startsWith("cpu")) {
        r.target = this.enabled && !waterMaterialUnsupported(r.mesh, r.sourceMaterial, r.reviewedHooks) ? "fused" : "original";
        r.phase = "gpu-allocation";
      }
      this.pending.add(r);
    }
    this.revision++;
  }

  cancel(mesh, reason = "cancelled") {
    const r = this.records.get(mesh);
    if (!r || r.published) return false;
    this.retire(r, reason);
    return true;
  }

  release(mesh) {
    const r = this.records.get(mesh);
    if (!r) return;
    this.retire(r, "stale-or-unloaded");
  }

  retire(r, reason) {
    if (r.retiring || this.records.get(r.mesh) !== r) return;
    r.retiring = true;
    const mesh = r.mesh, ownedMaterial = r.material;
    r.ready = false;
    r.phase = null;
    if (r.drawGeometry) r.drawGeometry.drawRange = ZERO_RANGE;
    this.records.delete(mesh); this.pending.delete(r);
    if (this.construction === r) this.construction = null;
    r.unwatchAttachment?.(); r.unwatchAttachment = null;
    // Detach aliases before disposal callbacks can observe or replace owners.
    if (r.decoder) { r.decoder.geometry.attributes = {}; r.decoder.geometry.index = null; }
    if (mesh.onBeforeRender === r.beforeHook) mesh.onBeforeRender = r.sourceBefore;
    if (mesh.raycast === r.decoder?.raycast) mesh.raycast = r.sourceRaycast;
    if (mesh.material === ownedMaterial) mesh.material = r.sourceMaterial;
    if (mesh.userData.waterFusion === r) delete mesh.userData.waterFusion;
    this.diagnostics.set(mesh, { state: "cancelled", reason, originalPathPreserved: !r.installed });
    this.stats.cancellations += Number(!r.published);
    try { this.backend?.reset(r); }
    finally {
      this.ledger.remove(r);
      r.data = r.metadata = r.indices = r.decoder = null;
      r.plan.attributes = r.plan.index = r.plan.geometry = r.plan.bits = null;
      r.releaseMaterial?.(); r.releaseMaterial = null;
      this.revision++;
    }
  }

  contextResources() {
    // The source material is borrowed, but may hold a pre-fusion/fallback GL
    // program while off-scene. The context collector deduplicates shared
    // materials; ordinary retirement must NEVER dispose this borrowed owner.
    return [...this.records.values()].flatMap(r => [r.texture, r.material, r.sourceMaterial].filter(Boolean));
  }

  dispose() {
    for (const mesh of this.records.keys()) this.release(mesh);
    this.backend?.dispose();
    this.disposed = true;
  }
}
