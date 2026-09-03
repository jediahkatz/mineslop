import {
  AQUATIC_AI_LIMITS,
  ecologyBodySample,
  ecologyCanOccupy,
  ecologyCanTarget,
  ecologyDistance,
  ecologyEye,
  ecologyIsDaylight,
  ecologyLineOfSight,
  ecologyPoint,
  ecologySupportAt,
  moveEcologyMob,
  pointInEcologyRegion,
  synchronousEcologyHook,
} from "./aquatic-ai.js";
import { BLOCK } from "./blocks.js";
import { captureEntityContext } from "./entity-context.js";
import { geometryWorldSpec, readGeometryCell, validBodyPosition } from "./geometry-world.js";
import { finitePosition } from "./mob-navigation.js";

export const NPC_PROFESSIONS = Object.freeze([
  "unemployed", "nitwit", "farmer", "librarian", "cartographer", "toolsmith",
  "cleric", "fisher", "armorer",
]);
const brains = new WeakMap();
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const wrap = (value) => Math.atan2(Math.sin(value), Math.cos(value));
const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const id = (value) => typeof value === "string" && value.length > 0 && value.length <= 1200;
const fields = (value, names) => record(value) && Object.keys(value).every((key) => names.includes(key));

function point(value, context, dimension) {
  return fields(value, ["x", "y", "z"]) && validBodyPosition(value, context, {
    radius: 0.32, height: 1.95, dimension,
  }) && value.y + 1.95 <= geometryWorldSpec(context, dimension).maxY;
}
function anchor(value, context, dimension) {
  return fields(value, ["id", "position"]) && id(value.id) && point(value.position, context, dimension)
    ? { id: value.id, position: ecologyPoint(value.position) } : null;
}

/** Read-only adapter shape, NOT another trade owner. Profession, claim, offer,
 * stock, restock day and trade history remain in the parent's trading archive.
 */
export function normalizeVillagerAssignment(value, context) {
  try {
    if (!fields(value, ["id", "structureId", "dimension", "profession", "revision", "home", "jobSite"]) ||
      !id(value.id) || value.id.length > 100 || !id(value.structureId) ||
      value.dimension !== "overworld" || !NPC_PROFESSIONS.includes(value.profession) ||
      !Number.isSafeInteger(value.revision) || value.revision < 0) return null;
    const home = value.home === null ? null : anchor(value.home, context, value.dimension);
    const jobSite = value.jobSite === null ? null : anchor(value.jobSite, context, value.dimension);
    if ((value.home !== null && !home) || (value.jobSite !== null && !jobSite)) return null;
    return {
      id: value.id, structureId: value.structureId, dimension: value.dimension,
      profession: value.profession, revision: value.revision, home, jobSite,
    };
  } catch {
    return null;
  }
}

/** Direct bridge to structure-layouts' member/home/job_site marker contracts.
 * Subsequent job changes are supplied by the trade owner, not these defaults.
 */
export function villagerAssignmentFromMarkers(member, home, jobSite, context, revision = 0, entityId = member?.id) {
  if (member?.type !== "member" || member.entity !== "villager" ||
    home?.type !== "home" || member.homeId !== home.id ||
    jobSite?.type !== "job_site" || member.jobSiteId !== jobSite.id ||
    jobSite.memberId !== member.id || member.structureId !== home.structureId ||
    member.structureId !== jobSite.structureId || member.profession !== jobSite.profession ||
    !finitePosition(home.position) || !finitePosition(jobSite.position))
    return null;
  const center = (marker) => ({
    x: marker.position.x + 0.5, y: marker.position.y, z: marker.position.z + 0.5,
  });
  return normalizeVillagerAssignment({
    id: entityId, structureId: member.structureId, dimension: member.dimension,
    profession: member.profession, revision,
    home: { id: home.id, position: center(home) },
    jobSite: { id: jobSite.id, position: center(jobSite) },
  }, context);
}

/** Adapter for Trading.readRuntime(id) (or the superset Trading.get(id)):
 * jobsite is lowercase and its position is an integer CELL, whereas AI anchors
 * are feet-center points. Offers/XP/calendar never enter the ecology archive.
 */
export function villagerAssignmentFromTrader(trader, {
  entityId = trader?.id, structureId, home = null, revision,
} = {}, context) {
  if (!record(trader) || !NPC_PROFESSIONS.includes(trader.profession) ||
    (trader.jobsite !== null && (!finitePosition(trader.jobsite?.position) ||
      trader.jobsite.dimension !== "overworld"))) return null;
  return normalizeVillagerAssignment({
    id: entityId, structureId, dimension: "overworld", profession: trader.profession,
    revision, home,
    jobSite: trader.jobsite === null ? null : {
      id: trader.jobsite.id,
      position: {
        x: trader.jobsite.position.x + 0.5,
        y: trader.jobsite.position.y,
        z: trader.jobsite.position.z + 0.5,
      },
    },
  }, context);
}

export function admitNpcSpawn(kind, position, collider, ctx) {
  const { structure, marker, world } = ctx;
  if (!ecologyCanOccupy(world, position, collider) ||
    structure?.dimension !== world.dimension ||
    !pointInEcologyRegion(position, structure.bounds)) return false;
  const sample = ecologyBodySample(world, position, collider, ctx.sampleFluid);
  if (!sample || sample.waterImmersion > 0.2 || sample.lavaImmersion > 0) return false;
  if (kind === "villager")
    return world.dimension === "overworld" && structure.kind === "village" &&
      marker?.type === "member" && marker.entity === "villager" &&
      marker.unique === true && marker.structureId === structure.id &&
      marker.dimension === world.dimension && finitePosition(marker.position) &&
      ecologyDistance(position, {
        x: marker.position.x + 0.5, y: marker.position.y, z: marker.position.z + 0.5,
      }) < 0.01 &&
      ecologySupportAt(world, position, collider, { maxRise: 0, maxDrop: 0.1 }) !== null;
  return kind === "blaze" && world.dimension === "nether" &&
    structure.kind === "nether_fortress" && marker?.structureId === structure.id &&
    marker.dimension === world.dimension &&
    ["spawner", "spawn_region", "encounter"].includes(marker.type) &&
    marker.entity === "blaze" &&
    (marker.mechanism !== "spawner" || (marker.block === "SPAWNER" &&
      Number.isInteger(BLOCK.SPAWNER) && finitePosition(marker.position) &&
      readGeometryCell(world, marker.position.x, marker.position.y, marker.position.z)?.id === BLOCK.SPAWNER)) &&
    pointInEcologyRegion(position, marker.bounds ?? structure.bounds);
}

function brainFor(mob) {
  let brain = brains.get(mob);
  if (!brain) {
    brain = { clock: 0, charge: 0, cooldown: 1, burst: 0, burstIn: 0, hurtIn: 0, target: null };
    brains.set(mob, brain);
  }
  return brain;
}

function moveToward(mob, goal, dt, ctx, collider, speed, flying = false) {
  if (!finitePosition(goal)) return;
  // Optional route provider may return ONE nearby waypoint, never ask the AI
  // to execute an unbounded terrain search or open doors by side effect.
  if (synchronousEcologyHook(ctx.npcWaypoint)) {
    const waypoint = ctx.npcWaypoint(mob, goal, { loadedOnly: true, maxNodes: 32 });
    if (finitePosition(waypoint) && ecologyDistance(mob.position, waypoint) <= 4) goal = waypoint;
  }
  const dx = goal.x - mob.position.x, dz = goal.z - mob.position.z;
  const distance = Math.hypot(dx, dz), yaw = Math.atan2(dx, dz);
  const step = Math.min(distance, speed * dt);
  for (const offset of [0, 0.7, -0.7]) {
    if (moveEcologyMob(ctx.world, mob, {
      x: Math.sin(yaw + offset) * step, z: Math.cos(yaw + offset) * step,
      y: flying ? clamp(goal.y - mob.position.y, -1.2, 1.2) * dt : -dt * 3,
    }, { collider, locomotion: flying ? "flight" : "amphibious", sampleFluid: ctx.sampleFluid })) {
      if (mob.root?.rotation && distance > 1e-6) {
        const current = Number.isFinite(mob.root.rotation.y) ? mob.root.rotation.y : 0;
        mob.root.rotation.y = wrap(current + wrap(yaw + offset - current) * Math.min(1, dt * 8));
      }
      return;
    }
  }
}

function nearestThreat(mob, ctx) {
  if (mob.fleeTime > 0 && Number.isFinite(mob.threat?.x) && Number.isFinite(mob.threat?.z))
    return { x: mob.threat.x, y: mob.position.y, z: mob.threat.z };
  let best = null, distance = 10;
  for (const other of (Array.isArray(ctx.threats) ? ctx.threats : []).slice(0, AQUATIC_AI_LIMITS.neighbors)) {
    if (other?.dead || other?.dormant ||
      (other?.spec?.temperament !== "hostile" && other?.attacking !== true)) continue;
    const next = ecologyDistance(mob.position, other.position);
    if (next < distance && ecologyLineOfSight(ctx.world, ecologyEye(mob), ecologyEye(other))) {
      best = other.position;
      distance = next;
    }
  }
  return best;
}

function assignmentFor(mob, ctx) {
  if (!synchronousEcologyHook(ctx.getVillagerAssignment)) return null;
  const assignment = normalizeVillagerAssignment(ctx.getVillagerAssignment(mob.id), ctx.worldContext ?? ctx.world);
  return assignment?.id === mob.id && assignment.dimension === ctx.world.dimension ? assignment : null;
}

function villager(mob, dt, ctx, state, collider) {
  const assignment = assignmentFor(mob, ctx);
  const threat = nearestThreat(mob, ctx);
  mob.fleeTime = Math.max(0, (Number.isFinite(mob.fleeTime) ? mob.fleeTime : 0) - dt);
  let goal = state.home, intent = "idle", atJobsite = false;
  if (threat) {
    intent = "flee";
    const dx = mob.position.x - threat.x, dz = mob.position.z - threat.z;
    const length = Math.hypot(dx, dz) || 1;
    goal = { x: mob.position.x + dx / length * 6, y: mob.position.y, z: mob.position.z + dz / length * 6 };
  } else if (assignment) {
    const work = ecologyIsDaylight(ctx.timeOfDay ?? 0.5);
    const jobLive = assignment.jobSite && ctx.jobsitePresent?.(assignment) === true;
    if (work && jobLive && !["unemployed", "nitwit"].includes(assignment.profession)) {
      intent = "work";
      goal = assignment.jobSite.position;
      atJobsite = ecologyDistance(mob.position, goal) <= 2.5 &&
        ecologyLineOfSight(ctx.world, ecologyEye(mob, collider), {
          ...goal, y: goal.y + collider.eyeHeight,
        });
    } else {
      intent = "home";
      goal = assignment.home?.position ?? state.home;
    }
    if (ctx.isTrading?.(mob.id) === true) intent = "talk";
  }
  if (ecologyDistance(goal, state.home) > AQUATIC_AI_LIMITS.leash) goal = state.home;
  const stop = intent === "work" ? 1.7 : 0.8;
  if (intent !== "talk" && ecologyDistance(mob.position, goal) > stop)
    moveToward(mob, goal, dt, ctx, collider, mob.spec.speed * (intent === "flee" ? 1.8 : 1));
  mob.lookTarget = finitePosition(ctx.playerEye) && ecologyDistance(mob.position, ctx.player) < 5
    ? ecologyPoint(ctx.playerEye) : { ...goal, y: goal.y + collider.eyeHeight };
  mob.npcIntent = intent;
  mob.availableForTrade = !!assignment && !threat && assignment.profession !== "nitwit";
  // Observation only. The trading owner alone checks day/stock/claim revisions
  // and prepares restock; a render/AI tick must never mint offers or inventory.
  ctx.onVillagerIntent?.(mob, {
    intent, atJobsite, canTrade: mob.availableForTrade,
    assignmentRevision: assignment?.revision ?? null,
    jobSiteId: assignment?.jobSite?.id ?? null,
  });
}

/** Extra read guard to combine with a real trading-owner + inventory plan.
 * Stock/prices/offers are NOT validated here: their owner pins those revisions.
 */
export function captureVillagerTrade(mob, ctx) {
  if (mob?.kind !== "villager") return null;
  const assignment = assignmentFor(mob, ctx);
  if (!assignment || !mob.availableForTrade || nearestThreat(mob, ctx))
    return null;
  const world = ctx.world, current = captureEntityContext(world, ctx.worldContext ?? world);
  const position = ecologyPoint(mob.position), health = mob.health, revision = world._editRevision;
  const valid = () => {
    const next = assignmentFor(mob, ctx);
    return ctx.world === world && current() && world._editRevision === revision &&
      ctx.getMob?.(mob.id) === mob && !mob.dead && !mob.dormant && mob.health === health &&
      health > 0 && ctx.health > 0 && mob.availableForTrade && !nearestThreat(mob, ctx) &&
      (ctx.playerDimension ?? ctx.dimension) === world.dimension &&
      ecologyDistance(position, mob.position) === 0 &&
      ecologyDistance(ecologyEye(mob), ctx.playerEye) <= 4 &&
      ecologyLineOfSight(world, ecologyEye(mob), ctx.playerEye) &&
      next?.revision === assignment.revision && next.profession === assignment.profession &&
      next.jobSite?.id === assignment.jobSite?.id &&
      (next.jobSite === null && assignment.jobSite === null ||
        ecologyDistance(next.jobSite?.position, assignment.jobSite?.position) === 0);
  };
  return valid() ? Object.freeze({ assignment, validate: valid }) : null;
}

/** Exact readAvailability shape consumed by Trading. Use interaction=false for
 * autonomous admission/work events; trade UI uses the default physical reach
 * and combines captureVillagerTrade().validate with its prepared trade plan.
 * revision is supplied by the ecology owner, never incremented by this read.
 */
export function readVillagerAvailability(mob, ctx, revision, { interaction = true } = {}) {
  const assignment = mob?.kind === "villager" ? assignmentFor(mob, ctx) : null;
  const alive = !!mob && mob.kind === "villager" && !mob.dead && mob.health > 0 &&
    ctx.getMob?.(mob.id) === mob;
  const available = alive && !!assignment && !mob.dormant &&
    assignment.profession !== "nitwit" &&
    ecologyCanOccupy(ctx.world, mob.position, mob.spec) && !nearestThreat(mob, ctx) &&
    (!interaction || (ctx.health > 0 &&
      (ctx.playerDimension ?? ctx.dimension) === ctx.world.dimension &&
      ecologyDistance(ecologyEye(mob), ctx.playerEye) <= 4 &&
      ecologyLineOfSight(ctx.world, ecologyEye(mob), ctx.playerEye)));
  return {
    adult: true, alive, nitwit: assignment?.profession === "nitwit",
    available: !!available, dimension: ctx.world.dimension,
    revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
  };
}

/** Physical work prerequisite for Trading.jobsiteUsable, not a restock action.
 * Trading remains responsible for exclusive claim, matching content, calendar,
 * daily cap, depleted stock and prepared publication.
 */
export function villagerJobsiteUsable(mob, jobsite, ctx) {
  const assignment = mob?.kind === "villager" ? assignmentFor(mob, ctx) : null;
  if (!assignment || !jobsite || !id(jobsite.id) ||
    jobsite.dimension !== ctx.world.dimension || !finitePosition(jobsite.position))
    return false;
  const position = {
    x: jobsite.position.x + 0.5, y: jobsite.position.y, z: jobsite.position.z + 0.5,
  };
  // Trading checks the PROPOSED jobsite during assignment, not only the old
  // claim. Its owner validates profession/content and exclusive ownership.
  const proposed = { ...assignment, jobSite: { id: jobsite.id, position } };
  return !mob.dead && !mob.dormant && mob.health > 0 && ctx.getMob?.(mob.id) === mob &&
    ecologyCanOccupy(ctx.world, mob.position, mob.spec) && !nearestThreat(mob, ctx) &&
    ctx.jobsitePresent?.(proposed, jobsite) === true &&
    ecologyDistance(mob.position, position) <= 2.5 &&
    ecologyLineOfSight(ctx.world, ecologyEye(mob), {
      ...position, y: position.y + mob.spec.eyeHeight,
    });
}

function blaze(mob, brain, dt, ctx, state, collider) {
  const sample = ecologyBodySample(ctx.world, mob.position, collider, ctx.sampleFluid);
  if (!sample) return;
  if (sample.waterImmersion > 0.2) {
    brain.charge = brain.burst = 0;
    if (brain.hurtIn <= 0) { brain.hurtIn = 1; ctx.hurt?.(mob, 2, null, false); }
    return;
  }
  const eye = ecologyEye(mob, collider);
  const distance = ecologyDistance(eye, ctx.playerEye);
  const key = ctx.playerTargetKey ?? "player";
  const target = ecologyCanTarget(mob, ctx) && distance <= mob.spec.vision &&
    ecologyDistance(mob.position, state.home) <= AQUATIC_AI_LIMITS.leash &&
    ecologyLineOfSight(ctx.world, eye, ctx.playerEye);
  if (!target || (brain.target !== null && brain.target !== key)) {
    brain.charge = brain.burst = 0;
    brain.target = null;
    brain.cooldown = Math.max(brain.cooldown, 0.5);
  }
  if (target) {
    brain.target = key;
    mob.lookTarget = ecologyPoint(ctx.playerEye);
    if (distance <= 2 && brain.cooldown <= 0) {
      brain.cooldown = 1.5;
      ctx.damagePlayer?.(mob.spec.damage, mob.spec.name, mob, { kind: "melee", position: eye });
    } else if (distance <= mob.spec.reach && synchronousEcologyHook(ctx.shootBlaze)) {
      if (brain.cooldown <= 0 && brain.burst === 0) {
        brain.charge = Math.min(1.5, brain.charge + dt);
        mob.beamCharge = brain.charge / 1.5;
        mob.attacking = true;
        if (brain.charge >= 1.5) { brain.burst = 3; brain.burstIn = 0; brain.charge = 0; }
      }
      if (brain.burst > 0) {
        mob.attacking = true;
        mob.beamCharge = 1;
        if (brain.burstIn <= 0) {
          // Dedicated small, non-explosive projectile. Do NOT adapt to the
          // existing ghast fireball's explosion path or emit an inert rod.
          const accepted = ctx.shootBlaze(mob, {
            kind: "blaze_fireball", from: eye, target: ecologyPoint(ctx.playerEye),
            speed: 9, damage: mob.spec.damage, fireSeconds: 4,
            lifetime: 3, radius: 0.15, explosive: false,
          }) === true;
          brain.burst = accepted ? brain.burst - 1 : 0;
          brain.burstIn = 0.25;
          if (!brain.burst) brain.cooldown = accepted ? mob.spec.cooldown : 1;
        }
      }
    }
    if (!mob.attacking && distance > 6)
      moveToward(mob, { ...ctx.player, y: ctx.player.y + 2 }, dt, ctx, collider, mob.spec.speed, true);
  } else {
    const phase = brain.clock * 0.4;
    const goal = {
      x: state.home.x + Math.sin(phase) * 2,
      y: state.home.y + 0.5 + Math.sin(phase * 1.7) * 0.4,
      z: state.home.z + Math.cos(phase) * 2,
    };
    moveToward(mob, goal, dt, ctx, collider, mob.spec.speed * 0.4, true);
  }
}

function resetNpcPose(mob) {
  Object.assign(mob, {
    moving: false, swimming: false, swimPitch: 0, lookTarget: null,
    eyeTarget: null, beamCharge: 0, attacking: false, spikesExtended: 0,
    availableForTrade: false, npcIntent: "idle",
  });
}

/** Suspension/removal cancels ephemeral charge and burst state. Resumption
 * must show a fresh telegraph; neither archive nor dormancy resumes a shot.
 */
export function clearNpcIntent(mob) {
  if (!["villager", "blaze"].includes(mob.kind)) return false;
  const brain = brains.get(mob);
  if (brain) {
    brain.charge = brain.burst = brain.burstIn = 0;
    brain.target = null;
    brain.cooldown = Math.max(brain.cooldown, 0.5);
  }
  resetNpcPose(mob);
  return true;
}

export function stepNpcMob(mob, dt, ctx, state, collider = mob.spec) {
  if (!["villager", "blaze"].includes(mob.kind)) return false;
  if (!Number.isFinite(dt) || dt <= 0) return true;
  if (!state?.alive || mob.dead || mob.dormant || !(mob.health > 0) ||
    state.dimension !== ctx.world.dimension ||
    !ecologyCanOccupy(ctx.world, mob.position, collider) ||
    !ecologyBodySample(ctx.world, mob.position, collider, ctx.sampleFluid)) {
    clearNpcIntent(mob);
    return true;
  }
  resetNpcPose(mob);
  const step = Math.min(dt, AQUATIC_AI_LIMITS.step), brain = brainFor(mob);
  brain.clock = (brain.clock + step) % 120;
  for (const key of ["cooldown", "hurtIn", "burstIn"])
    brain[key] = Math.max(0, brain[key] - step);
  if (mob.kind === "villager") {
    moveEcologyMob(ctx.world, mob, { x: 0, y: -step * 3, z: 0 }, {
      collider, locomotion: "amphibious", sampleFluid: ctx.sampleFluid,
    });
    villager(mob, step, ctx, state, collider);
  }
  else blaze(mob, brain, step, ctx, state, collider);
  return true;
}
