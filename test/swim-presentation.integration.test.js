import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { FLUID } from "../src/block-state.js";
import { ITEM } from "../src/items.js";
import { ItemUse } from "../src/item-use.js";
import { Effects } from "../src/effects.js";
import { PlayerVisual } from "../src/player-visual.js";
import { MAX_PLAYER_PARTS } from "../src/player-skin.js";
import {
  createHeldItemView, disposeHeldItemView, selectHeldItem, updateHeldItemView,
} from "../src/held-item.js";
import { controlFixture, dispatch } from "./control-fixture.js";
import { shapeWorld } from "./shape-fixture.js";

function fixture(t) {
  const f = controlFixture(t);
  const cells = [];
  for (let x = -2; x <= 2; x++)
    for (let z = -5; z <= 2; z++) {
      cells.push([x, 0, z, BLOCK.STONE]);
      for (let y = 1; y <= 4; y++)
        cells.push([x, y, z, BLOCK.WATER, 0, FLUID.WATER_SOURCE]);
    }
  f.player.world = shapeWorld(cells);
  f.player.allowFlight = false;
  f.player.setPosition({ x: 0.5, y: 2, z: 0.5 });
  const scene = new THREE.Scene(), visual = new PlayerVisual(scene);
  const texture = new THREE.Texture();
  const main = createHeldItemView(f.camera, { texture }, new Map([[ITEM.BOW, texture]]));
  selectHeldItem(main, ITEM.BOW);
  const use = new ItemUse();
  const inventory = Object.freeze({
    mainHand: Object.freeze({ id: ITEM.BOW, count: 1, durability: 17 }),
    offhand: Object.freeze({ id: ITEM.SHIELD, count: 1, durability: 19 }),
    equipment: Object.freeze({}),
  });
  t.after(() => { visual.dispose(); disposeHeldItemView(main); texture.dispose(); });
  return { ...f, scene, visual, main, use, inventory };
}
function physical(player) {
  return JSON.stringify({
    position: player.position, velocity: player.velocity, eye: player.eyePosition,
    yaw: player.yaw, pitch: player.pitch, height: player.height, eyeHeight: player.eyeHeight,
    grounded: player.grounded, moving: player.moving, climbing: player.climbing,
    flying: player.flying, seated: player.seated, revision: player.poseRevision,
    fluid: player.fluidState, queries: player.fluidDiagnostics(),
    camera: [player.camera.position.toArray(), player.camera.quaternion.toArray()],
  });
}
function observation(f, perspective = "back") {
  const p = f.player;
  // Explicit host hook until Player/Game own accepted-swimming forwarding.
  // This fixture exercises a fully submerged, non-grounded accepted update;
  // it deliberately does not install a competing production fluid heuristic.
  assert.ok(p.fluidState.waterImmersion > 0.9);
  assert.equal(p.grounded, false);
  return {
    position: p.position, yaw: p.yaw, pitch: p.pitch, bodyHeight: p.height,
    eyeHeight: p.eyeHeight, velocityY: p.velocity.y,
    swimming: true, fluidKnown: !p.fluidMovementBlocked,
    moving: p.moving, grounded: p.grounded, seated: p.seated,
    flying: p.flying, climbing: p.climbing, perspective,
    ...f.inventory,
  };
}

test("real Player accepted water input + render poses leave physics, inventory and ItemUse untouched", (t) => {
  const f = fixture(t);
  dispatch(f.document, "keydown", { code: "KeyW", target: f.element, timeStamp: 1000 });
  f.player.update(1 / 60, { recoverFromVoid: false });
  assert.equal(f.player.moving, true);
  const state = observation(f), before = physical(f.player);
  const inventory = JSON.stringify(f.inventory);
  f.use.start("bow", "main", ITEM.BOW);
  f.use.advance(0.3);
  const action = f.use.snapshot();
  for (let i = 0; i < 120; i++) {
    f.visual.update(1 / 60, state);
    updateHeldItemView(f.main, 1 / 60, i, true, true, f.use, state);
  }
  assert.equal(physical(f.player), before, "no scans, camera/eye/aim/collider or velocity edits");
  assert.equal(JSON.stringify(f.inventory), inventory);
  assert.deepEqual(f.use.snapshot(), action, "no use/charge/reach clocks change");
  assert.ok(f.visual.rig.swim.weight.value > 0.99);
  assert.ok(f.main.motion.bow.value > 0.99);
  assert.ok(f.main.hand.position.z > -0.77 && f.main.hand.position.z < -0.75);
});

test("first/back/front water snapshots reset on hidden/lifecycle edges with fixed owner budgets", (t) => {
  const f = fixture(t);
  f.player.update(1 / 60, { recoverFromVoid: false });
  const state = observation(f);
  const first = { ...state, perspective: "first" };
  f.visual.update(0, first);
  assert.equal(f.scene.children.length, 0);
  f.visual.update(0, state);
  const drySnapshot = f.visual.mesh.instanceMatrix.array.slice();
  for (let i = 0; i < 40; i++) f.visual.update(1 / 60, state);
  const mesh = f.visual.mesh, rig = f.visual.rig, resources = f.visual.resources;
  const parts = rig.parts.slice(), nodes = parts.map((part) => part.node);
  const swimming = mesh.instanceMatrix.array.slice();
  assert.notDeepEqual(swimming, drySnapshot);
  f.visual.update(0, { ...state, perspective: "front" });
  assert.deepEqual(mesh.instanceMatrix.array, swimming, "F5 back/front keeps the same body snapshot");
  for (let i = 0; i < 2000; i++) f.visual.update(1 / 144, state);
  assert.equal(f.visual.mesh, mesh);
  assert.equal(f.visual.resources, resources);
  assert.equal(f.visual.rig, rig);
  assert.deepEqual(rig.parts, parts);
  assert.deepEqual(rig.parts.map((part) => part.node), nodes);
  assert.equal(mesh.instanceMatrix.count, MAX_PLAYER_PARTS);
  assert.equal(f.scene.children.length, 1);
  let disposed = 0;
  mesh.addEventListener("dispose", () => disposed++);
  f.visual.update(0, first);
  assert.equal(disposed, 1);
  assert.equal(rig.swim.weight.value, 0);
  assert.equal(f.scene.children.length, 0);
  f.visual.update(0, state);
  assert.equal(f.visual.rig, rig, "reuse CPU rig without stale gait/swim");
  assert.deepEqual(f.visual.mesh.instanceMatrix.array, drySnapshot);
  f.visual.dispose();
  f.visual.update(0.1, state);
  assert.equal(f.visual.rig, null);
  assert.equal(f.scene.children.length, 0);
});

test("real held-view hiding, bob and reduced-motion reset/decorate without new geometry", (t) => {
  const f = fixture(t);
  f.player.update(1 / 60, { recoverFromVoid: false });
  const state = observation(f);
  const view = f.main, geometry = view.handGeometry, children = view.hand.children.slice();
  updateHeldItemView(view, 0, 0, false, false);
  updateHeldItemView(view, 0, 0, false, true);
  const idle = view.hand.position.toArray();
  for (let i = 0; i < 90; i++)
    updateHeldItemView(view, 1 / 60, i, false, true, null, state);
  assert.notDeepEqual(view.hand.position.toArray(), idle);
  view.motionPreference = { matches: true };
  updateHeldItemView(view, 0, 0, false, true, null, state);
  assert.deepEqual(view.hand.position.toArray(), idle);
  view.motionPreference.matches = false;
  updateHeldItemView(view, 0, 0, false, true, null, { ...state, bob: false });
  assert.deepEqual(view.hand.position.toArray(), idle);
  updateHeldItemView(view, 0, 0, false, false, null, state);
  assert.equal(view.motion.swim.phase, 0);
  assert.equal(view.hand.visible, false);
  updateHeldItemView(view, 0, 0, false, true, null, state);
  assert.deepEqual(view.hand.position.toArray(), idle);
  assert.equal(view.handGeometry, geometry);
  assert.deepEqual(view.hand.children, children);
});

test("Effects forwards the same accepted swim observation to both retained hands", (t) => {
  const f = fixture(t);
  f.player.update(1 / 60, { recoverFromVoid: false });
  const state = observation(f);
  const texture = new THREE.Texture();
  const offhand = createHeldItemView(
    f.camera, { texture }, new Map([[ITEM.SHIELD, texture]]), true
  );
  selectHeldItem(offhand, ITEM.SHIELD);
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 1
  );
  const effects = Object.assign({}, f.main, {
    offhand, mesh, arrows: [], particles: [], scene: f.scene,
  });
  t.after(() => {
    disposeHeldItemView(offhand);
    mesh.dispose();
    mesh.geometry.dispose();
    mesh.material.dispose();
    texture.dispose();
  });
  for (let i = 0; i < 60; i++)
    Effects.prototype.update.call(effects, 1 / 60, i, false, true, null, state);
  assert.ok(effects.motion.swim.weight.value > 0.99);
  assert.equal(offhand.motion.swim.weight.value, effects.motion.swim.weight.value);
  assert.equal(offhand.motion.swim.phase, effects.motion.swim.phase);
  Effects.prototype.update.call(effects, 0, 0, false, false, null, state);
  assert.equal(offhand.motion.swim.weight.value, 0);
  assert.equal(effects.motion.swim.weight.value, 0);
});
