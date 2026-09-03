import { BLOCK, BLOCKS } from "./blocks.js";
import {
  difficultyPolicy,
  hostileLimitForDifficulty,
} from "./mob-difficulty.js";
import {
  isDaylight,
  isHostileSpecies,
  MAX_HOSTILES,
  MAX_MOBS,
  MIN_HOSTILE_SPAWN_DISTANCE,
  MOB_SPECIES,
  speciesForBiome,
} from "./mob-species.js";

export const MOB_SPAWN_LIMITS = Object.freeze({
  step: 0.2,
  candidatesPerPulse: 8,
  admissionsPerFrame: 4,
  maxGroup: 3,
  cellSize: 8,
  minDistance: MIN_HOSTILE_SPAWN_DISTANCE,
  maxDistance: 48,
});

const pool = (limit, initialMin, initialMax, intervalMin, intervalMax) =>
  Object.freeze({ limit, initialMin, initialMax, intervalMin, intervalMax });
export const MOB_SPAWN_POOLS = Object.freeze({
  passive: pool(12, 2, 4, 6, 10),
  aquatic: pool(4, 3, 5, 8, 12),
  hostile: pool(MAX_HOSTILES, 2, 3, 2, 3),
});
const pools = Object.keys(MOB_SPAWN_POOLS);
const profile = (weight, minGroup, maxGroup, limit = 5) =>
  Object.freeze({ weight, minGroup, maxGroup, limit });

/** Relative weights AFTER habitat admission. No difficulty or population
 * multiplier; a rare biome's specialist can still be locally common there.
 */
export const NATURAL_MOB_PROFILES = Object.freeze({
  sheep: profile(12, 2, 3),
  pig: profile(10, 2, 3),
  cow: profile(10, 2, 3),
  chicken: profile(10, 2, 3),
  horse: profile(4, 2, 3, 3),
  rabbit: profile(6, 2, 3, 4),
  wolf: profile(2, 1, 2, 3),
  fox: profile(2, 1, 2, 2),
  goat: profile(4, 1, 2, 3),
  polar_bear: profile(2, 1, 2, 2),
  panda: profile(1, 1, 2, 2),
  camel: profile(1, 1, 2, 2),
  frog: profile(4, 1, 2, 3),
  mooshroom: profile(10, 2, 3),
  sulfur_cube: profile(4, 1, 2),
  cod: profile(8, 2, 3, 4),
  squid: profile(3, 1, 2, 3),
  zombie: profile(10, 1, 2),
  skeleton: profile(10, 1, 2),
  creeper: profile(4, 1, 1, 2),
  spider: profile(7, 1, 2),
  enderman: profile(2, 1, 1, 3),
  slime: profile(4, 1, 2),
  husk: profile(10, 1, 2),
  stray: profile(10, 1, 2),
  piglin: profile(10, 1, 2),
  ghast: profile(2, 1, 1, 2),
});

const point = (value) =>
  !!value && [value.x, value.y, value.z].every(Number.isFinite);
const uint = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const light = (value) => Number.isInteger(value) && value >= 0 && value <= 15;
const species = (kind) =>
  typeof kind === "string" && Object.hasOwn(MOB_SPECIES, kind) ? MOB_SPECIES[kind] : null;
const unit = (key) => {
  let value = 2166136261;
  for (const char of String(key))
    value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return (value >>> 0) / 4294967296;
};
const delay = (seed, name, serial, initial) => {
  const rule = MOB_SPAWN_POOLS[name];
  const min = initial ? rule.initialMin : rule.intervalMin;
  const max = initial ? rule.initialMax : rule.intervalMax;
  return min + unit(`${seed}:${name}:${serial}:delay`) * (max - min);
};

/** Ephemeral per-world/dimension schedule. Keep it across pause/resume; a
 * restored owner waits at least a full maximum interval, so repeated reloads
 * cannot accelerate replenishment. Opt into the shorter first-world warmup
 * only for a genuinely new world, never for travel or difficulty changes.
 * No persisted spawn debt, shared Wildlife RNG, wall clock or growing history.
 */
export function createMobSpawnClock(identity, { restored = true } = {}) {
  if (typeof restored !== "boolean")
    throw new RangeError("Spawn-clock restoration flag must be boolean");
  const seed = Math.floor(unit(identity) * 4294967296);
  return {
    seed,
    lanes: Object.fromEntries(pools.map((name) => [
      name, {
        remaining: restored
          ? MOB_SPAWN_POOLS[name].intervalMax + unit(`${seed}:${name}:restore`)
          : delay(seed, name, 0, true),
        serial: 0,
      },
    ])),
  };
}

export function stepMobSpawnClock(previous, dt, { paused = false, difficulty } = {}) {
  const policy = difficultyPolicy(difficulty);
  if (paused || !Number.isFinite(dt) || dt <= 0)
    return { state: previous, pulses: [] };
  if (!uint(previous?.seed) || !previous.lanes ||
    pools.some((name) => !uint(previous.lanes[name]?.serial) ||
      !Number.isFinite(previous.lanes[name]?.remaining) ||
      previous.lanes[name].remaining < 0))
    throw new RangeError("Invalid ephemeral mob spawn clock");
  const step = Math.min(dt, MOB_SPAWN_LIMITS.step);
  const state = { seed: previous.seed, lanes: {} }, pulses = [];
  for (const name of pools) {
    const lane = { ...previous.lanes[name] };
    lane.remaining = Math.max(0, lane.remaining - step);
    if (lane.remaining === 0) {
      // Consume blocked/full/Peaceful opportunities too. No catch-up loop.
      const serial = lane.serial;
      lane.serial = (serial + 1) >>> 0;
      lane.remaining = delay(state.seed, name, lane.serial, false);
      if (name !== "hostile" || policy.hostileSpawns)
        pulses.push(Object.freeze({ pool: name, serial, seed: state.seed }));
    }
    state.lanes[name] = lane;
  }
  return { state, pulses };
}

/** Eight bounded candidate columns per pulse. No reads, generation or admission.
 * Height, loaded whole-body footprint and ACTUAL post-jitter distance must be
 * checked by the parent. Species/group rolls are stable for a pool's site.
 */
export function sampleMobSpawnColumn(pulse, player, attempt) {
  if (!pulse || !pools.includes(pulse.pool) || !uint(pulse.seed) ||
    !uint(pulse.serial) || !point(player) || !Number.isInteger(attempt) ||
    attempt < 0 || attempt >= MOB_SPAWN_LIMITS.candidatesPerPulse) return null;
  const key = `${pulse.seed}:${pulse.pool}:${pulse.serial}:${attempt}`;
  const angle = unit(`${key}:angle`) * Math.PI * 2;
  const min = MOB_SPAWN_LIMITS.minDistance, max = MOB_SPAWN_LIMITS.maxDistance;
  const radius = Math.sqrt(min * min + unit(`${key}:radius`) * (max * max - min * min));
  const cellX = Math.floor((player.x + Math.sin(angle) * radius) / MOB_SPAWN_LIMITS.cellSize);
  const cellZ = Math.floor((player.z + Math.cos(angle) * radius) / MOB_SPAWN_LIMITS.cellSize);
  const site = `${pulse.seed}:${pulse.pool}:${cellX},${cellZ}`;
  return {
    cellX, cellZ,
    x: cellX * MOB_SPAWN_LIMITS.cellSize + 1.5 + unit(`${site}:x`) * 5,
    z: cellZ * MOB_SPAWN_LIMITS.cellSize + 1.5 + unit(`${site}:z`) * 5,
    speciesRoll: unit(`${site}:species`),
    groupRoll: unit(`${site}:group`),
  };
}

export function mobSpawnDistanceAllowed(position, player) {
  if (!point(position) || !point(player)) return false;
  const distance = Math.hypot(
    position.x - player.x, position.y - player.y, position.z - player.z
  );
  return distance >= MOB_SPAWN_LIMITS.minDistance && distance <= MOB_SPAWN_LIMITS.maxDistance;
}

/** Includes ecology hostiles, dolphins and turtles in the appropriate budget.
 * Villagers consume total capacity, not the independent animal-density cap.
 */
export function mobPopulationPool(kind) {
  const spec = species(kind);
  if (!spec) return null;
  if (isHostileSpecies(spec)) return "hostile";
  if (kind === "villager") return null;
  return spec.aquatic ? "aquatic" : "passive";
}

/** Pass only the host's bounded resident array, not an entire saved archive.
 * Owned/tamed/dormant residents still occupy their slots. Never make room by
 * removing them; a full budget simply declines new arrivals.
 */
export function countMobSpawnPopulation(entities) {
  if (!Array.isArray(entities) || entities.length > MAX_MOBS)
    throw new RangeError("Mob population requires the bounded resident array");
  const counts = { total: 0, pools: { passive: 0, aquatic: 0, hostile: 0 }, species: {} };
  for (const mob of entities) {
    if (!species(mob?.kind)) throw new RangeError("Unknown resident mob species");
    if (mob.dead === true) continue;
    counts.total++;
    counts.species[mob.kind] = (counts.species[mob.kind] ?? 0) + 1;
    const name = mobPopulationPool(mob.kind);
    if (name) counts.pools[name]++;
  }
  Object.freeze(counts.pools);
  Object.freeze(counts.species);
  return Object.freeze(counts);
}

/** Independent total, pool, species and per-frame admission budgets.
 * Also usable by the parent's ecology admission path; habitat/unique marker
 * authority remains there. Do not apply this as a filter while restoring saves.
 */
export function remainingMobSpawnCapacity(
  kind,
  population,
  { difficulty, maxEntities = MAX_MOBS, frameRemaining = MOB_SPAWN_LIMITS.admissionsPerFrame } = {}
) {
  const hostileLimit = hostileLimitForDifficulty(difficulty, MAX_HOSTILES);
  const spec = species(kind);
  if (!spec) return 0;
  const name = mobPopulationPool(kind);
  const count = population?.species?.[kind] ?? 0;
  const poolCount = name ? population?.pools?.[name] : 0;
  if (![population?.total, count, poolCount, maxEntities].every(
    (value) => Number.isInteger(value) && value >= 0 && value <= MAX_MOBS
  ) || !Number.isInteger(frameRemaining) || frameRemaining < 0 ||
    frameRemaining > MOB_SPAWN_LIMITS.admissionsPerFrame)
    throw new RangeError("Invalid bounded mob population budget");
  const poolLimit = name === "hostile" ? hostileLimit :
    name ? MOB_SPAWN_POOLS[name].limit : MAX_MOBS;
  const speciesLimit = Math.min(
    NATURAL_MOB_PROFILES[kind]?.limit ?? spec.limit ?? 5,
    spec.limit ?? MAX_MOBS
  );
  return Math.max(0, Math.min(
    frameRemaining, maxEntities - population.total,
    poolLimit - poolCount, speciesLimit - count
  ));
}

function naturalSupport(kind, groundId) {
  if (!Number.isInteger(groundId)) return false;
  if (kind === "mooshroom") return groundId === BLOCK.MYCELIUM;
  if (kind === "camel") return [BLOCK.SAND, BLOCK.RED_SAND].includes(groundId);
  if (kind === "rabbit") return [
    BLOCK.GRASS, BLOCK.MOSS, BLOCK.SAND, BLOCK.RED_SAND, BLOCK.SNOW_BLOCK,
  ].includes(groundId);
  if (kind === "polar_bear") return [
    BLOCK.GRASS, BLOCK.SNOW_BLOCK, BLOCK.ICE, BLOCK.PACKED_ICE, BLOCK.BLUE_ICE,
  ].includes(groundId);
  if (kind === "frog") return [
    BLOCK.GRASS, BLOCK.MOSS, BLOCK.MUD, BLOCK.DIRT, BLOCK.CLAY,
  ].includes(groundId);
  if (kind === "sulfur_cube") return [
    BLOCK.STONE, BLOCK.DEEPSLATE, BLOCK.TUFF, BLOCK.BASALT, BLOCK.SULFUR, BLOCK.POTENT_SULFUR,
  ].includes(groundId);
  return [BLOCK.GRASS, BLOCK.MOSS].includes(groundId);
}

function habitatAllowed(kind, site) {
  const spec = MOB_SPECIES[kind];
  if (spec.aquatic)
    return Number.isFinite(site.waterDepth) && site.waterDepth >= spec.minWaterDepth;
  if (isHostileSpecies(spec)) {
    if (site.dimension === "overworld" &&
      (!light(site.blockLight) || !light(site.skyLight) ||
        site.blockLight !== 0 || site.skyLight > 7 ||
        (!site.underground && isDaylight(site.timeOfDay)))) return false;
    const support = BLOCKS[site.groundId];
    return spec.flying || (!!support?.solid &&
      ![BLOCK.CACTUS, BLOCK.MAGMA_BLOCK].includes(site.groundId) &&
      !["leaves", "log"].includes(support.texture));
  }
  if (spec.undergroundOnly)
    return site.underground && naturalSupport(kind, site.groundId);
  if (site.underground || !naturalSupport(kind, site.groundId) ||
    !light(site.blockLight) || !light(site.skyLight)) return false;
  if (spec.nocturnalPassive) return !isDaylight(site.timeOfDay);
  return isDaylight(site.timeOfDay) && Math.max(site.blockLight, site.skyLight) >= 9;
}

/**
 * Site is a detached observation of the ACTUAL candidate: dimension, biomeId,
 * timeOfDay, underground, water, groundId, blockLight, skyLight, waterDepth,
 * loaded (whole footprint). skyLight is effective daylight-adjusted 0..15,
 * NOT fullbright/render intensity. Missing required light fails closed.
 * This helper never reads the World, creates a mob or claims a native marker.
 */
export function naturalMobSpawnCandidates(name, site, population, options = {}) {
  const policy = difficultyPolicy(options.difficulty);
  if (!pools.includes(name)) throw new RangeError("Unknown natural spawn pool");
  if ((name === "hostile" && !policy.hostileSpawns) || site?.loaded !== true ||
    typeof site.biomeId !== "string" || site.biomeId.length === 0 ||
    !["overworld", "nether", "end"].includes(site.dimension) ||
    !Number.isFinite(site.timeOfDay) || typeof site.underground !== "boolean" ||
    typeof site.water !== "boolean") return [];
  return speciesForBiome({ id: site.biomeId }, {
    dimension: site.dimension,
    timeOfDay: site.underground ? 0 : site.timeOfDay,
    water: site.water,
    hostile: name === "hostile",
  }).filter((kind) => Object.hasOwn(NATURAL_MOB_PROFILES, kind) &&
    mobPopulationPool(kind) === name &&
    (!MOB_SPECIES[kind].undergroundOnly || site.underground) &&
    habitatAllowed(kind, site) &&
    remainingMobSpawnCapacity(kind, population, options) > 0
  ).map((kind) => Object.freeze({ kind, weight: NATURAL_MOB_PROFILES[kind].weight }));
}

/** The caller supplies a deterministic roll; selection cannot consume or
 * reseed a gameplay/loot RNG. Empty admission is not a passive-spawn fallback.
 */
export function chooseMobSpawnSpecies(candidates, roll) {
  if (!Number.isFinite(roll) || roll < 0 || roll >= 1 ||
    !Array.isArray(candidates) || candidates.length > Object.keys(NATURAL_MOB_PROFILES).length ||
    candidates.some((entry) => !Object.hasOwn(NATURAL_MOB_PROFILES, entry?.kind) ||
      !Number.isFinite(entry.weight) || entry.weight <= 0))
    throw new RangeError("Invalid weighted natural spawn choice");
  const total = candidates.reduce((sum, entry) => sum + entry.weight, 0);
  if (!Number.isFinite(total)) throw new RangeError("Natural spawn weights overflow");
  let remaining = roll * total;
  for (const entry of candidates) {
    remaining -= entry.weight;
    if (remaining < 0) return entry.kind;
  }
  return candidates.at(-1)?.kind ?? null;
}

/** Stable group slots and horizontally spaced HEIGHT HINTS, not admitted
 * positions. Resolve each member's y, habitat/light, distance, collision and
 * capacity again. Never clone the first member's safe-ground result.
 */
export function planMobSpawnGroup(kind, anchor, roll) {
  if (!Object.hasOwn(NATURAL_MOB_PROFILES, kind) || !point(anchor)) return [];
  if (!Number.isFinite(roll) || roll < 0 || roll >= 1)
    throw new RangeError("Invalid mob group roll");
  const { minGroup, maxGroup } = NATURAL_MOB_PROFILES[kind];
  const count = Math.min(MOB_SPAWN_LIMITS.maxGroup,
    minGroup + Math.floor(roll * (maxGroup - minGroup + 1)));
  const spacing = MOB_SPECIES[kind].radius * 2 + 1.2;
  return Array.from({ length: count }, (_, slot) => {
    const angle = roll * Math.PI * 2 + slot * 2.399963229728653;
    return Object.freeze({
      slot,
      x: anchor.x + (slot ? Math.sin(angle) * spacing : 0),
      z: anchor.z + (slot ? Math.cos(angle) * spacing : 0),
      nearY: anchor.y,
    });
  });
}
