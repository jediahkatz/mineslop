import assert from "node:assert/strict";
import test from "node:test";
import { BrowserCapture, GAME_KEYBOARD_CODES } from "../src/browser-capture.js";

function fixture({ lock } = {}) {
  const document = new EventTarget();
  document.fullscreenElement = null;
  const changes = [];
  const messages = [];
  const locks = [];
  let unlocks = 0;
  const keyboard = {
    lock: lock ?? (async (codes) => locks.push(codes)),
    unlock: () => unlocks++,
  };
  const element = {
    ownerDocument: document,
    async requestFullscreen() {
      document.fullscreenElement = element;
      document.dispatchEvent(new Event("fullscreenchange"));
    },
  };
  document.exitFullscreen = async () => {
    document.fullscreenElement = null;
    document.dispatchEvent(new Event("fullscreenchange"));
  };
  const capture = new BrowserCapture(element, {
    keyboard,
    onChange: (value) => changes.push(value),
    onMessage: (value) => messages.push(value),
  });
  return {
    document,
    element,
    keyboard,
    capture,
    changes,
    messages,
    locks,
    unlocks: () => unlocks,
  };
}

test("explicit API fullscreen captures game shortcuts once and releases on exit", async () => {
  const f = fixture();
  assert.deepEqual(await f.capture.enter(), {
    ok: true,
    keyboardCaptured: true,
  });
  assert.equal(
    f.locks.length,
    1,
    "fullscreen event and enter completion share the same request"
  );
  assert.deepEqual(f.locks[0], [...GAME_KEYBOARD_CODES]);
  assert.ok(
    f.locks[0].includes("KeyW"),
    "Ctrl+W belongs to the game in captured fullscreen"
  );
  assert.ok(!f.locks[0].includes("Tab"), "task switching is not captured");
  assert.ok(
    !f.locks[0].includes("F4"),
    "window-exit shortcuts are not captured"
  );
  assert.deepEqual(await f.capture.exit(), { ok: true });
  assert.equal(f.capture.captured, false);
  assert.equal(f.unlocks(), 1);
  assert.deepEqual(f.changes.at(-1), {
    fullscreen: false,
    keyboardCaptured: false,
  });
  f.capture.dispose();
});

test("unsupported or refused capture leaves fullscreen playable with a truthful fallback", async () => {
  const denied = fixture({
    lock: async () => {
      throw new Error("NotAllowed");
    },
  });
  assert.deepEqual(await denied.capture.enter(), {
    ok: true,
    keyboardCaptured: false,
  });
  assert.match(denied.messages[0], /Double-tap W/);
  assert.equal(denied.capture.captured, false);
  denied.capture.dispose();
  const unsupported = fixture();
  unsupported.capture.keyboard = undefined;
  assert.deepEqual(await unsupported.capture.enter(), {
    ok: true,
    keyboardCaptured: false,
  });
  assert.match(unsupported.messages[0], /reserves some Ctrl shortcuts/);
  unsupported.capture.dispose();
});

test("a rejected fullscreen request does not request keyboard capture", async () => {
  const f = fixture();
  f.element.requestFullscreen = async () => {
    throw new Error("NotAllowed");
  };
  assert.equal((await f.capture.enter()).ok, false);
  assert.equal(f.locks.length, 0);
  assert.equal(f.capture.fullscreen, false);
  f.capture.dispose();
});

test("late lock completion cannot leave keys captured after fullscreen exit", async () => {
  let resolve;
  const f = fixture({
    lock: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  const entered = f.capture.enter();
  await Promise.resolve();
  await f.capture.exit();
  resolve();
  await entered;
  assert.equal(f.capture.fullscreen, false);
  assert.equal(f.capture.captured, false);
  assert.ok(f.unlocks() >= 1);
  assert.ok(!f.changes.some((change) => change.keyboardCaptured));
  f.capture.dispose();
});

test("disposal releases keys and prevents a pending request from reactivating capture", async () => {
  let resolve;
  const f = fixture({
    lock: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  const entered = f.capture.enter();
  await Promise.resolve();
  f.capture.dispose();
  resolve();
  await entered;
  assert.equal(f.capture.captured, false);
  assert.ok(f.unlocks() >= 1);
  assert.deepEqual(await f.capture.enter(), {
    ok: false,
    message: "Fullscreen is unavailable in this browser.",
  });
});
