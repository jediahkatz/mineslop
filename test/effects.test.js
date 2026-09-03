import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCKS } from "../src/blocks.js";
import { Effects } from "../src/effects.js";
import { usesHeldSprite } from "../src/held-item.js";
import { ITEM, ITEMS } from "../src/items.js";
import { tileFor } from "../src/textures.js";

test("held glass is translucent and switching back restores opaque rendering", () => {
  const effects = {
    handMaterial: new THREE.MeshLambertMaterial(),
    handGeometry: new THREE.BoxGeometry(),
    atlas: { uvFor: () => [0.25, 0.25, 0.5, 0.5] },
  };
  Effects.prototype.select.call(effects, 9);
  assert.equal(effects.handMaterial.transparent, true);
  assert.equal(effects.handMaterial.depthWrite, false);
  assert.equal(effects.handMaterial.opacity, 0.7);
  Effects.prototype.select.call(effects, 1);
  assert.equal(effects.handMaterial.transparent, false);
  assert.equal(effects.handMaterial.depthWrite, true);
  assert.equal(effects.handMaterial.opacity, 1);
  assert.ok(
    [...effects.handGeometry.getAttribute("uv").array].every(
      (v) => v >= 0.25 && v <= 0.5
    )
  );
  effects.handMaterial.dispose();
  effects.handGeometry.dispose();
});

test("particle instances retain sub-block detail near the large-world boundary", () => {
  const geometry = new THREE.BoxGeometry();
  const material = new THREE.MeshBasicMaterial();
  const mesh = new THREE.InstancedMesh(geometry, material, 1);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(29_000_000, 40, 29_000_000);
  const effects = {
    swing: 0,
    camera,
    mesh,
    hand: new THREE.Object3D(),
    arrows: [],
    matrix: new THREE.Object3D(),
    particles: [
      {
        x: 29_000_000.125,
        y: 40.5,
        z: 29_000_000.75,
        vx: 0,
        vy: 0,
        vz: 0,
        life: 1,
        color: new THREE.Color("#fff"),
      },
    ],
  };
  Effects.prototype.update.call(effects, 0, 0, false, true);
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(0, matrix);
  assert.equal(matrix.elements[12] + mesh.position.x, 29_000_000.125);
  assert.equal(matrix.elements[14] + mesh.position.z, 29_000_000.75);
  geometry.dispose();
  material.dispose();
  mesh.dispose();
});

test("survival food, tools, and empty hands never enter the block texture atlas", () => {
  const material = new THREE.MeshLambertMaterial();
  const geometry = new THREE.BoxGeometry();
  const texture = new THREE.Texture();
  const effects = {
    handMaterial: material,
    handGeometry: geometry,
    held: new THREE.Object3D(),
    itemMesh: new THREE.Object3D(),
    itemMaterial: new THREE.MeshLambertMaterial(),
    itemTextures: new Map([
      [ITEM.APPLE, texture],
      [ITEM.WOOD_PICKAXE, texture],
    ]),
    atlas: {
      uvFor(id) {
        assert.ok(id > 0 && BLOCKS[id], `No texture for block ${id}`);
        return [0, 0, 1, 1];
      },
    },
  };
  for (const id of [ITEM.APPLE, ITEM.WOOD_PICKAXE]) {
    Effects.prototype.select.call(effects, id);
    assert.equal(effects.held.visible, false);
    assert.equal(effects.itemMesh.visible, true);
    assert.equal(effects.itemMaterial.map, texture);
  }
  Effects.prototype.select.call(effects, 0);
  assert.equal(effects.held.visible, false);
  assert.equal(effects.itemMesh.visible, false);
  Effects.prototype.select.call(effects, 1);
  assert.equal(effects.held.visible, true);
  assert.equal(effects.itemMesh.visible, false);
  material.dispose();
  geometry.dispose();
  texture.dispose();
  effects.itemMaterial.dispose();
});

test("every inventory item can be equipped using its correct rendering path", () => {
  const texture = new THREE.Texture();
  const effects = {
    handMaterial: new THREE.MeshLambertMaterial(),
    handGeometry: new THREE.BoxGeometry(),
    held: new THREE.Object3D(),
    itemMesh: new THREE.Object3D(),
    itemMaterial: new THREE.MeshLambertMaterial(),
    itemTextures: new Map(
      ITEMS.filter((item) => usesHeldSprite(item.id)).map((item) => [
        item.id,
        texture,
      ])
    ),
    atlas: {
      uvFor(id, face) {
        tileFor(id, face);
        return [0, 0, 1, 1];
      },
    },
  };
  for (const item of ITEMS) {
    assert.doesNotThrow(
      () => Effects.prototype.select.call(effects, item.id),
      item.name
    );
    assert.equal(
      effects.held.visible,
      item.id > 0 && Boolean(BLOCKS[item.id]) && !usesHeldSprite(item.id)
    );
    assert.equal(
      effects.itemMesh.visible,
      item.id > 0 && usesHeldSprite(item.id)
    );
  }
  effects.handMaterial.dispose();
  effects.handGeometry.dispose();
  effects.itemMaterial.dispose();
  texture.dispose();
});

test("effects release both owned atlas textures when the scene is disposed", () => {
  const disposed = [];
  const disposable = (name) => ({ dispose: () => disposed.push(name) });
  const effects = Object.fromEntries(
    [
      "arrowGeometry",
      "arrowMaterial",
      "mesh",
      "geometry",
      "material",
      "handGeometry",
      "handMaterial",
      "itemGeometry",
      "itemMaterial",
      "armGeometry",
      "armMaterial",
    ].map((name) => [name, disposable(name)])
  );
  Object.assign(effects, {
    arrows: [],
    itemTextures: new Map(),
    scene: { remove() {} },
    camera: { remove() {} },
    atlas: {
      texture: disposable("diffuse-atlas"),
      emissiveTexture: disposable("berry-emission-atlas"),
    },
  });
  Effects.prototype.dispose.call(effects);
  assert.equal(disposed.filter((name) => name === "diffuse-atlas").length, 1);
  assert.equal(
    disposed.filter((name) => name === "berry-emission-atlas").length,
    1
  );
});
