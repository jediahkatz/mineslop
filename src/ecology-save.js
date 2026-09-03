import {
  ecologyCollider,
  ecologyMobLinksValid,
  normalizeEcologySnapshot,
} from "./expansion-ecology.js";
import { normalizeMobSnapshot, validMobPosition } from "./mob-save.js";
import { DIMENSIONS } from "./world-spec.js";

const record = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Cross-owner preflight; these are the existing v1 Wildlife projections, not
 * a second collection of corpses. Inactive dimensions retain every base pose.
 * Undefined is a legacy archive with no ecology. Explicit malformed data fails.
 */
export function normalizeEcologyServicesSnapshot(value, context) {
  try {
    if (value === undefined) value = {
      version: 1, ecology: normalizeEcologySnapshot(undefined, context), mobsByDimension: {},
    };
    if (!record(value) || value.version !== 1 ||
      Object.keys(value).some((key) => !["version", "ecology", "mobsByDimension"].includes(key)) ||
      !Object.hasOwn(value, "ecology") || value.ecology === undefined ||
      !record(value.mobsByDimension) ||
      Object.keys(value.mobsByDimension).some((key) => !DIMENSIONS.includes(key)))
      return null;
    const ecology = normalizeEcologySnapshot(value.ecology, context);
    if (!ecology) return null;
    const states = new Map(ecology.entries.map((entry) => [entry.id, entry]));
    const reserved = new Set([
      ...states.keys(), ...ecology.eggs.flatMap((egg) => [egg.id, egg.childId]),
    ]);
    const mobsByDimension = {};
    for (const dimension of DIMENSIONS) {
      if (!Object.hasOwn(value.mobsByDimension, dimension)) continue;
      const mobs = normalizeMobSnapshot(value.mobsByDimension[dimension], context, dimension);
      if (!mobs || mobs.killed.some((id) => reserved.has(id))) return null;
      for (const mob of mobs.entities) {
        const state = states.get(mob.id);
        // Egg/child identities cannot already belong to a legacy actor, even
        // in an inactive dimension. Deaths use Ecology's permanent tombstones,
        // never Wildlife's evicting killed-ID cache.
        if ((reserved.has(mob.id) && !state) ||
          (state && (!state.alive || state.kind !== mob.kind || state.dimension !== dimension ||
            !validMobPosition(mob.position, ecologyCollider(mob.kind, state), context, dimension))))
          return null;
      }
      mobsByDimension[dimension] = mobs;
    }
    // The live egg projection uses a World cell, not a fractional entity pose.
    // Domain-only authored fixtures can still exercise fractional beach points.
    if (ecology.eggs.some((egg) =>
      !Object.values(egg.position).every(Number.isSafeInteger))) return null;
    return ecologyMobLinksValid(ecology, Object.values(mobsByDimension))
      ? { version: 1, ecology, mobsByDimension } : null;
  } catch {
    return null;
  }
}

/** Exploration is normalized by its owner before this cross-check. A defeated
 * elder without the permanent completion is corrupt, not a repeatable reward.
 * Completions without a local resident are legitimate already-cleared sites.
 */
export function ecologyCompletionLinksValid(ecology, exploration) {
  if (!ecology || !Array.isArray(exploration?.encounters)) return false;
  const completed = new Set(exploration.encounters
    .filter((entry) => entry.completed === true).map((entry) => entry.marker.id));
  return ecology.elders.every((elder) =>
    completed.has(elder.id) === (elder.status === "defeated"));
}

/** The full canonical marker ID remains intact at the Exploration boundary.
 * Rich catalog markers carry extra layout fields which that ledger rejects.
 */
export function ecologyEncounterProjection(marker) {
  if (!marker || marker.type !== "encounter") return null;
  const { id, structureId, type, key, role, dimension, position } = marker;
  if (!position) return null;
  return Object.freeze({
    id, structureId, type, key, role, dimension,
    position: Object.freeze({ x: position.x, y: position.y, z: position.z }),
  });
}
