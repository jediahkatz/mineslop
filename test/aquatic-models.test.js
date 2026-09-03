import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  createAquaticModel,
  MAX_AQUATIC_PARTS_PER_MODEL,
} from "../src/aquatic-models.js";
import { AQUATIC_KINDS } from "../src/aquatic-skins.js";
import { MAX_PARTS_PER_MOB } from "../src/mob-models.js";
import { MOB_TEXELS_PER_BLOCK } from "../src/mob-skins.js";

const unit = new THREE.Box3(
  new THREE.Vector3(-0.5, -0.5, -0.5),
  new THREE.Vector3(0.5, 0.5, 0.5)
);

function bounds(model, parts = model.parts) {
  model.root.updateMatrixWorld(true);
  const result = new THREE.Box3();
  for (const part of parts)
    result.union(unit.clone().applyMatrix4(part.node.matrixWorld));
  return result;
}

function roleParts(model, role) {
  return model.parts.filter((part) => part.role === role);
}

function rotationHooks(model) {
  return ["tail", "flippers", "arms", "elbows", "legs", "knees"].flatMap(
    (name) => model.animation[name]
  );
}

test("aquatic factories produce grounded local, distinct, bounded CPU-only rigs", () => {
  const silhouettes = new Set();
  for (const kind of AQUATIC_KINDS) {
    const model = createAquaticModel(kind);
    const box = bounds(model);
    assert.equal(model.kind, kind);
    assert.equal(model.root.name, kind);
    assert.equal(model.visual.parent, model.root);
    assert.deepEqual(model.root.position.toArray(), [0, 0, 0]);
    assert.deepEqual(model.root.scale.toArray(), [1, 1, 1]);
    assert.ok(Math.abs(box.min.y) < 1e-8, `${kind}: neutral floor contact`);
    assert.deepEqual(model.localBounds, box);
    assert.ok(model.parts.length > 5);
    assert.ok(model.parts.length <= MAX_AQUATIC_PARTS_PER_MODEL);
    assert.ok(model.parts.length <= MAX_PARTS_PER_MOB);
    assert.equal(
      new Set(model.parts.map((part) => part.name)).size,
      model.parts.length
    );
    assert.ok(model.pickFloor <= box.min.y);
    assert.ok(model.pickHeight >= box.max.y);
    assert.ok(
      model.pickRadius >=
        Math.max(Math.abs(box.min.x), box.max.x, Math.abs(box.min.z), box.max.z)
    );
    model.root.traverse((node) => {
      assert.ok(node.matrixWorld.elements.every(Number.isFinite), kind);
      assert.ok(
        node.scale.toArray().every((value) => value > 0),
        kind
      );
      assert.equal(node.isMesh, undefined, "nodes must not allocate drawables");
      assert.equal(node.geometry, undefined);
      assert.equal(node.material, undefined);
    });
    for (const part of model.parts) {
      assert.ok(part.name.length > 0);
      assert.equal(part.node.name, part.role);
      assert.equal(part.skin.kind, kind);
      assert.equal(part.skin.role, part.role);
      assert.equal(part.skin.translucent, false);
      assert.equal(part.color.isColor, true);
      assert.deepEqual(
        part.skin.pixels,
        part.node.scale
          .toArray()
          .map((size) => Math.max(1, Math.round(size * MOB_TEXELS_PER_BLOCK)))
      );
    }
    silhouettes.add(
      JSON.stringify(
        model.parts.map((part) => [part.name, part.node.matrixWorld.elements])
      )
    );
  }
  assert.equal(silhouettes.size, AQUATIC_KINDS.length);
});

test("the dolphin has a projecting rostrum, dorsal fin, paired flippers and horizontal flukes", () => {
  const model = createAquaticModel("dolphin");
  const torso = bounds(model, roleParts(model, "body"));
  const head = bounds(model, roleParts(model, "head"));
  const snout = bounds(model, roleParts(model, "snout"));
  const dorsal = bounds(model, roleParts(model, "dorsal_fin"));
  const flukes = bounds(model, roleParts(model, "tail_fin"));
  const size = flukes.getSize(new THREE.Vector3());
  assert.ok(snout.max.z > head.max.z + 0.2);
  assert.ok(dorsal.max.y > torso.max.y + 0.2);
  assert.ok(size.x > size.y * 8, "flukes are horizontal, not a cod tail");
  assert.equal(model.flippers.length, 2);
  assert.ok(model.flippers[0].position.x * model.flippers[1].position.x < 0);
  assert.ok(model.animation.tail.length >= 2);
  assert.equal(model.animation.tail[0].node, model.tail);
  assert.ok(model.animation.tail.every((hook) => hook.axis === "x"));
  assert.ok(model.animation.flippers.every((hook) => hook.axis === "z"));
  assert.ok(!model.parts.some((part) => /eyeball|pupil/.test(part.name)));
});

test("the turtle has a stepped shell, front-facing head and four independently jointed paddles", () => {
  const model = createAquaticModel("turtle");
  const size = bounds(model).getSize(new THREE.Vector3());
  const shell = bounds(model, roleParts(model, "shell"));
  const torso = bounds(model, roleParts(model, "body"));
  const head = bounds(model, roleParts(model, "head"));
  assert.ok(size.x > size.y * 2, "low, broad silhouette");
  assert.ok(shell.max.y > torso.max.y);
  assert.ok(head.max.z > shell.max.z);
  assert.ok(roleParts(model, "shell").length > 1);
  assert.equal(model.flippers.length, 4);
  assert.equal(new Set(model.flippers).size, 4);
  assert.equal(new Set(model.flippers.map((node) => node.name)).size, 4);
  const quadrants = new Set(
    model.flippers.map(
      (node) => `${Math.sign(node.position.x)}/${Math.sign(node.position.z)}`
    )
  );
  assert.equal(quadrants.size, 4);
  assert.ok(
    model.animation.flippers.some((hook) => hook.front && hook.axis === "z")
  );
  assert.ok(
    model.animation.flippers.some((hook) => !hook.front && hook.axis === "y")
  );
});

test("the drowned keeps planted feet, jointed humanoid limbs, clothing and an algae silhouette", () => {
  const model = createAquaticModel("drowned");
  assert.equal(model.legs.length, 2);
  assert.equal(model.arms.length, 2);
  assert.deepEqual(
    model.wings,
    model.arms,
    "legacy limb handles remain available"
  );
  assert.equal(model.animation.knees.length, 2);
  assert.equal(model.animation.elbows.length, 2);
  for (const role of ["shirt", "pants", "arm", "hand", "leg", "foot", "kelp"])
    assert.ok(roleParts(model, role).length > 0, role);
  for (const foot of roleParts(model, "foot"))
    assert.ok(Math.abs(bounds(model, [foot]).min.y) < 1e-8);
  assert.ok(bounds(model, roleParts(model, "head")).min.y > 1.4);
  for (let i = 0; i < model.legs.length; i++) {
    assert.equal(model.animation.knees[i].node.parent, model.legs[i]);
    assert.equal(model.animation.elbows[i].node.parent, model.arms[i]);
    assert.equal(model.animation.arms[i].rest, model.arms[i].rotation.x);
  }
  assert.notEqual(model.animation.legs[0].phase, model.animation.legs[1].phase);
});

test("guardian spikes retract along their own normals and the movable eye stays within its socket", () => {
  for (const kind of ["guardian", "elder_guardian"]) {
    const model = createAquaticModel(kind);
    assert.ok(model.animation.spikes.length >= 8);
    assert.ok(model.animation.tail.length >= 2);
    assert.ok(model.animation.tail.every((hook) => hook.axis === "y"));
    const eye = roleParts(model, "eye")[0];
    const socket = roleParts(model, "eye_socket")[0];
    const target = model.animation.eye;
    assert.equal(roleParts(model, "eye").length, 1);
    assert.equal(target.node, model.eye);
    assert.equal(eye.node.parent, target.node);
    assert.equal(target.node.parent, socket.node.parent);
    assert.deepEqual(target.restPosition, target.node.position.toArray());
    assert.ok(target.node.position.z > socket.node.position.z);
    for (const [index, axis] of target.axes.entries())
      assert.ok(
        eye.node.scale[axis] / 2 + target.maxOffset[index] <
          socket.node.scale[axis] / 2,
        `${kind}: eye motion cannot escape its rim`
      );
    for (const hook of model.animation.spikes) {
      const direction = new THREE.Vector3(...hook.direction);
      const actual = new THREE.Vector3(0, 1, 0).applyQuaternion(
        hook.node.quaternion
      );
      assert.ok(actual.distanceTo(direction) < 1e-8);
      assert.ok(Math.abs(direction.length() - 1) < 1e-8);
      assert.ok(hook.min > 0 && hook.min < hook.max);
      assert.equal(hook.node.scale[hook.axis], hook.rest);
    }
  }
});

test("elder guardians have larger physical parts, a different palette and additional armor plates", () => {
  const normal = createAquaticModel("guardian");
  const elder = createAquaticModel("elder_guardian");
  const normalSize = bounds(normal).getSize(new THREE.Vector3());
  const elderSize = bounds(elder).getSize(new THREE.Vector3());
  for (const axis of ["x", "y", "z"])
    assert.ok(elderSize[axis] > normalSize[axis] * 1.5, axis);
  assert.ok(elder.parts.length > normal.parts.length);
  assert.equal(roleParts(normal, "plate").length, 0);
  assert.ok(roleParts(elder, "plate").length > 0);
  assert.notEqual(
    roleParts(normal, "body")[0].skin.baseColor,
    roleParts(elder, "body")[0].skin.baseColor
  );
  assert.ok(
    roleParts(elder, "body")[0].skin.pixels[0] >
      roleParts(normal, "body")[0].skin.pixels[0],
    "elder size is baked into dimensions, preserving physical texel density"
  );
});

test("animation metadata can drive finite local poses without mutating physical root or skin allocation", () => {
  for (const kind of AQUATIC_KINDS) {
    const model = createAquaticModel(kind);
    const nodes = new Set();
    model.root.traverse((node) => nodes.add(node));
    const channels = rotationHooks(model);
    const initialSkins = model.parts.map((part) => part.skin);
    const neutralBounds = model.localBounds.clone();
    for (const hook of channels) {
      assert.ok(nodes.has(hook.node), `${kind}: hook targets this rig`);
      assert.equal(hook.node[hook.property][hook.axis], hook.rest);
      assert.ok([hook.rest, hook.amplitude, hook.phase].every(Number.isFinite));
    }
    model.root.position.set(29_000_000.25, 11, -29_000_000.375);
    model.root.rotation.set(0.03, 0.52, -0.02);
    const position = model.root.position.toArray();
    const rotation = model.root.rotation.toArray();
    for (const phase of [-Math.PI / 2, 0, Math.PI / 2, Math.PI]) {
      const swim = model.animation.swim;
      assert.equal(swim.node, model.visual);
      swim.node.rotation[swim.pitchAxis] = Math.sin(phase) * 0.4;
      for (const hook of channels)
        hook.node[hook.property][hook.axis] =
          hook.rest + Math.sin(phase + hook.phase) * hook.amplitude;
      for (const spike of model.animation.spikes)
        spike.node.scale[spike.axis] =
          spike.min + (spike.max - spike.min) * (0.5 + Math.sin(phase) * 0.5);
      const eye = model.animation.eye;
      if (eye) {
        eye.node.position.fromArray(eye.restPosition);
        for (const [i, axis] of eye.axes.entries())
          eye.node.position[axis] += Math.sin(phase + i) * eye.maxOffset[i];
      }
      const look = model.animation.head;
      if (look) {
        look.node.rotation[look.yawAxis] = Math.sin(phase) * look.yawLimit;
        look.node.rotation[look.pitchAxis] = Math.cos(phase) * look.pitchLimit;
      }
      model.root.updateMatrixWorld(true);
      for (const part of model.parts)
        assert.ok(part.node.matrixWorld.elements.every(Number.isFinite), kind);
      assert.deepEqual(model.root.position.toArray(), position);
      assert.deepEqual(model.root.rotation.toArray(), rotation);
      assert.deepEqual(
        model.localBounds,
        neutralBounds,
        "bounds describe the neutral local pose"
      );
      for (let i = 0; i < initialSkins.length; i++)
        assert.equal(model.parts[i].skin, initialSkins[i]);
      assert.equal(model.parts.length, initialSkins.length);
    }
  }
});

test("factories isolate mutable rigs and reject non-aquatic kinds", () => {
  for (const kind of AQUATIC_KINDS) {
    const first = createAquaticModel(kind);
    const second = createAquaticModel(kind);
    const before = second.parts[0].node.position.toArray();
    first.parts[0].node.position.x += 10;
    first.parts[0].color.set("#ff0000");
    assert.deepEqual(second.parts[0].node.position.toArray(), before);
    assert.notEqual(first.parts[0].color, second.parts[0].color);
    assert.notEqual(first.visual, second.visual);
    assert.notEqual(
      first.animation.swim.restPosition,
      second.animation.swim.restPosition
    );
    assert.deepEqual(
      first.parts.map((part) => part.skin.key),
      second.parts.map((part) => part.skin.key)
    );
  }
  for (const kind of ["cod", "__proto__", "constructor", "", null])
    assert.throws(() => createAquaticModel(kind), /Unknown aquatic model/);
});
