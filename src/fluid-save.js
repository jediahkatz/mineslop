import { BLOCKS } from "./blocks.js";
import {
  FLUID_HARD_LIMITS,
  FLUID_STEP_SECONDS,
  MAX_FLUID_CLOCK,
  MAX_FLUID_WAIT_COLUMNS,
} from "./fluid-constants.js";
import { FluidWork } from "./fluid-work.js";
import {
  getWorldSpec,
  inColumnBounds,
  inWorldBounds,
  isDimension,
} from "./world-spec.js";

const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value, min, max) =>
  Number.isSafeInteger(value) && value >= min && value <= max;
const column = (cx, cz) =>
  Number.isSafeInteger(cx) &&
  Number.isSafeInteger(cz) &&
  inColumnBounds(cx * 16, cz * 16);
const mode = (value) => value === "seed" || value === "recover";
const tuple = (value, length) =>
  Array.isArray(value) && value.length === length;
const list = (value, maximum) =>
  Array.isArray(value) && value.length <= maximum;

function normalizeDimension(data, generatorVersion) {
  if (
    !record(data) ||
    !isDimension(data.dimension) ||
    !integer(data.clock, 0, MAX_FLUID_CLOCK) ||
    !Number.isFinite(data.accumulator) ||
    data.accumulator < 0 ||
    data.accumulator >
      FLUID_STEP_SECONDS * FLUID_HARD_LIMITS.maxTicksPerUpdate ||
    !integer(data.generation, 0, MAX_FLUID_CLOCK) ||
    !list(data.queue, FLUID_HARD_LIMITS.maxQueued) ||
    !list(data.sections, FLUID_HARD_LIMITS.maxDirtySections) ||
    !list(data.scans, FLUID_HARD_LIMITS.maxScanJobs) ||
    !list(data.regions, FLUID_HARD_LIMITS.maxRecoveryRegions)
  )
    return null;
  const spec = getWorldSpec(generatorVersion, data.dimension);
  const result = {
    dimension: data.dimension,
    clock: data.clock,
    accumulator: data.accumulator,
    generation: data.generation,
    queue: [],
    sections: [],
    scans: [],
    regions: [],
  };
  let seen = new Set();
  for (const entry of data.queue) {
    if (!tuple(entry, 7)) return null;
    const [x, y, z, due, expand, coralId, coralDue] = entry;
    if (
      !inWorldBounds(x, y, z, spec) ||
      !integer(due, 0, MAX_FLUID_CLOCK + 32) ||
      typeof expand !== "boolean" ||
      (coralId === null) !== (coralDue === null) ||
      (coralId !== null &&
        (!Number.isInteger(coralId) ||
          !BLOCKS[coralId]?.coralFamily ||
          BLOCKS[coralId].deadCoral ||
          !integer(coralDue, 0, MAX_FLUID_CLOCK + 32)))
    )
      return null;
    const key = `${x},${y},${z}`;
    if (seen.has(key)) return null;
    seen.add(key);
    result.queue.push([...entry]);
  }
  seen = new Set();
  for (const entry of data.sections) {
    if (!tuple(entry, 6)) return null;
    const [cx, cz, sy, cursor, again, waiting] = entry;
    if (
      !column(cx, cz) ||
      !integer(sy, spec.minY / 16, spec.maxY / 16 - 1) ||
      !integer(cursor, 0, 4095) ||
      typeof again !== "boolean" ||
      !list(waiting, MAX_FLUID_WAIT_COLUMNS)
    )
      return null;
    const key = `${cx},${cz},${sy}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const waits = new Set();
    for (const at of waiting) {
      if (!tuple(at, 2) || !column(...at) || waits.has(at.join(",")))
        return null;
      waits.add(at.join(","));
    }
    result.sections.push([
      cx,
      cz,
      sy,
      cursor,
      again,
      waiting.map((at) => [...at]),
    ]);
  }
  seen = new Set();
  for (const entry of data.scans) {
    if (!tuple(entry, 6)) return null;
    const [cx, cz, cursor, again, scanMode, generation] = entry;
    const key = `${cx},${cz}`;
    if (
      !column(cx, cz) ||
      seen.has(key) ||
      !integer(cursor, 0, (spec.maxY - spec.minY) * 256 - 1) ||
      typeof again !== "boolean" ||
      !mode(scanMode) ||
      !integer(generation, 0, data.generation)
    )
      return null;
    seen.add(key);
    result.scans.push([...entry]);
  }
  seen = new Set();
  for (const entry of data.regions) {
    if (!tuple(entry, 6)) return null;
    const [x0, x1, z0, z1, generation, regionMode] = entry;
    const key = `${x0},${x1},${z0},${z1}`;
    if (
      !column(x0, z0) ||
      !column(x1, z1) ||
      x0 > x1 ||
      z0 > z1 ||
      seen.has(key) ||
      !integer(generation, 1, data.generation) ||
      !mode(regionMode)
    )
      return null;
    seen.add(key);
    result.regions.push([...entry]);
  }
  return result;
}

/** Detached archive preflight. No World, renderer, timers or reservations are
 * constructed. Every dimension uses its own generator-specific signed bounds.
 */
export function normalizeFluidSnapshot(data, context) {
  if (
    !record(data) ||
    !context ||
    data.version !== 1 ||
    data.seed !== context.seed ||
    data.generatorVersion !== context.generatorVersion ||
    !list(data.dimensions, 3)
  )
    return null;
  try {
    getWorldSpec(context.generatorVersion, "overworld");
    const dimensions = [];
    const seen = new Set();
    for (const entry of data.dimensions) {
      const clean = normalizeDimension(entry, context.generatorVersion);
      if (!clean || seen.has(clean.dimension)) return null;
      seen.add(clean.dimension);
      dimensions.push(clean);
    }
    return {
      version: 1,
      seed: data.seed,
      generatorVersion: data.generatorVersion,
      dimensions,
    };
  } catch {
    return null;
  }
}

/** A smaller runtime pool may conservatively coarsen a valid larger queue,
 * never truncate it. Restarting an interrupted scan is safe and bounded.
 */
export function restoreFluidWork(data, generatorVersion, limits) {
  const work = new FluidWork(data.dimension, generatorVersion, limits);
  work.clock = data.clock;
  work.accumulator = data.accumulator;
  work.generation = data.generation;
  work.regions = data.regions.map(([x0, x1, z0, z1, generation, mode]) => ({
    x0,
    x1,
    z0,
    z1,
    generation,
    mode,
  }));
  if (work.regions.length > limits.maxRecoveryRegions) {
    const merged = { ...work.regions[0] };
    for (const region of work.regions.slice(1)) {
      merged.x0 = Math.min(merged.x0, region.x0);
      merged.x1 = Math.max(merged.x1, region.x1);
      merged.z0 = Math.min(merged.z0, region.z0);
      merged.z1 = Math.max(merged.z1, region.z1);
      merged.generation = Math.max(merged.generation, region.generation);
      if (region.mode === "recover") merged.mode = "recover";
    }
    work.regions = [merged];
  }
  for (const [cx, cz, sy, , again, waiting] of data.sections) {
    work.markSection(cx, cz, sy, waiting);
    const entry = work.sections.get(`${cx},${cz},${sy}`);
    if (entry) entry.again = again;
  }
  for (const [cx, cz, , again, mode, generation] of data.scans) {
    work.requestScan({ cx, cz, incarnation: null }, mode, generation);
    const entry = work.scans.get(`${cx},${cz}`);
    if (entry) entry.again = again;
  }
  for (const [x, y, z, due, expand, coralId, coralDue] of data.queue)
    work.offer(x, y, z, { due, expand, coralId, coralDue });
  return work;
}
