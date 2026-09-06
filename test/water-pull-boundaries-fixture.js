// Controlled shader inputs, not native lighting publication/readiness evidence.
import * as THREE from "three";
import { SkyColumns } from "../src/sky-columns.js";
import { DaylightMaterial } from "../src/daylight-material.js";
import { BLOCK_PAGE_LAYOUT, SURFACE_PAGE_LAYOUT, LIGHT_PHYSICAL_HANDLE } from "../src/light-page-layout.js";

export const BANK_LAYOUTS = { Block: BLOCK_PAGE_LAYOUT, Surface: SURFACE_PAGE_LAYOUT };
export const bankHandle = (kind, bank) => {
  const l = BANK_LAYOUTS[kind];
  return LIGHT_PHYSICAL_HANDLE + bank * l.across * l.down * l.layers;
};
export const bankMarker = (kind, bank, y) =>
  kind === "Block" ? 20 + bank * 35 + (y >= 8 ? 20 : 0) : (y >= 8 ? 12 + bank * 4 : bank * 4);

export function bankPixels(kind, bank) {
  const l = BANK_LAYOUTS[kind], width = l.width * l.across, height = l.height * l.down;
  const data = new Uint8Array(width * height).fill(kind === "Block" ? 240 : 2);
  const cells = kind === "Block" ? 20 : 18;
  for (let y = 0; y < 16; y++)
    for (let z = 0; z < cells; z++)
      for (let x = 0; x < cells; x++) {
        const index = y * cells * cells + z * cells + x;
        data[Math.floor(index / l.width) * width + index % l.width] = bankMarker(kind, bank, y);
      }
  return { data, width, height };
}

export function boundaryGeometry({ edge = false, addressMode = null } = {}) {
  const bases = addressMode === "high" ? [32766, 32853] : addressMode === "compact" ? [0, 4] : [0];
  const count = bases.at(-1) + 4, g = new THREE.BufferGeometry();
  const fields = { position: new Float32Array(count * 3), normal: new Float32Array(count * 3),
    uv: new Float32Array(count * 2), color: new Float32Array(count * 3) };
  const indices = [];
  bases.forEach((base, q) => {
    const cx = edge ? 15.5 : addressMode ? 7.4 + q * 1.2 : 8;
    const half = edge ? 0.3 : addressMode ? 0.4 : 1;
    const points = [[cx - half, 8, 7], [cx + half, 8, 7], [cx + half, 8, 9], [cx - half, 8, 9]];
    for (let v = 0; v < 4; v++) {
      fields.position.set(points[v], (base + v) * 3);
      fields.normal.set([0, 1, 0], (base + v) * 3);
      fields.uv.set([0.25, 0.25], (base + v) * 2);
      fields.color.set(addressMode ? (q ? [0.2, 0.9, 0.3] : [0.9, 0.2, 0.1]) : [0.7, 0.8, 0.9], (base + v) * 3);
    }
    indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  });
  for (const [name, data] of Object.entries(fields))
    g.setAttribute(name, new THREE.BufferAttribute(data, name === "uv" ? 2 : 3));
  g.setIndex(new THREE.BufferAttribute(new Uint16Array(indices), 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

export function boundaryFixture(options = {}) {
  const scene = new THREE.Scene(), owned = [];
  scene.background = new THREE.Color("#10151d");
  const tex = (data, width, height, format, type) => {
    const t = new THREE.DataTexture(data, width, height, format, type);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    owned.push(t);
    return t;
  };
  const atlas = tex(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  const material = new THREE.MeshLambertMaterial({ map: atlas, vertexColors: true,
    transparent: true, opacity: 0.72, side: THREE.DoubleSide, depthWrite: false });
  const geometry = boundaryGeometry(options), mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);
  const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 0.1);
  const sun = new THREE.DirectionalLight(0xffffff, 0.4);
  sun.position.set(8, 16, 8);
  sun.target.position.set(8, 8, 8);
  scene.add(hemi, sun, sun.target);
  const columns = new SkyColumns(1), daylight = new DaylightMaterial(columns, scene), u = daylight.uniforms;
  const sky = tex(new Float32Array(48 * 48).fill(128), 48, 48, THREE.RedFormat, THREE.FloatType);
  const surface = tex(new Uint16Array(25 * 2).fill(1), 25, 2, THREE.RedIntegerFormat, THREE.UnsignedShortType);
  const block = tex(new Uint16Array(9), 9, 1, THREE.RedIntegerFormat, THREE.UnsignedShortType);
  const palette = new Float32Array(256 * 4);
  for (let i = 1; i < 256; i++) palette.set([i / 512, 0.015 + (i % 11) / 256, 0.01, 1], i * 4);
  u.uBlockLightPalette.value = tex(palette, 256, 1, THREE.RGBAFormat, THREE.FloatType);
  const banks = {};
  for (const kind of ["Block", "Surface"]) {
    banks[kind] = [];
    for (let bank = 0; bank < BANK_LAYOUTS[kind].banks; bank++) {
      const { data, width, height } = bankPixels(kind, bank);
      // Full shader-coordinate width/height, but only the sampled layer 0.
      const t = new THREE.DataArrayTexture(data, width, height, 1);
      t.format = THREE.RedFormat;
      t.minFilter = t.magFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      t.needsUpdate = true;
      owned.push(t);
      banks[kind].push(t);
      u[`u${kind}LightBank${bank}`].value = t;
    }
  }
  u.uSkyCeilings.value = sky;
  u.uSurfaceLightPages.value = surface;
  u.uBlockLightPages.value = block;
  u.uSkyField.value.set(-16, -16, 48);
  u.uSurfaceField.value.set(0, 16, 3);
  u.uSurfaceOrigin.value.set(-1, -1);
  u.uBlockLightField.value.set(0, 16, 3);
  u.uBlockLightOrigin.value.set(-1, -1);
  u.uBlockLightGain.value = 1;
  u.uDaylightKey.value.setRGB(0.5, 0.4, 0.3);
  u.uDaylightSky.value.setRGB(0.5, 0.6, 0.7);
  u.uDaylightGround.value.setRGB(0.4, 0.3, 0.2);
  u.uCaveSky.value.setRGB(0.005, 0.005, 0.005);
  u.uCaveGround.value.setRGB(0.005, 0.005, 0.005);
  u.uCaveFog.value.setRGB(0.015, 0.025, 0.035);
  daylight.install(material);
  const cx = options.edge ? 15.5 : 8;
  const camera = new THREE.OrthographicCamera(-1.4, 1.4, 1.4, -1.4, 0.1, 32);
  const aim = back => {
    camera.up.set(0, 0, -1);
    camera.position.set(cx, back ? 4 : 12, 8);
    camera.lookAt(cx, 8, 8);
    camera.updateMatrixWorld(true);
  };
  const reset = kind => {
    block.image.data.fill(0);
    surface.image.data.fill(1);
    sky.image.data.fill(128);
    u.uBlockLightEnabled.value = Number(kind === "Block");
    u.uDaylightEnabled.value = Number(kind === "Surface");
    u.uDaylightFogEnabled.value = 0;
    scene.fog = null;
    dirty();
  };
  const dirty = () => { for (const t of [sky, surface, block]) t.needsUpdate = true; };
  aim(false);
  reset("Block");
  return { scene, material, geometry, mesh, camera, u, sky, surface, block, banks, aim, reset, dirty,
    controlledTextureBytes: owned.reduce((n, t) => n + t.image.data.byteLength, 0),
    dispose() {
      geometry.dispose(); material.dispose(); daylight.dispose(); columns.dispose();
      for (const t of owned) t.dispose();
    } };
}
