import { ecologyCompletionLinksValid, normalizeEcologyServicesSnapshot } from "./ecology-save.js";
import { normalizeEcologySnapshot } from "./expansion-ecology.js";
import { vehicleDataOnly } from "./game-vehicle-state.js";
import { HORSE_BASE_COPY_LIMIT } from "./horse-definitions.js";
import {
  emptyHorseSnapshot, horseBaseProjection, horseMobLinksValid,
  normalizeHorseSnapshot, sameHorseBase,
} from "./horse-save.js";
import { normalizeMobSnapshot } from "./mob-save.js";
import { DIMENSIONS, isDimension } from "./world-spec.js";

const record = (value) => value !== null && typeof value === "object" &&
  !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function field(object, key) {
  const property = Object.getOwnPropertyDescriptor(object, key);
  if (!property) return { present: false };
  if (!property.enumerable || !Object.hasOwn(property, "value") ||
      !vehicleDataOnly(property.value))
    throw new Error(`Invalid saved ${key}`);
  return { present: true, value: property.value };
}

function sameSnapshot(a, b) {
  if (a.dimension !== b.dimension || a.seed !== b.seed ||
      a.randomState !== b.randomState || a.nextId !== b.nextId ||
      a.entities.length !== b.entities.length || a.killed.length !== b.killed.length)
    return false;
  const killed = new Set(a.killed), entities = new Map(a.entities.map((mob) => [mob.id, mob]));
  return b.killed.every((id) => killed.has(id)) && b.entities.every((mob) => {
    const other = entities.get(mob.id);
    return other && sameHorseBase(horseBaseProjection(other), horseBaseProjection(mob)) &&
      other.absorbedBlock === mob.absorbedBlock;
  });
}

/**
 * One canonical Wildlife projection per dimension. All legacy locations are
 * validated, not concatenated or silently discarded. This runs before terrain
 * staging/teardown, and never reads getters in any sidecar/base copy.
 */
export function normalizeGameMobArchive(saved, context, dimension = "overworld", {
  horses: suppliedHorses, exploration,
} = {}) {
  if (saved == null) saved = {};
  if (!record(saved) || !isDimension(dimension)) throw new Error("Invalid saved creatures");
  const horseField = field(saved, "horses");
  const horses = normalizeHorseSnapshot(suppliedHorses ??
    (horseField.present ? horseField.value : emptyHorseSnapshot(context)), context);
  if (!horses) throw new Error("Invalid saved horses");
  if (horseField.present && suppliedHorses &&
      JSON.stringify(normalizeHorseSnapshot(horseField.value, context)) !== JSON.stringify(horses))
    throw new Error("Conflicting saved horse sidecars");
  const ecologyField = field(saved, "ecology");
  const rawEcology = ecologyField.present ? ecologyField.value : undefined;
  if (ecologyField.present && (!record(rawEcology) || rawEcology.version !== 1 ||
      Object.keys(rawEcology).some((key) => !["version", "ecology", "mobsByDimension"].includes(key)) ||
      !Object.hasOwn(rawEcology, "ecology") || !record(rawEcology.mobsByDimension)))
    throw new Error("Invalid saved ecology");
  const ecology = normalizeEcologySnapshot(rawEcology?.ecology, context);
  if (!ecology) throw new Error("Invalid saved ecology");

  const canonical = {}, copies = new Map();
  const accept = (raw, key) => {
    const snapshot = normalizeMobSnapshot(raw, context, key, { horses });
    if (!snapshot) throw new Error(`Invalid saved mobs in ${key}`);
    for (const mob of snapshot.entities) {
      const count = (copies.get(mob.id) ?? 0) + 1;
      copies.set(mob.id, count);
      if (count > HORSE_BASE_COPY_LIMIT) throw new Error("Too many saved mob compatibility copies");
    }
    if (canonical[key] && !sameSnapshot(canonical[key], snapshot))
      throw new Error(`Conflicting saved mob copies in ${key}`);
    canonical[key] ??= snapshot;
  };
  const acceptDimensions = (data) => {
    if (!record(data) || Object.keys(data).some((key) => !isDimension(key)))
      throw new Error("Invalid saved mob state dimension");
    for (const key of DIMENSIONS)
      if (Object.hasOwn(data, key)) accept(data[key], key);
  };
  for (const name of ["mobStates", "mobsByDimension"]) {
    const value = field(saved, name);
    if (value.present) acceptDimensions(value.value);
  }
  const active = field(saved, "mobs");
  if (active.present) accept(active.value, dimension);
  if (rawEcology) acceptDimensions(rawEcology.mobsByDimension);

  if (!horseMobLinksValid(horses, Object.values(canonical), { ecology }))
    throw new Error("Invalid saved horse/base/ecology identity links");
  const normalizedEcology = normalizeEcologyServicesSnapshot({
    version: 1, ecology, mobsByDimension: canonical,
  }, context, { horses });
  if (!normalizedEcology || (ecology.elders.length &&
      !ecologyCompletionLinksValid(ecology, exploration)))
    throw new Error("Invalid saved ecology/base/completion links");
  return {
    ...(canonical[dimension] ? { mobs: canonical[dimension] } : {}),
    mobStates: canonical,
    // Preserve this historical all-dimension spelling too. These are projections
    // of the SAME canonical set, never additional runtime records.
    mobsByDimension: canonical,
    ecology: normalizedEcology,
  };
}

/** Called only at a save/travel boundary, never to price per-frame movement. */
export function snapshotGameMobs(game) {
  const wildlife = game.wildlife;
  const dimension = wildlife?.dimension ?? game.world.dimension;
  const ecology = game.ecologyServices?.serialize();
  if (game.ecologyServices && !ecology)
    throw new Error("Cannot save invalid ecology/horse links");
  // Ecology keeps the inactive dimensions; its serialization already captures
  // this SAME Wildlife. Never ask a second base owner or prefer stale Game copies.
  const mobs = ecology?.mobsByDimension[dimension] ?? wildlife?.serialize?.();
  const states = ecology?.mobsByDimension ??
    { ...game.mobStates, ...(mobs ? { [dimension]: mobs } : {}) };
  return {
    ...(mobs ? { mobs } : {}),
    mobStates: states,
    mobsByDimension: states,
    ...(ecology ? { ecology: { ...ecology, mobsByDimension: states } } : {}),
  };
}
