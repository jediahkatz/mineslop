// A controlled material-composition test, NOT world lighting/readiness proof.
// Production DaylightMaterial and BlockLight shader code sample real complete
// textures. Constant page handles exercise both lit and roofed normal offsets.
import * as THREE from "three";
import { SkyColumns } from "../src/sky-columns.js";
import { DaylightMaterial } from "../src/daylight-material.js";

export function waterPullLightFixture(scene, materials) {
  const columns = new SkyColumns(1), daylight = new DaylightMaterial(columns, scene), owned = [];
  const texture = (data, width, height, format, type) => {
    const t = new THREE.DataTexture(data, width, height, format, type);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    owned.push(t);
    return t;
  };
  const sky = new Float32Array(64 * 64);
  for (let z = 0; z < 64; z++) for (let x = 0; x < 64; x++) sky[z * 64 + x] = x < 40 ? 0 : 128;
  const surface = new Uint16Array(36 * 25).fill(257);
  surface.fill(1, 36 * 24);
  const block = new Uint16Array(16 * 24);
  for (let y = 0; y < 24; y++) for (let slot = 0; slot < 16; slot++) block[y * 16 + slot] = 18 + slot * 4;
  const palette = new Float32Array(256 * 4);
  for (let i = 0; i < 256; i++) palette.set([0.08 + i / 1024, 0.04, 0.01, 1], i * 4);
  const dummy = new THREE.DataArrayTexture(new Uint8Array(1), 1, 1, 1);
  dummy.format = THREE.RedFormat;
  dummy.needsUpdate = true;
  owned.push(dummy);
  const u = daylight.uniforms;
  for (const name of Object.keys(u)) if (/^u(?:Surface|Block)LightBank\d+$/.test(name)) u[name].value = dummy;
  u.uSkyCeilings.value = texture(sky, 64, 64, THREE.RedFormat, THREE.FloatType);
  u.uSurfaceLightPages.value = texture(surface, 36, 25, THREE.RedIntegerFormat, THREE.UnsignedShortType);
  u.uBlockLightPages.value = texture(block, 16, 24, THREE.RedIntegerFormat, THREE.UnsignedShortType);
  u.uBlockLightPalette.value = texture(palette, 256, 1, THREE.RGBAFormat, THREE.FloatType);
  u.uSkyField.value.set(-64, -32, 64);
  u.uSurfaceField.value.set(-64, 384, 4);
  u.uSurfaceOrigin.value.set(-4, -2);
  u.uBlockLightField.value.set(-64, 384, 4);
  u.uBlockLightOrigin.value.set(-4, -2);
  u.uDaylightEnabled.value = u.uDaylightFogEnabled.value = u.uBlockLightEnabled.value = 1;
  u.uDaylightKey.value.set(1.5, 1.1, 0.8);
  u.uDaylightSky.value.set(0.6, 0.8, 1);
  u.uDaylightGround.value.set(0.3, 0.2, 0.15);
  u.uCaveSky.value.set(0.07, 0.08, 0.09);
  u.uCaveGround.value.set(0.02, 0.03, 0.04);
  u.uCaveFog.value.set(0.015, 0.025, 0.04);
  for (const material of materials) daylight.install(material);
  return {
    uniforms: u,
    bytes: owned.reduce((n, t) => n + t.image.data.byteLength, 0),
    restoreGPU() {
      for (const t of owned) { t.dispose(); t.needsUpdate = true; }
    },
    dispose() {
      daylight.dispose();
      columns.dispose();
      for (const t of owned) t.dispose();
    },
  };
}
