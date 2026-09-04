import {
  ANIMAL_BEHAVIOR_LIMITS,
  animalCanGraze,
  createAnimalBehavior,
  hasAnimalBehavior,
  planAnimalBehavior,
  planAnimalVocalization,
} from "./animal-behavior.js";
import {
  ENDERMAN_LIMITS,
  createEndermanRuntime,
  resetEndermanCombat,
  resetEndermanPursuit,
  stepEndermanGaze,
  stepEndermanPursuit,
  stepEndermanWater,
  teleportEnderman,
} from "./enderman.js";
import { readGeometryCell } from "./geometry-world.js";
import {
  difficultyPolicy,
  mobDifficultyAction,
  peacefulMobCombatReset,
} from "./mob-difficulty.js";
import {
  applyGravity,
  createAnimalNavigation,
  exposedToSun,
  finitePosition,
  footprintLoaded,
  hasLineOfSight,
  moveMob,
  stepAnimalNavigation,
} from "./mob-navigation.js";
import { isDaylight, isHostileSpecies, MOB_SPECIES } from "./mob-species.js";

const wrap = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));
export const mobEye = (mob) => ({
  x: mob.position.x,
  y: mob.position.y + (mob.spec.eyeHeight ?? mob.spec.height * 0.73),
  z: mob.position.z,
});

function steer(mob, yaw, speed, dt, ctx, dy = 0) {
  if (speed <= 0 && dy === 0) return;
  for (const offset of [0, 0.8, -0.8, 1.5, -1.5]) {
    const angle = yaw + offset;
    if (
      !moveMob(
        ctx.world,
        mob,
        Math.sin(angle) * speed * dt,
        Math.cos(angle) * speed * dt,
        dy * dt
      )
    )
      continue;
    mob.root.rotation.y +=
      wrap(angle - mob.root.rotation.y) * Math.min(1, dt * 8);
    mob.moving = true;
    return;
  }
  mob.wanderTimer = Math.min(mob.wanderTimer, 0.2);
}

function sunlight(mob, dt, ctx) {
  mob.sunCheck -= dt;
  if (mob.sunCheck <= 0) {
    mob.sunCheck = 0.6;
    mob.burning =
      !!mob.spec.sunburn &&
      ctx.dimension === "overworld" &&
      isDaylight(ctx.timeOfDay) &&
      exposedToSun(ctx.world, mob);
  }
  if (!mob.burning) {
    mob.burnTimer = 0;
    return;
  }
  mob.burnTimer += dt;
  if (mob.burnTimer >= 1) {
    mob.burnTimer -= 1;
    ctx.hurt(mob, 2, null, false);
  }
}

function wander(mob, dt, ctx) {
  if (mob.wanderTimer <= 0) {
    mob.wanderTimer = 1.5 + ctx.random() * 4;
    mob.walking = ctx.random() > 0.27;
    mob.targetYaw = mob.root.rotation.y + (ctx.random() - 0.5) * 2.7;
    if (
      Math.hypot(mob.position.x - mob.home.x, mob.position.z - mob.home.z) > 11
    )
      mob.targetYaw = Math.atan2(
        mob.home.x - mob.position.x,
        mob.home.z - mob.position.z
      );
  }
  if (!mob.walking) return;
  const speed = mob.spec.speed * (isHostileSpecies(mob.spec) ? 0.4 : 1);
  const dy = mob.spec.aquatic
    ? Math.sin(ctx.time * 0.7 + mob.phase) * 0.25
    : mob.spec.flying
      ? Math.sin(ctx.time * 0.6 + mob.phase) * 0.4
      : 0;
  steer(mob, mob.targetYaw, speed, dt, ctx, dy);
}

function animalState(mob) {
  mob.animalBehavior ??= createAnimalBehavior(
    mob.id ?? `${mob.kind}:${mob.phase}`, mob.root.rotation.y,
  );
  return mob.animalBehavior;
}

function animalAudible(mob, ctx) {
  return ctx.health > 0 && finitePosition(ctx.player) &&
    Math.hypot(mob.position.x - ctx.player.x, mob.position.y - ctx.player.y,
      mob.position.z - ctx.player.z) <= ANIMAL_BEHAVIOR_LIMITS.callRange;
}

function observeAnimalEvent(mob, event, ctx) {
  if (!event || typeof ctx.onAnimalEvent !== "function" ||
    !footprintLoaded(ctx.world, mob.position.x, mob.position.z, mob.spec.radius))
    return;
  ctx.onAnimalEvent(mob, event);
}

function animalVoice(mob, dt, ctx) {
  if (!hasAnimalBehavior(mob.kind)) return;
  const voice = planAnimalVocalization(animalState(mob), {
    audible: animalAudible(mob, ctx),
    alarm: mob.fleeTime > 0 || mob.attacking,
  }, dt);
  // Commit the cooldown before the optional audio observer. A refused/muted
  // call still consumes its opportunity and cannot be retried each substep.
  mob.animalBehavior = voice.state;
  observeAnimalEvent(mob, voice.event, ctx);
}

function animalMotion(mob, dt, ctx, lineOfSight) {
  animalState(mob);
  mob.animalNavigation ??= createAnimalNavigation(mob.phase < Math.PI ? 1 : -1);
  const ground = readGeometryCell(ctx.world,
    Math.floor(mob.position.x), Math.floor(mob.groundY - 0.001), Math.floor(mob.position.z));
  const decision = planAnimalBehavior(mob.animalBehavior, {
    kind: mob.kind,
    position: mob.position,
    home: mob.home,
    yaw: mob.root.rotation.y,
    speed: mob.spec.speed,
    player: ctx.player,
    playerVisible: lineOfSight && ctx.health > 0,
    daylight: isDaylight(ctx.timeOfDay),
    attracted: mob.followTime > 0 || ctx.isAnimalTempted?.(mob) === true,
    fleeTime: mob.fleeTime,
    threat: mob.threat,
    canGraze: animalCanGraze(mob.kind, ground?.id),
    audible: animalAudible(mob, ctx),
  }, dt);
  mob.animalBehavior = decision.state;
  mob.animalIntent = decision.intent.mode;
  mob.grazing = decision.intent.mode === "graze";
  mob.walking = decision.intent.speed > 0;
  mob.targetYaw = decision.intent.yaw;
  stepAnimalNavigation(ctx.world, mob, mob.animalNavigation, decision.intent, dt);
  // Optional post-decision observation. The audio owner supplies voices, range
  // attenuation and a global voice budget; AI never creates audio or items.
  observeAnimalEvent(mob, decision.event, ctx);
}

function wolfCompanion(mob, dt, ctx, distance, toward, canAttack) {
  const target = canAttack ? ctx.wolfTarget(mob) : null;
  if (target) {
    const dx = target.position.x - mob.position.x,
      dz = target.position.z - mob.position.z;
    if (
      Math.hypot(dx, dz) < 1.6 &&
      Math.abs(target.position.y - mob.position.y) < 1.8 &&
      hasLineOfSight(ctx.world, mobEye(mob), mobEye(target))
    ) {
      if (mob.attackCooldown <= 0) {
        mob.attackCooldown = mob.spec.cooldown;
        ctx.hurt(target, mob.spec.damage, { x: dx, y: 0.2, z: dz }, true);
      }
    } else steer(mob, Math.atan2(dx, dz), mob.spec.speed * 1.6, dt, ctx);
  } else if (distance > 3.2) {
    steer(mob, toward, mob.spec.speed * (distance > 7 ? 1.7 : 1), dt, ctx);
  } else if (distance < 1.5) {
    steer(mob, toward + Math.PI, mob.spec.speed * 0.5, dt, ctx);
  }
}

function fight(mob, dt, ctx, distance, toward, lineOfSight) {
  const spec = mob.spec;
  const verticalDistance = Math.abs(mobEye(mob).y - ctx.playerEye.y);
  if (mob.kind === "creeper") {
    if (lineOfSight && Math.hypot(distance, verticalDistance) < 2.6)
      mob.fuse += dt;
    else mob.fuse = Math.max(0, mob.fuse - dt * 2);
    mob.fusing = mob.fuse > 0;
    if (mob.fuse >= 1.65) {
      ctx.explodeMob(mob, 3.2);
      return;
    }
    if (distance > 2.1) steer(mob, toward, spec.speed, dt, ctx);
    return;
  }
  if (spec.ranged) {
    if (distance <= spec.reach && lineOfSight && mob.attackCooldown <= 0) {
      mob.attackCooldown = spec.cooldown;
      ctx.shoot(mob);
    }
    const dy = spec.flying
      ? Math.max(-1, Math.min(1, ctx.player.y + 5 - mob.position.y))
      : 0;
    if (distance > spec.reach * 0.72)
      steer(mob, toward, spec.speed, dt, ctx, dy);
    else if (distance < 4)
      steer(mob, toward + Math.PI, spec.speed, dt, ctx, dy);
    else if (spec.flying)
      steer(mob, toward + Math.PI / 2, spec.speed * 0.45, dt, ctx, dy);
    return;
  }
  if (distance <= spec.reach && verticalDistance < 1.7 && lineOfSight) {
    if (mob.kind === "enderman") resetEndermanPursuit(mob);
    if (mob.attackCooldown <= 0 &&
      (mob.kind !== "enderman" || (mob.restoreAttackCooldown ?? 0) <= 0)) {
      mob.attackCooldown = spec.cooldown;
      ctx.damagePlayer(spec.damage, spec.name, mob);
    }
  } else {
    const previousDistance = Math.hypot(
      mob.position.x - ctx.player.x, mob.position.y - ctx.player.y, mob.position.z - ctx.player.z,
    );
    steer(mob, toward, spec.speed, dt, ctx);
    if (mob.kind === "enderman")
      return stepEndermanPursuit(mob, dt, ctx, previousDistance);
  }
}

/** Fixed, bounded substeps; all callbacks are supplied by Wildlife. No rendering. */
export function stepMob(mob, dt, ctx) {
  if (mob.dead || mob.dormant || !Number.isFinite(dt) || dt <= 0) return;
  dt = Math.min(dt, ANIMAL_BEHAVIOR_LIMITS.step);
  const spec = mob.spec;
  const policy = difficultyPolicy(ctx.difficulty);
  const canAttack =
    policy.mobCombat &&
    !spec.harmless &&
    !ctx.spawnProtected &&
    ctx.mode !== "creative" &&
    ctx.health > 0;
  if (mob.kind === "enderman" && !canAttack) resetEndermanCombat(mob);
  // Motion authority includes bareback/untamed rides AND this frame's dismount.
  // It is independent of tamed/saddled/retained state and must precede gravity,
  // knockback, relocation, hopping, turning and the generic movement flags.
  if (mob.kind === "horse" && ctx.ownsMotionThisFrame?.(mob) === true) {
    if (mob.animalIntent !== "controlled" && mob.animalBehavior) {
      mob.animalBehavior = {
        ...mob.animalBehavior, mode: "idle", remaining: 1.5, approaching: false,
      };
    }
    mob.grazing = false;
    mob.animalIntent = "controlled";
    mob.animalNavigation = null;
    animalVoice(mob, dt, ctx);
    return;
  }
  const retained = ctx.retainsMob?.(mob) === true;
  if (!policy.mobCombat) {
    Object.assign(mob, peacefulMobCombatReset(spec));
    // Retention also covers persistent encounters; it is not proof of taming
    // and cannot turn a suspended hostile into a freely killable passive mob.
    if (mobDifficultyAction(mob, ctx.difficulty) === "suspend") {
      mob.moving = mob.grazing = false;
      return;
    }
  }
  // The owner decides dormancy/removal. AI never reads or searches missing
  // columns, and never relocates a retained horse to simulate wolf following.
  if (!footprintLoaded(ctx.world, mob.position.x, mob.position.z, spec.radius)) return;
  if (mob.kind === "enderman")
    mob.restoreAttackCooldown = Math.max(0, (mob.restoreAttackCooldown ?? 0) - dt);
  for (const key of [
    "attackCooldown",
    "fleeTime",
    "angry",
    "hitFlash",
    "wanderTimer",
    "hopCooldown",
    "teleportCooldown",
    "followTime",
    "pacified",
  ])
    mob[key] = Math.max(0, mob[key] - dt);
  mob.moving = mob.grazing = false;
  if (policy.mobCombat) sunlight(mob, dt, ctx);
  if (mob.dead) return;
  if (mob.kind === "enderman" && stepEndermanWater(mob, dt, ctx)) return;
  if (!applyGravity(ctx.world, mob, dt)) {
    if (retained) return;
    if (mob.kind === "enderman") {
      mob.attacking = false;
      mob.lookTimer = 0;
      resetEndermanPursuit(mob);
      teleportEnderman(mob, ctx, mob.position, 1, 5);
      return;
    }
    if (!ctx.relocate(mob, mob.position, 1, 5)) ctx.cull(mob);
    return;
  }
  if (Math.hypot(mob.knockback.x, mob.knockback.z) > 0.03) {
    moveMob(ctx.world, mob, mob.knockback.x * dt, mob.knockback.z * dt);
    const decay = Math.exp(-8 * dt);
    mob.knockback.x *= decay;
    mob.knockback.z *= decay;
  }
  const dx = ctx.player.x - mob.position.x,
    dz = ctx.player.z - mob.position.z;
  const distance = Math.hypot(dx, dz);
  const toward = Math.atan2(dx, dz);
  const vision = mob.kind === "enderman" ? ENDERMAN_LIMITS.gazeRange : spec.vision;
  const inVision = mob.kind === "enderman" ? distance <= vision : distance < vision;
  const lineOfSight =
    inVision &&
    hasLineOfSight(ctx.world, mobEye(mob), ctx.playerEye);
  const heldByGaze = mob.kind === "enderman" &&
    stepEndermanGaze(mob, dt, ctx, canAttack);
  const aggro =
    canAttack &&
    !mob.tamed &&
    mob.pacified <= 0 &&
    (mob.angry > 0 ||
      (spec.temperament === "hostile" &&
        !(spec.dayNeutral && isDaylight(ctx.timeOfDay))));
  mob.attacking = aggro;
  const fighting = aggro && inVision && (lineOfSight || mob.angry > 0);
  let plannedAnimal = false;
  if (heldByGaze) {
    mob.fuse = 0;
    mob.fusing = false;
    resetEndermanPursuit(mob);
    return;
  } else if (mob.tamed && mob.kind === "wolf") {
    wolfCompanion(mob, dt, ctx, distance, toward, canAttack);
  } else if (hasAnimalBehavior(mob.kind) && (mob.fleeTime > 0 || !fighting)) {
    mob.fuse = Math.max(0, mob.fuse - dt * 2);
    mob.fusing = false;
    animalMotion(mob, dt, ctx, lineOfSight);
    plannedAnimal = true;
  } else if (mob.fleeTime > 0 || (spec.shy && distance < 4)) {
    const yaw =
      mob.fleeTime > 0
        ? Math.atan2(
            mob.position.x - mob.threat.x,
            mob.position.z - mob.threat.z
          )
        : toward + Math.PI;
    steer(mob, yaw, spec.speed * 2.6, dt, ctx);
  } else if (fighting) {
    if (fight(mob, dt, ctx, distance, toward, lineOfSight)) return;
  } else {
    if (mob.kind === "enderman") resetEndermanPursuit(mob);
    mob.fuse = Math.max(0, mob.fuse - dt * 2);
    mob.fusing = false;
    if (mob.followTime > 0 && distance > 2.5 && distance < 14)
      steer(mob, toward, spec.speed * 1.4, dt, ctx);
    else wander(mob, dt, ctx);
  }
  if (!plannedAnimal) animalVoice(mob, dt, ctx);
  if (!canAttack) {
    mob.fuse = 0;
    mob.fusing = false;
    mob.attacking = false;
  }
  if (
    spec.hop &&
    mob.moving &&
    mob.position.y <= mob.groundY + 0.01 &&
    mob.hopCooldown <= 0
  ) {
    mob.velocityY = spec.hop;
    mob.hopCooldown = 0.8 + ctx.random() * 0.45;
  }
}

export function createMobState(kind, random) {
  const spec = MOB_SPECIES[kind];
  return {
    kind,
    spec,
    name: spec.name,
    health: spec.health,
    groundY: 0,
    velocityY: 0,
    knockback: { x: 0, z: 0 },
    threat: { x: 0, z: 0 },
    dead: false,
    dormant: false,
    tamed: false,
    attacking: false,
    moving: false,
    walking: true,
    burning: false,
    fusing: false,
    attackCooldown: 0.5,
    fleeTime: 0,
    angry: 0,
    hitFlash: 0,
    wanderTimer: random() * 2,
    hopCooldown: 0,
    teleportCooldown: 0,
    followTime: 0,
    pacified: 0,
    sunCheck: 0,
    burnTimer: 0,
    fuse: 0,
    lookTimer: 0,
    ...(kind === "enderman" ? createEndermanRuntime() : {}),
    targetYaw: random() * Math.PI * 2,
    stride: random() * 6,
    phase: random() * Math.PI * 2,
  };
}
