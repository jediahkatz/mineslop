import { dataRecord, immutable, integer } from "./enchantment-domain.js";
import { normalizeStack } from "./inventory-slots.js";
import { getItem } from "./items.js";
import { normalizeSupportedPotion } from "./potion-rules.js";
import {
  PEARL_GRAVITY, PEARL_STEP_SECONDS, stepPearlFlight,
  validPearlPosition, validPearlVelocity,
} from "./pearl-physics.js";
import { validPearlLife, validPearlOwnerId } from "./pearl-save.js";
import { progressArray } from "./progression-common.js";
import { normalizeProgressionContext } from "./progression-context.js";

export const POTION_PROJECTILES_VERSION = 1;
export const MAX_SPLASH_PROJECTILES = 16;
export const SPLASH_LIFETIME = 15;
export const SPLASH_FRONTIER_LIFETIME = 2;
export const SPLASH_SPEED = 10;
export const SPLASH_GRAVITY = 20;
// Includes eighty maximally escaped seed code units and a 64-character owner.
export const SPLASH_HEADER_BYTES = 1024;
export const SPLASH_MOTION_BYTES = 768;

export function createPotionProjectilesSnapshot(context, ownerId) {
  context = normalizeProgressionContext(context);
  if (!validPearlOwnerId(ownerId)) throw new RangeError("Invalid splash owner");
  return {
    version: POTION_PROJECTILES_VERSION, seed: context.seed,
    generatorVersion: context.generatorVersion, ownerId,
    nextId: 1, accumulator: 0, projectiles: [],
  };
}

export function normalizePotionProjectile(value, context, ownerId) {
  dataRecord(value, ["id", "ownerId", "life", "dimension", "position", "velocity",
    "age", "wait", "stack"], "splash projectile");
  integer(value.id, "splash id", 1, 0x7fffffff);
  for (const field of ["position", "velocity"])
    dataRecord(value[field], ["x", "y", "z"], `splash ${field}`);
  if (
    value.ownerId !== ownerId || !validPearlLife(value.life) ||
    !validPearlPosition(value.position, context, value.dimension) ||
    !validPearlVelocity(value.velocity) ||
    !Number.isFinite(value.age) || value.age < 0 || value.age >= SPLASH_LIFETIME ||
    !Number.isFinite(value.wait) || value.wait < 0 ||
    value.wait >= SPLASH_FRONTIER_LIFETIME || value.wait > value.age
  )
    throw new RangeError("Invalid splash flight");
  const stack = normalizeStack(value.stack, context);
  if (stack.count !== 1 || getItem(stack.id)?.potionForm !== "splash" ||
      normalizeSupportedPotion(stack.data?.potion).form !== "splash")
    throw new RangeError("A splash projectile must own its canonical potion");
  return {
    id: value.id, ownerId, life: value.life, dimension: value.dimension,
    position: { ...value.position }, velocity: { ...value.velocity },
    age: value.age, wait: value.wait, stack,
  };
}

export function normalizePotionProjectilesSnapshot(value, context, ownerId) {
  context = normalizeProgressionContext(context);
  dataRecord(value, ["version", "seed", "generatorVersion", "ownerId", "nextId",
    "accumulator", "projectiles"], "splash snapshot");
  if (value.version !== POTION_PROJECTILES_VERSION || value.seed !== context.seed ||
      value.generatorVersion !== context.generatorVersion || value.ownerId !== ownerId ||
      !validPearlOwnerId(ownerId) || !Number.isFinite(value.accumulator) ||
      value.accumulator < 0 || value.accumulator >= PEARL_STEP_SECONDS)
    throw new RangeError("Invalid splash snapshot identity");
  integer(value.nextId, "next splash id", 1, 0x7fffffff);
  const seen = new Set();
  const projectiles = progressArray(value.projectiles, MAX_SPLASH_PROJECTILES).map((projectile) => {
    const next = normalizePotionProjectile(projectile, context, ownerId);
    if (seen.has(next.id) || next.id >= value.nextId)
      throw new RangeError("Reused splash projectile identity");
    seen.add(next.id);
    return immutable(next);
  });
  if (!projectiles.length && value.accumulator !== 0)
    throw new RangeError("Fractional splash time without projectiles");
  return { ...createPotionProjectilesSnapshot(context, ownerId),
    nextId: value.nextId, accumulator: value.accumulator, projectiles };
}

/** Java-style 0.5 block/tick throw, aimed 20 degrees above the physical view. */
export function splashLaunchVelocity(direction) {
  if (!direction || !["x", "y", "z"].every((axis) => Number.isFinite(direction[axis])))
    return null;
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (length < 1e-8) return null;
  const horizontal = Math.hypot(direction.x, direction.z);
  const pitch = Math.atan2(direction.y, horizontal) + Math.PI / 9;
  return {
    x: (horizontal > 1e-8 ? direction.x / horizontal : 0) * Math.cos(pitch) * SPLASH_SPEED,
    y: Math.sin(pitch) * SPLASH_SPEED,
    z: (horizontal > 1e-8 ? direction.z / horizontal : 1) * Math.cos(pitch) * SPLASH_SPEED,
  };
}

/**
 * Reuse ONLY the read-only quarter-block swept collision helper, not pearl
 * ownership, teleport, damage, tickets or RNG. Potion gravity is independent.
 */
export function stepSplashFlight(world, context, projectile) {
  const step = stepPearlFlight(world, context, projectile);
  if (step.kind !== "flight") return step;
  return { ...step, velocity: {
    ...step.velocity,
    y: step.velocity.y - (SPLASH_GRAVITY - PEARL_GRAVITY) * PEARL_STEP_SECONDS,
  } };
}
