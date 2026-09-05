import * as THREE from "three";
import { geometryEpoch, geometryWorldSpec } from "./geometry-world.js";
import { BlockLightRevisions } from "./block-light-revisions.js";
import { BLOCK_LIGHT_PALETTE_BYTES, BlockLightTopologyJob } from "./block-light-topology.js";
import { BlockLightSolver, BLOCK_LIGHT_PAGE_CELLS } from "./block-light-solver.js";
import { MAX_RENDER_RADIUS, renderDistanceLayout } from "./render-distance.js";

export const BLOCK_LIGHT_LIMITS = Object.freeze({
  maxRadius: MAX_RENDER_RADIUS, maxHeight: 384, milliseconds: 2,
  scans: 8192, visits: 32768, uploads: 2, publications: 8, atlasWidth: 80,
});
export const BLOCK_LIGHT_GAIN = 1;
const modulo = (x, n) => ((x % n) + n) % n;
const key = (x, z, y) => `${x},${z},${y}`;

/** Render-only static emission. No terrain writes, generation, mesh ownership
 * or gameplay subscriptions. Unchanged pages survive observer/ring movement. */
export class BlockLightField {
  constructor() {
    this.revisions = new BlockLightRevisions();
    this.topology = new Map();
    this.cache = new Map();
    this.waiting = new Map();
    this.targets = [];
    this.nextTarget = 0;
    this.uploadQueue = [];
    this.solver = new BlockLightSolver();
    this.serial = this.age = 0;
    this.disposed = false;
    this.allocate(16, 0);
  }

  allocate(height, radius) {
    const layout = renderDistanceLayout(radius);
    this.texture?.dispose();
    this.validTexture?.dispose();
    this.height = height;
    this.radius = radius;
    this.tiles = layout.tiles;
    this.sections = height / 16;
    this.layerBytes = height * 400 * 4;
    this.data = new Uint8Array(this.layerBytes * this.tiles ** 2);
    this.valid = new Uint8Array(this.sections * this.tiles ** 2);
    this.uploaded = Array(this.valid.length).fill(null);
    this.texture = new THREE.DataArrayTexture(this.data, BLOCK_LIGHT_LIMITS.atlasWidth, height * 5, this.tiles ** 2);
    // Allocate GPU storage without a monolithic cold CPU->GPU data upload.
    // Actual populated layers become dataReady only with bounded layer updates.
    this.texture.source.dataReady = false;
    this.texture.needsUpdate = true;
    this.validTexture = new THREE.DataTexture(this.valid, this.tiles ** 2, this.sections, THREE.RedFormat);
    this.validTexture.needsUpdate = true;
    this.allocationBytes = this.data.byteLength + this.valid.byteLength;
  }

  slot(x, z) {
    return modulo(z, this.tiles) * this.tiles + modulo(x, this.tiles);
  }

  index(x, z, y) {
    return (y - this.spec.minY / 16) * this.tiles ** 2 + this.slot(x, z);
  }

  within(entry, halo = 0) {
    return Math.abs(entry.x - this.cx) <= this.radius + halo &&
      Math.abs(entry.z - this.cz) <= this.radius + halo;
  }

  invalidate(entry) {
    if (!this.within(entry)) return;
    const at = this.index(entry.x, entry.z, entry.y);
    this.valid[at] = 0;
    this.uploaded[at] = null;
  }

  publish(entry, layers) {
    const at = this.index(entry.x, entry.z, entry.y);
    const stamp = `${key(entry.x, entry.z, entry.y)}:${entry.serial}`;
    if (this.uploaded[at] === stamp) return true;
    const slot = this.slot(entry.x, entry.z);
    if (entry.values && !layers.has(slot) && !this.texture.layerUpdates.has(slot) &&
      new Set([...layers, ...this.texture.layerUpdates]).size >= BLOCK_LIGHT_LIMITS.uploads) return false;
    if (entry.values) {
      const offset = slot * this.layerBytes + (entry.y - this.spec.minY / 16) * BLOCK_LIGHT_PAGE_CELLS * 4;
      this.data.set(entry.values, offset);
      layers.add(slot);
    }
    // 127 is verified darkness; stale atlas bytes are never sampled for it.
    this.valid[at] = entry.values ? 255 : 127;
    this.uploaded[at] = stamp;
    return true;
  }

  start(target) {
    this.job = { ...target, sources: [], cursor: 0,
      signature: this.revisions.signature(this.world, target.x, target.z, target.y, 2) };
  }

  advance(budget, layers) {
    const job = this.job;
    while (job.cursor < 27) {
      const i = job.cursor, x = job.x + i % 3 - 1;
      const z = job.z + Math.floor(i / 3) % 3 - 1, y = job.y + Math.floor(i / 9) - 1;
      const id = key(x, z, y);
      if ((this.revisions.tokens.get(id) ?? "0") === "0") {
        job.sources.push(null); job.cursor++; continue;
      }
      let source = this.topology.get(id);
      if (!source) {
        job.builder ??= new BlockLightTopologyJob(this, { x, z, y });
        source = job.builder.step(this, budget);
        if (!source) return;
        if (source.stale) { this.job = null; this.stats.staleJobs++; return; }
        this.topology.set(id, source);
        this.stats.topologyBuilds++;
        job.builder = null;
      }
      job.sources.push(source);
      job.cursor++;
    }
    const hasSources = job.sources.some((entry) => entry?.emitters > 0);
    if (hasSources) {
      if (!job.started) { this.solver.begin(job.sources); job.started = true; }
      if (!this.solver.step(budget, this.stats)) return;
    }
    if (job.signature !== this.revisions.signature(this.world, job.x, job.z, job.y, 2)) {
      this.job = null; this.stats.staleJobs++; return;
    }
    const entry = { x: job.x, z: job.z, y: job.y, serial: ++this.serial,
      values: hasSources && this.solver.lit ? this.solver.values : null };
    this.cache.set(job.key, entry);
    this.waiting.delete(job.key);
    if (!this.publish(entry, layers)) this.uploadQueue.push(entry);
    this.stats.completed++;
    this.job = null;
    this.solver.sources = null;
  }

  refreshQueue(position) {
    for (const [id, entry] of this.topology)
      if (!this.within(entry, 1) || this.revisions.changed(entry.x, entry.z, entry.y, 1)) this.topology.delete(id);
    for (const [id, entry] of this.cache)
      if (!this.within(entry) || this.revisions.changed(entry.x, entry.z, entry.y, 2)) {
        this.cache.delete(id);
        this.invalidate(entry);
      }
    if (this.job && (!this.within(this.job) || this.revisions.changed(this.job.x, this.job.z, this.job.y, 2))) {
      this.job = null; this.stats.staleJobs++;
      this.solver.sources = null;
      this.solver.count = 0;
    }
    const waiting = new Map(), pending = [];
    this.uploadQueue = [];
    this.age++;
    for (let z = this.cz - this.radius; z <= this.cz + this.radius; z++)
      for (let x = this.cx - this.radius; x <= this.cx + this.radius; x++)
        for (let y = this.spec.minY / 16; y < this.spec.maxY / 16; y++) {
          const id = key(x, z, y), at = this.index(x, z, y), cached = this.cache.get(id);
          if (cached) {
            if (this.uploaded[at] !== `${id}:${cached.serial}`) {
              // A wrapped ring slot is unavailable until its new owner is
              // published; bounded uploads must never expose the old owner.
              this.valid[at] = 0; this.uploaded[at] = null;
              this.uploadQueue.push(cached);
            }
            continue;
          }
          this.valid[at] = 0; this.uploaded[at] = null;
          if ((this.revisions.tokens.get(id) ?? "0") === "0") continue;
          const age = this.waiting.get(id) ?? this.age;
          waiting.set(id, age);
          pending.push({ key: id, x, z, y, age,
            distance: (x * 16 + 8 - position.x) ** 2 + (z * 16 + 8 - position.z) ** 2 +
              (y * 16 + 8 - position.y) ** 2 });
        }
    this.waiting = waiting;
    this.targets = pending.sort((a, b) => a.age - b.age || a.distance - b.distance);
    this.nextTarget = 0;
  }

  observeMutation(world, event) {
    if (!this.disposed && world === this.world) this.revisions.observeMutation(world, event);
  }

  update(world, position, radius = 3) {
    if (this.disposed) return;
    const started = performance.now(), spec = geometryWorldSpec(world);
    if (spec.minY % 16 || spec.maxY % 16 || spec.maxY - spec.minY > BLOCK_LIGHT_LIMITS.maxHeight)
      throw new RangeError("Unsupported block-light height");
    radius = Number.isFinite(radius)
      ? Math.max(0, Math.min(BLOCK_LIGHT_LIMITS.maxRadius, Math.floor(radius))) : 0;
    const reset = this.world !== world || this.epoch !== geometryEpoch(world) ||
      this.dimension !== world.dimension || this.version !== world.generatorVersion ||
      this.spec?.minY !== spec.minY || this.spec?.maxY !== spec.maxY;
    if (reset) {
      this.topology.clear(); this.cache.clear(); this.waiting.clear();
      this.job = null;
      this.solver.sources = null;
      this.solver.values = null;
      this.solver.count = 0;
      this.revisions = new BlockLightRevisions();
      this.restoreGPU();
    }
    Object.assign(this, { world, spec, epoch: geometryEpoch(world), dimension: world.dimension,
      version: world.generatorVersion, cx: Math.floor(position.x / 16), cz: Math.floor(position.z / 16) });
    if (this.height !== spec.maxY - spec.minY || radius !== this.radius)
      this.allocate(spec.maxY - spec.minY, radius);
    this.stats = { scans: 0, shapeReads: 0, visits: 0, seedVisits: 0, floodVisits: 0, outputVisits: 0, columnChecks: 0,
      stampChecks: 0, topologyBuilds: 0, completed: 0, staleJobs: 0, queuePeak: 0, uploadBytes: 0, uploadLayers: 0,
      allocationBytes: this.allocationBytes ?? 0 };
    this.allocationBytes = 0;
    const oldValid = this.valid.slice();
    const changed = this.revisions.update(world, this.cx, this.cz, radius, spec, this.stats);
    if (!changed && !this.pending && !this.job && !this.stats.allocationBytes) {
      this.stats.updateMs = performance.now() - started;
      return;
    }
    if (changed) this.refreshQueue(position);
    const layers = new Set();
    while (this.uploadQueue.length && performance.now() - started < BLOCK_LIGHT_LIMITS.milliseconds) {
      if (!this.publish(this.uploadQueue[0], layers)) break;
      this.uploadQueue.shift();
    }
    const budget = {
      scan: () => {
        if (this.stats.scans >= BLOCK_LIGHT_LIMITS.scans ||
          (this.stats.scans % 32 === 0 && performance.now() - started >= BLOCK_LIGHT_LIMITS.milliseconds)) return false;
        this.stats.scans++; return true;
      },
      visit: () => {
        if (this.stats.visits >= BLOCK_LIGHT_LIMITS.visits ||
          (this.stats.visits % 32 === 0 && performance.now() - started >= BLOCK_LIGHT_LIMITS.milliseconds)) return false;
        this.stats.visits++; return true;
      },
    };
    while (this.stats.completed < BLOCK_LIGHT_LIMITS.publications &&
      performance.now() - started < BLOCK_LIGHT_LIMITS.milliseconds) {
      if (!this.job) {
        while (this.nextTarget < this.targets.length && this.cache.has(this.targets[this.nextTarget].key)) this.nextTarget++;
        if (this.nextTarget === this.targets.length) break;
        this.start(this.targets[this.nextTarget++]);
      }
      this.advance(budget, layers);
      if (this.job || this.stats.staleJobs) break;
    }
    for (const slot of layers) this.texture.addLayerUpdate(slot);
    if (layers.size) {
      this.texture.source.dataReady = true;
      this.texture.needsUpdate = true;
    }
    // Invalidation and ring reuse use this small mask immediately; their old
    // full-sized atlas layers need not all upload in the same frame.
    if (reset || this.valid.some((value, i) => value !== oldValid[i])) {
      this.validTexture.needsUpdate = true;
      this.stats.uploadBytes += this.valid.byteLength;
    }
    this.stats.uploadBytes += layers.size * this.layerBytes;
    this.stats.uploadLayers = layers.size;
    this.pending = this.waiting.size + this.uploadQueue.length;
    this.stats.updateMs = performance.now() - started;
  }

  sample(point) {
    if (!this.world || this.disposed) return [0, 0, 0];
    const x = Math.floor(point.x), z = Math.floor(point.z), y = Math.floor(point.y) - this.spec.minY;
    if (y < 0 || y >= this.height) return [0, 0, 0];
    const ownerX = Math.floor(x / 16), ownerZ = Math.floor(z / 16);
    const rx = x - ownerX * 16, rz = z - ownerZ * 16;
    const edgeX = rx < 2 || rx >= 14, edgeZ = rz < 2 || rz >= 14;
    const nx = ownerX + (rx < 2 ? -1 : 1), nz = ownerZ + (rz < 2 ? -1 : 1);
    const columns = [[Math.max(this.cx - this.radius, Math.min(this.cx + this.radius, ownerX)),
      Math.max(this.cz - this.radius, Math.min(this.cz + this.radius, ownerZ))]];
    if (edgeX) columns.push([nx, ownerZ]);
    if (edgeZ) columns.push([ownerX, nz]);
    if (edgeX && edgeZ) columns.push([nx, nz]);
    for (const [cx, cz] of columns) {
      if (!this.within({ x: cx, z: cz })) continue;
      const lx = x - cx * 16 + 2, lz = z - cz * 16 + 2;
      if (lx < 0 || lx >= 20 || lz < 0 || lz >= 20) continue;
      const slot = this.slot(cx, cz), ready = this.valid[Math.floor(y / 16) * this.tiles ** 2 + slot];
      if (!ready) continue;
      // Verified darkness is authoritative; only unavailable pages fall back.
      if (ready !== 255) return [0, 0, 0];
      const at = slot * this.layerBytes + (y * 400 + lz * 20 + lx) * 4;
      return Array.from(this.data.subarray(at, at + 3), (v) => v / 255);
    }
    return [0, 0, 0];
  }

  resources() {
    return { atlasBytes: this.data.byteLength, validityBytes: this.valid.byteLength,
      cacheBytes: [...this.cache.values()].reduce((n, e) => n + (e.values?.byteLength ?? 0), 0),
      topologyBytes: [...this.topology.values()].reduce((n, e) => n + (e.values?.byteLength ?? 0), 0),
      topologySections: this.topology.size, cachedSections: this.cache.size,
      sharedPaletteBytes: BLOCK_LIGHT_PALETTE_BYTES,
      metadataEntries: this.revisions.tokens.size, metadataPrefixBytes: this.revisions.prefix?.byteLength ?? 0,
      semanticEntries: this.revisions.semantic.size,
      targetEntries: this.targets.length, uploadQueue: this.uploadQueue.length,
      scratchBytes: this.solver.resources() + BLOCK_LIGHT_PAGE_CELLS * 4 + 4096 * 4,
      queuedCells: this.solver.count ?? 0, pending: this.pending ?? 0 };
  }

  restoreGPU() {
    this.valid.fill(0);
    this.uploaded.fill(null);
    this.texture.clearLayerUpdates();
    this.texture.source.dataReady = false;
    this.texture.needsUpdate = true;
    this.validTexture.needsUpdate = true;
    this.uploadQueue = [...this.cache.values()];
    this.pending = this.waiting.size + this.uploadQueue.length;
  }

  dispose() {
    this.disposed = true;
    this.texture.dispose(); this.validTexture.dispose();
    this.cache.clear(); this.topology.clear(); this.waiting.clear();
    this.revisions = new BlockLightRevisions();
    this.job = null; this.world = null;
    this.targets = []; this.uploadQueue = [];
    this.solver.sources = null;
    this.solver.values = null;
  }
}
