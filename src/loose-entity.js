import { box, overlaps } from "./aabb.js";
import { sweepBoxAxis, visitWorldBoxes } from "./collision.js";
import {
  columnLoaded,
  geometryWorldSpec,
  validBodyPosition,
} from "./geometry-world.js";
import { WORLD_MAX, WORLD_MIN } from "./terrain.js";

// Match storage.js / player-save.js: high flight is valid while y + 2 remains
// a safe voxel coordinate. The terrain height is not a flight/drop ceiling.
export const MAX_LOOSE_Y = Number.MAX_SAFE_INTEGER - 2;
export const MAX_LOOSE_SPEED = 32;
export const MAX_PICKUP_DELAY = 60;
const DIMENSIONS = new Set(["overworld", "nether", "end"]);

export const isLooseRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const isLooseDimension = (dimension) => DIMENSIONS.has(dimension);
export const isLoosePosition = (position, context) =>
  isLooseRecord(position) &&
  validBodyPosition(position, context) &&
  position.y <= MAX_LOOSE_Y &&
  Number.isSafeInteger(Math.ceil(position.y + 2));

/** Delays are remaining simulation seconds; velocities are blocks/second. */
export function isLooseMotion(options) {
  if (!isLooseRecord(options)) return false;
  if (
    options.pickupDelay !== undefined &&
    (!Number.isFinite(options.pickupDelay) ||
      options.pickupDelay < 0 ||
      options.pickupDelay > MAX_PICKUP_DELAY)
  )
    return false;
  return (
    options.velocity === undefined ||
    (isLooseRecord(options.velocity) &&
      ["x", "y", "z"].every(
        (axis) =>
          Number.isFinite(options.velocity[axis]) &&
          Math.abs(options.velocity[axis]) <= MAX_LOOSE_SPEED
      ))
  );
}

export function looseMotion(options, initialY = 0) {
  return {
    pickupDelay: options.pickupDelay ?? 0,
    vx: options.velocity?.x ?? 0,
    vy: options.velocity?.y ?? initialY,
    vz: options.velocity?.z ?? 0,
  };
}

export function serializeLooseMotion(entity) {
  return {
    pickupDelay: entity.pickupDelay,
    velocity: { x: entity.vx, y: entity.vy, z: entity.vz },
  };
}

// A delayed throw must not merge into an immediately collectible resting stack.
export const sameLooseMotion = (a, b) =>
  a.pickupDelay === b.pickupDelay &&
  a.vx === b.vx &&
  a.vy === b.vy &&
  a.vz === b.vz;

export const looseDistanceSquared = (a, b) =>
  (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;

function columnsAt(position, footprint, destination = position) {
  return {
    minX: Math.max(
      WORLD_MIN,
      Math.floor(Math.min(position.x, destination.x) - footprint)
    ),
    maxX: Math.min(
      WORLD_MAX - 1,
      Math.floor(Math.max(position.x, destination.x) + footprint)
    ),
    minZ: Math.max(
      WORLD_MIN,
      Math.floor(Math.min(position.z, destination.z) - footprint)
    ),
    maxZ: Math.min(
      WORLD_MAX - 1,
      Math.floor(Math.max(position.z, destination.z) + footprint)
    ),
  };
}

export function loadedLooseColumns(world, position, footprint, destination) {
  const columns = columnsAt(position, footprint, destination);
  for (let x = columns.minX; x <= columns.maxX; x++)
    for (let z = columns.minZ; z <= columns.maxZ; z++)
      if (!columnLoaded(world, x, z)) return null;
  return columns;
}

const looseBox = (entity, halfSize, footprint) =>
  box(
    entity.x - footprint,
    entity.y - halfSize,
    entity.z - footprint,
    entity.x + footprint,
    entity.y + halfSize,
    entity.z + footprint
  );

function liftOut(world, entity, halfSize, footprint) {
  const spec = geometryWorldSpec(world);
  // Placement may enclose a drop. Lift over actual contacts (including slabs
  // and fence protrusions), preserving its item data and reservation.
  for (let attempts = 0; attempts <= (spec.maxY - spec.minY) * 8; attempts++) {
    const body = looseBox(entity, halfSize, footprint);
    let top = -Infinity;
    visitWorldBoxes(world, body, "collision", (contact) => {
      if (!contact.frontier && overlaps(body, contact.box))
        top = Math.max(top, contact.box[4]);
    });
    if (!Number.isFinite(top)) break;
    entity.y = top + halfSize;
    entity.vy = 0;
  }
}

function moveVertical(world, entity, amount, halfSize, footprint) {
  const bottom = geometryWorldSpec(world).minY + halfSize;
  const requested = entity.y + amount;
  const next = Math.max(bottom, Math.min(MAX_LOOSE_Y, requested));
  const moved = sweepBoxAxis(
    world,
    looseBox(entity, halfSize, footprint),
    "y",
    next - entity.y
  );
  entity.y += moved.amount;
  if (moved.blocked || next !== requested) entity.vy = 0;
}

function moveHorizontal(world, entity, axis, amount, halfSize, footprint) {
  if (!amount) return;
  const velocity = axis === "x" ? "vx" : "vz";
  const requested = entity[axis] + amount;
  const next = Math.max(
    WORLD_MIN + footprint,
    Math.min(WORLD_MAX - footprint, requested)
  );
  const moved = sweepBoxAxis(
    world,
    looseBox(entity, halfSize, footprint),
    axis,
    next - entity[axis]
  );
  entity[axis] += moved.amount;
  if (moved.blocked || next !== requested) entity[velocity] = 0;
}

/**
 * Finite, swept, axis-separated loose-body physics. All crossed columns are
 * preflighted before mutation: an unloaded frontier freezes the entire motion.
 * Vertical queries stay in terrain bounds even for safe-integer flight heights.
 */
export function stepLooseEntity(
  world,
  entity,
  dt,
  { halfSize, footprint = halfSize * Math.SQRT2, gravity = 16, drag = 3 }
) {
  if (
    !Number.isFinite(dt) ||
    dt <= 0 ||
    !isLoosePosition(entity, world) ||
    ![
      entity.vx,
      entity.vy,
      entity.vz,
      halfSize,
      footprint,
      gravity,
      drag,
    ].every(Number.isFinite) ||
    [entity.vx, entity.vy, entity.vz].some(
      (speed) => Math.abs(speed) > MAX_LOOSE_SPEED
    ) ||
    halfSize <= 0 ||
    footprint <= 0 ||
    gravity < 0 ||
    drag < 0
  )
    return false;
  const step = Math.min(dt, 0.1);
  const destination = {
    x: Math.max(
      WORLD_MIN + footprint,
      Math.min(WORLD_MAX - footprint, entity.x + entity.vx * step)
    ),
    z: Math.max(
      WORLD_MIN + footprint,
      Math.min(WORLD_MAX - footprint, entity.z + entity.vz * step)
    ),
  };
  if (!loadedLooseColumns(world, entity, footprint, destination)) return false;
  liftOut(world, entity, halfSize, footprint);
  entity.vy = Math.max(-18, entity.vy - gravity * step);
  const steps = Math.max(
    1,
    Math.ceil((Math.max(Math.abs(entity.vx), Math.abs(entity.vz)) * step) / 0.2)
  );
  for (let i = 0; i < steps; i++) {
    moveVertical(
      world,
      entity,
      (entity.vy * step) / steps,
      halfSize,
      footprint
    );
    moveHorizontal(
      world,
      entity,
      "x",
      (entity.vx * step) / steps,
      halfSize,
      footprint
    );
    moveHorizontal(
      world,
      entity,
      "z",
      (entity.vz * step) / steps,
      halfSize,
      footprint
    );
  }
  const damping = Math.exp(-drag * step);
  entity.vx *= damping;
  entity.vz *= damping;
  return true;
}
