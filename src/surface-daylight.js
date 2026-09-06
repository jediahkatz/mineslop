import { entranceLightWeight } from "./cave-daylight.js";
import { columnLoaded } from "./geometry-world.js";
import { prioritizeDaylight, SurfaceTopology } from "./surface-topology.js";
import { LIGHT_MAX_RADIUS, SURFACE_PAGE_LAYOUT, lightLayout } from "./light-page-layout.js";
import { PagedLightStore } from "./paged-light-store.js";
import { SurfaceLightSolver } from "./surface-light-solver.js";

export const SURFACE_DAYLIGHT_LIMITS = Object.freeze({
  chunkBuilds: 2, cachedChunks: lightLayout(LIGHT_MAX_RADIUS).sourceChunks,
  topologyBuilds: 18, topologyChunks: lightLayout(LIGHT_MAX_RADIUS).spareChunks,
  radius: 16, atlasWidth: 72,
});
const modulo = (n, size) => ((n % size) + size) % size;

/** Render-only, resumable world-space diffuse skylight. Required receiver
 * pages are pinned; camera movement retains verified overlapping world data.
 */
export class SurfaceDaylight {
  constructor(columns, limits) {
    this.columns = columns;
    this.limits = limits;
    this.layout = columns.layout;
    this.tiles = this.layout.tiles;
    this.cache = new Map();
    this.serial = this.age = 0;
    this.waiting = new Map();
    this.topology = new SurfaceTopology(columns, {
      ...SURFACE_DAYLIGHT_LIMITS, topologyChunks: this.layout.spareChunks,
    });
    this.allocate(16);
  }

  setRadius(radius) {
    const layout = lightLayout(radius);
    if (layout.radius === this.layout.radius) return;
    this.layout = layout;
    this.tiles = layout.tiles;
    this.allocate(this.height);
    this.topology.setCapacity(layout.spareChunks);
  }

  allocate(height) {
    this.store?.dispose();
    this.height = height;
    // The final row shares this sampler with sky-column validity, avoiding an
    // eleventh lighting sampler. Unused tail columns never own physical pages.
    this.store = new PagedLightStore(SURFACE_PAGE_LAYOUT, this.tiles ** 2, height / 16,
      { tableColumns: this.layout.sourceChunks, extraRows: 1 });
    this.solver = new SurfaceLightSolver(height);
    this.uploaded = Array(this.tiles ** 2).fill(null);
    this.job = null;
  }

  begin(reset) {
    const height = this.columns.spec.maxY - this.columns.spec.minY;
    this.valid = height > 0 && height <= this.limits.height && height % 16 === 0;
    Object.assign(this.columns.stats, {
      surfaceBuilds: 0, surfaceCellReads: 0, surfaceShapeReads: 0,
      surfaceVoxelVisits: 0, surfaceFloodVisits: 0, surfaceOutputVisits: 0, surfaceUploadBytes: 0,
      surfaceStampChecks: 0, surfaceMaskReads: 0, surfaceTopologyBuilds: 0,
      surfaceTopologyComparisons: 0, surfaceDependencyChecks: 0, surfaceQueueComparisons: 0,
    });
    this.age++;
    if (this.height !== (this.valid ? height : 16)) this.allocate(this.valid ? height : 16);
    if (reset) {
      this.cache.clear(); this.waiting.clear(); this.topology.clear();
      this.job = null;
      for (let i = 0; i < this.store.mapping.length; i++) this.store.invalidate(i);
      this.uploaded.fill(null);
    }
    this.pending = 0;
  }

  slot(cx, cz) {
    return modulo(cz, this.tiles) * this.tiles + modulo(cx, this.tiles);
  }

  index(cx, cz, section) {
    return section * this.store.tableColumns + this.slot(cx, cz);
  }

  upload(slot, entry) {
    const stamp = entry ? `${entry.key}:${entry.serial}` : null;
    if (this.uploaded[slot] === stamp) return;
    for (let y = 0; y < this.height / 16; y++) {
      const at = y * this.store.tableColumns + slot;
      this.store.invalidate(at);
      // Missing light/shape input is unavailable, never authoritative darkness.
      if (entry?.certified)
        this.store.publish(this.store.claim(at, `${stamp}:${y}`), entry.pages[y]);
    }
    this.uploaded[slot] = stamp;
  }

  update(position, radius) {
    if (!this.valid || this.columns.world.dimension !== "overworld") return;
    const { world, stats } = this.columns;
    const cx = Math.floor(position.x / 16), cz = Math.floor(position.z / 16);
    this.cx = cx; this.cz = cz;
    const stamps = new Map(), pending = [], waiting = new Map();
    for (let z = cz - radius - 2; z <= cz + radius + 2; z++)
      for (let x = cx - radius - 2; x <= cx + radius + 2; x++) {
        const chunk = world.chunks?.get(`${x},${z}`);
        const known = chunk && columnLoaded(world, x * 16, z * 16);
        stamps.set(`${x},${z}`, known ? this.columns.revisions.token(world, x, z) : "0");
        stats.surfaceStampChecks++;
      }
    this.sources = this.topology.update(cx, cz, radius, stamps, this.age, this.waiting);
    const active = new Set();
    for (let z = cz - radius; z <= cz + radius; z++)
      for (let x = cx - radius; x <= cx + radius; x++) {
        const key = `${x},${z}`, slot = this.slot(x, z);
        active.add(key);
        if (this.sources.get(key) === null) {
          this.cache.delete(key); this.upload(slot, null); continue;
        }
        const dependencies = [];
        for (let dz = -1; dz <= 1; dz++)
          for (let dx = -1; dx <= 1; dx++) {
            dependencies.push(this.sources.get(`${x + dx},${z + dz}`));
            stats.surfaceDependencyChecks++;
          }
        const ready = dependencies.every((entry) => entry !== undefined);
        const stamp = dependencies.map((entry) => `${entry?.serial ?? 0}:${Number(!!entry?.complete)}`).join("|");
        const old = this.cache.get(key);
        if (ready && old?.stamp === stamp) this.upload(slot, old);
        else {
          this.cache.delete(key); this.upload(slot, null);
          const age = this.waiting.get(key) ?? this.age;
          waiting.set(key, age);
          pending.push({ x, z, key, stamp, ready, dependencies, age, distance: (x - cx) ** 2 + (z - cz) ** 2 });
        }
      }
    for (const key of this.cache.keys()) if (!active.has(key)) this.cache.delete(key);
    if (this.job && !pending.some((p) => p.key === this.job.key && p.stamp === this.job.stamp && p.ready))
      this.job = null;
    prioritizeDaylight(pending, stats);
    const budget = this.columns.surfaceWork;
    for (let built = stats.surfaceBuilds; built < SURFACE_DAYLIGHT_LIMITS.chunkBuilds; built++) {
      if (!this.job) {
        this.job = pending.find((p) => p.ready && waiting.has(p.key));
        if (!this.job) break;
        this.solver.begin(this.job.dependencies, this.columns.spec.minY, this.height);
      }
      if (!this.solver.step(budget, stats)) break;
      const job = this.job;
      const entry = { key: job.key, x: job.x, z: job.z, stamp: job.stamp,
        pages: this.solver.pages, serial: ++this.serial, certified: job.dependencies.every((e) => e?.complete) };
      this.cache.set(job.key, entry);
      this.upload(this.slot(job.x, job.z), entry);
      waiting.delete(job.key);
      stats.surfaceBuilds++;
      this.job = null;
      this.solver.sources = null;
      this.solver.pages = [];
      this.solver.page = null;
    }
    this.waiting = waiting;
    this.pending = waiting.size;
  }

  sample(point) {
    const y = Math.floor(point.y) - this.columns.spec.minY;
    if (!this.valid || y < 0 || y >= this.height) return 0;
    const x = Math.floor(point.x), z = Math.floor(point.z), ox = Math.floor(x / 16), oz = Math.floor(z / 16);
    const lx = modulo(x, 16), lz = modulo(z, 16);
    const candidates = [[ox, oz]];
    if (lx === 0 || lx === 15) candidates.push([ox + (lx === 0 ? -1 : 1), oz]);
    if (lz === 0 || lz === 15) candidates.push([ox, oz + (lz === 0 ? -1 : 1)]);
    if ((lx === 0 || lx === 15) && (lz === 0 || lz === 15))
      candidates.push([ox + (lx === 0 ? -1 : 1), oz + (lz === 0 ? -1 : 1)]);
    for (const [cx, cz] of candidates) {
      if (Math.abs(cx - this.cx) > this.layout.radius || Math.abs(cz - this.cz) > this.layout.radius) continue;
      const localX = x - cx * 16 + 1, localZ = z - cz * 16 + 1;
      const value = this.store.sample(this.index(cx, cz, Math.floor(y / 16)), (y % 16) * 324 + localZ * 18 + localX);
      if (value !== undefined) return entranceLightWeight(16 - value);
    }
    return 0;
  }

  restoreGPU() {
    this.store.restoreGPU();
  }

  resources() {
    const store = this.store.resources();
    // Uncertified results still own arrays; certified pages share these same
    // buffers with the store. Count the union, not two aliases or only uploads.
    const buffers = new Set();
    for (const entry of this.cache.values())
      for (const page of entry.pages) if (page instanceof Uint8Array) buffers.add(page.buffer);
    for (const page of this.store.pages.values()) if (page.values) buffers.add(page.values.buffer);
    const bytes = [...buffers].reduce((n, buffer) => n + buffer.byteLength, 0);
    return { atlasBytes: 0, ...store, canonicalBytes: bytes, cacheBytes: bytes, cachedChunks: this.cache.size,
      scratchBytes: this.solver.resources(), layers: store.banks * SURFACE_PAGE_LAYOUT.layers,
      pending: this.pending, cacheLimit: this.layout.chunks,
      certifiedChunks: [...this.cache.values()].filter((e) => e.certified).length,
      ...this.topology.resources() };
  }

  dispose() {
    this.cache.clear(); this.waiting.clear(); this.topology.clear();
    this.sources?.clear(); this.job = null; this.solver.sources = null;
    this.solver.pages = [];
    this.solver.page = null;
    this.solver.distance = new Uint8Array(0);
    this.solver.queue = new Uint32Array(0);
    this.pending = 0;
    this.store.dispose();
  }
}
