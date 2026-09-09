export const FLUID_STEP_SECONDS = 0.25;
export const FLUID_GAME_TICKS = 5;
export const MAX_FLUID_CLOCK = 1_000_000_000_000;
export const MAX_FLUID_PLAN_READS = 192;
export const MAX_FLUID_WAIT_COLUMNS = 8;
export const MAX_FLUID_DROP_PARTICIPANTS = 16;
export const MAX_SPONGE_WATER = 65;
export const MAX_SPONGE_DISTANCE = 7;
export const MAX_SPONGE_READS = 1024;

// Bounded equivalent of Java's ~487.6-second mean random-tick extension.
// These are ACTIVE dimension ticks, not wall time or a one-second farm.
export const KELP_GROW_TICKS = 1950;
export const KELP_MAX_AGE = 25;
export const KELP_MAX_HEIGHT = 26;
export const MAX_KELP_TIMERS = 1024;
export const kelpTimerLimit = (limits) =>
  Math.min(
    MAX_KELP_TIMERS,
    limits.maxQueued - 1,
    Math.max(1, Math.floor(limits.maxQueued / 4))
  );

export const FLUID_LIMITS = Object.freeze({
  maxQueued: 4096,
  maxDirtySections: 256,
  maxScanJobs: 32,
  maxRecoveryRegions: 16,
  maxUpdatesPerTick: 96,
  maxScanCellsPerUpdate: 256,
  maxScanVisitsPerUpdate: 64,
  maxRecoveryVisitsPerUpdate: 16,
  maxTicksPerUpdate: 4,
});

export const FLUID_HARD_LIMITS = Object.freeze({
  maxQueued: 8192,
  maxDirtySections: 1024,
  maxScanJobs: 128,
  maxRecoveryRegions: 64,
  maxUpdatesPerTick: 256,
  maxScanCellsPerUpdate: 4096,
  maxScanVisitsPerUpdate: 256,
  maxRecoveryVisitsPerUpdate: 64,
  maxTicksPerUpdate: 4,
});

export function fluidLimits(options = {}) {
  const limits = {};
  for (const [name, fallback] of Object.entries(FLUID_LIMITS)) {
    const value = options[name] ?? fallback;
    if (
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > FLUID_HARD_LIMITS[name]
    )
      throw new RangeError(`Invalid fluid limit: ${name}`);
    limits[name] = value;
  }
  return Object.freeze(limits);
}

// Reserve the entire bounded scheduler at construction. Postcommit work cannot
// need a fallible budget increase after the World edit has already published.
// Tuples include bounded signed coordinates, clocks, flags and <=8 wait columns.
// A kelp timer belongs to an existing queue cell, not an extra queued cell.
// Its optional projection plus that cell's seven-tuple still fits 128 bytes.
export function fluidReservedBytes(limits) {
  return (
    4096 +
    3 *
      (limits.maxQueued * 128 +
        limits.maxDirtySections * 256 +
        limits.maxScanJobs * 128 +
        limits.maxRecoveryRegions * 128)
  );
}

export const FLUID_DIRECTIONS = Object.freeze([
  Object.freeze({ x: 0, y: -1, z: 0, face: "down", opposite: "up" }),
  Object.freeze({ x: 0, y: 1, z: 0, face: "up", opposite: "down" }),
  Object.freeze({ x: -1, y: 0, z: 0, face: "west", opposite: "east" }),
  Object.freeze({ x: 1, y: 0, z: 0, face: "east", opposite: "west" }),
  Object.freeze({ x: 0, y: 0, z: -1, face: "north", opposite: "south" }),
  Object.freeze({ x: 0, y: 0, z: 1, face: "south", opposite: "north" }),
]);
export const HORIZONTAL_FLUID_DIRECTIONS = Object.freeze(
  FLUID_DIRECTIONS.slice(2)
);
export const fluidCellKey = (x, y, z) => `${x},${y},${z}`;
export const fluidColumnKey = (cx, cz) => `${cx},${cz}`;
export const fluidSectionKey = (cx, cz, sy) => `${cx},${cz},${sy}`;

export const FLUID_WAKE_OFFSETS = Object.freeze(
  Array.from({ length: 125 }, (_, i) => [
    (i % 5) - 2,
    Math.floor(i / 25) - 2,
    (Math.floor(i / 5) % 5) - 2,
  ])
    .filter(([x, y, z]) => Math.abs(x) + Math.abs(y) + Math.abs(z) <= 2)
    .sort(
      (a, b) =>
        a.reduce((sum, value) => sum + Math.abs(value), 0) -
        b.reduce((sum, value) => sum + Math.abs(value), 0)
    )
    .map(Object.freeze)
);
