import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { animateAquaticMob } from "../src/aquatic-animation.js";
import { AQUATIC_KINDS } from "../src/aquatic-skins.js";
import { animateMob, createMobModel } from "../src/mob-models.js";

function entityFor(kind, fields = {}) {
  const model = createMobModel(kind);
  model.root.position.set(2, 9, -3);
  model.root.rotation.y = 0.4;
  return {
    kind,
    model,
    position: model.root.position,
    spec: { speed: 1 },
    moving: true,
    phase: 0.3,
    stride: 17,
    velocityY: -0.5,
    yaw: 0.4,
    ...fields,
  };
}

function pose(model) {
  const transforms = [];
  model.root.traverse((node) => {
    transforms.push([
      node.position.toArray(),
      node.rotation.toArray(),
      node.scale.toArray(),
    ]);
  });
  return transforms;
}

function assertLimits(model) {
  const hooks = model.animation;
  for (const name of ["tail", "flippers", "arms", "elbows", "legs", "knees"]) {
    for (const hook of hooks[name]) {
      const actual = hook.node[hook.property][hook.axis];
      const amplitude = Math.abs(hook.amplitude);
      assert.ok(Number.isFinite(actual), `${model.kind}/${name}`);
      assert.ok(actual >= hook.rest - amplitude - 1e-12);
      assert.ok(actual <= hook.rest + amplitude + 1e-12);
      if (name === "knees") assert.ok(actual >= hook.rest - 1e-12);
    }
  }
  const swim = hooks.swim;
  assert.ok(
    Math.abs(swim.node.rotation[swim.pitchAxis] - swim.restRotation[0]) <=
      swim.maxPitch + 1e-12
  );
  if (hooks.head) {
    const head = hooks.head;
    assert.ok(
      Math.abs(head.node.rotation[head.yawAxis] - head.restRotation[1]) <=
        head.yawLimit + 1e-12
    );
    assert.ok(
      Math.abs(head.node.rotation[head.pitchAxis] - head.restRotation[0]) <=
        head.pitchLimit + 1e-12
    );
  }
  if (hooks.eye) {
    const eye = hooks.eye;
    for (const [i, axis] of eye.axes.entries())
      assert.ok(
        Math.abs(eye.node.position[axis] - eye.restPosition[i]) <=
          eye.maxOffset[i] + 1e-12
      );
    assert.equal(eye.node.position.z, eye.restPosition[2]);
  }
  for (const hook of hooks.spikes) {
    const actual = hook.node[hook.property][hook.axis];
    assert.ok(actual >= hook.min - 1e-12 && actual <= hook.max + 1e-12);
  }
  for (const part of model.parts)
    assert.ok(part.node.matrixWorld.elements.every(Number.isFinite));
}

test("animateMob dispatches to the actual aquatic adapter without the legacy tail or stride pass", () => {
  const player = Object.freeze({ x: 4, y: 11, z: 6 });
  for (const kind of AQUATIC_KINDS) {
    const direct = entityFor(kind, { swimming: true, swimPitch: 0.25 });
    const routed = entityFor(kind, { swimming: true, swimPitch: 0.25 });
    for (let frame = 0; frame < 4; frame++) {
      animateAquaticMob(direct, 0.05, frame * 0.05, player);
      animateMob(routed, 0.05, frame * 0.05, player);
      assert.deepEqual(pose(routed.model), pose(direct.model));
      assert.equal(routed.stride, 17);
      assertLimits(routed.model);
    }
  }
});

test("animation changes only visual nodes, never frozen physical transforms or entity fields", () => {
  for (const kind of AQUATIC_KINDS) {
    const entity = entityFor(kind, {
      swimming: true,
      swimPitch: 0.6,
      beamCharge: 0.7,
      eyeTarget: Object.freeze({ x: 6, y: 12, z: 7 }),
    });
    const { model } = entity;
    const physical = [
      model.root.position.toArray(),
      model.root.rotation.toArray(),
      model.root.quaternion.toArray(),
      model.root.scale.toArray(),
    ];
    const neutralBounds = model.localBounds.clone();
    const picking = [model.pickFloor, model.pickHeight, model.pickRadius];
    const before = pose(model);
    const parts = model.parts;
    const skins = parts.map((part) => part.skin);
    const colors = parts.map((part) => part.color.toArray());
    const nodes = [];
    const childLists = [];
    model.root.traverse((node) => {
      nodes.push(node);
      childLists.push(node.children);
    });
    Object.freeze(model.root.position);
    Object.freeze(model.root.rotation);
    Object.freeze(model.root.quaternion);
    Object.freeze(model.root.scale);
    Object.freeze(entity.spec);
    Object.freeze(entity);
    for (let frame = 0; frame < 24; frame++) {
      animateMob(entity, 0.025, frame * 0.025);
      assertLimits(model);
    }
    assert.notDeepEqual(pose(model), before);
    assert.deepEqual(
      [
        model.root.position.toArray(),
        model.root.rotation.toArray(),
        model.root.quaternion.toArray(),
        model.root.scale.toArray(),
      ],
      physical
    );
    assert.equal(entity.stride, 17);
    assert.equal(entity.phase, 0.3);
    assert.equal(entity.velocityY, -0.5);
    assert.equal(entity.yaw, 0.4);
    assert.deepEqual(model.localBounds, neutralBounds);
    assert.deepEqual(
      [model.pickFloor, model.pickHeight, model.pickRadius],
      picking
    );
    assert.equal(model.parts, parts);
    for (let i = 0; i < parts.length; i++) {
      assert.equal(parts[i].skin, skins[i]);
      assert.deepEqual(parts[i].color.toArray(), colors[i]);
    }
    const afterNodes = [];
    model.root.traverse((node) => afterNodes.push(node));
    assert.deepEqual(afterNodes, nodes);
    for (let i = 0; i < nodes.length; i++)
      assert.equal(nodes[i].children, childLists[i]);
  }
});

test("non-positive and non-finite dt freeze poses and do not seed or advance the visual clock", () => {
  for (const kind of AQUATIC_KINDS) {
    const paused = entityFor(kind, { swimming: true, swimPitch: 0.25 });
    const control = entityFor(kind, { swimming: true, swimPitch: 0.25 });
    const initial = pose(paused.model);
    animateMob(paused, 0, 90_000);
    assert.deepEqual(pose(paused.model), initial);
    animateMob(paused, 0.05, 0);
    animateMob(control, 0.05, 0);
    const before = pose(paused.model);
    for (const dt of [0, -1, NaN, Infinity, -Infinity, undefined]) {
      animateMob(
        {
          ...paused,
          moving: false,
          swimming: false,
          swimPitch: 100,
          lookYaw: -100,
          lookPitch: 100,
          beamCharge: 1,
          spikesExtended: false,
        },
        dt,
        900_000,
        { x: -100, y: 100, z: 100 }
      );
      assert.deepEqual(pose(paused.model), before, `${kind}/${dt}`);
    }
    animateMob(paused, 0.05, 900_001);
    animateMob(control, 0.05, 0.05);
    assert.deepEqual(pose(paused.model), pose(control.model));
  }
});

test("large frame steps are capped and paused frames still refresh caller-owned root movement", () => {
  for (const kind of AQUATIC_KINDS) {
    const capped = entityFor(kind, { swimming: true });
    const delayed = entityFor(kind, { swimming: true });
    animateMob(capped, 0.1, 0);
    animateMob(delayed, 1000, 0);
    assert.deepEqual(pose(delayed.model), pose(capped.model));
    const before = pose(delayed.model).slice(1);
    const part = delayed.model.parts[0].node;
    const worldX = part.matrixWorld.elements[12];
    delayed.model.root.position.x += 31;
    animateMob(delayed, 0, 900_000);
    assert.deepEqual(pose(delayed.model).slice(1), before);
    assert.ok(Math.abs(part.matrixWorld.elements[12] - worldX - 31) < 1e-9);
  }
});

test("tail axes, mirrored paddles and humanoid joints follow their declared animation hooks", () => {
  for (const kind of AQUATIC_KINDS) {
    const entity = entityFor(kind, { swimming: true });
    animateMob(entity, 0.1, 0.4);
    const { model } = entity;
    assertLimits(model);
    for (const hook of model.animation.tail)
      assert.ok(Math.abs(hook.node.rotation[hook.axis] - hook.rest) > 1e-6);
    if (kind === "dolphin") {
      assert.equal(
        model.tail.rotation.y,
        0,
        "no legacy yaw wag over the fluke beat"
      );
      assert.ok(Math.abs(model.tail.rotation.x) > 0.01);
    }
    if (kind === "guardian" || kind === "elder_guardian") {
      assert.equal(model.tail.rotation.x, 0);
      assert.ok(Math.abs(model.tail.rotation.y) > 0.01);
    }
    for (const hook of model.animation.flippers)
      assert.ok(Math.abs(hook.node.rotation[hook.axis] - hook.rest) > 1e-6);
    if (kind === "drowned") {
      assert.ok(model.legs.every((node) => Math.abs(node.rotation.x) > 0.01));
      assert.ok(
        Math.abs(model.legs[0].rotation.x + model.legs[1].rotation.x) < 1e-10
      );
      assert.ok(
        model.animation.knees.some((hook) => hook.node.rotation.x > hook.rest)
      );
      assert.ok(
        model.animation.elbows.every(
          (hook) => Math.abs(hook.node.rotation.x - hook.rest) > 1e-6
        )
      );
    }
  }
});

test("minimal defaults, extreme controls and invalid targets remain finite and within rig limits", () => {
  for (const kind of AQUATIC_KINDS) {
    const minimal = { kind, model: createMobModel(kind) };
    animateMob(minimal, 0.1, undefined);
    assertLimits(minimal.model);
    const extreme = entityFor(kind, {
      swimming: true,
      swimPitch: 1e300,
      lookYaw: -1e300,
      lookPitch: 1e300,
      phase: 1e300,
      beamCharge: 1e300,
      spikesExtended: -1e300,
      spec: { speed: 1e300 },
      lookTarget: { x: NaN, y: Infinity, z: 0 },
      eyeTarget: { x: 0, y: 0, z: -Infinity },
    });
    animateMob(extreme, 1000, 1e300);
    assertLimits(extreme.model);
    assert.equal(
      extreme.model.visual.rotation.x,
      extreme.model.animation.swim.maxPitch
    );
    const head = extreme.model.animation.head;
    if (head) {
      assert.equal(head.node.rotation.y, -head.yawLimit);
      assert.equal(head.node.rotation.x, head.pitchLimit);
    }
    Object.assign(extreme, {
      swimPitch: NaN,
      lookYaw: Infinity,
      lookPitch: NaN,
      beamCharge: NaN,
      spikesExtended: Infinity,
      spec: { speed: NaN },
    });
    animateMob(extreme, 0.1, NaN);
    assertLimits(extreme.model);
    assert.equal(extreme.model.visual.rotation.x, 0);
  }
  assert.throws(
    () =>
      animateAquaticMob({ kind: "cow", model: createMobModel("cow") }, 0.1, 0),
    /matching aquatic model/
  );
  assert.throws(
    () =>
      animateAquaticMob(
        { kind: "guardian", model: createMobModel("turtle") },
        0.1,
        0
      ),
    /matching aquatic model/
  );
});

function localTarget(node, origin, offset) {
  return node.parent.localToWorld(
    new THREE.Vector3(
      origin[0] + offset[0],
      origin[1] + offset[1],
      origin[2] + offset[2]
    )
  );
}

test("combined head yaw and pitch aim the actual forward vector at an in-range target", () => {
  for (const kind of ["dolphin", "turtle", "drowned"]) {
    const entity = entityFor(kind, { swimming: true, swimPitch: 0.3 });
    animateMob(entity, 0.1, 0);
    const head = entity.model.head;
    entity.lookTarget = localTarget(
      head,
      head.position.toArray(),
      [0.4, 0.3, 5]
    );
    animateMob(entity, 0.1, 0.1);
    const actual = new THREE.Vector3(0, 0, 1).applyQuaternion(head.quaternion);
    const expected = new THREE.Vector3(0.4, 0.3, 5).normalize();
    assert.ok(actual.distanceTo(expected) < 1e-12, kind);
  }
});

test("head and eye targets use the actual posed parent space across heading, pitch and far coordinates", () => {
  for (const kind of AQUATIC_KINDS) {
    const results = [];
    for (const far of [false, true]) {
      const entity = entityFor(kind, { swimming: true, swimPitch: 0.35 });
      const ancestor = new THREE.Group();
      if (far) {
        ancestor.position.set(17, 3, -25);
        ancestor.rotation.set(0.13, 0.71, -0.08);
        ancestor.scale.set(1.2, 0.9, 1.1);
        entity.model.root.position.set(29_000_000.25, 11, -29_000_000.375);
        entity.model.root.rotation.set(-0.07, 1.2, 0.04);
      }
      ancestor.add(entity.model.root);
      animateMob(entity, 0.1, 0);
      const hooks = entity.model.animation;
      const node = hooks.eye?.node ?? hooks.head.node;
      const origin = hooks.eye?.restPosition ?? node.position.toArray();
      const target = localTarget(node, origin, [3, 2, 4]);
      const before = target.toArray();
      if (hooks.eye) entity.eyeTarget = target;
      else entity.lookTarget = target;
      animateMob(entity, 0.1, 0.1);
      assert.deepEqual(target.toArray(), before);
      assertLimits(entity.model);
      results.push(
        hooks.eye
          ? [node.position.x - origin[0], node.position.y - origin[1]]
          : [node.rotation.y, node.rotation.x]
      );
    }
    assert.ok(results[0][0] > 0, `${kind}: target is to local +X`);
    assert.ok(
      kind === "guardian" || kind === "elder_guardian"
        ? results[0][1] > 0
        : results[0][1] < 0,
      `${kind}: native local pitch/eye offset follows the elevated target`
    );
    for (let axis = 0; axis < 2; axis++)
      assert.ok(Math.abs(results[0][axis] - results[1][axis]) < 1e-7, kind);
  }
});

test("guardian eye target priority and centering stay inside the fixed socket", () => {
  const entity = entityFor("guardian", { swimming: true, swimPitch: 0.3 });
  animateMob(entity, 0.1, 0);
  const hook = entity.model.animation.eye;
  const aim = (offset) => localTarget(hook.node, hook.restPosition, offset);
  const right = aim([3, 1, 4]);
  const left = aim([-3, 1, 4]);
  entity.eyeTarget = right;
  entity.lookTarget = left;
  animateMob(entity, 0.1, 0.1, left);
  assert.ok(hook.node.position.x > hook.restPosition[0]);
  entity.eyeTarget = { x: NaN, y: 0, z: 0 };
  animateMob(entity, 0.1, 0.2, right);
  assert.ok(
    hook.node.position.x < hook.restPosition[0],
    "lookTarget beats player fallback"
  );
  delete entity.lookTarget;
  animateMob(entity, 0.1, 0.3, right);
  assert.ok(hook.node.position.x > hook.restPosition[0]);
  for (const target of [aim([0, 0, -4]), aim([0, 0, 0]), null]) {
    entity.eyeTarget = target;
    animateMob(entity, 0.1, 0.4);
    for (let i = 0; i < hook.axes.length; i++)
      assert.ok(
        Math.abs(hook.node.position[hook.axes[i]] - hook.restPosition[i]) <
          1e-10
      );
    assertLimits(entity.model);
  }
});

test("spike extension and beam-charge posing are bounded cosmetic inputs with explicit overrides", () => {
  for (const kind of ["guardian", "elder_guardian"]) {
    const entity = entityFor(kind);
    animateMob(entity, 0.1, 0);
    const hooks = entity.model.animation.spikes;
    assert.ok(hooks.every((hook) => hook.node.scale.y < hook.max));
    entity.beamCharge = 1;
    animateMob(entity, 0.1, 0.1);
    assert.ok(
      hooks.every((hook) => Math.abs(hook.node.scale.y - hook.max) < 1e-12)
    );
    entity.spikesExtended = false;
    entity.attacking = true;
    animateMob(entity, 0.1, 0.2);
    assert.ok(
      hooks.every((hook) => Math.abs(hook.node.scale.y - hook.min) < 1e-12)
    );
    entity.spikesExtended = 0.5;
    animateMob(entity, 0.1, 0.3);
    assert.ok(
      hooks.every(
        (hook) =>
          Math.abs(hook.node.scale.y - (hook.min + hook.max) / 2) < 1e-12
      )
    );
    delete entity.spikesExtended;
    entity.beamCharge = 0;
    animateMob(entity, 0.1, 0.4);
    assert.ok(
      hooks.every((hook) => Math.abs(hook.node.scale.y - hook.max) < 1e-12)
    );
    assertLimits(entity.model);
  }
});

test("upright drowned foot support is visual-only and swimming clears any previous gait lift", () => {
  const entity = entityFor("drowned", { swimming: false });
  entity.model.root.position.set(0, 0, 0);
  const model = entity.model;
  const restY = model.legs.map((node) => node.position.y);
  const feet = model.parts.filter((part) => part.role === "foot");
  const unit = new THREE.Box3(
    new THREE.Vector3(-0.5, -0.5, -0.5),
    new THREE.Vector3(0.5, 0.5, 0.5)
  );
  for (let frame = 0; frame < 32; frame++) {
    animateMob(entity, 0.07, frame * 0.07);
    for (const foot of feet) {
      const bounds = unit.clone().applyMatrix4(foot.node.matrixWorld);
      assert.ok(
        bounds.min.y >= -1e-7,
        "upright visual soles do not penetrate the neutral ground plane"
      );
    }
    for (let i = 0; i < model.legs.length; i++)
      assert.ok(
        model.legs[i].position.y <= restY[i] + 0.5,
        "lift cannot accumulate"
      );
    assert.deepEqual(entity.position.toArray(), [0, 0, 0]);
  }
  entity.swimming = true;
  entity.swimPitch = 0.8;
  animateMob(entity, 0.1, 3);
  assert.deepEqual(
    model.legs.map((node) => node.position.y),
    restY
  );
  assert.equal(model.visual.rotation.x, 0.8);
  entity.swimming = false;
  entity.moving = false;
  animateMob(entity, 0.1, 3.1);
  assertLimits(model);
  assert.deepEqual(entity.position.toArray(), [0, 0, 0]);
});
