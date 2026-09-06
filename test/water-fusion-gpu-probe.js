import * as THREE from "three";
import { WaterFusionOwner, waterFusionBudget } from "../src/water-fusion.js";
import { waterFusionCovered } from "../src/water-fusion-geometry.js";
import { releaseLostContextResources } from "../src/context-resources.js";
import { authoredWaterScene } from "./water-pull-fixture.js";
import { nativeWaterScene } from "./water-pull-native-fixture.js";
import { waterPullLightFixture } from "./water-pull-light-fixture.js";
import { waterFusionGLTrace, assertWaterGPUWork } from "./water-fusion-gl-trace.js";

const check = (ok, message) => { if (!ok) throw new Error(message); };
const difference = (a, b) => a.reduce((n, v, i) => n + Number(v !== b[i]), 0);

export async function runWaterFusionProbe() {
  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  renderer.setSize(128, 128); renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.info.autoReset = false;
  renderer.shadowMap.enabled = true;
  document.body.append(renderer.domElement);
  const gl = renderer.getContext(), trace = waterFusionGLTrace(renderer);
  check(gl.getExtension("EXT_color_buffer_float"), "float readback verification requires EXT_color_buffer_float");
  const report = { pairs: [], fixtures: [], transfers: [], recovery: [], refresh: [], programs: trace.programDescriptions };
  globalThis.waterFusionProgress = report;
  const camera = new THREE.PerspectiveCamera(65, 1, 0.05, 512);
  const capture = scene => {
    trace.draws.length = 0; renderer.info.reset();
    trace.state.scope = "render";
    renderer.render(scene, camera);
    const image = new Uint8Array(128 * 128 * 4);
    gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, image);
    check(gl.getError() === gl.NO_ERROR, "render GL error");
    check(trace.draws.length === renderer.info.render.calls, "Three calls must equal actual GL calls");
    return { image, calls: trace.draws.slice() };
  };
  const step = (owner, budget = waterFusionBudget()) => {
      const start = trace.operations.length;
      trace.state.scope = "water-step";
      owner.step(renderer, budget);
      const operations = trace.operations.slice(start);
      const actualWork = operations.reduce((n, o) => n + o.workBytes, 0);
      const gpuDebit = assertWaterGPUWork(budget.work, operations);
      check(actualWork <= budget.usedBytes, `uncharged GL work ${actualWork}/${budget.usedBytes}`);
      check(budget.usedBytes <= 1048576 && budget.work.length <= 16, "slice ceiling");
      check(operations.every(o => o.workBytes <= 1048576), "single transfer ceiling");
      report.transfers.push({ usedBytes: budget.usedBytes, actualWork, gpuDebit,
        work: budget.work, operations: operations.map(({ handle, ...o }) => o) });
  };
  const pump = owner => {
    for (let i = 0; i < 10000 && owner.pending.size; i++) {
      step(owner);
    }
    check(!owner.pending.size, `build incomplete ${JSON.stringify([...owner.records.values()].map(r => [r.phase, r.error]))}`);
  };
  const run = async (f, name, lit) => {
    f.scene.background = new THREE.Color("#172029");
    f.scene.fog = new THREE.Fog("#899aaa", 12, 100);
    f.scene.add(new THREE.AmbientLight(0xffffff, 0.7), new THREE.HemisphereLight(0x8fcfff, 0x514332, 0.8));
    const sun = new THREE.DirectionalLight(0xffe9c5, 2.1);
    sun.position.copy(new THREE.Vector3(...f.target).add(new THREE.Vector3(14, 20, 10)));
    sun.target.position.set(...f.target); sun.castShadow = true; sun.shadow.mapSize.set(128, 128);
    Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 0.5, far: 100 });
    f.scene.add(sun, sun.target);
    let light = lit ? waterPullLightFixture(f.scene, [f.materials.water, f.materials.glass]) : null;
    const owner = new WaterFusionOwner({ enabled: true });
    // Reference duplication exists ONLY in this paired test, never in the owner.
    const refs = f.water.map(mesh => ({ mesh, geometry: mesh.geometry.clone(), before: mesh.onBeforeRender }));
    const waterIds = new Set(f.water.map(m => m.id));
    const aim = position => { camera.position.set(...position); camera.lookAt(...f.target); camera.updateMatrixWorld(true); };
    const reference = () => {
      const saved = refs.map(({ mesh }) => [mesh.geometry, mesh.material, mesh.onBeforeRender]);
      refs.forEach(({ mesh, geometry, before }) => {
        mesh.geometry = geometry; mesh.material = f.materials.water; mesh.onBeforeRender = before;
      });
      try { return capture(f.scene); } finally {
        refs.forEach(({ mesh }, i) => [mesh.geometry, mesh.material, mesh.onBeforeRender] = saved[i]);
      }
    };
    const pair = label => {
      const a = reference(), b = capture(f.scene);
      const differingBytes = difference(a.image, b.image);
      const expanded = b.calls.flatMap(c => waterIds.has(c.id) && c.method === "drawElementsInstanced" ? [c.id, c.id] : [c.id]);
      check(JSON.stringify(expanded) === JSON.stringify(a.calls.map(c => c.id)), `${name}/${label}: order`);
      check(differingBytes === 0, `${name}/${label}: ${differingBytes} differing bytes`);
      const visible = f.water.map(m => m.visible);
      f.water.forEach(m => m.visible = false);
      const background = capture(f.scene);
      f.water.forEach((m, i) => m.visible = visible[i]);
      const waterBytes = difference(a.image, background.image);
      report.pairs.push({ name, label, differingBytes, waterBytes,
        referenceCalls: a.calls.length, fusedCalls: b.calls.length,
        referenceWaterCalls: a.calls.filter(c => waterIds.has(c.id)).length,
        fusedWaterCalls: b.calls.filter(c => waterIds.has(c.id)).length });
      if (!label.includes("empty") && !label.includes("mirrored")) check(waterBytes > 0, `${name}/${label}: water visibility`);
      return b.image;
    };
    aim(f.views[0][1]);
    reference(); // Allocate original reference path before constructing owned resources.
    const original = f.water[0].geometry;
    for (const mesh of f.water) {
      const status = owner.request(mesh, { current: () => true, exclusiveGeometry: true,
        reviewedHooks: new Set([f.materials.water.onBeforeCompile]) });
      check(status.state === "pending", `${name}: ${JSON.stringify(status)}`);
      if (mesh === f.water[0]) {
        trace.state.failNextRows = true;
        while (trace.state.failNextRows) {
          step(owner, waterFusionBudget({ operations: 1 }));
        }
        check(owner.stats.failures === 1 && !owner.status(mesh).ready, "failed upload cannot publish");
        check(mesh.geometry === original, "failed upload preserves original source");
      }
      pump(owner);
    }
    const resources = owner.resources();
    let measuredTexture = 0, measuredIndex = 0;
    for (const r of owner.records.values()) {
      const texture = trace.textures.get(renderer.properties.get(r.texture).__webglTexture);
      check(texture?.format === gl.RGBA32F && texture.levels === 1, "owned texture allocation");
      measuredTexture += texture.bytes;
      measuredIndex += trace.buffers.get(r.indexBuffer) ?? 0;
      check(r.plan.attributes === null && r.plan.geometry === null, "no retained source attributes");
      check(r.drawGeometry.index.array === r.indices, "canonical index alias");
      // Independent full-buffer/texture readback, including padding and -0.
      // These verification arrays are test-only, not production staging.
      const index = new Uint8Array(r.indices.byteLength), pixels = new Float32Array(r.data.length);
      const oldBuffer = gl.getParameter(gl.COPY_READ_BUFFER_BINDING);
      gl.bindBuffer(gl.COPY_READ_BUFFER, r.indexBuffer);
      gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, index);
      gl.bindBuffer(gl.COPY_READ_BUFFER, oldBuffer);
      check(difference(index, new Uint8Array(r.indices.buffer, r.indices.byteOffset, r.indices.byteLength)) === 0, "actual index bytes");
      const oldFramebuffer = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D,
        renderer.properties.get(r.texture).__webglTexture, 0);
      check(gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE, "float texture readback");
      gl.readPixels(0, 0, r.plan.width, r.plan.height, gl.RGBA, gl.FLOAT, pixels);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, oldFramebuffer); gl.deleteFramebuffer(fb);
      check(difference(new Uint32Array(pixels.buffer), new Uint32Array(r.data.buffer)) === 0, "actual texture bit pattern");
      check(gl.getError() === gl.NO_ERROR, "canonical GPU readback error");
    }
    check(measuredTexture + measuredIndex === resources.allocatedOwnedGpuBytes, "actual GPU ownership bytes");
    report.fixtures.push({ name, native: f.native, resources, measuredTexture, measuredIndex });
    for (const [view, position] of f.views) {
      aim(position);
      for (const time of [0, 3.25]) { f.time.value = time; pair(`${view}/${time}`); }
    }
    aim(f.views[0][1]);
    if (name === "authored") {
      for (const mode of ["partial", "empty", "mirrored"]) {
        for (const { mesh, geometry } of refs) {
          geometry.setDrawRange(mode === "partial" ? 3 : 0, mode === "partial" ? 12 : mode === "empty" ? 0 : Infinity);
          mesh.geometry.setDrawRange(geometry.drawRange.start, geometry.drawRange.count);
          mesh.scale.x = mode === "mirrored" ? -1 : 1;
        }
        pair(mode);
      }
      for (const { mesh, geometry } of refs) { mesh.scale.x = 1; geometry.setDrawRange(0, Infinity); }
      f.water.forEach(m => m.geometry.setDrawRange(0, Infinity));
      // A stable key closure changes its resolved value: refresh must recompile.
      let quality = "high";
      const composed = f.materials.water.onBeforeCompile;
      f.materials.water.onBeforeCompile = (shader, glRenderer) => {
        composed.call(f.materials.water, shader, glRenderer);
        if (quality === "low") shader.fragmentShader = shader.fragmentShader
          .replace("diffuseColor.rgb *= 0.99 + ripple * 0.055;", "");
      };
      f.materials.water.customProgramCacheKey = () => `quality-${quality}`;
      let lowPixels;
      for (const next of ["low", "high"]) {
        quality = next; f.materials.water.needsUpdate = true;
        f.water.forEach(m => owner.refresh(m, { reviewedHooks: new Set([f.materials.water.onBeforeCompile]) })); pump(owner);
        const image = pair(`quality-${next}`);
        if (next === "low") lowPixels = image;
        else check(difference(lowPixels, image) > 0, "quality recompilation must change visible water pixels");
        report.refresh.push(next);
      }
      const previousLight = light;
      light = waterPullLightFixture(f.scene, [f.materials.water, f.materials.glass]);
      light.uniforms.uDaylightKey.value.set(0.15, 0.25, 0.35);
      f.water.forEach(m => owner.refresh(m, { reviewedHooks: new Set([f.materials.water.onBeforeCompile]) }));
      pump(owner); pair("daylight-owner-rebound"); report.refresh.push("daylight-owner-rebound");
      previousLight.dispose();
      f.materials.water.clippingPlanes = [new THREE.Plane(new THREE.Vector3(1, 0, 0), 29)];
      renderer.localClippingEnabled = true;
      f.water.forEach(m => owner.refresh(m)); pump(owner);
      check([...owner.records.values()].every(r => r.mode === "original"), "clipping uses original fallback");
      pair("clipping-fallback");
      f.materials.water.clippingPlanes = null;
      f.water.forEach(m => owner.refresh(m)); pump(owner);
      pair("clipping-removed");
    } else {
      f.water.forEach(m => m.frustumCulled = false);
      pair("allocation-no-object-culling");
      f.water.forEach(m => m.frustumCulled = true);
      f.terrain.forEach(m => m.visible = true);
      pair("complete-native-terrain-occlusion");
      f.terrain.forEach(m => m.visible = false);
    }
    const before = pair("before-recovery");
    const arrays = [...owner.records.values()].map(r => [r.data, r.indices]);
    const extension = gl.getExtension("WEBGL_lose_context");
    const lost = new Promise(resolve => renderer.domElement.addEventListener("webglcontextlost", event => {
      event.preventDefault();
      // The reference copies are off-scene, test-only retained resources.
      releaseLostContextResources(renderer, f.scene, refs.map(r => r.geometry), [owner]);
      resolve();
    }, { once: true }));
    extension.loseContext();
    check(f.water.every(m => !waterFusionCovered(m) && !owner.status(m).ready), "loss before DOM event is not ready");
    await lost;
    check(f.water.every(m => !waterFusionCovered(m)), "loss is not ready");
    const restored = new Promise(resolve => renderer.domElement.addEventListener("webglcontextrestored", resolve, { once: true }));
    // WebGL only allows restoration AFTER the loss event has returned.
    await new Promise(resolve => setTimeout(resolve, 50));
    extension.restoreContext();
    await Promise.race([restored, new Promise((_, reject) => setTimeout(() => reject(new Error("restore timeout")), 10000))]);
    light?.restoreGPU();
    pump(owner);
    check([...owner.records.values()].every((r, i) => r.data === arrays[i][0] && r.indices === arrays[i][1]), "recovery array identity");
    const after = pair("after-recovery");
    check(difference(before, after) === 0, "context restore pixels");
    report.recovery.push({ name, differingBytes: 0, sameArrays: true });
    const retainedGeometries = f.water.map(m => m.geometry), retainedDecoders = [...owner.records.values()].map(r => r.decoder.geometry);
    owner.dispose();
    check(owner.resources().allocatedCpuBytes === 0, "retired CPU bytes");
    check([...retainedGeometries, ...retainedDecoders].every(g => g.index === null && !Object.keys(g.attributes).length), "retirement detaches borrowed views");
    refs.forEach(r => r.geometry.dispose());
    light?.dispose();
  };
  try {
    await run(authoredWaterScene(), "authored", true);
    await run(nativeWaterScene(), "native", false);
    report.machine = { renderer: gl.getParameter(gl.RENDERER), maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxVertexSamplers: gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS),
      maxCombinedSamplers: gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) };
    return report;
  } finally { renderer.dispose(); }
}
