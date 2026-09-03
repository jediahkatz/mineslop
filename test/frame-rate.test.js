import assert from "node:assert/strict";
import test from "node:test";
import { FPS_WINDOW_MS, FrameRate } from "../src/frame-rate.js";

const near = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test("FPS starts unknown and excludes the incomplete interval before the first drawn frame", () => {
  const meter = new FrameRate();
  assert.equal(meter.fps, null);
  assert.equal(meter.observe(10000), false);
  assert.equal(meter.fps, null);
  for (let frame = 0; frame < 19; frame++)
    assert.equal(meter.observe(25), false);
  assert.equal(meter.observe(25), true);
  near(meter.fps, 40);
  near(meter.frameMs, 25);
});

for (const fps of [30, 60, 120, 144]) {
  test(`steady ${fps} FPS is derived from actual frame duration`, () => {
    const meter = new FrameRate();
    meter.observe(1);
    let publications = 0;
    for (let frame = 0; frame < fps * 2; frame++)
      if (meter.observe(1000 / fps)) {
        publications++;
        near(meter.fps, fps);
        near(meter.frameMs, 1000 / fps);
      }
    assert.ok(publications >= 3 && publications <= 4);
  });
}

test("uneven frame durations do not inflate FPS by averaging reciprocals", () => {
  const meter = new FrameRate();
  meter.observe(1);
  for (let pair = 0; pair < 9; pair++) {
    meter.observe(10);
    meter.observe(50);
  }
  near(meter.fps, 1000 / 30);
  near(meter.frameMs, 30);
  assert.notEqual(Math.round(meter.fps), (100 + 20) / 2);
});

test("visible stalls count fully, without the simulation or adaptive-resolution caps", () => {
  const meter = new FrameRate();
  meter.observe(1);
  for (let i = 0; i < 4; i++) meter.observe(16);
  assert.equal(meter.observe(1000), true);
  near(meter.fps, 5000 / 1064);
  near(meter.frameMs, 1064 / 5);
});

test("reset discards hidden/loading gaps and old published values", () => {
  const meter = new FrameRate();
  meter.observe(1);
  meter.observe(FPS_WINDOW_MS);
  assert.equal(meter.fps, 2);
  meter.observe(100);
  meter.reset();
  assert.equal(meter.fps, null);
  assert.equal(meter.frameMs, null);
  assert.equal(meter.observe(60000), false);
  for (let i = 0; i < 10; i++) meter.observe(50);
  near(meter.fps, 20);
});

test("invalid intervals reset safely and no frame history grows", () => {
  const meter = new FrameRate();
  for (const value of [0, -1, NaN, Infinity, undefined, "16"]) {
    meter.observe(1);
    meter.observe(500);
    assert.equal(meter.observe(value), false);
    assert.equal(meter.fps, null);
  }
  const keys = Object.keys(meter);
  meter.observe(1);
  for (let i = 0; i < 100000; i++) meter.observe(10);
  assert.deepEqual(Object.keys(meter), keys);
  assert.ok(
    Object.values(meter).every(
      (value) => typeof value === "number" || typeof value === "boolean"
    )
  );
  near(meter.fps, 100);
});
