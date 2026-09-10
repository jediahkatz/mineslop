import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_RENDER_MODE,
  RENDER_MODE_KEY,
  loadRenderModePreferences,
  normalizeRenderModePreferences,
  resolveRenderMode,
  saveRenderModePreferences,
} from "../src/render-mode-preferences.js";
import { loadRenderDistance, RENDER_DISTANCE_KEY } from "../src/render-distance-preferences.js";

function storage(initial = []) {
  const values = new Map([
    [RENDER_DISTANCE_KEY, "12"],
    ["voxelcraft-view-v1", '{ "showFps": true, "guiScale": "auto" }'],
    ["voxelcraft-controls-v1", '{ "inputMode": "remote" }'],
    ...initial,
  ]);
  const writes = [];
  return {
    values,
    writes,
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      writes.push([key, value]);
      values.set(key, value);
    },
  };
}

test("a missing mode uses the original short presets without rewriting the extended preference or other keys", () => {
  const source = storage(), before = [...source.values];
  const preferences = loadRenderModePreferences(source);
  assert.deepEqual(preferences, { version: 1, mode: "nearby", nearbyRadius: null });
  assert.equal(Object.isFrozen(preferences), true);
  for (const [quality, radius] of [["low", 2], ["medium", 3], ["high", 4]])
    assert.deepEqual(resolveRenderMode(preferences, loadRenderDistance(source), quality), {
      mode: "nearby", distantTerrain: false, override: null, radius, maxRadius: 4,
    });
  assert.equal(resolveRenderMode(preferences, 12, "toString").radius, 3);
  assert.deepEqual([...source.values], before);
  assert.deepEqual(source.writes, []);
});

test("explicit nearby distance is independent of effects while extended restores its own retained radius", () => {
  for (const radius of [2, 3, 4])
    for (const quality of ["low", "medium", "high"])
      assert.deepEqual(resolveRenderMode({ version: 1, mode: "nearby", nearbyRadius: radius }, 12, quality), {
        mode: "nearby", distantTerrain: false, override: radius, radius, maxRadius: 4,
      });
  for (const radius of [2, 6, 12])
    for (const quality of ["low", "medium", "high"])
      assert.deepEqual(resolveRenderMode({ version: 1, mode: "extended", nearbyRadius: 3 }, radius, quality), {
        mode: "extended", distantTerrain: true, override: radius, radius, maxRadius: 12,
      });
});

test("mode switches and nearby adjustments cold-load without modifying any legacy preference bytes", () => {
  const source = storage(), legacy = [...source.values];
  for (const mode of ["nearby", "extended", "nearby"]) {
    const requested = { version: 1, mode, nearbyRadius: 2 };
    assert.equal(saveRenderModePreferences(requested, source), true);
    const loaded = loadRenderModePreferences(source);
    assert.deepEqual(loaded, requested);
    assert.deepEqual([...source.values].filter(([key]) => key !== RENDER_MODE_KEY), legacy);
    assert.equal(loadRenderDistance(source), 12);
    assert.equal(resolveRenderMode(loaded, loadRenderDistance(source), "high").radius,
      mode === "nearby" ? 2 : 12);
  }
  assert.equal(source.writes.every(([key]) => key === RENDER_MODE_KEY), true);
});

test("malformed, inherited, future and accessor preferences fall back read-only instead of migrating storage", () => {
  const bad = [
    null, [], "extended", {}, { ...DEFAULT_RENDER_MODE, version: 2 },
    { ...DEFAULT_RENDER_MODE, mode: "unknown" },
    ...[undefined, 0, 1, 5, 12, 2.5, "3"].map((nearbyRadius) => ({
      ...DEFAULT_RENDER_MODE, nearbyRadius,
    })),
    Object.create(DEFAULT_RENDER_MODE),
  ];
  let reads = 0;
  bad.push({
    version: 1, nearbyRadius: null,
    get mode() { reads++; return "extended"; },
  });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  bad.push(revoked.proxy);
  for (const value of bad) {
    assert.deepEqual(normalizeRenderModePreferences(value), DEFAULT_RENDER_MODE);
    const target = storage();
    assert.equal(saveRenderModePreferences(value, target), false);
    assert.deepEqual(target.writes, []);
  }
  assert.equal(reads, 0);
  for (const text of ["not JSON", '{"version":2,"mode":"extended","nearbyRadius":2}', "null"]) {
    const source = storage([[RENDER_MODE_KEY, text]]), before = [...source.values];
    assert.deepEqual(loadRenderModePreferences(source), DEFAULT_RENDER_MODE);
    assert.deepEqual([...source.values], before);
    assert.deepEqual(source.writes, []);
  }
});

test("storage denial is explicit for writes and safe for reads", () => {
  const blocked = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
  };
  assert.deepEqual(loadRenderModePreferences(blocked), DEFAULT_RENDER_MODE);
  assert.equal(saveRenderModePreferences(DEFAULT_RENDER_MODE, blocked), false);
  assert.equal(saveRenderModePreferences(DEFAULT_RENDER_MODE, {}), false);
});
