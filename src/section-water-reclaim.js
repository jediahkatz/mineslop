import { planWaterGeometry } from "./water-fusion-geometry.js";
import { invalidateRegionalPlans } from "./regional-section-pages.js";
import { disposeSectionPage } from "./section-pages.js";

const unit = (kind, run = () => {}) => ({ kind, run });

/** Retire actual payloads separately from candidate/metadata visits. Shared
 * page storage is never credited as free: dead hidden ranges remain resident
 * until normal compaction replaces them, without unbudgeted index uploads. */
export class SectionWaterReclaim {
  constructor(host) { this.host = host; this.pressure = null; this.active = null; this.cursor = null; }
  request(job, mesh) {
    if (job.waterGroup.parent || !job.current()) return;
    const plan = this.host.owner.contains(mesh) ? null :
      planWaterGeometry(mesh, this.host.owner.limits.maxCopyBytesPerSlice);
    if (plan?.unsupported) return;
    this.pressure = { job, mesh, plan };
  }
  capacity(job, cpuDeficit, gpuDeficit, stagingDeficit) {
    if (Math.max(cpuDeficit, gpuDeficit, stagingDeficit) <= 0) return;
    const own = this.host.owner.resources(), e = this.host.accounting.external();
    this.pressure = { job, plan: null,
      goalCpu: own.reservedCpuBytes + e.cpuBytes - Math.max(0, cpuDeficit),
      goalGpu: own.reservedGpuBytes + e.gpuBytes - Math.max(0, gpuDeficit),
      goalStaging: own.stagingBytes + e.stagingBytes - Math.max(0, stagingDeficit) };
  }
  fits() {
    const p = this.pressure;
    const g = this.host.renderer;
    if (!p || p.job.world !== g.world || !p.job.current() ||
        g.sectionJobs.get(`${p.job.stamp.cx},${p.job.stamp.cz},${p.job.stamp.sy}`) !== p.job) return true;
    const own = this.host.owner.resources(), e = this.host.accounting.external(), limits = this.host.owner.limits;
    const plan = this.host.owner.contains(p.mesh) ? null : p.plan;
    const cpu = plan ? plan.textureBytes + plan.metadataBytes : 0;
    const gpu = plan ? plan.textureBytes + plan.indexBytes +
      [...plan.attributes, plan.index].reduce((n, a) => n + a.array.byteLength, 0) : 0;
    return own.reservedCpuBytes + e.cpuBytes + cpu <= Math.min(limits.maxCpuBytes, p.goalCpu ?? Infinity) &&
      own.reservedGpuBytes + e.gpuBytes + gpu <= Math.min(limits.maxGpuBytes, p.goalGpu ?? Infinity) &&
      own.stagingBytes + e.stagingBytes + cpu <= Math.min(limits.maxStagingBytes, p.goalStaging ?? Infinity);
  }
  step(budget) {
    const g = this.host.renderer;
    while (budget.remainingOperations > 0 && performance.now() < budget.deadline) {
      if (!this.active) {
        if (this.fits()) { this.pressure = null; break; }
        this.cursor ??= g.chunks.entries();
        budget.remainingOperations--; budget.work.push({ kind: "reclaim-candidate-visit", bytes: 0 });
        const next = this.cursor.next();
        if (next.done) { this.cursor = null; break; }
        const [key, column] = next.value, job = this.pressure.job;
        if ((column.visible && !column.userData.waterRetiringGroups?.size) || key === `${job.stamp.cx},${job.stamp.cz}` ||
            [...g.sectionJobs.values()].some(j => `${j.stamp.cx},${j.stamp.cz}` === key)) continue;
        if (!column.userData.sectionRegion) continue;
        const region = column.userData.sectionRegion;
        this.active = { iterator: this.retire(key, column), key, column, world: g.world,
          region, revision: region.userData.pageRevision };
      }
      if (budget.remainingOperations < 1 || performance.now() >= budget.deadline) break;
      if (this.active.world !== g.world || g.chunks.get(this.active.key) !== this.active.column ||
          this.active.revision !== this.active.region.userData.pageRevision) {
        this.active.iterator.return(); this.active = null; continue;
      }
      const next = this.active.iterator.next();
      if (next.done) { this.active = null; continue; }
      const active = this.active;
      budget.remainingOperations--; budget.work.push({ kind: next.value.kind, bytes: 0 });
      this.host.accounting.mutation(next.value.run);
      if (next.value.kind === "reclaim-plan-invalidation") active.revision++;
    }
  }
  *retire(key, column) {
    const g = this.host.renderer, region = column.userData.sectionRegion;
    const byMesh = new Map();
    try {
      yield unit("reclaim-plan-invalidation", () => {
        invalidateRegionalPlans(g, region);
        region.userData.waterRetirement = true;
        region.userData.pageRevision++;
        column.userData.meshed = false;
        g.sectionQueueLayout = null;
      });
      for (const page of region.userData.pageDescriptors)
        yield unit("reclaim-page-index-visit", () => byMesh.set(page.mesh, page));
      column.userData.waterRetiringGroups ??= new Set();
      for (const group of column.userData.waterRetiringGroups)
        yield* this.retireGroup(column, group, region, byMesh);
      for (const [sy, section] of column.userData.sections) {
        yield unit("reclaim-section-visit");
        if (column.visible || g.chunks.get(key) !== column) break;
        const group = section.group;
        yield unit("reclaim-section-detach", () => {
          // This snapshot is no longer eligible, but all payload ownership is
          // retained until the separately charged release operations below.
          group.visible = false;
          column.userData.waterRetiringGroups.add(group);
          column.userData.sections.delete(sy);
          region.userData.sections.delete(`${key},${sy}`);
          g.world.dirtyChunks.add(key);
        });
        yield* this.retireGroup(column, group, region, byMesh);
      }
      const descriptors = [], pages = [];
      for (const page of region.userData.pageDescriptors) {
        yield unit("reclaim-page-visit");
        const sources = [];
        for (const mesh of page.sources) {
          yield unit("reclaim-page-source-visit");
          if (!mesh.userData.waterRetired) sources.push(mesh);
        }
        yield unit("reclaim-page-membership", () => {
          page.sources = sources;
        });
        if (sources.length) { descriptors.push(page); pages.push(page.mesh); }
        else yield unit("reclaim-page-payload-release", () => {
          // Keep registered storage until disposal has actually completed.
          disposeSectionPage(page.mesh.geometry);
          region.remove(page.mesh);
        });
      }
      yield unit("reclaim-page-list-publication", () => {
        region.userData.pageDescriptors = descriptors;
        region.userData.pages = pages;
      });
      for (const section of region.userData.sections.values()) {
        yield unit("reclaim-survivor-visit", () => {
          const owner = section.group.parent;
          if (owner) owner.userData.pages = pages;
        });
      }
      yield unit("reclaim-column-release", () => {
        if (!column.userData.sections.size && g.chunks.get(key) === column) {
          g.scene.remove(column); g.chunks.delete(key);
        }
        if (!region.userData.sections.size) {
          g.scene.remove(region); g.sectionRegions.delete(region.userData.key);
        }
        g.meshResourceRevision = (g.meshResourceRevision ?? 0) + 1;
        g.sectionQueueLayout = null;
      });
    } finally { delete region.userData.waterRetirement; }
  }
  *retireGroup(column, group, region, byMesh) {
    while (group.children.length) {
      const mesh = group.children[0];
      yield unit("reclaim-source-visit");
      yield unit("reclaim-payload-release", () => {
        const range = region.userData.sectionRanges?.get(mesh);
        if (range) {
          mesh.userData.waterRetired = true;
          const page = byMesh.get(range.mesh);
          const stride = Object.values(range.mesh.geometry.attributes)
            .reduce((n, a) => n + a.itemSize * a.array.BYTES_PER_ELEMENT, 0);
          page.retainedDeadBytes = (page.retainedDeadBytes ?? 0) +
            mesh.geometry.attributes.position.count * stride +
            range.count * range.mesh.geometry.index.array.BYTES_PER_ELEMENT;
          region.userData.sectionRanges.delete(mesh);
        }
        this.host.releaseMesh(mesh);
        if (!mesh.userData.sectionSource) mesh.geometry.dispose();
        mesh.geometry.attributes = {}; mesh.geometry.index = null;
        delete mesh.userData.canonicalRange;
        delete mesh.geometry.userData.colorPalette;
        group.remove(mesh);
      });
    }
    yield unit("reclaim-group-release", () => {
      column.remove(group); column.userData.waterRetiringGroups.delete(group);
    });
  }
  dispose() { this.active?.iterator.return(); this.active = this.pressure = this.cursor = null; }
}
