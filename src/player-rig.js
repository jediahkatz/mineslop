import * as THREE from "three";
import { getItem, ITEM } from "./items.js";
import { MAX_PLAYER_PARTS, PLAYER_SKINS } from "./player-skin.js";

const STANDING_HEIGHT = 1.8;
const STANDING_EYE_HEIGHT = 1.62;
const TORSO_LENGTH = 0.6;
const LEG_LENGTH = 0.3;
const ANKLE_HEIGHT = 0.12;
const WHITE = "#ffffff";
const METAL = "#c7cdd4";

function joint(parent, name, x = 0, y = 0, z = 0) {
  const node = new THREE.Group();
  node.name = name;
  node.position.set(x, y, z);
  parent.add(node);
  return node;
}

function box(rig, parent, name, skin, position, size) {
  const node = new THREE.Object3D();
  node.name = name;
  node.position.fromArray(position);
  node.scale.fromArray(size);
  parent.add(node);
  const part = { node, skin, color: new THREE.Color(WHITE), visible: true };
  rig.parts.push(part);
  return part;
}

function armor(rig, slot, parent, name, position, size) {
  const part = box(rig, parent, name, PLAYER_SKINS.metal, position, size);
  part.visible = false;
  rig.equipment[slot].parts.push(part);
  return part;
}

function buildHand(rig, parent, name) {
  const root = joint(parent, name, 0, -0.59, 0.04);
  const hand = { root, parts: [], item: null };
  for (let i = 0; i < 4; i++) {
    const part = box(
      rig,
      root,
      `${name}-${i}`,
      PLAYER_SKINS.tint,
      [0, 0, 0],
      [1, 1, 1]
    );
    part.visible = false;
    hand.parts.push(part);
  }
  return hand;
}

function buildArm(rig, side) {
  const name = side < 0 ? "right" : "left";
  const root = joint(rig.torso, `${name}-shoulder`, side * 0.36, 0.56);
  box(
    rig,
    root,
    `${name}-sleeve`,
    PLAYER_SKINS.sleeve,
    [0, -0.2, 0],
    [0.22, 0.4, 0.24]
  );
  box(
    rig,
    root,
    `${name}-hand`,
    PLAYER_SKINS.hand,
    [0, -0.51, 0],
    [0.22, 0.22, 0.24]
  );
  armor(
    rig,
    "chest",
    root,
    `${name}-pauldron`,
    [0, -0.07, 0],
    [0.265, 0.17, 0.28]
  );
  const hand = buildHand(rig, root, side < 0 ? "mainHand" : "offhand");
  rig.arms.push({ root, side, hand });
  return hand;
}

function buildLeg(rig, side) {
  const name = side < 0 ? "right" : "left";
  const root = joint(rig.root, `${name}-hip`, side * 0.125);
  const thigh = box(
    rig,
    root,
    `${name}-thigh`,
    PLAYER_SKINS.trousers,
    [0, -0.15, 0],
    [0.235, LEG_LENGTH, 0.24]
  );
  const thighArmor = armor(
    rig,
    "legs",
    root,
    `${name}-leg-armor`,
    [0, -0.15, 0],
    [0.255, 0.31, 0.265]
  );
  const knee = joint(root, `${name}-knee`, 0, -LEG_LENGTH);
  const shin = box(
    rig,
    knee,
    `${name}-shin`,
    PLAYER_SKINS.trousers,
    [0, -0.15, 0],
    [0.235, LEG_LENGTH, 0.24]
  );
  const shinArmor = armor(
    rig,
    "legs",
    knee,
    `${name}-shin-armor`,
    [0, -0.108, 0],
    [0.255, 0.216, 0.265]
  );
  // Soles stay level at the independently solved ankle, including in crouch.
  const foot = joint(rig.root, `${name}-ankle`, side * 0.125, ANKLE_HEIGHT);
  const boot = box(
    rig,
    foot,
    `${name}-boot`,
    PLAYER_SKINS.boot,
    [0, -0.06, 0.04],
    [0.245, 0.12, 0.32]
  );
  armor(
    rig,
    "feet",
    foot,
    `${name}-boot-armor`,
    [0, -0.05, 0.04],
    [0.27, 0.14, 0.36]
  );
  rig.legs.push({ root, knee, foot, thigh, shin, boot, thighArmor, shinArmor, side });
}

/** CPU-only local rig. +Z is its face; no node aliases physical player state. */
export function createPlayerRig() {
  const rig = {
    root: new THREE.Group(),
    parts: [],
    arms: [],
    legs: [],
    equipment: {
      head: { item: null, parts: [] },
      chest: { item: null, parts: [] },
      legs: { item: null, parts: [] },
      feet: { item: null, parts: [] },
    },
    stride: 0,
    gait: 0,
  };
  rig.root.name = "Original human player rig";
  rig.torso = joint(rig.root, "torso");
  box(
    rig,
    rig.torso,
    "coat",
    PLAYER_SKINS.coat,
    [0, TORSO_LENGTH / 2, 0],
    [0.48, TORSO_LENGTH, 0.28]
  );
  armor(
    rig,
    "chest",
    rig.torso,
    "chest-armor",
    [0, TORSO_LENGTH / 2, 0],
    [0.515, 0.605, 0.315]
  );
  armor(rig, "legs", rig.torso, "waist-armor", [0, 0.06, 0], [0.5, 0.12, 0.31]);
  rig.head = joint(rig.root, "head");
  box(rig, rig.head, "face", PLAYER_SKINS.head, [0, 0, 0], [0.48, 0.48, 0.48]);
  armor(
    rig,
    "head",
    rig.head,
    "helmet-crown",
    [0, 0.235, 0],
    [0.51, 0.1, 0.51]
  );
  for (const side of [-1, 1])
    armor(
      rig,
      "head",
      rig.head,
      `helmet-side-${side}`,
      [side * 0.25, 0.05, 0],
      [0.035, 0.29, 0.5]
    );
  armor(
    rig,
    "head",
    rig.head,
    "helmet-back",
    [0, 0.05, -0.25],
    [0.5, 0.29, 0.035]
  );
  armor(
    rig,
    "head",
    rig.head,
    "helmet-brow",
    [0, 0.13, 0.25],
    [0.5, 0.07, 0.035]
  );
  // Facing +Z makes the player's own right hand the negative-X arm.
  rig.mainHand = buildArm(rig, -1);
  rig.offhand = buildArm(rig, 1);
  buildLeg(rig, -1);
  buildLeg(rig, 1);
  if (rig.parts.length > MAX_PLAYER_PARTS)
    throw new Error("Player rig exceeds its fixed instance budget");
  posePlayerRig(rig, 0, {});
  return rig;
}

/** Shared appearance lookup; never takes ownership of or edits the stack. */
export function getPlayerStackItem(stack) {
  if (
    !stack ||
    !Number.isSafeInteger(stack.id) ||
    stack.id <= 0 ||
    !Number.isSafeInteger(stack.count) ||
    stack.count <= 0
  )
    return null;
  const item = getItem(stack.id);
  return item && stack.count <= item.stackSize ? item : null;
}

export function getPlayerEquipmentItem(slot, stack) {
  const item = getPlayerStackItem(stack);
  return item?.kind === "equipment" && item.equipmentSlot === slot
    ? item
    : null;
}

function isShield(item) {
  return item?.tool === "shield";
}

function handBox(hand, index, skin, color, position, size, pitch = 0) {
  const part = hand.parts[index];
  part.visible = true;
  part.skin = skin;
  part.color.set(color);
  part.node.position.fromArray(position);
  part.node.scale.fromArray(size);
  part.node.rotation.set(pitch, 0, 0);
}

function updateHand(hand, stack) {
  const item = getPlayerStackItem(stack);
  if (hand.item === item) return;
  hand.item = item;
  for (const part of hand.parts) part.visible = false;
  if (!item) return;
  const color = item.color ?? WHITE;
  const wood = PLAYER_SKINS.wood;
  const tint = PLAYER_SKINS.tint;
  const metal = PLAYER_SKINS.metal;
  hand.root.rotation.set(Math.PI / 2, 0, 0);
  if (isShield(item)) {
    hand.root.rotation.x = -0.2;
    handBox(hand, 0, wood, WHITE, [0, 0, 0.08], [0.34, 0.48, 0.065]);
    handBox(hand, 1, metal, METAL, [0, 0.24, 0.08], [0.38, 0.055, 0.08]);
    handBox(hand, 2, metal, METAL, [0, -0.24, 0.08], [0.3, 0.055, 0.08]);
    handBox(hand, 3, metal, METAL, [0, 0, 0.14], [0.1, 0.12, 0.05]);
  } else if (item.kind === "block") {
    hand.root.rotation.x = 0;
    handBox(hand, 0, tint, color, [0, -0.04, 0.13], [0.235, 0.235, 0.235]);
  } else if (item.tool === "sword") {
    handBox(hand, 0, wood, WHITE, [0, 0.01, 0], [0.06, 0.19, 0.055]);
    handBox(hand, 1, tint, color, [0, 0.12, 0], [0.23, 0.045, 0.07]);
    handBox(hand, 2, tint, color, [0, 0.34, 0], [0.075, 0.42, 0.045]);
  } else if (
    item.tool === "pickaxe" ||
    item.tool === "axe" ||
    item.tool === "shovel"
  ) {
    handBox(hand, 0, wood, WHITE, [0, 0.12, 0], [0.055, 0.42, 0.055]);
    if (item.tool === "pickaxe") {
      handBox(hand, 1, tint, color, [0, 0.34, 0], [0.34, 0.075, 0.08]);
      handBox(hand, 2, tint, color, [0.14, 0.285, 0], [0.06, 0.14, 0.075]);
    } else if (item.tool === "axe") {
      handBox(hand, 1, tint, color, [0.08, 0.3, 0], [0.21, 0.23, 0.07]);
    } else {
      handBox(hand, 1, tint, color, [0, 0.36, 0], [0.17, 0.2, 0.07]);
    }
  } else if (item.tool === "bow") {
    hand.root.rotation.x = 0;
    handBox(hand, 0, wood, WHITE, [0, 0, 0.08], [0.055, 0.26, 0.055]);
    handBox(hand, 1, wood, WHITE, [0, 0.2, 0.02], [0.055, 0.22, 0.055], -0.45);
    handBox(hand, 2, wood, WHITE, [0, -0.2, 0.02], [0.055, 0.22, 0.055], 0.45);
    handBox(hand, 3, tint, WHITE, [0, 0, -0.06], [0.02, 0.62, 0.02]);
  } else if (item.id === ITEM.ARROW) {
    handBox(hand, 0, wood, WHITE, [0, 0.12, 0], [0.03, 0.5, 0.03]);
    handBox(hand, 1, metal, METAL, [0, 0.4, 0], [0.07, 0.1, 0.06]);
    handBox(hand, 2, tint, WHITE, [0, -0.08, 0], [0.12, 0.13, 0.025]);
  } else {
    hand.root.rotation.x = 0;
    handBox(hand, 0, tint, color, [0, 0.02, 0.12], [0.16, 0.2, 0.09]);
  }
}

function updateEquipment(gear, slot, stack) {
  const item = getPlayerEquipmentItem(slot, stack);
  if (gear.item === item) return;
  gear.item = item;
  for (const part of gear.parts) {
    part.visible = item !== null;
    part.color.set(item?.color ?? WHITE);
  }
}

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function legLengths(leg, thigh, shin) {
  leg.knee.position.y = -thigh;
  leg.thigh.node.position.y = -thigh / 2;
  leg.shin.node.position.y = -shin / 2;
  leg.thigh.node.scale.y = thigh;
  leg.shin.node.scale.y = shin;
  leg.thighArmor.node.position.y = -thigh / 2;
  leg.thighArmor.node.scale.y = thigh + 0.01;
  leg.shinArmor.node.position.y = -shin * 0.36;
  leg.shinArmor.node.scale.y = shin * 0.72;
}

function poseLeg(leg, hipY, hipZ, stride, lift) {
  const ankleY = ANKLE_HEIGHT + lift;
  const dy = hipY - ankleY;
  const dz = stride - hipZ;
  const distance = Math.hypot(dy, dz);
  // A small visual reach adjustment avoids snapping at full extension. This
  // never alters the simulated foot position, height, velocity or collision.
  const length = Math.max(LEG_LENGTH, distance / 2);
  const bend = Math.acos(Math.min(1, distance / (2 * length)));
  leg.root.position.set(leg.side * 0.125, hipY, hipZ);
  leg.root.rotation.set(-Math.atan2(dz, dy) - bend, 0, 0, "XYZ");
  leg.knee.rotation.set(bend * 2, 0, 0);
  legLengths(leg, length, length);
  leg.foot.position.set(leg.side * 0.125, ankleY, stride);
  leg.foot.rotation.set(0, 0, 0);
}

function poseHorseLeg(leg, hipY, hipZ) {
  // The coat's lower edge is the pelvis reference (~.72). Hips sit just inside
  // that hem, keeping the sideways thighs above the horse's 1.61-high back when
  // the physical seat feet offset is .95. Knees/shins hang OUTSIDE its .79-wide
  // body; boat-style forward legs would penetrate the neck and chest instead.
  const thigh = 0.39, shin = 0.4, hipX = leg.side * 0.16;
  const jointY = hipY + 0.1;
  leg.root.position.set(hipX, jointY, hipZ);
  leg.root.rotation.set(-Math.PI / 2, leg.side * Math.PI / 2, 0, "YXZ");
  leg.knee.rotation.set(Math.PI / 2, 0, 0);
  legLengths(leg, thigh, shin);
  leg.foot.position.set(hipX + leg.side * thigh, jointY - shin, hipZ);
  leg.foot.rotation.set(0, 0, 0);
}

/** Pose only; callers own camera placement, collisions, inventory and timing. */
export function posePlayerRig(rig, dt, state) {
  const step = Math.max(0, Math.min(0.1, finite(dt, 0)));
  const seated = state.seated === true;
  const horse = seated && state.vehicleType === "horse";
  const crouching = !seated && Boolean(state.crouching);
  const bodyHeight = THREE.MathUtils.clamp(
    finite(state.bodyHeight, crouching ? 1.5 : STANDING_HEIGHT),
    1.2,
    STANDING_HEIGHT
  );
  const eyeHeight = THREE.MathUtils.clamp(
    finite(state.eyeHeight, crouching ? 1.27 : STANDING_EYE_HEIGHT),
    0.9,
    bodyHeight - 0.1
  );
  const pitch = THREE.MathUtils.clamp(
    finite(state.pitch, 0),
    -Math.PI / 2,
    Math.PI / 2
  );
  const lean = crouching ? 0.35 : 0;
  const headExtent =
    0.24 * (Math.abs(Math.cos(pitch)) + Math.abs(Math.sin(pitch)));
  const neutralHeadY = Math.min(eyeHeight - 0.06, bodyHeight - 0.24);
  const headY = Math.min(neutralHeadY, bodyHeight - headExtent);
  const hipY = Math.max(
    ANKLE_HEIGHT + 0.15,
    neutralHeadY - 0.24 - TORSO_LENGTH * Math.cos(lean)
  );
  const hipZ = crouching ? -0.12 : 0;
  const moving = !seated && Boolean(state.moving);
  const sprinting = !seated && Boolean(state.sprinting) && !crouching;
  const target = moving ? (crouching ? 0.095 : sprinting ? 0.3 : 0.2) : 0;
  if (seated) rig.gait = rig.stride = 0;
  else rig.gait += (target - rig.gait) * Math.min(1, step * 14);
  if (moving)
    rig.stride =
      (rig.stride + step * (crouching ? 6 : sprinting ? 14 : 10)) %
      (Math.PI * 2);
  const swing = Math.sin(rig.stride) * rig.gait;
  const airborne = !seated && Math.abs(finite(state.velocityY, 0)) > 0.2;
  const lift = airborne ? 0 : Math.cos(rig.stride) * rig.gait * 0.18;
  const aimYaw = finite(state.yaw, 0);
  const bodyYaw = horse ? finite(state.hullYaw, aimYaw) : aimYaw;
  rig.root.rotation.y = bodyYaw + Math.PI;
  rig.torso.position.set(0, hipY, hipZ);
  rig.torso.rotation.x = lean;
  rig.head.position.set(0, headY, hipZ + TORSO_LENGTH * Math.sin(lean));
  // Only the appearance follows horse heading; yaw/pitch remain physical aim.
  const lookYaw = horse
    ? Math.atan2(Math.sin(aimYaw - bodyYaw), Math.cos(aimYaw - bodyYaw)) : 0;
  rig.head.rotation.set(-pitch, lookYaw, 0, horse ? "YXZ" : "XYZ");
  if (horse) {
    for (const leg of rig.legs) poseHorseLeg(leg, hipY, hipZ);
  } else if (seated) {
    // Horizontal thighs, bent knees and raised, level boots. This is a visual
    // pose inside the same feet/eye envelope, not a smaller world collider.
    const seatLift = Math.max(0, hipY - LEG_LENGTH - ANKLE_HEIGHT);
    for (const leg of rig.legs)
      poseLeg(leg, hipY, hipZ, hipZ + LEG_LENGTH, seatLift);
  } else {
    poseLeg(rig.legs[0], hipY, hipZ, swing, Math.max(0, lift));
    poseLeg(rig.legs[1], hipY, hipZ, -swing, Math.max(0, -lift));
  }
  updateHand(rig.mainHand, state.mainHand);
  updateHand(rig.offhand, state.offhand);
  for (let i = 0; i < rig.arms.length; i++) {
    const arm = rig.arms[i];
    const holding = arm.hand.item !== null;
    const holdPitch = holding ? (isShield(arm.hand.item) ? -0.5 : -0.28) : 0;
    arm.root.rotation.x =
      (seated ? -0.75 : -lean) +
      holdPitch +
      (i === 0 ? 1 : -1) * swing * (holding ? 1.2 : 2.1);
    arm.root.rotation.z = arm.side * (seated ? 0.08 : airborne ? 0.12 : 0.035);
  }
  updateEquipment(rig.equipment.head, "head", state.equipment?.head);
  updateEquipment(rig.equipment.chest, "chest", state.equipment?.chest);
  updateEquipment(rig.equipment.legs, "legs", state.equipment?.legs);
  updateEquipment(rig.equipment.feet, "feet", state.equipment?.feet);
  rig.root.updateMatrixWorld(true);
}
