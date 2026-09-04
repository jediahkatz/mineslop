import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { blockLightRigs } from "./block-light-rig-fixture.js";

test("GPU probe targets hit real anchored opaque and late gel skin geometry", (t) => {
  const scene = new THREE.Scene(), rigs = blockLightRigs(scene);
  t.after(() => rigs.dispose());
  scene.updateMatrixWorld(true);
  assert.equal(rigs.mobs.length, 2);
  for (const target of rigs.mobs) {
    const camera = new THREE.PerspectiveCamera(20, 1, 0.01, 100);
    camera.position.copy(target.point).addScaledVector(target.normal, 0.5);
    camera.up.set(0, target.normal.y ? 0 : 1, target.normal.y ? -1 : 0);
    camera.lookAt(target.point);
    camera.updateMatrixWorld(true);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(), camera);
    const hit = ray.intersectObject(target.group, true)[0];
    assert.ok(hit?.point.distanceTo(target.point) < 0.001, `${target.kind}: probe misses native skin face`);
    assert.ok(hit.uv && Number.isInteger(hit.instanceId));
    for (const mesh of target.group.children) {
      assert.deepEqual(mesh.position.toArray(), [16, 0, 16]);
      assert.equal(mesh.material.map.name, "Original pixel creature skins");
      assert.equal(mesh.material.isMeshLambertMaterial, true);
    }
  }
  assert.ok(rigs.mobs[1].group.children.some((mesh) => mesh.material.transparent));
});

test("return-boundary cow texel is front-facing and hit from the actual observer", (t) => {
  const scene = new THREE.Scene(), rigs = blockLightRigs(scene);
  t.after(() => rigs.dispose());
  const cow = rigs.mobs[0];
  cow.group.position.x = -1.3;
  const point = new THREE.Vector3(15.98, 9.42, 2.45);
  scene.updateMatrixWorld(true);
  for (const x of [12.5, 64.5, 63.99]) {
    const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 512);
    camera.position.set(x, 9.62, 2.5);
    camera.lookAt(16.5, 8, 2.5); camera.updateMatrixWorld(true);
    const projected = point.clone().project(camera);
    const ray = new THREE.Raycaster(camera.position, point.clone().sub(camera.position).normalize());
    const hit = ray.intersectObject(cow.group, true)[0];
    assert.ok(hit?.point.distanceTo(point) < 0.001);
    assert.ok(hit.uv && Number.isInteger(hit.instanceId));
    assert.ok(Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1);
    assert.ok(cow.normal.dot(camera.position.clone().sub(point)) > 0);
  }
});
