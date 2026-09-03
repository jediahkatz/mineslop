import assert from "node:assert/strict";
import test from "node:test";
import { DOUBLE_TAP_MS } from "../src/player.js";
import { controlFixture, dispatch, InputElement } from "./control-fixture.js";

const down = (f, code, timeStamp = 1000, extra = {}) =>
  dispatch(f.document, "keydown", {
    code,
    timeStamp,
    target: f.element,
    ...extra,
  });
const up = (f, code) => dispatch(f.document, "keyup", { code });
const tap = (f, code, timeStamp) => {
  down(f, code, timeStamp);
  up(f, code);
};
const frames = (player, count = 1) => {
  for (let frame = 0; frame < count; frame++) player.update(1 / 60);
};

test("only two fresh Space presses toggle flight; repeat and duplicate keydowns do not", (t) => {
  const f = controlFixture(t);
  const changes = [];
  f.player.onFlightChange = (flying) => changes.push(flying);
  down(f, "Space", 1000);
  down(f, "Space", 1100, { repeat: true });
  down(f, "Space", 1200);
  frames(f.player, 10);
  assert.equal(f.player.flying, false);
  up(f, "Space");
  down(f, "Space", 1300);
  assert.equal(f.player.flying, true);
  frames(f.player, 60);
  assert.equal(f.player.flying, true, "holding the second press keeps flying");
  up(f, "Space");
  tap(f, "Space", 2500);
  tap(f, "Space", 2650);
  assert.equal(f.player.flying, false);
  assert.deepEqual(changes, [true, false]);
});

test("flight taps expire and reject backwards event timestamps", (t) => {
  for (const interval of [DOUBLE_TAP_MS + 1, -1]) {
    const f = controlFixture(t);
    tap(f, "Space", 1000);
    tap(f, "Space", 1000 + interval);
    assert.equal(f.player.flying, false);
    tap(f, "Space", 1100 + interval);
    assert.equal(f.player.flying, true);
  }
});

for (const transition of [
  "blur",
  "resize",
  "pointercancel",
  "disable",
  "unlock",
  "input-mode",
  "game-mode",
  "editing",
]) {
  test(`${transition} clears pending flight and sprint taps and ignores stale repeats`, (t) => {
    const f = controlFixture(t);
    tap(f, "Space", 1000);
    tap(f, "KeyW", 1000);
    if (transition === "disable") f.player.enabled = false;
    else if (transition === "unlock") f.player.unlock();
    else if (transition === "input-mode") f.player.inputMode = "native";
    else if (transition === "game-mode") {
      f.player.allowFlight = false;
      f.player.allowFlight = true;
    } else if (transition === "editing") {
      const input = new InputElement(f.document);
      input.closest = () => input;
      dispatch(f.document, "focusin", { target: input });
    } else
      dispatch(
        transition === "pointercancel" ? f.document : f.window,
        transition
      );
    f.player.enabled = true;
    down(f, "Space", 1050, { repeat: true });
    down(f, "KeyW", 1050, { repeat: true });
    assert.equal(f.player._keys.size, 0);
    up(f, "Space");
    up(f, "KeyW");
    down(f, "KeyW", 1100);
    tap(f, "Space", 1100);
    frames(f.player);
    assert.equal(f.player.flying, false);
    assert.equal(f.player.sprinting, false);
    tap(f, "Space", 1200);
    assert.equal(
      f.player.flying,
      true,
      "a new complete double tap still works"
    );
  });
}

test("Survival rejects flight, clears active Creative flight, and preserves held jump", (t) => {
  const f = controlFixture(t);
  f.player.flying = true;
  f.player.velocity.y = 5;
  down(f, "Space");
  f.player.allowFlight = false;
  assert.equal(f.player.flying, false);
  assert.equal(f.player.velocity.y, 0);
  assert.equal(f.player._keys.size, 0);
  f.player.flying = true;
  assert.equal(f.player.flying, false);
  frames(f.player);
  let jumps = 0;
  f.player.onJump = () => jumps++;
  tap(f, "Space", 1100);
  down(f, "Space", 1200);
  frames(f.player, 180);
  assert.equal(f.player.flying, false);
  assert.ok(jumps >= 3);
  up(f, "Space");
  const released = jumps;
  frames(f.player, 120);
  assert.equal(jumps, released);
  assert.equal(f.player.grounded, true);
});

for (const shift of ["ShiftLeft", "ShiftRight"]) {
  test(`${shift} brakes flight ascent immediately and descends without crouching`, (t) => {
    const f = controlFixture(t);
    f.player.setPosition({ x: 0.5, y: 30, z: 0.5 });
    f.player.flying = true;
    down(f, "Space");
    frames(f.player, 60);
    assert.ok(f.player.velocity.y > 5);
    const before = f.player.position.y;
    up(f, "Space");
    down(f, shift, 2100);
    frames(f.player);
    assert.ok(
      f.player.velocity.y < 0,
      "Shift must not continue ascending first"
    );
    assert.ok(f.player.position.y < before);
    assert.equal(f.player.sneaking, false);
  });
}

test("landing a Creative flight turns flight off and held Shift becomes ground sneak", (t) => {
  const f = controlFixture(t);
  f.player.setPosition({ x: 0.5, y: 3, z: 0.5 });
  f.player.flying = true;
  down(f, "ShiftLeft");
  frames(f.player, 120);
  assert.equal(f.player.flying, false);
  assert.equal(f.player.grounded, true);
  assert.equal(f.player.sneaking, true);
  assert.equal(f.player.position.y, 1);
});

for (const control of ["ControlLeft", "ControlRight"]) {
  test(`${control} boosts flight but cannot descend; F/C/Q are not movement keys`, (t) => {
    const f = controlFixture(t);
    const unboosted = controlFixture(t);
    for (const current of [f, unboosted]) {
      current.player.setPosition({ x: 0.5, y: 30, z: 0.5 });
      current.player.flying = true;
    }
    down(f, control);
    for (const code of ["KeyF", "KeyC", "KeyQ"]) {
      const event = down(f, code);
      assert.equal(event.defaultPrevented, false);
      assert.equal(f.player._keys.has(code), false);
    }
    frames(f.player, 30);
    assert.equal(f.player.position.y, 30);
    down(f, "Space");
    down(unboosted, "Space");
    frames(f.player, 30);
    frames(unboosted.player, 30);
    assert.ok(f.player.velocity.y > unboosted.player.velocity.y * 1.5);
    assert.equal(f.player.flying, true);
    dispatch(f.window, "blur");
    assert.equal(f.player.velocity.y, 0);
    assert.equal(f.player._keys.size, 0);
  });
}

test("Space swimming remains continuous and Shift, not Ctrl or C, sinks", (t) => {
  const f = controlFixture(t);
  f.player.allowFlight = false;
  f.player.setPosition({ x: 0.5, y: 10, z: 0.5 });
  f.world.get = () => 11;
  down(f, "Space");
  frames(f.player, 60);
  assert.ok(f.player.velocity.y > 3);
  up(f, "Space");
  down(f, "ControlLeft");
  down(f, "KeyC");
  frames(f.player, 60);
  assert.ok(f.player.velocity.y > 0);
  up(f, "ControlLeft");
  down(f, "ShiftLeft");
  frames(f.player, 60);
  assert.ok(f.player.velocity.y < -2);
  assert.equal(f.player.flying, false);
});
