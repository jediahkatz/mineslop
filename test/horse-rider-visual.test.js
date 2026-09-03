import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { ITEM } from "../src/items.js";
import { createPlayerRig, posePlayerRig } from "../src/player-rig.js";
import { PlayerPortrait } from "../src/player-portrait.js";
import { MAX_PLAYER_PARTS } from "../src/player-skin.js";
import { PlayerVisual } from "../src/player-visual.js";
import {
  close, mountedPlayerFixture, playerSnapshot, seatPose,
} from "./mounted-player-fixture.js";

const unit = new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
const matrices = (rig) => rig.parts.map((part) => [...part.node.matrixWorld.elements]);
const bounds = (parts) => {
  const box = new THREE.Box3();
  for (const part of parts)
    if (part.visible) box.union(unit.clone().applyMatrix4(part.node.matrixWorld));
  return box;
};
const nodes = (rig) => {
  const result = [];
  rig.root.traverse((node) => result.push(node));
  return result;
};
const gear = () => ({
  mainHand: { id: ITEM.IRON_PICKAXE, count: 1, durability: 43 },
  offhand: { id: ITEM.SHIELD, count: 1, durability: 17 },
  equipment: {
    head: { id: ITEM.IRON_HELMET, count: 1, durability: 57 },
    chest: { id: ITEM.IRON_ARMOR, count: 1, durability: 37 },
    legs: { id: ITEM.IRON_LEGGINGS, count: 1, durability: 47 },
    feet: { id: ITEM.IRON_BOOTS, count: 1, durability: 17 },
  },
});
const horse = (extra = {}) => ({
  seated: true, vehicleType: "horse", hullYaw: -Math.PI, yaw: -Math.PI, pitch: 0, ...extra,
});

test("horse riders straddle the back with knees/shins outside the body and connected level boots", () => {
  const rig = createPlayerRig();
  posePlayerRig(rig, 0, horse());
  close(rig.torso.position.y + 0.95, 1.67);
  close(bounds(rig.parts).max.y + 0.95, 2.75);
  assert.equal(rig.gait, 0);
  assert.equal(rig.stride, 0);
  for (const leg of rig.legs) {
    const hip = new THREE.Vector3().setFromMatrixPosition(leg.root.matrixWorld);
    const knee = new THREE.Vector3().setFromMatrixPosition(leg.knee.matrixWorld);
    assert.ok(Math.abs(knee.x) > 0.5, "thigh goes sideways over the back");
    close(knee.y, hip.y);
    close(knee.z, hip.z);
    close(leg.knee.rotation.x, Math.PI / 2);
    assert.ok(bounds([leg.thigh]).min.y + 0.95 > 1.61, "thigh clears the horse's back");
    for (const part of [leg.shin, leg.boot]) {
      const box = bounds([part]);
      assert.ok(leg.side < 0 ? box.max.x < -0.395 : box.min.x > 0.395,
        `${part.node.name} does not pass through the horse's torso`);
      assert.ok(Math.max(Math.abs(box.min.x), Math.abs(box.max.x)) < 0.88);
    }
    const endpoint = new THREE.Vector3(0, -leg.shin.node.scale.y, 0)
      .applyMatrix4(leg.knee.matrixWorld);
    const ankle = new THREE.Vector3().setFromMatrixPosition(leg.foot.matrixWorld);
    close(endpoint.distanceTo(ankle), 0);
    close(leg.foot.rotation.x, 0);
    close(leg.foot.rotation.z, 0);
  }
});

test("untamed, bareback and saddled riders use the same straddle, never the forward boat seat", () => {
  const rig = createPlayerRig();
  posePlayerRig(rig, 0, horse());
  const reference = matrices(rig), parts = rig.parts.slice(), allNodes = nodes(rig);
  for (const tamed of [false, true]) {
    for (const saddled of [false, true]) {
      if (!tamed && saddled) continue;
      posePlayerRig(rig, 0.1, horse({
        tamed, saddled, moving: true, sprinting: true, crouching: true, velocityY: 8,
      }));
      assert.deepEqual(matrices(rig), reference);
      assert.equal(rig.gait, 0);
      assert.equal(rig.stride, 0);
      assert.ok(rig.parts.every((part, i) => part === parts[i]));
      assert.deepEqual(nodes(rig), allNodes);
    }
  }
  posePlayerRig(rig, 0, { seated: true, vehicleType: "boat", yaw: -Math.PI });
  assert.notDeepEqual(matrices(rig), reference);
  for (const leg of rig.legs) {
    close(leg.root.position.x, leg.side * 0.125);
    close(leg.root.rotation.y, 0);
    close(leg.foot.position.z, 0.3);
  }
});

test("horse body follows committed heading but head preserves physical aim in both F5 views", (t) => {
  const visual = new PlayerVisual(new THREE.Scene());
  t.after(() => visual.dispose());
  const state = {
    ...horse(), position: new THREE.Vector3(0.375, 9.95, -0.625), ...gear(),
  };
  for (const perspective of ["back", "front"]) {
    for (const hullYaw of [0, 1.7, -408.72136]) {
      for (const yaw of [-0.43, 2.1]) {
        for (const pitch of [-1.4, 0, 0.6]) {
          Object.assign(state, { perspective, hullYaw, yaw, pitch });
          const snapshot = structuredClone(state);
          visual.update(0.05, Object.freeze({ ...state }));
          close(visual.rig.root.rotation.y, hullYaw + Math.PI);
          const body = new THREE.Vector3(0, 0, 1).transformDirection(visual.rig.root.matrixWorld);
          close(body.distanceTo(new THREE.Vector3(-Math.sin(hullYaw), 0, -Math.cos(hullYaw))), 0);
          const head = new THREE.Vector3(0, 0, 1).transformDirection(visual.rig.head.matrixWorld);
          close(head.distanceTo(new THREE.Vector3(
            -Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch),
          )), 0);
          assert.deepEqual(structuredClone(state), snapshot);
        }
      }
    }
  }
});

test("horse presentation never writes the actual Player camera, aim, motion or held ownership", (t) => {
  const f = mountedPlayerFixture(t), player = f.player;
  const pose = seatPose({ vehicleType: "horse", hullYaw: 1.2 });
  assert.equal(player.update(0, { riderPose: pose }), true);
  player.yaw = -0.43;
  player.pitch = 0.32;
  const visual = new PlayerVisual(new THREE.Scene());
  t.after(() => visual.dispose());
  for (const perspective of ["back", "front", "first"]) {
    player.perspective = perspective;
    const before = playerSnapshot(player);
    const state = Object.freeze({
      position: player.position, yaw: player.yaw, pitch: player.pitch,
      seated: player.seated, vehicleType: pose.vehicleType, hullYaw: pose.hullYaw,
      bodyHeight: player.height, eyeHeight: player.eyeHeight,
      velocityY: player.velocity.y, perspective, ...gear(),
    });
    for (let frame = 0; frame < 8; frame++) visual.update(0.05, state);
    assert.deepEqual(playerSnapshot(player), before);
    if (visual.mesh) {
      assert.notEqual(visual.mesh.position, player.position);
      assert.deepEqual(visual.mesh.position, player.position);
    }
  }
});

test("horse exits restore every boat/standing/crouch joint, including yaw and limb lengths at dt=0", () => {
  for (const state of [
    { yaw: 0.73, pitch: 0.4 },
    { seated: true, yaw: 0.73, pitch: 0.4 },
    { seated: true, vehicleType: "boat", hullYaw: -3, yaw: 0.73, pitch: 0.4 },
    { crouching: true, bodyHeight: 1.5, eyeHeight: 1.27, yaw: 0.73 },
    { vehicleType: "horse", hullYaw: 2, seated: false, yaw: 0.73 },
  ]) {
    const reused = createPlayerRig(), clean = createPlayerRig();
    const appearance = gear();
    posePlayerRig(reused, 0.1, { ...horse({ hullYaw: 2, yaw: -1, pitch: 0.6 }), ...appearance });
    posePlayerRig(reused, 0, { ...state, ...appearance });
    posePlayerRig(clean, 0, { ...state, ...appearance });
    assert.deepEqual(matrices(reused), matrices(clean));
  }
});

test("horse F5 changes reuse bounded local batches and dispose every lazy GPU resource exactly once", (t) => {
  const scene = new THREE.Scene(), visual = new PlayerVisual(scene);
  t.after(() => visual.dispose());
  const state = {
    ...horse({ hullYaw: 0.73, yaw: -0.32, pitch: 0.2 }), ...gear(),
    position: new THREE.Vector3(0.375, 9.95, -0.625), perspective: "first",
  };
  visual.update(0, state);
  assert.equal(visual.rig, null);
  assert.equal(visual.mesh, null);
  state.perspective = "back";
  visual.update(0, state);
  const { mesh, resources, rig } = visual;
  const baseline = mesh.instanceMatrix.array.slice();
  const allNodes = nodes(rig), parts = rig.parts.slice();
  const buffers = [mesh.instanceMatrix.array, mesh.instanceColor.array,
    resources.rects.array, resources.sizes.array, resources.flashes.array];
  for (let frame = 0; frame < 40; frame++) {
    state.perspective = frame % 2 ? "front" : "back";
    state.position.set(frame % 2 ? 29_000_000.375 : -29_000_000.625, 300_000.95, 0.125);
    visual.update(0.05, state);
    assert.equal(visual.rig, rig);
    assert.equal(visual.mesh, mesh);
    assert.equal(visual.resources, resources);
    assert.equal(mesh.instanceMatrix.count, MAX_PLAYER_PARTS);
    assert.ok(mesh.count > 0 && mesh.count <= MAX_PLAYER_PARTS);
    assert.deepEqual(mesh.instanceMatrix.array, baseline);
    assert.deepEqual(nodes(rig), allNodes);
    assert.ok(rig.parts.every((part, i) => part === parts[i]));
    const current = [mesh.instanceMatrix.array, mesh.instanceColor.array,
      resources.rects.array, resources.sizes.array, resources.flashes.array];
    assert.ok(current.every((buffer, i) => buffer === buffers[i]));
    for (let i = 0; i < mesh.count; i++)
      for (const axis of [12, 13, 14])
        assert.ok(Math.abs(mesh.instanceMatrix.array[i * 16 + axis]) < 4);
  }
  const counts = [0, 0, 0, 0];
  [mesh, resources.geometry, resources.material, resources.texture].forEach((resource, i) =>
    resource.addEventListener("dispose", () => counts[i]++));
  state.perspective = "first";
  visual.update(0, state);
  resources.dispose();
  visual.update(0, state);
  assert.deepEqual(counts, [1, 1, 1, 1]);
  assert.equal(scene.children.length, 0);
  state.perspective = "back";
  visual.update(0, state);
  assert.equal(visual.rig, rig);
  assert.notEqual(visual.mesh, mesh);
  assert.notEqual(visual.resources, resources);
});

test("inventory portraits remain standing when handed horse-specific presentation fields", (t) => {
  const standing = new PlayerPortrait(), mounted = new PlayerPortrait();
  t.after(() => { standing.dispose(); mounted.dispose(); });
  const appearance = gear();
  standing.update(appearance);
  mounted.update({ ...appearance, ...horse({ hullYaw: 2, yaw: -1 }) });
  assert.deepEqual(mounted.pixels.data, standing.pixels.data);
  assert.deepEqual(matrices(mounted._rig), matrices(standing._rig));
});
