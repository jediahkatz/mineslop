// Real WebGL pixels from a roofed entrance face, with partial topology work
// during context loss. This authored control is not native GUI acceptance.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import test from "node:test";
import { chromium } from "playwright";
import { chromeExecutable } from "./realtime/config.mjs";
import { installWebGLCallTrace } from "./webgl-call-trace.js";

const base = new URL(process.env.VOXELCRAFT_TEST_URL ?? "http://127.0.0.1:5173/mineslop/");
test("retained entrance atlas layers restore alongside partial lost-context topology work", { timeout: 120000 }, async (t) => {
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true, args: ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 128, height: 128 } });
  await page.addInitScript(installWebGLCallTrace);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type())) t.diagnostic(message.text());
  });
  await page.goto(new URL("test/daylight-surface-probe.html", base).href, { waitUntil: "load" });
  const result = await page.evaluate(async () => {
    const THREE = await import("../node_modules/three/build/three.module.js");
    const { BLOCK } = await import("../src/blocks.js");
    const { GameRenderer } = await import("../src/renderer.js");
    const { sampleDaylightAt } = await import("../src/daylight-material.js");
    const { surfaceTunnel, ENTRANCE_SURFACES, surfaceAirPoint } = await import("./daylight-surface-fixture.js");
    const f = surfaceTunnel(true), g = new GameRenderer(document.querySelector("#surface-probe"), f.world);
    const surface = ENTRANCE_SURFACES[0], point = surfaceAirPoint(surface), SIZE = 65;
    try {
      g.setQuality("medium");
      g.setTime(0.5);
      g.renderer.setPixelRatio(1);
      g.renderer.setSize(SIZE, SIZE);
      g.camera.aspect = 1;
      g.camera.position.copy(f.position(4.5));
      g.camera.lookAt(surface.point.x, surface.point.y, surface.point.z);
      g.camera.zoom = 16;
      g.camera.updateProjectionMatrix();
      // Match the existing material control: production shaders, fixed texel,
      // no distant fog contribution; no altered light colors or shader masks.
      for (const material of Object.values(g.materials)) material.fog = false;
      const tick = () => {
        g.rebuildDirty(Infinity);
        g.update(0, 0, f.position(4.5));
      };
      for (let i = 0; i < 42; i++) {
        tick();
        if (!g.skyColumns.surfaceLight.pending) break;
      }
      const gl = g.renderer.getContext(), light = g.skyColumns.surfaceLight;
      const data = light.data;
      const slot = light.slot(0, 0);
      const at = (Math.floor(point.y) - g.skyColumns.spec.minY) * 256 + Math.floor(point.z) * 16 + Math.floor(point.x);
      const index = slot * light.layerSize + at;
      const capture = () => {
        g.camera.updateMatrixWorld(true);
        g.scene.updateMatrixWorld(true);
        const ray = new THREE.Raycaster();
        ray.setFromCamera(new THREE.Vector2(), g.camera);
        const meshes = [];
        for (const group of g.chunks.values())
          if (group.visible) group.traverse((mesh) => { if (mesh.isMesh) meshes.push(mesh); });
        const hit = ray.intersectObjects(meshes, false)[0];
        if (!hit || hit.point.distanceTo(new THREE.Vector3(surface.point.x, surface.point.y, surface.point.z)) > 0.0001)
          throw new Error("Readback must hit the same roofed entrance texel");
        g.render();
        const rgba = new Uint8Array(4), gpu = new Uint8Array(4);
        gl.readPixels(32, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
        const fb = gl.createFramebuffer(), previous = gl.getParameter(gl.FRAMEBUFFER_BINDING);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
          g.renderer.properties.get(light.texture).__webglTexture, 0, slot);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
          throw new Error("Retained atlas layer is not framebuffer readable");
        gl.readPixels(at % 64, Math.floor(at / 64), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, gpu);
        gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
        gl.deleteFramebuffer(fb);
        return { rgba: [...rgba], gpu: gpu[0], cpu: data[index], mask: sampleDaylightAt(g.skyColumns, point),
          uv: hit.uv.toArray(), point: hit.point.toArray(), pending: light.pending,
          work: { ...g.skyColumns.stats }, memory: { ...g.renderer.info.memory } };
      };
      const before = capture();
      const canvas = g.renderer.domElement, extension = gl.getExtension("WEBGL_lose_context");
      const lost = new Promise((resolve) => canvas.addEventListener("webglcontextlost", resolve, { once: true }));
      extension.loseContext();
      await lost;
      await new Promise(requestAnimationFrame);
      if (!gl.isContextLost()) throw new Error("Topology work must run while the GPU context is lost");
      // An actual opaque addition, remote from the selected roof. Stone-to-dirt
      // at y=7 is light-irrelevant and should no longer invalidate surface light.
      f.world.put(70, 9, 2, BLOCK.DIRT);
      tick();
      const whileLost = { layers: [...light.texture.layerUpdates], cpu: data[index],
        pending: light.pending, work: { ...g.skyColumns.stats } };
      const worldAfterEdit = [...f.world.chunks].map(([key, chunk]) => [key, chunk.revision, chunk.incarnation]);
      const restored = new Promise((resolve) => canvas.addEventListener("webglcontextrestored", resolve, { once: true }));
      extension.restoreContext();
      await restored;
      const first = capture();
      for (let i = 0; i < 42; i++) {
        tick();
        g.render();
        if (!light.pending) break;
      }
      const warm = capture();
      for (let layer = 0; layer < light.tiles ** 2; layer++) light.texture.addLayerUpdate(layer);
      light.texture.needsUpdate = true;
      const fullUploadControl = capture();
      return { before, whileLost, first, warm, fullUploadControl,
        atlasBytes: data.byteLength, layers: light.tiles ** 2, sameCpuBuffer: data === light.data,
        worldAfterEdit, worldAfterRestore: [...f.world.chunks].map(([key, chunk]) => [key, chunk.revision, chunk.incarnation]),
        quality: g.quality, fullbright: g.fullbrightInspection,
        epoch: window.__glCallTrace.reports[0].epoch,
        glErrors: window.__glCallTrace.reports.flatMap((report) => report.firstErrors), glError: gl.getError() };
    } finally {
      g.dispose();
    }
  });
  t.diagnostic(JSON.stringify(result));
  if (process.env.MINESLOP_DAYLIGHT_CONTEXT_REPORT)
    writeFileSync(process.env.MINESLOP_DAYLIGHT_CONTEXT_REPORT, JSON.stringify(result, null, 2) + "\n");
  assert.deepEqual(errors, []);
  assert.deepEqual(result.glErrors, []);
  assert.equal(result.glError, 0);
  assert.equal(result.epoch, 1);
  assert.equal(result.before.mask.direct, 0);
  assert.ok(result.before.mask.ambient > 0.8);
  assert.equal(result.before.gpu, result.before.cpu);
  assert.ok(result.before.gpu > 0);
  assert.equal(result.sameCpuBuffer, true);
  assert.deepEqual(result.worldAfterRestore, result.worldAfterEdit);
  assert.equal(result.quality, "medium");
  assert.equal(result.fullbright, false);
  assert.equal(result.layers, 81);
  assert.equal(result.atlasBytes, 81 * 256 * 384);
  assert.ok(result.whileLost.work.surfaceBuilds > 0 && result.whileLost.work.surfaceBuilds <= 2);
  for (const frame of [result.first, result.warm, result.fullUploadControl]) {
    assert.equal(frame.cpu, result.before.cpu);
    assert.equal(frame.gpu, result.before.gpu, "Restoration must upload retained, non-dirty atlas layers");
    assert.deepEqual(frame.uv, result.before.uv);
    assert.deepEqual(frame.rgba, result.before.rgba, "The same roofed entrance texel must keep its color");
  }
});
