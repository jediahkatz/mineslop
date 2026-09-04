import { subtractRectangles } from "./aabb.js";
import { BLOCK } from "./blocks.js";
import { FLUID } from "./block-state.js";
import {
  bodyBox,
  boxCollides,
  moveBody,
  supportContacts,
} from "./collision.js";
import {
  sampleFluid as sharedSampleFluid,
  sampleFluidAtPoint as sharedSampleFluidAtPoint,
} from "./fluid-sampling.js";
import { createFluidQueryView } from "./fluid-query-view.js";
import {
  geometryWorldSpec,
  validBodyPosition,
} from "./geometry-world.js";
import {
  exposedToSun,
  finitePosition,
  footprintLoaded,
  hasLineOfSight,
} from "./mob-navigation.js";

// Keep the ecology domain independent of the species registry which imports
// its definitions. This has the same daylight interval as legacy mob AI.
export function ecologyIsDaylight(timeOfDay) {
  const time = ((timeOfDay % 1) + 1) % 1;
  return time > 0.27 && time < 0.73;
}

export const AQUATIC_AI_LIMITS = Object.freeze({
  step: 0.1,
  movement: 3.2,
  los: 24,
  leash: 32,
  guideDistance: 96,
  descriptors: 8,
  structureIdentity: 1024,
  surfaceProbes: 32,
  waterCandidates: 12,
  neighbors: 8,
});
export const ELDER_MARKER_KEYS = Object.freeze([
  "elder_west",
  "elder_east",
  "elder_crown",
]);
export const ecologyPoint = ({ x, y, z }) => ({ x, y, z });
export const ecologyDistance = (a, b) =>
  finitePosition(a) && finitePosition(b)
    ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
    : Infinity;
export const synchronousEcologyHook = (hook) =>
  typeof hook === "function" &&
  Object.prototype.toString.call(hook) === "[object Function]";
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
const wrap = (n) => Math.atan2(Math.sin(n), Math.cos(n));
const brains = new WeakMap();
const fluidViews = new WeakMap();

function fluidView(world) {
  let view = fluidViews.get(world);
  if (!view) {
    view = createFluidQueryView(world);
    fluidViews.set(world, view);
  }
  return view;
}

function brainFor(mob) {
  let brain = brains.get(mob);
  if (!brain) {
    let seed = 2166136261;
    for (const char of String(mob.id))
      seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
    brain = {
      phase: ((seed >>> 0) / 0x100000000) * Math.PI * 2,
      clock: 0,
      cooldown: 0.5,
      charge: 0,
      target: null,
      surface: false,
      waterGoal: null,
      seekIn: 0,
      hurtIn: 0,
      effectIn: 0,
      auraIn: 0,
      spikeIn: 0,
      lastHit: null,
    };
    brains.set(mob, brain);
  }
  return brain;
}

function knownWorld(world) {
  return !!world &&
    (typeof world.isLoaded === "function" || world.chunks instanceof Map);
}

function validCollider(collider) {
  return Number.isFinite(collider?.radius) && collider.radius > 0 && collider.radius <= 2 &&
    Number.isFinite(collider?.height) && collider.height > 0 && collider.height <= 4;
}

/** Rich sampler contract is fluid-sampling.sampleFluid, including unitless
 * current. No water IDs, guessed surface levels, or second fluid simulation.
 */
export function ecologyBodySample(world, position, collider, provider = sharedSampleFluid) {
  if (
    !knownWorld(world) ||
    !finitePosition(position) ||
    !validCollider(collider) ||
    !synchronousEcologyHook(provider) ||
    !footprintLoaded(world, position.x, position.z, collider.radius)
  ) return null;
  const sample = provider(fluidView(world), position, collider);
  if (
    !sample || sample.valid === false || sample.loaded === false || sample.eyeLoaded === false ||
    ![sample.waterImmersion, sample.lavaImmersion].every(
      (n) => Number.isFinite(n) && n >= 0 && n <= 1
    ) ||
    !Object.values(FLUID).includes(sample.eyeFluid) ||
    typeof sample.canBreathe !== "boolean" ||
    (sample.current && !finitePosition(sample.current))
  ) return null;
  return sample;
}

export function ecologyCanOccupy(world, position, collider) {
  return (
    knownWorld(world) &&
    validCollider(collider) &&
    validBodyPosition(position, world, collider) &&
    position.y + collider.height <= geometryWorldSpec(world).maxY &&
    footprintLoaded(world, position.x, position.z, collider.radius) &&
    !boxCollides(world, bodyBox(position, collider.radius, collider.height))
  );
}

/** A shallow wet foot is not an ocean habitat. Try three bounded vertical
 * alignments containing the body, allowing only the small exposed source
 * surface cap. Slab-clipped water still cannot replace a deep water column.
 */
export function ecologyWaterColumn(world, position, collider, depth, sampleFluid) {
  if (!validCollider(collider) || !Number.isFinite(depth) ||
    depth < collider.height || depth > 4) return false;
  for (const fraction of [0, 0.5, 1]) {
    const at = { ...position, y: position.y - (depth - collider.height) * fraction };
    const sample = ecologyBodySample(world, at, {
      ...collider, height: depth, eyeHeight: Math.min(depth, collider.eyeHeight ?? collider.height),
    }, sampleFluid);
    if (sample?.waterImmersion >= 1 - 0.125 / depth && sample.lavaImmersion === 0)
      return true;
  }
  return false;
}

/** Loaded exact support boxes, including slabs/stairs; never heightAt/surfaceYAt.
 * Every part of the footprint needs support within one safe step, not a single
 * center voxel. Water may occupy the same supported space.
 */
export function ecologySupportAt(world, position, collider, {
  maxRise = 0.6, maxDrop = 0.7, sandOnly = false,
} = {}) {
  if (
    !knownWorld(world) ||
    !finitePosition(position) ||
    !validCollider(collider) ||
    !footprintLoaded(world, position.x, position.z, collider.radius) ||
    ![maxRise, maxDrop].every((n) => Number.isFinite(n) && n >= 0 && n <= 1)
  ) return null;
  const filter = ({ cell }) =>
    cell?.id !== BLOCK.CACTUS && (!sandOnly || cell?.id === BLOCK.SAND);
  const contacts = supportContacts(world, position, {
    radius: collider.radius, maxRise, maxDrop, filter,
  });
  const heights = [...new Set(contacts.map((contact) => contact.height))]
    .sort((a, b) => b - a);
  const footprint = [
    position.x - collider.radius, position.z - collider.radius,
    position.x + collider.radius, position.z + collider.radius,
  ];
  for (const y of heights) {
    if (!ecologyCanOccupy(world, { ...position, y }, collider)) continue;
    const support = contacts
      .filter((contact) => contact.height <= y && contact.height >= y - 0.6)
      .map(({ box }) => [box[0], box[2], box[3], box[5]]);
    if (subtractRectangles([footprint], support).length === 0) return y;
  }
  return null;
}

export function isTurtleBeach(world, position, collider, sampleFluid) {
  const sample = ecologyBodySample(world, position, collider, sampleFluid);
  return (
    sample !== null && sample.waterImmersion === 0 && sample.lavaImmersion === 0 &&
    ecologySupportAt(world, position, collider, {
      maxRise: 0, maxDrop: 0.05, sandOnly: true,
    }) !== null
  );
}

/** Swimming has no grounded step. Land only on a real nearby support top,
 * sweeping upward, across and down with the ordinary collision solver.
 * Partial immersion includes the last wet fraction before reaching a bank.
 */
function shoreLanding(world, from, delta, collider, normal) {
  const projected = { x: from.x + delta.x, y: from.y, z: from.z + delta.z };
  const heights = [...new Set(supportContacts(world, projected, {
    radius: collider.radius, maxRise: 0.6, maxDrop: 0,
    filter: ({ cell }) => cell?.id !== BLOCK.CACTUS,
  }).map(({ height }) => height))].sort((a, b) => a - b);
  const travel = (at) => (at.x - from.x) ** 2 + (at.z - from.z) ** 2;
  const options = { ...collider, stepHeight: 0 };
  for (const y of heights) {
    const rise = y - from.y;
    if (rise <= 0 || rise > 0.6) continue;
    const lifted = moveBody(world, from, { x: 0, y: rise, z: 0 }, options);
    if (lifted.blocked.y) continue;
    const across = moveBody(world, lifted.position, { x: delta.x, y: 0, z: delta.z }, options);
    if (travel(across.position) <= travel(normal.position) + 1e-8) continue;
    const landed = moveBody(world, across.position, { x: 0, y: -0.05, z: 0 }, options);
    if (landed.grounded && ecologyCanOccupy(world, landed.position, collider))
      return { ...landed, stepped: landed.position.y - from.y };
  }
  return normal;
}

/** Bounded physical movement, independent of neutral visual/picking bounds.
 * amphibious permits supported dry steps, swimming and shore transitions.
 * swimmer permits partial immersion (a dolphin's blowhole can reach air).
 * flight is for the NPC adapter; all three stop at unloaded column walls.
 */
export function moveEcologyMob(world, mob, displacement, {
  collider = mob.spec,
  locomotion = "amphibious",
  sampleFluid = sharedSampleFluid,
} = {}) {
  const from = mob.position;
  if (
    !finitePosition(displacement) ||
    Math.hypot(displacement.x, displacement.y, displacement.z) > AQUATIC_AI_LIMITS.movement ||
    !ecologyCanOccupy(world, from, collider)
  ) return false;
  const steps = Math.max(1, Math.ceil(Math.hypot(
    displacement.x, displacement.y, displacement.z
  ) / 0.2));
  let moved = false;
  for (let i = 0; i < steps; i++) {
    const current = ecologyBodySample(world, from, collider, sampleFluid);
    if (!current) break;
    const delta = {
      x: displacement.x / steps,
      y: displacement.y / steps,
      z: displacement.z / steps,
    };
    const projected = { x: from.x + delta.x, y: from.y + delta.y, z: from.z + delta.z };
    if (!footprintLoaded(world, projected.x, projected.z, collider.radius)) break;
    if (locomotion === "amphibious" && current.waterImmersion < 0.2) {
      const destination = ecologyBodySample(world, projected, collider, sampleFluid);
      if (!destination) break;
      const support = ecologySupportAt(world, projected, collider);
      if (destination.waterImmersion < 0.2 && support === null) {
        // Falling after support is mined away remains possible; do not walk
        // over a cliff while the current footprint still has support.
        if (ecologySupportAt(world, from, collider, { maxRise: 0, maxDrop: 0.1 }) !== null)
          break;
        // A swimmer can finish climbing a bank while its footprint still
        // straddles water. Partial REAL support is enough during that landing;
        // it is not enough to initiate walking off fully supported dry ground.
        const landing = supportContacts(world, projected, {
          radius: collider.radius, maxRise: 0.6, maxDrop: 0.6,
        });
        if (!landing.length) delta.x = delta.z = 0;
      }
    }
    let result = moveBody(world, from, delta, {
      ...collider,
      stepHeight: locomotion === "amphibious" ? 0.6 : 0,
    });
    if (locomotion === "amphibious" && current.waterImmersion > 0 &&
      (result.blocked.x || result.blocked.z))
      result = shoreLanding(world, from, delta, collider, result);
    if (!ecologyCanOccupy(world, result.position, collider)) break;
    const next = ecologyBodySample(world, result.position, collider, sampleFluid);
    if (
      !next || (next.lavaImmersion > 0 && !mob.spec.fireImmune) ||
      (locomotion === "swimmer" && next.waterImmersion < 0.08)
    ) break;
    const distance = ecologyDistance(from, result.position);
    if (distance < 1e-8) break;
    const horizontal = Math.hypot(result.position.x - from.x, result.position.z - from.z);
    const pitch = -Math.atan2(result.position.y - from.y, horizontal);
    Object.assign(from, result.position);
    mob.moving = true;
    mob.swimming = next.waterImmersion >= 0.2;
    mob.swimPitch = mob.swimming ? clamp(pitch, -0.75, 0.75) : 0;
    mob.groundY = result.grounded ? from.y : (mob.groundY ?? from.y);
    moved = true;
  }
  return moved;
}

export function ecologyLineOfSight(world, from, to) {
  return ecologyDistance(from, to) <= AQUATIC_AI_LIMITS.los &&
    hasLineOfSight(world, from, to);
}

export function ecologyEye(mob, collider = mob.spec) {
  return {
    x: mob.position.x,
    y: mob.position.y + (collider.eyeHeight ?? collider.height * 0.8),
    z: mob.position.z,
  };
}

export function ecologyCanTarget(mob, ctx) {
  return !mob.dead && !mob.dormant && mob.health > 0 &&
    ctx.mode !== "creative" && ctx.health > 0 && !ctx.spawnProtected &&
    !ctx.playerInvulnerable &&
    (ctx.playerDimension ?? ctx.dimension) === ctx.world.dimension &&
    finitePosition(ctx.player) && finitePosition(ctx.playerEye) &&
    footprintLoaded(ctx.world, ctx.player.x, ctx.player.z, 0.3);
}

export function pointInEcologyRegion(position, bounds) {
  return !!bounds && finitePosition(position) &&
    ["minX", "minY", "minZ", "maxX", "maxY", "maxZ"].every((key) => Number.isFinite(bounds[key])) &&
    position.x >= bounds.minX && position.x < bounds.maxX &&
    position.y >= bounds.minY && position.y < bounds.maxY &&
    position.z >= bounds.minZ && position.z < bounds.maxZ;
}

/** Exact authored encounter identities, not "three elders per visit". */
export function isElderMarker(structure, marker) {
  return structure?.kind === "ocean_monument" &&
    structure.dimension === "overworld" &&
    marker?.type === "encounter" && marker.entity === "elder_guardian" &&
    marker.unique === true && ELDER_MARKER_KEYS.includes(marker.key) &&
    marker.structureId === structure.id && marker.dimension === structure.dimension &&
    marker.id === `${structure.id}/encounter/${marker.key}` &&
    finitePosition(marker.position) && pointInEcologyRegion(marker.position, marker.bounds);
}

function guideFromDescriptor(descriptor, dimension) {
  if (
    !descriptor || !["shipwreck", "ocean_ruin"].includes(descriptor.kind) ||
    descriptor.dimension !== dimension ||
    typeof descriptor.id !== "string" || descriptor.id.length === 0 ||
    descriptor.id.length > AQUATIC_AI_LIMITS.structureIdentity ||
    !finitePosition(descriptor.origin)
  ) return null;
  return {
    id: descriptor.id, kind: descriptor.kind,
    position: {
      x: descriptor.origin.x + 0.5,
      y: descriptor.origin.y + 1,
      z: descriptor.origin.z + 0.5,
    },
  };
}

/** Provider enumerates CACHED descriptors only (<=8); AI never describes or
 * generates terrain. Deterministic tie-breaking makes prepared feeds repeatable.
 */
export function findDolphinGuide(position, dimension, descriptors) {
  if (!Array.isArray(descriptors)) return null;
  let best = null, distance = AQUATIC_AI_LIMITS.guideDistance;
  for (const descriptor of descriptors.slice(0, AQUATIC_AI_LIMITS.descriptors)) {
    const candidate = guideFromDescriptor(descriptor, dimension);
    if (!candidate) continue;
    const next = ecologyDistance(position, candidate.position);
    if (next > 4 && (next < distance || (next === distance && candidate.id < best?.id))) {
      best = candidate;
      distance = next;
    }
  }
  return best;
}

/** Habitat is supplied from the already-admitted terrain/structure metadata.
 * Unlike the old !water hostile branch, aquatic hostiles are explicitly admitted.
 * Light is the local 0..15 block/sky reading; absence fails closed for drowned.
 */
export function admitEcologySpawn(kind, position, collider, ctx) {
  if (!ecologyCanOccupy(ctx.world, position, collider)) return false;
  const sample = ecologyBodySample(ctx.world, position, collider, ctx.sampleFluid);
  if (!sample || sample.lavaImmersion > 0) return false;
  const dimension = ctx.world.dimension;
  const biome = ctx.biomeId ?? "";
  const ocean = /(^|_)ocean$/.test(biome);
  if (kind === "elder_guardian") {
    // A unique encounter needs its entire REAL body underwater and three
    // blocks of habitat depth in its marker column. Inflating the body to
    // that depth also widens the overhead query into neighboring decoration
    // (the native crown lantern), even though the elder never occupies it.
    // Keep the depth/source-cap requirement; do not treat clipped host water
    // or a merely wet foot as a flooded chamber.
    return dimension === "overworld" && isElderMarker(ctx.structure, ctx.marker) &&
      pointInEcologyRegion(position, ctx.marker.bounds) &&
      ecologyDistance(position, {
        x: ctx.marker.position.x + 0.5, y: ctx.marker.position.y, z: ctx.marker.position.z + 0.5,
      }) < 0.01 &&
      sample.waterImmersion >= 1 - 1e-8 &&
      ecologyWaterColumn(ctx.world, position, {
        ...collider, radius: Math.min(collider.radius, 0.5),
      }, 3, ctx.sampleFluid);
  }
  const water = sample.waterImmersion >= 0.8 && (kind === "turtle" ||
    ecologyWaterColumn(ctx.world, position, collider, 2, ctx.sampleFluid));
  if (kind === "dolphin")
    return dimension === "overworld" && ocean && !/frozen/.test(biome) && water;
  if (kind === "turtle")
    return dimension === "overworld" && (
      (biome === "beach" && isTurtleBeach(ctx.world, position, collider, ctx.sampleFluid)) ||
      (water && finitePosition(ctx.homeBeach) &&
        ecologyDistance(position, ctx.homeBeach) <= 32 &&
        isTurtleBeach(ctx.world, ctx.homeBeach, collider, ctx.sampleFluid))
    );
  if (kind === "drowned")
    return dimension === "overworld" && (ocean || /river$/.test(biome)) && water &&
      ctx.blockLight === 0 && Number.isInteger(ctx.skyLight) && ctx.skyLight >= 0 &&
      ctx.skyLight <= 15 && (ctx.skyLight <= 7 || !ecologyIsDaylight(ctx.timeOfDay ?? 0.5));
  if (kind === "guardian")
    return dimension === "overworld" && water &&
      ctx.structure?.kind === "ocean_monument" &&
      ctx.structure.dimension === dimension &&
      pointInEcologyRegion(position, ctx.structure.bounds);
  return false;
}

function steer(mob, target, speed, dt, ctx, collider, locomotion) {
  if (!finitePosition(target)) return false;
  const dx = target.x - mob.position.x, dz = target.z - mob.position.z;
  const distance = Math.hypot(dx, dz);
  const yaw = distance > 1e-6 ? Math.atan2(dx, dz) : (mob.root?.rotation.y ?? 0);
  const wet = ecologyBodySample(ctx.world, mob.position, collider, ctx.sampleFluid);
  if (!wet) return false;
  const dy = wet.waterImmersion >= 0.2 || locomotion === "flight"
    ? clamp(target.y - mob.position.y, -speed, speed) * dt
    : -Math.min(0.2, dt * 3);
  for (const offset of [0, 0.7, -0.7]) {
    const step = Math.min(distance, speed * dt);
    if (moveEcologyMob(ctx.world, mob, {
      x: Math.sin(yaw + offset) * step, z: Math.cos(yaw + offset) * step, y: dy,
    }, { collider, locomotion, sampleFluid: ctx.sampleFluid })) {
      if (mob.root?.rotation && distance > 1e-6)
        mob.root.rotation.y = wrap((Number.isFinite(mob.root.rotation.y) ? mob.root.rotation.y : 0) +
          wrap(yaw + offset - (mob.root.rotation.y || 0)) * Math.min(1, dt * 8));
      return true;
    }
  }
  return false;
}

function waterGoal(mob, brain, ctx, collider) {
  if (brain.seekIn > 0) return brain.waterGoal;
  brain.seekIn = 1;
  brain.waterGoal = null;
  for (let i = 0; i < AQUATIC_AI_LIMITS.waterCandidates; i++) {
    const angle = brain.phase + (i % 4) * Math.PI / 2;
    const radius = 2 + Math.floor(i / 4) * 2;
    const goal = {
      x: mob.position.x + Math.sin(angle) * radius,
      y: mob.position.y - Math.floor(i / 8) * 0.5,
      z: mob.position.z + Math.cos(angle) * radius,
    };
    if (!ecologyCanOccupy(ctx.world, goal, collider)) continue;
    const sample = ecologyBodySample(ctx.world, goal, collider, ctx.sampleFluid);
    if (sample?.waterImmersion >= 0.5 && sample.lavaImmersion === 0) {
      brain.waterGoal = goal;
      break;
    }
  }
  return brain.waterGoal;
}

function surfaceGoal(mob, ctx, collider) {
  const eye = ecologyEye(mob, collider);
  const sampler = ctx.sampleFluidAtPoint ?? sharedSampleFluidAtPoint;
  if (!synchronousEcologyHook(sampler)) return null;
  for (let i = 1; i <= AQUATIC_AI_LIMITS.surfaceProbes; i++) {
    const point = { ...eye, y: eye.y + i * 0.5 };
    if (point.y >= geometryWorldSpec(ctx.world).maxY) break;
    const sample = sampler(fluidView(ctx.world), point);
    if (!sample || sample.valid === false || sample.loaded === false || sample.eyeLoaded === false) break;
    if (sample.fluid !== FLUID.NONE) continue;
    const goal = { ...mob.position, y: point.y - collider.eyeHeight + 0.02 };
    if (ecologyCanOccupy(ctx.world, goal, collider)) return goal;
    break; // A roof is not a navigable air pocket.
  }
  return { ...mob.position, y: mob.position.y + 1 };
}

function wander(mob, brain, state, dt, ctx, collider, locomotion) {
  const heading = brain.phase + Math.floor(brain.clock / 3) * 1.37;
  const home = state.home;
  const target = ecologyDistance(mob.position, home) > 10
    ? home
    : {
      x: mob.position.x + Math.sin(heading) * 2,
      y: mob.position.y + Math.sin(brain.clock * 0.6 + brain.phase) * 0.4,
      z: mob.position.z + Math.cos(heading) * 2,
    };
  return steer(mob, target, mob.spec.speed * 0.45, dt, ctx, collider, locomotion);
}

function dolphin(mob, brain, state, sample, dt, ctx, collider) {
  if (sample.waterImmersion < 0.08) {
    const goal = waterGoal(mob, brain, ctx, collider);
    if (goal) steer(mob, goal, mob.spec.speed * 0.25, dt, ctx, collider, "amphibious");
    if (state.dryTime >= 20 && brain.hurtIn <= 0) {
      brain.hurtIn = 1;
      ctx.hurt?.(mob, 1, null, false);
    }
    return;
  }
  if (state.air < 60) brain.surface = true;
  if (brain.surface && sample.canBreathe) brain.surface = false;
  if (state.air <= 0 && brain.hurtIn <= 0) {
    brain.hurtIn = 1;
    ctx.hurt?.(mob, 2, null, false);
  }
  if (brain.surface) {
    steer(mob, surfaceGoal(mob, ctx, collider), mob.spec.speed, dt, ctx, collider, "swimmer");
    return;
  }
  const distance = ecologyDistance(mob.position, ctx.player);
  if (state.assistTime > 0 && ctx.health > 0 && distance <= 8 &&
    ctx.playerSwimming === true &&
    ecologyLineOfSight(ctx.world, ecologyEye(mob, collider), ctx.playerEye)) {
    if (brain.effectIn <= 0 && synchronousEcologyHook(ctx.applyEffect)) {
      brain.effectIn = 0.5;
      ctx.applyEffect({
        id: "dolphins_grace", source: mob.id, duration: 1.5, swimSpeedMultiplier: 1.6,
      });
    }
  }
  if (state.guide && synchronousEcologyHook(ctx.getStructure)) {
    const current = guideFromDescriptor(ctx.getStructure(state.guide.id), state.dimension);
    if (current && current.id === state.guide.id && current.kind === state.guide.kind &&
      ecologyDistance(current.position, state.guide.position) < 0.01) {
      mob.lookTarget = ecologyPoint(current.position);
      if (distance <= 12 && ecologyDistance(mob.position, current.position) > 4)
        steer(mob, current.position, mob.spec.speed * 0.7, dt, ctx, collider, "swimmer");
      return; // Wait for the fed player instead of abandoning them.
    }
  }
  if (state.assistTime > 0 && distance > 3 && distance <= 12)
    steer(mob, ctx.player, mob.spec.speed * 0.7, dt, ctx, collider, "swimmer");
  else wander(mob, brain, state, dt, ctx, collider, "swimmer");
}

function turtle(mob, brain, state, sample, dt, ctx, collider) {
  if (state.gravid) {
    mob.lookTarget = ecologyPoint(state.homeBeach);
    if (ecologyDistance(mob.position, state.homeBeach) > 0.8)
      steer(mob, state.homeBeach, mob.spec.speed, dt, ctx, collider, "amphibious");
    return;
  }
  if (state.loveTime > 0 && Array.isArray(ctx.neighbors)) {
    for (const other of ctx.neighbors.slice(0, AQUATIC_AI_LIMITS.neighbors)) {
      const mate = ctx.ecologyStateFor?.(other?.id);
      if (other !== mob && other?.kind === "turtle" && !other.dead &&
        mate?.alive && mate.loveTime > 0 && !mate.gravid &&
        ecologyDistance(mob.position, other.position) < 8) {
        mob.lookTarget = ecologyEye(other, collider);
        if (ecologyDistance(mob.position, other.position) > 1.5)
          steer(mob, other.position, mob.spec.speed, dt, ctx, collider, "amphibious");
        return;
      }
    }
  }
  if (sample.waterImmersion < 0.2 && (!state.scuteClaimed || brain.clock % 20 < 12)) {
    const goal = waterGoal(mob, brain, ctx, collider);
    if (goal) {
      steer(mob, goal, mob.spec.speed, dt, ctx, collider, "amphibious");
      return;
    }
  }
  wander(mob, brain, state, dt, ctx, collider, "amphibious");
}

function drowned(mob, brain, state, sample, dt, ctx, collider) {
  const day = ecologyIsDaylight(ctx.timeOfDay ?? 0.5);
  if (day && sample.waterImmersion < 0.2) {
    if (brain.hurtIn <= 0) {
      brain.hurtIn = 1;
      if (exposedToSun(ctx.world, { ...mob, spec: collider })) ctx.hurt?.(mob, 2, null, false);
    }
    const goal = waterGoal(mob, brain, ctx, collider);
    if (goal) steer(mob, goal, mob.spec.speed, dt, ctx, collider, "amphibious");
    return;
  }
  const eye = ecologyEye(mob, collider);
  const target = ecologyCanTarget(mob, ctx) && (!day || ctx.playerSwimming === true) &&
    ecologyDistance(mob.position, state.home) <= AQUATIC_AI_LIMITS.leash &&
    ecologyDistance(eye, ctx.playerEye) <= mob.spec.vision &&
    ecologyLineOfSight(ctx.world, eye, ctx.playerEye);
  if (!target) {
    if (!mob.moving) wander(mob, brain, state, dt, ctx, collider, "amphibious");
    return;
  }
  mob.attacking = true;
  mob.lookTarget = ecologyPoint(ctx.playerEye);
  if (ecologyDistance(eye, ctx.playerEye) <= mob.spec.reach) {
    if (brain.cooldown <= 0) {
      brain.cooldown = mob.spec.cooldown;
      ctx.damagePlayer?.(mob.spec.damage, mob.spec.name, mob, { kind: "melee", position: eye });
    }
  } else steer(mob, ctx.player, mob.spec.speed, dt, ctx, collider, "amphibious");
}

function cancelBeam(mob, brain, ctx) {
  if (brain.charge > 0) ctx.onBeam?.(mob, { phase: "cancel", charge: 0 });
  brain.charge = 0;
  brain.target = null;
  mob.beamCharge = 0;
  mob.attacking = false;
}

function guardian(mob, brain, state, sample, dt, ctx, collider) {
  mob.spikesExtended = 1;
  const eye = ecologyEye(mob, collider);
  const distance = ecologyDistance(eye, ctx.playerEye);
  const key = ctx.playerTargetKey ?? "player";
  const target = sample.waterImmersion >= 0.2 && ecologyCanTarget(mob, ctx) &&
    distance >= 2.5 && distance <= mob.spec.reach &&
    ecologyDistance(mob.position, state.home) <= AQUATIC_AI_LIMITS.leash &&
    ecologyLineOfSight(ctx.world, eye, ctx.playerEye);
  if (!target || (brain.target !== null && brain.target !== key)) cancelBeam(mob, brain, ctx);
  if (mob.kind === "elder_guardian" && ecologyCanTarget(mob, ctx) &&
    distance <= 24 && ecologyLineOfSight(ctx.world, eye, ctx.playerEye) &&
    brain.auraIn <= 0 && synchronousEcologyHook(ctx.applyEffect)) {
    brain.auraIn = 30;
    ctx.applyEffect({ id: "mining_fatigue", source: mob.id, duration: 40, level: 2 });
  }
  if (target && brain.cooldown <= 0 && synchronousEcologyHook(ctx.onBeam)) {
    brain.target = key;
    const duration = mob.kind === "elder_guardian" ? 2.5 : 2;
    const charge = clamp(brain.charge + dt, 0, duration);
    // The adapter must accept a visible telegraph in its bounded beam pool.
    // No registered renderer/available beam means no invisible beam damage.
    if (ctx.onBeam(mob, {
      phase: "charge", charge: charge / duration,
      from: eye, to: ecologyPoint(ctx.playerEye),
    }) !== true) {
      cancelBeam(mob, brain, ctx);
      return;
    }
    brain.charge = charge;
    mob.beamCharge = charge / duration;
    mob.attacking = true;
    mob.lookTarget = mob.eyeTarget = ecologyPoint(ctx.playerEye);
    mob.spikesExtended = 1;
    if (charge >= duration) {
      brain.cooldown = mob.spec.cooldown;
      // The renderer must have presented earlier charge frames. A full CPU
      // charge alone is not permission for invisible damage.
      const visible = ctx.onBeam(mob, {
        phase: "fire", charge: 1, from: eye, to: ecologyPoint(ctx.playerEye),
      }) === true;
      if (visible) ctx.damagePlayer?.(mob.spec.damage, mob.spec.name, mob, {
        kind: "guardian_beam", position: eye,
      });
      else cancelBeam(mob, brain, ctx);
      brain.charge = 0;
      brain.target = null;
      mob.beamCharge = 0;
    }
    return;
  }
  if (sample.waterImmersion < 0.08) {
    if (brain.hurtIn <= 0) {
      brain.hurtIn = 1;
      ctx.hurt?.(mob, 1, null, false);
    }
    return;
  }
  if (ecologyCanTarget(mob, ctx) && distance < 2.5) {
    steer(mob, {
      x: mob.position.x * 2 - ctx.player.x, y: mob.position.y,
      z: mob.position.z * 2 - ctx.player.z,
    }, mob.spec.speed, dt, ctx, collider, "swimmer");
  } else if (ecologyCanTarget(mob, ctx) && distance < mob.spec.vision &&
    ecologyDistance(mob.position, state.home) < AQUATIC_AI_LIMITS.leash &&
    ecologyLineOfSight(ctx.world, eye, ctx.playerEye)) {
    steer(mob, ctx.player, mob.spec.speed, dt, ctx, collider, "swimmer");
  } else wander(mob, brain, state, dt, ctx, collider, "swimmer");
  mob.spikesExtended = mob.moving ? 0.2 : 1;
}

export function clearAquaticIntent(mob, ctx = {}) {
  const brain = brains.get(mob);
  if (brain) cancelBeam(mob, brain, ctx);
  Object.assign(mob, {
    moving: false, swimming: false, swimPitch: 0, lookTarget: null,
    eyeTarget: null, beamCharge: 0, attacking: false,
    spikesExtended: ["guardian", "elder_guardian"].includes(mob.kind) ? 1 : 0,
  });
}

/** Runtime brain is a WeakMap, NOT an undocumented mob-save extension. Reload
 * intentionally restarts attack telegraphs. Persistent timers come exclusively
 * from ExpansionEcology; the caller must advance them before this step.
 */
export function stepAquaticMob(mob, dt, ctx, state, collider = mob.spec) {
  const handlers = { dolphin, turtle, drowned, guardian, elder_guardian: guardian };
  if (!Object.hasOwn(handlers, mob.kind)) return false;
  if (!Number.isFinite(dt) || dt <= 0) return true;
  const step = Math.min(AQUATIC_AI_LIMITS.step, dt);
  if (!state?.alive || mob.dead || mob.dormant || !(mob.health > 0) ||
    state.dimension !== ctx.world.dimension) {
    clearAquaticIntent(mob, ctx);
    return true;
  }
  const sample = ecologyBodySample(ctx.world, mob.position, collider, ctx.sampleFluid);
  if (!sample || !ecologyCanOccupy(ctx.world, mob.position, collider)) {
    clearAquaticIntent(mob, ctx);
    return true;
  }
  const brain = brainFor(mob);
  brain.clock = (brain.clock + step) % 120;
  for (const key of ["cooldown", "seekIn", "hurtIn", "effectIn", "auraIn", "spikeIn"])
    brain[key] = Math.max(0, brain[key] - step);
  Object.assign(mob, {
    moving: false, swimming: sample.waterImmersion >= 0.2, swimPitch: 0,
    lookTarget: null, eyeTarget: null, attacking: false, beamCharge: 0,
    spikesExtended: 0,
  });
  if (sample.waterImmersion < 0.08)
    moveEcologyMob(ctx.world, mob, { x: 0, y: -step * 3, z: 0 }, {
      collider, locomotion: "amphibious", sampleFluid: ctx.sampleFluid,
    });
  handlers[mob.kind](mob, brain, state, sample, step, ctx, collider);
  return true;
}

/** Call once for a successfully dealt direct PLAYER melee hit, before removal.
 * Not for projectiles/explosions/thorns, blocked hits or touch contact. The
 * returned attack is explicitly non-recursive; caller applies it to Gameplay.
 */
export function guardianRetaliation(mob, hit, ctx) {
  if (
    !["guardian", "elder_guardian"].includes(mob.kind) ||
    !ecologyCanTarget(mob, ctx) || mob.spikesExtended < 0.8 ||
    hit?.kind !== "melee" || hit.source !== "player" || !(hit.dealt > 0) ||
    typeof hit.id !== "string" || hit.id.length > 100 ||
    ecologyDistance(ecologyEye(mob), ctx.playerEye) > 3 ||
    !ecologyLineOfSight(ctx.world, ecologyEye(mob), ctx.playerEye)
  ) return null;
  const brain = brainFor(mob);
  if (brain.spikeIn > 0 || brain.lastHit === hit.id) return null;
  brain.lastHit = hit.id;
  brain.spikeIn = 0.35;
  return { damage: 2, kind: "thorns", retaliate: false, position: ecologyEye(mob) };
}
