import { columnLoaded, geometryEpoch, geometryWorldSpec } from "./geometry-world.js";
import { BlockLightRevisions, BLOCK_LIGHT_METADATA_LIMITS } from "./block-light-revisions.js";
import { benignBlockLightChange, BLOCK_LIGHT_MUTATION_CELLS } from "./block-light-mutations.js";
import { BLOCK_LIGHT_PALETTE_BYTES, BlockLightTopologyJob } from "./block-light-topology.js";
import { BlockLightSolver, BLOCK_LIGHT_PAGE_CELLS } from "./block-light-solver.js";
import { BLOCK_PAGE_LAYOUT, LIGHT_MAX_RADIUS, lightLayout } from "./light-page-layout.js";
import { PagedLightStore } from "./paged-light-store.js";
import { blockLightPalette, blockPaletteTexture } from "./block-light-palette.js";

export const BLOCK_LIGHT_LIMITS = Object.freeze({
  maxRadius: LIGHT_MAX_RADIUS, maxHeight: 384, milliseconds: 2,
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
    this.targets = this.waiting;
    this.uploadQueue = [];
    this.solver = new BlockLightSolver();
    this.serial = this.age = 0;
    this.disposed = false;
    this.paletteTexture = blockPaletteTexture();
    this.allocate(16, 0);
  }

  allocate(height, radius) {
    const layout = lightLayout(radius);
    this.store?.dispose();
    this.height = height;
    this.radius = radius;
    this.tiles = layout.tiles;
    this.sections = height / 16;
    this.store = new PagedLightStore(BLOCK_PAGE_LAYOUT, this.tiles ** 2, this.sections);
    this.valid = this.store.mapping;
    this.uploaded = Array(this.valid.length).fill(null);
    this.validTexture = this.store.table;
    this.allocationBytes = this.valid.byteLength + this.store.generations.byteLength;
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
    this.store.invalidate(at);
    this.uploaded[at] = null;
  }

  publish(entry, layers) {
    if (!this.within(entry) || entry.y < this.spec.minY / 16 || entry.y >= this.spec.maxY / 16) return true;
    const at = this.index(entry.x, entry.z, entry.y);
    const stamp = `${key(entry.x, entry.z, entry.y)}:${entry.serial}`;
    if (this.uploaded[at] === stamp) return true;
    // Missing in-world source input must never certify darkness. Changes to
    // the dependency ring invalidate this cached result when input arrives.
    if (!entry.certified) return true;
    const ticket = this.store.claim(at, stamp);
    this.store.publish(ticket, entry.values);
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
      if (!budget.metadata()) return;
      const i = job.cursor, x = job.x + i % 3 - 1;
      const z = job.z + Math.floor(i / 3) % 3 - 1, y = job.y + Math.floor(i / 9) - 1;
      const id = key(x, z, y);
      if (this.revisions.token(this.world, x, z, y) === "0") {
        job.sources.push(null); job.cursor++; continue;
      }
      let source = this.topology.get(id);
      // A bounded lazy eviction may retain a source across a window move.
      // Validate it before reuse even when its old metadata was pruned.
      if (source && source.layout !== this.revisions.layoutVersion) {
        if (source.signature !== this.revisions.signature(this.world, x, z, y, 1)) {
          this.topology.delete(id); source = null;
        } else source.layout = this.revisions.layoutVersion;
      }
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
    const certified = job.sources.every((source, i) => source?.complete ||
      job.y + Math.floor(i / 9) - 1 < this.spec.minY / 16 ||
      job.y + Math.floor(i / 9) - 1 >= this.spec.maxY / 16);
    const entry = { x: job.x, z: job.z, y: job.y, serial: ++this.serial, certified,
      signature: job.signature,
      values: hasSources && this.solver.lit ? blockLightPalette.encode(this.solver.values) : null };
    this.cache.set(job.key, entry);
    this.waiting.delete(job.key);
    if (!this.publish(entry, layers)) this.uploadQueue.push(entry);
    this.stats.completed++;
    this.job = null;
    this.solver.sources = null;
  }

  cancelJob() {
    if (!this.job) return;
    this.stats.staleJobs++;
    this.job = null;
    this.solver.sources = null;
    this.solver.count = 0;
  }

  enqueue(x, z, y) {
    const id = key(x, z, y);
    if (!this.within({ x, z }) || y < this.spec.minY / 16 || y >= this.spec.maxY / 16 ||
      this.cache.has(id) || this.waiting.has(id) || this.job?.key === id ||
      !columnLoaded(this.world, x * 16, z * 16)) return;
    this.waiting.set(id, { key: id, x, z, y });
  }

  *requiredTargets(position) {
    const middle = Math.max(this.spec.minY / 16, Math.min(this.spec.maxY / 16 - 1, Math.floor(position.y / 16)));
    // Lazy near-first enumeration, no full-height list construction or sort.
    for (let ring = 0; ring <= this.radius; ring++)
      for (let z = this.cz - ring; z <= this.cz + ring; z++)
        for (let x = this.cx - ring; x <= this.cx + ring; x++) {
          if (Math.max(Math.abs(x - this.cx), Math.abs(z - this.cz)) !== ring) continue;
          for (let offset = 0; offset < this.sections; offset++)
            for (const y of offset ? [middle - offset, middle + offset] : [middle])
              if (y >= this.spec.minY / 16 && y < this.spec.maxY / 16) yield { x, z, y };
        }
  }

  refreshQueue(position) {
    this.seed = this.requiredTargets(position);
    this.seedRemaining = this.tiles ** 2 * this.sections;
  }

  resetWork(position) {
    this.store.invalidateAll();
    this.uploaded.fill(null);
    this.cache.clear(); this.topology.clear(); this.waiting.clear();
    this.uploadQueue = [];
    this.cacheWork = this.topologyPrune = null;
    this.cancelJob();
    this.refreshQueue(position);
    this.stats.globalInvalidations++;
  }

  resizeWork(position) {
    // Allocation has already made every new GPU handle unavailable. Retain
    // canonical objects, but never bulk-publish them or trust an old ticket.
    this.waiting.clear();
    this.uploadQueue = [];
    this.cancelJob();
    this.cacheWork = this.cache.entries();
    this.topologyPrune = this.topology.entries();
    this.refreshQueue(position);
  }

  advanceCache(started, layers) {
    while (this.cacheWork && this.stats.cacheChecks < BLOCK_LIGHT_METADATA_LIMITS.pruning &&
      this.stats.reused < BLOCK_LIGHT_LIMITS.publications &&
      performance.now() - started < BLOCK_LIGHT_LIMITS.milliseconds) {
      const next = this.cacheWork.next();
      if (next.done) { this.cacheWork = null; break; }
      const [id, entry] = next.value;
      this.stats.cacheChecks++;
      if (!this.within(entry)) { this.cache.delete(id); continue; }
      const at = this.index(entry.x, entry.z, entry.y);
      if (this.uploaded[at] === `${id}:${entry.serial}`) continue;
      this.stats.reused++;
      // Reject metadata-pruning ABA and same-coordinate chunk replacements
      // before the entry can acquire a new store's ticket.
      if (entry.signature !== this.revisions.signature(this.world, entry.x, entry.z, entry.y, 2)) {
        this.cache.delete(id);
        this.invalidate(entry);
        this.enqueue(entry.x, entry.z, entry.y);
        continue;
      }
      this.publish(entry, layers);
    }
  }

  invalidateChanges(changes, position, allowance = BLOCK_LIGHT_METADATA_LIMITS.invalidations - this.stats.metadataInvalidations) {
    const full = (1 << this.sections) - 1;
    const expanded = changes.map(({ x, z, mask }) => {
      const topology = (mask | mask << 1 | mask >>> 1) & full;
      return { x, z, topology, pages: (topology | topology << 1 | topology >>> 1) & full };
    });
    let work = 0;
    for (const change of expanded) {
      for (let bits = change.pages; bits; bits &= bits - 1) work += 25;
      for (let bits = change.topology; bits; bits &= bits - 1) work += 9;
    }
    if (work > allowance) {
      this.resetWork(position);
      return -1;
    }
    for (const change of expanded) {
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
        const x = change.x + dx, z = change.z + dz;
        for (let bits = change.pages; bits; bits &= bits - 1) {
          const bit = 31 - Math.clz32(bits & -bits), y = this.spec.minY / 16 + bit, id = key(x, z, y);
          this.stats.metadataInvalidations++;
          if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1 && (change.topology & 1 << bit)) this.topology.delete(id);
          if (!this.within({ x, z })) continue;
          this.cache.delete(id);
          this.invalidate({ x, z, y });
          if (this.job?.key === id) this.cancelJob();
          // Existing waiters retain their queue turn. A cancelled moving
          // target returns at the tail, so it cannot starve stable receivers.
          this.enqueue(x, z, y);
        }
      }
    }
    return work;
  }

  moveWindow(previous, position) {
    const overlapX = Math.max(0, this.tiles - Math.abs(previous.cx - this.cx));
    const overlapZ = Math.max(0, this.tiles - Math.abs(previous.cz - this.cz));
    if ((this.tiles ** 2 - overlapX * overlapZ) * this.sections > BLOCK_LIGHT_METADATA_LIMITS.invalidations) {
      this.resetWork(position); return;
    }
    for (let z = previous.cz - this.radius; z <= previous.cz + this.radius; z++)
      for (let x = previous.cx - this.radius; x <= previous.cx + this.radius; x++) {
        if (this.within({ x, z })) continue;
        for (let y = this.spec.minY / 16; y < this.spec.maxY / 16; y++) {
          const id = key(x, z, y), at = this.index(x, z, y);
          this.store.invalidate(at); this.uploaded[at] = null;
          this.cache.delete(id); this.waiting.delete(id);
          this.stats.metadataInvalidations++;
        }
      }
    if (this.job && !this.within(this.job)) this.cancelJob();
    this.topologyPrune = this.topology.entries();
    this.refreshQueue(position);
  }

  observeMutation(world, event) {
    if (this.disposed || world !== this.world) return;
    this.revisions.observeMutation(world, event);
    if (event?.epoch !== this.epoch || event.dimension !== world.dimension ||
      event.revision !== world._editRevision || !Array.isArray(event.changes)) return;
    if (this.eventGlobal) return;
    if (event.changes.length > BLOCK_LIGHT_MUTATION_CELLS) {
      this.resetWork(this.position); this.eventGlobal = true; return;
    }
    this.eventMasks ??= new Map();
    const columns = new Map();
    for (const change of event.changes) {
      if (benignBlockLightChange(change)) continue;
      const y = Math.floor(change.y / 16) - this.spec.minY / 16;
      if (y < 0 || y >= this.sections) continue;
      const x = Math.floor(change.x / 16), z = Math.floor(change.z / 16), id = `${x},${z}`;
      if ((this.eventMasks.get(id) ?? 0) & 1 << y) continue;
      this.eventMasks.set(id, (this.eventMasks.get(id) ?? 0) | 1 << y);
      const entry = columns.get(id) ?? { x, z, mask: 0 };
      entry.mask |= 1 << y;
      columns.set(id, entry);
    }
    if (columns.size) {
      const work = this.invalidateChanges([...columns.values()], this.position,
        BLOCK_LIGHT_METADATA_LIMITS.invalidations - (this.eventWork ?? 0));
      if (work < 0) this.eventGlobal = true;
      else this.eventWork = (this.eventWork ?? 0) + work;
    }
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
      this.height !== spec.maxY - spec.minY || this.minY !== spec.minY ||
      this.spec?.minY !== spec.minY || this.spec?.maxY !== spec.maxY;
    const previous = { cx: this.cx, cz: this.cz, radius: this.radius };
    if (reset) {
      this.topology.clear(); this.cache.clear(); this.waiting.clear();
      this.job = null;
      this.solver.sources = null;
      this.solver.values = null;
      this.solver.count = 0;
      this.revisions = new BlockLightRevisions();
      this.uploaded.fill(null);
    }
    Object.assign(this, { world, spec, epoch: geometryEpoch(world), dimension: world.dimension,
      version: world.generatorVersion, minY: spec.minY,
      cx: Math.floor(position.x / 16), cz: Math.floor(position.z / 16), position });
    if (this.height !== spec.maxY - spec.minY || radius !== this.radius)
      this.allocate(spec.maxY - spec.minY, radius);
    this.stats = { scans: 0, shapeReads: 0, visits: 0, seedVisits: 0, floodVisits: 0, outputVisits: 0, columnChecks: 0,
      stampChecks: 0, topologyBuilds: 0, completed: 0, staleJobs: 0, queuePeak: 0, uploadBytes: 0, uploadLayers: 0,
      resetVisits: 0, lazyReads: 0, initializedCells: 0,
      metadataInvalidations: 0, metadataTargets: 0, metadataPrunes: 0, metadataSources: 0, globalInvalidations: 0,
      cacheChecks: 0, reused: 0,
      mutationMetadataWork: this.eventWork ?? 0,
      allocationBytes: this.allocationBytes ?? 0 };
    this.eventGlobal = false; this.eventWork = 0; this.eventMasks?.clear();
    this.allocationBytes = 0;
    const changed = this.revisions.update(world, this.cx, this.cz, radius, spec, this.stats);
    if (reset || this.revisions.global) this.resetWork(position);
    else {
      if (previous.radius !== radius) this.resizeWork(position);
      else if (previous.cx !== this.cx || previous.cz !== this.cz) this.moveWindow(previous, position);
      if (changed) this.invalidateChanges(this.revisions.changes, position);
    }
    for (let i = 0; this.seed && i < BLOCK_LIGHT_METADATA_LIMITS.targets; i++) {
      if (i % 8 === 0 && performance.now() - started >= BLOCK_LIGHT_LIMITS.milliseconds / 2) break;
      const next = this.seed.next();
      if (next.done) { this.seed = null; this.seedRemaining = 0; break; }
      this.enqueue(next.value.x, next.value.z, next.value.y);
      this.seedRemaining--;
      this.stats.metadataTargets++;
    }
    for (let i = 0; this.topologyPrune && i < BLOCK_LIGHT_METADATA_LIMITS.pruning; i++) {
      const next = this.topologyPrune.next();
      if (next.done) { this.topologyPrune = null; break; }
      if (!this.within(next.value[1], 1)) this.topology.delete(next.value[0]);
      this.stats.metadataPrunes++;
    }
    if (!changed && !this.seed && !this.waiting.size && !this.uploadQueue.length && !this.job &&
      !this.cacheWork && !this.topologyPrune && !this.revisions.pruneIterator) {
      this.pending = 0;
      this.stats.updateMs = performance.now() - started;
      return;
    }
    const layers = new Set();
    this.advanceCache(started, layers);
    while (this.uploadQueue.length && performance.now() - started < BLOCK_LIGHT_LIMITS.milliseconds) {
      if (!this.publish(this.uploadQueue[0], layers)) break;
      this.uploadQueue.shift();
    }
    const budget = {
      metadata: () => {
        if (this.stats.metadataSources >= BLOCK_LIGHT_METADATA_LIMITS.sources ||
          performance.now() - started >= BLOCK_LIGHT_LIMITS.milliseconds) return false;
        this.stats.metadataSources++; return true;
      },
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
    while (this.stats.completed + this.stats.reused < BLOCK_LIGHT_LIMITS.publications &&
      performance.now() - started < BLOCK_LIGHT_LIMITS.milliseconds) {
      if (!this.job) {
        const next = this.waiting.entries().next();
        if (next.done) break;
        this.waiting.delete(next.value[0]);
        this.start(next.value[1]);
      }
      this.advance(budget, layers);
      if (this.job) break;
    }
    this.pending = Math.min(this.tiles ** 2 * this.sections,
      this.waiting.size + this.uploadQueue.length + Number(!!this.job) + (this.seedRemaining ?? 0) +
      Number(!!(this.cacheWork || this.topologyPrune || this.revisions.pruneIterator)));
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
      const at = Math.floor(y / 16) * this.tiles ** 2 + this.slot(cx, cz);
      const value = this.store.sample(at, (y % 16) * 400 + lz * 20 + lx);
      if (value === undefined) continue;
      return blockLightPalette.decode(value).map((v) => v / 255);
    }
    return [0, 0, 0];
  }

  resources() {
    return { atlasBytes: 0, validityBytes: this.valid.byteLength, ...this.store.resources(),
      cacheBytes: [...this.cache.values()].reduce((n, e) => n + (e.values?.byteLength ?? 0), 0),
      topologyBytes: [...this.topology.values()].reduce((n, e) => n + (e.values?.byteLength ?? 0), 0),
      topologySections: this.topology.size, cachedSections: this.cache.size,
      certifiedSections: [...this.cache.values()].filter((e) => e.certified).length,
      sharedPaletteBytes: BLOCK_LIGHT_PALETTE_BYTES,
      rgbPaletteBytes: blockLightPalette.bytes.byteLength,
      metadataEntries: this.revisions.tokens.size, metadataPrefixBytes: this.revisions.prefix?.byteLength ?? 0,
      semanticEntries: this.revisions.semantic.size,
      targetEntries: this.waiting.size, uploadQueue: this.uploadQueue.length,
      pendingCacheWork: Number(!!this.cacheWork),
      scratchBytes: this.disposed ? 0 : this.solver.resources() + BLOCK_LIGHT_PAGE_CELLS * 4 + 4096,
      queuedCells: this.solver.count ?? 0, pending: this.pending ?? 0 };
  }

  restoreGPU() {
    this.store.restoreGPU();
    this.paletteTexture.dispose();
    this.paletteTexture = blockPaletteTexture();
    this.validTexture = this.store.table;
    this.uploaded.fill(null);
    this.uploadQueue = [];
    this.cacheWork = this.cache.entries();
    this.pending = this.waiting.size + Number(!!this.job) + (this.seedRemaining ?? 0) + 1;
  }

  dispose() {
    this.disposed = true;
    this.store.dispose(); this.paletteTexture.dispose();
    this.valid = this.store.mapping;
    this.uploaded = [];
    this.cache.clear(); this.topology.clear(); this.waiting.clear();
    this.revisions = new BlockLightRevisions();
    this.job = null; this.world = null;
    this.seed = this.topologyPrune = this.cacheWork = null; this.seedRemaining = 0; this.uploadQueue = [];
    this.eventMasks?.clear();
    this.solver.sources = null;
    this.solver.values = null;
    this.solver.light = this.solver.queue = new Uint32Array(0);
    this.solver.cost = this.solver.queued = new Uint8Array(0);
    this.pending = this.solver.count = 0;
  }
}
