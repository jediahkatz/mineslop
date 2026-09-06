import { WaterFusionOwner, waterFusionBudget, WATER_FUSION_LIMITS } from "./water-fusion.js";
import { geometryEpoch } from "./geometry-world.js";
import { waterFusionCovered, waterFusionDecoder } from "./water-fusion-geometry.js";
import { waterMaterialState } from "./water-fusion-material.js";
import { SectionWaterResources, watchWaterHostField } from "./section-water-resources.js";
import { SectionWaterVisibility } from "./section-water-visibility.js";
import { SectionWaterAttachments } from "./section-water-attachments.js";
import { SectionWaterReclaim } from "./section-water-reclaim.js";

/** Section transactions own membership; the water core owns canonical payloads.
 * Detached conversion consumes the SAME scheduler quotas and storage admission,
 * but contributes no scene submissions until final section admission succeeds.
 */
export class SectionWaterFusion {
  constructor(renderer, limits) {
    this.renderer = renderer;
    this.entries = new Map();
    this.dirty = new Set();
    this.refreshRemaining = 0;
    this.materialGeneration = 0;
    this.materialState = waterMaterialState(renderer.materials.water);
    this.material = renderer.materials.water;
    this.reviewedHooks = new Set([this.material.onBeforeCompile]);
    this.owner = new WaterFusionOwner({
      enabled: true, context: renderer.world, drawsWhenAttached: true,
      limits,
      ...(renderer.waterFusionBackendFactory ? { backendFactory: renderer.waterFusionBackendFactory } : {}),
      externalResources: () => this.accounting.external(),
    });
    this.accounting = new SectionWaterResources(this);
    this.visibility = new SectionWaterVisibility(this);
    this.attachments = new SectionWaterAttachments(this);
    this.reclaim = new SectionWaterReclaim(this);
    renderer.contextResourceOwners?.add(this);
  }

  configure(limits) {
    const previousDrawCap = this.owner.limits.maxDrawCalls;
    for (const [key, cap] of Object.entries(WATER_FUSION_LIMITS))
      this.owner.limits[key] = Math.min(cap, limits[key] ?? cap);
    if (this.owner.context !== this.renderer.world) this.owner.setContext(this.renderer.world);
    if (previousDrawCap !== this.owner.limits.maxDrawCalls) this.attachments.invalidate();
  }

  current(entry) {
    const { renderer: g } = this, { stamp, world, group } = entry;
    if (world !== g.world || stamp.epoch !== geometryEpoch(g.world) ||
        stamp.dimension !== g.world.dimension || stamp.generator !== g.world.generator) return false;
    const key = `${stamp.cx},${stamp.cz}`, chunk = g.world.chunks.get(key);
    const original = stamp.neighbors.find(n => n.key === key);
    if (!chunk || chunk !== original.chunk || chunk.incarnation !== original.incarnation) return false;
    const distance = Math.max(Math.abs(stamp.cx - Math.floor(g.camera.position.x / 16)),
      Math.abs(stamp.cz - Math.floor(g.camera.position.z / 16)));
    if (entry.installed) {
      // An edited section's old snapshot stays drawable until its replacement
      // commits. Coverage separately rejects its stale revision.
      return distance <= g.renderRadius + 1 && g.chunks.get(key)?.userData.sections.get(stamp.sy)?.group === group;
    }
    return distance <= g.renderRadius && entry.job.current() &&
      g.sectionJobs.get(`${key},${stamp.sy}`) === entry.job;
  }

  prepare(job) {
    const group = job.waterGroup;
    let ready = true;
    for (const mesh of group.children) {
      if (mesh.userData.batch !== "water") continue;
      let entry = this.entries.get(mesh);
      if (!entry) {
        entry = { mesh, group, job, world: job.world, stamp: job.stamp, installed: false,
          materialGeneration: this.materialGeneration };
        this.entries.set(mesh, entry);
        mesh.userData.sectionWater = entry;
        entry.host = this;
        entry.stops = ["castShadow", "receiveShadow", "customDepthMaterial", "customDistanceMaterial"]
          .map(key => watchWaterHostField(mesh, key, () => {
            this.dirty.add(entry); this.attachments.invalidate(); this.visibility.update(entry);
          }));
        this.visibility.add(entry);
      }
      const diagnostic = this.owner.status(mesh);
      if (!this.owner.contains(mesh) && diagnostic?.state === "cancelled") {
        if (diagnostic.originalPathPreserved !== true) {
          job.waterInvalid = true;
          return false;
        }
        entry.fallback = diagnostic.reason || "cancelled-original";
      }
      if (!this.owner.contains(mesh) && !entry.fallback) {
        const result = this.owner.request(mesh, {
          exclusiveGeometry: true, current: () => this.current(entry),
          reviewedHooks: this.reviewedHooks,
        });
        if (result.state === "unsupported") entry.fallback = result.reason;
        else if (result.state !== "pending") {
          ready = false;
          if (result.state === "blocked" && this.current(entry)) this.reclaim.request(job, mesh);
        }
      }
      if (this.owner.contains(mesh) && !this.owner.status(mesh).ready) {
        ready = false;
        if (this.owner.status(mesh).error === "reservation-blocked") this.reclaim.request(job, mesh);
      }
      if (!this.owner.contains(mesh) && this.owner.status(mesh)?.state === "cancelled") {
        if (this.owner.status(mesh).originalPathPreserved !== true) {
          job.waterInvalid = true;
          return false;
        }
        entry.fallback = this.owner.status(mesh).reason || "cancelled-original";
      }
    }
    for (const mesh of group.children) {
      const entry = this.entries.get(mesh);
      if (entry) this.visibility.update(entry);
    }
    return ready;
  }

  install(group) {
    for (const mesh of group.children) {
      const entry = this.entries.get(mesh);
      if (entry) {
        entry.installed = true; entry.job = null; this.accounting.installed(mesh);
        this.visibility.update(entry);
      }
    }
  }

  release(group) {
    for (const mesh of group?.children ?? []) this.releaseMesh(mesh);
  }

  releaseMesh(mesh) {
    if (!this.entries.has(mesh)) return;
    const entry = this.entries.get(mesh);
    this.visibility.remove(entry);
    this.dirty.delete(entry);
    entry.stops?.forEach(stop => stop());
    this.owner.release(mesh);
    this.entries.delete(mesh);
    delete mesh.userData.sectionWater;
  }

  refresh() {
    const material = this.renderer.materials.water, state = waterMaterialState(material);
    if (material === this.material && state.length === this.materialState.length &&
        state.every((value, i) => value === this.materialState[i])) return;
    this.material = material; this.materialState = state;
    this.materialGeneration++;
    this.attachments.invalidate();
    this.reviewedHooks.clear(); this.reviewedHooks.add(material.onBeforeCompile);
    this.refreshIterator = this.entries.values();
    this.refreshRemaining = this.entries.size;
  }

  get refreshPending() { return this.refreshRemaining > 0 || this.dirty.size > 0; }

  step(limits, started, steps) {
    const g = this.renderer;
    const b = waterFusionBudget({
      bytes: Math.max(0, limits.maxCopyBytesPerSlice - g.meshStats.lastSliceCopyBytes),
      operations: Math.max(0, limits.maxStepsPerSlice - steps),
      milliseconds: Math.max(0, started + limits.maxSliceMs - performance.now()),
    });
    b.deadline = Math.min(b.deadline, started + limits.maxSliceMs);
    const before = b.remainingOperations;
    this.reclaim.step(b);
    // Metadata is work too. Never visit a population in refresh()/render(), or
    // consume a second frame allowance. Preserve one operation for core work.
    while (this.refreshPending && b.remainingOperations > (this.owner.pending.size ? 1 : 0) &&
        performance.now() < b.deadline) {
      let entry;
      if (this.dirty.size) {
        entry = this.dirty.values().next().value; this.dirty.delete(entry);
      } else {
        const next = this.refreshIterator.next();
        this.refreshRemaining--;
        if (next.done) { this.refreshRemaining = 0; break; }
        entry = next.value;
      }
      b.remainingOperations--; b.work.push({ kind: "host-refresh", bytes: 0 });
      if (this.entries.get(entry.mesh) !== entry) continue;
      this.owner.refresh(entry.mesh, { material: this.material, reviewedHooks: this.reviewedHooks });
      entry.materialGeneration = this.materialGeneration;
      if (entry.fallback) entry.mesh.material = this.material;
      this.visibility.update(entry);
    }
    this.owner.step(g.renderer, b);
    g.meshStats.lastSliceCopyBytes += b.usedBytes;
    g.meshStats.waterWork.push(...b.work);
    return before - b.remainingOperations;
  }

  /** Feed the existing identity-deduplicated census, including mesher aliases. */
  resources(cpu, readyBuffers) {
    let liveGpu = 0, stagingGpu = 0, unallocatedCpu = 0, allocatedGpu = 0;
    for (const [mesh, r] of this.owner.records) {
      const contribution = this.owner.ledger.recordContribution(r);
      const installed = this.entries.get(mesh)?.installed === true;
      const target = installed && r.published ? cpu : readyBuffers;
      for (const buffer of contribution.cpu) target.add(buffer);
      unallocatedCpu += contribution.reserveCpu;
      const gpu = contribution.gpu + [...contribution.input]
        .reduce((n, attribute) => n + this.owner.ledger.inputBytesFor(attribute), 0);
      if (installed) liveGpu += gpu; else stagingGpu += gpu;
      allocatedGpu += contribution.allocatedGpu;
    }
    return { liveGpu, stagingGpu, unallocatedCpu, allocatedGpu, externalGpu: this.accounting.gpu.bytes };
  }

  meshBytes(mesh) {
    const r = this.owner.records.get(mesh);
    if (!r) return null;
    return this.owner.ledger.recordContribution(r).gpu;
  }

  canRender() {
    return !this.accounting.mutationDepth && this.visibility.canRender() &&
      !this.owner.backend?.gl.isContextLost();
  }

  covered(mesh) { return waterSectionVisible(mesh); }
  contextResources() { return this.owner.contextResources(); }
  dispose() {
    this.reclaim.dispose();
    this.owner.dispose();
    this.visibility.dispose();
    this.accounting.dispose();
    for (const [mesh, entry] of this.entries) {
      entry.stops?.forEach(stop => stop()); delete mesh.userData.sectionWater;
    }
    this.entries.clear();
    this.dirty.clear();
    this.renderer.contextResourceOwners?.delete(this);
  }
}

export function waterSectionVisible(mesh) {
  const entry = mesh.userData.sectionWater;
  if (!entry) return true;
  const { host, stamp, world } = entry;
  if (entry.materialGeneration !== host.materialGeneration || host.dirty.has(entry)) return false;
  if (!entry.installed || !host.current(entry)) return false;
  for (const neighbor of stamp.neighbors) {
    const chunk = world.chunks.get(neighbor.key);
    if (chunk !== neighbor.chunk || chunk?.incarnation !== neighbor.incarnation) return false;
    if (chunk?.sectionRevisions
      ? neighbor.sections.some(([sy, revision]) => (chunk.sectionRevisions.get(sy) ?? 0) !== revision)
      : chunk?.revision !== neighbor.revision) return false;
  }
  const r = host.owner.records.get(mesh);
  return !r ? !!entry.fallback : !r.phase && !r.error && waterFusionCovered(mesh) && !!r.indexBuffer &&
    (r.mode === "original" ? !!r.vbo : !!r.textureAllocated);
}

export function sectionInspectionGeometry(mesh) {
  // A stale owned record must never fall back to the zero-attribute GPU shell.
  return mesh.userData.waterFusion ? waterFusionDecoder(mesh) : mesh.geometry;
}
