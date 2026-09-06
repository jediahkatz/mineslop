import { meshSubmissionCount } from "./regional-section-pages.js";

/** Positive net reservations never credit outgoing geometry before removal.
 * An epoch invalidates all outstanding plans in O(1), including reentrant
 * ledger changes. Every yielded plan must reserve again before committing. */
export class SectionWaterAttachments {
  constructor(host) { this.host = host; this.epoch = 0; this.reserved = 0; this.tokens = new Map(); }
  invalidate() { this.epoch++; this.reserved = 0; }
  release(job) {
    const token = this.tokens.get(job);
    if (token?.epoch === this.epoch) this.reserved -= token.amount;
    this.tokens.delete(job);
  }
  draws(mesh, attached = true) {
    const r = this.host.owner.records.get(mesh);
    if (r) return this.host.owner.ledger.drawsFor(r, attached);
    const geometry = mesh.geometry, range = geometry.drawRange;
    const count = geometry.index?.count ?? geometry.attributes.position?.count ?? 0;
    return Math.min(count, range.start + range.count) - Math.max(0, range.start) >= 3 ? meshSubmissionCount(mesh) : 0;
  }
  reserve(job) {
    this.release(job);
    if (this.host.accounting.mutationDepth || this.host.refreshPending) return false;
    const { pagePlan: plan } = job;
    if (!plan || !job.current()) return false;
    const region = plan.column;
    let outgoing = region.userData.pages.length, incoming = plan.pages.length;
    for (const section of region.userData.sections.values())
      for (const mesh of section.group.children)
        if (!mesh.userData.sectionSource) outgoing += this.draws(mesh);
    for (const mesh of plan.transparentMeshes) incoming += this.draws(mesh);
    const amount = Math.max(0, incoming - outgoing);
    const base = this.host.accounting.external().drawCalls + this.host.owner.resources().reservedDrawCalls;
    if (base + amount > this.host.owner.limits.maxDrawCalls) return false;
    this.tokens.set(job, { epoch: this.epoch, amount, plan, revision: plan.revision });
    this.reserved += amount;
    return true;
  }
  valid(job) {
    const t = this.tokens.get(job), g = this.host.renderer;
    return !!t && t.epoch === this.epoch && t.plan === job.pagePlan &&
      t.plan.column.userData.pageRevision === t.revision && job.world === g.world && job.current() &&
      g.sectionJobs.get(`${job.stamp.cx},${job.stamp.cz},${job.stamp.sy}`) === job &&
      this.host.accounting.external().drawCalls + this.host.owner.resources().reservedDrawCalls <=
        this.host.owner.limits.maxDrawCalls;
  }
  commit(job, run, deadline) {
    if (performance.now() >= deadline || !this.valid(job)) return false;
    const g = this.host.renderer, plan = job.pagePlan, region = plan.column;
    const key = `${job.stamp.cx},${job.stamp.cz}`, column = g.chunks.get(key);
    const oldSection = column?.userData.sections.get(job.stamp.sy);
    const saved = { ...region.userData, sections: new Map(region.userData.sections) };
    const bindings = plan.bindings;
    const views = bindings.map(({ source }) => ({ source, attributes: source.geometry.attributes,
      index: source.geometry.index, palette: source.geometry.userData.colorPalette, range: source.userData.canonicalRange }));
    const incoming = new Set(plan.pages.map(p => p.mesh));
    const obsolete = region.userData.pages.filter(mesh => !incoming.has(mesh));
    const leases = [], retire = [];
    let committed = false;
    this.release(job);
    return this.host.accounting.mutation(() => {
      try {
        for (const mesh of obsolete) {
          leases.push(this.host.accounting.geometry(mesh.geometry, "live", true));
          region.remove(mesh);
        }
        if (oldSection) {
          for (const mesh of oldSection.group.children)
            if (!mesh.userData.sectionSource && !this.host.owner.contains(mesh))
              leases.push(this.host.accounting.geometry(mesh.geometry, "live", true));
          column.remove(oldSection.group);
        }
        job.waterCommit = {
          deferRetire: callback => retire.push(callback),
          validate: () => job.current() && job.world === g.world &&
            region.userData.pageRevision === plan.revision,
        };
        committed = run();
        return committed;
      } finally {
        delete job.waterCommit;
        if (!committed) {
          plan.group.removeFromParent();
          for (const page of plan.pages) if (!saved.pages.includes(page.mesh)) page.mesh.removeFromParent();
          Object.assign(region.userData, saved);
          for (const view of views) {
            view.source.geometry.attributes = view.attributes; view.source.geometry.index = view.index;
            view.source.geometry.userData.colorPalette = view.palette;
            view.source.userData.canonicalRange = view.range;
          }
          plan.bindings = bindings; plan.transferred = false;
          for (const mesh of saved.pages) if (mesh.parent !== region) region.add(mesh);
          if (oldSection) {
            column.userData.sections.set(job.stamp.sy, oldSection);
            column.add(oldSection.group);
          } else g.chunks.get(key)?.userData.sections.delete(job.stamp.sy);
          for (const section of saved.sections.values()) {
            const owner = section.group.parent;
            if (owner) { owner.userData.pages = saved.pages; owner.userData.sectionRanges = saved.sectionRanges; }
          }
          for (const mesh of plan.group.children) {
            const entry = this.host.entries.get(mesh);
            if (entry) {
              entry.installed = false; entry.job = job;
              this.host.accounting.installed(mesh); this.host.visibility.update(entry);
            }
          }
        }
        try { if (committed) for (const callback of retire) callback(); }
        finally { leases.forEach(release => release()); }
      }
    });
  }
}
