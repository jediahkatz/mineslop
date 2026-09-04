import { geometryWorldSpec } from "./geometry-world.js";

export const WEATHER_READ_BUDGET = 2048;
export const WEATHER_MUTATION_LIMIT = 512;
const CACHE_LIMIT = 64;
const UNKNOWN = Object.freeze({ known: false, y: null });
const occupied = (cell) => {
  if (!cell || !Number.isSafeInteger(cell.id) || cell.id < 0 ||
      !Number.isSafeInteger(cell.fluid ?? 0) || (cell.fluid ?? 0) < 0)
    return null;
  return cell.id !== 0 || (cell.fluid ?? 0) !== 0;
};

/**
 * Highest occupied cell, conservatively including leaves, glass and fluids.
 * Never uses World.get (missing chunks look like air there), generates chunks,
 * or retains a chunk after the next source/epoch check. Pending scans are dry.
 */
export class WeatherExposure {
  constructor() {
    this.cache = new Map();
    this.world = null;
    this.epoch = null;
    this.remaining = 0;
    this.chunkIds = new WeakMap();
    this.nextChunkId = 0;
  }

  beginFrame(world) {
    if (world !== this.world || world.epoch !== this.epoch ||
        world.dimension !== this.dimension) {
      this.clear();
      this.world = world;
      this.epoch = world.epoch;
      this.dimension = world.dimension;
    }
    this.remaining = WEATHER_READ_BUDGET;
    this.reads = 0;
  }

  /** Carry scans through contiguous, current publications without terrain reads.
   * Missed/replayed events never advance cache revisions: roof() then rescans.
   */
  onMutation(world, event) {
    if (!world || world !== this.world || world._disposed || world.epoch !== this.epoch ||
        world.dimension !== this.dimension || event?.epoch !== this.epoch ||
        event?.dimension !== this.dimension ||
        !Number.isSafeInteger(event.revision) || event.revision !== world._editRevision ||
        !Object.isFrozen(event) || !Array.isArray(event.changes) || !Object.isFrozen(event.changes) ||
        event.changes.length > WEATHER_MUTATION_LIMIT) return false;
    const chunks = new Map();
    for (const change of event.changes) {
      if (!change || ![change.x, change.y, change.z].every(Number.isSafeInteger))
        return false;
      const before = occupied(change.before), after = occupied(change.after);
      if (before === null || after === null) return false;
      const chunkKey = `${Math.floor(change.x / 16)},${Math.floor(change.z / 16)}`;
      let columns = chunks.get(chunkKey);
      if (!columns) chunks.set(chunkKey, columns = new Map());
      if (before !== after) {
        const key = `${change.x},${change.z}`;
        columns.set(key, Math.max(columns.get(key) ?? -Infinity, change.y));
      }
    }
    for (const [key, entry] of this.cache) {
      const chunkKey = `${Math.floor(entry.x / 16)},${Math.floor(entry.z / 16)}`;
      const columns = chunks.get(chunkKey);
      if (!columns) continue;
      const chunk = world.chunks?.get(chunkKey);
      if (!chunk || !world.isLoaded?.(entry.x, entry.z) ||
          this.chunkIds.get(chunk) !== entry.chunkId) {
        this.cache.delete(key);
        continue;
      }
      if (entry.revision === chunk.revision) continue;
      if (entry.revision + 1 !== chunk.revision) {
        this.cache.delete(key);
        continue;
      }
      const changedY = columns.get(key);
      const frontier = entry.result.known ? entry.result.y : entry.nextY;
      if (changedY !== undefined && changedY >= frontier) {
        entry.nextY = Math.max(frontier, changedY);
        entry.result = UNKNOWN;
      }
      entry.revision = chunk.revision;
    }
    return true;
  }

  roof(x, z) {
    const world = this.world;
    if (!world || world._disposed || world.epoch !== this.epoch ||
        world.dimension !== this.dimension ||
        !Number.isSafeInteger(x) || !Number.isSafeInteger(z)) return UNKNOWN;
    const key = `${x},${z}`;
    const chunk = world.chunks?.get(`${Math.floor(x / 16)},${Math.floor(z / 16)}`);
    if (!chunk || !world.isLoaded?.(x, z) || typeof world.getCell !== "function") {
      this.cache.delete(key);
      return UNKNOWN;
    }
    const spec = geometryWorldSpec(world);
    if (!this.chunkIds.has(chunk)) this.chunkIds.set(chunk, ++this.nextChunkId);
    const chunkId = this.chunkIds.get(chunk);
    let entry = this.cache.get(key);
    if (!entry || entry.chunkId !== chunkId || entry.revision !== chunk.revision) {
      if (this.cache.size >= CACHE_LIMIT && !this.cache.has(key))
        this.cache.delete(this.cache.keys().next().value);
      // Cache identity scalars, not resident payloads: eviction stays unpinned.
      entry = { x, z, chunkId, revision: chunk.revision, nextY: spec.maxY - 1, result: UNKNOWN };
      this.cache.set(key, entry);
    }
    while (!entry.result.known && this.remaining > 0 && entry.nextY >= spec.minY) {
      this.remaining--;
      this.reads++;
      const y = entry.nextY;
      const cell = world.getCell(x, y, z);
      if (!cell) {
        this.cache.delete(key);
        return UNKNOWN;
      }
      entry.nextY--;
      if (cell.id !== 0 || (cell.fluid ?? 0) !== 0)
        entry.result = { known: true, y };
    }
    if (entry.nextY < spec.minY && !entry.result.known)
      entry.result = { known: true, y: spec.minY - 1 };
    return entry.result;
  }

  clear() {
    this.cache.clear();
    this.world = null;
    this.remaining = 0;
    this.chunkIds = new WeakMap();
    this.nextChunkId = 0;
  }
}
