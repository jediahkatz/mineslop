import { geometryBuffers, meshSubmissionCount } from "./regional-section-pages.js";

/** Watch identity changes, not vertex contents. Restorers preserve later owners. */
const fields = new WeakMap();
function watch(object, key, changed) {
  let map = fields.get(object);
  if (!map) { map = new Map(); fields.set(object, map); }
  const existing = map.get(key);
  if (existing) { existing.listeners.add(changed); return () => existing.remove(changed); }
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor && (!descriptor.configurable || descriptor.get || descriptor.set)) return () => {};
  let value = object[key];
  const get = () => value;
  const listeners = new Set([changed]);
  Object.defineProperty(object, key, { configurable: true, enumerable: descriptor?.enumerable ?? true,
    get, set(next) { if (next === value) return; value = next; for (const listener of [...listeners]) listener(); } });
  const remove = listener => {
    listeners.delete(listener);
    if (listeners.size) return;
    map.delete(key);
    if (Object.getOwnPropertyDescriptor(object, key)?.get !== get) return;
    if (descriptor) Object.defineProperty(object, key, { ...descriptor, value });
    else { delete object[key]; if (value !== undefined) object[key] = value; }
  };
  map.set(key, { listeners, remove });
  return () => remove(changed);
}
export { watch as watchWaterHostField };

const geometryEdits = new WeakMap();
function observeGeometryEdits(geometry, changed) {
  let state = geometryEdits.get(geometry);
  if (!state) {
    state = { listeners: new Set(), restore: [] };
    for (const key of ["setAttribute", "deleteAttribute", "setDrawRange"]) {
      const descriptor = Object.getOwnPropertyDescriptor(geometry, key), method = geometry[key];
      const wrapped = function(...args) {
        const result = method.apply(this, args);
        for (const listener of [...state.listeners]) listener();
        return result;
      };
      geometry[key] = wrapped;
      state.restore.push(() => {
        if (geometry[key] !== wrapped) return;
        if (descriptor) Object.defineProperty(geometry, key, descriptor); else delete geometry[key];
      });
    }
    geometryEdits.set(geometry, state);
  }
  state.listeners.add(changed);
  return () => {
    state.listeners.delete(changed);
    if (!state.listeners.size) { state.restore.forEach(stop => stop()); geometryEdits.delete(geometry); }
  };
}

class BackingCounts {
  constructor(size = buffer => buffer.byteLength) {
    this.size = size; this.refs = new Map(); this.bytes = 0; this.ready = 0; this.pending = 0;
  }
  change(buffers, role, direction) {
    for (const buffer of buffers) {
      let r = this.refs.get(buffer);
      if (!r) { r = { live: 0, ready: 0, pending: 0, bytes: this.size(buffer) }; this.refs.set(buffer, r); }
      this.account(r, -1);
      if (direction > 0) r.bytes = Math.max(r.bytes, this.size(buffer));
      r[role] += direction;
      this.account(r, 1);
      if (!r.live && !r.ready && !r.pending) this.refs.delete(buffer);
    }
  }
  account(r, sign) {
    if (r.live || r.ready || r.pending) this.bytes += sign * r.bytes;
    if (!r.live) {
      if (r.pending) this.pending += sign * r.bytes;
      else if (r.ready) this.ready += sign * r.bytes;
    }
  }
}

/** Incremental external ownership, not a cached total-minus-water census.
 * Mutations update only their own geometry/job/contribution. fits() reads O(1)
 * totals; a reentrant callback sees mutations synchronously.
 *
 * Terrain ownership is observed at the chunks/regions/jobs maps and their
 * Object3D child events. Geometry/material identity changes are observed too.
 * Scheduler scratch counters are synchronized around each step; structural
 * exchanges close callback admission until old storage is actually retired.
 */
export class SectionWaterResources {
  constructor(host) {
    this.host = host;
    this.cpu = new BackingCounts();
    // Three caches GPU buffers by attribute/interleaved-storage identity, NOT
    // by ArrayBuffer identity. Two overlapping CPU views still upload twice.
    this.gpu = new BackingCounts(attribute => attribute.array.byteLength);
    this.core = new Map(); this.sourceRecords = new Map(); this.scenes = new Map(); this.jobs = new Map();
    this.roots = new Map(); this.restorers = [];
    this.externalDraws = 0; this.unready = 0;
    this.invalidMeshes = 0;
    this.reservedPages = 0; this.snapshots = 0; this.pendingSnapshots = 0;
    this.jobReservations = 0; this.writers = 0;
    const g = host.renderer;
    g.sectionRegions ??= new Map(); g.sectionJobs ??= new Map();
    this.maps = { chunks: g.chunks, sectionRegions: g.sectionRegions, sectionJobs: g.sectionJobs };
    this.observeMap(g.chunks, value => this.trackRoot(value), value => this.untrackRoot(value));
    this.observeMap(g.sectionRegions, value => this.trackRoot(value), value => this.untrackRoot(value));
    this.observeMap(g.sectionJobs,
      value => { if (value !== this.movingJob) this.trackJob(value); },
      value => { if (value !== this.movingJob) this.untrackJob(value); });
    this.stopCore = host.owner.ledger.observe((r, previous, next) => this.coreChanged(r, next));
  }

  rotateJob(key, job) {
    this.movingJob = job;
    try { this.host.renderer.sectionJobs.delete(key); this.host.renderer.sectionJobs.set(key, job); }
    finally { this.movingJob = null; }
  }

  mutation(callback) {
    this.mutationDepth = (this.mutationDepth ?? 0) + 1;
    try { return callback(); } finally { this.mutationDepth--; }
  }

  observeMap(map, add, remove) {
    const set = map.set, del = map.delete, clear = map.clear;
    map.set = function(key, value) {
      const old = this.get(key);
      if (old !== value) { if (old) remove(old); set.call(this, key, value); add(value); }
      return this;
    };
    map.delete = function(key) { const value = this.get(key); if (value) remove(value); return del.call(this, key); };
    map.clear = function() { for (const value of this.values()) remove(value); return clear.call(this); };
    this.restorers.push(() => { map.set = set; map.delete = del; map.clear = clear; });
    for (const value of map.values()) add(value);
  }

  geometry(geometry, role, gpu, changed = () => {}) {
    let buffers = new Set(), attributes = new Set(), stops = [], stopped = false;
    const refresh = () => {
      if (stopped) return;
      this.cpu.change(buffers, role, -1);
      if (gpu) this.gpu.change(attributes, "live", -1);
      for (const stop of stops) stop();
      buffers = geometryBuffers(geometry);
      attributes = new Set([...Object.values(geometry.attributes), geometry.index]
        .filter(Boolean).map(a => a.isInterleavedBufferAttribute ? a.data : a).filter(a => a.array));
      for (const a of attributes) buffers.add(a.array.buffer);
      this.cpu.change(buffers, role, 1);
      if (gpu) this.gpu.change(attributes, "live", 1);
      stops = [];
      // One source has a fixed, small attribute set. Shared views are counted
      // by backing identity; attribute replacement must not retain old bytes.
      for (const a of [...Object.values(geometry.attributes), geometry.index]) {
        if (!a) continue;
        const storage = a.isInterleavedBufferAttribute ? a.data : a;
        stops.push(watch(storage, "array", refresh));
      }
      changed();
    };
    const top = [watch(geometry, "attributes", refresh), watch(geometry, "index", refresh),
      observeGeometryEdits(geometry, refresh)];
    refresh();
    return () => {
      if (stopped) return;
      stopped = true;
      for (const stop of [...top, ...stops]) stop();
      this.cpu.change(buffers, role, -1);
      if (gpu) this.gpu.change(attributes, "live", -1);
    };
  }

  trackRoot(root) {
    if (this.roots.has(root)) return;
    const nodes = new Map();
    const add = node => {
      if (nodes.has(node)) return;
      const added = event => add(event.child), removed = event => remove(event.child);
      node.addEventListener("childadded", added); node.addEventListener("childremoved", removed);
      nodes.set(node, () => {
        node.removeEventListener("childadded", added); node.removeEventListener("childremoved", removed);
      });
      if (node.isMesh && !node.userData.sectionSource) this.trackMesh(node);
      for (const child of node.children) add(child);
    };
    const remove = node => {
      for (const child of node.children) remove(child);
      if (node.isMesh) this.untrackMesh(node);
      nodes.get(node)?.(); nodes.delete(node);
    };
    add(root); this.roots.set(root, () => remove(root));
  }
  untrackRoot(root) { this.roots.get(root)?.(); this.roots.delete(root); }

  trackMesh(mesh) {
    if (this.scenes.has(mesh)) return;
    const state = { stops: [], payload: null, draws: 0, invalid: false, updating: false };
    const refresh = () => {
      if (state.updating) return;
      state.updating = true;
      const previousDraws = state.draws;
      state.payload?.(); state.payload = null;
      this.externalDraws -= state.draws; state.draws = 0;
      this.invalidMeshes -= Number(state.invalid);
      const record = this.host.owner.records.get(mesh) ?? this.sourceRecords.get(mesh);
      const ownsGeometry = record && (mesh.geometry === record.drawGeometry ||
        (!record.installed && mesh.geometry === record.plan.geometry));
      state.invalid = !!record?.installed &&
        (mesh.geometry !== record.drawGeometry || mesh.material !== record.renderMaterial);
      this.invalidMeshes += Number(state.invalid);
      if (!ownsGeometry && mesh.geometry?.isBufferGeometry) {
        state.payload = this.geometry(mesh.geometry, "live", true, refresh);
        const count = mesh.geometry.index?.count ?? mesh.geometry.attributes.position?.count ?? 0;
        state.draws = count > 0 ? meshSubmissionCount(mesh) : 0;
        this.externalDraws += state.draws;
      }
      state.updating = false;
      if (previousDraws !== state.draws) this.host.attachments?.invalidate();
    };
    state.refresh = refresh;
    state.stops = [watch(mesh, "geometry", refresh), watch(mesh, "material", refresh)];
    this.scenes.set(mesh, state); refresh();
  }
  untrackMesh(mesh) {
    const s = this.scenes.get(mesh);
    if (!s) return;
    s.payload?.(); s.stops.forEach(stop => stop()); this.externalDraws -= s.draws;
    if (s.draws) this.host.attachments?.invalidate();
    this.invalidMeshes -= Number(s.invalid);
    this.scenes.delete(mesh);
  }

  coreChanged(record, contribution) {
    const old = this.core.get(record);
    const projected = contribution ? this.host.owner.ledger.drawsFor(record, true) : 0;
    const drawable = !!record.ready && !record.phase && !record.error;
    if ((old?.draws ?? 0) !== (contribution?.draws ?? 0) ||
        (old?.projected ?? 0) !== projected || old?.drawable !== drawable)
      this.host.attachments?.invalidate();
    if (old) { this.cpu.change(old.cpu, old.role, -1); this.unready -= Number(old.unready); }
    if (contribution) {
      if (!this.sourceRecords.has(record.mesh) || this.host.owner.records.get(record.mesh) === record)
        this.sourceRecords.set(record.mesh, record);
      const role = this.host.entries.get(record.mesh)?.installed && record.published ? "live" : "ready";
      const unready = !!record.attached && (!record.ready || !!record.phase || !!record.error ||
        !record.indexBuffer || (record.mode === "original" ? !record.vbo : !record.textureAllocated));
      this.cpu.change(contribution.cpu, role, 1);
      this.unready += Number(unready);
      this.core.set(record, { cpu: contribution.cpu, role, unready, projected, drawable, draws: contribution.draws });
    } else {
      this.core.delete(record);
      if (this.sourceRecords.get(record.mesh) === record) this.sourceRecords.delete(record.mesh);
    }
    this.scenes.get(record.mesh)?.refresh();
    this.host.visibility?.update(this.host.entries.get(record.mesh));
  }
  installed(mesh) {
    const r = this.host.owner.records.get(mesh);
    if (r) this.coreChanged(r, this.host.owner.ledger.recordContribution(r));
  }

  trackJob(job) {
    if (this.jobs.has(job)) { this.syncJob(job); return; }
    const state = { payloads: new Map(), stops: [], readySnapshot: 0, pendingSnapshot: 0,
      reserve: 0, pages: 0, writer: 0, syncing: false };
    this.jobs.set(job, state);
    for (const key of ["status", "result", "mesher", "snapshotBytes", "pagePlan", "waterGroup"])
      state.stops.push(watch(job, key, () => this.syncJob(job)));
    this.syncJob(job);
  }
  syncJob(job) {
    const s = this.jobs.get(job);
    if (!s || s.syncing) return;
    s.syncing = true;
    const geometries = new Set();
    for (const part of job.result?.parts ?? job.mesher?.context.parts ?? [])
      for (const geometry of Object.values(part)) if (geometry) geometries.add(geometry);
    for (const mesh of job.waterGroup?.children ?? []) {
      // Core shells own no ordinary payload; their canonical contribution is
      // already tracked above. Original result geometries remain observable.
      if (!this.host.owner.contains(mesh)) geometries.add(mesh.geometry);
    }
    const role = job.done ? "ready" : "pending";
    for (const [geometry, p] of s.payloads)
      if (!geometries.has(geometry) || p.role !== role) { p.stop(); s.payloads.delete(geometry); }
    for (const geometry of geometries)
      if (!s.payloads.has(geometry)) s.payloads.set(geometry, { role, stop: this.geometry(geometry, role, false) });
    this.snapshots -= s.readySnapshot; this.pendingSnapshots -= s.pendingSnapshot;
    this.jobReservations -= s.reserve; this.reservedPages -= s.pages; this.writers -= s.writer;
    s.readySnapshot = job.done ? job.snapshotBytes ?? 0 : 0;
    s.pendingSnapshot = job.done ? 0 : job.snapshotBytes ?? 0;
    s.reserve = job.done ? 0 : job.limits.maxTotalBytes * 2 + 256 * 1024 + (job.snapshotBytes ?? 0);
    s.pages = job.pagePlan?.stagingBytes ?? 0;
    s.writer = Number(!job.done || job.bytes > 0);
    this.snapshots += s.readySnapshot; this.pendingSnapshots += s.pendingSnapshot;
    this.jobReservations += s.reserve; this.reservedPages += s.pages; this.writers += s.writer;
    s.syncing = false;
  }
  untrackJob(job) {
    this.host.attachments?.release(job);
    const s = this.jobs.get(job);
    if (!s) return;
    s.stops.forEach(stop => stop()); for (const p of s.payloads.values()) p.stop();
    this.snapshots -= s.readySnapshot; this.pendingSnapshots -= s.pendingSnapshot;
    this.jobReservations -= s.reserve; this.reservedPages -= s.pages; this.writers -= s.writer;
    this.jobs.delete(job);
  }

  external() {
    // Scene/page exchanges retire allocations in multiple synchronous steps.
    // Callback admission is closed until the host commits that transaction.
    // Core-only transitions remain observable and use fresh contributions.
    const g = this.host.renderer;
    if (this.mutationDepth || g.chunks !== this.maps.chunks || g.sectionRegions !== this.maps.sectionRegions ||
        g.sectionJobs !== this.maps.sectionJobs) return { cpuBytes: Infinity, gpuBytes: Infinity,
      stagingBytes: Infinity, drawCalls: Infinity };
    const own = this.host.owner.resources();
    const palette = g.geometryPalette?.resources();
    const paletteUpload = Math.max(palette?.pendingUploadBytes ?? 0, this.writers ? palette?.gpuBytes ?? 0 : 0);
    const pages = this.reservedPages + (g.sectionCompaction?.plan.stagingBytes ?? 0);
    const future = own.reservedCpuBytes - own.allocatedCpuBytes;
    const staging = this.cpu.ready + this.snapshots +
      Math.max(this.cpu.pending + this.pendingSnapshots, this.jobReservations) + pages + paletteUpload + future;
    const cpu = this.cpu.bytes + (palette?.cpuBytes ?? 0) +
      (staging - this.cpu.ready - this.cpu.pending);
    return {
      cpuBytes: Math.max(0, cpu - own.reservedCpuBytes),
      gpuBytes: this.gpu.bytes + (palette?.gpuBytes ?? 0) + pages,
      stagingBytes: Math.max(0, staging - own.stagingBytes),
      drawCalls: this.externalDraws + (this.host.attachments?.reserved ?? 0),
    };
  }
  dispose() {
    this.stopCore();
    for (const root of [...this.roots.keys()]) this.untrackRoot(root);
    for (const job of [...this.jobs.keys()]) this.untrackJob(job);
    this.restorers.forEach(stop => stop());
  }
}
