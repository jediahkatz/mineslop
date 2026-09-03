import { normalizeFluidSnapshot } from "./fluid-save.js";
import { createWorldContext, DIMENSIONS, getWorldSpec } from "./world-spec.js";

export const fluidServiceRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const fluidServiceSynchronous = (callback) =>
  typeof callback === "function" &&
  Object.prototype.toString.call(callback) === "[object Function]";

/** Validate every dimension before allocating a staged scheduler. */
export function normalizeFluidServiceContext(context) {
  if (
    !fluidServiceRecord(context) ||
    typeof context.seed !== "string" ||
    context.seed.length > 80 ||
    !fluidServiceSynchronous(context.specForDimension)
  )
    return null;
  try {
    for (const dimension of DIMENSIONS) {
      const spec = context.specForDimension(dimension);
      const canonical = getWorldSpec(context.generatorVersion, dimension);
      if (
        !fluidServiceRecord(spec) ||
        ["minY", "maxY", "seaLevel", "voidY"].some(
          (field) => spec[field] !== canonical[field]
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
 * Archive projection, not a World load. Only ABSENT fluid sidecars migrate to
 * an empty scheduler; explicit null, unsupported versions and malformed queues
 * reject. Historical World source bytes remain dormant on cold admissions.
 */
export function normalizeFluidServicesSnapshot(saved, context) {
  const cleanContext = normalizeFluidServiceContext(context);
  if (!cleanContext) return null;
  if (saved === undefined || saved === null) saved = {};
  if (!fluidServiceRecord(saved)) return null;
  const fluids = Object.hasOwn(saved, "fluids")
    ? normalizeFluidSnapshot(saved.fluids, cleanContext)
    : {
        version: 1,
        seed: cleanContext.seed,
        generatorVersion: cleanContext.generatorVersion,
        dimensions: [],
      };
  return fluids ? { fluids } : null;
}

export function fluidHostBindable(game, name, value) {
  const slot = Object.getOwnPropertyDescriptor(game, name);
  return slot
    ? Object.hasOwn(slot, "value") &&
        slot.configurable &&
        (slot.value == null ||
          slot.value === value ||
          slot.value._disposed === true)
    : Object.isExtensible(game);
}

/**
 * Read-through World view: no copied cells, subscriptions or replacement of
 * World methods. Every prepared World participant gains the host lifecycle
 * prerequisite, even on a fluid tick without plant loot. An observer replacing
 * the host also stops the remaining catch-up ticks in that same update.
 */
export function hostedFluidWorld(service) {
  const world = service.world;
  return Object.freeze({
    get seed() {
      return world.seed;
    },
    get generatorVersion() {
      return world.generatorVersion;
    },
    get dimension() {
      return service._frameBusy && !service._running()
        ? undefined
        : world.dimension;
    },
    get epoch() {
      return world.epoch;
    },
    get spec() {
      return world.spec;
    },
    get chunks() {
      return world.chunks;
    },
    get coordinator() {
      return world.coordinator;
    },
    getCell: (x, y, z) => world.getCell(x, y, z),
    prepareMutation: (changes, options) =>
      service._prepareWorld(changes, options),
  });
}
