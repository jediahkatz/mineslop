import * as THREE from "three";
import { nativeGeometryFixture } from "./regional-native-fixture.js";
import { createSectionMeshJob } from "../src/section-mesh.js";
import { sectionYs } from "../src/mesh-snapshot.js";
import { sectionSourceGroup } from "../src/section-pages.js";
import { createChunkMaterials } from "../src/renderer.js";
import { createAtlas } from "../src/textures.js";
import { installTestWaterRipple } from "./water-pull-fixture.js";

export function nativeWaterScene() {
  const start = performance.now();
  const fixture = nativeGeometryFixture({ seed: "cedar-valley", version: 7, radius: 2, cx: -66, cz: 85 });
  const atlas = createAtlas(), materials = createChunkMaterials(atlas), time = { value: 0 };
  installTestWaterRipple(materials.water, time);
  const scene = new THREE.Scene(), water = [], terrain = [];
  for (let cz = 84; cz <= 87; cz++) for (let cx = -68; cx <= -65; cx++) {
    const column = new THREE.Group();
    column.position.set(cx * 16, 0, cz * 16);
    scene.add(column);
    for (const sy of sectionYs(fixture.world)) {
      if (performance.now() - start > 30000) throw new Error("Native water fixture exceeded 30s CPU bound");
      const job = createSectionMeshJob(fixture.world, cx, cz, sy, atlas, { typedScratch: true });
      job.step({ flush: true });
      if (job.status !== "ready") throw new Error(`Native section ${cx},${cz},${sy}: ${job.status}`);
      const group = sectionSourceGroup(job.takeResult(), materials);
      column.add(group);
      for (const mesh of group.children) {
        if (mesh.userData.batch === "water") water.push(mesh);
        else {
          // Keep complete native terrain for an additional occlusion control.
          // Main views isolate original native water (not coverage acceptance).
          mesh.layers.enable(0);
          mesh.visible = false;
          terrain.push(mesh);
        }
      }
      job.dispose();
    }
  }
  scene.updateMatrixWorld(true);
  const largest = water.reduce((a, b) =>
    a.geometry.attributes.position.count > b.geometry.attributes.position.count ? a : b);
  largest.geometry.computeBoundingSphere();
  const center = largest.geometry.boundingSphere.center.clone().applyMatrix4(largest.matrixWorld);
  const target = center.toArray();
  const view = (name, x, y, z) => [name, center.clone().add(new THREE.Vector3(x, y, z)).toArray()];
  return { scene, water, terrain, materials, time, atlas, fixture, target,
    views: [view("above", 8, 22, 14), view("below", 9, -12, 17),
      view("inside", 0.1, 0.05, 0.15), view("grazing", -27, 0.3, 3)],
    native: { seed: "cedar-valley", version: 7, region: [-17, 21], columns: 16, sections: 384,
      apronColumns: fixture.world.chunks.size, sources: water.length, generationAndMeshMs: performance.now() - start },
  };
}
