import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { EYE_HEIGHT, MAX_LOOK_PITCH, PLAYER_HEIGHT } from "../src/player.js";
import { dispatch, InputElement } from "./control-fixture.js";
import {
  close,
  exitPose,
  freezePose,
  keyDown,
  keyUp,
  mountedPlayerFixture,
  seatPose,
  tap,
} from "./mounted-player-fixture.js";

test("vehicleKeys borrows the stable raw set only when enabled and inputReady", async (t) => {
  const f = mountedPlayerFixture(t, { preferences: { inputMode: "native" } });
  const p = f.player,
    keys = p._keys;
  keyDown(f, "KeyW");
  assert.equal(p.inputReady, false);
  assert.equal(p.vehicleKeys, null);
  assert.equal(await p.lock(), true);
  assert.equal(p.vehicleKeys, keys);
  assert.equal(
    p.vehicleKeys,
    p.vehicleKeys,
    "no per-frame key projection allocation"
  );
  assert.equal(p.vehicleKeys.has("KeyW"), true);
  p.enabled = false;
  assert.equal(p.vehicleKeys, null);
  assert.equal(keys.size, 0);
  p.enabled = true;
  assert.equal(p.vehicleKeys, keys);
  p.unlock();
  assert.equal(p.vehicleKeys, null);
  p.inputMode = "remote";
  assert.equal(p.inputReady, true);
  assert.equal(p.locked, false);
  assert.equal(p.vehicleKeys, keys);
  assert.equal(await p.lock(), true);
  assert.equal(
    f.calls.length,
    1,
    "Remote never requests a second native capture"
  );
  keyDown(f, "ShiftRight");
  assert.equal(p.vehicleKeys.has("ShiftRight"), true);
});

test("seating keeps raw steering and arrow keys but cannot queue jumps, crouch, fly or latch sprint", (t) => {
  const f = mountedPlayerFixture(t),
    p = f.player;
  const raw = [
    "KeyW",
    "KeyS",
    "KeyA",
    "KeyD",
    "ShiftLeft",
    "ShiftRight",
    "ArrowLeft",
    "ArrowUp",
  ];
  keyDown(f, "Space", 900);
  keyDown(f, "ControlLeft", 920);
  keyDown(f, "ControlRight", 930);
  for (const code of raw) keyDown(f, code, 1000);
  assert.equal(p._jumpQueued, true);
  const keys = p.vehicleKeys;
  p.update(0, { riderPose: seatPose() });
  assert.equal(p.vehicleKeys, keys);
  for (const code of raw) assert.equal(keys.has(code), true, code);
  for (const code of ["Space", "ControlLeft", "ControlRight"])
    assert.equal(keys.has(code), false, `${code} cannot survive the mount`);
  const flightChanges = [];
  p.onFlightChange = (value) => flightChanges.push(value);
  p.onJump =
    p.onStep =
    p.onFall =
      () =>
        assert.fail(
          "seated keys must not enter walking/swimming/flight movement"
        );
  keyUp(f, "KeyW");
  for (const at of [1100, 1200, 1300]) {
    tap(f, "Space", at);
    tap(f, "KeyW", at);
    keyDown(f, "ControlLeft", at);
    keyDown(f, "ControlRight", at);
    p.flying = true;
    p.update(0.05, { riderPose: seatPose() });
    assert.equal(p.flying, false);
    assert.equal(p.sprinting, false);
    assert.equal(p.sneaking, false);
    assert.equal(p.moving, false);
    assert.equal(p.climbing, false);
    assert.equal(p.grounded, false);
    assert.equal(p.height, PLAYER_HEIGHT);
    assert.equal(p.eyeHeight, EYE_HEIGHT);
    assert.equal(p._jumpQueued, false);
    assert.equal(p._spaceTapAt, null);
    assert.equal(p._forwardTapAt, null);
    assert.equal(p._sprintLatched, false);
    assert.deepEqual(p.velocity.toArray(), [1.25, -0.2, -0.75]);
  }
  assert.deepEqual(flightChanges, []);
  p.update(0, { exitPose: exitPose() });
  for (const code of raw) keyUp(f, code);
  for (const code of ["Space", "ControlLeft", "ControlRight", "KeyW"])
    keyDown(f, code, 1350, { repeat: true });
  assert.equal(
    p._keys.size,
    0,
    "a held seated key cannot re-arm on an OS repeat"
  );
  p.onJump = p.onStep = p.onFall = null;
  tap(f, "KeyW", 1400);
  assert.equal(
    p._sprintLatched,
    false,
    "the final mounted W tap was not a first sprint tap"
  );
  keyDown(f, "KeyW", 1500);
  p.update(0.05);
  assert.equal(
    p.sprinting,
    true,
    "fresh Java double-tap sprint still works after exit"
  );
  keyUp(f, "KeyW");
  tap(f, "Space", 1550);
  assert.equal(
    p.flying,
    false,
    "the final mounted Space tap was not a first flight tap"
  );
  tap(f, "Space", 1650);
  assert.equal(p.flying, true);
  assert.deepEqual(flightChanges, [true]);
});

test("mounting during a Remote drag preserves its anchor and does not reset capture or the use gesture", (t) => {
  const f = mountedPlayerFixture(t),
    p = f.player;
  let resets = 0;
  p.onInputReset = () => resets++;
  p.beginRemoteLook(f.event(100));
  dispatch(f.document, "mousemove", f.event(150, 100, { timeStamp: 20 }));
  close(p.yaw, -0.1);
  const capture = p._captureRevision;
  p.update(0, { riderPose: seatPose() });
  dispatch(f.document, "mousemove", f.event(200, 100, { timeStamp: 40 }));
  close(p.yaw, -0.2);
  assert.equal(p.endRemoteLook(f.event(200, 100, { timeStamp: 60 })), false);
  assert.equal(resets, 0);
  assert.equal(p._captureRevision, capture);
  assert.deepEqual(f.calls, []);
});

for (const inputMode of ["native", "remote"]) {
  for (const perspective of ["first", "back", "front"]) {
    test(`${inputMode} mouse and arrow aim remain physical in ${perspective} view while hull yaw changes`, async (t) => {
      const f = mountedPlayerFixture(t, { preferences: { inputMode } });
      const p = f.player;
      if (inputMode === "native") await p.lock();
      const pose = freezePose(seatPose());
      p.update(0, { riderPose: pose });
      p.perspective = perspective;
      const eye = p.eyePosition,
        physicalEye = eye.clone();
      const position = p.position.clone(),
        velocity = p.velocity.clone();
      if (inputMode === "native") {
        dispatch(f.document, "mousemove", { movementX: 400, movementY: -100 });
      } else {
        p.beginRemoteLook(f.event(100));
        dispatch(f.document, "mousemove", f.event(500, 0, { timeStamp: 100 }));
        p.endRemoteLook(f.event(500, 0, { timeStamp: 120 }));
      }
      close(p.yaw, -0.8);
      close(p.pitch, 0.2);
      for (const code of ["ArrowLeft", "ArrowUp", "KeyA", "KeyW", "ShiftLeft"])
        keyDown(f, code);
      p.update(0.05, { riderPose: { ...pose, hullYaw: -15.7 } });
      close(p.yaw, -0.72);
      close(p.pitch, 0.265);
      assert.ok(
        p.position.equals(position),
        "W/A cannot create a second translation"
      );
      assert.ok(p.velocity.equals(velocity));
      assert.equal(p.eyePosition, eye);
      assert.ok(eye.equals(physicalEye));
      assert.equal(p.sneaking, false);
      const forward = p.forward;
      close(
        f.camera.getWorldDirection(new THREE.Vector3()).dot(forward),
        perspective === "front" ? -1 : 1
      );
      if (perspective === "first") assert.ok(f.camera.position.equals(eye));
      else {
        const offset = f.camera.position.clone().sub(eye);
        close(offset.length(), 4);
        close(offset.normalize().dot(forward), perspective === "back" ? -1 : 1);
      }
      for (const code of ["ArrowLeft", "ArrowUp"]) keyUp(f, code);
      const yaw = p.yaw,
        pitch = p.pitch;
      const revision = p.poseRevision;
      p.update(0, { riderPose: { ...pose, hullYaw: 2.3 } });
      assert.equal(p.yaw, yaw);
      assert.equal(p.pitch, pitch);
      assert.ok(p.poseRevision > revision);
      assert.equal(
        p.vehicleKeys.has("KeyA"),
        true,
        "raw A remains a hull input"
      );
      assert.equal(f.calls.length, inputMode === "native" ? 1 : 0);
    });
  }
}

test("seated arrow input clamps elapsed time and pitch without changing a zero-time pose application", (t) => {
  const f = mountedPlayerFixture(t),
    p = f.player;
  p.update(0, { riderPose: seatPose() });
  p.pitch = MAX_LOOK_PITCH - 0.01;
  keyDown(f, "ArrowLeft");
  keyDown(f, "ArrowUp");
  p.update(1000, { riderPose: seatPose() });
  close(p.yaw, 0.16);
  assert.equal(p.pitch, MAX_LOOK_PITCH);
  p.update(0, { riderPose: seatPose() });
  close(p.yaw, 0.16);
  assert.equal(p.pitch, MAX_LOOK_PITCH);
});

for (const transition of [
  "blur",
  "resize",
  "pointercancel",
  "disable",
  "unlock",
  "editing",
  "input-mode",
]) {
  test(`${transition} releases raw keys and Remote look without releasing a committed seat`, (t) => {
    const f = mountedPlayerFixture(t),
      p = f.player;
    p.update(0, { riderPose: seatPose() });
    for (const code of ["KeyW", "ShiftLeft", "ArrowLeft"]) keyDown(f, code);
    p.beginRemoteLook(f.event(100));
    dispatch(f.document, "mousemove", f.event(120));
    const yaw = p.yaw,
      position = p.position.clone(),
      velocity = p.velocity.clone();
    let resets = 0;
    p.onInputReset = () => resets++;
    if (transition === "disable") p.enabled = false;
    else if (transition === "unlock") p.unlock();
    else if (transition === "input-mode") p.inputMode = "native";
    else if (transition === "editing") {
      const input = new InputElement(f.document);
      input.closest = () => input;
      dispatch(f.document, "focusin", { target: input });
    } else
      dispatch(
        transition === "pointercancel" ? f.document : f.window,
        transition
      );
    assert.ok(resets > 0);
    assert.equal(p.seated, true);
    assert.equal(p.sneaking, false);
    assert.ok(p.position.equals(position));
    assert.ok(p.velocity.equals(velocity));
    assert.equal(p._keys.size, 0);
    assert.equal(p._jumpQueued, false);
    assert.equal(p._spaceTapAt, null);
    assert.equal(p._forwardTapAt, null);
    assert.equal(p._sprintLatched, false);
    assert.equal(f.element.dataset.looking, "false");
    p.enabled = true;
    keyDown(f, "KeyW", 1100, { repeat: true });
    assert.equal(p._keys.size, 0);
    dispatch(f.document, "mousemove", f.event(900));
    close(p.yaw, yaw);
    p.update(0.05, { riderPose: seatPose() });
    assert.ok(p.position.equals(position));
    assert.equal(p.seated, true);
  });
}
