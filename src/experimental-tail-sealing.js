import { geometryEpoch } from "./geometry-world.js";

export const EXPERIMENTAL_TAIL_VERTICES = 65532;
export const EXPERIMENTAL_FALLBACK_BYTES = 8 * 1024 * 1024;
const epochs = new WeakMap();
const ownership = new WeakMap();

const configuration = (r) => JSON.stringify([r.meshLimits, r.sectionMeshLimits, r.quality,
  Object.entries(r.materials).map(([key, m]) =>
    [key, m.id, m.version, m.side, m.transparent, m.forceSinglePass])]);
const center = (r) => `${Math.floor(r.camera.position.x / 16)},${Math.floor(r.camera.position.z / 16)}:${r.renderRadius}`;

/** Explicit test opt-in. Only an empty renderer over a fully resident, versioned
 * input set may start a cold epoch. Re-enabling a flag never rearms an epoch.
 */
export function beginExperimentalColdTailEpoch(renderer) {
  invalidateExperimentalColdTailEpoch(renderer);
  const world = renderer.world;
  if (renderer.meshLimits?.experimentalColdTailSealing !== true ||
      renderer.meshLimits.regionalPages !== true || renderer.waterFusionEnabled ||
      renderer.sectionWater || renderer.renderRadius > 4 || renderer.renderRadius < 1 ||
      (renderer.meshLimits.maxJobs ?? 1) !== 1 ||
      renderer.chunks.size || renderer.sectionRegions?.size || renderer.sectionJobs?.size ||
      renderer.sectionCompaction || !world.chunks.size || world.chunks.size > 169 ||
      experimentalTailOwners(renderer) ||
      !Number.isSafeInteger(world._nextDirtyTicket)) return false;
  const chunks = [...world.chunks].map(([key, chunk]) => ({
    key, chunk, incarnation: chunk.incarnation, revision: chunk.revision,
  }));
  if (chunks.some(({ incarnation, revision }) =>
    !Number.isSafeInteger(incarnation) || !Number.isSafeInteger(revision))) return false;
  // Settle normal world/packing initialization before capturing the epoch.
  // A zero-work slice cannot create a section job or acknowledge geometry.
  renderer.rebuildDirty(0);
  epochs.set(renderer, {
    active: true, world, epoch: geometryEpoch(world), generator: world.generator,
    dimension: world.dimension, ticket: world._nextDirtyTicket, chunks,
    configuration: configuration(renderer), center: center(renderer),
  });
  return true;
}

export function invalidateExperimentalColdTailEpoch(renderer) {
  const epoch = epochs.get(renderer);
  if (epoch) {
    epoch.active = false;
    // Do not retain an unloaded chunk/old world through a dead eligibility
    // token. Physical page leases have their own buffer-free numeric state.
    delete epoch.world;
    delete epoch.generator;
    epoch.chunks = [];
    epochs.delete(renderer);
  }
}

export function experimentalColdTailEpoch(renderer) {
  const epoch = epochs.get(renderer), world = renderer.world;
  if (!epoch?.active) return null;
  if (renderer.regionalMaterials) {
    const materials = Object.values(renderer.regionalMaterials).map((m) => `${m.id}:${m.version}`).join(",");
    epoch.regionalMaterials ??= materials;
    if (epoch.regionalMaterials !== materials) epoch.active = false;
  }
  if (!epoch.active || world !== epoch.world || geometryEpoch(world) !== epoch.epoch ||
      world.generator !== epoch.generator || world.dimension !== epoch.dimension ||
      world._nextDirtyTicket !== epoch.ticket || world.chunks.size !== epoch.chunks.length ||
      configuration(renderer) !== epoch.configuration || center(renderer) !== epoch.center ||
      renderer.waterFusionEnabled || renderer.sectionWater || renderer.sectionCompaction ||
      epoch.chunks.some(({ key, chunk, incarnation, revision }) =>
        world.chunks.get(key) !== chunk || chunk.incarnation !== incarnation || chunk.revision !== revision)) {
    invalidateExperimentalColdTailEpoch(renderer);
    return null;
  }
  return epoch;
}

/** A numeric lease count, not a buffer registry. Explicit physical retirement
 * releases it; GPU context disposal deliberately does not. This also covers
 * private copies and detached water-transaction retirement leases.
 */
export function retainExperimentalTailPage(renderer, geometry) {
  if (geometry.userData.releaseExperimentalTail) return;
  let owner = ownership.get(renderer);
  if (!owner) ownership.set(renderer, owner = { count: 0 });
  owner.count++;
  let live = true;
  geometry.userData.releaseExperimentalTail = () => {
    if (!live) return;
    live = false;
    owner.count--;
  };
}

export const experimentalTailOwners = (renderer) => ownership.get(renderer)?.count ?? 0;

export function experimentalTailHeadroom(renderer) {
  return epochs.get(renderer)?.active || experimentalTailOwners(renderer)
    ? EXPERIMENTAL_FALLBACK_BYTES : 0;
}

export function experimentalTailPlanCurrent(renderer, plan) {
  return !plan?.experimentalEpoch || experimentalColdTailEpoch(renderer) === plan.experimentalEpoch;
}
