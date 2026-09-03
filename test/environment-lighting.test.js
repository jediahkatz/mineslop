import assert from "node:assert/strict";
import test from "node:test";
import { sampleOutdoorLighting } from "../src/environment-lighting.js";

test("daylight has a stronger key than fill, while night retains a dim above-horizon moon", () => {
  const day = sampleOutdoorLighting(1);
  const night = sampleOutdoorLighting(-1);
  assert.ok(day.keyIntensity > day.hemisphereIntensity);
  assert.ok(night.keyIntensity > 0);
  assert.ok(
    day.keyIntensity + day.hemisphereIntensity >
      (night.keyIntensity + night.hemisphereIntensity) * 4
  );
  assert.equal(day.keySign, 1);
  assert.equal(night.keySign, -1);
  assert.equal(day.moonIntensity, 0);
  assert.equal(night.sunIntensity, 0);
});

test("sunset warmth and key/fill power vary continuously through the zero-power sun/moon handoff", () => {
  let previous = sampleOutdoorLighting(-1);
  for (let step = 1; step <= 2000; step++) {
    const height = -1 + step / 1000;
    const next = sampleOutdoorLighting(height);
    for (const key of [
      "keyIntensity",
      "hemisphereIntensity",
      "warmth",
      "sunWarmth",
      "daylight",
    ]) {
      assert.ok(Number.isFinite(next[key]) && next[key] >= 0, key);
      assert.ok(Math.abs(previous[key] - next[key]) < 0.03, key);
    }
    assert.ok(height * next.keySign >= 0, "the active key is above ground");
    if (height < 0) assert.equal(next.sunIntensity, 0);
    else assert.equal(next.moonIntensity, 0);
    previous = next;
  }
  const horizon = sampleOutdoorLighting(0);
  assert.equal(horizon.keyIntensity, 0);
  assert.ok(horizon.hemisphereIntensity > 0, "twilight keeps a sky fill");
  assert.ok(sampleOutdoorLighting(0.1).sunWarmth > previous.sunWarmth);
});

test("lighting samples reuse caller-owned storage and sanitize unsupported heights", () => {
  const state = {};
  assert.equal(sampleOutdoorLighting(0.5, state), state);
  assert.equal(sampleOutdoorLighting(-0.5, state), state);
  assert.equal(state.keySign, -1);
  for (const height of [NaN, Infinity, undefined, 8])
    assert.deepEqual(sampleOutdoorLighting(height), sampleOutdoorLighting(1));
  assert.deepEqual(sampleOutdoorLighting(-8), sampleOutdoorLighting(-1));
});
