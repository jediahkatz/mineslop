import { entityContextFor } from "./entity-context.js";
import {
  HORSE_BASE_RECORD_RESERVED_BYTES, HORSE_HEADER_RESERVED_BYTES,
  HORSE_MAX_FALL_DISTANCE, HORSE_MAX_SPEED, HORSE_MAX_VERTICAL_SPEED,
  HORSE_RECORD_RESERVED_BYTES, HORSE_TAMING_TICKS, HORSE_TOMBSTONE_RESERVED_BYTES,
  MAX_LIVING_HORSES, MAX_RETAINED_HORSE_IDS, horseId, isHorseSaddle,
} from "./horse-definitions.js";
import { cloneStack, isValidStack } from "./inventory-slots.js";
import { encodedBytes } from "./save-budget.js";
import { DIMENSIONS, isDimension } from "./world-spec.js";

/** Reject accessors before reading them. Save data cannot execute game hooks. */
export function horseDataRecord(value, allowed, required = allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value);
  return keys.every((key) => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === "string" && allowed.includes(key) &&
      property.enumerable && Object.hasOwn(property, "value");
  }) && required.every((key) => Object.hasOwn(value, key));
}

export function horseDataArray(value, maximum) {
  if (!Array.isArray(value) || value.length > maximum) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === value.length + 1 && keys.every((key) => {
    if (key === "length") return true;
    const property = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === "string" && /^(0|[1-9]\d*)$/.test(key) &&
      Number(key) < value.length && property.enumerable && Object.hasOwn(property, "value");
  });
}

const bounded = (value, low, high) =>
  Number.isFinite(value) && value >= low && value <= high;
const liveFields = [
  "id", "dimension", "alive", "tamed", "temper", "failedAttempts",
  "saddle", "rider", "tamingTicksLeft", "motion",
];
const deadFields = ["id", "dimension", "alive"];
const motionFields = ["vx", "vy", "vz", "grounded", "fallDistance"];

export function validHorseMotion(value) {
  return horseDataRecord(value, motionFields) &&
    bounded(value.vx, -HORSE_MAX_SPEED, HORSE_MAX_SPEED) &&
    bounded(value.vz, -HORSE_MAX_SPEED, HORSE_MAX_SPEED) &&
    bounded(value.vy, -HORSE_MAX_VERTICAL_SPEED, HORSE_MAX_VERTICAL_SPEED) &&
    typeof value.grounded === "boolean" &&
    bounded(value.fallDistance, 0, HORSE_MAX_FALL_DISTANCE) &&
    (!value.grounded || (value.vy === 0 && value.fallDistance === 0));
}

export function cloneHorseRecord(entry, context) {
  if (!entry.alive) return { id: entry.id, dimension: entry.dimension, alive: false };
  return {
    id: entry.id, dimension: entry.dimension, alive: true,
    tamed: entry.tamed, temper: entry.temper, failedAttempts: entry.failedAttempts,
    saddle: entry.saddle === null ? null : cloneStack(entry.saddle, context),
    rider: entry.rider, tamingTicksLeft: entry.tamingTicksLeft,
    motion: entry.motion === null ? null : { ...entry.motion },
  };
}

export function normalizeHorseRecord(value, context) {
  try {
    if (!horseDataRecord(value, liveFields, deadFields) || !horseId(value.id) ||
      !isDimension(value.dimension) || typeof value.alive !== "boolean") return null;
    if (!value.alive) {
      if (!horseDataRecord(value, deadFields)) return null;
      const result = cloneHorseRecord(value, context);
      return encodedBytes(result) + 1 <= HORSE_TOMBSTONE_RESERVED_BYTES ? result : null;
    }
    if (!horseDataRecord(value, liveFields) ||
      typeof value.tamed !== "boolean" ||
      !Number.isInteger(value.temper) || !bounded(value.temper, 0, 100) ||
      !Number.isInteger(value.failedAttempts) || !bounded(value.failedAttempts, 0, 20) ||
      value.temper < value.failedAttempts * 5 ||
      (value.saddle !== null &&
        (!horseDataRecord(value.saddle, ["id", "count", "data"], ["id", "count"]) ||
          !isHorseSaddle(value.saddle) || !isValidStack(value.saddle, context))) ||
      (!value.tamed && value.saddle !== null) ||
      (value.rider !== null && value.rider !== "player") ||
      !bounded(value.tamingTicksLeft, 0, HORSE_TAMING_TICKS) ||
      (value.tamed && value.tamingTicksLeft !== 0) ||
      (!value.tamed && value.tamingTicksLeft === 0 &&
        (value.rider === null || value.failedAttempts === 0)) ||
      (value.motion !== null && !validHorseMotion(value.motion)) ||
      (value.rider === null && value.motion?.grounded === true) ||
      (value.rider !== null && value.motion === null)) return null;
    const result = cloneHorseRecord(value, context);
    return encodedBytes(result) + 1 <= HORSE_RECORD_RESERVED_BYTES ? result : null;
  } catch {
    return null;
  }
}

export function emptyHorseSnapshot(context) {
  context = entityContextFor(undefined, context);
  return { version: 1, seed: String(context.seed),
    generatorVersion: context.generatorVersion, entries: [] };
}

/**
 * Absence is an ARCHIVE concern: call emptyHorseSnapshot(context) only when the
 * top-level key is absent. Explicit undefined/null, including here, rejects.
 */
export function normalizeHorseSnapshot(value, context) {
  try {
    context = entityContextFor(undefined, context);
    for (const dimension of DIMENSIONS) context.specForDimension(dimension);
    if (!horseDataRecord(value, ["version", "seed", "generatorVersion", "entries"]) ||
      value.version !== 1 || typeof value.seed !== "string" ||
      value.seed !== String(context.seed) || value.generatorVersion !== context.generatorVersion ||
      !horseDataArray(value.entries, MAX_RETAINED_HORSE_IDS)) return null;
    const header = emptyHorseSnapshot(context);
    if (encodedBytes(header) > HORSE_HEADER_RESERVED_BYTES) return null;
    const ids = new Set(), entries = [];
    let living = 0, riders = 0;
    for (const raw of value.entries) {
      const entry = normalizeHorseRecord(raw, context);
      if (!entry || ids.has(entry.id) ||
        (entry.alive && ++living > MAX_LIVING_HORSES) ||
        (entry.alive && entry.rider !== null && ++riders > 1)) return null;
      ids.add(entry.id);
      entries.push(entry);
    }
    return { ...header, entries };
  } catch {
    return null;
  }
}

/** The complete owned Wildlife projection, not a second saved pose collection. */
export function horseBaseProjection(mob) {
  return {
    id: mob.id, kind: mob.kind,
    position: { x: mob.position.x, y: mob.position.y, z: mob.position.z },
    health: mob.health, yaw: mob.root?.rotation.y ?? mob.yaw,
    tamed: mob.tamed, angry: mob.angry, attackCooldown: mob.attackCooldown,
    fuse: mob.fuse, pacified: mob.pacified,
  };
}

export function sameHorseBase(a, b) {
  return a.id === b.id && a.kind === b.kind && a.health === b.health &&
    a.yaw === b.yaw && a.tamed === b.tamed && a.angry === b.angry &&
    a.attackCooldown === b.attackCooldown && a.fuse === b.fuse && a.pacified === b.pacified &&
    ["x", "y", "z"].every((key) => a.position[key] === b.position[key]);
}

/**
 * Parent supplies ONE already-normalized canonical snapshot per dimension.
 * Compatibility copies are compared by parent using sameHorseBase(), never
 * concatenated here. Validate Ecology first and supply its normalized sidecar.
 */
export function horseMobLinksValid(horses, snapshots, { ecology } = {}) {
  try {
    if (!horses || !Array.isArray(horses.entries) ||
      !Array.isArray(snapshots) || snapshots.length > DIMENSIONS.length) return false;
    const entries = new Map(horses.entries.map((entry) => [entry.id, entry]));
    const ecologyIds = new Set([
      ...(ecology?.entries ?? []).map((entry) => entry.id),
      ...(ecology?.eggs ?? []).flatMap((egg) => [egg.id, egg.childId]),
    ]);
    if ([...entries.keys()].some((id) => ecologyIds.has(id))) return false;
    const seen = new Set(), dimensions = new Set(), live = new Set();
    for (const snapshot of snapshots) {
      if (!snapshot || !isDimension(snapshot.dimension) ||
        dimensions.has(snapshot.dimension)) return false;
      dimensions.add(snapshot.dimension);
      for (const id of snapshot.killed) {
        if (entries.has(id) || seen.has(id)) return false;
        seen.add(id);
      }
      for (const mob of snapshot.entities) {
        if (seen.has(mob.id)) return false;
        seen.add(mob.id);
        const state = entries.get(mob.id);
        if (!state) continue;
        if (!state.alive || mob.kind !== "horse" || mob.tamed ||
          state.dimension !== snapshot.dimension ||
          encodedBytes(horseBaseProjection(mob)) + 1 > HORSE_BASE_RECORD_RESERVED_BYTES) return false;
        live.add(mob.id);
      }
    }
    return horses.entries.every((entry) => entry.alive === live.has(entry.id));
  } catch {
    return false;
  }
}
