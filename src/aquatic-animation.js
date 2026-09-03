import * as THREE from "three";
import { AQUATIC_KINDS } from "./aquatic-skins.js";

const TAU = Math.PI * 2;
const EYE_YAW_LIMIT = Math.PI / 3;
const EYE_PITCH_LIMIT = Math.PI / 4;
const states = new WeakMap();
const unitBox = new THREE.Box3(
  new THREE.Vector3(-0.5, -0.5, -0.5),
  new THREE.Vector3(0.5, 0.5, 0.5)
);

const finite = (value, fallback = 0) =>
  Number.isFinite(value) ? value : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const wrap = (value) => ((value % TAU) + TAU) % TAU;

function validPoint(point) {
  return (
    point != null &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    Number.isFinite(point.z)
  );
}

function makeState(entity, elapsed) {
  return {
    phase: wrap(wrap(finite(elapsed)) + wrap(finite(entity.phase))),
    gait: 0,
    target: new THREE.Vector3(),
    inverse: new THREE.Matrix4(),
    local: new THREE.Matrix4(),
    bounds: new THREE.Box3(),
    supports: entity.model.legs.map((node) => ({
      node,
      foot: node.getObjectByName("foot"),
      restY: node.position.y,
    })),
  };
}

function approach(current, target, min, max, rest, blend) {
  const start = clamp(finite(current, rest), min, max);
  const end = clamp(finite(target, rest), min, max);
  return start + (end - start) * blend;
}

function poseSwings(hooks, phase, amount, blend, positiveOnly = false) {
  for (const hook of hooks) {
    const amplitude = Math.abs(hook.amplitude);
    const wave = Math.sin(phase + hook.phase);
    const target =
      hook.rest +
      (positiveOnly ? Math.max(0, wave) * amplitude : wave * hook.amplitude) *
        amount;
    hook.node[hook.property][hook.axis] = approach(
      hook.node[hook.property][hook.axis],
      target,
      positiveOnly ? hook.rest : hook.rest - amplitude,
      hook.rest + amplitude,
      hook.rest,
      blend
    );
  }
}

function directionInParent(state, parent, point, x, y, z) {
  if (!validPoint(point)) return false;
  state.inverse.copy(parent.matrixWorld).invert();
  state.target.copy(point).applyMatrix4(state.inverse);
  state.target.x -= x;
  state.target.y -= y;
  state.target.z -= z;
  return (
    validPoint(state.target) &&
    Math.hypot(state.target.x, state.target.y, state.target.z) > 1e-6
  );
}

function poseHead(model, entity, player, state, blend) {
  const hook = model.animation.head;
  if (!hook) return;
  const point = validPoint(entity.lookTarget) ? entity.lookTarget : player;
  const node = hook.node;
  let yaw = 0,
    pitch = 0;
  if (
    directionInParent(
      state,
      node.parent,
      point,
      node.position.x,
      node.position.y,
      node.position.z
    )
  ) {
    yaw = Math.atan2(state.target.x, state.target.z);
    pitch = -Math.atan2(
      state.target.y,
      Math.hypot(state.target.x, state.target.z)
    );
  }
  const restYaw = hook.restRotation[1],
    restPitch = hook.restRotation[0];
  node.rotation[hook.yawAxis] = approach(
    node.rotation[hook.yawAxis],
    restYaw + finite(entity.lookYaw, yaw),
    restYaw - hook.yawLimit,
    restYaw + hook.yawLimit,
    restYaw,
    blend
  );
  node.rotation[hook.pitchAxis] = approach(
    node.rotation[hook.pitchAxis],
    restPitch + finite(entity.lookPitch, pitch),
    restPitch - hook.pitchLimit,
    restPitch + hook.pitchLimit,
    restPitch,
    blend
  );
}

function poseEye(model, entity, player, state, blend) {
  const hook = model.animation.eye;
  if (!hook) return;
  const point = validPoint(entity.eyeTarget)
    ? entity.eyeTarget
    : validPoint(entity.lookTarget)
      ? entity.lookTarget
      : player;
  const rest = hook.restPosition;
  let x = 0,
    y = 0;
  if (
    directionInParent(
      state,
      hook.node.parent,
      point,
      rest[0],
      rest[1],
      rest[2]
    ) &&
    state.target.z > 0
  ) {
    x = clamp(
      Math.atan2(state.target.x, state.target.z) / EYE_YAW_LIMIT,
      -1,
      1
    );
    y = clamp(
      Math.atan2(state.target.y, Math.hypot(state.target.x, state.target.z)) /
        EYE_PITCH_LIMIT,
      -1,
      1
    );
  }
  for (let i = 0; i < hook.axes.length; i++) {
    const axis = hook.axes[i];
    const limit = hook.maxOffset[i];
    hook.node.position[axis] = approach(
      hook.node.position[axis],
      rest[i] + (i === 0 ? x : y) * limit,
      rest[i] - limit,
      rest[i] + limit,
      rest[i],
      blend
    );
  }
}

function spikeExtension(entity, moving, charge) {
  if (typeof entity.spikesExtended === "boolean")
    return entity.spikesExtended ? 1 : 0;
  if (Number.isFinite(entity.spikesExtended))
    return clamp(entity.spikesExtended, 0, 1);
  return entity.attacking === true || charge > 0 ? 1 : moving ? 0.25 : 1;
}

// Support the upright land gait in visual-local coordinates. This does not
// query terrain, change the physical root, or establish a gameplay collider.
function supportFeet(model, state) {
  const floor = -model.animation.swim.restPosition[1];
  for (const support of state.supports) {
    if (!support.foot) continue;
    state.inverse.copy(support.node.parent.matrixWorld).invert();
    state.local.multiplyMatrices(state.inverse, support.foot.matrixWorld);
    state.bounds.copy(unitBox).applyMatrix4(state.local);
    support.node.position.y =
      support.restY + Math.max(0, finite(floor - state.bounds.min.y));
  }
}

/**
 * Visual-only adapter for createAquaticModel; it never advances entity.stride,
 * steers a heading, moves the physical root, acquires a target, or deals damage.
 *
 * Optional read-only pose inputs on entity:
 * - moving: boolean; spec.speed: finite speed, clamped to [0,6] for cadence.
 * - swimming: boolean, default true except drowned. Controls paddle/kick gait.
 * - swimPitch: local X radians, default 0, clamped to the rig limit; used only
 *   while swimming. Positive X points a +Z-facing horizontal swimmer downward.
 * - lookTarget / eyeTarget: world-space {x,y,z}; eyeTarget overrides lookTarget
 *   for guardians. player is the fallback point. Missing/invalid points center
 *   the pose; a guardian also centers its eye for coincident/behind targets.
 * - lookYaw / lookPitch: optional local Y/X radian overrides of head tracking.
 * - beamCharge: [0,1], default 0; cosmetic tail damping and spike extension only.
 * - attacking: boolean; extends guardian spikes, default false.
 * - spikesExtended: boolean or [0,1], overriding automatic spike extension
 *   (extended at rest/charging, partly retracted in motion).
 *
 * Positive finite dt is capped at 0.1s. Other dt values freeze the local pose,
 * but still refresh world matrices for caller-owned root/ancestor transforms.
 * elapsed and entity.phase seed one bounded visual clock on the first active
 * frame; subsequent animation advances by dt only, so pause/resume cannot jump.
 * Scratch objects live in a WeakMap per rig, with no per-frame collections or
 * GPU allocations. Neutral model bounds remain neutral bounds, not colliders.
 */
export function animateAquaticMob(entity, dt, elapsed, player) {
  const model = entity?.model;
  if (
    !AQUATIC_KINDS.includes(entity?.kind) ||
    model?.kind !== entity.kind ||
    !model?.animation?.swim
  )
    throw new Error("Aquatic animation requires a matching aquatic model");
  const step = clamp(finite(dt), 0, 0.1);
  if (step === 0) {
    model.root.updateWorldMatrix(true, true);
    return;
  }
  let state = states.get(model);
  if (!state) {
    state = makeState(entity, elapsed);
    states.set(model, state);
  }
  const blend = Math.min(1, step * 12);
  const moving = entity.moving === true;
  const swimming =
    typeof entity.swimming === "boolean"
      ? entity.swimming
      : entity.kind !== "drowned";
  const speed = clamp(finite(entity.spec?.speed, 1), 0, 6);
  state.gait = approach(state.gait, moving ? 1 : 0, 0, 1, 0, blend);
  const rate = Math.min(
    14,
    swimming
      ? 1.5 + state.gait * (3 + speed * 2)
      : 1 + state.gait * (3 + speed * 3)
  );
  state.phase = wrap(finite(state.phase) + step * rate);
  const hooks = model.animation;
  const charge = hooks.spikes.length
    ? clamp(finite(entity.beamCharge), 0, 1)
    : 0;
  const swim = hooks.swim;
  const restPitch = swim.restRotation[0];
  swim.node.rotation[swim.pitchAxis] = approach(
    swim.node.rotation[swim.pitchAxis],
    restPitch + (swimming ? finite(entity.swimPitch) : 0),
    restPitch - swim.maxPitch,
    restPitch + swim.maxPitch,
    restPitch,
    blend
  );
  for (const support of state.supports) support.node.position.y = support.restY;
  poseSwings(
    hooks.tail,
    state.phase,
    (swimming ? 0.16 + state.gait * 0.84 : state.gait * 0.45) *
      (1 - charge * 0.65),
    blend
  );
  poseSwings(
    hooks.flippers,
    state.phase,
    swimming ? 0.12 + state.gait * 0.88 : state.gait * 0.35,
    blend
  );
  const legs = swimming ? 0.1 + state.gait * 0.9 : state.gait;
  const arms = swimming ? 0.2 + state.gait * 0.8 : state.gait * 0.45;
  poseSwings(hooks.legs, state.phase, legs, blend);
  poseSwings(hooks.knees, state.phase, legs, blend, true);
  poseSwings(hooks.arms, state.phase, arms, blend);
  poseSwings(hooks.elbows, state.phase, arms, blend);
  const extension = spikeExtension(entity, moving, charge);
  for (const hook of hooks.spikes)
    hook.node[hook.property][hook.axis] = approach(
      hook.node[hook.property][hook.axis],
      hook.min + extension * (hook.max - hook.min),
      hook.min,
      hook.max,
      hook.rest,
      blend
    );
  model.root.updateWorldMatrix(true, true);
  if (!swimming) supportFeet(model, state);
  poseHead(model, entity, player, state, blend);
  poseEye(model, entity, player, state, blend);
  model.root.updateWorldMatrix(true, true);
}
