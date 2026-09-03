import assert from "node:assert/strict";
import test from "node:test";
import { MAX_MOUSE_SENSITIVITY } from "../src/control-preferences.js";
import { controlFixture, dispatch } from "./control-fixture.js";

const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test("Remote is ready without ever capturing; ordinary hover cannot turn the camera", async (t) => {
  const f = controlFixture(t);
  assert.equal(await f.player.lock(), true);
  assert.equal(f.player.inputReady, true);
  assert.equal(f.player.locked, false);
  assert.deepEqual(f.calls, []);
  dispatch(f.document, "mousemove", f.event(900, 200, { buttons: 0 }));
  close(f.player.yaw, 0);
  close(f.player.pitch, 0);
  assert.equal(f.element.dataset.inputMode, "remote");
  assert.equal(f.element.dataset.looking, "false");
});

test("Remote conserves slow horizontal/vertical absolute drags at irregular frame cadence", (t) => {
  const f = controlFixture(t);
  f.player.beginRemoteLook(f.event(100));
  let n = 0;
  const move = (x, y) => {
    dispatch(f.document, "mousemove", f.event(x, y, { timeStamp: ++n * 20 }));
    if (n % 7 === 0) f.player.update(n % 3 ? 1 / 60 : 1 / 20);
    if (n > 1) {
      close(f.player.yaw, -(x - 100) * 0.002);
      close(f.player.pitch, -(y - 100) * 0.002);
    }
  };
  for (let x = 102; x <= 900; x += 2) move(x, 100);
  close(f.player.yaw, -1.6);
  for (let x = 898; x >= 100; x -= 2) move(x, 100);
  for (let y = 102; y <= 400; y += 2) move(100, y);
  close(f.player.pitch, -0.6);
  for (let y = 398; y >= 100; y -= 2) move(100, y);
  f.player.update(1 / 60);
  close(f.camera.rotation.y, 0);
  close(f.camera.rotation.x, 0);
  assert.equal(
    f.player.endRemoteLook(f.event(100, 100, { timeStamp: n * 20 + 20 })),
    false
  );
  assert.equal(f.element.dataset.looking, "false");
});

for (const transition of [
  "blur",
  "resize",
  "pointercancel",
  "disable",
  "unlock",
]) {
  test(`${transition} clears the drag, tap, keys and mining callback before resuming`, (t) => {
    const f = controlFixture(t);
    let resets = 0;
    f.player.onInputReset = () => resets++;
    dispatch(f.document, "keydown", { code: "KeyW", target: f.element });
    f.player.beginRemoteLook(f.event(100));
    dispatch(f.document, "mousemove", f.event(120));
    const yaw = f.player.yaw;
    if (transition === "disable") f.player.enabled = false;
    else if (transition === "unlock") f.player.unlock();
    else
      dispatch(
        transition === "pointercancel" ? f.document : f.window,
        transition
      );
    assert.equal(f.player._keys.size, 0);
    assert.ok(resets > 0);
    f.player.enabled = true;
    dispatch(f.document, "mousemove", f.event(900));
    close(f.player.yaw, yaw);
    assert.equal(
      f.player.endRemoteLook(f.event(900, 100, { timeStamp: 100 })),
      false
    );
    f.player.beginRemoteLook(f.event(900));
    dispatch(f.document, "mousemove", f.event(894));
    close(f.player.yaw - yaw, 0.012);
  });
}

test("a lost RMB release cancels Remote look and cannot turn into a stale tap", (t) => {
  const f = controlFixture(t);
  f.player.beginRemoteLook(f.event(100));
  dispatch(f.document, "mousemove", f.event(120));
  const yaw = f.player.yaw;
  dispatch(f.document, "mousemove", f.event(200, 100, { buttons: 0 }));
  dispatch(f.document, "mousemove", f.event(600));
  close(f.player.yaw, yaw);
  assert.equal(
    f.player.endRemoteLook(f.event(600, 100, { timeStamp: 100 })),
    false
  );
});

test("sensitivity scales both axes without clipping native flicks or reusing a Remote anchor", async (t) => {
  const f = controlFixture(t);
  f.player.beginRemoteLook(f.event(100));
  f.player.mouseSensitivity = 2;
  dispatch(f.document, "mousemove", f.event(600));
  close(f.player.yaw, 0);
  f.player.beginRemoteLook(f.event(100));
  dispatch(f.document, "mousemove", f.event(200, 150));
  close(f.player.yaw, -0.4);
  close(f.player.pitch, -0.2);
  f.player.inputMode = "native";
  assert.equal(f.player.inputReady, false);
  assert.equal(await f.player.lock(), true);
  const yaw = f.player.yaw;
  dispatch(f.document, "mousemove", { movementX: 400, movementY: 50 });
  close(f.player.yaw - yaw, -1.6);
  close(f.player.pitch, -0.4);
  f.player.mouseSensitivity = 100;
  assert.equal(f.player.mouseSensitivity, MAX_MOUSE_SENSITIVITY);
  f.player.inputMode = "remote";
  assert.equal(f.player.locked, false);
  const after = f.player.yaw;
  dispatch(f.document, "mousemove", f.event(900));
  close(f.player.yaw, after);
});

test("a pending Native capture cannot capture Remote or retry raw fallback after a mode change", async (t) => {
  for (const succeed of [false, true]) {
    const f = controlFixture(t, { inputMode: "native" });
    let complete;
    f.element.requestPointerLock = () =>
      new Promise((resolve, reject) => {
        complete = () => {
          if (succeed) {
            f.document.pointerLockElement = f.element;
            dispatch(f.document, "pointerlockchange");
            resolve();
          } else reject(new DOMException("Unsupported", "NotSupportedError"));
        };
      });
    const pending = f.player.lock();
    f.player.inputMode = "remote";
    complete();
    assert.equal(await pending, false);
    assert.equal(f.player.locked, false);
    assert.equal(await f.player.lock(), true);
  }
});
