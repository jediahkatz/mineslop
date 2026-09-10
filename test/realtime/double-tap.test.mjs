import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as flush, setTimeout as delay } from "node:timers/promises";
import { DOUBLE_TAP_MS } from "../../src/player.js";
import { controlFixture, dispatch } from "../control-fixture.js";
import { RealInputs } from "./input.mjs";

// CPU transport model only. Requests enter in order; renderer acknowledgements
// may be delayed, fail after delivery, or arrive out of order.
function keyboardFixture({ deferred = false, faults = new Map(), timeoutMs = 1000, onSend } = {}) {
  const events = [], pending = [], pressed = new Set();
  let automatic = !deferred;
  const send = (type, key) => {
    const repeat = type === "down" && pressed.has(key);
    if (type === "down") pressed.add(key);
    else pressed.delete(key);
    const event = {
      type, key, at: performance.now(), repeat,
      modifiers: [...pressed].filter((code) => /^(Control|Shift|Alt|Meta)/.test(code)).sort(),
    };
    const index = events.push(event) - 1;
    onSend?.(event);
    const fault = faults.get(index);
    if (fault?.sync) throw fault.error;
    if (fault) return Promise.reject(fault.error ?? fault);
    if (automatic) return Promise.resolve();
    return new Promise((resolve, reject) => pending.push({ index, resolve, reject }));
  };
  const page = {
    keyboard: {
      down: (key, ...options) => {
        assert.deepEqual(options, [], "no timestamps, repeat flags or modifier overrides");
        return send("down", key);
      },
      up: (key, ...options) => {
        assert.deepEqual(options, [], "normal keyboard release only");
        return send("up", key);
      },
    },
  };
  const input = new RealInputs(page, { viewport: { width: 1280, height: 720 }, timeoutMs });
  return {
    input, events, pressed, pending,
    finish() {
      automatic = true;
      for (const request of pending) request.resolve();
    },
  };
}
const sequence = (events) => events.map(({ type, key }) => [type, key]);
const pairs = [["down", "Space"], ["up", "Space"], ["down", "Space"], ["up", "Space"]];

test("double tap queues both fresh presses before a renderer ACK slower than the intent window", async () => {
  const f = keyboardFixture({ deferred: true });
  const outcome = f.input.doubleTap("Space").then(() => null, (error) => error);
  try {
    await flush();
    assert.deepEqual(sequence(f.events), pairs.slice(0, 3));
    assert.deepEqual(f.events.filter(({ type }) => type === "down").map(({ repeat }) => repeat), [false, false]);
    assert.ok(f.events[2].at - f.events[0].at < DOUBLE_TAP_MS);
    assert.ok(f.input.held.has("Space"), "the in-flight second press remains owned");
    await delay(DOUBLE_TAP_MS + 10);
    // An out-of-order ACK cannot release or resurrect the owned second press.
    f.pending[2].resolve();
    f.pending[1].resolve();
    await flush();
    assert.equal(f.events.length, 3);
    assert.ok(f.input.held.has("Space"));
    f.pending[0].resolve();
    await flush();
    assert.deepEqual(sequence(f.events), pairs);
    f.pending[3].resolve();
    assert.equal(await outcome, null);
    assert.equal(f.input.counts.keydown, 2);
    assert.equal(f.input.counts.keyup, 2);
    assert.equal(f.input.counts.byKey.Space, 2);
    assert.equal(f.input.held.size, 0);
    assert.equal(f.pressed.size, 0);
    assert.ok(Number.isFinite(f.input.lastSpacePressAt));
  } finally {
    f.finish();
    await outcome;
  }
});

test("a previously held Space is released first and unrelated held modifiers remain unchanged", async () => {
  const f = keyboardFixture();
  await f.input.setHeld(["ControlLeft", "ShiftLeft", "Space"]);
  const start = f.events.length;
  await f.input.doubleTap("Space");
  const gesture = f.events.slice(start);
  assert.deepEqual(sequence(gesture), [["up", "Space"], ...pairs]);
  for (const event of gesture) assert.deepEqual(event.modifiers, ["ControlLeft", "ShiftLeft"]);
  assert.ok(gesture.every(({ repeat }) => !repeat));
  assert.deepEqual([...f.input.held], ["ControlLeft", "ShiftLeft"]);
  assert.deepEqual([...f.pressed], ["ControlLeft", "ShiftLeft"]);
  await f.input.release();
  assert.equal(f.pressed.size, 0);
});

test("failed release of a pre-held key prevents a non-fresh burst and remains retryable", async () => {
  const fault = new Error("pre-held key release failed");
  const f = keyboardFixture({ faults: new Map([[1, fault]]) });
  await f.input.down("Space");
  await assert.rejects(f.input.doubleTap("Space"), fault);
  assert.deepEqual(sequence(f.events), pairs.slice(0, 2));
  assert.ok(f.input.held.has("Space"));
  await f.input.release();
  assert.equal(f.input.held.size, 0);
  assert.equal(f.pressed.size, 0);
});

for (const index of [0, 1, 2]) {
  test(`failed burst send ${index + 1} still drains siblings and releases the possibly delivered key`, async () => {
    const fault = new Error(`rejected send ${index}`);
    const f = keyboardFixture({ faults: new Map([[index, fault]]) });
    await assert.rejects(f.input.doubleTap("Space"), (error) =>
      error === fault || error.errors?.includes(fault));
    assert.deepEqual(sequence(f.events), pairs);
    assert.equal(f.input.held.size, 0);
    assert.equal(f.pressed.size, 0);
  });
}

test("a synchronous transport exception is observed without abandoning other queued sends", async () => {
  const fault = new Error("synchronous transport failure");
  const f = keyboardFixture({ faults: new Map([[1, { sync: true, error: fault }]]) });
  await assert.rejects(f.input.doubleTap("Space"), (error) =>
    error === fault || error.errors?.includes(fault));
  assert.deepEqual(sequence(f.events), pairs);
  assert.equal(f.input.held.size, 0);
  assert.equal(f.pressed.size, 0);
});

test("failed final keyup preserves ownership for later cleanup and retains the original send error", async () => {
  const sendError = new Error("first keydown failed"), releaseError = new Error("final keyup failed");
  const f = keyboardFixture({ faults: new Map([[0, sendError], [3, releaseError]]) });
  await assert.rejects(f.input.doubleTap("Space"), (error) => {
    const errors = [error, ...(error.errors ?? [])].flatMap((entry) => [entry, ...(entry.errors ?? [])]);
    assert.ok(errors.includes(sendError));
    assert.ok(errors.includes(releaseError));
    return true;
  });
  assert.ok(f.input.held.has("Space"));
  await f.input.release();
  assert.equal(f.input.held.size, 0);
  assert.equal(f.pressed.size, 0);
  assert.equal(f.events.at(-1).type, "up");
});

test("a timed-out burst sends cleanup before late ACKs and late ACKs cannot re-hold the key", async () => {
  const f = keyboardFixture({ deferred: true, timeoutMs: 15 });
  const outcome = f.input.doubleTap("Space").then(() => null, (error) => error);
  try {
    await delay(20);
    assert.deepEqual(sequence(f.events), pairs);
    f.pending.find(({ index }) => index === 3).resolve();
    assert.match((await outcome).message, /timed out/);
    assert.equal(f.input.held.size, 0);
    f.finish();
    await flush();
    assert.equal(f.input.held.size, 0);
    assert.equal(f.pressed.size, 0);
  } finally {
    f.finish();
    await outcome;
  }
});

test("a failed second-press frame observation releases Space without retrying the gesture", async () => {
  const f = keyboardFixture();
  const fault = new Error("frame observation failed");
  f.input.frames = async (count) => {
    assert.equal(count, 2);
    assert.ok(f.input.held.has("Space"));
    assert.deepEqual(sequence(f.events), pairs.slice(0, 3));
    throw fault;
  };
  await assert.rejects(f.input.doubleTap("Space", { holdSecondFrames: 2 }), fault);
  assert.deepEqual(sequence(f.events), pairs);
  assert.equal(f.input.held.size, 0);
  assert.equal(f.pressed.size, 0);
});

test("invalid second-press frame bounds fail before any input", async () => {
  const f = keyboardFixture();
  for (const holdSecondFrames of [-1, 3, 0.5, NaN, "2"])
    await assert.rejects(f.input.doubleTap("Space", { holdSecondFrames }), /frames/i);
  assert.deepEqual(f.events, []);
  assert.equal(f.input.held.size, 0);
});

test("an immediate full release can flip the flight flag but relands on the first physical update", async (t) => {
  const playerFixture = controlFixture(t, { inputMode: "native" });
  await playerFixture.player.lock();
  playerFixture.player.update(1 / 60);
  const initialY = playerFixture.player.position.y;
  const f = keyboardFixture({
    onSend: ({ type, key, repeat }) => dispatch(
      playerFixture.document, type === "down" ? "keydown" : "keyup",
      { code: key, repeat, target: playerFixture.element }
    ),
  });
  await f.input.doubleTap("Space");
  assert.ok(playerFixture.player.flying);
  playerFixture.player.update(1 / 60);
  assert.equal(playerFixture.player.flying, false);
  assert.ok(playerFixture.player.grounded);
  assert.equal(playerFixture.player.position.y, initialY);
});

for (const dt of [1 / 60, 0.1]) {
  test(`held second Space press produces persistent physical takeoff at dt=${dt}`, async (t) => {
    const playerFixture = controlFixture(t, { inputMode: "native" });
    await playerFixture.player.lock();
    playerFixture.player.update(dt);
    assert.ok(playerFixture.player.grounded);
    const initialY = playerFixture.player.position.y;
    const f = keyboardFixture({
      onSend: ({ type, key, repeat }) => {
        // The existing CPU EventTarget uses real Node Event timestamps. Only
        // ordinary key handlers and Player.update move this physical fixture.
        dispatch(playerFixture.document, type === "down" ? "keydown" : "keyup", {
          code: key, repeat, target: playerFixture.element,
        });
      },
    });
    let heldFrames = 0;
    f.input.frames = async (count) => {
      assert.equal(count, 2);
      assert.ok(playerFixture.player._keys.has("Space"));
      assert.ok(playerFixture.player.flying);
      for (let index = 0; index < count; index++) {
        playerFixture.player.update(dt);
        heldFrames++;
      }
    };
    await f.input.doubleTap("Space", { holdSecondFrames: 2 });
    const afterHoldY = playerFixture.player.position.y;
    assert.equal(heldFrames, 2);
    assert.ok(afterHoldY > initialY);
    assert.equal(playerFixture.player._keys.has("Space"), false);
    for (let index = 0; index < 30; index++) playerFixture.player.update(dt);
    assert.ok(playerFixture.player.flying);
    assert.equal(playerFixture.player.grounded, false);
    assert.ok(playerFixture.player.position.y > initialY);
    assert.deepEqual(sequence(f.events), pairs);
    assert.equal(f.input.held.size, 0);
    t.diagnostic(JSON.stringify({
      scope: "CPU physical Player, not browser or FPS proof",
      dt, heldFrames, initialY, afterHoldY, settledY: playerFixture.player.position.y,
      flyingAfterRelease: playerFixture.player.flying, grounded: playerFixture.player.grounded,
    }));
  });
}
