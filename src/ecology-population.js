import { ecologyDistance, synchronousEcologyHook } from "./aquatic-ai.js";
import { ECOLOGY_SPECIES } from "./expansion-ecology.js";
import { finitePosition } from "./mob-navigation.js";
import { TransactionInvariantError } from "./transactions.js";

export const ECOLOGY_HOST_LIMITS = Object.freeze({
  naturalAttempts: 6, verticalProbes: 12, markerCandidates: 12,
  structureCandidates: 4, regionCandidates: 8, admissions: 3,
  eggsPerStep: 8, lifecyclePerStep: 4, dormantPerFrame: 8,
});
const center = (at) => ({ x: at.x + 0.5, y: at.y, z: at.z + 0.5 });

function read(index, method, ...args) {
  if (!synchronousEcologyHook(index?.[method])) return [];
  try {
    const values = index[method](...args);
    return Array.isArray(values) ? values : [];
  } catch (error) {
    if (error instanceof TransactionInvariantError) throw error;
    return [];
  }
}

/** Fixed candidates around an admitted anchor. Actual colliders, fluids and
 * region bounds still admit each point; an occupied spawner is never a body.
 */
function regionPoint(anchor, index, round) {
  const angle = (index + round) * 2.399963229728653;
  const radius = 1.6 + Math.floor(index / 4);
  return {
    x: anchor.x + Math.sin(angle) * radius,
    y: anchor.y + (index % 3) * 0.6,
    z: anchor.z + Math.cos(angle) * radius,
  };
}

/** Reads ONLY the parent's bounded, current canonical index and loaded cells.
 * No descriptor discovery, generator calls, height-column scans or random draws.
 * Returning counts is also useful for the parent's per-frame work diagnostics.
 */
export function populateEcology(host) {
  const work = { attempts: 0, admitted: 0, markers: 0, structures: 0 };
  if (!host.active) return work;
  const { world, wildlife, markers: index } = host;
  const ctx = wildlife.context, dimension = world.dimension;
  const round = host._populationRound++;
  const admit = (kind, position, options) => {
    if (work.admitted >= ECOLOGY_HOST_LIMITS.admissions) return false;
    work.attempts++;
    const plan = host.prepareAdmission(kind, position, options);
    if (!plan || !host.commit(plan).ok) return false;
    work.admitted++;
    return true;
  };
  const markers = read(index, "nearbyMarkers", ctx.player, {
    dimension, entities: ["villager", "elder_guardian", "blaze"],
    radius: 48, limit: ECOLOGY_HOST_LIMITS.markerCandidates,
  }).slice(0, ECOLOGY_HOST_LIMITS.markerCandidates);
  for (const marker of markers) {
    if (work.admitted >= ECOLOGY_HOST_LIMITS.admissions) break;
    work.markers++;
    if (!marker || !Object.hasOwn(ECOLOGY_SPECIES, marker.entity) ||
      !finitePosition(marker.position) || marker.dimension !== dimension ||
      index.getMarker(marker.id) !== marker || host.ecology.entityIdForMarker(marker.id)) continue;
    const structure = index.getStructure(marker.structureId);
    const anchor = center(marker.position);
    if (ecologyDistance(anchor, ctx.player) > 48) continue;
    if (marker.entity !== "blaze") admit(marker.entity, anchor, { structure, marker });
    else {
      if (ecologyDistance(anchor, ctx.player) > 16) continue;
      for (let i = 0; i < ECOLOGY_HOST_LIMITS.regionCandidates; i++)
        if (admit("blaze", regionPoint(anchor, i, round), { structure, marker })) break;
    }
  }
  // Monument catalogs declare THREE unique elders, not ordinary guardian
  // markers. Guardians use the same admitted monument's bounded water region.
  if (dimension !== "overworld") return work;
  const structures = read(index, "nearbyStructures", ctx.player, {
    dimension, kinds: ["ocean_monument"], radius: 48,
    limit: ECOLOGY_HOST_LIMITS.structureCandidates,
  }).slice(0, ECOLOGY_HOST_LIMITS.structureCandidates);
  for (const structure of structures) {
    if (work.admitted >= ECOLOGY_HOST_LIMITS.admissions) break;
    work.structures++;
    if (structure?.kind !== "ocean_monument" || structure.dimension !== dimension ||
      !finitePosition(structure.origin) || index.getStructure(structure.id) !== structure) continue;
    const anchor = center(structure.origin);
    anchor.y++;
    for (let i = 0; i < ECOLOGY_HOST_LIMITS.regionCandidates; i++) {
      const point = regionPoint(anchor, i, round);
      if (ecologyDistance(point, ctx.player) <= 48 && admit("guardian", point, { structure })) break;
    }
  }
  const sea = host.context.specForDimension("overworld").seaLevel;
  for (let attempt = 0; attempt < ECOLOGY_HOST_LIMITS.naturalAttempts &&
    work.admitted < ECOLOGY_HOST_LIMITS.admissions; attempt++) {
    const serial = host._spawnCursor++;
    const kind = ["dolphin", "turtle", "drowned"][serial % 3];
    const angle = serial * 2.399963229728653, radius = 26 + (serial % 3) * 7;
    const x = Math.floor(ctx.player.x + Math.sin(angle) * radius) + 0.5;
    const z = Math.floor(ctx.player.z + Math.cos(angle) * radius) + 0.5;
    if (!world.isLoaded(Math.floor(x), Math.floor(z))) continue;
    const top = kind === "turtle" ? sea + 6 :
      Math.min(sea - 2, Math.max(world.spec.minY + 2, Math.floor(ctx.player.y)));
    for (let i = 0; i < ECOLOGY_HOST_LIMITS.verticalProbes; i++)
      if (admit(kind, { x, y: top - i, z })) break;
  }
  return work;
}
