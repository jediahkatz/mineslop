import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { getItem, ITEM } from "../src/items.js";
import { PlayerPortrait } from "../src/player-portrait.js";
import { createPlayerRig, posePlayerRig } from "../src/player-rig.js";
import { MAX_PLAYER_PARTS, PLAYER_SKINS } from "../src/player-skin.js";
import { PlayerVisual } from "../src/player-visual.js";
import {
  close,
  mountedPlayerFixture,
  playerSnapshot,
  seatPose,
} from "./mounted-player-fixture.js";

const unit = new THREE.Box3(
  new THREE.Vector3(-0.5, -0.5, -0.5),
  new THREE.Vector3(0.5, 0.5, 0.5)
);
const matrices = (rig) =>
  rig.parts.map((part) => [...part.node.matrixWorld.elements]);
const stack = (id, durability) => Object.freeze({ id, count: 1, durability });
const appearance = () =>
  Object.freeze({
    mainHand: stack(ITEM.IRON_PICKAXE, 43),
    offhand: stack(ITEM.SHIELD, 17),
    equipment: Object.freeze({
      head: stack(ITEM.IRON_HELMET, 57),
      chest: stack(ITEM.IRON_ARMOR, 37),
      legs: stack(ITEM.IRON_LEGGINGS, 47),
      feet: stack(ITEM.IRON_BOOTS, 17),
    }),
  });
const bounds = (parts) => {
  const result = new THREE.Box3();
  for (const part of parts)
    if (part.visible)
      result.union(unit.clone().applyMatrix4(part.node.matrixWorld));
  return result;
};
const nodes = (rig) => {
  const result = [];
  rig.root.traverse((node) => result.push(node));
  return result;
};
const watchDisposal = (resources) => {
  const counts = new Map(resources.map((resource) => [resource, 0]));
  for (const resource of resources)
    resource.addEventListener("dispose", () =>
      counts.set(resource, counts.get(resource) + 1)
    );
  return counts;
};

test("the real shared seated rig bends thighs/knees and raises level boots without moving its physical eye envelope", () => {
  const rig = createPlayerRig();
  const standing = matrices(rig),
    records = rig.parts.slice(),
    allNodes = nodes(rig);
  const head = rig.head.position.clone(),
    torso = rig.torso.position.clone();
  close(bounds(rig.parts).min.y, 0);
  close(bounds(rig.parts).max.y, 1.8);
  posePlayerRig(rig, 0.1, { moving: true, sprinting: true });
  assert.ok(rig.gait > 0);
  posePlayerRig(rig, 0, {
    seated: true,
    moving: true,
    sprinting: true,
    crouching: true,
    velocityY: -9,
  });
  assert.equal(rig.gait, 0);
  assert.equal(rig.stride, 0);
  assert.ok(rig.head.position.equals(head));
  assert.ok(rig.torso.position.equals(torso));
  assert.deepEqual(rig.root.position.toArray(), [0, 0, 0]);
  close(rig.torso.rotation.x, 0);
  close(bounds(rig.parts).max.y, 1.8);
  assert.ok(bounds(rig.parts).min.y >= 0.29);
  for (const leg of rig.legs) {
    close(leg.root.rotation.x, -Math.PI / 2);
    close(leg.knee.rotation.x, Math.PI / 2);
    close(leg.thigh.node.scale.y, 0.3);
    close(leg.shin.node.scale.y, 0.3);
    close(leg.foot.position.z, 0.3);
    close(leg.foot.rotation.x, 0);
    close(leg.foot.rotation.z, 0);
    const shinEnd = new THREE.Vector3(
      0,
      -leg.shin.node.scale.y,
      0
    ).applyMatrix4(leg.knee.matrixWorld);
    const ankle = new THREE.Vector3().setFromMatrixPosition(
      leg.foot.matrixWorld
    );
    close(shinEnd.distanceTo(ankle), 0);
    close(bounds([leg.boot]).min.y, 0.3);
  }
  for (const arm of rig.arms) {
    close(arm.root.rotation.x, -0.75);
    close(arm.root.rotation.z, arm.side * 0.08);
  }
  assert.notDeepEqual(matrices(rig), standing);
  assert.ok(rig.parts.length <= MAX_PLAYER_PARTS);
  assert.ok(
    rig.parts.every(
      (part, i) => part === records[i] && part.skin.kind === "player"
    )
  );
  assert.deepEqual(nodes(rig), allNodes);
  const seated = matrices(rig);
  for (const dt of [0, 0.05, 1000, -1, NaN])
    posePlayerRig(rig, dt, {
      seated: true,
      moving: true,
      sprinting: true,
      velocityY: 10,
    });
  assert.deepEqual(
    matrices(rig),
    seated,
    "hull movement cannot restart walking/airborne animation"
  );
  posePlayerRig(rig, 0, {});
  assert.deepEqual(
    matrices(rig),
    standing,
    "dt=0 exit restores every neutral joint and limb length"
  );
});

test("omitted seated keeps the existing standing, sprint, crouch and held-item poses", () => {
  for (const state of [
    {},
    { moving: true },
    { moving: true, sprinting: true },
    { moving: true, crouching: true, bodyHeight: 1.5, eyeHeight: 1.27 },
    { ...appearance(), pitch: 0.3, yaw: -0.8 },
  ]) {
    const omitted = createPlayerRig(),
      explicit = createPlayerRig();
    for (const dt of [0, 0.05, 0.07, 0]) {
      posePlayerRig(omitted, dt, state);
      posePlayerRig(explicit, dt, { ...state, seated: false });
      assert.deepEqual(matrices(omitted), matrices(explicit));
      assert.equal(omitted.gait, explicit.gait);
      assert.equal(omitted.stride, explicit.stride);
    }
  }
});

test("seated look still follows Player yaw/pitch and preserves textured hand silhouettes and equipped armor", () => {
  const rig = createPlayerRig(),
    gear = appearance();
  const before = structuredClone(gear);
  posePlayerRig(rig, 0, gear);
  const parts = rig.parts.map((part) => ({
    part,
    skin: part.skin,
    visible: part.visible,
    color: part.color.toArray(),
  }));
  const handTransforms = [rig.mainHand, rig.offhand].map((hand) => ({
    rotation: hand.root.rotation.toArray(),
    boxes: hand.parts.map((part) => ({
      position: part.node.position.toArray(),
      scale: part.node.scale.toArray(),
      rotation: part.node.rotation.toArray(),
    })),
  }));
  for (const yaw of [0, 0.73, -408.72136]) {
    for (const pitch of [-1.4, 0, 0.65, 1.4]) {
      posePlayerRig(rig, 0.1, {
        ...gear,
        seated: true,
        yaw,
        pitch,
        velocityY: 6,
      });
      const direction = new THREE.Vector3(0, 0, 1).transformDirection(
        rig.head.matrixWorld
      );
      const expected = new THREE.Vector3(
        -Math.sin(yaw) * Math.cos(pitch),
        Math.sin(pitch),
        -Math.cos(yaw) * Math.cos(pitch)
      );
      close(direction.distanceTo(expected), 0);
      close(rig.root.rotation.y, yaw + Math.PI);
      assert.equal(rig.mainHand.item, getItem(gear.mainHand.id));
      assert.equal(rig.offhand.item, getItem(gear.offhand.id));
      close(rig.arms[0].root.rotation.x, -0.75 - 0.28);
      close(rig.arms[1].root.rotation.x, -0.75 - 0.5);
      for (const slot of ["head", "chest", "legs", "feet"]) {
        assert.equal(
          rig.equipment[slot].item,
          getItem(gear.equipment[slot].id)
        );
        assert.ok(rig.equipment[slot].parts.every((part) => part.visible));
      }
      for (const saved of parts) {
        assert.equal(saved.part.skin, saved.skin);
        assert.equal(saved.part.visible, saved.visible);
        assert.deepEqual(saved.part.color.toArray(), saved.color);
        assert.ok(saved.part.node.matrixWorld.elements.every(Number.isFinite));
      }
      assert.ok(
        rig.mainHand.parts.some(
          (part) => part.visible && part.skin === PLAYER_SKINS.wood
        )
      );
      assert.ok(
        rig.offhand.parts.some(
          (part) => part.visible && part.skin === PLAYER_SKINS.metal
        )
      );
    }
  }
  for (const [i, hand] of [rig.mainHand, rig.offhand].entries()) {
    assert.deepEqual(hand.root.rotation.toArray(), handTransforms[i].rotation);
    assert.deepEqual(
      hand.parts.map((part) => ({
        position: part.node.position.toArray(),
        scale: part.node.scale.toArray(),
        rotation: part.node.rotation.toArray(),
      })),
      handTransforms[i].boxes
    );
  }
  assert.deepEqual(gear, before);
});

test("PlayerVisual forwards seated to the shared rig without changing the real Player, camera or stack owners", (t) => {
  const f = mountedPlayerFixture(t),
    p = f.player;
  p.update(0, { riderPose: seatPose() });
  p.yaw = -0.43;
  p.pitch = 0.32;
  p.perspective = "front";
  const visual = new PlayerVisual(new THREE.Scene());
  t.after(() => visual.dispose());
  const before = playerSnapshot(p),
    gear = appearance();
  const state = Object.freeze({
    position: p.position,
    yaw: p.yaw,
    pitch: p.pitch,
    seated: p.seated,
    moving: true,
    sprinting: true,
    crouching: p.sneaking,
    bodyHeight: p.height,
    eyeHeight: p.eyeHeight,
    velocityY: p.velocity.y,
    perspective: p.perspective,
    ...gear,
  });
  for (let frame = 0; frame < 8; frame++) visual.update(0.05, state);
  assert.deepEqual(playerSnapshot(p), before);
  assert.notEqual(visual.mesh.position, p.position);
  assert.deepEqual(visual.mesh.position, p.position);
  assert.equal(visual.rig.gait, 0);
  close(visual.rig.legs[0].root.rotation.x, -Math.PI / 2);
  assert.equal(visual.rig.mainHand.item.id, gear.mainHand.id);
  assert.equal(visual.rig.offhand.item.id, gear.offhand.id);
});

test("seated F5 rendering reuses fixed nodes, textured batches and local Float32 uploads, then disposes exactly once", (t) => {
  const scene = new THREE.Scene(),
    visual = new PlayerVisual(scene);
  t.after(() => visual.dispose());
  const state = {
    position: new THREE.Vector3(0.375, 2, -0.625),
    yaw: -0.73,
    pitch: 0.42,
    seated: true,
    moving: false,
    perspective: "first",
    ...appearance(),
  };
  visual.update(0, state);
  assert.equal(visual.rig, null);
  assert.equal(scene.children.length, 0);
  state.perspective = "back";
  visual.update(0, state);
  const { rig, mesh, resources } = visual;
  const allNodes = nodes(rig),
    parts = rig.parts.slice();
  const local = mesh.instanceMatrix.array.slice();
  const buffers = [
    mesh.instanceMatrix.array,
    mesh.instanceColor.array,
    resources.rects.array,
    resources.sizes.array,
    resources.flashes.array,
  ];
  assert.equal(mesh.instanceMatrix.count, MAX_PLAYER_PARTS);
  assert.equal(mesh.geometry.groups.length, 0);
  for (let frame = 0; frame < 24; frame++) {
    state.position.set(
      (frame % 2 ? -29_000_000 : 29_000_000) + 0.375,
      300_000.625,
      -29_000_000.125
    );
    state.seated = frame % 2 === 0;
    state.perspective = frame % 3 ? "front" : "back";
    visual.update(0.05, state);
    assert.equal(visual.mesh, mesh);
    assert.equal(visual.resources, resources);
    assert.equal(visual.rig, rig);
    assert.deepEqual(nodes(rig), allNodes);
    assert.ok(rig.parts.every((part, i) => part === parts[i]));
    assert.deepEqual(scene.children, [mesh]);
    assert.ok(mesh.count > 0 && mesh.count <= MAX_PLAYER_PARTS);
    const current = [
      mesh.instanceMatrix.array,
      mesh.instanceColor.array,
      resources.rects.array,
      resources.sizes.array,
      resources.flashes.array,
    ];
    assert.ok(current.every((buffer, i) => buffer === buffers[i]));
    if (state.seated) assert.deepEqual(mesh.instanceMatrix.array, local);
    let index = 0;
    for (const part of rig.parts) {
      if (!part.visible) continue;
      assert.deepEqual(
        [...resources.rects.array.subarray(index * 4, index * 4 + 4)],
        resources.atlas.entries.get(part.skin.key).rect
      );
      for (const axis of [12, 13, 14])
        assert.ok(Math.abs(mesh.instanceMatrix.array[index * 16 + axis]) < 4);
      index++;
    }
    assert.equal(index, mesh.count);
    assert.deepEqual(mesh.position.toArray(), state.position.toArray());
  }
  const disposed = watchDisposal([
    mesh,
    resources.geometry,
    resources.material,
    resources.texture,
  ]);
  state.perspective = "first";
  visual.update(0, state);
  visual.update(0, state);
  resources.dispose();
  assert.ok([...disposed.values()].every((count) => count === 1));
  assert.equal(scene.children.length, 0);
  assert.equal(visual.rig, rig);
  state.perspective = "back";
  state.seated = true;
  visual.update(0, state);
  assert.equal(visual.rig, rig);
  assert.notEqual(visual.mesh, mesh);
  assert.notEqual(visual.resources, resources);
  close(rig.legs[0].root.rotation.x, -Math.PI / 2);
  const final = visual.resources;
  const finalDisposed = watchDisposal([
    visual.mesh,
    final.geometry,
    final.material,
    final.texture,
  ]);
  visual.dispose();
  visual.dispose();
  assert.ok([...finalDisposed.values()].every((count) => count === 1));
  assert.equal(scene.children.length, 0);
});

test("inventory portraits ignore world seating and keep their default standing appearance and shared equipment", (t) => {
  const gear = appearance(),
    standing = new PlayerPortrait(),
    mounted = new PlayerPortrait();
  t.after(() => {
    standing.dispose();
    mounted.dispose();
  });
  standing.update(gear);
  mounted.update({
    ...gear,
    seated: true,
    moving: true,
    crouching: true,
    bodyHeight: 1.2,
    eyeHeight: 0.9,
    yaw: 3,
    pitch: 1,
  });
  assert.deepEqual(mounted.pixels.data, standing.pixels.data);
  assert.deepEqual(matrices(mounted._rig), matrices(standing._rig));
  for (const leg of mounted._rig.legs) close(bounds([leg.boot]).min.y, 0);
  const pixels = mounted.pixels.data.slice();
  assert.equal(mounted.update({ ...gear, seated: false }), false);
  assert.deepEqual(mounted.pixels.data, pixels);
  const worldRig = createPlayerRig();
  posePlayerRig(worldRig, 0, { ...gear, seated: true });
  assert.notDeepEqual(matrices(worldRig), matrices(mounted._rig));
  assert.equal(
    mounted._rig.parts.find((part) => part.node.name === "face").skin,
    PLAYER_SKINS.head
  );
});
