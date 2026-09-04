import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { DaylightMaterial } from "../src/daylight-material.js";
import { createMobGelResources, createMobSkinResources } from "../src/mob-skin-atlas.js";
import { daylightRenderer, daylightTunnel } from "./daylight-fixture.js";

function compile(material) {
  const shader = {
    uniforms: {}, vertexShader: THREE.ShaderLib.lambert.vertexShader,
    fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
  };
  material.onBeforeCompile(shader, null);
  return shader;
}

test("late opaque and gel batches bind scene daylight without changing skin, emission or local light paths", (t) => {
  const fixture = daylightTunnel(), feet = { x: 4.5, y: 8, z: 2.5 };
  const g = daylightRenderer(t, fixture.world, feet);
  g.update(0, 1, feet);
  const skin = createMobSkinResources(72), gel = createMobGelResources(skin);
  t.after(() => { gel.dispose(); skin.dispose(); g.daylightMaterial.dispose(); });
  const pixels = skin.texture.image.data.slice();
  for (const resources of [skin, gel]) {
    const material = resources.material;
    const version = material.version;
    assert.equal(g.daylightMaterial.installed.has(material), false);
    material.onBeforeRender(null, g.scene);
    assert.equal(g.daylightMaterial.installed.has(material), true);
    assert.equal(material.version, version + 1);
    material.onBeforeRender(null, g.scene);
    assert.equal(material.version, version + 1, "shared instances install only once");
    const shader = compile(material);
    assert.equal(shader.uniforms.uSkyCeilings, g.daylightMaterial.uniforms.uSkyCeilings);
    assert.match(shader.vertexShader, /vMapUv = mobSkinRect.xy/);
    assert.match(shader.fragmentShader, /diffuseColor.rgb \*= mobSkinTexel.rgb/);
    assert.match(shader.fragmentShader, /totalEmissiveRadiance \+= mix\(mobSkinTexel.rgb, vMobTint, vMobFlash\) \* mobSkinTexel.a/);
    assert.match(shader.fragmentShader, /getPointLightInfo\( pointLight, geometryPosition, directLight \)/);
    assert.match(shader.fragmentShader, /getAmbientLightIrradiance\( ambientLightColor \)/);
    assert.match(shader.fragmentShader, /uDaylightEnabled > 0.5/);
    assert.match(shader.fragmentShader, /uDaylightFogEnabled > 0.5/);
    assert.equal(material.fog, true);
  }
  assert.equal(gel.texture, skin.texture);
  assert.deepEqual(skin.texture.image.data, pixels, "original texels and alpha-emission stay intact");
  assert.equal(gel.material.transparent, true);
  assert.equal(gel.material.depthWrite, false);
  g.setFullbrightInspection(true);
  assert.equal(g.daylightMaterial.uniforms.uDaylightEnabled.value, 0);
  assert.equal(g.atmosphere.inspectionLight.intensity, Math.PI);
  g.setFullbrightInspection(false);
  assert.equal(g.daylightMaterial.uniforms.uDaylightEnabled.value, 1);
});

test("world sampling follows batching, instancing and the batch anchor in Three's transform order", (t) => {
  const fixture = daylightTunnel(), feet = { x: 4.5, y: 8, z: 2.5 };
  const g = daylightRenderer(t, fixture.world, feet);
  g.update(0, 1, feet);
  const resources = createMobSkinResources(1);
  t.after(() => { resources.dispose(); g.daylightMaterial.dispose(); });
  resources.material.onBeforeRender(null, g.scene);
  const shader = compile(resources.material);
  assert.match(shader.vertexShader, /#ifdef USE_BATCHING\s+daylightPosition = batchingMatrix \* daylightPosition;/);
  assert.match(shader.vertexShader, /#ifdef USE_INSTANCING\s+daylightPosition = instanceMatrix \* daylightPosition;/);
  assert.match(shader.vertexShader, /vDaylightPosition = \(modelMatrix \* daylightPosition\).xyz/);
  assert.ok(shader.vertexShader.indexOf("batchingMatrix * daylightPosition") <
    shader.vertexShader.indexOf("instanceMatrix * daylightPosition"));
  assert.ok(shader.vertexShader.indexOf("instanceMatrix * daylightPosition") <
    shader.vertexShader.indexOf("modelMatrix * daylightPosition"));
  // Wildlife subtracts the batch anchor from uploaded matrices. Including
  // modelMatrix alone would sample (48,0,960), not this real cow top.
  const instance = new THREE.Matrix4().makeTranslation(13.75, 33.42, 9.45);
  const anchor = new THREE.Matrix4().makeTranslation(48, 0, 960);
  const point = new THREE.Vector3().applyMatrix4(instance).applyMatrix4(anchor);
  assert.deepEqual(point.toArray(), [61.75, 33.42, 969.45]);
});

test("retained materials rebind across replacement scenes without nested hooks or stale uniforms", (t) => {
  const fixture = daylightTunnel(), feet = { x: 4.5, y: 8, z: 2.5 };
  const g = daylightRenderer(t, fixture.world, feet);
  g.update(0, 1, feet);
  const resources = createMobSkinResources(1);
  const nextScene = new THREE.Scene();
  const next = new DaylightMaterial(g.skyColumns, nextScene);
  t.after(() => { resources.dispose(); next.dispose(); g.daylightMaterial.dispose(); });
  const material = resources.material;
  material.onBeforeRender(null, g.scene);
  const oldKey = material.customProgramCacheKey();
  material.onBeforeRender(null, nextScene);
  assert.equal(g.daylightMaterial.installed.has(material), false);
  assert.equal(next.installed.has(material), true);
  assert.notEqual(material.customProgramCacheKey(), oldKey);
  const shader = compile(material);
  assert.equal(shader.uniforms.uDaylightEnabled, next.uniforms.uDaylightEnabled);
  assert.equal(shader.vertexShader.match(/varying vec3 vDaylightPosition;/g).length, 1);
  assert.equal(shader.fragmentShader.match(/vec4 mobSkinTexel =/g).length, 1);
  next.dispose();
  material.onBeforeRender(null, nextScene);
  assert.equal(next.installed.has(material), false);
  assert.equal(material.customProgramCacheKey(), "voxelcraft-mob-skin-atlas-v1");
  assert.doesNotMatch(compile(material).vertexShader, /vDaylightPosition/);
  const late = createMobGelResources(resources);
  t.after(() => late.dispose());
  late.material.onBeforeRender(null, nextScene);
  assert.equal(next.installed.has(late.material), false, "disposed scenes do not bind new materials");
  const replacement = new DaylightMaterial(g.skyColumns, nextScene);
  t.after(() => replacement.dispose());
  late.material.onBeforeRender(null, nextScene);
  assert.equal(replacement.installed.has(late.material), true, "new renderer binds late batches after travel/reload");
});
