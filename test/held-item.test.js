import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import {
  createHeldItemView,
  disposeHeldItemView,
  selectHeldItem,
  updateHeldItemView,
  usesHeldSprite,
} from "../src/held-item.js";
import { ITEM, ITEMS } from "../src/items.js";

function fixture(t) {
  const camera = new THREE.PerspectiveCamera();
  const texture = new THREE.Texture();
  const atlas = { texture, uvFor: () => [0.1, 0.2, 0.4, 0.6] };
  const textures = new Map(
    ITEMS.filter((item) => usesHeldSprite(item.id)).map((item) => [
      item.id,
      texture,
    ])
  );
  const main = createHeldItemView(camera, atlas, textures);
  const offhand = createHeldItemView(camera, atlas, textures, true);
  t.after(() => {
    disposeHeldItemView(main);
    disposeHeldItemView(offhand);
    texture.dispose();
  });
  return { camera, main, offhand, texture };
}

function horizontalAnchor(view) {
  const tangent = Math.tan((view.camera.fov * Math.PI) / 360);
  return (
    view.hand.position.x / -view.hand.position.z / tangent / view.camera.aspect
  );
}

test("offhand rendering is independent while both hands share cached item images", (t) => {
  const { main, offhand, texture } = fixture(t);
  selectHeldItem(main, BLOCK.GLASS);
  selectHeldItem(offhand, BLOCK.STONE);
  assert.notEqual(main.handGeometry, offhand.handGeometry);
  assert.notEqual(main.handMaterial, offhand.handMaterial);
  assert.equal(main.handMaterial.transparent, true);
  assert.equal(offhand.handMaterial.transparent, false);
  selectHeldItem(main, ITEM.WOOD_PICKAXE);
  selectHeldItem(offhand, ITEM.WOOD_PICKAXE);
  assert.equal(main.itemMaterial.map, texture);
  assert.equal(offhand.itemMaterial.map, texture);
  assert.notEqual(main.itemMaterial, offhand.itemMaterial);
  selectHeldItem(main, BLOCK.STONE);
  assert.equal(main.handMaterial.transparent, false);
  assert.equal(offhand.itemMesh.visible, true);
});

test("empty offhands remain hidden and HUD/perspective visibility hides both hands", (t) => {
  const { main, offhand } = fixture(t);
  selectHeldItem(main, 0);
  selectHeldItem(offhand, 0);
  updateHeldItemView(main, 0, 0, false, true);
  updateHeldItemView(offhand, 0, 0, false, true);
  assert.equal(main.hand.visible, true, "the empty main hand still has an arm");
  assert.equal(main.held.visible, false);
  assert.equal(offhand.hand.visible, false);
  selectHeldItem(offhand, BLOCK.TORCH);
  updateHeldItemView(offhand, 0, 0, false, true);
  assert.equal(offhand.hand.visible, true);
  updateHeldItemView(main, 0, 0, false, false);
  updateHeldItemView(offhand, 0, 0, false, false);
  assert.equal(main.hand.visible, false);
  assert.equal(offhand.hand.visible, false);
});

test("held-use poses apply to the correct hand and reset after release", (t) => {
  const { main, offhand } = fixture(t);
  selectHeldItem(main, ITEM.BOW);
  selectHeldItem(offhand, ITEM.APPLE);
  const food = { active: true, kind: "food", hand: "offhand", progress: 0.5 };
  updateHeldItemView(main, 0, 2, false, true, food);
  updateHeldItemView(offhand, 0, 2, false, true, food);
  assert.ok(Math.abs(horizontalAnchor(main) - 0.76) < 1e-9);
  assert.ok(Math.abs(horizontalAnchor(offhand) + 0.42) < 1e-9);
  assert.equal(offhand.hand.position.z, -0.72);
  updateHeldItemView(main, 0, 2, false, true, {
    active: true,
    kind: "bow",
    hand: "main",
    progress: 0.8,
  });
  assert.ok(Math.abs(horizontalAnchor(main) - 0.33) < 1e-9);
  assert.ok(main.itemMesh.scale.y > 1);
  updateHeldItemView(offhand, 0, 2, false, true, {
    active: true,
    kind: "shield",
    hand: "offhand",
    progress: 1,
  });
  assert.ok(Math.abs(horizontalAnchor(offhand) + 0.48) < 1e-9);
  assert.equal(offhand.itemMesh.scale.x, 1.6);
  for (const hand of [main, offhand]) {
    updateHeldItemView(hand, 0.1, 2, false, true, { active: false });
    assert.equal(hand.hand.position.z, -0.82);
    assert.equal(hand.itemMesh.scale.x, 1);
    hand.hand.updateMatrixWorld(true);
    assert.ok(hand.hand.matrixWorld.elements.every(Number.isFinite));
  }
});

test("idle items remain at the screen edge across aspect and FOV changes", (t) => {
  const { camera, main, offhand } = fixture(t);
  selectHeldItem(main, ITEM.APPLE);
  selectHeldItem(offhand, ITEM.APPLE);
  for (const aspect of [4 / 3, 16 / 9, 21 / 9]) {
    for (const fov of [60, 75, 90]) {
      camera.aspect = aspect;
      camera.fov = fov;
      camera.updateProjectionMatrix();
      for (const view of [main, offhand]) {
        view.swing = 0;
        updateHeldItemView(view, 0, 0, false, true);
      }
      camera.updateMatrixWorld(true);
      const bounds = (view) => {
        const positions = view.itemGeometry.getAttribute("position");
        return Array.from(
          { length: positions.count },
          (_, index) =>
            new THREE.Vector3()
              .fromBufferAttribute(positions, index)
              .applyMatrix4(view.itemMesh.matrixWorld)
              .project(camera).x
        );
      };
      assert.ok(
        Math.min(...bounds(main)) > 0.5,
        "main item clears the central HUD"
      );
      assert.ok(
        Math.max(...bounds(offhand)) < -0.5,
        "offhand item clears the central HUD"
      );
    }
  }
});

test("cross-shaped plants use their sprite instead of a transparent textured cube", (t) => {
  const { main } = fixture(t);
  for (const id of [BLOCK.CAVE_VINE, BLOCK.GLOW_BERRIES]) {
    assert.equal(usesHeldSprite(id), true);
    selectHeldItem(main, id);
    assert.equal(main.held.visible, false);
    assert.equal(main.itemMesh.visible, true);
  }
  assert.equal(usesHeldSprite(BLOCK.STONE), false);
});

test("disposing hand views removes their objects but does not dispose shared textures", () => {
  const camera = new THREE.PerspectiveCamera();
  const texture = new THREE.Texture();
  let textureDisposals = 0;
  texture.addEventListener("dispose", () => textureDisposals++);
  const hand = createHeldItemView(camera, { texture }, new Map());
  let geometryDisposals = 0;
  for (const geometry of [
    hand.handGeometry,
    hand.itemGeometry,
    hand.armGeometry,
  ])
    geometry.addEventListener("dispose", () => geometryDisposals++);
  disposeHeldItemView(hand);
  assert.equal(camera.children.length, 0);
  assert.equal(geometryDisposals, 3);
  assert.equal(textureDisposals, 0);
  texture.dispose();
});
