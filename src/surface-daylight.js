import * as THREE from "three";
import { CAVE_DAYLIGHT_LIMITS, entranceLightWeight } from "./cave-daylight.js";
import { columnLoaded } from "./geometry-world.js";
import { MAX_RENDER_RADIUS, renderDistanceLayout } from "./render-distance.js";
import { prioritizeDaylight, SurfaceTopology } from "./surface-topology.js";
import { CHUNK_SIZE } from "./terrain.js";

export const SURFACE_DAYLIGHT_LIMITS = Object.freeze({
  chunkBuilds: 2,
  cachedChunks: renderDistanceLayout(MAX_RENDER_RADIUS).sourceChunks,
  // At most the former two builds' nine source columns worth of cell reads.
  topologyBuilds: 18,
  topologyChunks: renderDistanceLayout(MAX_RENDER_RADIUS).spareChunks,
  radius: CAVE_DAYLIGHT_LIMITS.lightRadius,
  atlasWidth: 64,
});
const LAYER = CHUNK_SIZE * CHUNK_SIZE;
const SIDE = CHUNK_SIZE * 3; // One full light-radius halo, independent of the view.
const PLANE = SIDE * SIDE;
const BLOCKED = 255, UNLIT = 254;
const modulo = (n, size) => ((n % size) + size) % size;

/**
 * Render-only diffuse skylight. Each tile solves the same finite, six-connected
 * path from loaded open sky, even on a cold outside view or a deep look-back.
 * Opaque/unknown cells stop propagation; partial occluders conservatively stop
 * the whole voxel. No camera aperture, terrain generation, or gameplay light.
 */
export class SurfaceDaylight {
  constructor(columns, limits) {
    this.columns = columns;
    this.limits = limits;
    this.layout = columns.layout;
    this.tiles = this.layout.tiles;
    this.cache = new Map();
    this.ids = new WeakMap();
    this.serial = 0;
    this.nextId = 0;
    this.age = 0;
    this.waiting = new Map();
    this.topology = new SurfaceTopology(columns, {
      ...SURFACE_DAYLIGHT_LIMITS, topologyChunks: this.layout.spareChunks,
    });
    this.allocate(1);
  }

  setRadius(radius) {
    const layout = renderDistanceLayout(radius);
    if (layout.radius === this.layout.radius) return;
    this.layout = layout;
    this.tiles = layout.tiles;
    this.allocate(this.height);
    // Ring modulo changes invalidate uploads, not verified world-space entries.
    this.waiting.clear();
    this.sources?.clear();
    while (this.cache.size > layout.sourceChunks)
      this.cache.delete(this.cache.keys().next().value);
    this.topology.setCapacity(layout.spareChunks);
  }

  allocate(height) {
    this.texture?.dispose();
    this.height = height;
    this.layerSize = height * LAYER;
    this.data = new Uint8Array(this.layerSize * this.tiles * this.tiles);
    this.texture = new THREE.DataArrayTexture(
      this.data, SURFACE_DAYLIGHT_LIMITS.atlasWidth,
      this.layerSize / SURFACE_DAYLIGHT_LIMITS.atlasWidth, this.tiles * this.tiles
    );
    this.texture.format = THREE.RedFormat;
    this.texture.needsUpdate = true;
    this.uploaded = Array(this.tiles * this.tiles).fill(null);
    this.distance = new Uint8Array(PLANE * height);
    this.queue = new Uint32Array(PLANE * height);
  }

  begin(reset) {
    const height = this.columns.spec.maxY - this.columns.spec.minY;
    this.valid = height > 0 && height <= this.limits.height;
    Object.assign(this.columns.stats, {
      surfaceBuilds: 0, surfaceCellReads: 0, surfaceShapeReads: 0,
      surfaceVoxelVisits: 0, surfaceFloodVisits: 0, surfaceUploadBytes: 0,
      surfaceStampChecks: 0, surfaceMaskReads: 0, surfaceTopologyBuilds: 0,
      surfaceTopologyComparisons: 0, surfaceDependencyChecks: 0, surfaceQueueComparisons: 0,
    });
    this.age++;
    if (this.height !== (this.valid ? height : 1)) this.allocate(this.valid ? height : 1);
    if (reset) {
      this.cache.clear();
      this.waiting.clear();
      this.topology.clear();
      for (let slot = 0; slot < this.uploaded.length; slot++) this.upload(slot, null);
    }
    this.pending = 0;
  }

  slot(cx, cz) {
    return modulo(cz, this.tiles) * this.tiles + modulo(cx, this.tiles);
  }

  upload(slot, entry) {
    if (this.uploaded[slot] === (entry?.serial ?? null)) return;
    this.data.fill(0, slot * this.layerSize, (slot + 1) * this.layerSize);
    if (entry) this.data.set(entry.values, slot * this.layerSize);
    this.uploaded[slot] = entry?.serial ?? null;
    this.texture.addLayerUpdate(slot);
    this.texture.needsUpdate = true;
    this.columns.stats.surfaceUploadBytes += this.layerSize;
  }

  update(position, radius) {
    if (!this.valid || this.columns.world.dimension !== "overworld") return;
    const world = this.columns.world;
    const cx = Math.floor(position.x / CHUNK_SIZE), cz = Math.floor(position.z / CHUNK_SIZE);
    const stamps = new Map(), pending = [], waiting = new Map();
    // The 16-block solve halo plus one shape-neighbor halo. Check identities,
    // not an unbounded resident-map scan; don't retain chunks or their buffers.
    for (let z = cz - radius - 2; z <= cz + radius + 2; z++)
      for (let x = cx - radius - 2; x <= cx + radius + 2; x++) {
        const chunk = world.chunks?.get(`${x},${z}`);
        const known = chunk && columnLoaded(world, x * CHUNK_SIZE, z * CHUNK_SIZE);
        if (known && !this.ids.has(chunk)) this.ids.set(chunk, ++this.nextId);
        stamps.set(`${x},${z}`, known ? `${this.ids.get(chunk)}:${chunk.revision}:${chunk.incarnation}` : "0");
        this.columns.stats.surfaceStampChecks++;
      }
    this.sources = this.topology.update(cx, cz, radius, stamps, this.age, this.waiting);
    for (let z = cz - radius; z <= cz + radius; z++)
      for (let x = cx - radius; x <= cx + radius; x++) {
        const key = `${x},${z}`, slot = this.slot(x, z);
        if (this.sources.get(key) === null) {
          this.cache.delete(key);
          this.upload(slot, null);
          continue;
        }
        const dependencies = [];
        for (let dz = -1; dz <= 1; dz++)
          for (let dx = -1; dx <= 1; dx++) {
            dependencies.push(this.sources.get(`${x + dx},${z + dz}`));
            this.columns.stats.surfaceDependencyChecks++;
          }
        const ready = dependencies.every((entry) => entry !== undefined);
        const stamp = dependencies.map((entry) => entry?.serial ?? 0).join("|");
        const old = this.cache.get(key);
        if (ready && old?.stamp === stamp) {
          this.cache.delete(key);
          this.cache.set(key, old);
          this.upload(slot, old);
        } else {
          // Unknown/unverified topology and real closures clear immediately.
          // Repeated changes keep the original queue age, never stale light.
          this.cache.delete(key);
          this.upload(slot, null);
          const age = this.waiting.get(key) ?? this.age;
          waiting.set(key, age);
          pending.push({ x, z, key, stamp, ready, age, distance: (x - cx) ** 2 + (z - cz) ** 2 });
        }
      }
    prioritizeDaylight(pending, this.columns.stats);
    const budget = Math.max(0, SURFACE_DAYLIGHT_LIMITS.chunkBuilds - this.columns.stats.surfaceBuilds);
    let built = 0;
    for (const tile of pending) {
      if (built >= budget) break;
      if (!tile.ready) continue;
      const entry = { stamp: tile.stamp, values: this.build(tile.x, tile.z), serial: ++this.serial };
      this.cache.set(tile.key, entry);
      this.upload(this.slot(tile.x, tile.z), entry);
      waiting.delete(tile.key);
      built++;
      if (this.cache.size > this.layout.sourceChunks)
        this.cache.delete(this.cache.keys().next().value);
    }
    this.waiting = waiting;
    this.pending = pending.length - built;
  }

  build(cx, cz) {
    const { spec, stats } = this.columns;
    const chunks = [];
    let top = spec.minY, centerTop = spec.minY;
    stats.surfaceBuilds++;
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const sky = this.sources.get(`${cx + dx},${cz + dz}`);
        if (!sky) continue;
        const maximum = spec.minY + sky.depth;
        top = Math.max(top, maximum);
        if (!dx && !dz) centerTop = maximum;
        chunks.push({ sky, dx, dz });
      }
    const depth = Math.ceil(top) - spec.minY;
    const centerDepth = Math.ceil(centerTop) - spec.minY;
    const count = depth * PLANE;
    const d = this.distance, queue = this.queue;
    d.fill(BLOCKED, 0, count);
    stats.surfaceVoxelVisits += count;
    for (const { sky, dx, dz } of chunks)
      for (let y = 0; y < depth; y++)
        for (let z = 0; z < CHUNK_SIZE; z++)
          for (let x = 0; x < CHUNK_SIZE; x++) {
            const column = z * CHUNK_SIZE + x;
            const index = y * PLANE + ((dz + 1) * CHUNK_SIZE + z) * SIDE + (dx + 1) * CHUNK_SIZE + x;
            if (y + spec.minY >= sky.heights[column]) {
              d[index] = 0;
              continue;
            }
            const cellIndex = y * LAYER + column;
            stats.surfaceMaskReads++;
            if (!(sky.blocked[cellIndex >>> 5] & (1 << (cellIndex & 31)))) d[index] = UNLIT;
          }
    let head = 0, tail = 0;
    // Seed only roofed air adjacent to direct sky, not the huge exterior volume.
    for (let y = 0; y < depth; y++)
      for (let z = 1; z < SIDE - 1; z++)
        for (let x = 1; x < SIDE - 1; x++) {
          const i = y * PLANE + z * SIDE + x;
          if (d[i] !== UNLIT) continue;
          if (d[i - 1] === 0 || d[i + 1] === 0 || d[i - SIDE] === 0 || d[i + SIDE] === 0 ||
              (y > 0 && d[i - PLANE] === 0) || (y + 1 < depth && d[i + PLANE] === 0)) {
            d[i] = 1;
            queue[tail++] = i;
          }
        }
    stats.surfaceVoxelVisits += count;
    const spread = (i, value) => {
      if (d[i] !== UNLIT) return;
      d[i] = value;
      queue[tail++] = i;
    };
    while (head < tail) {
      const i = queue[head++], value = d[i] + 1;
      if (value >= SURFACE_DAYLIGHT_LIMITS.radius) continue;
      const x = i % SIDE, z = Math.floor(i / SIDE) % SIDE;
      if (x > 0) spread(i - 1, value);
      if (x + 1 < SIDE) spread(i + 1, value);
      if (z > 0) spread(i - SIDE, value);
      if (z + 1 < SIDE) spread(i + SIDE, value);
      if (i >= PLANE) spread(i - PLANE, value);
      if (i + PLANE < count) spread(i + PLANE, value);
    }
    stats.surfaceFloodVisits += tail;
    const values = new Uint8Array(centerDepth * LAYER);
    for (let y = 0; y < centerDepth; y++)
      for (let z = 0; z < CHUNK_SIZE; z++)
        for (let x = 0; x < CHUNK_SIZE; x++) {
          const value = d[y * PLANE + (z + CHUNK_SIZE) * SIDE + x + CHUNK_SIZE];
          if (value < SURFACE_DAYLIGHT_LIMITS.radius)
            values[y * LAYER + z * CHUNK_SIZE + x] = SURFACE_DAYLIGHT_LIMITS.radius - value;
        }
    return values;
  }

  sample(point) {
    const y = Math.floor(point.y) - this.columns.spec.minY;
    if (!this.valid || y < 0 || y >= this.height) return 0;
    const x = Math.floor(point.x), z = Math.floor(point.z);
    const slot = this.slot(Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE));
    const value = this.data[slot * this.layerSize + y * LAYER + modulo(z, CHUNK_SIZE) * CHUNK_SIZE + modulo(x, CHUNK_SIZE)];
    return entranceLightWeight(SURFACE_DAYLIGHT_LIMITS.radius - value);
  }

  resources() {
    let cacheBytes = 0;
    for (const entry of this.cache.values()) cacheBytes += entry.values.byteLength;
    return {
      atlasBytes: this.data.byteLength, cacheBytes, cachedChunks: this.cache.size,
      scratchBytes: this.distance.byteLength + this.queue.byteLength,
      layers: this.tiles * this.tiles, pending: this.pending,
      cacheLimit: this.layout.sourceChunks,
      ...this.topology.resources(),
    };
  }

  dispose() {
    this.cache.clear();
    this.waiting.clear();
    this.topology.clear();
    this.sources?.clear();
    this.texture.dispose();
  }
}
