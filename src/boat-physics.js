import { overlaps } from "./aabb.js";
import { BLOCK } from "./blocks.js";
import {
  BOAT_BUBBLE_SECONDS,
  BOAT_DRAFT,
  BOAT_HEIGHT,
  BOAT_MAX_SPEED,
  BOAT_MAX_VERTICAL_SPEED,
  BOAT_RADIUS,
  BOAT_SEAT_HEIGHT,
  BOAT_SUBMERGE_SECONDS,
  boatHeading,
  boatSeat,
} from "./boat-definitions.js";
import {
  bodyBox,
  boxCollides,
  moveBody,
  supportContacts,
  sweepBoxAxis,
  sweepCameraDistance,
  visitWorldBoxes,
} from "./collision.js";
import { geometryWorldSpec } from "./geometry-world.js";
import {
  aquaticSample,
  aquaticSweepBounds,
  finitePoint,
  loadedAquaticArea,
} from "./vehicle-water.js";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const TAU = Math.PI * 2;
const PLAYER_RADIUS = 0.3,
  PLAYER_HEIGHT = 1.8;
const hazardIds = new Set([
  BLOCK.CACTUS,
  BLOCK.MAGMA_BLOCK,
  BLOCK.LAVA,
  BLOCK.NETHER_PORTAL,
  BLOCK.END_PORTAL,
]);
const offsets = [
  [0, 0],
  [-0.43, -0.43],
  [-0.43, 0.43],
  [0.43, -0.43],
  [0.43, 0.43],
];

export const boatBox = (boat, withPassengers = false) =>
  bodyBox(
    boat,
    BOAT_RADIUS,
    withPassengers ? BOAT_SEAT_HEIGHT + PLAYER_HEIGHT : BOAT_HEIGHT
  );

/** Five hull columns, three vertical probes each; never a water-column scan. */
export function boatWaterState(world, boat, sampleFluid) {
  if (!loadedAquaticArea(world, boatBox(boat))) return null;
  let wet = 0,
    submerged = 0,
    bubble = 0,
    surfaceY = null;
  const current = { x: 0, y: 0, z: 0 };
  for (let index = 0; index < offsets.length; index++) {
    const [dx, dz] = offsets[index];
    let top = null,
      water = false,
      sampledCurrent = false;
    for (const height of [-0.025, BOAT_DRAFT, BOAT_HEIGHT + 0.025]) {
      const sample = aquaticSample(
        world,
        { x: boat.x + dx, y: boat.y + height, z: boat.z + dz },
        sampleFluid
      );
      if (!sample) return null;
      if (!sample.water) continue;
      water = true;
      if (sample.surfaceY !== null)
        top = Math.max(top ?? -Infinity, sample.surfaceY);
      if (height > BOAT_HEIGHT) submerged++;
      if (sample.bubble < 0) bubble = -1;
      else if (sample.bubble > 0 && bubble === 0) bubble = 1;
      if (!sampledCurrent) {
        sampledCurrent = true;
        current.x += sample.current.x / offsets.length;
        current.y += sample.current.y / offsets.length;
        current.z += sample.current.z / offsets.length;
      }
    }
    if (water) wet++;
    // The center owns buoyancy. A neighboring elevated water cell cannot lift
    // the hull before it crosses that cell's blocked ascending-water edge.
    if (index === 0) surfaceY = top;
  }
  return {
    wet: wet / offsets.length,
    submerged: submerged >= 3,
    surfaceY,
    bubble,
    current,
  };
}

export function boatPlacementPosition(world, point, sampleFluid) {
  if (!finitePoint(point)) return null;
  const sample = aquaticSample(world, point, sampleFluid);
  if (!sample?.water || sample.surfaceY === null) return null;
  const position = { x: point.x, y: sample.surfaceY - BOAT_DRAFT, z: point.z };
  if (
    !loadedAquaticArea(world, boatBox(position)) ||
    boxCollides(world, boatBox(position)) ||
    boatWaterState(world, position, sampleFluid)?.submerged !== false
  )
    return null;
  return position;
}

/** At most 61 ray steps, clipped by actual solid geometry before placement. */
export function boatWaterTarget(
  world,
  origin,
  direction,
  maxDistance = 6,
  sampleFluid
) {
  if (
    !finitePoint(origin) ||
    !finitePoint(direction) ||
    !Number.isFinite(maxDistance) ||
    maxDistance <= 0
  )
    return null;
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!length) return null;
  const unit = {
    x: direction.x / length,
    y: direction.y / length,
    z: direction.z / length,
  };
  const distance = sweepCameraDistance(
    world,
    origin,
    unit,
    Math.min(6, maxDistance),
    0
  );
  for (let index = 0; index <= 60 && index * 0.1 <= distance; index++) {
    const point = {
      x: origin.x + unit.x * index * 0.1,
      y: origin.y + unit.y * index * 0.1,
      z: origin.z + unit.z * index * 0.1,
    };
    const sample = aquaticSample(world, point, sampleFluid);
    if (!sample) return null;
    if (sample.water && boatPlacementPosition(world, point, sampleFluid))
      return { point, fluid: sample.fluid, distance: index * 0.1 };
  }
  return null;
}

/**
 * Mutates only the supplied detached boat. No step-up, lift-out, snapping to a
 * water surface, chunk generation, or player/camera yaw mutation. Unknown
 * frontiers freeze the entire step, including submersion/bubble clocks.
 */
export function stepBoat(
  world,
  boat,
  dt,
  input = {},
  { sampleFluid, otherBoats = [] } = {}
) {
  if (!finitePoint(boat) || !Number.isFinite(dt) || dt <= 0)
    return { moved: false, reason: "invalid-step" };
  const step = Math.min(dt, 0.05);
  const next = { ...boat };
  const water = boatWaterState(world, boat, sampleFluid);
  if (!water) return { moved: false, reason: "frontier" };
  const forward = clamp(
    Number.isFinite(input.forward) ? input.forward : 0,
    -1,
    1
  );
  const turn = clamp(Number.isFinite(input.turn) ? input.turn : 0, -1, 1);
  const occupied = boat.passengers?.some((id) => id !== null) === true;
  if (boxCollides(world, boatBox(boat, occupied)))
    return { moved: false, reason: "obstructed" };
  const drive = water.submerged ? 0.15 : water.wet ? 1 : 0.08;
  next.turnVelocity = clamp(
    (boat.turnVelocity + turn * 5 * drive * step) * Math.exp(-3 * step),
    -4,
    4
  );
  next.yaw = boatHeading(boat.yaw + next.turnVelocity * step);
  const thrust = (forward >= 0 ? 7.5 : 3.5) * forward * drive;
  next.vx -= Math.sin(next.yaw) * thrust * step;
  next.vz -= Math.cos(next.yaw) * thrust * step;
  const drag = Math.exp(-(water.wet ? 0.95 : 5) * step);
  next.vx = clamp(
    (next.vx + water.current.x * 1.5 * step) * drag,
    -BOAT_MAX_SPEED,
    BOAT_MAX_SPEED
  );
  next.vz = clamp(
    (next.vz + water.current.z * 1.5 * step) * drag,
    -BOAT_MAX_SPEED,
    BOAT_MAX_SPEED
  );
  const speed = Math.hypot(next.vx, next.vz);
  if (speed > BOAT_MAX_SPEED) {
    next.vx *= BOAT_MAX_SPEED / speed;
    next.vz *= BOAT_MAX_SPEED / speed;
  }
  let acceleration = -9.8;
  if (water.submerged) acceleration = -3 - boat.vy * 2;
  else if (water.surfaceY !== null)
    acceleration = 24 * (water.surfaceY - boat.y - BOAT_DRAFT) - boat.vy * 9;
  acceleration += water.current.y * 2;
  next.submergedTime = water.submerged
    ? Math.min(BOAT_SUBMERGE_SECONDS, boat.submergedTime + step)
    : 0;
  next.bubbleTime = water.bubble
    ? Math.min(
        BOAT_BUBBLE_SECONDS,
        (boat.bubbleDirection === water.bubble ? boat.bubbleTime : 0) + step
      )
    : 0;
  next.bubbleDirection = water.bubble;
  // Up columns rock the hull until the three-second launch; an immediate
  // large lift would lose contact and reset the timer before it ever fires.
  if (water.bubble) acceleration += water.bubble > 0 ? 0.8 : -8;
  next.vy = clamp(
    boat.vy + acceleration * step,
    -BOAT_MAX_VERTICAL_SPEED,
    BOAT_MAX_VERTICAL_SPEED
  );
  const bubbleImpulse = next.bubbleTime >= BOAT_BUBBLE_SECONDS;
  if (bubbleImpulse) {
    next.vy = water.bubble > 0 ? 6.5 : -4;
    next.bubbleTime = 0;
  }
  const destination = {
    x: boat.x + next.vx * step,
    y: boat.y + next.vy * step,
    z: boat.z + next.vz * step,
  };
  if (
    !loadedAquaticArea(
      world,
      aquaticSweepBounds(
        boat,
        destination,
        BOAT_RADIUS,
        BOAT_SEAT_HEIGHT + PLAYER_HEIGHT
      )
    )
  )
    return { moved: false, reason: "frontier" };

  // Horizontal motion is evaluated at the old waterline before vertical
  // buoyancy, so an elevated fluid step cannot lift the hull into itself.
  for (const [axis, velocity] of [
    ["x", "vx"],
    ["z", "vz"],
  ]) {
    const trial = { ...next, [axis]: next[axis] + next[velocity] * step };
    const ahead = boatWaterState(world, trial, sampleFluid);
    if (!ahead) return { moved: false, reason: "frontier" };
    if (
      water.surfaceY !== null &&
      !water.submerged &&
      ahead.surfaceY !== null &&
      ahead.surfaceY > water.surfaceY + 0.025
    ) {
      next[velocity] = 0;
      continue;
    }
    const moved = sweepBoxAxis(
      world,
      boatBox(next, occupied),
      axis,
      next[velocity] * step
    );
    next[axis] += moved.amount;
    if (moved.blocked) next[velocity] = 0;
  }
  if (
    otherBoats.some(
      (other) =>
        other.id !== boat.id &&
        other.dimension === boat.dimension &&
        overlaps(boatBox(next), boatBox(other))
    )
  ) {
    next.x = boat.x;
    next.z = boat.z;
    next.vx = next.vz = 0;
  }
  const vertical = sweepBoxAxis(
    world,
    boatBox(next, occupied),
    "y",
    next.vy * step
  );
  next.y += vertical.amount;
  if (vertical.blocked) next.vy = 0;
  if (
    !Number.isSafeInteger(Math.ceil(next.y + PLAYER_HEIGHT + BOAT_SEAT_HEIGHT))
  )
    return { moved: false, reason: "coordinate-limit" };
  if (next.y <= geometryWorldSpec(world).voidY)
    return { moved: false, reason: "void", lost: true };
  next.paddlePhase =
    (boat.paddlePhase + (Math.abs(forward) + Math.abs(turn)) * step * 5) % TAU;
  Object.assign(boat, next);
  return {
    moved: true,
    water,
    eject:
      next.submergedTime >= BOAT_SUBMERGE_SECONDS ||
      (bubbleImpulse && water.bubble < 0),
    bubbleImpulse: bubbleImpulse ? water.bubble : 0,
  };
}

function hazardous(world, bounds) {
  let danger = false;
  for (const channel of ["selection", "fluidVolume"])
    visitWorldBoxes(
      world,
      bounds,
      channel,
      ({ box, cell }) => {
        if (hazardIds.has(cell?.id) && overlaps(bounds, box)) danger = true;
      },
      { unloaded: "empty", borders: false }
    );
  return danger;
}

/** Seat transfers sweep the full standing body, not just an eye/target ray. */
export function boatRiderPathClear(world, start, candidate) {
  if (
    !finitePoint(start) ||
    !finitePoint(candidate) ||
    !loadedAquaticArea(
      world,
      aquaticSweepBounds(start, candidate, PLAYER_RADIUS, PLAYER_HEIGHT)
    ) ||
    boxCollides(world, bodyBox(start, PLAYER_RADIUS, PLAYER_HEIGHT)) ||
    boxCollides(world, bodyBox(candidate, PLAYER_RADIUS, PLAYER_HEIGHT))
  )
    return false;
  // Clear a real bank's lip before moving sideways, then descend into water
  // or onto lower support. Sweep all three legs: no teleport through a roof.
  const lifted = { ...start, y: Math.max(start.y, candidate.y) };
  if (
    sweepBoxAxis(
      world,
      bodyBox(start, PLAYER_RADIUS, PLAYER_HEIGHT),
      "y",
      lifted.y - start.y
    ).blocked
  )
    return false;
  const moved = moveBody(
    world,
    lifted,
    {
      x: candidate.x - start.x,
      y: 0,
      z: candidate.z - start.z,
    },
    { radius: PLAYER_RADIUS, height: PLAYER_HEIGHT, stepHeight: 0 }
  );
  const down = sweepBoxAxis(
    world,
    bodyBox(moved.position, PLAYER_RADIUS, PLAYER_HEIGHT),
    "y",
    candidate.y - lifted.y
  );
  moved.position.y += down.amount;
  return (
    Math.hypot(
      moved.position.x - candidate.x,
      moved.position.y - candidate.y,
      moved.position.z - candidate.z
    ) < 0.001
  );
}

function reachableExit(world, boat, candidate, slot, otherBoats) {
  const bounds = bodyBox(candidate, PLAYER_RADIUS, PLAYER_HEIGHT);
  if (
    hazardous(world, bounds) ||
    otherBoats.some(
      (other) =>
        other.dimension === boat.dimension && overlaps(bounds, boatBox(other))
    )
  )
    return false;
  return boatRiderPathClear(world, boatSeat(boat, slot), candidate);
}

/**
 * Bounded adjacent land exits first, then real water. Never fabricates support
 * or sets grounded on open ocean. A blocked exit returns null and preserves the
 * mount; callers must not teleport above a roof or create a temporary platform.
 */
export function findBoatDismount(
  world,
  boat,
  { slot = 0, sampleFluid, allowSubmerged = false, otherBoats = [] } = {}
) {
  const right = { x: Math.cos(boat.yaw), z: -Math.sin(boat.yaw) };
  const front = { x: -Math.sin(boat.yaw), z: -Math.cos(boat.yaw) };
  const distance = BOAT_RADIUS + PLAYER_RADIUS + 0.15;
  const points = [
    [1, 0],
    [-1, 0],
    [0, -1],
    [0, 1],
    [1, -1],
    [-1, -1],
    [1, 1],
    [-1, 1],
  ].map(([r, f]) => ({
    x: boat.x + (right.x * r + front.x * f) * distance,
    y: boat.y + BOAT_SEAT_HEIGHT,
    z: boat.z + (right.z * r + front.z * f) * distance,
  }));
  for (const point of points) {
    if (!loadedAquaticArea(world, bodyBox(point, PLAYER_RADIUS, PLAYER_HEIGHT)))
      continue;
    const contacts = supportContacts(world, point, {
      radius: PLAYER_RADIUS,
      maxDrop: 1.25,
      maxRise: 0.6,
      filter: ({ cell, box }) =>
        !hazardIds.has(cell?.id) &&
        point.x > box[0] &&
        point.x < box[3] &&
        point.z > box[2] &&
        point.z < box[5],
    }).sort(
      (a, b) => Math.abs(a.height - point.y) - Math.abs(b.height - point.y)
    );
    for (const contact of contacts) {
      const position = { ...point, y: contact.height + 0.001 };
      const foot = aquaticSample(
        world,
        { ...position, y: position.y + 0.05 },
        sampleFluid
      );
      if (
        !foot ||
        foot.water ||
        !reachableExit(world, boat, position, slot, otherBoats)
      )
        continue;
      return {
        position,
        swimming: false,
        grounded: true,
        velocity: { x: 0, y: 0, z: 0 },
      };
    }
  }
  for (const point of points) {
    const water = aquaticSample(
      world,
      { ...point, y: boat.y + 0.02 },
      sampleFluid
    );
    if (
      !water?.water ||
      water.surfaceY === null ||
      (!allowSubmerged && water.bubble < 0)
    )
      continue;
    const position = { ...point, y: Math.min(point.y, water.surfaceY - 0.35) };
    const head = aquaticSample(
      world,
      { ...position, y: position.y + 1.62 },
      sampleFluid
    );
    if (
      !head ||
      (!allowSubmerged && head.water) ||
      !reachableExit(world, boat, position, slot, otherBoats)
    )
      continue;
    return {
      position,
      swimming: true,
      grounded: false,
      velocity: {
        x: boat.vx * 0.25,
        y: Math.min(0, boat.vy),
        z: boat.vz * 0.25,
      },
    };
  }
  return null;
}
