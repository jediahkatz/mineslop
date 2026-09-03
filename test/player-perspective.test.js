import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { controlFixture, dispatch } from "./control-fixture.js";

const close = (actual, expected, message = "") =>
  assert.ok(
    Math.abs(actual - expected) < 1e-8,
    `${message}: ${actual} != ${expected}`
  );
const direction = (camera) => camera.getWorldDirection(new THREE.Vector3());

test("F5 perspectives orbit the physical eye without changing pose or player aim", (t) => {
  const f = controlFixture(t);
  f.player.setPosition({ x: 0.5, y: 10, z: 0.5 });
  f.player.yaw = -408.72136;
  f.player.pitch = -0.37;
  f.player.enabled = false;
  f.player.update(1 / 60);
  const position = f.player.position.clone();
  const forward = f.player.forward;
  const eye = f.player.eyePosition;
  const originalEye = eye.clone();
  assert.equal(f.player.perspective, "first");
  close(f.camera.position.distanceTo(eye), 0);
  for (const perspective of ["back", "front", "first"]) {
    assert.equal(f.player.cyclePerspective(), perspective);
    assert.equal(f.player.perspective, perspective);
    assert.equal(f.player.eyePosition, eye, "the eye vector stays stable");
    assert.deepEqual(f.player.position, position);
    assert.deepEqual(f.player.eyePosition, originalEye);
    assert.deepEqual(f.player.forward, forward);
    assert.equal(f.player.yaw, -408.72136);
    assert.equal(f.player.pitch, -0.37);
    const offset = f.camera.position.clone().sub(eye);
    close(offset.length(), perspective === "first" ? 0 : 4);
    if (perspective !== "first")
      close(offset.normalize().dot(forward), perspective === "back" ? -1 : 1);
    close(direction(f.camera).dot(forward), perspective === "front" ? -1 : 1);
  }
  f.player.perspective = "invalid";
  assert.equal(f.player.perspective, "first");
});

test("camera bob never moves the physical interaction origin", (t) => {
  const f = controlFixture(t);
  f.player._bob = 0.02;
  f.player._syncCamera(0);
  close(f.camera.position.y - f.player.eyePosition.y, 0.02);
  close(f.player.eyePosition.y - f.player.position.y, f.player.eyeHeight);
  const eye = f.player.eyePosition.clone();
  f.player.cyclePerspective();
  assert.deepEqual(f.player.eyePosition, eye);
});

for (const perspective of ["back", "front"]) {
  test(`${perspective} camera shortens at a solid wall and restores distance after it clears`, (t) => {
    const f = controlFixture(t);
    f.player.setPosition({ x: 0.5, y: 2, z: 0.5 });
    const wall = perspective === "back" ? 2 : -2;
    f.world.isSolid = (_x, y, z) => y === 0 || z === wall;
    const position = f.player.position.clone();
    f.player.perspective = perspective;
    const blockedDistance = f.camera.position.distanceTo(f.player.eyePosition);
    assert.ok(blockedDistance > 0);
    assert.ok(blockedDistance < 1.5);
    if (perspective === "back") assert.ok(f.camera.position.z < wall - 0.1);
    else assert.ok(f.camera.position.z > wall + 1.1);
    assert.deepEqual(f.player.position, position);
    f.world.isSolid = (_x, y) => y === 0;
    f.player._syncCamera(0);
    close(f.camera.position.distanceTo(f.player.eyePosition), 4);
    assert.deepEqual(f.player.position, position);
  });
}

test("third-person near-plane corners cannot peek through a wall beside the center ray", (t) => {
  const f = controlFixture(t);
  f.player.setPosition({ x: 0.9, y: 2, z: 0.5 });
  f.world.isSolid = (x, _y, z) => x === 1 && z === 2;
  f.player.perspective = "back";
  assert.ok(f.camera.position.x < 1, "the center ray never enters the wall");
  assert.ok(f.camera.position.z < 2);
  assert.ok(f.camera.position.distanceTo(f.player.eyePosition) < 1.5);
});

test("pitched third-person cameras collide with cave floors and ceilings", (t) => {
  const f = controlFixture(t);
  f.world.isSolid = (_x, y) => y === 0 || y === 4;
  f.player.pitch = 0.9;
  const pose = f.player.position.clone();
  f.player.perspective = "back";
  assert.ok(f.camera.position.y > 1.1);
  assert.ok(f.camera.position.distanceTo(f.player.eyePosition) < 4);
  f.player.perspective = "front";
  assert.ok(f.camera.position.y < 3.9);
  assert.ok(f.camera.position.distanceTo(f.player.eyePosition) < 4);
  assert.deepEqual(f.player.position, pose);
  close(direction(f.camera).dot(f.player.forward), -1);
});

test("an unloaded terrain frontier also blocks the third-person camera", (t) => {
  const f = controlFixture(t);
  f.player.setPosition({ x: 0.5, y: 20, z: 0.5 });
  f.player.yaw = Math.PI / 2;
  f.world.isLoaded = (x) => x < 2;
  f.player.perspective = "back";
  assert.ok(f.camera.position.x < 1.9);
  assert.ok(f.camera.position.distanceTo(f.player.eyePosition) < 1.5);
});

test("Native and explicit Remote look still steer the player in front perspective", async (t) => {
  for (const inputMode of ["native", "remote"]) {
    const f = controlFixture(t, { inputMode });
    f.player.setPosition({ x: 0.5, y: 10, z: 0.5 });
    f.player.perspective = "front";
    if (inputMode === "native") {
      await f.player.lock();
      dispatch(f.document, "mousemove", { movementX: 400, movementY: -100 });
    } else {
      f.player.beginRemoteLook(f.event(100));
      dispatch(f.document, "mousemove", f.event(500, 0));
      f.player.endRemoteLook(f.event(500, 0, { timeStamp: 100 }));
      assert.deepEqual(f.calls, []);
    }
    f.player.update(1 / 60);
    close(f.player.yaw, -0.8);
    close(f.player.pitch, 0.2);
    close(direction(f.camera).dot(f.player.forward), -1);
    close(
      f.camera.position
        .clone()
        .sub(f.player.eyePosition)
        .normalize()
        .dot(f.player.forward),
      1
    );
  }
});
