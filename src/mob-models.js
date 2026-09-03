import * as THREE from "three";
import { animateAquaticMob } from "./aquatic-animation.js";
import { createAquaticModel } from "./aquatic-models.js";
import { AQUATIC_KINDS } from "./aquatic-skins.js";
import { ECOLOGY_SPECIES } from "./expansion-ecology.js";
import { HORSE_MAX_ELAPSED, HORSE_STRIDE_DISTANCE } from "./horse-definitions.js";
import { createMobSkin } from "./mob-skins.js";
import { animateNpcMob, createNpcModel } from "./npc-models.js";
import { NPC_KINDS } from "./npc-skins.js";

export const MAX_PARTS_PER_MOB = 72;
export const MAX_GEL_PARTS_PER_MOB = 6;

/**
 * Horse presentation contract: Wildlife publishes entity.horseView as a frozen
 * { tamed, saddled, ridden, grounded, swimming } snapshot of committed Horses
 * state. Missing view means untracked/unsaddled, never "holding a saddle".
 * Wildlife must use this predicate for BOTH instance batching and part picking.
 * Refresh the view after committed tack/rider/motion changes and on bind/load;
 * clear it when detached. "ridden" includes untamed/bareback, not just control.
 * The view and model.horseMotion are transient and must not enter mob saves.
 * No horse state is copied into the wolf-specific entity.tamed field.
 */
export function isMobPartVisible(part, entity) {
  if (part.condition === "horseSaddled")
    return entity?.kind === "horse" &&
      entity.horseView?.tamed === true && entity.horseView.saddled === true;
  return !part.condition || Boolean(entity?.[part.condition]);
}

function validateModelBudget(model) {
  if (model.parts.length > MAX_PARTS_PER_MOB)
    throw new Error(`Mob model exceeds instance budget: ${model.kind}`);
  if (
    model.parts.filter((part) => part.skin.translucent).length >
    MAX_GEL_PARTS_PER_MOB
  )
    throw new Error(`Mob gel exceeds instance budget: ${model.kind}`);
}

/** Fit the original neutral rig to its declared gameplay height, never derive
 * a collider from decorative spikes/fins. A separate parent preserves every
 * authored animation/rest coordinate and leaves root.scale for turtle age.
 */
function ecologyModel(model) {
  validateModelBudget(model);
  const scale = Math.min(1, ECOLOGY_SPECIES[model.kind].height / model.localBounds.max.y);
  if (scale < 1) {
    const display = new THREE.Group();
    display.name = "ecology-display-scale";
    display.scale.setScalar(scale);
    model.root.add(display);
    display.add(model.visual);
    model.localBounds.min.multiplyScalar(scale);
    model.localBounds.max.multiplyScalar(scale);
    model.pickFloor *= scale;
    model.pickHeight *= scale;
    model.pickRadius *= scale;
    model.root.updateWorldMatrix(true, true);
  }
  return model;
}

function rig(kind) {
  const root = new THREE.Group();
  const model = {
    kind,
    root,
    parts: [],
    legs: [],
    wings: [],
    head: null,
    tail: null,
  };
  model.box = (parent, role, x, y, z, sx, sy, sz, condition) => {
    const node = new THREE.Object3D();
    node.name = role;
    node.position.set(x, y, z);
    node.scale.set(sx, sy, sz);
    parent.add(node);
    const skin = createMobSkin(kind, role, [sx, sy, sz]);
    model.parts.push({
      node,
      role,
      skin,
      color: new THREE.Color(skin.baseColor),
      condition,
    });
    return node;
  };
  model.joint = (parent, x, y, z) => {
    const joint = new THREE.Group();
    joint.position.set(x, y, z);
    parent.add(joint);
    return joint;
  };
  return model;
}

function fourLegs(
  m,
  { width = 0.54, length = 0.88, height = 0.6, thickness = 0.19 }
) {
  for (const x of [-width / 2, width / 2]) {
    for (const z of [-length / 2, length / 2]) {
      const leg = m.joint(m.root, x, height, z);
      // Diagonal pairs step together, not both front feet against both rear.
      leg.userData.stridePhase = x * z > 0 ? 0 : Math.PI;
      leg.userData.ground = {
        height,
        halfDepth: (thickness + 0.055) / 2,
        z: 0.013,
      };
      m.box(leg, "leg", 0, -height / 2, 0, thickness, height, thickness);
      m.box(
        leg,
        "hoof",
        0,
        -height + 0.065,
        0.013,
        thickness + 0.02,
        0.13,
        thickness + 0.055
      );
      m.legs.push(leg);
    }
  }
}

function sheep(m) {
  m.box(m.root, "wool", 0, 0.83, -0.05, 0.82, 0.66, 1.2);
  m.box(m.root, "wool", 0, 0.89, -0.71, 0.2, 0.27, 0.2);
  fourLegs(m, { height: 0.54 });
  const h = (m.head = m.joint(m.root, 0, 1.01, 0.56));
  m.box(h, "head", 0, -0.015, 0.13, 0.43, 0.47, 0.47);
  m.box(h, "wool", 0, 0.24, 0.025, 0.49, 0.18, 0.44);
  for (const s of [-1, 1])
    m.box(h, "ear", s * 0.29, 0.045, 0.015, 0.18, 0.12, 0.17);
}

function pig(m) {
  m.box(m.root, "body", 0, 0.66, -0.05, 0.8, 0.62, 1.16);
  fourLegs(m, {
    height: 0.38,
    length: 0.77,
    thickness: 0.22,
  });
  const h = (m.head = m.joint(m.root, 0, 0.75, 0.51));
  m.box(h, "head", 0, 0, 0.08, 0.54, 0.46, 0.45);
  m.box(h, "muzzle", 0, -0.085, 0.36, 0.34, 0.21, 0.18);
  for (const s of [-1, 1]) {
    const ear = m.box(h, "ear", s * 0.22, 0.245, 0.02, 0.17, 0.17, 0.13);
    ear.rotation.z = -s * 0.3;
  }
  const tail = (m.tail = m.joint(m.root, 0, 0.72, -0.66));
  m.box(tail, "tail", 0.045, 0.015, -0.045, 0.1, 0.085, 0.14).rotation.z = -0.4;
  m.box(tail, "tail", 0.085, 0.095, -0.07, 0.075, 0.12, 0.075);
}

function cow(m, mushroom = false) {
  m.box(m.root, "body", 0, 1.02, -0.05, 0.92, 0.8, 1.4);
  m.box(m.root, "udder", 0, 0.58, -0.22, 0.35, 0.18, 0.38);
  fourLegs(m, {
    width: 0.66,
    length: 1,
    height: 0.7,
    thickness: 0.23,
  });
  const h = (m.head = m.joint(m.root, 0, 1.28, 0.69));
  m.box(h, "head", 0, 0, 0.08, 0.56, 0.58, 0.47);
  m.box(h, "muzzle", 0, -0.18, 0.35, 0.55, 0.23, 0.18);
  for (const s of [-1, 1]) {
    m.box(h, "ear", s * 0.36, 0.035, 0, 0.2, 0.15, 0.22);
    m.box(h, "horn", s * 0.23, 0.36, -0.04, 0.095, 0.27, 0.1).rotation.z =
      -s * 0.22;
  }
  const tail = (m.tail = m.joint(m.root, 0, 1.12, -0.78));
  m.box(tail, "tail", 0, -0.22, 0, 0.08, 0.48, 0.1);
  m.box(tail, "mane", 0, -0.49, 0, 0.15, 0.18, 0.16);
  if (mushroom) {
    for (const [x, z, height] of [
      [-0.2, -0.4, 0.32],
      [0.21, 0.19, 0.42],
      [0, -0.08, 0.21],
    ]) {
      m.box(m.root, "stem", x, 1.4 + height / 2, z, 0.11, height, 0.12);
      m.box(m.root, "mushroom", x, 1.42 + height, z, 0.42, 0.19, 0.39);
    }
  }
}

function chicken(m) {
  m.box(m.root, "body", 0, 0.52, -0.09, 0.43, 0.44, 0.55);
  for (const s of [-1, 1]) {
    const leg = m.joint(m.root, s * 0.13, 0.31, 0);
    leg.userData.ground = { height: 0.31, halfDepth: 0.1, z: 0.06 };
    m.box(leg, "beak", 0, -0.15, 0, 0.065, 0.3, 0.065);
    m.box(leg, "beak", 0, -0.285, 0.06, 0.16, 0.05, 0.2);
    m.legs.push(leg);
    const wing = m.joint(m.root, s * 0.215, 0.68, -0.06);
    m.box(wing, "wing", s * 0.025, -0.15, 0, 0.085, 0.32, 0.37);
    m.wings.push(wing);
  }
  const h = (m.head = m.joint(m.root, 0, 0.77, 0.21));
  m.box(h, "head", 0, 0, 0, 0.29, 0.35, 0.29);
  m.box(h, "beak", 0, -0.035, 0.225, 0.2, 0.105, 0.19);
  m.box(h, "wattle", 0, -0.175, 0.16, 0.09, 0.17, 0.09);
  m.box(h, "comb", 0, 0.205, -0.01, 0.075, 0.11, 0.18);
  m.box(m.root, "tail", 0, 0.68, -0.41, 0.23, 0.23, 0.18).rotation.x = -0.5;
}

function longLegged(m, camel = false) {
  m.box(m.root, "body", 0, camel ? 1.49 : 1.26, -0.05, 0.79, 0.7, 1.52);
  fourLegs(m, {
    width: 0.57,
    length: 1.04,
    height: camel ? 1.2 : 0.98,
    thickness: camel ? 0.18 : 0.2,
  });
  if (camel) {
    m.box(m.root, "hump", 0, 1.95, -0.19, 0.61, 0.48, 0.64);
    m.box(m.root, "hump", 0, 2.17, -0.19, 0.41, 0.15, 0.43);
  }
  const h = (m.head = m.joint(m.root, 0, camel ? 1.66 : 1.45, 0.64));
  m.box(h, "neck", 0, 0.25, 0.03, 0.32, camel ? 1.0 : 0.77, 0.37).rotation.x =
    -0.25;
  m.box(
    h,
    "head",
    0,
    camel ? 0.62 : 0.49,
    0.24,
    0.34,
    0.4,
    camel ? 0.57 : 0.69
  ).rotation.x = 0.23;
  m.box(
    h,
    "muzzle",
    0,
    camel ? 0.55 : 0.41,
    camel ? 0.56 : 0.61,
    0.35,
    0.22,
    0.15
  );
  for (const s of [-1, 1]) {
    m.box(
      h,
      "ear",
      s * 0.15,
      camel ? 0.87 : 0.82,
      -0.02,
      0.09,
      0.27,
      0.13
    ).rotation.z = s * 0.17;
  }
  if (!camel) {
    m.box(h, "mane", 0, 0.25, -0.2, 0.15, 0.8, 0.15).rotation.x = -0.25;
  }
  const tail = (m.tail = m.joint(m.root, 0, camel ? 1.66 : 1.5, -0.85));
  m.box(
    tail,
    "mane",
    0,
    -0.4,
    -0.08,
    camel ? 0.11 : 0.22,
    0.82,
    0.19
  ).rotation.x = 0.18;
}

function horse(m) {
  longLegged(m);
  // Build every conditional part up front, including its skin role. The lazy
  // atlas therefore knows all tack before freezing; equipping allocates nothing.
  const tack = (role, x, y, z, sx, sy, sz) =>
    m.box(m.root, role, x, y, z, sx, sy, sz, "horseSaddled");
  tack("saddle", 0, 1.64, -0.12, 0.72, 0.07, 0.66);
  tack("saddle", 0, 1.705, 0.24, 0.52, 0.11, 0.13);
  tack("saddle", 0, 1.705, -0.44, 0.62, 0.11, 0.13);
  for (const side of [-1, 1]) {
    tack("saddle", side * 0.415, 1.45, -0.12, 0.04, 0.37, 0.58);
    tack("saddle_strap", side * 0.405, 1.255, -0.07, 0.035, 0.69, 0.12);
    tack("saddle_strap", side * 0.48, 1.42, 0.07, 0.035, 0.38, 0.065);
    tack("saddle_iron", side * 0.53, 1.23, 0.07, 0.16, 0.04, 0.18);
  }
  tack("saddle_strap", 0, 0.9, -0.07, 0.82, 0.035, 0.12);
  // CPU-only animation history, not saved motion or a second horse pose owner.
  m.horseMotion = { x: NaN, z: NaN, moving: false, grounded: false, amplitude: 0 };
}

function rabbit(m) {
  m.box(m.root, "body", 0, 0.3, -0.09, 0.35, 0.36, 0.43);
  for (const s of [-1, 1]) {
    const leg = m.joint(m.root, s * 0.16, 0.19, -0.15);
    leg.userData.stridePhase = 0;
    leg.userData.ground = { height: 0.19, halfDepth: 0.175, z: 0.07 };
    m.box(leg, "hoof", 0, -0.095, 0.07, 0.17, 0.19, 0.35);
    m.legs.push(leg);
    m.box(m.root, "leg", s * 0.1, 0.14, 0.2, 0.085, 0.28, 0.11);
  }
  const h = (m.head = m.joint(m.root, 0, 0.49, 0.19));
  m.box(h, "head", 0, 0, 0, 0.29, 0.28, 0.29);
  for (const s of [-1, 1]) {
    const ear = m.joint(h, s * 0.09, 0.13, -0.06);
    m.box(ear, "ear", 0, 0.19, 0, 0.1, 0.4, 0.09);
    ear.rotation.z = -s * 0.13;
  }
  m.box(m.root, "tail_tip", 0, 0.34, -0.34, 0.18, 0.19, 0.18);
}

function canine(m, fox = false) {
  m.box(m.root, "body", 0, fox ? 0.43 : 0.65, -0.09, 0.44, 0.38, 0.95);
  m.box(
    m.root,
    "belly",
    0,
    fox ? 0.31 : 0.55,
    0.17,
    0.43,
    fox ? 0.2 : 0.33,
    0.39
  );
  fourLegs(m, {
    width: 0.34,
    length: 0.63,
    height: fox ? 0.3 : 0.49,
    thickness: 0.13,
  });
  const h = (m.head = m.joint(m.root, 0, fox ? 0.53 : 0.79, 0.42));
  m.box(h, "head", 0, 0, 0.04, fox ? 0.35 : 0.39, 0.34, 0.36);
  m.box(h, "muzzle", 0, -0.085, 0.285, fox ? 0.22 : 0.27, 0.19, 0.29);
  for (const s of [-1, 1]) {
    m.box(h, "ear", s * 0.13, 0.23, -0.04, 0.13, 0.22, 0.14).rotation.z =
      -s * 0.15;
  }
  if (!fox) m.box(h, "collar", 0, -0.17, -0.045, 0.405, 0.09, 0.29, "tamed");
  const tail = (m.tail = m.joint(m.root, 0, fox ? 0.49 : 0.69, -0.58));
  tail.rotation.x = fox ? -0.35 : 0.48;
  m.box(tail, "tail", 0, 0, -0.24, fox ? 0.26 : 0.15, fox ? 0.27 : 0.16, 0.51);
  m.box(
    tail,
    "tail_tip",
    0,
    0,
    -0.51,
    fox ? 0.24 : 0.14,
    fox ? 0.23 : 0.15,
    fox ? 0.2 : 0.1
  );
}

function goat(m) {
  m.box(m.root, "body", 0, 0.79, -0.05, 0.61, 0.6, 1.05);
  m.box(m.root, "belly", 0, 1.05, 0.19, 0.61, 0.24, 0.53);
  fourLegs(m, {
    width: 0.46,
    length: 0.74,
    height: 0.54,
    thickness: 0.14,
  });
  const h = (m.head = m.joint(m.root, 0, 1.11, 0.49));
  m.box(h, "head", 0, 0, 0.13, 0.35, 0.47, 0.43);
  m.box(h, "muzzle", 0, -0.16, 0.36, 0.23, 0.14, 0.15);
  m.box(h, "belly", 0, -0.4, 0.27, 0.12, 0.33, 0.16);
  for (const s of [-1, 1]) {
    m.box(h, "horn", s * 0.13, 0.42, -0.02, 0.11, 0.55, 0.12).rotation.x =
      -0.42;
    m.box(h, "ear", s * 0.27, 0.06, 0.06, 0.22, 0.1, 0.17);
  }
  m.box(m.root, "tail", 0, 0.99, -0.65, 0.16, 0.2, 0.25).rotation.x = 0.55;
}

function bear(m, panda = false) {
  m.box(
    m.root,
    "body",
    0,
    0.79,
    -0.13,
    panda ? 1.02 : 1.04,
    0.94,
    panda ? 1.25 : 1.72
  );
  fourLegs(m, {
    width: 0.68,
    length: panda ? 0.85 : 1.2,
    height: 0.46,
    thickness: 0.29,
  });
  const h = (m.head = m.joint(m.root, 0, 1.02, panda ? 0.57 : 0.85));
  m.box(h, "head", 0, 0, 0.03, panda ? 0.68 : 0.64, 0.59, 0.57);
  for (const s of [-1, 1]) {
    m.box(h, "ear", s * 0.25, 0.32, -0.07, 0.18, 0.2, 0.17);
  }
  m.box(h, "muzzle", 0, -0.12, 0.365, 0.33, 0.25, panda ? 0.22 : 0.29);
  m.box(m.root, "tail", 0, 0.8, panda ? -0.8 : -1.04, 0.17, 0.19, 0.18);
}

function frog(m) {
  m.box(m.root, "body", 0, 0.2, -0.08, 0.54, 0.28, 0.53);
  m.box(m.root, "belly", 0, 0.12, 0.08, 0.47, 0.18, 0.37);
  const h = (m.head = m.joint(m.root, 0, 0.27, 0.12));
  m.box(h, "head", 0, 0, 0, 0.6, 0.25, 0.41);
  for (const s of [-1, 1]) {
    m.box(h, "eye", s * 0.19, 0.16, 0.035, 0.17, 0.17, 0.21);
    const leg = m.joint(m.root, s * 0.255, 0.19, -0.2);
    m.box(leg, "leg", s * 0.015, -0.07, 0, 0.18, 0.2, 0.36);
    m.box(leg, "leg", s * 0.035, -0.16, 0.16, 0.18, 0.06, 0.2);
    m.legs.push(leg);
    m.box(m.root, "leg", s * 0.22, 0.055, 0.3, 0.11, 0.11, 0.18);
  }
}

function humanoid(m, kind) {
  const skeleton = kind === "skeleton" || kind === "stray";
  const husk = kind === "husk",
    piglin = kind === "piglin",
    stray = kind === "stray";
  const hip = 0.81;
  m.box(m.root, skeleton ? "pelvis" : "pants", 0, hip, 0, 0.46, 0.16, 0.26);
  for (const s of [-1, 1]) {
    const leg = m.joint(m.root, s * 0.16, hip, 0);
    leg.userData.ground = {
      height: hip,
      halfDepth: skeleton ? 0.065 : 0.17,
      z: skeleton ? 0 : 0.04,
    };
    m.box(
      leg,
      skeleton ? "bone" : "pants",
      0,
      -0.405,
      0,
      skeleton ? 0.12 : 0.27,
      0.81,
      skeleton ? 0.13 : 0.28
    );
    if (!skeleton) m.box(leg, "hoof", 0, -0.725, 0.04, 0.28, 0.17, 0.34);
    m.legs.push(leg);
  }
  if (skeleton) {
    m.box(m.root, "spine", 0, 1.17, -0.045, 0.105, 0.64, 0.12);
    for (let i = 0; i < 3; i++) {
      m.box(
        m.root,
        "rib",
        0,
        1.03 + i * 0.16,
        0,
        0.42 + i * 0.025,
        0.085,
        0.23
      );
    }
    m.box(m.root, "rib", 0, 1.47, 0, 0.62, 0.11, 0.2);
  } else m.box(m.root, "shirt", 0, 1.19, 0, 0.58, 0.65, 0.33);
  const h = (m.head = m.joint(m.root, 0, husk ? 1.6 : 1.66, 0));
  m.box(
    h,
    skeleton ? "skull" : "head",
    0,
    0.04,
    0,
    piglin ? 0.55 : 0.49,
    0.49,
    0.46
  );
  if (piglin) {
    m.box(h, "muzzle", 0, -0.055, 0.285, 0.35, 0.19, 0.17);
    for (const s of [-1, 1]) {
      m.box(h, "ear", s * 0.34, 0.14, -0.04, 0.21, 0.26, 0.14).rotation.z =
        -s * 0.42;
      m.box(h, "horn", s * 0.19, -0.1, 0.3, 0.07, 0.19, 0.09);
    }
    m.box(m.root, "collar", 0, 0.96, 0, 0.59, 0.075, 0.34);
  }
  if (husk) {
    m.box(h, "wrap", 0, 0.265, -0.015, 0.52, 0.14, 0.48);
  }
  if (stray) {
    m.box(h, "cloak", 0, 0.31, -0.06, 0.56, 0.12, 0.54);
    for (const s of [-1, 1])
      m.box(h, "cloak", s * 0.255, 0.09, -0.06, 0.06, 0.38, 0.5);
    m.box(m.root, "cloak", 0, 1.13, -0.17, 0.59, 0.72, 0.08);
    m.box(m.root, "cloak", 0, 1.46, 0, 0.65, 0.12, 0.38);
  }
  for (const s of [-1, 1]) {
    const arm = m.joint(m.root, s * 0.39, 1.46, 0);
    m.box(
      arm,
      skeleton ? "bone" : "arm",
      0,
      -0.34,
      0,
      skeleton ? 0.11 : 0.24,
      0.7,
      skeleton ? 0.12 : 0.25
    );
    arm.rotation.x = skeleton ? -0.8 : piglin ? -0.32 : -1.35;
    arm.userData.restPitch = arm.rotation.x;
    m.wings.push(arm);
    if (s === -1 && skeleton) {
      const bow = m.joint(arm, 0, -0.65, 0.04);
      for (let i = 0; i < 5; i++) {
        m.box(
          bow,
          "bow",
          0,
          (i - 2) * 0.14,
          0.12 - Math.abs(i - 2) * 0.065,
          0.065,
          0.18,
          0.07
        );
      }
      m.box(bow, "string", 0, 0, -0.05, 0.02, 0.65, 0.02);
    }
    if (s === 1 && piglin) {
      m.box(arm, "hilt", 0, -0.65, 0.19, 0.1, 0.12, 0.4);
      m.box(arm, "blade", 0, -0.65, 0.39, 0.3, 0.1, 0.1);
      m.box(arm, "blade", 0, -0.65, 0.75, 0.12, 0.09, 0.65);
    }
  }
}

function creeper(m) {
  m.box(m.root, "body", 0, 0.77, 0, 0.46, 0.86, 0.34);
  fourLegs(m, {
    width: 0.44,
    length: 0.33,
    height: 0.34,
    thickness: 0.23,
  });
  const h = (m.head = m.joint(m.root, 0, 1.345, 0));
  m.box(h, "head", 0, 0, 0, 0.62, 0.59, 0.57);
}

function spider(m) {
  m.box(m.root, "body", 0, 0.45, -0.31, 0.77, 0.49, 0.89);
  m.box(m.root, "thorax", 0, 0.4, 0.26, 0.46, 0.32, 0.48);
  const h = (m.head = m.joint(m.root, 0, 0.43, 0.56));
  m.box(h, "head", 0, 0, 0, 0.56, 0.32, 0.32);
  for (const s of [-1, 1])
    m.box(h, "claw", s * 0.14, -0.18, 0.13, 0.065, 0.17, 0.085);
  for (const s of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const leg = m.joint(m.root, s * 0.25, 0.44, -0.37 + i * 0.23);
      leg.rotation.y = s * (i - 1.5) * 0.43;
      leg.userData.stridePhase = ((i + (s > 0 ? 1 : 0)) % 2) * Math.PI;
      leg.userData.side = s;
      leg.userData.restYaw = leg.rotation.y;
      m.box(leg, "leg", s * 0.25, 0.03, 0, 0.54, 0.095, 0.1).rotation.z =
        s * 0.2;
      m.box(leg, "leg", s * 0.59, -0.188, 0, 0.095, 0.48, 0.1).rotation.z =
        s * 0.4;
      m.legs.push(leg);
    }
  }
}

function enderman(m) {
  m.box(m.root, "body", 0, 2.12, 0, 0.42, 0.87, 0.27);
  for (const s of [-1, 1]) {
    const leg = m.joint(m.root, s * 0.14, 1.78, 0);
    leg.userData.ground = { height: 1.78, halfDepth: 0.065, z: 0 };
    m.box(leg, "leg", 0, -0.89, 0, 0.125, 1.78, 0.13);
    m.legs.push(leg);
    const arm = m.joint(m.root, s * 0.3, 2.48, 0);
    m.box(arm, "arm", 0, -0.93, 0, 0.115, 1.92, 0.12);
    m.wings.push(arm);
  }
  m.box(m.root, "neck", 0, 2.58, 0, 0.18, 0.13, 0.17);
  // The eye row is at 2.855, matching the existing gameplay eye target.
  const h = (m.head = m.joint(m.root, 0, 2.82375, 0));
  m.stareTarget = m.box(h, "head", 0, 0, 0, 0.48, 0.5, 0.46);
}

function slime(m) {
  const core = (m.core = m.joint(m.root, 0, 0.55, 0));
  m.box(core, "gel_shell", 0, 0.02, 0, 1.02, 1.02, 1.02);
  m.box(core, "gel_cap", 0, 0.525, 0, 0.94, 0.065, 0.94);
  // A low spreading skirt gives the hopping body weight at ground contact.
  for (const x of [-0.27, 0.27])
    for (const z of [-0.27, 0.27])
      m.box(core, "gel_foot", x, -0.5, z, 0.5, 0.1, 0.5);
  // The inset face belongs to an opaque nucleus, wholly inside the clear shell.
  // Both use this ground-pivoted joint, so squash cannot expose the nucleus.
  m.box(core, "gel", 0, 0.02, 0.035, 0.64, 0.65, 0.64);
}

function sulfurCube(m) {
  const core = (m.core = m.joint(m.root, 0, 0.57, 0));
  m.box(core, "shell", 0, -0.02, 0, 1, 1.04, 0.98);
  m.box(core, "gel_cap", 0, 0.49, 0, 0.97, 0.11, 0.95);
  m.box(core, "shell_base", 0, -0.505, 0, 1.01, 0.13, 0.99);
  for (const s of [-1, 1]) {
    m.box(core, "crystal", s * 0.27, 0.615, -0.1, 0.16, 0.15, 0.19);
  }
  // White albedo on this one tinted part preserves the actual absorbed color.
  // Keep it last: the conditional core adds exactly one instance.
  m.box(core, "absorbed", 0, -0.27, 0.47, 0.47, 0.37, 0.13, "absorbedBlock");
  m.absorbedColors = [m.parts.at(-1).color];
}

function ghast(m) {
  const h = (m.head = m.joint(m.root, 0, 1.89, 0));
  m.box(h, "head", 0, 0, 0, 2.02, 1.88, 1.87);
  m.box(h, "belly", 0, -0.86, 0, 1.93, 0.2, 1.79);
  for (let i = 0; i < 9; i++) {
    const leg = m.joint(
      m.root,
      ((i % 3) - 1) * 0.61,
      1,
      (Math.floor(i / 3) - 1) * 0.6
    );
    const length = 0.65 + (i % 3) * 0.15;
    m.box(leg, "tentacle", 0, -length / 2, 0, 0.22, length, 0.22);
    m.legs.push(leg);
  }
}

function cod(m) {
  m.box(m.root, "head", 0, 0.2, 0, 0.24, 0.29, 0.69);
  m.box(m.root, "belly", 0, 0.12, 0, 0.25, 0.13, 0.59);
  m.box(m.root, "fin", 0, 0.37, -0.06, 0.055, 0.14, 0.22);
  for (const s of [-1, 1]) {
    m.box(m.root, "fin", s * 0.2, 0.17, -0.02, 0.2, 0.05, 0.23).rotation.y =
      -s * 0.55;
  }
  const tail = (m.tail = m.joint(m.root, 0, 0.2, -0.39));
  m.box(tail, "fin", 0, 0, -0.12, 0.055, 0.36, 0.29);
}

function squid(m) {
  m.box(m.root, "mantle", 0, 1.24, 0, 0.74, 1.08, 0.74);
  m.box(m.root, "mantle_cap", 0, 1.75, 0, 0.62, 0.12, 0.61);
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const leg = m.joint(
      m.root,
      Math.sin(angle) * 0.29,
      0.74,
      Math.cos(angle) * 0.29
    );
    leg.rotation.z = -Math.sin(angle) * 0.25;
    leg.rotation.x = Math.cos(angle) * 0.25;
    m.box(leg, "tentacle", 0, -0.35, 0, 0.13, 0.75, 0.13);
    m.legs.push(leg);
  }
}

export function createMobModel(kind) {
  // Visual support is independent of gameplay species/spawn registration.
  if (NPC_KINDS.includes(kind)) return ecologyModel(createNpcModel(kind));
  if (AQUATIC_KINDS.includes(kind)) return ecologyModel(createAquaticModel(kind));
  const builders = {
    sheep,
    pig,
    cow,
    chicken,
    rabbit,
    goat,
    frog,
    creeper,
    spider,
    enderman,
    slime,
    sulfur_cube: sulfurCube,
    ghast,
    cod,
    squid,
    mooshroom: (model) => cow(model, true),
    horse,
    camel: (model) => longLegged(model, true),
    wolf: canine,
    fox: (model) => canine(model, true),
    polar_bear: bear,
    panda: (model) => bear(model, true),
    zombie: (model) => humanoid(model, "zombie"),
    skeleton: (model) => humanoid(model, "skeleton"),
    husk: (model) => humanoid(model, "husk"),
    stray: (model) => humanoid(model, "stray"),
    piglin: (model) => humanoid(model, "piglin"),
  };
  if (!Object.hasOwn(builders, kind)) throw new Error(`Unknown mob: ${kind}`);
  const m = rig(kind);
  builders[kind](m);
  if (["zombie", "skeleton", "stray"].includes(kind)) {
    for (const s of [-1, 1]) {
      m.box(m.root, "flame", s * 0.3, 0.87, 0.17, 0.16, 0.73, 0.13, "burning");
      m.box(m.root, "flame", s * 0.3, 1.07, 0.18, 0.085, 0.62, 0.09, "burning");
    }
  }
  validateModelBudget(m);
  if (m.core) m.core.userData.restY = m.core.position.y;
  m.root.updateMatrixWorld(true);
  const unit = new THREE.Box3(
    new THREE.Vector3(-0.5, -0.5, -0.5),
    new THREE.Vector3(0.5, 0.5, 0.5)
  );
  const bounds = new THREE.Box3();
  for (const part of m.parts)
    bounds.union(unit.clone().applyMatrix4(part.node.matrixWorld));
  m.pickRadius =
    Math.hypot(
      Math.max(Math.abs(bounds.min.x), bounds.max.x),
      Math.max(Math.abs(bounds.min.z), bounds.max.z)
    ) + 0.15;
  m.pickHeight = bounds.max.y + 0.12;
  m.pickFloor = Math.min(0, bounds.min.y - 0.1);
  m.root.name = kind;
  return m;
}

const wrap = (value) => Math.atan2(Math.sin(value), Math.cos(value));

function horseGait(entity, dt) {
  const motion = entity.model.horseMotion;
  const { position, horseView } = entity;
  const step = Number.isFinite(dt) ? Math.max(0, Math.min(dt, HORSE_MAX_ELAPSED)) : 0;
  const distance = Math.hypot(position.x - motion.x, position.z - motion.z);
  motion.x = position.x;
  motion.z = position.z;
  // Untracked ground walkers already publish groundY/velocityY. Mounted horses
  // publish the physics result in horseView, including airborne and deep water.
  motion.grounded = horseView
    ? horseView.grounded === true && horseView.swimming !== true
    : Number.isFinite(entity.groundY) &&
      Math.abs(position.y - entity.groundY) < 0.02 &&
      Math.abs(entity.velocityY) < 0.1;
  // Reject first samples, zero-time refreshes and relocations. This is a visual
  // sampling bound, not a speed limit or a physics/AI movement decision.
  motion.moving = motion.grounded && step > 0 &&
    Number.isFinite(distance) && distance > 0.0001 && distance <= step * 16;
  motion.amplitude = motion.moving ? Math.min(0.65, distance / step * 0.11) : 0;
  if (motion.moving)
    entity.stride = (entity.stride + distance / HORSE_STRIDE_DISTANCE * Math.PI * 2) % (Math.PI * 2);
  return motion;
}

export function animateMob(entity, dt, elapsed, player) {
  if (NPC_KINDS.includes(entity.kind))
    return animateNpcMob(entity, dt, elapsed, player);
  if (AQUATIC_KINDS.includes(entity.kind))
    return animateAquaticMob(entity, dt, elapsed, player);
  const { model, position, spec } = entity;
  const horseMotion = entity.kind === "horse" ? horseGait(entity, dt) : null;
  const moving = horseMotion ? horseMotion.moving : entity.moving;
  if (!horseMotion) entity.stride += moving ? dt * (spec.speed * 5 + 3) : 0;
  const poseStep = horseMotion
    ? Number.isFinite(dt) ? Math.max(0, Math.min(dt, 0.1)) : 0
    : dt;
  model.legs.forEach((leg, i) => {
    const phase =
      entity.stride + (leg.userData.stridePhase ?? (i % 2 ? Math.PI : 0));
    if (entity.kind === "ghast" || entity.kind === "squid") {
      leg.rotation.x = Math.sin(elapsed * 2 + i * 0.7) * 0.24;
      leg.rotation.z = Math.cos(elapsed * 1.8 + i) * 0.23;
    } else if (entity.kind === "spider") {
      leg.rotation.y =
        leg.userData.restYaw + (moving ? Math.cos(phase) * 0.1 : 0);
      leg.rotation.z = moving
        ? leg.userData.side * Math.max(0, Math.sin(phase)) * 0.12
        : 0;
    } else {
      const target = moving
        ? Math.sin(phase) * (horseMotion?.amplitude ?? 0.36)
        : horseMotion && !horseMotion.grounded && entity.horseView?.swimming !== true
          ? (leg.position.z > 0 ? -0.25 : 0.2)
          : 0;
      leg.rotation.x += (target - leg.rotation.x) * Math.min(1, poseStep * 14);
      const ground = leg.userData.ground;
      if (ground) {
        const sine = Math.sin(leg.rotation.x);
        // Lift only the visual joint when a rotated square toe would clip
        // through the floor. The simulated root/collider never moves.
        leg.position.y =
          ground.height +
          Math.max(
            0,
            ground.height * (Math.cos(leg.rotation.x) - 1) +
              Math.abs(sine) * ground.halfDepth +
              sine * ground.z
          );
      }
    }
  });
  if (model.head) {
    const target =
      horseMotion && entity.horseView?.ridden === true
        ? 0
        : player && position.distanceToSquared(player) < 100
        ? Math.max(
            -0.65,
            Math.min(
              0.65,
              wrap(
                Math.atan2(player.x - position.x, player.z - position.z) -
                  model.root.rotation.y
              )
            )
          )
        : Math.sin(elapsed * 0.7 + entity.phase) * 0.07;
    model.head.rotation.y +=
      (target - model.head.rotation.y) * Math.min(1, poseStep * 5);
    if (["sheep", "cow", "mooshroom", "horse"].includes(entity.kind)) {
      const graze =
        !moving && !entity.angry && entity.wanderTimer > 1 &&
        (!horseMotion || (horseMotion.grounded && entity.horseView?.ridden !== true))
          ? 0.5 : 0;
      model.head.rotation.x +=
        (graze - model.head.rotation.x) * Math.min(1, poseStep * 3);
    }
  }
  if (model.tail)
    model.tail.rotation.y =
      Math.sin(elapsed * (entity.tamed ? 8 : 2) + entity.phase) *
      (entity.tamed ? 0.6 : 0.16);
  if (entity.kind === "chicken")
    model.wings.forEach((wing, i) => {
      wing.rotation.z =
        (i ? 1 : -1) *
        (0.08 +
          (entity.velocityY < -0.5
            ? Math.abs(Math.sin(elapsed * 20)) * 0.7
            : 0));
    });
  if (entity.kind === "enderman")
    model.wings.forEach((arm, i) => {
      arm.rotation.x = moving
        ? Math.sin(entity.stride + i * Math.PI) * 0.23
        : 0;
    });
  else if (
    ["zombie", "husk", "skeleton", "stray", "piglin"].includes(entity.kind)
  )
    model.wings.forEach((arm, i) => {
      arm.rotation.x =
        arm.userData.restPitch +
        (moving ? Math.sin(entity.stride + i * Math.PI) * 0.065 : 0);
    });
  if (model.core) {
    const squash =
      spec.hop === 0
        ? 1
        : entity.velocityY > 0.1
          ? 1.08
          : moving
            ? 0.96 + Math.sin(elapsed * 5) * 0.05
            : 1;
    model.core.scale.set(1 / Math.sqrt(squash), squash, 1 / Math.sqrt(squash));
    model.core.position.y = model.core.userData.restY * squash;
  }
  model.root.updateMatrixWorld(true);
}

export function createProjectileModel(kind) {
  const m = rig(kind === "arrow" ? "arrow" : "fireball");
  if (kind === "arrow") {
    m.box(m.root, "shaft", 0, 0, 0, 0.035, 0.035, 0.62);
    m.box(m.root, "arrowhead", 0, 0, 0.36, 0.075, 0.075, 0.13);
    m.box(m.root, "feather", 0, 0, -0.22, 0.18, 0.02, 0.16);
  } else {
    m.box(m.root, "fire", 0, 0, 0, 0.44, 0.44, 0.44);
    m.box(m.root, "flame", 0, 0, 0.18, 0.28, 0.28, 0.18);
    m.box(m.root, "ember", 0, 0, -0.3, 0.28, 0.29, 0.31);
  }
  return m;
}
