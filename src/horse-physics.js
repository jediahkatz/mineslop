import { visitWorldBoxes } from "./collision.js";
import {
  HORSE_GRAVITY, HORSE_HEIGHT, HORSE_MAX_FALL_DISTANCE, HORSE_MAX_SPEED,
  HORSE_MAX_VERTICAL_SPEED, HORSE_RADIUS, HORSE_RIDER_HEIGHT,
  HORSE_RIDER_RADIUS, HORSE_RIDE_SPEED, HORSE_SEAT_HEIGHT,
  HORSE_SHALLOW_SPEED_FACTOR, HORSE_STEP_HEIGHT, HORSE_STEP_SECONDS,
  horseHeading, horsePoint,
} from "./horse-definitions.js";
import {
  horseBounds, horseClear, horseEnvironment, horsePositionValid,
  horseSupport, sweepHorseAxis,
} from "./horse-collision.js";
import { aquaticSweepBounds, loadedAquaticArea } from "./vehicle-water.js";

export {
  findHorseDismount, horseBounds, horseClear, horseEnvironment,
  horseExitValid, horseRiderPathClear,
} from "./horse-collision.js";

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const EPSILON = 1e-6;
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const control = (value) => Number.isFinite(value) ? clamp(value, -1, 1) : 0;

function horizontal(world, initial, dx, dz, mounted) {
  const position = horsePoint(initial), blocked = { x: false, z: false };
  for (const [axis, amount] of [["x", dx], ["z", dz]]) {
    const result = sweepHorseAxis(world, position, axis, amount, mounted);
    position[axis] += result.amount;
    blocked[axis] = result.blocked;
  }
  return { position, blocked, stepped: 0 };
}

/** This species-local step solver does not alter Player's 0.6 step cap. */
function stepUp(world, initial, normal, dx, dz, mounted) {
  const query = aquaticSweepBounds(initial, {
    x: initial.x + dx, y: initial.y + HORSE_STEP_HEIGHT, z: initial.z + dz,
  }, HORSE_RADIUS, mounted ? HORSE_SEAT_HEIGHT + HORSE_RIDER_HEIGHT : HORSE_HEIGHT);
  if (!loadedAquaticArea(world, query)) return normal;
  const candidates = new Set();
  visitWorldBoxes(world, query, "collision", ({ box, frontier }) => {
    const rise = box[4] - initial.y;
    if (!frontier && rise > EPSILON && rise <= HORSE_STEP_HEIGHT + EPSILON)
      candidates.add(rise);
  });
  let best = normal;
  for (const rise of [...candidates].sort((a, b) => a - b).slice(0, 16)) {
    if (sweepHorseAxis(world, initial, "y", rise, mounted).blocked) continue;
    const lifted = { ...initial, y: initial.y + rise };
    const candidate = horizontal(world, lifted, dx, dz, mounted);
    if (distance(initial, candidate.position) <= distance(initial, best.position) + EPSILON)
      continue;
    const down = sweepHorseAxis(world, candidate.position, "y", -rise - 0.055, mounted);
    candidate.position.y += down.amount;
    if (!down.blocked || !horseSupport(world, candidate.position) ||
      !horseClear(world, candidate.position, mounted)) continue;
    candidate.stepped = candidate.position.y - initial.y;
    best = candidate;
  }
  return best;
}

function moveHorse(world, initial, displacement, mounted, mayStep) {
  let position = horsePoint(initial), grounded = false, stepped = 0;
  const blocked = { x: false, y: false, z: false };
  const count = Math.max(1, Math.ceil(Math.max(
    Math.abs(displacement.x), Math.abs(displacement.y), Math.abs(displacement.z),
  ) / 0.2));
  // Capped speed and dt make this <= 8, even at terminal vertical speed.
  if (count > 8) return null;
  for (let index = 0; index < count; index++) {
    const supported = displacement.y <= 0 && !!horseSupport(world, position);
    const vertical = sweepHorseAxis(world, position, "y", displacement.y / count, mounted);
    position.y += vertical.amount;
    blocked.y ||= vertical.blocked;
    grounded = vertical.blocked && displacement.y <= 0;
    let result = horizontal(world, position, displacement.x / count, displacement.z / count, mounted);
    if (mayStep && (supported || grounded) && (result.blocked.x || result.blocked.z))
      result = stepUp(world, position, result, displacement.x / count, displacement.z / count, mounted);
    position = result.position;
    blocked.x ||= result.blocked.x;
    blocked.z ||= result.blocked.z;
    stepped += result.stepped;
    grounded = (grounded || supported || result.stepped > 0) && !!horseSupport(world, position);
    if (!horsePositionValid(world, position, mounted)) return null;
  }
  return { position, blocked, grounded, stepped };
}

/**
 * Pure bounded proposal; Wildlife alone publishes position/yaw/health.
 * motion is the sidecar's velocity/ground/fall state, never a second pose.
 * No chunk requests, terrain edits, global step changes or grounded AI solver.
 */
export function stepHorse(world, base, motion, dt, controls = {}, {
  mounted = true, controlled = true, jumpVelocity = 0, sampleFluid,
} = {}) {
  const position = horsePoint(base.position), yaw = base.yaw ?? base.root?.rotation.y ?? 0;
  const frozen = (reason, environment = null) => ({
    position, yaw, motion: { ...motion }, moved: false, frontier: reason === "frontier",
    blocked: reason, stepped: 0, fallDamage: 0, strideDistance: 0,
    water: environment?.water ?? null, supportBlock: environment?.supportBlock ?? null,
    requestExit: reason === "deep-water" || reason === "hazard",
  });
  if (!Number.isFinite(dt) || dt <= 0) return frozen("idle");
  if (!horseClear(world, position, mounted))
    return frozen(loadedAquaticArea(world, horseBounds(position, mounted)) ? "obstructed" : "frontier");
  const environment = horseEnvironment(world, position, sampleFluid);
  if (!environment) return frozen("frontier");
  if (environment.hazardous) return frozen("hazard", environment);
  if (environment.water === "deep") return frozen("deep-water", environment);
  dt = Math.min(dt, HORSE_STEP_SECONDS);
  const next = { ...motion };
  let nextYaw = yaw;
  let forward = controlled ? control(controls.forward) : 0;
  let strafe = controlled ? control(controls.strafe) : 0;
  const strength = Math.max(1, Math.hypot(forward, strafe));
  forward /= strength;
  strafe /= strength;
  if (controlled && Number.isFinite(controls.yaw) && (forward || strafe)) {
    const turn = horseHeading(controls.yaw + Math.PI - yaw);
    nextYaw = horseHeading(yaw + clamp(turn, -3.5 * dt, 3.5 * dt));
  }
  const speed = HORSE_RIDE_SPEED * (environment.water === "shallow" ? HORSE_SHALLOW_SPEED_FACTOR : 1);
  const desired = {
    x: Math.sin(nextYaw) * forward * speed - Math.cos(nextYaw) * strafe * speed * 0.55,
    z: Math.cos(nextYaw) * forward * speed + Math.sin(nextYaw) * strafe * speed * 0.55,
  };
  if (forward < 0) {
    desired.x *= 0.4;
    desired.z *= 0.4;
  }
  const acceleration = 1 - Math.exp(-8 * dt);
  next.vx = clamp(next.vx + (desired.x - next.vx) * acceleration, -HORSE_MAX_SPEED, HORSE_MAX_SPEED);
  next.vz = clamp(next.vz + (desired.z - next.vz) * acceleration, -HORSE_MAX_SPEED, HORSE_MAX_SPEED);
  const jumping = controlled && motion.grounded && environment.grounded &&
    Number.isFinite(jumpVelocity) && jumpVelocity > 0;
  if (jumping) {
    next.vy = Math.min(9, jumpVelocity);
    next.grounded = false;
  }
  next.vy = Math.max(-HORSE_MAX_VERTICAL_SPEED, next.vy - HORSE_GRAVITY * dt);
  const displacement = { x: next.vx * dt, y: next.vy * dt, z: next.vz * dt };
  const destination = {
    x: position.x + displacement.x, y: position.y + displacement.y, z: position.z + displacement.z,
  };
  const envelope = aquaticSweepBounds(position, destination, HORSE_RADIUS,
    mounted ? Math.max(HORSE_HEIGHT, HORSE_SEAT_HEIGHT + HORSE_RIDER_HEIGHT) : HORSE_HEIGHT);
  // Include any potential step ascent AND connected-shape neighbors.
  if (motion.grounded && !jumping) envelope[4] += HORSE_STEP_HEIGHT;
  if (!loadedAquaticArea(world, envelope)) return frozen("frontier");
  const moved = moveHorse(world, position, displacement, mounted, !jumping && next.vy <= 0);
  if (!moved) return frozen("bounds");
  const after = horseEnvironment(world, moved.position, sampleFluid);
  if (!after) return frozen("frontier");
  // Do not step into lava/fire. Deep water is entered only as far as this
  // bounded substep, then held until an actual safe dismount can commit.
  if (after.hazardous) return frozen("hazard", after);
  if (moved.blocked.x) next.vx = 0;
  if (moved.blocked.z) next.vz = 0;
  if (moved.blocked.y) next.vy = 0;
  next.grounded = moved.grounded;
  const fallen = Math.max(0, position.y - moved.position.y);
  next.fallDistance = Math.min(HORSE_MAX_FALL_DISTANCE, next.fallDistance + fallen);
  const fallDamage = moved.grounded && !motion.grounded
    ? Math.max(0, Math.ceil(next.fallDistance - 3 - EPSILON)) : 0;
  if (moved.grounded) {
    next.vy = 0;
    next.fallDistance = 0;
  }
  return {
    position: moved.position, yaw: nextYaw, motion: next,
    moved: Math.abs(moved.position.y - position.y) > EPSILON ||
      distance(position, moved.position) > EPSILON || nextYaw !== yaw,
    frontier: false, blocked: moved.blocked, stepped: moved.stepped, fallDamage,
    strideDistance: motion.grounded && next.grounded && after.water !== "deep"
      ? distance(position, moved.position) : 0,
    supportBlock: after.supportBlock, water: after.water,
    requestExit: after.water === "deep",
  };
}

// Export rider dimensions for parent staging/placement checks, without Player imports.
export const HORSE_RIDER_COLLIDER = Object.freeze({
  radius: HORSE_RIDER_RADIUS, height: HORSE_RIDER_HEIGHT,
});
