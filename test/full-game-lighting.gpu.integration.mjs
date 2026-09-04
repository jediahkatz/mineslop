// Full native Game, not the authored material fixture. Every run has an empty
// disposable profile, no GUI input, no imported save and no terrain edits.
// VOXELCRAFT_TEST_URL=http://127.0.0.1:5582/mineslop/ node --test test/full-game-lighting.gpu.integration.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { chromeExecutable } from "./realtime/config.mjs";
import { installWebGLCallTrace } from "./webgl-call-trace.js";

const root = resolve(process.env.MINESLOP_GL_SOURCE ?? new URL("..", import.meta.url).pathname);
const base = new URL(process.env.VOXELCRAFT_TEST_URL ?? "http://127.0.0.1:5173/mineslop/");
if (!base.pathname.endsWith("/")) base.pathname += "/";
const url = new URL("test/realtime/index.html?quality=medium&seed=cedar-valley&pixelRatio=1", base);
const files = ["renderer.js", "atmosphere.js", "daylight-material.js", "sky-columns.js", "surface-daylight.js", "surface-topology.js", "textures.js", "context-resources.js", "effects.js", "game.js"];
const restore = process.env.MINESLOP_GL_RESTORE === "1";
const gpuCrash = process.env.MINESLOP_GL_GPU_CRASH === "1";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashes = () => Promise.all(files.map(async (file) => {
  try { return [file, hash(await readFile(resolve(root, "src", file)))]; }
  catch (error) {
    // Frozen pre-fix checkpoints predate the context/topology helpers.
    if (["context-resources.js", "surface-topology.js"].includes(file) && error.code === "ENOENT") return [file, null];
    throw error;
  }
}))
  .then(Object.fromEntries);

test("native full-Game daylight uploads, draws and terrain pixels remain valid", { timeout: 240000 }, async (t) => {
  const before = await hashes();
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true,
    args: ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
  });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  assert.deepEqual(await context.storageState({ indexedDB: true }), { cookies: [], origins: [] });
  await context.addInitScript(installWebGLCallTrace);
  const page = await context.newPage();
  const errors = [], warnings = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()) && /WebGL|GL_INVALID|texture|shader|draw|sampler/i.test(message.text())) {
      if (warnings.length < 32) warnings.push({ type: message.type(), text: message.text() });
    }
  });
  await page.goto(url.href, { waitUntil: "load", timeout: 120000 });
  await page.waitForFunction(() => window.__voxelBot?.ready || window.__voxelBot?.error,
    undefined, { timeout: 120000 });
  assert.equal(await page.evaluate(() => window.__voxelBot.error), null);
  const served = await page.evaluate(async (files) => Object.fromEntries(await Promise.all(files.map(async (file) =>
    [file, (await import(new URL(`../../src/${file}?raw`, location.href).href)).default]))),
  Object.keys(before).filter((file) => before[file] !== null));
  assert.deepEqual(Object.fromEntries(Object.entries(served).map(([file, text]) => [file, hash(text)])),
    Object.fromEntries(Object.entries(before).filter(([, value]) => value !== null)));
  const setup = await page.evaluate(async () => {
    const game = window.__voxelBot.game, g = game.graphics;
    if (!game.paused || game.world.generatorVersion !== 3 || game.world.seed !== "cedar-valley" ||
        game.gameplay.mode !== "creative" || g.fullbrightInspection || game.world.edits.size)
      throw new Error("Expected an unedited, fresh native-v3 Creative Game with Fullbright off");
    const route = game.world.generator.getCaveEntrances(0, 8)[0].path;
    const middle = route[Math.floor(route.length / 2)];
    await game.world.ensureArea({ x: middle.x + 0.5, y: middle.low + 0.01, z: middle.z + 0.5 }, 4);
    const changed = game.buildingServices.setTime(0.5);
    if (changed?.ok === false) throw new Error("Noon setup refused");
    game.currentTime = game.buildingServices.worldClock.time;
    g.setTime(game.currentTime);
    game.player.setPosition({ x: 60.5, y: 37.01, z: 986.5 });
    game.player.flying = false;
    game.player.yaw = 0;
    game.player.pitch = -0.18;
    game.player._syncCamera(0);
    const started = performance.now();
    let frames = 0;
    do {
      g.rebuildDirty(Infinity);
      g.update(0, game.elapsed, game.player.position);
      g.render();
      if (++frames >= 100 || performance.now() - started > 60000)
        break; // Preserve the GL ledger and pixels even if setup fails to settle.
      if (!g.skyColumns.surfaceLight.pending && frames > 2) break;
      await new Promise(requestAnimationFrame);
    } while (true);
    return { frames, milliseconds: performance.now() - started, routePoints: route.length, edits: game.world.edits.size,
      pending: g.skyColumns.surfaceLight.pending, distantReady: g.distant.ready };
  });
  const capture = () => page.evaluate(async () => {
    const { raycast } = await import(new URL("../../src/raycast.js", location.href));
    const { sampleDaylightAt } = await import(new URL("../../src/daylight-material.js", location.href));
    const game = window.__voxelBot.game, g = game.graphics, gl = g.renderer.getContext();
    const edits = JSON.stringify(game.snapshot().world.edits);
    g.render();
    const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const samples = [];
    g.camera.updateMatrixWorld(true);
    for (let y = Math.floor(height * 0.12); y < height * 0.76; y += 48)
      for (let x = Math.floor(width * 0.12); x < width * 0.88; x += 64) {
        const direction = g.camera.position.clone().set((x + 0.5) / width * 2 - 1, (y + 0.5) / height * 2 - 1, 0.5)
          .unproject(g.camera).sub(g.camera.position).normalize();
        const hit = raycast(game.world, g.camera.position, direction, 40, { channel: "occlusion" });
        if (!hit || hit.distance > 25) continue;
        const point = Object.fromEntries(["x", "y", "z"].map((axis) => [axis, hit.point[axis] + hit.normal[axis] * 0.02]));
        const mask = sampleDaylightAt(g.skyColumns, point);
        if (mask.direct !== 1) continue;
        const rgba = Array.from(pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 4));
        samples.push({ x, y, block: hit.id, point, mask, rgba, luma: rgba[0] * 0.2126 + rgba[1] * 0.7152 + rgba[2] * 0.0722 });
      }
    const programs = Object.entries(g.materials).filter(([, material]) => material.isMeshLambertMaterial)
      .map(([name, material]) => {
        const properties = g.renderer.properties.get(material);
        const program = properties.currentProgram?.program;
        const uniforms = [];
        if (program) for (let index = 0; index < gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS); index++) {
          const info = gl.getActiveUniform(program, index);
          if (![gl.SAMPLER_2D, gl.SAMPLER_2D_ARRAY].includes(info.type)) continue;
          const unit = gl.getUniform(program, gl.getUniformLocation(program, info.name));
          uniforms.push({ name: info.name, type: info.type, unit,
            texture: window.__glCallTrace.texture(gl, info.type === gl.SAMPLER_2D_ARRAY ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_2D, unit) });
        }
        return { name, batching: properties.batching, instancing: properties.instancing, uniforms };
      });
    const extension = gl.getExtension("WEBGL_debug_renderer_info");
    // Encode the exact framebuffer already sampled. The default, non-preserved
    // WebGL buffer can be cleared by presentation before a later toDataURL.
    const frame = document.createElement("canvas");
    frame.width = width;
    frame.height = height;
    const context2D = frame.getContext("2d", { willReadFrequently: true });
    const image = context2D.createImageData(width, height);
    for (let row = 0; row < height; row++)
      image.data.set(pixels.subarray((height - 1 - row) * width * 4, (height - row) * width * 4),
        row * width * 4);
    context2D.putImageData(image, 0, 0);
    const png = frame.toDataURL("image/png");
    const sourcePixels = (texture) => {
      const image = texture.image;
      const data = image.data ?? image.getContext("2d").getImageData(0, 0, image.width, image.height).data;
      let nonzero = 0, sum = 0, alpha = 0;
      for (let i = 0; i < data.length; i += 4) {
        nonzero += Number(data[i] + data[i + 1] + data[i + 2] > 0);
        sum += data[i] + data[i + 1] + data[i + 2];
        alpha += data[i + 3];
      }
      return { type: texture.type, width: image.width, height: image.height,
        nonzero, meanRGB: sum / (data.length / 4 * 3), meanAlpha: alpha / (data.length / 4) };
    };
    const sourceAtlas = window.__glFaultFinished ? sourcePixels(g.materials.opaque.map) : null;
    const sourceGlow = window.__glFaultFinished ? sourcePixels(g.atmosphere.glowTexture) : null;
    return {
      setup: {
        quality: g.quality, pixelRatio: g.renderer.getPixelRatio(), width, height,
        active: game.active, enabled: game.player.enabled, locked: game.player.locked,
        distantReady: g.distant.ready, distantVisible: g.distant.group.visible,
        fullbright: g.fullbrightInspection, fog: [g.scene.fog.near, g.scene.fog.far],
        outputColorSpace: g.renderer.outputColorSpace, toneMapping: g.renderer.toneMapping,
        toneMappingExposure: g.renderer.toneMappingExposure, position: game.player.position.toArray(),
        camera: g.camera.position.toArray(), cameraEuler: g.camera.rotation.toArray(),
        directSky: g.skyAccess.directSky, exposure: g.skyAccess.exposure, known: g.skyAccess.known,
        atlas: g.skyColumns.surfaceLight.resources(), work: { ...g.skyColumns.stats }, sourceAtlas, sourceGlow,
        memory: { ...g.renderer.info.memory },
        atlasCpuBytes: [g.atlas.texture, g.atlas.emissiveTexture]
          .reduce((sum, texture) => sum + (texture.image.data?.byteLength ?? 0), 0),
        edits: game.world.edits.size, unchangedEdits: edits === JSON.stringify(game.snapshot().world.edits),
        renderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      },
      samples, programs, png,
      failedPrograms: g.renderer.info.programs.filter((program) => program.diagnostics?.runnable === false).length,
      contextLost: gl.isContextLost(), glError: gl.getError(), trace: window.__glCallTrace.reports,
    };
  });
  const paused = await capture();
  await page.evaluate(() => window.__voxelBot.game.play());
  const playing = await page.evaluate(async (maxFrames) => {
    const game = window.__voxelBot.game, g = game.graphics;
    const started = performance.now();
    let frames = 0;
    do {
      await new Promise(requestAnimationFrame);
      if (++frames >= maxFrames || performance.now() - started > 90000) break;
    } while (frames < 12 || !g.distant.ready || g.skyColumns.surfaceLight.pending);
    return { frames, milliseconds: performance.now() - started, active: game.active, enabled: game.player.enabled,
      locked: game.player.locked, distantReady: g.distant.ready, pending: g.skyColumns.surfaceLight.pending };
  }, restore || gpuCrash ? 12 : 200);
  let result = await capture();
  const healthy = result;
  if (restore || gpuCrash) {
    const fault = { gpuCrash };
    if (gpuCrash) {
      await page.evaluate(() => {
        window.__glRestoreSeen = false;
        window.__voxelBot.game.graphics.renderer.domElement.addEventListener("webglcontextrestored",
          () => { window.__glRestoreSeen = true; }, { once: true });
      });
      // Only this freshly launched browser's GPU process is affected. Never
      // connect this fault-injection test to an existing CDP/profile.
      const client = await browser.newBrowserCDPSession();
      await client.send("Browser.crashGpuProcess");
      await client.detach();
      await page.waitForFunction(() => window.__glRestoreSeen, undefined, { timeout: 20000 })
        .catch((error) => { fault.restoreWait = error.message; });
    } else await page.evaluate(async () => {
      const g = window.__voxelBot.game.graphics, canvas = g.renderer.domElement;
      const extension = g.renderer.getContext().getExtension("WEBGL_lose_context");
      if (!extension) throw new Error("Controlled context restoration is unavailable");
      const lost = new Promise((resolve) => canvas.addEventListener("webglcontextlost", resolve, { once: true }));
      extension.loseContext();
      await lost;
      await new Promise(requestAnimationFrame);
      const restored = new Promise((resolve) => canvas.addEventListener("webglcontextrestored", resolve, { once: true }));
      extension.restoreContext();
      await restored;
      for (let frame = 0; frame < 4; frame++) await new Promise(requestAnimationFrame);
    });
    await page.evaluate(async () => {
      for (let frame = 0; frame < 4; frame++) await new Promise(requestAnimationFrame);
      window.__glFaultFinished = true;
    });
    fault.cleanup = await page.evaluate(() => {
      const game = window.__voxelBot.game, g = game.graphics;
      const key = `${Math.floor(game.player.position.x / 16)},${Math.floor(game.player.position.z / 16)}`;
      const before = window.__glCallTrace.reports.reduce((sum, trace) => sum + trace.errors, 0);
      // Exercise ordinary renderer eviction/rebuild without changing a voxel.
      g.removeChunk(key);
      game.world.dirtyChunks.add(key);
      g.rebuildDirty(Infinity);
      g.render();
      return { key, edits: game.world.edits.size,
        glErrors: window.__glCallTrace.reports.reduce((sum, trace) => sum + trace.errors, 0) - before };
    });
    result = await capture();
    result.setup.fault = fault;
  }
  const { png, ...report } = result;
  if (process.env.MINESLOP_GL_REPORT)
    writeFileSync(process.env.MINESLOP_GL_REPORT, JSON.stringify({ hashes: before, warmup: setup, playing,
      paused: { ...paused, png: undefined }, healthy: { ...healthy, png: undefined }, ...report, errors, warnings }, null, 2) + "\n");
  if (process.env.MINESLOP_GL_IMAGE)
    writeFileSync(process.env.MINESLOP_GL_IMAGE, Buffer.from(png.split(",")[1], "base64"));
  const luminances = result.samples.map((sample) => sample.luma).sort((a, b) => a - b);
  const controls = new Map(healthy.samples.map((sample) => [`${sample.x},${sample.y}`, sample]));
  const matchingPixels = result.samples.filter((sample) => {
    const reference = controls.get(`${sample.x},${sample.y}`);
    return reference && sample.rgba.every((value, i) => Math.abs(value - reference.rgba[i]) <= 3);
  }).length;
  const summary = { calls: result.trace.reduce((sum, trace) => sum + trace.calls, 0),
    glErrors: result.trace.reduce((sum, trace) => sum + trace.errors, 0), directSkySamples: luminances.length,
    median: luminances[Math.floor(luminances.length / 2)], nonblack: luminances.filter((value) => value > 3).length,
    matchingPixels, atlasCpuBytes: result.setup.atlasCpuBytes, memory: result.setup.memory,
    edits: result.setup.edits, warnings, errors };
  t.diagnostic(JSON.stringify(summary));
  assert.deepEqual(await hashes(), before, "Source must stay unchanged during a run");
  assert.equal(result.setup.quality, "medium");
  assert.equal(result.setup.pixelRatio, 1);
  assert.equal(result.setup.active, true);
  assert.equal(result.setup.enabled, true);
  assert.equal(result.setup.locked, true);
  assert.equal(result.setup.fullbright, false);
  assert.equal(result.setup.outputColorSpace, "srgb");
  assert.equal(result.setup.toneMappingExposure, 1.05);
  assert.equal(result.setup.edits, 0);
  assert.equal(result.setup.unchangedEdits, true);
  assert.equal(result.setup.atlas.pending, 0);
  assert.equal(result.setup.fault?.restoreWait, undefined, "Fault injection must actually restore a lost context");
  assert.equal(result.contextLost, false);
  assert.equal(result.failedPrograms, 0);
  assert.deepEqual(errors, []);
  assert.equal(summary.glErrors, 0, JSON.stringify(result.trace.flatMap((trace) => trace.firstErrors).slice(0, 1)));
  assert.equal(result.glError, 0);
  if (restore || gpuCrash) {
    assert.equal(result.trace[0].epoch, 1);
    assert.ok(result.setup.sourceAtlas.nonzero > result.setup.sourceAtlas.width * result.setup.sourceAtlas.height / 2);
    assert.ok(result.setup.sourceGlow.nonzero > 0, "the restored sun glow must retain its original canvas content");
    assert.ok(matchingPixels >= result.samples.length * 0.8, "restoration preserves surface colors, not just brightness");
    assert.ok(result.setup.memory.textures <= healthy.setup.memory.textures);
    assert.ok(result.setup.memory.geometries <= healthy.setup.memory.geometries + 2);
  } else assert.ok(result.trace.every((trace) => trace.epoch === 0 && trace.contextLosses.length === 0));
  assert.ok(summary.directSkySamples >= 20, "Sample actual nearby direct-sky terrain, not just the sky background");
  assert.ok(summary.nonblack >= summary.directSkySamples * 0.8 && summary.median > 20,
    `Detailed outdoor terrain must not be black silhouettes: ${JSON.stringify(summary)}`);
});
