import { overlaps } from "./aabb.js";
import { BLOCK } from "./blocks.js";
import { FLUID } from "./block-state.js";
import { bodyBox, boxCollides, supportContacts, sweepBoxAxis } from "./collision.js";
import { geometryWorldSpec, readGeometryCell } from "./geometry-world.js";
import {
  HORSE_HEIGHT, HORSE_MAX_SPEED, HORSE_MAX_VERTICAL_SPEED, HORSE_RADIUS,
  HORSE_RIDER_HEIGHT, HORSE_RIDER_RADIUS, HORSE_SEAT_HEIGHT, HORSE_WADE_DEPTH,
  horsePoint, horseSeat,
} from "./horse-definitions.js";
import { WORLD_MAX, WORLD_MIN } from "./terrain.js";
import { aquaticSample, aquaticSweepBounds, finitePoint, loadedAquaticArea } from "./vehicle-water.js";

const EPSILON = 1e-6;
const hazards = new Set([
  BLOCK.LAVA, BLOCK.FIRE, BLOCK.SOUL_FIRE, BLOCK.CACTUS,
  BLOCK.MAGMA_BLOCK, BLOCK.CAMPFIRE, BLOCK.SOUL_CAMPFIRE,
].filter(Number.isInteger));
const safeContact = (contact) =>
  !contact.frontier && !hazards.has(contact.cell?.id) && contact.cell?.fluid !== FLUID.LAVA;

export function horseBoxes(position, mounted = true) {
  const boxes = [bodyBox(position, HORSE_RADIUS, HORSE_HEIGHT)];
  if (mounted) boxes.push(bodyBox(horseSeat(position), HORSE_RIDER_RADIUS, HORSE_RIDER_HEIGHT));
  return boxes;
}

export function horseBounds(position, mounted = true) {
  return bodyBox(position, HORSE_RADIUS,
    mounted ? Math.max(HORSE_HEIGHT, HORSE_SEAT_HEIGHT + HORSE_RIDER_HEIGHT) : HORSE_HEIGHT);
}

export function horsePositionValid(world, position, mounted = true) {
  if (!finitePoint(position)) return false;
  const bounds = horseBounds(position, mounted), spec = geometryWorldSpec(world);
  return bounds.every(Number.isFinite) && bounds[0] >= WORLD_MIN && bounds[3] <= WORLD_MAX &&
    bounds[2] >= WORLD_MIN && bounds[5] <= WORLD_MAX &&
    bounds[1] >= spec.minY && bounds[4] <= spec.maxY;
}

export function horseClear(world, position, mounted = true) {
  return horsePositionValid(world, position, mounted) &&
    loadedAquaticArea(world, horseBounds(position, mounted)) &&
    horseBoxes(position, mounted).every((bounds) => !boxCollides(world, bounds));
}

export function sweepHorseAxis(world, position, axis, amount, mounted = true) {
  let allowed = amount;
  for (const bounds of horseBoxes(position, mounted)) {
    const result = sweepBoxAxis(world, bounds, axis, amount);
    allowed = amount >= 0 ? Math.min(allowed, result.amount) : Math.max(allowed, result.amount);
  }
  return { amount: allowed, blocked: Math.abs(allowed - amount) > EPSILON };
}

export function horseSupport(world, position, radius = HORSE_RADIUS, options = {}) {
  const contacts = supportContacts(world, position, {
    radius, maxDrop: 0.055, maxRise: 0, ...options, filter: safeContact,
  });
  return contacts.sort((a, b) => b.height - a.height)[0] ?? null;
}

/**
 * Shallow: water around feet but not one block above them. Deep: water at that
 * upper sample. Deep water freezes horse motion and requests a safe exit; this
 * slice does not pretend to implement swimming. Unknown cells freeze as well.
 */
export function horseEnvironment(world, position, sampleFluid) {
  if (!loadedAquaticArea(world, horseBounds(position))) return null;
  let wet = false, deep = false, hazardous = false;
  const radius = HORSE_RADIUS * 0.7;
  for (const [dx, dz] of [[0, 0], [radius, 0], [-radius, 0], [0, radius], [0, -radius]]) {
    for (const [height, upper] of [[0.12, false], [HORSE_WADE_DEPTH, true]]) {
      const sample = aquaticSample(world, {
        x: position.x + dx, y: position.y + height, z: position.z + dz,
      }, sampleFluid);
      if (!sample) return null;
      hazardous ||= sample.fluid === FLUID.LAVA;
      const cell = readGeometryCell(world, Math.floor(position.x + dx),
        Math.floor(position.y + height), Math.floor(position.z + dz));
      hazardous ||= hazards.has(cell?.id);
      wet ||= sample.water;
      deep ||= upper && sample.water;
    }
  }
  const support = horseSupport(world, position);
  hazardous ||= supportContacts(world, position, { radius: HORSE_RADIUS,
    maxDrop: 0.055, maxRise: 0 }).some((contact) => !safeContact(contact));
  return { water: deep ? "deep" : wet ? "shallow" : "dry", hazardous,
    grounded: support !== null, supportBlock: support?.cell.id ?? null };
}

const sameAmount = (actual, expected) => Math.abs(actual - expected) < EPSILON;

function riderHazardFree(world, position, sampleFluid) {
  const edge = HORSE_RIDER_RADIUS * 0.99;
  for (const [dx, dz] of [[0, 0], [-edge, -edge], [-edge, edge], [edge, -edge], [edge, edge]])
    for (const dy of [0.1, 0.9, 1.7]) {
      const point = { x: position.x + dx, y: position.y + dy, z: position.z + dz };
      const sample = aquaticSample(world, point, sampleFluid);
      const cell = readGeometryCell(world, Math.floor(point.x), Math.floor(point.y), Math.floor(point.z));
      if (!sample || sample.fluid === FLUID.LAVA || hazards.has(cell?.id)) return false;
    }
  return true;
}

/** A concrete rise -> horizontal -> descent path, not an endpoint teleport. */
export function horseRiderPathClear(world, from, to, { sampleFluid, checkHazards = false } = {}) {
  if (!finitePoint(from) || !finitePoint(to) ||
    Math.hypot(to.x - from.x, to.z - from.z) > 6 ||
    Math.abs(to.y - from.y) > 4) return false;
  const spec = geometryWorldSpec(world);
  if (Math.min(from.y, to.y) < spec.minY ||
    Math.max(from.y, to.y) + HORSE_RIDER_HEIGHT > spec.maxY ||
    !loadedAquaticArea(world, aquaticSweepBounds(from, to, HORSE_RIDER_RADIUS, HORSE_RIDER_HEIGHT)) ||
    boxCollides(world, bodyBox(from, HORSE_RIDER_RADIUS, HORSE_RIDER_HEIGHT))) return false;
  const position = horsePoint(from), high = Math.max(from.y, to.y);
  if (checkHazards && !riderHazardFree(world, position, sampleFluid)) return false;
  for (const [axis, destination] of [["y", high], ["x", to.x], ["z", to.z], ["y", to.y]]) {
    const amount = destination - position[axis];
    const swept = sweepBoxAxis(world, bodyBox(position, HORSE_RIDER_RADIUS, HORSE_RIDER_HEIGHT), axis, amount);
    if (!sameAmount(swept.amount, amount)) return false;
    if (checkHazards) {
      const count = Math.ceil(Math.abs(amount) / 0.2);
      for (let index = 1; index <= count; index++)
        if (!riderHazardFree(world, { ...position, [axis]: position[axis] + amount * index / count }, sampleFluid))
          return false;
    }
    position[axis] = destination;
  }
  return !boxCollides(world, bodyBox(position, HORSE_RIDER_RADIUS, HORSE_RIDER_HEIGHT));
}

export function horseExitValid(world, base, exit, { sampleFluid, otherHorses = [] } = {}) {
  if (!exit || !finitePoint(exit.position) ||
    !loadedAquaticArea(world, bodyBox(exit.position, HORSE_RIDER_RADIUS, HORSE_RIDER_HEIGHT)) ||
    !horseSupport(world, exit.position, HORSE_RIDER_RADIUS) ||
    supportContacts(world, exit.position, { radius: HORSE_RIDER_RADIUS, maxDrop: 0.055, maxRise: 0 })
      .some((contact) => !safeContact(contact))) return false;
  const bounds = bodyBox(exit.position, HORSE_RIDER_RADIUS, HORSE_RIDER_HEIGHT);
  if (overlaps(bounds, bodyBox(base.position, HORSE_RADIUS, HORSE_HEIGHT))) return false;
  for (const other of otherHorses.slice(0, 28)) {
    if (other === base || other.id === base.id || other.dead || other.dormant) continue;
    if (overlaps(bounds, bodyBox(other.position, other.spec?.radius ?? HORSE_RADIUS,
      other.spec?.height ?? HORSE_HEIGHT))) return false;
  }
  // Use exact player clearance, not the wider horse envelope at the exit.
  const edge = HORSE_RIDER_RADIUS * 0.99;
  for (const [dx, dz] of [[0, 0], [-edge, -edge], [-edge, edge], [edge, -edge], [edge, edge]])
    for (const y of [exit.position.y + 0.1, exit.position.y + 1]) {
      const point = { x: exit.position.x + dx, y, z: exit.position.z + dz };
      const sample = aquaticSample(world, point, sampleFluid);
      const cell = readGeometryCell(world, Math.floor(point.x), Math.floor(y), Math.floor(point.z));
      if (!sample || hazards.has(cell?.id) || sample.fluid === FLUID.LAVA ||
        (y > exit.position.y + 0.5 && sample.water))
        return false;
    }
  return horseRiderPathClear(world, horseSeat(base.position), exit.position, { sampleFluid, checkHazards: true });
}

export function findHorseDismount(world, base, options = {}) {
  const yaw = base.yaw ?? base.root?.rotation.y ?? 0;
  // Side exits first, then the diagonals and front/back. A small, fixed search.
  for (const angle of [Math.PI / 2, -Math.PI / 2, Math.PI / 4, -Math.PI / 4,
    Math.PI * 3 / 4, -Math.PI * 3 / 4, 0, Math.PI]) {
    const direction = yaw + angle, radius = 1.8;
    const position = {
      x: base.position.x + Math.sin(direction) * radius,
      y: base.position.y, z: base.position.z + Math.cos(direction) * radius,
    };
    if (!loadedAquaticArea(world, bodyBox(position, HORSE_RIDER_RADIUS, HORSE_RIDER_HEIGHT + 1)))
      continue;
    const contacts = supportContacts(world, position, {
      radius: HORSE_RIDER_RADIUS, maxDrop: 1, maxRise: 1, filter: safeContact,
    }).sort((a, b) => Math.abs(a.height - position.y) - Math.abs(b.height - position.y));
    for (const contact of contacts.slice(0, 12)) {
      const exit = { vehicleType: "horse", id: base.id, dimension: world.dimension,
        position: { ...position, y: contact.height },
        velocity: { x: 0, y: 0, z: 0 }, grounded: true, seated: false };
      if (horseExitValid(world, base, exit, options)) return exit;
    }
  }
  return null;
}

/** Death alone may relinquish the exact, already-clear seat after removing
 * its horse. This is NOT a supported dismount or a search for an airborne
 * destination: no offset, lift, snap-to-ground or collision exemption for
 * terrain/other mobs is allowed. Only the dying horse's own body disappears.
 */
export function horseDeathExitValid(world, base, exit, options = {}) {
  if (!exit || exit.vehicleType !== "horse" || exit.id !== base.id ||
    exit.dimension !== world.dimension || exit.seated !== false) return false;
  if (exit.grounded === true) return horseExitValid(world, base, exit, options);
  if (exit.grounded !== false || !finitePoint(base.position) ||
    !finitePoint(exit.position) || !finitePoint(exit.velocity) ||
    Math.abs(exit.velocity.x) > HORSE_MAX_SPEED ||
    Math.abs(exit.velocity.z) > HORSE_MAX_SPEED ||
    Math.abs(exit.velocity.y) > HORSE_MAX_VERTICAL_SPEED) return false;
  const seat = horseSeat(base.position), bounds = bodyBox(seat, HORSE_RIDER_RADIUS, HORSE_RIDER_HEIGHT);
  if (!["x", "y", "z"].every((axis) => exit.position[axis] === seat[axis]) ||
    bounds[0] < WORLD_MIN || bounds[3] > WORLD_MAX ||
    bounds[2] < WORLD_MIN || bounds[5] > WORLD_MAX ||
    !horseRiderPathClear(world, seat, seat, { sampleFluid: options.sampleFluid, checkHazards: true }))
    return false;
  for (const other of (options.otherHorses ?? []).slice(0, 28)) {
    if (other === base || other.id === base.id || other.dead || other.dormant) continue;
    if (overlaps(bounds, bodyBox(other.position, other.spec?.radius ?? HORSE_RADIUS,
      other.spec?.height ?? HORSE_HEIGHT))) return false;
  }
  return true;
}

export function findHorseDeathExit(world, base, motion, options = {}) {
  const supported = findHorseDismount(world, base, options);
  if (supported) return supported;
  if (!motion || !finitePoint(base.position)) return null;
  const exit = {
    vehicleType: "horse", id: base.id, dimension: world.dimension,
    position: horseSeat(base.position),
    velocity: { x: motion.vx, y: motion.vy, z: motion.vz },
    grounded: false, seated: false,
  };
  return horseDeathExitValid(world, base, exit, options) ? exit : null;
}
