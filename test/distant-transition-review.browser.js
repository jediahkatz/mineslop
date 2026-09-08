import * as THREE from "three";
import { DistantDetailMask } from "../src/distant-detail-mask.js";
import {
  publishReviewSurface, REVIEW_OPTIONS, REVIEW_POSITION, syntheticReviewTerrain,
} from "./distant-transition-review-fixtures.js";

function face(scene, material, vertices, normal) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(Array(4).fill(normal).flat(), 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  scene.add(new THREE.Mesh(geometry, material));
  return geometry;
}

function readPixels(renderer, size) {
  const gl = renderer.getContext(), pixels = new Uint8Array(size * size * 4);
  gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let background = 0, green = 0;
  for (let at = 0; at < pixels.length; at += 4) {
    if (pixels[at] === 255 && pixels[at + 1] === 0 && pixels[at + 2] === 255) background++;
    if (pixels[at] === 0 && pixels[at + 1] === 255 && pixels[at + 2] === 0) green++;
  }
  const center = (Math.floor(size / 2) * size + Math.floor(size / 2)) * 4;
  return {
    background, colored: size * size - background, green,
    center: [...pixels.subarray(center, center + 4)], glError: gl.getError(),
  };
}

export function runReviewBoundaryGPU() {
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setSize(64, 64);
  renderer.setClearColor(0xff00ff, 1);
  const rows = [];
  try {
    for (const mode of ["coarse", "refined-control", "sealed-control"]) {
      const scene = new THREE.Scene();
      scene.add(new THREE.AmbientLight(0xffffff, 2));
      const lod = syntheticReviewTerrain((x, z) => z % 16 === 0 ? 63 : 31, {
        scene, refined: mode === "refined-control",
      });
      const material = new THREE.MeshLambertMaterial({ color: 0x83ac52 });
      const geometries = [];
      try {
        publishReviewSurface(lod);
        lod.update(REVIEW_POSITION, {
          ...REVIEW_OPTIONS, budgetMs: 0, coverage: new Set(["0,0"]),
        });
        // Independent analytic native cap for chunk 0,0: row z=0 is Y64,
        // rows z=1..15 are Y32. It does not borrow LOD anchors or triangles.
        geometries.push(face(scene, material,
          [0, 64, 0, 0, 64, 1, 16, 64, 1, 16, 64, 0], [0, 1, 0]));
        geometries.push(face(scene, material,
          [0, 32, 1, 0, 32, 16, 16, 32, 16, 16, 32, 1], [0, 1, 0]));
        geometries.push(face(scene, material,
          [0, 32, 1, 16, 32, 1, 16, 64, 1, 0, 64, 1], [0, 0, 1]));
        if (mode === "sealed-control") {
          // Positive control: filling exactly the missing boundary must make
          // the witness visible, proving neither camera nor readback is blank.
          geometries.push(face(scene, material,
            [16, 32, 1, 16, 32, 16, 16, 64, 16, 16, 64, 1], [-1, 0, 0]));
        }
        const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
        camera.position.set(8, 48, 8);
        camera.lookAt(28, 32, 8.5);
        scene.updateMatrixWorld(true);
        const mesh = lod._active.terrain;
        const positions = mesh.geometry.attributes.position;
        const normals = mesh.geometry.attributes.normal;
        let sealingTriangles = 0;
        for (let i = 0; i < mesh.geometry.drawRange.count; i += 3) {
          const ids = [0, 1, 2].map((offset) => mesh.geometry.index.getX(i + offset));
          if (ids.every((id) => positions.getX(id) === 16) &&
              ids.some((id) => normals.getX(id) !== 0) &&
              Math.min(...ids.map((id) => positions.getZ(id))) < 8.5 &&
              Math.max(...ids.map((id) => positions.getZ(id))) > 8.5)
            sealingTriangles++;
        }
        const ray = new THREE.Raycaster(new THREE.Vector3(16.5, 90, 8.5), new THREE.Vector3(0, -1, 0));
        const eastTop = ray.intersectObject(mesh)[0]?.point.y ?? null;
        // No fog: isolate the seam rather than letting a background-colored
        // fade impersonate geometry. The witness is within 32 blocks, well
        // inside the candidate's 85%-of-192 outdoor clear band.
        renderer.render(scene, camera);
        rows.push({
          mode, bootstrap: lod._active.data.request.bootstrap,
          complete: lod.terrainCoverageComplete, fog: lod.fogDistance,
          nativeWestTop: 32, eastTop, sealingTriangles,
          ...readPixels(renderer, 64),
        });
      } finally {
        lod.dispose();
        geometries.forEach((geometry) => geometry.dispose());
        material.dispose();
      }
    }
  } finally { renderer.dispose(); }
  return rows;
}

export function runReviewMaskGPU() {
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setSize(32, 32);
  renderer.setClearColor(0xff00ff, 1);
  const rows = [];
  try {
    for (const x of [0, -16, 32768, 29999968, -29999984]) {
      const scene = new THREE.Scene();
      const material = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
      const mask = new DistantDetailMask();
      mask.install(material);
      const geometry = face(scene, material,
        [16, 0, 0, 16, 16, 0, 16, 16, 16, 16, 0, 16], [1, 0, 0]);
      scene.children[0].position.x = x;
      const camera = new THREE.OrthographicCamera(-8, 8, 8, -8, 0.1, 100);
      camera.position.set(x + 32, 8, 8);
      camera.lookAt(x + 16, 8, 8);
      const center = new THREE.Vector3(x + 8, 8, 8);
      const spec = { minY: 0, maxY: 96 };
      try {
        mask.update(center, spec, new Map());
        renderer.render(scene, camera);
        const unowned = readPixels(renderer, 32);
        mask.update(center, spec, new Map([[`${x / 16},0,0`, 1]]));
        renderer.render(scene, camera);
        const owned = readPixels(renderer, 32);
        rows.push({
          x, cpuOwns: mask.owns(new THREE.Vector3(x + 16, 8, 8), new THREE.Vector3(1, 0, 0)),
          unowned, owned,
        });
      } finally {
        mask.dispose();
        geometry.dispose();
        material.dispose();
      }
    }
  } finally { renderer.dispose(); }
  return rows;
}
