import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { HURT_SECONDS } from "../src/hurt-feedback.js";
import { ITEM } from "../src/items.js";
import { MAX_PLAYER_PARTS } from "../src/player-skin.js";
import { PlayerVisual } from "../src/player-visual.js";
import { hurtFixture } from "./hurt-fixture.js";

function fixture(t) {
  const scene = new THREE.Scene();
  const visual = new PlayerVisual(scene);
  t.after(() => visual.dispose());
  const state = {
    position: new THREE.Vector3(29_000_000.375, 43.625, -29_000_000.125),
    yaw: -408.72136,
    pitch: 0.47,
    perspective: "back",
    mainHand: { id: ITEM.IRON_SWORD, count: 1, durability: 20 },
    offhand: { id: ITEM.SHIELD, count: 1, durability: 30 },
    equipment: {},
  };
  return { ...hurtFixture(t), scene, visual, state };
}

test("committed hurt tints the existing avatar batch and restores base colors without moving the rig", (t) => {
  const { gameplay, feedback, visual, state } = fixture(t);
  visual.update(0, state);
  const mesh = visual.mesh;
  const resources = visual.resources;
  const colors = mesh.instanceColor.array.slice();
  const matrices = mesh.instanceMatrix.array.slice();
  const rigColors = visual.rig.parts.map((part) => part.color.toArray());
  const buffers = [
    mesh.instanceColor.array,
    mesh.instanceMatrix.array,
    resources.flashes.array,
  ];
  const pose = state.position.toArray();
  gameplay.damage(6, "fall");
  for (let frame = 0; frame < 80; frame++) {
    const hurt = feedback.update(0);
    visual.update(0, { ...state, hurtTint: hurt.tint });
    assert.equal(visual.mesh, mesh);
    assert.equal(visual.resources, resources);
    assert.equal(mesh.material, resources.material);
    assert.equal(mesh.geometry, resources.geometry);
    assert.equal(mesh.instanceColor.array, buffers[0]);
    assert.equal(mesh.instanceMatrix.array, buffers[1]);
    assert.equal(resources.flashes.array, buffers[2]);
    assert.equal(resources.flashes.count, MAX_PLAYER_PARTS);
    assert.deepEqual(mesh.instanceMatrix.array, matrices);
  }
  assert.notDeepEqual(mesh.instanceColor.array, colors);
  assert.ok(
    resources.flashes.array
      .slice(0, mesh.count)
      .every((value) => value > 0 && value <= 1)
  );
  assert.deepEqual(
    visual.rig.parts.map((part) => part.color.toArray()),
    rigColors
  );
  assert.deepEqual(state.position.toArray(), pose);
  const quiet = feedback.update(HURT_SECONDS);
  visual.update(0, { ...state, hurtTint: quiet.tint });
  assert.deepEqual(mesh.instanceColor.array, colors);
  assert.ok(
    resources.flashes.array.slice(0, mesh.count).every((value) => value === 0)
  );
});

test("reduced-motion hurt still tints; hide/F5 and death cannot leak tint into another avatar or new batch", (t) => {
  const a = fixture(t);
  const b = fixture(t);
  a.visual.update(0, a.state);
  b.visual.update(0, b.state);
  assert.equal(a.visual.resources.atlas, b.visual.resources.atlas);
  const siblingColors = b.visual.mesh.instanceColor.array.slice();
  const resources = a.visual.resources;
  let disposals = 0;
  resources.material.addEventListener("dispose", () => disposals++);
  a.motionPreference.matches = true;
  a.gameplay.damage(2);
  const reduced = a.feedback.update(0);
  assert.equal(reduced.roll, 0);
  a.visual.update(0, { ...a.state, hurtTint: reduced.tint });
  assert.deepEqual(b.visual.mesh.instanceColor.array, siblingColors);
  assert.ok(b.visual.resources.flashes.array.every((value) => value === 0));
  a.visual.update(0, { perspective: "first" });
  assert.equal(disposals, 1);
  assert.equal(a.visual.mesh, null);
  assert.equal(a.scene.children.length, 0);
  a.gameplay.damage(50);
  a.gameplay.respawn();
  a.visual.update(0, {
    ...a.state,
    perspective: "front",
    hurtTint: a.feedback.update(0).tint,
  });
  assert.notEqual(a.visual.resources, resources);
  assert.ok(a.visual.resources.flashes.array.every((value) => value === 0));
  assert.equal(a.scene.children.length, 1);
  assert.equal(disposals, 1);
});

test("invalid or absent avatar tint is neutral and pause/reset clears a live tint without allocating a material", (t) => {
  const { gameplay, feedback, visual, state } = fixture(t);
  visual.update(0, state);
  const material = visual.resources.material;
  const colors = visual.mesh.instanceColor.array.slice();
  for (const hurtTint of [undefined, NaN, Infinity, -1]) {
    visual.update(0, { ...state, hurtTint });
    assert.deepEqual(visual.mesh.instanceColor.array, colors);
    assert.ok(visual.resources.flashes.array.every((value) => value === 0));
  }
  gameplay.damage(3);
  visual.update(0, { ...state, hurtTint: feedback.update(0).tint });
  assert.notDeepEqual(visual.mesh.instanceColor.array, colors);
  visual.update(0, {
    ...state,
    hurtTint: feedback.update(100, { simulating: false }).tint,
  });
  assert.deepEqual(visual.mesh.instanceColor.array, colors);
  assert.equal(visual.resources.material, material);
  feedback.reset();
  visual.dispose();
  visual.update(0, { ...state, hurtTint: 1 });
  assert.equal(visual.mesh, null);
});
