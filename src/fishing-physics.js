import { FLUID } from "./block-state.js";
import {
  bodyBox,
  boxCollides,
  sweepBoxAxis,
  sweepCameraDistance,
} from "./collision.js";
import {
  fishingRandomInt,
  fishingWaitTicks,
  nextFishingRandom,
} from "./fishing-loot.js";
import { inspectFishingOpenWater } from "./fishing-water.js";
import { geometryWorldSpec } from "./geometry-world.js";
import {
  aquaticSample,
  aquaticSweepBounds,
  finitePoint,
  loadedAquaticArea,
} from "./vehicle-water.js";

export const FISHING_TICK = 0.05;
export const MAX_FISHING_STEPS = 4;
export const MAX_FISHING_CASTS = 8;
export const MAX_FISHING_RANGE = 32;
export const MAX_BOBBER_SPEED = 24;
export const BOBBER_RADIUS = 0.1;
export const MAX_BOBBER_FLIGHT_TICKS = 600;
export const FISHING_PHASES = Object.freeze([
  "flying",
  "wait-retry",
  "waiting",
  "approach",
  "hook",
  "stuck",
]);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const bobberBox = (bobber) =>
  bodyBox(
    { ...bobber, y: bobber.y - BOBBER_RADIUS },
    BOBBER_RADIUS,
    BOBBER_RADIUS * 2
  );

/** Physical eye/aim, not third-person or bobbing camera coordinates. */
export function fishingLaunch(world, eye, direction) {
  if (!finitePoint(eye) || !finitePoint(direction)) return null;
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!length) return null;
  const unit = {
    x: direction.x / length,
    y: direction.y / length,
    z: direction.z / length,
  };
  const clearance = sweepCameraDistance(world, eye, unit, 0.35, BOBBER_RADIUS);
  if (clearance < 0.15) return null;
  const result = {
    x: eye.x + unit.x * clearance,
    y: eye.y + unit.y * clearance,
    z: eye.z + unit.z * clearance,
    vx: unit.x * 12,
    vy: unit.y * 12 + 2,
    vz: unit.z * 12,
  };
  return loadedAquaticArea(world, bobberBox(result)) &&
    !boxCollides(world, bobberBox(result))
    ? result
    : null;
}

function moveBobber(world, bobber, sampleFluid, waterFlight) {
  const destination = {
    x: bobber.x + bobber.vx * FISHING_TICK,
    y: bobber.y + bobber.vy * FISHING_TICK,
    z: bobber.z + bobber.vz * FISHING_TICK,
  };
  if (
    !loadedAquaticArea(
      world,
      aquaticSweepBounds(
        { ...bobber, y: bobber.y - BOBBER_RADIUS },
        { ...destination, y: destination.y - BOBBER_RADIUS },
        BOBBER_RADIUS,
        BOBBER_RADIUS * 2
      )
    )
  )
    return "frontier";
  const steps = Math.max(
    1,
    Math.ceil(
      (Math.hypot(bobber.vx, bobber.vy, bobber.vz) * FISHING_TICK) / 0.1
    )
  );
  for (let index = 0; index < steps; index++) {
    let blocked = false;
    for (const [axis, velocity] of [
      ["x", "vx"],
      ["y", "vy"],
      ["z", "vz"],
    ]) {
      const moved = sweepBoxAxis(
        world,
        bobberBox(bobber),
        axis,
        (bobber[velocity] * FISHING_TICK) / steps
      );
      bobber[axis] += moved.amount;
      if (moved.blocked) {
        blocked = true;
        bobber[velocity] = 0;
      }
    }
    if (blocked) return "stuck";
    const sample = aquaticSample(world, bobber, sampleFluid);
    if (!sample) return "frontier";
    if (sample.fluid === FLUID.LAVA_SOURCE) return "stuck";
    if (waterFlight && sample.water) return "water";
  }
  return "moved";
}

/** No retry loop: even a rejected wait consumes exactly this one tick's draw. */
function rollWait(bobber, events) {
  const wait = fishingWaitTicks(bobber.randomState, bobber.lure);
  bobber.randomState = wait.state;
  bobber.phase = wait.value > 0 ? "waiting" : "wait-retry";
  bobber.remaining = bobber.total = wait.value > 0 ? wait.value : 0;
  events.push(
    wait.value > 0
      ? {
          type: "waiting",
          seconds: wait.value * FISHING_TICK,
          openWater: bobber.openWater,
        }
      : {
          type: "wait-retry",
          waitTicks: wait.value,
          openWater: bobber.openWater,
        }
  );
}

function beginWaiting(world, bobber, events) {
  const water = inspectFishingOpenWater(world, bobber);
  if (!water.loaded) return false;
  bobber.openWater = water.valid;
  bobber.vx *= 0.25;
  bobber.vy *= 0.1;
  bobber.vz *= 0.25;
  rollWait(bobber, events);
  return true;
}

/**
 * One detached 20Hz tick. Caller publishes the returned record/RNG/events.
 * null freezes all progress at a frontier. A missed bite starts a fresh wait;
 * there is no wall-clock catch-up, instant reward, bait or fish-entity query.
 * `wait-retry` keeps zero timers and the last draw's RNG state. Each subsequent
 * loaded tick rolls once; a positive wait starts counting down on the next tick.
 * Retrying is part of the same attempt and cannot restore open-water eligibility.
 */
export function stepFishingCast(world, original, sampleFluid) {
  if (!loadedAquaticArea(world, bobberBox(original))) return null;
  const bobber = { ...original },
    events = [];
  if (bobber.phase === "stuck") return { bobber, events };
  if (bobber.phase === "flying") {
    bobber.vy = Math.max(-MAX_BOBBER_SPEED, bobber.vy - 8 * FISHING_TICK);
    const motion = moveBobber(world, bobber, sampleFluid, true);
    if (motion === "frontier") return null;
    bobber.flightTicks++;
    if (motion === "stuck" || bobber.flightTicks >= MAX_BOBBER_FLIGHT_TICKS) {
      bobber.phase = "stuck";
      bobber.vx = bobber.vy = bobber.vz = 0;
      bobber.remaining = bobber.total = 0;
      events.push({ type: "stuck" });
    } else if (motion === "water") {
      if (!beginWaiting(world, bobber, events)) return null;
      events.unshift({ type: "splash" });
    } else {
      bobber.vx *= 0.99;
      bobber.vz *= 0.99;
    }
  } else {
    const before = inspectFishingOpenWater(world, bobber);
    if (!before.loaded) return null;
    bobber.openWater &&= before.valid;
    const sample = aquaticSample(
      world,
      { ...bobber, y: bobber.y - 0.08 },
      sampleFluid
    );
    if (!sample) return null;
    if (!sample.water || sample.surfaceY === null) {
      bobber.phase = "flying";
      bobber.remaining = bobber.total = 0;
      bobber.flightTicks = 0;
      bobber.openWater = false;
      events.push({ type: "left-water" });
    } else {
      const targetY =
        sample.surfaceY - (bobber.phase === "hook" ? 0.16 : 0.035);
      const blend = 1 - Math.exp(-3 * FISHING_TICK);
      bobber.vx += (sample.current.x - bobber.vx) * blend;
      bobber.vz += (sample.current.z - bobber.vz) * blend;
      // Bubble columns rock this float, rather than launching it out of water
      // and making ordinary fish/junk attempts impossible. Treasure still fails.
      const verticalCurrent = sample.bubble
        ? sample.bubble * 0.6
        : sample.current.y * 2;
      bobber.vy +=
        ((targetY - bobber.y) * 25 - bobber.vy * 6 + verticalCurrent) *
        FISHING_TICK;
      for (const velocity of ["vx", "vy", "vz"])
        bobber[velocity] = clamp(
          bobber[velocity],
          -MAX_BOBBER_SPEED,
          MAX_BOBBER_SPEED
        );
      const motion = moveBobber(world, bobber, sampleFluid, false);
      if (motion === "frontier") return null;
      if (motion === "stuck") {
        bobber.phase = "stuck";
        bobber.remaining = bobber.total = 0;
        bobber.vx = bobber.vy = bobber.vz = 0;
        bobber.openWater = false;
        events.push({ type: "stuck" });
      } else {
        const after = inspectFishingOpenWater(world, bobber);
        if (!after.loaded) return null;
        bobber.openWater &&= after.valid;
        if (bobber.phase === "wait-retry") rollWait(bobber, events);
        else if (--bobber.remaining === 0 && bobber.phase === "waiting") {
          const approach = fishingRandomInt(bobber.randomState, 20, 80);
          const angle = nextFishingRandom(approach.state);
          bobber.randomState = angle.state;
          bobber.approachAngle = angle.value * Math.PI * 2;
          bobber.phase = "approach";
          bobber.remaining = bobber.total = approach.value;
          events.push({
            type: "approach",
            seconds: approach.value * FISHING_TICK,
            angle: bobber.approachAngle,
          });
        } else if (bobber.remaining === 0 && bobber.phase === "approach") {
          const hook = fishingRandomInt(bobber.randomState, 20, 40);
          bobber.randomState = hook.state;
          bobber.phase = "hook";
          bobber.remaining = bobber.total = hook.value;
          bobber.vy = -1.25;
          events.push({ type: "bite", seconds: hook.value * FISHING_TICK });
        } else if (bobber.remaining === 0 && bobber.phase === "hook") {
          events.push({ type: "miss" });
          if (!beginWaiting(world, bobber, events)) return null;
        }
      }
    }
  }
  if (
    bobber.y <= geometryWorldSpec(world).voidY ||
    !Number.isSafeInteger(Math.ceil(bobber.y + 2))
  )
    return { bobber: null, events: [{ type: "cancel", reason: "void" }] };
  return { bobber, events };
}
