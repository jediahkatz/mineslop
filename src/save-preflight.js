import { normalizeOverflowSnapshot } from "./drop-overflow.js";
import { normalizeExperienceOrbSnapshot } from "./experience-orb-save.js";
import { normalizeExplorationServicesSnapshot } from "./exploration-host-state.js";
import { normalizeFuseSnapshot } from "./fuses.js";
import { normalizeBuildingServicesSnapshot } from "./game-building-services.js";
import { normalizeFluidServicesSnapshot } from "./game-fluid-state.js";
import { normalizeGameMobArchive } from "./game-mob-state.js";
import { normalizeProgressionArchive } from "./game-progression-state.js";
import { normalizeProjectileServicesSnapshot } from "./game-projectile-state.js";
import {
  normalizeVehicleServicesSnapshot,
  vehicleArchiveRiderValid,
} from "./game-vehicle-state.js";
import { Gameplay } from "./gameplay.js";
import { hasExpandedTerrain } from "./generator-version.js";
import { isLoosePosition } from "./loose-entity.js";
import { normalizePickupSnapshot } from "./pickups.js";
import { Settlement } from "./settlement.js";
import { GENERATOR_VERSION } from "./terrain.js";
import { normalizeWorldSave } from "./world-edits.js";
import {
  createWorldContext,
  isDimension,
  isEditablePosition,
  isWorldPose,
} from "./world-spec.js";

const labels = Object.freeze({
  gameplay: "inventory",
  settlement: "container or crop data",
  overflow: "loose-item archive",
  fuses: "explosives",
  pickups: "item pickups",
  experienceOrbs: "experience orbs",
});

const loadDetached = (Type) => (data, context) => {
  const component = new Type({ context });
  try {
    return component.load(data, { context }) ? component.serialize() : null;
  } finally {
    component.dispose?.();
  }
};
const defaults = Object.freeze({
  gameplay: loadDetached(Gameplay),
  settlement: loadDetached(Settlement),
  overflow: (data, context) => normalizeOverflowSnapshot(data, { context }),
  fuses: normalizeFuseSnapshot,
  pickups: normalizePickupSnapshot,
  experienceOrbs: normalizeExperienceOrbSnapshot,
});
const positions = Object.freeze({
  settlement: { fields: ["chests", "furnaces", "crops"], cells: true },
  fuses: { fields: ["entries"], cells: true },
  overflow: { fields: ["entries"], cells: false },
  pickups: { fields: ["items"], cells: false },
  experienceOrbs: { fields: ["orbs"], cells: false },
});

function validatePositions(name, data, context) {
  const descriptor = positions[name];
  if (!descriptor) return;
  for (const field of descriptor.fields) {
    // Structural validation and migration belong to the component normalizer.
    if (!Array.isArray(data?.[field])) continue;
    for (const entry of data[field]) {
      if (
        !entry ||
        !isDimension(entry.dimension) ||
        !(descriptor.cells
          ? isEditablePosition(
              entry.x,
              entry.y,
              entry.z,
              context.generatorVersion,
              entry.dimension
            )
          : isLoosePosition(entry, context))
      )
        throw new Error(`Invalid saved ${labels[name]} coordinates`);
    }
  }
}

/**
 * Detached, validated snapshots for the components this preflight owns. Every
 * coordinate-bearing component receives the same all-dimension context, never
 * the active dimension's build bounds. No scenes, terrain or live owners exist.
 *
 * A staged activator may supply pure normalizers[name](data, context) while
 * component owners extend their loaders. Return a canonical snapshot or null.
 * Legacy loaders remain authoritative and fail closed when they cannot yet
 * represent an expanded record; this function does not silently strip it.
 */
export function normalizeWorldComponents(saved, { normalizers = {} } = {}) {
  if (saved === null || saved === undefined) return null;
  if (typeof saved !== "object" || Array.isArray(saved))
    throw new Error("Invalid saved world components");
  // These data-only sidecars must reject accessors before generic cloning can
  // invoke or erase them. Clone the other archive fields to derive world bounds.
  const descriptors = Object.getOwnPropertyDescriptors(saved);
  delete descriptors.exploration;
  delete descriptors.playerProjectiles;
  delete descriptors.progression;
  delete descriptors.boats;
  delete descriptors.fishing;
  delete descriptors.horses;
  delete descriptors.ecology;
  delete descriptors.mobs;
  delete descriptors.mobStates;
  delete descriptors.mobsByDimension;
  const input = structuredClone(Object.defineProperties({}, descriptors));
  const world =
    input.world === undefined ? undefined : normalizeWorldSave(input.world);
  const context = createWorldContext(
    world ?? { seed: "", generatorVersion: GENERATOR_VERSION }
  );
  const normalized = { context, ...(world === undefined ? {} : { world }) };
  if (hasExpandedTerrain(context.generatorVersion) || Object.hasOwn(saved, "exploration")) {
    const exploration = normalizeExplorationServicesSnapshot(saved, context);
    if (!exploration) throw new Error("Invalid saved exploration claims");
    Object.assign(normalized, exploration);
  }
  const building = normalizeBuildingServicesSnapshot(input, context);
  if (!building) throw new Error("Invalid saved bed or calendar data");
  Object.assign(normalized, building, { time: building.worldClock.time });
  const fluids = normalizeFluidServicesSnapshot(input, context);
  if (!fluids) throw new Error("Invalid saved fluid simulation data");
  Object.assign(normalized, fluids);
  const projectiles = normalizeProjectileServicesSnapshot(saved, context);
  if (!projectiles) throw new Error("Invalid saved player projectiles");
  Object.assign(normalized, projectiles);
  const progression = normalizeProgressionArchive(saved, context);
  if (!progression) throw new Error("Invalid saved progression data");
  Object.assign(normalized, progression);
  const vehicles = normalizeVehicleServicesSnapshot(saved, context);
  if (!vehicles) throw new Error("Invalid saved boats or fishing or horses");
  Object.assign(normalized, vehicles);
  if (input.player !== undefined) {
    if (
      !isWorldPose(input.player, context, world?.dimension ?? "overworld") ||
      ![input.player.yaw, input.player.pitch].every(Number.isFinite)
    )
      throw new Error("Invalid saved player position");
    normalized.player = input.player;
  }
  Object.assign(
    normalized,
    normalizeGameMobArchive(saved, context, world?.dimension ?? "overworld", {
      horses: vehicles.horses, exploration: normalized.exploration,
    })
  );
  for (const [name, fallback] of Object.entries(defaults)) {
    const data = input[name];
    if (data === undefined) continue;
    validatePositions(name, data, context);
    const normalize = normalizers[name] ?? fallback;
    if (
      typeof normalize !== "function" ||
      Object.prototype.toString.call(normalize) !== "[object Function]"
    )
      throw new Error(`Invalid ${name} component normalizer`);
    const component = normalize(data, context);
    if (
      !component ||
      typeof component !== "object" ||
      Array.isArray(component) ||
      typeof component.then === "function"
    )
      throw new Error(
        `Invalid saved ${labels[name]}${
          hasExpandedTerrain(context.generatorVersion)
            ? "; expanded records require a context-aware component normalizer"
            : ""
        }`
      );
    normalized[name] = structuredClone(component);
  }
  if (!vehicleArchiveRiderValid(
    vehicles, normalized, normalized.player, world?.dimension ?? "overworld",
    normalized.gameplay?.dead === true
  ))
    throw new Error("Invalid saved vehicle rider position or dimension");
  return normalized;
}

/** Compatibility wrapper; staged activation should retain the normalized result. */
export function preflightWorldComponents(saved, options) {
  normalizeWorldComponents(saved, options);
  return true;
}
