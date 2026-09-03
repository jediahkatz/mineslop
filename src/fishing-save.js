import { validPassengerId } from "./boat-definitions.js";
import { fishingWaitTicks as applyFishingLure } from "./enchantment-effects.js";
import { entityContextFor } from "./entity-context.js";
import { fishingRodStats, validFishingRandomState } from "./fishing-loot.js";
import {
  BOBBER_RADIUS,
  FISHING_PHASES,
  FISHING_TICK,
  MAX_BOBBER_FLIGHT_TICKS,
  MAX_BOBBER_SPEED,
  MAX_FISHING_CASTS,
} from "./fishing-physics.js";
import { cloneStack } from "./inventory-slots.js";
import { seedHash } from "./noise.js";
import { encodedBytes } from "./save-budget.js";
import { WORLD_MAX, WORLD_MIN } from "./terrain.js";
import { isWorldPose } from "./world-spec.js";

export const FISHING_RECORD_RESERVED_BYTES = 4096;
export const FISHING_HEADER_RESERVED_BYTES = 1024;
const record = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value, min, max) =>
  Number.isSafeInteger(value) && value >= min && value <= max;
const fields = new Set([
  "id",
  "ownerId",
  "hand",
  "slotKey",
  "handRevision",
  "rod",
  "dimension",
  "origin",
  "x",
  "y",
  "z",
  "vx",
  "vy",
  "vz",
  "phase",
  "remaining",
  "total",
  "flightTicks",
  "randomState",
  "openWater",
  "accumulator",
  "approachAngle",
  "lure",
  "luck",
]);
export const validFishingSlotKey = (key) =>
  typeof key === "string" && /^[a-zA-Z0-9_.:-]{1,48}$/.test(key);

export function cloneFishingRecord(value, context) {
  return {
    ...value,
    rod: cloneStack(value.rod, context),
    origin: { ...value.origin },
  };
}

export function normalizeFishingRecord(value, context) {
  try {
    const stats = fishingRodStats(value?.rod, context);
    if (
      !record(value) ||
      !stats ||
      Object.keys(value).some((key) => !fields.has(key)) ||
      !integer(value.id, 1, Number.MAX_SAFE_INTEGER - 1) ||
      !validPassengerId(value.ownerId) ||
      !["main", "offhand"].includes(value.hand) ||
      !validFishingSlotKey(value.slotKey) ||
      !integer(value.handRevision, 0, Number.MAX_SAFE_INTEGER) ||
      !isWorldPose(value, context, value.dimension) ||
      value.x < WORLD_MIN + BOBBER_RADIUS ||
      value.x > WORLD_MAX - BOBBER_RADIUS ||
      value.z < WORLD_MIN + BOBBER_RADIUS ||
      value.z > WORLD_MAX - BOBBER_RADIUS ||
      !record(value.origin) ||
      Object.keys(value.origin).some((key) => !["x", "y", "z"].includes(key)) ||
      !isWorldPose(value.origin, context, value.dimension) ||
      !["vx", "vy", "vz"].every(
        (key) =>
          Number.isFinite(value[key]) &&
          Math.abs(value[key]) <= MAX_BOBBER_SPEED
      ) ||
      !FISHING_PHASES.includes(value.phase) ||
      !integer(value.flightTicks, 0, MAX_BOBBER_FLIGHT_TICKS) ||
      !validFishingRandomState(value.randomState) ||
      typeof value.openWater !== "boolean" ||
      !Number.isFinite(value.accumulator) ||
      value.accumulator < 0 ||
      value.accumulator >= FISHING_TICK ||
      !Number.isFinite(value.approachAngle) ||
      value.approachAngle < 0 ||
      value.approachAngle > Math.PI * 2 ||
      value.lure !== stats.lure ||
      value.luck !== stats.luck
    )
      return null;
    const minimumWait = applyFishingLure(100, value.lure);
    // Zero timers identify a pending draw, never an expired accepted wait.
    if (value.phase === "wait-retry" && minimumWait > 0) return null;
    const ranges = {
      flying: [0, 0],
      stuck: [0, 0],
      "wait-retry": [0, 0],
      waiting: [Math.max(1, minimumWait), applyFishingLure(600, value.lure)],
      approach: [20, 80],
      hook: [20, 40],
    };
    const [min, max] = ranges[value.phase];
    if (
      !integer(value.total, min, max) ||
      !integer(value.remaining, min === 0 ? 0 : 1, value.total)
    )
      return null;
    const clean = cloneFishingRecord(value, context);
    return encodedBytes(clean) + 1 <= FISHING_RECORD_RESERVED_BYTES
      ? clean
      : null;
  } catch {
    return null;
  }
}

/** Detached all-dimension state; pending retries, RNG and bite windows survive reopen. */
export function normalizeFishingSnapshot(data, context) {
  try {
    context = entityContextFor(undefined, context);
    const empty = {
      version: 1,
      seed: String(context.seed),
      generatorVersion: context.generatorVersion,
      nextId: 1,
      randomState: seedHash(`${context.seed}:fishing`),
      casts: [],
    };
    if (data === undefined) return empty;
    if (
      !record(data) ||
      data.version !== 1 ||
      Object.keys(data).some((key) => !Object.hasOwn(empty, key)) ||
      data.seed !== empty.seed ||
      data.generatorVersion !== empty.generatorVersion ||
      !integer(data.nextId, 1, Number.MAX_SAFE_INTEGER) ||
      !validFishingRandomState(data.randomState) ||
      !Array.isArray(data.casts) ||
      data.casts.length > MAX_FISHING_CASTS
    )
      return null;
    const ids = new Set(),
      owners = new Set(),
      casts = [];
    for (const entry of data.casts) {
      const cast = normalizeFishingRecord(entry, context);
      if (
        !cast ||
        cast.id >= data.nextId ||
        ids.has(cast.id) ||
        owners.has(cast.ownerId)
      )
        return null;
      ids.add(cast.id);
      owners.add(cast.ownerId);
      casts.push(cast);
    }
    return {
      ...empty,
      nextId: data.nextId,
      randomState: data.randomState,
      casts,
    };
  } catch {
    return null;
  }
}
