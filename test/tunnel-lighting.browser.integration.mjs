// Opt-in real GPU verification; the preview server remains running.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";
import { chromeExecutable } from "./realtime/config.mjs";

const base = new URL(process.env.VOXELCRAFT_TEST_URL ?? "http://127.0.0.1:5173/mineslop/");
if (!base.pathname.endsWith("/")) base.pathname += "/";
const url = new URL("test/realtime/index.html?quality=low&seed=cedar-valley&pixelRatio=0.5", base);

test("cave daylight shaders compile on the real GPU and survive quality/inspection changes", {
  timeout: 180000,
}, async (t) => {
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true,
    args: ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
  });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1000, height: 720 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /WebGLProgram|shader|compile|VALIDATE_STATUS/i.test(message.text()))
      errors.push(message.text());
  });
  await page.goto(url.href, { waitUntil: "load", timeout: 90000 });
  await page.waitForFunction(() => window.__voxelBot?.ready || window.__voxelBot?.error,
    undefined, { timeout: 90000 });
  assert.equal(await page.evaluate(() => window.__voxelBot.error), null);

  const states = [];
  for (const [quality, fullbright] of [
    ["low", false], ["medium", false], ["high", false],
    ["high", true], ["high", false], ["low", false],
  ]) {
    const state = await page.evaluate(({ quality, fullbright }) => {
      const { graphics: g, player } = window.__voxelBot.game;
      g.setQuality(quality);
      g.setFullbrightInspection(fullbright);
      g.update(0, g.waterTime.value, player.position);
      g.renderer.render(g.scene, g.camera);
      const gl = g.renderer.getContext();
      return {
        quality,
        fullbright,
        maskEnabled: g.daylightMaterial?.uniforms.uDaylightEnabled.value,
        materials: Object.entries(g.materials)
          .filter(([, material]) => material.isMeshLambertMaterial)
          .map(([name, material]) => ({
            name,
            daylightHook: /:daylight-1:/.test(material.customProgramCacheKey()),
          })),
        programCount: g.renderer.info.programs.length,
        failedPrograms: g.renderer.info.programs
          .filter((program) => program.diagnostics?.runnable === false)
          .map((program) => ({
            programLog: program.diagnostics.programLog,
            vertexLog: program.diagnostics.vertexShader?.log,
            fragmentLog: program.diagnostics.fragmentShader?.log,
          })),
        contextLost: gl.isContextLost(),
        glError: gl.getError(),
      };
    }, { quality, fullbright });
    states.push(state);
    t.diagnostic(JSON.stringify(state));
    assert.equal(state.contextLost, false);
    assert.equal(state.glError, 0);
    assert.ok(state.programCount > 0);
    assert.deepEqual(state.failedPrograms, []);
    assert.equal(state.maskEnabled, Number(!fullbright));
    assert.ok(state.materials.length > 0);
    for (const material of state.materials)
      assert.equal(material.daylightHook, true, `${quality} lost the ${material.name} daylight hook`);
    assert.deepEqual(errors, [], "Shader/compiler errors must not hide behind a running game loop");
  }
  assert.equal(states.length, 6);
});

test("native cave look-back reuses the rendered horizon on the first visible frame", {
  timeout: 180000,
}, async (t) => {
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true,
    args: ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
  });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /WebGLProgram|shader|compile|VALIDATE_STATUS/i.test(message.text()))
      errors.push(message.text());
  });
  await page.goto(url.href, { waitUntil: "load", timeout: 90000 });
  await page.waitForFunction(() => window.__voxelBot?.ready || window.__voxelBot?.error,
    undefined, { timeout: 90000 });
  assert.equal(await page.evaluate(() => window.__voxelBot.error), null);
  const served = await page.evaluate(async () =>
    (await import(new URL("../../src/distant-terrain.js?raw", location.href).href)).default);
  const expected = await readFile(new URL("../src/distant-terrain.js", import.meta.url));
  const sourceHash = createHash("sha256").update(served).digest("hex");
  assert.equal(sourceHash, createHash("sha256").update(expected).digest("hex"), "Wrong served horizon checkpoint");

  // Scripted stationary setups through the real Player/World; not a claim of
  // continuous user movement. Rendering between stations uses ordinary RAF.
  await page.evaluate(async () => {
    const game = window.__voxelBot.game;
    if (!game.paused || game.world.seed !== "cedar-valley" || game.world.generatorVersion !== 3)
      throw new Error("Expected a fresh paused native v3 world");
    await game.setMode("survival");
    await game.world.ensureArea({ x: 60.5, y: 27.01, z: 951.5 }, 4);
    const changed = game.buildingServices.setTime(0.5);
    if (changed?.ok === false) throw new Error("Noon setup refused");
    game.currentTime = game.buildingServices.worldClock.time;
    game.graphics.setTime(game.currentTime);
    game.player.setPosition({ x: 60.5, y: 37.01, z: 986.5 });
    game.player.yaw = game.player.pitch = 0;
    game.player._syncCamera(0);
  });
  const result = await page.evaluate(async () => {
    const game = window.__voxelBot.game, g = game.graphics;
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const start = performance.now();
    let stable = 0, previous = null, warmFrames = 0;
    for (; warmFrames < 240 && performance.now() - start < 45000; warmFrames++) {
      await nextFrame();
      const fog = [g.scene.fog.near, g.scene.fog.far];
      const settled = g.distant.ready && !g.distant._job && !g.distant._vegetationJob &&
        previous && fog.every((value, index) => Math.abs(value - previous[index]) < 0.001);
      stable = settled ? stable + 1 : 0;
      previous = fog;
      if (stable >= 8) break;
    }
    if (stable < 8) throw new Error("Native horizon/fog did not settle within the bounded warmup");
    const warmMs = performance.now() - start;
    const snapshot = () => {
      const d = g.distant, camera = g.camera;
      camera.updateMatrixWorld(true);
      const mouth = camera.position.clone().set(60.5, 38.63, 986.5);
      const depth = -mouth.clone().applyMatrix4(camera.matrixWorldInverse).z;
      const clip = mouth.clone().project(camera);
      const along = Math.max(0, Math.min(1, (depth - g.scene.fog.near) / (g.scene.fog.far - g.scene.fog.near)));
      const gl = g.renderer.getContext();
      return {
        ready: d.ready, visible: d.group.visible, fogDistance: d.fogDistance,
        ground: d._active?.terrain.geometry.uuid ?? null,
        canopy: d._vegetation?.layer.mesh.geometry.uuid ?? null,
        terrainJob: Boolean(d._job), canopyJob: Boolean(d._vegetationJob),
        work: { ...d.lastWork }, skyVisible: g.skyAccess?.skyVisible,
        fog: [g.scene.fog.near, g.scene.fog.far],
        mouthVisible: depth > 0 && Math.abs(clip.x) <= 1 && Math.abs(clip.y) <= 1,
        mouthFog: along * along * (3 - 2 * along),
        edits: game.world.edits.size,
        contextLost: gl.isContextLost(), glError: gl.getError(),
        failedPrograms: g.renderer.info.programs.filter((program) => program.diagnostics?.runnable === false).length,
      };
    };
    const before = snapshot(), occluded = [], returned = [];
    game.player.setPosition({ x: 60.5, y: 20.01, z: 937.5 });
    game.player.yaw = game.player.pitch = 0;
    game.player._syncCamera(0);
    for (let frame = 0; frame < 4; frame++) {
      await nextFrame();
      occluded.push({ frame, ...snapshot() });
    }
    game.player.setPosition({ x: 60.5, y: 30.01, z: 964.25 });
    game.player.yaw = Math.PI;
    game.player.pitch = Math.atan2(7, 22.25);
    game.player._syncCamera(0);
    for (let frame = 0; frame < 12; frame++) {
      await nextFrame();
      returned.push({ frame, ...snapshot() });
    }
    return { warmFrames, warmMs, before, occluded, returned };
  });
  t.diagnostic(JSON.stringify({ sourceHash, ...result }));
  assert.ok(result.before.ready && result.before.ground && result.before.canopy);
  assert.equal(result.before.edits, 0);
  for (const state of [...result.occluded, ...result.returned]) {
    assert.equal(state.ground, result.before.ground);
    assert.equal(state.canopy, result.before.canopy);
    assert.equal(state.terrainJob, false);
    assert.equal(state.canopyJob, false);
    assert.equal(state.edits, 0);
    assert.equal(state.contextLost, false);
    assert.equal(state.glError, 0);
    assert.equal(state.failedPrograms, 0);
  }
  for (const state of result.occluded) {
    assert.equal(state.skyVisible, false);
    assert.equal(state.ready, false);
    assert.equal(state.visible, false);
    assert.equal(state.fogDistance, 0);
    assert.deepEqual(state.work, { units: 0, samples: 0 });
  }
  for (const state of result.returned) {
    assert.equal(state.skyVisible, true);
    assert.equal(state.ready, true, `Horizon was not ready on return frame ${state.frame}`);
    assert.equal(state.mouthVisible, true);
    assert.ok(state.mouthFog < 0.05, `Mouth fog on return frame ${state.frame}: ${state.mouthFog}`);
  }
  assert.deepEqual(errors, []);
});
