import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { Atmosphere } from "../src/atmosphere.js";
import { getBiomeById } from "../src/biomes.js";
import { WORLD_HEIGHT } from "../src/terrain.js";
import { getWorldSpec } from "../src/world-spec.js";

function withAtmosphere(check, world) {
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
  camera.position.set(12000, 65, -9000);
  try {
    check(atmosphere, scene, camera);
  } finally {
    atmosphere.dispose();
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
}

test("biome atmosphere drives matching fog and sky at arbitrary world positions", () => {
  withAtmosphere((atmosphere, scene, camera) => {
    atmosphere.setBiome({
      dimension: "overworld",
      category: "forest",
      fogColor: "#b4d1ce",
      temperature: 0.6,
    });
    atmosphere.timeOfDay = 0.5;
    atmosphere.update(0, 0, camera.position, camera);
    assert.ok(scene.fog.color.equals(new THREE.Color("#b4d1ce")));
    assert.ok(
      scene.fog.color.equals(atmosphere.sky.material.uniforms.horizon.value)
    );
    assert.ok(atmosphere.sky.position.equals(camera.position));
    assert.equal(atmosphere.sun.visible, true);
    assert.equal(atmosphere.clouds.visible, true);
    assert.ok(Math.abs(atmosphere.clouds.position.x - camera.position.x) < 47);
    const matrix = new THREE.Matrix4();
    atmosphere.clouds.getMatrixAt(0, matrix);
    assert.ok(
      new THREE.Vector3().setFromMatrixPosition(matrix).y > WORLD_HEIGHT
    );
    assert.ok(camera.far > atmosphere.sky.geometry.parameters.radius);
  });
});

test("Nether and End atmosphere hides overworld celestial objects and uses dimension palettes", () => {
  withAtmosphere((atmosphere, scene, camera) => {
    atmosphere.setBiome({ dimension: "nether", fogColor: "#79323d" });
    atmosphere.update(0, 1, camera.position, camera);
    assert.equal(atmosphere.sun.visible, false);
    assert.equal(atmosphere.moon.visible, false);
    assert.equal(atmosphere.clouds.visible, false);
    assert.equal(atmosphere.stars.material.opacity, 0);
    assert.ok(scene.fog.color.equals(new THREE.Color("#79323d")));
    atmosphere.timeOfDay = 0.9;
    atmosphere.update(0, 2, camera.position, camera);
    assert.ok(
      scene.fog.color.equals(new THREE.Color("#79323d")),
      "Nether fog is not overwritten by the day clock"
    );
    atmosphere.setBiome({ dimension: "end", fogColor: "#292334" });
    atmosphere.update(0, 3, camera.position, camera);
    assert.ok(atmosphere.stars.material.opacity > 0);
    assert.ok(scene.fog.color.equals(new THREE.Color("#292334")));
  });
});

test("cloud altitude follows the world specification while sky centers follow signed and high flight", () => {
  const world = { generatorVersion: 3, dimension: "overworld" };
  withAtmosphere((atmosphere, _scene, camera) => {
    const matrix = new THREE.Matrix4();
    const local = new THREE.Vector3();
    for (const version of [3, 4]) {
      world.generatorVersion = version;
      const spec = getWorldSpec(version, "overworld");
      for (const y of [-40, 29_000_000.25]) {
        camera.position.y = y;
        atmosphere.update(0, 1, camera.position, camera);
        assert.ok(atmosphere.sky.position.equals(camera.position));
        for (let i = 0; i < atmosphere.clouds.count; i++) {
          atmosphere.clouds.getMatrixAt(i, matrix);
          local.setFromMatrixPosition(matrix);
          const altitude = local.y + atmosphere.clouds.position.y;
          assert.ok(altitude > spec.maxY && altitude < spec.maxY + 24);
        }
      }
    }
    world.dimension = "end";
    atmosphere.setBiome({ dimension: "end" });
    atmosphere.update(0, 1, camera.position, camera);
    assert.equal(atmosphere.clouds.visible, false);
  }, world);
});

test("low quality suppresses clouds while caves retain their local fog", () => {
  withAtmosphere((atmosphere, scene, camera) => {
    atmosphere.cloudsEnabled = false;
    atmosphere.update(0, 1, camera.position, camera);
    assert.equal(atmosphere.clouds.visible, false);
    atmosphere.cloudsEnabled = true;
    atmosphere.setBiome({
      dimension: "overworld",
      category: "cave",
      fogColor: "#15242c",
    });
    atmosphere.update(0, 2, camera.position, camera);
    assert.equal(atmosphere.clouds.visible, false);
    assert.equal(atmosphere.sun.visible, false);
    assert.ok(
      scene.fog.color.equals(new THREE.Color("#15242c").multiplyScalar(0.12))
    );
  });
});

test("underground darkness does not gain sunlight or bright ambient illumination from the day clock", () => {
  withAtmosphere((atmosphere, scene, camera) => {
    atmosphere.setBiome({
      dimension: "overworld",
      category: "cave",
      fogColor: "#2b453c",
    });
    for (const time of [0, 0.3, 0.5, 0.75]) {
      atmosphere.timeOfDay = time;
      atmosphere.update(0, time, camera.position, camera);
      assert.equal(atmosphere.sunlight.intensity, 0);
      assert.ok(
        atmosphere.hemi.intensity > 0 && atmosphere.hemi.intensity <= 0.06
      );
      assert.equal(atmosphere.sun.visible, false);
      assert.equal(atmosphere.moon.visible, false);
      assert.equal(atmosphere.clouds.visible, false);
      assert.ok(
        scene.fog.color.equals(new THREE.Color("#2b453c").multiplyScalar(0.12))
      );
    }
    atmosphere.setBiome({ dimension: "overworld", category: "forest" });
    atmosphere.timeOfDay = 0.5;
    atmosphere.update(0, 1, camera.position, camera);
    assert.ok(atmosphere.hemi.intensity > 1);
    assert.ok(atmosphere.sunlight.intensity > 1);
  });
});

function atmosphereSnapshot(atmosphere, scene) {
  const uniforms = atmosphere.sky.material.uniforms;
  return {
    fog: scene.fog.color.toArray(),
    fogRange: [scene.fog.near, scene.fog.far],
    sunlight: atmosphere.sunlight.intensity,
    sunlightColor: atmosphere.sunlight.color.toArray(),
    hemisphere: atmosphere.hemi.intensity,
    sky: [uniforms.zenith.value.toArray(), uniforms.horizon.value.toArray()],
    celestial: [
      atmosphere.sun.visible,
      atmosphere.moon.visible,
      atmosphere.clouds.visible,
      atmosphere.stars.material.opacity,
    ],
    time: atmosphere.timeOfDay,
    direction: atmosphere.sunDirection.toArray(),
    dimension: atmosphere.dimension,
  };
}

test("fullbright uses uniform white ambient light through day, night and biome changes", () => {
  withAtmosphere((atmosphere, scene, camera) => {
    assert.equal(atmosphere.fullbrightInspection, false);
    assert.equal(atmosphere.inspectionLight.intensity, 0);
    assert.equal(atmosphere.inspectionLight.isAmbientLight, true);
    assert.ok(
      atmosphere.inspectionLight.color.equals(new THREE.Color("white"))
    );
    for (const id of [
      "forest",
      "lush_caves",
      "dripstone_caves",
      "deep_dark",
      "sulfur_caves",
      "nether_wastes",
      "the_end",
    ]) {
      const biome = getBiomeById(id);
      atmosphere.setBiome(biome);
      let inspectionFog;
      for (const time of [0, 0.3, 0.5, 0.75]) {
        atmosphere.timeOfDay = time;
        atmosphere.fullbrightInspection = false;
        atmosphere.update(0, 10, camera.position, camera);
        const natural = atmosphereSnapshot(atmosphere, scene);
        atmosphere.fullbrightInspection = true;
        atmosphere.update(0, 10, camera.position, camera);
        const inspection = atmosphereSnapshot(atmosphere, scene);
        assert.equal(atmosphere.inspectionLight.intensity / Math.PI, 1, id);
        assert.equal(inspection.sunlight, 0, id);
        assert.equal(inspection.hemisphere, 0, id);
        assert.equal(inspection.time, time);
        if (biome.category === "cave")
          assert.deepEqual(inspection.sky, [inspection.fog, inspection.fog]);
        else assert.deepEqual(inspection.sky, natural.sky);
        assert.deepEqual(inspection.celestial, natural.celestial);
        assert.deepEqual(inspection.direction, natural.direction);
        assert.deepEqual(inspection.fogRange, natural.fogRange);
        assert.equal(inspection.dimension, natural.dimension);
        if (inspectionFog) assert.deepEqual(inspection.fog, inspectionFog);
        inspectionFog = inspection.fog;
        if (biome.category === "cave") {
          assert.ok(
            inspection.fog.every((channel, i) => channel > natural.fog[i] * 4),
            `${id}: inspection fog is not the near-black natural cave fog`
          );
        }
        atmosphere.fullbrightInspection = false;
        atmosphere.update(0, 10, camera.position, camera);
        assert.equal(atmosphere.inspectionLight.intensity, 0);
        assert.deepEqual(atmosphereSnapshot(atmosphere, scene), natural);
      }
    }
  });
});

test("disposal removes the inspection light along with the natural lights", () => {
  let light;
  let scene;
  withAtmosphere((atmosphere, atmosphereScene) => {
    scene = atmosphereScene;
    light = atmosphere.inspectionLight;
    assert.equal(light.parent, scene);
  });
  assert.equal(light.parent, null);
  assert.ok(scene.children.every((object) => !object.isLight));
});

test("the existing square sun stays readable inside a compact, faint halo", () => {
  withAtmosphere((atmosphere, scene, camera) => {
    assert.equal(atmosphere.sun.geometry.type, "PlaneGeometry");
    assert.equal(atmosphere.sun.geometry.parameters.width, 10);
    assert.equal(atmosphere.sun.geometry.parameters.height, 10);
    assert.equal(atmosphere.sunGlow.scale.x, 24);
    for (const time of [0.26, 0.3, 0.5, 0.74]) {
      atmosphere.timeOfDay = time;
      atmosphere.update(0, 0, camera.position, camera);
      assert.equal(atmosphere.sun.visible, true);
      assert.ok(atmosphere.sunGlow.material.opacity < 0.3);
      assert.ok(atmosphere.sunGlow.position.equals(atmosphere.sun.position));
      assert.ok(atmosphere.sun.quaternion.equals(camera.quaternion));
    }
    assert.equal(atmosphere.sun.material.toneMapped, false);
    assert.equal(
      scene.children.filter((object) => object.isLight).length,
      3,
      "sun/moon share one key, plus hemisphere and inspection lights"
    );
  });
});

test("glow canvas restoration reuses the texture without changing physical lighting", () => {
  let canvas;
  withAtmosphere((atmosphere, scene, camera) => {
    atmosphere.timeOfDay = 0.5;
    atmosphere.update(0, 0, camera.position, camera);
    const before = atmosphereSnapshot(atmosphere, scene);
    const texture = atmosphere.glowTexture;
    const version = texture.version;
    canvas = texture.image;
    for (let restored = 1; restored <= 2; restored++) {
      canvas.oncontextrestored();
      assert.equal(atmosphere.glowTexture, texture);
      assert.equal(texture.version, version + restored);
      assert.equal(texture.image, canvas);
      assert.equal(texture.colorSpace, THREE.SRGBColorSpace);
      assert.equal(texture.minFilter, THREE.LinearMipmapLinearFilter);
      assert.equal(texture.magFilter, THREE.LinearFilter);
      assert.deepEqual(atmosphereSnapshot(atmosphere, scene), before);
    }
  });
  assert.equal(canvas.oncontextrestored, null, "disposal detaches recovery");
});

test("moonlight comes from the visible moon and daylight uses a warm key with cooler fill", () => {
  withAtmosphere((atmosphere, _scene, camera) => {
    atmosphere.timeOfDay = 0.5;
    atmosphere.update(0, 0, camera.position, camera);
    const dayIntensity = atmosphere.sunlight.intensity;
    assert.ok(atmosphere.lightDirection.dot(atmosphere.sunDirection) > 0.999);
    assert.ok(atmosphere.sunlight.color.r > atmosphere.sunlight.color.b);
    assert.ok(atmosphere.hemi.color.b > atmosphere.hemi.color.r);
    atmosphere.timeOfDay = 0.72;
    atmosphere.update(0, 0, camera.position, camera);
    assert.ok(
      atmosphere.sunlight.color.r / atmosphere.sunlight.color.b >
        atmosphere.daySun.r / atmosphere.daySun.b,
      "dusk warms the material key instead of only the sky"
    );
    atmosphere.timeOfDay = 0;
    atmosphere.update(0, 0, camera.position, camera);
    assert.equal(atmosphere.moon.visible, true);
    assert.equal(atmosphere.sun.visible, false);
    assert.ok(atmosphere.lightDirection.dot(atmosphere.sunDirection) < -0.999);
    assert.ok(
      atmosphere.sunlight.position.y > atmosphere.sunlight.target.position.y
    );
    assert.ok(atmosphere.sunlight.color.b > atmosphere.sunlight.color.r);
    assert.ok(
      atmosphere.sunlight.intensity > 0 &&
        atmosphere.sunlight.intensity < dayIntensity * 0.2
    );
  });
});

test("Nether and End keep continuous dimension lighting across the outdoor sun/moon handoff", () => {
  withAtmosphere((atmosphere, _scene, camera) => {
    for (const dimension of ["nether", "end"]) {
      atmosphere.setBiome({ dimension });
      atmosphere.timeOfDay = 0.25 - 0.00001;
      atmosphere.update(0, 0, camera.position, camera);
      const before = atmosphere.lightDirection.clone();
      const color = atmosphere.sunlight.color.clone();
      const intensity = atmosphere.sunlight.intensity;
      atmosphere.timeOfDay = 0.25 + 0.00001;
      atmosphere.update(0, 0, camera.position, camera);
      assert.ok(atmosphere.lightDirection.distanceTo(before) < 0.001);
      assert.ok(atmosphere.sunlight.color.equals(color));
      assert.equal(atmosphere.sunlight.intensity, intensity);
    }
  });
});

test("celestial art renders before terrain even when the horizon passes its fixed sky distance", () => {
  withAtmosphere((atmosphere, _scene, camera) => {
    camera.far = 1024;
    atmosphere.update(0, 0, camera.position, camera);
    for (const object of [
      atmosphere.stars,
      atmosphere.sunGlow,
      atmosphere.sun,
      atmosphere.moon,
    ]) {
      assert.equal(object.material.transparent, false, object.type);
      assert.equal(object.material.depthWrite, false, object.type);
      assert.equal(object.material.depthTest, false, object.type);
      assert.ok(object.renderOrder > atmosphere.sky.renderOrder);
      assert.ok(object.renderOrder < 0, "opaque terrain renders afterwards");
    }
    assert.equal(
      atmosphere.sunGlow.material.blending,
      THREE.AdditiveBlending,
      "halo opacity still blends inside the early opaque queue"
    );
    assert.equal(atmosphere.stars.material.blending, THREE.AdditiveBlending);
    assert.ok(atmosphere.sunGlow.renderOrder < atmosphere.sun.renderOrder);
  });
});
