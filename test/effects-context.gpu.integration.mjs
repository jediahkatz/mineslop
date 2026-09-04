// Isolated full-Game GPU restart. No native GUI connection, save import,
// inventory mutation, or terrain edits; sprite/arrow setup is render-only.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import test from "node:test";
import { chromium } from "playwright";
import { chromeExecutable } from "./realtime/config.mjs";
import { installWebGLCallTrace } from "./webgl-call-trace.js";

const base = new URL(process.env.VOXELCRAFT_TEST_URL ?? "http://127.0.0.1:5173/mineslop/");
test("full-Game GPU restart releases cached held textures and expired arrow resources", { timeout: 180000 }, async (t) => {
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true, args: ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
  });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  assert.deepEqual(await context.storageState({ indexedDB: true }), { cookies: [], origins: [] });
  await context.addInitScript(installWebGLCallTrace);
  const page = await context.newPage(), errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(new URL("test/realtime/index.html?quality=medium&seed=cedar-valley&pixelRatio=1", base).href,
    { waitUntil: "load", timeout: 120000 });
  await page.waitForFunction(() => window.__voxelBot?.ready || window.__voxelBot?.error,
    undefined, { timeout: 120000 });
  assert.equal(await page.evaluate(() => window.__voxelBot.error), null);
  for (const name of ["APPLE", "STICK"]) {
    const id = await page.evaluate(async (name) => {
      const { ITEM } = await import("../../src/items.js");
      window.__voxelBot.game.effects.select(ITEM[name]);
      return ITEM[name];
    }, name);
    await page.waitForFunction((id) => {
      const image = window.__voxelBot.game.effects.itemTextures.get(id).image;
      return image?.complete && image.naturalWidth > 0;
    }, id);
    await page.evaluate((id) => {
      const game = window.__voxelBot.game;
      game.graphics.renderer.initTexture(game.effects.itemTextures.get(id));
    }, id);
  }
  const before = await page.evaluate(async () => {
    const { ITEM } = await import("../../src/items.js");
    const game = window.__voxelBot.game, g = game.graphics, effects = game.effects;
    if (!game.paused || game.world.edits.size || g.fullbrightInspection || game.gameplay.mode !== "creative")
      throw new Error("Need an unchanged fresh native Game with Fullbright off");
    const gl = g.renderer.getContext(), trace = window.__glCallTrace;
    const apple = effects.itemTextures.get(ITEM.APPLE), stick = effects.itemTextures.get(ITEM.STICK);
    const counts = { apple: 0, stick: 0, arrowGeometry: 0, arrowMaterial: 0 };
    for (const [name, resource] of Object.entries({ apple, stick, arrowGeometry: effects.arrowGeometry, arrowMaterial: effects.arrowMaterial }))
      resource.addEventListener("dispose", () => counts[name]++);
    const ids = Object.fromEntries([["apple", apple], ["stick", stick]].map(([name, texture]) =>
      [name, trace.id(g.renderer.properties.get(texture).__webglTexture)]));
    const forward = g.camera.getWorldDirection(g.camera.position.clone());
    const start = g.camera.position.clone().addScaledVector(forward, 3);
    effects.shoot(start, start.clone().addScaledVector(forward, 1));
    const arrow = effects.arrows.at(-1);
    let arrowIndexBuffer, arrowRendered = 0;
    arrow.mesh.onAfterRender = () => {
      arrowRendered++;
      arrowIndexBuffer = trace.id(gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING));
    };
    g.render();
    effects.update(1, 0, false, false);
    window.__effectsContextProbe = { counts, restored: false };
    g.renderer.domElement.addEventListener("webglcontextrestored",
      () => { window.__effectsContextProbe.restored = true; }, { once: true });
    return { ids, arrowIndexBuffer, arrowRendered,
      appleCached: effects.itemTextures.get(ITEM.APPLE) === apple,
      appleBound: effects.itemMaterial.map === apple || effects.offhand.itemMaterial.map === apple,
      stickBound: effects.itemMaterial.map === stick, arrowOffScene: !arrow.mesh.parent && !effects.arrows.length,
      counts: { ...counts }, edits: game.world.edits.size,
      errors: trace.reports.flatMap((report) => report.firstErrors) };
  });
  // Only this newly launched browser is ever fault-injected.
  const client = await browser.newBrowserCDPSession();
  await client.send("Browser.crashGpuProcess");
  await client.detach();
  await page.waitForFunction(() => window.__effectsContextProbe.restored, undefined, { timeout: 25000 });
  const restored = await page.evaluate(() => {
    const game = window.__voxelBot.game;
    return { counts: { ...window.__effectsContextProbe.counts }, edits: game.world.edits.size,
      epoch: window.__glCallTrace.reports[0].epoch, lost: game.graphics.renderer.getContext().isContextLost() };
  });
  const cleanup = await page.evaluate(() => {
    const game = window.__voxelBot.game, g = game.graphics;
    // Ordinary owner teardown, including the unbound Apple and expired arrow.
    game.effects.dispose();
    return { counts: { ...window.__effectsContextProbe.counts }, edits: game.world.edits.size,
      owners: g.contextResourceOwners.size, glError: g.renderer.getContext().getError(),
      totalErrors: window.__glCallTrace.reports.reduce((sum, report) => sum + report.errors, 0),
      errors: window.__glCallTrace.reports.flatMap((report) => report.firstErrors) };
  });
  const result = { before, restored, cleanup, errors };
  t.diagnostic(JSON.stringify(result));
  if (process.env.MINESLOP_EFFECTS_CONTEXT_REPORT)
    writeFileSync(process.env.MINESLOP_EFFECTS_CONTEXT_REPORT, JSON.stringify(result, null, 2) + "\n");
  assert.ok(before.ids.apple && before.ids.stick && before.ids.apple !== before.ids.stick);
  assert.ok(before.arrowIndexBuffer && before.arrowRendered);
  assert.equal(before.appleCached, true);
  assert.equal(before.appleBound, false);
  assert.equal(before.stickBound, true);
  assert.equal(before.arrowOffScene, true);
  assert.deepEqual(before.counts, { apple: 0, stick: 0, arrowGeometry: 0, arrowMaterial: 0 });
  assert.deepEqual(restored.counts, { apple: 1, stick: 1, arrowGeometry: 1, arrowMaterial: 1 });
  assert.deepEqual(cleanup.counts, { apple: 2, stick: 2, arrowGeometry: 2, arrowMaterial: 2 });
  assert.equal(restored.epoch, 1);
  assert.equal(restored.lost, false);
  assert.equal(cleanup.owners, 0);
  assert.equal(cleanup.edits, 0);
  assert.equal(cleanup.totalErrors, 0);
  assert.equal(cleanup.glError, 0);
  assert.deepEqual(errors, []);
});
