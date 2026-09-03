import { normalizeBoatSnapshot } from "./boat-save.js";
import { normalizeFishingSnapshot } from "./fishing-save.js";
import { createWorldContext, DIMENSIONS, getWorldSpec } from "./world-spec.js";

export const vehicleRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const vehicleSynchronous = (callback) =>
  typeof callback === "function" &&
  Object.prototype.toString.call(callback) === "[object Function]";
export const vehicleContextMatches = (context, world) =>
  context?.seed === world.seed &&
  context?.generatorVersion === world.generatorVersion;

function dataOnly(value) {
  let remaining = 65536;
  const visit = (entry, depth = 0) => {
    if (--remaining < 0 || depth > 12) return false;
    if (
      entry === null ||
      typeof entry === "string" ||
      typeof entry === "boolean"
    )
      return true;
    if (typeof entry === "number") return Number.isFinite(entry);
    if (!entry || typeof entry !== "object") return false;
    if (Array.isArray(entry)) {
      if (
        Object.getPrototypeOf(entry) !== Array.prototype ||
        entry.length > remaining ||
        Reflect.ownKeys(entry).length !== entry.length + 1
      )
        return false;
      for (let index = 0; index < entry.length; index++) {
        const field = Object.getOwnPropertyDescriptor(entry, String(index));
        if (
          !field?.enumerable ||
          !Object.hasOwn(field, "value") ||
          !visit(field.value, depth + 1)
        )
          return false;
      }
      return true;
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(entry)))
      return false;
    for (const key of Reflect.ownKeys(entry)) {
      const field = Object.getOwnPropertyDescriptor(entry, key);
      if (
        typeof key !== "string" ||
        !field.enumerable ||
        !Object.hasOwn(field, "value") ||
        !visit(field.value, depth + 1)
      )
        return false;
    }
    return true;
  };
  return visit(value);
}

/** World accepts the empty seed. Do not trim, invent, or reject that identity. */
export function normalizeVehicleServiceContext(context) {
  try {
    if (
      !vehicleRecord(context) ||
      typeof context.seed !== "string" ||
      context.seed.length > 80 ||
      !vehicleSynchronous(context.specForDimension)
    )
      return null;
    for (const dimension of DIMENSIONS) {
      const spec = context.specForDimension(dimension);
      const canonical = getWorldSpec(context.generatorVersion, dimension);
      if (
        !vehicleRecord(spec) ||
        ["minY", "maxY", "seaLevel", "voidY"].some(
          (key) => spec[key] !== canonical[key]
        )
      )
        return null;
    }
    return createWorldContext(context);
  } catch {
    return null;
  }
}

/**
 * Pure archive projection, including inactive dimensions. Only ABSENT fields
 * migrate to empty components; a present undefined/null/unsupported payload
 * rejects. No World reads, registration, catalog writes or renderer allocation.
 */
export function normalizeVehicleServicesSnapshot(saved, context) {
  try {
    const cleanContext = normalizeVehicleServiceContext(context);
    if (!cleanContext) return null;
    if (saved === undefined || saved === null) saved = {};
    if (!vehicleRecord(saved)) return null;
    const values = {};
    for (const name of ["boats", "fishing"]) {
      const field = Object.getOwnPropertyDescriptor(saved, name);
      if (!field) continue;
      if (
        !field.enumerable ||
        !Object.hasOwn(field, "value") ||
        !dataOnly(field.value)
      )
        return null;
      values[name] = field.value;
    }
    const boats = normalizeBoatSnapshot(values.boats, cleanContext);
    const fishing = normalizeFishingSnapshot(values.fishing, cleanContext);
    return boats && fishing ? { boats, fishing } : null;
  } catch {
    return null;
  }
}

export function vehicleHostBindable(game, name, value) {
  const slot = Object.getOwnPropertyDescriptor(game, name);
  return slot
    ? Object.hasOwn(slot, "value") &&
        slot.configurable &&
        (slot.value == null ||
          slot.value === value ||
          slot.value._disposed === true)
    : Object.isExtensible(game);
}

/** A palette rod must never rebind to an equal finite Survival rod on reload. */
export function vehicleHandSlot(gameplay, hand) {
  if (hand === "offhand") return "offhand:0";
  if (
    hand !== "main" ||
    !Number.isInteger(gameplay.selected) ||
    gameplay.selected < 0 ||
    gameplay.selected > 8
  )
    return null;
  return `${gameplay.mode === "creative" ? "palette" : "inventory"}:${gameplay.selected}`;
}
