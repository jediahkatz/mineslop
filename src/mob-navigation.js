import { BLOCK, BLOCKS } from "./blocks.js";
import { box, overlaps, subtractBoxes, subtractRectangles } from "./aabb.js";
import { isWaterFluid } from "./block-state.js";
import {
  bodyBox,
  boxCollides,
  supportContacts,
  sweepBoxAxis,
  sweepCameraDistance,
  visitWorldBoxes,
} from "./collision.js";
import {
  columnLoaded,
  geometryWorldSpec,
  readGeometryCell,
  validBodyPosition,
} from "./geometry-world.js";
import { raycast } from "./raycast.js";

export const finitePosition = (position) =>
  !!position && [position.x, position.y, position.z].every(Number.isFinite);

export function insideWorld(position, context) {
  return (
    validBodyPosition(position, context, { height: 0 }) &&
    position.y <
      geometryWorldSpec(context, position?.dimension ?? context?.dimension).maxY
  );
}

function columns(x, z, radius) {
  return {
    x0: Math.floor(x - radius),
    x1: Math.floor(x + radius - 0.001),
    z0: Math.floor(z - radius),
    z1: Math.floor(z + radius - 0.001),
  };
}

export function footprintLoaded(world, x, z, radius = 0.5) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
  const bounds = columns(x, z, radius);
  for (let bx = bounds.x0; bx <= bounds.x1; bx++) {
    for (let bz = bounds.z0; bz <= bounds.z1; bz++) {
      if (!columnLoaded(world, bx, bz)) return false;
    }
  }
  return true;
}

export function canOccupy(world, x, y, z, spec, water = false) {
  const bounds = geometryWorldSpec(world);
  if (
    !validBodyPosition({ x, y, z }, world, {
      radius: spec.radius,
      height: spec.height,
    }) ||
    y + spec.height > bounds.maxY ||
    !footprintLoaded(world, x, z, spec.radius)
  )
    return false;
  const body = bodyBox({ x, y, z }, spec.radius, spec.height);
  if (boxCollides(world, body)) return false;
  const fluids = [];
  let hazardous = false;
  visitWorldBoxes(
    world,
    body,
    "fluidVolume",
    (contact) => {
      if (!overlaps(body, contact.box)) return;
      if (isWaterFluid(contact.shape.fluid)) fluids.push(contact.box);
      else hazardous = true;
    },
    { unloaded: "empty", borders: false }
  );
  if (hazardous) return false;
  return water
    ? subtractBoxes([body], fluids).length === 0
    : fluids.length === 0;
}

/** Returns feet height, checking the whole footprint, headroom, and loaded seams.
 * A one-block slope is allowed; a missing column or cliff is not.
 */
export function groundAt(
  world,
  x,
  z,
  spec,
  {
    nearY,
    stepHeight = spec.stepHeight ?? 1,
    maxDrop = 1,
    natural = false,
  } = {}
) {
  if (!footprintLoaded(world, x, z, spec.radius)) return null;
  let surface = nearY;
  if (surface === undefined) {
    const modern = typeof world.surfaceYAt === "function";
    const top = modern
      ? world.surfaceYAt(Math.floor(x), Math.floor(z))
      : world.heightAt?.(Math.floor(x), Math.floor(z));
    if (!Number.isFinite(top) || (!modern && top < 0)) return null;
    surface = top + 1;
  }
  if (!Number.isFinite(surface)) return null;
  const filter = ({ cell }) =>
    cell.id !== BLOCK.CACTUS &&
    (!natural || !["leaves", "log"].includes(BLOCKS[cell.id]?.texture));
  const candidates = supportContacts(
    world,
    { x, y: surface, z },
    {
      radius: spec.radius,
      maxRise: stepHeight,
      maxDrop: nearY === undefined ? 6 : maxDrop,
      filter,
    }
  );
  const heights = [
    ...new Set(candidates.map((contact) => contact.height)),
  ].sort((a, b) => b - a);
  const footprint = [
    x - spec.radius,
    z - spec.radius,
    x + spec.radius,
    z + spec.radius,
  ];
  for (const feet of heights) {
    if (!canOccupy(world, x, feet, z, spec)) continue;
    const support = supportContacts(
      world,
      { x, y: feet, z },
      {
        radius: spec.radius,
        maxDrop: 1,
        filter,
      }
    );
    const covered = support.map(({ box: bounds }) => [
      bounds[0],
      bounds[2],
      bounds[3],
      bounds[5],
    ]);
    if (subtractRectangles([footprint], covered).length === 0) return feet;
  }
  return null;
}

export function waterHome(world, x, z, spec) {
  if (!footprintLoaded(world, x, z, spec.radius)) return null;
  const bx = Math.floor(x),
    bz = Math.floor(z);
  const { minY, maxY } = geometryWorldSpec(world);
  const water = (y) => isWaterFluid(readGeometryCell(world, bx, y, bz)?.fluid);
  for (let top = maxY - 1; top >= minY + spec.minWaterDepth - 1; top--) {
    if (!water(top)) continue;
    let depth = 0;
    while (depth < spec.minWaterDepth && water(top - depth)) depth++;
    if (depth < spec.minWaterDepth) return null;
    const y = top + 1 - spec.height - 0.65;
    return canOccupy(world, x, y, z, spec, true) ? y : null;
  }
  return null;
}

function clearSweep(world, from, to, spec) {
  const position = { x: from.x, y: from.y, z: from.z };
  for (const axis of ["y", "x", "z"]) {
    const movement = sweepBoxAxis(
      world,
      bodyBox(position, spec.radius, spec.height),
      axis,
      to[axis] - position[axis]
    );
    if (movement.blocked) return false;
    position[axis] += movement.amount;
  }
  return true;
}

export function moveMob(world, entity, dx, dz, dy = 0) {
  const { spec, position } = entity;
  if (![dx, dz, dy].every(Number.isFinite)) return false;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz, dy) / 0.2));
  if (steps > 16) return false;
  let moved = false;
  for (let i = 0; i < steps; i++) {
    const x = position.x + dx / steps;
    const z = position.z + dz / steps;
    if (spec.aquatic || spec.flying) {
      const y = position.y + dy / steps;
      if (!canOccupy(world, x, y, z, spec, !!spec.aquatic)) break;
      if (!clearSweep(world, position, { x, y, z }, spec)) break;
      position.set(x, y, z);
    } else {
      const y = groundAt(world, x, z, spec, { nearY: entity.groundY });
      if (y === null) break;
      const feet = Math.max(y, position.y);
      if (
        !canOccupy(world, x, feet, z, spec) ||
        (y > position.y &&
          !canOccupy(world, position.x, y, position.z, spec)) ||
        !clearSweep(world, position, { x, y: feet, z }, spec)
      )
        break;
      position.set(x, feet, z);
      entity.groundY = y;
    }
    moved = true;
  }
  return moved;
}

export function applyGravity(world, entity, dt) {
  if (entity.spec.flying || entity.spec.aquatic) return true;
  if (!Number.isFinite(dt) || dt <= 0) return false;
  const { position, spec } = entity;
  const bounds = geometryWorldSpec(world);
  const ground = groundAt(world, position.x, position.z, spec, {
    nearY: position.y,
    stepHeight: 0,
    maxDrop: bounds.maxY - bounds.minY,
  });
  if (ground === null) return false;
  entity.groundY = ground;
  entity.velocityY -= (spec.light ? 5 : 18) * dt;
  const nextY = Math.max(ground, position.y + entity.velocityY * dt);
  const movement = sweepBoxAxis(
    world,
    bodyBox(position, spec.radius, spec.height),
    "y",
    nextY - position.y
  );
  if (
    canOccupy(world, position.x, position.y + movement.amount, position.z, spec)
  )
    position.y += movement.amount;
  else entity.velocityY = Math.min(0, entity.velocityY);
  if (position.y <= ground + 0.001) {
    position.y = ground;
    entity.velocityY = 0;
  }
  return true;
}

export function hasLineOfSight(world, from, to) {
  if (!finitePosition(from) || !finitePosition(to)) return false;
  const dx = to.x - from.x,
    dy = to.y - from.y,
    dz = to.z - from.z;
  const distance = Math.hypot(dx, dy, dz);
  if (distance > 80) return false;
  if (!distance)
    return columnLoaded(world, Math.floor(from.x), Math.floor(from.z));
  return (
    sweepCameraDistance(
      world,
      from,
      { x: dx / distance, y: dy / distance, z: dz / distance },
      distance,
      0
    ) >=
    distance - 1e-6
  );
}

export function exposedToSun(world, entity) {
  const { x, y, z } = entity.position;
  if (!columnLoaded(world, Math.floor(x), Math.floor(z))) return false;
  const top = y + entity.spec.height;
  const { maxY } = geometryWorldSpec(world);
  if (top >= maxY) return true;
  if (
    raycast(world, { x, y: top, z }, { x: 0, y: 1, z: 0 }, maxY - top, {
      channel: "occlusion",
    })
  )
    return false;
  let water = false;
  visitWorldBoxes(
    world,
    box(x, top, z, x, maxY, z),
    "fluidVolume",
    (contact) => {
      if (isWaterFluid(contact.shape.fluid)) water = true;
    },
    { unloaded: "empty", borders: false }
  );
  return !water;
}

export function rayBoxDistance(
  origin,
  direction,
  position,
  radius,
  height,
  maxDistance
) {
  let near = 0,
    far = maxDistance;
  for (const axis of ["x", "y", "z"]) {
    const min = position[axis] - (axis === "y" ? 0 : radius);
    const max = position[axis] + (axis === "y" ? height : radius);
    if (Math.abs(direction[axis]) < 1e-9) {
      if (origin[axis] < min || origin[axis] > max) return null;
    } else {
      const a = (min - origin[axis]) / direction[axis];
      const b = (max - origin[axis]) / direction[axis];
      near = Math.max(near, Math.min(a, b));
      far = Math.min(far, Math.max(a, b));
      if (near > far) return null;
    }
  }
  return near;
}
