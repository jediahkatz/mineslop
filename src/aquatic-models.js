import * as THREE from "three";
import { AQUATIC_KINDS, createAquaticSkin } from "./aquatic-skins.js";

export const MAX_AQUATIC_PARTS_PER_MODEL = 32;

function rig(kind) {
  const root = new THREE.Group();
  root.name = kind;
  const visual = new THREE.Group();
  visual.name = "swim-pivot";
  root.add(visual);
  const model = {
    kind,
    root,
    visual,
    parts: [],
    legs: [],
    arms: [],
    wings: [],
    flippers: [],
    head: null,
    tail: null,
    eye: null,
    animation: {
      swim: null,
      head: null,
      tail: [],
      flippers: [],
      arms: [],
      elbows: [],
      legs: [],
      knees: [],
      spikes: [],
      eye: null,
    },
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
    // Keep the existing role/node.name convention; part.name is unique.
    node.name = role;
    node.position.fromArray(position);
    node.scale.fromArray(size);
    parent.add(node);
    const skin = createAquaticSkin(kind, role, size);
    model.parts.push({
      name,
      role,
      node,
      skin,
      color: new THREE.Color(skin.baseColor),
    });
    return node;
  };
  return model;
}

function swing(node, axis, amplitude, phase = 0) {
  return {
    node,
    property: "rotation",
    axis,
    rest: node.rotation[axis],
    amplitude,
    phase,
  };
}

function head(m, position, yawLimit, pitchLimit) {
  const node = (m.head = m.joint(m.visual, "head-pivot", position));
  // Yaw about the neck, then pitch about the turned head's local X axis.
  node.rotation.order = "YXZ";
  m.animation.head = {
    node,
    yawAxis: "y",
    pitchAxis: "x",
    yawLimit,
    pitchLimit,
    restRotation: node.rotation.toArray().slice(0, 3),
  };
  return node;
}

function dolphin(m) {
  m.box(m.visual, "torso", "body", [0, 0, 0.04], [0.55, 0.44, 1.06]);
  m.box(m.visual, "underside", "belly", [0, -0.19, 0.09], [0.48, 0.1, 0.94]);
  const h = head(m, [0, 0.015, 0.49], 0.22, 0.18);
  m.box(h, "forehead", "head", [0, 0, 0.08], [0.45, 0.36, 0.45]);
  m.box(h, "rostrum", "snout", [0, -0.09, 0.46], [0.28, 0.16, 0.45]);
  m.box(h, "lower-jaw", "belly", [0, -0.176, 0.46], [0.26, 0.05, 0.43]);
  m.box(
    m.visual,
    "dorsal-base",
    "dorsal_fin",
    [0, 0.29, -0.1],
    [0.1, 0.19, 0.32]
  );
  m.box(
    m.visual,
    "dorsal-tip",
    "dorsal_fin",
    [0, 0.44, -0.17],
    [0.08, 0.17, 0.18]
  ).rotation.x = -0.15;
  for (const side of [-1, 1]) {
    const name = side < 0 ? "right" : "left";
    const fin = m.joint(m.visual, `${name}-flipper`, [
      side * 0.24,
      -0.07,
      0.19,
    ]);
    fin.rotation.set(0, -side * 0.35, -side * 0.18);
    m.box(
      fin,
      `${name}-flipper-base`,
      "flipper",
      [side * 0.21, -0.055, -0.07],
      [0.48, 0.095, 0.29]
    );
    m.box(
      fin,
      `${name}-flipper-tip`,
      "flipper",
      [side * 0.44, -0.055, -0.16],
      [0.18, 0.07, 0.2]
    );
    m.flippers.push(fin);
    m.animation.flippers.push({ ...swing(fin, "z", side * 0.2), side });
  }
  const tail = (m.tail = m.joint(
    m.visual,
    "tail-base-pivot",
    [0, -0.015, -0.5]
  ));
  m.box(tail, "tail-base", "tail", [0, 0, -0.23], [0.31, 0.28, 0.48]);
  const tip = m.joint(tail, "tail-tip-pivot", [0, 0, -0.43]);
  m.box(tip, "tail-tip", "tail", [0, 0, -0.14], [0.2, 0.16, 0.3]);
  const flukes = m.joint(tip, "flukes-pivot", [0, 0, -0.27]);
  for (const side of [-1, 1])
    m.box(
      flukes,
      `${side < 0 ? "right" : "left"}-fluke`,
      "tail_fin",
      [side * 0.2, 0, -0.04],
      [0.4, 0.08, 0.27]
    ).rotation.y = side * 0.32;
  // Cetacean flukes beat vertically, unlike the guardian's lateral fish tail.
  m.animation.tail.push(
    swing(tail, "x", 0.22),
    swing(tip, "x", 0.28, -0.6),
    swing(flukes, "x", 0.18, -1.2)
  );
}

function turtle(m) {
  m.box(m.visual, "torso", "body", [0, 0, -0.06], [0.78, 0.22, 1]);
  m.box(m.visual, "plastron", "belly", [0, -0.12, -0.08], [0.75, 0.08, 0.96]);
  m.box(
    m.visual,
    "shell-rim",
    "shell_rim",
    [0, 0.12, -0.1],
    [0.98, 0.18, 1.22]
  );
  m.box(m.visual, "carapace", "shell", [0, 0.3, -0.12], [0.88, 0.32, 1.08]);
  m.box(m.visual, "shell-crown", "shell", [0, 0.51, -0.16], [0.65, 0.12, 0.84]);
  const h = head(m, [0, 0.03, 0.54], 0.4, 0.22);
  m.box(h, "neck", "neck", [0, 0, 0.01], [0.26, 0.18, 0.28]);
  m.box(h, "face", "head", [0, 0.01, 0.25], [0.38, 0.28, 0.38]);
  for (const side of [-1, 1]) {
    for (const front of [true, false]) {
      const name = `${front ? "front" : "rear"}-${side < 0 ? "right" : "left"}`;
      const fin = m.joint(m.visual, `${name}-flipper`, [
        side * 0.38,
        -0.05,
        front ? 0.3 : -0.47,
      ]);
      fin.rotation.y = side * (front ? -0.28 : 0.35);
      m.box(
        fin,
        `${name}-paddle`,
        "flipper",
        [side * (front ? 0.24 : 0.17), 0, front ? 0.03 : -0.08],
        front ? [0.57, 0.09, 0.35] : [0.4, 0.08, 0.27]
      );
      if (front)
        m.box(
          fin,
          `${name}-paddle-tip`,
          "flipper",
          [side * 0.46, 0, 0.16],
          [0.2, 0.075, 0.27]
        );
      m.flippers.push(fin);
      m.animation.flippers.push({
        ...swing(
          fin,
          front ? "z" : "y",
          side * (front ? 0.38 : 0.24),
          front ? 0 : Math.PI
        ),
        side,
        front,
      });
    }
  }
  const tail = (m.tail = m.joint(m.visual, "tail-pivot", [0, -0.03, -0.69]));
  m.box(tail, "tail", "tail", [0, 0, -0.08], [0.14, 0.12, 0.22]);
  m.animation.tail.push(swing(tail, "y", 0.12));
}

function drowned(m) {
  m.box(m.visual, "tunic", "shirt", [0, 1.18, 0], [0.56, 0.64, 0.33]);
  m.box(m.visual, "waist", "pants", [0, 0.815, 0], [0.49, 0.17, 0.28]);
  const h = head(m, [0, 1.675, 0.015], 0.65, 0.45);
  m.box(h, "face", "head", [0, 0.025, 0], [0.49, 0.49, 0.46]);
  m.box(h, "kelp-crown", "kelp", [-0.14, 0.3, -0.1], [0.16, 0.08, 0.29]);
  m.box(h, "kelp-trail", "kelp", [-0.2, 0.13, -0.24], [0.065, 0.3, 0.055]);
  for (const side of [-1, 1]) {
    const name = side < 0 ? "right" : "left";
    const phase = side < 0 ? 0 : Math.PI;
    m.box(
      m.visual,
      `${name}-torn-hem`,
      "shirt",
      [side * 0.18, side < 0 ? 0.82 : 0.78, 0],
      [0.18, side < 0 ? 0.18 : 0.26, 0.34]
    );
    const leg = m.joint(m.visual, `${name}-hip`, [side * 0.15, 0.81, 0]);
    leg.userData.ground = { height: 0.81, halfDepth: 0.155, z: 0.03 };
    leg.userData.stridePhase = phase;
    m.box(leg, `${name}-thigh`, "pants", [0, -0.2, 0], [0.25, 0.4, 0.26]);
    const knee = m.joint(leg, `${name}-knee`, [0, -0.4, 0]);
    m.box(knee, `${name}-shin`, "leg", [0, -0.16, 0], [0.23, 0.32, 0.25]);
    m.box(knee, `${name}-foot`, "foot", [0, -0.34, 0.03], [0.25, 0.14, 0.31]);
    m.legs.push(leg);
    m.animation.legs.push(swing(leg, "x", 0.36, phase));
    m.animation.knees.push(swing(knee, "x", 0.22, phase));
    const arm = m.joint(m.visual, `${name}-shoulder`, [side * 0.4, 1.45, 0]);
    arm.rotation.set(side < 0 ? -1.05 : -0.82, 0, side * 0.08);
    arm.userData.restPitch = arm.rotation.x;
    m.box(arm, `${name}-sleeve`, "sleeve", [0, -0.17, 0], [0.23, 0.34, 0.25]);
    const elbow = m.joint(arm, `${name}-elbow`, [0, -0.34, 0]);
    elbow.rotation.x = -0.15;
    m.box(elbow, `${name}-forearm`, "arm", [0, -0.135, 0], [0.21, 0.27, 0.22]);
    m.box(elbow, `${name}-hand`, "hand", [0, -0.34, 0.01], [0.23, 0.16, 0.25]);
    m.arms.push(arm);
    m.wings.push(arm);
    m.animation.arms.push(swing(arm, "x", 0.24, phase + Math.PI));
    m.animation.elbows.push(swing(elbow, "x", 0.12, phase));
  }
}

function guardian(m, elder = false) {
  const factor = elder ? 1.7 : 1;
  const scaled = (values) => values.map((value) => value * factor);
  const box = (parent, name, role, position, size) =>
    m.box(parent, name, role, scaled(position), scaled(size));
  const joint = (parent, name, position) =>
    m.joint(parent, name, scaled(position));
  box(m.visual, "carved-body", "body", [0, 0, 0], [0.95, 0.88, 0.88]);
  box(
    m.visual,
    "optic-rim",
    "eye_socket",
    [0, 0.05, 0.493],
    [0.53, 0.49, 0.115]
  );
  const eye = (m.eye = joint(m.visual, "eye-target", [0, 0.05, 0.558]));
  box(eye, "tracking-eye", "eye", [0, 0, 0], [0.27, 0.24, 0.045]);
  m.animation.eye = {
    node: eye,
    property: "position",
    axes: ["x", "y"],
    forwardAxis: "z",
    targetSpace: "parent-local",
    restPosition: eye.position.toArray(),
    maxOffset: [0.1 * factor, 0.08 * factor],
  };
  const directions = [
    [1, 0, 0.12],
    [-1, 0, 0.12],
    [0, 1, 0.08],
    [0, -1, 0.08],
    [1, 1, -0.45],
    [-1, 1, -0.45],
    [1, -1, -0.45],
    [-1, -1, -0.45],
    [0, 1, -1],
    [0, -1, -1],
  ];
  for (const [index, components] of directions.entries()) {
    const direction = new THREE.Vector3(...components).normalize();
    const halfSize = [0.475, 0.44, 0.44];
    const distance =
      Math.min(
        ...direction
          .toArray()
          .map((value, axis) =>
            value === 0 ? Infinity : halfSize[axis] / Math.abs(value)
          )
      ) - 0.055;
    const spike = joint(
      m.visual,
      `spike-${index}-pivot`,
      direction.clone().multiplyScalar(distance).toArray()
    );
    spike.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
    box(
      spike,
      `spike-${index}-base`,
      "spike",
      [0, 0.12, 0],
      [0.12, 0.24, 0.12]
    );
    box(
      spike,
      `spike-${index}-tip`,
      "spike_tip",
      [0, 0.33, 0],
      [0.065, 0.2, 0.065]
    );
    m.animation.spikes.push({
      node: spike,
      property: "scale",
      axis: "y",
      rest: 1,
      min: 0.3,
      max: 1,
      direction: direction.toArray(),
    });
  }
  let parent = m.visual;
  let position = [0, -0.08, -0.44];
  for (const [index, size] of [
    [0.3, 0.28, 0.43],
    [0.22, 0.21, 0.34],
    [0.13, 0.14, 0.26],
  ].entries()) {
    const tail = joint(parent, `tail-${index}-pivot`, position);
    if (index === 0) m.tail = tail;
    box(tail, `tail-${index}`, "tail", [0, 0, -size[2] / 2], size);
    m.animation.tail.push(swing(tail, "y", 0.22 + index * 0.1, -index * 0.65));
    parent = tail;
    position = [0, 0, -size[2]];
  }
  const fin = joint(parent, "tail-fin-pivot", position);
  for (const side of [-1, 1])
    box(
      fin,
      `${side < 0 ? "lower" : "upper"}-tail-fin`,
      "tail_fin",
      [0, side * 0.17, -0.08],
      [0.075, 0.3, 0.26]
    ).rotation.x = side * 0.28;
  if (elder) {
    box(
      m.visual,
      "ancient-crown",
      "plate",
      [0, 0.48, -0.02],
      [0.76, 0.09, 0.71]
    );
    for (const side of [-1, 1])
      box(
        m.visual,
        `${side < 0 ? "right" : "left"}-ancient-plate`,
        "plate",
        [side * 0.485, -0.05, -0.04],
        [0.12, 0.6, 0.67]
      );
  }
}

const unitBox = new THREE.Box3(
  new THREE.Vector3(-0.5, -0.5, -0.5),
  new THREE.Vector3(0.5, 0.5, 0.5)
);

function bounds(m) {
  m.root.updateMatrixWorld(true);
  const result = new THREE.Box3();
  for (const part of m.parts)
    result.union(unitBox.clone().applyMatrix4(part.node.matrixWorld));
  return result;
}

/**
 * CPU-only cuboid rig, facing +Z, grounded at local Y=0 in its neutral pose.
 * root is caller-owned physical state; visual is the independent swim pivot.
 * Rotation hooks use rest + sin(phase + swimPhase) * amplitude (radians).
 * Spike hooks scale local Y in [min,max]; eye targeting translates from
 * restPosition within maxOffset in its parent's local XY plane.
 * localBounds and pick extents describe the neutral pose, not a swim collider.
 * No animator, species registration, collision rules, or GPU resources here.
 */
export function createAquaticModel(kind) {
  if (!AQUATIC_KINDS.includes(kind))
    throw new Error(`Unknown aquatic model: ${kind}`);
  const m = rig(kind);
  const builders = {
    dolphin,
    turtle,
    drowned,
    guardian,
    elder_guardian: (model) => guardian(model, true),
  };
  builders[kind](m);
  if (m.parts.length > MAX_AQUATIC_PARTS_PER_MODEL)
    throw new Error(`Aquatic model exceeds instance budget: ${kind}`);
  m.visual.position.y -= bounds(m).min.y;
  m.localBounds = bounds(m);
  m.animation.swim = {
    node: m.visual,
    pitchAxis: "x",
    maxPitch: Math.PI / 2,
    restPosition: m.visual.position.toArray(),
    restRotation: m.visual.rotation.toArray().slice(0, 3),
  };
  const { min, max } = m.localBounds;
  m.pickRadius =
    Math.hypot(
      Math.max(Math.abs(min.x), max.x),
      Math.max(Math.abs(min.z), max.z)
    ) + 0.15;
  m.pickHeight = max.y + 0.12;
  m.pickFloor = Math.min(0, min.y - 0.1);
  return m;
}
