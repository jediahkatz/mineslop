import { BLOCK } from "./blocks.js";
import { inspectConduit } from "./conduit-rules.js";

export const CONDUIT_LIMITS = Object.freeze({
  sources: 128, queuedColumns: 64, residentColumns: 8192,
  cellsPerStep: 32768, columnsPerStep: 4, mutationCells: 256,
  attacksPerStep: 4,
});
const keyOf = ({ x, y, z }) => `${x},${y},${z}`;
const columnOf = ({ x, z }) => `${Math.floor(x / 16)},${Math.floor(z / 16)}`;

/**
 * Transient resident-only discovery. Queues/caches retain scalar keys and
 * incarnations, never chunk buffers or pins. Overflow requests a finite sweep
 * of resident identities, time-sliced beside admissions (neither can starve).
 * Too many sources fail closed until a complete bounded sweep fits again.
 */
export class ConduitIndex {
  constructor(world) {
    this.world = world;
    this.reset();
  }

  reset() {
    this.epoch = this.world.epoch;
    this.dimension = this.world.dimension;
    this.sources = new Map();
    this.cache = new Map();
    this.queue = new Map();
    this.overflow = false;
    this.fallback = null;
    this.needsFallback = true;
    this.residentCount = this.world.chunks.size;
    this.lastMutationRevision = this.world._editRevision;
    this.lastWork = { cells: 0, columns: 0 };
  }

  sync() {
    if (this.epoch !== this.world.epoch || this.dimension !== this.world.dimension)
      this.reset();
  }

  _add(position, map = this.sources) {
    const key = keyOf(position);
    if (map.has(key)) return true;
    if (map.size >= CONDUIT_LIMITS.sources) {
      if (map === this.sources) {
        this.overflow = true;
        if (!this.fallback) this.needsFallback = true;
      }
      return false;
    }
    const chunk = this.world.chunks.get(columnOf(position));
    if (!chunk) return false;
    map.set(key, { x: position.x, y: position.y, z: position.z, incarnation: chunk.incarnation });
    return true;
  }

  onChunkLoaded(world, event) {
    if (world !== this.world) return false;
    this.sync();
    if (event?.epoch !== this.epoch || event.dimension !== this.dimension ||
        world.chunks.get(event.key) !== event.chunk ||
        event.chunk?.incarnation !== event.incarnation) return false;
    if (this.overflow) this.needsFallback = true;
    if (!this.queue.has(event.key) && this.queue.size >= CONDUIT_LIMITS.queuedColumns)
      this.needsFallback = true;
    else this.queue.set(event.key, { key: event.key, incarnation: event.incarnation, offset: 0 });
    return true;
  }

  onMutation(world, event) {
    if (world !== this.world) return false;
    this.sync();
    if (event?.epoch !== this.epoch || event.dimension !== this.dimension ||
        !Number.isSafeInteger(event.revision) ||
        event.revision !== world._editRevision ||
        event.revision <= this.lastMutationRevision) return false;
    // Only acknowledge a current publication after remembering any omitted
    // predecessors. The finite sweep, not this unrelated event, recovers them.
    if (event.revision !== this.lastMutationRevision + 1) this.needsFallback = true;
    this.lastMutationRevision = event.revision;
    if (event.changes.length > CONDUIT_LIMITS.mutationCells) {
      this.needsFallback = true;
      return true;
    }
    for (const change of event.changes) {
      const key = keyOf(change);
      if (change.after?.id === BLOCK.CONDUIT) this._add(change);
      else {
        this.sources.delete(key);
        this.cache.delete(key);
      }
      if (this.fallback) {
        if (change.after?.id === BLOCK.CONDUIT) {
          if (!this._add(change, this.fallback.sources)) this.fallback.overflow = true;
        } else this.fallback.sources.delete(key);
      }
    }
    if (this.overflow) this.needsFallback = true;
    return true;
  }

  _startFallback() {
    const columns = [];
    for (const [key, chunk] of this.world.chunks) {
      if (columns.length === CONDUIT_LIMITS.residentColumns) {
        this.overflow = true;
        return;
      }
      columns.push({ key, incarnation: chunk.incarnation, offset: 0 });
    }
    this.needsFallback = false;
    this.fallback = { columns, cursor: 0, sources: new Map(), overflow: false };
  }

  _scan(work, budget, destination) {
    const chunk = this.world.chunks.get(work.key);
    if (!chunk || chunk.incarnation !== work.incarnation) return { cells: 0, done: true };
    const end = Math.min(chunk.blocks.length, work.offset + budget);
    const start = work.offset;
    for (; work.offset < end; work.offset++) {
      if (chunk.blocks[work.offset] !== BLOCK.CONDUIT) continue;
      const position = {
        x: chunk.cx * 16 + work.offset % 16,
        y: this.world.spec.minY + Math.floor(work.offset / 256),
        z: chunk.cz * 16 + Math.floor(work.offset / 16) % 16,
      };
      if (!this._add(position, destination) && this.fallback?.sources === destination)
        this.fallback.overflow = true;
      this._add(position);
    }
    return { cells: end - start, done: work.offset === chunk.blocks.length };
  }

  step() {
    this.sync();
    if (this.world._disposed) return;
    // One scalar comparison also covers a missing LAST event (and loadEdits,
    // which publishes admissions). Coalesce gaps into the existing sweep;
    // unchanged/fully observed revisions do not schedule recurring scans.
    if (Number.isSafeInteger(this.world._editRevision) &&
        this.world._editRevision !== this.lastMutationRevision) {
      this.lastMutationRevision = this.world._editRevision;
      this.needsFallback = true;
    }
    if (this.overflow && this.world.chunks.size !== this.residentCount)
      this.needsFallback = true;
    this.residentCount = this.world.chunks.size;
    this.lastWork = { cells: 0, columns: 0 };
    this.prune();
    if (!this.fallback && this.needsFallback) this._startFallback();
    for (const fallback of [false, true]) {
      let budget = CONDUIT_LIMITS.cellsPerStep / 2;
      for (let i = 0; i < CONDUIT_LIMITS.columnsPerStep / 2 && budget > 0; i++) {
        const sweep = this.fallback;
        const work = fallback ? sweep?.columns[sweep.cursor] : this.queue.values().next().value;
        if (!work) break;
        const result = this._scan(work, budget, fallback ? sweep.sources : this.sources);
        budget -= result.cells;
        this.lastWork.cells += result.cells;
        this.lastWork.columns++;
        if (result.done) {
          if (fallback) sweep.cursor++;
          else this.queue.delete(work.key);
        }
      }
    }
    const sweep = this.fallback;
    if (sweep && sweep.cursor === sweep.columns.length) {
      for (const position of this.sources.values())
        if (this.world.chunks.get(columnOf(position))?.incarnation === position.incarnation &&
            this.world.getCell(position.x, position.y, position.z)?.id === BLOCK.CONDUIT &&
            !this._add(position, sweep.sources)) sweep.overflow = true;
      this.sources = sweep.sources;
      this.cache.clear();
      this.overflow = sweep.overflow;
      this.fallback = null;
      this.prune();
    }
  }

  prune() {
    for (const [key, position] of this.sources) {
      if (this.world.chunks.get(columnOf(position))?.incarnation !== position.incarnation ||
          this.world.getCell(position.x, position.y, position.z)?.id !== BLOCK.CONDUIT) {
        this.sources.delete(key);
        this.cache.delete(key);
        if (this.overflow) this.needsFallback = true;
      }
    }
  }

  /** At most four distinct columns and 70 scalar reads on a cache miss. */
  observe(position) {
    this.sync();
    if (this.overflow || this.world._disposed) return null;
    const key = keyOf(position), source = this.sources.get(key);
    if (!source || source.incarnation !== this.world.chunks.get(columnOf(position))?.incarnation)
      return null;
    const cached = this.cache.get(key);
    if (cached?.validate()) return cached.value ? cached : null;
    const columns = new Map();
    for (const dx of [-2, 2]) for (const dz of [-2, 2]) {
      const column = columnOf({ x: position.x + dx, z: position.z + dz });
      const chunk = this.world.chunks.get(column);
      columns.set(column, { incarnation: chunk?.incarnation, revision: chunk?.revision });
    }
    const epoch = this.epoch, dimension = this.dimension;
    const validate = () => !this.world._disposed && !this.overflow &&
      this.world.epoch === epoch && this.world.dimension === dimension &&
      this.sources.get(key) === source &&
      [...columns].every(([column, before]) => {
        const current = this.world.chunks.get(column);
        return current?.incarnation === before.incarnation && current?.revision === before.revision;
      });
    const value = inspectConduit(position, (x, y, z) => this.world.getCell(x, y, z));
    const observation = Object.freeze({ value, validate, columns: columns.size });
    this.cache.set(key, observation);
    return value && validate() ? observation : null;
  }
}
