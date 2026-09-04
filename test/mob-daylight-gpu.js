// Authored browser regression, not native-world or manual-walk acceptance.
// Real GameRenderer/atmosphere/field, production mob atlas and instanced rigs.
// Fog stays enabled; fixed close-up rays isolate lighting from fog distance.
import * as THREE from "three";
import { sampleDaylightAt } from "../src/daylight-material.js";
import { createMobModel } from "../src/mob-models.js";
import { createMobGelResources, createMobSkinResources, paintMobAtlasFace } from "../src/mob-skin-atlas.js";
import { GameRenderer } from "../src/renderer.js";
import { daylightTunnel } from "./daylight-fixture.js";

const SIZE = 65;
const ANCHOR = new THREE.Vector3(16, 0, 16);
const luma = (rgba) => rgba[0] * 0.2126 + rgba[1] * 0.7152 + rgba[2] * 0.0722;

export function runMobDaylightProbe(container) {
  const fixture = daylightTunnel();
  const before = [...fixture.world.chunks].map(([key, chunk]) => [key, chunk.blocks.slice()]);
  const resources = createMobSkinResources(72 * 6);
  const groups = [], targets = [];
  const ray = new THREE.Raycaster(), pixel = new Uint8Array(4);
  let g, gel, frame = 0, readbacks = 0;
  const renderer = (world) => {
    const graphics = new GameRenderer(container, world);
    graphics.setQuality("medium");
    graphics.setTime(0.5);
    graphics.renderer.setPixelRatio(1);
    graphics.renderer.setSize(SIZE, SIZE);
    graphics.camera.aspect = 1;
    graphics.camera.updateProjectionMatrix();
    return graphics;
  };
  const batch = (parts, source) => {
    const mesh = new THREE.InstancedMesh(source.geometry, source.material, parts.length);
    mesh.position.copy(ANCHOR);
    mesh.frustumCulled = false;
    parts.forEach((part, index) => {
      const matrix = part.node.matrixWorld.clone();
      matrix.elements[12] -= ANCHOR.x;
      matrix.elements[14] -= ANCHOR.z;
      mesh.setMatrixAt(index, matrix);
      mesh.setColorAt(index, part.skin.tintable ? part.color : new THREE.Color(1, 1, 1));
      source.write(index, part.skin);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    mesh.count = parts.length;
    source.update();
    return mesh;
  };
  // Each opaque rig gets its own attributes but shares the production material
  // and texture; changing one rig's UVs cannot overwrite another rig's data.
  const rigs = [];
  const addRig = (name, kind, x, top, emissiveRole) => {
    const model = createMobModel(kind);
    model.root.position.set(x, 8, 2.5);
    model.root.updateMatrixWorld(true);
    const parts = model.parts.filter((p) => emissiveRole ? p.role === emissiveRole : !p.condition);
    const source = createMobSkinResources(72);
    rigs.push(source);
    const opaque = batch(parts.filter((p) => !p.skin.translucent), source);
    opaque.material = resources.material;
    const group = new THREE.Group();
    group.add(opaque);
    if (parts.some((p) => p.skin.translucent))
      group.add(batch(parts.filter((p) => p.skin.translucent), gel));
    groups.push(group);
    g.scene.add(group);
    let point = new THREE.Vector3(x, 8 + top, 2.45), normal = new THREE.Vector3(0, 1, 0), sourceRGBA;
    if (kind === "slime") {
      point.set(x, 8.57, 3.01);
      normal.set(0, 0, 1);
    }
    if (emissiveRole) {
      const part = parts[0], face = paintMobAtlasFace(part.skin, "front");
      let index = 0, best = -1;
      for (let i = 0; i < face.width * face.height; i++) {
        const score = face.data[i * 4 + 3] * (face.data[i * 4] + face.data[i * 4 + 1] + face.data[i * 4 + 2]);
        if (score > best) { best = score; index = i; }
      }
      sourceRGBA = [...face.data.subarray(index * 4, index * 4 + 4)];
      point.set((index % face.width + 0.5) / face.width - 0.5,
        0.5 - (Math.floor(index / face.width) + 0.5) / face.height, 0.5).applyMatrix4(part.node.matrixWorld);
      normal.set(0, 0, 1);
    }
    const target = { name, point, normal, group, sourceRGBA };
    targets.push(target);
    return target;
  };
  const observer = (x) => {
    g.camera.position.copy(fixture.position(x));
    g.camera.lookAt(2.5, 9.5, 2.5);
    g.setBiome(g.world.getBiome(x, 2.5, 8));
    let ticks = 0;
    do {
      g.rebuildDirty(Infinity);
      g.update(0, ++frame, { x, y: 8, z: 2.5 });
      if (++ticks > 81) throw new Error("Daylight field did not settle");
    } while (g.skyColumns.surfaceLight.pending);
    return { x, exposure: g.skyAccess.exposure, known: g.skyAccess.known,
      pending: g.skyColumns.surfaceLight.pending, fog: [g.scene.fog.near, g.scene.fog.far] };
  };
  const read = (target) => {
    if (++readbacks > 100) throw new Error("Mob daylight readback budget exceeded");
    const camera = g.camera.clone();
    camera.position.copy(target.point).addScaledVector(target.normal, 0.5);
    camera.up.set(0, target.normal.y ? 0 : 1, target.normal.y ? -1 : 0);
    camera.fov = 35;
    camera.lookAt(target.point);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    g.scene.updateMatrixWorld(true);
    ray.setFromCamera(new THREE.Vector2(), camera);
    const hits = ray.intersectObject(target.group, true), hit = hits[0];
    if (!hit || hit.point.distanceTo(target.point) > 0.0001)
      throw new Error(`Readback misses the fixed ${target.name} face`);
    g.renderer.render(g.scene, camera);
    const gl = g.renderer.getContext();
    gl.readPixels(32, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    if (gl.getError() || gl.isContextLost()) throw new Error("Mob daylight GL failure");
    const depth = -target.point.clone().applyMatrix4(camera.matrixWorldInverse).z;
    const t = THREE.MathUtils.clamp((depth - g.scene.fog.near) / (g.scene.fog.far - g.scene.fog.near), 0, 1);
    const backing = hits.find((hit) => !hit.object.material.transparent);
    const backingDepth = backing && -backing.point.clone().applyMatrix4(camera.matrixWorldInverse).z;
    return { name: target.name, rgba: [...pixel], luma: luma(pixel), uv: hit.uv.toArray(),
      instance: hit.instanceId, point: hit.point.toArray(), sourceRGBA: target.sourceRGBA,
      mask: sampleDaylightAt(g.skyColumns, target.point.clone().addScaledVector(target.normal, 0.02)),
      fogFactor: t * t * (3 - 2 * t), backingUnfogged: backingDepth !== undefined && backingDepth < g.scene.fog.near };
  };
  const capture = () => targets.map(read);
  try {
    g = renderer(fixture.world);
    addRig("outside", "cow", -2.5, 1.42);
    addRig("inside", "sheep", 4.5, 1.16);
    addRig("deep", "cow", 24.5, 1.42);
    const first = observer(-4.5);
    const beforeLateGel = capture();
    gel = createMobGelResources(resources);
    const lateBeforeDraw = g.daylightMaterial.installed.has(gel.material);
    addRig("gel", "slime", 8.5, 1.1075);
    addRig("eyes", "enderman", 28.5, 0, "head");
    addRig("fire", "zombie", 20.5, 0, "flame");
    const stations = [];
    for (const x of [-4.5, 4.5, 32.5, -4.5]) {
      const state = observer(x);
      const natural = capture();
      g.setFullbrightInspection(true);
      const fullbright = capture();
      g.setFullbrightInspection(false);
      const restored = capture();
      stations.push({ ...state, natural, fullbright, restored });
    }
    const target = targets.find((t) => t.name === "deep");
    const unlit = read(target);
    const light = new THREE.PointLight("#ffce7e", 4, 8, 1.5);
    light.position.copy(target.point).addScaledVector(target.normal, 1);
    g.scene.add(light);
    let torch;
    try { torch = read(target); }
    finally { light.removeFromParent(); light.dispose(); }
    const restoredTorch = read(target);
    const binding = { opaque: g.daylightMaterial.installed.has(resources.material),
      gel: g.daylightMaterial.installed.has(gel.material), sharedAtlas: gel.texture === resources.texture,
      fog: resources.material.fog && gel.material.fog && g.materials.opaque.fog };
    const unchanged = before.every(([key, blocks]) =>
      blocks.every((value, i) => fixture.world.chunks.get(key).blocks[i] === value));
    // Same retained materials/instances, new renderer and genuinely different
    // world illumination. A stale binding would leave the inside sheep bright.
    const openKey = resources.material.customProgramCacheKey();
    groups.forEach((group) => group.removeFromParent());
    g.dispose();
    const closed = daylightTunnel();
    closed.close();
    g = renderer(closed.world);
    groups.forEach((group) => g.scene.add(group));
    const reboundObserver = observer(32.5);
    const rebound = capture();
    g.setFullbrightInspection(true);
    const reboundFullbright = capture();
    g.setFullbrightInspection(false);
    // Freshly created materials in the replacement scene are an independent
    // reference for both retained opaque and retained translucent bindings.
    const fresh = createMobSkinResources(1), freshGel = createMobGelResources(fresh);
    const swapped = [];
    groups.forEach((group) => group.traverse((mesh) => {
      if (!mesh.isInstancedMesh) return;
      swapped.push([mesh, mesh.material]);
      mesh.material = mesh.material.transparent ? freshGel.material : fresh.material;
    }));
    let freshRebound, freshBindings;
    try {
      freshRebound = capture();
      freshBindings = g.daylightMaterial.installed.has(fresh.material) &&
        g.daylightMaterial.installed.has(freshGel.material);
    } finally {
      swapped.forEach(([mesh, material]) => { mesh.material = material; });
      freshGel.dispose(); fresh.dispose();
    }
    const failedPrograms = g.renderer.info.programs.filter((p) => p.diagnostics?.runnable === false).length;
    return { first, beforeLateGel, lateBeforeDraw, stations, unlit, torch, restoredTorch, binding,
      unchanged, anchor: ANCHOR.toArray(), readbacks, reboundObserver, rebound, reboundFullbright,
      freshRebound, freshBindings, failedPrograms,
      reboundBinding: { keyChanged: resources.material.customProgramCacheKey() !== openKey,
        opaque: g.daylightMaterial.installed.has(resources.material), gel: g.daylightMaterial.installed.has(gel.material) } };
  } finally {
    groups.forEach((group) => { group.removeFromParent(); group.traverse((o) => o.isInstancedMesh && o.dispose()); });
    g?.dispose();
    gel?.dispose();
    rigs.forEach((source) => source.dispose());
    resources.dispose();
  }
}
