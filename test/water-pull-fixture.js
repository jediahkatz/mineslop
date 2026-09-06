import * as THREE from "three";
import { createChunkMaterials } from "../src/renderer.js";

// Exact production ripple expression, deliberately test-owned. The GPU test
// hashes renderer.js alongside this fixture to record its reference revision.
export function installTestWaterRipple(material, time) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWaterTime = time;
    shader.vertexShader = `varying vec3 vWaterPosition;\n${shader.vertexShader}`.replace(
      "#include <begin_vertex>", "#include <begin_vertex>\nvWaterPosition = position;");
    shader.fragmentShader = `uniform float uWaterTime;\nvarying vec3 vWaterPosition;\n${shader.fragmentShader}`.replace(
      "#include <color_fragment>", `#include <color_fragment>
      float ripple = sin(vWaterPosition.x * 1.963495 + uWaterTime * 0.8)
        * sin(vWaterPosition.z * 2.356194 - uWaterTime * 0.65);
      diffuseColor.rgb *= 0.99 + ripple * 0.055;`);
  };
  material.customProgramCacheKey = () => "test-production-water-high";
}

export function waterTestMaterials() {
  const pixels = new Uint8Array([
    50, 130, 180, 255, 70, 150, 200, 220,
    40, 120, 160, 240, 80, 170, 210, 255,
  ]);
  const texture = new THREE.DataTexture(pixels, 2, 2, THREE.RGBAFormat);
  texture.needsUpdate = true;
  texture.magFilter = texture.minFilter = THREE.NearestFilter;
  const materials = createChunkMaterials({ texture, emissiveTexture: texture });
  const time = { value: 0 };
  installTestWaterRipple(materials.water, time);
  return { materials, texture, time };
}

export function colorGeometry(geometry) {
  geometry.clearGroups();
  const n = geometry.attributes.position.count;
  const color = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    color[i * 3] = i % 4 === 0 ? 1.125 : 0.75;
    color[i * 3 + 1] = 0.625 + (i % 3) * 0.125;
    color[i * 3 + 2] = 0.875;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(color, 3));
  return geometry;
}

export function authoredWaterScene() {
  const f = waterTestMaterials(), scene = new THREE.Scene(), water = [];
  for (let i = 0; i < 3; i++) {
    const geometry = colorGeometry(new THREE.BoxGeometry(4.5, 1.5 + i * 0.4, 4.5));
    geometry.rotateX(i * 0.18);
    geometry.rotateZ(i * -0.11);
    geometry.translate(3 + i * 1.1, 2 + i * 0.3, 3 + i * 0.8);
    if (i === 0) geometry.attributes.color.array.set([-0, -0.125, 4.125]);
    const mesh = new THREE.Mesh(geometry, f.materials.water);
    mesh.position.set(-32, 0, -16);
    mesh.renderOrder = 2;
    scene.add(mesh);
    water.push(mesh);
  }
  for (let i = 0; i < 2; i++) {
    const glass = new THREE.Mesh(colorGeometry(new THREE.BoxGeometry(1.4, 4, 1.4)), f.materials.glass);
    glass.position.set(-28 + i * 1.8, 2.3, -12 + i * 1.3);
    // Deliberately exercise depth/tie interleaving, not just production's
    // default glass=1/water=2 separate render-order buckets.
    glass.renderOrder = 2;
    scene.add(glass);
  }
  const floor = new THREE.Mesh(colorGeometry(new THREE.BoxGeometry(15, 0.2, 15)), f.materials.opaque);
  floor.position.set(-28, -0.5, -12);
  floor.castShadow = true;
  floor.receiveShadow = true;
  scene.add(floor);
  return { ...f, scene, water, target: [-28, 2.3, -12],
    views: [
      ["above", [-24, 10, -5]], ["below", [-25, 0.1, -7]],
      ["inside", [-28.3, 2.4, -12.2]], ["grazing", [-37, 3.2, -12]],
    ] };
}
