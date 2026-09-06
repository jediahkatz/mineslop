import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { GameRenderer } from "../src/renderer.js";

// Exercise the actual constructor callback without constructing a WebGLRenderer.
// This callback uses only its host; compiling its body avoids a fake recovery
// implementation that would miss changes to the production event handler.
const restoredBody = GameRenderer.toString().match(
  /this\.contextRestoredHandler = \(\) => \{([\s\S]*?)\n    \};/
);
assert.ok(restoredBody, "GameRenderer must register its restoration callback");
const restore = new Function(restoredBody[1]);

function fixture() {
  const sunlight = new THREE.DirectionalLight();
  sunlight.castShadow = true;
  sunlight.shadow.needsUpdate = false;
  // Recovery must not delete a render target through old-context listeners.
  sunlight.shadow.map = { dispose() { assert.fail("restore disposed old shadow map"); } };
  const calls = [];
  const graphics = Object.assign(Object.create(GameRenderer.prototype), {
    atmosphere: {
      sunlight, sunDirection: new THREE.Vector3(0, 1, 0),
      dimension: "overworld", underground: false,
    },
    renderer: { shadowMap: { enabled: true, needsUpdate: false } },
    shadowDirty: false, lastShadowTime: 10,
    shadowPosition: new THREE.Vector3(),
    shadowSunDirection: new THREE.Vector3(0, 1, 0),
    quality: "high", localLights: [],
    setPlayerVisualEffects: () => calls.push("effects"),
    daylightMaterial: { restoreGPU: () => calls.push("daylight") },
    geometryPalette: { restoreGPU: () => calls.push("palette") },
    lightingNeedsFlush: false,
  });
  return { graphics, calls };
}

function flags(graphics, expected) {
  assert.equal(graphics.atmosphere.sunlight.shadow.needsUpdate, expected);
  assert.equal(graphics.renderer.shadowMap.needsUpdate, expected);
}

test("context restoration rearms the first frozen-clock shadow update", () => {
  const { graphics: g, calls } = fixture();
  const map = g.atmosphere.sunlight.shadow.map;
  restore.call(g);
  assert.deepEqual(calls, ["effects", "daylight", "palette"]);
  assert.equal(g.lightingNeedsFlush, true);
  assert.equal(g.shadowDirty, true);
  assert.equal(g.atmosphere.sunlight.shadow.map, map);
  g.updateShadows(10, new THREE.Vector3());
  flags(g, true);
  assert.equal(g.shadowDirty, false);
  assert.equal(g.lastShadowTime, 10);
});

test("ordinary dirty shadows retain the 0.75-second budget", () => {
  const { graphics: g } = fixture();
  g.shadowDirty = true;
  for (const time of [10, 10.5, 10.749]) {
    g.updateShadows(time, new THREE.Vector3());
    flags(g, false);
    assert.equal(g.shadowDirty, true);
    assert.equal(g.lastShadowTime, 10);
  }
  g.updateShadows(10.75, new THREE.Vector3());
  flags(g, true);
  assert.equal(g.shadowDirty, false);
  assert.equal(g.lastShadowTime, 10.75);
});

test("the recovered shadow draw starts a fresh ordinary throttle budget", () => {
  const { graphics: g } = fixture();
  restore.call(g);
  g.updateShadows(10, new THREE.Vector3());
  flags(g, true);
  g.atmosphere.sunlight.shadow.needsUpdate = false;
  g.renderer.shadowMap.needsUpdate = false;
  g.shadowDirty = true;
  for (const time of [10, 10.749]) {
    g.updateShadows(time, new THREE.Vector3());
    flags(g, false);
  }
  g.updateShadows(10.75, new THREE.Vector3());
  flags(g, true);
});

for (const mode of ["low-quality", "fullbright", "underground", "nether"]) {
  test(`restoration respects ${mode} shadows and later re-enabling`, () => {
    const { graphics: g } = fixture();
    if (mode === "low-quality") g.quality = "low";
    if (mode === "fullbright") g.atmosphere.fullbrightInspection = true;
    if (mode === "underground") g.atmosphere.underground = true;
    if (mode === "nether") g.atmosphere.dimension = "nether";
    g.updateLightingMode();
    assert.equal(g.atmosphere.sunlight.castShadow, false);
    restore.call(g);
    g.updateShadows(10, new THREE.Vector3());
    flags(g, false);
    assert.equal(g.renderer.shadowMap.enabled, false);
    assert.equal(g.shadowDirty, true);
    g.quality = "high";
    g.atmosphere.fullbrightInspection = false;
    g.atmosphere.underground = false;
    g.atmosphere.dimension = "overworld";
    g.updateLightingMode();
    g.updateShadows(10, new THREE.Vector3());
    flags(g, true);
    assert.equal(g.renderer.shadowMap.enabled, true);
    assert.equal(g.shadowDirty, false);
  });
}