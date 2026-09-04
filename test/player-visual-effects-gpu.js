// Authored production-renderer control, not native-world gameplay acceptance.
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { createMobModel } from "../src/mob-models.js";
import { createMobSkinResources } from "../src/mob-skin-atlas.js";
import { GameRenderer } from "../src/renderer.js";
import { daylightTunnel } from "./daylight-fixture.js";

export async function runPlayerVisionProbe(container) {
  const f = daylightTunnel();
  f.close();
  // Fully admitted authored empty neighbors exercise the normal detail fog
  // cap without a surface LOD stand-in for underwater geometry.
  for (let z = -3; z <= 3; z++)
    for (let x = -2; x <= 4; x++)
      if (!f.world.chunks.has(`${x},${z}`)) f.world.admit(x, z);
  f.world.put(40, 8, 2, BLOCK.GLOWSTONE);
  const g = new GameRenderer(container, f.world);
  let skin, mob;
  const SIZE = 65, frame = new Uint8Array(SIZE * SIZE * 4);
  const fingerprint = (arrays) => {
    let hash = 2166136261;
    for (const a of arrays)
      for (const byte of new Uint8Array(a.buffer, a.byteOffset, a.byteLength))
        hash = Math.imul(hash ^ byte, 16777619) >>> 0;
    return hash;
  };
  const terrain = { name: "textured-stone", point: new THREE.Vector3(24.5, 8, 2.5) };
  const targets = [terrain];
  try {
    g.setQuality("medium");
    g.setTime(0);
    g.renderer.setPixelRatio(1);
    g.renderer.setSize(SIZE, SIZE);
    g.camera.aspect = 1;
    g.camera.position.copy(f.position(24.5));
    g.camera.lookAt(0, 9.5, 2.5);
    g.camera.updateProjectionMatrix();
    const tick = () => {
      g.rebuildDirty(Infinity);
      g.update(0, 0, g.camera.position);
    };
    const settle = () => {
      for (let i = 0; i < 2048; i++) {
        tick();
        // Drain real uploads; the production publisher deliberately refuses
        // additional layers until the prior frame's upload was consumed.
        g.render();
        if (!g.skyColumns.surfaceLight.pending && !g.blockLight.pending && !g.blockLight.job)
          return i + 1;
      }
      throw new Error(`Authored visual fields exceeded bounded warmup: surface=${g.skyColumns.surfaceLight.pending}, block=${g.blockLight.pending}`);
    };
    const warmupTicks = settle();
    const gl = g.renderer.getContext();
    const fields = () => fingerprint([g.skyColumns.data, g.skyColumns.surfaceLight.data,
      g.blockLight.data, g.blockLight.valid]);
    const world = () => fingerprint([...f.world.chunks.values()].map((c) => c.blocks));
    const unchanged = { fields: fields(), world: world() };
    const read = (target) => {
      const camera = g.camera.clone();
      camera.position.copy(target.point).add(new THREE.Vector3(0, 0.5, 0));
      camera.up.set(0, 0, -1);
      camera.fov = 35;
      camera.lookAt(target.point);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
      g.scene.updateMatrixWorld(true);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(), camera);
      const meshes = target.mesh ? [target.mesh] : [...g.chunks.values()];
      const hit = ray.intersectObjects(meshes, true)[0];
      if (!hit || hit.point.distanceTo(target.point) > 0.0001)
        throw new Error(`Fixed ${target.name} surface ray missed`);
      g.renderer.render(g.scene, camera);
      gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, frame);
      const middle = (32 * SIZE + 32) * 4;
      return { name: target.name, rgba: [...frame.slice(middle, middle + 4)],
        hash: fingerprint([frame]), uv: hit.uv.toArray(), instance: hit.instanceId ?? null };
    };
    const capture = () => targets.map(read);
    const initial = capture();
    // Create production atlas + instanced cow only after vision is active.
    g.setPlayerVisualEffects({ nightVision: 1 });
    tick();
    const model = createMobModel("cow");
    model.root.position.set(28.5, 8, 2.5);
    model.root.updateMatrixWorld(true);
    const parts = model.parts.filter((part) => !part.condition);
    skin = createMobSkinResources(72);
    mob = new THREE.InstancedMesh(skin.geometry, skin.material, parts.length);
    mob.position.set(16, 0, 16);
    mob.frustumCulled = false;
    parts.forEach((part, index) => {
      const matrix = part.node.matrixWorld.clone();
      matrix.elements[12] -= 16;
      matrix.elements[14] -= 16;
      mob.setMatrixAt(index, matrix);
      mob.setColorAt(index, part.skin.tintable ? part.color : new THREE.Color(1, 1, 1));
      skin.write(index, part.skin);
    });
    mob.instanceMatrix.needsUpdate = true;
    mob.instanceColor.needsUpdate = true;
    skin.update();
    g.scene.add(mob);
    targets.push({ name: "late-instanced-cow", point: new THREE.Vector3(28.5, 9.42, 2.45), mesh: mob });
    targets.push({ name: "self-emissive-glowstone", point: new THREE.Vector3(40.5, 9, 2.5) });
    const active = capture();
    const allocation = { ...g.renderer.info.memory, programs: g.renderer.info.programs.length };
    const strengths = [];
    for (const strength of [0, 0.25, 0.5, 1, 0]) {
      g.setPlayerVisualEffects({ nightVision: strength });
      tick();
      strengths.push({ strength, uniform: g.daylightMaterial.uniforms.uPlayerVision.value, pixels: capture() });
    }
    // Independent zero-path control removes only the vision branch from the
    // assembled shader. All spatial daylight/block-light code stays identical.
    const material = g.materials.opaque;
    const compiled = material.onBeforeCompile, key = material.customProgramCacheKey;
    material.onBeforeCompile = (shader, renderer) => {
      compiled(shader, renderer);
      const before = shader.fragmentShader;
      shader.fragmentShader = before.replace(
        /if \(uPlayerVision > 0\.0\) \{[\s\S]*?\} else \{\s*(irradiance \+= getHemisphereLightIrradiance\( skyLight, geometryNormal \);)\s*\}/,
        "$1"
      );
      if (shader.fragmentShader === before) throw new Error("Zero-path shader control failed");
    };
    material.customProgramCacheKey = () => `${key()}:zero-path-control`;
    material.needsUpdate = true;
    const baselineControl = read(terrain);
    material.onBeforeCompile = compiled;
    material.customProgramCacheKey = key;
    material.needsUpdate = true;
    g.setFullbrightInspection(true);
    const inspection = capture();
    g.setPlayerVisualEffects({ nightVision: 1, conduitPower: true });
    tick();
    const inspectionEffect = capture();
    g.setFullbrightInspection(false);
    g.setPlayerVisualEffects();
    tick();
    const expired = capture();
    const stable = { fields: fields() === unchanged.fields, world: world() === unchanged.world };
    const canvas = g.renderer.domElement, extension = gl.getExtension("WEBGL_lose_context");
    g.setPlayerVisualEffects({ nightVision: 1 });
    capture();
    const lost = new Promise((resolve) => canvas.addEventListener("webglcontextlost", resolve, { once: true }));
    extension.loseContext();
    await lost;
    const lostUniform = g.daylightMaterial.uniforms.uPlayerVision.value;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const restored = new Promise((resolve) => canvas.addEventListener("webglcontextrestored", resolve, { once: true }));
    extension.restoreContext();
    await restored;
    const restoredUniform = g.daylightMaterial.uniforms.uPlayerVision.value;
    // Block-light intentionally republishes its cached pages in bounded
    // slices after loss. Reset is immediate; compare pixels once republished.
    const restoreTicks = settle();
    const afterContext = capture();
    g.setPlayerVisualEffects({ nightVision: 1 });
    tick();
    const reapplied = capture();
    const restoredStable = { fields: fields() === unchanged.fields, world: world() === unchanged.world };
    const water = [];
    let expiredWaterFog;
    for (const block of [BLOCK.WATER, BLOCK.LAVA, BLOCK.AIR]) {
      f.world.put(24, 9, 2, block);
      g.setPlayerVisualEffects({ conduitPower: true });
      tick();
      water.push({ block, known: g.atmosphere.cameraMediumKnown, underwater: g.atmosphere.underwater,
        vision: g.daylightMaterial.uniforms.uPlayerVision.value, fog: g.scene.fog.far,
        cap: g.streamingFogDistance(g.camera.position), distant: g.distant.group.visible });
      if (block === BLOCK.WATER) {
        g.setPlayerVisualEffects();
        expiredWaterFog = g.scene.fog.far;
      }
    }
    f.world.put(24, 9, 2, BLOCK.WATER);
    tick();
    g.removeChunk("1,0");
    g.update(0, 0, g.camera.position);
    const missingDetail = { fog: g.scene.fog.far, cap: g.streamingFogDistance(g.camera.position) };
    return { initial, active, strengths, baselineControl, inspection, inspectionEffect, expired,
      stable, restoredStable, warmupTicks, restoreTicks, lostUniform, restoredUniform,
      afterContext, reapplied, water, expiredWaterFog, missingDetail, allocation,
      finalAllocation: { ...g.renderer.info.memory, programs: g.renderer.info.programs.length },
      glError: gl.getError(), contextLost: gl.isContextLost(),
      failedPrograms: g.renderer.info.programs.filter((p) => p.diagnostics?.runnable === false).length };
  } finally {
    mob?.removeFromParent();
    mob?.dispose();
    skin?.dispose();
    g.dispose();
  }
}
