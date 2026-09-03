import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { Atmosphere } from "../src/atmosphere.js";
import { BLOCK } from "../src/blocks.js";
import { FLUID as F, BLOCK_STATE as S } from "../src/block-state.js";
import { sampleFluidAtPoint } from "../src/fluid-sampling.js";
import { controlFixture } from "./control-fixture.js";
import { shapeWorld } from "./shape-fixture.js";

/** Canvas is only a texture-construction stub; all fluid/Three state is real. */
function atmosphereFixture(t, world) {
  const previous = globalThis.document;
  globalThis.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        createRadialGradient: () => ({ addColorStop() {} }),
        fillRect() {},
      }),
    }),
  };
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog("#ffffff", 10, 60);
  const atmosphere = new Atmosphere(scene, world);
  const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 512);
  atmosphere.setBiome({
    dimension: "overworld",
    category: "forest",
    waterColor: "#326e92",
    fogColor: "#b4d1ce",
  });
  atmosphere.timeOfDay = 0.5;
  t.after(() => {
    atmosphere.dispose();
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
  return { atmosphere, scene, camera };
}

test("camera fog samples the real flow surface, not a WATER block ID or player position", (t) => {
  const world = shapeWorld([[0, 1, 0, BLOCK.WATER, 0, F.WATER_7]]);
  const f = atmosphereFixture(t, world);
  const feet = new THREE.Vector3(0.5, 1, 0.5);
  f.camera.position.set(0.5, 1.2, 0.5);
  assert.equal(world.get(0, 1, 0), BLOCK.WATER);
  f.atmosphere.update(0, 0, feet, f.camera);
  assert.equal(f.atmosphere.underwater, false);
  assert.ok(f.scene.fog.color.equals(new THREE.Color("#b4d1ce")));
  f.camera.position.y = 1.05;
  f.atmosphere.update(0, 0, feet, f.camera);
  assert.equal(f.atmosphere.underwater, true);
  assert.ok(f.scene.fog.color.equals(new THREE.Color("#326e92")));
  assert.deepEqual(
    f.atmosphere.cameraFluid,
    sampleFluidAtPoint(world, f.camera.position)
  );
  assert.equal(f.atmosphere.sun.visible, false);
  assert.equal(f.atmosphere.clouds.visible, false);
  assert.equal(f.atmosphere.stars.material.opacity, 0);
  assert.deepEqual(
    [f.scene.fog.near, f.scene.fog.far],
    [10, 60],
    "Renderer keeps ownership of distances and terrain coverage"
  );
});

test("waterlogged cavities tint the render camera but their solid volume and air do not", (t) => {
  const world = shapeWorld([[0, 1, 0, BLOCK.OAK_SLAB, S.TOP, F.WATER_SOURCE]]);
  const f = atmosphereFixture(t, world);
  f.camera.position.set(0.5, 1.25, 0.5);
  f.atmosphere.update(0, 0, new THREE.Vector3(20, 1, 20), f.camera);
  assert.equal(f.atmosphere.underwater, true);
  assert.equal(f.atmosphere.cameraFluid.kind, "water");
  f.camera.position.y = 1.75;
  f.atmosphere.update(0, 0, f.camera.position, f.camera);
  assert.equal(f.atmosphere.underwater, false);
  assert.equal(f.atmosphere.cameraFluid.fluid, F.NONE);
  assert.ok(f.scene.fog.color.equals(new THREE.Color("#b4d1ce")));
  assert.equal(f.atmosphere.sun.visible, true);
});

test("F5 visual medium is independent of the unbobbed eye's breathing/bubble projection", (t) => {
  const world = shapeWorld([[0, 1, 0, BLOCK.WATER, 0, F.BUBBLE_UP]]);
  const f = atmosphereFixture(t, world);
  const input = controlFixture(t);
  input.player.world = world;
  input.player.setPosition({ x: 0.5, y: 0, z: 0.5 });
  f.atmosphere.update(0, 0, input.player.position, input.camera);
  assert.equal(f.atmosphere.underwater, true);
  assert.equal(input.player.gameplayEnvironment().restoreAir, true);
  for (const perspective of ["back", "front"]) {
    input.player.perspective = perspective;
    f.atmosphere.update(0, 0, input.player.position, input.camera);
    assert.equal(f.atmosphere.underwater, false);
    assert.equal(input.player.gameplayEnvironment().underwater, true);
    assert.equal(input.player.gameplayEnvironment().restoreAir, true);
  }
});

test("inspection does not erase fluid volumes and dry frames restore sky/biome fog after water or lava", (t) => {
  const world = shapeWorld([
    [0, 1, 0, BLOCK.WATER],
    [1, 1, 0, BLOCK.LAVA],
  ]);
  const f = atmosphereFixture(t, world);
  f.atmosphere.fullbrightInspection = true;
  for (const [x, kind, color] of [
    [0.5, "water", "#326e92"],
    [1.5, "lava", "#d66629"],
  ]) {
    f.camera.position.set(x, 1.4, 0.5);
    f.atmosphere.update(0, 0, f.camera.position, f.camera);
    assert.equal(f.atmosphere.cameraFluid.kind, kind);
    assert.equal(f.atmosphere.inLava, kind === "lava");
    assert.ok(f.scene.fog.color.equals(new THREE.Color(color)));
    assert.ok(
      f.atmosphere.sky.material.uniforms.horizon.value.equals(f.scene.fog.color)
    );
    assert.equal(f.atmosphere.clouds.visible, false);
    assert.equal(f.atmosphere.inspectionLight.intensity, Math.PI);
  }
  f.camera.position.x = 4;
  f.atmosphere.update(0, 0, f.camera.position, f.camera);
  assert.equal(f.atmosphere.cameraFluid.kind, "none");
  assert.equal(f.atmosphere.underwater, false);
  assert.equal(f.atmosphere.inLava, false);
  assert.equal(f.atmosphere.clouds.visible, true);
  assert.equal(f.atmosphere.sun.visible, true);
  assert.ok(f.scene.fog.color.equals(new THREE.Color("#b4d1ce")));
});

test("unknown camera columns stay explicitly unknown and do not reveal celestial art or query a generator", (t) => {
  let loaded = false;
  const world = shapeWorld([[0, 1, 0, BLOCK.WATER]], { loaded: () => loaded });
  world.getSpawn = world.generate = () =>
    assert.fail("camera sample must not request terrain");
  const f = atmosphereFixture(t, world);
  f.camera.position.set(0.5, 1.4, 0.5);
  f.atmosphere.update(0, 0, f.camera.position, f.camera);
  assert.equal(f.atmosphere.cameraMediumKnown, false);
  assert.equal(f.atmosphere.cameraFluid.canBreathe, false);
  assert.equal(f.atmosphere.underwater, false);
  assert.equal(f.atmosphere.sun.visible, false);
  loaded = true;
  f.atmosphere.update(0, 0, f.camera.position, f.camera);
  assert.equal(f.atmosphere.cameraMediumKnown, true);
  assert.equal(f.atmosphere.underwater, true);
});

test("camera membership uses world-space camera coordinates and reuses bounded sample storage across world replacement", (t) => {
  const world = shapeWorld([[0, 1, 0, BLOCK.WATER]]);
  const f = atmosphereFixture(t, world);
  const rig = new THREE.Group();
  rig.position.set(10, 0, 0);
  rig.add(f.camera);
  f.camera.position.set(-9.5, 1.4, 0.5);
  let reads = 0;
  const get = world.getCell.bind(world);
  world.getCell = (...args) => {
    reads++;
    return get(...args);
  };
  const sample = f.atmosphere.sampleCameraFluid(f.camera);
  const current = sample.current;
  assert.equal(f.atmosphere.underwater, true);
  assert.equal(sample.sampledCells, 1);
  assert.ok(
    reads <= 256,
    "one authored point has bounded volume/current reads"
  );
  assert.equal(f.atmosphere.sampleCameraFluid(f.camera), sample);
  f.atmosphere.world = shapeWorld();
  assert.equal(f.atmosphere.sampleCameraFluid(f.camera), sample);
  assert.equal(sample.current, current);
  assert.equal(sample.kind, "none");
  assert.equal(f.atmosphere.underwater, false);
});
