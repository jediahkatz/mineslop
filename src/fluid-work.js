import {
  FLUID_DIRECTIONS,
  FLUID_WAKE_OFFSETS,
  fluidCellKey,
  fluidColumnKey,
  fluidSectionKey,
  MAX_FLUID_CLOCK,
  MAX_FLUID_WAIT_COLUMNS,
} from "./fluid-constants.js";
import { fluidScanCandidate } from "./fluid-rules.js";
import { getWorldSpec, inColumnBounds, inWorldBounds } from "./world-spec.js";

const CACHE_COLUMNS = 512; // World retains at most 441 resident columns.
const contains = (region, cx, cz) =>
  cx >= region.x0 && cx <= region.x1 && cz >= region.z0 && cz <= region.z1;

function remember(map, key, value) {
  map.delete(key);
  if (map.size >= CACHE_COLUMNS) map.delete(map.keys().next().value);
  map.set(key, value);
}

/** Exact cells -> dirty sections -> bounded coarse recovery regions.
 *
 * Coarse regions are conservative, sticky archive markers: after pressure has
 * subsided, each resident incarnation is scanned once per generation; future
 * admissions in the region are also recovered. They do not enumerate unloaded
 * terrain. Merging bounding rectangles can do extra work, but cannot lose work.
 */
export class FluidWork {
  constructor(dimension, generatorVersion, limits) {
    this.dimension = dimension;
    this.spec = getWorldSpec(generatorVersion, dimension);
    this.limits = limits;
    this.clock = 0;
    this.accumulator = 0;
    this.generation = 0;
    this.queue = new Map();
    this.sections = new Map();
    this.scans = new Map();
    this.regions = [];
    this.admitted = new Map();
    this.recovered = new Map();
    this._sectionIterator = null;
    this._scanIterator = null;
    this._worldIterator = null;
    this._scanTurn = false;
  }

  offer(x, y, z, options = {}, overflow = true, stats) {
    if (!inWorldBounds(x, y, z, this.spec)) return true;
    if (stats) stats.scheduleRequests++;
    const key = fluidCellKey(x, y, z);
    const due = options.due ?? this.clock + 1;
    const existing = this.queue.get(key);
    if (existing) {
      existing.due = Math.min(existing.due, due);
      existing.expand ||= options.expand === true;
      if (options.coralId != null) {
        existing.coralId = options.coralId;
        existing.coralDue = options.coralDue;
      }
      return true;
    }
    if (this.queue.size >= this.limits.maxQueued) {
      if (overflow) {
        this.markSection(
          Math.floor(x / 16),
          Math.floor(z / 16),
          Math.floor(y / 16)
        );
        if (stats) stats.overflows++;
      }
      return false;
    }
    this.queue.set(key, {
      x,
      y,
      z,
      due,
      expand: options.expand === true,
      coralId: options.coralId ?? null,
      coralDue: options.coralDue ?? null,
    });
    return true;
  }

  wake(x, y, z, stats) {
    for (const [dx, dy, dz] of FLUID_WAKE_OFFSETS)
      this.offer(x + dx, y + dy, z + dz, {}, true, stats);
  }

  expand(entry, stats) {
    for (const direction of FLUID_DIRECTIONS)
      this.offer(
        entry.x + direction.x,
        entry.y + direction.y,
        entry.z + direction.z,
        {},
        true,
        stats
      );
  }

  take(stats) {
    const entries = [];
    for (const [key, entry] of this.queue) {
      stats.queueVisits++;
      if (entry.due > this.clock) continue;
      this.queue.delete(key);
      entries.push(entry);
      if (entries.length >= this.limits.maxUpdatesPerTick) break;
    }
    return entries;
  }

  markSection(cx, cz, sy, waiting = []) {
    if (
      !inColumnBounds(cx * 16, cz * 16) ||
      sy < this.spec.minY / 16 ||
      sy >= this.spec.maxY / 16
    )
      return;
    const key = fluidSectionKey(cx, cz, sy);
    const existing = this.sections.get(key);
    const waits = new Map(
      (existing?.waiting ?? []).map((column) => [column.join(","), column])
    );
    for (const column of waiting) waits.set(column.join(","), [...column]);
    if (
      waits.size > MAX_FLUID_WAIT_COLUMNS ||
      (!existing && this.sections.size >= this.limits.maxDirtySections)
    ) {
      this.markRegion(cx, cz);
      this.sections.delete(key);
      return;
    }
    if (existing) {
      existing.again ||= existing.cursor > 0;
      existing.waiting = [...waits.values()];
    } else {
      this.sections.set(key, {
        cx,
        cz,
        sy,
        cursor: 0,
        again: false,
        waiting: [...waits.values()],
        incarnation: null,
      });
    }
  }

  defer(entry, waiting) {
    this.markSection(
      Math.floor(entry.x / 16),
      Math.floor(entry.z / 16),
      Math.floor(entry.y / 16),
      waiting
    );
  }

  _nextGeneration() {
    if (this.generation >= MAX_FLUID_CLOCK) {
      this.generation = 1;
      this.recovered.clear();
      for (const region of this.regions) region.generation = 1;
      for (const scan of this.scans.values()) {
        scan.generation = 0;
        scan.again = true;
      }
    }
    return ++this.generation;
  }

  markRegion(cx, cz, mode = "recover") {
    const generation = this._nextGeneration();
    const found = this.regions.find((region) => contains(region, cx, cz));
    if (found) {
      found.generation = generation;
      if (mode === "recover") found.mode = mode;
      return;
    }
    const region = { x0: cx, x1: cx, z0: cz, z1: cz, generation, mode };
    if (this.regions.length < this.limits.maxRecoveryRegions) {
      this.regions.push(region);
      return;
    }
    for (const previous of this.regions) {
      region.x0 = Math.min(region.x0, previous.x0);
      region.x1 = Math.max(region.x1, previous.x1);
      region.z0 = Math.min(region.z0, previous.z0);
      region.z1 = Math.max(region.z1, previous.z1);
      if (previous.mode === "recover") region.mode = "recover";
    }
    this.regions = [region];
  }

  regionWork(cx, cz) {
    let generation = 0,
      mode = "seed";
    for (const region of this.regions) {
      if (!contains(region, cx, cz)) continue;
      generation = Math.max(generation, region.generation);
      if (region.mode === "recover") mode = "recover";
    }
    return generation ? { generation, mode } : null;
  }

  requestScan(chunk, mode = "seed", generation = 0) {
    const { cx, cz, incarnation } = chunk;
    const key = fluidColumnKey(cx, cz);
    const existing = this.scans.get(key);
    if (existing) {
      if (existing.incarnation !== incarnation) {
        existing.cursor = 0;
        existing.incarnation = incarnation;
      } else if (
        existing.cursor > 0 &&
        (generation > existing.generation ||
          (mode === "recover" && existing.mode !== mode))
      )
        existing.again = true;
      if (mode === "recover") existing.mode = mode;
      existing.generation = Math.max(existing.generation, generation);
      return true;
    }
    if (this.scans.size >= this.limits.maxScanJobs) {
      this.markRegion(cx, cz, mode);
      return false;
    }
    this.scans.set(key, {
      cx,
      cz,
      mode,
      cursor: 0,
      again: false,
      incarnation,
      generation,
    });
    return true;
  }

  onChunkLoaded(world, chunk) {
    const key = fluidColumnKey(chunk.cx, chunk.cz);
    if (this.admitted.get(key) !== chunk.incarnation) {
      remember(this.admitted, key, chunk.incarnation);
      this.requestScan(chunk);
    }
    // A frontier dependency can be a neighboring column, not the edited one.
    for (const section of this.sections.values())
      section.waiting = section.waiting.filter(
        ([cx, cz]) => !world.chunks.has(fluidColumnKey(cx, cz))
      );
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const resident = world.chunks.get(
          fluidColumnKey(chunk.cx + dx, chunk.cz + dz)
        );
        if (!resident) continue;
        const work = this.regionWork(resident.cx, resident.cz);
        if (work) {
          this.recovered.delete(fluidColumnKey(resident.cx, resident.cz));
          this.requestScan(resident, work.mode, work.generation);
        }
      }
  }

  discoverRecovery(world, stats) {
    if (!this.regions.length) return;
    this._worldIterator ??= world.chunks.values();
    for (let i = 0; i < this.limits.maxRecoveryVisitsPerUpdate; i++) {
      const next = this._worldIterator.next();
      if (next.done) {
        this._worldIterator = null;
        break;
      }
      stats.recoveryVisits++;
      const chunk = next.value;
      const work = this.regionWork(chunk.cx, chunk.cz);
      if (!work) continue;
      const seen = this.recovered.get(fluidColumnKey(chunk.cx, chunk.cz));
      if (
        seen?.incarnation === chunk.incarnation &&
        seen.generation >= work.generation
      )
        continue;
      // The marker already owns this work. A full scan pool must not repeatedly
      // re-dirty the region and prevent a running pass from ever completing.
      const key = fluidColumnKey(chunk.cx, chunk.cz);
      if (this.scans.has(key) || this.scans.size < this.limits.maxScanJobs)
        this.requestScan(chunk, work.mode, work.generation);
    }
  }

  _nextScan() {
    this._scanTurn = !this._scanTurn;
    const field = this._scanTurn ? "_sectionIterator" : "_scanIterator";
    const map = this._scanTurn ? this.sections : this.scans;
    this[field] ??= map.entries();
    const next = this[field].next();
    if (next.done) {
      this[field] = null;
      return null;
    }
    return {
      map,
      key: next.value[0],
      job: next.value[1],
      section: this._scanTurn,
    };
  }

  scan(world, stats) {
    this.discoverRecovery(world, stats);
    const visitLimit = Math.min(
      this.limits.maxScanVisitsPerUpdate,
      2 * (this.sections.size + this.scans.size + 1)
    );
    for (let visit = 0; visit < visitLimit; visit++) {
      if (stats.scanCells >= this.limits.maxScanCellsPerUpdate) break;
      stats.scanVisits++;
      const selected = this._nextScan();
      if (!selected) continue;
      const { map, key, job, section } = selected;
      const chunk = world.chunks.get(fluidColumnKey(job.cx, job.cz));
      if (!chunk) {
        if (!section) {
          // Admission will seed an evicted column again. Active recovery, unlike
          // an unfinished cold seed, must also survive without another edit.
          if (job.mode === "recover") this.markRegion(job.cx, job.cz);
          map.delete(key);
        }
        continue;
      }
      if (section && job.waiting.length) continue;
      if (job.incarnation !== chunk.incarnation) {
        job.incarnation = chunk.incarnation;
        job.cursor = 0;
      }
      const cells = section ? 4096 : (this.spec.maxY - this.spec.minY) * 256;
      while (
        job.cursor < cells &&
        stats.scanCells < this.limits.maxScanCellsPerUpdate
      ) {
        const at = job.cursor;
        const x = job.cx * 16 + (at % 16);
        const z = job.cz * 16 + (Math.floor(at / 16) % 16);
        const y =
          (section ? job.sy * 16 : this.spec.minY) + Math.floor(at / 256);
        stats.scanCells++;
        const candidate = fluidScanCandidate(
          world,
          x,
          y,
          z,
          section ? "recover" : job.mode,
          stats
        );
        if (candidate && !this.offer(x, y, z, candidate, false, stats)) return;
        job.cursor++;
      }
      if (job.cursor !== cells) continue;
      if (job.again) {
        job.cursor = 0;
        job.again = false;
      } else {
        map.delete(key);
        if (!section && job.generation)
          remember(this.recovered, key, {
            incarnation: chunk.incarnation,
            generation: job.generation,
          });
      }
    }
  }

  serialize() {
    return {
      dimension: this.dimension,
      clock: this.clock,
      accumulator: this.accumulator,
      generation: this.generation,
      queue: [...this.queue.values()].map(
        ({ x, y, z, due, expand, coralId, coralDue }) => [
          x,
          y,
          z,
          due,
          expand,
          coralId,
          coralDue,
        ]
      ),
      sections: [...this.sections.values()].map(
        ({ cx, cz, sy, cursor, again, waiting }) => [
          cx,
          cz,
          sy,
          cursor,
          again,
          waiting.map((column) => [...column]),
        ]
      ),
      scans: [...this.scans.values()].map(
        ({ cx, cz, cursor, again, mode, generation }) => [
          cx,
          cz,
          cursor,
          again,
          mode,
          generation,
        ]
      ),
      regions: this.regions.map(({ x0, x1, z0, z1, generation, mode }) => [
        x0,
        x1,
        z0,
        z1,
        generation,
        mode,
      ]),
    };
  }
}
