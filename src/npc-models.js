import * as THREE from "three";
import { createNpcSkin, NPC_KINDS } from "./npc-skins.js";

export const MAX_NPC_PARTS_PER_MODEL = 24;
const unitBox = new THREE.Box3(
  new THREE.Vector3(-0.5, -0.5, -0.5),
  new THREE.Vector3(0.5, 0.5, 0.5)
);
const states = new WeakMap();
const finite = (n, fallback = 0) => Number.isFinite(n) ? n : fallback;
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const wrap = (n) => Math.atan2(Math.sin(n), Math.cos(n));
const validPoint = (point) => point && [point.x, point.y, point.z].every(Number.isFinite);

function rig(kind) {
  const root = new THREE.Group();
  root.name = kind;
  const visual = new THREE.Group();
  visual.name = "npc-visual";
  root.add(visual);
  const model = {
    kind, root, visual, parts: [], legs: [], wings: [], rods: [], head: null,
    animation: { legs: [], orbit: [] },
  };
  model.joint = (parent, name, position) => {
    const node = new THREE.Group();
    node.name = name;
    node.position.fromArray(position);
    parent.add(node);
    return node;
  };
  model.box = (parent, name, role, position, size) => {
    const node = new THREE.Object3D();
    node.name = role;
    node.position.fromArray(position);
    node.scale.fromArray(size);
    parent.add(node);
    const skin = createNpcSkin(kind, role, size);
    model.parts.push({ name, role, node, skin, color: new THREE.Color(skin.baseColor) });
    return node;
  };
  return model;
}

function villager(m) {
  m.box(m.visual, "long-robe", "robe", [0, 0.98, 0], [0.56, 0.98, 0.38]);
  m.box(m.visual, "work-apron", "apron", [0, 0.92, 0.207], [0.4, 0.7, 0.045]);
  m.box(m.visual, "collar", "apron", [0, 1.45, 0], [0.62, 0.1, 0.42]);
  const h = (m.head = m.joint(m.visual, "head-pivot", [0, 1.68, 0]));
  h.rotation.order = "YXZ";
  m.box(h, "face", "head", [0, 0.045, 0], [0.51, 0.54, 0.48]);
  m.box(h, "nose", "nose", [0, -0.07, 0.31], [0.15, 0.25, 0.19]);
  m.box(h, "cap", "cap", [0, 0.34, -0.025], [0.55, 0.11, 0.52]);
  for (const side of [-1, 1]) {
    const leg = m.joint(m.visual, `leg-${side}`, [side * 0.155, 0.55, 0]);
    m.box(leg, `leg-${side}`, "robe", [0, -0.23, 0], [0.23, 0.46, 0.25]);
    const foot = m.box(leg, `boot-${side}`, "boot", [0, -0.475, 0.045], [0.26, 0.15, 0.34]);
    m.legs.push(leg);
    m.animation.legs.push({ node: leg, foot, phase: side < 0 ? 0 : Math.PI, restY: 0.55 });
    const arm = m.joint(m.visual, `folded-arm-${side}`, [side * 0.37, 1.35, 0]);
    arm.rotation.z = side * 0.2;
    m.box(arm, `upper-sleeve-${side}`, "sleeve", [0, -0.2, 0.06], [0.24, 0.4, 0.29]);
    m.box(arm, `folded-sleeve-${side}`, "sleeve", [-side * 0.13, -0.31, 0.26], [0.4, 0.22, 0.24]);
    m.box(arm, `hand-${side}`, "hand", [-side * 0.32, -0.31, 0.26], [0.16, 0.19, 0.21]);
    m.wings.push(arm);
  }
}

function blaze(m) {
  const h = (m.head = m.joint(m.visual, "head-pivot", [0, 1.4, 0]));
  h.rotation.order = "YXZ";
  m.box(h, "furnace-face", "head", [0, 0, 0], [0.56, 0.54, 0.52]);
  m.box(m.visual, "coal-core", "core", [0, 0.86, 0], [0.33, 0.52, 0.3]);
  m.box(m.visual, "core-tip", "ember", [0, 0.48, 0], [0.16, 0.2, 0.16]);
  for (let ring = 0; ring < 3; ring++) {
    const joint = m.joint(m.visual, `rod-orbit-${ring}`, [0, 0.35 + ring * 0.45, 0]);
    const radius = ring === 1 ? 0.59 : 0.46;
    m.animation.orbit.push({ node: joint, rate: ring === 1 ? -0.85 : 0.65, phase: ring * 0.7 });
    for (let i = 0; i < 3; i++) {
      const angle = i * Math.PI * 2 / 3 + ring * 0.45;
      const rod = m.joint(joint, `rod-${ring}-${i}`, [
        Math.sin(angle) * radius, 0, Math.cos(angle) * radius,
      ]);
      rod.rotation.z = Math.sin(angle) * 0.18;
      rod.rotation.x = Math.cos(angle) * 0.18;
      m.box(rod, `rod-${ring}-${i}`, "rod", [0, 0, 0], [0.15, 0.47, 0.15]);
      m.box(rod, `ember-${ring}-${i}`, "ember", [0, 0.235, 0], [0.16, 0.07, 0.16]);
      m.rods.push(rod);
    }
  }
}

function modelBounds(model) {
  model.root.updateWorldMatrix(true, true);
  const bounds = new THREE.Box3();
  for (const part of model.parts)
    bounds.union(unitBox.clone().applyMatrix4(part.node.matrixWorld));
  return bounds;
}

/** CPU-only, +Z-facing authored cuboids. Shared skin descriptors, no Mesh,
 * geometry, material, texture, lights, species registration or physics queries.
 */
export function createNpcModel(kind) {
  if (!NPC_KINDS.includes(kind)) throw new RangeError("Unknown NPC model");
  const model = rig(kind);
  if (kind === "villager") villager(model);
  else blaze(model);
  if (model.parts.length > MAX_NPC_PARTS_PER_MODEL) throw new RangeError("NPC part budget exceeded");
  model.visual.position.y -= modelBounds(model).min.y;
  model.animation.restY = model.visual.position.y;
  model.localBounds = modelBounds(model);
  const { min, max } = model.localBounds;
  model.pickFloor = Math.min(0, min.y - 0.1);
  model.pickHeight = max.y + 0.2;
  model.pickRadius = Math.hypot(
    Math.max(Math.abs(min.x), max.x), Math.max(Math.abs(min.z), max.z)
  ) + 0.2;
  return model;
}

/** All state is local and bounded, including huge/invalid external elapsed.
 * Physical root, species collider and immutable neutral bounds never change.
 */
export function animateNpcMob(entity, dt, elapsed, player) {
  const model = entity?.model;
  if (!NPC_KINDS.includes(entity?.kind) || model?.kind !== entity.kind)
    throw new RangeError("NPC animation requires matching model");
  const step = clamp(finite(dt), 0, 0.1);
  if (!step) { model.root.updateWorldMatrix(true, true); return; }
  let state = states.get(model);
  if (!state) {
    state = {
      phase: wrap(finite(elapsed) % (Math.PI * 2) + finite(entity.phase) % (Math.PI * 2)),
      target: new THREE.Vector3(), inverse: new THREE.Matrix4(),
      local: new THREE.Matrix4(), bounds: new THREE.Box3(),
    };
    states.set(model, state);
  }
  const speed = clamp(finite(entity.spec?.speed, 1), 0, 6);
  state.phase = wrap(state.phase + step * (entity.moving ? 3 + speed * 3 : 1.2));
  const blend = Math.min(1, step * 10);
  const charge = clamp(finite(entity.beamCharge), 0, 1);
  for (const leg of model.animation.legs) {
    const target = entity.moving ? Math.sin(state.phase + leg.phase) * 0.35 : 0;
    leg.node.rotation.x = clamp(finite(leg.node.rotation.x), -0.4, 0.4) * (1 - blend) + target * blend;
    leg.node.position.y = leg.restY;
  }
  for (const orbit of model.animation.orbit) {
    orbit.node.rotation.y = wrap(state.phase * orbit.rate * (1 + charge * 0.7) + orbit.phase);
    orbit.node.rotation.x = Math.sin(state.phase + orbit.phase) * 0.06;
  }
  model.visual.position.y = model.animation.restY +
    (entity.kind === "blaze" ? 0.04 + Math.sin(state.phase * 0.7) * 0.04 + charge * 0.08 : 0);
  model.root.updateWorldMatrix(true, true);
  for (const leg of model.animation.legs) {
    state.inverse.copy(leg.node.parent.matrixWorld).invert();
    state.local.multiplyMatrices(state.inverse, leg.foot.matrixWorld);
    state.bounds.copy(unitBox).applyMatrix4(state.local);
    leg.node.position.y = leg.restY + Math.max(0, -state.bounds.min.y);
  }
  const target = validPoint(entity.lookTarget) ? entity.lookTarget : player;
  let yaw = 0, pitch = 0;
  if (validPoint(target)) {
    state.inverse.copy(model.head.parent.matrixWorld).invert();
    state.target.copy(target).applyMatrix4(state.inverse).sub(model.head.position);
    if (validPoint(state.target) && state.target.lengthSq() > 1e-8) {
      yaw = clamp(Math.atan2(state.target.x, state.target.z), -0.65, 0.65);
      pitch = clamp(-Math.atan2(state.target.y, Math.hypot(state.target.x, state.target.z)), -0.35, 0.35);
    }
  }
  model.head.rotation.y = clamp(finite(model.head.rotation.y), -0.65, 0.65) * (1 - blend) + yaw * blend;
  model.head.rotation.x = clamp(finite(model.head.rotation.x), -0.35, 0.35) * (1 - blend) + pitch * blend;
  model.root.updateWorldMatrix(true, true);
}
