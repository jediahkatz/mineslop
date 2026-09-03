import {
  applyGravity,
  exposedToSun,
  hasLineOfSight,
  moveMob,
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

function wolfCompanion(mob, dt, ctx, distance, toward) {
  const target = ctx.wolfTarget(mob);
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
    if (mob.attackCooldown <= 0) {
      mob.attackCooldown = spec.cooldown;
      ctx.damagePlayer(spec.damage, spec.name, mob);
    }
  } else {
    steer(mob, toward, spec.speed, dt, ctx);
    if (mob.kind === "enderman" && !mob.moving && mob.teleportCooldown <= 0) {
      mob.teleportCooldown = 5;
      ctx.relocate(mob, ctx.player, 4, 8);
    }
  }
}

/** Fixed, bounded substeps; all callbacks are supplied by Wildlife. No rendering. */
export function stepMob(mob, dt, ctx) {
  if (mob.dead || mob.dormant) return;
  const spec = mob.spec;
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
  mob.moving = false;
  sunlight(mob, dt, ctx);
  if (mob.dead) return;
  if (!applyGravity(ctx.world, mob, dt)) {
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
  const canAttack =
    !spec.harmless &&
    !ctx.spawnProtected &&
    ctx.mode !== "creative" &&
    ctx.health > 0;
  const lineOfSight =
    distance < spec.vision &&
    hasLineOfSight(ctx.world, mobEye(mob), ctx.playerEye);
  if (mob.kind === "enderman") {
    mob.lookTimer = canAttack && ctx.isLookingAt(mob) ? mob.lookTimer + dt : 0;
    if (mob.lookTimer > 0.65) mob.angry = 20;
  }
  const aggro =
    canAttack &&
    !mob.tamed &&
    mob.pacified <= 0 &&
    (mob.angry > 0 ||
      (spec.temperament === "hostile" &&
        !(spec.dayNeutral && isDaylight(ctx.timeOfDay))));
  mob.attacking = aggro;
  if (mob.tamed && mob.kind === "wolf") {
    wolfCompanion(mob, dt, ctx, distance, toward);
  } else if (mob.fleeTime > 0 || (spec.shy && distance < 4)) {
    const yaw =
      mob.fleeTime > 0
        ? Math.atan2(
            mob.position.x - mob.threat.x,
            mob.position.z - mob.threat.z
          )
        : toward + Math.PI;
    steer(mob, yaw, spec.speed * 2.6, dt, ctx);
  } else if (
    aggro &&
    distance < spec.vision &&
    (lineOfSight || mob.angry > 0)
  ) {
    fight(mob, dt, ctx, distance, toward, lineOfSight);
  } else {
    mob.fuse = Math.max(0, mob.fuse - dt * 2);
    mob.fusing = false;
    if (mob.followTime > 0 && distance > 2.5 && distance < 14)
      steer(mob, toward, spec.speed * 1.4, dt, ctx);
    else wander(mob, dt, ctx);
  }
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
    targetYaw: random() * Math.PI * 2,
    stride: random() * 6,
    phase: random() * Math.PI * 2,
  };
}
