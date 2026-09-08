import * as THREE from "three";
import { DistantDetailMask } from "../src/distant-detail-mask.js";
import { NativeBoundaryProfile } from "../src/native-boundary-profile.js";
import { NativeTerrainSeams } from "../src/native-terrain-seams.js";
import { releaseLostContextResources } from "../src/context-resources.js";

function cap(y) {
  const geometry = new THREE.PlaneGeometry(16, 16);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(8, y, 8);
  return geometry;
}

export async function runNativeSeamTransitionsGPU() {
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setSize(32, 32);
  renderer.setClearColor(0xff00ff);
  document.body.append(renderer.domElement);
  const rows = [];
  globalThis.nativeSeamProgress = rows;
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  try {
    for (const origin of [0, -16, 32768, 29999968, -29999984]) {
      const scene = new THREE.Scene();
      scene.add(new THREE.AmbientLight(0xffffff, 2));
      const mask = new DistantDetailMask();
      const seams = new NativeTerrainSeams(scene, mask);
      const opaque = cap(32), water = cap(48), replacement = cap(56);
      const profile = new NativeBoundaryProfile([{ opaque, water }]);
      while (!profile.done) check(profile.step(128, Infinity) <= 128, "profile work exceeded limit");
      const nextProfile = new NativeBoundaryProfile([{ opaque: replacement }]);
      while (!nextProfile.done) nextProfile.step(128, Infinity);
      const texture = new THREE.DataTexture(new Float32Array(16).fill(64), 4, 4, THREE.RedFormat, THREE.FloatType);
      texture.needsUpdate = true;
      seams.setSurface({ originX: origin, originZ: 0, waterSurface: 64,
        bounds: { minX: origin - 16, maxX: origin + 48, minZ: -16, maxZ: 48 } }, texture);
      const key = `${origin / 16},0`;
      const camera = new THREE.OrthographicCamera(-8, 8, 8, -8, 0.1, 100);
      const spec = { minY: 0, maxY: 96 };
      const ownership = (bits, offset = 0, sy = 1) => mask.update(
        { x: origin + 8 + offset, z: 8 }, spec,
        new Map([[`${key},${sy}`, bits & 1], [`${key},2`, bits & 8]]));
      const capture = (label, batch = 0, y = 48) => {
        renderer.setClearColor(0xff00ff, 1);
        seams.layers.forEach((layer, index) => { layer.mesh.visible = index === batch; });
        camera.position.set(origin + 32, y, 8);
        camera.lookAt(origin + 16, y, 8);
        renderer.render(scene, camera);
        const gl = renderer.getContext(), pixels = new Uint8Array(32 * 32 * 4);
        gl.readPixels(0, 0, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        let visible = 0;
        for (let i = 0; i < pixels.length; i += 4)
          visible += !(pixels[i] === 255 && pixels[i + 1] === 0 && pixels[i + 2] === 255);
        const error = gl.getError();
        check(error === 0, `${origin} ${label}: GL error ${error}`);
        rows.push({ origin, label, visible });
        return visible;
      };
      try {
        seams.update(new Map([[key, [{ data: profile.data, bits: 9 }]]]));
        ownership(0);
        check(capture("unpublished") === 0, "unpublished CPU boundary drew");
        ownership(1);
        check(capture("opaque-only") === 1024, "opaque boundary has a hole");
        check(capture("water-unpublished", 1, 56) === 0, "opaque ownership leaked to water");
        ownership(8);
        check(capture("opaque-revoked") === 0, "water ownership leaked to opaque");
        check(capture("water-only", 1, 56) === 1024, "water boundary has a hole");
        ownership(9, 48);
        check(capture("moved") === 1024, "moving mask origin lost boundary");
        ownership(9);
        check(capture("reversed") === 1024, "reversing mask origin lost boundary");
        seams.update(new Map([[key, [{ data: nextProfile.data, bits: 1 }]]]));
        ownership(1, 0, 3);
        check(capture("replacement-removes-old-seam") === 0, "retired boundary still drew");
        seams.update(new Map([[key, [{ data: profile.data, bits: 9 }]]]));
        ownership(9);
        texture.image.data.fill(NaN); texture.needsUpdate = true;
        check(capture("unknown-neighbor") === 0, "unknown height invented a wall");
        texture.image.data.fill(64); texture.needsUpdate = true;
        check(capture("restored-height") === 1024, "height restoration failed");
        if (origin === 0) {
          const lost = new Promise(resolve => renderer.domElement.addEventListener("webglcontextlost",
            event => {
              event.preventDefault();
              releaseLostContextResources(renderer, scene);
              resolve();
            }, { once: true }));
          renderer.forceContextLoss();
          await lost;
          await new Promise(resolve => setTimeout(resolve, 100));
          const restored = new Promise(resolve => renderer.domElement.addEventListener("webglcontextrestored",
            resolve, { once: true }));
          renderer.forceContextRestore();
          await restored;
          check(capture("context-restored") === 1024, "context replacement lost seam or ownership");
        }
        seams.update(new Map());
        check(capture("native-removed") === 0, "removed native retained boundary");
      } finally {
        seams.dispose(); mask.dispose(); texture.dispose();
        opaque.dispose(); water.dispose(); replacement.dispose();
      }
    }
    return rows;
  } finally { renderer.dispose(); renderer.domElement.remove(); }
}
