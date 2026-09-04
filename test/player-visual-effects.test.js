import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { applySceneDaylight, DaylightMaterial } from "../src/daylight-material.js";
import { playerVisionStrength, playerWaterFogFar, visualStrength } from "../src/player-visual-effects.js";
import { daylightRenderer, daylightTunnel } from "./daylight-fixture.js";

const hash = (arrays) => {
  const h = createHash("sha256");
  for (const a of arrays) h.update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  return h.digest("hex");
};
const feet = { x: 4.5, y: 8, z: 2.5 };
const make = (t) => {
  const f = daylightTunnel();
  const g = daylightRenderer(t, f.world, feet, "medium");
  for (let i = 0; i < 60; i++) g.update(0, i, feet);
  return { f, g, u: g.daylightMaterial.uniforms };
};

test("visual scalars are finite, smoothly clamped and conduit requires known submerged water", () => {
  for (const invalid of [undefined, null, NaN, Infinity, -Infinity, "1", {}, true])
    assert.equal(visualStrength(invalid), 0);
  assert.equal(visualStrength(-2), 0);
  assert.equal(visualStrength(2), 1);
  assert.equal(playerVisionStrength(0.25, false, {}), 0.15625);
  assert.equal(playerVisionStrength(0.5, false, {}), 0.5);
  assert.equal(playerVisionStrength(1, false, {}), 1);
  for (const medium of [{}, { cameraMediumKnown: false, underwater: true },
    { cameraMediumKnown: true, underwater: false },
    { cameraMediumKnown: true, underwater: true, inLava: true }])
    assert.equal(playerVisionStrength(0, true, medium), 0);
  assert.equal(playerVisionStrength(0, true, { cameraMediumKnown: true, underwater: true }), 1);
  assert.equal(playerVisionStrength(0, 1, { cameraMediumKnown: true, underwater: true }), 0);
});

test("water fog is bounded by quality/admitted streaming distance, never distant LOD", () => {
  assert.equal(playerWaterFogFar(0, 61), 20);
  assert.equal(playerWaterFogFar(1, 61), 48);
  assert.equal(playerWaterFogFar(0.5, 61), 34);
  for (const cap of [2, 5, 19, 29, 45])
    assert.equal(playerWaterFogFar(1, cap), cap);
  for (const invalid of [NaN, Infinity, undefined])
    assert.equal(playerWaterFogFar(1, invalid), 2);
  assert.equal(playerWaterFogFar(NaN, 61), 20);
});

test("setter copies scalars, expiry clears uniforms, paused valid state and inspection stay independent", (t) => {
  const { g, u } = make(t);
  assert.equal(u.uPlayerVision.value, 0);
  const payload = { nightVision: 1, conduitPower: false };
  g.setPlayerVisualEffects(payload);
  payload.nightVision = 0;
  g.update(0, 70, feet);
  assert.equal(u.uPlayerVision.value, 1);
  const natural = [g.atmosphere.hemi.intensity, g.atmosphere.sunlight.intensity];
  g.setFullbrightInspection(true);
  assert.equal(u.uPlayerVision.value, 0);
  assert.equal(g.fullbrightInspection, true);
  g.setFullbrightInspection(false);
  assert.equal(u.uPlayerVision.value, 1);
  assert.deepEqual([g.atmosphere.hemi.intensity, g.atmosphere.sunlight.intensity], natural);
  for (const payload of [{ nightVision: NaN }, null, undefined, { nightVision: 0 }]) {
    g.setPlayerVisualEffects({ nightVision: 1 });
    g.setPlayerVisualEffects(payload);
    assert.equal(u.uPlayerVision.value, 0);
    assert.equal(g.atmosphere.conduitPower, false);
    assert.equal(g.fullbrightInspection, false);
  }
});

test("actual render camera rejects conduit vision in air, unknown cells and lava", (t) => {
  const { f, g, u } = make(t);
  g.setPlayerVisualEffects({ conduitPower: true });
  g.update(0, 70, feet);
  assert.equal(u.uPlayerVision.value, 0);
  f.world.put(4, 9, 2, BLOCK.WATER);
  g.update(0, 71, feet);
  assert.equal(u.uPlayerVision.value, 1);
  assert.ok(g.scene.fog.far <= g.streamingFogDistance(g.camera.position));
  assert.equal(g.distant.group.visible, false);
  f.world.put(4, 9, 2, BLOCK.LAVA);
  g.update(0, 72, feet);
  assert.equal(u.uPlayerVision.value, 0);
  assert.equal(g.scene.fog.far, 4);
  g.camera.position.x = 80;
  g.update(0, 73, feet);
  assert.equal(g.atmosphere.cameraMediumKnown, false);
  assert.equal(u.uPlayerVision.value, 0);
  assert.equal(g.distant.group.visible, false);
  g.setPlayerVisualEffects({ nightVision: 1 });
  g.update(0, 74, feet);
  assert.equal(u.uPlayerVision.value, 1, "potion vision is not gated by submersion");
});

test("visual projection does not mutate sky fields, block light, source blocks or natural lighting", (t) => {
  const { f, g, u } = make(t);
  const source = () => hash([...f.world.chunks.values()].map((c) => c.blocks));
  const fields = () => hash([g.skyColumns.data, g.skyColumns.surfaceLight.data, g.blockLight.data]);
  const before = { source: source(), fields: fields(), key: u.uDaylightKey.value.toArray(),
    sky: u.uDaylightSky.value.toArray(), ground: u.uDaylightGround.value.toArray(),
    access: JSON.stringify(g.skyAccess), shadows: g.naturalShadowsEnabled() };
  for (const strength of [1, 0.25, 0.5, 0]) {
    g.setPlayerVisualEffects({ nightVision: strength });
    g.update(0, 80 + strength, feet);
    assert.deepEqual({ source: source(), fields: fields(), key: u.uDaylightKey.value.toArray(),
      sky: u.uDaylightSky.value.toArray(), ground: u.uDaylightGround.value.toArray(),
      access: JSON.stringify(g.skyAccess), shadows: g.naturalShadowsEnabled() }, before);
  }
});

test("late instanced material hooks share live uniforms, disposed bindings cannot inherit vision", (t) => {
  const { g, u } = make(t);
  g.setPlayerVisualEffects({ nightVision: 1 });
  const material = new THREE.MeshLambertMaterial();
  t.after(() => material.dispose());
  applySceneDaylight(g.scene, material);
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.lambert.vertexShader,
    fragmentShader: THREE.ShaderLib.lambert.fragmentShader };
  material.onBeforeCompile(shader);
  assert.equal(shader.uniforms.uPlayerVision, u.uPlayerVision);
  assert.match(shader.vertexShader, /instanceMatrix \* daylightPosition/);
  assert.match(shader.fragmentShader, /vec3\(2\.4\) -\s+blockLightAt/);
  assert.match(shader.fragmentShader, /#include <emissivemap_fragment>/);
  g.daylightMaterial.dispose();
  g.daylightMaterial.update(g.atmosphere);
  assert.equal(u.uPlayerVision.value, 0);
  const replacement = new DaylightMaterial(g.skyColumns, new THREE.Scene());
  t.after(() => replacement.dispose());
  replacement.install(material);
  material.onBeforeCompile(shader);
  assert.equal(shader.uniforms.uPlayerVision.value, 0);
  assert.notEqual(shader.uniforms.uPlayerVision, u.uPlayerVision);
});

test("world dimension/epoch replacement resets player presentation", (t) => {
  const { f, g, u } = make(t);
  g.setPlayerVisualEffects({ nightVision: 1, conduitPower: true });
  f.world.dimension = "end";
  g.syncVisibleChunks();
  assert.equal(u.uPlayerVision.value, 0);
  assert.equal(g.atmosphere.nightVision, 0);
  assert.equal(g.atmosphere.conduitPower, false);
});
