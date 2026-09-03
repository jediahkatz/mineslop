import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { Atmosphere } from "../src/atmosphere.js";
import { BLOCK, BLOCKS, isSolid } from "../src/blocks.js";
import { GameRenderer } from "../src/renderer.js";
import { createGenerator } from "../src/terrain.js";

test("a real v3 dripstone cave has no luminous decoration or source-free daytime light", (t) => {
  const generator = createGenerator("cedar-valley", "overworld", 3);
  const point = generator.locateBiome("dripstone_caves");
  assert.ok(point);
  const biome = generator.getBiome(point.x, point.z, point.y);
  assert.equal(biome.id, "dripstone_caves");
  assert.equal(biome.category, "cave");
  const minX = Math.floor(point.x) - 8;
  const minZ = Math.floor(point.z) - 8;
  const { blocks } = generator.generateRegion(minX, minZ, 16, 16);
  let air = 0;
  let rock = 0;
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      const wx = minX + x;
      const wz = minZ + z;
      const top = generator.terrainHeight(wx, wz);
      for (let y = 13; y <= top - 4; y++) {
        if (generator.getBiome(wx, wz, y).id !== "dripstone_caves") continue;
        const id = blocks[y * 256 + z * 16 + x];
        if (id === BLOCK.AIR) air++;
        if (isSolid(id)) rock++;
        assert.ok(!BLOCKS[id].emissive, `${wx},${y},${wz}`);
        assert.notEqual(id, BLOCK.CAVE_VINE);
        assert.notEqual(id, BLOCK.GLOW_BERRIES);
      }
    }
  }
  assert.ok(air > 0 && rock > 0, "inspect real cave air and rock, not void");

  const previous = globalThis.document;
  globalThis.document = {
    createElement: () => ({
      getContext: () => ({
        createRadialGradient: () => ({ addColorStop() {} }),
        fillRect() {},
      }),
    }),
  };
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog("#ffffff", 10, 60);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(point.x, point.y + 1.62, point.z);
  const atmosphere = new Atmosphere(scene);
  const renderer = Object.create(GameRenderer.prototype);
  Object.assign(renderer, {
    chunks: new Map(),
    lastLightTime: -Infinity,
    localLights: [
      new THREE.PointLight("#ffffff", 0),
      new THREE.PointLight("#ffffff", 0),
    ],
  });
  try {
    atmosphere.setBiome(biome);
    let elapsed = 0;
    for (const quality of ["low", "medium", "high"]) {
      renderer.quality = quality;
      for (const day of [0, 0.3, 0.5, 0.75]) {
        atmosphere.timeOfDay = day;
        atmosphere.update(0, ++elapsed, camera.position, camera);
        renderer.updateLocalLights(elapsed, camera.position);
        assert.equal(atmosphere.sunlight.intensity, 0);
        assert.ok(atmosphere.hemi.intensity <= 0.06);
        assert.equal(atmosphere.sun.visible, false);
        assert.equal(atmosphere.moon.visible, false);
        assert.ok(
          renderer.localLights.every((light) => light.intensity === 0),
          "without block emitters there is no automatic player light"
        );
      }
    }
    t.diagnostic(JSON.stringify({ seed: "cedar-valley", point, air, rock }));
  } finally {
    renderer.localLights.forEach((light) => light.dispose());
    atmosphere.dispose();
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});
