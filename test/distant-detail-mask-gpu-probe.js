import * as THREE from "three";
import { DistantDetailMask } from "../src/distant-detail-mask.js";

// Real material shader and readback. Empty ownership must draw every pixel;
// matching ownership must discard every pixel, independently for each batch.
export function runDistantMaskGPU() {
  const size = 32, scene = new THREE.Scene(), mask = new DistantDetailMask();
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  mask.install(material);
  const geometry = new THREE.PlaneGeometry(16, 16);
  const batchAttribute = new THREE.Float32BufferAttribute(new Float32Array(4), 1);
  geometry.setAttribute("lodDetailBatch", batchAttribute);
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);
  const camera = new THREE.OrthographicCamera(-8, 8, 8, -8, 0.1, 32);
  const spec = { minY: -64, maxY: 320 };
  let renderer, target;
  const replaceContext = () => {
    target?.dispose();
    renderer?.dispose();
    renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
    renderer.setSize(size, size);
    renderer.setPixelRatio(1);
    renderer.setClearColor(0, 0);
    target = new THREE.WebGLRenderTarget(size, size);
  };
  const countPixels = () => {
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    const pixels = new Uint8Array(size * size * 4);
    renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
    renderer.setRenderTarget(null);
    let count = 0;
    for (let i = 3; i < pixels.length; i += 4) count += pixels[i] !== 0;
    return count;
  };
  const results = [];
  try {
    replaceContext();
    for (const origin of [0, 32768, 29999968, -29999984]) {
      for (const axis of ["x", "y", "z"]) for (const side of [-1, 1]) {
        const normal = new THREE.Vector3();
        normal[axis] = side;
        const center = new THREE.Vector3(origin + 8, 8, origin + 8);
        const point = center.clone().addScaledVector(normal, 8);
        mesh.position.copy(point);
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
        camera.position.copy(point).addScaledVector(normal, 8);
        camera.up.set(0, axis === "y" ? 0 : 1, axis === "y" ? 1 : 0);
        camera.lookAt(point);
        camera.updateMatrixWorld(true);
        const key = `${origin / 16},${origin / 16},0`;
        for (let batch = 0; batch < 4; batch++) {
          batchAttribute.array.fill(batch);
          batchAttribute.needsUpdate = true;
          const sections = new Map([[key, 1 << batch]]);
          mask.update(center, spec, new Map());
          const unowned = countPixels();
          mask.update(center, spec, sections);
          const owned = countPixels();
          const cpuOwned = mask.owns(point, normal, batch);
          mask.update(center.clone().add(new THREE.Vector3(48, 0, -48)), spec, sections);
          const moved = countPixels();
          mask.update(center, spec, sections);
          const reversed = countPixels();
          mask.update(center, spec, new Map([[key, 1 << ((batch + 1) % 4)]]));
          const otherBatch = countPixels();
          results.push({ origin, axis, side, batch, unowned, owned, cpuOwned,
            moved, reversed, otherBatch });
        }
      }
    }
    // A replacement WebGL context must re-upload the retained CPU mask.
    const center = new THREE.Vector3(29999976, 8, 29999976);
    mesh.position.set(29999984, 8, 29999976);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0));
    camera.position.set(29999992, 8, 29999976);
    camera.up.set(0, 1, 0);
    camera.lookAt(mesh.position);
    batchAttribute.array.fill(0); batchAttribute.needsUpdate = true;
    mask.update(center, spec, new Map([["1874998,1874998,0", 1]]));
    replaceContext();
    const replacementOwned = countPixels();
    mask.update(center, spec, new Map());
    const replacementUnowned = countPixels();
    return { results, replacementOwned, replacementUnowned };
  } finally {
    target?.dispose(); renderer?.dispose(); geometry.dispose(); material.dispose(); mask.dispose();
  }
}
