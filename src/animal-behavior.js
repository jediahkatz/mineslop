import { BLOCK } from "./blocks.js";

export const ANIMAL_BEHAVIOR_LIMITS = Object.freeze({
  step: 0.2,
  followStart: 3.2,
  followStop: 2.1,
  followRange: 14,
  shyRelease: 7,
  callRange: 24,
  callMin: 12,
  callMax: 30,
});

const profile = (graze, homeRadius, shy = 0, nocturnal = false) =>
  Object.freeze({ graze, homeRadius, shy, nocturnal });
const profiles = Object.freeze({
  sheep: profile(0.4, 10),
  pig: profile(0.3, 10),
  cow: profile(0.4, 10),
  chicken: profile(0.4, 7),
  horse: profile(0.4, 14),
  rabbit: profile(0.3, 9, 3),
  wolf: profile(0, 14),
  fox: profile(0, 12, 4, true),
  goat: profile(0.25, 12),
  polar_bear: profile(0, 14),
  panda: profile(0.5, 8),
  camel: profile(0.25, 14),
  frog: profile(0.25, 6),
  mooshroom: profile(0.4, 10),
});

export const hasAnimalBehavior = (kind) => Object.hasOwn(profiles, kind);
const point = (value) =>
  !!value && [value.x, value.y, value.z].every(Number.isFinite);
const horizontalPoint = (value) =>
  !!value && Number.isFinite(value.x) && Number.isFinite(value.z);
const wrap = (yaw) => Math.atan2(Math.sin(yaw), Math.cos(yaw));
const heading = (from, to, fallback) =>
  Math.hypot(to.x - from.x, to.z - from.z) < 0.01
    ? fallback
    : Math.atan2(to.x - from.x, to.z - from.z);

function random(state) {
  state.seed = (Math.imul(state.seed, 1664525) + 1013904223) >>> 0;
  return state.seed / 4294967296;
}

const callDelay = (state) =>
  ANIMAL_BEHAVIOR_LIMITS.callMin +
  random(state) *
    (ANIMAL_BEHAVIOR_LIMITS.callMax - ANIMAL_BEHAVIOR_LIMITS.callMin);

/** Independent, ephemeral intent RNG: neither a save owner nor Wildlife's RNG. */
export function createAnimalBehavior(identity, yaw = 0) {
  let seed = 2166136261;
  for (const char of String(identity))
    seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  const state = {
    seed: seed >>> 0,
    mode: "idle",
    remaining: 0,
    yaw: Number.isFinite(yaw) ? wrap(yaw) : 0,
    approaching: false,
    threatX: 0,
    threatZ: 0,
    callIn: 0,
  };
  state.remaining = 1.5 + random(state) * 2.5;
  state.callIn = callDelay(state);
  return state;
}

/** One cooldown for ambient AND alarm attempts. Admission/mute/range cannot
 * refund a due opportunity or produce a retry every frame. Also used when a
 * companion/riding owner, rather than the generic planner, supplies movement.
 */
export function planAnimalVocalization(
  previous,
  { audible = false, alarm = false, paused = false } = {},
  dt
) {
  if (paused || !Number.isFinite(dt) || dt <= 0)
    return { state: previous, event: null };
  const state = { ...previous };
  state.callIn = Math.max(
    0,
    state.callIn - Math.min(dt, ANIMAL_BEHAVIOR_LIMITS.step)
  );
  let event = null;
  if (state.callIn === 0) {
    state.callIn = callDelay(state);
    if (audible) event = { call: alarm ? "alarm" : "ambient" };
  }
  return { state, event };
}

/** Grazing/pecking is an animation intent, never a block, item or health edit. */
export function animalCanGraze(kind, groundId) {
  if (!hasAnimalBehavior(kind) || profiles[kind].graze === 0) return false;
  if (kind === "mooshroom") return groundId === BLOCK.MYCELIUM;
  if (kind === "camel") return [BLOCK.SAND, BLOCK.RED_SAND].includes(groundId);
  if (["pig", "chicken", "frog"].includes(kind) &&
    [BLOCK.DIRT, BLOCK.MUD, BLOCK.PODZOL].includes(groundId)) return true;
  return groundId === BLOCK.GRASS || groundId === BLOCK.MOSS;
}

/**
 * Pure bounded decision step. The host supplies current physical observations;
 * `attracted` means an already-committed follow timer or a read-only hand check.
 * Resource-affecting feeding/taming/breeding remain with their atomic owners.
 * No world, inventory, audio, clock, callback, or shared RNG is read here.
 */
export function planAnimalBehavior(previous, observation, dt) {
  const stop = {
    state: previous,
    intent: { mode: observation.controlled ? "controlled" : "idle", speed: 0, yaw: previous.yaw },
    event: null,
  };
  if (!hasAnimalBehavior(observation.kind) || observation.controlled ||
    observation.paused || !Number.isFinite(dt) || dt <= 0 ||
    !point(observation.position) || !Number.isFinite(observation.speed) ||
    observation.speed < 0) return stop;
  dt = Math.min(dt, ANIMAL_BEHAVIOR_LIMITS.step);
  const next = { ...previous };
  next.remaining = Math.max(0, next.remaining - dt);
  const { position, player } = observation;
  const traits = profiles[observation.kind];
  const distance = point(player)
    ? Math.hypot(player.x - position.x, player.z - position.z)
    : Infinity;
  const seesPlayer = observation.playerVisible === true && point(player) &&
    Math.abs(player.y - position.y) < 3;
  const attracted = observation.attracted === true && seesPlayer &&
    distance < ANIMAL_BEHAVIOR_LIMITS.followRange;
  const injured = observation.fleeTime > 0 && horizontalPoint(observation.threat);
  const startled = !attracted && seesPlayer && distance < traits.shy;
  const continuingFlight = previous.mode === "flee" && !attracted &&
    (next.remaining > 0 || (traits.shy > 0 && seesPlayer &&
      distance < ANIMAL_BEHAVIOR_LIMITS.shyRelease));
  let speed = 0;
  if (injured || startled || continuingFlight) {
    if (injured || startled) {
      const threat = injured ? observation.threat : player;
      next.threatX = threat.x;
      next.threatZ = threat.z;
    }
    if (previous.mode !== "flee")
      next.remaining = 1.5 + random(next);
    next.mode = "flee";
    next.approaching = false;
    next.yaw = heading(
      { x: next.threatX, z: next.threatZ }, position, next.yaw,
    );
    speed = observation.speed * 2.6;
  } else if (attracted) {
    next.mode = "follow";
    next.remaining = 0;
    next.approaching = distance > ANIMAL_BEHAVIOR_LIMITS.followStart ||
      (previous.mode === "follow" && previous.approaching &&
        distance > ANIMAL_BEHAVIOR_LIMITS.followStop);
    next.yaw = heading(position, player, next.yaw);
    if (next.approaching) speed = observation.speed * 1.3;
  } else {
    if (previous.mode === "flee" || previous.mode === "follow") {
      next.mode = "idle";
      next.remaining = 1.8 + random(next) * 2;
      next.approaching = false;
    }
    if (next.mode === "graze" && observation.canGraze !== true) {
      next.mode = "idle";
      next.remaining = Math.max(1, next.remaining);
    }
    if (next.remaining <= 0) {
      const choice = random(next);
      const resting = observation.daylight === traits.nocturnal;
      const homeDistance = horizontalPoint(observation.home)
        ? Math.hypot(position.x - observation.home.x, position.z - observation.home.z)
        : 0;
      if (homeDistance > traits.homeRadius) {
        next.mode = "roam";
        next.yaw = heading(position, observation.home, next.yaw);
      } else if (observation.canGraze === true && choice < traits.graze) {
        next.mode = "graze";
      } else if (choice < (resting ? 0.82 : 0.62)) {
        next.mode = "idle";
      } else {
        next.mode = "roam";
        const yaw = Number.isFinite(observation.yaw) ? observation.yaw : next.yaw;
        next.yaw = wrap(yaw + (random(next) - 0.5) * 2.4);
      }
      next.remaining = next.mode === "roam"
        ? 3 + random(next) * 4
        : 2.5 + random(next) * (resting ? 5 : 3);
    }
    if (next.mode === "roam") speed = observation.speed * 0.8;
  }
  const voice = planAnimalVocalization(next, {
    audible: observation.audible === true,
    alarm: next.mode === "flee",
  }, dt);
  return {
    state: voice.state,
    intent: { mode: next.mode, yaw: next.yaw, speed },
    event: voice.event,
  };
}
