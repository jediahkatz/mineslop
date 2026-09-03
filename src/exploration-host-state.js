import {
  EXPLORATION_VERSION,
  normalizeExplorationSnapshot,
} from "./exploration-state.js";
import {
  normalizeProgressContext,
  progressRecord,
  synchronousProgressCallback,
} from "./progression-common.js";

export const EXPLORATION_SERVICE_LIMITS = Object.freeze({
  columns: 512,
  markers: 32768,
  descriptorsPerColumn: 8,
  markersPerColumn: 64,
  scanColumns: 8,
});
const CAPS = Object.freeze({
  columns: 512,
  markers: 32768,
  descriptorsPerColumn: 64,
  markersPerColumn: 64,
  scanColumns: 32,
});

export const explorationContextMatches = (context, world) =>
  context?.seed === world.seed &&
  context?.generatorVersion === world.generatorVersion;

/** Only absence migrates. A present null/undefined/accessor sidecar rejects. */
export function normalizeExplorationServicesSnapshot(saved, context) {
  try {
    const clean = normalizeProgressContext(context);
    if (saved === undefined || saved === null) saved = {};
    if (
      !saved ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(saved))
    )
      return null;
    const field = Object.getOwnPropertyDescriptor(saved, "exploration");
    if (field && (!field.enumerable || !Object.hasOwn(field, "value")))
      return null;
    const exploration = field
      ? normalizeExplorationSnapshot(field.value, clean)
      : {
          version: EXPLORATION_VERSION,
          seed: clean.seed,
          generatorVersion: clean.generatorVersion,
          containers: [],
          encounters: [],
        };
    return exploration ? { exploration } : null;
  } catch {
    return null;
  }
}

export function explorationServiceLimits(value) {
  progressRecord(value, Object.keys(CAPS));
  const limits = { ...EXPLORATION_SERVICE_LIMITS, ...value };
  if (
    Object.entries(limits).some(
      ([key, count]) =>
        !Number.isSafeInteger(count) || count < 1 || count > CAPS[key]
    )
  )
    throw new RangeError("Exploration resident limits exceed their bounds");
  return Object.freeze(limits);
}

/** The actual current generator's cheap column sampler, never a voxel query. */
export function nativeExplorationContext(world) {
  const generator = world.generator;
  if (
    world.generatorVersion !== 4 ||
    generator?.generatorVersion !== 4 ||
    generator.seed !== world.seed ||
    generator.dimension !== world.dimension ||
    !synchronousProgressCallback(generator.sampleColumn) ||
    ["minY", "maxY", "seaLevel", "voidY"].some(
      (key) => generator.spec?.[key] !== world.spec[key]
    )
  )
    throw new RangeError("Native structure sampling is unavailable");
  return {
    seed: world.seed,
    dimension: world.dimension,
    spec: world.spec,
    sampleColumn: (x, z) => generator.sampleColumn(x, z),
  };
}

/** Replays ONLY an already-admitted resident; this does not generate or edit. */
export function explorationAdmission(world, chunk) {
  return Object.freeze({
    world,
    chunk,
    seed: world.seed,
    generatorVersion: world.generatorVersion,
    epoch: world.epoch,
    dimension: world.dimension,
    key: `${chunk.cx},${chunk.cz}`,
    cx: chunk.cx,
    cz: chunk.cz,
    incarnation: chunk.incarnation,
    revision: chunk.revision,
  });
}

export function explorationHostBindable(game, name, value) {
  const slot = Object.getOwnPropertyDescriptor(game, name);
  return slot
    ? Object.hasOwn(slot, "value") &&
        slot.configurable &&
        (slot.value == null ||
          slot.value === value ||
          slot.value._disposed === true)
    : Object.isExtensible(game);
}
