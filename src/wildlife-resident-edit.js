import { synchronousEcologyHook } from "./aquatic-ai.js";
import { captureEntityContext } from "./entity-context.js";
import { MAX_LIVING_HORSES } from "./horse-definitions.js";
import {
  horseBaseProjection, horseDataRecord, sameHorseBase, validHorseMotion,
} from "./horse-save.js";
import { finitePosition } from "./mob-navigation.js";
import { isMobId, normalizeMobHeading, validMobPosition } from "./mob-save.js";
import { MAX_ECOLOGY_RESIDENTS, MAX_MOBS, MOB_SPECIES, isHostileSpecies } from "./mob-species.js";

const point = ({ x, y, z }) => ({ x, y, z });
const samePoint = (a, b) => a?.x === b?.x && a?.y === b?.y && a?.z === b?.z;
const finiteHorizontal = (value) => Number.isFinite(value?.x) && Number.isFinite(value?.z);
const editKeys = ["spawn", "remove", "damage", "mob", "heal", "motion", "retain",
  "nextId", "validate", "notify", "fields"];

/** Capture identities, not another resident collection. The active array is
 * bounded; dormant maps are never enumerated to prepare a combat edit.
 */
export function captureResidentBatch(wildlife) {
  if (!wildlife) return null;
  const { world, worldContext, context, coordinator, dimension, entities, animals, byId,
    dormantEcology, dormantHorses, _retainedHorseIds: retained, killed, maxEntities } = wildlife;
  if (wildlife.disposed || !world || !coordinator || !wildlife._ownsRegistration ||
    coordinator.usage(wildlife) !== 0 || world.coordinator !== coordinator ||
    context?.world !== world || context.worldContext !== worldContext ||
    (world.dimension ?? "overworld") !== dimension || animals !== entities ||
    !Array.isArray(entities) || !Number.isInteger(maxEntities) || maxEntities < 1 ||
    maxEntities > MAX_MOBS || entities.length > maxEntities ||
    !(byId instanceof Map) || !(dormantEcology instanceof Map) ||
    !(dormantHorses instanceof Map) || !(retained instanceof Set) || !(killed instanceof Set) ||
    entities.some((mob) => !mob || !isMobId(mob.id) || !mob.spec || byId.get(mob.id) !== mob) ||
    new Set(entities).size !== entities.length ||
    new Set(entities.map((mob) => mob.id)).size !== entities.length) return null;
  const revision = wildlife._ecologyRevision, nextId = wildlife.nextId;
  const members = entities.slice(), byIdSize = byId.size;
  const ecologySize = dormantEcology.size, horseSize = dormantHorses.size, retainedSize = retained.size;
  const epoch = captureEntityContext(world, worldContext);
  const current = () => !wildlife.disposed && wildlife.world === world &&
    wildlife.worldContext === worldContext && wildlife.dimension === dimension &&
    wildlife.context === context && context.world === world && context.worldContext === worldContext &&
    wildlife.coordinator === coordinator && wildlife._ownsRegistration &&
    coordinator.usage(wildlife) === 0 && wildlife._ecologyRevision === revision &&
    wildlife.nextId === nextId && wildlife.maxEntities === maxEntities &&
    wildlife.entities === entities && wildlife.animals === animals &&
    entities.length === members.length && members.every((mob, i) => entities[i] === mob) &&
    wildlife.byId === byId && byId.size === byIdSize &&
    wildlife.dormantEcology === dormantEcology && dormantEcology.size === ecologySize &&
    wildlife.dormantHorses === dormantHorses && dormantHorses.size === horseSize &&
    wildlife._retainedHorseIds === retained && retained.size === retainedSize &&
    wildlife.killed === killed && epoch();
  if (!current() || !Number.isSafeInteger(nextId) || nextId < 0 ||
    nextId >= Number.MAX_SAFE_INTEGER) return null;
  return { wildlife, coordinator, entities, byId, dormantEcology, dormantHorses, retained,
    killed, revision, nextId, maxEntities, retainedSize,
    ecologyCount: ecologySize + members.filter((mob) => mob.spec.ecology).length, current };
}

function captureActor(mob) {
  if (!mob || !isMobId(mob.id) || !Object.hasOwn(MOB_SPECIES, mob.kind) || MOB_SPECIES[mob.kind] !== mob.spec ||
    mob.dead || mob.dormant || !Number.isFinite(mob.health) || mob.health <= 0 ||
    mob.health > mob.spec.health || !finitePosition(mob.position) || !mob.root?.rotation ||
    mob.root.position !== mob.position || !mob.knockback || !finitePosition(mob.home)) return null;
  const base = horseBaseProjection(mob), spec = mob.spec;
  const position = mob.position, root = mob.root, rotation = root.rotation;
  const home = mob.home, homePoint = point(home), knockback = mob.knockback;
  const impulse = { x: knockback.x, z: knockback.z };
  const threat = mob.threat, threatPoint = threat && { x: threat.x, z: threat.z };
  const keys = ["targetYaw", "velocityY", "moving", "speed", "groundY", "hitFlash", "fleeTime"];
  const values = keys.map((key) => mob[key]);
  return {
    base, position: point(position),
    current: () => !mob.dead && !mob.dormant && mob.spec === spec &&
      mob.position === position && mob.root === root && root.position === position && root.rotation === rotation &&
      sameHorseBase(base, horseBaseProjection(mob)) &&
      mob.home === home && samePoint(home, homePoint) &&
      mob.knockback === knockback && knockback.x === impulse.x && knockback.z === impulse.z &&
      mob.threat === threat && (!threat || (threat.x === threatPoint.x && threat.z === threatPoint.z)) &&
      keys.every((key, i) => mob[key] === values[i]),
  };
}

/** The one preparation engine used by standalone wrappers and shared batches.
 * Entries contain data and read guards, never another owner's publisher.
 */
export function prepareResidentEdit(snapshot, domain, options) {
  if (!snapshot.current() || !["horse", "ecology", "legacy", "source"].includes(domain) ||
    !horseDataRecord(options, editKeys, [])) return null;
  const { wildlife, entities, byId, retained, killed } = snapshot;
  const { spawn, remove, damage, mob = remove ?? damage?.mob, heal = 0, motion,
    retain = false, nextId = snapshot.nextId, validate = () => true, notify, fields } = options;
  if (!synchronousEcologyHook(validate) || (notify !== undefined && !synchronousEcologyHook(notify)) ||
    !Number.isSafeInteger(nextId) || nextId < snapshot.nextId || nextId >= Number.MAX_SAFE_INTEGER ||
    !Number.isFinite(heal) || heal < 0 || typeof retain !== "boolean" ||
    (spawn && (mob || remove || damage || heal || motion || retain || domain !== "ecology")) ||
    (remove && (remove !== mob || damage || heal || retain)) ||
    (damage && (damage.mob !== mob || heal)) || ((heal || damage || motion || retain) && !mob) ||
    (retain && domain !== "horse") || (fields && domain !== "source")) return null;
  if (domain === "source" && (!mob || spawn || remove || damage || heal || motion || retain ||
    nextId !== snapshot.nextId || !horseDataRecord(fields, ["attackCooldown", "fuse"], []) ||
    !Object.keys(fields).length ||
    Object.entries(fields).some(([key, value]) => !Number.isFinite(value) || value < 0 ||
      value > (key === "fuse" ? 1.65 : mob.spec?.cooldown)))) return null;
  if (domain === "legacy" && (!mob || mob.kind === "horse" || mob.spec?.ecology ||
    spawn || remove || heal || motion || retain || !damage || nextId !== snapshot.nextId)) return null;
  const key = domain === "horse" || (domain === "source" && mob.kind === "horse")
    ? "horseServices" : domain === "ecology" || (domain === "source" && mob.spec?.ecology)
      ? "ecologyServices" : null;
  const host = key && wildlife[key];
  if (key && (!host?.active || host.coordinator !== snapshot.coordinator)) return null;
  const actor = mob && captureActor(mob), created = spawn && captureActor(spawn);
  if ((mob && (!actor || byId.get(mob.id) !== mob || !entities.includes(mob) ||
    (domain === "horse" && mob.kind !== "horse") || (domain === "ecology" && !mob.spec.ecology))) ||
    (spawn && (!created || !spawn.spec.ecology)) ||
    (domain === "source" && key === "ecologyServices" &&
      !host.ecology.canRestore(mob.id, mob.kind, wildlife.dimension))) return null;
  const id = mob?.id ?? spawn?.id, wasRetained = mob && retained.has(id);
  const dormant = domain === "horse" ? snapshot.dormantHorses : snapshot.dormantEcology;
  const spawnAvailable = () => !byId.has(id) && !killed.has(id) &&
    !wildlife.horseServices?.identityReserved(id);
  if ((retain && !wasRetained && retained.size >= MAX_LIVING_HORSES) ||
    (spawn && (!spawnAvailable() || entities.length >= snapshot.maxEntities ||
      snapshot.ecologyCount >= MAX_ECOLOGY_RESIDENTS))) return null;
  const values = {}, edit = { id, mob, spawn, remove, dormant, retain, nextId, validate, notify,
    removeIndex: remove ? entities.indexOf(remove) : -1,
    retainAdded: !!(retain && !wasRetained), values };
  if (remove) Object.assign(values, { health: 0, dead: true });
  if (heal) {
    if (mob.health + heal > mob.spec.health) return null;
    Object.assign(values, { health: mob.health + heal, fleeTime: 0 });
  }
  if (damage) {
    if (!Number.isFinite(damage.amount) || damage.amount <= 0 || damage.amount >= mob.health ||
      typeof damage.retaliate !== "boolean" ||
      (damage.knockback !== undefined && !finiteHorizontal(damage.knockback)) ||
      (damage.threat !== undefined && !finiteHorizontal(damage.threat)) ||
      (damage.velocityY !== undefined && (domain !== "legacy" || damage.velocityY !== 2.4))) return null;
    Object.assign(values, { health: mob.health - damage.amount, hitFlash: 0.24 });
    if (damage.threat !== undefined) values.threat = { ...damage.threat };
    if (damage.knockback !== undefined) edit.knockback = { ...damage.knockback };
    if (damage.velocityY !== undefined) values.velocityY = damage.velocityY;
    if (damage.retaliate) {
      if (mob.spec.temperament === "passive" || (domain === "legacy" && mob.tamed)) values.fleeTime = 5;
      else values.angry = 20;
      if (domain === "legacy" && isHostileSpecies(mob.spec)) {
        edit.defend = { target: id, until: wildlife.clock + 8 };
      }
    }
  }
  if (motion && !remove) {
    if (!validMobPosition(motion.position, mob.spec, wildlife.worldContext, wildlife.dimension) ||
      !Number.isFinite(motion.yaw) || !validHorseMotion(motion.motion)) return null;
    edit.position = point(motion.position);
    edit.yaw = normalizeMobHeading(motion.yaw);
    Object.assign(values, {
      targetYaw: edit.yaw, velocityY: motion.motion.vy,
      moving: Math.hypot(motion.position.x - actor.position.x, motion.position.z - actor.position.z) > 1e-6,
      speed: Math.hypot(motion.motion.vx, motion.motion.vz),
      ...(motion.motion.grounded ? { groundY: motion.position.y } : {}),
    });
    if (domain === "horse") {
      edit.home = point(motion.position);
      edit.knockback = { x: 0, z: 0 };
    }
  }
  if (fields) Object.assign(values, fields);
  const clock = wildlife.clock, defendTarget = wildlife.defendTarget, defendUntil = wildlife.defendUntil;
  edit.current = () => (!key || (wildlife[key] === host && host.active &&
    host.coordinator === snapshot.coordinator)) &&
    (!mob || (actor.current() && byId.get(id) === mob && entities.includes(mob) &&
      retained.has(id) === wasRetained)) &&
    (domain !== "source" || key !== "ecologyServices" ||
      host.ecology.canRestore(id, mob.kind, wildlife.dimension)) &&
    (!spawn || (created.current() && spawnAvailable())) &&
    (!edit.defend || (wildlife.clock === clock && wildlife.defendTarget === defendTarget &&
      wildlife.defendUntil === defendUntil));
  return edit;
}

/** Preserve the existing borrower impulse semantics, including zero direction. */
export function residentDamage(player, mob, amount, direction, retaliate, legacy = false) {
  const finite = finitePosition(direction);
  const length = finite ? Math.hypot(direction.x, direction.z) : 0;
  const strength = Math.min(7, 2.5 + amount * 0.4);
  return {
    mob, amount, retaliate,
    ...(!legacy || length > 0 ? {
      knockback: length ? { x: direction.x / length * strength, z: direction.z / length * strength }
        : { x: 0, z: 0 },
    } : {}),
    ...(!legacy || !finite || length > 0 ? {
      threat: length ? { x: mob.position.x - direction.x / length * 3,
        z: mob.position.z - direction.z / length * 3 } : { x: player.x, z: player.z },
    } : {}),
    ...(legacy && length > 0 && !mob.spec.aquatic && !mob.spec.flying ? { velocityY: 2.4 } : {}),
  };
}

export function horseResidentEdit(wildlife, mob, {
  health = mob?.health, remove = false, retain = false, motion,
  direction, retaliate = true, validate, notify,
} = {}) {
  if (mob?.kind !== "horse" || mob.tamed || typeof remove !== "boolean" ||
    typeof retain !== "boolean" || (remove && retain) || typeof retaliate !== "boolean" ||
    (!remove && (!Number.isFinite(health) || health <= 0 || health > mob.spec.health))) return null;
  let movement;
  if (motion) {
    if (!validMobPosition(motion.position, mob.spec, wildlife.worldContext, wildlife.dimension) ||
      !Number.isFinite(motion.yaw) || !validHorseMotion(motion.motion)) return null;
    movement = { position: point(motion.position),
      yaw: normalizeMobHeading(motion.yaw), motion: { ...motion.motion } };
  }
  const amount = mob.health - health;
  return {
    mob, remove: remove ? mob : undefined, retain, motion: movement,
    heal: !remove && amount < 0 ? -amount : 0,
    damage: !remove && amount > 0 ? residentDamage(wildlife.player, mob, amount, direction, retaliate) : undefined,
    validate, notify,
  };
}

/** Installation only. Keep live arrays, maps, vectors and actor objects. */
export function installResidentEdits(snapshot, edits, removals, nextId) {
  const { wildlife, entities, byId, retained } = snapshot;
  for (const edit of removals) {
    entities.splice(edit.removeIndex, 1);
    edit.dormant.delete(edit.id);
    byId.delete(edit.id);
    if (edit.remove.kind === "horse") retained.delete(edit.id);
  }
  for (const edit of edits) {
    if (edit.spawn) {
      entities.push(edit.spawn);
      byId.set(edit.id, edit.spawn);
    }
    if (edit.retain) retained.add(edit.id);
    if (edit.mob) {
      Object.assign(edit.mob, edit.values);
      if (edit.knockback) {
        edit.mob.knockback.x = edit.knockback.x;
        edit.mob.knockback.z = edit.knockback.z;
      }
      if (edit.position) {
        edit.mob.position.copy(edit.position);
        edit.mob.root.rotation.y = edit.yaw;
      }
      if (edit.home) edit.mob.home.copy(edit.home);
    }
    if (edit.defend) {
      wildlife.defendTarget = edit.defend.target;
      wildlife.defendUntil = edit.defend.until;
    }
  }
  wildlife.nextId = nextId;
  wildlife._ecologyRevision++;
}
