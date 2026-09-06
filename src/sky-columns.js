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
import { LIGHT_MAX_RADIUS, lightLayout } from "./light-page-layout.js";
import { lightWorkBudget } from "./light-work-budget.js";
import { SurfaceLightRevisions } from "./surface-light-revisions.js";
import { SurfaceDaylight } from "./surface-daylight.js";
import { CHUNK_SIZE } from "./terrain.js";
import { checkedLightTransfer } from "./light-transfer.js";

export const SKY_COLUMN_LIMITS = Object.freeze({
  cachedChunks: lightLayout(LIGHT_MAX_RADIUS).spareChunks,
  scalarColumns: 256,
  renderRadius: LIGHT_MAX_RADIUS,
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
  constructor(radius = 4) {
    this.cache = new Map();
    this.scalars = new Map();
    this.revisions = new SurfaceLightRevisions();
    this.serial = 0;
    this.origin = new THREE.Vector2();
    this.requests = new Map();
    this.clock = this.requestTurn = 0;
    this.setRadius(radius);
    this.surfaceLight = new SurfaceDaylight(this, SKY_COLUMN_LIMITS);
  }

  setRadius(radius) {
    const layout = lightLayout(radius);
    if (this.layout?.radius === radius) return;
    this.layout = layout;
    this.texture?.dispose();
    this.size = (layout.tiles + 2) * CHUNK_SIZE;
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
    this.texture.source.dataReady = false;
    this.texture.needsUpdate = true;
    this.staging?.dispose();
    this.staging = new THREE.DataTexture(null, 16, 16, THREE.RedFormat, THREE.FloatType);
    this.skyUploaded = Array(layout.sourceChunks).fill(null);
    this.skyCopied = Array(layout.sourceChunks).fill(null);
    this.skyOwners = Array(layout.sourceChunks).fill(null);
    this.skyUploads = new Map();
    this.fieldKey = null;
    while (this.cache.size > layout.spareChunks)
      this.cache.delete(this.cache.keys().next().value);
    this.surfaceLight?.setRadius(radius);
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
      this.revisions = new SurfaceLightRevisions();
      this.requests.clear();
      this.job = null;
      this.skyUploaded.fill(null);
      this.skyCopied.fill(null);
      this.skyOwners.fill(null);
      this.skyUploads.clear();
      this.fieldKey = null;
    }
    this.world = world;
    this.epoch = geometryEpoch(world);
    this.dimension = world.dimension;
    this.generator = world.generator;
    this.spec = spec;
    this.revisions.begin(world);
    // Legacy scalar readers do not have incarnation/revision identities.
    this.scalars.clear();
    this.stats = { chunkBuilds: 0, cellReads: 0, scalarColumns: 0 };
    this.clock++;
    this.work = lightWorkBudget();
    this.surfaceWork = lightWorkBudget();
    this.topologyWork = lightWorkBudget();
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

  chunkStamp(cx, cz) {
    const world = this.world;
    const key = `${cx},${cz}`;
    const chunk = world.chunks?.get(key);
    const { minY, maxY } = this.spec;
    if (
      !chunk?.blocks ||
      !columnLoaded(world, cx * 16, cz * 16) ||
      maxY - minY > SKY_COLUMN_LIMITS.height ||
      chunk.blocks.length !== (maxY - minY) * LAYER
    )
      return null;
    // A neighboring door/stair may change its resolved occlusion without an
    // edit in this column. Eviction/readmission also invalidates that input.
    const stamps = [];
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        stamps.push(this.revisions.token(world, cx + dx, cz + dz));
      }
    return stamps.join("|");
  }

  chunk(cx, cz) {
    const key = `${cx},${cz}`, stamp = this.chunkStamp(cx, cz);
    if (stamp === null) { this.cache.delete(key); this.requests.delete(key); return null; }
    const old = this.cache.get(key);
    if (old?.stamp === stamp) return old;
    const previous = this.requests.get(key);
    this.requests.set(key, { key, cx, cz, stamp, age: previous?.age ?? this.clock, attempt: previous?.attempt ?? 0 });
    return null;
  }

  workChunks(budget) {
    const { minY, maxY } = this.spec;
    while (budget.take()) {
      if (!this.job) {
        let request;
        const distance = (r) => (r.cx - (this.cx ?? r.cx)) ** 2 + (r.cz - (this.cz ?? r.cz)) ** 2;
        for (const candidate of this.requests.values())
          if (!request || candidate.attempt < request.attempt ||
            (candidate.attempt === request.attempt && (candidate.age < request.age ||
              (candidate.age === request.age && distance(candidate) < distance(request))))) request = candidate;
        if (!request) break;
        request.attempt = ++this.requestTurn;
        this.job = { ...request, heights: new Float32Array(LAYER).fill(minY), column: 0, y: maxY - 1 };
      }
      const job = this.job, chunk = this.world.chunks.get(job.key);
      if (!chunk || this.requests.get(job.key)?.stamp !== job.stamp) {
        // A continuously changing column must not monopolize the resumable
        // scanner. Stable required columns behind it retain their queue turn.
        const request = this.requests.get(job.key);
        this.requests.delete(job.key);
        if (chunk && request) this.requests.set(job.key, request);
        this.job = null;
        continue;
      }
      const index = (job.y - minY) * LAYER + job.column, id = chunk.blocks[index];
      this.stats.cellReads++;
      let top = -Infinity;
      if (id !== BLOCK.AIR) top = this.cellTop(opaqueCube[id] ? { id } : readChunkCell(chunk, index),
        job.cx * 16 + job.column % 16, job.y, job.cz * 16 + Math.floor(job.column / 16));
      if (top !== -Infinity || job.y === minY) {
        if (top !== -Infinity) job.heights[job.column] = top;
        job.column++; job.y = maxY - 1;
      } else job.y--;
      if (job.column !== LAYER) continue;
      if (this.chunkStamp(job.cx, job.cz) === job.stamp) {
        this.cache.set(job.key, { heights: job.heights, stamp: job.stamp,
          complete: job.stamp.split("|").every((token) => token !== "0"), serial: ++this.serial });
        this.requests.delete(job.key);
        this.stats.chunkBuilds++;
      }
      this.job = null;
    }
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
      return chunk.complete ? chunk.heights[(z - cz * CHUNK_SIZE) * CHUNK_SIZE + x - cx * CHUNK_SIZE] : UNKNOWN_SKY_HEIGHT;
    if (this.world.chunks?.has(`${cx},${cz}`)) return UNKNOWN_SKY_HEIGHT;
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
    this.setRadius(r);
    const cx = Math.floor(position.x / CHUNK_SIZE);
    const cz = Math.floor(position.z / CHUNK_SIZE);
    this.cx = cx; this.cz = cz;
    this.origin.set((cx - r - 1) * CHUNK_SIZE, (cz - r - 1) * CHUNK_SIZE);
    for (const [key, request] of this.requests)
      if (Math.abs(request.cx - cx) > r + 2 || Math.abs(request.cz - cz) > r + 2) this.requests.delete(key);
    for (const key of this.cache.keys()) {
      const [x, z] = key.split(",").map(Number);
      if (Math.abs(x - cx) > r + 2 || Math.abs(z - cz) > r + 2) this.cache.delete(key);
    }
    const tiles = [];
    for (let z = cz - r - 1; z <= cz + r + 1; z++)
      for (let x = cx - r - 1; x <= cx + r + 1; x++) {
        const key = `${x},${z}`, slot = this.skySlot(x, z), entry = this.chunk(x, z);
        tiles.push({ x, z, key, slot });
        const stamp = entry ? `${key}:${entry.serial}` : null;
        if (this.skyOwners[slot] !== key || this.skyUploaded[slot] !== stamp) {
          this.surfaceLight.store.setAuxiliary(this.skyIndex(slot), 0);
          this.skyOwners[slot] = key;
          this.skyUploaded[slot] = null;
          this.skyUploads.delete(slot);
        }
      }
    this.workChunks(this.work);
    for (const { x, z, key, slot } of tiles) {
      const entry = this.cache.get(key);
      if (!entry?.complete || this.requests.has(key)) continue;
      const stamp = `${key}:${entry.serial}`;
      if (this.skyUploaded[slot] !== stamp) this.skyUploads.set(slot, { x, z, key, entry, stamp });
      if (this.skyCopied[slot] !== stamp) {
        for (let row = 0; row < 16; row++)
          this.data.set(entry.heights.subarray(row * 16, row * 16 + 16),
            (Math.floor(slot / (this.layout.tiles + 2)) * 16 + row) * this.size + slot % (this.layout.tiles + 2) * 16);
        this.skyCopied[slot] = stamp;
      }
    }
    this.surfaceLight.update(position, r);
    // Scalar sky queries may retain columns in the outer cache ring (r + 2).
    // Keep their one-cell shape-neighbor identities too, otherwise pruning
    // regenerates a dependency stamp each frame and restarts their scan.
    // This retains metadata only; receiver/source coverage and admission stay
    // r / r + 1, with r + 2 geometry dependencies.
    this.revisions.prune(cx, cz, r + 3);
    this.pending = this.requests.size + this.skyUploads.size;
  }

  skySlot(x, z) {
    const n = this.layout.tiles + 2, mod = (v) => ((v % n) + n) % n;
    return mod(z) * n + mod(x);
  }

  skyIndex(slot) {
    const store = this.surfaceLight.store;
    return store.sections * store.tableColumns + slot;
  }

  flush(renderer, budget) {
    this.transferFailed = true;
    const store = this.surfaceLight.store;
    store.flushInvalidations(renderer, budget);
    const published = [];
    for (const [slot, upload] of this.skyUploads) {
      if (published.length === 4) break;
      if (budget.bytes < 1024 + store.mapping.byteLength || budget.copies < 2) break;
      if (!upload.entry.complete || this.skyOwners[slot] !== upload.key || this.cache.get(upload.key) !== upload.entry ||
        this.requests.has(upload.key)) { this.skyUploads.delete(slot); continue; }
      this.staging.image.data = upload.entry.heights;
      const n = this.layout.tiles + 2;
      budget.bytes -= 1024; budget.copies--; budget.uploadedBytes += 1024;
      try {
        checkedLightTransfer(renderer, "sky data", () => renderer.copyTextureToTexture(this.staging, this.texture, null,
          new THREE.Vector2(slot % n * 16, Math.floor(slot / n) * 16)));
      } finally {
        this.staging.image.data = null;
      }
      published.push([slot, upload]);
    }
    if (published.length) {
      store.publishAuxiliary(renderer, budget, published.map(([slot]) => [this.skyIndex(slot), 1]));
      for (const [slot, upload] of published) {
        this.skyUploaded[slot] = upload.stamp;
        this.skyUploads.delete(slot);
      }
    }
    this.transferFailed = false;
  }

  restoreGPU() {
    this.texture.dispose();
    this.texture = new THREE.DataTexture(this.data, this.size, this.size, THREE.RedFormat, THREE.FloatType);
    this.texture.source.dataReady = false;
    this.texture.needsUpdate = true;
    this.skyUploaded.fill(null);
    this.surfaceLight.restoreGPU();
    // Retained verified ceilings republish through the ordinary budget.
    for (const [key, entry] of this.cache) {
      const [x, z] = key.split(",").map(Number), slot = this.skySlot(x, z);
      if (entry.complete && this.skyOwners[slot] === key && !this.requests.has(key))
        this.skyUploads.set(slot, { x, z, key, entry, stamp: `${key}:${entry.serial}` });
    }
  }

  resources() {
    if (this.disposed) return { gpuBytes: 0, mirrorBytes: 0, cacheBytes: 0, scratchBytes: 0,
      requiredColumns: 0, readyColumns: 0, pendingRequired: 0, pendingCompute: 0, pendingUploads: 0 };
    const readyColumns = this.transferFailed || this.surfaceLight.store.mappingDirty ? 0 :
      this.skyUploaded.reduce((n, stamp) => n + Number(stamp !== null), 0);
    return { gpuBytes: this.data.byteLength, mirrorBytes: this.data.byteLength,
      cacheBytes: [...this.cache.values()].reduce((n, entry) => n + entry.heights.byteLength, 0),
      scratchBytes: this.job?.heights.byteLength ?? 0, requiredColumns: this.layout.sourceChunks,
      readyColumns, pendingRequired: this.layout.sourceChunks - readyColumns,
      pendingCompute: this.requests.size, pendingUploads: this.skyUploads.size };
  }

  observeMutation(world, event) {
    if (world === this.world) this.revisions.observe(world, event);
  }

  dispose() {
    this.disposed = true;
    this.cache.clear();
    this.scalars.clear();
    this.requests.clear();
    this.skyUploads.clear();
    this.job = null;
    this.world = null;
    this.revisions = new SurfaceLightRevisions();
    this.texture.dispose();
    this.staging.dispose();
    this.texture.image.data = this.staging.image.data = null;
    this.data = new Float32Array(0);
    this.skyUploaded = this.skyCopied = this.skyOwners = [];
    this.pending = 0;
    this.surfaceLight.dispose();
  }
}
