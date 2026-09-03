import assert from "node:assert/strict";
import test from "node:test";
import { REMOTE_TAP_MS, RemoteLook } from "../src/remote-look.js";

const at = (x, y = 100, timeStamp = 0) => ({
  clientX: x,
  clientY: y,
  timeStamp,
  // Intentionally corrupt native deltas: Remote uses only client coordinates.
  movementX: -874,
  movementY: 600,
});

test("slow absolute 2px drags conserve the buffered start, vertical motion and reversals", () => {
  const look = new RemoteLook();
  look.begin(at(100));
  const applied = { x: 0, y: 0 };
  const move = (x, y) => {
    const delta = look.move(at(x, y));
    applied.x += delta.x;
    applied.y += delta.y;
    if (look.dragging) {
      assert.equal(applied.x, x - 100);
      assert.equal(applied.y, y - 100);
    }
  };
  for (let x = 102; x <= 900; x += 2) move(x, 100);
  assert.deepEqual(applied, { x: 800, y: 0 });
  for (let x = 898; x >= 100; x -= 2) move(x, 100);
  assert.deepEqual(applied, { x: 0, y: 0 });
  for (let y = 102; y <= 500; y += 2) move(100, y);
  assert.deepEqual(applied, { x: 0, y: 400 });
  for (let y = 498; y >= 100; y -= 2) move(100, y);
  assert.deepEqual(applied, { x: 0, y: 0 });
  assert.equal(look.end(at(100, 100, 100)).tap, false);
});

test("a short right tap tolerates tiny jitter without moving the view", () => {
  const look = new RemoteLook();
  look.begin(at(10, 10, 500));
  assert.deepEqual(look.move(at(11, 11, 520)), { x: 0, y: 0 });
  assert.deepEqual(look.end(at(11, 11, 550)), { x: 0, y: 0, tap: true });
  assert.equal(look.end(at(11, 11, 560)).tap, false, "a tap is consumed once");
});

test("a drag that returns to its origin never becomes a place tap", () => {
  const look = new RemoteLook();
  look.begin(at(100));
  assert.deepEqual(look.move(at(104)), { x: 4, y: 0 });
  assert.deepEqual(look.move(at(102)), { x: -2, y: 0 });
  assert.deepEqual(look.end(at(100, 100, 100)), { x: -2, y: 0, tap: false });
});

test("a long stationary right hold cannot accidentally place on release", () => {
  const look = new RemoteLook();
  look.begin(at(100));
  assert.equal(look.end(at(100, 100, REMOTE_TAP_MS + 1)).tap, false);
});

test("release-only movement recognizes a drag and conserves the final delta", () => {
  const look = new RemoteLook();
  look.begin(at(100));
  assert.deepEqual(look.end(at(160, 120, 100)), { x: 60, y: 20, tap: false });
});

test("reset discards a pending tap and drag anchor; repositioning starts fresh", () => {
  const look = new RemoteLook();
  look.begin(at(10));
  look.move(at(110));
  look.reset();
  assert.deepEqual(look.move(at(900)), { x: 0, y: 0 });
  assert.equal(look.end(at(900, 100, 100)).tap, false);
  look.begin(at(900));
  assert.deepEqual(look.move(at(894)), { x: -6, y: 0 });
});

test("nonfinite coordinates cancel the gesture instead of poisoning future look", () => {
  const look = new RemoteLook();
  look.begin(at(100));
  assert.deepEqual(look.move(at(NaN)), { x: 0, y: 0 });
  assert.equal(look.end(at(100, 100, 100)).tap, false);
  look.begin(at(100));
  assert.deepEqual(look.move(at(108)), { x: 8, y: 0 });
});
