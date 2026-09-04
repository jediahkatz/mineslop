// Presentation only: no input, world time, item-use timing, or camera state.
const TAU = Math.PI * 2;
const blend = () => ({ lead: 0, value: 0 });
const unit = (value) =>
  Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

export const HELD_MOTION_MAX_DT = 0.1;
export const HELD_MINING_PERIOD = 0.36;

// Accepted locomotion only. The host must explicitly attest that fluid data is
// known; eye immersion alone and wet grounded feet do not imply swimming.
export function swimPresentationBlocked(state) {
  return !state || state.fluidKnown !== true || state.seated === true ||
    state.flying === true || state.climbing === true || state.dead === true;
}

export function createSwimMotion() {
  return { weight: blend(), moving: blend(), phase: 0, active: false };
}

export function resetSwimMotion(swim) {
  swim.weight.lead = swim.weight.value = 0;
  swim.moving.lead = swim.moving.value = 0;
  swim.phase = 0;
  swim.active = false;
}

export function advanceSwimMotion(swim, dt, state) {
  if (swimPresentationBlocked(state)) {
    resetSwimMotion(swim);
    return;
  }
  swim.active = state.swimming === true && state.grounded !== true;
  if (!Number.isFinite(dt) || dt <= 0) return;
  const step = Math.min(dt, HELD_MOTION_MAX_DT);
  const rateDt = step * 10;
  const decay = Math.exp(-rateDt);
  approach(swim.weight, swim.active ? 1 : 0, rateDt, decay);
  approach(swim.moving, swim.active && state.moving === true ? 1 : 0, rateDt, decay);
  swim.phase = (swim.phase + step * 4.2) % TAU;
}

export function createHeldMotion() {
  const motion = {
    walk: blend(),
    swim: createSwimMotion(),
    bob: true,
    mining: blend(),
    food: blend(),
    bow: blend(),
    shield: blend(),
    charge: blend(),
    equip: blend(),
    strike: blend(),
    walkPhase: 0,
    miningPhase: 0,
    foodPhase: 0,
    miningRequested: false,
    miningActive: false,
    pose: {
      x: 0.76, y: -0.75, depth: 0.82,
      rx: 0.15, ry: -0.4, rz: 0.08,
      itemYaw: 0.5, itemRoll: -0.28, scale: 1, scaleY: 1,
    },
  };
  // Allocate once. Hidden-frame resets and all updates reuse these same objects.
  motion.channels = [
    motion.walk, motion.mining, motion.food, motion.bow,
    motion.shield, motion.charge, motion.equip, motion.strike,
  ];
  return motion;
}

/**
 * Exact solution of two cascaded first-order filters for a constant target.
 * Both stages stay within [0, 1]; retargeting preserves position and velocity.
 * Unlike a per-frame lerp, splitting a dt does not change the response.
 */
function approach(channel, target, rateDt, decay) {
  const delta = channel.lead - target;
  channel.value = unit(
    target + (channel.value - target + delta * rateDt) * decay
  );
  channel.lead = unit(target + delta * decay);
}

export function requestHeldSelection(motion) {
  // An impulse changes only the leading stage, never the rendered pose.
  motion.equip.lead = 1;
}

function reset(motion) {
  for (let i = 0; i < motion.channels.length; i++) {
    motion.channels[i].lead = motion.channels[i].value = 0;
  }
  motion.walkPhase = motion.miningPhase = motion.foodPhase = 0;
  resetSwimMotion(motion.swim);
  motion.miningRequested = motion.miningActive = false;
}

/**
 * A mining request is a one-update lease, renewed only by accepted mining.
 * Legacy swing writes are one-shot impulses, never evidence of held mining.
 * Zero/invalid dt freezes motion; hidden views discard transient work. Large
 * gaps advance at most one visual step, with no catch-up loop or wall clock.
 */
export function advanceHeldMotion(
  motion, dt, moving, visible, kind = null, progress = 0, swing = 0,
  locomotion
) {
  if (!visible) {
    reset(motion);
    return 0;
  }
  motion.bob = locomotion?.bob !== false;
  advanceSwimMotion(motion.swim, dt, locomotion);
  if (!Number.isFinite(dt) || dt <= 0) return 0;
  const step = Math.min(dt, HELD_MOTION_MAX_DT);
  motion.miningActive = motion.miningRequested;
  motion.miningRequested = false;
  motion.strike.lead = Math.max(motion.strike.lead, unit(swing));

  const rateDt = 22 * step;
  const decay = Math.exp(-rateDt);
  approach(motion.walk, moving && !motion.swim.active ? 1 : 0, rateDt, decay);
  approach(motion.mining, motion.miningActive ? 1 : 0, rateDt, decay);
  approach(motion.food, kind === "food" ? 1 : 0, rateDt, decay);
  approach(motion.bow, kind === "bow" ? 1 : 0, rateDt, decay);
  approach(motion.shield, kind === "shield" ? 1 : 0, rateDt, decay);
  approach(motion.charge, kind === "bow" ? unit(progress) : 0, rateDt, decay);
  const pulseDt = 16 * step;
  const pulseDecay = Math.exp(-pulseDt);
  approach(motion.equip, 0, pulseDt, pulseDecay);
  approach(motion.strike, 0, pulseDt, pulseDecay);

  motion.walkPhase = (motion.walkPhase + step * 11) % TAU;
  motion.miningPhase = (motion.miningPhase + step * TAU / HELD_MINING_PERIOD) % TAU;
  motion.foodPhase = (motion.foodPhase + step * 28) % TAU;
  return step;
}

/** Reused, normalized-screen pose. Projection happens AFTER blending. */
export function composeHeldMotion(motion, left, shieldItem, reducedMotion) {
  const side = left ? -1 : 1;
  const food = motion.food.value;
  const bow = motion.bow.value;
  const shield = motion.shield.value;
  const idle = Math.max(0, 1 - food - bow - shield);
  const decorative = reducedMotion ? 0 : 1;
  const stroke = decorative * Math.max(
    motion.mining.value * (1 - Math.cos(motion.miningPhase)) * 0.5,
    Math.min(1, Math.E * motion.strike.value)
  );
  const equip = decorative * Math.min(1, Math.E * motion.equip.value);
  // Swimming is decorative and subordinate to every real action, including
  // selection/strike pulses. It never changes an item's use pose or timing.
  const swim = decorative * Number(motion.bob) * motion.swim.weight.value *
    Math.max(0, idle - motion.mining.value -
      Math.min(1, Math.E * motion.strike.value) -
      Math.min(1, Math.E * motion.equip.value));
  const strokePhase = motion.swim.phase + (left ? Math.PI : 0);
  const swimMove = motion.swim.moving.value;
  const pose = motion.pose;
  pose.x = side * (
    0.76 * idle + 0.42 * food + 0.33 * bow + 0.48 * shield -
    0.025 * stroke * idle
  );
  pose.y = -0.75 * idle - 0.26 * food - 0.42 * bow - 0.3 * shield -
    0.08 * equip + decorative * (
      Math.sin(motion.walkPhase) * 0.0095 * motion.walk.value * idle *
        Number(motion.bob && !motion.swim.active) +
      Math.sin(motion.foodPhase) * 0.018 * food
    );
  pose.depth = 0.82 * idle + 0.72 * food + 0.76 * bow + 0.75 * shield;
  pose.rx = 0.15 * idle - 0.3 * food + 0.06 * bow -
    0.68 * stroke * idle + 0.06 * equip;
  pose.ry = side * (-0.4 * (idle + food) - 0.15 * bow);
  pose.rz = side * (0.08 * (idle + food + bow) + 0.04 * shield);
  pose.itemYaw = side * (0.5 * (1 - shield) + 0.12 * shield);
  pose.itemRoll = side * -0.28 * (1 - shield);
  const baseScale = shieldItem ? 1.35 : 1;
  pose.scale = baseScale * idle + food + bow + 1.6 * shield;
  pose.scaleY = pose.scale + 0.12 * bow * motion.charge.value;
  pose.x += side * swim * Math.sin(strokePhase) * (0.009 + 0.009 * swimMove);
  pose.y += swim * Math.cos(strokePhase) * (0.008 + 0.008 * swimMove);
  pose.depth += swim * Math.sin(strokePhase) * 0.012 * swimMove;
  pose.rx += swim * (-0.035 + 0.035 * Math.cos(strokePhase));
  pose.rz += side * swim * Math.sin(strokePhase) * 0.025;
  return pose;
}
