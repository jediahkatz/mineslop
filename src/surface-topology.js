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
    this.attempts = new Map();
    this.turn = 0;
    this.serial = 0;
  }

  setCapacity(topologyChunks) {
    this.limits = { ...this.limits, topologyChunks };
    while (this.cache.size > topologyChunks)
      this.cache.delete(this.cache.keys().next().value);
    this.waiting.clear();
    this.job = null;
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
        pending.push({ x, z, key, stamp, complete: dependencies.every((d) => d !== "0" && d !== undefined),
          identity: `${id}:${incarnation}`, age: first,
          distance: (x - cx) ** 2 + (z - cz) ** 2 });
      }
    const budget = Math.max(0, this.limits.topologyBuilds - stats.surfaceTopologyBuilds);
    // Whole input groups no longer complete synchronously. Least-recently
    // attempted work prevents one repeatedly invalidated near column from
    // starving an older, stable receiver's dependencies.
    pending.sort((a, b) => {
      stats.surfaceQueueComparisons++;
      return (this.attempts.get(a.key) ?? 0) - (this.attempts.get(b.key) ?? 0) ||
        a.age - b.age || a.distance - b.distance || a.z - b.z || a.x - b.x;
    });
    const selected = pending.slice(0, budget);
    const work = this.columns.topologyWork;
    if (this.job && !pending.some((p) => p.key === this.job.target.key && p.stamp === this.job.target.stamp))
      this.job = null;
    // A partial verifier owns its input until completion or dependency change.
    // Do not restart it just because another receiver became nearer.
    const ordered = [...selected].filter((p) => p.key !== this.job?.target.key);
    if (this.job) ordered.unshift(this.job.target);
    for (const job of ordered) {
      if (stats.surfaceTopologyBuilds >= this.limits.topologyBuilds) break;
      if (this.job && this.job.target.key !== job.key) break;
      if (!this.job) {
        this.attempts.set(job.key, ++this.turn);
        const sky = this.columns.chunk(job.x, job.z);
        if (!sky) continue;
        this.job = { target: job, iterator: this.build(job, sky) };
      }
      let result;
      while (work.take()) {
        result = this.job.iterator.next();
        if (result.done) break;
      }
      if (!result?.done) break;
      const entry = result.value;
      this.job = null;
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
    const active = new Set([...entries.keys(), ...pending.map((p) => p.key)]);
    for (const key of this.attempts.keys()) if (!active.has(key)) this.attempts.delete(key);
    return entries;
  }

  *build({ x: cx, z: cz, key, stamp, identity, complete }, sky) {
    const { world, spec } = this.columns;
    let stats = this.columns.stats;
    const depth = Math.ceil(Math.min(spec.maxY, Math.max(spec.minY, ...sky.heights))) - spec.minY;
    const blocked = new Uint32Array(Math.ceil(depth * LAYER / 32));
    for (let i = 0; i < depth * LAYER; i++) {
      yield;
      stats = this.columns.stats;
      const chunk = world.chunks.get(key);
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
    const columns = this.columns;
    const equal = function* (a, b) {
      if (!a || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        yield;
        stats = columns.stats;
        stats.surfaceTopologyComparisons++;
        if (a[i] !== b[i]) return false;
      }
      return true;
    };
    stats.surfaceTopologyBuilds++;
    if (old?.identity === identity && (yield* equal(old.blocked, blocked)) && (yield* equal(old.heights, sky.heights)))
      return { ...old, stamp, complete };
    return { stamp, identity, complete, blocked, heights: sky.heights, depth, serial: ++this.serial };
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
    this.attempts.clear();
    this.job = null;
  }
}
