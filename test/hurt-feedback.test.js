import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  HURT_MAX_FLASH,
  HURT_MAX_ROLL,
  HURT_SECONDS,
} from "../src/hurt-feedback.js";
import { controlFixture, dispatch } from "./control-fixture.js";
import { hurtFixture } from "./hurt-fixture.js";

const emptyView = { visible: false, roll: 0, flash: 0, tint: 0 };
const near = (a, b, tolerance = 1e-7) =>
  assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

function physical(player) {
  return {
    position: player.position.toArray(),
    eye: player.eyePosition.toArray(),
    forward: player.forward.toArray(),
    velocity: player.velocity.toArray(),
    yaw: player.yaw,
    pitch: player.pitch,
    flying: player.flying,
    grounded: player.grounded,
    fallDistance: player.fallDistance,
  };
}

function cameraState(camera) {
  return {
    position: camera.position.toArray(),
    rotation: camera.rotation.toArray(),
    quaternion: camera.quaternion.toArray(),
    matrix: camera.matrix.toArray(),
    world: camera.matrixWorld.toArray(),
    inverseWorld: camera.matrixWorldInverse.toArray(),
    projection: camera.projectionMatrix.toArray(),
    inverseProjection: camera.projectionMatrixInverse.toArray(),
    fov: camera.fov,
    aspect: camera.aspect,
  };
}

test("a real hit produces a bounded decaying pulse and repeated hits refresh instead of stacking", (t) => {
  const { gameplay, feedback } = hurtFixture(t);
  assert.deepEqual(feedback.update(0), emptyView);
  assert.equal(gameplay.damage(4, "fall"), 4);
  const initial = feedback.update(0);
  assert.equal(initial.visible, true);
  assert.ok(
    Math.abs(initial.roll) > 0 && Math.abs(initial.roll) <= HURT_MAX_ROLL
  );
  assert.ok(initial.flash > 0 && initial.flash <= HURT_MAX_FLASH);
  const halfway = feedback.update(HURT_SECONDS / 2);
  assert.ok(Math.abs(halfway.roll) < Math.abs(initial.roll));
  assert.ok(halfway.flash < initial.flash);
  assert.ok(halfway.tint < initial.tint);
  for (let hit = 0; hit < 200; hit++) {
    assert.ok(gameplay.damage(0.005, "fall") > 0);
    const view = feedback.update(0.001);
    assert.ok(feedback.remaining > 0 && feedback.remaining <= HURT_SECONDS);
    assert.ok(Math.abs(view.roll) <= HURT_MAX_ROLL);
    assert.ok(view.flash <= HURT_MAX_FLASH);
    assert.ok(view.tint >= 0 && view.tint <= 1);
  }
  assert.deepEqual(feedback.update(HURT_SECONDS), emptyView);
  assert.equal(feedback.remaining, 0);
  assert.equal(feedback.strength, 0);
  assert.deepEqual(feedback.update(10_000), emptyView);
});

test("pause freezes simulation age but hides motion/flash; active hidden overlays still age the pulse", (t) => {
  const { gameplay, feedback } = hurtFixture(t);
  gameplay.damage(2, "fall");
  const initial = feedback.update(0);
  const remaining = feedback.remaining;
  assert.deepEqual(feedback.update(900, { simulating: false }), emptyView);
  assert.equal(feedback.remaining, remaining);
  assert.deepEqual(feedback.update(0), initial);
  assert.deepEqual(feedback.update(0.1, { visible: false }), emptyView);
  assert.ok(feedback.remaining < remaining);
  assert.ok(feedback.update(0).flash < initial.flash);
  feedback.reset();
  assert.deepEqual(feedback.update(0), emptyView);
});

test("reduced-motion preference removes roll immediately while preserving readable color feedback", (t) => {
  const preference = { matches: true };
  const { gameplay, feedback } = hurtFixture(t, {
    motionPreference: preference,
  });
  gameplay.damage(3, "fall");
  const reduced = feedback.update(0);
  assert.equal(reduced.roll, 0);
  assert.ok(reduced.flash > 0);
  assert.ok(reduced.tint > 0);
  preference.matches = false;
  const moving = feedback.update(0);
  assert.notEqual(moving.roll, 0);
  assert.equal(moving.flash, reduced.flash);
  assert.equal(moving.tint, reduced.tint);
  preference.matches = true;
  const camera = new THREE.PerspectiveCamera();
  const before = cameraState(camera);
  feedback.render(camera, moving, () => {
    assert.deepEqual(
      cameraState(camera),
      before,
      "preference also gates a previously sampled view"
    );
  });
});

test("invalid events/timesteps never create or corrupt a pulse; death, reset and disposal clear it", (t) => {
  const { gameplay, feedback } = hurtFixture(t);
  for (const event of [
    {},
    { previousHealth: 20, health: 20, damage: 0, dead: false },
    { previousHealth: 10, health: 15, damage: -5, dead: false },
    { previousHealth: 20, health: 19, damage: 0, dead: false },
    { previousHealth: Infinity, health: 19, damage: Infinity, dead: false },
    { previousHealth: 20, health: NaN, damage: 1, dead: false },
    { previousHealth: 20, health: -1, damage: 21, dead: true },
  ])
    assert.equal(feedback.noteHealthLoss(event), false);
  assert.deepEqual(feedback.update(0), emptyView);
  gameplay.damage(1);
  const valid = feedback.update(0);
  for (const dt of [undefined, NaN, Infinity, -1])
    assert.deepEqual(feedback.update(dt), valid);
  gameplay.damage(30);
  assert.equal(gameplay.dead, true);
  assert.deepEqual(feedback.update(0), emptyView);
  gameplay.respawn();
  assert.deepEqual(feedback.update(0), emptyView);
  gameplay.damage(1);
  assert.equal(feedback.update(0).visible, true);
  assert.deepEqual(feedback.update(0, { dead: true }), emptyView);
  gameplay.damage(1);
  feedback.dispose();
  gameplay.damage(1);
  assert.deepEqual(feedback.update(0), emptyView);
});

test("view-axis roll changes the projected image but never pose, center aim or camera state across F5", (t) => {
  const { gameplay, feedback } = hurtFixture(t);
  const f = controlFixture(t);
  f.player.enabled = false;
  f.player.setPosition({ x: 29_000_000.375, y: 43.625, z: -29_000_000.125 });
  f.player.yaw = -408.72136;
  f.player.pitch = 0.47;
  f.player.velocity.set(1.3, -2.7, 0.4);
  f.camera.aspect = 16 / 9;
  f.camera.updateProjectionMatrix();
  f.player.update(0.001);
  gameplay.damage(4, "fall");
  const view = feedback.update(0);
  const raycaster = new THREE.Raycaster();
  const center = new THREE.Vector2();
  const originalEye = f.player.eyePosition;
  const resources = [feedback._projection, feedback._inverse, feedback._roll];
  for (const perspective of ["first", "back", "front", "first"]) {
    f.player.perspective = perspective;
    const pose = physical(f.player);
    const before = cameraState(f.camera);
    raycaster.setFromCamera(center, f.camera);
    const centerRay = raycaster.ray.clone();
    const point = new THREE.Vector3(1, 0, -5).applyMatrix4(
      f.camera.matrixWorld
    );
    const unrolled = point.clone().project(f.camera);
    for (let draw = 0; draw < 80; draw++) {
      const result = feedback.render(f.camera, view, () => {
        assert.deepEqual(physical(f.player), pose);
        assert.deepEqual(f.camera.quaternion.toArray(), before.quaternion);
        assert.deepEqual(f.camera.rotation.toArray(), before.rotation);
        assert.deepEqual(f.camera.position.toArray(), before.position);
        raycaster.setFromCamera(center, f.camera);
        near(raycaster.ray.origin.distanceTo(centerRay.origin), 0);
        near(raycaster.ray.direction.distanceTo(centerRay.direction), 0);
        const rolled = point.clone().project(f.camera);
        assert.ok(
          Math.abs(rolled.y - unrolled.y) > 1e-4,
          "the actual rendered projection tilts"
        );
        return "drawn";
      });
      assert.equal(result, "drawn");
      assert.deepEqual(
        cameraState(f.camera),
        before,
        "bit-exact restoration; no frame-to-frame drift"
      );
      assert.equal(f.player.eyePosition, originalEye);
    }
  }
  assert.equal(feedback._projection, resources[0]);
  assert.equal(feedback._inverse, resources[1]);
  assert.equal(feedback._roll, resources[2]);
});

test("native/remote look and movement retain the same physical steering during a hurt frame", async (t) => {
  for (const inputMode of ["native", "remote"]) {
    const { gameplay, feedback } = hurtFixture(t);
    const f = controlFixture(t, { inputMode });
    f.player.allowFlight = false;
    f.player.perspective = "front";
    if (inputMode === "native") {
      await f.player.lock();
      dispatch(f.document, "mousemove", { movementX: 400, movementY: -100 });
    } else {
      f.player.beginRemoteLook(f.event(100));
      dispatch(f.document, "mousemove", f.event(500, 0));
      f.player.endRemoteLook(f.event(500, 0, { timeStamp: 100 }));
    }
    dispatch(f.document, "keydown", { code: "KeyW" });
    f.player.update(0.05);
    near(f.player.yaw, -0.8);
    near(f.player.pitch, 0.2);
    assert.ok(f.player.moving);
    gameplay.damage(2, "fall");
    const before = physical(f.player);
    feedback.render(f.camera, feedback.update(0), () => {
      assert.deepEqual(physical(f.player), before);
    });
    assert.deepEqual(physical(f.player), before);
    f.player.update(0.05);
    assert.notDeepEqual(f.player.position.toArray(), before.position);
    near(f.player.yaw, -0.8);
    near(f.player.pitch, 0.2);
  }
});

test("draw errors, nested draws, camera replacement and reset cannot retain a rolled projection", (t) => {
  const { gameplay, feedback } = hurtFixture(t);
  gameplay.damage(4, "fall");
  const view = feedback.update(0);
  const first = new THREE.PerspectiveCamera(75, 16 / 9);
  const second = new THREE.PerspectiveCamera(80, 4 / 3);
  const firstState = cameraState(first);
  const secondState = cameraState(second);
  const failure = new Error("draw failed");
  assert.throws(
    () =>
      feedback.render(first, view, () => {
        throw failure;
      }),
    failure
  );
  assert.deepEqual(cameraState(first), firstState);
  feedback.render(second, view, () => {
    const outerProjection = second.projectionMatrix.toArray();
    feedback.render(second, view, () => {
      assert.deepEqual(second.projectionMatrix.toArray(), outerProjection);
    });
    feedback.reset();
  });
  assert.deepEqual(cameraState(first), firstState);
  assert.deepEqual(cameraState(second), secondState);
  feedback.render(first, view, () => {
    assert.deepEqual(
      cameraState(first),
      firstState,
      "reset also invalidates a previously sampled view"
    );
  });
  assert.deepEqual(feedback.update(0), emptyView);
});
