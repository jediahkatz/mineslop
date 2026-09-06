// Each record has four attributes and one index. Updating a record never walks
// unrelated owners; CPU backing and input GPU attribute identities have separate
// refcounts (two views share CPU storage, but upload separate GPU ranges).
export class WaterFusionLedger {
  constructor() {
    this.records = new Map();
    this.cpu = new Map();
    this.input = new Map();
    this.listeners = new Set();
    this.cpuBytes = this.inputBytes = 0;
    this.totals = { reserveCpu: 0, gpu: 0, allocatedGpu: 0, staging: 0, metadata: 0, draws: 0 };
  }
  refs(map, objects, direction, field, size) {
    for (const object of objects) {
      let entry = map.get(object);
      if (!entry) {
        entry = { refs: 0, bytes: size(object) };
        map.set(object, entry);
        this[field] += entry.bytes;
      }
      entry.refs += direction;
      // BufferAttribute.array may be replaced before stale work is cancelled.
      // Release the amount actually charged, not its now-mutated view's size.
      if (!entry.refs) { this[field] -= entry.bytes; map.delete(object); }
    }
  }
  contribution(r) {
    const cpu = new Set(), input = new Set();
    let reserveCpu = 0, staging = 0;
    if (!r.published) {
      for (const a of [...(r.plan.attributes ?? []), r.plan.index].filter(Boolean)) {
        cpu.add(a.array.buffer); input.add(a);
      }
      reserveCpu = (r.data ? 0 : r.plan.textureBytes) + (r.metadata ? 0 : r.plan.metadataBytes);
      staging = r.plan.textureBytes + r.plan.metadataBytes;
    }
    if (r.data) cpu.add(r.data.buffer);
    if (r.metadata) cpu.add(r.metadata.buffer);
    if (r.indices) cpu.add(r.indices.buffer);
    // Publication changes mode before retiring the previous GPU payload.
    // A validator/dispose callback in that interval must still reserve BOTH.
    const fused = r.mode !== "original" || (r.published && r.target === "fused") || r.textureAllocated;
    const original = r.mode === "original" || (r.published && r.target === "original") || r.vbo;
    const gpu = r.plan.indexBytes + (fused ? r.plan.textureBytes : 0) + (original ? r.plan.vboBytes : 0);
    return { cpu, input, reserveCpu, staging, gpu,
      allocatedGpu: (r.textureAllocated ? r.plan.textureBytes : 0) +
        (r.indexBuffer ? r.plan.indexBytes : 0) + (r.vbo ? r.plan.vboBytes : 0),
      metadata: r.metadata?.byteLength ?? 0,
      draws: this.drawsFor(r) };
  }
  /** Same authoritative reservation with a projected attachment, without
   * mutating actual scene membership or crediting an unperformed removal. */
  drawsFor(r, attached = r.attached) {
    const count = Math.max(0, Math.min(r.indices?.length ?? 0, r.range.start + r.range.count) - r.range.start);
    return count >= 3 && attached ? !r.published || r.mode === "original" || r.target === "original" ? 2 : 1 : 0;
  }
  apply(c, direction) {
    this.refs(this.cpu, c.cpu, direction, "cpuBytes", b => b.byteLength);
    this.refs(this.input, c.input, direction, "inputBytes", a => a.array.byteLength);
    for (const key of Object.keys(this.totals)) this.totals[key] += direction * c[key];
  }
  add(r) {
    this.records.set(r, null);
    // Backend allocation/reset assignments participate too, including failures
    // and callback reads made before a transfer returns to the scheduler.
    for (const name of ["data", "metadata", "indices", "mode", "target", "published",
      "textureAllocated", "indexBuffer", "vbo", "attached", "ready", "phase", "error", "installed"]) {
      let value = r[name];
      Object.defineProperty(r, name, { enumerable: true, configurable: true,
        get: () => value, set: next => { value = next; this.update(r); } });
    }
    const rangeDescriptors = Object.getOwnPropertyDescriptors(r.range);
    for (const name of ["start", "count"]) {
      let value = r.range[name];
      Object.defineProperty(r.range, name, { enumerable: true, configurable: true,
        get: () => value, set: next => { value = next; this.update(r); } });
    }
    r.unwatchRange = () => {
      for (const name of ["start", "count"])
        Object.defineProperty(r.range, name, { ...rangeDescriptors[name], value: r.range[name] });
    };
    this.update(r);
  }
  update(r) {
    if (!this.records.has(r)) return;
    const old = this.records.get(r);
    if (old) this.apply(old, -1);
    const next = this.contribution(r);
    this.apply(next, 1);
    this.records.set(r, next);
    for (const listener of this.listeners) listener(r, old, next);
  }
  remove(r) {
    const old = this.records.get(r);
    if (!old) return;
    this.apply(old, -1);
    this.records.delete(r);
    for (const listener of this.listeners) listener(r, old, null);
    r.unwatchRange?.();
    r.unwatchRange = null;
    // Retained diagnostic records must not retain the whole owner's ledger.
    for (const name of ["data", "metadata", "indices", "mode", "target", "published",
      "textureAllocated", "indexBuffer", "vbo", "attached", "ready", "phase", "error", "installed"])
      Object.defineProperty(r, name, { value: r[name], writable: true, configurable: true, enumerable: true });
  }
  /** Borrowed immutable-by-contract contribution; consumers must not mutate its
   * sets. Observers run after refcounts/totals commit and must not mutate core. */
  recordContribution(record) { return this.records.get(record) ?? null; }
  inputBytesFor(attribute) { return this.input.get(attribute)?.bytes ?? 0; }
  observe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  resources(sources, pending) {
    const t = this.totals;
    return { allocatedCpuBytes: this.cpuBytes, reservedCpuBytes: this.cpuBytes + t.reserveCpu,
      reservedGpuBytes: t.gpu + this.inputBytes, allocatedOwnedGpuBytes: t.allocatedGpu,
      retainedInputGpuBytes: this.inputBytes, stagingBytes: t.staging, reservedDrawCalls: t.draws,
      metadataBytes: t.metadata, sources, pending, jsAndDriverHeapMeasured: false };
  }
}

// Object3D does not bubble ancestor attachment events. Subscribe to this
// source's ancestry, not an owner-wide scan. A subtree mutation updates only
// affected records at mutation time, never all records inside fits()/step().
export function watchWaterAttachment(r, enabled) {
  let ancestors = [];
  const changed = () => {
    for (const node of ancestors) {
      node.removeEventListener("added", changed);
      node.removeEventListener("removed", changed);
    }
    ancestors = [];
    let attached = !enabled;
    if (enabled) for (let node = r.mesh; node; node = node.parent) {
      ancestors.push(node);
      node.addEventListener("added", changed);
      node.addEventListener("removed", changed);
      attached ||= node.isScene === true;
    }
    r.attached = attached;
  };
  changed();
  return () => {
    for (const node of ancestors) {
      node.removeEventListener("added", changed);
      node.removeEventListener("removed", changed);
    }
    ancestors = [];
  };
}
