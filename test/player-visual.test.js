import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { getItem, ITEM } from "../src/items.js";
import { createPlayerRig, posePlayerRig } from "../src/player-rig.js";
import { MAX_PLAYER_PARTS } from "../src/player-skin.js";
import { PlayerVisual } from "../src/player-visual.js";
import { controlFixture } from "./control-fixture.js";

const unit = new THREE.Box3(
  new THREE.Vector3(-0.5, -0.5, -0.5),
  new THREE.Vector3(0.5, 0.5, 0.5)
);
const close = (actual, expected, tolerance = 1e-8) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} != ${expected}`
  );
const stack = (id, durability) =>
  durability === undefined ? { id, count: 1 } : { id, count: 1, durability };
const armor = () => ({
  head: stack(ITEM.IRON_HELMET, 57),
  chest: stack(ITEM.IRON_ARMOR, 37),
  legs: stack(ITEM.IRON_LEGGINGS, 47),
  feet: stack(ITEM.IRON_BOOTS, 17),
});

function bounds(parts) {
  const result = new THREE.Box3();
  for (const part of parts)
    if (part.visible)
      result.union(unit.clone().applyMatrix4(part.node.matrixWorld));
  return result;
}

function fixture(t, extra = {}) {
  const scene = new THREE.Scene();
  const visual = new PlayerVisual(scene);
  t.after(() => visual.dispose());
  return {
    scene,
    visual,
    state: {
      position: new THREE.Vector3(0.375, 9, -0.625),
      yaw: 0,
      pitch: 0,
      moving: false,
      sprinting: false,
      crouching: false,
      bodyHeight: 1.8,
      eyeHeight: 1.62,
      velocityY: 0,
      perspective: "back",
      mainHand: null,
      offhand: null,
      equipment: {},
      ...extra,
    },
  };
}

function watchDisposal(resources) {
  const counts = new Map(resources.map((resource) => [resource, 0]));
  for (const resource of resources)
    resource.addEventListener("dispose", () =>
      counts.set(resource, counts.get(resource) + 1)
    );
  return counts;
}

test("first-person has no player geometry; back/front share one live batch", (t) => {
  const { scene, visual, state } = fixture(t, { perspective: "first" });
  assert.equal(visual.visible, false);
  assert.equal(visual.mesh, null);
  assert.equal(visual.resources, null);
  visual.update(0.1, state);
  assert.equal(visual.rig, null, "even the CPU rig is lazy");
  assert.equal(scene.children.length, 0);
  state.perspective = "back";
  visual.update(0, state);
  const mesh = visual.mesh;
  const resources = visual.resources;
  assert.equal(visual.visible, true);
  assert.equal(scene.children.length, 1);
  assert.equal(scene.children[0], mesh);
  assert.ok(mesh.count > 0 && mesh.count <= MAX_PLAYER_PARTS);
  assert.equal(mesh.instanceMatrix.count, MAX_PLAYER_PARTS);
  assert.equal(mesh.geometry.groups.length, 0, "one opaque material draw");
  assert.equal(mesh.material.transparent, false);
  const matrices = mesh.instanceMatrix.array.slice();
  state.perspective = "front";
  visual.update(0, state);
  assert.equal(visual.mesh, mesh);
  assert.equal(visual.resources, resources);
  assert.deepEqual(mesh.instanceMatrix.array, matrices);
  const disposed = watchDisposal([
    mesh,
    resources.geometry,
    resources.material,
    resources.texture,
  ]);
  state.perspective = "first";
  visual.update(0, state);
  visual.update(0.1, state);
  assert.equal(visual.visible, false);
  assert.equal(visual.mesh, null);
  assert.equal(visual.resources, null);
  assert.equal(mesh.count, 0);
  assert.equal(scene.children.length, 0);
  assert.ok([...disposed.values()].every((count) => count === 1));
});

test("the original human has a 1.8 standing envelope and level grounded boots", () => {
  const rig = createPlayerRig();
  const standing = bounds(rig.parts);
  close(standing.min.y, 0);
  close(standing.max.y, 1.8);
  assert.equal(rig.arms.length, 2);
  assert.equal(rig.legs.length, 2);
  assert.ok(rig.parts.length <= MAX_PLAYER_PARTS);
  assert.ok(rig.parts.every((part) => part.skin.kind === "player"));
  for (const leg of rig.legs) {
    close(bounds([leg.boot]).min.y, 0);
    close(leg.foot.rotation.x, 0);
    close(leg.foot.rotation.z, 0);
  }
  assert.ok(rig.mainHand.root.parent.position.x < 0);
  assert.ok(rig.offhand.root.parent.position.x > 0);
});

test("head pitch and yaw+PI facing match physical forward in both third-person views", (t) => {
  const { visual, state } = fixture(t);
  for (const perspective of ["back", "front"]) {
    for (const yaw of [0, Math.PI / 2, -Math.PI, -408.72136]) {
      let torsoPosition;
      for (const pitch of [-1.4, -0.3, 0, 0.8, 1.4]) {
        Object.assign(state, { perspective, yaw, pitch });
        visual.update(0, state);
        const direction = new THREE.Vector3(0, 0, 1).transformDirection(
          visual.rig.head.matrixWorld
        );
        const expected = new THREE.Vector3(
          -Math.sin(yaw) * Math.cos(pitch),
          Math.sin(pitch),
          -Math.cos(yaw) * Math.cos(pitch)
        );
        close(direction.distanceTo(expected), 0);
        close(visual.rig.root.rotation.y, yaw + Math.PI);
        torsoPosition ??= visual.rig.torso.position.toArray();
        assert.deepEqual(
          visual.rig.torso.position.toArray(),
          torsoPosition,
          "looking up/down does not change the body stance"
        );
      }
    }
  }
});

test("walk/sprint/crouch bend the limbs without sinking soles or losing ankle contact", () => {
  for (const [crouching, sprinting, bodyHeight, eyeHeight] of [
    [false, false, 1.8, 1.62],
    [false, true, 1.8, 1.62],
    [true, false, 1.5, 1.27],
  ]) {
    const rig = createPlayerRig();
    const state = {
      moving: true,
      crouching,
      sprinting,
      bodyHeight,
      eyeHeight,
      yaw: 0.43,
      pitch: 0,
    };
    for (let frame = 0; frame < 24; frame++) {
      state.pitch = Math.sin(frame * 0.4) * 1.4;
      posePlayerRig(rig, 0.05, state);
      const envelope = bounds(rig.parts);
      assert.ok(envelope.min.y >= -1e-8, "no limb penetrates the floor");
      assert.ok(envelope.max.y <= bodyHeight + 1e-8);
      const soles = rig.legs.map((leg) => bounds([leg.boot]).min.y);
      assert.ok(Math.min(...soles) <= 1e-8, "one foot supports every step");
      assert.ok(
        Math.max(...soles) <= 0.06,
        "the stepping foot only lifts a little"
      );
      for (const leg of rig.legs) {
        const endpoint = new THREE.Vector3(
          0,
          -leg.shin.node.scale.y,
          0
        ).applyMatrix4(leg.knee.matrixWorld);
        const ankle = new THREE.Vector3().setFromMatrixPosition(
          leg.foot.matrixWorld
        );
        close(endpoint.distanceTo(ankle), 0);
        assert.ok(leg.root.rotation.x !== 0 || leg.knee.rotation.x !== 0);
      }
      assert.deepEqual(rig.root.position.toArray(), [0, 0, 0]);
    }
    posePlayerRig(rig, 0.1, { ...state, moving: false, pitch: 0 });
    close(rig.head.position.y, eyeHeight - 0.06);
    for (const leg of rig.legs) close(bounds([leg.boot]).min.y, 0);
    if (crouching)
      assert.ok(rig.legs.every((leg) => leg.knee.rotation.x > 0.5));
  }
  const walk = createPlayerRig();
  const sprint = createPlayerRig();
  posePlayerRig(walk, 0.1, { moving: true });
  posePlayerRig(sprint, 0.1, { moving: true, sprinting: true });
  assert.ok(sprint.gait > walk.gait && sprint.stride > walk.stride);
  close(walk.arms[0].root.rotation.x + walk.arms[1].root.rotation.x, 0);
});

test("the actual controller's physical pose, eye, velocity and camera are never mutated", (t) => {
  const f = controlFixture(t);
  const { visual } = fixture(t);
  f.player.enabled = false;
  f.player.setPosition({ x: 29_000_000.375, y: 43.625, z: -29_000_000.125 });
  f.player.yaw = -408.72136;
  f.player.pitch = 0.47;
  f.player.velocity.set(1.3, -2.7, 0.4);
  const physical = () => ({
    position: f.player.position.toArray(),
    eye: f.player.eyePosition.toArray(),
    velocity: f.player.velocity.toArray(),
    forward: f.player.forward.toArray(),
    yaw: f.player.yaw,
    pitch: f.player.pitch,
    camera: f.camera.position.toArray(),
    cameraRotation: f.camera.quaternion.toArray(),
  });
  for (const crouching of [false, true]) {
    f.player.sneaking = crouching;
    for (const perspective of ["back", "front", "first"]) {
      f.player.perspective = perspective;
      const before = physical();
      const state = Object.freeze({
        position: f.player.position,
        yaw: f.player.yaw,
        pitch: f.player.pitch,
        moving: true,
        sprinting: !crouching,
        crouching: f.player.sneaking,
        bodyHeight: f.player.height,
        eyeHeight: f.player.eyeHeight,
        velocityY: f.player.velocity.y,
        perspective: f.player.perspective,
      });
      for (let frame = 0; frame < 8; frame++) visual.update(0.05, state);
      assert.deepEqual(physical(), before);
      if (visual.mesh) {
        assert.notEqual(visual.mesh.position, f.player.position);
        assert.deepEqual(visual.mesh.position, f.player.position);
      }
    }
  }
});

test("fractional world coordinates never enter Float32 instance uploads at +/-29M", (t) => {
  const { visual, state } = fixture(t, {
    moving: true,
    crouching: true,
    bodyHeight: 1.5,
    eyeHeight: 1.27,
    yaw: -0.73,
    pitch: 0.42,
    mainHand: stack(ITEM.IRON_PICKAXE, 83),
    offhand: stack(ITEM.SHIELD, 19),
    equipment: armor(),
  });
  visual.update(0.1, state);
  const baseline = visual.mesh.instanceMatrix.array.slice();
  const upload = new THREE.Matrix4();
  for (const offset of [0, 29_000_000, -29_000_000]) {
    for (const shift of [15.99, 16.01, -0.01]) {
      state.position.set(offset + shift, 300_000.625, -offset + 0.375);
      const before = state.position.toArray();
      visual.update(0, state);
      assert.deepEqual(visual.mesh.instanceMatrix.array, baseline);
      assert.deepEqual(state.position.toArray(), before);
      assert.deepEqual(visual.mesh.position.toArray(), before);
      let index = 0;
      for (const part of visual.rig.parts) {
        if (!part.visible) continue;
        visual.mesh.getMatrixAt(index++, upload);
        for (const axis of [12, 13, 14])
          assert.ok(Math.abs(upload.elements[axis]) < 4, "local upload");
        const expected = visual.mesh.matrixWorld
          .clone()
          .multiply(part.node.matrixWorld);
        upload.premultiply(visual.mesh.matrixWorld);
        for (let element = 0; element < 16; element++)
          close(upload.elements[element], expected.elements[element], 1e-6);
      }
      assert.equal(index, visual.mesh.count);
    }
  }
});

test("hands, wear and equipment use supplied stacks and clear every stale instance", (t) => {
  const { visual, state } = fixture(t);
  visual.update(0, state);
  const unadorned = visual.mesh.count;
  const mesh = visual.mesh;
  const rig = visual.rig;
  const resources = visual.resources;
  const records = rig.parts.slice();
  const buffers = [
    mesh.instanceMatrix.array,
    mesh.instanceColor.array,
    resources.rects.array,
    resources.sizes.array,
  ];
  state.equipment = armor();
  state.mainHand = stack(ITEM.IRON_SWORD, 13);
  state.offhand = stack(ITEM.SHIELD, 9);
  const snapshot = structuredClone(state);
  visual.update(0.05, state);
  assert.deepEqual(
    structuredClone(state),
    snapshot,
    "no inventory or wear writes"
  );
  assert.ok(mesh.count > unadorned);
  for (const slot of ["head", "chest", "legs", "feet"]) {
    const gear = rig.equipment[slot];
    assert.equal(gear.item, getItem(state.equipment[slot].id));
    assert.ok(gear.parts.every((part) => part.visible));
  }
  assert.equal(rig.mainHand.item.id, state.mainHand.id);
  assert.equal(rig.offhand.item.id, state.offhand.id);
  for (const id of [
    ITEM.STONE,
    ITEM.WOOD_PICKAXE,
    ITEM.STONE_AXE,
    ITEM.IRON_SHOVEL,
    ITEM.BOW,
    ITEM.ARROW,
    ITEM.APPLE,
  ]) {
    state.mainHand = stack(id);
    visual.update(0.05, state);
    assert.equal(rig.mainHand.item.id, id);
    assert.ok(rig.mainHand.parts.some((part) => part.visible));
    let index = 0;
    for (const part of rig.parts) {
      if (!part.visible) continue;
      assert.deepEqual(
        [...resources.rects.array.subarray(index * 4, index * 4 + 4)],
        resources.atlas.entries.get(part.skin.key).rect
      );
      index++;
    }
    assert.equal(mesh.count, index);
    assert.equal(visual.mesh, mesh);
    assert.equal(visual.rig, rig);
    assert.equal(visual.resources, resources);
    assert.ok(rig.parts.every((part, i) => part === records[i]));
    const current = [
      mesh.instanceMatrix.array,
      mesh.instanceColor.array,
      resources.rects.array,
      resources.sizes.array,
    ];
    assert.ok(current.every((buffer, i) => buffer === buffers[i]));
  }
  state.mainHand = state.offhand = null;
  state.equipment = {};
  visual.update(0, state);
  assert.equal(mesh.count, unadorned);
  assert.ok(rig.mainHand.parts.every((part) => !part.visible));
  assert.ok(rig.offhand.parts.every((part) => !part.visible));
  assert.ok(Object.values(rig.equipment).every((gear) => gear.item === null));
});

test("empty/invalid stacks, wrong armor slots and invalid poses cannot leave phantom gear", (t) => {
  const { visual, state } = fixture(t, {
    mainHand: stack(ITEM.BOW),
    offhand: stack(ITEM.SHIELD),
    equipment: armor(),
  });
  visual.update(0, state);
  for (const invalid of [
    null,
    undefined,
    { id: ITEM.BOW, count: 0 },
    { id: ITEM.BOW, count: 2 },
    { id: ITEM.STONE, count: -3 },
    { id: ITEM.STONE, count: NaN },
    { id: ITEM.STONE, count: Infinity },
    { id: -1, count: 1 },
    { id: 999_999, count: 1 },
  ]) {
    state.mainHand = state.offhand = invalid;
    state.equipment = {
      head: invalid,
      chest: invalid,
      legs: invalid,
      feet: invalid,
    };
    visual.update(0, state);
    assert.equal(visual.rig.mainHand.item, null);
    assert.equal(visual.rig.offhand.item, null);
    assert.ok(
      Object.values(visual.rig.equipment).every((gear) => gear.item === null)
    );
  }
  state.equipment = { head: stack(ITEM.IRON_ARMOR), chest: stack(ITEM.SHIELD) };
  visual.update(NaN, {
    ...state,
    yaw: Infinity,
    pitch: NaN,
    bodyHeight: NaN,
    eyeHeight: NaN,
  });
  assert.ok(
    Object.values(visual.rig.equipment).every((gear) => gear.item === null)
  );
  assert.ok(
    visual.rig.parts.every((part) =>
      part.node.matrixWorld.elements.every(Number.isFinite)
    )
  );
  state.position.x = Infinity;
  visual.update(0, state);
  assert.equal(visual.mesh, null);
  assert.equal(visual.resources, null);
});

test("repeated hide/show and world disposal release every owned GPU object exactly once", (t) => {
  const a = fixture(t);
  const b = fixture(t);
  a.visual.update(0, a.state);
  b.visual.update(0, b.state);
  assert.equal(a.visual.resources.atlas, b.visual.resources.atlas);
  assert.notEqual(a.visual.resources.texture, b.visual.resources.texture);
  assert.notEqual(a.visual.resources.geometry, b.visual.resources.geometry);
  const other = b.visual.resources;
  const otherDisposals = watchDisposal([
    other.texture,
    other.geometry,
    other.material,
  ]);
  const sibling = new THREE.Group();
  a.scene.add(sibling);
  const rig = a.visual.rig;
  for (let cycle = 0; cycle < 3; cycle++) {
    const { mesh, resources } = a.visual;
    const disposals = watchDisposal([
      mesh,
      resources.texture,
      resources.geometry,
      resources.material,
    ]);
    a.state.perspective = "first";
    a.visual.update(0, a.state);
    resources.dispose();
    a.visual.update(0, a.state);
    assert.ok([...disposals.values()].every((count) => count === 1));
    assert.deepEqual(a.scene.children, [sibling]);
    assert.ok([...otherDisposals.values()].every((count) => count === 0));
    a.state.perspective = "back";
    a.visual.update(0, a.state);
    assert.equal(a.visual.rig, rig);
    assert.notEqual(a.visual.resources, resources);
    assert.equal(a.visual.resources.atlas, other.atlas);
  }
  const final = a.visual.resources;
  const disposed = watchDisposal([
    a.visual.mesh,
    final.texture,
    final.geometry,
    final.material,
  ]);
  a.visual.dispose();
  a.visual.dispose();
  final.dispose();
  a.visual.update(0, a.state);
  assert.equal(a.visual.rig, null);
  assert.equal(a.visual.mesh, null);
  assert.deepEqual(a.scene.children, [sibling]);
  assert.ok([...disposed.values()].every((count) => count === 1));
  b.visual.update(0.05, b.state);
  assert.ok(b.visual.mesh.count > 0);
  assert.ok([...otherDisposals.values()].every((count) => count === 0));
  b.visual.dispose();
  assert.ok([...otherDisposals.values()].every((count) => count === 1));
});
