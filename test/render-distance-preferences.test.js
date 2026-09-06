import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RENDER_RADIUS } from "../src/render-distance.js";
import {
  RENDER_DISTANCE_KEY,
  loadRenderDistance,
  normalizeRenderDistance,
  saveRenderDistance,
} from "../src/render-distance-preferences.js";

const storageFixture = () => {
  const values = new Map();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
};

test("distance preferences accept only integer radii in the shared range", () => {
  for (let radius = 2; radius <= 12; radius++)
    assert.equal(normalizeRenderDistance(radius), radius);
  for (const invalid of [null, undefined, "6", {}, [], true, 0, 1, 13, 6.5, NaN, Infinity])
    assert.equal(normalizeRenderDistance(invalid), DEFAULT_RENDER_RADIUS);
});

test("missing or malformed browser preferences use the default without rewriting storage", () => {
  const storage = storageFixture();
  assert.equal(loadRenderDistance(storage), DEFAULT_RENDER_RADIUS);
  assert.equal(storage.values.size, 0);
  for (const raw of ["{", "null", '"6"', "{}", "[]", "true", "1", "13", "4.5"]) {
    storage.values.set(RENDER_DISTANCE_KEY, raw);
    assert.equal(loadRenderDistance(storage), DEFAULT_RENDER_RADIUS);
    assert.equal(storage.getItem(RENDER_DISTANCE_KEY), raw);
  }
});

test("accepted distance survives reload without modifying other preferences", () => {
  const storage = storageFixture();
  storage.values.set("voxelcraft-view-v1", '{"guiScale":2,"showFps":true}');
  for (const radius of [2, 6, 12]) {
    assert.equal(saveRenderDistance(radius, storage), true);
    assert.equal(loadRenderDistance(storage), radius);
    assert.equal(storage.getItem(RENDER_DISTANCE_KEY), String(radius));
  }
  assert.equal(storage.getItem("voxelcraft-view-v1"), '{"guiScale":2,"showFps":true}');
  assert.equal(storage.values.size, 2);
});

test("invalid saves cannot replace an existing accepted distance", () => {
  const storage = storageFixture();
  assert.equal(saveRenderDistance(6, storage), true);
  for (const invalid of [undefined, null, "12", 1, 13, 6.5, NaN, Infinity]) {
    assert.equal(saveRenderDistance(invalid, storage), false);
    assert.equal(loadRenderDistance(storage), 6);
  }
});

test("unavailable browser storage fails safely", () => {
  const storage = {
    getItem() { throw new Error("Storage unavailable"); },
    setItem() { throw new Error("Quota exceeded"); },
  };
  assert.equal(loadRenderDistance(storage), DEFAULT_RENDER_RADIUS);
  assert.equal(saveRenderDistance(12, storage), false);
});
