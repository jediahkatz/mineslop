import {
  isLooseDimension,
  isLooseMotion,
  isLoosePosition,
  isLooseRecord,
  looseMotion,
  serializeLooseMotion,
} from "./loose-entity.js";

export const MAX_EXPERIENCE_ORBS = 256;
export const MAX_ORB_EXPERIENCE = 32_767;
export const EXPERIENCE_ORB_LIFETIME = 300;
// Eight bounded finite-number fields, the amount, dimension, keys and separator.
// Motion/aging changes no reservation and never re-encodes the moving pool.
export const EXPERIENCE_ORB_RECORD_RESERVED_BYTES = 512;

const fields = new Set([
  "amount",
  "dimension",
  "x",
  "y",
  "z",
  "age",
  "pickupDelay",
  "velocity",
]);

/** Pure, detached canonical data. Importing this module allocates no renderers. */
export function normalizeExperienceOrbSnapshot(data, context) {
  if (data === undefined) return { version: 1, orbs: [] };
  if (
    !isLooseRecord(data) ||
    data.version !== 1 ||
    !Array.isArray(data.orbs) ||
    data.orbs.length > MAX_EXPERIENCE_ORBS ||
    Object.keys(data).some((key) => key !== "version" && key !== "orbs")
  )
    return null;
  const orbs = [];
  try {
    for (const entry of data.orbs) {
      if (
        !isLooseRecord(entry) ||
        Object.keys(entry).some((key) => !fields.has(key)) ||
        !isLooseDimension(entry.dimension) ||
        !isLoosePosition(entry, context) ||
        !isLooseMotion(entry) ||
        (entry.velocity !== undefined &&
          Object.keys(entry.velocity).some(
            (key) => !["x", "y", "z"].includes(key)
          )) ||
        !Number.isSafeInteger(entry.amount) ||
        entry.amount <= 0 ||
        entry.amount > MAX_ORB_EXPERIENCE ||
        (entry.age !== undefined &&
          (!Number.isFinite(entry.age) ||
            entry.age < 0 ||
            entry.age >= EXPERIENCE_ORB_LIFETIME))
      )
        return null;
      orbs.push({
        amount: entry.amount,
        dimension: entry.dimension,
        x: entry.x,
        y: entry.y,
        z: entry.z,
        age: entry.age ?? 0,
        ...serializeLooseMotion(looseMotion(entry)),
      });
    }
  } catch {
    return null;
  }
  return { version: 1, orbs };
}

export const validateExperienceOrbs = (data, context) =>
  normalizeExperienceOrbSnapshot(data, context) !== null;
