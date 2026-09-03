import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { sampleDaylightAt } from "../src/daylight-material.js";
import { daylightRenderer, daylightTunnel } from "./daylight-fixture.js";
import { ENTRANCE_SURFACES, surfaceAirPoint, surfaceTunnel } from "./daylight-surface-fixture.js";

test("natural world shading distinguishes outdoor, entrance and deep surfaces in the same frame", (t) => {
  const fixture = daylightTunnel();
  const feet = { x: 4.5, y: 8, z: 2.5 };
  const g = daylightRenderer(t, fixture.world, feet);
  g.update(0, 1, feet);
  const at = (x) => sampleDaylightAt(g.skyColumns, fixture.position(x));
  assert.deepEqual(at(-2.5), { direct: 1, ambient: 1 });
  assert.equal(at(4.5).direct, 0);
  assert.ok(at(4.5).ambient > 0 && at(4.5).ambient < 1);
  assert.deepEqual(at(32.5), { direct: 0, ambient: 0 });
  assert.ok(g.atmosphere.hemi.intensity > 0.05);
  const uniforms = g.daylightMaterial.uniforms;
  assert.equal(uniforms.uDaylightEnabled.value, 1);
  assert.equal(uniforms.uDaylightFogEnabled.value, 1);
  const noon = uniforms.uDaylightKey.value.clone();
  g.setTime(0);
  assert.ok(uniforms.uDaylightKey.value.r < noon.r);
  assert.ok(uniforms.uDaylightKey.value.b > uniforms.uDaylightKey.value.r);
  g.setFullbrightInspection(true);
  assert.equal(uniforms.uDaylightEnabled.value, 0, "inspection disables the spatial mask immediately");
  assert.equal(uniforms.uDaylightFogEnabled.value, 0);
  assert.equal(g.atmosphere.inspectionLight.intensity, Math.PI);
  assert.equal(g.atmosphere.sunlight.intensity, 0);
  assert.equal(g.atmosphere.hemi.intensity, 0);
  g.setFullbrightInspection(false);
  assert.equal(uniforms.uDaylightEnabled.value, 1);
  assert.deepEqual(at(32.5), { direct: 0, ambient: 0 });
  t.diagnostic(JSON.stringify({ exterior: at(-2.5), entrance: at(4.5), deep: at(32.5) }));
});

test("closed source-free rooms, dimensions and unknown cameras keep their existing lighting contracts", (t) => {
  const fixture = daylightTunnel(-32);
  fixture.close();
  const feet = { x: 4.5, y: -32, z: 2.5 };
  const g = daylightRenderer(t, fixture.world, feet);
  for (const time of [0, 0.3, 0.5, 0.75]) {
    g.atmosphere.timeOfDay = time;
    g.update(0, time + 1, feet);
    assert.equal(g.skyAccess.exposure, 0);
    assert.equal(g.skyAccess.skyVisible, false);
    assert.equal(g.atmosphere.sunlight.intensity, 0);
    assert.equal(g.atmosphere.hemi.intensity, 0.05);
    assert.ok(g.localLights.every((light) => light.intensity === 0));
  }
  g.camera.position.x = 80;
  g.update(0, 3, feet);
  assert.equal(g.skyAccess.known, false);
  assert.equal(g.atmosphere.cameraMediumKnown, false);
  assert.equal(g.atmosphere.sun.visible, false);
  assert.equal(g.distant.group.visible, false);
  g.camera.position.copy(fixture.position(4.5));
  for (const dimension of ["nether", "end"]) {
    fixture.world.dimension = dimension;
    g.setBiome({ dimension });
    g.update(0, 4, feet);
    assert.equal(g.daylightMaterial.uniforms.uDaylightEnabled.value, 0);
    assert.equal(g.atmosphere.sunlight.intensity, 0.35);
    assert.equal(g.atmosphere.hemi.intensity, 1.55);
    assert.equal(g.atmosphere.sun.visible, false);
  }
  fixture.world.dimension = "overworld";
  g.setBiome(fixture.surface);
  g.update(0, 5, feet);
  assert.equal(g.atmosphere.underground, false, "the label alone says surface");
  assert.equal(g.skyAccess.exposure, 0, "the real closed room still has no daylight");
  assert.equal(g.atmosphere.sunlight.intensity, 0);
  assert.equal(g.atmosphere.hemi.intensity, 0.05);
  assert.ok(g.scene.fog.color.equals(new THREE.Color("#36444d").multiplyScalar(0.12)));
  assert.ok(g.daylightMaterial.uniforms.uCaveFog.value.equals(g.scene.fog.color));
});

test("water and lava keep their camera-medium fog instead of receiving the cave/exterior fog mask", (t) => {
  const fixture = daylightTunnel();
  const feet = { x: 4.5, y: 8, z: 2.5 };
  const g = daylightRenderer(t, fixture.world, feet);
  for (const block of [BLOCK.WATER, BLOCK.LAVA, BLOCK.AIR]) {
    fixture.world.put(4, 9, 2, block);
    g.update(0, block + 1, feet);
    assert.equal(g.atmosphere.underwater, block === BLOCK.WATER);
    assert.equal(g.atmosphere.inLava, block === BLOCK.LAVA);
    assert.equal(g.daylightMaterial.uniforms.uDaylightFogEnabled.value, Number(block === BLOCK.AIR));
  }
});

test("Lambert hooks preserve torch/emissive/ambient paths and compose with existing water hooks", (t) => {
  const fixture = daylightTunnel();
  const feet = { x: 4.5, y: 8, z: 2.5 };
  const g = daylightRenderer(t, fixture.world, feet);
  g.update(0, 1, feet);
  const material = new THREE.MeshLambertMaterial();
  t.after(() => material.dispose());
  let waterHookCalls = 0;
  material.onBeforeCompile = (shader) => {
    waterHookCalls++;
    shader.uniforms.existingRippleTime = { value: 3 };
  };
  material.customProgramCacheKey = () => "water-high";
  g.daylightMaterial.install(material);
  g.daylightMaterial.install(material);
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.lambert.vertexShader,
    fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
  };
  material.onBeforeCompile(shader, null);
  assert.equal(waterHookCalls, 1);
  assert.equal(shader.uniforms.existingRippleTime.value, 3);
  assert.match(material.customProgramCacheKey(), /^water-high:daylight/);
  assert.match(shader.fragmentShader, /getPointLightInfo\( pointLight, geometryPosition, directLight \);/);
  assert.match(shader.fragmentShader, /getAmbientLightIrradiance\( ambientLightColor \)/);
  assert.match(shader.fragmentShader, /#include <emissivemap_fragment>/);
  assert.match(shader.fragmentShader, /directLight.color = uDaylightKey \* skyMask.x/);
  assert.match(shader.fragmentShader, /mix\(uCaveSky, uDaylightSky, skyMask.y\)/);
  assert.match(shader.fragmentShader, /linearToOutputTexel\(vec4\(uCaveFog, 1.0\)\)/);
  assert.match(shader.fragmentShader, /mix\(caveFog, fogColor, skyMask.y\)/);
  assert.equal(shader.uniforms.uSkyCeilings.value, g.skyColumns.texture);
  assert.equal(shader.uniforms.uSurfaceDaylight.value, g.skyColumns.surfaceLight.texture);
  assert.equal(Object.hasOwn(shader.uniforms, "uDaylightOpenings"), false, "camera diagnostics are not shader inputs");
  const distantShader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.lambert.vertexShader,
    fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
  };
  g.distant._terrainMaterial.onBeforeCompile(distantShader, null);
  assert.match(distantShader.fragmentShader, /#define MINESLOP_EXTERIOR_DAYLIGHT/);
  assert.equal(distantShader.uniforms.uDaylightKey, shader.uniforms.uDaylightKey);
});

test("[surface-light] the surface atlas preserves the same entrance faces at deep camera exposure zero", (t) => {
  const fixture = surfaceTunnel();
  const feet = { x: 4.5, y: 8, z: 2.5 };
  const g = daylightRenderer(t, fixture.world, feet, "medium");
  const samples = [];
  for (const x of [4.5, 15.5, 16.5, 32.5, 4.5]) {
    g.camera.position.copy(fixture.position(x));
    g.camera.lookAt(2.53125, 11, 2.53125);
    g.update(0, samples.length, { ...feet, x });
    const u = g.daylightMaterial.uniforms;
    samples.push({
      x,
      cameraDiagnostics: {
        exposure: g.skyAccess.exposure,
        skyVisible: g.skyAccess.skyVisible,
        sources: g.skyAccess.sources.map((source) => ({ ...source })),
      },
      field: u.uSkyField.value.toArray(),
      enabled: u.uDaylightEnabled.value,
      floor: { sky: u.uCaveSky.value.toArray(), ground: u.uCaveGround.value.toArray() },
      surfaces: ENTRANCE_SURFACES.map((surface) => ({
        name: surface.name,
        ...sampleDaylightAt(g.skyColumns, surfaceAirPoint(surface)),
      })),
    });
  }
  t.diagnostic(JSON.stringify({ fixedSurfaceLighting: samples }));
  g.setFullbrightInspection(true);
  assert.equal(g.daylightMaterial.uniforms.uDaylightEnabled.value, 0);
  assert.equal(g.atmosphere.inspectionLight.intensity, Math.PI);
  g.setFullbrightInspection(false);
  assert.equal(g.daylightMaterial.uniforms.uDaylightEnabled.value, 1);
  assert.equal(samples[3].cameraDiagnostics.exposure, 0, "do not lift the deep camera's exposure to light the mouth");
  assert.deepEqual(samples[3].cameraDiagnostics.sources, []);
  for (const sample of samples) {
    assert.ok(sample.cameraDiagnostics.skyVisible && sample.enabled);
    for (let i = 0; i < ENTRANCE_SURFACES.length; i++)
      assert.ok(
        Math.abs(sample.surfaces[i].ambient - samples[0].surfaces[i].ambient) < 0.08,
        `${sample.surfaces[i].name}: GPU input loses illumination at observer x=${sample.x}`
      );
  }
});
