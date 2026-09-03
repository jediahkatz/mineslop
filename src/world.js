import { BLOCK, BLOCKS, isSolid } from "./blocks.js";
import { cellAfterBreaking, FLUID } from "./block-state.js";
import {
  cellIndex,
  chunkKey,
  cloneChunkData,
  normalizeChunkPacket,
  normalizeGeneratedChunk,
  prepareChunkWrites,
  publishChunkWrites,
  readChunkCell,
  sectionKey,
} from "./chunk-data.js";
import { spawnStandingHeight } from "./spawn-support.js";
import { TransactionCoordinator } from "./transactions.js";
import {
  CHUNK_SIZE,
  createGenerator,
  GENERATOR_VERSION,
  WATER_LEVEL,
  WORLD_HEIGHT,
  WORLD_MAX,
  WORLD_MIN,
} from "./terrain.js";
import {
  cellEditTuple,
  createEditState,
  editChunkKey,
  normalizeWorldSave,
} from "./world-edits.js";
import {
  isWorldMutation,
  prepareLegacySet,
  prepareWorldMutation,
} from "./world-mutations.js";
import { getWorldSpec, inColumnBounds, inWorldBounds } from "./world-spec.js";

export { CHUNK_SIZE, WATER_LEVEL, WORLD_HEIGHT, WORLD_MAX, WORLD_MIN };
export { raycast } from "./raycast.js";

const MAX_RADIUS = 8;
const MAX_CHUNKS = (2 * (MAX_RADIUS + 2) + 1) ** 2;
const MAX_IN_FLIGHT = 2;
const WORKER_TIMEOUT = 15000;
const MAX_ADMISSION_OBSERVER_ERRORS = 16;

function abortError(message = "World loading was cancelled") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function area(position, radius, padding = 0) {
  if (
    !position ||
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.z) ||
    !inColumnBounds(Math.floor(position.x), Math.floor(position.z)) ||
    !Number.isInteger(radius) ||
    radius < 0 ||
    radius > MAX_RADIUS
  )
    throw new RangeError(
      `Expected an in-bounds position and radius 0–${MAX_RADIUS}`
    );
  const cx = Math.floor(position.x / CHUNK_SIZE);
  const cz = Math.floor(position.z / CHUNK_SIZE);
  const chunks = [];
  const reach = radius + padding;
  for (let z = cz - reach; z <= cz + reach; z++) {
    for (let x = cx - reach; x <= cx + reach; x++) {
      if (inColumnBounds(x * CHUNK_SIZE, z * CHUNK_SIZE)) {
        chunks.push({ cx: x, cz: z, key: chunkKey(x, z) });
      }
    }
  }
  chunks.sort(
    (a, b) =>
      (a.cx - cx) ** 2 +
      (a.cz - cz) ** 2 -
      ((b.cx - cx) ** 2 + (b.cz - cz) ** 2)
  );
  return { cx, cz, radius, chunks };
}

export class World {
  constructor(
    seed = "cedar-valley",
    {
      dimension = "overworld",
      generatorVersion = GENERATOR_VERSION,
      useWorker = true,
      generatorFactory = createGenerator,
      coordinator = new TransactionCoordinator(),
      onMutation,
      onChunkAdmitted,
    } = {}
  ) {
    this._spec = getWorldSpec(generatorVersion, dimension);
    if (typeof generatorFactory !== "function")
      throw new TypeError("Expected a terrain generator factory");
    this.seed = String(seed).slice(0, 80);
    this.dimension = dimension;
    this.generatorVersion = generatorVersion;
    // Constructor, dimension changes and explicit saved-version loads use the
    // same factory. Its default stays historical; opting into v4 is deliberate.
    this._generatorFactory = generatorFactory;
    this.generator = generatorFactory(this.seed, dimension, generatorVersion);
    this.chunks = new Map();
    this.dirtyChunks = new Set();
    this.dirtySectionRevisions = new Map();
    this.removedChunks = new Set();
    this.edits = new Map();
    this._editsByChunk = new Map();
    this._editRecordBytes = new Map();
    this._editBytes = 0;
    this._editRevision = 0;
    this._requests = new Map();
    this._inFlight = new Map();
    this._pins = new Map();
    this._streamWanted = new Set();
    this._focus = null;
    this._epoch = 0;
    this._nextIncarnation = 0;
    this._nextDirtyTicket = 0;
    this._nextRequestId = 0;
    this._worker = null;
    // Functions cannot cross the worker boundary. Worker helper fixtures can
    // inject the same factory explicitly in handleTerrainRequest instead.
    this._workerDisabled = !useWorker || generatorFactory !== createGenerator;
    this._scheduled = null;
    this._disposed = false;
    this.coordinator = coordinator;
    this.onMutation = onMutation;
    this.onChunkAdmitted = onChunkAdmitted;
    this._admissionObserverErrors = [];
    if (coordinator.register(this, 0) === false)
      throw new RangeError("Unable to reserve world save capacity");
  }

  get spec() {
    return this._spec;
  }

  get epoch() {
    return this._epoch;
  }

  /** Last sixteen failures; identity metadata does not retain chunk payloads. */
  get admissionObserverErrors() {
    return this._admissionObserverErrors.slice();
  }

  get minY() {
    return this._spec.minY;
  }

  get maxY() {
    return this._spec.maxY;
  }

  generate(radius = 2) {
    if (this._disposed) throw abortError("World is disposed");
    const target = area(this.generator.getSpawn(), radius);
    this._focus = { ...target, radius: radius + 2 };
    this._streamWanted = new Set(target.chunks.map(({ key }) => key));
    this._cancelUnwanted();
    for (const { cx, cz } of target.chunks) this._generateSync(cx, cz);
    this._trimCache();
    return this;
  }

  async ensureArea(position, radius = 2) {
    if (this._disposed) throw abortError("World is disposed");
    const target = area(position, radius);
    const pins = new Set([
      ...this._pins.keys(),
      ...target.chunks.map((chunk) => chunk.key),
    ]);
    const missing = target.chunks.filter(
      ({ key }) => !this.chunks.has(key) && !this._requests.has(key)
    );
    if (
      pins.size > MAX_CHUNKS ||
      this._requests.size + missing.length > MAX_CHUNKS
    )
      throw new RangeError("Too many concurrent chunk loads");
    const epoch = this._epoch;
    this._focus = { ...target, radius: radius + 2 };
    for (const { key } of target.chunks)
      this._pins.set(key, (this._pins.get(key) ?? 0) + 1);
    try {
      await Promise.all(
        target.chunks.map(({ cx, cz }) => this._requestChunk(cx, cz))
      );
      if (epoch !== this._epoch || this._disposed) throw abortError();
      return this;
    } finally {
      // An old dimension's finally must not unpin a new request with the same key.
      if (epoch === this._epoch) {
        for (const { key } of target.chunks) {
          const count = this._pins.get(key) - 1;
          if (count > 0) this._pins.set(key, count);
          else this._pins.delete(key);
        }
      }
    }
  }

  updateStreaming(position, radius = 3) {
    if (this._disposed) return this;
    const target = area(position, radius, 1);
    this._focus = { ...target, radius: radius + 2 };
    this._streamWanted = new Set(target.chunks.map(({ key }) => key));
    this._cancelUnwanted();
    for (const { cx, cz, key } of target.chunks) {
      if (this._requests.size >= MAX_CHUNKS && !this._requests.has(key)) break;
      this._requestChunk(cx, cz);
    }
    this._trimCache();
    return this;
  }

  get(x, y, z) {
    if (!inWorldBounds(x, y, z, this.spec)) return BLOCK.AIR;
    const chunk = this.chunks.get(
      chunkKey(Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE))
    );
    return chunk ? chunk.blocks[cellIndex(x, y, z, this.spec)] : BLOCK.AIR;
  }

  getCell(x, y, z) {
    if (!inWorldBounds(x, y, z, this.spec)) return null;
    const chunk = this.chunks.get(
      chunkKey(Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE))
    );
    return chunk ? readChunkCell(chunk, cellIndex(x, y, z, this.spec)) : null;
  }

  getBlockState(x, y, z) {
    return this.getCell(x, y, z)?.state ?? 0;
  }

  getFluid(x, y, z) {
    return this.getCell(x, y, z)?.fluid ?? FLUID.NONE;
  }

  isLoaded(x, z) {
    return (
      Number.isFinite(x) &&
      Number.isFinite(z) &&
      inColumnBounds(Math.floor(x), Math.floor(z)) &&
      this.chunks.has(
        chunkKey(Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE))
      )
    );
  }

  set(x, y, z, id) {
    return this.commitMutation(prepareLegacySet(this, x, y, z, id));
  }

  prepareMutation(changes, options = {}) {
    return prepareWorldMutation(this, changes, options);
  }

  commitMutation(plan) {
    return (
      isWorldMutation(this, plan) && this.coordinator.commit([plan]).ok === true
    );
  }

  applyCells(changes, options = {}) {
    return this.commitMutation(this.prepareMutation(changes, options));
  }

  breakCell(x, y, z, options = {}) {
    const before = this.getCell(x, y, z);
    return (
      before !== null &&
      this.applyCells(
        [{ x, y, z, before, after: cellAfterBreaking(before) }],
        options
      )
    );
  }

  markDirty(x, z) {
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    const localX = x - cx * CHUNK_SIZE;
    const localZ = z - cz * CHUNK_SIZE;
    const xs = [cx];
    const zs = [cz];
    if (localX === 0) xs.push(cx - 1);
    if (localX === CHUNK_SIZE - 1) xs.push(cx + 1);
    if (localZ === 0) zs.push(cz - 1);
    if (localZ === CHUNK_SIZE - 1) zs.push(cz + 1);
    for (const x of xs) {
      for (const z of zs) {
        this._dirtyColumn(x, z);
      }
    }
  }

  clearDirty() {
    this.dirtyChunks.clear();
    this.dirtySectionRevisions.clear();
  }

  acknowledgeSectionMesh(cx, cz, sy, ticket) {
    const key = sectionKey(cx, cz, sy);
    if (
      !this.dirtySectionRevisions.has(key) ||
      this.dirtySectionRevisions.get(key) !== ticket
    )
      return false;
    this.dirtySectionRevisions.delete(key);
    const column = chunkKey(cx, cz);
    for (let y = Math.floor(this.minY / 16); y < this.maxY / 16; y++)
      if (this.dirtySectionRevisions.has(sectionKey(cx, cz, y))) return true;
    this.dirtyChunks.delete(column);
    return true;
  }

  isSolid(x, y, z) {
    return isSolid(this.get(x, y, z));
  }

  heightAt(x, z) {
    return this.surfaceYAt(x, z) ?? -1;
  }

  surfaceYAt(x, z) {
    if (!inColumnBounds(x, z) || !this.isLoaded(x, z)) return null;
    for (let y = this.maxY - 1; y >= this.minY; y--) {
      const id = this.get(x, y, z);
      if (
        isSolid(id) &&
        BLOCKS[id].texture !== "leaves" &&
        !(BLOCKS[id].texture === "log" && BLOCKS[id].tool === "axe")
      )
        return y;
    }
    return null;
  }

  getSpawn() {
    if (this._disposed) throw abortError("World is disposed");
    const approximate = this.generator.getSpawn();
    const target = area(approximate, 1);
    this._focus = { ...target, radius: 3 };
    for (const { cx, cz } of target.chunks) this._generateSync(cx, cz);
    const centerX = Math.floor(approximate.x);
    const centerZ = Math.floor(approximate.z);
    // Centered feet fit inside one column. Shared geometry checks exact support
    // and full-body clearance, including foliage and placed ceilings.
    for (let radius = 0; radius <= CHUNK_SIZE; radius++) {
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
          const x = centerX + dx;
          const z = centerZ + dz;
          if (!this.isLoaded(x, z)) continue;
          const y = this._spawnHeight(x, z, approximate.y);
          if (y !== null) return { x: x + 0.5, y, z: z + 0.5 };
        }
      }
    }
    throw new Error("No safe spawn found near the terrain spawn");
  }

  _spawnHeight(x, z, preferredY) {
    return spawnStandingHeight(this, x, z, preferredY);
  }

  getBiome(x, z, y) {
    return this.generator.getBiome(x, z, y);
  }

  locateBiome(id, from) {
    return this.generator.locateBiome(id, from);
  }

  setDimension(dimension) {
    const spec = getWorldSpec(this.generatorVersion, dimension);
    if (this._disposed) throw abortError("World is disposed");
    if (dimension === this.dimension) return this;
    const generator = this._generatorFactory(
      this.seed,
      dimension,
      this.generatorVersion
    );
    this._resetChunks();
    this.dimension = dimension;
    this._spec = spec;
    this.generator = generator;
    return this;
  }

  serialize() {
    const edits = [];
    for (const [key, cell] of this.edits) {
      const [dimension, position] = key.split(":");
      edits.push(
        cellEditTuple(dimension, ...position.split(",").map(Number), cell)
      );
    }
    return {
      version: 3,
      generatorVersion: this.generatorVersion,
      seed: this.seed,
      dimension: this.dimension,
      edits,
    };
  }

  loadEdits(data) {
    if (this._disposed) return false;
    let saved, state, generator, spec;
    const staged = [];
    try {
      saved = normalizeWorldSave(data, { expectedSeed: this.seed });
      spec = getWorldSpec(saved.generatorVersion, saved.dimension);
      state = createEditState(saved);
      const sameGenerator =
        saved.dimension === this.dimension &&
        saved.generatorVersion === this.generatorVersion;
      generator = sameGenerator
        ? this.generator
        : this._generatorFactory(
            this.seed,
            saved.dimension,
            saved.generatorVersion
          );
      if (saved.dimension === this.dimension) {
        for (const previous of this.chunks.values()) {
          const { cx, cz } = previous;
          const chunk = sameGenerator
            ? cloneChunkData(previous)
            : normalizeGeneratedChunk(generator.generateChunk(cx, cz), {
                id: 0,
                epoch: this.epoch + 1,
                seed: this.seed,
                dimension: saved.dimension,
                generatorVersion: saved.generatorVersion,
                cx,
                cz,
              });
          if (sameGenerator) {
            const originals = [...previous.originals].map(([at, cell]) => ({
              at,
              cell,
            }));
            publishChunkWrites(chunk, prepareChunkWrites(chunk, originals));
          }
          this._applyEdits(chunk, state.byChunk, saved.dimension);
          staged.push(chunk);
        }
      }
      // Valid larger imports can be adopted, but subsequent consuming edits
      // remain constrained by the same shared reservation as every other owner.
      if (
        this.coordinator.register(this, state.bytes, {
          allowOverBudget: true,
        }) === false
      )
        return false;
    } catch {
      return false;
    }
    const focus = saved.dimension === this.dimension ? this._focus : null;
    this._resetChunks();
    this._focus = focus;
    this.dimension = saved.dimension;
    this.generatorVersion = saved.generatorVersion;
    this._spec = spec;
    this.generator = generator;
    this.edits = state.edits;
    this._editsByChunk = state.byChunk;
    this._editRecordBytes = state.recordBytes;
    this._editBytes = state.bytes;
    this._editRevision++;
    const epoch = this.epoch;
    // Publish the entire replacement before observers may re-enter generation.
    const admissions = staged.map((chunk) => this._admitChunk(chunk, false));
    for (const event of admissions) this._notifyChunkAdmitted(event);
    if (!this._disposed && this.epoch === epoch) this._trimCache();
    return true;
  }

  _applyEdits(chunk, byChunk = this._editsByChunk, dimension = this.dimension) {
    chunk.originals = new Map();
    const edits = byChunk.get(editChunkKey(dimension, chunk.cx, chunk.cz));
    const writes = [];
    for (const [at, cell] of edits ?? []) {
      const original = readChunkCell(chunk, at);
      if (original.id === BLOCK.BEDROCK) continue;
      chunk.originals.set(at, Object.freeze(original));
      writes.push({ at, cell });
    }
    publishChunkWrites(chunk, prepareChunkWrites(chunk, writes));
  }

  _storeChunk(chunk) {
    this._applyEdits(chunk);
    const event = this._admitChunk(chunk);
    if (this._isCurrentAdmission(event)) this._trimCache();
    return chunk;
  }

  _admitChunk(chunk, notify = true) {
    chunk.incarnation = ++this._nextIncarnation;
    chunk.revision = 0;
    chunk.sectionRevisions = new Map();
    for (let sy = Math.floor(this.minY / 16); sy < this.maxY / 16; sy++)
      chunk.sectionRevisions.set(sy, 0);
    const key = chunkKey(chunk.cx, chunk.cz);
    this.chunks.set(key, chunk);
    this._dirtyNeighbors(chunk.cx, chunk.cz);
    const event = Object.freeze({
      world: this,
      seed: this.seed,
      dimension: this.dimension,
      generatorVersion: this.generatorVersion,
      epoch: this.epoch,
      key,
      cx: chunk.cx,
      cz: chunk.cz,
      incarnation: chunk.incarnation,
      revision: chunk.revision,
      chunk,
    });
    if (notify) this._notifyChunkAdmitted(event);
    return event;
  }

  _isCurrentAdmission(event) {
    return (
      !this._disposed &&
      event.world === this &&
      event.epoch === this.epoch &&
      this.chunks.get(event.key) === event.chunk &&
      event.chunk.incarnation === event.incarnation
    );
  }

  /**
   * Explicit synchronous observation, like onMutation; no subscriptions/replay.
   * The frozen envelope captures identity, but chunk is a borrowed live resident:
   * consumers must not mutate its buffers and must recheck epoch/incarnation
   * before deferred work. Return values cannot veto admission or request retries.
   */
  _notifyChunkAdmitted(event) {
    if (!this._isCurrentAdmission(event)) return;
    try {
      const notify = this.onChunkAdmitted;
      if (notify === undefined || notify === null) return;
      if (
        typeof notify !== "function" ||
        Object.prototype.toString.call(notify) !== "[object Function]"
      )
        throw new TypeError("Chunk admission observers must be synchronous");
      const result = Reflect.apply(notify, this, [event]);
      if (
        result !== null &&
        (typeof result === "object" || typeof result === "function") &&
        typeof result.then === "function"
      ) {
        // An invalid returned Promise must not become an unhandled rejection.
        if (result instanceof Promise) result.catch(() => {});
        throw new TypeError("Chunk admission observers must be synchronous");
      }
    } catch (error) {
      this._admissionObserverErrors.push(
        Object.freeze({
          seed: event.seed,
          dimension: event.dimension,
          generatorVersion: event.generatorVersion,
          epoch: event.epoch,
          cx: event.cx,
          cz: event.cz,
          incarnation: event.incarnation,
          error,
        })
      );
      if (this._admissionObserverErrors.length > MAX_ADMISSION_OBSERVER_ERRORS)
        this._admissionObserverErrors.shift();
    }
  }

  _job(cx, cz, id = 0) {
    return {
      id,
      epoch: this.epoch,
      seed: this.seed,
      dimension: this.dimension,
      generatorVersion: this.generatorVersion,
      minY: this.minY,
      maxY: this.maxY,
      cx,
      cz,
    };
  }

  _generateSync(cx, cz) {
    if (this._disposed) throw abortError("World is disposed");
    const epoch = this.epoch;
    const key = chunkKey(cx, cz);
    let chunk = this.chunks.get(key);
    if (!chunk)
      chunk = this._storeChunk(
        normalizeGeneratedChunk(
          this.generator.generateChunk(cx, cz),
          this._job(cx, cz)
        )
      );
    if (
      this._disposed ||
      this.epoch !== epoch ||
      this.chunks.get(key) !== chunk
    )
      throw abortError();
    const request = this._requests.get(key);
    if (request && !this._inFlight.has(request.id))
      this._finish(request, chunk);
    return chunk;
  }

  _requestChunk(cx, cz) {
    const key = chunkKey(cx, cz);
    if (this.chunks.has(key)) return Promise.resolve(this.chunks.get(key));
    if (this._requests.has(key)) return this._requests.get(key).promise;
    let resolve, reject;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Streaming is fire-and-forget; explicit ensureArea callers still receive rejection.
    promise.catch(() => {});
    this._requests.set(key, {
      ...this._job(cx, cz, ++this._nextRequestId),
      key,
      promise,
      resolve,
      reject,
      timer: null,
    });
    this._schedule();
    return promise;
  }

  _schedule() {
    if (this._disposed || this._scheduled !== null || this._requests.size === 0)
      return;
    this._scheduled = setTimeout(() => {
      this._scheduled = null;
      this._pump();
    }, 0);
  }

  _nextQueued() {
    const { cx = 0, cz = 0 } = this._focus ?? {};
    return [...this._requests.values()]
      .filter((request) => !this._inFlight.has(request.id))
      .sort(
        (a, b) =>
          Number(this._pins.has(b.key)) - Number(this._pins.has(a.key)) ||
          (a.cx - cx) ** 2 +
            (a.cz - cz) ** 2 -
            ((b.cx - cx) ** 2 + (b.cz - cz) ** 2)
      )[0];
  }

  _pump() {
    if (this._disposed) return;
    this._cancelUnwanted();
    if (!this._nextQueued()) return;
    const worker = this._getWorker();
    if (worker) {
      while (
        worker === this._worker &&
        !this._disposed &&
        this._inFlight.size < MAX_IN_FLIGHT
      ) {
        const request = this._nextQueued();
        if (!request) break;
        this._inFlight.set(request.id, request);
        request.timer = setTimeout(
          () => this._failWorker(worker),
          WORKER_TIMEOUT
        );
        try {
          worker.postMessage({
            type: "generate",
            schemaVersion: 2,
            id: request.id,
            epoch: request.epoch,
            seed: request.seed,
            dimension: request.dimension,
            generatorVersion: request.generatorVersion,
            minY: request.minY,
            maxY: request.maxY,
            cx: request.cx,
            cz: request.cz,
          });
        } catch {
          this._failWorker(worker);
          break;
        }
      }
    } else {
      // One chunk per task keeps updateStreaming nonblocking without Worker support.
      const request = this._nextQueued();
      try {
        this._finish(
          request,
          normalizeGeneratedChunk(
            this.generator.generateChunk(request.cx, request.cz),
            request
          )
        );
      } catch (error) {
        this._finish(request, null, error);
      }
    }
  }

  _getWorker() {
    if (this._workerDisabled || typeof globalThis.Worker !== "function")
      return null;
    if (this._worker) return this._worker;
    try {
      const worker = new Worker(
        new URL("./terrain.worker.js", import.meta.url),
        {
          type: "module",
        }
      );
      this._worker = worker;
      worker.onmessage = ({ data }) => {
        if (worker !== this._worker || this._disposed) return;
        const request = this._inFlight.get(data?.id);
        if (!request || data.epoch !== this._epoch) return;
        if (data.type === "error") return this._failWorker(worker);
        let chunk;
        try {
          chunk = normalizeChunkPacket(data, request);
        } catch {
          return this._failWorker(worker);
        }
        this._finish(request, chunk);
      };
      worker.onerror = (event) => {
        event.preventDefault?.();
        this._failWorker(worker);
      };
      worker.onmessageerror = () => this._failWorker(worker);
      return worker;
    } catch {
      this._workerDisabled = true;
      return null;
    }
  }

  _failWorker(worker) {
    if (worker !== this._worker) return;
    worker.terminate();
    this._worker = null;
    this._workerDisabled = true;
    for (const request of this._inFlight.values()) clearTimeout(request.timer);
    this._inFlight.clear();
    this._cancelUnwanted();
    this._schedule();
  }

  _finish(request, chunk, error) {
    if (this._requests.get(request.key) !== request) return;
    clearTimeout(request.timer);
    this._inFlight.delete(request.id);
    this._requests.delete(request.key);
    if (request.epoch !== this._epoch || this._disposed) {
      request.reject(abortError());
    } else if (error) {
      request.reject(error);
    } else if (
      !this._pins.has(request.key) &&
      !this._streamWanted.has(request.key)
    ) {
      request.reject(abortError());
    } else {
      try {
        const loaded = this.chunks.get(request.key) ?? this._storeChunk(chunk);
        if (
          this._disposed ||
          request.epoch !== this.epoch ||
          this.chunks.get(request.key) !== loaded
        )
          request.reject(abortError());
        else request.resolve(loaded);
      } catch (failure) {
        request.reject(failure);
      }
    }
    if (this._nextQueued()) this._schedule();
  }

  _cancelUnwanted() {
    for (const request of this._requests.values()) {
      if (
        !this._pins.has(request.key) &&
        !this._streamWanted.has(request.key) &&
        !this._inFlight.has(request.id)
      ) {
        this._requests.delete(request.key);
        request.reject(abortError());
      }
    }
  }

  _dirtyNeighbors(cx, cz) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        this._dirtyColumn(cx + dx, cz + dz);
      }
    }
  }

  _dirtyColumn(cx, cz) {
    if (!this.chunks.has(chunkKey(cx, cz))) return;
    for (let sy = Math.floor(this.minY / 16); sy < this.maxY / 16; sy++)
      this._markSectionDirty(cx, cz, sy);
  }

  _markSectionDirty(cx, cz, sy) {
    const column = chunkKey(cx, cz);
    if (
      !this.chunks.has(column) ||
      sy < Math.floor(this.minY / 16) ||
      sy >= this.maxY / 16
    )
      return;
    this.dirtyChunks.add(column);
    this.dirtySectionRevisions.set(
      sectionKey(cx, cz, sy),
      ++this._nextDirtyTicket
    );
  }

  _cellDirtySections(changes) {
    const sections = new Map();
    for (const { x, y, z } of changes) {
      // A two-cell apron covers derived neighbor shapes, corner AO and seams.
      for (
        let cx = Math.floor((x - 2) / CHUNK_SIZE);
        cx <= Math.floor((x + 2) / CHUNK_SIZE);
        cx++
      )
        for (
          let cz = Math.floor((z - 2) / CHUNK_SIZE);
          cz <= Math.floor((z + 2) / CHUNK_SIZE);
          cz++
        )
          for (
            let sy = Math.floor((y - 2) / CHUNK_SIZE);
            sy <= Math.floor((y + 2) / CHUNK_SIZE);
            sy++
          )
            sections.set(sectionKey(cx, cz, sy), { cx, cz, sy });
    }
    return sections;
  }

  _markSectionsDirty(sections) {
    for (const { cx, cz, sy } of sections.values())
      this._markSectionDirty(cx, cz, sy);
  }

  _removeChunk(key, chunk) {
    this.chunks.delete(key);
    this.dirtyChunks.delete(key);
    for (const sy of chunk.sectionRevisions.keys())
      this.dirtySectionRevisions.delete(sectionKey(chunk.cx, chunk.cz, sy));
    this.removedChunks.add(key);
    this._dirtyNeighbors(chunk.cx, chunk.cz);
  }

  _trimCache() {
    const { cx = 0, cz = 0, radius = MAX_RADIUS + 2 } = this._focus ?? {};
    for (const [key, chunk] of this.chunks) {
      if (
        !this._pins.has(key) &&
        Math.max(Math.abs(chunk.cx - cx), Math.abs(chunk.cz - cz)) > radius
      )
        this._removeChunk(key, chunk);
    }
    if (this.chunks.size > MAX_CHUNKS) {
      const unpinned = [...this.chunks.entries()]
        .filter(([key]) => !this._pins.has(key))
        .sort(
          ([, a], [, b]) =>
            (b.cx - cx) ** 2 +
            (b.cz - cz) ** 2 -
            ((a.cx - cx) ** 2 + (a.cz - cz) ** 2)
        );
      for (const [key, chunk] of unpinned) {
        if (this.chunks.size <= MAX_CHUNKS) break;
        this._removeChunk(key, chunk);
      }
    }
  }

  _resetChunks() {
    this._epoch++;
    clearTimeout(this._scheduled);
    this._scheduled = null;
    this._worker?.terminate();
    this._worker = null;
    for (const request of this._requests.values()) {
      clearTimeout(request.timer);
      request.reject(abortError());
    }
    this._requests.clear();
    this._inFlight.clear();
    this._pins.clear();
    this._streamWanted.clear();
    for (const key of this.chunks.keys()) this.removedChunks.add(key);
    this.chunks.clear();
    this.dirtyChunks.clear();
    this.dirtySectionRevisions.clear();
    this._focus = null;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._resetChunks();
    this.onChunkAdmitted = undefined;
    this.coordinator.release(this);
  }
}
