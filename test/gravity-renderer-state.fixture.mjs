import assert from "node:assert/strict";
import * as THREE from "three";
import { Atmosphere } from "../src/atmosphere.js";
import { DistantTerrain } from "../src/distant-terrain.js";
import { createChunkMaterials } from "../src/renderer.js";
import { LOCAL_LIGHT_LIMITS } from "../src/local-lighting.js";
import { RealGameRenderer } from "./gravity-game-runtime.fixture.mjs";

/**
 * Actual GameRenderer prototype and actual World/mesher/Atmosphere/Daylight/LOD
 * owners. Constructor-only DOM canvas/art assets and WebGL submission are
 * transports; no update/rebuild/visibility/coverage/lighting method is replaced.
 * Reuse Game's scene and Player's camera so live owner identity stays intact.
 */
export function installRealRendererState(f) {
  const { game, doc } = f;
  doc.createElement = () => ({
    getContext: () => ({
      createRadialGradient: () => ({ addColorStop() {} }), fillRect() {},
    }),
  });
  const { scene, camera } = game.graphics;
  const world = game.world;
  scene.fog = new THREE.Fog("#d6e1cf", 10, 45);
  const atlas = {
    texture: new THREE.Texture(), emissiveTexture: new THREE.Texture(),
    uvFor: () => [0, 0, 1, 1],
  };
  const box = new THREE.BoxGeometry();
  const target = new THREE.LineSegments(new THREE.EdgesGeometry(box),
    new THREE.LineBasicMaterial());
  const miningOverlay = new THREE.Mesh(box.clone(), new THREE.MeshBasicMaterial());
  box.dispose();
  scene.add(target, miningOverlay);
  let submissions = 0, drawState = null;
  const graphics = Object.assign(Object.create(RealGameRenderer.prototype), {
    world, scene, camera, atlas, materials: createChunkMaterials(atlas),
    chunks: new Map(), viewCenter: null, quality: "low",
    dimension: world.dimension, chunkGenerator: world.generator, chunkEpoch: world.epoch,
    waterTime: { value: 0 }, atmosphere: new Atmosphere(scene, world),
    distant: new DistantTerrain(scene, world),
    localLights: Array.from({ length: LOCAL_LIGHT_LIMITS.maxSources }, () => {
      const light = new THREE.PointLight("#ffce7e", 0, 9, 1.5);
      scene.add(light);
      return light;
    }),
    lightStats: {}, lastLightTime: -Infinity, shadowDirty: true,
    shadowPosition: new THREE.Vector3(), shadowSunDirection: new THREE.Vector3(),
    lastShadowTime: -Infinity, target, miningOverlay,
    miningTextures: Array.from({ length: 10 }, () => new THREE.Texture()),
    renderer: {
      shadowMap: {},
      render() {
        scene.updateMatrixWorld(true);
        camera.updateMatrixWorld(true);
        // Snapshot at actual GameRenderer.render submission, not just after
        // Game.frame returns: no later CPU update can mask a stale draw.
        drawState = {
          coverageKey: [...graphics.detailCoverage()].sort().join(";"),
          cutoutKey: graphics.distant._active?.viewKey,
          field: {
            data: graphics.skyColumns.data.slice(),
            origin: graphics.skyColumns.origin.clone(), size: graphics.skyColumns.size,
          },
        };
        submissions++;
      },
      dispose() {},
      domElement: { removeEventListener() {}, remove() {} },
    },
  });
  assert.equal(graphics.update, RealGameRenderer.prototype.update);
  assert.equal(graphics.rebuildDirty, RealGameRenderer.prototype.rebuildDirty);
  graphics.setBiome(world.getBiome(camera.position.x, camera.position.z));
  graphics.setTime(game.currentTime);
  game.graphics = graphics;
  return {
    graphics,
    get submissions() { return submissions; },
    get drawState() { return drawState; },
    warm() {
      graphics.rebuildDirty(Infinity);
      for (let i = 0; i < 500; i++) {
        graphics.update(0, game.elapsed, game.player.position);
        if (graphics.distant.ready && !graphics.distant._job) {
          scene.updateMatrixWorld(true);
          camera.updateMatrixWorld(true);
          return;
        }
      }
      assert.fail("bounded actual distant-terrain build must publish");
    },
    roofTextureAt(x, z, field = graphics.skyColumns) {
      return field.data[(z - field.origin.y) * field.size + x - field.origin.x];
    },
    groundHits(x, z, distant = false) {
      scene.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
      const ray = new THREE.Raycaster(new THREE.Vector3(x, world.maxY + 1, z),
        new THREE.Vector3(0, -1, 0));
      return distant
        ? ray.intersectObject(graphics.distant._active.terrain, false)
        : ray.intersectObject(graphics.chunks.get(`${Math.floor(x / 16)},${Math.floor(z / 16)}`), true);
    },
  };
}
