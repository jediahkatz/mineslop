import { resolveShape } from "./block-shapes.js";
import { BLOCK } from "./blocks.js";
import { readChunkCell } from "./chunk-data.js";
import { readGeometryCell } from "./geometry-world.js";
import { opaqueCube } from "./mesh-palette.js";

const LAYER = 256;

export function prioritizeDaylight(queue, stats) {
  queue.sort((a, b) => {
    stats.surfaceQueueComparisons++;
    return a.age - b.age || a.distance - b.distance || a.z - b.z || a.x - b.x;
  });
}

/**
 * Exact render-only light topology, not a hash of terrain or a world revision.
 * Raw identities/revisions (including the shape-neighbor halo) trigger bounded
 * verification. Equal occlusion bits and ceilings retain their light serial.
 * No entry retains a chunk or its blocks; pending verification is never valid.
 */
export class SurfaceTopology {
  constructor(columns, limits) {
    this.columns = columns;
    this.limits = limits;
    this.cache = new Map();
    this.waiting = new Map();
    this.serial = 0;
  }

  setCapacity(topologyChunks) {
    this.limits = { ...this.limits, topologyChunks };
    while (this.cache.size > topologyChunks)
      this.cache.delete(this.cache.keys().next().value);
    this.waiting.clear();
  }

  update(cx, cz, radius, stamps, age, tileWaiting) {
    const stats = this.columns.stats, entries = new Map(), pending = [], waiting = new Map();
    for (let z = cz - radius - 1; z <= cz + radius + 1; z++)
      for (let x = cx - radius - 1; x <= cx + radius + 1; x++) {
        const key = `${x},${z}`, center = stamps.get(key);
        if (center === "0") {
          this.cache.delete(key);
          entries.set(key, null);
          continue;
        }
        const dependencies = [];
        for (let dz = -1; dz <= 1; dz++)
          for (let dx = -1; dx <= 1; dx++) {
            dependencies.push(stamps.get(`${x + dx},${z + dz}`));
            stats.surfaceDependencyChecks++;
          }
        const stamp = dependencies.join("|"), old = this.cache.get(key);
        if (old?.stamp === stamp) {
          this.cache.delete(key);
          this.cache.set(key, old);
          entries.set(key, old);
          continue;
        }
        const [id, , incarnation] = center.split(":");
        const first = this.waiting.get(key) ?? age;
        waiting.set(key, first);
        pending.push({ x, z, key, stamp, identity: `${id}:${incarnation}`, age: first,
          distance: (x - cx) ** 2 + (z - cz) ** 2 });
      }
    const budget = Math.max(0, this.limits.topologyBuilds - stats.surfaceTopologyBuilds);
    const selected = new Set();
    if (pending.length && budget > 0) {
      const jobs = new Map(pending.map((job) => [job.key, job])), tiles = [];
      for (let z = cz - radius; z <= cz + radius; z++)
        for (let x = cx - radius; x <= cx + radius; x++) {
          const key = `${x},${z}`;
          if (stamps.get(key) !== "0")
            tiles.push({ x, z, age: tileWaiting.get(key) ?? age, distance: (x - cx) ** 2 + (z - cz) ** 2 });
        }
      prioritizeDaylight(tiles, stats);
      // Verify complete input groups for the oldest tiles first. Two groups
      // need at most 18 sources, so continuous changes cannot strand a tile
      // behind independently rotating, only partially verified source halos.
      for (const tile of tiles) {
        const needed = [];
        for (let dz = -1; dz <= 1; dz++)
          for (let dx = -1; dx <= 1; dx++) {
            const job = jobs.get(`${tile.x + dx},${tile.z + dz}`);
            stats.surfaceDependencyChecks++;
            if (job && !selected.has(job)) needed.push(job);
          }
        if (selected.size + needed.length <= budget)
          needed.forEach((job) => selected.add(job));
        if (selected.size === budget) break;
      }
      prioritizeDaylight(pending, stats);
      for (const job of pending) {
        if (selected.size === budget) break;
        selected.add(job);
      }
    }
    for (const job of selected) {
      const entry = this.build(job);
      entries.set(job.key, entry);
      waiting.delete(job.key);
      if (entry) {
        this.cache.delete(job.key);
        this.cache.set(job.key, entry);
        if (this.cache.size > this.limits.topologyChunks)
          this.cache.delete(this.cache.keys().next().value);
      }
    }
    this.waiting = waiting;
    return entries;
  }

  build({ x: cx, z: cz, key, stamp, identity }) {
    const { world, spec, stats } = this.columns;
    stats.surfaceTopologyBuilds++;
    const sky = this.columns.chunk(cx, cz);
    if (!sky) return null;
    const chunk = world.chunks.get(key);
    const depth = Math.ceil(Math.min(spec.maxY, Math.max(spec.minY, ...sky.heights))) - spec.minY;
    const blocked = new Uint32Array(Math.ceil(depth * LAYER / 32));
    for (let i = 0; i < depth * LAYER; i++) {
      const id = chunk.blocks[i];
      stats.surfaceCellReads++;
      if (id === BLOCK.AIR) continue;
      let occludes = opaqueCube[id];
      if (!occludes) {
        const x = cx * 16 + i % 16, y = spec.minY + Math.floor(i / LAYER);
        const z = cz * 16 + Math.floor(i / 16) % 16;
        occludes = resolveShape(readChunkCell(chunk, i), (dx, dy, dz) => {
          stats.surfaceShapeReads++;
          return readGeometryCell(world, x + dx, y + dy, z + dz);
        }).occlusion.length > 0;
      }
      if (occludes) blocked[i >>> 5] |= 1 << (i & 31);
    }
    const old = this.cache.get(key);
    const equal = (a, b) => {
      if (!a || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        stats.surfaceTopologyComparisons++;
        if (a[i] !== b[i]) return false;
      }
      return true;
    };
    if (old?.identity === identity && equal(old.blocked, blocked) && equal(old.heights, sky.heights))
      return { ...old, stamp };
    return { stamp, identity, blocked, heights: sky.heights, depth, serial: ++this.serial };
  }

  resources() {
    let bytes = 0;
    for (const entry of this.cache.values()) bytes += entry.blocked.byteLength + entry.heights.byteLength;
    return { topologyBytes: bytes, topologyChunks: this.cache.size, topologyPending: this.waiting.size,
      topologyLimit: this.limits.topologyChunks };
  }

  clear() {
    this.cache.clear();
    this.waiting.clear();
  }
}
