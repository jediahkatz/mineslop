import * as THREE from "three";
import { Atmosphere } from "../src/atmosphere.js";
import { BLOCK } from "../src/blocks.js";
import { DistantTerrain } from "../src/distant-terrain.js";
import { createChunkMaterials, GameRenderer } from "../src/renderer.js";
import { authoredColumns } from "./shape-fixture.js";

export function daylightTunnel(y = 8) {
  const world = authoredColumns([[-1, 0], [0, 0], [1, 0], [2, 0]]);
  for (let x = -8; x < 48; x++) {
    for (let z = 0; z <= 4; z++) {
      world.put(x, y - 1, z, BLOCK.STONE);
      if (x < 0) continue;
      world.put(x, y + 3, z, BLOCK.STONE);
      for (let h = y; h < y + 3; h++)
        if (z === 0 || z === 4) world.put(x, h, z, BLOCK.STONE);
    }
  }
  const surface = { id: "plains", category: "grassland", dimension: "overworld", fogColor: "#b4d1ce" };
  const cave = { id: "dripstone_caves", category: "cave", dimension: "overworld", fogColor: "#574d47" };
  world.getBiome = (_x, _z, height) => height === undefined ? surface : cave;
  return {
    world,
    surface,
    cave,
    position: (x) => new THREE.Vector3(x, y + 1.62, 2.5),
    close(closed = true) {
      for (let z = 1; z <= 3; z++)
        for (let h = y; h <= y + 3; h++)
          world.put(-1, h, z, closed ? BLOCK.STONE : BLOCK.AIR);
    },
  };
}

/** Real renderer, atmosphere and LOD logic; only canvas/WebGL output is omitted. */
export function daylightRenderer(t, world, feet, quality = "low") {
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
  scene.fog = new THREE.Fog("#ffffff", 10, 29);
  const atlas = { texture: new THREE.Texture(), emissiveTexture: new THREE.Texture(), uvFor: () => [0, 0, 1, 1] };
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 512);
  camera.position.set(feet.x, feet.y + 1.62, feet.z);
  const graphics = Object.assign(Object.create(GameRenderer.prototype), {
    world, scene, camera, atlas, quality: "medium", biome: null, viewCenter: null,
    dimension: world.dimension, chunkGenerator: world.generator, chunkEpoch: world.epoch,
    chunks: new Map(), waterTime: { value: 0 }, materials: createChunkMaterials(atlas),
    atmosphere: new Atmosphere(scene, world), distant: new DistantTerrain(scene, world),
    localLights: [new THREE.PointLight(), new THREE.PointLight()], lightStats: {},
    lastLightTime: -Infinity, shadowDirty: true, lastShadowTime: -Infinity,
    shadowPosition: new THREE.Vector3(), shadowSunDirection: new THREE.Vector3(),
    renderer: { shadowMap: {} }, resize() {},
  });
  graphics.localLights.forEach((light) => scene.add(light));
  graphics.setQuality(quality);
  graphics.setBiome(world.getBiome?.(Math.floor(feet.x), Math.floor(feet.z), feet.y));
  graphics.setTime(0.5);
  t.after(() => {
    graphics.distant.dispose();
    graphics.skyColumns?.dispose();
    for (const key of [...graphics.chunks.keys()]) graphics.removeChunk(key);
    for (const material of Object.values(graphics.materials)) material.dispose();
    for (const light of graphics.localLights) light.dispose();
    graphics.atmosphere.dispose();
    atlas.texture.dispose();
    atlas.emissiveTexture.dispose();
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
  return graphics;
}
