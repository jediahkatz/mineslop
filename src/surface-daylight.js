import * as THREE from "three";
import { resolveShape } from "./block-shapes.js";
import { BLOCK } from "./blocks.js";
import { CAVE_DAYLIGHT_LIMITS, entranceLightWeight } from "./cave-daylight.js";
import { readChunkCell } from "./chunk-data.js";
import { columnLoaded, readGeometryCell } from "./geometry-world.js";
import { opaqueCube } from "./mesh-palette.js";
import { CHUNK_SIZE } from "./terrain.js";

export const SURFACE_DAYLIGHT_LIMITS = Object.freeze({
  chunkBuilds: 2,
  cachedChunks: 121,
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
    this.tiles = limits.renderRadius * 2 + 1;
    this.cache = new Map();
    this.ids = new WeakMap();
    this.serial = 0;
    this.nextId = 0;
    this.allocate(1);
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
      surfaceStampChecks: 0,
    });
    if (this.height !== (this.valid ? height : 1)) this.allocate(this.valid ? height : 1);
    if (reset) {
      this.cache.clear();
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
    const stamps = new Map(), pending = [];
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
    for (let z = cz - radius; z <= cz + radius; z++)
      for (let x = cx - radius; x <= cx + radius; x++) {
        const key = `${x},${z}`, slot = this.slot(x, z);
        if (stamps.get(key) === "0") {
          this.cache.delete(key);
          this.upload(slot, null);
          continue;
        }
        const dependencies = [];
        for (let dz = -2; dz <= 2; dz++)
          for (let dx = -2; dx <= 2; dx++) dependencies.push(stamps.get(`${x + dx},${z + dz}`));
        const stamp = dependencies.join("|");
        const old = this.cache.get(key);
        if (old?.stamp === stamp) {
          this.cache.delete(key);
          this.cache.set(key, old);
          this.upload(slot, old);
        } else {
          // Invalidation is immediate, even when the rebuild must wait its turn.
          this.cache.delete(key);
          this.upload(slot, null);
          pending.push({ x, z, key, stamp, distance: (x - cx) ** 2 + (z - cz) ** 2 });
        }
      }
    pending.sort((a, b) => a.distance - b.distance || a.z - b.z || a.x - b.x);
    const budget = Math.max(0, SURFACE_DAYLIGHT_LIMITS.chunkBuilds - this.columns.stats.surfaceBuilds);
    for (const tile of pending.slice(0, budget)) {
      const entry = { stamp: tile.stamp, values: this.build(tile.x, tile.z), serial: ++this.serial };
      this.cache.set(tile.key, entry);
      this.upload(this.slot(tile.x, tile.z), entry);
      if (this.cache.size > SURFACE_DAYLIGHT_LIMITS.cachedChunks)
        this.cache.delete(this.cache.keys().next().value);
    }
    this.pending = Math.max(0, pending.length - budget);
  }

  build(cx, cz) {
    const { world, spec, stats } = this.columns;
    const chunks = [];
    let top = spec.minY, centerTop = spec.minY;
    stats.surfaceBuilds++;
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, z = cz + dz;
        const sky = columnLoaded(world, x * CHUNK_SIZE, z * CHUNK_SIZE) && this.columns.chunk(x, z);
        if (!sky) continue;
        const chunk = world.chunks.get(`${x},${z}`);
        const maximum = Math.min(spec.maxY, Math.max(spec.minY, ...sky.heights));
        top = Math.max(top, maximum);
        if (!dx && !dz) centerTop = maximum;
        chunks.push({ chunk, sky, dx, dz, x, z });
      }
    const depth = Math.ceil(top) - spec.minY;
    const centerDepth = Math.ceil(centerTop) - spec.minY;
    const count = depth * PLANE;
    const d = this.distance, queue = this.queue;
    d.fill(BLOCKED, 0, count);
    stats.surfaceVoxelVisits += count;
    for (const { chunk, sky, dx, dz, x: cx, z: cz } of chunks)
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
            const id = chunk.blocks[cellIndex];
            stats.surfaceCellReads++;
            if (id === BLOCK.AIR) d[index] = UNLIT;
            else if (!opaqueCube[id]) {
              const shape = resolveShape(readChunkCell(chunk, cellIndex), (nx, ny, nz) => {
                stats.surfaceShapeReads++;
                return readGeometryCell(world, cx * CHUNK_SIZE + x + nx, y + spec.minY + ny, cz * CHUNK_SIZE + z + nz);
              });
              if (!shape.occlusion.length) d[index] = UNLIT;
            }
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
    };
  }

  dispose() {
    this.cache.clear();
    this.texture.dispose();
  }
}
