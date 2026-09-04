import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { releaseLostContextResources } from "../src/context-resources.js";
import { updateBlockLightUniforms } from "../src/block-light-material.js";
import { applySceneDaylight, DaylightMaterial } from "../src/daylight-material.js";
import { GameRenderer } from "../src/renderer.js";
import { lightField, lightWorld, settleLight } from "./block-light-fixture.js";

test("field hooks compose, rebind, preserve instancing/emission/dynamic lights and detach", () => {
  const columns = { texture: new THREE.Texture(), surfaceLight: { texture: new THREE.Texture() } };
  const firstScene = new THREE.Scene(), secondScene = new THREE.Scene();
  const first = new DaylightMaterial(columns, firstScene), second = new DaylightMaterial(columns, secondScene);
  const material = new THREE.MeshLambertMaterial({ emissive: "#734455" });
  const emissive = material.emissive.clone();
  let calls = 0;
  const original = (shader) => { shader.uniforms.skinTexels = { value: "preserved" }; calls++; };
  material.onBeforeCompile = original;
  material.customProgramCacheKey = () => "skin-atlas";
  const compile = () => {
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.lambert.vertexShader,
      fragmentShader: THREE.ShaderLib.lambert.fragmentShader };
    material.onBeforeCompile(shader, null);
    return shader;
  };
  applySceneDaylight(firstScene, material);
  const a = compile();
  applySceneDaylight(secondScene, material);
  const b = compile();
  assert.equal(calls, 2);
  assert.equal(b.uniforms.skinTexels.value, "preserved");
  assert.equal(a.uniforms.uBlockLightAtlas.value, first.blockLight.texture);
  assert.equal(b.uniforms.uBlockLightAtlas.value, second.blockLight.texture);
  assert.match(b.vertexShader, /instanceMatrix \* daylightPosition/);
  assert.match(b.vertexShader, /batchingMatrix \* daylightPosition/);
  assert.match(b.fragmentShader, /getPointLightInfo\( pointLight, geometryPosition, directLight \);/);
  assert.match(b.fragmentShader, /#include <emissivemap_fragment>/);
  assert.equal((b.fragmentShader.match(/irradiance \+= blockLightAt/g) ?? []).length, 1);
  assert.ok(material.emissive.equals(emissive));
  first.dispose();
  applySceneDaylight(secondScene, material);
  assert.equal(compile().uniforms.uBlockLightAtlas.value, second.blockLight.texture);
  const late = new THREE.MeshLambertMaterial({ transparent: true });
  applySceneDaylight(secondScene, late);
  assert.match(late.customProgramCacheKey(), /block-light-2/);
  second.dispose();
  applySceneDaylight(secondScene, material);
  assert.equal(material.onBeforeCompile, original);
  assert.equal(material.customProgramCacheKey(), "skin-atlas");
  material.dispose(); late.dispose(); columns.texture.dispose(); columns.surfaceLight.texture.dispose();
});

test("all-dimension field enable is independent from daylight and disabled by Fullbright", (t) => {
  const world = lightWorld({ dimension: "nether" }), field = lightField(t);
  world.put(8, 8, 8, BLOCK.TORCH);
  settleLight(field, world);
  const owner = new DaylightMaterial({ texture: null, surfaceLight: { texture: null } });
  t.after(() => owner.dispose());
  updateBlockLightUniforms(field, owner.uniforms, false);
  assert.equal(owner.uniforms.uBlockLightEnabled.value, 1);
  assert.equal(owner.uniforms.uDaylightEnabled.value, 0);
  updateBlockLightUniforms(field, owner.uniforms, true);
  assert.equal(owner.uniforms.uBlockLightEnabled.value, 0);
  field.dispose();
  updateBlockLightUniforms(field, owner.uniforms, false);
  assert.equal(owner.uniforms.uBlockLightEnabled.value, 0);
});

test("static voxel point-light pool is inert; independently owned dynamic lights are untouched", () => {
  const pool = [new THREE.PointLight(), new THREE.PointLight()];
  const dynamic = new THREE.PointLight("#55aaff", 3);
  GameRenderer.prototype.updateLocalLights.call({ localLights: pool }, 10);
  assert.ok(pool.every((light) => light.intensity === 0 && light.userData.emitter === null));
  assert.equal(dynamic.intensity, 3);
});

test("context restoration republishes cached pages within the actual pending-upload cap", (t) => {
  const columns = [];
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) columns.push([x, z]);
  const world = lightWorld({ columns }), field = lightField(t), position = { x: 8, y: 8, z: 8 };
  world.put(8, 8, 8, BLOCK.TORCH);
  settleLight(field, world, position, 1);
  const expected = field.sample({ x: 9, y: 8, z: 8 });
  releaseLostContextResources({ getContext: () => ({ isContextLost: () => true }) },
    new THREE.Scene(), [field.texture, field.validTexture]);
  assert.equal(field.texture.layerUpdates.size, 9, "generic recovery dirties the whole array");
  field.restoreGPU();
  assert.equal(field.texture.layerUpdates.size, 0, "field recovery replaces the full-array upload request");
  assert.deepEqual(field.sample({ x: 9, y: 8, z: 8 }), [0, 0, 0]);
  for (let i = 0; i < 4; i++) {
    field.update(world, position, 1);
    assert.ok(field.texture.layerUpdates.size <= 2, "no draws: updates cannot silently accumulate uploads");
    assert.equal(field.stats.scans, 0);
  }
  assert.ok(field.pending > 0);
  const report = settleLight(field, world, position, 1);
  assert.equal(report.maxima.scans, 0);
  assert.deepEqual(field.sample({ x: 9, y: 8, z: 8 }), expected);
});
