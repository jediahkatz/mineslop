import { overlaps } from "./aabb.js";
import { isWaterFluid } from "./block-state.js";
import { bodyBox, visitWorldBoxes } from "./collision.js";
import { finitePosition, hasLineOfSight } from "./mob-navigation.js";

export const ENDERMAN_LIMITS = Object.freeze({
  provokeTime: 0.25,
  gazeRange: 64,
  freezeRange: 16,
  escapeRange: 4,
  angerTime: 20,
  teleportCooldown: 1,
  waterDamageInterval: 0.5,
  pursuitDelay: 1.5,
  blockedDelay: 1.5,
  maxHop: 32,
  recovery: 0.35,
});

export const createEndermanRuntime = () => ({
  pursuitTime: 0,
  blockedTime: 0,
  waterDamageCooldown: 0,
});

export function resetEndermanPursuit(mob) {
  mob.pursuitTime = mob.blockedTime = 0;
}

export function resetEndermanCombat(mob) {
  resetEndermanPursuit(mob);
  mob.angry = mob.lookTimer = 0;
  mob.attacking = false;
  mob.attackCooldown = Math.max(mob.attackCooldown, ENDERMAN_LIMITS.recovery);
}

/** Save carries anger, not partially charged navigation/stare/retry work. */
export function restoreEndermanRuntime(mob) {
  Object.assign(mob, createEndermanRuntime());
  mob.lookTimer = mob.hitFlash = 0;
  mob.teleportCooldown = ENDERMAN_LIMITS.teleportCooldown;
  mob.attackCooldown = Math.max(mob.attackCooldown, ENDERMAN_LIMITS.recovery);
}

/** Final destination guard, shared by every Enderman relocation reason. */
export function endermanDestinationAllowed(mob, position, player, playerHeight = 1.8) {
  if (!finitePosition(position)) return false;
  const distance = Math.hypot(
    position.x - mob.position.x, position.y - mob.position.y, position.z - mob.position.z,
  );
  return distance > 1e-6 && distance <= ENDERMAN_LIMITS.maxHop &&
    (!finitePosition(player) || !overlaps(
      bodyBox(position, mob.spec.radius, mob.spec.height),
      bodyBox(player, 0.36, playerHeight),
    ));
}

export const endermanEye = (mob) => ({
  x: mob.position.x,
  y: mob.position.y + mob.spec.eyeHeight,
  z: mob.position.z,
});

/** Physical eye direction only: animation, bob and render origins have no authority. */
export function isEndermanStaredAt(world, mob, eye, forward, player) {
  if (!finitePosition(eye) || !finitePosition(forward) || !finitePosition(player)) return false;
  const target = endermanEye(mob);
  const dx = target.x - eye.x, dy = target.y - eye.y, dz = target.z - eye.z;
  const distance = Math.hypot(dx, dy, dz);
  const length = Math.hypot(forward.x, forward.y, forward.z);
  const targetDistance = Math.hypot(
    mob.position.x - player.x, mob.position.y - player.y, mob.position.z - player.z,
  );
  if (length < 1e-9 || distance < 1e-9 || targetDistance > ENDERMAN_LIMITS.gazeRange)
    return false;
  // Java's distance-dependent eye-direction tolerance, not a fixed wide cone
  // or a ray against an animated mesh.
  const dot = (dx * forward.x + dy * forward.y + dz * forward.z) / (distance * length);
  return dot > 1 - 0.025 / distance && hasLineOfSight(world, eye, target);
}

/** Spend retry budget even when the loaded-world search cannot find a safe site. */
export function teleportEnderman(mob, ctx, center, minRadius, maxRadius, cooldown = ENDERMAN_LIMITS.teleportCooldown, options) {
  if (mob.dead || mob.dormant || mob.teleportCooldown > 1e-9) return false;
  resetEndermanPursuit(mob);
  // Wildlife spends its budget before searching. Keep the same contract for
  // standalone AI contexts whose relocation callback does not own timers.
  const result = ctx.relocate(mob, center, minRadius, maxRadius, options);
  mob.teleportCooldown = Math.max(mob.teleportCooldown, cooldown);
  return result;
}

/** Sustained far pursuit or lack of forward progress, not a random melee dodge. */
export function stepEndermanPursuit(mob, dt, ctx, previousDistance) {
  const dx = ctx.player.x - mob.position.x;
  const dy = ctx.player.y - mob.position.y;
  const dz = ctx.player.z - mob.position.z;
  const distance = Math.hypot(dx, dy, dz);
  mob.pursuitTime = distance > ENDERMAN_LIMITS.freezeRange
    ? Math.min(ENDERMAN_LIMITS.pursuitDelay, (mob.pursuitTime ?? 0) + dt) : 0;
  mob.blockedTime = previousDistance - distance < mob.spec.speed * dt * 0.1
    ? Math.min(ENDERMAN_LIMITS.blockedDelay, (mob.blockedTime ?? 0) + dt) : 0;
  if (mob.pursuitTime + 1e-9 < ENDERMAN_LIMITS.pursuitDelay &&
    mob.blockedTime + 1e-9 < ENDERMAN_LIMITS.blockedDelay) return false;
  // Aim a bounded hop along the physical target direction. Jitter searches
  // around that intermediate point; the owner rejects non-progressing sites.
  const progress = Math.min(24, Math.max(0, distance - 6));
  const fraction = distance > 0 ? progress / distance : 0;
  const center = {
    x: mob.position.x + dx * fraction,
    y: mob.position.y + dy * fraction,
    z: mob.position.z + dz * fraction,
  };
  return teleportEnderman(mob, ctx, center, 2, 4,
    ENDERMAN_LIMITS.teleportCooldown, { towardPlayer: true });
}

/** Returns whether gaze owns locomotion this substep (not gravity/knockback). */
export function stepEndermanGaze(mob, dt, ctx, canAttack) {
  const looking = canAttack && ctx.isLookingAt(mob);
  mob.lookTimer = looking
    ? Math.min(ENDERMAN_LIMITS.provokeTime, mob.lookTimer + dt)
    : 0;
  if (mob.lookTimer + 1e-9 >= ENDERMAN_LIMITS.provokeTime)
    mob.angry = ENDERMAN_LIMITS.angerTime;
  if (!looking) return false;
  if (mob.angry <= 0) return true;
  const distance = Math.hypot(
    mob.position.x - ctx.player.x,
    mob.position.y - ctx.player.y,
    mob.position.z - ctx.player.z,
  );
  if (distance < ENDERMAN_LIMITS.escapeRange) {
    teleportEnderman(mob, ctx, ctx.player, 8, 16);
    // A successful teleport invalidates the caller's old distance/heading.
    // A failed close escape must still hold rather than immediately melee.
    return true;
  }
  return distance <= ENDERMAN_LIMITS.freezeRange;
}

/** Water precedes generic invalid-ground recovery, which would otherwise cull. */
export function stepEndermanWater(mob, dt, ctx) {
  mob.waterDamageCooldown = Math.max(0, (mob.waterDamageCooldown ?? 0) - dt);
  const body = bodyBox(mob.position, mob.spec.radius, mob.spec.height);
  let wet = false;
  visitWorldBoxes(ctx.world, body, "fluidVolume", (contact) => {
    if (isWaterFluid(contact.shape.fluid) && overlaps(body, contact.box)) wet = true;
  }, { unloaded: "empty", borders: false });
  if (!wet) return false;
  resetEndermanPursuit(mob);
  mob.lookTimer = 0;
  mob.attacking = false;
  if (mob.waterDamageCooldown <= 1e-9) {
    mob.waterDamageCooldown = ENDERMAN_LIMITS.waterDamageInterval;
    ctx.hurt(mob, 1, null, false);
  }
  if (!mob.dead) teleportEnderman(mob, ctx, mob.position, 4, 12);
  return true;
}
