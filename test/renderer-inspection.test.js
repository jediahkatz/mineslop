import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { Atmosphere } from "../src/atmosphere.js";
import { getBiomeById } from "../src/biomes.js";
import { BLOCK } from "../src/blocks.js";
import { GameRenderer, QUALITY } from "../src/renderer.js";
import { attachRendererLight, rendererLightWorld, settleRendererLight } from "./renderer-block-light-fixture.js";

const receiver = { x: 2.5, y: 14.02, z: 2.5 };

function fixture(t, quality = "low", biome = "dripstone_caves") {
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
  scene.fog = new THREE.Fog("#ffffff", 8, 29);
  const group = new THREE.Group();
  group.userData.emitters = [
    { id: BLOCK.TORCH, x: 3.5, y: 14.5, z: 2.5 },
    { id: BLOCK.GLOW_BERRIES, x: 4.5, y: 14.5, z: 1.5 },
  ];
  const water = new THREE.MeshLambertMaterial();
  const world = rendererLightWorld(t, [
    [1, 40, 1, BLOCK.STONE],
    [2, 13, 2, BLOCK.STONE],
    [3, 14, 2, BLOCK.TORCH],
    [4, 14, 1, BLOCK.GLOW_BERRIES],
  ]);
  const graphics = Object.assign(Object.create(GameRenderer.prototype), {
    scene,
    quality,
    world,
    camera: new THREE.PerspectiveCamera(),
    atmosphere: new Atmosphere(scene),
    renderer: { shadowMap: {} },
    localLights: [
      new THREE.PointLight("white", 0),
      new THREE.PointLight("white", 0),
    ],
    chunks: new Map([["0,0", group]]),
    materials: { water },
    waterTime: { value: 10 },
    shadowPosition: new THREE.Vector3(),
    shadowSunDirection: new THREE.Vector3(),
    lastShadowTime: -Infinity,
    resize() {},
  });
  graphics.camera.position.set(1, 14, 1);
  graphics.setQuality(quality);
  graphics.setBiome(getBiomeById(biome));
  graphics.setTime(0.5);
  attachRendererLight(t, graphics);
  settleRendererLight(graphics);
  world.dirtyChunks.clear();
  t.after(() => {
    graphics.atmosphere.dispose();
    for (const light of graphics.localLights) light.dispose();
    water.dispose();
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
  return { graphics, group };
}

function lights(graphics) {
  return {
    ambient: graphics.atmosphere.inspectionLight.intensity,
    sun: graphics.atmosphere.sunlight.intensity,
    hemi: graphics.atmosphere.hemi.intensity,
    fog: graphics.scene.fog.color.toArray(),
    shadowMap: graphics.renderer.shadowMap.enabled,
    castShadow: graphics.atmosphere.sunlight.castShadow,
    fieldEnabled: graphics.daylightMaterial.uniforms.uBlockLightEnabled.value,
    receiver: graphics.blockLight.sample(receiver),
    sources: graphics.localLights.map((light) => ({
      intensity: light.intensity,
      visible: light.visible,
      position: light.position.toArray(),
      color: light.color.toArray(),
    })),
  };
}

test("inspection toggles immediately without changing chunks, view distance, pose or time", (t) => {
  const { graphics, group } = fixture(t);
  const natural = lights(graphics);
  assert.equal(natural.fieldEnabled, 1);
  assert.ok(natural.receiver[0] > 0.7, "real stone receiver starts torch-lit");
  const fogRange = [graphics.scene.fog.near, graphics.scene.fog.far];
  const camera = graphics.camera.position.toArray();
  const direction = graphics.camera.quaternion.toArray();
  const radius = graphics.renderRadius;
  const emitters = structuredClone(group.userData.emitters);
  graphics.viewCenter = "retained-view-center";
  graphics.resize =
    graphics.rebuildDirty =
    graphics.syncVisibleChunks =
      () => assert.fail("lighting-only toggles must not rebuild or resize");
  assert.equal(graphics.setFullbrightInspection(true), true);
  assert.equal(graphics.atmosphere.inspectionLight.intensity / Math.PI, 1);
  assert.equal(graphics.atmosphere.sunlight.intensity, 0);
  assert.equal(graphics.atmosphere.hemi.intensity, 0);
  assert.equal(graphics.renderer.shadowMap.enabled, false);
  assert.equal(graphics.daylightMaterial.uniforms.uBlockLightEnabled.value, 0);
  assert.deepEqual(graphics.blockLight.sample(receiver), natural.receiver, "inspection suppresses shading, not the world field");
  assert.ok(
    graphics.localLights.every((light) => !light.visible && !light.intensity)
  );
  assert.equal(graphics.setFullbrightInspection(true), true);
  assert.equal(graphics.timeOfDay, 0.5);
  assert.deepEqual(graphics.camera.position.toArray(), camera);
  assert.deepEqual(graphics.camera.quaternion.toArray(), direction);
  assert.equal(graphics.renderRadius, radius);
  assert.deepEqual([graphics.scene.fog.near, graphics.scene.fog.far], fogRange);
  assert.equal(graphics.viewCenter, "retained-view-center");
  assert.equal(graphics.chunks.get("0,0"), group);
  assert.equal(graphics.world.dirtyChunks.size, 0);
  assert.deepEqual(group.userData.emitters, emitters);
  assert.equal(graphics.setFullbrightInspection(false), false);
  assert.deepEqual(
    lights(graphics),
    natural,
    "no subsequent frame is needed to restore"
  );
  assert.equal(graphics.atmosphere.sunlight.intensity, 0);
  assert.equal(graphics.atmosphere.hemi.intensity, 0.05);
  assert.ok(
    graphics.scene.fog.color.equals(
      new THREE.Color(getBiomeById("dripstone_caves").fogColor).multiplyScalar(
        0.12
      )
    )
  );
});

test("quality and biome switches retain fullbright, then restore the current budgets", (t) => {
  const { graphics } = fixture(t);
  graphics.setFullbrightInspection(true);
  for (const quality of ["high", "medium", "low"]) {
    graphics.setQuality(quality);
    for (const id of [
      "lush_caves",
      "deep_dark",
      "forest",
      "nether_wastes",
      "the_end",
    ]) {
      const biome = getBiomeById(id);
      graphics.world.setDimension(biome.dimension).generate(0);
      graphics.setBiome(biome);
      for (const time of [0, 0.5]) {
        graphics.setTime(time);
        settleRendererLight(graphics);
        assert.equal(graphics.fullbrightInspection, true);
        assert.equal(graphics.daylightMaterial.uniforms.uBlockLightEnabled.value, 0);
        assert.ok(graphics.blockLight.sample(receiver)[0] > 0.7, `${quality}/${id}: field remains populated during inspection`);
        assert.equal(
          graphics.atmosphere.inspectionLight.intensity / Math.PI,
          1
        );
        assert.equal(graphics.atmosphere.sunlight.intensity, 0);
        assert.equal(graphics.atmosphere.hemi.intensity, 0);
        assert.equal(graphics.renderer.shadowMap.enabled, false);
        assert.ok(
          graphics.localLights.every(
            (light) => !light.visible && !light.intensity
          )
        );
      }
      const currentField = graphics.blockLight.sample(receiver);
      graphics.setFullbrightInspection(false);
      assert.equal(
        graphics.renderer.shadowMap.enabled,
        quality === "high" &&
          biome.dimension === "overworld" &&
          biome.category !== "cave"
      );
      assert.equal(
        graphics.localLights.filter((light) => light.visible).length,
        QUALITY[quality].localLights
      );
      assert.ok(graphics.localLights.every((light) => light.intensity === 0), "static pool stays inert within its quality budget");
      assert.equal(graphics.daylightMaterial.uniforms.uBlockLightEnabled.value, 1);
      assert.equal(graphics.daylightMaterial.uniforms.uBlockLightAtlas.value, graphics.blockLight.texture);
      assert.equal(graphics.daylightMaterial.uniforms.uBlockLightValid.value, graphics.blockLight.validTexture);
      assert.deepEqual(graphics.blockLight.sample(receiver), currentField, "current natural field restores without a frame");
      assert.equal(graphics.atmosphere.inspectionLight.intensity, 0);
      if (biome.category === "cave") {
        assert.equal(graphics.atmosphere.sunlight.intensity, 0);
        assert.equal(graphics.atmosphere.hemi.intensity, 0.05);
      }
      graphics.setFullbrightInspection(true);
    }
  }
  graphics.setFullbrightInspection(false);
  assert.equal(graphics.quality, "low");
  assert.equal(
    graphics.daylightMaterial.uniforms.uBlockLightEnabled.value,
    1,
    "Performance keeps world-space torch illumination"
  );
  assert.ok(graphics.blockLight.sample(receiver)[0] > 0.7);
  assert.equal(graphics.localLights[1].visible, false);
});

test("placed light sources are read afresh when leaving inspection, not restored from stale state", (t) => {
  const { graphics, group } = fixture(t);
  graphics.setFullbrightInspection(true);
  assert.equal(graphics.world.set(3, 14, 2, BLOCK.AIR), true);
  assert.equal(graphics.world.set(4, 14, 1, BLOCK.AIR), true);
  // Intentionally retain stale mesh emitters until the next rebuild.
  settleRendererLight(graphics);
  graphics.setFullbrightInspection(false);
  assert.equal(graphics.daylightMaterial.uniforms.uBlockLightEnabled.value, 1);
  assert.deepEqual(graphics.blockLight.sample(receiver), [0, 0, 0], "removed sources stay dark despite stale mesh metadata");
  graphics.setFullbrightInspection(true);
  group.userData.emitters = [];
  assert.equal(graphics.world.set(2, 15, 1, BLOCK.TORCH), true);
  assert.equal(graphics.world.set(2, 14, 2, BLOCK.STONE), true);
  const placedReceiver = { x: 2.5, y: 15.02, z: 2.5 };
  settleRendererLight(graphics);
  const placed = graphics.blockLight.sample(placedReceiver);
  assert.ok(placed[0] > 0.7, "new torch reaches the neighboring stone face without mesh emitters");
  assert.ok(placed[0] > placed[1] && placed[1] > placed[2], "torch keeps its warm color");
  assert.equal(graphics.daylightMaterial.uniforms.uBlockLightEnabled.value, 0);
  graphics.setFullbrightInspection(false);
  assert.equal(graphics.daylightMaterial.uniforms.uBlockLightEnabled.value, 1);
  assert.deepEqual(graphics.blockLight.sample(placedReceiver), placed, "leaving inspection immediately uses current receiver data");
});

test("shadows restore for Beautiful outdoors, never underground or in cheaper quality", (t) => {
  const { graphics } = fixture(t, "high", "forest");
  graphics.updateShadows(10, graphics.camera.position);
  graphics.atmosphere.sunlight.shadow.needsUpdate = false;
  graphics.renderer.shadowMap.needsUpdate = false;
  graphics.setFullbrightInspection(true);
  assert.equal(graphics.atmosphere.sunlight.castShadow, false);
  graphics.setFullbrightInspection(false);
  assert.equal(graphics.atmosphere.sunlight.castShadow, true);
  assert.equal(graphics.renderer.shadowMap.enabled, true);
  assert.equal(graphics.renderer.shadowMap.needsUpdate, true);
  graphics.updateShadows(10.01, graphics.camera.position);
  assert.equal(
    graphics.lastShadowTime,
    10.01,
    "re-enabling is not held by the old throttle"
  );
  graphics.setFullbrightInspection(true);
  graphics.setBiome(getBiomeById("dripstone_caves"));
  graphics.setFullbrightInspection(false);
  assert.equal(graphics.renderer.shadowMap.enabled, false);
  graphics.setBiome(getBiomeById("forest"));
  assert.equal(graphics.renderer.shadowMap.enabled, true);
  graphics.setFullbrightInspection(true);
  graphics.setQuality("medium");
  graphics.setFullbrightInspection(false);
  assert.equal(graphics.renderer.shadowMap.enabled, false);
});

test("the bounded shadow refresh follows the active lunar key, not the below-horizon sun", (t) => {
  const { graphics } = fixture(t, "high", "forest");
  graphics.updateShadows(10, graphics.camera.position);
  graphics.setTime(0.9);
  graphics.updateShadows(11, graphics.camera.position);
  assert.ok(
    graphics.shadowSunDirection.equals(graphics.atmosphere.lightDirection)
  );
  assert.ok(
    graphics.shadowSunDirection.dot(graphics.atmosphere.sunDirection) < 0
  );
  graphics.shadowDirty = true;
  graphics.updateShadows(11.1, graphics.camera.position);
  assert.equal(
    graphics.lastShadowTime,
    11,
    "moonlight retains the refresh throttle"
  );
  graphics.setFullbrightInspection(true);
  graphics.updateShadows(20, graphics.camera.position);
  assert.equal(
    graphics.lastShadowTime,
    11,
    "inspection never updates shadow maps"
  );
});
