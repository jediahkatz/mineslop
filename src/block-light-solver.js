import { LIGHT_BLOCKED, LIGHT_WATER } from "./block-light-topology.js";

const SIDE = 48, PLANE = SIDE * SIDE, COUNT = SIDE * PLANE;
export const BLOCK_LIGHT_TILE_SIDE = 20; // Two-cell render/shape apron.
export const BLOCK_LIGHT_PAGE_CELLS = 20 * 20 * 16;

// One reusable, fixed-capacity wavefront. Strongest level wins; equal-level
// colors use a deterministic packed-color tie break, independent of traversal.
export class BlockLightSolver {
  constructor() {
    this.light = new Uint32Array(COUNT);
    this.cost = new Uint8Array(COUNT);
    this.queue = new Uint32Array(COUNT);
    this.queued = new Uint8Array(COUNT);
    // Low bit: queued. High seven bits: scratch generation. No extra cell
    // metadata; rollover clearing is incremental and charged to visit().
    this.generation = 0;
  }

  begin(sources) {
    this.sources = sources;
    this.cursor = 0;
    this.head = this.tail = this.count = this.peak = 0;
    if (!this.resetPending) {
      this.generation++;
      if (this.generation === 128) {
        this.generation = 1;
        this.resetPending = true;
      }
    }
    this.tag = this.generation << 1;
    // Restart an interrupted rollover before reusing any generation.
    this.phase = this.resetPending ? "reset" : "seed";
    this.values = new Uint8Array(BLOCK_LIGHT_PAGE_CELLS * 4);
    this.lit = false;
    this.denseSeed = true;
  }

  prepare(i, stats) {
    if ((this.queued[i] & 254) === this.tag) return;
    const x = i % SIDE, z = Math.floor(i / SIDE) % SIDE, y = Math.floor(i / PLANE);
    const source = this.sources[Math.floor(y / 16) * 9 + Math.floor(z / 16) * 3 + Math.floor(x / 16)];
    const code = source ? (source.uniform ?? source.values[(y % 16) * 256 + (z % 16) * 16 + x % 16]) : LIGHT_BLOCKED;
    stats.lazyReads = (stats.lazyReads ?? 0) + 1;
    this.cost[i] = code & LIGHT_BLOCKED ? 255 : code & LIGHT_WATER ? 2 : 1;
    this.light[i] = 0;
    this.queued[i] = this.tag;
    stats.initializedCells = (stats.initializedCells ?? 0) + 1;
  }

  enqueue(i) {
    if (this.queued[i] & 1) return;
    if (this.count >= COUNT) throw new Error("Block-light queue capacity exceeded");
    this.queued[i] |= 1;
    this.queue[this.tail] = i;
    this.tail = (this.tail + 1) % COUNT;
    this.count++;
    this.peak = Math.max(this.peak, this.count);
  }

  spread(i, source, stats) {
    // A completely emissive seed pass touched every cell already. This exact
    // condition avoids lazy lookups in the dense worst case, without a heuristic.
    if (!this.denseSeed) this.prepare(i, stats);
    if (this.cost[i] === 255) return;
    const level = (source & 15) - this.cost[i];
    if (level <= 0) return;
    const value = ((source & 0xffffff00) | level) >>> 0, old = this.light[i];
    if (level < (old & 15) || (level === (old & 15) && value <= old)) return;
    this.light[i] = value;
    this.enqueue(i);
  }

  step(budget, stats) {
    while (budget.visit()) {
      if (this.phase === "reset") {
        this.queued[this.cursor++] = 0;
        stats.resetVisits = (stats.resetVisits ?? 0) + 1;
        if (this.cursor === COUNT) {
          this.resetPending = false;
          this.phase = "seed";
          this.cursor = 0;
        }
      } else if (this.phase === "seed") {
        // Topology already counted emitters during its bounded scan. Skip
        // certified non-emitting sections in one visit, but scan unknown
        // metadata normally (including direct solver callers).
        const section = Math.floor(this.cursor / 4096), at = this.cursor % 4096;
        const source = this.sources[section];
        if (!source || source.emitters === 0 ||
          (source.uniform != null && !(source.uniform & 15))) {
          this.cursor = (section + 1) * 4096;
          this.denseSeed = false;
        } else {
          const code = source.uniform ?? source.values[at];
          this.cursor++;
          if (code & 15) {
            const x = (section % 3) * 16 + at % 16;
            const z = (Math.floor(section / 3) % 3) * 16 + Math.floor(at / 16) % 16;
            const y = Math.floor(section / 9) * 16 + Math.floor(at / 256);
            const i = y * PLANE + z * SIDE + x;
            // Each seed cell is visited once, before any flood work.
            this.cost[i] = code & LIGHT_BLOCKED ? 255 : code & LIGHT_WATER ? 2 : 1;
            this.light[i] = (code & 0xffffff0f) >>> 0;
            this.queued[i] = this.tag;
            stats.initializedCells = (stats.initializedCells ?? 0) + 1;
            this.enqueue(i);
          } else this.denseSeed = false;
        }
        stats.seedVisits++;
        if (this.cursor === COUNT) this.phase = "flood";
      } else if (this.phase === "flood") {
        if (!this.count) { this.phase = "output"; this.cursor = 0; continue; }
        const i = this.queue[this.head], source = this.light[i];
        this.head = (this.head + 1) % COUNT;
        this.count--;
        this.queued[i] &= 254;
        const x = i % SIDE, z = Math.floor(i / SIDE) % SIDE;
        if (x) this.spread(i - 1, source, stats);
        if (x < SIDE - 1) this.spread(i + 1, source, stats);
        if (z) this.spread(i - SIDE, source, stats);
        if (z < SIDE - 1) this.spread(i + SIDE, source, stats);
        if (i >= PLANE) this.spread(i - PLANE, source, stats);
        if (i + PLANE < COUNT) this.spread(i + PLANE, source, stats);
        stats.floodVisits++;
      } else {
        const i = this.cursor++, x = i % 20, z = Math.floor(i / 20) % 20, y = Math.floor(i / 400);
        const cell = (y + 16) * PLANE + (z + 14) * SIDE + x + 14;
        const light = (this.queued[cell] & 254) === this.tag ? this.light[cell] : 0;
        const weight = ((light & 15) / 15) ** 2, at = i * 4;
        this.values[at] = Math.round((light >>> 24) * weight);
        this.values[at + 1] = Math.round(((light >>> 16) & 255) * weight);
        this.values[at + 2] = Math.round(((light >>> 8) & 255) * weight);
        this.lit ||= weight > 0;
        stats.outputVisits++;
        if (this.cursor === BLOCK_LIGHT_PAGE_CELLS) return true;
      }
    }
    stats.queuePeak = Math.max(stats.queuePeak, this.peak);
    return false;
  }

  resources() {
    return this.light.byteLength + this.cost.byteLength + this.queue.byteLength + this.queued.byteLength;
  }
}
