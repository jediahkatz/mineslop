import {
  PEARL_STEP_SECONDS,
  validPearlPosition,
  validPearlVelocity,
} from "./pearl-physics.js";
import { isDimension } from "./world-spec.js";

export const PLAYER_PROJECTILES_VERSION = 1;
export const MAX_PLAYER_PEARLS = 16;
export const PEARL_COOLDOWN_SECONDS = 1;
export const PEARL_LIFETIME_SECONDS = 30;
export const PEARL_FRONTIER_SECONDS = 2;
export const MAX_PEARL_ID = 2_147_483_647;
export const PEARL_HEADER_RESERVED_BYTES = 1024;
export const PEARL_RECORD_RESERVED_BYTES = 1024;

const headerFields = [
  "version",
  "seed",
  "generatorVersion",
  "ownerId",
  "life",
  "cooldown",
  "randomState",
  "nextId",
  "accumulator",
  "projectiles",
];
const projectileFields = [
  "id",
  "kind",
  "ownerId",
  "life",
  "dimension",
  "position",
  "velocity",
  "age",
  "wait",
  "spin",
];
const vectorFields = ["x", "y", "z"];

// No getters, unknown fields, prototypes or symbolic payloads enter a prepared
// record. These checks allocate no scene, model, material, texture or DOM node.
export function pearlDataRecord(value, fields) {
  if (
    !value ||
    typeof value !== "object" ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    return false;
  return Reflect.ownKeys(value).every((key) => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return (
      typeof key === "string" &&
      fields.includes(key) &&
      property.enumerable &&
      Object.hasOwn(property, "value")
    );
  });
}

export const validPearlOwnerId = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,63}$/.test(value);
export const validPearlLife = (value) =>
  Number.isSafeInteger(value) && value >= 0 && value <= MAX_PEARL_ID;
const uint32 = (value) =>
  Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff;
const inRange = (value, minimum, maximum) =>
  Number.isFinite(value) && value >= minimum && value < maximum;
const copyVector = (value) => ({ x: value.x, y: value.y, z: value.z });

export function clonePearlRecord(value) {
  return {
    id: value.id,
    kind: "ender_pearl",
    ownerId: value.ownerId,
    life: value.life,
    dimension: value.dimension,
    position: copyVector(value.position),
    velocity: copyVector(value.velocity),
    age: value.age,
    wait: value.wait,
    spin: value.spin,
  };
}

export function freezePearlRecord(value) {
  const copy = clonePearlRecord(value);
  Object.freeze(copy.position);
  Object.freeze(copy.velocity);
  return Object.freeze(copy);
}

export function nextPearlRandom(state) {
  let next = state >>> 0;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  return next >>> 0;
}

/**
 * Detached, all-dimension, renderer-free archive validation. `owner`, when
 * supplied, is {id,life?} from the parent's normalized player identity. All
 * records must belong to this one player life; unknown kinds are not skipped.
 * Inactive dimensions can be normalized, but runtime policy cancels them.
 */
export function normalizePlayerProjectilesSnapshot(data, context, owner) {
  try {
    if (
      !context ||
      typeof context.specForDimension !== "function" ||
      !pearlDataRecord(data, headerFields) ||
      data.version !== PLAYER_PROJECTILES_VERSION ||
      typeof data.seed !== "string" ||
      data.seed.length > 80 ||
      data.seed !== String(context.seed) ||
      data.generatorVersion !== context.generatorVersion ||
      ![1, 2, 3, 4].includes(data.generatorVersion) ||
      !validPearlOwnerId(data.ownerId) ||
      !validPearlLife(data.life) ||
      (owner !== undefined &&
        (!owner ||
          owner.id !== data.ownerId ||
          (owner.life !== undefined && owner.life !== data.life))) ||
      !Number.isFinite(data.cooldown) ||
      data.cooldown < 0 ||
      data.cooldown > PEARL_COOLDOWN_SECONDS ||
      !inRange(data.accumulator, 0, PEARL_STEP_SECONDS) ||
      !uint32(data.randomState) ||
      !Number.isSafeInteger(data.nextId) ||
      data.nextId < 1 ||
      data.nextId > MAX_PEARL_ID ||
      !Array.isArray(data.projectiles) ||
      data.projectiles.length > MAX_PLAYER_PEARLS
    )
      return null;
    const ids = new Set();
    const projectiles = [];
    for (const entry of data.projectiles) {
      if (
        !pearlDataRecord(entry, projectileFields) ||
        entry.kind !== "ender_pearl" ||
        !Number.isSafeInteger(entry.id) ||
        entry.id < 1 ||
        entry.id >= data.nextId ||
        ids.has(entry.id) ||
        entry.ownerId !== data.ownerId ||
        entry.life !== data.life ||
        !isDimension(entry.dimension) ||
        !pearlDataRecord(entry.position, vectorFields) ||
        !validPearlPosition(entry.position, context, entry.dimension) ||
        !pearlDataRecord(entry.velocity, vectorFields) ||
        !validPearlVelocity(entry.velocity) ||
        !inRange(entry.age, 0, PEARL_LIFETIME_SECONDS) ||
        !inRange(entry.wait, 0, PEARL_FRONTIER_SECONDS) ||
        entry.wait > entry.age ||
        !uint32(entry.spin)
      )
        return null;
      ids.add(entry.id);
      projectiles.push(clonePearlRecord(entry));
    }
    return {
      version: PLAYER_PROJECTILES_VERSION,
      seed: data.seed,
      generatorVersion: data.generatorVersion,
      ownerId: data.ownerId,
      life: data.life,
      cooldown: data.cooldown,
      randomState: data.randomState,
      nextId: data.nextId,
      accumulator: data.accumulator,
      projectiles,
    };
  } catch {
    return null;
  }
}

// The fixed header covers bounded UTF-8 seed/identity plus timers/RNG. A moving
// record's 1 KiB covers all bounded fields at maximum JSON number widths. Motion
// and countdowns therefore never serialize the pool to update reservations.
export const pearlReservedBytes = (count) =>
  PEARL_HEADER_RESERVED_BYTES + count * PEARL_RECORD_RESERVED_BYTES;
