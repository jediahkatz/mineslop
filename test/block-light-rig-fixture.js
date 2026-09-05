import * as THREE from "three";
import { createMobModel } from "../src/mob-models.js";
import { createMobGelResources, createMobSkinResources } from "../src/mob-skin-atlas.js";

export function blockLightRigs(scene) {
  const mobs = [], resources = [];
  for (const [kind, x] of [["cow", 17.5], ["slime", 20.5]]) {
    const model = createMobModel(kind), group = new THREE.Group();
    const opaque = createMobSkinResources(72);
    resources.push(opaque);
    model.root.position.set(x, 8, 2.5);
    model.root.updateMatrixWorld(true);
    for (const translucent of [false, true]) {
      const parts = model.parts.filter((p) => !p.condition && !!p.skin.translucent === translucent);
      if (!parts.length) continue;
      const source = translucent ? createMobGelResources(opaque) : opaque;
      if (translucent) resources.push(source);
      const mesh = new THREE.InstancedMesh(source.geometry, source.material, parts.length);
      mesh.position.set(16, 0, 16);
      mesh.frustumCulled = false;
      parts.forEach((part, index) => {
        const matrix = part.node.matrixWorld.clone();
        matrix.elements[12] -= 16; matrix.elements[14] -= 16;
        mesh.setMatrixAt(index, matrix);
        mesh.setColorAt(index, part.skin.tintable ? part.color : new THREE.Color(1, 1, 1));
        source.write(index, part.skin);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
      source.update();
      group.add(mesh);
    }
    scene.add(group);
    mobs.push({ kind, group, point: new THREE.Vector3(x, kind === "cow" ? 9.42 : 8.57, kind === "cow" ? 2.45 : 3.01),
      normal: kind === "cow" ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1) });
  }
  return { mobs, resources, dispose() {
    for (const mob of mobs) scene.remove(mob.group);
    for (const source of resources) source.dispose();
  } };
}
