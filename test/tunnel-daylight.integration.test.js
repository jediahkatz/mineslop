import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { sampleDaylightAt } from "../src/daylight-material.js";
import { hasTerrainRoof } from "../src/renderer.js";
import { World } from "../src/world.js";
import { daylightRenderer } from "./daylight-fixture.js";

test("the recorded native entrance keeps daylight, deep darkness, look-back terrain and a real remeshed torch", async (t) => {
  const world = new World("cedar-valley", { generatorVersion: 3, useWorker: false });
  t.after(() => world.dispose());
  // Exact native stations from the pre-fix capture; this is not authored
  // entrance terrain, player-input evidence, or a GPU luminance assertion.
  const outside = { x: 60.5, y: 37.01, z: 986.5 };
  const entrance = { x: 60.5, y: 30.01, z: 964.25 };
  const occluded = { x: 60.5, y: 20.01, z: 937.5 };
  const deep = { x: 60.5, y: 16.01, z: 916.5 };
  await world.ensureArea({ x: 60.5, y: 27.01, z: 951.5 }, 4);
  const admitted = world.chunks.size;
  const g = daylightRenderer(t, world, outside);
  let elapsed = 0;
  const opening = new THREE.Vector3(outside.x, outside.y + 1.62, outside.z);
  const visit = (feet, lookBack = false) => {
    g.camera.position.set(feet.x, feet.y + 1.62, feet.z);
    if (lookBack) g.camera.lookAt(opening);
    else g.camera.rotation.set(0, 0, 0, "YXZ");
    g.rebuildDirty(Infinity);
    g.update(0, elapsed += 0.05, feet);
    assert.equal(world.chunks.size, admitted, "lighting cannot admit more terrain");
  };
  const warm = (feet, lookBack = false) => {
    for (let frame = 0; frame < 320; frame++) {
      visit(feet, lookBack);
      if (g.distant.ready && !g.distant._job) return;
    }
    assert.fail("bounded native LOD work did not publish");
  };
  const state = (label) => ({
    label,
    key: g.atmosphere.sunlight.intensity,
    hemi: g.atmosphere.hemi.intensity,
    exposure: g.skyAccess.exposure,
    skyVisible: g.skyAccess.skyVisible,
    fog: [g.scene.fog.near, g.scene.fog.far],
    selected: g.lightStats.selected,
  });
  warm(outside);
  const outsideState = state("outside");
  assert.equal(g.skyAccess.exposure, 1);
  visit(entrance);
  assert.equal(hasTerrainRoof(world, g.camera.position), true);
  assert.equal(world.getBiome(60, 964, entrance.y).category, "cave");
  const beforeLabel = state("roofed-before-HUD");
  assert.ok(beforeLabel.exposure > 0 && beforeLabel.exposure < 1);
  assert.ok(beforeLabel.hemi > 0.05 && beforeLabel.hemi < 1.48);
  const oldLayer = g.distant._active;
  // Keep the original frame/HUD ordering, including the first frame after it.
  g.setBiome(world.getBiome(60, 964, entrance.y));
  visit(entrance);
  const afterLabel = state("roofed-after-HUD");
  assert.ok(Math.abs(afterLabel.hemi - beforeLabel.hemi) < 0.000001);
  assert.ok(Math.abs(afterLabel.key - beforeLabel.key) < 0.000001);
  assert.equal(g.distant._active, oldLayer, "a label change must not discard the visible horizon");
  assert.equal(g.distant.ready, true);
  assert.deepEqual(sampleDaylightAt(g.skyColumns, opening), { direct: 1, ambient: 1 });
  visit(entrance, true);
  g.camera.updateMatrixWorld(true);
  const depth = -opening.clone().applyMatrix4(g.camera.matrixWorldInverse).z;
  assert.ok(depth > 0);
  const mouthFog = THREE.MathUtils.smoothstep(depth, g.scene.fog.near, g.scene.fog.far);
  assert.ok(mouthFog < 0.05, `the pre-fix look-back fog weight was 0.764, now ${mouthFog}`);
  const entranceState = state("look-back");

  // The real ABBA capture lost both layers here, then waited over 120 native
  // frames for a new canopy before the visible entrance regained its horizon.
  const canopy = g.distant._vegetation;
  assert.ok(canopy);
  for (let frame = 0; frame < 4; frame++) {
    visit(occluded);
    assert.equal(g.skyAccess.known, true);
    assert.equal(g.skyAccess.skyVisible, false);
    assert.equal(g.distant.ready, false);
    assert.equal(g.distant.fogDistance, 0);
    assert.equal(g.distant._active, oldLayer);
    assert.equal(g.distant._vegetation, canopy);
    assert.equal(g.distant._job, null);
    assert.equal(g.distant._vegetationJob, null);
    assert.deepEqual(g.distant.lastWork, { units: 0, samples: 0 });
  }
  const occludedState = state("occluded");
  visit(entrance, true);
  assert.equal(g.skyAccess.skyVisible, true);
  assert.equal(g.distant.ready, true, "no warm() after the occluded station");
  assert.equal(g.distant._active, oldLayer);
  assert.equal(g.distant._vegetation, canopy);
  assert.equal(g.distant._job, null);
  assert.equal(g.distant._vegetationJob, null);
  assert.ok(g.scene.fog.far > occludedState.fog[1]);
  const returnFog = THREE.MathUtils.smoothstep(depth, g.scene.fog.near, g.scene.fog.far);
  assert.ok(returnFog < 0.05, `first-visible look-back fog weight: ${returnFog}`);
  const returnState = state("first-visible-return");

  g.setBiome(world.getBiome(60, 916, deep.y));
  warm(deep, true);
  assert.equal(g.skyAccess.exposure, 0);
  assert.equal(g.atmosphere.sunlight.intensity, 0);
  assert.equal(g.atmosphere.hemi.intensity, 0.05);
  assert.equal(g.skyAccess.skyVisible, true, "the distant aperture does not imply ambient light here");
  assert.equal(g.distant.ready, true);
  assert.deepEqual(sampleDaylightAt(g.skyColumns, g.camera.position), { direct: 0, ambient: 0 });
  const deepState = state("deep-with-native-emitters");
  assert.equal(world.get(61, 16, 916), BLOCK.AIR);
  assert.equal(world.set(61, 16, 916, BLOCK.TORCH), true);
  visit(deep, true);
  assert.equal(g.localLights[0].userData.emitter.id, BLOCK.TORCH);
  assert.ok(g.localLights[0].intensity > 6);
  assert.equal(g.skyAccess.exposure, 0, "a torch is not an outdoor opening");
  const torchState = state("real-torch");
  g.setFullbrightInspection(true);
  assert.equal(g.atmosphere.inspectionLight.intensity, Math.PI);
  assert.equal(g.daylightMaterial.uniforms.uDaylightEnabled.value, 0);
  assert.ok(g.localLights.every((light) => !light.visible && !light.intensity));
  g.setFullbrightInspection(false);
  assert.equal(g.daylightMaterial.uniforms.uDaylightEnabled.value, 1);
  assert.equal(g.localLights[0].userData.emitter.id, BLOCK.TORCH);
  assert.equal(g.atmosphere.hemi.intensity, 0.05);
  assert.equal(world.set(61, 16, 916, BLOCK.AIR), true);
  visit(deep, true);
  assert.ok(g.localLights.every((light) => light.userData.emitter?.id !== BLOCK.TORCH));
  t.diagnostic(JSON.stringify({ stations: [outsideState, beforeLabel, afterLabel, entranceState, occludedState, returnState, deepState, torchState], mouthFog, returnFog, admitted }));
});
