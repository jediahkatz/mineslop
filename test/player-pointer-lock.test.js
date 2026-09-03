import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import * as THREE from "three";
import { Player } from "../src/player.js";

function fixture(t) {
  const document = new EventTarget();
  document.defaultView = new EventTarget();
  document.pointerLockElement = null;
  const calls = [];
  const element = {
    ownerDocument: document,
    requestPointerLock(...args) {
      calls.push(args);
      return api.request(...args);
    },
  };
  const capture = () => {
    document.pointerLockElement = element;
    document.dispatchEvent(new Event("pointerlockchange"));
  };
  const errorEvent = () =>
    document.dispatchEvent(new Event("pointerlockerror"));
  const api = { request: () => Promise.resolve().then(capture) };
  document.exitPointerLock = () => {
    document.pointerLockElement = null;
    document.dispatchEvent(new Event("pointerlockchange"));
  };
  const player = new Player(new THREE.PerspectiveCamera(), {}, element);
  player.enabled = true;
  t.after(() => player.dispose());
  const assertCleanedUp = () => {
    assert.equal(getEventListeners(document, "pointerlockerror").length, 0);
    // The Player's persistent input-reset listener remains until dispose.
    assert.equal(getEventListeners(document, "pointerlockchange").length, 1);
  };
  return {
    document,
    element,
    player,
    api,
    calls,
    capture,
    errorEvent,
    assertCleanedUp,
  };
}

test("requests unadjusted capture and preserves all native movement", async (t) => {
  const f = fixture(t);
  assert.equal(await f.player.lock(), true);
  assert.deepEqual(f.calls, [[{ unadjustedMovement: true }]]);
  assert.equal(await f.player.lock(), true);
  assert.equal(
    f.calls.length,
    1,
    "an existing capture must not be requested again"
  );
  let yaw = 0;
  let pitch = 0;
  // Large legitimate sweeps must remain usable; raw input is not a heuristic
  // spike filter. Include the observed recenter magnitude as a native control.
  for (const [movementX, movementY] of [
    [2, 0],
    [688, 0],
    [-690, 0],
    [-1937.5, 372.25],
    [1937.5, -372.25],
  ]) {
    f.document.dispatchEvent(
      Object.assign(new Event("mousemove"), { movementX, movementY })
    );
    yaw -= movementX * 0.002;
    pitch -= movementY * 0.002;
    assert.ok(Math.abs(f.player.yaw - yaw) < 1e-10);
    assert.ok(Math.abs(f.player.pitch - pitch) < 1e-10);
  }
  f.assertCleanedUp();
});

test("unsupported raw input falls back despite an earlier generic error event", async (t) => {
  const f = fixture(t);
  f.api.request = (options) =>
    Promise.resolve().then(() => {
      if (options?.unadjustedMovement) {
        f.errorEvent();
        throw new DOMException("Raw input unavailable", "NotSupportedError");
      }
      // A generic event queued by the first request must not fail the second.
      f.errorEvent();
      f.capture();
    });
  assert.equal(await f.player.lock(), true);
  assert.deepEqual(f.calls, [[{ unadjustedMovement: true }], []]);
  assert.equal(f.player.locked, true);
  f.assertCleanedUp();
});

for (const name of ["NotSupportedError", "TypeError"]) {
  test(`synchronously unsupported options fall back once (${name})`, async (t) => {
    const f = fixture(t);
    f.api.request = (options) => {
      if (options) throw new DOMException("Unsupported options", name);
      f.capture();
    };
    assert.equal(await f.player.lock(), true);
    assert.deepEqual(f.calls, [[{ unadjustedMovement: true }], []]);
    f.assertCleanedUp();
  });
}

for (const name of ["NotAllowedError", "SecurityError", "AbortError"]) {
  test(`does not retry a denied or cancelled capture (${name})`, async (t) => {
    const f = fixture(t);
    f.api.request = () =>
      Promise.resolve().then(() => {
        f.errorEvent();
        throw new DOMException("Capture rejected", name);
      });
    assert.equal(await f.player.lock(), false);
    assert.equal(f.calls.length, 1);
    assert.equal(f.player.locked, false);
    f.assertCleanedUp();
  });
}

test("legacy void API can ignore options and capture synchronously", async (t) => {
  const f = fixture(t);
  f.api.request = () => {
    f.capture();
  };
  assert.equal(await f.player.lock(), true);
  assert.equal(f.calls.length, 1);
  f.assertCleanedUp();
});

test("legacy void API resolves from an asynchronous capture event", async (t) => {
  const f = fixture(t);
  f.api.request = () => {
    queueMicrotask(f.capture);
  };
  assert.equal(await f.player.lock(), true);
  assert.equal(f.calls.length, 1);
  f.assertCleanedUp();
});

test("untyped legacy errors get one ordinary capture attempt", async (t) => {
  const f = fixture(t);
  f.api.request = (options) => {
    queueMicrotask(options ? f.errorEvent : f.capture);
  };
  assert.equal(await f.player.lock(), true);
  assert.deepEqual(f.calls, [[{ unadjustedMovement: true }], []]);
  f.assertCleanedUp();
});

test("ordinary fallback failure is final for both promise and legacy APIs", async (t) => {
  for (const legacy of [false, true]) {
    const f = fixture(t);
    f.api.request = () => {
      if (legacy) {
        queueMicrotask(f.errorEvent);
        return;
      }
      return Promise.reject(
        new DOMException("Unavailable", "NotSupportedError")
      );
    };
    assert.equal(await f.player.lock(), false);
    assert.equal(f.calls.length, 2);
    assert.equal(f.player.locked, false);
    f.assertCleanedUp();
  }
});

test("missing pointer lock API fails without swallowing normal mouse input", async (t) => {
  const f = fixture(t);
  delete f.element.requestPointerLock;
  assert.equal(await f.player.lock(), false);
  f.player._onMouseMove({ movementX: 688, movementY: 100 });
  assert.equal(f.player.yaw, 0, "uncaptured motion must not move the camera");
  assert.equal(f.player.pitch, 0);
  f.assertCleanedUp();
});

test("focusing an editor cancels a pending Native capture without retrying it", async (t) => {
  const f = fixture(t);
  let complete;
  f.api.request = () =>
    new Promise((resolve) => {
      complete = () => {
        f.capture();
        resolve();
      };
    });
  const pending = f.player.lock();
  const focus = new Event("focusin");
  Object.defineProperty(focus, "target", {
    value: { isContentEditable: true },
  });
  f.document.dispatchEvent(focus);
  complete();
  assert.equal(await pending, false);
  assert.equal(f.player.locked, false);
  assert.equal(f.calls.length, 1);
  f.assertCleanedUp();
});
