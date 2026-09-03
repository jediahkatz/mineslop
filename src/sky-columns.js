import * as THREE from "three";
import { resolveShape } from "./block-shapes.js";
import { BLOCK } from "./blocks.js";
import { readChunkCell } from "./chunk-data.js";
import {
  columnLoaded,
  geometryEpoch,
  geometryWorldSpec,
  readGeometryCell,
} from "./geometry-world.js";
import { opaqueCube } from "./mesh-palette.js";
import { SurfaceDaylight } from "./surface-daylight.js";
import { CHUNK_SIZE } from "./terrain.js";

export const SKY_COLUMN_LIMITS = Object.freeze({
  cachedChunks: 169,
  scalarColumns: 256,
  renderRadius: 4,
  height: 384,
});
export const UNKNOWN_SKY_HEIGHT = 1_000_000;
const LAYER = CHUNK_SIZE * CHUNK_SIZE;

/**
 * A loaded-geometry ceiling, not the generator's pre-carving height. Partial
 * occluders conservatively cover their column; glass and fluids do not become
 * roofs. This is only skylight data, never terrain admission or collision.
 */
export class SkyColumns {
  constructor() {
    this.cache = new Map();
    this.scalars = new Map();
    this.chunkIds = new WeakMap();
    this.nextChunkId = 0;
    this.serial = 0;
    this.origin = new THREE.Vector2();
    this.size = (SKY_COLUMN_LIMITS.renderRadius * 2 + 1) * CHUNK_SIZE;
    this.data = new Float32Array(this.size * this.size);
    this.data.fill(UNKNOWN_SKY_HEIGHT);
    this.texture = new THREE.DataTexture(
      this.data,
      this.size,
      this.size,
      THREE.RedFormat,
      THREE.FloatType
    );
    this.texture.magFilter = this.texture.minFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
    this.surfaceLight = new SurfaceDaylight(this, SKY_COLUMN_LIMITS);
  }

  begin(world) {
    const spec = geometryWorldSpec(world);
    const reset =
      this.world !== world ||
      this.epoch !== geometryEpoch(world) ||
      this.dimension !== world.dimension ||
      this.generator !== world.generator ||
      this.spec !== spec;
    if (reset) {
      this.cache.clear();
      this.fieldKey = null;
    }
    this.world = world;
    this.epoch = geometryEpoch(world);
    this.dimension = world.dimension;
    this.generator = world.generator;
    this.spec = spec;
    // Legacy scalar readers do not have incarnation/revision identities.
    this.scalars.clear();
    this.stats = { chunkBuilds: 0, cellReads: 0, scalarColumns: 0 };
    this.surfaceLight.begin(reset);
    return this;
  }

  cellTop(cell, x, y, z) {
    if (!cell) return UNKNOWN_SKY_HEIGHT;
    if (cell.id === BLOCK.AIR) return -Infinity;
    if (opaqueCube[cell.id]) return y + 1;
    const shape = resolveShape(cell, (dx, dy, dz) =>
      readGeometryCell(this.world, x + dx, y + dy, z + dz)
    );
    return shape.occlusion.reduce(
      (top, bounds) => Math.max(top, y + bounds[4]),
      -Infinity
    );
  }

  chunk(cx, cz) {
    const world = this.world;
    const key = `${cx},${cz}`;
    const chunk = world.chunks?.get(key);
    const { minY, maxY } = this.spec;
    if (
      !chunk?.blocks ||
      maxY - minY > SKY_COLUMN_LIMITS.height ||
      chunk.blocks.length !== (maxY - minY) * LAYER
    )
      return null;
    // A neighboring door/stair may change its resolved occlusion without an
    // edit in this column. Eviction/readmission also invalidates that input.
    const stamps = [];
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const neighbor = world.chunks.get(`${cx + dx},${cz + dz}`);
        // Numeric stamps cannot pin evicted chunks and their full cell buffers.
        // Object identity still distinguishes legacy readmissions without IDs.
        if (neighbor && !this.chunkIds.has(neighbor))
          this.chunkIds.set(neighbor, ++this.nextChunkId);
        stamps.push(
          neighbor ? this.chunkIds.get(neighbor) : 0,
          neighbor?.revision,
          neighbor?.incarnation
        );
      }
    const old = this.cache.get(key);
    if (old && stamps.every((stamp, i) => stamp === old.stamps[i]))
      return old;
    const heights = new Float32Array(LAYER);
    heights.fill(minY);
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const column = z * CHUNK_SIZE + x;
        for (let y = maxY - 1; y >= minY; y--) {
          const index = (y - minY) * LAYER + column;
          this.stats.cellReads++;
          const id = chunk.blocks[index];
          if (id === BLOCK.AIR) continue;
          const top = this.cellTop(
            opaqueCube[id] ? { id } : readChunkCell(chunk, index),
            cx * CHUNK_SIZE + x,
            y,
            cz * CHUNK_SIZE + z
          );
          if (top === -Infinity) continue;
          heights[column] = top;
          break;
        }
      }
    }
    const result = { heights, stamps, serial: ++this.serial };
    this.cache.delete(key);
    this.cache.set(key, result);
    if (this.cache.size > SKY_COLUMN_LIMITS.cachedChunks)
      this.cache.delete(this.cache.keys().next().value);
    this.stats.chunkBuilds++;
    return result;
  }

  ceiling(x, z) {
    x = Math.floor(x);
    z = Math.floor(z);
    const { minY, maxY } = this.spec;
    if (
      !Number.isSafeInteger(x) ||
      !Number.isSafeInteger(z) ||
      !columnLoaded(this.world, x, z) ||
      maxY - minY > SKY_COLUMN_LIMITS.height
    )
      return UNKNOWN_SKY_HEIGHT;
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    const chunk = this.chunk(cx, cz);
    if (chunk)
      return chunk.heights[(z - cz * CHUNK_SIZE) * CHUNK_SIZE + x - cx * CHUNK_SIZE];
    const key = `${x},${z}`;
    if (this.scalars.has(key)) return this.scalars.get(key);
    // A missing reader is unknown, not an all-air legacy world.
    if (
      (!this.world.getCell && !this.world.get) ||
      this.scalars.size >= SKY_COLUMN_LIMITS.scalarColumns
    )
      return UNKNOWN_SKY_HEIGHT;
    let top = minY;
    for (let y = maxY - 1; y >= minY; y--) {
      this.stats.cellReads++;
      const cellTop = this.cellTop(readGeometryCell(this.world, x, y, z), x, y, z);
      if (cellTop === -Infinity) continue;
      top = cellTop;
      break;
    }
    this.scalars.set(key, top);
    this.stats.scalarColumns++;
    return top;
  }

  open(point) {
    if (point.y < this.spec.minY) return false;
    const top = this.ceiling(point.x, point.z);
    return top !== UNKNOWN_SKY_HEIGHT && point.y >= top;
  }

  updateField(position, radius) {
    const r = Number.isFinite(radius)
      ? Math.max(0, Math.min(SKY_COLUMN_LIMITS.renderRadius, Math.floor(radius)))
      : 0;
    const cx = Math.floor(position.x / CHUNK_SIZE);
    const cz = Math.floor(position.z / CHUNK_SIZE);
    const tiles = [];
    for (let z = -r; z <= r; z++)
      for (let x = -r; x <= r; x++)
        tiles.push({ x, z, chunk: this.chunk(cx + x, cz + z) });
    const key = `${cx},${cz}:${r}:${tiles.map((tile) => tile.chunk?.serial ?? 0).join(",")}`;
    if (key === this.fieldKey) {
      this.surfaceLight.update(position, r);
      return;
    }
    this.fieldKey = key;
    this.origin.set((cx - r) * CHUNK_SIZE, (cz - r) * CHUNK_SIZE);
    this.data.fill(UNKNOWN_SKY_HEIGHT);
    for (const { x, z, chunk } of tiles) {
      if (!chunk) continue;
      for (let row = 0; row < CHUNK_SIZE; row++) {
        const offset = ((z + r) * CHUNK_SIZE + row) * this.size + (x + r) * CHUNK_SIZE;
        this.data.set(chunk.heights.subarray(row * CHUNK_SIZE, (row + 1) * CHUNK_SIZE), offset);
      }
    }
    this.texture.needsUpdate = true;
    this.surfaceLight.update(position, r);
  }

  dispose() {
    this.cache.clear();
    this.scalars.clear();
    this.texture.dispose();
    this.surfaceLight.dispose();
  }
}
