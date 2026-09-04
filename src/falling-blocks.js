import { isFallingBlock, planFallingBlock } from "./falling-block-rules.js";
import { TransactionInvariantError } from "./transactions.js";
import { inWorldBounds } from "./world-spec.js";

export const FALLING_BLOCK_LIMITS = Object.freeze({
  stepSeconds: 0.1,
  ticksPerUpdate: 2,
  evaluationsPerTick: 64,
  mutationsPerUpdate: 8,
  queuedCells: 4096,
  scanCellsPerUpdate: 512,
  scanVisitsPerUpdate: 32,
  scanJobs: 512,
});
const synchronous = (fn) =>
  typeof fn === "function" &&
  Object.prototype.toString.call(fn) === "[object Function]";
const positionKey = ({ x, y, z }) => `${x},${y},${z}`;
const columnKey = (x, z) => `${Math.floor(x / 16)},${Math.floor(z / 16)}`;
const counters = () => ({
  ticks: 0, evaluated: 0, prepared: 0, moved: 0, rejected: 0, occupied: 0,
  scanCells: 0, scanVisits: 0, observerErrors: 0,
});

/**
 * Real bounded gravity, with every block always owned by World.
 *
 * Wire onMutation(event), onChunkLoaded(residentChunk), update(activeDt).
 * isOccupied([minX,minY,minZ,maxX,maxY,maxZ]) MUST be a read-only player/vehicle
 * swept-AABB query, returning exactly false only when clear. Missing hooks fail
 * closed. canAdvance is rechecked at commit, including after external callbacks.
 * prepareDrops has the same atomic retention contract as FluidSystem.
 *
 * No save sidecar: transient work is reconstructible from saved World cells.
 * Replay current residents after construction/load. Each admission is scanned
 * once incrementally; mutations wake their own cell and the two cells above
 * (including tall fence support). Overflow rescans ONLY that affected resident.
 * Eviction cancels obsolete work; fresh admission rediscovers unsettled blocks.
 * No chunks are generated, no falling item entities exist, no loot is spawned.
 */
export class FallingBlocks {
  constructor(world, { isOccupied, canAdvance = () => true, prepareDrops } = {}) {
    if (!world?.coordinator || !(world.chunks instanceof Map) ||
        !synchronous(world.prepareMutation) || !synchronous(canAdvance) ||
        (isOccupied !== undefined && !synchronous(isOccupied)) ||
        (prepareDrops !== undefined && !synchronous(prepareDrops)))
      throw new TypeError("Invalid falling-block World or synchronous hooks");
    this.world = world;
    this.coordinator = world.coordinator;
    this.isOccupied = isOccupied;
    this.canAdvance = canAdvance;
    this.prepareDrops = prepareDrops;
    this.seed = world.seed;
    this.generatorVersion = world.generatorVersion;
    this._epoch = world.epoch;
    this._queue = new Map();
    this._scans = new Map();
    this._admitted = new WeakSet();
    this._accumulator = 0;
    this._busy = false;
    this._disposed = false;
    this._last = counters();
    if (!this.coordinator.register(this, 0))
      throw new RangeError("Cannot register falling-block transaction guard");
  }

  _current() {
    return !this._disposed && !this.world._disposed &&
      this.world.coordinator === this.coordinator &&
      this.world.seed === this.seed &&
      this.world.generatorVersion === this.generatorVersion &&
      this.coordinator.usage(this) === 0;
  }

  _syncEpoch() {
    if (this._epoch === this.world.epoch) return;
    this._epoch = this.world.epoch;
    this._queue.clear();
    this._scans.clear();
    this._admitted = new WeakSet();
    this._accumulator = 0;
  }

  _resident(entry) {
    return this.world.chunks.get(entry.key) === entry.chunk;
  }

  _scanLater(chunk, restart = false) {
    const key = `${chunk.cx},${chunk.cz}`;
    const previous = this._scans.get(key);
    if (previous?.chunk === chunk) {
      previous.restart ||= restart;
      return;
    }
    if (this._scans.size >= FALLING_BLOCK_LIMITS.scanJobs) {
      // World has <=441 residents (442 transiently during admission). A full
      // job table therefore necessarily contains obsolete resident identities.
      for (const [key, job] of this._scans)
        if (!this._resident(job)) this._scans.delete(key);
    }
    if (this._scans.size >= FALLING_BLOCK_LIMITS.scanJobs)
      throw new RangeError("World exceeds falling-block resident bound");
    this._scans.set(key, { key, chunk, cursor: 0, restart: false });
  }

  _offer(x, y, z, scanning = false) {
    if (!inWorldBounds(x, y, z, this.world.spec)) return true;
    const key = columnKey(x, z);
    const chunk = this.world.chunks.get(key);
    if (!chunk) return true;
    const at = positionKey({ x, y, z });
    if (this._queue.get(at)?.chunk === chunk) return true;
    this._queue.delete(at);
    // Reserve a tick's intake for admission scans. Otherwise a full queue of
    // occupied/refused retries can permanently starve unrelated new terrain.
    const capacity = FALLING_BLOCK_LIMITS.queuedCells -
      (scanning ? 0 : FALLING_BLOCK_LIMITS.evaluationsPerTick);
    if (this._queue.size >= capacity) {
      if (!scanning) this._scanLater(chunk, true);
      return false;
    }
    this._queue.set(at, { x, y, z, key, chunk });
    return true;
  }

  onMutation(event) {
    if (!this._current() || event?.epoch !== this.world.epoch ||
        event?.dimension !== this.world.dimension || !Array.isArray(event.changes))
      return false;
    this._syncEpoch();
    for (const { x, y, z } of event.changes) {
      this._offer(x, y, z);
      this._offer(x, y + 1, z);
      this._offer(x, y + 2, z); // Tall fence/gate support reaches the next cell.
    }
    return true;
  }

  onChunkLoaded(chunk, { priority = false } = {}) {
    if (!this._current() || !chunk ||
        this.world.chunks.get(`${chunk.cx},${chunk.cz}`) !== chunk) return false;
    this._syncEpoch();
    if (this._admitted.has(chunk)) return true;
    this._admitted.add(chunk);
    this._scanLater(chunk);
    if (priority) {
      const key = `${chunk.cx},${chunk.cz}`;
      const job = this._scans.get(key);
      this._scans.delete(key);
      this._scans = new Map([[key, job], ...this._scans]);
    }
    return true;
  }

  _scan(stats) {
    const limits = FALLING_BLOCK_LIMITS;
    while (this._scans.size && stats.scanCells < limits.scanCellsPerUpdate &&
           stats.scanVisits < limits.scanVisitsPerUpdate) {
      const [key, job] = this._scans.entries().next().value;
      stats.scanVisits++;
      if (!this._resident(job)) { this._scans.delete(key); continue; }
      const end = Math.min(job.cursor + 64, job.chunk.blocks.length,
        job.cursor + limits.scanCellsPerUpdate - stats.scanCells);
      let blocked = false;
      while (job.cursor < end) {
        const at = job.cursor;
        stats.scanCells++;
        if (isFallingBlock(job.chunk.blocks[at])) {
          const x = job.chunk.cx * 16 + at % 16;
          const z = job.chunk.cz * 16 + Math.floor(at / 16) % 16;
          const y = this.world.spec.minY + Math.floor(at / 256);
          if (!this._offer(x, y, z, true)) { blocked = true; break; }
        }
        job.cursor++;
      }
      if (job.cursor === job.chunk.blocks.length && job.restart) {
        job.cursor = 0;
        job.restart = false;
        this._scans.delete(key);
        this._scans.set(key, job); // Repeated overflow must yield to other chunks.
      }
      // Finish the earliest admission first (World admits near the player
      // first), rather than delaying every surface behind all loaded columns.
      if (job.cursor === job.chunk.blocks.length) this._scans.delete(key);
      if (blocked) break; // Let the queue drain before attempting more scanning.
    }
  }

  _clear(plan) {
    return this._current() && this.canAdvance() === true &&
      this.isOccupied?.(plan.bounds) === false;
  }

  _move(entry, plan, stats) {
    // Conservative replay is in memory BEFORE commit/notification. Save inside
    // a notification is still safe: all actual mass is already in World.
    for (const { x, y, z } of plan.changes) {
      this._offer(x, y, z);
      this._offer(x, y + 1, z);
    }
    if (!this._clear(plan)) { stats.occupied++; return; }
    // World preparation/notification is substantially costlier than a scalar
    // candidate check. Budget attempted mutations separately, including refusals.
    if (stats.prepared >= FALLING_BLOCK_LIMITS.mutationsPerUpdate) return;
    stats.prepared++;
    const epoch = this.world.epoch;
    const dimension = this.world.dimension;
    const worldPlan = this.world.prepareMutation(plan.changes, {
      epoch, reads: plan.reads,
    });
    if (!worldPlan) { stats.rejected++; return; }
    let retained = [];
    if (plan.plants.length) {
      try {
        const result = this.prepareDrops?.(plan.drops, {
          plants: plan.plants, changes: plan.changes, epoch, dimension,
        });
        if (!result || typeof result.then === "function") {
          stats.rejected++;
          return;
        }
        retained = Array.isArray(result) ? result : [result];
        if (!retained.length || retained.length > 16) {
          stats.rejected++;
          return;
        }
      } catch (error) {
        if (error instanceof TransactionInvariantError) throw error;
        stats.rejected++;
        return;
      }
    }
    let used = false;
    const guard = {
      owner: this, beforeBytes: 0, afterBytes: 0,
      validate: () => !used && this.world.epoch === epoch &&
        this.world.dimension === dimension && this._resident(entry) &&
        this._clear(plan),
      publish() { used = true; },
    };
    const result = this.coordinator.commit([worldPlan, ...retained, guard]);
    if (!result.ok) { stats.rejected++; return; }
    stats.moved++;
    stats.observerErrors += result.observerErrors.length;
  }

  update(dt) {
    if (this._busy || !this._current() || !Number.isFinite(dt) || dt <= 0 ||
        this.canAdvance() !== true) return false;
    this._syncEpoch();
    const stats = this._last = counters();
    const limits = FALLING_BLOCK_LIMITS;
    const updateEpoch = this.world.epoch;
    this._accumulator = Math.min(limits.stepSeconds * limits.ticksPerUpdate,
      this._accumulator + dt);
    this._busy = true;
    try {
      this._scan(stats);
      while (this._accumulator + 1e-10 >= limits.stepSeconds &&
             stats.ticks < limits.ticksPerUpdate && this._current() &&
             this.world.epoch === updateEpoch && this.canAdvance() === true) {
        this._accumulator = Math.max(0, this._accumulator - limits.stepSeconds);
        stats.ticks++;
        const entries = [];
        for (const [key, entry] of this._queue) {
          this._queue.delete(key);
          entries.push(entry);
          if (entries.length === limits.evaluationsPerTick) break;
        }
        // Snapshot all proposals before moving anything: never move one block
        // twice within a tick because a notification appended more queue work.
        const plans = entries.map((entry) => {
          stats.evaluated++;
          return this._resident(entry) ? planFallingBlock(this.world, entry) : null;
        });
        for (let i = 0; i < entries.length; i++) {
          if (!this._current() || this.world.epoch !== updateEpoch) break;
          if (plans[i]) this._move(entries[i], plans[i], stats);
        }
      }
    } finally { this._busy = false; }
    return true;
  }

  diagnostics() {
    return { queued: this._queue.size, scanJobs: this._scans.size,
      last: { ...this._last }, limits: FALLING_BLOCK_LIMITS };
  }

  dispose() {
    if (this._disposed) return true;
    if (!this.coordinator.release(this)) return false;
    this._disposed = true;
    this._queue.clear();
    this._scans.clear();
    return true;
  }
}
